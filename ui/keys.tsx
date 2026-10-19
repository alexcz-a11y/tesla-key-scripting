// 钥匙与设置（G-Keys）：配对状态、钥匙列表、调试日志、VIN、重新配对、删除本机钥匙
// 靠近自动（M6）与车机电源选项（M7）尚未实现，只显示入口说明
import { HStack, useEffect, useState, VirtualNode } from "scripting"
import { describeError } from "../core/errors"
import { createPrivateKey, deletePrivateKey, getPublicKey, hasPrivateKey, setVin, VehicleConfig } from "../core/keystore"
import { hex } from "../core/bytes"
import { KeyRole } from "../core/proto"
import { describeKey } from "../client/vehicle"
import { pairKey } from "../client/pairing"
import { AppState, carActions, client, reloadKeyInfo, run, updateConfig, useApp } from "./store"
import { Board, BOTTOM_PAD, Bottom, C, Col, En, Ends, Geo, PageHeader, Row, Split, Tile, Zh } from "./kit"

const notYetM6 = (): void => void Dialog.alert({ title: "还没有接入", message: "靠近自动解锁 / 离开自动上锁是下一阶段（M6）。在 Scripting 提供蓝牙后台保活接口之前，只能在前台工作。" })
/** 车辆不回报这两项的当前状态，只能直接选开或关 */
async function powerMenu(title: string, apply: (on: boolean) => Promise<void>): Promise<void> {
  const i: number | null = await Dialog.actionSheet({ title, message: "车辆不提供当前状态，请直接选择", actions: [{ label: "开启" }, { label: "关闭" }] })
  if (i === 0) await apply(true)
  else if (i === 1) await apply(false)
}

export function KeysPage(p: { onBack: () => void; onDebug: () => void }): VirtualNode {
  const s: AppState = useApp()
  const [keyCount, setKeyCount] = useState<number | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  useEffect(() => {
    reloadKeyInfo()
  }, [])

  const listKeys = (): void => void run("listKeys", async () => {
    const keys = await client.listKeys()
    setKeyCount(keys.length)
    const mine: Uint8Array | null = getPublicKey()
    const mineHex: string | null = mine ? hex(mine) : null
    const me = keys.find((k) => mineHex != null && k.publicKey?.PublicKeyRaw != null && hex(k.publicKey.PublicKeyRaw) === mineHex)
    if (me) updateConfig({ keySlot: me.slot ?? 0, paired: true })
    await Dialog.alert({ title: `车辆钥匙 · ${keys.length} 把`, message: keys.map((k) => describeKey(k, mine)).join("\n") || "列表为空" })
  })

  /** 填写 / 修改 VIN：换了车会清掉配对状态和会话缓存（setVin），并断开当前连接 */
  const editVin = async (): Promise<boolean> => {
    const input: string | null = await Dialog.prompt({
      title: "车辆 VIN",
      message: "17 位，在车机「控制 → 软件」或行驶证上可以看到",
      defaultValue: s.config.vin,
      placeholder: "例如 LRW…",
    })
    if (input == null) return false
    try {
      const before: string = s.config.vin
      const c: VehicleConfig = await setVin(input)
      if (c.vin !== before) await client.transport.disconnect().catch(() => undefined)
      updateConfig(c)
      return true
    } catch (e: any) {
      await Dialog.alert({ title: "VIN 无效", message: describeError(e) })
      return false
    }
  }

  const pair = async (): Promise<void> => {
    if (!s.config.vin && !(await editVin())) return
    const ok: boolean = await Dialog.confirm({
      title: "配对本机钥匙",
      message: "请确认：人在车里、钥匙卡在手边。点确定后发送配对请求，然后在中控刷卡，并在车机屏幕上确认。最多等待 2 分钟。",
    })
    if (!ok) return
    if (!hasPrivateKey()) createPrivateKey()
    client.reloadKey()
    const pub: Uint8Array | null = getPublicKey()
    if (!pub) return
    const done: boolean = await run("pair", () => pairKey(client, pub, { role: KeyRole.OWNER, onProgress: (l: string) => setProgress(l) }))
    setProgress(null)
    reloadKeyInfo()
    if (done) await Dialog.alert({ title: "配对完成", message: "本机钥匙已在车辆钥匙列表中。" })
  }

  const remove = async (): Promise<void> => {
    const ok: boolean = await Dialog.confirm({
      title: "删除本机钥匙",
      message: "会从这台手机删除私钥，之后无法再用本机控车，需要重新配对。车辆钥匙列表里的这把钥匙不会自动删除，请在车机「锁」→ 钥匙列表里手动删除。",
      confirmLabel: "删除",
    })
    if (!ok) return
    deletePrivateKey()
    updateConfig({ keySlot: undefined })
    client.reloadKey()
    reloadKeyInfo()
  }

  const vinMenu = async (): Promise<void> => {
    if (!s.config.vin) {
      await editVin()
      return
    }
    const i: number | null = await Dialog.actionSheet({ title: `VIN ${s.config.vin}`, actions: [{ label: "拷贝" }, { label: "修改" }] })
    if (i === 0) {
      await Pasteboard.setString(s.config.vin)
      await Dialog.alert({ message: `已拷贝 VIN ${s.config.vin}` })
    } else if (i === 1) await editVin()
  }

  return <Board render={(g: Geo) => {
      const heroEn: string = !s.hasKey ? "No key." : s.config.paired ? "Paired." : "Unpaired."
      const heroTop: string = progress
        ?? (s.hasKey ? `本机钥匙${s.config.keySlot != null ? " · 槽 " + s.config.keySlot : ""} · ${s.keyId ?? "…"}` : "还没有生成钥匙 · 轻点「配对」开始")
      const onOff = (on: boolean, name: string): VirtualNode[] => [
        <Tile key={name + "on"} g={g} w={97} h={80} bg={on ? C.ink : C.cream} fg={on ? C.cream : C.ink} action={notYetM6} a11y={name + " 开"}>
          <En g={g} size={20} kerning={1.6}>ON</En>
        </Tile>,
        <Tile key={name + "off"} g={g} w={97} h={80} bg={on ? C.cream : C.ink} fg={on ? C.ink : C.cream} action={notYetM6} a11y={name + " 关"}>
          <En g={g} size={20} kerning={1.6}>OFF</En>
        </Tile>,
      ]
      const vin: string = s.config.vin
      return <Col>
        <PageHeader g={g} back="返回" title="钥匙与设置" subtitle="Owner · iPhone" onBack={p.onBack} />
        <Tile g={g} w={390} h={188} bg={C.cobalt} fg={C.white} pad={{ top: 14, leading: 16, trailing: 16, bottom: 6 }} busy={s.busy === "pair"} a11y="钥匙状态">
          <Ends top={<Zh g={g}>{heroTop}</Zh>} bottom={<HStack frame={{ width: 358 * g.sx, alignment: "leading" }}><En g={g} size={112} fixed kerning={-4}>{heroEn}</En></HStack>} />
        </Tile>

        <Row>
          <Tile g={g} w={196} h={80}>
            <Ends top={<En g={g} size={26}>Walk-up</En>} bottom={<Zh g={g}>靠近自动解锁 · 待接入</Zh>} />
          </Tile>
          {onOff(s.config.autoUnlock, "靠近自动解锁")}
        </Row>
        <Row>
          <Tile g={g} w={195} h={100} action={notYetM6} a11y="解锁距离">
            <Ends top={<Zh g={g}>解锁距离 ↗</Zh>} bottom={<En g={g} size={40}>{`−${Math.abs(s.config.unlockRssi)} dBm`}</En>} />
          </Tile>
          <Tile g={g} w={195} h={100} action={notYetM6} a11y="离开距离">
            <Ends top={<Zh g={g}>离开距离 ↗</Zh>} bottom={<En g={g} size={40}>{`−${Math.abs(s.config.leaveRssi)} dBm`}</En>} />
          </Tile>
        </Row>
        <Row>
          <Tile g={g} w={196} h={80}>
            <Ends top={<En g={g} size={26}>Auto-lock</En>} bottom={<Zh g={g}>离开后自动上锁 · 待接入</Zh>} />
          </Tile>
          {onOff(s.config.autoLock, "离开后自动上锁")}
        </Row>

        <Row>
          {/* 车辆不提供这两项的当前状态（GetVehicleData 里没有），所以只给开 / 关两个选项，不显示状态 */}
          <Tile g={g} w={130} h={80} action={() => void powerMenu("低功耗模式", carActions.lowPower)} disabled={s.busy != null || !s.hasKey}
            busy={s.busy === "lowPower"} a11y="低功耗模式">
            <Ends top={<En g={g} size={26}>—</En>} bottom={<Zh g={g}>低功耗模式 ↗</Zh>} />
          </Tile>
          <Tile g={g} w={130} h={80} action={() => void powerMenu("保持附件供电", carActions.keepAccessoryPower)} disabled={s.busy != null || !s.hasKey}
            busy={s.busy === "accessory"} a11y="保持附件供电">
            <Ends top={<En g={g} size={26}>—</En>} bottom={<Zh g={g}>保持附件供电 ↗</Zh>} />
          </Tile>
          <Tile g={g} w={130} h={80} action={listKeys} disabled={s.busy != null || !s.hasKey} busy={s.busy === "listKeys"} a11y="车辆钥匙列表">
            <Ends top={<En g={g} size={26}>{keyCount != null ? `${keyCount} keys` : "Keys"}</En>} bottom={<Zh g={g}>车辆钥匙列表 ↗</Zh>} />
          </Tile>
        </Row>

        <Row>
          <Tile g={g} w={196} h={52} action={p.onDebug} a11y="调试日志">
            <Split left={<Zh g={g}>调试日志</Zh>} right={<En g={g} size={13} italic>Log ↗</En>} />
          </Tile>
          <Tile g={g} w={194} h={52} action={() => void vinMenu()} disabled={s.busy != null} a11y={vin ? "拷贝或修改 VIN" : "填写 VIN"}>
            <Split left={<Zh g={g}>车辆与 VIN</Zh>} right={<En g={g} size={13} italic>{vin ? `${vin.slice(0, 4)}···${vin.slice(-4)}` : "未填写 ↗"}</En>} />
          </Tile>
        </Row>

        <Row>
          <Tile g={g} w={195} h={140} pad={{ top: 12, leading: 12, trailing: 12, bottom: BOTTOM_PAD }}
            action={() => void pair()} disabled={s.busy != null} busy={s.busy === "pair"} a11y="配对本机钥匙">
            <Bottom g={g}>
              <Zh g={g} size={22}>{s.config.paired ? "重新配对" : "配对"}</Zh>
              <En g={g} size={12} italic>Pair with key card</En>
            </Bottom>
          </Tile>
          <Tile g={g} w={195} h={140} bg={C.vermilion} pad={{ top: 12, leading: 12, trailing: 12, bottom: BOTTOM_PAD }}
            action={() => void remove().catch((e: any) => Dialog.alert({ message: describeError(e) }))} disabled={s.busy != null || !s.hasKey} a11y="删除本机钥匙">
            <Bottom g={g}>
              <Zh g={g} size={22}>删除本机钥匙</Zh>
              <En g={g} size={12} italic>Needs confirmation</En>
            </Bottom>
          </Tile>
        </Row>
      </Col>
  }} />
}
