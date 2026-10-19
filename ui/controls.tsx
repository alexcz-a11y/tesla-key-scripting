// 全部功能（G-Controls）：车机（Infotainment）状态与指令（M7 第一、二档 + 媒体）
// 数据来自 GetVehicleData，没有读到的一律显示「—」，不伪造数值。车机睡着时不自动读取，轻点标题块才会唤醒并读取
import { HStack, ShapeStyle, useEffect, VirtualNode, VStack } from "scripting"
import { SleepStatus } from "../core/proto"
import { Msg } from "../client/dispatcher"
import { CATEGORIES, Category, HeaterLevel, KeeperMode, Seat } from "../client/infotainment"
import { AppState, actions, carActions, getState, refreshCar, useApp } from "./store"
import { Board, BOTTOM_PAD, Bottom, C, Col, En, Ends, Geo, PageHeader, Row, Tile, Zh } from "./kit"

const DASH: string = "—"
const CAR_POLL_MS: number = 30000
const ALL_CATS: Category[] = Object.keys(CATEGORIES) as Category[]

/** Void 成员组成的 oneof（如 ChargingState）解码后是 { Charging: {}, type: "Charging" } */
function oneofName(o: Msg | undefined): string | null {
  if (!o) return null
  if (typeof o.type === "string") return o.type
  return Object.keys(o)[0] ?? null
}

const deg = (v: number | undefined): string => (v == null ? DASH : `${v.toFixed(1)}°`)
const bar = (v: number | undefined): string => (v == null ? DASH : v.toFixed(1))
const hhmm = (t: number): string => {
  const d: Date = new Date(t)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

const CHARGING_ZH: Record<string, string> = {
  Unknown: "未知", Disconnected: "未插枪", NoPower: "桩无电", Starting: "正在开始",
  Charging: "充电中", Complete: "已充满", Stopped: "已停止", Calibrating: "校准中",
}
const HEATER_ZH: string[] = ["关", "低", "中", "高"]
const HEATER_LEVELS: HeaterLevel[] = ["OFF", "LOW", "MED", "HIGH"]
const KEEPER_ZH: Record<string, string> = { Unknown: "未知", Off: "关", On: "保持", Dog: "狗模式", Party: "露营" }
const UPDATE_EN: Record<string, string> = {
  Unknown: "Unknown", Installing: "Installing", Scheduled: "Scheduled", Available: "Available",
  DownloadingWifiWait: "Wi-Fi wait", Downloading: "Downloading",
}
const PLAYBACK_EN: string[] = ["Stopped", "Playing", "Paused"]

/** 弹出动作列表，选中后执行对应函数 */
async function sheet(title: string, message: string | undefined, items: { label: string; run: () => unknown; destructive?: boolean }[]): Promise<void> {
  const i: number | null = await Dialog.actionSheet({ title, message, actions: items.map((a) => ({ label: a.label, destructive: a.destructive })) })
  if (i != null && i >= 0 && items[i]) await items[i].run()
}

function seatMenu(name: string, seat: Seat, current: number | undefined): Promise<void> {
  return sheet(`${name}座椅加热`, current != null ? `当前：${HEATER_ZH[current] ?? current}` : undefined,
    HEATER_LEVELS.map((lv: HeaterLevel, i: number) => ({ label: HEATER_ZH[i], run: () => carActions.seatHeater(seat, lv) })))
}

function climateMenu(cl: Msg): Promise<void> {
  const on: boolean | undefined = cl.is_climate_on
  const items: { label: string; run: () => unknown }[] = [
    { label: on ? "关闭空调" : "打开空调", run: () => carActions.climate(!on) },
    { label: `设定温度（当前 ${deg(cl.driver_temp_setting)}）`, run: () => carActions.temp() },
    { label: `主驾座椅加热（${cl.seat_heater_left != null ? HEATER_ZH[cl.seat_heater_left] : DASH}）`, run: () => seatMenu("主驾", "FRONT_LEFT", cl.seat_heater_left) },
    { label: `副驾座椅加热（${cl.seat_heater_right != null ? HEATER_ZH[cl.seat_heater_right] : DASH}）`, run: () => seatMenu("副驾", "FRONT_RIGHT", cl.seat_heater_right) },
  ]
  if (cl.seat_heater_rear_left != null) items.push({ label: `后排左座椅加热（${HEATER_ZH[cl.seat_heater_rear_left]}）`, run: () => seatMenu("后排左", "REAR_LEFT", cl.seat_heater_rear_left) })
  if (cl.seat_heater_rear_center != null) items.push({ label: `后排中座椅加热（${HEATER_ZH[cl.seat_heater_rear_center]}）`, run: () => seatMenu("后排中", "REAR_CENTER", cl.seat_heater_rear_center) })
  if (cl.seat_heater_rear_right != null) items.push({ label: `后排右座椅加热（${HEATER_ZH[cl.seat_heater_rear_right]}）`, run: () => seatMenu("后排右", "REAR_RIGHT", cl.seat_heater_rear_right) })
  // 没装方向盘加热时车辆不返回这个字段
  if (cl.steering_wheel_heater != null) items.push({ label: cl.steering_wheel_heater ? "关闭方向盘加热" : "打开方向盘加热", run: () => carActions.steeringHeater(!cl.steering_wheel_heater) })
  const defrostMax: boolean = oneofName(cl.defrost_mode) === "Max"
  items.push({ label: defrostMax ? "关闭最大除霜" : "打开最大除霜", run: () => carActions.defrost(!defrostMax) })
  const keeper: string | null = oneofName(cl.climate_keeper_mode)
  items.push({
    label: `保持空调（${keeper ? KEEPER_ZH[keeper] ?? keeper : DASH}）`,
    run: () => sheet("保持空调", "下车后继续运行空调", [
      { label: "关", run: () => carActions.keeper(KeeperMode.OFF) },
      { label: "保持", run: () => carActions.keeper(KeeperMode.KEEP) },
      { label: "狗模式", run: () => carActions.keeper(KeeperMode.DOG) },
      { label: "露营", run: () => carActions.keeper(KeeperMode.CAMP) },
    ]),
  })
  return sheet("空调与座椅", `车内 ${deg(cl.inside_temp_celsius)} · 车外 ${deg(cl.outside_temp_celsius)}`, items)
}

function chargeMenu(ch: Msg): Promise<void> {
  const st: string | null = oneofName(ch.charging_state)
  const charging: boolean = st === "Charging" || st === "Starting"
  return sheet("充电", st ? `${CHARGING_ZH[st] ?? st}${ch.charger_power != null ? ` · ${ch.charger_power} kW` : ""}` : undefined, [
    { label: charging ? "停止充电" : "开始充电", run: () => (charging ? carActions.chargeStop() : carActions.chargeStart()) },
    { label: `充电上限（当前 ${ch.charge_limit_soc != null ? ch.charge_limit_soc + "%" : DASH}）`, run: () => carActions.chargeLimit() },
    { label: `充电电流（当前 ${ch.charging_amps ?? ch.charge_current_request ?? DASH} A）`, run: () => carActions.chargeAmps() },
  ])
}

export function ControlsPage(p: { onBack: () => void; onKeys: () => void }): VirtualNode {
  const s: AppState = useApp()
  const sleep: number = s.status?.vehicleSleepStatus ?? SleepStatus.UNKNOWN
  const awakeEn: string = s.status == null ? DASH : sleep === SleepStatus.AWAKE ? "Awake" : sleep === SleepStatus.ASLEEP ? "Asleep" : "Unknown"
  const idle: boolean = s.busy == null

  // 已连接且车机醒着时自动读取：进入页面、连上或车机醒来时读一次，之后每 30 秒一次。
  // 不为了显示数据去唤醒车辆；已知不回复的胎压只在手动刷新时再试
  const ready: boolean = s.hasKey && s.conn === "connected" && sleep === SleepStatus.AWAKE
  useEffect(() => {
    if (!ready) return
    const tick = (): void => {
      const st: AppState = getState()
      if (st.busy != null) return
      // 自动刷新从不唤醒车辆
      void refreshCar(ALL_CATS.filter((c: Category) => !(c === "tire" && st.carMissing.tire)), false)
    }
    tick()
    const timer = setInterval(tick, CAR_POLL_MS)
    return () => clearInterval(timer)
  }, [ready])

  const refresh = async (): Promise<void> => {
    await refreshCar()
    const err: string | null = getState().carErr
    if (err) await Dialog.alert({ title: "读取车机状态失败", message: err })
  }

  const ch: Msg = s.car.charge ?? {}
  const cl: Msg = s.car.climate ?? {}
  const cs: Msg = s.car.closures ?? {}
  const tp: Msg = s.car.tire ?? {}
  const md: Msg = s.car.media ?? {}
  const up: Msg | undefined = s.car.update

  const subtitle: string = s.carLoading ? "Reading…"
    : s.carAt == null ? "Tap to read"
      : `${s.carLive ? "Live" : "Last"} · ${hhmm(s.carAt)}`

  return <Board render={(g: Geo) => {
      /** 状态块：左上部件名，下方英文大字 + 一行中文说明 */
      const stateTile = (w: number, h: number, name: string, en: string, size: number, zh: string, run: () => unknown, busyKey: string[], bg?: ShapeStyle, fg?: ShapeStyle): VirtualNode =>
        <Tile g={g} w={w} h={h} bg={bg} fg={fg} action={() => void run()} disabled={!idle} busy={s.busy != null && busyKey.includes(s.busy)} a11y={name}>
          <Ends top={<Zh g={g}>{name + " ↗"}</Zh>}
            bottom={<VStack alignment="leading" spacing={6 * g.f}><En g={g} size={size}>{en}</En><Zh g={g}>{zh}</Zh></VStack>} />
        </Tile>
      const actionTile = (w: number, zh: string, en: string, run: () => unknown, key: string): VirtualNode =>
        <Tile g={g} w={w} h={80} action={() => void run()} disabled={!idle} busy={s.busy === key} a11y={zh}>
          <Ends top={<Zh g={g} size={28}>{zh}</Zh>} bottom={<En g={g} size={12} italic>{en}</En>} />
        </Tile>

      // 空调
      const climateOn: boolean | undefined = cl.is_climate_on
      const climateZh: string = climateOn == null ? "空调 · 未读取" : `空调 · ${climateOn ? "开" : "关"} · 车内 ${deg(cl.inside_temp_celsius)}`
      // 充电
      const chState: string | null = oneofName(ch.charging_state)
      const chargeZh: string = chState == null ? "未读取"
        : `${CHARGING_ZH[chState] ?? chState}${ch.charge_limit_soc != null ? ` · 上限 ${ch.charge_limit_soc}%` : ""}`
      // 车窗
      const wins: (boolean | undefined)[] = [cs.window_open_driver_front, cs.window_open_passenger_front, cs.window_open_driver_rear, cs.window_open_passenger_rear]
      const winKnown: boolean = wins.some((v) => v != null)
      const winEn: string = !winKnown ? DASH : wins.some((v) => v === true) ? "Open" : "Closed"
      // 哨兵
      const sentry: string | null = oneofName(cs.sentry_mode_state)
      const sentryOn: boolean = sentry != null && sentry !== "Off"
      const sentryEn: string = sentry == null ? DASH : sentryOn ? "On" : "Off"
      // 媒体
      const playback: string = md.media_playback_status != null ? PLAYBACK_EN[md.media_playback_status] ?? String(md.media_playback_status) : DASH
      const mediaZh: string = md.now_playing_title ? String(md.now_playing_title) : s.car.media ? "没有在播放" : "未读取"
      // 代客与限速（PIN 类，第四档，这里只读）
      const valet: boolean | undefined = cs.valet_mode
      const limit: Msg | undefined = cs.speed_limit_mode
      const limitZh: string = limit?.current_limit_mph != null
        ? `限速 ${Math.round(limit.current_limit_mph * 1.609344)} km/h · ${limit.active ? "已启用" : "未启用"}`
        : s.car.closures ? "限速 · 未设置" : "未读取"
      // 软件更新
      const updEn: string = up == null ? DASH : (() => {
        const st: string | null = oneofName(up.status)
        return st ? UPDATE_EN[st] ?? st : "None"
      })()

      return <Col>
        <PageHeader g={g} back="返回" title="全部功能" subtitle={`${s.config.name} · ${awakeEn} · ${subtitle}`} onBack={p.onBack}
          onTitle={() => void refresh()} titleA11y="读取车机状态（车机睡眠时会唤醒）" />
        <Row>
          {stateTile(236, 188, "空调与座椅", deg(cl.driver_temp_setting), 72, climateZh, () => climateMenu(cl), ["climate", "temp", "seat", "wheel", "defrost", "keeper"], C.cobalt, C.white)}
          {stateTile(154, 188, "充电", ch.battery_level != null ? `${ch.battery_level}%` : DASH, 52, chargeZh, () => chargeMenu(ch), ["charge", "chargeLimit", "chargeAmps"], C.vermilion)}
        </Row>
        <Row>
          {stateTile(118, 162, "车窗", winEn, 30, "全部车窗", () => sheet("车窗", "只能控制全部车窗，车辆须停稳", [
            { label: "通风（微开）", run: () => carActions.windows("vent") },
            { label: "关闭", run: () => carActions.windows("close") },
          ]), ["windows"])}
          {stateTile(118, 162, "哨兵模式", sentryEn, 44, sentry != null ? `哨兵 · ${sentry}` : "未读取", async () => {
            const ok: boolean = await Dialog.confirm({
              title: sentryOn ? "关闭哨兵模式" : "开启哨兵模式",
              message: sentryOn ? "车辆将停止哨兵监控。" : "车辆会用摄像头监控周围，耗电会增加。",
              confirmLabel: sentryOn ? "关闭" : "开启",
            })
            if (ok) await carActions.sentry(!sentryOn)
          }, ["sentry"])}
          {stateTile(154, 162, "媒体", playback, 36, mediaZh, () => sheet("媒体", md.now_playing_artist ? String(md.now_playing_artist) : undefined, [
            { label: "播放 / 暂停", run: () => carActions.media("toggle") },
            { label: "下一曲", run: () => carActions.media("next") },
            { label: "上一曲", run: () => carActions.media("prev") },
            { label: "音量 +", run: () => carActions.media("up") },
            { label: "音量 −", run: () => carActions.media("down") },
          ]), ["media"], C.ink, C.cream)}
        </Row>
        <Row>
          {stateTile(262, 150, "代客与限速", valet == null ? DASH : valet ? "Valet on" : "Valet off", 44, limitZh, () => sheet("代客与限速",
            `代客模式 ${valet == null ? DASH : valet ? "开" : "关"} · ${limitZh}。PIN 每次现场输入，不保存。`, [
              valet ? { label: "关闭代客模式", run: () => carActions.valetOff() } : { label: "开启代客模式…", run: () => carActions.valetOn() },
              { label: "重置代客 PIN", run: () => carActions.resetValetPin() },
              { label: "设置限速值…", run: () => carActions.speedLimitSet() },
              limit?.active ? { label: "停用限速…", run: () => carActions.speedLimitActivate(false) } : { label: "启用限速…", run: () => carActions.speedLimitActivate(true) },
              { label: "清除限速 PIN…", run: () => carActions.speedLimitClearPin() },
              { label: "忘记限速 PIN（车主清除）", run: () => carActions.speedLimitClearPinAdmin(), destructive: true },
            ]), ["valet", "valetPin", "speedLimit"])}
          <Tile g={g} w={128} h={150} a11y="胎压">
            <Ends top={<Zh g={g}>胎压 bar</Zh>} bottom={<VStack alignment="leading" spacing={4 * g.f}>
              <En g={g} size={26}>{`${bar(tp.tpms_pressure_fl)}  ${bar(tp.tpms_pressure_fr)}`}</En>
              <En g={g} size={26}>{`${bar(tp.tpms_pressure_rl)}  ${bar(tp.tpms_pressure_rr)}`}</En>
              <Zh g={g}>{s.carMissing.tire && !s.car.tire ? "车辆没有返回胎压"
                : tp.tpms_rcp_front_value != null ? `建议 ${bar(tp.tpms_rcp_front_value)} / ${bar(tp.tpms_rcp_rear_value)}` : "前 · 后"}</Zh>
            </VStack>} />
          </Tile>
        </Row>
        <Row>
          {actionTile(140, "闪灯", "Flash lights", () => carActions.flash(), "flash")}
          {actionTile(120, "鸣笛", "Honk", () => carActions.honk(), "honk")}
          <Tile g={g} w={130} h={80} action={() => void sheet("软件更新",
            up == null ? "还没有读取" : `状态：${updEn}${up.version?.trim() ? ` · 版本 ${up.version}` : ""}${up.download_perc != null ? ` · 下载 ${up.download_perc}%` : ""}`, [
              { label: "安排安装…", run: () => carActions.updateSchedule() },
              { label: "取消安装倒计时", run: () => carActions.updateCancel() },
            ])} disabled={!idle} busy={s.busy === "update"} a11y="软件更新">
            <Ends top={<En g={g} size={22}>{updEn}</En>} bottom={<Zh g={g}>软件更新 ↗</Zh>} />
          </Tile>
        </Row>
        <Row>
          <Tile g={g} w={240} h={140} bg={C.ink} fg={C.cream} pad={{ top: 12, leading: 14, trailing: 14, bottom: BOTTOM_PAD }}
            action={p.onKeys} a11y="钥匙与设置">
            <Ends top={<HStack frame={{ maxWidth: "infinity", alignment: "trailing" }}><En g={g} size={34}>→</En></HStack>}
              bottom={<VStack alignment="leading" spacing={6 * g.f}>
                <En g={g} size={32}>{s.config.paired ? "Paired" : "Unpaired"}</En>
                <Zh g={g}>钥匙与设置 · 调试日志</Zh>
              </VStack>} />
          </Tile>
          <Tile g={g} w={150} h={140} pad={{ top: 12, leading: 12, trailing: 12, bottom: BOTTOM_PAD }}
            action={() => void actions.wake()} disabled={!idle} busy={s.busy === "wake"} a11y="唤醒车机">
            <Bottom g={g}>
              <En g={g} size={32}>{awakeEn}</En>
              <Zh g={g}>{sleep === SleepStatus.AWAKE ? "车机 · 已唤醒" : "车机 · 轻点唤醒"}</Zh>
            </Bottom>
          </Tile>
        </Row>
      </Col>
  }} />
}
