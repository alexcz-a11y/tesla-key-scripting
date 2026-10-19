// 不依赖 @noble/curves 的存储部分：车辆配置、会话状态缓存（Storage），本机公钥缓存（Storage，公开信息），
// 会话密钥缓存（Keychain）。小组件的轻量解锁路径只能用这些；core/keystore.ts 原样转出并加上私钥相关功能
import { hex, unhex } from "./bytes"
import { TeslaError } from "./errors"
import { log } from "./log"
import type { SessionKeys } from "./session"

const ST_CONFIG: string = "tesla_key.config.v1"
const ST_SESSIONS: string = "tesla_key.sessions.v1"
const ST_LOCAL_PUBLIC: string = "tesla_key.local_public.v1"
/**
 * 会话密钥 K（= SHA1(ECDH(本机私钥, 车辆公钥).x)[:16]）的缓存，由主界面在握手 / 恢复会话时写入。
 * 拿到 K 就能对这台车签名指令，和私钥一样敏感：只放钥匙串，「仅本机、手机解锁时才可读取」，不同步 iCloud；
 * 绑定本机公钥，换钥匙 / 删除钥匙时随 clearSessions 一起清除。2026-10-18 用户确认采用（小组件在 Scripting 关闭时解锁需要它）
 */
const KC_SESSION_KEYS: string = "tesla_key.session_keys.v2"

export interface VehicleConfig {
  vin: string
  name: string
  localName: string
  /** 上次连接到的外设 id（iOS 每台手机不同，用来快速重连） */
  peripheralId?: string
  /** 用户已确认配对成功 */
  paired: boolean
  pairedAt?: number
  /** 本机钥匙在车辆白名单里的槽位（读钥匙列表时记下） */
  keySlot?: number
  /** 靠近自动解锁 */
  autoUnlock: boolean
  /** 平滑后 RSSI 高于此值视为“贴近” */
  unlockRssi: number
  /** 平滑后 RSSI 低于此值视为“离开” */
  leaveRssi: number
  /** 离开后自动上锁 */
  autoLock: boolean
  debugLog: boolean
}

export const DEFAULT_CONFIG: VehicleConfig = {
  // VIN 由用户在「钥匙与设置 → 车辆与 VIN」里填写（setVin 会同时算出广播名 localName）
  vin: "",
  name: "Model Y",
  localName: "",
  paired: false,
  autoUnlock: false,
  unlockRssi: -62,
  leaveRssi: -85,
  autoLock: false,
  debugLog: false,
}

export function loadConfig(): VehicleConfig {
  const c: Partial<VehicleConfig> | null = Storage.get<Partial<VehicleConfig>>(ST_CONFIG)
  return { ...DEFAULT_CONFIG, ...(c ?? {}) }
}

export function saveConfig(c: VehicleConfig): void {
  Storage.set(ST_CONFIG, c)
}

// ---- 会话状态缓存（epoch / counter / 时钟，不含密钥） ----

/** 与 core/session.ts 的 SessionCache 相同（这里不导入 session，避免循环依赖） */
export interface SessionCacheData {
  domain: number
  vehiclePublicKey: string
  epoch: string
  counter: number
  clockTime: number
  timeZeroMs: number
  savedAt: number
}

export function loadSessions(): Record<string, SessionCacheData> {
  return Storage.get<Record<string, SessionCacheData>>(ST_SESSIONS) ?? {}
}

export function saveSession(c: SessionCacheData): void {
  const all: Record<string, SessionCacheData> = loadSessions()
  all[String(c.domain)] = c
  Storage.set(ST_SESSIONS, all)
}

export function clearSessions(): void {
  Storage.remove(ST_SESSIONS)
  clearSessionKeys()
}

// ---- 本机公钥（公开信息；由主界面算好存下，轻量路径不用再做 P-256 运算） ----

export function cachedLocalPublic(): Uint8Array | null {
  const s: string | null = Storage.get<string>(ST_LOCAL_PUBLIC)
  return s ? unhex(s) : null
}

export function saveLocalPublic(pub: Uint8Array | null): void {
  if (pub) Storage.set(ST_LOCAL_PUBLIC, hex(pub))
  else Storage.remove(ST_LOCAL_PUBLIC)
}

// ---- 会话密钥 K（钥匙串） ----

interface SessionKeyStore {
  /** 本机公钥 hex：换了钥匙就整体作废 */
  local: string
  /** 车辆公钥 hex → K hex */
  keys: Record<string, string>
}

function readKeyStore(): SessionKeyStore | null {
  try {
    const s: string | null = Keychain.get(KC_SESSION_KEYS)
    return s ? (JSON.parse(s) as SessionKeyStore) : null
  } catch (_e) {
    return null
  }
}

export function cacheSessionKey(localPublic: Uint8Array, vehiclePublic: Uint8Array, K: Uint8Array): void {
  const local: string = hex(localPublic)
  const prev: SessionKeyStore | null = readKeyStore()
  const store: SessionKeyStore = prev && prev.local === local ? prev : { local, keys: {} }
  store.keys[hex(vehiclePublic)] = hex(K)
  // Keychain.set 失败时返回 false（keychain 文档）：记下来，不然小组件之后只会报「没有缓存的会话密钥」
  if (!Keychain.set(KC_SESSION_KEYS, JSON.stringify(store), { accessibility: "unlocked_this_device" })) {
    log.warn("会话密钥写入钥匙串失败，小组件直连会用不了")
  }
}

export function cachedSessionKey(localPublic: Uint8Array, vehiclePublic: Uint8Array): Uint8Array | null {
  const store: SessionKeyStore | null = readKeyStore()
  if (!store || store.local !== hex(localPublic)) return null
  const k: string | undefined = store.keys[hex(vehiclePublic)]
  return k ? unhex(k) : null
}

export function clearSessionKeys(): void {
  try {
    Keychain.remove(KC_SESSION_KEYS)
  } catch (_e) {
    // 没有缓存即可
  }
}

/** 缺少缓存的 K：小组件无法自己算（没有 P-256），只能让用户先打开主界面 */
export function noCachedKey(): TeslaError {
  return new TeslaError("NO_CACHED_KEY", "小组件还没有这台车的会话密钥：请先打开一次 Tesla Key 主界面，连上车辆并解锁或上锁一次", false)
}

/** 小组件用的会话钥匙材料：只读缓存，不做 P-256 运算。没有本机公钥缓存时返回 null */
export function cachedSessionKeys(): SessionKeys | null {
  const localPublic: Uint8Array | null = cachedLocalPublic()
  if (!localPublic) return null
  return {
    localPublic,
    deriveK: async (vehiclePublic: Uint8Array): Promise<Uint8Array> => {
      const K: Uint8Array | null = cachedSessionKey(localPublic, vehiclePublic)
      if (!K) throw noCachedKey()
      return K
    },
  }
}
