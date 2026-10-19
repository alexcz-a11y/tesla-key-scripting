// 会话：握手校验、counter、时钟、AES-GCM 指令签名、响应解密、缓存
// 对应 Go internal/authentication/{signer,peer,native,window}.go 与 dispatcher/session.go
import { equalBytes, hex, randomBytes, toBytes, unhex, utf8 } from "./bytes"
import { aesGcmDecrypt, aesGcmEncrypt, importAesKey, subkey } from "./crypto_lite"
import { Metadata, SignatureType, Tag } from "./metadata"
import { decode, Types } from "./pb_lite"
import { Errors, TeslaError } from "./errors"

export const DEFAULT_EXPIRES_SEC: number = 5
const SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST: number = 1

export interface SessionInfoObj {
  counter?: number
  publicKey?: Uint8Array
  epoch?: Uint8Array
  clock_time?: number
  status?: number
  handle?: number
}

/**
 * 会话用到的钥匙材料。Session 自己不做 P-256 运算（小组件进程加载不了 @noble/curves）：
 * 主界面传入用私钥现算的实现（core/keystore.ts 的 sessionKeysFor，算出 K 时写入钥匙串缓存），
 * 小组件传入只读缓存的实现（core/keys_lite.ts 的 cachedSessionKeys）
 */
export interface SessionKeys {
  /** 65 字节本机公钥 */
  readonly localPublic: Uint8Array
  /** 会话密钥 K = SHA1(ECDH(本机私钥, 车辆公钥).x)[:16] */
  deriveK(vehiclePublic: Uint8Array): Promise<Uint8Array>
}

export interface SessionCache {
  domain: number
  vehiclePublicKey: string
  epoch: string
  counter: number
  clockTime: number
  /** 本地时间（毫秒）对应车辆 clock_time = 0 的时刻 */
  timeZeroMs: number
  savedAt: number
}

/** 响应防重放滑动窗口（64 位） */
export class SlidingWindow {
  private used: boolean = false
  private counter: number = 0
  private history: bigint = 0n

  update(newCounter: number): boolean {
    if (!this.used) {
      this.used = true
      this.counter = newCounter
      return true
    }
    if (newCounter === this.counter) return false
    if (newCounter < this.counter) {
      const age: number = this.counter - newCounter
      if (age > 64) return false
      const bit: bigint = 1n << BigInt(age - 1)
      if ((this.history & bit) !== 0n) return false
      this.history |= bit
      return true
    }
    const shift: number = newCounter - this.counter
    this.history = shift >= 64 ? 0n : (this.history << BigInt(shift)) & 0xffffffffffffffffn
    if (shift <= 64) this.history |= 1n << BigInt(shift - 1)
    this.counter = newCounter
    return true
  }
}

export interface EncryptResult {
  ciphertext: Uint8Array
  signatureData: Record<string, any>
  /** request hash：[5] + GCM tag，用于解密响应 */
  requestId: Uint8Array
}

export interface EncryptOverrides {
  nonce?: Uint8Array
  expiresAt?: number
  counter?: number
}

export class Session {
  readonly domain: number
  readonly vin: string
  private readonly keys: SessionKeys
  readonly localPublic: Uint8Array

  private K: Uint8Array | null = null
  private aesKey: CryptoKey | null = null
  private sessionInfoKey: Uint8Array | null = null
  vehiclePublicKey: Uint8Array | null = null
  epoch: Uint8Array = new Uint8Array(16)
  counter: number = 0
  private setTime: number = 0
  private timeZeroMs: number = 0
  ready: boolean = false

  constructor(domain: number, vin: string, keys: SessionKeys) {
    this.domain = domain
    this.vin = vin
    this.keys = keys
    this.localPublic = keys.localPublic
  }

  private get vinBytes(): Uint8Array {
    return utf8(this.vin)
  }

  private async setVehicleKey(pub: Uint8Array): Promise<void> {
    if (this.vehiclePublicKey && equalBytes(this.vehiclePublicKey, pub) && this.K) return
    this.K = await this.keys.deriveK(pub)
    this.aesKey = await importAesKey(this.K)
    this.sessionInfoKey = await subkey(this.K, "session info")
    this.vehiclePublicKey = new Uint8Array(pub)
  }

  /** session info 的 HMAC：HMAC(HMAC(K,"session info"), META‖0xFF‖encodedInfo) */
  async sessionInfoHMAC(challenge: Uint8Array, encodedInfo: Uint8Array): Promise<Uint8Array> {
    if (!this.sessionInfoKey) throw Errors.noSession()
    const meta: Metadata = new Metadata()
      .add(Tag.SIGNATURE_TYPE, new Uint8Array([SignatureType.HMAC]))
      .add(Tag.PERSONALIZATION, this.vinBytes)
      .add(Tag.CHALLENGE, challenge)
    return meta.hmacChecksum(this.sessionInfoKey, encodedInfo)
  }

  /**
   * 处理车辆发来的 session info（握手响应或错误时附带的重同步信息）。
   * tag 校验失败会抛错；成功后会话变为 ready。
   */
  async processHello(challenge: Uint8Array, encodedInfo: Uint8Array, tag: Uint8Array, nowMs: number = Date.now()): Promise<void> {
    const info: SessionInfoObj = decode<SessionInfoObj>(Types.SessionInfo, encodedInfo)
    if ((info.status ?? 0) === SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST) throw Errors.keyNotPaired()
    const pub: Uint8Array = toBytes(info.publicKey)
    if (pub.length !== 65) throw Errors.badResponse("session info 缺少车辆公钥")
    if (this.vehiclePublicKey && !equalBytes(this.vehiclePublicKey, pub)) {
      // 车辆换了密钥（例如更换了控制器）：重建会话
      this.ready = false
      this.K = null
    }
    await this.setVehicleKey(pub)
    const expected: Uint8Array = await this.sessionInfoHMAC(challenge, encodedInfo)
    if (!equalBytes(expected, tag)) throw new TeslaError("BAD_SESSION_TAG", "session info 校验失败（HMAC 不匹配）", false)

    const epoch: Uint8Array = toBytes(info.epoch)
    const clock: number = info.clock_time ?? 0
    const counter: number = info.counter ?? 0
    if (!this.ready) {
      this.epoch = epoch
      this.counter = counter
      this.setTime = clock
      this.timeZeroMs = nowMs - clock * 1000
      this.ready = true
      return
    }
    // 只在 epoch 变化或时钟不回退时更新；counter 只增不减
    if (!equalBytes(this.epoch, epoch) || this.setTime <= clock) {
      if (this.counter < counter) this.counter = counter
      this.epoch = epoch
      this.setTime = clock
      this.timeZeroMs = nowMs - clock * 1000
    }
  }

  /** 车辆时钟（秒） */
  vehicleClock(nowMs: number = Date.now()): number {
    return Math.floor((nowMs - this.timeZeroMs) / 1000)
  }

  /**
   * 用 AES-GCM-PERSONALIZED 加密指令负载。
   * flags 必须和最终发出去的 RoutableMessage.flags 一致。
   */
  async encrypt(plaintext: Uint8Array, flags: number, expiresInSec: number = DEFAULT_EXPIRES_SEC, ov: EncryptOverrides = {}): Promise<EncryptResult> {
    if (!this.ready || !this.aesKey) throw Errors.noSession()
    let counter: number
    if (ov.counter != null) {
      counter = ov.counter
    } else {
      if (this.counter >= 0xffffffff) throw new TeslaError("COUNTER_ROLLOVER", "计数器溢出，请重新握手", false)
      this.counter += 1
      counter = this.counter
    }
    const expiresAt: number = ov.expiresAt ?? Math.floor((Date.now() + expiresInSec * 1000 - this.timeZeroMs) / 1000)
    const meta: Metadata = new Metadata()
      .add(Tag.SIGNATURE_TYPE, new Uint8Array([SignatureType.AES_GCM_PERSONALIZED]))
      .add(Tag.DOMAIN, new Uint8Array([this.domain]))
      .add(Tag.PERSONALIZATION, this.vinBytes)
      .add(Tag.EPOCH, this.epoch)
      .addU32(Tag.EXPIRES_AT, expiresAt)
      .addU32(Tag.COUNTER, counter)
    if (flags > 0) meta.addU32(Tag.FLAGS, flags)
    const aad: Uint8Array = await meta.sha256Checksum()
    const nonce: Uint8Array = ov.nonce ?? randomBytes(12)
    const { ciphertext, tag } = await aesGcmEncrypt(this.aesKey, nonce, plaintext, aad)
    const requestId: Uint8Array = new Uint8Array(17)
    requestId[0] = SignatureType.AES_GCM_PERSONALIZED
    requestId.set(tag, 1)
    return {
      ciphertext,
      requestId,
      signatureData: {
        signer_identity: { public_key: this.localPublic },
        AES_GCM_Personalized_data: { epoch: this.epoch, nonce, counter, expires_at: expiresAt, tag },
      },
    }
  }

  /** 解密车辆的加密响应，返回明文与响应 counter */
  async decryptResponse(msg: Record<string, any>, requestId: Uint8Array): Promise<{ plaintext: Uint8Array; counter: number }> {
    if (!this.aesKey) throw Errors.noSession()
    const gcm: Record<string, any> | undefined = msg.signature_data?.AES_GCM_Response_data
    if (!gcm) throw Errors.badResponse("缺少 AES-GCM 响应数据")
    const counter: number = gcm.counter ?? 0
    const fault: number = msg.signedMessageStatus?.signed_message_fault ?? 0
    const domain: number = msg.from_destination?.domain ?? this.domain
    const meta: Metadata = new Metadata()
      .add(Tag.SIGNATURE_TYPE, new Uint8Array([SignatureType.AES_GCM_RESPONSE]))
      .add(Tag.DOMAIN, new Uint8Array([domain]))
      .add(Tag.PERSONALIZATION, this.vinBytes)
      .addU32(Tag.COUNTER, counter)
      .addU32(Tag.FLAGS, msg.flags ?? 0)
      .add(Tag.REQUEST_HASH, requestId)
      .addU32(Tag.FAULT, fault)
    const aad: Uint8Array = await meta.sha256Checksum()
    const plaintext: Uint8Array = await aesGcmDecrypt(this.aesKey, toBytes(gcm.nonce), toBytes(msg.protobuf_message_as_bytes), toBytes(gcm.tag), aad)
    return { plaintext, counter }
  }

  exportCache(): SessionCache | null {
    if (!this.ready || !this.vehiclePublicKey) return null
    return {
      domain: this.domain,
      vehiclePublicKey: hex(this.vehiclePublicKey),
      epoch: hex(this.epoch),
      counter: this.counter,
      clockTime: this.setTime,
      timeZeroMs: this.timeZeroMs,
      savedAt: Date.now(),
    }
  }

  async importCache(c: SessionCache): Promise<void> {
    await this.setVehicleKey(unhex(c.vehiclePublicKey))
    this.epoch = unhex(c.epoch)
    this.counter = c.counter
    this.setTime = c.clockTime
    this.timeZeroMs = c.timeZeroMs
    this.ready = true
  }

  reset(): void {
    this.ready = false
  }
}
