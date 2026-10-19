// 元数据 TLV 序列化（对应 Go internal/authentication/metadata.go）
// 格式：tag(1) len(1) value，按 tag 递增；结尾 0xFF 再接 message，然后取 SHA256 或 HMAC
import { concat, u32be } from "./bytes"
import { hmacSha256, sha256 } from "./crypto_lite"

export const Tag = {
  SIGNATURE_TYPE: 0,
  DOMAIN: 1,
  PERSONALIZATION: 2,
  EPOCH: 3,
  EXPIRES_AT: 4,
  COUNTER: 5,
  CHALLENGE: 6,
  FLAGS: 7,
  REQUEST_HASH: 8,
  FAULT: 9,
  END: 255,
} as const

export const SignatureType = {
  AES_GCM: 0,
  AES_GCM_PERSONALIZED: 5,
  HMAC: 6,
  HMAC_PERSONALIZED: 8,
  AES_GCM_RESPONSE: 9,
} as const

export class Metadata {
  private parts: Uint8Array[] = []
  private last: number = -1

  add(tag: number, value: Uint8Array | null | undefined): this {
    if (tag < this.last) throw new Error("metadata items must be added in increasing tag order")
    if (value == null) return this
    if (value.length > 255) throw new Error("metadata field longer than 255 bytes")
    this.last = tag
    this.parts.push(new Uint8Array([tag, value.length]), value)
    return this
  }

  addU32(tag: number, value: number): this {
    return this.add(tag, u32be(value >>> 0))
  }

  /** TLV 串（不含 END） */
  serialize(): Uint8Array {
    return concat(...this.parts)
  }

  private withEnd(message?: Uint8Array): Uint8Array {
    return concat(this.serialize(), new Uint8Array([Tag.END]), message ?? new Uint8Array(0))
  }

  async sha256Checksum(message?: Uint8Array): Promise<Uint8Array> {
    return sha256(this.withEnd(message))
  }

  async hmacChecksum(key: Uint8Array, message?: Uint8Array): Promise<Uint8Array> {
    return hmacSha256(key, this.withEnd(message))
  }
}
