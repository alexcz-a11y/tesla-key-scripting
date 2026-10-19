import { Script } from "scripting"
import protobuf from "protobufjs"
import * as fs from "node:fs"

// 一次性工具：把 proto/*.proto 预编译成 JSON 描述符模块 core/proto_desc.ts
// 运行：scripting-ts run "<脚本目录>/tests/gen_proto.ts"
const ROOT_DIR: string = Script.directory.replace(/\/tests\/?$/, "")
const FILES: string[] = ["signatures", "keys", "errors", "common", "managed_charging", "vehicle", "vcsec", "universal_message", "car_server"]

function main(): string {
  const dir: string = fs.existsSync(ROOT_DIR + "/proto") ? ROOT_DIR : Script.directory
  const root = new protobuf.Root()
  protobuf.parse('syntax = "proto3"; package google.protobuf; message Timestamp { int64 seconds = 1; int32 nanos = 2; }', root, { keepCase: true })
  for (const f of FILES) {
    protobuf.parse(fs.readFileSync(`${dir}/proto/${f}.proto`, "utf8"), root, { keepCase: true })
  }
  root.resolveAll()
  const json: string = JSON.stringify(root.toJSON({ keepComments: false }))
  const out: string = `// 自动生成：tests/gen_proto.ts。不要手动编辑。\n// 来源：teslamotors/vehicle-command pkg/protocol/protobuf\nexport const PROTO_DESC: any = ${json}\n`
  fs.writeFileSync(`${dir}/core/proto_desc.ts`, out, "utf8")
  return `ok bytes=${out.length} dir=${dir}`
}

try { Script.exit(main()) } catch (e: any) { Script.exit("ERR " + String(e) + "\n" + (e?.stack ?? "")) }
