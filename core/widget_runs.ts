// 小组件指令的运行记录：小组件在桌面运行时连不到开发服务器，所以把每次点按的步骤、结果和协议日志存进 Storage，
// 之后在「钥匙与设置 → 调试日志」里查看和拷贝。只依赖 Storage，不引入协议代码（小组件也会加载本文件）

export const ST_WIDGET_RUNS: string = "tesla_key.widget.runs.v1"
const MAX_RUNS: number = 5
const MAX_LOGS: number = 200

export interface WidgetResult {
  at: number
  ok: boolean
  /** main = 交给主脚本；direct = 本环境直连 */
  route: "main" | "direct" | "none"
  ms: number
  error?: string
  /** 主脚本那一步没成功的原因（之后改走直连时） */
  mainError?: string
  /** 主脚本自己执行指令用的毫秒数（总用时减去它≈消息传递时间） */
  mainMs?: number
}

export interface WidgetRun {
  id: number
  cmd: string
  start: number
  /** 本环境可用的全局 API，用来确认文档没写的部分 */
  env: Record<string, boolean>
  steps: { t: number; step: string }[]
  result?: WidgetResult
  logs: string[]
}

export function loadRuns(): WidgetRun[] {
  try {
    return Storage.get<WidgetRun[]>(ST_WIDGET_RUNS) ?? []
  } catch (_e) {
    return []
  }
}

/** 按 id 覆盖保存，只留最近几次 */
export function saveRun(run: WidgetRun): void {
  try {
    const runs: WidgetRun[] = loadRuns().filter((r: WidgetRun) => r.id !== run.id)
    runs.push({ ...run, logs: run.logs.slice(-MAX_LOGS) })
    Storage.set(ST_WIDGET_RUNS, runs.slice(-MAX_RUNS))
  } catch (_e) {
    // 记录失败不影响指令
  }
}

export function clearRuns(): void {
  Storage.remove(ST_WIDGET_RUNS)
}

function clock(t: number): string {
  const d: Date = new Date(t)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

/** 调试页显示 / 拷贝用的文本 */
export function formatRuns(runs: WidgetRun[]): string[] {
  if (runs.length === 0) return ["（还没有小组件运行记录）"]
  const out: string[] = []
  for (const r of runs) {
    const res: WidgetResult | undefined = r.result
    const head: string = res
      ? `${res.ok ? "成功" : "失败"} · ${res.route === "main" ? "主脚本" : res.route === "direct" ? "直连" : "—"} · ${res.ms} ms${res.mainMs != null ? `（主脚本 ${res.mainMs} ms）` : ""}`
      : `没有结果：停在「${r.steps[r.steps.length - 1]?.step ?? "?"}」（被系统中止或仍在运行）`
    out.push(`== 小组件 ${r.cmd} · ${clock(r.start)} · ${head}`)
    out.push(`  环境：${Object.entries(r.env).map(([k, v]) => `${k}=${v ? "有" : "无"}`).join(" ")}`)
    if (res?.mainError) out.push(`  主脚本：${res.mainError}`)
    if (res?.error) out.push(`  错误：${res.error}`)
    r.steps.forEach((s) => out.push(`  +${s.t} ms ${s.step}`))
    r.logs.forEach((l: string) => out.push("    " + l))
  }
  return out
}
