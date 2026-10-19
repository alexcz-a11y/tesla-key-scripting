// 加密原语：P-256（@noble/curves）生成钥匙、公钥、ECDH；其余（SHA / HMAC / AES-GCM）在 crypto_lite.ts，这里原样转出。
// 小组件进程加载不了 @noble/curves（2026-10-18 实测：加载到这个库时进程被终止），所以轻量解锁路径只导入 crypto_lite
import { p256 } from "@noble/curves/nist.js"
import { hex } from "./bytes"
import { sha1 } from "./crypto_lite"
import type { SessionKeys } from "./session"

export {
  aesGcmDecrypt, aesGcmEncrypt, hmacSha256, importAesKey, publicKeyId, sha1, sha256, subkey, vehicleLocalName,
} from "./crypto_lite"
export type { GcmOutput } from "./crypto_lite"

/** 生成 32 字节 P-256 私钥标量 */
export function generatePrivateKey(): Uint8Array {
  const u: any = p256.utils as any
  const sk: Uint8Array = typeof u.randomSecretKey === "function" ? u.randomSecretKey() : u.randomPrivateKey()
  return new Uint8Array(sk)
}

/** 65 字节未压缩公钥 0x04||X||Y */
export function publicKeyFromPrivate(priv: Uint8Array): Uint8Array {
  return new Uint8Array(p256.getPublicKey(priv, false))
}

export function isValidPublicKey(pub: Uint8Array): boolean {
  try {
    p256.Point.fromHex(hex(pub))
    return pub.length === 65
  } catch (_e) {
    return false
  }
}

/** 会话密钥 K = SHA1(ECDH(priv, peerPub).x)[:16] */
export async function deriveSessionKey(priv: Uint8Array, peerPub: Uint8Array): Promise<Uint8Array> {
  const shared: Uint8Array = p256.getSharedSecret(priv, peerPub, false)
  const x: Uint8Array = shared.slice(1, 33)
  return (await sha1(x)).slice(0, 16)
}

/** 用私钥现算的会话钥匙材料（core/session.ts 的 SessionKeys）；onDerived 在每次算出 K 后调用 */
export function sessionKeysFromPrivate(priv: Uint8Array, onDerived?: (vehiclePublic: Uint8Array, K: Uint8Array) => void): SessionKeys {
  const localPublic: Uint8Array = publicKeyFromPrivate(priv)
  return {
    localPublic,
    deriveK: async (vehiclePublic: Uint8Array): Promise<Uint8Array> => {
      const K: Uint8Array = await deriveSessionKey(priv, vehiclePublic)
      onDerived?.(vehiclePublic, K)
      return K
    },
  }
}
