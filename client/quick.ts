// 小组件 / 控制中心的快速指令：不依赖界面状态，自己连接车辆，执行一条 VCSEC 指令后断开
// 小组件路径可能在主脚本已执行后再直连执行一次，所以每条指令都要能重复执行：
// 前后备箱的 MOVE 是开 / 关切换，按指令前读到的状态决定发不发（core/widget_cmds 的 closureRequest）
// 小组件进程加载不了 npm 包（protobufjs、@noble/curves），这里只能用轻量模块：
// 编解码用 core/pb_lite，会话密钥 K 读主界面缓存在钥匙串里的那份（core/keys_lite 的 cachedSessionKeys），不做 P-256 运算
import { sleep, unhex } from "../core/bytes"
import { TeslaError } from "../core/errors"
import { cachedSessionKey, cachedSessionKeys, loadConfig, loadSessions, noCachedKey, saveConfig, SessionCacheData, VehicleConfig } from "../core/keys_lite"
import { log } from "../core/log"
import { Domain, RKEAction } from "../core/proto_consts"
import { SessionKeys } from "../core/session"
import { BleTransport } from "../core/transport_ble"
import { Dispatcher } from "./dispatcher"
import { VcsecClient, VehicleStatus } from "./vcsec"
import { closureRequest, COMMAND_ZH, isDoorCommand, SETTLE_INTERVAL_MS, SETTLE_TIMEOUT_MS, targetReached, WidgetCommand } from "../core/widget_cmds"

export type QuickCommand = WidgetCommand

/** 与 ui/store.ts 的 ST_SNAPSHOT 相同；这里不导入 store，避免把界面代码加载进小组件 */
const ST_SNAPSHOT: string = "tesla_key.snapshot.v1"

/** onStep：每走一步报告一次，调用方记下来，用来判断被系统中止时停在哪里；transport 供测试注入假车辆 */
export async function quickCommand(cmd: QuickCommand, onStep?: (s: string) => void, transport?: BleTransport): Promise<void> {
  const config: VehicleConfig = loadConfig()
  if (!config.paired) throw new TeslaError("NOT_PAIRED", "还没有完成配对，请先在 Tesla Key 主界面配对", false)
  // 先确认有缓存的 K，不然连上车也签不了名
  const keys: SessionKeys | null = cachedSessionKeys()
  if (!keys) throw noCachedKey()
  const cached: SessionCacheData | undefined = loadSessions()[String(Domain.VCSEC)]
  if (!cached || !cachedSessionKey(keys.localPublic, unhex(cached.vehiclePublicKey))) throw noCachedKey()

  const t: BleTransport = transport ?? new BleTransport()
  let d: Dispatcher | null = null
  try {
    onStep?.("扫描并连接车辆")
    const id: string = await t.connect(config.localName, config.peripheralId)
    if (id !== config.peripheralId) {
      // 重新读一次再写，尽量不覆盖主界面同时改过的配置
      const c: VehicleConfig = loadConfig()
      c.peripheralId = id
      saveConfig(c)
    }
    d = new Dispatcher(t, config.vin, keys)
    const v: VcsecClient = new VcsecClient(d)
    // 先读一次状态：记进日志（看车当时是不是在睡，指令本身会叫醒 VCSEC），切换类指令还要靠它判断要不要发
    onStep?.("读取指令前状态")
    let pre: VehicleStatus | null = null
    try {
      pre = await v.status()
      log.info(`指令前状态 sleep=${pre.vehicleSleepStatus ?? 0} lock=${pre.vehicleLockState ?? 0} presence=${pre.userPresence ?? 0}`)
    } catch (e: any) {
      log.warn("指令前读取状态失败: " + String(e?.message ?? e))
    }
    onStep?.("发送" + COMMAND_ZH[cmd])
    if (cmd === "unlock" || cmd === "lock") {
      await v.rke(cmd === "unlock" ? RKEAction.UNLOCK : RKEAction.LOCK)
    } else {
      if (!pre && (cmd === "frunk_open" || cmd === "trunk_open")) {
        throw new TeslaError("NO_STATUS", "读不到车辆状态，没有发送（这条指令是开 / 关切换，不确定状态时不发）", true)
      }
      const req: Record<string, number> | null = closureRequest(cmd, pre?.closureStatuses as Record<string, number | undefined> | undefined)
      if (req) await v.closure(req)
      else log.info(`${COMMAND_ZH[cmd]}：已经是目标状态，不发送`)
    }
    // 读车身状态（不需要认证、不唤醒车机）存成快照，小组件显示用；读不到不影响指令结果。
    // 指令回复时门 / 尾门往往还没动完（尾门开合要好几秒，2026-10-18 实测只读一次会存下旧状态），
    // 所以每 1.5 秒读一次，直到到达目标状态或超时，存最后一次读到的
    onStep?.("等待车辆到位")
    try {
      const t0: number = Date.now()
      let status: VehicleStatus = await v.status()
      while (!targetReached(cmd, status as any) && Date.now() - t0 < SETTLE_TIMEOUT_MS) {
        await sleep(SETTLE_INTERVAL_MS)
        status = await v.status()
      }
      log.info(`${COMMAND_ZH[cmd]}：${targetReached(cmd, status as any) ? "已到位" : "超时未到位"}，用时 ${Date.now() - t0} ms`)
      const prev = Storage.get<{ selective?: boolean }>(ST_SNAPSHOT)
      // 与 ui/store 一致：整车上锁时弹开单门，车辆报 UNLOCKED 但其余门仍锁着；解锁 / 上锁、车辆重新报上锁时清掉
      const locked: boolean = (status.vehicleLockState ?? 0) === 1
      const selective: boolean = cmd === "unlock" || cmd === "lock" || locked ? false
        : isDoorCommand(cmd) && (pre?.vehicleLockState ?? 0) === 1 ? true
        : prev?.selective === true
      Storage.set(ST_SNAPSHOT, { status, at: Date.now(), selective })
    } catch (e: any) {
      log.warn("指令后读取状态失败: " + String(e?.message ?? e))
    }
  } finally {
    onStep?.("断开")
    d?.dispose()
    await t.disconnect()
  }
}
