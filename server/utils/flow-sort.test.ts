import { describe, expect, it } from 'vitest'
import { planFlowInsertAbove, sortRegularFlows } from './flow-sort'

/**
 * 複製模組要排在原模組正上方（`planFlowInsertAbove`）。
 *
 * 以前複製出來的一律排在整份清單最上面，模組一多就要捲到頂、再一路拖回原本的資料夾。
 */

const at = (ms: number) => ({ toMillis: () => ms })
const flow = (id: string, extra: Record<string, unknown> = {}) => ({ id, createdAt: at(1), ...extra })

/** 照算出來的值套回去，再用側欄同一套排序排一次，看新模組最後落在哪 */
function applied(flows: ReturnType<typeof flow>[], newId: string, anchorId: string) {
  const plan = planFlowInsertAbove(flows, anchorId)!
  const byId = new Map(plan.updates.map(u => [u.id, u.sortOrder]))
  const rows = flows.map(f => (byId.has(f.id) ? { ...f, sortOrder: byId.get(f.id) } : f))
  rows.push({ id: newId, createdAt: at(999), sortOrder: plan.sortOrder })
  return sortRegularFlows(rows).map(f => f.id)
}

describe('planFlowInsertAbove（複製的模組排在原模組正上方）', () => {
  it('插在中間：新模組就在原模組上面一格，其他人順序不變', () => {
    const flows = [flow('a', { sortOrder: 0 }), flow('b', { sortOrder: 1 }), flow('c', { sortOrder: 2 })]
    expect(applied(flows, 'new', 'b')).toEqual(['a', 'new', 'b', 'c'])
  })

  it('只回「值真的變了」的那幾個（原模組上面的不用動）', () => {
    const flows = [flow('a', { sortOrder: 0 }), flow('b', { sortOrder: 1 }), flow('c', { sortOrder: 2 })]
    expect(planFlowInsertAbove(flows, 'b')).toEqual({
      sortOrder: 1,
      updates: [{ id: 'b', sortOrder: 2 }, { id: 'c', sortOrder: 3 }],
    })
  })

  it('原模組在最上面：新模組變第一個', () => {
    const flows = [flow('a', { sortOrder: 0 }), flow('b', { sortOrder: 1 })]
    expect(applied(flows, 'new', 'a')).toEqual(['new', 'a', 'b'])
  })

  it('⛔ 兩個模組排序值一樣（舊資料）：照側欄看到的順序算，不會跑到更上面', () => {
    // 側欄：排序值一樣時新建的在上面（list.get 是 createdAt 新→舊）＝ b、a、c
    const flows = [
      flow('a', { sortOrder: 5, createdAt: at(100) }),
      flow('b', { sortOrder: 5, createdAt: at(200) }),
      flow('c', { sortOrder: 6 }),
    ]
    expect(sortRegularFlows([flows[1]!, flows[0]!, flows[2]!]).map(f => f.id)).toEqual(['b', 'a', 'c'])
    expect(applied(flows, 'new', 'a')).toEqual(['b', 'new', 'a', 'c'])
  })

  it('舊資料沒有 sortOrder（照 createdAt 新→舊）也排得對，而且之後都有整數排序值', () => {
    const flows = [flow('old', { createdAt: at(100) }), flow('older', { createdAt: at(50) })]
    expect(applied(flows, 'new', 'older')).toEqual(['old', 'new', 'older'])
    const plan = planFlowInsertAbove(flows, 'older')!
    expect(plan.updates).toEqual([{ id: 'old', sortOrder: 0 }, { id: 'older', sortOrder: 2 }])
  })

  it('找不到原模組（系統模組、剛被刪掉）：回 null，由呼叫端排最上面', () => {
    expect(planFlowInsertAbove([flow('a', { sortOrder: 0 })], 'gone')).toBeNull()
  })
})
