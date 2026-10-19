// Tesla Key 主屏幕小组件（按 Design 画布原型 Version 40 实现）：
//   大号 = 整车；中号 = 车锁 / 前备箱 / 后备箱 / 充电口；小号 = 一个部位，用小组件设置里的「参数」选：
//   lock（默认）、door_fl、door_fr、door_rl、door_rr、trunk、charge
// 只读 Storage 快照显示状态，不连车、不唤醒；按钮走 CommandIntent（app_intents.tsx：先交给主脚本，不行再直连）。
// 原型按 430pt 宽 iPhone 画（小号 170、中号 / 大号 364 宽）。按 HIG：边距固定（文字 16pt、按钮组 11pt，按钮间距 8pt），
// 点击区固定（车门 65/50 × 44pt），图在剩余空间里等比缩放；文字用系统文字样式（支持动态字体），默认字号下不小于 11pt。
// 对顺序敏感的修饰符（内边距 → 撑满 → 背景）用 modifiers() 链式写，顺序与 SwiftUI 一致。
// 深浅色：根背景用 widgetBackground（「透明」「色调」外观下系统自动隐藏），文字用自定义深浅两色（次要文字比系统 secondaryLabel 深，保证 4.5:1）；
// accented 渲染模式下内容都会被染成白色，车图改用深色版（白线）那套。
// 车图是按每个位置的尺寸预先导出的 3x PNG（assets/widget-r2，目录名带版本号，见 ASSET_DIR；导出脚本在作者本地的素材工程里，不在本仓库），
// 小组件里不做裁切和遮罩，省内存（上限约 30 MB）。
// 文字只显示结果（状态、可做的操作），不显示「执行中」之类的中间状态：中间状态会让文字变长、放不下变成省略号。
// 静态导入链里只能放轻量模块（npm 包会让小组件空白）
import { Button, DateLabel, DynamicShapeStyle, EnvironmentValuesReader, HStack, Image, modifiers, Path, Script, Shape, Spacer, SVG, Text, VirtualNode, VStack, Widget, ZStack } from "scripting"
import { CommandIntent } from "./app_intents"
import { closureOpen, DoorCommand, loadSnapshot, Snapshot, snapshotLocked, WIDGET_DOORS, WidgetCommand } from "./core/widget_cmds"
import { SleepStatus, UserPresence } from "./core/proto_consts"

type Snap = Snapshot

// ---- 配色（原型 THEME） ----
const TEXT: DynamicShapeStyle = { light: "#000000", dark: "#FFFFFF" }
const DIM: DynamicShapeStyle = { light: "rgba(60,60,67,0.76)", dark: "rgba(235,235,245,0.6)" }
/**
 * 按钮块：inverse 方案（画布原型的 tile = inverse）。线框图正后方永远是整块里最暗（浅色版最亮）的地方：
 *   平时 = 下沉的暗槽 + 很淡的点阵 + 内阴影（Scripting 没有内阴影，做成图：tile_{medium,large}_{d,l}.png）；
 *   打开 / 解锁 = 整块翻成实体（深色版白块、浅色版深块），线框图换成另一套（深色版用墨线图、浅色版用白线图），状态字用强调色。
 * 「透明」「色调」外观下内容会被染成白色、只留透明度；Scripting 的「透明背景 / 模糊背景小组件」要求内容不画不透明底：
 * 这两种情况都改用半透明白底（平时 8%、打开 / 解锁 32%），层次还在
 */
const ACTIVE_BG: DynamicShapeStyle = {
  dark: { colors: ["#FFFFFF", "#E3E6EB"], startPoint: "top", endPoint: "bottom" },
  light: { colors: ["#2A2D33", "#0E1013"], startPoint: "top", endPoint: "bottom" },
}
const ACTIVE_TEXT: DynamicShapeStyle = { light: "#FFFFFF", dark: "#0A0B0D" }
/** 白块上 #C2410C（约 5:1），深块上 #FFB340（约 9:1） */
const ACTIVE_STATUS: DynamicShapeStyle = { light: "#FFB340", dark: "#C2410C" }
const BG: DynamicShapeStyle = { light: "#FFFFFF", dark: "#0A0B0D" }
/**
 * 按钮块圆角：HIG「用 SwiftUI 容器让内容圆角与小组件圆角协调，见 ContainerRelativeShape」。
 * containerRelative 继承小组件的圆角并按内缩距离（按钮离边 11pt）算出同心圆角：430pt 机型上是 22 − 11 = 11pt，
 * 其他机型按系统实际的小组件圆角算。四块离上下（大号离下、左右）边的距离相同，所以四块圆角一致。
 * 不用 concentricRect（iOS 26 ConcentricRectangle 逐角计算：不挨着小组件圆角的角退回系统默认的小圆角，四块不一致）
 */
const TILE_SHAPE: Shape = "containerRelative"
/** HIG：文字不小于 11pt。单行放不下时允许缩小，但默认字号下不低于 11pt */
const FOOTNOTE_MIN: number = 11 / 13
const CAPTION_MIN: number = 11 / 12

// ---- 部位 ----
type Part = "lock" | "door_fl" | "door_fr" | "door_rl" | "door_rr" | "frunk" | "trunk" | "charge"
type Slot = "small" | "medium" | "large"

const NAME: Record<Part, string> = {
  lock: "车锁", door_fl: "左前门", door_fr: "右前门", door_rl: "左后门", door_rr: "右后门", frunk: "前备箱", trunk: "后备箱", charge: "充电口",
}
/** 部位对应的 closureStatuses 键（车门取自 core/widget_cmds 的 WIDGET_DOORS） */
const CLOSURE: Partial<Record<Part, string>> = { ...WIDGET_DOORS, frunk: "frontTrunk", trunk: "rearTrunk", charge: "chargePort" }
/** 中号和大号底部那一排 */
const ROW_PARTS: Part[] = ["lock", "frunk", "trunk", "charge"]
const SMALL_PARTS: Part[] = ["lock", "door_fl", "door_fr", "door_rl", "door_rr", "trunk", "charge"]

interface PartState {
  part: Part
  /** 车锁：已解锁；其余：已打开 */
  open: boolean
  /** 有没有快照 */
  known: boolean
  state: string
  hint: string
  /** 轻点发的指令；null = 没有可做的（车门 / 前备箱已打开，只能手动关），轻点只打开 App */
  cmd: WidgetCommand | null
  label: string
}

function partState(part: Part, s: Snap | null): PartState {
  const known: boolean = s != null
  if (part === "lock") {
    // 单门弹开后车报 UNLOCKED，但其余门仍锁着（selective），当作已锁
    const locked: boolean = !known || snapshotLocked(s)
    return {
      part, open: !locked, known,
      state: !known ? "未知" : locked ? "已上锁" : "已解锁",
      hint: locked ? "轻点解锁" : "轻点上锁",
      cmd: locked ? "unlock" : "lock",
      label: !known ? "状态未知，轻点解锁" : locked ? "已上锁，轻点解锁" : "已解锁，轻点上锁",
    }
  }
  const open: boolean = closureOpen(s?.status.closureStatuses?.[CLOSURE[part] as string])
  const state: string = !known ? "未知" : open ? "已打开" : "关闭"
  if (part.startsWith("door_")) {
    const hint: string = open ? "需手动关门" : "轻点弹开"
    return { part, open, known, state, hint, cmd: open ? null : (part as DoorCommand), label: `${NAME[part]}${state}，${hint}` }
  }
  if (part === "frunk") {
    const hint: string = open ? "需手动关闭" : "轻点打开"
    return { part, open, known, state, hint, cmd: open ? null : "frunk_open", label: `前备箱${state}，${hint}` }
  }
  const hint: string = open ? "轻点关闭" : "轻点打开"
  const cmd: WidgetCommand = part === "trunk" ? (open ? "trunk_close" : "trunk_open") : open ? "charge_close" : "charge_open"
  return { part, open, known, state, hint, cmd, label: `${NAME[part]}${state}，${hint}` }
}

/** 有指令时整块是按钮；没有可做的指令时只是普通视图（轻点打开 App），避免重复发已经到位的指令 */
function Tap({ p, children }: { p: PartState; children: VirtualNode }): VirtualNode {
  if (!p.cmd) return <VStack accessibilityLabel={p.label}>{children}</VStack>
  return <Button intent={CommandIntent({ cmd: p.cmd })} buttonStyle="plain" accessibilityLabel={p.label}>{children}</Button>
}

// ---- 图 ----
/**
 * 小组件图片目录带版本号：手机上会按文件路径缓存图片（2026-10-18 实测：同名文件更新后，大号整车仍显示旧图、新加的按钮底图不显示），
 * 所以图片有改动就整体导出到新目录、改这里的版本号（导出脚本：reference/ai-wireframe/pipeline/widget/parts.py）
 */
const ASSET_DIR: string = "widget-r2"
/** 渲染必需的几张图（检查图片有没有同步到手机时用） */
const REQUIRED_ASSETS: string[] = ["tile_medium_d.png", "tile_large_d.png", "large_car_d.png", "small_lock_0_d.png", "medium_lock_0_d.png"]

function asset(name: string): string {
  return Path.join(Script.directory, "assets", ASSET_DIR, name)
}

/**
 * 用哪套线框图：
 *   normal   = 跟随深浅色（深色版白线、带灯光；浅色版墨线）
 *   swap     = 反过来（inverse 方案打开 / 解锁时：深色模式下是白块，要用墨线图；浅色模式下是深块，用白线图）
 *   accented = 「透明」「色调」外观：一律用浅色版（不带灯光光晕，染成白色后不会变成一团白雾）
 */
type ImageMode = "normal" | "swap" | "accented"

/**
 * 关 / 开两张图。图在给它的空间里等比缩放、居中：
 * 同一排按钮的图框一样大，导出时又让同一排的车站在同一条地面线上，所以缩放后仍然对齐
 */
function partImage(slot: Slot, part: Part, open: boolean, mode: ImageMode): VirtualNode {
  const base: string = `${slot}_${part}_${open ? 1 : 0}`
  const d: string = asset(`${base}_d.png`), l: string = asset(`${base}_l.png`)
  return <Image
    filePath={mode === "accented" ? l : mode === "swap" ? { light: d, dark: l } : { light: l, dark: d }}
    resizable
    modifiers={modifiers().scaleToFit().frame({ maxWidth: "infinity", maxHeight: "infinity" })}
  />
}

// ---- 小号 ----
// 四周 16pt；部位名 13pt / 图 / 状态 20pt + 提示 13pt，行距 6pt；整个小组件是一个按钮（没有可做的指令时不是）
function Small({ part, snap, accented }: { part: Part; snap: Snap | null; accented: boolean }): VirtualNode {
  const p: PartState = partState(part, snap)
  return <Tap p={p}>
    <VStack alignment="leading" spacing={6} modifiers={modifiers().padding(16).frame({ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" })}>
      <Text font="footnote" fontWeight="semibold" foregroundStyle={DIM} lineLimit={1} minScaleFactor={FOOTNOTE_MIN}>{NAME[part]}</Text>
      {partImage("small", part, p.open, accented ? "accented" : "normal")}
      <HStack alignment="firstTextBaseline" spacing={4}>
        <Text font="title3" fontWeight="semibold" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>{p.state}</Text>
        <Spacer minLength={0} />
        <Text font="footnote" foregroundStyle={DIM} lineLimit={1} minScaleFactor={FOOTNOTE_MIN}>{p.hint}</Text>
      </HStack>
    </VStack>
  </Tap>
}

// ---- 按钮块（中号 / 大号底部） ----
// 中号：内边距上 10 / 左右 4 / 下 12，图 + 部位名 13pt + 状态 12pt；大号：上 7 / 下 6，图 + 部位名
function TileBackground({ slot, active, plain }: { slot: "medium" | "large"; active: boolean; plain: boolean }): VirtualNode {
  const fill = modifiers().frame({ maxWidth: "infinity", maxHeight: "infinity" })
  if (plain) {
    return <VStack modifiers={fill.background({ style: active ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.08)", shape: TILE_SHAPE })}>{[]}</VStack>
  }
  if (active) {
    return <VStack modifiers={fill.background({ style: ACTIVE_BG, shape: TILE_SHAPE })}>{[]}</VStack>
  }
  // 平时：暗槽底图按按钮大小拉伸（尺寸按 430pt 机型做的，其他机型只差几个点），再按小组件圆角裁切
  return <Image
    filePath={{ light: asset(`tile_${slot}_l.png`), dark: asset(`tile_${slot}_d.png`) }}
    resizable
    modifiers={modifiers().frame({ maxWidth: "infinity", maxHeight: "infinity" }).clipShape(TILE_SHAPE)}
  />
}

/** 外观：accented =「透明」「色调」外观（内容被染白）；plainBg = 不能画不透明底（accented，或 Scripting 的透明背景 / 模糊背景小组件） */
interface Look {
  accented: boolean
  plainBg: boolean
}

function Tile({ p, slot, look, showState }: { p: PartState; slot: "medium" | "large"; look: Look; showState: boolean }): VirtualNode {
  const pad = slot === "medium" ? { top: 10, leading: 4, trailing: 4, bottom: 12 } : { top: 7, leading: 4, trailing: 4, bottom: 6 }
  const active: boolean = p.open
  const flip: boolean = active && !look.plainBg
  return <Tap p={p}>
    <ZStack modifiers={modifiers().frame({ maxWidth: "infinity", maxHeight: "infinity" })}>
      <TileBackground slot={slot} active={active} plain={look.plainBg} />
      <VStack spacing={slot === "medium" ? 6 : 4} modifiers={modifiers().padding(pad).frame({ maxWidth: "infinity", maxHeight: "infinity" })}>
        {partImage(slot, p.part, p.open, look.accented ? "accented" : flip ? "swap" : "normal")}
        <VStack spacing={1}>
          <Text font="footnote" fontWeight="semibold" foregroundStyle={flip ? ACTIVE_TEXT : TEXT} lineLimit={1} minScaleFactor={FOOTNOTE_MIN}>{NAME[p.part]}</Text>
          {showState
            ? <Text font="caption" foregroundStyle={flip ? ACTIVE_STATUS : active ? TEXT : DIM} lineLimit={1} minScaleFactor={CAPTION_MIN}>{p.state}</Text>
            : null}
        </VStack>
      </VStack>
    </ZStack>
  </Tap>
}

// 按钮组：离边 11pt、间距 8pt（HIG 给按钮 / 背景形状分组用的紧凑边距）
function Medium({ snap, look }: { snap: Snap | null; look: Look }): VirtualNode {
  return <HStack spacing={8} modifiers={modifiers().padding(11).frame({ maxWidth: "infinity", maxHeight: "infinity" })}>
    {ROW_PARTS.map((part: Part) => <Tile p={partState(part, snap)} slot="medium" look={look} showState />)}
  </HStack>
}

// ---- 大号 ----
/** 状态摘要里车门的列举顺序 */
const DOOR_ORDER: DoorCommand[] = ["door_fl", "door_rl", "door_fr", "door_rr"]

/** 原型 renderVals 的第一行：开得多时合并，宽度始终放得下 */
function summary(snap: Snap | null): string {
  if (!snap) return "还没有车辆状态，打开 App 连接一次"
  const cs: Record<string, number | undefined> = snap.status.closureStatuses ?? {}
  const opened: string[] = DOOR_ORDER.filter((d: DoorCommand) => closureOpen(cs[WIDGET_DOORS[d]])).map((d: DoorCommand) => NAME[d])
  const frunk: boolean = closureOpen(cs.frontTrunk), trunk: boolean = closureOpen(cs.rearTrunk), charge: boolean = closureOpen(cs.chargePort)
  const items: string[] = []
  if (opened.length >= 3) items.push(`${opened.length} 扇车门`)
  else if (opened.length) items.push(opened.join("、"))
  if (frunk && trunk) items.push("前后备箱")
  else if (frunk) items.push("前备箱")
  else if (trunk) items.push("后备箱")
  if (charge) items.push("充电口")
  if (items.length) return items.join("、") + "已开"
  const presence: number | undefined = snap.status.userPresence
  const sleep: number | undefined = snap.status.vehicleSleepStatus
  const rest: string[] = ["车门全关"]
  if (presence === UserPresence.NOT_PRESENT) rest.push("车内无人")
  else if (presence === UserPresence.PRESENT) rest.push("车内有人")
  if (sleep === SleepStatus.ASLEEP) rest.push("车机休眠")
  else if (sleep === SleepStatus.AWAKE) rest.push("车机唤醒")
  return rest.join(" · ")
}

/** 右上角俯视小车（原型 Main.dc.html 的 SVG，车头朝左；下边两扇是左侧门，上边两扇是右侧门；车身不填充） */
function topCarSvg(cs: Record<string, number | undefined>, light: boolean): string {
  const M = light
    ? { wheel: "rgba(28,28,30,0.3)", body: "rgba(28,28,30,0.63)", glassFill: "rgba(28,28,30,0.06)", glassLine: "rgba(28,28,30,0.41)", mirror: "rgba(28,28,30,0.52)", seam: "rgba(28,28,30,0.46)", door: "#1C1C1E", glow: 0.1, closed: 0.85, faded: 0.16 }
    : { wheel: "rgba(255,255,255,0.22)", body: "rgba(255,255,255,0.5)", glassFill: "rgba(255,255,255,0.05)", glassLine: "rgba(255,255,255,0.3)", mirror: "rgba(255,255,255,0.4)", seam: "rgba(255,255,255,0.35)", door: "#FFFFFF", glow: 0.18, closed: 0.75, faded: 0.12 }
  // [门, 铰链 x, y, 关闭终点 x, 打开终点 x, y]
  const D: [string, number, number, number, number, number][] = [
    ["frontPassengerDoor", 88, 36, 140, 126.6, 1.2], ["rearPassengerDoor", 140, 36, 188, 175.7, 3.9],
    ["frontDriverDoor", 88, 116, 140, 126.6, 150.8], ["rearDriverDoor", 140, 116, 188, 175.7, 148.1],
  ]
  const doors: string = D.map(([key, x, y, cx, ox, oy]) => {
    const open: boolean = closureOpen(cs[key])
    return open
      ? `<line x1="${x}" y1="${y}" x2="${cx}" y2="${y}" stroke-width="3" opacity="${M.faded}"/><line x1="${x}" y1="${y}" x2="${ox}" y2="${oy}" stroke-width="12" stroke-opacity="${M.glow}"/><line x1="${x}" y1="${y}" x2="${ox}" y2="${oy}" stroke-width="3.5"/>`
      : `<line x1="${x}" y1="${y}" x2="${cx}" y2="${y}" stroke-width="3" opacity="${M.closed}"/>`
  }).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 152" width="260" height="152">`
    + `<g fill="${M.wheel}"><path d="M53,35 V32 Q53,29 56,29 H76 Q79,29 79,32 V35 Z M183,35 V32 Q183,29 186,29 H206 Q209,29 209,32 V35 Z"/><path d="M53,117 V120 Q53,123 56,123 H76 Q79,123 79,120 V117 Z M183,117 V120 Q183,123 186,123 H206 Q209,123 209,120 V117 Z"/></g>`
    + `<path d="M58,36 L206,36 Q230,36 230,60 L230,92 Q230,116 206,116 L58,116 Q30,116 30,90 L30,62 Q30,36 58,36 Z" fill="none" stroke="${M.body}" stroke-width="2"/>`
    + `<path d="M84,46 Q74,76 84,106 L188,104 Q197,76 188,48 Z" fill="${M.glassFill}" stroke="${M.glassLine}" stroke-width="1.5"/>`
    + `<path d="M86,36 L79,27 L94,29 Z M86,116 L79,125 L94,123 Z" fill="${M.mirror}"/>`
    + `<g stroke="${M.seam}" stroke-width="1.5"><line x1="88" y1="36" x2="88" y2="46"/><line x1="140" y1="36" x2="140" y2="46"/><line x1="188" y1="36" x2="188" y2="46"/><line x1="88" y1="116" x2="88" y2="106"/><line x1="140" y1="116" x2="140" y2="106"/><line x1="188" y1="116" x2="188" y2="106"/></g>`
    + `<g fill="none" stroke="${M.door}" stroke-linecap="round">${doors}</g></svg>`
}

function DoorHit({ part, snap, w }: { part: DoorCommand; snap: Snap | null; w: number }): VirtualNode {
  // 门已打开时没有可做的指令（只能手动关），这块区域轻点只打开 App
  return <Tap p={partState(part, snap)}>
    <Text frame={{ width: w, height: 44 }} contentShape="rect"> </Text>
  </Tap>
}

/**
 * 大号整车的尺寸：和原来一样，宽最多 345pt、高最多 158pt（1440 × 660 的比例），高度还要给标题区（102pt）、
 * 按钮组（92pt）和上下最小间距（12pt）让位；窄一点的机型按小组件实际尺寸缩小
 */
function carSize(size: { width: number; height: number }): { w: number; h: number } {
  const h: number = Math.max(0, Math.min(158, size.height - 102 - 92 - 12, (size.width - 19) * 660 / 1440))
  return { w: h * 1440 / 660, h }
}

function Large({ snap, look, size }: { snap: Snap | null; look: Look; size: { width: number; height: number } }): VirtualNode {
  const locked: boolean = snap == null || snapshotLocked(snap)
  const car = carSize(size)
  // 整车图是加宽版（1852 × 866：车头前方左边 412、上 112、下 94 是雾天车灯的光柱和雾）。
  // 车身按原来的框（car.w × car.h）摆，加宽出来的部分超出框画出去，越过小组件边缘时被小组件裁掉
  const k: number = car.w / 1440
  const cs: Record<string, number | undefined> = snap?.status.closureStatuses ?? {}
  return <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}>
    {/* 标题区离左、上 16pt；俯视图点击区离右 11pt、离上 14pt（原型：点击区 (238,14) 115×88，俯视图 130×76 在 (233,20)） */}
    <HStack alignment="top" spacing={12} modifiers={modifiers().padding({ top: 14, leading: 16, trailing: 11 })}>
      <VStack alignment="leading" spacing={2} modifiers={modifiers().padding({ top: 2 }).frame({ maxWidth: "infinity", alignment: "leading" })}>
        <Text font="title" fontWeight="semibold" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>{snap == null ? "未知" : locked ? "已上锁" : "已解锁"}</Text>
        <Text font="footnote" foregroundStyle={DIM} lineLimit={1} minScaleFactor={FOOTNOTE_MIN}>{summary(snap)}</Text>
        {snap
          ? <HStack spacing={0}>
            <Text font="footnote" foregroundStyle={DIM} lineLimit={1}>Model Y · </Text>
            <DateLabel date={new Date(snap.at)} style="time" font="footnote" foregroundStyle={DIM} lineLimit={1} />
            <Text font="footnote" foregroundStyle={DIM} lineLimit={1}> 更新</Text>
          </HStack>
          : <Text font="footnote" foregroundStyle={DIM} lineLimit={1}>Model Y</Text>}
      </VStack>
      <ZStack frame={{ width: 115, height: 88 }}>
        <SVG
          code={look.accented ? topCarSvg(cs, false) : { light: topCarSvg(cs, true), dark: topCarSvg(cs, false) }}
          resizable
          modifiers={modifiers().scaleToFit().frame({ width: 130, height: 76 }).offset({ x: 2.5, y: 0 })}
        />
        {/* 四块点击区按 B 柱和车身中线分：前门 65 × 44pt，后门 50 × 44pt（上排右侧门，下排左侧门） */}
        <VStack spacing={0}>
          <HStack spacing={0}>
            <DoorHit part="door_fr" snap={snap} w={65} />
            <DoorHit part="door_rr" snap={snap} w={50} />
          </HStack>
          <HStack spacing={0}>
            <DoorHit part="door_fl" snap={snap} w={65} />
            <DoorHit part="door_rl" snap={snap} w={50} />
          </HStack>
        </VStack>
      </ZStack>
    </HStack>
    <Spacer minLength={4} />
    {/* 整车：车身框在标题区和按钮之间上下居中（图里车身两侧有留白，车身正好对齐 16pt 边距）。
        深色版开着灯；浅色版和「透明」「色调」外观用不开灯的浅色版（同样加宽，位置完全一样） */}
    <ZStack frame={{ width: car.w, height: car.h }}>
      <Image
        filePath={look.accented ? asset("large_car_l.png") : { light: asset("large_car_l.png"), dark: asset("large_car_d.png") }}
        resizable
        modifiers={modifiers().frame({ width: 1852 * k, height: 866 * k }).offset({ x: (926 - 1132) * k, y: (433 - 442) * k })}
      />
    </ZStack>
    <Spacer minLength={8} />
    {/* 底部按钮组：高 81pt，离左右下 11pt，间距 8pt */}
    <HStack spacing={8} modifiers={modifiers().frame({ height: 81 }).padding({ leading: 11, trailing: 11, bottom: 11 })}>
      {ROW_PARTS.map((part: Part) => <Tile p={partState(part, snap)} slot="large" look={look} showState={false} />)}
    </HStack>
  </VStack>
}

// ---- 入口 ----

function smallPart(): Part {
  const raw: string = String(Widget.parameter ?? "").trim().toLowerCase()
  return (SMALL_PARTS as string[]).includes(raw) ? (raw as Part) : "lock"
}

function View({ missing }: { missing: string | null }): VirtualNode {
  const snap: Snap | null = loadSnapshot()
  const family = Widget.family
  const size = Widget.displaySize
  // 锁屏尺寸（先只做主屏幕）：只显示一行锁状态，不放按钮和图
  if (family === "accessoryCircular" || family === "accessoryRectangular" || family === "accessoryInline") {
    return <Text font="headline" lineLimit={1} minScaleFactor={0.7}>{snap == null ? "Tesla" : snapshotLocked(snap) ? "已上锁" : "已解锁"}</Text>
  }
  return <EnvironmentValuesReader keys={["widgetRenderingMode"]}>
    {(env) => {
      const accented: boolean = env.widgetRenderingMode === "accented"
      const look: Look = { accented, plainBg: accented || Widget.isTransparentMode || Widget.isBlurMode }
      let body: VirtualNode
      if (family === "systemLarge" || family === "systemExtraLarge" || family === "systemExtraLargePortrait") {
        body = <Large snap={snap} look={look} size={size} />
      } else if (family === "systemMedium") {
        body = <Medium snap={snap} look={look} />
      } else {
        body = <Small part={smallPart()} snap={snap} accented={accented} />
      }
      return <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} widgetBackground={BG}>
        {body}
        {missing ? <Text font="caption" foregroundStyle="red" lineLimit={1} minScaleFactor={0.8} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottom" }}>{missing}</Text> : null}
      </ZStack>
    }}
  </EnvironmentValuesReader>
}

/**
 * 图片在 Scripting 的 iCloud Drive 容器里（2026-10-18 实测：开发服务器只同步代码、不同步图片，图片是在 Mac 上直接复制进
 * ~/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Tesla Key/assets/ 再由 iCloud 同步到手机的）。
 * 手机上的 iCloud 文件可能只有占位、没有下载，小组件进程不会自己去下：每次渲染前把还没下载的图片下载下来（已下载的直接跳过）。
 * 必需的图还是读不到时，在小组件底部用一行红字提示（正常时不显示）
 */
async function ensureAssets(): Promise<string | null> {
  const r2: string = Path.join(Script.directory, "assets", ASSET_DIR)
  try {
    if (!FileManager.existsSync(r2)) await FileManager.downloadFileFromiCloud(r2).catch(() => false)
    if (FileManager.existsSync(r2)) {
      // 没下载的文件在目录里显示为「.名字.icloud」占位
      const names: string[] = FileManager.readDirectorySync(r2).map((n: string) => n.replace(/^\.(.+)\.icloud$/, "$1")).filter((n: string) => n.endsWith(".png"))
      const todo: string[] = names.map((n: string) => Path.join(r2, n)).filter((f: string) => {
        try {
          return !FileManager.existsSync(f) || (FileManager.isFileStoredIniCloud(f) && !FileManager.isiCloudFileDownloaded(f))
        } catch (_e) {
          return true
        }
      })
      if (todo.length) await Promise.all(todo.map((f: string) => FileManager.downloadFileFromiCloud(f).catch(() => false)))
    }
    const missing: number = REQUIRED_ASSETS.filter((n: string) => !FileManager.existsSync(asset(n))).length
    return missing ? `图片未同步（缺 ${missing} 张），请检查 iCloud` : null
  } catch (_e) {
    return "图片读取失败，请检查 iCloud"
  }
}

/**
 * 刷新策略：15 分钟后请求刷新（系统按刷新预算决定实际时间）。小组件只读手机上的快照、不连车，
 * 定时刷新只为跟上 App 里读到的新状态和「HH:MM 更新」；指令执行完 AppIntent 会立刻 Widget.reloadAll()
 */
const RELOAD_AFTER_MS: number = 15 * 60 * 1000

ensureAssets().then((missing: string | null) =>
  Widget.present(<View missing={missing} />, { policy: "after", date: new Date(Date.now() + RELOAD_AFTER_MS) }))
