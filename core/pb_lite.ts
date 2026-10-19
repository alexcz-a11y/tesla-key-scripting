// 手写的最小 protobuf 编解码：只覆盖 RoutableMessage / SessionInfo / VCSEC 收发要用的消息，不依赖 protobufjs。
// 小组件进程加载不了 npm 包（2026-10-18 实测：加载 @noble/curves 时进程被终止），调度层和 VCSEC 客户端都改用这里，
// 主界面和小组件走同一套代码。字段号对照 proto/universal_message.proto、signatures.proto、vcsec.proto、errors.proto。
// 行为与 core/proto.ts 的 encode / decode（protobufjs）保持一致：
//   编码：按字段号递增写出；值不是 null / undefined 就写（包括 0 和空 bytes，与 protobufjs fromObject + encode 相同）；
//   解码：只放线上出现过的字段（defaults: false），枚举为数字，repeated 字段总是数组（arrays: true），
//         oneof 另加一个以 oneof 名为键、值为字段名的属性（oneofs: true），未知字段跳过
export type Msg = Record<string, any>

type Kind = "varint" | "bytes" | "fixed32" | Schema

interface Field {
  n: number
  name: string
  k: Kind
  oneof?: string
  rep?: boolean
}

export interface Schema {
  name: string
  fields: Field[]
  byNo: Map<number, Field>
}

function schema(name: string, fields: Field[]): Schema {
  const sorted: Field[] = fields.slice().sort((a: Field, b: Field) => a.n - b.n)
  return { name, fields: sorted, byNo: new Map(sorted.map((f: Field) => [f.n, f] as [number, Field])) }
}

const v = (n: number, name: string, oneof?: string): Field => ({ n, name, k: "varint", oneof })
const b = (n: number, name: string, oneof?: string): Field => ({ n, name, k: "bytes", oneof })
const f32 = (n: number, name: string): Field => ({ n, name, k: "fixed32" })
const m = (n: number, name: string, k: Schema, oneof?: string): Field => ({ n, name, k, oneof })

// ---- UniversalMessage / Signatures ----

const Destination: Schema = schema("Destination", [v(1, "domain", "sub_destination"), b(2, "routing_address", "sub_destination")])
const MessageStatus: Schema = schema("MessageStatus", [v(1, "operation_status"), v(2, "signed_message_fault")])
const SessionInfoRequest: Schema = schema("SessionInfoRequest", [b(1, "public_key"), b(2, "challenge")])
const KeyIdentity: Schema = schema("KeyIdentity", [b(1, "public_key", "identity_type"), v(3, "handle", "identity_type")])
const AesGcmPersonalized: Schema = schema("AES_GCM_Personalized_Signature_Data", [
  b(1, "epoch"), b(2, "nonce"), v(3, "counter"), f32(4, "expires_at"), b(5, "tag"),
])
const AesGcmResponse: Schema = schema("AES_GCM_Response_Signature_Data", [b(1, "nonce"), v(2, "counter"), b(3, "tag")])
const HmacSig: Schema = schema("HMAC_Signature_Data", [b(1, "tag")])
const HmacPersonalized: Schema = schema("HMAC_Personalized_Signature_Data", [b(1, "epoch"), v(2, "counter"), f32(3, "expires_at"), b(4, "tag")])
const SignatureData: Schema = schema("SignatureData", [
  m(1, "signer_identity", KeyIdentity),
  m(5, "AES_GCM_Personalized_data", AesGcmPersonalized, "sig_type"),
  m(6, "session_info_tag", HmacSig, "sig_type"),
  m(8, "HMAC_Personalized_data", HmacPersonalized, "sig_type"),
  m(9, "AES_GCM_Response_data", AesGcmResponse, "sig_type"),
])
const RoutableMessage: Schema = schema("RoutableMessage", [
  m(6, "to_destination", Destination),
  m(7, "from_destination", Destination),
  b(10, "protobuf_message_as_bytes", "payload"),
  m(14, "session_info_request", SessionInfoRequest, "payload"),
  b(15, "session_info", "payload"),
  m(13, "signature_data", SignatureData, "sub_sigData"),
  m(12, "signedMessageStatus", MessageStatus),
  b(50, "request_uuid"),
  b(51, "uuid"),
  v(52, "flags"),
])
const SessionInfo: Schema = schema("SessionInfo", [
  v(1, "counter"), b(2, "publicKey"), b(3, "epoch"), f32(4, "clock_time"), v(5, "status"), v(6, "handle"),
])

// ---- VCSEC ----

const KeyIdentifier: Schema = schema("KeyIdentifier", [b(1, "publicKeySHA1")])
const InformationRequest: Schema = schema("InformationRequest", [
  v(1, "informationRequestType"), m(2, "keyId", KeyIdentifier, "key"), b(3, "publicKey", "key"), v(4, "slot", "key"),
])
const CLOSURES: string[] = ["frontDriverDoor", "frontPassengerDoor", "rearDriverDoor", "rearPassengerDoor", "rearTrunk", "frontTrunk", "chargePort", "tonneau"]
const ClosureMoveRequest: Schema = schema("ClosureMoveRequest", CLOSURES.map((name: string, i: number) => v(i + 1, name)))
const UnsignedMessage: Schema = schema("UnsignedMessage", [
  m(1, "InformationRequest", InformationRequest, "sub_message"),
  v(2, "RKEAction", "sub_message"),
  m(4, "closureMoveRequest", ClosureMoveRequest, "sub_message"),
])
const ClosureStatuses: Schema = schema("ClosureStatuses", CLOSURES.map((name: string, i: number) => v(i + 1, name)))
const DetailedClosureStatus: Schema = schema("DetailedClosureStatus", [v(1, "tonneauPercentOpen")])
const VehicleStatus: Schema = schema("VehicleStatus", [
  m(1, "closureStatuses", ClosureStatuses), v(2, "vehicleLockState"), v(3, "vehicleSleepStatus"), v(4, "userPresence"),
  m(5, "detailedClosureStatus", DetailedClosureStatus),
])
const SignedMessageStatus: Schema = schema("SignedMessage_status", [v(1, "counter"), v(2, "signedMessageInformation")])
const WhitelistOperationStatus: Schema = schema("WhitelistOperation_status", [
  v(1, "whitelistOperationInformation"), m(2, "signerOfOperation", KeyIdentifier), v(3, "operationStatus"),
])
const CommandStatus: Schema = schema("CommandStatus", [
  v(1, "operationStatus"),
  m(2, "signedMessageStatus", SignedMessageStatus, "sub_message"),
  m(3, "whitelistOperationStatus", WhitelistOperationStatus, "sub_message"),
])
const NominalError: Schema = schema("NominalError", [v(1, "genericError")])
const PublicKey: Schema = schema("PublicKey", [b(1, "PublicKeyRaw")])
const KeyMetadata: Schema = schema("KeyMetadata", [v(1, "keyFormFactor")])
const WhitelistInfo: Schema = schema("WhitelistInfo", [
  v(1, "numberOfEntries"), { n: 2, name: "whitelistEntries", k: KeyIdentifier, rep: true }, v(3, "slotMask"),
])
const WhitelistEntryInfo: Schema = schema("WhitelistEntryInfo", [
  m(1, "keyId", KeyIdentifier), m(2, "publicKey", PublicKey), m(4, "metadataForKey", KeyMetadata), v(6, "slot"), v(7, "keyRole"),
])
const FromVCSECMessage: Schema = schema("FromVCSECMessage", [
  m(1, "vehicleStatus", VehicleStatus, "sub_message"),
  m(4, "commandStatus", CommandStatus, "sub_message"),
  m(16, "whitelistInfo", WhitelistInfo, "sub_message"),
  m(17, "whitelistEntryInfo", WhitelistEntryInfo, "sub_message"),
  m(46, "nominalError", NominalError, "sub_message"),
])

export const Types = {
  RoutableMessage,
  SessionInfo,
  UnsignedMessage,
  FromVCSECMessage,
}

// ---- 编码 ----

function pushVarint(out: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`不支持的整数值 ${value}`)
  let x: number = value >>> 0
  while (x > 0x7f) {
    out.push((x & 0x7f) | 0x80)
    x >>>= 7
  }
  out.push(x)
}

function toBytesIn(x: unknown, where: string): Uint8Array {
  if (x instanceof Uint8Array) return x
  if (Array.isArray(x)) return new Uint8Array(x as number[])
  throw new Error(`${where} 应为字节`)
}

function encodeInto(s: Schema, obj: Msg, out: number[]): void {
  for (const f of s.fields) {
    const val: unknown = obj[f.name]
    if (val == null) continue
    const items: unknown[] = f.rep ? (val as unknown[]) : [val]
    for (const item of items) {
      if (f.k === "varint") {
        pushVarint(out, (f.n << 3) | 0)
        pushVarint(out, typeof item === "boolean" ? (item ? 1 : 0) : Number(item))
      } else if (f.k === "fixed32") {
        pushVarint(out, (f.n << 3) | 5)
        const x: number = Number(item) >>> 0
        out.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255)
      } else {
        const body: Uint8Array = f.k === "bytes" ? toBytesIn(item, `${s.name}.${f.name}`) : encode(f.k, item as Msg)
        pushVarint(out, (f.n << 3) | 2)
        pushVarint(out, body.length)
        for (let i = 0; i < body.length; i++) out.push(body[i])
      }
    }
  }
}

export function encode(s: Schema, obj: Msg): Uint8Array {
  const out: number[] = []
  encodeInto(s, obj, out)
  return new Uint8Array(out)
}

// ---- 解码 ----

class Reader {
  pos: number = 0
  readonly buf: Uint8Array
  readonly end: number

  constructor(buf: Uint8Array, end: number = buf.length) {
    this.buf = buf
    this.end = end
  }

  varint(): number {
    // 只取低 32 位（本模块的字段都是 uint32 / 枚举），超长时跳过高位
    let x: number = 0
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("varint 越界")
      const c: number = this.buf[this.pos++]
      if (i < 5) x |= (c & 0x7f) << (7 * i)
      if ((c & 0x80) === 0) return x >>> 0
    }
    throw new Error("varint 过长")
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.end) throw new Error("长度越界")
    const out: Uint8Array = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 1) this.take(8)
    else if (wire === 2) this.take(this.varint())
    else if (wire === 5) this.take(4)
    else throw new Error(`不支持的 wire type ${wire}`)
  }
}

function decodeFrom(s: Schema, r: Reader): Msg {
  const o: Msg = {}
  for (const f of s.fields) if (f.rep) o[f.name] = []
  while (r.pos < r.end) {
    const key: number = r.varint()
    const no: number = key >>> 3
    const wire: number = key & 7
    const f: Field | undefined = s.byNo.get(no)
    const want: number = !f ? -1 : f.k === "varint" ? 0 : f.k === "fixed32" ? 5 : 2
    if (!f || wire !== want) {
      r.skip(wire)
      continue
    }
    let val: unknown
    if (f.k === "varint") {
      val = r.varint()
    } else if (f.k === "fixed32") {
      const p: Uint8Array = r.take(4)
      val = (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0
    } else {
      const len: number = r.varint()
      if (f.k === "bytes") {
        val = r.take(len)
      } else {
        if (len < 0 || r.pos + len > r.end) throw new Error("长度越界")
        const sub: Reader = new Reader(r.buf, r.pos + len)
        sub.pos = r.pos
        val = decodeFrom(f.k, sub)
        r.pos += len
      }
    }
    if (f.rep) {
      o[f.name].push(val)
    } else {
      // 同一个 oneof 只保留最后出现的成员
      if (f.oneof) for (const g of s.fields) if (g.oneof === f.oneof && g !== f) delete o[g.name]
      o[f.name] = val
      if (f.oneof) o[f.oneof] = f.name
    }
  }
  return o
}

export function decode<R = Msg>(s: Schema, bytes: Uint8Array): R {
  return decodeFrom(s, new Reader(bytes)) as R
}
