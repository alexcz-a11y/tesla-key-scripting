// 在 Mac 上用 Node 跑小组件指令测试：npx tsx tests/widget_cmds_node.ts（这些函数不依赖 Scripting 的全局对象）
import { runWidgetCmds } from "./widget_cmds"

runWidgetCmds().then((r: string) => {
  console.log(r)
  process.exit(r.includes("❌") ? 1 : 0)
})
