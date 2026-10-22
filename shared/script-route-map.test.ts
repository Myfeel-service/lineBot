import { describe, expect, it } from 'vitest'
import { buildRouteMap } from './script-route-map'
import { moveQuestion, toQuestionList } from './script-question-list'
import type { ScriptNode } from './types/ai-script'

/** 正式站 MYFEEL「查詢訂單」的骨架（同 script-question-list.test.ts） */
function orderFlow(): ScriptNode[] {
  return [
    { id: 't', type: 'trigger', matchMode: 'semantic', keywords: [], examples: ['我想查訂單'], priority: 50, next: 'c_id' },
    { id: 'c_id', type: 'collect', question: '請問您的訂單編號是？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', next: 'save', skipLabel: '我沒有訂單編號', skipNext: 'q_mail' },
    { id: 'q_mail', type: 'quickReply', question: '方便提供 Email 嗎？', expireMs: 600000, options: [{ label: '提供 Email', next: 'c_mail' }, { label: '沒有 Email', next: 'c_name' }] },
    { id: 'c_mail', type: 'collect', question: '請提供 Email', fieldName: 'email', expireMs: 600000, format: 'email', next: 'save' },
    { id: 'c_name', type: 'collect', question: '請問大名？', fieldName: 'name', expireMs: 600000, format: 'any', next: 'c_phone' },
    { id: 'c_phone', type: 'collect', question: '請留電話', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 'save' },
    { id: 'save', type: 'saveLead', fieldMap: [{ fromField: 'order_id', attrKey: '訂單編號' }], next: 'r' },
    { id: 'r', type: 'reply', text: '已收到', thenHandoff: true },
  ]
}

describe('路線圖（D-142）', () => {
  it('MYFEEL 查詢訂單：照示意第⑥張——三條繞道、三圈、一個跨線', () => {
    const m = buildRouteMap(toQuestionList(orderFlow(), 't')!)
    expect(m.stationIds).toEqual(['c_id', 'q_mail', 'c_mail', 'c_name', 'c_phone', 'save'])
    // 1→2（客人說沒有）、2→3（提供 Email）、4→5、5→最後是直線；3→4 沒有線（Email 答了直接到最後）
    expect(m.rails).toEqual([true, true, false, true, true])
    const byRoute = Object.fromEntries(m.brackets.map(b => [`${b.from}>${b.to}`, b]))
    expect(Object.keys(byRoute).sort()).toEqual(['0>5', '1>3', '2>5'])
    expect(byRoute['1>3']).toMatchObject({ labels: ['沒有 Email'], lane: 0, backward: false })
    expect(byRoute['2>5']).toMatchObject({ labels: ['答了'], lane: 1 })
    expect(byRoute['0>5']).toMatchObject({ labels: ['答了'], lane: 2 })
    expect(m.laneCount).toBe(3)
    // Email（第 3 站）答了往右出去，經過「沒有 Email」那條（第 2→4 站）的直線
    expect(m.hops).toEqual([{ lane: 0, station: 2 }])
  })

  it('⛔ 一條直線（每一題都只接下一題）沒有繞道——畫面上不畫這張圖', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', matchMode: 'semantic', keywords: [], examples: ['x'], priority: 50, next: 'a' },
      { id: 'a', type: 'collect', question: 'A?', fieldName: 'name', expireMs: 1, format: 'any', next: 'b' },
      { id: 'b', type: 'collect', question: 'B?', fieldName: 'phone', expireMs: 1, format: 'phone', next: 'r', skipLabel: '先跳過', skipNext: 'r' },
      { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    const m = buildRouteMap(toQuestionList(nodes, 't')!)
    expect(m.brackets).toEqual([])
    expect(m.rails).toEqual([true, true])
  })

  it('同一段兩條路（答了、客人說沒有都跳到最後）合成一條、兩個標籤', () => {
    const nodes = orderFlow()
    ;(nodes[1] as any).skipNext = 'save'
    const m = buildRouteMap(toQuestionList(nodes, 't')!)
    const b = m.brackets.find(x => x.from === 0 && x.to === 5)!
    expect(b.labels).toEqual(['答了', '我沒有訂單編…'])
  })

  it('換順序後往回跳：標成往回、照樣有一圈', () => {
    const nodes = orderFlow()
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 3, 0) // 姓名拖到最上面 → 「沒有 Email」往回跳到第 1 站
    const m = buildRouteMap(toQuestionList(nodes, 't')!)
    const back = m.brackets.find(b => b.backward)!
    expect(back).toMatchObject({ from: 2, to: 0 })
    expect(back.lane).toBeGreaterThanOrEqual(0)
  })

  it('隔壁一圈同一格已經有標籤：往旁邊的格子挪，不疊在一起', () => {
    // 第 1 站答了跳第 4 站、第 2 站客人說沒有也跳第 4 站：兩條在相鄰兩圈、正中間都落在第 2～3 站之間
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', matchMode: 'semantic', keywords: [], examples: ['x'], priority: 50, next: 'a' },
      { id: 'a', type: 'collect', question: 'A?', fieldName: 'f1', expireMs: 1, format: 'any', next: 'd', skipLabel: '沒有', skipNext: 'b' },
      { id: 'b', type: 'collect', question: 'B?', fieldName: 'f2', expireMs: 1, format: 'any', next: 'c', skipLabel: '沒有', skipNext: 'd' },
      { id: 'c', type: 'collect', question: 'C?', fieldName: 'f3', expireMs: 1, format: 'any', next: 'd' },
      { id: 'd', type: 'collect', question: 'D?', fieldName: 'f4', expireMs: 1, format: 'any', next: 'r' },
      { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    const m = buildRouteMap(toQuestionList(nodes, 't')!)
    const outer = m.brackets.find(b => b.from === 0 && b.to === 3)!
    const inner = m.brackets.find(x => x.from === 1 && x.to === 3)!
    expect([inner.lane, outer.lane]).toEqual([0, 1])
    expect(inner.labelGap).toBe(1) // 正中間
    expect(outer.labelGap).toBe(0) // 正中間被隔壁那圈佔了，挪到旁邊
  })

  it('好幾種結尾（服務分流，`D-149`）：每一種結尾一站，按鈕直接繞到各自那一站', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['客服選單'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '?', expireMs: 1, options: [{ label: '出貨查詢', next: 'r1' }, { label: '退換貨', next: 'tg' }, { label: '找真人', next: 'r3' }] },
      { id: 'r1', type: 'reply', text: '1', thenHandoff: false },
      { id: 'tg', type: 'tag', addTagIds: [], next: 'r2' },
      { id: 'r2', type: 'reply', text: '2', thenHandoff: true },
      { id: 'r3', type: 'reply', text: '3', thenHandoff: true },
    ]
    const m = buildRouteMap(toQuestionList(nodes, 't')!)
    expect(m.stationIds).toEqual(['q', 'r1', 'tg', 'r3'])
    expect(m.rails).toEqual([true, false, false]) // 出貨查詢＝緊接下一站；結尾跟結尾之間沒有線
    expect(m.brackets.map(b => [b.from, b.to, b.labels.join()])).toEqual([[0, 2, '退換貨'], [0, 3, '找真人']])
  })

  it('看答案走不同路（`D-150`①）：分路掛在那一題上、不是一站；每一條標答案、其他答案標「其他」', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'c' },
      { id: 'c', type: 'collect', question: '會員等級？', fieldName: 'level', expireMs: 1, format: 'any', next: 'b' },
      { id: 'b', type: 'branch', cases: [{ field: 'level', op: 'equals', value: 'VIP', next: 'r_vip' }, { field: 'level', op: 'contains', value: '金卡', next: 'r_vip' }], defaultNext: 'c2' },
      { id: 'c2', type: 'collect', question: '電話？', fieldName: 'phone', expireMs: 1, format: 'phone', next: 'r_all' },
      { id: 'r_vip', type: 'reply', text: 'VIP', thenHandoff: true },
      { id: 'r_all', type: 'reply', text: '一般', thenHandoff: false },
    ]
    const m = buildRouteMap(toQuestionList(nodes, 't')!)
    expect(m.stationIds).toEqual(['c', 'c2', 'r_vip', 'r_all'])
    expect(m.rails).toEqual([true, false, false]) // 其他答案 → 下一題＝直線
    expect(m.brackets.map(b => [b.from, b.to, b.labels.join('、')])).toEqual([[0, 2, 'VIP、金卡'], [1, 3, '答了']])
  })

  it('路上貼了標籤的照樣畫到真正的去處；排不進清單的步驟不畫', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '?', expireMs: 1, options: [{ label: '出貨', next: 'r1' }, { label: '退換貨', next: 'tg' }] },
      { id: 'tg', type: 'tag', addTagIds: ['退貨'], next: 'c', onRoute: true },
      { id: 'c', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 1, format: 'any', next: 'r1' },
      { id: 'r1', type: 'reply', text: '好', thenHandoff: false },
    ]
    const m = buildRouteMap(toQuestionList(nodes, 't')!)
    expect(m.stationIds).toEqual(['q', 'c', 'r1'])
    expect(m.brackets.map(b => [b.from, b.to, b.labels.join()])).toEqual([[0, 2, '出貨']])
    expect(m.rails).toEqual([true, true]) // 退換貨（路上貼標籤）→ 下一題、答了 → 最後
  })

  it('標籤放在跨過的範圍正中間那一格（站與站之間）', () => {
    const m = buildRouteMap(toQuestionList(orderFlow(), 't')!)
    const gap = (from: number, to: number) => m.brackets.find(b => b.from === from && b.to === to)!.labelGap
    expect(gap(1, 3)).toBe(1) // 第 2、3 站之間
    expect(gap(0, 5)).toBe(2) // 第 3、4 站之間
    expect(gap(2, 5)).toBe(3) // 第 4、5 站之間
  })
})
