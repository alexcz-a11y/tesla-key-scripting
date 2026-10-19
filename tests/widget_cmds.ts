// 小组件指令逻辑测试：防重复执行（closureRequest）、到位判断（targetReached）、等车辆到位（waitForTarget）、单门弹开标记（nextSelective）。
// 都是纯函数，不连车。入口：调试页「小组件指令测试」，或在 Mac 上 npx tsx tests/widget_cmds_node.ts
import { ClosureMove, ClosureState, LockState } from "../core/proto_consts"
import { closureRequest, isLockedState, nextSelective, targetReached, waitForTarget, WidgetCommand } from "../core/widget_cmds"

interface Result { name: string; ok: boolean; detail?: string }

export async function runWidgetCmds(): Promise<string> {
  const results: Result[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    results.push({ name, ok, detail: ok ? undefined : detail })
  }
  const { OPEN, AJAR, CLOSED, OPENING, CLOSING } = ClosureState

  // 1. 防重复执行：已经到位就不发
  check("门关着 → 弹开", JSON.stringify(closureRequest("door_fl", { frontDriverDoor: CLOSED })) === JSON.stringify({ frontDriverDoor: ClosureMove.OPEN }))
  check("门已开 → 不发", closureRequest("door_fl", { frontDriverDoor: OPEN }) === null)
  check("门半开 → 不发", closureRequest("door_rr", { rearPassengerDoor: AJAR }) === null)
  check("前备箱关着 → MOVE", closureRequest("frunk_open", { frontTrunk: CLOSED })?.frontTrunk === ClosureMove.MOVE)
  check("前备箱已开 → 不发（MOVE 是切换，再发会关上）", closureRequest("frunk_open", { frontTrunk: OPEN }) === null)
  check("后备箱正在打开 → 不发", closureRequest("trunk_open", { rearTrunk: OPENING }) === null)
  check("后备箱关着 → MOVE", closureRequest("trunk_open", {})?.rearTrunk === ClosureMove.MOVE)
  check("关后备箱用 CLOSE（重复发安全）", closureRequest("trunk_close", { rearTrunk: OPEN })?.rearTrunk === ClosureMove.CLOSE)
  check("充电口开 / 关用 OPEN / CLOSE", closureRequest("charge_open", {})?.chargePort === ClosureMove.OPEN && closureRequest("charge_close", {})?.chargePort === ClosureMove.CLOSE)

  // 2. 到位判断
  check("车内上锁也算锁着", isLockedState(LockState.INTERNAL_LOCKED) && isLockedState(LockState.LOCKED) && !isLockedState(LockState.UNLOCKED))
  check("上锁到位（含车内上锁）", targetReached("lock", { vehicleLockState: LockState.INTERNAL_LOCKED }))
  check("解锁未到位", !targetReached("unlock", { vehicleLockState: LockState.LOCKED }))
  check("后备箱半开算打开到位", targetReached("trunk_open", { closureStatuses: { rearTrunk: AJAR } }))
  check("后备箱正在打开不算到位", !targetReached("trunk_open", { closureStatuses: { rearTrunk: OPENING } }))
  check("后备箱正在关闭不算关好", !targetReached("trunk_close", { closureStatuses: { rearTrunk: CLOSING } }))
  check("充电口没报状态算关着", targetReached("charge_close", { closureStatuses: {} }))

  // 3. 等车辆到位：第 3 次读到才到位
  let reads: number = 0
  const seq: number[] = [OPENING, OPENING, OPEN]
  const w = await waitForTarget("trunk_open" as WidgetCommand, async () => ({ closureStatuses: { rearTrunk: seq[Math.min(reads++, seq.length - 1)] } }))
  check("轮询到到位为止", w.reached && reads === 3, `reached=${w.reached} reads=${reads}`)

  // 4. 中途读取出错：用最后一次读到的
  let n: number = 0
  const w2 = await waitForTarget("trunk_close" as WidgetCommand, async () => {
    if (n++ === 1) throw new Error("断开")
    return { closureStatuses: { rearTrunk: CLOSING } }
  })
  check("读取出错保留最后一次结果", w2.status?.closureStatuses?.rearTrunk === CLOSING && !w2.reached, JSON.stringify(w2.status))

  // 5. 单门弹开标记
  check("整车锁着时弹开单门 → 置上", nextSelective(false, "door_fl", true, LockState.UNLOCKED))
  check("解锁 / 上锁 → 清掉", !nextSelective(true, "unlock", false, LockState.UNLOCKED) && !nextSelective(true, "lock", false, LockState.UNLOCKED))
  check("车辆重新报上锁 → 清掉", !nextSelective(true, null, false, LockState.LOCKED))
  check("其他情况保持", nextSelective(true, "trunk_open", false, LockState.UNLOCKED) && !nextSelective(false, "door_fl", false, LockState.UNLOCKED))

  const failed: Result[] = results.filter((r: Result) => !r.ok)
  const lines: string[] = results.map((r: Result) => `${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? "  → " + r.detail : ""}`)
  return `${results.length - failed.length}/${results.length} passed\n` + lines.join("\n")
}
