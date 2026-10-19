// M1 单元测试：官方 protocol.md 测试向量 + 响应解密往返 + 滑动窗口
// 入口：index.tsx 的「M1 协议测试」，或 scripting-ts run "<脚本目录>/tests/m1_test.ts"
import { concat, hex, unhex, utf8 } from "../core/bytes"
import { aesGcmEncrypt, deriveSessionKey, importAesKey, publicKeyFromPrivate, sessionKeysFromPrivate, subkey, vehicleLocalName } from "../core/crypto"
import { Metadata, SignatureType, Tag } from "../core/metadata"
import { decode, encode, FLAG_ENCRYPT_RESPONSE, Types } from "../core/proto"
import { Session, SlidingWindow } from "../core/session"

const VIN: string = "5YJ30123456789ABC"
const CLIENT_PRIV: Uint8Array = unhex("2538CDC29A97C19C1E99A637D6CF4F8C970C118B56EDE1E6323E6D162C4B30DB")
const VEHICLE_PRIV_UNUSED: string = ""
const SESSION_INFO: Uint8Array = unhex("0806124104c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d971a104c463f9cc0d3d26906e982ed224adde6255a0a0000")
const CHALLENGE: Uint8Array = unhex("1588d5a30eabc6f8fc9a951b11f6fd11")
const SESSION_TAG: Uint8Array = unhex("996c1fe38331be138f8039c194b14db2198846ed7d8251e6749284d7b32ea002")

type Result = { name: string; ok: boolean; detail?: string }
const results: Result[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail: ok ? undefined : detail })
}

export async function runM1(): Promise<string> {
  results.length = 0
  // 1. 公钥推导
  const pub: Uint8Array = publicKeyFromPrivate(CLIENT_PRIV)
  check("client public key", hex(pub) === "04b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a714330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e", hex(pub))

  // 2. 会话密钥 K 与 session info key
  const info: any = decode(Types.SessionInfo, SESSION_INFO)
  const K: Uint8Array = await deriveSessionKey(CLIENT_PRIV, info.publicKey)
  check("shared key K", hex(K) === "1b2fce19967b79db696f909cff89ea9a", hex(K))
  const sik: Uint8Array = await subkey(K, "session info")
  check("session info key", hex(sik) === "fceb679ee7bca756fcd441bf238bf2f338629b41d9eb9c67be1b32c9672ce300", hex(sik))
  check("session info decode", info.counter === 6 && info.clock_time === 2650 && hex(info.epoch) === "4c463f9cc0d3d26906e982ed224adde6", JSON.stringify({ c: info.counter, t: info.clock_time }))

  // 3. 元数据序列化
  const meta: Metadata = new Metadata().add(Tag.SIGNATURE_TYPE, new Uint8Array([SignatureType.HMAC])).add(Tag.PERSONALIZATION, utf8(VIN)).add(Tag.CHALLENGE, CHALLENGE)
  check("metadata TLV", hex(meta.serialize()) + "ff" === "000106021135594a333031323334353637383941424306101588d5a30eabc6f8fc9a951b11f6fd11ff", hex(meta.serialize()))

  // 4. 握手校验（Session.processHello）
  const s: Session = new Session(3, VIN, sessionKeysFromPrivate(CLIENT_PRIV))
  const nowMs: number = Date.now()
  await s.processHello(CHALLENGE, SESSION_INFO, SESSION_TAG, nowMs)
  check("processHello ready", s.ready && s.counter === 6 && s.vehicleClock(nowMs) === 2650, `ready=${s.ready} counter=${s.counter} clock=${s.vehicleClock(nowMs)}`)

  // 篡改 tag 必须失败
  let rejected: boolean = false
  try {
    const bad: Uint8Array = new Uint8Array(SESSION_TAG)
    bad[0] ^= 1
    await new Session(3, VIN, sessionKeysFromPrivate(CLIENT_PRIV)).processHello(CHALLENGE, SESSION_INFO, bad)
  } catch (_e) {
    rejected = true
  }
  check("processHello rejects bad tag", rejected)

  // 5. AES-GCM 指令加密（官方 HVAC 向量）
  const action: Uint8Array = encode(Types.CarServerAction, { vehicleAction: { hvacAutoAction: { power_on: true } } })
  check("encode HVAC action", hex(action) === "120452020801", hex(action))
  const enc = await s.encrypt(action, FLAG_ENCRYPT_RESPONSE, 5, { nonce: unhex("dbf79447fa156674dae1caed"), expiresAt: 2655 })
  check("counter incremented to 7", s.counter === 7 && enc.signatureData.AES_GCM_Personalized_data.counter === 7, String(s.counter))
  check("ciphertext", hex(enc.ciphertext) === "38038e8c0f2e", hex(enc.ciphertext))
  check("gcm tag", hex(enc.signatureData.AES_GCM_Personalized_data.tag) === "c228e0ff64991481db3a7bbc133696c5", hex(enc.signatureData.AES_GCM_Personalized_data.tag))
  check("request id", hex(enc.requestId) === "05c228e0ff64991481db3a7bbc133696c5", hex(enc.requestId))

  // 6. RoutableMessage 编码 + 解码回读
  const rm: Uint8Array = encode(Types.RoutableMessage, {
    to_destination: { domain: 3 },
    from_destination: { routing_address: unhex("2c907bd76c640d360b3027dc7404efde") },
    protobuf_message_as_bytes: enc.ciphertext,
    signature_data: enc.signatureData,
    flags: FLAG_ENCRYPT_RESPONSE,
    uuid: unhex("58406580528b6a5301391800b4fe9b99"),
  })
  const back: any = decode(Types.RoutableMessage, rm)
  check("routable roundtrip", hex(back.signature_data.AES_GCM_Personalized_data.tag) === "c228e0ff64991481db3a7bbc133696c5" && back.flags === 2 && back.to_destination.domain === 3, JSON.stringify(Object.keys(back)))

  // 7. 响应解密：模拟车辆按 protocol.md 规则加密一条 CarServer.Response，再用 Session 解密
  const respPlain: Uint8Array = encode(Types.CarServerResponse, { actionStatus: { result: 0 } })
  const respCounter: number = 1
  const respFlags: number = 0
  const respMeta: Metadata = new Metadata()
    .add(Tag.SIGNATURE_TYPE, new Uint8Array([SignatureType.AES_GCM_RESPONSE]))
    .add(Tag.DOMAIN, new Uint8Array([3]))
    .add(Tag.PERSONALIZATION, utf8(VIN))
    .addU32(Tag.COUNTER, respCounter)
    .addU32(Tag.FLAGS, respFlags)
    .add(Tag.REQUEST_HASH, enc.requestId)
    .addU32(Tag.FAULT, 0)
  const respNonce: Uint8Array = unhex("000102030405060708090a0b")
  const vehAes: CryptoKey = await importAesKey(K)
  const vehEnc = await aesGcmEncrypt(vehAes, respNonce, respPlain, await respMeta.sha256Checksum())
  const respMsgBytes: Uint8Array = encode(Types.RoutableMessage, {
    to_destination: { routing_address: unhex("2c907bd76c640d360b3027dc7404efde") },
    from_destination: { domain: 3 },
    protobuf_message_as_bytes: vehEnc.ciphertext,
    signature_data: { AES_GCM_Response_data: { nonce: respNonce, counter: respCounter, tag: vehEnc.tag } },
    flags: respFlags,
    request_uuid: unhex("58406580528b6a5301391800b4fe9b99"),
  })
  const respMsg: any = decode(Types.RoutableMessage, respMsgBytes)
  const dec = await s.decryptResponse(respMsg, enc.requestId)
  check("response decrypt", hex(dec.plaintext) === hex(respPlain) && dec.counter === 1, hex(dec.plaintext))
  let wrongHashRejected: boolean = false
  try {
    await s.decryptResponse(respMsg, concat(new Uint8Array([5]), new Uint8Array(16)))
  } catch (_e) {
    wrongHashRejected = true
  }
  check("response decrypt rejects wrong request hash", wrongHashRejected)

  // 8. 会话缓存导出/导入后继续签名，counter 连续
  const cache = s.exportCache()!
  const s2: Session = new Session(3, VIN, sessionKeysFromPrivate(CLIENT_PRIV))
  await s2.importCache(cache)
  const enc2 = await s2.encrypt(action, FLAG_ENCRYPT_RESPONSE)
  check("cache import continues counter", enc2.signatureData.AES_GCM_Personalized_data.counter === 8, String(enc2.signatureData.AES_GCM_Personalized_data.counter))

  // 9. 重同步：同 epoch、旧时钟不得回滚；counter 只增不减
  await s.processHello(CHALLENGE, SESSION_INFO, SESSION_TAG, nowMs)
  check("resync keeps higher counter", s.counter === 7, String(s.counter))

  // 10. 滑动窗口
  const w: SlidingWindow = new SlidingWindow()
  const seq: boolean[] = [w.update(5), w.update(5), w.update(7), w.update(6), w.update(6), w.update(100), w.update(37), w.update(37), w.update(35)]
  // 37：落后 63 未用过 → 接受；再次 37 → 重复拒绝；35：落后 65 超出窗口 → 拒绝
  check("sliding window", JSON.stringify(seq) === JSON.stringify([true, false, true, true, false, true, true, false, false]), JSON.stringify(seq))

  // 11. 广播名
  // 广播名 = S + hex(SHA1(VIN)[0:8]) + C（用 SDK 测试 VIN，期望值用 Python hashlib 算出）
  const ln: string = await vehicleLocalName(VIN)
  check("local name", ln === "Sade9a822faa374f8C", ln)

  const failed: Result[] = results.filter((r: Result) => !r.ok)
  const lines: string[] = results.map((r: Result) => `${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? "  → " + r.detail : ""}`)
  return `${results.length - failed.length}/${results.length} passed\n` + lines.join("\n") + VEHICLE_PRIV_UNUSED
}
