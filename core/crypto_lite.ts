// 加密原语（只用系统 WebCrypto）：SHA1 / SHA256 / HMAC / AES-GCM。不依赖 @noble/curves，小组件的轻量解锁路径也能用。
// 需要 P-256 运算的部分（生成钥匙、公钥、ECDH）在 core/crypto.ts
import { hex, utf8 } from "./bytes"

const subtle: SubtleCrypto = crypto.subtle

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-1", data))
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", data))
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k: CryptoKey = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await subtle.sign("HMAC", k, data))
}

export async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

export interface GcmOutput {
  ciphertext: Uint8Array
  tag: Uint8Array
}

export async function aesGcmEncrypt(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<GcmOutput> {
  const out: Uint8Array = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext))
  return { ciphertext: out.slice(0, out.length - 16), tag: out.slice(out.length - 16) }
}

export async function aesGcmDecrypt(key: CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const joined: Uint8Array = new Uint8Array(ciphertext.length + tag.length)
  joined.set(ciphertext, 0)
  joined.set(tag, ciphertext.length)
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, joined))
}

/** HMAC 子密钥：HMAC-SHA256(K, label) */
export async function subkey(K: Uint8Array, label: string): Promise<Uint8Array> {
  return hmacSha256(K, utf8(label))
}

/** 车辆 BLE 广播名：S + hex(SHA1(VIN)[0:8]) + C */
export async function vehicleLocalName(vin: string): Promise<string> {
  const d: Uint8Array = await sha1(utf8(vin))
  return "S" + hex(d.slice(0, 8)) + "C"
}

/** 公钥 SHA1 前 4 字节（车机钥匙列表里的 keyId 显示用） */
export async function publicKeyId(pub: Uint8Array): Promise<string> {
  return hex((await sha1(pub)).slice(0, 4))
}
