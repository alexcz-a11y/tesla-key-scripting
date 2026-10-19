// 界面状态：单例车辆客户端 + 连接 / 状态推送 / RSSI / 进行中的指令，各页面通过 useApp() 订阅
import { useEffect, useState, Widget } from "scripting"
import { describeError, TeslaError } from "../core/errors"
import { getPublicKeyId, hasPrivateKey, loadConfig, saveConfig, VehicleConfig } from "../core/keystore"
import { log } from "../core/log"
import { ClosureState, LockState, SleepStatus } from "../core/proto"
import { ConnState } from "../core/transport_ble"
import { DoorKey, VehicleClient } from "../client/vehicle"
import { VehicleStatus } from "../client/vcsec"
import { Act, CATEGORIES, Category, HeaterLevel, isValidPin, Seat } from "../client/infotainment"
import { Msg } from "../client/dispatcher"
import { closureOpen, closureRequest, COMMAND_ZH, isDoorCommand, isLockedState, isWidgetCommand, loadSnapshot as loadBodySnapshot, nextSelective, saveSnapshot, waitForTarget, WIDGET_DOORS, WidgetCommand } from "../core/widget_cmds"

const ST_CAR: string = "tesla_key.car.v1"
const RSSI_INTERVAL_MS: number = 3000
/** 单条指令（含连接、唤醒车机）的总时限 */
const RUN_LIMIT_MS: number = 120000

export const client: VehicleClient = new VehicleClient()

export interface AppState {
  conn: ConnState
  connErr: string | null
  rssi: number | null
  status: VehicleStatus | null
  /** 状态时间（毫秒）；live=false 时是上次保存的快照 */
  statusAt: number | null
  live: boolean
  /** 正在执行的指令 key（同一时间只跑一个） */
  busy: string | null
  /** 整车上锁时弹开了单门：车辆此时报 UNLOCKED，但其余门仍锁着 */
  selective: boolean
  keyId: string | null
  hasKey: boolean
  config: VehicleConfig
  /** 成功 / 失败计数，用来触发触感反馈 */
  okCount: number
  errCount: number
  /** 车机（Infotainment）状态，按 GetVehicleData 分类；carLive=false 时是上次保存的快照 */
  car: CarData
  carAt: number | null
  carLive: boolean
  carLoading: boolean
  carErr: string | null
  /** 本次读取失败的分类及原因（例如本车不回复胎压） */
  carMissing: Partial<Record<Category, string>>
}

export type CarData = Partial<Record<Category, Msg>>

function loadSnapshot(): { status: VehicleStatus; at: number; selective?: boolean } | null {
  return loadBodySnapshot<VehicleStatus>()
}

function loadCarSnapshot(): { car: CarData; at: number } | null {
  try {
    return Storage.get<{ car: CarData; at: number }>(ST_CAR)
  } catch (_e) {
    return null
  }
}

const snap = loadSnapshot()
const carSnap = loadCarSnapshot()
let state: AppState = {
  conn: "idle",
  connErr: null,
  rssi: null,
  status: snap?.status ?? null,
  statusAt: snap?.at ?? null,
  live: false,
  busy: null,
  selective: snap?.selective ?? false,
  keyId: null,
  hasKey: hasPrivateKey(),
  config: loadConfig(),
  okCount: 0,
  errCount: 0,
  car: carSnap?.car ?? {},
  carAt: carSnap?.at ?? null,
  carLive: false,
  carLoading: false,
  carErr: null,
  carMissing: {},
}

const listeners: Set<() => void> = new Set()
const pushListeners: Set<(s: VehicleStatus) => void> = new Set()

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

export function getState(): AppState {
  return state
}

/** 订阅状态变化，返回取消函数 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 订阅车辆推送的原始状态（调试页用） */
export function onPush(fn: (s: VehicleStatus) => void): () => void {
  pushListeners.add(fn)
  return () => {
    pushListeners.delete(fn)
  }
}

export function useApp(): AppState {
  const [s, setS] = useState<AppState>(state)
  useEffect(() => subscribe(() => setS(state)), [])
  return s
}

function applyStatus(st: VehicleStatus): void {
  const at: number = Date.now()
  // 单门弹开后车辆报 UNLOCKED，但实测其余门和前后备箱仍然拉不开：这个标记的规则见 core/widget_cmds 的 nextSelective
  const selective: boolean = nextSelective(state.selective, null, false, st.vehicleLockState)
  set({ status: st, statusAt: at, live: true, selective })
  // 单门弹开标记一起保存：重新打开 App 时车辆仍报 UNLOCKED，但其余门其实还锁着
  saveSnapshot({ status: st, at, selective })
}

client.onStatusPush = (st: VehicleStatus) => {
  applyStatus(st)
  for (const l of [...pushListeners]) l(st)
}

let rssiTimer: any = null

function startRssi(): void {
  if (rssiTimer) return
  const tick = async (): Promise<void> => {
    const v: number | null = await client.transport.readRSSI()
    if (v != null && v !== state.rssi) set({ rssi: v })
  }
  void tick()
  rssiTimer = setInterval(() => void tick(), RSSI_INTERVAL_MS)
}

function stopRssi(): void {
  if (rssiTimer) clearInterval(rssiTimer)
  rssiTimer = null
}

client.transport.onStateChange = (s: ConnState, err?: string) => {
  if (s === "connected") startRssi()
  else stopRssi()
  set({ conn: s, connErr: err ?? null, live: s === "connected" ? state.live : false, rssi: s === "connected" ? state.rssi : null })
}

export function reloadKeyInfo(): void {
  set({ hasKey: hasPrivateKey(), config: loadConfig() })
  void getPublicKeyId().then((id: string | null) => set({ keyId: id }))
}

export function updateConfig(patch: Partial<VehicleConfig>): void {
  const c: VehicleConfig = { ...loadConfig(), ...patch }
  saveConfig(c)
  set({ config: c })
}

let connecting: Promise<void> | null = null

/** 连接并读一次状态；已连接则直接返回 */
export function ensureConnected(): Promise<void> {
  if (client.connected) return Promise.resolve()
  if (connecting) return connecting
  connecting = (async () => {
    try {
      await client.connect()
      applyStatus(await client.status())
    } finally {
      connecting = null
    }
  })()
  return connecting
}

/** 打开页面时自动连接；失败只记录，不弹窗 */
export function autoConnect(): void {
  ensureConnected().catch((e: any) => {
    log.warn("自动连接失败: " + describeError(e))
    set({ connErr: describeError(e) })
  })
}

export async function disconnect(): Promise<void> {
  await client.disconnect()
}

/**
 * 执行一条指令：需要时先连接，结束后读一次状态。
 * 失败弹窗显示中文原因；「可能已执行」的错误也照实提示。
 */
export async function run(key: string, job: () => Promise<void>): Promise<boolean> {
  if (state.busy) return false
  set({ busy: key })
  try {
    // 兜底：任何一步卡住（例如蓝牙 Promise 不返回），最多 2 分钟后放开界面
    let timer: any = null
    const limit: Promise<never> = new Promise<never>((_r, reject: (e: Error) => void) => {
      timer = setTimeout(() => reject(new TeslaError("STUCK", "操作超过 2 分钟没有结束，已放弃等待", false, true)), RUN_LIMIT_MS)
    })
    try {
      await Promise.race([(async () => {
        await ensureConnected()
        await job()
      })(), limit])
    } finally {
      clearTimeout(timer)
    }
    try {
      applyStatus(await client.status())
    } catch (e: any) {
      log.warn("指令后读取状态失败: " + describeError(e))
    }
    set({ busy: null, okCount: state.okCount + 1 })
    return true
  } catch (e: any) {
    set({ busy: null, errCount: state.errCount + 1 })
    const maybe: string = e?.possibleSuccess ? "\n\n指令可能已经执行，请看车辆状态确认。" : ""
    await Dialog.alert({ title: "没有完成", message: describeError(e) + maybe })
    return false
  }
}

/**
 * 小组件通过 ScriptSession 交给主脚本的指令。不弹窗，结果返回给小组件；
 * 每条指令都要能重复执行（小组件在主脚本超时后会改走直连，可能再执行一次）：前后备箱的 MOVE 按当前状态决定发不发
 */
export async function handleRemote(cmd: unknown): Promise<{ ok: boolean; error?: string; ms?: number }> {
  if (!isWidgetCommand(cmd)) return { ok: false, error: "不支持的指令" }
  log.info(`小组件指令：${cmd}`)
  const t0: number = Date.now()
  const r = await doRemote(cmd)
  log.info(`小组件指令完成：${r.ok ? "成功" : "失败 " + r.error}，主脚本用时 ${Date.now() - t0} ms`)
  return { ...r, ms: Date.now() - t0 }
}

async function doRemote(cmd: WidgetCommand): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureConnected()
    if (cmd === "unlock" || cmd === "lock") {
      if (cmd === "unlock") await client.unlock()
      else await client.lock()
      set({ selective: false })
    } else {
      // 开合类指令按最新状态决定发不发（已经到位就不发，重复执行也安全）
      const st: VehicleStatus = await client.status()
      const req: Record<string, number> | null = closureRequest(cmd, st.closureStatuses as Record<string, number | undefined> | undefined)
      if (!req) log.info(`${COMMAND_ZH[cmd]}：已经是目标状态，不发送`)
      else if (isDoorCommand(cmd)) {
        await client.door(WIDGET_DOORS[cmd])
        if (isLockedState(st.vehicleLockState)) set({ selective: true })
      } else if (cmd === "frunk_open") await client.openFrunk()
      else if (cmd === "trunk_open") await client.openTrunk()
      else if (cmd === "trunk_close") await client.closeTrunk()
      else if (cmd === "charge_open") await client.openChargePort()
      else if (cmd === "charge_close") await client.closeChargePort()
    }
    // 指令已发出就先回复小组件（不让小组件那边等到超时、改走直连再发一次），
    // 再在后台等车辆动完、存快照、刷新小组件
    void settleAndReload(cmd)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: describeError(e) }
  }
}

async function settleAndReload(cmd: WidgetCommand): Promise<void> {
  const w = await waitForTarget(cmd, () => client.status())
  log.info(`${COMMAND_ZH[cmd]}：${w.reached ? "已到位" : "未确认到位"}，用时 ${w.ms} ms`)
  if (w.status) applyStatus(w.status)
  Widget.reloadAll()
}

// ---- 车机（Infotainment） ----

const ALL_CATS: Category[] = Object.keys(CATEGORIES) as Category[]
let refreshing: Promise<void> | null = null

/**
 * 读车机状态（逐个分类，车机睡着会先唤醒）。一个分类失败不影响其他分类；
 * 唤醒 / 握手这类整体性失败直接结束。
 */
export function refreshCar(cats: Category[] = ALL_CATS, wake: boolean = true): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    set({ carLoading: true, carErr: null })
    // carErr 只表示整体失败（一个分类都没读到）；单个分类读不到记在 carMissing
    let lastErr: string | null = null
    try {
      await ensureConnected()
      for (const cat of cats) {
        try {
          const data: Msg = await client.carState(cat, wake)
          const missing: Partial<Record<Category, string>> = { ...state.carMissing }
          delete missing[cat]
          set({ car: { ...(state.carLive ? state.car : {}), [cat]: data }, carAt: Date.now(), carLive: true, carMissing: missing })
        } catch (e: any) {
          const msg: string = describeError(e)
          log.warn(`读取车机 ${cat} 失败: ${msg}`)
          set({ carMissing: { ...state.carMissing, [cat]: msg } })
          if (!state.carLive) {
            lastErr = msg
            break
          }
        }
      }
      try {
        Storage.set(ST_CAR, { car: state.car, at: state.carAt })
      } catch (_e) {
        // 快照只是缓存
      }
    } catch (e: any) {
      lastErr = describeError(e)
    } finally {
      set({ carLoading: false, carErr: lastErr })
      refreshing = null
    }
  })()
  return refreshing
}

/** 发一条车机指令，成功后在后台刷新相关分类 */
function carRun(key: string, action: Msg, what: string, cats: Category[]): Promise<boolean> {
  return run(key, async () => {
    await client.car(action, what)
  }).then((ok: boolean) => {
    if (ok) void refreshCar(cats)
    return ok
  })
}

/** 让用户输入一个数，范围外返回 null */
async function askNumber(title: string, message: string, initial: number | undefined, min: number, max: number): Promise<number | null> {
  const raw: string | null = await Dialog.prompt({ title, message, defaultValue: initial != null ? String(initial) : "", keyboardType: "decimalPad" })
  if (raw == null || raw.trim() === "") return null
  const v: number = Number(raw.trim())
  if (!Number.isFinite(v) || v < min || v > max) {
    await Dialog.alert({ title: "数值超出范围", message: `请输入 ${min} 到 ${max} 之间的数。` })
    return null
  }
  return v
}

export const carActions = {
  climate: (on: boolean) => carRun("climate", Act.climate(on), on ? "开空调" : "关空调", ["climate"]),
  temp: async () => {
    const cl: Msg = state.car.climate ?? {}
    const min: number = cl.min_avail_temp_celsius ?? 15
    const max: number = cl.max_avail_temp_celsius ?? 28
    const v: number | null = await askNumber("设定温度", `摄氏度，${min} 到 ${max}，主驾和副驾同时设置`, cl.driver_temp_setting, min, max)
    if (v != null) await carRun("temp", Act.temps(v, v), "设定温度", ["climate"])
  },
  seatHeater: (seat: Seat, level: HeaterLevel) => carRun("seat", Act.seatHeaters([[seat, level]]), "座椅加热", ["climate"]),
  steeringHeater: (on: boolean) => carRun("wheel", Act.steeringHeater(on), "方向盘加热", ["climate"]),
  defrost: (on: boolean) => carRun("defrost", Act.defrostMax(on), "最大除霜", ["climate"]),
  keeper: (mode: number) => carRun("keeper", Act.keeper(mode), "保持空调", ["climate"]),
  chargeStart: () => carRun("charge", Act.chargeStart(), "开始充电", ["charge"]),
  chargeStop: () => carRun("charge", Act.chargeStop(), "停止充电", ["charge"]),
  chargeLimit: async () => {
    const ch: Msg = state.car.charge ?? {}
    const min: number = ch.charge_limit_soc_min ?? 50
    const max: number = ch.charge_limit_soc_max ?? 100
    const v: number | null = await askNumber("充电上限", `百分比，${min} 到 ${max}`, ch.charge_limit_soc, min, max)
    if (v != null) await carRun("chargeLimit", Act.chargeLimit(Math.round(v)), "设置充电上限", ["charge"])
  },
  chargeAmps: async () => {
    const ch: Msg = state.car.charge ?? {}
    const max: number = ch.charge_current_request_max ?? 32
    const v: number | null = await askNumber("充电电流", `安培，1 到 ${max}`, ch.charging_amps ?? ch.charge_current_request, 1, max)
    if (v != null) await carRun("chargeAmps", Act.chargeAmps(Math.round(v)), "设置充电电流", ["charge"])
  },
  windows: async (cmd: "vent" | "close") => {
    if (cmd === "close") {
      const ok: boolean = await Dialog.confirm({ title: "关闭全部车窗", message: "车辆不会检查窗边有没有人或物，请确认车窗附近安全。", confirmLabel: "关闭" })
      if (!ok) return
    }
    await carRun("windows", Act.windows(cmd), cmd === "vent" ? "车窗通风" : "关闭车窗", ["closures"])
  },
  sentry: (on: boolean) => carRun("sentry", Act.sentry(on), on ? "开启哨兵" : "关闭哨兵", ["closures"]),
  honk: async () => {
    const ok: boolean = await Dialog.confirm({ title: "鸣笛", message: "车辆须在 P 挡。", confirmLabel: "鸣笛" })
    if (ok) await carRun("honk", Act.honk(), "鸣笛", [])
  },
  flash: () => carRun("flash", Act.flash(), "闪灯", []),
  media: (cmd: "toggle" | "next" | "prev" | "up" | "down") => {
    const a: Msg = cmd === "toggle" ? Act.mediaToggle() : cmd === "next" ? Act.mediaNext() : cmd === "prev" ? Act.mediaPrev() : Act.volume(cmd === "up" ? 1 : -1)
    return carRun("media", a, "媒体", ["media"])
  },

  // ---- 第四档：都要二次确认；PIN 每次现场输入，不保存 ----

  valetOn: async () => {
    const pin: string | null = await askPin("开启代客模式", "设置一个 4 位数字 PIN，关闭代客模式时车上要输入它。代客模式会限制速度和功能，并关闭 PIN 驾驶。")
    if (pin == null) return
    if (await confirm("开启代客模式", "确认开启？", "开启")) await carRun("valet", Act.valet(true, pin), "开启代客模式", ["closures"])
  },
  valetOff: async () => {
    if (!(await confirm("关闭代客模式", "确认关闭代客模式？", "关闭"))) return
    const ok: boolean = await run("valet", async () => {
      try {
        await client.car(Act.valet(false, ""), "关闭代客模式")
      } catch (e: any) {
        // SDK：关闭时车辆回 already off 视为成功
        if (!(e instanceof TeslaError && e.code === "CAR_ERROR" && e.message.includes("already off"))) throw e
      }
    })
    if (ok) void refreshCar(["closures"])
  },
  resetValetPin: async () => {
    if (await confirm("重置代客 PIN", "清除代客模式的 PIN（须先关闭代客模式）。", "重置")) await carRun("valetPin", Act.resetValetPin(), "重置代客 PIN", ["closures"])
  },
  speedLimitSet: async () => {
    const lm: Msg = state.car.closures?.speed_limit_mode ?? {}
    const min: number = Math.ceil((lm.min_limit_mph ?? 50) * KMH_PER_MPH)
    const max: number = Math.floor((lm.max_limit_mph ?? 90) * KMH_PER_MPH)
    const cur: number | undefined = lm.current_limit_mph != null ? Math.round(lm.current_limit_mph * KMH_PER_MPH) : undefined
    const kmh: number | null = await askNumber("限速值", `公里每小时，${min} 到 ${max}（车辆按英里每小时保存，会有 1 km/h 左右的换算误差）`, cur, min, max)
    if (kmh == null) return
    if (await confirm("设置限速值", `设为 ${Math.round(kmh)} km/h？只改数值，不会启用限速。`, "设置")) {
      await carRun("speedLimit", Act.speedLimitSet(kmh / KMH_PER_MPH), "设置限速值", ["closures"])
    }
  },
  speedLimitActivate: async (on: boolean) => {
    const pin: string | null = await askPin(on ? "启用限速" : "停用限速", on ? "输入 4 位限速 PIN（第一次启用时就是设定 PIN）。" : "输入启用限速时设定的 4 位 PIN。")
    if (pin == null) return
    if (await confirm(on ? "启用限速" : "停用限速", on ? "启用后车速会被限制在设定值。" : "确认停用限速？", on ? "启用" : "停用")) {
      await carRun("speedLimit", Act.speedLimitActivate(on, pin), on ? "启用限速" : "停用限速", ["closures"])
    }
  },
  speedLimitClearPin: async () => {
    const pin: string | null = await askPin("清除限速 PIN", "输入当前的 4 位限速 PIN。清除后限速会停用。")
    if (pin == null) return
    if (await confirm("清除限速 PIN", "确认清除？", "清除")) await carRun("speedLimit", Act.speedLimitClearPin(pin), "清除限速 PIN", ["closures"])
  },
  speedLimitClearPinAdmin: async () => {
    if (await confirm("忘记 PIN：用车主钥匙清除", "不需要旧 PIN，直接停用限速并清除 PIN（需要车主钥匙，固件 2023.38 以上）。", "清除")) {
      await carRun("speedLimit", Act.speedLimitClearPinAdmin(), "清除限速 PIN（车主）", ["closures"])
    }
  },
  lowPower: async (on: boolean) => {
    const msg: string = on ? "车辆会减少待机耗电，但手机唤醒和连接会变慢。" : "关闭后待机耗电会增加。"
    if (await confirm(on ? "开启低功耗模式" : "关闭低功耗模式", msg, on ? "开启" : "关闭")) await carRun("lowPower", Act.lowPower(on), "低功耗模式", [])
  },
  keepAccessoryPower: async (on: boolean) => {
    const msg: string = on ? "下车后 USB、无线充电和 12V 插座继续供电，直到车辆进入低功耗；即使没接设备也会多耗电。" : "下车后附件按正常逻辑断电。"
    if (await confirm(on ? "开启保持附件供电" : "关闭保持附件供电", msg, on ? "开启" : "关闭")) await carRun("accessory", Act.keepAccessoryPower(on), "保持附件供电", [])
  },
  updateSchedule: async () => {
    const min: number | null = await askNumber("安排安装软件更新", "多少分钟后开始安装（1 到 1440）。安装期间车辆不能使用，开始后不能取消。", 2, 1, 1440)
    if (min == null) return
    if (await confirm("安排安装", `${Math.round(min)} 分钟后开始安装？`, "安排")) {
      await carRun("update", Act.updateSchedule(Math.round(min) * 60), "安排软件更新", ["update"])
    }
  },
  updateCancel: async () => {
    if (await confirm("取消安装倒计时", "已经开始安装的更新不能取消。", "取消安装")) await carRun("update", Act.updateCancel(), "取消软件更新", ["update"])
  },
}

const KMH_PER_MPH: number = 1.609344

function confirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return Dialog.confirm({ title, message, confirmLabel })
}

/** 输入 4 位数字 PIN（遮挡显示，不保存）；格式不对返回 null */
async function askPin(title: string, message: string): Promise<string | null> {
  const raw: string | null = await Dialog.prompt({ title, message, obscureText: true, keyboardType: "numberPad", placeholder: "4 位数字" })
  if (raw == null || raw === "") return null
  const pin: string = raw.trim()
  if (!isValidPin(pin)) {
    await Dialog.alert({ title: "PIN 格式不对", message: "PIN 必须是 4 位数字。" })
    return null
  }
  return pin
}

// ---- 指令 ----

/** 开着（含半开、正在打开），定义在 core/widget_cmds，界面和小组件共用 */
export const isOpen = closureOpen

export const actions = {
  unlock: () => run("unlock", async () => {
    await client.unlock()
    set({ selective: false })
  }),
  lock: () => run("lock", async () => {
    await client.lock()
    set({ selective: false })
  }),
  wake: () => run("wake", () => client.wake()),
  trunk: () => run("rearTrunk", () => client.openTrunk()),
  frunk: async () => {
    const ok: boolean = await Dialog.confirm({ title: "打开前备箱", message: "前备箱打开后需要手动按下关闭。" })
    if (ok) await run("frontTrunk", () => client.openFrunk())
  },
  /** 充电口：开着就关，否则打开 */
  chargePort: () => run("chargePort", () => (isOpen(state.status?.closureStatuses?.chargePort) ? client.closeChargePort() : client.openChargePort())),
  door: (key: DoorKey) => run(key, async () => {
    const wasLocked: boolean = isLockedState(state.status?.vehicleLockState)
    await client.door(key)
    if (wasLocked) set({ selective: true })
  }),
}

export function isAsleep(st: VehicleStatus | null): boolean {
  return (st?.vehicleSleepStatus ?? 0) === SleepStatus.ASLEEP
}
