// 本地钥匙与车辆配置：私钥存 Keychain（仅本机），其余配置存 Storage。
// 不依赖 P-256 的部分（配置、会话缓存、公钥 / 会话密钥缓存）在 keys_lite.ts，这里原样转出
import { equalBytes, hex, unhex } from "./bytes"
import { generatePrivateKey, publicKeyFromPrivate, publicKeyId, sessionKeysFromPrivate, vehicleLocalName } from "./crypto"
import { cachedSessionKey, cacheSessionKey, clearSessions, loadConfig, saveConfig, saveLocalPublic, VehicleConfig } from "./keys_lite"
import type { SessionKeys } from "./session"

export {
  cachedLocalPublic, cachedSessionKey, cachedSessionKeys, cacheSessionKey, clearSessionKeys, clearSessions, DEFAULT_CONFIG,
  loadConfig, loadSessions, saveConfig, saveLocalPublic, saveSession,
} from "./keys_lite"
export type { SessionCacheData, VehicleConfig } from "./keys_lite"

const KC_PRIVATE: string = "tesla_key.private_key.v1"

export async function setVin(vin: string): Promise<VehicleConfig> {
  const v: string = vin.trim().toUpperCase()
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) throw new Error("VIN 必须是 17 位字母数字（不含 I/O/Q）")
  const c: VehicleConfig = loadConfig()
  if (c.vin !== v) {
    c.vin = v
    c.localName = await vehicleLocalName(v)
    c.peripheralId = undefined
    c.paired = false
    clearSessions()
  }
  saveConfig(c)
  return c
}

// ---- 私钥 ----

export function hasPrivateKey(): boolean {
  return Keychain.contains(KC_PRIVATE)
}

export function loadPrivateKey(): Uint8Array | null {
  const d: Data | null = Keychain.getData(KC_PRIVATE)
  if (!d) {
    const s: string | null = Keychain.get(KC_PRIVATE)
    return s ? unhex(s) : null
  }
  const u: Uint8Array | null = d.toUint8Array()
  return u && u.length === 32 ? u : null
}

/** 生成新钥匙（会覆盖旧钥匙，旧钥匙需要在车机上删除） */
export function createPrivateKey(): Uint8Array {
  const sk: Uint8Array = generatePrivateKey()
  const data: Data | null = Data.fromUint8Array(sk)
  let ok: boolean = false
  if (data) ok = Keychain.setData(KC_PRIVATE, data, { accessibility: "first_unlock_this_device" })
  if (!ok) ok = Keychain.set(KC_PRIVATE, hex(sk), { accessibility: "first_unlock_this_device" })
  if (!ok) throw new Error("无法把私钥写入钥匙串")
  const c: VehicleConfig = loadConfig()
  c.paired = false
  saveConfig(c)
  clearSessions()
  saveLocalPublic(publicKeyFromPrivate(sk))
  return sk
}

export function deletePrivateKey(): void {
  Keychain.remove(KC_PRIVATE)
  const c: VehicleConfig = loadConfig()
  c.paired = false
  saveConfig(c)
  clearSessions()
  saveLocalPublic(null)
}

/**
 * 主界面用的会话钥匙材料：用私钥现算 K，并写入钥匙串缓存，供小组件在 Scripting 关闭时解锁（2026-10-18 用户确认）。
 * 握手或从缓存恢复会话时都会算一次 K，所以主界面连上车并发过一次 VCSEC 指令后，小组件就能用
 */
export function sessionKeysFor(priv: Uint8Array): SessionKeys {
  const keys: SessionKeys = sessionKeysFromPrivate(priv, (vehiclePublic: Uint8Array, K: Uint8Array) => {
    try {
      if (!equalBytes(cachedSessionKey(keys.localPublic, vehiclePublic), K)) cacheSessionKey(keys.localPublic, vehiclePublic, K)
    } catch (_e) {
      // 写不进钥匙串只影响小组件，主界面照常使用
    }
  })
  saveLocalPublic(keys.localPublic)
  return keys
}

/** 本机公钥；算出后顺便存一份（公开信息），小组件的轻量路径直接读取 */
export function getPublicKey(): Uint8Array | null {
  const sk: Uint8Array | null = loadPrivateKey()
  const pub: Uint8Array | null = sk ? publicKeyFromPrivate(sk) : null
  saveLocalPublic(pub)
  return pub
}

export async function getPublicKeyId(): Promise<string | null> {
  const pub: Uint8Array | null = getPublicKey()
  return pub ? publicKeyId(pub) : null
}

// 曾短暂把会话密钥缓存在钥匙串的 v1（实测 ECDH 只要几毫秒，当时撤销；现在小组件需要，改用 keys_lite 的 v2），启动时清理残留
try {
  if (Keychain.contains("tesla_key.session_keys.v1")) Keychain.remove("tesla_key.session_keys.v1")
} catch (_e) {
  // 没有残留即可
}
