// 车辆客户端：组合 BLE 传输、调度层与各域客户端，供 UI / 运行时使用
import { hex, sleep, unhex } from "../core/bytes"
import { Errors, TeslaError } from "../core/errors"
import { getPublicKey, loadConfig, loadPrivateKey, loadSessions, saveConfig, sessionKeysFor, VehicleConfig } from "../core/keystore"
import { log } from "../core/log"
import { toBytes } from "../core/bytes"
import { decode, Types } from "../core/pb_lite"
import { ClosureMove, ClosureState, Domain, KeyFormFactor, KeyRole, LockState, RKEAction, SleepStatus, UserPresence } from "../core/proto"
import { SessionInfoObj, SessionKeys } from "../core/session"
import { BleTransport } from "../core/transport_ble"
import { Dispatcher, Msg } from "./dispatcher"
import { Category, CS_TIMEOUT_MS, InfotainmentClient, TIRE_TIMEOUT_MS } from "./infotainment"
import { VcsecClient, VehicleStatus, WhitelistEntryInfo } from "./vcsec"

/** 唤醒到 VCSEC 报 AWAKE 的最长等待 */
const WAKE_TIMEOUT_MS: number = 25000
/** 车机多久内回过消息就不再探测 */
const CS_ALIVE_MS: number = 20000
const PING_TIMEOUT_MS: number = 4000
/** 等车机开始回应的最长时间（实测车机启动可能接近 1 分钟） */
const CS_WAKE_TIMEOUT_MS: number = 75000

export type DoorKey = "frontDriverDoor" | "frontPassengerDoor" | "rearDriverDoor" | "rearPassengerDoor"
type ClosureKey = DoorKey | "rearTrunk" | "frontTrunk" | "chargePort"

const isOpenish = (v: number): boolean => v === ClosureState.OPEN || v === ClosureState.AJAR || v === ClosureState.OPENING

export const DOORS: { key: DoorKey; zh: string }[] = [
  { key: "frontDriverDoor", zh: "左前门（主驾）" },
  { key: "frontPassengerDoor", zh: "右前门（副驾）" },
  { key: "rearDriverDoor", zh: "左后门" },
  { key: "rearPassengerDoor", zh: "右后门" },
]

export class VehicleClient {
  readonly transport: BleTransport = new BleTransport()
  private dispatcher: Dispatcher | null = null
  private vcsecClient: VcsecClient | null = null
  private csClient: InfotainmentClient | null = null
  config: VehicleConfig = loadConfig()

  get connected(): boolean {
    return this.transport.isConnected
  }

  get vcsec(): VcsecClient {
    if (!this.vcsecClient) throw new Error("还没有连接车辆")
    return this.vcsecClient
  }

  get cs(): InfotainmentClient {
    if (!this.csClient) throw new Error("还没有连接车辆")
    return this.csClient
  }

  get d(): Dispatcher {
    if (!this.dispatcher) throw new Error("还没有连接车辆")
    return this.dispatcher
  }

  /** 扫描并连接车辆；私钥在连接时读取（配对后需要重新连接或调用 reloadKey） */
  async connect(): Promise<void> {
    this.config = loadConfig()
    if (!this.config.vin || !this.config.localName) throw Errors.noVin()
    const id: string = await this.transport.connect(this.config.localName, this.config.peripheralId)
    if (id !== this.config.peripheralId) {
      this.config.peripheralId = id
      saveConfig(this.config)
    }
    this.reloadKey()
  }

  /** 车辆主动推送到广播域的 VCSEC 状态（开关门、上锁、车内有人等变化时） */
  onStatusPush: ((s: VehicleStatus) => void) | null = null
  lastStatus: VehicleStatus | null = null
  private lastStatusAt: number = 0
  private readonly pushWatchers: Set<(s: VehicleStatus) => void> = new Set()

  /** 等推送来的状态满足条件 */
  private watchStatus(ok: (st: VehicleStatus) => boolean): { promise: Promise<void>; stop: () => void } {
    let stop: () => void = () => undefined
    const promise: Promise<void> = new Promise<void>((resolve: () => void) => {
      const fn = (st: VehicleStatus): void => {
        if (ok(st)) {
          this.pushWatchers.delete(fn)
          resolve()
        }
      }
      this.pushWatchers.add(fn)
      stop = () => this.pushWatchers.delete(fn)
    })
    return { promise, stop }
  }

  /** 等某个开合件的状态满足条件（来自推送），用于提前确认开合动作完成 */
  private watchClosure(key: ClosureKey, ok: (state: number) => boolean): { promise: Promise<void>; stop: () => void } {
    return this.watchStatus((st: VehicleStatus) => ok((st.closureStatuses as Record<string, number | undefined> | undefined)?.[key] ?? ClosureState.CLOSED))
  }

  private async closureWithWatch(request: Record<string, number>, key: ClosureKey, ok: (state: number) => boolean): Promise<void> {
    const w = this.watchClosure(key, ok)
    try {
      await this.vcsec.closure(request, w.promise)
    } finally {
      w.stop()
    }
  }

  reloadKey(): void {
    this.dispatcher?.dispose()
    const priv: Uint8Array | null = loadPrivateKey()
    const keys: SessionKeys | null = priv ? sessionKeysFor(priv) : null
    this.dispatcher = new Dispatcher(this.transport, this.config.vin, keys)
    // 已有 VCSEC 会话缓存时先算一次 K 写进钥匙串（不联网），小组件不用等主界面再发一次指令
    const cached = loadSessions()[String(Domain.VCSEC)]
    if (keys && cached) keys.deriveK(unhex(cached.vehiclePublicKey)).catch((e: any) => log.warn("预先计算会话密钥失败: " + String(e?.message ?? e)))
    this.vcsecClient = new VcsecClient(this.dispatcher)
    this.csClient = new InfotainmentClient(this.dispatcher)
    this.dispatcher.onUnmatched((_raw: Uint8Array, m: Msg | null) => {
      if (!m || m.to_destination?.domain !== Domain.BROADCAST || m.from_destination?.domain !== Domain.VCSEC) return
      const body: Uint8Array = toBytes(m.protobuf_message_as_bytes)
      if (!body.length) return
      try {
        const from: Msg = decode<Msg>(Types.FromVCSECMessage, body)
        if (from.vehicleStatus) {
          const st: VehicleStatus = from.vehicleStatus as VehicleStatus
          this.lastStatus = st
          this.lastStatusAt = Date.now()
          for (const w of [...this.pushWatchers]) w(st)
          this.onStatusPush?.(st)
        }
      } catch (e: any) {
        log.warn("广播状态无法解析: " + String(e?.message ?? e))
      }
    })
  }

  /** 读一次状态并缓存 */
  async status(): Promise<VehicleStatus> {
    this.lastStatus = await this.vcsec.status()
    this.lastStatusAt = Date.now()
    return this.lastStatus
  }

  // ---- 核心指令（VCSEC，需要已配对） ----

  unlock(): Promise<void> {
    return this.vcsec.rke(RKEAction.UNLOCK)
  }

  lock(): Promise<void> {
    return this.vcsec.rke(RKEAction.LOCK)
  }

  /** 唤醒车机（Infotainment），之后空调、充电等指令才能执行 */
  wake(): Promise<void> {
    return this.vcsec.rke(RKEAction.WAKE_VEHICLE)
  }

  /** 后备箱：电动尾门开/关切换 */
  openTrunk(): Promise<void> {
    // MOVE 是开/关切换：以状态相对指令前发生变化为完成
    const before: number = this.lastStatus?.closureStatuses?.rearTrunk ?? ClosureState.CLOSED
    const wasOpen: boolean = isOpenish(before)
    return this.closureWithWatch({ rearTrunk: ClosureMove.MOVE }, "rearTrunk", (v: number) => (wasOpen ? v === ClosureState.CLOSED || v === ClosureState.CLOSING : isOpenish(v)))
  }

  /** 关后备箱（仅部分车型支持） */
  closeTrunk(): Promise<void> {
    return this.vcsec.closure({ rearTrunk: ClosureMove.CLOSE })
  }

  /**
   * 单门弹开：VCSEC ClosureMoveRequest 的车门字段（官方 tesla-control 未暴露）。
   * 2026-10-17 在 2024 Model Y 长续航上实测：OPEN 四门都有效，MOVE 车辆回复成功但没有动作。
   */
  door(door: DoorKey, move: number = ClosureMove.OPEN): Promise<void> {
    return this.closureWithWatch({ [door]: move }, door, isOpenish)
  }

  openFrunk(): Promise<void> {
    return this.closureWithWatch({ frontTrunk: ClosureMove.MOVE }, "frontTrunk", isOpenish)
  }

  /**
   * 打开充电口盖：VCSEC ClosureMoveRequest.chargePort = OPEN。
   * 官方 SDK 走车机的 ChargePortDoorOpen（要唤醒车机，M7）；VCSEC 这条通路尚未实测。
   */
  openChargePort(): Promise<void> {
    return this.closureWithWatch({ chargePort: ClosureMove.OPEN }, "chargePort", isOpenish)
  }

  /** 关闭充电口盖：chargePort = CLOSE（插着充电枪时车辆不会关） */
  closeChargePort(): Promise<void> {
    return this.closureWithWatch({ chargePort: ClosureMove.CLOSE }, "chargePort", (v: number) => v === ClosureState.CLOSED || v === ClosureState.CLOSING)
  }

  // ---- 车机（Infotainment）：要先确认车机醒着 ----

  /**
   * 车机睡着就先用 VCSEC 唤醒，等状态变成 AWAKE（推送或每 3 秒读一次）。
   * 醒来后车机还可能回 BUSY / INTERNAL，由 InfotainmentClient 重试。
   */
  async ensureAwake(timeoutMs: number = WAKE_TIMEOUT_MS): Promise<void> {
    const awake = (st: VehicleStatus): boolean => st.vehicleSleepStatus === SleepStatus.AWAKE
    // 车机睡下去时不一定有推送，状态超过 10 秒就重新读一次
    if (this.lastStatus && Date.now() - this.lastStatusAt < 10000 && awake(this.lastStatus)) return
    if (awake(await this.status())) return
    log.info("车机在睡眠，先唤醒")
    const w = this.watchStatus(awake)
    try {
      await this.wake()
      const deadline: number = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const done: boolean = await Promise.race([w.promise.then(() => true), sleep(3000).then(() => false)])
        if (done || awake(await this.status())) {
          log.info("车机已唤醒")
          return
        }
      }
    } finally {
      w.stop()
    }
    throw new TeslaError("WAKE_TIMEOUT", "车机唤醒超时，请稍后再试", true)
  }

  /**
   * 确认车机能回应。实测 VCSEC 报 AWAKE 时车机也可能不回（进车后约 1 分钟才回）：
   * 先用 Ping 短超时探测，不回就发 WAKE_VEHICLE，再每 4 秒探测一次，直到回应或超时。
   */
  async ensureInfotainment(wake: boolean = true, timeoutMs: number = CS_WAKE_TIMEOUT_MS): Promise<void> {
    if (Date.now() - this.cs.lastReplyAt < CS_ALIVE_MS) return
    if (!wake) {
      // 不唤醒：车机没回应就直接放弃
      await this.cs.ping(PING_TIMEOUT_MS)
      return
    }
    await this.ensureAwake()
    const deadline: number = Date.now() + timeoutMs
    let woke: boolean = false
    while (true) {
      try {
        await this.cs.ping(PING_TIMEOUT_MS)
        return
      } catch (e: any) {
        // 只有「没有回复」才说明车机没醒；其他错误（钥匙未配对等）直接报给用户
        if (!(e instanceof TeslaError) || e.code !== "TIMEOUT") throw e
      }
      if (Date.now() >= deadline) throw new TeslaError("CS_TIMEOUT", "车机一直没有回应，可能还在启动，请稍后再试", true)
      if (!woke) {
        log.info("车机没有回应，发送唤醒")
        await this.wake()
        woke = true
      }
    }
  }

  /** 发车机指令（自动唤醒） */
  async car(action: Msg, what: string): Promise<Msg> {
    await this.ensureInfotainment()
    return this.cs.send(action, what)
  }

  /** 读车机状态分类；wake=false 时车机没回应就失败，不发唤醒 */
  async carState(cat: Category, wake: boolean = true): Promise<Msg> {
    await this.ensureInfotainment(wake)
    return this.cs.state(cat, cat === "tire" ? TIRE_TIMEOUT_MS : CS_TIMEOUT_MS)
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect()
  }

  /** 本机公钥在指定域的白名单状态（不需要会话） */
  async keyStatus(domain: 2 | 3 = Domain.VCSEC): Promise<SessionInfoObj> {
    const pub: Uint8Array | null = getPublicKey()
    if (!pub) throw new Error("还没有生成钥匙")
    return this.d.querySessionInfo(domain, pub)
  }

  /** 读完整钥匙列表 */
  async listKeys(): Promise<WhitelistEntryInfo[]> {
    const info = await this.vcsec.whitelistInfo()
    const out: WhitelistEntryInfo[] = []
    const mask: number = info.slotMask ?? 0
    for (let slot = 0; slot < 32; slot++) {
      if (((mask >>> slot) & 1) === 0) continue
      try {
        out.push(await this.vcsec.whitelistEntry(slot))
      } catch (e: any) {
        log.warn(`读取钥匙槽 ${slot} 失败: ${String(e?.message ?? e)}`)
      }
    }
    return out
  }
}

// ---- 中文显示 ----

const CLOSURE_ZH: Record<number, string> = {
  [ClosureState.CLOSED]: "关", [ClosureState.OPEN]: "开", [ClosureState.AJAR]: "半开",
  [ClosureState.UNKNOWN]: "未知", [ClosureState.FAILED_UNLATCH]: "弹开失败",
  [ClosureState.OPENING]: "正在开", [ClosureState.CLOSING]: "正在关",
}
const LOCK_ZH: Record<number, string> = {
  [LockState.UNLOCKED]: "已解锁", [LockState.LOCKED]: "已上锁",
  [LockState.INTERNAL_LOCKED]: "车内锁定", [LockState.SELECTIVE_UNLOCKED]: "部分解锁",
}
const SLEEP_ZH: Record<number, string> = { [SleepStatus.UNKNOWN]: "未知", [SleepStatus.AWAKE]: "醒着", [SleepStatus.ASLEEP]: "睡眠" }
const PRESENCE_ZH: Record<number, string> = { [UserPresence.UNKNOWN]: "未知", [UserPresence.NOT_PRESENT]: "无人", [UserPresence.PRESENT]: "有人" }
const ROLE_ZH: Record<number, string> = {
  [KeyRole.NONE]: "无", [KeyRole.SERVICE]: "服务", [KeyRole.OWNER]: "车主", [KeyRole.DRIVER]: "驾驶员",
  [KeyRole.FM]: "车队", [KeyRole.VEHICLE_MONITOR]: "监控", [KeyRole.CHARGING_MANAGER]: "充电管理", [KeyRole.GUEST]: "访客",
}
const FORM_ZH: Record<number, string> = {
  [KeyFormFactor.UNKNOWN]: "未知", [KeyFormFactor.NFC_CARD]: "钥匙卡", [KeyFormFactor.IOS_DEVICE]: "iPhone",
  [KeyFormFactor.ANDROID_DEVICE]: "Android", [KeyFormFactor.CLOUD_KEY]: "云端",
}

// proto3 默认值不出现在解码结果里，缺省即 0
const z = (m: Record<number, string>, v: number | undefined): string => m[v ?? 0] ?? String(v)

export function describeStatus(s: VehicleStatus): string[] {
  const c = s.closureStatuses ?? {}
  return [
    `门锁：${z(LOCK_ZH, s.vehicleLockState)}　车辆：${z(SLEEP_ZH, s.vehicleSleepStatus)}　车内：${z(PRESENCE_ZH, s.userPresence)}`,
    `车门 左前${z(CLOSURE_ZH, c.frontDriverDoor)} 右前${z(CLOSURE_ZH, c.frontPassengerDoor)} 左后${z(CLOSURE_ZH, c.rearDriverDoor)} 右后${z(CLOSURE_ZH, c.rearPassengerDoor)}`,
    `前备箱${z(CLOSURE_ZH, c.frontTrunk)} 后备箱${z(CLOSURE_ZH, c.rearTrunk)} 充电口${z(CLOSURE_ZH, c.chargePort)}`,
  ]
}

export function describeKey(k: WhitelistEntryInfo, mine: Uint8Array | null): string {
  const pub: Uint8Array | undefined = k.publicKey?.PublicKeyRaw
  const isMine: boolean = !!mine && !!pub && hex(pub) === hex(mine)
  return `槽 ${k.slot ?? 0}：${z(ROLE_ZH, k.keyRole)} · ${z(FORM_ZH, k.metadataForKey?.keyFormFactor)} · ${hex(k.keyId?.publicKeySHA1).slice(0, 8)}${isMine ? " ← 本机" : ""}`
}
