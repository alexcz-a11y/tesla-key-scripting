// VCSEC 域：状态查询、钥匙列表、RKE 动作、开合件动作
// 对应 Go pkg/vehicle/vcsec.go。VCSEC 同一时间只发一个请求（官方要求 counter 按序到达）
// 只依赖轻量模块，小组件的直连路径也用这里（client/quick.ts）
import { sleep, toBytes } from "../core/bytes"
import { Errors, nominalError, TeslaError, whitelistError } from "../core/errors"
import { log } from "../core/log"
import { decode, encode, Types } from "../core/pb_lite"
import { Domain, InfoRequest } from "../core/proto_consts"
import { DEFAULT_TIMEOUT_MS, Dispatcher, getError, Msg, Pending, RETRY_INTERVAL_MS, shouldRetry } from "./dispatcher"

const OPERATION_STATUS_WAIT: number = 1
const OPERATION_STATUS_ERROR: number = 2
const CLOSURE_TIMEOUT_MS: number = 15000

export interface VehicleStatus {
  closureStatuses?: {
    frontDriverDoor?: number
    frontPassengerDoor?: number
    rearDriverDoor?: number
    rearPassengerDoor?: number
    rearTrunk?: number
    frontTrunk?: number
    chargePort?: number
    tonneau?: number
  }
  vehicleLockState?: number
  vehicleSleepStatus?: number
  userPresence?: number
  detailedClosureStatus?: { tonneauPercentOpen?: number }
}

export interface WhitelistInfo {
  numberOfEntries?: number
  whitelistEntries?: { publicKeySHA1?: Uint8Array }[]
  slotMask?: number
}

export interface WhitelistEntryInfo {
  keyId?: { publicKeySHA1?: Uint8Array }
  publicKey?: { PublicKeyRaw?: Uint8Array }
  metadataForKey?: { keyFormFactor?: number }
  slot?: number
  keyRole?: number
}

type TerminalTest = (from: Msg) => boolean

/** 解析 VCSEC 回复并把应用层错误转成异常（Go unmarshalVCSECResponse） */
export function unmarshalVCSEC(m: Msg): Msg {
  const err: TeslaError | null = getError(m)
  if (err) throw err
  const body: Uint8Array = toBytes(m.protobuf_message_as_bytes)
  if (!body.length) return {}
  let from: Msg
  try {
    from = decode<Msg>(Types.FromVCSECMessage, body)
  } catch (_e) {
    throw Errors.badResponse("FromVCSECMessage 无法解析")
  }
  if (from.nominalError) throw nominalError(from.nominalError.genericError)
  const st: Msg | undefined = from.commandStatus
  if (st) {
    const op: number = st.operationStatus ?? 0
    if (op === OPERATION_STATUS_WAIT) throw Errors.busy()
    if (op === OPERATION_STATUS_ERROR) {
      const code: number = st.whitelistOperationStatus?.whitelistOperationInformation ?? 0
      if (code !== 0) throw whitelistError(code)
      if (!st.signedMessageStatus) throw Errors.unknown()
    }
  }
  return from
}

const noCommandStatus: TerminalTest = (from: Msg) => from.commandStatus == null
const firstReply: TerminalTest = () => true

export class VcsecClient {
  private readonly d: Dispatcher
  private chain: Promise<unknown> = Promise.resolve()

  constructor(d: Dispatcher) {
    this.d = d
  }

  /** 串行执行 VCSEC 请求 */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run: Promise<T> = this.chain.then(job, job)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async readUntil(p: Pending, done: TerminalTest, deadline: number, early?: Promise<void>): Promise<Msg> {
    let observed: boolean = false
    const earlyDone: Promise<null> | null = early ? early.then(() => {
      observed = true
      return null
    }) : null
    while (true) {
      const next: Promise<Msg> = p.next(deadline - Date.now(), "VCSEC 指令")
      const reply: Msg | null = earlyDone ? await Promise.race([next, earlyDone]) : await next
      if (reply == null || observed) {
        next.catch(() => undefined)
        log.info("车辆状态推送已确认动作完成，不再等待回复")
        return {}
      }
      const from: Msg = unmarshalVCSEC(reply)
      if (done(from)) return from
    }
  }

  /** 发送 UnsignedMessage 到 VCSEC，按官方规则重试，直到终态 */
  /** early：外部观察到动作已完成（例如状态推送）时 resolve，提前结束等待 */
  /** readOnly：查询类请求（状态、钥匙列表），回复丢包时可以安全重发 */
  private result(unsigned: Msg, auth: boolean, done: TerminalTest, timeoutMs: number = DEFAULT_TIMEOUT_MS, early?: Promise<void>, readOnly: boolean = false): Promise<Msg> {
    return this.serial(async () => {
      const payload: Uint8Array = encode(Types.UnsignedMessage, unsigned)
      const deadline: number = Date.now() + timeoutMs
      if (auth) await this.d.startSession(Domain.VCSEC, timeoutMs)
      while (true) {
        let err: unknown
        const p: Pending = await this.d.send(Domain.VCSEC, { protobuf_message_as_bytes: payload }, auth, readOnly)
        try {
          return await this.readUntil(p, done, deadline, early)
        } catch (e) {
          err = e
        } finally {
          p.close()
        }
        if (!shouldRetry(err) || Date.now() + RETRY_INTERVAL_MS >= deadline) throw err
        log.info("VCSEC 重试: " + String((err as Error)?.message ?? err))
        await sleep(RETRY_INTERVAL_MS)
      }
    })
  }

  // ---- 不需要钥匙 ----

  async status(): Promise<VehicleStatus> {
    const from: Msg = await this.result({ InformationRequest: { informationRequestType: InfoRequest.GET_STATUS } }, false, firstReply, DEFAULT_TIMEOUT_MS, undefined, true)
    return (from.vehicleStatus ?? {}) as VehicleStatus
  }

  async whitelistInfo(): Promise<WhitelistInfo> {
    const from: Msg = await this.result({ InformationRequest: { informationRequestType: InfoRequest.GET_WHITELIST_INFO } }, false, firstReply, DEFAULT_TIMEOUT_MS, undefined, true)
    return (from.whitelistInfo ?? {}) as WhitelistInfo
  }

  async whitelistEntry(slot: number): Promise<WhitelistEntryInfo> {
    const from: Msg = await this.result({ InformationRequest: { informationRequestType: InfoRequest.GET_WHITELIST_ENTRY_INFO, slot } }, false, firstReply, DEFAULT_TIMEOUT_MS, undefined, true)
    return (from.whitelistEntryInfo ?? {}) as WhitelistEntryInfo
  }

  // ---- 需要已配对的钥匙 ----

  async rke(action: number): Promise<void> {
    await this.result({ RKEAction: action }, true, noCommandStatus)
  }

  /** 开合件动作，例如 { rearTrunk: ClosureMove.MOVE } */
  async closure(request: Record<string, number>, early?: Promise<void>): Promise<void> {
    // 实测车辆要等开合动作走完才回复（尾门超过 5 秒，车门重试时 40 秒以上），给 15 秒并接受状态推送提前确认
    await this.result({ closureMoveRequest: request }, true, noCommandStatus, CLOSURE_TIMEOUT_MS, early)
  }
}
