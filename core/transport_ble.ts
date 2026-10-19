// BLE 传输：扫描 / 连接 / 2 字节长度前缀分帧 / 按 MTU 分片写入 / 通知重组
// 对应 Go pkg/connector/ble/ble.go
import { concat, equalBytes, hex, sleep, u16be } from "./bytes"
import { Errors, TeslaError } from "./errors"
import { log } from "./log"

export const TESLA_SERVICE: string = "00000211-B2D1-43F0-9B88-960CEBF8B91E"
export const TESLA_TX_CHAR: string = "00000212-B2D1-43F0-9B88-960CEBF8B91E"
export const TESLA_RX_CHAR: string = "00000213-B2D1-43F0-9B88-960CEBF8B91E"

const MAX_MESSAGE: number = 1024
// Go 用 1 秒；但这里计时用的是 JS 处理分片的时刻，JS 线程被耗时计算占住时，同一条消息的分片也会隔开超过 1 秒，
// 缓冲被误清空，后面的分片被当成长度头（2026-10-17 实测「丢弃超长消息 len=27299」两次，随后该请求超时）
const RX_CHUNK_TIMEOUT_MS: number = 5000
const DEFAULT_BLOCK: number = 20
/** discover* 之后等待列表填充的最长时间 */
const LIST_WAIT_MS: number = 2000

const BLE_OP_TIMEOUT_MS: number = 2000
/** 单片写入（withResponse）的最长等待；正常几十毫秒 */
const WRITE_TIMEOUT_MS: number = 4000

/** 等 promise 结束（成功或失败都算）；超时返回 false */
function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve: (ok: boolean) => void) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    promise.then(() => true, () => true).then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** 等 promise 成功；失败抛出原错误，超时返回 false */
function settleOk(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve: (ok: boolean) => void, reject: (e: unknown) => void) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    }, (e: unknown) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/** 每 50ms 轮询一次，直到 get() 返回非空或超时 */
async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline: number = Date.now() + timeoutMs
  while (true) {
    const v: T | undefined = get()
    if (v !== undefined || Date.now() >= deadline) return v
    await sleep(50)
  }
}

export type ConnState = "idle" | "scanning" | "connecting" | "connected" | "disconnected"

export interface ScanHit {
  peripheral: BluetoothPeripheral
  rssi: number
  connectable: boolean
}

function sameUUID(a: string, b: string): boolean {
  const n = (s: string): string => {
    const u: string = s.toUpperCase()
    return u.length === 4 ? `0000${u}-0000-1000-8000-00805F9B34FB` : u
  }
  return n(a) === n(b)
}

/**
 * 扫描指定广播名的车辆，返回首个命中；超时返回 null。
 */
export async function scanForVehicle(localName: string, timeoutMs: number): Promise<ScanHit | null> {
  return new Promise<ScanHit | null>((resolve: (h: ScanHit | null) => void) => {
    let done: boolean = false
    let timer: any = null
    const finish = async (h: ScanHit | null): Promise<void> => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try {
        await BluetoothCentralManager.stopScan()
      } catch (_e) {
        // ignore
      }
      resolve(h)
    }
    timer = setTimeout(() => {
      void finish(null)
    }, timeoutMs)
    BluetoothCentralManager.startScan(
      (p: BluetoothPeripheral, adv: BluetoothAdvertisementData, rssi: number) => {
        const name: string = adv.localName ?? p.name ?? ""
        if (name !== localName) return
        const connectable: boolean = adv.isConnectable !== false
        if (!connectable) log.warn("车辆广播 isConnectable=false：车辆蓝牙连接数可能已满（最多 3 条）")
        void finish({ peripheral: p, rssi, connectable })
      },
      { allowDuplicates: false },
    ).catch((e: any) => {
      log.error("开始扫描失败: " + String(e?.message ?? e))
      void finish(null)
    })
  })
}

export class BleTransport {
  state: ConnState = "idle"
  peripheral: BluetoothPeripheral | null = null
  private txChar: BluetoothCharacteristic | null = null
  private rxChar: BluetoothCharacteristic | null = null
  private blockLength: number = DEFAULT_BLOCK
  private inputBuffer: Uint8Array = new Uint8Array(0)
  private lastRx: number = 0
  private lastChunk: Uint8Array | null = null
  private recentChunks: string[] = []
  private writeChain: Promise<void> = Promise.resolve()
  /** 连接代次：断开时加一，旧代次的写入一律作废 */
  private gen: number = 0
  private disconnectWaiter: (() => void) | null = null

  onMessage: ((msg: Uint8Array) => void) | null = null
  onStateChange: ((s: ConnState, err?: string) => void) | null = null

  private setState(s: ConnState, err?: string): void {
    this.state = s
    this.onStateChange?.(s, err)
  }

  get isConnected(): boolean {
    // peripheral.isConnected 可能是扫描时的快照，不随连接变化；以 onDisconnected 维护的状态为准
    return this.state === "connected" && this.peripheral != null
  }

  /** 连接到车辆：优先用缓存的外设 id，失败则扫描广播名 */
  async connect(localName: string, cachedId?: string, scanTimeoutMs: number = 12000): Promise<string> {
    if (this.isConnected && this.peripheral) return this.peripheral.id
    let p: BluetoothPeripheral | null = null
    this.setState("scanning")
    const hit: ScanHit | null = await scanForVehicle(localName, scanTimeoutMs)
    if (hit) {
      p = hit.peripheral
      log.info(`发现车辆 ${localName} RSSI=${hit.rssi}`)
    } else if (cachedId) {
      const known: BluetoothPeripheral[] = await BluetoothCentralManager.retrievePeripherals([cachedId])
      p = known[0] ?? null
      if (p) log.info("扫描未命中，尝试缓存的外设 id 直连")
    }
    if (!p) {
      this.setState("disconnected", "附近没有扫描到车辆")
      throw new Error(`附近没有扫描到车辆（${localName}）。请靠近车辆并确认手机蓝牙已开启。`)
    }
    try {
      await this.attach(p)
    } catch (e: any) {
      // 连上了但没拿到特征：断开，避免占用车端连接位
      await this.disconnect()
      this.setState("disconnected", String(e?.message ?? e))
      throw e
    }
    return p.id
  }

  private async attach(p: BluetoothPeripheral): Promise<void> {
    this.peripheral = p
    this.setState("connecting")
    p.onDisconnected = (err: Error | null) => {
      log.warn("蓝牙断开（系统回调）" + (err ? ": " + err.message : ""))
      this.txChar = null
      this.rxChar = null
      this.setState("disconnected", err?.message)
      this.resetIO()
      const w = this.disconnectWaiter
      this.disconnectWaiter = null
      w?.()
    }
    await BluetoothCentralManager.connect(p)
    const findSvc = (): BluetoothService | undefined => (p.services ?? []).find((s: BluetoothService) => sameUUID(s.uuid, TESLA_SERVICE))
    // Scripting 的 discover* Promise 返回后，services / characteristics 要稍后才填进对象（实测几十到几百毫秒），所以轮询等待
    await p.discoverServices([TESLA_SERVICE])
    let svc0: BluetoothService | undefined = await waitFor(findSvc, LIST_WAIT_MS)
    if (!svc0) {
      log.warn("按 UUID 发现服务超时，改为发现全部服务")
      await p.discoverServices()
      svc0 = await waitFor(findSvc, LIST_WAIT_MS)
    }
    if (!svc0) throw new Error(`车辆没有提供 Tesla 蓝牙服务（发现的服务：${(p.services ?? []).map((s: BluetoothService) => s.uuid).join(",") || "无"}）`)
    const svc: BluetoothService = svc0
    const complete = (): BluetoothCharacteristic[] | undefined => {
      const list: BluetoothCharacteristic[] = findSvc()?.characteristics ?? svc.characteristics ?? []
      const ok: boolean = list.some((c: BluetoothCharacteristic) => sameUUID(c.uuid, TESLA_TX_CHAR)) && list.some((c: BluetoothCharacteristic) => sameUUID(c.uuid, TESLA_RX_CHAR))
      return ok ? list : undefined
    }
    await p.discoverCharacteristics(svc)
    let found: BluetoothCharacteristic[] | undefined = await waitFor(complete, LIST_WAIT_MS)
    if (!found) {
      log.warn("发现特征超时，重新发现一次")
      await p.discoverCharacteristics(svc)
      found = await waitFor(complete, LIST_WAIT_MS)
    }
    const chars: BluetoothCharacteristic[] = found ?? findSvc()?.characteristics ?? svc.characteristics ?? []
    log.info(`服务 ${svc.uuid} 特征：${chars.map((c: BluetoothCharacteristic) => `${c.uuid}[${(c.properties ?? []).join("/")}]`).join(", ") || "无"}`)
    this.txChar = chars.find((c: BluetoothCharacteristic) => sameUUID(c.uuid, TESLA_TX_CHAR)) ?? null
    this.rxChar = chars.find((c: BluetoothCharacteristic) => sameUUID(c.uuid, TESLA_RX_CHAR)) ?? null
    if (!this.txChar || !this.rxChar) throw new Error(`没有找到 Tesla 蓝牙读写特征（找到 ${chars.length} 个：${chars.map((c: BluetoothCharacteristic) => c.uuid).join(",")}）`)
    // Go 实现用 ATT_MTU-3 作为分片大小；iOS 的 withoutResponse 长度就是 ATT_MTU-3（withResponse 可能返回 512，依赖长写，车端未必支持）
    const mtu: number = p.maxWriteValueLength("withoutResponse")
    this.blockLength = mtu >= DEFAULT_BLOCK ? Math.min(mtu, MAX_MESSAGE) : DEFAULT_BLOCK
    await p.subscribe(this.rxChar, (err: Error | null, value: Data | null) => {
      if (err) {
        log.warn("通知错误: " + err.message)
        return
      }
      const bytes: Uint8Array | null = value ? value.toUint8Array() : null
      if (bytes && bytes.length) this.rx(bytes)
    })
    log.info(`已连接，写入块大小 ${this.blockLength} 字节`)
    this.setState("connected")
  }

  async disconnect(): Promise<void> {
    const p: BluetoothPeripheral | null = this.peripheral
    if (!p) return
    // 实测 unsubscribe / disconnect 的 Promise 可能永远不返回，每步最多等 2 秒
    // unsubscribe 的 Promise 实测从不返回；断开时系统会清掉订阅，所以只发出不等待
    if (this.rxChar && this.state === "connected") p.unsubscribe(this.rxChar).catch(() => undefined)
    // 以系统的 onDisconnected 回调作为「本 App 已断开」的确认
    const confirmed: Promise<void> = new Promise<void>((resolve: () => void) => {
      this.disconnectWaiter = resolve
    })
    const wasConnected: boolean = this.state === "connected" || this.state === "connecting"
    if (!(await settleWithin(BluetoothCentralManager.disconnect(p), BLE_OP_TIMEOUT_MS))) log.warn("断开请求的 Promise 超时未返回")
    if (wasConnected) {
      if (await settleWithin(confirmed, BLE_OP_TIMEOUT_MS)) log.info("已确认断开：收到系统断开回调")
      else log.warn("2 秒内没有收到系统断开回调，无法确认已断开")
    }
    this.disconnectWaiter = null
    this.txChar = null
    this.rxChar = null
    if (this.state !== "disconnected") {
      this.setState("disconnected")
      this.resetIO()
    }
    // 系统层面是否还连着（可能是 Tesla App 等其他 App 持有的连接）
    try {
      const still: BluetoothPeripheral[] = await BluetoothCentralManager.retrieveConnectedPeripherals([TESLA_SERVICE])
      const mine: boolean = still.some((x: BluetoothPeripheral) => x.id === p.id)
      log.info(mine ? "系统仍与车辆保持蓝牙连接（其他 App 在用，例如 Tesla App 手机钥匙；本脚本已断开）" : "系统层面已无与车辆的连接")
    } catch (e: any) {
      log.warn("查询系统连接失败: " + String(e?.message ?? e))
    }
  }

  async readRSSI(): Promise<number | null> {
    try {
      return this.peripheral && this.state === "connected" ? await this.peripheral.readRSSI() : null
    } catch (_e) {
      return null
    }
  }

  /** 接收：两包间隔超过 1s 清空缓冲；按 2 字节长度拆出完整消息 */
  private rx(chunk: Uint8Array): void {
    const now: number = Date.now()
    // 诊断：最近分片（时间差、长度、开头字节），拆包出错时一起打印
    this.recentChunks.push(`${this.lastRx ? `+${now - this.lastRx}ms` : "首片"} len=${chunk.length} ${hex(chunk.slice(0, 8))}`)
    if (this.recentChunks.length > 12) this.recentChunks.shift()
    // 2026-10-17 实测拆包出错时同一个错误长度连续出现两次，怀疑同一分片被投递了两次；
    // 加密数据两片完全相同几乎不可能，所以紧挨着的相同分片当作重复丢弃，并记日志以便确认
    const prev: Uint8Array | null = this.lastChunk
    this.lastChunk = chunk
    if (prev && now - this.lastRx < 200 && equalBytes(prev, chunk)) {
      // 实测重复总是伴随前一片丢失：缓冲里的消息已经不完整，清掉并通知上层，免得白等到超时
      log.warn(`丢弃重复分片 len=${chunk.length}，缓冲里的消息已不完整`)
      this.inputBuffer = new Uint8Array(0)
      this.emitFrameLoss()
      return
    }
    if (now - this.lastRx > RX_CHUNK_TIMEOUT_MS) this.inputBuffer = new Uint8Array(0)
    this.lastRx = now
    this.inputBuffer = concat(this.inputBuffer, chunk)
    while (this.inputBuffer.length >= 2) {
      const len: number = (this.inputBuffer[0] << 8) | this.inputBuffer[1]
      if (len > MAX_MESSAGE) {
        log.warn(`丢弃超长消息 len=${len}；最近分片：\n${this.recentChunks.join("\n")}`)
        // 正在等的回复多半已经丢了，通知上层不要白等到超时
        this.emitFrameLoss()
        this.inputBuffer = new Uint8Array(0)
        return
      }
      if (this.inputBuffer.length < 2 + len) return
      const msg: Uint8Array = this.inputBuffer.slice(2, 2 + len)
      this.inputBuffer = this.inputBuffer.slice(2 + len)
      log.rx(hex(msg))
      try {
        this.onMessage?.(msg)
      } catch (e: any) {
        log.error("处理消息异常: " + String(e?.message ?? e))
      }
    }
  }

  /**
   * 发送一条完整消息（自动加长度前缀并分片，串行写入）。
   * 每片写入都有超时：2026-10-17 实测信号弱（−97 dBm）时 writeValue 的 Promise 一直不返回、断开后也不返回，
   * 指令卡死，排在后面的写入也全部堵住。
   */
  send(message: Uint8Array): Promise<void> {
    const gen: number = this.gen
    const run = async (): Promise<void> => {
      const p: BluetoothPeripheral | null = this.peripheral
      const tx: BluetoothCharacteristic | null = this.txChar
      if (!p || !tx || this.state !== "connected" || gen !== this.gen) throw Errors.notConnected()
      if (message.length > MAX_MESSAGE) throw new Error("消息过长")
      log.tx(hex(message))
      const out: Uint8Array = concat(u16be(message.length), message)
      for (let i = 0; i < out.length; i += this.blockLength) {
        const end: number = Math.min(i + this.blockLength, out.length)
        const d: Data | null = Data.fromUint8Array(out.slice(i, end))
        if (!d) throw new Error("无法构造蓝牙数据包")
        if (!(await settleOk(p.writeValue(tx, d, "withResponse"), WRITE_TIMEOUT_MS))) {
          log.warn(`蓝牙写入 ${WRITE_TIMEOUT_MS} ms 没有完成（第 ${i / this.blockLength + 1} 片）`)
          // 最后一片已经发出时车辆可能收到了完整消息
          throw new TeslaError("WRITE_TIMEOUT", "蓝牙发送超时，信号可能太弱，请靠近车辆再试", false, end === out.length)
        }
        if (gen !== this.gen) throw Errors.notConnected()
      }
    }
    const next: Promise<void> = this.writeChain.then(run, run)
    this.writeChain = next.catch(() => undefined)
    return next
  }

  /** 连接断开：作废进行中的写入队列，通知上层立刻结束等待中的请求 */
  private resetIO(): void {
    this.gen++
    this.writeChain = Promise.resolve()
    this.inputBuffer = new Uint8Array(0)
    for (const fn of [...this.disconnectListeners]) {
      try {
        fn()
      } catch (_e) {
        // 监听器异常不影响断开处理
      }
    }
  }

  private readonly disconnectListeners: Set<() => void> = new Set()
  private readonly frameLossListeners: Set<() => void> = new Set()

  /**
   * 拆包出错（收到的数据对不上长度头）。2026-10-17 实测出错时总是「前一片丢失、后一片重复」，
   * 推断是分片投递到脚本时被后一片覆盖，脚本这边无法恢复丢失的数据。
   */
  private emitFrameLoss(): void {
    for (const fn of [...this.frameLossListeners]) {
      try {
        fn()
      } catch (_e) {
        // 监听器异常不影响收包
      }
    }
  }

  onFrameLoss(fn: () => void): () => void {
    this.frameLossListeners.add(fn)
    return () => {
      this.frameLossListeners.delete(fn)
    }
  }

  onDisconnect(fn: () => void): () => void {
    this.disconnectListeners.add(fn)
    return () => {
      this.disconnectListeners.delete(fn)
    }
  }
}
