// 配对：发送 add-key-request（旧式 ToVCSECMessage 信封，不需要会话），提示刷卡确认，轮询 session info 直到钥匙进入白名单
// 对应 Go pkg/vehicle/security.go SendAddKeyRequestWithRole 与 vcsec.go addKeyPayload
import { hex, sleep, toBytes } from "../core/bytes"
import { describeError, TeslaError, whitelistError } from "../core/errors"
import { loadConfig, saveConfig, VehicleConfig } from "../core/keystore"
import { log } from "../core/log"
import { decode, Domain, encode, KeyFormFactor, KeyRole, Types } from "../core/proto"
import { Msg } from "./dispatcher"
import { VehicleClient } from "./vehicle"

const SIGNATURE_TYPE_PRESENT_KEY: number = 2
const OPERATION_STATUS_WAIT: number = 1
const POLL_INTERVAL_MS: number = 2000
/** 车辆等刷卡和屏幕确认的时间有限，超过这个时间仍未进白名单就判定失败 */
export const PAIR_TIMEOUT_MS: number = 120000

export interface PairOptions {
  role?: number
  formFactor?: number
  timeoutMs?: number
  onProgress: (line: string) => void
  /** 返回 true 时中止等待 */
  cancelled?: () => boolean
}

export function addKeyRequestBytes(publicKey: Uint8Array, role: number, formFactor: number): Uint8Array {
  const unsigned: Uint8Array = encode(Types.UnsignedMessage, {
    WhitelistOperation: {
      addKeyToWhitelistAndAddPermissions: { key: { PublicKeyRaw: publicKey }, keyRole: role },
      metadataForKey: { keyFormFactor: formFactor },
    },
  })
  return encode(Types.ToVCSECMessage, {
    signedMessage: { protobufMessageAsBytes: unsigned, signatureType: SIGNATURE_TYPE_PRESENT_KEY },
  })
}

/** 尝试把车辆的非请求回复解释成 FromVCSECMessage（可能是 RoutableMessage 包着，也可能是裸消息） */
function interpretVcsec(raw: Uint8Array, m: Msg | null): Msg | null {
  const candidates: Uint8Array[] = []
  const body: Uint8Array = toBytes(m?.protobuf_message_as_bytes)
  if (body.length) candidates.push(body)
  if (!m) candidates.push(raw)
  for (const c of candidates) {
    try {
      return decode<Msg>(Types.FromVCSECMessage, c)
    } catch (_e) {
      // 继续尝试下一个
    }
  }
  return null
}

/**
 * 发起配对并等待结果。成功返回；失败抛错（等刷卡超时、屏幕拒绝、列表已满等）。
 * 调用前必须已连接车辆、已生成钥匙。
 */
export async function pairKey(client: VehicleClient, publicKey: Uint8Array, opt: PairOptions): Promise<void> {
  const role: number = opt.role ?? KeyRole.OWNER
  const formFactor: number = opt.formFactor ?? KeyFormFactor.IOS_DEVICE
  const timeoutMs: number = opt.timeoutMs ?? PAIR_TIMEOUT_MS
  const say = (s: string): void => {
    log.info(s)
    opt.onProgress(s)
  }

  // 先确认还没配对，避免重复添加
  const before = await client.keyStatus(Domain.VCSEC)
  if ((before.status ?? 0) === 0) {
    say("这把钥匙已经在白名单里了，不需要再配对")
    markPaired()
    return
  }

  // 车辆对配对请求的回复不带我们的 routing address，从「未匹配消息」里观察
  const result: { failure: TeslaError | null } = { failure: null }
  const off = client.d.onUnmatched((raw: Uint8Array, m: Msg | null) => {
    const from: Msg | null = interpretVcsec(raw, m)
    if (!from) return
    const st: Msg | undefined = from.commandStatus
    if (!st) return
    if ((st.operationStatus ?? 0) === OPERATION_STATUS_WAIT) {
      say("车辆在等待刷卡：请把钥匙卡放到中控刷卡区")
      return
    }
    const wl: Msg | undefined = st.whitelistOperationStatus
    if (wl) {
      const code: number = wl.whitelistOperationInformation ?? 0
      if (code === 0) say("车辆报告：钥匙操作完成")
      else result.failure = whitelistError(code)
    }
  })

  try {
    say(`发送配对请求（角色 ${role === KeyRole.OWNER ? "车主" : role}，形态 iPhone），公钥 ${hex(publicKey).slice(0, 16)}…`)
    await client.transport.send(addKeyRequestBytes(publicKey, role, formFactor))
    say("已发送。请在中控刷钥匙卡，然后在车机屏幕上点确认。")

    const deadline: number = Date.now() + timeoutMs
    let lastHint: number = Date.now()
    while (Date.now() < deadline) {
      if (opt.cancelled?.()) throw new TeslaError("CANCELLED", "已取消等待（车辆上的请求可能仍在进行）", false)
      if (result.failure) throw result.failure
      await sleep(POLL_INTERVAL_MS)
      try {
        const info = await client.keyStatus(Domain.VCSEC)
        if ((info.status ?? 0) === 0) {
          say("配对成功：钥匙已进入车辆白名单")
          markPaired()
          return
        }
      } catch (e) {
        log.warn("轮询配对状态失败: " + describeError(e))
      }
      if (Date.now() - lastHint > 15000) {
        lastHint = Date.now()
        say(`仍在等待…剩余 ${Math.round((deadline - Date.now()) / 1000)} 秒`)
      }
    }
    if (result.failure) throw result.failure
    throw new TeslaError("PAIR_TIMEOUT", "等待超时：没有在规定时间内刷卡并在屏幕上确认", false)
  } finally {
    off()
  }
}

function markPaired(): void {
  const c: VehicleConfig = loadConfig()
  c.paired = true
  c.pairedAt = Date.now()
  saveConfig(c)
}
