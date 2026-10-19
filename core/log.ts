// 调试日志：环形缓冲 + 订阅（UI 的调试页实时显示 TX/RX）

export interface LogEntry {
  t: number
  level: "info" | "warn" | "error" | "tx" | "rx"
  msg: string
}

const MAX: number = 400
const entries: LogEntry[] = []
const listeners: Set<(e: LogEntry) => void> = new Set()
/** 是否同时写进 Scripting 控制台（配置 debugLog，默认关）；App 内调试页和小组件运行记录始终能看到 */
let toConsole: boolean = false

export function setLogEnabled(v: boolean): void {
  toConsole = v
}

function push(level: LogEntry["level"], msg: string): void {
  const e: LogEntry = { t: Date.now(), level, msg }
  entries.push(e)
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
  for (const l of listeners) {
    try {
      l(e)
    } catch (_err) {
      // 忽略监听器异常
    }
  }
  if (!toConsole) return
  const line: string = `[${level}] ${msg}`
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

export const log = {
  info: (m: string): void => push("info", m),
  warn: (m: string): void => push("warn", m),
  error: (m: string): void => push("error", m),
  tx: (m: string): void => push("tx", m),
  rx: (m: string): void => push("rx", m),
}

export function getLogs(): LogEntry[] {
  return entries.slice()
}

export function clearLogs(): void {
  entries.length = 0
}

export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
