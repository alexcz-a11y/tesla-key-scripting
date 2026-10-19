// Tesla 钥匙主界面（M5，G「色块版面」）：主页 → 全部功能 / 钥匙与设置 → 调试日志
import { Navigation, NavigationDestination, NavigationStack, Script, useEffect, useObservable, VirtualNode, ZStack } from "scripting"
import { HomePage } from "./ui/home"
import { ControlsPage } from "./ui/controls"
import { KeysPage } from "./ui/keys"
import { DebugPage } from "./ui/debug"
import { autoConnect, disconnect, getState, handleRemote, reloadKeyInfo } from "./ui/store"
import { ST_MAIN_SESSION } from "./core/widget_cmds"
import { loadConfig } from "./core/keystore"
import { setLogEnabled } from "./core/log"

type Page = "controls" | "keys" | "debug"

const HIDE_BAR: { visibility: "hidden"; bars: "navigationBar"[] } = { visibility: "hidden", bars: ["navigationBar"] }

function App(): VirtualNode {
  const path = useObservable<string[]>([])
  const push = (p: Page): void => path.setValue([...path.value, p])
  const pop = (): void => path.setValue(path.value.slice(0, -1))
  const s = getState()

  useEffect(() => {
    reloadKeyInfo()
    if (s.hasKey) autoConnect()
  }, [])

  // 自定义组件不接收视图修饰器，所以每页外面套一层 ZStack 来隐藏系统导航栏
  return <NavigationStack path={path} statusBarHidden>
    <ZStack
      toolbarVisibility={HIDE_BAR}
      navigationDestination={
        <NavigationDestination>
          {(page: string) => {
            if (page === "controls") return <ZStack toolbarVisibility={HIDE_BAR}><ControlsPage onBack={pop} onKeys={() => push("keys")} /></ZStack>
            if (page === "keys") return <ZStack toolbarVisibility={HIDE_BAR}><KeysPage onBack={pop} onDebug={() => push("debug")} /></ZStack>
            return <DebugPage />
          }}
        </NavigationDestination>
      }
    >
      <HomePage onAll={() => push("controls")} onKeys={() => push("keys")} />
    </ZStack>
  </NavigationStack>
}

async function main(): Promise<void> {
  // 按 status_bar 文档：全屏呈现，statusBarHidden 才生效。退出：轻点左上连接块 →「退出」
  // 主界面运行期间接收小组件的指令（ScriptSession：只能由 index 注册，主脚本关闭后失效）
  // script/api 文档：务必调用 Script.exit() 释放资源，所以放在 finally 里，前面任何一步出错都会退出
  let sessionId: string | null = null
  try {
    setLogEnabled(loadConfig().debugLog)
    sessionId = ScriptSession.register(async (message: ScriptSession.Value) => {
      const cmd: unknown = message && typeof message === "object" && !Array.isArray(message) ? message.command : null
      return await handleRemote(cmd)
    })
    Storage.set(ST_MAIN_SESSION, sessionId)
    await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" })
  } catch (e: any) {
    console.error("[main] 出错: " + String(e?.message ?? e))
  } finally {
    try {
      if (sessionId) {
        ScriptSession.unregister(sessionId)
        if (Storage.get<string>(ST_MAIN_SESSION) === sessionId) Storage.remove(ST_MAIN_SESSION)
      }
      await disconnect()
    } catch (_e) {
      // 退出前的清理失败不影响退出
    }
    Script.exit()
  }
}

void main()
