// 调度层：RoutableMessage 收发、请求/响应匹配、各域握手、响应解密与重试
// 对应 Go internal/dispatcher/{dispatcher,session,receiver}.go 与 pkg/protocol/error.go
// 只依赖轻量模块（pb_lite、crypto_lite 等），小组件的直连路径也用这里（client/quick.ts）
import { equalBytes, hex, randomBytes, sleep, toBytes } from "../core/bytes"
import { Errors, faultError, TeslaError } from "../core/errors"
import { loadSessions, saveSession } from "../core/keys_lite"
import { log } from "../core/log"
import { decode, encode, Types } from "../core/pb_lite"
import { Domain, DomainId, FLAG_ENCRYPT_RESPONSE } from "../core/proto_consts"
import { Session, SessionInfoObj, SessionKeys, SlidingWindow } from "../core/session"
import { BleTransport } from "../core/transport_ble"

const ADDRESS_LEN: number = 16
const UUID_LEN: number = 16
/** 握手请求到回复之间允许的最大延迟，超过则丢弃 session info（Go maxLatency） */
const MAX_LATENCY_MS: number = 4000
export const RETRY_INTERVAL_MS: number = 1000
export const DEFAULT_TIMEOUT_MS: number = 5000

const SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST: number = 1
const OPERATION_STATUS_WAIT: number = 1
const OPERATION_STATUS_ERROR: number = 2

export type Msg = Record<string, any>

/** 一个请求的待收回复队列 */
export class Pending {
  readonly key: string
  readonly domain: DomainId
  readonly uuid: Uint8Array
  readonly sentAt: number = Date.now()
  /** 加密请求的 request hash，用于解密响应 */
  requestId: Uint8Array | null = null
  readonly window: SlidingWindow = new SlidingWindow()
  private queue: Msg[] = []
  private waiter: ((m: Msg) => void) | null = null
  private readonly dispatcher: Dispatcher

  /** 没有副作用的请求（读状态、握手、Ping）：回复丢包时可以让它立刻失败并重发 */
  readonly readOnly: boolean

  constructor(dispatcher: Dispatcher, key: string, domain: DomainId, uuid: Uint8Array, readOnly: boolean) {
    this.dispatcher = dispatcher
    this.key = key
    this.domain = domain
    this.uuid = uuid
    this.readOnly = readOnly
  }

  push(m: Msg): void {
    const w = this.waiter
    if (w) {
      this.waiter = null
      w(m)
    } else if (this.queue.length < 10) {
      this.queue.push(m)
    } else {
      log.warn("回复队列已满，丢弃一条")
    }
  }

  /** 等下一条回复；超时抛 TIMEOUT（可能已执行） */
  next(timeoutMs: number, what: string): Promise<Msg> {
    const m: Msg | undefined = this.queue.shift()
    if (m) return Promise.resolve(m)
    if (this.failed) return Promise.reject(this.failed)
    return new Promise<Msg>((resolve: (m: Msg) => void, reject: (e: Error) => void) => {
      const timer = setTimeout(() => {
        this.waiter = null
        this.failer = null
        reject(Errors.timeout(what))
      }, Math.max(1, timeoutMs))
      this.waiter = (msg: Msg) => {
        clearTimeout(timer)
        this.failer = null
        resolve(msg)
      }
      this.failer = (e: Error) => {
        clearTimeout(timer)
        this.waiter = null
        reject(e)
      }
    })
  }

  private failed: Error | null = null
  private failer: ((e: Error) => void) | null = null

  /** 连接断开：等待中的回复立刻失败，不再等到超时 */
  fail(e: Error): void {
    this.failed = e
    const f = this.failer
    this.failer = null
    f?.(e)
  }

  close(): void {
    this.dispatcher.closePending(this)
  }
}

/** 协议层错误检查（Go protocol.GetError） */
export function getError(m: Msg): TeslaError | null {
  const fault: number = m.signedMessageStatus?.signed_message_fault ?? 0
  if (fault !== 0) return faultError(fault)
  const infoBytes: Uint8Array = toBytes(m.session_info)
  if (infoBytes.length) {
    let info: SessionInfoObj
    try {
      info = decode<SessionInfoObj>(Types.SessionInfo, infoBytes)
    } catch (_e) {
      return Errors.badResponse("session info 无法解析")
    }
    const st: number = info.status ?? 0
    if (st === SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST) return Errors.keyNotPaired()
    if (st !== 0) return Errors.unknown()
  }
  const op: number = m.signedMessageStatus?.operation_status ?? 0
  if (op === OPERATION_STATUS_WAIT) return Errors.busy()
  if (op !== 0 && op !== OPERATION_STATUS_ERROR) return Errors.unknown()
  return null
}

/** 可以重试：临时错误且不可能已经执行 */
export function shouldRetry(e: unknown): boolean {
  return e instanceof TeslaError && e.temporary && !e.possibleSuccess
}

export class Dispatcher {
  readonly transport: BleTransport
  readonly vin: string
  private readonly keys: SessionKeys | null
  /** Infotainment 用固定 routing address；VCSEC 每个请求换新地址 */
  private readonly address: Uint8Array = randomBytes(ADDRESS_LEN)
  private readonly sessions: Map<number, Session> = new Map()
  private readonly pending: Map<string, Pending> = new Map()
  /** 没有对应请求的消息（含车辆主动推送到广播域的状态、无法按 RoutableMessage 解析的原始字节） */
  private readonly unmatchedListeners: Set<(raw: Uint8Array, m: Msg | null) => void> = new Set()

  onUnmatched(fn: (raw: Uint8Array, m: Msg | null) => void): () => void {
    this.unmatchedListeners.add(fn)
    return () => {
      this.unmatchedListeners.delete(fn)
    }
  }

  private emitUnmatched(raw: Uint8Array, m: Msg | null): void {
    for (const fn of this.unmatchedListeners) {
      try {
        fn(raw, m)
      } catch (e: any) {
        log.warn("未匹配消息监听器异常: " + String(e?.message ?? e))
      }
    }
  }

  constructor(transport: BleTransport, vin: string, keys: SessionKeys | null) {
    this.transport = transport
    this.vin = vin
    this.keys = keys
    transport.onMessage = (bytes: Uint8Array) => this.process(bytes)
    this.offDisconnect = transport.onDisconnect(() => {
      // 断开时指令可能已经发出并执行，按「可能已执行」报告
      const e: TeslaError = new TeslaError("DISCONNECTED", "蓝牙连接断开了", false, true)
      for (const p of [...this.pending.values()]) p.fail(e)
      this.pending.clear()
    })
    this.offFrameLoss = transport.onFrameLoss(() => {
      // 不知道丢的是哪条回复，只让「只读」请求立刻失败并重发（没有副作用，重发安全）。
      // 指令继续等自己的回复或超时：2026-10-18 实测车机 Ping 的回复丢包时，同时在等的解锁指令被一起判失败，
      // 而车辆其实已经解锁、解锁的回复随后完整到达
      const e: TeslaError = new TeslaError("FRAME_LOST", "蓝牙数据包丢失，没有收到完整回复", true, false)
      for (const p of [...this.pending.values()]) if (p.readOnly) p.fail(e)
    })
  }

  private readonly offDisconnect: () => void
  private readonly offFrameLoss: () => void

  /** 换钥匙重建调度器时，解除对旧传输层事件的监听 */
  dispose(): void {
    this.offDisconnect()
    this.offFrameLoss()
  }

  get hasKey(): boolean {
    return this.keys != null
  }

  private static key(domain: number, address: Uint8Array, uuid: Uint8Array | null): string {
    return `${domain}:${hex(address)}:${domain === Domain.VCSEC || !uuid ? "" : hex(uuid)}`
  }

  closePending(p: Pending): void {
    if (this.pending.get(p.key) === p) this.pending.delete(p.key)
  }

  // ---- 接收 ----

  private process(bytes: Uint8Array): void {
    let m: Msg
    try {
      m = decode<Msg>(Types.RoutableMessage, bytes)
    } catch (e: any) {
      log.warn("丢弃无法解析的消息: " + String(e?.message ?? e))
      this.emitUnmatched(bytes, null)
      return
    }
    const domain: number | undefined = m.from_destination?.domain
    if (domain == null) {
      log.warn("丢弃缺少来源域的消息")
      this.emitUnmatched(bytes, m)
      return
    }
    const reqUuid: Uint8Array = toBytes(m.request_uuid)
    if (reqUuid.length !== 0 && reqUuid.length !== UUID_LEN) {
      log.warn("丢弃 request_uuid 长度错误的消息")
      return
    }
    const addr: Uint8Array = toBytes(m.to_destination?.routing_address)
    if (addr.length !== ADDRESS_LEN) {
      if (m.to_destination?.domain !== Domain.BROADCAST) log.info(`忽略发往域 ${m.to_destination?.domain ?? "?"} 的消息`)
      this.emitUnmatched(bytes, m)
      return
    }
    const p: Pending | undefined = this.pending.get(Dispatcher.key(domain, addr, reqUuid))
    if (!p) {
      log.info(`丢弃没有对应请求的回复 domain=${domain}`)
      this.emitUnmatched(bytes, m)
      return
    }
    // 车辆在错误回复里可能附带新的 session info，先更新会话再交给请求方
    this.checkForSessionUpdate(m, p, reqUuid).then(() => this.decryptInPlace(m, p)).then((ok: boolean) => {
      if (ok) p.push(m)
    }).catch((e: any) => log.warn("处理回复失败: " + String(e?.message ?? e)))
  }

  private async checkForSessionUpdate(m: Msg, p: Pending, reqUuid: Uint8Array): Promise<void> {
    const info: Uint8Array = toBytes(m.session_info)
    if (!info.length) return
    if (!this.keys) return
    if (Date.now() - p.sentAt > MAX_LATENCY_MS) {
      log.warn("session info 到达太晚，丢弃")
      return
    }
    const tag: Uint8Array = toBytes(m.signature_data?.session_info_tag?.tag)
    if (!tag.length) {
      // 钥匙不在白名单时车辆不带 HMAC，属正常情况
      log.info("session info 没有 HMAC，不用于建立会话")
      return
    }
    const s: Session | undefined = this.sessions.get(p.domain)
    if (!s) return
    const challenge: Uint8Array = reqUuid.length ? reqUuid : p.uuid
    if (!equalBytes(challenge, p.uuid)) {
      log.warn("session info 的 challenge 与请求不符，丢弃")
      return
    }
    try {
      await s.processHello(challenge, info, tag)
      const c = s.exportCache()
      if (c) saveSession(c)
      log.info(`域 ${p.domain} 会话已更新 counter=${s.counter}`)
    } catch (e: any) {
      log.warn(`域 ${p.domain} session info 无效: ${String(e?.message ?? e)}`)
    }
  }

  /** 解密 AES-GCM 响应，明文写回 protobuf_message_as_bytes；重放返回 false */
  private async decryptInPlace(m: Msg, p: Pending): Promise<boolean> {
    if (!m.signature_data?.AES_GCM_Response_data) return true
    const s: Session | undefined = this.sessions.get(p.domain)
    if (!s || !p.requestId) {
      log.warn("收到加密回复但没有解密上下文")
      return false
    }
    const { plaintext, counter } = await s.decryptResponse(m, p.requestId)
    if (!p.window.update(counter)) {
      log.info("丢弃重复的车辆回复")
      return false
    }
    m.protobuf_message_as_bytes = plaintext
    return true
  }

  // ---- 发送 ----

  /**
   * 发送一条 RoutableMessage。auth=true 时用该域会话加密 payload（需先 startSession）。
   * 返回 Pending，调用方读完回复后必须 close()。
   */
  async send(domain: DomainId, payload: Msg, auth: boolean, readOnly: boolean = false): Promise<Pending> {
    if (!this.transport.isConnected) throw Errors.notConnected()
    const uuid: Uint8Array = randomBytes(UUID_LEN)
    const addr: Uint8Array = domain === Domain.VCSEC ? randomBytes(ADDRESS_LEN) : this.address
    const msg: Msg = {
      to_destination: { domain },
      from_destination: { routing_address: addr },
      uuid,
      ...payload,
    }
    const p: Pending = new Pending(this, Dispatcher.key(domain, addr, uuid), domain, uuid, readOnly)
    if (auth) {
      const s: Session | undefined = this.sessions.get(domain)
      if (!s || !s.ready) throw Errors.noSession()
      const plain: Uint8Array = toBytes(msg.protobuf_message_as_bytes)
      const enc = await s.encrypt(plain, FLAG_ENCRYPT_RESPONSE)
      msg.protobuf_message_as_bytes = enc.ciphertext
      msg.signature_data = enc.signatureData
      msg.flags = FLAG_ENCRYPT_RESPONSE
      p.requestId = enc.requestId
      const c = s.exportCache()
      if (c) saveSession(c)
    }
    this.pending.set(p.key, p)
    try {
      await this.transport.send(encode(Types.RoutableMessage, msg))
    } catch (e) {
      p.close()
      throw e
    }
    return p
  }

  // ---- 会话 ----

  session(domain: DomainId): Session | undefined {
    return this.sessions.get(domain)
  }

  /** 握手：发 session_info_request，等车辆回复的 session info 通过 HMAC 校验 */
  async startSession(domain: DomainId, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Session> {
    if (!this.keys) throw Errors.noKey()
    let s: Session | undefined = this.sessions.get(domain)
    if (s?.ready) return s
    if (!s) {
      s = new Session(domain, this.vin, this.keys)
      this.sessions.set(domain, s)
      const cached = loadSessions()[String(domain)]
      if (cached) {
        try {
          await s.importCache(cached)
          log.info(`域 ${domain} 会话从缓存恢复 counter=${s.counter}`)
          return s
        } catch (_e) {
          log.warn(`域 ${domain} 会话缓存无效，重新握手`)
        }
      }
    }
    const deadline: number = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const p: Pending = await this.send(domain, { session_info_request: { public_key: s.localPublic } }, false, true)
      try {
        const reply: Msg = await p.next(Math.min(RETRY_INTERVAL_MS * 2, deadline - Date.now()), "握手")
        const err: TeslaError | null = getError(reply)
        if (err) throw err
        // 回复已在 process() 里交给 processHello，等它完成
        for (let i = 0; i < 10 && !s.ready; i++) await sleep(20)
        if (s.ready) return s
        log.warn(`域 ${domain} 握手回复未能建立会话，重试`)
      } catch (e) {
        if (!shouldRetry(e)) throw e
      } finally {
        p.close()
      }
      await sleep(Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())))
    }
    throw Errors.timeout("握手")
  }

  /** 丢弃会话（例如签名失败且车辆没附带新的 session info） */
  resetSession(domain: DomainId): void {
    this.sessions.get(domain)?.reset()
    this.sessions.delete(domain)
  }

  /**
   * 不需要钥匙也能发的握手请求：返回车辆的 session info（status 表示这把公钥是否在白名单）。
   * 用来确认配对结果。
   */
  async querySessionInfo(domain: DomainId, publicKey: Uint8Array, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<SessionInfoObj> {
    const deadline: number = Date.now() + timeoutMs
    while (true) {
      const p: Pending = await this.send(domain, { session_info_request: { public_key: publicKey } }, false, true)
      try {
        const reply: Msg = await p.next(Math.max(1, deadline - Date.now()), "查询会话信息")
        const fault: number = reply.signedMessageStatus?.signed_message_fault ?? 0
        if (fault !== 0) throw faultError(fault)
        const infoBytes: Uint8Array = toBytes(reply.session_info)
        if (!infoBytes.length) throw Errors.badResponse("缺少 session info")
        return decode<SessionInfoObj>(Types.SessionInfo, infoBytes)
      } catch (e) {
        if (!shouldRetry(e) || Date.now() + RETRY_INTERVAL_MS > deadline) throw e
      } finally {
        p.close()
      }
      await sleep(RETRY_INTERVAL_MS)
    }
  }
}
