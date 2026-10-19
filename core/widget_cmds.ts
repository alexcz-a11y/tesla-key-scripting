// 小组件能发的指令：小组件、AppIntent、主脚本（ScriptSession）、直连（client/quick）共用的名字。
// 不依赖任何模块（小组件进程会静态加载本文件）

/** 车门键名与 VehicleStatus.closureStatuses 一致：Driver = 左侧（主驾），Passenger = 右侧 */
export type WidgetDoor = "frontDriverDoor" | "frontPassengerDoor" | "rearDriverDoor" | "rearPassengerDoor"

export type WidgetCommand =
  | "unlock"
  | "lock"
  | "door_fl"
  | "door_fr"
  | "door_rl"
  | "door_rr"
  | "frunk_open"
  | "trunk_open"
  | "trunk_close"
  | "charge_open"
  | "charge_close"

export const WIDGET_DOORS: Record<"door_fl" | "door_fr" | "door_rl" | "door_rr", WidgetDoor> = {
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

export function isWidgetCommand(v: unknown): v is WidgetCommand {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(COMMAND_ZH, v)
}

export function isDoorCommand(c: WidgetCommand): c is "door_fl" | "door_fr" | "door_rl" | "door_rr" {
  return c in WIDGET_DOORS
}

/** ClosureState：OPEN 1、AJAR 2、OPENING 5 都算开着 */
export function closureOpen(v: number | undefined): boolean {
  return v === 1 || v === 2 || v === 5
}

/**
 * 指令完成后车辆应该到达的状态（用来在指令后轮询车身状态，直到车真的动完再写快照）。
 * 门 / 前备箱弹开后可能报 AJAR（2），也算到位；后备箱、充电口要等到 OPEN（1）或 CLOSED（0），OPENING / CLOSING 表示还在动
 */
export function targetReached(c: WidgetCommand, status: { vehicleLockState?: number; closureStatuses?: Record<string, number | undefined> }): boolean {
  const cs: Record<string, number | undefined> = status.closureStatuses ?? {}
  const v = (k: string): number => cs[k] ?? 0
  if (c === "unlock") return (status.vehicleLockState ?? 0) !== 1
  if (c === "lock") return (status.vehicleLockState ?? 0) === 1
  if (isDoorCommand(c)) return v(WIDGET_DOORS[c]) === 1 || v(WIDGET_DOORS[c]) === 2
  switch (c) {
    case "frunk_open": return v("frontTrunk") === 1 || v("frontTrunk") === 2
    case "trunk_open": return v("rearTrunk") === 1
    case "trunk_close": return v("rearTrunk") === 0
    case "charge_open": return v("chargePort") === 1
    case "charge_close": return v("chargePort") === 0
    default: return true
  }
}

/** 指令后轮询车身状态的时限和间隔（读车身状态不唤醒车机；时限要留在 AppIntent 的执行时间里） */
export const SETTLE_TIMEOUT_MS: number = 12000
export const SETTLE_INTERVAL_MS: number = 1500

/**
 * 指令所需的开合动作；返回 null 表示已经是目标状态、不用发。
 * 前备箱、后备箱的 MOVE 是开 / 关切换：只在关着时发，这样主脚本超时后再走一次直连也不会开了又关。
 * ClosureMove：MOVE 1、OPEN 3、CLOSE 4
 */
export function closureRequest(c: WidgetCommand, closures: Record<string, number | undefined> | undefined): Record<string, number> | null {
  const cs: Record<string, number | undefined> = closures ?? {}
  if (isDoorCommand(c)) return { [WIDGET_DOORS[c]]: 3 }
  switch (c) {
    case "frunk_open":
      return closureOpen(cs.frontTrunk) ? null : { frontTrunk: 1 }
    case "trunk_open":
      return closureOpen(cs.rearTrunk) ? null : { rearTrunk: 1 }
    case "trunk_close":
      return { rearTrunk: 4 }
    case "charge_open":
      return { chargePort: 3 }
    case "charge_close":
      return { chargePort: 4 }
    default:
      return null
  }
}
