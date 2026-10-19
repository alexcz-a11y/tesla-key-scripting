// G「色块版面」组件：按 390×844 设计稿尺寸、用嵌套 VStack / HStack（间距 0）拼版，按屏幕尺寸等比缩放
// 规范：全直角；每块只描自身 1px 黑边、块内不放分隔线；英文状态用 Didot，中文部件名用宋体常规字重
// 布局写法依据本地文档：ZStack 文档「与 VStack、HStack 结合」、frame 文档「精确尺寸用固定 width/height」、
// status_bar 文档的全屏样例 `<VStack frame={Device.screen}>`、safe_area 文档的 ignoresSafeArea
import { Button, HStack, ShapeStyle, Spacer, Text, VirtualNode, VStack, ZStack } from "scripting"

export const C: Record<"paper" | "cream" | "ink" | "vermilion" | "cobalt" | "white", ShapeStyle> = {
  paper: "#E9DFCB",
  cream: "#F2EBDD",
  ink: "#111111",
  vermilion: "#F24B24",
  cobalt: "#1C3FBF",
  white: "#FFFFFF",
}

// 字体用 PostScript 名称（FontPicker 文档：自定义字体按 PostScript 名称指定）
const EN: string = "Didot"
const EN_ITALIC: string = "Didot-Italic"
const ZH: string = "STSongti-SC-Regular"

const DESIGN_W: number = 390
const DESIGN_H: number = 844
/** 贴屏幕底边的块，内容离底边的距离（设计稿值，避开 Home 条） */
export const BOTTOM_PAD: number = 46

export interface Geo {
  sx: number
  sy: number
  /** 字号与内边距缩放 */
  f: number
}

/** 整屏画板：屏幕大小的 VStack，外层 ZStack 忽略安全区，背景铺满 */
// 不能用函数作 children：实测 Scripting 会把 children 包成数组（日志：p.children is an instance of Array）
export function Board(p: { render: (g: Geo) => VirtualNode }): VirtualNode {
  const W: number = Device.screen.width
  const H: number = Device.screen.height
  const sx: number = W / DESIGN_W
  const sy: number = H / DESIGN_H
  const g: Geo = { sx, sy, f: Math.min(sx, sy) }
  let content: VirtualNode
  try {
    content = p.render(g)
  } catch (e: any) {
    console.error("[Board] 渲染出错: " + String(e?.message ?? e) + "\n" + String(e?.stack ?? ""))
    content = <Text foregroundStyle="red">{"渲染出错：" + String(e?.message ?? e)}</Text>
  }
  return <ZStack ignoresSafeArea background={C.paper}>
    <VStack alignment="leading" spacing={0} frame={{ width: W, height: H, alignment: "topLeading" }}>
      {content}
    </VStack>
  </ZStack>
}

/** 一行：块从左到右紧贴 */
type Kids = VirtualNode | (VirtualNode | undefined | null | (VirtualNode | undefined | null)[])[]

export function Row(p: { children: Kids }): VirtualNode {
  return <HStack alignment="top" spacing={0}>{p.children}</HStack>
}

/** 一列：块从上到下紧贴 */
export function Col(p: { children: Kids }): VirtualNode {
  return <VStack alignment="leading" spacing={0}>{p.children}</VStack>
}

type Pad = { top?: number; leading?: number; bottom?: number; trailing?: number }

export interface TileProps {
  g: Geo
  /** 设计稿尺寸 */
  w: number
  h: number
  bg?: ShapeStyle
  fg?: ShapeStyle
  /** 设计稿单位，默认上下 10、左右 12 */
  pad?: Pad
  action?: () => void
  disabled?: boolean
  /** 正在执行时降低不透明度 */
  busy?: boolean
  a11y?: string
  children: VirtualNode | (VirtualNode | null)[]
}

/**
 * 一个独立方块：固定尺寸，1px 黑边（相邻块各描 0.5，合起来 1px）。
 * 外层 ZStack 管尺寸 / 底色 / 描边，内层 VStack 管内边距，避免同一个视图上多个修饰器的先后顺序影响结果。
 */
export function Tile(p: TileProps): VirtualNode {
  const { g } = p
  const pad: Pad = p.pad ?? {}
  const box: VirtualNode = <ZStack
    alignment="topLeading"
    frame={{ width: p.w * g.sx, height: p.h * g.sy, alignment: "topLeading" }}
    background={p.bg ?? C.cream}
    border={{ style: C.ink, width: 0.5 }}
    clipped
    opacity={p.busy ? 0.55 : 1}
    accessibilityLabel={p.a11y}
  >
    <VStack
      alignment="leading"
      spacing={0}
      foregroundStyle={p.fg ?? C.ink}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
      padding={{
        top: (pad.top ?? 10) * g.f,
        leading: (pad.leading ?? 12) * g.f,
        bottom: (pad.bottom ?? 10) * g.f,
        trailing: (pad.trailing ?? 12) * g.f,
      }}
    >
      {p.children}
    </VStack>
  </ZStack>
  if (!p.action) return box
  return <Button action={p.action} buttonStyle="plain" disabled={p.disabled}>{box}</Button>
}

/**
 * Didot / 宋体没有箭头字形，iOS 回退到系统字体时 ↗ 等会按 emoji 显示。
 * 在箭头后加 U+FE0E（文本样式变体选择符）强制按文字显示。
 */
function textArrows(c: string | string[]): string {
  // children 传进来是数组（Scripting 会把 children 包成数组，见 Board 的说明）
  const t: string = Array.isArray(c) ? c.join("") : String(c)
  return t.replace(/([←→↑↓↗↘↖↙])\uFE0E?/g, "$1\uFE0E")
}

/** 英文状态字（Didot） */
export function En(p: { g: Geo; size: number; italic?: boolean; color?: ShapeStyle; children: string; fixed?: boolean; kerning?: number }): VirtualNode {
  return <Text
    font={{ name: p.italic ? EN_ITALIC : EN, size: p.size * p.g.f }}
    foregroundStyle={p.color}
    lineLimit={1}
    minScaleFactor={p.fixed ? undefined : 0.5}
    fixedSize={p.fixed ? { horizontal: true, vertical: true } : undefined}
    kerning={p.kerning != null ? p.kerning * p.g.f : undefined}
  >{textArrows(p.children)}</Text>
}

/** 中文部件名 / 操作（宋体常规字重，不用粗体） */
export function Zh(p: { g: Geo; size?: number; color?: ShapeStyle; children: string; kerning?: number }): VirtualNode {
  return <Text
    font={{ name: ZH, size: (p.size ?? 12) * p.g.f }}
    foregroundStyle={p.color}
    lineLimit={1}
    minScaleFactor={0.6}
    kerning={p.kerning != null ? p.kerning * p.g.f : undefined}
  >{textArrows(p.children)}</Text>
}

/** 上下两端分布：top 在顶，bottom 在底 */
export function Ends(p: { top: VirtualNode; bottom: VirtualNode }): VirtualNode {
  return <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
    {p.top}
    <Spacer minLength={0} />
    {p.bottom}
  </VStack>
}

/** 内容压在底部，行间距 6 */
export function Bottom(p: { g: Geo; children: VirtualNode | VirtualNode[] }): VirtualNode {
  return <VStack alignment="leading" spacing={6 * p.g.f} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomLeading" }}>
    <Spacer minLength={0} />
    {p.children}
  </VStack>
}

/** 左边一组、右下角一个小标签 */
export function Split(p: { left: VirtualNode; right: VirtualNode }): VirtualNode {
  return <HStack alignment="bottom" spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomLeading" }}>
    {p.left}
    <Spacer minLength={4} />
    {p.right}
  </HStack>
}

/** 状态 + 部件名两行 */
export function Pair(p: { g: Geo; en: string; size: number; zh: string; color?: ShapeStyle }): VirtualNode {
  return <VStack alignment="leading" spacing={6 * p.g.f}>
    <En g={p.g} size={p.size} color={p.color}>{p.en}</En>
    <Zh g={p.g} color={p.color}>{p.zh}</Zh>
  </VStack>
}

/** 子页面顶部一行：黑色返回块 + 页面名块 */
export function PageHeader(p: { g: Geo; back: string; title: string; subtitle: string; onBack: () => void; onTitle?: () => void; titleA11y?: string }): VirtualNode {
  const { g } = p
  return <Row>
    <Tile g={g} w={110} h={124} bg={C.ink} fg={C.cream} pad={{ bottom: 12 }} action={p.onBack} a11y={"返回" + p.back}>
      <Bottom g={g}>
        <En g={g} size={34}>←</En>
        <Zh g={g}>{p.back}</Zh>
      </Bottom>
    </Tile>
    <Tile g={g} w={280} h={124} pad={{ bottom: 12 }} action={p.onTitle} a11y={p.titleA11y}>
      <Bottom g={g}>
        <Zh g={g} size={26}>{p.title}</Zh>
        <En g={g} size={13} italic>{p.subtitle}</En>
      </Bottom>
    </Tile>
  </Row>
}
