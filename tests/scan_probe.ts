// M0 扫描探测：持续扫描车辆广播，记录 RSSI、可连接性、广播内容和采样间隔
// 用来回答：能不能扫到车、信号强度范围、广播里有没有服务 UUID
import { hex } from "../core/bytes"

export interface ScanProbeOptions {
  localName: string
  seconds: number
  onLine: (line: string) => void
}

export interface ScanProbeResult {
  samples: number
  others: number
  rssiMin: number | null
  rssiMax: number | null
  rssiAvg: number | null
  /** 相邻两次命中的最大间隔（秒），锁屏后扫描停住时会很大 */
  maxGapSec: number | null
  connectable: boolean | null
  serviceUUIDs: string[]
  summary: string
}

function fmtTime(ms: number): string {
  const d: Date = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export async function runScanProbe(opt: ScanProbeOptions): Promise<ScanProbeResult> {
  const say = (s: string): void => {
    console.log(s)
    opt.onLine(s)
  }
  const seen: Set<string> = new Set()
  const rssis: number[] = []
  const uuids: Set<string> = new Set()
  let connectable: boolean | null = null
  let lastHit: number = 0
  let maxGap: number = 0
  let lastPrint: number = 0
  let firstAdvPrinted: boolean = false

  say(`开始扫描 ${opt.seconds}s，目标广播名 ${opt.localName}`)
  const started: number = Date.now()
  try {
    await BluetoothCentralManager.startScan(
      (p: BluetoothPeripheral, adv: BluetoothAdvertisementData, rssi: number) => {
        const name: string = adv.localName ?? p.name ?? ""
        if (name !== opt.localName) {
          seen.add(p.id)
          return
        }
        const now: number = Date.now()
        if (lastHit) maxGap = Math.max(maxGap, (now - lastHit) / 1000)
        lastHit = now
        if (rssi !== 127) rssis.push(rssi)
        if (adv.isConnectable != null) connectable = adv.isConnectable
        for (const u of adv.serviceUUIDs ?? []) uuids.add(u.toUpperCase())
        for (const u of adv.overflowServiceUUIDs ?? []) uuids.add(u.toUpperCase() + "(overflow)")
        if (!firstAdvPrinted) {
          firstAdvPrinted = true
          say(`首次命中 id=${p.id}`)
          say(`  serviceUUIDs=${JSON.stringify(adv.serviceUUIDs ?? [])} overflow=${JSON.stringify(adv.overflowServiceUUIDs ?? [])}`)
          say(`  serviceData=${JSON.stringify(Object.keys(adv.serviceData ?? {}))} txPower=${adv.txPowerLevel ?? "-"}`)
          say(`  manufacturerData=${adv.manufacturerData ? hex(adv.manufacturerData.toUint8Array() ?? new Uint8Array(0)) : "-"}`)
        }
        // 每秒最多打印一行
        if (now - lastPrint >= 1000) {
          lastPrint = now
          say(`${fmtTime(now)} RSSI=${rssi} connectable=${adv.isConnectable}`)
        }
      },
      { allowDuplicates: true },
    )
    await new Promise<void>((r: () => void) => setTimeout(r, opt.seconds * 1000))
  } finally {
    try {
      await BluetoothCentralManager.stopScan()
    } catch (_e) {
      // ignore
    }
  }

  if (lastHit && Date.now() - lastHit > maxGap * 1000) maxGap = (Date.now() - lastHit) / 1000
  const n: number = rssis.length
  const res: ScanProbeResult = {
    samples: n,
    others: seen.size,
    rssiMin: n ? Math.min(...rssis) : null,
    rssiMax: n ? Math.max(...rssis) : null,
    rssiAvg: n ? Math.round(rssis.reduce((a: number, b: number) => a + b, 0) / n) : null,
    maxGapSec: lastHit ? Math.round(maxGap * 10) / 10 : null,
    connectable,
    serviceUUIDs: [...uuids],
    summary: "",
  }
  res.summary = n
    ? `命中 ${n} 次，RSSI ${res.rssiMin}~${res.rssiMax}（均值 ${res.rssiAvg}），最大间隔 ${res.maxGapSec}s，connectable=${connectable}，广播服务 UUID=${JSON.stringify(res.serviceUUIDs)}，其他设备 ${res.others} 个，用时 ${Math.round((Date.now() - started) / 1000)}s`
    : `没有扫描到 ${opt.localName}（其他设备 ${res.others} 个）。确认在车旁、手机蓝牙已开，且 Scripting 有蓝牙权限。`
  say("结果：" + res.summary)
  return res
}
