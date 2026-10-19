// 调试页（原 M0–M4 测试页）：协议自测、扫描探测、逐条指令、协议日志与一键拷贝。从「钥匙与设置 → 调试日志」进入
import { Button, List, Section, Text, Toggle, useEffect, useState, VirtualNode } from "scripting"
import { hex } from "../core/bytes"
import { createPrivateKey, getPublicKey, getPublicKeyId, hasPrivateKey, loadConfig, VehicleConfig } from "../core/keystore"
import { getLogs, LogEntry, onLog } from "../core/log"
import { ClosureMove, Domain } from "../core/proto"
import { describeKey, describeStatus, DOORS, DoorKey } from "../client/vehicle"
import { client, getState, onPush, reloadKeyInfo, subscribe } from "./store"
import { pairKey } from "../client/pairing"
import { runM1 } from "../tests/m1"
import { runWidgetCmds } from "../tests/widget_cmds"
import { clearRuns, formatRuns, loadRuns } from "../core/widget_runs"

const MAX_LINES: number = 400

function fmtLog(e: LogEntry): string {
  const d: Date = new Date(e.t)
  const ts: string = `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
  return `  [${ts} ${e.level}] ${e.msg}`
}

export function DebugPage(): VirtualNode {
  const cfg: VehicleConfig = loadConfig()
  // 最上面是小组件运行记录（存在 Storage，重开 App 不丢）；下面是本次启动以来的协议日志（只在内存，重开 App 清空）
  const [lines, setLines] = useState<string[]>(() => [
    "—— 小组件运行记录（最近 5 次，重开 App 不清空）——",
    ...formatRuns(loadRuns()),
    "—— 本次启动的协议日志（重开 App 会清空）——",
    ...getLogs().map(fmtLog),
  ])
  const [busy, setBusy] = useState<string | null>(null)
  const [connected, setConnected] = useState<boolean>(client.connected)
  const [keyId, setKeyId] = useState<string | null>(null)
  const [showProto, setShowProto] = useState<boolean>(true)

  const append = (s: string): void => {
    setLines((prev: string[]) => {
      const next: string[] = [...prev, ...s.split("\n")]
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  }

  useEffect(() => {
    void getPublicKeyId().then((id: string | null) => setKeyId(id))
    const offPush = onPush((st) => {
      append("车辆推送状态：")
      describeStatus(st).forEach((l: string) => append("  " + l))
    })
    let last = getState().conn
    const offState = subscribe(() => {
      const st = getState()
      setConnected(st.conn === "connected")
      if (st.conn !== last) {
        last = st.conn
        append(`连接状态：${st.conn}${st.connErr ? "（" + st.connErr + "）" : ""}`)
      }
    })
    return () => {
      offPush()
      offState()
    }
  }, [])

  useEffect(() => {
    if (!showProto) return
    return onLog((e: LogEntry) => append(fmtLog(e)))
  }, [showProto])

  const run = async (name: string, job: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(name)
    append(`—— ${name} ——`)
    const t0: number = Date.now()
    try {
      await job()
      append(`（${Date.now() - t0} ms）`)
    } catch (e: any) {
      const msg: string = `ERR ${e?.code ? "[" + e.code + "] " : ""}${String(e?.message ?? e)}${e?.possibleSuccess ? "（指令可能已执行）" : ""}`
      append(msg + (e?.code ? "" : e?.stack ? "\n" + e.stack : ""))
    } finally {
      setConnected(client.connected)
      setBusy(null)
      reloadKeyInfo()
    }
  }

  const testM1 = () => run("M1 协议测试", async () => append(await runM1()))
  const testWidgetCmds = () => run("小组件指令测试", async () => append(await runWidgetCmds()))

  const connect = () => run("连接车辆", async () => {
    await client.connect()
    append(`已连接 peripheral=${client.config.peripheralId} state=${client.transport.state} isConnected=${client.transport.peripheral?.isConnected}`)
  })
  const status = () => run("读取车辆状态", async () => {
    describeStatus(await client.status()).forEach(append)
  })
  const genKey = () => run("生成钥匙", async () => {
    if (hasPrivateKey()) {
      const ok: boolean = await Dialog.confirm({ message: "已经有钥匙了。重新生成会让旧钥匙失效（车上需删除旧钥匙），确定？" })
      if (!ok) return
    }
    createPrivateKey()
    if (client.connected) client.reloadKey()
    const id: string | null = await getPublicKeyId()
    setKeyId(id)
    append(`新钥匙 keyId=${id}`)
    append(`公钥 ${hex(getPublicKey())}`)
  })
  const keyStatus = () => run("查询本机钥匙状态（VCSEC）", async () => {
    const info = await client.keyStatus(Domain.VCSEC)
    append(info.status === 1 ? "钥匙未在白名单（还没配对）" : `钥匙已在白名单 counter=${info.counter ?? 0} clock=${info.clock_time ?? 0}`)
  })
  const listKeys = () => run("读取钥匙列表", async () => {
    const keys = await client.listKeys()
    append(`共 ${keys.length} 把`)
    const mine: Uint8Array | null = getPublicKey()
    keys.forEach((k) => append(describeKey(k, mine)))
  })
  const pair = () => run("配对（车主）", async () => {
    const pub: Uint8Array | null = getPublicKey()
    if (!pub) throw new Error("请先生成钥匙")
    const ok: boolean = await Dialog.confirm({
      title: "配对新钥匙",
      message: "请确认：人在车里、钥匙卡在手边。点确定后发送配对请求，然后在中控刷卡，并在车机屏幕上确认。最多等待 2 分钟。",
    })
    if (!ok) return
    await pairKey(client, pub, { onProgress: append })
  })
  const verify = () => run("验证会话（VCSEC + 车机握手）", async () => {
    client.reloadKey()
    const s = await client.d.startSession(Domain.VCSEC)
    append(`VCSEC 握手成功 counter=${s.counter} 车辆时钟=${s.vehicleClock()}`)
    const s3 = await client.d.startSession(Domain.INFOTAINMENT)
    append(`车机（Infotainment）握手成功 counter=${s3.counter} 车辆时钟=${s3.vehicleClock()}`)
  })
  /** 执行指令后读一次状态，确认结果 */
  const cmd = (name: string, job: () => Promise<void>) => run(name, async () => {
    await job()
    append("车辆已确认执行")
    describeStatus(await client.status()).forEach(append)
  })
  const unlock = () => cmd("解锁", () => client.unlock())
  const lock = () => cmd("上锁", () => client.lock())
  const wake = () => cmd("唤醒", () => client.wake())
  const trunk = () => cmd("后备箱（开/关）", () => client.openTrunk())
  const frunk = async () => {
    const ok: boolean = await Dialog.confirm({ message: "确定打开前备箱？前备箱需要手动按下关闭。" })
    if (ok) await cmd("开前备箱", () => client.openFrunk())
  }
  const door = async (key: DoorKey, zh: string, move: number) => {
    const name: string = `${zh} ${move === ClosureMove.OPEN ? "OPEN" : "MOVE"}`
    const ok: boolean = await Dialog.confirm({ message: `单门实验：${name}。门可能直接弹开，确认周围安全？` })
    if (ok) await cmd(name, () => client.door(key, move))
  }
  const disconnect = () => run("断开", async () => {
    await client.disconnect()
  })

  const copyAll = async (): Promise<void> => {
    const header: string = `Tesla Key 测试 · ${new Date().toISOString()} · VIN ${cfg.vin} · keyId ${keyId ?? "-"}`
    await Pasteboard.setString([header, ...lines].join("\n"))
    await Dialog.alert({ message: `已拷贝 ${lines.length} 行` })
  }

  const idle: boolean = busy == null
  return <List navigationTitle="调试日志" navigationBarTitleDisplayMode="inline" toolbarVisibility={{ visibility: "visible", bars: ["navigationBar"] }}>
    <Section header={<Text>车辆</Text>}>
      <Text>VIN {cfg.vin}</Text>
      <Text>广播名 {cfg.localName}</Text>
      <Text>本机钥匙 {keyId ?? "未生成"}　{connected ? "已连接" : "未连接"}</Text>
    </Section>
    <Section header={<Text>M2 通信（站在车旁）</Text>}>
      <Button title="连接车辆" systemImage="link" action={connect} disabled={!idle} />
      <Button title="读取车辆状态" systemImage="car" action={status} disabled={!idle} />
      <Button title="生成钥匙" systemImage="key" action={genKey} disabled={!idle} />
      <Button title="查询本机钥匙状态" systemImage="questionmark.key.filled" action={keyStatus} disabled={!idle} />
      <Button title="读取钥匙列表" systemImage="list.bullet" action={listKeys} disabled={!idle} />
      <Button title="断开" systemImage="xmark.circle" action={disconnect} disabled={!idle} />
    </Section>
    <Section header={<Text>M4 核心指令（需已配对）</Text>}>
      <Button title="解锁" systemImage="lock.open" action={unlock} disabled={!idle} />
      <Button title="上锁" systemImage="lock" action={lock} disabled={!idle} />
      <Button title="唤醒车机" systemImage="sun.max" action={wake} disabled={!idle} />
      <Button title="后备箱（开/关）" systemImage="car.rear" action={trunk} disabled={!idle} />
      <Button title="开前备箱" systemImage="car.front.waves.up" action={frunk} disabled={!idle} />
    </Section>
    <Section header={<Text>单门弹开</Text>} footer={<Text>2024 Model Y 实测：OPEN 四门有效；整车上锁时只弹开该门，其余门仍锁住。</Text>}>
      {DOORS.map((d) => <Button key={d.key + "o"} title={`${d.zh} · OPEN`} systemImage="door.left.hand.open" action={() => door(d.key, d.zh, ClosureMove.OPEN)} disabled={!idle} />)}
    </Section>
    <Section header={<Text>M3 配对（坐在车里，带钥匙卡）</Text>}>
      <Button title="发起配对（车主）" systemImage="key.radiowaves.forward" action={pair} disabled={!idle} />
      <Button title="验证会话（握手）" systemImage="checkmark.shield" action={verify} disabled={!idle} />
    </Section>
    <Section header={<Text>小组件运行记录</Text>} footer={<Text>桌面小组件连不到开发服务器，最近 5 次点按的步骤、结果和协议日志存在本机，在这里查看；「拷贝全部输出」会一起拷贝。</Text>}>
      <Button title="显示小组件记录" systemImage="rectangle.and.text.magnifyingglass" action={() => formatRuns(loadRuns()).forEach(append)} />
      <Button title="清空小组件记录" systemImage="trash" action={() => {
        clearRuns()
        append("已清空小组件记录")
      }} />
    </Section>
    <Section header={<Text>M0</Text>}>
      <Button title="M1 协议测试" systemImage="checkmark.seal" action={testM1} disabled={!idle} />
      <Button title="小组件指令测试" systemImage="checkmark.seal" action={testWidgetCmds} disabled={!idle} />
    </Section>
    <Section header={<Text>输出</Text>}>
      <Toggle title="显示协议日志（TX/RX）" value={showProto} onChanged={setShowProto} />
      <Button title="拷贝全部输出" systemImage="doc.on.doc" action={copyAll} disabled={lines.length === 0} />
      <Button title="清空输出" systemImage="trash" action={() => setLines([])} disabled={!idle} />
    </Section>
    <Section header={<Text>{busy ? `运行中：${busy}` : "输出"}</Text>}>
      {lines.length === 0
        ? <Text foregroundStyle="secondaryLabel">还没有输出</Text>
        : lines.map((l: string, i: number) => <Text key={i} font="caption" monospaced textSelection>{l}</Text>)}
    </Section>
  </List>
}
