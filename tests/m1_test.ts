// 命令行入口：scripting-ts run "<脚本目录>/tests/m1_test.ts"
import { Script } from "scripting"
import { runM1 } from "./m1"

runM1().then((r: string) => Script.exit(r)).catch((e: any) => Script.exit("ERR " + String(e) + "\n" + (e?.stack ?? "")))
