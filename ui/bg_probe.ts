// 后台蓝牙任务（BluetoothBackground）测试：注册 / 查看 / 注销，以及读取 bluetooth.tsx 写下的观察结果
// 测试任务只观察事件，不发送指令；注册后系统会在后台一直维持与车辆的连接（占用车端 3 个连接位中的一个）
import { loadConfig } from "../core/keystore"
import { TESLA_RX_CHAR, TESLA_SERVICE } from "../core/transport_ble"

export const BG_TASK_ID: string = "tesla_key.probe"
const PROBE_KEY: string = "tesla_key.bg_probe.v1"

type Out = (s: string) => void

export async function bgCapabilities(out: Out): Promise<void> {
  const c: BluetoothBackgroundCapabilities = await BluetoothBackground.getCapabilities()
  out(`supported=${c.supported} authorization=${c.authorization} restoration=${c.restoration} accessorySetup=${c.accessorySetup}`)
  out("limitations:")
  c.limitations.forEach((l: string) => out("  · " + l))
}

export async function bgRegister(out: Out): Promise<void> {
  const ok: boolean = await Dialog.confirm({
    title: "注册后台蓝牙测试任务",
    message: "注册后系统会在后台一直维持与车辆的蓝牙连接（占用车上 3 个连接位中的一个），测试任务只记录收到的事件，不发送任何指令。用完请注销。",
    confirmLabel: "注册",
  })
  if (!ok) return
  const cfg = loadConfig()
  const info: BluetoothBackgroundTaskInfo = await BluetoothBackground.register({
    id: BG_TASK_ID,
    target: { serviceUUIDs: [TESLA_SERVICE], localName: cfg.localName, peripheralId: cfg.peripheralId },
    subscriptions: [{ serviceUUID: TESLA_SERVICE, characteristicUUID: TESLA_RX_CHAR }],
  })
  out("已注册：" + JSON.stringify(info))
}

export async function bgStatus(out: Out): Promise<void> {
  const info: BluetoothBackgroundTaskInfo | null = await BluetoothBackground.get(BG_TASK_ID)
  out("任务：" + (info ? JSON.stringify(info) : "没有注册"))
  // 两个渠道各读一次：哪边有数据，说明后台环境里哪个 API 可用
  let kc: string | null = null
  let st: string | null = null
  try {
    kc = Keychain.get(PROBE_KEY)
  } catch (e: any) {
    out("读 Keychain 出错：" + String(e?.message ?? e))
  }
  try {
    st = Storage.get<string>(PROBE_KEY)
  } catch (e: any) {
    out("读 Storage 出错：" + String(e?.message ?? e))
  }
  out("后台写入的 Keychain：" + (kc ?? "无"))
  out("后台写入的 Storage：" + (st ?? "无"))
}

export async function bgUnregister(out: Out): Promise<void> {
  await BluetoothBackground.unregister(BG_TASK_ID)
  try {
    Keychain.remove(PROBE_KEY)
    Storage.remove(PROBE_KEY)
  } catch (_e) {
    // 清理失败不影响注销
  }
  out("已注销测试任务")
}
