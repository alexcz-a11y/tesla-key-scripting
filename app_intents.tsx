// 小组件按钮触发的 AppIntent（运行环境 Script.env = "app_intents"）
// 一个 AppIntent 带参数 cmd（core/widget_cmds 的 WidgetCommand）：解锁、上锁、弹开车门、前后备箱、充电口。依次尝试两条路径：
//   1. 主脚本：Tesla Key 主界面正在运行时，通过 ScriptSession 交给它执行（复用已建立的蓝牙连接）
//   2. 直连：主脚本没在运行时，在本环境里自己连接车辆执行（文档没写这个环境能否用蓝牙，所以先检测）
// 不走后台蓝牙任务：文档里没有让 AppIntent 触发它的方式
// 每次运行的步骤、结果和协议日志都存进 Storage（core/widget_runs.ts），在「钥匙与设置 → 调试日志」里查看
// 注意：widget.tsx 要导入本文件，所以这里不能静态导入协议代码（protobufjs、协议描述、加密库）。
// 小组件进程只有约 30 MB 内存（widget 文档：超限时小组件显示空白）。2026-10-17 静态导入时桌面小组件一直空白、App 内预览正常，推断就是这个原因。
// 协议代码在 perform 里按需加载，只在点按钮时才进内存
import { AppIntentManager, AppIntentProtocol, Widget } from "scripting"
import { LogEntry, onLog } from "./core/log"
import { COMMAND_ZH, isWidgetCommand, ST_MAIN_SESSION, WidgetCommand } from "./core/widget_cmds"
import { saveRun, WidgetResult, WidgetRun } from "./core/widget_runs"

function probeEnv(): Record<string, boolean> {
  const g: any = globalThis as any
  return {
    bluetooth: typeof g.BluetoothCentralManager !== "undefined",
    scriptSession: typeof g.ScriptSession !== "undefined",
    subtle: typeof g.crypto?.subtle?.encrypt === "function",
    keychain: typeof g.Keychain !== "undefined",
  }
}

function errText(e: any): string {
  return String(e?.code ? `${e.code}: ` : "") + String(e?.message ?? e)
}

function fmtLog(e: LogEntry): string {
  return `[+${e.t % 100000} ${e.level}] ${e.msg.length > 300 ? e.msg.slice(0, 300) + "…" : e.msg}`
}

/**
 * 主脚本不在、或没接下这个请求时才改走直连（script_session 文档：已接受的工作不会撤销，挂起期间过期的排队命令会被丢弃）：
 * 会话不存在 / 已关闭 / 不可用 / 处理器无效 / 超时（主脚本被挂起，命令被丢弃）。
 * 主脚本正忙（BUSY，占着蓝牙）或处理器执行出错时不改走直连，直接报错，避免同一条指令发两次、两条连接抢车
 */
const FALLBACK_CODES: string[] = [
  "SCRIPT_SESSION_UNAVAILABLE", "SCRIPT_SESSION_NOT_FOUND", "SCRIPT_SESSION_CLOSED", "SCRIPT_SESSION_INVALID_HANDLER", "SCRIPT_SESSION_TIMEOUT",
]

/** 交给主脚本执行：成功返回 null；主脚本不可用时返回原因（调用方改走直连）；主脚本执行失败则抛出 */
async function viaMain(cmd: WidgetCommand, onMainMs: (ms: number) => void): Promise<string | null> {
  const id: string | null = Storage.get<string>(ST_MAIN_SESSION)
  if (!id) return "主脚本没有在运行"
  try {
    const reply = await ScriptSession.request<{ ok: boolean; error?: string; ms?: number }>(id, { command: cmd }, { timeout: 30000 })
    if (typeof reply?.ms === "number") onMainMs(reply.ms)
    if (reply?.ok) return null
    throw new Error(reply?.error ?? "主脚本没有完成")
  } catch (e: any) {
    // 主脚本不在 / 被挂起：改走直连。万一主脚本其实执行过，开合类指令按当前状态决定发不发，重复一次也安全
    if (typeof e?.code === "string" && FALLBACK_CODES.includes(e.code)) return errText(e)
    throw e
  }
}

export const CommandIntent = AppIntentManager.register<{ cmd: WidgetCommand }>({
  name: "TeslaKeyCommandIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (params: { cmd: WidgetCommand }) => {
    const cmd: unknown = params?.cmd
    if (!isWidgetCommand(cmd)) return
    const t0: number = Date.now()
    const run: WidgetRun = { id: t0, cmd, start: t0, env: probeEnv(), steps: [], logs: [] }
    // 每一步都保存：被系统中途终止时，记录里能看出停在哪一步
    const step = (name: string): void => {
      run.steps.push({ t: Date.now() - t0, step: name })
      saveRun(run)
    }
    // 协议日志也记下来；最多每秒存一次，避免频繁写存储
    let savedAt: number = 0
    const offLog = onLog((e: LogEntry) => {
      run.logs.push(fmtLog(e))
      if (Date.now() - savedAt > 1000) {
        savedAt = Date.now()
        saveRun(run)
      }
    })
    let mainError: string | undefined
    let mainMs: number | undefined
    step("开始 " + COMMAND_ZH[cmd])
    // 先刷新一次，小组件立刻显示「进行中」
    Widget.reloadAll()
    let res: WidgetResult
    try {
      step("交给主脚本")
      const skipped: string | null = await viaMain(cmd, (ms: number) => {
        mainMs = ms
      })
      if (skipped == null) {
        res = { at: Date.now(), ok: true, route: "main", ms: Date.now() - t0, mainMs }
      } else {
        mainError = skipped
        if (!run.env.bluetooth) throw new Error("这个环境不能使用蓝牙，请先打开 Tesla Key 主界面")
        // 2026-10-18 实测：这个环境加载 npm 包（@noble/curves、protobufjs）时进程会被终止，自写的小模块可以。
        // client/quick 只依赖轻量模块（core/pb_lite 编解码、钥匙串里缓存的会话密钥），不含 npm 包
        step("加载协议代码")
        const { quickCommand } = await import("./client/quick")
        await quickCommand(cmd, step)
        res = { at: Date.now(), ok: true, route: "direct", ms: Date.now() - t0, mainError }
      }
    } catch (e: any) {
      res = { at: Date.now(), ok: false, route: mainError ? "direct" : "main", ms: Date.now() - t0, error: errText(e), mainError, mainMs }
    }
    offLog()
    run.result = res
    step(res.ok ? "完成" : "失败")
    Widget.reloadAll()
  },
})
