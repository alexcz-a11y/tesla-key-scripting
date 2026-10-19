// 小组件能发的指令和车身状态快照：小组件、AppIntent、主脚本（ScriptSession）、直连（client/quick）共用。
// 只依赖轻量模块（小组件进程会静态加载本文件，不能带 npm 包）
import { sleep } from "./bytes"
import { ClosureMove, ClosureState, LockState } from "./proto_consts"

/** 车门键名与 VehicleStatus.closureStatuses 一致：Driver = 左侧（主驾），Passenger = 右侧 */
export type WidgetDoor = "frontDriverDoor" | "frontPassengerDoor" | "rearDriverDoor" | "rearPassengerDoor"

export type DoorCommand = "door_fl" | "door_fr" | "door_rl" | "door_rr"

export type WidgetCommand =
  | "unlock"
  | "lock"
  | DoorCommand
  | "frunk_open"
  | "trunk_open"
  | "trunk_close"
  | "charge_open"
  | "charge_close"

export const WIDGET_DOORS: Record<DoorCommand, WidgetDoor> = {
  door_fl: "frontDriverDoor",
  door_fr: "frontPassengerDoor",
  door_rl: "rearDriverDoor",
  door_rr: "rearPassengerDoor",
}

export const COMMAND_ZH: Record<WidgetCommand, string> = {
  unlock: "解锁",
  lock: "上锁",
  door_fl: "弹开左前门",
  door_fr: "弹开右前门",
  door_rl: "弹开左后门",
  door_rr: "弹开右后门",
  frunk_open: "打开前备箱",
  trunk_open: "打开后备箱",
  trunk_close: "关闭后备箱",
  charge_open: "打开充电口",
  charge_close: "关闭充电口",
}

/** 主界面运行时登记的 ScriptSession id（小组件指令交给主界面执行时用） */
export const ST_MAIN_SESSION: string = "tesla_key.main_session"

export function isWidgetCommand(v: unknown): v is WidgetCommand {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(COMMAND_ZH, v)
}

export function isDoorCommand(c: WidgetCommand): c is DoorCommand {
  return c in WIDGET_DOORS
}

// ---- 车身状态 ----

/** 车身状态里小组件和指令用到的部分（client/vcsec 的 VehicleStatus 是它的超集） */
export interface BodyStatus {
  vehicleLockState?: number
  vehicleSleepStatus?: number
  userPresence?: number
  closureStatuses?: Record<string, number | undefined>
}

/** 开着：OPEN、AJAR（半开，门弹开后常报这个）、OPENING */
export function closureOpen(v: number | undefined): boolean {
  return v === ClosureState.OPEN || v === ClosureState.AJAR || v === ClosureState.OPENING
}

/** 锁着：LOCKED，或在车内锁上的 INTERNAL_LOCKED */
export function isLockedState(v: number | undefined): boolean {
  return v === LockState.LOCKED || v === LockState.INTERNAL_LOCKED
}

/**
 * 指令完成后车辆应该到达的状态（用来在指令后轮询车身状态，直到车真的动完再写快照）。
 * 门、前备箱、后备箱打开后可能报 OPEN 或 AJAR，都算到位；关闭要等到 CLOSED。OPENING / CLOSING 表示还在动
 */
export function targetReached(c: WidgetCommand, status: BodyStatus): boolean {
  const cs: Record<string, number | undefined> = status.closureStatuses ?? {}
  const opened = (k: string): boolean => cs[k] === ClosureState.OPEN || cs[k] === ClosureState.AJAR
  const closed = (k: string): boolean => (cs[k] ?? ClosureState.CLOSED) === ClosureState.CLOSED
  if (c === "unlock") return !isLockedState(status.vehicleLockState)
  if (c === "lock") return isLockedState(status.vehicleLockState)
  if (isDoorCommand(c)) return opened(WIDGET_DOORS[c])
  switch (c) {
    case "frunk_open": return opened("frontTrunk")
    case "trunk_open": return opened("rearTrunk")
    case "trunk_close": return closed("rearTrunk")
    case "charge_open": return opened("chargePort")
    case "charge_close": return closed("chargePort")
    default: return true
  }
}

/**
 * 指令所需的开合动作；返回 null 表示已经是目标状态、不用发（重复执行也安全）：
 * 车门已开着不再弹开；前备箱、后备箱的 MOVE 是开 / 关切换，只在关着时发，这样主脚本超时后再走一次直连也不会开了又关
 */
export function closureRequest(c: WidgetCommand, closures: Record<string, number | undefined> | undefined): Record<string, number> | null {
  const cs: Record<string, number | undefined> = closures ?? {}
  if (isDoorCommand(c)) return closureOpen(cs[WIDGET_DOORS[c]]) ? null : { [WIDGET_DOORS[c]]: ClosureMove.OPEN }
  switch (c) {
    case "frunk_open":
      return closureOpen(cs.frontTrunk) ? null : { frontTrunk: ClosureMove.MOVE }
    case "trunk_open":
      return closureOpen(cs.rearTrunk) ? null : { rearTrunk: ClosureMove.MOVE }
    case "trunk_close":
      return { rearTrunk: ClosureMove.CLOSE }
    case "charge_open":
      return { chargePort: ClosureMove.OPEN }
    case "charge_close":
      return { chargePort: ClosureMove.CLOSE }
    default:
      return null
  }
}

/** 指令后轮询车身状态的时限和间隔（读车身状态不唤醒车机） */
export const SETTLE_TIMEOUT_MS: number = 12000
export const SETTLE_INTERVAL_MS: number = 1500

/**
 * 指令回复时门 / 尾门往往还没动完（尾门开合要好几秒，只读一次会存下旧状态）：
 * 每 1.5 秒读一次车身状态，到达目标状态或超时为止。中途读取出错就停下，返回最后一次读到的（一次都没读到返回 null）
 */
export async function waitForTarget<S extends BodyStatus>(cmd: WidgetCommand, read: () => Promise<S>): Promise<{ status: S | null; reached: boolean; ms: number }> {
  const t0: number = Date.now()
  let last: S | null = null
  try {
    last = await read()
    while (!targetReached(cmd, last) && Date.now() - t0 < SETTLE_TIMEOUT_MS) {
      await sleep(SETTLE_INTERVAL_MS)
      last = await read()
    }
  } catch (_e) {
    // 用最后一次读到的
  }
  return { status: last, reached: last != null && targetReached(cmd, last), ms: Date.now() - t0 }
}

// ---- 快照：小组件只读这份（不连车），直连和主界面连车后写入 ----

export const ST_SNAPSHOT: string = "tesla_key.snapshot.v1"

export interface Snapshot<S extends BodyStatus = BodyStatus> {
  status: S
  at: number
  /** 整车上锁时弹开了单门：车辆此时报 UNLOCKED，但其余门仍锁着 */
  selective?: boolean
}

export function loadSnapshot<S extends BodyStatus = BodyStatus>(): Snapshot<S> | null {
  try {
    return Storage.get<Snapshot<S>>(ST_SNAPSHOT)
  } catch (_e) {
    return null
  }
}

export function saveSnapshot(s: Snapshot): void {
  try {
    Storage.set(ST_SNAPSHOT, s)
  } catch (_e) {
    // 快照只是缓存
  }
}

/**
 * 单门弹开标记：整车上锁时弹开单门 → 置上；解锁 / 上锁、或车辆重新报上锁 → 清掉；其余情况保持。
 * 不能按「有没有门开着」判断：指令回复后马上读到的状态里，门还没真正弹开（2026-10-17 实测因此被提前清掉）
 */
export function nextSelective(prev: boolean, cmd: WidgetCommand | null, wasLocked: boolean, nowLockState: number | undefined): boolean {
  if (cmd === "unlock" || cmd === "lock" || isLockedState(nowLockState)) return false
  if (cmd && isDoorCommand(cmd) && wasLocked) return true
  return prev
}

/** 小组件显示用：锁着，或单门弹开（其余门仍锁着） */
export function snapshotLocked(s: Snapshot | null): boolean {
  return s != null && (isLockedState(s.status.vehicleLockState) || s.selective === true)
}
