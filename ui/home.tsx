// 主页（G · 已上锁 / 已解锁）：连接、整车状态、四门单独弹开、解锁上锁、前后备箱、充电口、车机、全部功能
import { HStack, Navigation, Script, ShapeStyle, Spacer, VirtualNode, VStack } from "scripting"
import { ClosureState, LockState, SleepStatus, UserPresence } from "../core/proto"
import { DoorKey } from "../client/vehicle"
import { actions, AppState, autoConnect, disconnect, isOpen, useApp } from "./store"
import { Board, BOTTOM_PAD, Bottom, C, Col, En, Ends, Geo, Pair, Row, Split, Tile, Zh } from "./kit"

export function closureEn(v: number | undefined, known: boolean, shut: string = "Closed"): string {
  if (!known) return "—"
  switch (v ?? ClosureState.CLOSED) {
    case ClosureState.CLOSED: return shut
    case ClosureState.OPEN: return "Open"
    case ClosureState.AJAR: return "Ajar"
    case ClosureState.OPENING: return "Opening"
    case ClosureState.CLOSING: return "Closing"
    case ClosureState.FAILED_UNLATCH: return "Failed"
    default: return "Unknown"
  }
}

function hhmm(t: number): string {
  const d: Date = new Date(t)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** 连接块：轻点弹出连接相关操作 */
async function connMenu(s: AppState, dismiss: () => void): Promise<void> {
  const connected: boolean = s.conn === "connected"
  const items: { label: string; destructive?: boolean; run: () => void | Promise<void> }[] = [
    connected ? { label: "断开蓝牙", run: () => disconnect() } : { label: "连接车辆", run: () => autoConnect() },
  ]
  if (Script.supportsMinimization()) items.push({ label: "收起到后台", run: () => void Script.minimize() })
  items.push({ label: "查看控制台", run: () => console.present() })
  items.push({ label: "关闭页面（查看控制台）", run: () => dismiss() })
  const msg: string = s.connErr && !connected ? s.connErr : connected ? "已通过蓝牙连接车辆" : "未连接"
  const i: number | null = await Dialog.actionSheet({ title: "蓝牙连接", message: msg, actions: items.map((a) => ({ label: a.label, destructive: a.destructive })) })
  if (i != null && i >= 0 && items[i]) await items[i].run()
}

const DOOR_ZH: Record<DoorKey, string> = {
  frontDriverDoor: "左前门",
  frontPassengerDoor: "右前门",
  rearDriverDoor: "左后门",
  rearPassengerDoor: "右后门",
}

export function HomePage(p: { onAll: () => void; onKeys: () => void }): VirtualNode {
  const s: AppState = useApp()
  const dismiss = Navigation.useDismiss()
  const st = s.status
  const known: boolean = st != null
  const c = st?.closureStatuses ?? {}
  // 状态未知时按已上锁处理：主操作显示「解锁」
  const locked: boolean = !known || (st?.vehicleLockState ?? LockState.UNLOCKED) === LockState.LOCKED || s.selective
  const idle: boolean = s.busy == null

  return <Board render={(g: Geo) => {
      // ---- 顶部三块 ----
      const conn: { en: string; zh: string; dark: boolean } =
        s.conn === "connected" ? { en: "Connected", zh: "蓝牙连接", dark: true }
          : s.conn === "scanning" ? { en: "Scanning", zh: "正在寻找车辆", dark: true }
            : s.conn === "connecting" ? { en: "Linking", zh: "正在连接", dark: true }
              : { en: "Offline", zh: "蓝牙 · 轻点连接", dark: false }
      const paired: string = s.config.paired ? "Paired" : s.hasKey ? "Unpaired" : "No key"
      const slot: string = s.config.keySlot != null ? `钥匙 · 槽 ${s.config.keySlot} ↗` : "钥匙与设置 ↗"

      // ---- 整车状态 ----
      const heroText: string = !known ? "Offline." : locked ? "Locked." : "Unlocked."
      const heroBg: ShapeStyle = !known ? C.cream : locked ? C.vermilion : C.ink
      const heroFg: ShapeStyle = !known ? C.ink : locked ? C.ink : C.vermilion
      const heroSub: string[] = [`${s.config.name} 整车`]
      if (s.selective) heroSub.push("单门弹开 · 其余门仍上锁")
      if (known) heroSub.push((st?.userPresence ?? 0) === UserPresence.PRESENT ? "车内有人" : (st?.userPresence ?? 0) === UserPresence.NOT_PRESENT ? "车内无人" : "车内未知")
      if (known && !s.live && s.statusAt) heroSub.push(`上次状态 ${hhmm(s.statusAt)}`)
      if (!known) heroSub.push("还没有读到车辆状态")

      const door = (key: DoorKey): { en: string; open: boolean } => {
        const v: number | undefined = (c as Record<string, number | undefined>)[key]
        return { en: closureEn(v, known), open: known && isOpen(v) }
      }
      const doorTile = (key: DoorKey, w: number, h: number, layout: "row" | "tall" | "small"): VirtualNode => {
        const d = door(key)
        const zh: string = DOOR_ZH[key]
        const hint: string = d.open ? "已弹开" : "弹开 ↗"
        const body: VirtualNode =
          layout === "row" ? <Split left={<Pair g={g} en={d.en} size={40} zh={zh} />} right={<Zh g={g}>{hint}</Zh>} />
            : layout === "tall" ? <Ends top={<Zh g={g}>{zh}</Zh>} bottom={<Pair g={g} en={d.en} size={d.open ? 40 : 34} zh={hint} />} />
              : <Ends top={<En g={g} size={28}>{d.en}</En>} bottom={<Zh g={g}>{d.open ? zh + " · 开" : zh + " ↗"}</Zh>} />
        return <Tile g={g} w={w} h={h} bg={d.open ? C.vermilion : C.cream}
          pad={layout === "row" ? { leading: 14, trailing: 14 } : layout === "tall" ? { top: 12, bottom: 12, leading: 12, trailing: 12 } : undefined}
          action={() => void actions.door(key)} disabled={!idle || d.open} busy={s.busy === key}
          a11y={d.open ? `${zh}已打开` : `弹开${zh}`}>{body}</Tile>
      }

      const shut = (v: number | undefined): string => closureEn(v, known, "Shut")
      const frunkOpen: boolean = known && isOpen(c.frontTrunk)
      const trunkOpen: boolean = known && isOpen(c.rearTrunk)
      const portOpen: boolean = known && isOpen(c.chargePort)
      const sleep: number = st?.vehicleSleepStatus ?? SleepStatus.UNKNOWN
      const awakeEn: string = !known ? "—" : sleep === SleepStatus.AWAKE ? "Awake" : sleep === SleepStatus.ASLEEP ? "Asleep" : "Unknown"

      return <Col>
        <Row>
          <Tile g={g} w={170} h={124} bg={conn.dark ? C.ink : C.cream} fg={conn.dark ? C.cream : C.ink}
            pad={{ leading: 14, trailing: 14, bottom: 12 }} action={() => void connMenu(s, dismiss)} a11y="蓝牙连接">
            <Bottom g={g}>
              <En g={g} size={30}>{conn.en}</En>
              <Zh g={g}>{conn.zh}</Zh>
            </Bottom>
          </Tile>
          <Tile g={g} w={110} h={124} pad={{ bottom: 12 }} a11y="信号强度">
            <Bottom g={g}>
              <En g={g} size={34}>{s.rssi != null ? `−${Math.abs(s.rssi)}` : "—"}</En>
              <Zh g={g}>信号 dBm</Zh>
            </Bottom>
          </Tile>
          <Tile g={g} w={110} h={124} pad={{ bottom: 12 }} action={p.onKeys} a11y="钥匙与设置">
            <Bottom g={g}>
              <En g={g} size={26}>{paired}</En>
              <Zh g={g}>{slot}</Zh>
            </Bottom>
          </Tile>
        </Row>
        <Tile g={g} w={390} h={188} bg={heroBg} fg={heroFg} pad={{ top: 14, leading: 0, trailing: 16, bottom: 0 }} a11y="整车状态">
          <VStack alignment="trailing" spacing={2 * g.f} frame={{ maxWidth: "infinity", alignment: "trailing" }}>
            {heroSub.map((l: string, i: number) => <Zh key={String(i)} g={g} color={heroBg === C.ink ? C.cream : C.ink}>{l}</Zh>)}
          </VStack>
          <Spacer />
          {/* 大字出血：文字保持原尺寸，外面套固定宽度的 frame（左对齐），超出右边的部分由方块裁掉，不撑大布局 */}
          <HStack frame={{ width: 360 * g.sx, alignment: "leading" }} padding={{ leading: 14 * g.f, bottom: 4 * g.f }}>
            <En g={g} size={heroText === "Locked." ? 128 : 112} fixed kerning={-4}>{heroText}</En>
          </HStack>
        </Tile>
        <Row>
          <Col>
            <Row>
              {doorTile("frontDriverDoor", 236, 84, "row")}
            </Row>
            <Row>
              {doorTile("rearDriverDoor", 118, 78, "small")}
              {doorTile("rearPassengerDoor", 118, 78, "small")}
            </Row>
          </Col>
          {doorTile("frontPassengerDoor", 154, 162, "tall")}
        </Row>
        <Row>
          <Tile g={g} w={262} h={150} bg={C.cobalt} fg={C.white} pad={{ top: 14, bottom: 14, leading: 16, trailing: 16 }}
            action={() => void (locked ? actions.unlock() : actions.lock())} disabled={!idle}
            busy={s.busy === "unlock" || s.busy === "lock"} a11y={locked ? "解锁全部车门" : "上锁全部车门"}>
            <Ends top={<En g={g} size={15} italic>{locked ? "Unlock all doors" : "Lock all doors"}</En>}
              bottom={<Zh g={g} size={58} kerning={2}>{locked ? "解锁" : "上锁"}</Zh>} />
          </Tile>
          <Col>
            <Tile g={g} w={128} h={75} bg={frunkOpen ? C.vermilion : C.cream}
              action={() => void actions.frunk()} disabled={!idle || frunkOpen} busy={s.busy === "frontTrunk"} a11y="打开前备箱">
              <Ends top={<En g={g} size={26}>{shut(c.frontTrunk)}</En>} bottom={<Zh g={g}>前备箱</Zh>} />
            </Tile>
            <Tile g={g} w={128} h={75} bg={trunkOpen ? C.vermilion : C.cream}
              action={() => void actions.trunk()} disabled={!idle} busy={s.busy === "rearTrunk"} a11y={trunkOpen ? "关闭后备箱" : "打开后备箱"}>
              <Ends top={<En g={g} size={26}>{shut(c.rearTrunk)}</En>} bottom={<Zh g={g}>{trunkOpen ? "后备箱 · 轻点关闭" : "后备箱"}</Zh>} />
            </Tile>
          </Col>
        </Row>
        <Row>
          <Tile g={g} w={150} h={80}
            action={() => void (locked ? actions.lock() : actions.unlock())} disabled={!idle} a11y={locked ? "上锁" : "解锁"}>
            <Ends top={<Zh g={g} size={30}>{locked ? "上锁" : "解锁"}</Zh>} bottom={<En g={g} size={12} italic>{locked ? "Lock" : "Unlock"}</En>} />
          </Tile>
          <Tile g={g} w={240} h={80} bg={portOpen ? C.vermilion : C.cream} pad={{ leading: 14, trailing: 14 }}
            action={() => void actions.chargePort()} disabled={!idle} busy={s.busy === "chargePort"} a11y={portOpen ? "关闭充电口" : "打开充电口"}>
            <Split left={<Pair g={g} en={shut(c.chargePort)} size={32} zh="充电口" />} right={<Zh g={g}>{portOpen ? "轻点关闭" : "打开 ↗"}</Zh>} />
          </Tile>
        </Row>
        <Row>
          <Tile g={g} w={150} h={140} pad={{ top: 12, leading: 12, trailing: 12, bottom: BOTTOM_PAD }}
            action={() => void actions.wake()} disabled={!idle} busy={s.busy === "wake"} a11y="唤醒车机">
            <Bottom g={g}>
              <En g={g} size={32}>{awakeEn}</En>
              <Zh g={g}>{sleep === SleepStatus.AWAKE ? "车机 · 已唤醒" : "车机 · 轻点唤醒"}</Zh>
            </Bottom>
          </Tile>
          <Tile g={g} w={240} h={140} bg={C.ink} fg={C.cream} pad={{ top: 12, leading: 14, trailing: 14, bottom: BOTTOM_PAD }}
            action={p.onAll} a11y="全部功能">
            <Ends top={<HStack frame={{ maxWidth: "infinity", alignment: "trailing" }}><En g={g} size={34}>→</En></HStack>}
              bottom={<VStack alignment="leading" spacing={6 * g.f}>
                <Zh g={g} size={26}>全部功能</Zh>
                <Zh g={g}>空调 · 充电 · 车窗 · 哨兵 · 媒体</Zh>
              </VStack>} />
          </Tile>
        </Row>
      </Col>
  }} />
}
