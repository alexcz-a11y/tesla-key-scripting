// Protobuf：从预编译描述符加载官方 .proto（keepCase，字段名与 .proto 一致）
import protobuf from "protobufjs"
import { PROTO_DESC } from "./proto_desc"

const root: protobuf.Root = protobuf.Root.fromJSON(PROTO_DESC)

function T(name: string): protobuf.Type {
  return root.lookupType(name)
}

export const Types = {
  RoutableMessage: T("UniversalMessage.RoutableMessage"),
  SessionInfo: T("Signatures.SessionInfo"),
  ToVCSECMessage: T("VCSEC.ToVCSECMessage"),
  UnsignedMessage: T("VCSEC.UnsignedMessage"),
  FromVCSECMessage: T("VCSEC.FromVCSECMessage"),
  CarServerAction: T("CarServer.Action"),
  CarServerResponse: T("CarServer.Response"),
}

// 枚举常量放在 proto_consts.ts（不依赖 protobufjs，小组件的轻量路径也要用），这里原样转出
export {
  ClosureMove, ClosureState, Domain, FLAG_ENCRYPT_RESPONSE, InfoRequest, KeyFormFactor, KeyRole, LockState,
  MessageFault, RKEAction, SleepStatus, UserPresence, VcsecOpStatus,
} from "./proto_consts"
export type { DomainId } from "./proto_consts"

const TO_OBJECT_OPTS: protobuf.IConversionOptions = {
  enums: Number,
  longs: Number,
  defaults: false,
  arrays: true,
  oneofs: true,
}

export function encode(type: protobuf.Type, obj: Record<string, any>): Uint8Array {
  const err: string | null = type.verify(obj)
  if (err) throw new Error(`${type.name} 编码参数错误: ${err}`)
  return type.encode(type.fromObject(obj)).finish()
}

export function decode<R = any>(type: protobuf.Type, bytes: Uint8Array): R {
  return type.toObject(type.decode(bytes), TO_OBJECT_OPTS) as R
}

/** 调试用：带枚举名的 JSON */
export function debugJSON(type: protobuf.Type, bytes: Uint8Array): string {
  try {
    const o: any = type.toObject(type.decode(bytes), { enums: String, longs: Number, bytes: String, defaults: false, oneofs: false })
    return JSON.stringify(o)
  } catch (e: any) {
    return `<decode error: ${String(e?.message ?? e)}>`
  }
}

/** 枚举值 → 名称 */
export function enumName(path: string, value: number | undefined | null): string {
  if (value == null) return "-"
  try {
    const e: protobuf.Enum = root.lookupEnum(path)
    return e.valuesById[value] ?? String(value)
  } catch (_e) {
    return String(value)
  }
}

