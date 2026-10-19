// 错误类型与中文提示（对应 Go pkg/protocol/error.go 的重试规则）
import { MessageFault } from "./proto_consts"

export class TeslaError extends Error {
  /** 可以等 1 秒后重试 */
  temporary: boolean
  /** 指令可能已经执行（例如超时没收到回复） */
  possibleSuccess: boolean
  code: string

  constructor(code: string, message: string, temporary: boolean = false, possibleSuccess: boolean = false) {
    super(message)
    this.name = "TeslaError"
    this.code = code
    this.temporary = temporary
    this.possibleSuccess = possibleSuccess
  }
}

const RETRYABLE_FAULTS: Set<number> = new Set<number>([
  MessageFault.BUSY,
  MessageFault.TIMEOUT,
  MessageFault.INVALID_SIGNATURE,
  MessageFault.INVALID_TOKEN_OR_COUNTER,
  MessageFault.INTERNAL,
  MessageFault.INCORRECT_EPOCH,
  MessageFault.TIME_EXPIRED,
  MessageFault.TIME_TO_LIVE_TOO_LONG,
])

const FAULT_ZH: Record<number, string> = {
  1: "车辆子系统忙，请稍后重试",
  2: "车辆子系统没有响应",
  3: "钥匙未配对：车辆不认识这把钥匙",
  4: "这把钥匙已被禁用",
  5: "签名校验失败（会话不同步）",
  6: "防重放计数器已被使用（会话不同步）",
  7: "权限不足（角色或车辆状态不允许）",
  8: "目标域无效，固件可能过旧",
  9: "车辆不支持该指令",
  10: "车辆无法解析该指令",
  11: "车辆内部错误（可能还没启动完成）",
  12: "指令发错了车（VIN 不匹配）",
  13: "参数错误",
  14: "车辆钥匙列表已满，请先删除一把钥匙",
  15: "会话 epoch 不匹配（会话不同步）",
  16: "IV 长度错误",
  17: "指令已过期（时钟不同步）",
  18: "车辆未写入 VIN，需要售后处理",
  19: "车辆内部错误（元数据哈希失败）",
  20: "指令有效期过长",
  21: "车主已关闭手机远程访问",
  22: "未开启远程服务访问",
  23: "该指令需要通过 Tesla 账号云端发送",
  24: "请求超出 MTU",
  25: "响应超出 MTU",
  26: "计数器重复",
  27: "钥匙句柄无效",
  28: "车辆要求加密响应",
}

export function faultError(fault: number): TeslaError {
  if (fault === MessageFault.UNKNOWN_KEY_ID) return new TeslaError("KEY_NOT_PAIRED", FAULT_ZH[3], false)
  return new TeslaError(`FAULT_${fault}`, FAULT_ZH[fault] ?? `车辆返回错误码 ${fault}`, RETRYABLE_FAULTS.has(fault))
}

export const Errors = {
  busy: (): TeslaError => new TeslaError("BUSY", "车辆忙或正在唤醒，请稍后", true),
  keyNotPaired: (): TeslaError => new TeslaError("KEY_NOT_PAIRED", "钥匙未配对：请先完成配对", false),
  timeout: (what: string): TeslaError => new TeslaError("TIMEOUT", `${what}超时，没有收到车辆回复`, true, true),
  notConnected: (): TeslaError => new TeslaError("NOT_CONNECTED", "没有连接到车辆", false),
  noSession: (): TeslaError => new TeslaError("NO_SESSION", "尚未与车辆建立安全会话", false),
  noKey: (): TeslaError => new TeslaError("NO_KEY", "还没有生成钥匙，请先在配对页生成", false),
  noVin: (): TeslaError => new TeslaError("NO_VIN", "还没有填写 VIN", false),
  unknown: (): TeslaError => new TeslaError("UNKNOWN", "车辆返回了未知状态", false),
  badResponse: (detail: string): TeslaError => new TeslaError("BAD_RESPONSE", `车辆回复格式错误：${detail}`, false, true),
}

const GENERIC_ZH: Record<number, string> = {
  1: "未知错误",
  2: "有门或盖没关",
  3: "已经是开启状态",
  4: "该功能对用户指令禁用",
  5: "车辆不在 P 挡",
  6: "未授权",
  7: "不允许通过当前通道（蓝牙）执行",
}

export function nominalError(genericError: number | undefined): TeslaError {
  const g: number = genericError ?? 1
  return new TeslaError(`NOMINAL_${g}`, GENERIC_ZH[g] ?? `车辆拒绝执行（${g}）`, false)
}

const WHITELIST_ZH: Record<number, string> = {
  1: "未记录的错误",
  2: "不能删除自己",
  3: "钥匙卡槽已满",
  4: "钥匙列表已满",
  5: "没有添加钥匙的权限",
  6: "公钥无效",
  7: "没有删除钥匙的权限",
  8: "没有修改权限的权限",
  9: "不能把别人提升到比自己更高的权限",
  10: "不能降级比自己权限高的钥匙",
  11: "不能移除自己的权限",
  12: "公钥不在钥匙列表中",
  13: "这把钥匙已经在列表里了",
  14: "必须把钥匙卡放在读卡区才能添加",
  15: "工厂模式外不能修改",
  16: "工厂模式不能添加永久钥匙",
  17: "工厂模式不能删除永久钥匙",
  18: "车辆存储已满",
  19: "添加钥匙时没有指定角色",
  20: "不能添加服务角色钥匙",
  21: "非服务钥匙不能添加服务技师",
  22: "服务模式外不能添加服务技师",
  23: "无法开始本地认证",
  24: "车机屏幕上拒绝了",
  25: "等待刷卡超时",
  26: "等待屏幕确认超时",
  27: "代客模式下不能添加",
  28: "已取消",
}

export function whitelistError(code: number): TeslaError {
  return new TeslaError(`WHITELIST_${code}`, WHITELIST_ZH[code] ?? `钥匙操作失败（${code}）`, false)
}

export function describeError(e: unknown): string {
  if (e instanceof TeslaError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export function isTemporary(e: unknown): boolean {
  return e instanceof TeslaError && e.temporary
}
