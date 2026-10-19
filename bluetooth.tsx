// 后台蓝牙任务（BluetoothBackground）测试版：只观察，不向车辆发送任何指令
// 目的：确认后台任务实际能收到哪些事件、后台环境里有哪些 API（文档没写 Storage / crypto.subtle / Widget 是否可用）
// 结果同时写 checkpoint、Keychain、Storage；调试页读 Keychain 和 Storage，哪边有数据就说明哪边可用
const KC_PROBE: string = "tesla_key.bg_probe.v1"
const ST_PROBE: string = "tesla_key.bg_probe.v1"

interface Probe {
  firstAt: number
  lastAt: number
  counts: Record<string, number>
  last: { type: string; sequence: number; peripheralId: string | null; valueLen?: number; error?: string }
  env: Record<string, boolean>
}

function env(): Record<string, boolean> {
  const g: any = globalThis as any
  return {
    storage: typeof g.Storage !== "undefined",
    keychain: typeof g.Keychain !== "undefined",
    subtle: typeof g.crypto?.subtle?.encrypt === "function",
    widget: typeof g.Widget?.reloadAll === "function",
    scriptSession: typeof g.ScriptSession !== "undefined",
  }
}

BluetoothBackground.handleEvents(async (event: BluetoothBackgroundEvent, context: BluetoothBackgroundContext) => {
  const prev = (await context.checkpoint.read()) as Probe | null
  const now: number = Date.now()
  const counts: Record<string, number> = { ...(prev?.counts ?? {}) }
  counts[event.type] = (counts[event.type] ?? 0) + 1
  const next: Probe = {
    firstAt: prev?.firstAt ?? now,
    lastAt: now,
    counts,
    last: {
      type: event.type,
      sequence: event.sequence,
      peripheralId: event.peripheralId,
      valueLen: event.value ? event.value.toUint8Array()?.length : undefined,
      error: event.error ? `${event.error.code}: ${event.error.message}` : undefined,
    },
    env: env(),
  }
  await context.checkpoint.write(next)
  const json: string = JSON.stringify(next)
  try {
    Keychain.set(KC_PROBE, json, { accessibility: "first_unlock_this_device" })
  } catch (_e) {
    // 记录在 env 里即可
  }
  try {
    Storage.set(ST_PROBE, json)
  } catch (_e) {
    // 同上
  }
})
