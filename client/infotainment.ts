// Infotainment（CarServer）域：GetVehicleData 分类读取与车机指令
// 对应 Go pkg/vehicle/infotainment.go getCarServerResponse 与 vehicle.go Send 的重试规则。需要车机醒着
import { sleep, toBytes } from "../core/bytes"
import { Errors, TeslaError } from "../core/errors"
import { log } from "../core/log"
import { debugJSON, decode, Domain, encode, Types } from "../core/proto"
import { Dispatcher, getError, Msg, Pending, RETRY_INTERVAL_MS, shouldRetry } from "./dispatcher"

/** 车机刚唤醒时会回 BUSY / INTERNAL，给足时间按 1 秒间隔重试 */
export const CS_TIMEOUT_MS: number = 15000
const OPERATION_STATUS_ERROR: number = 1

/** GetVehicleData 分类：请求字段 → VehicleData 里的回包字段（SDK 一次只请求一个分类） */
export const CATEGORIES = {
  charge: ["getChargeState", "charge_state"],
  climate: ["getClimateState", "climate_state"],
  drive: ["getDriveState", "drive_state"],
  closures: ["getClosuresState", "closures_state"],
  media: ["getMediaState", "media_state"],
  update: ["getSoftwareUpdateState", "software_update_state"],
  // 放最后：2026-10-17 实测本车对这个分类不回复（车内有人没人都一样），只给短超时
  tire: ["getTirePressureState", "tire_pressure_state"],
} as const
export const TIRE_TIMEOUT_MS: number = 5000
export type Category = keyof typeof CATEGORIES
export const CATEGORY_ZH: Record<Category, string> = {
  charge: "充电", climate: "空调", drive: "行驶", closures: "车门车窗", media: "媒体", update: "软件更新", tire: "胎压",
}

/** actionStatus.result_reason.plain_text 的常见取值（来自 Fleet 文档与 SDK） */
const REASON_ZH: Record<string, string> = {
  "already off": "已经是关闭状态",
  "already on": "已经是开启状态",
  already_set: "已经是这个值",
  already_started: "已经在充电",
  "cable connected": "插着充电枪，不能关闭充电口",
  car_wash: "洗车模式中",
  "not allowed": "当前状态不允许",
  not_charging: "当前没有在充电",
  is_charging: "已经在充电",
  complete: "已经充满",
  disconnected: "没有插充电枪",
  no_power: "充电桩没有供电",
  requested: "已经请求过",
  low_power_mode_enforced: "电量过低，车辆强制处于低功耗模式",
  parental_controls_active: "家长控制已激活",
  not_supported: "这台车不支持",
  // 2026-10-17 实测：人在车外时媒体播放 / 暂停返回这个
  user_not_present: "车内没有人，车辆不允许执行",
  // 2026-10-17 实测：代客模式开着时重置代客 PIN 等操作返回这个
  "valet mode on": "代客模式开着，请先关闭代客模式",
  // 2026-10-17 实测：限速启用期间修改限速相关设置返回这个
  speed_limit_mode_active: "限速正在启用，请先停用限速",
}

export function carError(text: string): TeslaError {
  const t: string = text || "unspecified error"
  const zh: string | undefined = REASON_ZH[t]
  return new TeslaError("CAR_ERROR", zh ? `${zh}（${t}）` : `车辆拒绝执行：${t}`, false)
}

export class InfotainmentClient {
  private readonly d: Dispatcher
  private chain: Promise<unknown> = Promise.resolve()
  /** 最近一次收到车机回复的时间（错误回复也算：说明车机在线） */
  lastReplyAt: number = 0

  constructor(d: Dispatcher) {
    this.d = d
  }

  /** 串行执行：同一时间只有一个车机请求在途，便于日志对照和按序重试 */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run: Promise<T> = this.chain.then(job, job)
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * 发送 VehicleAction，返回 CarServer.Response（actionStatus 为错误时抛出）。
   * readOnly：没有副作用的请求（读状态、Ping），回复丢包时可以安全重发
   */
  send(vehicleAction: Msg, what: string, timeoutMs: number = CS_TIMEOUT_MS, readOnly: boolean = false): Promise<Msg> {
    return this.serial(async () => {
      const payload: Uint8Array = encode(Types.CarServerAction, { vehicleAction: dropDefaults(vehicleAction) })
      // 握手有自己的超时，不占用指令本身的等待时间
      await this.d.startSession(Domain.INFOTAINMENT, CS_TIMEOUT_MS)
      const deadline: number = Date.now() + timeoutMs
      while (true) {
        let err: unknown
        try {
          await this.d.startSession(Domain.INFOTAINMENT, Math.max(1, deadline - Date.now()))
          const p: Pending = await this.d.send(Domain.INFOTAINMENT, { protobuf_message_as_bytes: payload }, true, readOnly)
          try {
            const reply: Msg = await p.next(Math.max(1, deadline - Date.now()), what)
            this.lastReplyAt = Date.now()
            const e: TeslaError | null = getError(reply)
            if (e) throw e
            return parseResponse(reply)
          } finally {
            p.close()
          }
        } catch (e) {
          err = e
        }
        // FRAME_LOST 只会发给只读请求（见 Dispatcher），按临时错误重试
        if (!shouldRetry(err) || Date.now() + RETRY_INTERVAL_MS >= deadline) throw err
        log.info(`车机重试（${what}）: ` + String((err as Error)?.message ?? err))
        await sleep(RETRY_INTERVAL_MS)
      }
    })
  }

  /** 读一个 GetVehicleData 分类 */
  async state(cat: Category, timeoutMs: number = CS_TIMEOUT_MS): Promise<Msg> {
    const [req, field] = CATEGORIES[cat]
    const r: Msg = await this.send({ getVehicleData: { [req]: {} } }, `读取${CATEGORY_ZH[cat]}`, timeoutMs, true)
    const data: Msg | undefined = r.vehicleData?.[field]
    if (!data) throw Errors.badResponse(`回包里没有 ${field}`)
    return data
  }

  /** 无副作用的认证探测：钥匙被车机认可、车机在线 */
  async ping(timeoutMs: number = CS_TIMEOUT_MS): Promise<void> {
    await this.send({ ping: { ping_id: 1 } }, "Ping", timeoutMs, true)
  }
}

// ---- VehicleAction 构造（字段与 SDK climate.go / charge.go / actions.go / infotainment.go 一致） ----

export type HeaterLevel = "OFF" | "LOW" | "MED" | "HIGH"
export type Seat = "FRONT_LEFT" | "FRONT_RIGHT" | "REAR_LEFT" | "REAR_CENTER" | "REAR_RIGHT"
/** ClimateKeeperAction_E：Off=0, On(保持)=1, Dog=2, Camp=3 */
export const KeeperMode = { OFF: 0, KEEP: 1, DOG: 2, CAMP: 3 } as const

export const Act = {
  climate: (on: boolean): Msg => ({ hvacAutoAction: { power_on: on, manual_override: false } }),
  /** SDK ChangeClimateTemp 原样带上 level = TEMP_MAX（用意没有文档），这里照抄 */
  temps: (driver: number, passenger: number): Msg => ({
    hvacTemperatureAdjustmentAction: { driver_temp_celsius: driver, passenger_temp_celsius: passenger, level: { TEMP_MAX: {} } },
  }),
  seatHeaters: (levels: [Seat, HeaterLevel][]): Msg => ({
    hvacSeatHeaterActions: { hvacSeatHeaterAction: levels.map(([seat, lv]) => ({ [`SEAT_HEATER_${lv}`]: {}, [`CAR_SEAT_${seat}`]: {} })) },
  }),
  steeringHeater: (on: boolean): Msg => ({ hvacSteeringWheelHeaterAction: { power_on: on } }),
  defrostMax: (on: boolean): Msg => ({ hvacSetPreconditioningMaxAction: { on, manual_override: false } }),
  keeper: (mode: number): Msg => ({ hvacClimateKeeperAction: { ClimateKeeperAction: mode, manual_override: false } }),
  overheat: (on: boolean, fanOnly: boolean): Msg => ({ setCabinOverheatProtectionAction: { on, fan_only: fanOnly } }),
  chargeStart: (): Msg => ({ chargingStartStopAction: { start: {} } }),
  chargeStop: (): Msg => ({ chargingStartStopAction: { stop: {} } }),
  chargeLimit: (percent: number): Msg => ({ chargingSetLimitAction: { percent } }),
  chargeAmps: (amps: number): Msg => ({ setChargingAmpsAction: { charging_amps: amps } }),
  windows: (cmd: "vent" | "close"): Msg => ({ vehicleControlWindowAction: { [cmd]: {} } }),
  honk: (): Msg => ({ vehicleControlHonkHornAction: {} }),
  flash: (): Msg => ({ vehicleControlFlashLightsAction: {} }),
  sentry: (on: boolean): Msg => ({ vehicleControlSetSentryModeAction: { on } }),
  mediaToggle: (): Msg => ({ mediaPlayAction: {} }),
  mediaNext: (): Msg => ({ mediaNextTrack: {} }),
  mediaPrev: (): Msg => ({ mediaPreviousTrack: {} }),
  /** 只有符号有意义（SDK 注释） */
  volume: (delta: 1 | -1): Msg => ({ mediaUpdateVolume: { volume_delta: delta } }),

  // ---- 第四档：需要二次确认（security.go / charge.go / infotainment.go） ----
  /** 开启要 4 位数字 PIN；关闭时 password 留空 */
  valet: (on: boolean, pin: string): Msg => ({ vehicleControlSetValetModeAction: { on, password: on ? pin : "" } }),
  /** 须先关闭代客模式 */
  resetValetPin: (): Msg => ({ vehicleControlResetValetPinAction: {} }),
  /** 单位 mph */
  speedLimitSet: (mph: number): Msg => ({ drivingSetSpeedLimitAction: { limit_mph: mph } }),
  speedLimitActivate: (on: boolean, pin: string): Msg => ({ drivingSpeedLimitAction: { activate: on, pin } }),
  speedLimitClearPin: (pin: string): Msg => ({ drivingClearSpeedLimitPinAction: { pin } }),
  /** 忘记 PIN 时的恢复手段（车主钥匙，固件 2023.38+） */
  speedLimitClearPinAdmin: (): Msg => ({ drivingClearSpeedLimitPinAdminAction: {} }),
  lowPower: (on: boolean): Msg => ({ setLowPowerModeAction: { low_power_mode: on } }),
  keepAccessoryPower: (on: boolean): Msg => ({ setKeepAccessoryPowerModeAction: { keep_accessory_power_mode: on } }),
  /** 距现在多少秒后安装；车辆须已下载好更新 */
  updateSchedule: (offsetSec: number): Msg => ({ vehicleControlScheduleSoftwareUpdateAction: { offset_sec: offsetSec } }),
  updateCancel: (): Msg => ({ vehicleControlCancelSoftwareUpdateAction: {} }),
}

/** SDK IsValidPIN：4 位且全为数字 */
export function isValidPin(pin: string): boolean {
  return /^[0-9]{4}$/.test(pin)
}

/**
 * protobufjs 会把显式给出的 false / 0 / "" 也编码进去，Go 的 proto3 编码不会。
 * 去掉这些标量，让字节和官方一致（官方向量：hvacAutoAction{power_on:true} → 120452020801）。
 * 空对象 {} 要保留：Void 成员的存在本身就是选择。
 */
export function dropDefaults(o: Msg): Msg {
  const out: Msg = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === false || v === 0 || v === "") continue
    out[k] = Array.isArray(v) ? v.map((x: any) => (x && typeof x === "object" ? dropDefaults(x) : x))
      : v && typeof v === "object" && !(v instanceof Uint8Array) ? dropDefaults(v) : v
  }
  return out
}

function parseResponse(m: Msg): Msg {
  const body: Uint8Array = toBytes(m.protobuf_message_as_bytes)
  let r: Msg
  try {
    r = body.length ? decode<Msg>(Types.CarServerResponse, body) : {}
  } catch (_e) {
    // 回包无法解析时指令可能已执行（Go：PossibleSuccess: true）
    throw Errors.badResponse("CarServer.Response 无法解析")
  }
  log.rx("CarServer " + debugJSON(Types.CarServerResponse, body).slice(0, 600))
  if ((r.actionStatus?.result ?? 0) === OPERATION_STATUS_ERROR) throw carError(r.actionStatus?.result_reason?.plain_text ?? "")
  return r
}
