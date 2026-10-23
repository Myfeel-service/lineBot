import { describe, expect, it } from 'vitest'
import { addBranch, addBranchCase, addEnding, appendQuestion, endingOfNode, insertEndStep, isBackwardTarget, isOrderTarget, moveQuestion, orderNextOf, removeBranchCase, removeEndStep, removeEnding, removeQuestion, removeStray, replaceTerminal, routesOf, setRouteTags, setRouteTarget, startFirst, toQuestionList } from './script-question-list'
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

  it('`D-150`：排不進清單的步驟（看答案分路沒掛在題目上）照樣是清單，那一步列出來，不換畫面', () => {
    const v = toQuestionList([
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'b' },
      { id: 'b', type: 'branch', cases: [], defaultNext: 'r' },
      { id: 'r', type: 'reply', text: '1', thenHandoff: false },
    ], 't')!
    expect(v.items).toEqual([])
    expect(v.strays.map(s => [s.node.id, s.reachable])).toEqual([['b', true]])
  })

  it('只有連開頭或結尾都沒有（資料壞掉）才不是清單', () => {
    expect(toQuestionList([{ id: 'r', type: 'reply', text: '1', thenHandoff: false }], 't')).toBeNull()
    expect(toQuestionList([{ id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: '' }], 't')).toBeNull()
  })

  it('開頭接的不是第一題（節點順序跟走的順序對不上）：打開時把那一題排第一，客人怎麼走不變', () => {
    const nodes = orderFlow()
    ;(nodes[0] as any).next = 'c_name'
    expect(toQuestionList(nodes, 't')).not.toBeNull()
    const before = JSON.stringify(nodes.map(n => [n.id, (n as any).next, (n as any).skipNext, (n as any).options?.map((o: any) => o.next)]).sort())
    startFirst(nodes, 't')
    expect(toQuestionList(nodes, 't')!.items.map(i => i.id)).toEqual(['c_name', 'c_id', 'q_mail', 'c_mail', 'c_phone'])
    expect(JSON.stringify(nodes.map(n => [n.id, (n as any).next, (n as any).skipNext, (n as any).options?.map((o: any) => o.next)]).sort())).toBe(before)
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

  it('拿掉第一題（答了直接到最後、後面只從「客人說沒有」走得到）：開頭接下一題，後面整串還接得到', () => {
    const nodes = orderFlow()
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'c_id')
    expect((nodes[0] as any).next).toBe('q_mail')
    const v = toQuestionList(nodes, 't')
    expect(v?.items.map(i => i.id)).toEqual(['q_mail', 'c_mail', 'c_name', 'c_phone'])
    expect((nodes.find(n => n.id === 'save') as any).fieldMap.map((m: any) => m.fromField)).toEqual(['email', 'name', 'phone'])
    expect(valid(nodes)).toBeNull()
  })

  it('拿掉最後一題：指到它的路接「直接到最後」', () => {
    const nodes = orderFlow()
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'c_phone')
    expect((nodes.find(n => n.id === 'c_name') as any).next).toBe('save')
    expect(toQuestionList(nodes, 't')?.items.map(i => i.id)).toEqual(['c_id', 'q_mail', 'c_mail', 'c_name'])
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

describe('好幾種結尾也用清單（`D-149`）', () => {
  const valid = (nodes: ScriptNode[]) => validateScriptDoc({ name: 'x', nodes, rootNodeId: 't' })
  const node = (nodes: ScriptNode[], id: string) => nodes.find(n => n.id === id) as any

  /** 服務分流範本那種：一題按鈕、三顆各回不同的話 */
  function menuFlow(): ScriptNode[] {
    return [
      { id: 't', type: 'trigger', keywords: ['客服選單'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '請問需要哪項服務？', expireMs: 1, options: [{ label: '出貨查詢', next: 'r1' }, { label: '退換貨', next: 'tg' }, { label: '找真人', next: 'r3' }] },
      { id: 'r1', type: 'reply', text: '您可在「我的訂單」查看', thenHandoff: false },
      { id: 'tg', type: 'tag', addTagIds: ['退貨'], next: 'r2' },
      { id: 'r2', type: 'reply', text: '請提供訂單編號', thenHandoff: true },
      { id: 'r3', type: 'reply', text: '馬上為您轉接', thenHandoff: true },
    ]
  }

  it('服務分流：一題三種結尾，每一種各自的貼標籤認得出來', () => {
    const v = toQuestionList(menuFlow(), 't')!
    expect(v.items.map(i => i.id)).toEqual(['q'])
    expect(v.endings.map(e => [e.entryId, e.terminal.id, e.tag?.id ?? null])).toEqual([['r1', 'r1', null], ['tg', 'r2', 'tg'], ['r3', 'r3', null]])
    expect(v.endId).toBe('r1') // 第一種（舊程式照用的那幾格）
    expect(endingOfNode(v, 'tg')?.terminal.id).toBe('r2')
  })

  it('`D-150`：兩顆按鈕各貼不同的標籤、接到同一種結尾 → 各自貼在那顆按鈕上（以前不是清單）', () => {
    const nodes = menuFlow()
    nodes.push({ id: 'tg2', type: 'tag', addTagIds: ['真人'], next: 'r2' })
    ;(node(nodes, 'q').options[2]).next = 'tg2'
    const v = toQuestionList(nodes, 't')!
    expect([...v.routeTagIds].sort()).toEqual(['tg', 'tg2'])
    expect(routesOf(v, v.items[0]!).map(r => [r.target, r.tags.map(t => t.id)])).toEqual([['r1', []], ['r2', ['tg']], ['r2', ['tg2']]])
    expect(v.strays).toEqual([])
  })

  it('`D-150`：沒有題目卻有兩種結尾 → 照樣是清單，第二種標成走不到', () => {
    const v = toQuestionList([
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'r1' },
      { id: 'r1', type: 'reply', text: '1', thenHandoff: false },
      { id: 'r2', type: 'reply', text: '2', thenHandoff: false },
    ], 't')!
    expect(v.endings).toHaveLength(2)
    expect([...v.unreachable]).toEqual(['r2'])
  })

  it('最後一題是按鈕、各顆去不同結尾：加一題不動任何一顆（猜錯就是把客人帶去別的結尾）', () => {
    const nodes = menuFlow()
    const item = { id: 'c_new', type: 'collect', question: '?', fieldName: 'note', expireMs: 1, format: 'any', next: '' } as ScriptNode
    appendQuestion(nodes, toQuestionList(nodes, 't')!, item as any)
    expect(node(nodes, 'q').options.map((o: any) => o.next)).toEqual(['r1', 'tg', 'r3'])
    expect(node(nodes, 'c_new').next).toBe('r1')
  })

  it('最後一題是「問一題」接某一種結尾：新的這題接手它原本去的那一種', () => {
    const nodes = menuFlow()
    nodes.splice(2, 0, { id: 'c1', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 1, format: 'any', next: 'tg' })
    ;(node(nodes, 'q').options[1]).next = 'c1'
    const item = { id: 'c2', type: 'collect', question: '電話？', fieldName: 'phone', expireMs: 1, format: 'phone', next: '' } as ScriptNode
    appendQuestion(nodes, toQuestionList(nodes, 't')!, item as any)
    expect(node(nodes, 'c1').next).toBe('c2')
    expect(node(nodes, 'c2').next).toBe('tg')
    expect(valid(nodes)).toBeNull()
  })

  it('好幾種結尾時，最後一題去哪一種結尾不算「照順序」：換順序不會被改掉', () => {
    const nodes = menuFlow()
    nodes.splice(1, 0, { id: 'c0', type: 'collect', question: '大名？', fieldName: 'name', expireMs: 1, format: 'any', next: 'q' })
    node(nodes, 't').next = 'c0'
    const v = toQuestionList(nodes, 't')!
    expect(isOrderTarget(v, 1, 'r1')).toBe(false)
    moveQuestion(nodes, v, 1, 0) // 按鈕那題拖到最上面
    expect(node(nodes, 'q').options.map((o: any) => o.next)).toEqual(['r1', 'tg', 'r3'])
    expect(node(nodes, 't').next).toBe('q')
    // 只有一種結尾時，最後一題接「最後」照舊算照順序
    expect(isOrderTarget(toQuestionList(orderFlow(), 't')!, 4, 'save')).toBe(true)
  })

  it('多一種結尾：第一種有存進客人資料就照抄一份掛在前面；拿掉一種：指到它的路改接別種', () => {
    const nodes = orderFlow()
    const v = toQuestionList(nodes, 't')!
    const entry = addEnding(nodes, v, { id: 'r_b', type: 'reply', text: '另一種', thenHandoff: false }, { id: 'save_b', type: 'saveLead', fieldMap: [], next: '' })
    expect(entry).toBe('save_b')
    node(nodes, 'c_mail').next = entry // 給了 Email 的走另一種結尾
    const v2 = toQuestionList(nodes, 't')!
    expect(v2.endings.map(e => e.entryId)).toEqual(['save', 'save_b'])
    expect(v2.endings[1]!.saveLead?.fieldMap).toEqual(v2.endings[0]!.saveLead?.fieldMap)
    expect(valid(nodes)).toBeNull()
    removeEnding(nodes, v2, 'save_b', 'save')
    expect(node(nodes, 'c_mail').next).toBe('save')
    expect(nodes.some(n => n.id === 'r_b' || n.id === 'save_b')).toBe(false)
    expect(toQuestionList(nodes, 't')!.endings).toHaveLength(1)
  })

  it('⛔ 多一種結尾：抄的是每一種存的欄位合起來（＝題目上勾著的），不是只抄第一種（`C-395`）', () => {
    // 舊資料：第一種沒有存進客人資料、第二種存電話——畫面上電話那題是勾著的
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'c_id' },
      { id: 'c_id', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 1, format: 'any', next: 'q' },
      { id: 'q', type: 'quickReply', question: '要留電話嗎？', expireMs: 1, options: [{ label: '要', next: 'c_phone' }, { label: '不用', next: 'r_a' }] },
      { id: 'c_phone', type: 'collect', question: '電話？', fieldName: 'phone', expireMs: 1, format: 'phone', next: 'save_b' },
      { id: 'r_a', type: 'reply', text: '好的', thenHandoff: false },
      { id: 'save_b', type: 'saveLead', fieldMap: [{ fromField: 'phone', attrKey: '電話' }], next: 'r_b' },
      { id: 'r_b', type: 'reply', text: '會打給您', thenHandoff: false },
    ]
    const entry = addEnding(nodes, toQuestionList(nodes, 't')!, { id: 'r_c', type: 'reply', text: 'c', thenHandoff: false }, { id: 'save_c', type: 'saveLead', fieldMap: [], next: '' })
    expect(entry).toBe('save_c')
    expect(node(nodes, 'save_c').fieldMap).toEqual([{ fromField: 'phone', attrKey: '電話' }])

    // 兩種各存不同的：合起來；同一題兩種名字不一樣的用前面那一種的
    nodes.splice(nodes.findIndex(n => n.id === 'r_a'), 0, { id: 'save_a', type: 'saveLead', fieldMap: [{ fromField: 'order_id', attrKey: '訂單編號' }, { fromField: 'phone', attrKey: '手機' }], next: 'r_a' })
    node(nodes, 'q').options[1].next = 'save_a'
    addEnding(nodes, toQuestionList(nodes, 't')!, { id: 'r_d', type: 'reply', text: 'd', thenHandoff: false }, { id: 'save_d', type: 'saveLead', fieldMap: [], next: '' })
    expect(node(nodes, 'save_d').fieldMap).toEqual([{ fromField: 'order_id', attrKey: '訂單編號' }, { fromField: 'phone', attrKey: '手機' }])
  })

  it('刪一題：每一種結尾的存進客人資料都拿掉那個欄位', () => {
    const nodes = orderFlow()
    addEnding(nodes, toQuestionList(nodes, 't')!, { id: 'r_b', type: 'reply', text: 'b', thenHandoff: false }, { id: 'save_b', type: 'saveLead', fieldMap: [], next: '' })
    node(nodes, 'c_mail').next = 'save_b'
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'c_phone')
    for (const id of ['save', 'save_b']) expect(node(nodes, id).fieldMap.some((m: any) => m.fromField === 'phone')).toBe(false)
  })

  it('⛔ 一顆按鈕接到某一種結尾、那一種自己有標籤（沒有「貼在路上」的記號）：照舊是那一種結尾的標籤', () => {
    const v = toQuestionList(menuFlow(), 't')!
    expect(v.routeTagIds.size).toBe(0)
    expect(v.endings[1]!.tag?.id).toBe('tg')
  })

  it('掛貼標籤／換成送模組可以指定是哪一種結尾', () => {
    const nodes = menuFlow()
    const v = toQuestionList(nodes, 't')!
    insertEndStep(nodes, v, { id: 'tg3', type: 'tag', addTagIds: ['真人'], next: '' }, v.endings[2]!)
    expect(node(nodes, 'q').options[2].next).toBe('tg3')
    const v2 = toQuestionList(nodes, 't')!
    replaceTerminal(nodes, v2, { id: 'x', type: 'module', moduleId: 'm1' }, v2.endings[0]!)
    expect(node(nodes, 'r1')).toEqual({ id: 'r1', type: 'module', moduleId: 'm1' })
    expect(valid(nodes)).toBeNull()
  })
})

describe('只留一套畫面（`D-150`）：看答案走不同路、貼在路上的標籤、排不進去的步驟', () => {
  const valid = (nodes: ScriptNode[]) => validateScriptDoc({ name: 'x', nodes, rootNodeId: 't' })
  const node = (nodes: ScriptNode[], id: string) => nodes.find(n => n.id === id) as any

  /** 示意第⑨張那條：先問會員等級、VIP 直接到 VIP 的結尾，其他人再問電話 */
  function memberFlow(): ScriptNode[] {
    return [
      { id: 't', type: 'trigger', matchMode: 'semantic', keywords: [], examples: ['我是會員'], priority: 50, next: 'c_lv' },
      { id: 'c_lv', type: 'collect', question: '請問您的會員等級？', fieldName: 'level', expireMs: 1, format: 'any', next: 'b' },
      { id: 'b', type: 'branch', cases: [{ field: 'level', op: 'equals', value: 'VIP', next: 'r_vip' }, { field: 'level', op: 'contains', value: '金卡', next: 'r_vip' }], defaultNext: 'c_phone' },
      { id: 'c_phone', type: 'collect', question: '請留電話', fieldName: 'phone', expireMs: 1, format: 'phone', next: 'r_all' },
      { id: 'r_vip', type: 'reply', text: 'VIP 專屬客服馬上為您服務', thenHandoff: true },
      { id: 'r_all', type: 'reply', text: '感謝您的詢問', thenHandoff: false },
    ]
  }

  it('看答案走不同路掛在那一題上：那一題的路＝每一條＋其他答案（取代「答了」）', () => {
    const v = toQuestionList(memberFlow(), 't')!
    expect(v.items.map(i => i.id)).toEqual(['c_lv', 'c_phone'])
    expect(v.branches.get('c_lv')?.id).toBe('b')
    expect(routesOf(v, v.items[0]!).map(r => [r.kind, r.index, r.target])).toEqual([['case', 0, 'r_vip'], ['case', 1, 'r_vip'], ['other', -1, 'c_phone']])
    expect(v.strays).toEqual([])
    expect(v.unreachable.size).toBe(0)
  })

  it('⋯ → 看答案走不同路：原本答了去哪＝其他答案去哪；填好才存得了；拿光了變回「答了」', () => {
    const nodes = orderFlow()
    const v = toQuestionList(nodes, 't')!
    const item = v.items[0] as any
    addBranch(nodes, item, 'b1')
    expect(item.next).toBe('b1')
    expect(node(nodes, 'b1').defaultNext).toBe('save')
    expect(valid(nodes)).not.toBeNull() // 那一條還沒填答案、去哪
    const v2 = toQuestionList(nodes, 't')!
    const caseRoute = routesOf(v2, item).find(r => r.kind === 'case')!
    node(nodes, 'b1').cases[0].value = 'A123'
    setRouteTarget(nodes, v2, item, caseRoute, 'c_phone')
    expect(valid(nodes)).toBeNull()
    addBranchCase(toQuestionList(nodes, 't')!, item)
    expect(node(nodes, 'b1').cases).toHaveLength(2)
    removeBranchCase(nodes, toQuestionList(nodes, 't')!, item, 1)
    removeBranchCase(nodes, toQuestionList(nodes, 't')!, item, 0)
    expect(nodes.some(n => n.id === 'b1')).toBe(false)
    expect(item.next).toBe('save')
    expect(valid(nodes)).toBeNull()
  })

  it('換順序：看答案的每一條照樣分「照順序」與「指定的」', () => {
    const nodes = memberFlow()
    nodes.splice(3, 0, { id: 'c_name', type: 'collect', question: '大名？', fieldName: 'name', expireMs: 1, format: 'any', next: 'c_phone' })
    node(nodes, 'b').defaultNext = 'c_name' // 其他答案 → 下一題（照順序）
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 2, 1) // 電話拖到大名前面
    expect(toQuestionList(nodes, 't')!.items.map(i => i.id)).toEqual(['c_lv', 'c_phone', 'c_name'])
    expect(node(nodes, 'b').defaultNext).toBe('c_phone') // 照順序的跟著新順序
    expect(node(nodes, 'b').cases.map((c: any) => c.next)).toEqual(['r_vip', 'r_vip']) // 指定去 VIP 結尾的不變
    expect(valid(nodes)).toBeNull()
  })

  it('刪掉有看答案分路的那一題：分路一起拿掉，指到它的路改接下一題；只從那裡走得到的結尾標成走不到', () => {
    const nodes = memberFlow()
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'c_lv')
    expect(nodes.some(n => n.id === 'b')).toBe(false)
    expect(node(nodes, 't').next).toBe('c_phone')
    expect([...toQuestionList(nodes, 't')!.unreachable]).toEqual(['r_vip'])
    expect(valid(nodes)).toContain('接不到')
  })

  it('⛔ 好幾種結尾時把最後一題往上拖：換到最後的那題接原本最後一題去的那一種，不是第一種', () => {
    const nodes = memberFlow()
    nodes.splice(3, 0, { id: 'c_name', type: 'collect', question: '大名？', fieldName: 'name', expireMs: 1, format: 'any', next: 'c_phone' })
    node(nodes, 'b').defaultNext = 'c_name'
    moveQuestion(nodes, toQuestionList(nodes, 't')!, 2, 1)
    expect(node(nodes, 'c_phone').next).toBe('c_name')
    expect(node(nodes, 'c_name').next).toBe('r_all') // 不是 r_vip（第一種）
    expect(valid(nodes)).toBeNull()
  })

  it('按鈕上貼標籤：按了才貼、接同一種結尾的別顆按鈕不會一起被貼；拿掉接回原樣', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['客服選單'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '請問需要哪項服務？', expireMs: 1, options: [{ label: '出貨查詢', next: 'r' }, { label: '退換貨', next: 'r' }] },
      { id: 'r', type: 'reply', text: '好的', thenHandoff: true },
    ]
    const v = toQuestionList(nodes, 't')!
    const q = v.items[0]!
    setRouteTags(nodes, v, q, routesOf(v, q)[1]!, ['退貨客人'], 'tg')
    expect(node(nodes, 'q').options.map((o: any) => o.next)).toEqual(['r', 'tg'])
    expect(node(nodes, 'tg')).toMatchObject({ addTagIds: ['退貨客人'], next: 'r', onRoute: true })
    expect(valid(nodes)).toBeNull()
    // 只剩這顆接這一種結尾也一樣讀成「貼在按鈕上」（有記號），不會變成那一種結尾的標籤
    node(nodes, 'q').options[0].next = 'tg'
    node(nodes, 'q').options[0].next = 'r'
    const v2 = toQuestionList(nodes, 't')!
    expect([...v2.routeTagIds]).toEqual(['tg'])
    expect(v2.endings[0]!.tag).toBeNull()
    setRouteTags(nodes, v2, v2.items[0]!, routesOf(v2, v2.items[0]!)[1]!, [], 'unused')
    expect(nodes.some(n => n.id === 'tg')).toBe(false)
    expect(node(nodes, 'q').options.map((o: any) => o.next)).toEqual(['r', 'r'])
  })

  it('路上貼了標籤的那條改去處：標籤照貼、改標籤後面接哪；刪那一題時路上的標籤一起拿掉', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '?', expireMs: 1, options: [{ label: '退換貨', next: 'tg' }] },
      { id: 'tg', type: 'tag', addTagIds: ['退貨'], next: 'c' },
      { id: 'c', type: 'collect', question: '訂單編號？', fieldName: 'order_id', expireMs: 1, format: 'any', next: 'r' },
      { id: 'r', type: 'reply', text: '好', thenHandoff: false },
    ]
    const v = toQuestionList(nodes, 't')!
    expect([...v.routeTagIds]).toEqual(['tg']) // 舊資料沒記號：後面接的是一題 → 貼在路上
    setRouteTarget(nodes, v, v.items[0]!, routesOf(v, v.items[0]!)[0]!, 'r')
    expect(node(nodes, 'q').options[0].next).toBe('tg')
    expect(node(nodes, 'tg').next).toBe('r')
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'q')
    expect(nodes.some(n => n.id === 'tg')).toBe(false)
  })

  it('排不進去的步驟：存進客人資料放在兩題中間 → 列出來（客人照樣走得到）；刪掉＝接到它的路改接它後面', () => {
    const nodes = memberFlow()
    nodes.splice(1, 0, { id: 's_mid', type: 'saveLead', fieldMap: [{ fromField: 'level', attrKey: '等級' }], next: 'c_lv' })
    node(nodes, 't').next = 's_mid'
    const v = toQuestionList(nodes, 't')!
    expect(v.strays.map(s => [s.node.id, s.reachable])).toEqual([['s_mid', true]])
    removeStray(nodes, 's_mid')
    expect(node(nodes, 't').next).toBe('c_lv')
    expect(toQuestionList(nodes, 't')!.strays).toEqual([])
  })

  it('接不到的題目照樣在清單上，標成走不到', () => {
    const nodes = memberFlow()
    node(nodes, 'b').defaultNext = 'r_all' // 其他答案直接到最後 → 電話那題沒有路接過去
    const v = toQuestionList(nodes, 't')!
    expect(v.items.map(i => i.id)).toEqual(['c_lv', 'c_phone'])
    expect([...v.unreachable]).toEqual(['c_phone'])
  })

  it('⛔ 好幾種結尾時拿掉最後一題：指到它的路接它原本去的那一種，不是第一種（`C-395`）', () => {
    // 會員分流：按「會員」先問電話再回 VIP 那句（第二種結尾）；按「不是」直接回一般那句（第一種）
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['會員'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '請問您是會員嗎？', expireMs: 1, options: [{ label: '會員', next: 'c_phone' }, { label: '不是', next: 'r_all' }] },
      { id: 'c_phone', type: 'collect', question: '請留電話', fieldName: 'phone', expireMs: 1, format: 'phone', next: 'r_vip' },
      { id: 'r_all', type: 'reply', text: '感謝您的詢問', thenHandoff: false },
      { id: 'r_vip', type: 'reply', text: 'VIP 專屬客服馬上為您服務', thenHandoff: true },
    ]
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'c_phone')
    expect(node(nodes, 'q').options.map((o: any) => o.next)).toEqual(['r_vip', 'r_all']) // 不是 r_all（第一種）
    expect(valid(nodes)).toBeNull()
  })

  it('好幾種結尾時拿掉最後一題、它的路各去不同結尾（服務分流）：沒有哪一種是對的，照舊接第一種', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['客服'], priority: 50, next: 'c_name' },
      { id: 'c_name', type: 'collect', question: '大名？', fieldName: 'name', expireMs: 1, format: 'any', next: 'q' },
      { id: 'q', type: 'quickReply', question: '請問需要哪項服務？', expireMs: 1, options: [{ label: '出貨查詢', next: 'r1' }, { label: '退換貨', next: 'r2' }] },
      { id: 'r1', type: 'reply', text: '您可在「我的訂單」查看', thenHandoff: false },
      { id: 'r2', type: 'reply', text: '請提供訂單編號', thenHandoff: true },
    ]
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'q')
    expect(node(nodes, 'c_name').next).toBe('r1')
    expect([...toQuestionList(nodes, 't')!.unreachable]).toEqual(['r2']) // 另一種標成走不到，畫面標黃
  })

  it('⛔ 兩條路共用同一個貼在路上的標籤：改一條的去處、標籤，或刪掉一題，另一條不跟著變（`C-395`）', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['客服選單'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '請問需要哪項服務？', expireMs: 1, options: [{ label: '退貨', next: 'tg' }, { label: '換貨', next: 'tg' }] },
      { id: 'tg', type: 'tag', addTagIds: ['退換貨'], next: 'r1', onRoute: true },
      { id: 'r1', type: 'reply', text: '請提供訂單編號', thenHandoff: true },
      { id: 'r2', type: 'reply', text: '換貨請填寫尺寸', thenHandoff: true },
    ]
    const v = toQuestionList(nodes, 't')!
    expect(routesOf(v, v.items[0]!).map(r => r.tags.map(t => t.id))).toEqual([['tg'], ['tg']])
    // 「換貨」改去第二種結尾：「退貨」照舊去第一種，兩顆都照樣貼標籤
    setRouteTarget(nodes, v, v.items[0]!, routesOf(v, v.items[0]!)[1]!, 'r2')
    const v2 = toQuestionList(nodes, 't')!
    expect(routesOf(v2, v2.items[0]!).map(r => [r.target, r.tags.map(t => t.addTagIds)])).toEqual([['r1', [['退換貨']]], ['r2', [['退換貨']]]])
    expect(node(nodes, 'q').options.map((o: any) => o.next)).toEqual(['tg', 'tg-2'])
    expect(valid(nodes)).toBeNull()

    // 「退貨」換標籤：另一顆的不變（又共用一次再改，確認新的那份也是分出來的）
    node(nodes, 'q').options[1].next = 'tg'
    node(nodes, 'tg').next = 'r1'
    nodes.splice(nodes.findIndex(n => n.id === 'tg-2'), 1)
    const v3 = toQuestionList(nodes, 't')!
    setRouteTags(nodes, v3, v3.items[0]!, routesOf(v3, v3.items[0]!)[0]!, ['退貨客人'], 'unused')
    const v4 = toQuestionList(nodes, 't')!
    expect(routesOf(v4, v4.items[0]!).map(r => r.tags.flatMap(t => t.addTagIds))).toEqual([['退貨客人'], ['退換貨']])

    // 「換貨」不貼了：「退貨」那顆照貼
    setRouteTags(nodes, v4, v4.items[0]!, routesOf(v4, v4.items[0]!)[1]!, [], '')
    const v5 = toQuestionList(nodes, 't')!
    expect(routesOf(v5, v5.items[0]!).map(r => r.tags.flatMap(t => t.addTagIds))).toEqual([['退貨客人'], []])
    expect(node(nodes, 'q').options.map((o: any) => o.next)).toEqual(['tg-2', 'r1'])
    expect(nodes.some(n => n.id === 'tg')).toBe(false)
  })

  it('⛔ 兩題的路共用同一個標籤、刪掉其中一題：另一題路上的標籤留著（`C-395`）', () => {
    const nodes: ScriptNode[] = [
      { id: 't', type: 'trigger', keywords: ['x'], priority: 50, next: 'q' },
      { id: 'q', type: 'quickReply', question: '?', expireMs: 1, options: [{ label: '退貨', next: 'tg' }, { label: '其他', next: 'c' }] },
      { id: 'c', type: 'collect', question: '大名？', fieldName: 'name', expireMs: 1, format: 'any', next: 'tg' },
      { id: 'tg', type: 'tag', addTagIds: ['退貨'], next: 'r', onRoute: true },
      { id: 'r', type: 'reply', text: '好', thenHandoff: false },
    ]
    removeQuestion(nodes, toQuestionList(nodes, 't')!, 'q')
    expect(node(nodes, 't').next).toBe('c')
    expect(node(nodes, 'c').next).toBe('tg')
    expect(node(nodes, 'tg')).toMatchObject({ addTagIds: ['退貨'], next: 'r' })
    expect(valid(nodes)).toBeNull()
  })

  it('最後一題有看答案分路、各條去不同結尾：加一題不動任何一條', () => {
    const nodes = memberFlow()
    nodes.splice(3, 1) // 拿掉電話：其他答案直接去一般結尾
    node(nodes, 'b').defaultNext = 'r_all'
    appendQuestion(nodes, toQuestionList(nodes, 't')!, { id: 'c_new', type: 'collect', question: '?', fieldName: 'note', expireMs: 1, format: 'any', next: '' })
    expect(node(nodes, 'b').defaultNext).toBe('r_all')
    expect(node(nodes, 'b').cases.map((c: any) => c.next)).toEqual(['r_vip', 'r_vip'])
  })
})
