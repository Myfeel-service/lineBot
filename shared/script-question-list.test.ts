import { describe, expect, it } from 'vitest'
import { appendQuestion, insertEndStep, isBackwardTarget, moveQuestion, orderNextOf, removeEndStep, removeQuestion, replaceTerminal, toQuestionList } from './script-question-list'
import { validateScriptDoc, type ScriptNode } from './types/ai-script'

/** 正式站 MYFEEL「查詢訂單」的骨架（2026-10-21 唯讀查到的節點順序） */
function orderFlow(): ScriptNode[] {
  return [
    { id: 't', type: 'trigger', matchMode: 'semantic', keywords: ['訂單'], examples: ['我想查訂單'], priority: 50, next: 'c_id' },
    { id: 'c_id', type: 'collect', question: '請問您的訂單編號是？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', next: 'save', skipLabel: '我沒有訂單編號', skipNext: 'q_mail' },
    { id: 'q_mail', type: 'quickReply', question: '方便提供 Email 嗎？', expireMs: 600000, options: [{ label: '提供 Email', next: 'c_mail' }, { label: '沒有 Email', next: 'c_name' }] },
    { id: 'c_mail', type: 'collect', question: '請提供 Email', fieldName: 'email', expireMs: 600000, format: 'email', next: 'save' },
    { id: 'c_name', type: 'collect', question: '請問大名？', fieldName: 'name', expireMs: 600000, format: 'any', next: 'c_phone' },
    { id: 'c_phone', type: 'collect', question: '請留電話', fieldName: 'phone', expireMs: 600000, format: 'phone', next: 'save' },
    { id: 'save', type: 'saveLead', fieldMap: [{ fromField: 'order_id', attrKey: '訂單編號' }, { fromField: 'email', attrKey: 'Email' }, { fromField: 'name', attrKey: '姓名' }, { fromField: 'phone', attrKey: '電話' }], next: 'r' },
    { id: 'r', type: 'reply', text: '已收到您的資訊', thenHandoff: true },
  ]
}

describe('toQuestionList（哪些流程可以用問答清單編）', () => {
  it('MYFEEL 查詢訂單：五題照順序、最後一段從「存進客人資料」開始', () => {
    const v = toQuestionList(orderFlow(), 't')!
    expect(v.items.map(i => i.id)).toEqual(['c_id', 'q_mail', 'c_mail', 'c_name', 'c_phone'])
    expect(v.endId).toBe('save')
    expect(v.terminal.id).toBe('r')
    expect(v.saveLead?.id).toBe('save')
  })

  it('一句話回一件事（開始 → 回覆）也是清單：沒有題目', () => {
    const v = toQuestionList([
      { id: 't', type: 'trigger', keywords: ['抽獎'], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: '活動說明', thenHandoff: false },
    ], 't')!
    expect(v.items).toEqual([])
    expect(v.endId).toBe('r')
  })

  it('⛔ 好幾個結尾（服務分流）、有依答案分路的 → 不是清單，照舊用流程圖', () => {
    expect(toQuestionList([
      { id: 't', type: 'trigger', keywords: ['選單'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '?', expireMs: 1, options: [{ label: 'a', next: 'r1' }, { label: 'b', next: 'r2' }] },
      { id: 'r1', type: 'reply', text: '1', thenHandoff: false },
      { id: 'r2', type: 'reply', text: '2', thenHandoff: false },
    ], 't')).toBeNull()
    expect(toQuestionList([
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'b' },
      { id: 'b', type: 'branch', cases: [], defaultNext: 'r' },
      { id: 'r', type: 'reply', text: '1', thenHandoff: false },
    ], 't')).toBeNull()
  })

  it('⛔ 開頭接的不是第一題（節點順序跟走的順序對不上）→ 不是清單，免得「第 1 題」講錯', () => {
    const nodes = orderFlow()
    ;(nodes[0] as any).next = 'c_name'
    expect(toQuestionList(nodes, 't')).toBeNull()
  })
})

describe('清單上的增刪：改完一律還是合法的流程', () => {
  const valid = (nodes: ScriptNode[]) => validateScriptDoc({ name: 'x', nodes, rootNodeId: 't' })

  it('加一題：原本最後一題「答了 → 最後」改接新的這題；前面「答得出就收尾」的不動', () => {
    const nodes = orderFlow()
    const v = toQuestionList(nodes, 't')!
    appendQuestion(nodes, v, { id: 'c_addr', type: 'collect', question: '新地址？', fieldName: 'address', expireMs: 600000, format: 'any', next: '' })
    const after = toQuestionList(nodes, 't')!
    expect(after.items.map(i => i.id)).toEqual(['c_id', 'q_mail', 'c_mail', 'c_name', 'c_phone', 'c_addr'])
    expect((nodes.find(n => n.id === 'c_phone') as any).next).toBe('c_addr')
    expect((nodes.find(n => n.id === 'c_id') as any).next).toBe('save')
    expect((nodes.find(n => n.id === 'c_addr') as any).next).toBe('save')
    expect(valid(nodes)).toBeNull()
  })

  it('沒有題目時加第一題：開頭改接它', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['抽獎'], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: '好', thenHandoff: false },
    ]
    appendQuestion(nodes, toQuestionList(nodes, 't')!, { id: 'c', type: 'collect', question: '大名？', fieldName: 'name', expireMs: 600000, format: 'any', next: '' })
    expect((nodes[0] as any).next).toBe('c')
    expect(toQuestionList(nodes, 't')!.items.map(i => i.id)).toEqual(['c'])
    expect(valid(nodes)).toBeNull()
  })

  it('拿掉一題：指到它的路改接它的下一步；存進客人資料裡那個欄位一起拿掉', () => {
    const nodes = orderFlow()
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'c_name')
    expect((nodes.find(n => n.id === 'q_mail') as any).options[1].next).toBe('c_phone')
    expect((nodes.find(n => n.id === 'save') as any).fieldMap.map((m: any) => m.fromField)).toEqual(['order_id', 'email', 'phone'])
    expect(valid(nodes)).toBeNull()
  })

  it('貼標籤掛在最後一段最前面、拿掉後接回原樣', () => {
    const nodes = orderFlow()
    insertEndStep(nodes, toQuestionList(nodes, 't')!, { id: 'tag', type: 'tag', addTagIds: ['vip'], next: '' })
    const v = toQuestionList(nodes, 't')!
    expect(v.endId).toBe('tag')
    expect(v.tag?.next).toBe('save')
    expect((nodes.find(n => n.id === 'c_id') as any).next).toBe('tag')
    expect(valid(nodes)).toBeNull()
    removeEndStep(nodes, 'tag')
    expect(toQuestionList(nodes, 't')!.endId).toBe('save')
    expect((nodes.find(n => n.id === 'c_id') as any).next).toBe('save')
  })

  it('結尾換成送模組：同一個 id，指到結尾的路都不用動', () => {
    const nodes = orderFlow()
    replaceTerminal(nodes, toQuestionList(nodes, 't')!, { id: 'ignored', type: 'module', moduleId: 'm1' })
    const v = toQuestionList(nodes, 't')!
    expect(v.terminal).toEqual({ id: 'r', type: 'module', moduleId: 'm1' })
    expect(v.saveLead?.next).toBe('r')
  })
})

describe('換順序（拖曳、上移下移）', () => {
  const valid = (nodes: ScriptNode[]) => validateScriptDoc({ name: 'x', nodes, rootNodeId: 't' })
  const next = (nodes: ScriptNode[], id: string) => (nodes.find(n => n.id === id) as any)

  /** 三題照順序問、全部接下一題 */
  function linear(): ScriptNode[] {
    return [
      { id: 't', type: 'trigger', matchMode: 'semantic', keywords: [], examples: ['x'], priority: 50, next: 'a' },
      { id: 'a', type: 'collect', question: 'A?', fieldName: 'name', expireMs: 1, format: 'any', next: 'b' },
      { id: 'b', type: 'collect', question: 'B?', fieldName: 'phone', expireMs: 1, format: 'phone', next: 'c' },
      { id: 'c', type: 'collect', question: 'C?', fieldName: 'email', expireMs: 1, format: 'email', next: 'r' },
      { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
    ]
  }

  it('全部照順序的：換完一樣照新順序一路問到最後，開頭接新的第一題', () => {
    const nodes = linear()
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 2, 0)
    const v = toQuestionList(nodes, 't')!
    expect(v.items.map(i => i.id)).toEqual(['c', 'a', 'b'])
    expect(next(nodes, 't').next).toBe('c')
    expect(next(nodes, 'c').next).toBe('a')
    expect(next(nodes, 'a').next).toBe('b')
    expect(next(nodes, 'b').next).toBe('r')
    expect(valid(nodes)).toBeNull()
  })

  it('MYFEEL 查詢訂單把最後一題（電話）拖到最上面：指定的跳題跟著原本那一題，照順序的跟著新順序', () => {
    const nodes = orderFlow()
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 4, 0)
    const v = toQuestionList(nodes, 't')!
    expect(v.items.map(i => i.id)).toEqual(['c_phone', 'c_id', 'q_mail', 'c_mail', 'c_name'])
    expect(next(nodes, 'c_phone').next).toBe('c_id') // 原本是最後一題的「直接到最後」＝照順序 → 接新的下一題
    expect(next(nodes, 'c_id').next).toBe('save') // 第 1 題「答得出編號就收尾」是指定的，不變
    expect(next(nodes, 'c_id').skipNext).toBe('q_mail') // 「客人說沒有 → 下一題」照順序，新的下一題還是它
    expect(next(nodes, 'q_mail').options.map((o: any) => o.next)).toEqual(['c_mail', 'c_name'])
    expect(next(nodes, 'c_mail').next).toBe('save') // 不是最後一題卻「直接到最後」＝指定的，不變
    expect(next(nodes, 'c_name').next).toBe('save') // 原本接下一題（電話），現在是最後一題 → 直接到最後
    expect(valid(nodes)).toBeNull()
  })

  it('⛔ 指定的跳題換完變成往回跳：不偷偷改掉，認得出來讓畫面標紅', () => {
    const nodes = linear()
    next(nodes, 'a').next = 'c' // 第 1 題答了直接跳第 3 題
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 2, 0)
    const v = toQuestionList(nodes, 't')!
    expect(v.items.map(i => i.id)).toEqual(['c', 'a', 'b'])
    expect(next(nodes, 'a').next).toBe('c')
    expect(isBackwardTarget(v, 1, 'c')).toBe(true)
    expect(isBackwardTarget(v, 1, 'b')).toBe(false)
    expect(isBackwardTarget(v, 1, v.endId)).toBe(false)
  })

  it('同一個位置、超出範圍：什麼都不動', () => {
    const nodes = linear()
    const before = JSON.stringify(nodes)
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 1, 1)
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 0, 3)
    expect(JSON.stringify(nodes)).toBe(before)
  })

  it('orderNextOf：中間的題目是下一題，最後一題是「最後」那一段的入口', () => {
    const v = toQuestionList(orderFlow(), 't')!
    expect(orderNextOf(v, 0)).toBe('q_mail')
    expect(orderNextOf(v, 4)).toBe('save')
  })
})
