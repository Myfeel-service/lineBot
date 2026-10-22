/**
 * 自動回應的「問答清單」看法（`D-138`④）：照順序問的流程不用接線，一題一列就講得完。
 *
 * 哪些流程可以用清單編：一個開始、中間只有「問一題」與「給按鈕選」、最後是一種或好幾種結尾
 * （回一段話或送一個模組；每一種結尾前面可以掛「存進客人資料」與「貼標籤」各一個）。每一題的去向只能是
 * 別一題或某一種結尾——MYFEEL 的查詢訂單、更改地址、新增備註是一種結尾；服務分流（按不同按鈕回不同的話）
 * 是好幾種（`D-149`，2026-10-22 以前好幾種結尾就退回流程圖編法，叫法、操作全是另一套）。
 * 只有「依答案分路」的照舊用流程圖編，資料一樣、只是看法不同。
 *
 * ⛔ 這裡只「解讀」與「搬動」同一份節點，不另存一種格式——兩種看法改的是同一份資料，存檔的格式不變。
 */
import type {
  ScriptCollectNode,
  ScriptModuleNode,
  ScriptNode,
  ScriptQuickReplyNode,
  ScriptReplyNode,
  ScriptSaveLeadNode,
  ScriptTagNode,
  ScriptTriggerNode,
} from './types/ai-script'

export type QuestionItem = ScriptCollectNode | ScriptQuickReplyNode

/** 一種結尾：入口（存進客人資料／貼標籤／結尾三者中最前面那個）一路接到結尾 */
export interface QuestionEnding {
  /** 題目的去向指這裡＝到這一種結尾 */
  entryId: string
  terminal: ScriptReplyNode | ScriptModuleNode
  saveLead: ScriptSaveLeadNode | null
  tag: ScriptTagNode | null
}

export interface QuestionListView {
  trigger: ScriptTriggerNode
  /** 照節點順序排好的題目 */
  items: QuestionItem[]
  /** 每一種結尾（至少一種），照結尾節點的順序（`D-149`） */
  endings: QuestionEnding[]
  /** 第一種結尾的入口：只有一種結尾時＝「直接到最後」（以下三格同樣是第一種結尾的，舊程式照用） */
  endId: string
  terminal: ScriptReplyNode | ScriptModuleNode
  saveLead: ScriptSaveLeadNode | null
  tag: ScriptTagNode | null
}

function isItem(n: ScriptNode): n is QuestionItem {
  return n.type === 'collect' || n.type === 'quickReply'
}

/** 這個步驟屬於哪一種結尾（入口、存進客人資料、貼標籤、結尾本身都算）；不屬於任何一種回 null */
export function endingOfNode(view: QuestionListView, nodeId: string): QuestionEnding | null {
  return view.endings.find(e => e.entryId === nodeId || e.terminal.id === nodeId || e.saveLead?.id === nodeId || e.tag?.id === nodeId) ?? null
}

/** 題目往外指的每一條路 */
function itemTargets(item: QuestionItem): string[] {
  if (item.type === 'collect') return [item.next, ...(item.skipLabel?.trim() && item.skipNext ? [item.skipNext] : [])]
  return item.options.map(o => o.next)
}

/** 這份流程能不能用清單編；不能回 null（照舊用流程圖） */
export function toQuestionList(nodes: ScriptNode[], rootNodeId: string): QuestionListView | null {
  const trigger = nodes.find(n => n.id === rootNodeId)
  if (!trigger || trigger.type !== 'trigger') return null
  if (nodes.some(n => n.type === 'trigger' && n.id !== rootNodeId)) return null
  if (nodes.some(n => n.type === 'branch')) return null

  const terminals = nodes.filter((n): n is ScriptReplyNode | ScriptModuleNode => n.type === 'reply' || n.type === 'module')
  if (!terminals.length) return null
  const chain = nodes.filter((n): n is ScriptSaveLeadNode | ScriptTagNode => n.type === 'saveLead' || n.type === 'tag')

  // 每一種結尾：存進客人資料／貼標籤要排成一條直線接到那個結尾，入口是沒有被它們指到的那一個；
  // 每個存進客人資料／貼標籤都要剛好屬於一種結尾、一種結尾各最多一個
  const byTerminal = new Map<string, Array<ScriptSaveLeadNode | ScriptTagNode>>(terminals.map(t => [t.id, []]))
  for (const n of chain) {
    let cursor: string = n.id
    const seen = new Set<string>()
    while (!byTerminal.has(cursor)) {
      if (seen.has(cursor)) return null // 繞圈
      seen.add(cursor)
      const step = chain.find(c => c.id === cursor)
      if (!step) return null // 接到題目或不存在的步驟
      cursor = step.next
    }
    byTerminal.get(cursor)!.push(n)
  }
  const endings: QuestionEnding[] = []
  for (const terminal of terminals) {
    const steps = byTerminal.get(terminal.id)!
    const saveLeads = steps.filter((n): n is ScriptSaveLeadNode => n.type === 'saveLead')
    const tags = steps.filter((n): n is ScriptTagNode => n.type === 'tag')
    if (saveLeads.length > 1 || tags.length > 1) return null
    const pointed = new Set(steps.map(n => n.next))
    const heads = [terminal.id, ...steps.map(n => n.id)].filter(id => !pointed.has(id))
    if (heads.length !== 1) return null
    endings.push({ entryId: heads[0]!, terminal, saveLead: saveLeads[0] ?? null, tag: tags[0] ?? null })
  }

  const items = nodes.filter(isItem)
  if (items.length + chain.length + terminals.length + 1 !== nodes.length) return null // 有清單不認得的步驟
  const allowed = new Set([...items.map(i => i.id), ...endings.map(e => e.entryId)])
  if (!allowed.has(trigger.next)) return null
  if (items.length && trigger.next !== items[0]!.id) return null // 第一題要是開頭接的那一題
  // 沒有題目：開頭直接接結尾，只可能有一種（其他種接不到）
  if (!items.length && (endings.length !== 1 || trigger.next !== endings[0]!.entryId)) return null
  for (const item of items) {
    if (itemTargets(item).some(t => !allowed.has(t))) return null
  }

  const first = endings[0]!
  return {
    trigger,
    items,
    endings,
    endId: first.entryId,
    terminal: first.terminal,
    saveLead: first.saveLead,
    tag: first.tag,
  }
}

/** 把所有指到 fromId 的路改指到 toId（開頭、每一題、存進客人資料、貼標籤、分路） */
export function retargetAll(nodes: ScriptNode[], fromId: string, toId: string): void {
  for (const n of nodes) {
    if ((n.type === 'trigger' || n.type === 'tag' || n.type === 'saveLead') && n.next === fromId) n.next = toId
    else if (n.type === 'collect') {
      if (n.next === fromId) n.next = toId
      if (n.skipNext === fromId) n.skipNext = toId
    }
    else if (n.type === 'quickReply') {
      for (const o of n.options) if (o.next === fromId) o.next = toId
    }
    else if (n.type === 'branch') {
      if (n.defaultNext === fromId) n.defaultNext = toId
      for (const c of n.cases) if (c.next === fromId) c.next = toId
    }
  }
}

function setItemNext(item: QuestionItem, target: string) {
  if (item.type === 'collect') item.next = target
  else for (const o of item.options) o.next = target
}

/**
 * 在最後一題後面加一題（沒有題目＝加在開頭後面）。
 * 原本最後一題「答了 → 直接到最後」的路改接到新的這題，新的這題答了 → 直接到最後。
 * 前面那幾題指「直接到最後」的不動（「答得出編號就收尾」是刻意的）。
 * 好幾種結尾（`D-149`）：最後一題是「問一題」→ 新的這題接手它原本去的那一種結尾；
 * 最後一題是按鈕、而且各顆去不同的結尾（服務分流那種）→ ⛔ 不動任何一顆，新的這題先接第一種結尾、
 * 由他自己選哪顆按鈕要先問這題（猜錯一顆就是把客人帶去別的結尾）。
 */
export function appendQuestion(nodes: ScriptNode[], view: QuestionListView, item: QuestionItem): void {
  const last = view.items[view.items.length - 1]
  const ends = new Set(view.endings.map(e => e.entryId))
  setItemNext(item, view.endId)
  if (!last) view.trigger.next = item.id
  else if (last.type === 'collect') {
    if (ends.has(last.next)) { setItemNext(item, last.next); last.next = item.id }
  }
  else {
    const toEnds = last.options.filter(o => ends.has(o.next))
    const oneEnd = toEnds.length > 0 && toEnds.every(o => o.next === toEnds[0]!.next)
    if (view.endings.length === 1 || (oneEnd && toEnds.length === last.options.length)) {
      if (toEnds[0]) setItemNext(item, toEnds[0].next)
      for (const o of toEnds) o.next = item.id
    }
  }
  const at = last ? nodes.findIndex(n => n.id === last.id) + 1 : nodes.findIndex(n => n.id === view.trigger.id) + 1
  nodes.splice(at, 0, item)
}

/**
 * 拿掉一題＝不問這題了：指到它的路改接清單上的下一題（最後一題就是「直接到最後」）；
 * 存進客人資料裡這題的欄位一起拿掉。
 * ⛔ 不接它「答了 →」的去處：MYFEEL 查詢訂單第 1 題答了直接到最後、後面四題只從「客人說沒有」走得到，
 * 照那條接＝開頭直接跳到最後、後面整串接不到、存不了檔（`C-379`）。
 */
export function removeQuestion(nodes: ScriptNode[], view: QuestionListView, itemId: string): void {
  const index = view.items.findIndex(i => i.id === itemId)
  const item = view.items[index]
  if (!item) return
  const idx = nodes.findIndex(n => n.id === itemId)
  nodes.splice(idx, 1)
  retargetAll(nodes, itemId, orderNextOf(view, index))
  if (item.type === 'collect') {
    // 好幾種結尾時每一種都有自己的「存進客人資料」（`D-149`），這題的欄位每一種都拿掉
    for (const e of view.endings) {
      if (!e.saveLead) continue
      e.saveLead.fieldMap = e.saveLead.fieldMap.filter(m => m.fromField !== item.fieldName)
      if (!e.saveLead.fieldMap.length) removeEndStep(nodes, e.saveLead.id)
    }
  }
}

/** 在某一種結尾（預設第一種）最前面掛一步（存進客人資料／貼標籤）：原本指那一種結尾的路都改接它 */
export function insertEndStep(nodes: ScriptNode[], view: QuestionListView, step: ScriptSaveLeadNode | ScriptTagNode, ending: QuestionEnding = view.endings[0]!): void {
  step.next = ending.entryId
  retargetAll(nodes, ending.entryId, step.id)
  const at = nodes.findIndex(n => n.id === ending.terminal.id)
  nodes.splice(at, 0, step)
}

/** 拿掉「最後」那一段的一步：指到它的路改接它的下一步 */
export function removeEndStep(nodes: ScriptNode[], stepId: string): void {
  const idx = nodes.findIndex(n => n.id === stepId)
  const step = nodes[idx]
  if (!step || (step.type !== 'saveLead' && step.type !== 'tag')) return
  nodes.splice(idx, 1)
  retargetAll(nodes, stepId, step.next)
}

/** 第 index 題「照順序」的下一步：下一題；最後一題就是「直接到最後」（好幾種結尾時是第一種，新開的路預設接這裡） */
export function orderNextOf(view: QuestionListView, index: number): string {
  return view.items[index + 1]?.id ?? view.endId
}

/**
 * 這條路算不算「照順序」（畫面上不寫「答了 →」、換順序時跟著新順序走）：接下一題；
 * 最後一題接「最後」也算——但⛔ 好幾種結尾時不算：去哪一種結尾一定是他刻意選的（`D-149`）。
 */
export function isOrderTarget(view: QuestionListView, index: number, targetId: string): boolean {
  const next = view.items[index + 1]
  if (next) return targetId === next.id
  return view.endings.length === 1 && targetId === view.endId
}

/** 第 index 題的這條路會不會往回跳（指到自己或前面的題目）：換順序之後才可能出現，畫面要標紅 */
export function isBackwardTarget(view: QuestionListView, index: number, targetId: string): boolean {
  const t = view.items.findIndex(i => i.id === targetId)
  return t >= 0 && t <= index
}

/**
 * 換順序（拖曳、上移下移；2026-10-22 老闆要能拖曳排序）。
 * - 原本接「下一題」的路（最後一題的「直接到最後」也算）→ 換完還是接新的下一題；
 * - 特別指定跳到哪一題、或不是最後一題卻「直接到最後」的 → 跟著那一題走、不變
 *   （MYFEEL 查詢訂單第 1 題「答了 → 直接到最後」是刻意的，不能因為換順序被改掉）；
 * - 開頭一律接新的第一題（清單的規則：開頭要接第一題）。
 * 跳題因此可能變成往回跳——⛔ 不在這裡偷偷改掉，畫面用 isBackwardTarget 標紅，讓他自己決定。
 */
export function moveQuestion(nodes: ScriptNode[], view: QuestionListView, from: number, to: number): void {
  const items = view.items
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return

  // 先記下每一條路是不是「照順序」（用舊順序判）
  const followsOrder = items.map((it, i) => {
    const isOrder = (t: string | undefined) => Boolean(t) && isOrderTarget(view, i, t!)
    return it.type === 'collect'
      ? { next: isOrder(it.next), skip: isOrder(it.skipNext), options: [] as boolean[] }
      : { next: false, skip: false, options: it.options.map(o => isOrder(o.next)) }
  })

  const order = items.map((_, i) => i)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved!)
  const reordered = order.map(i => items[i]!)

  // 節點陣列裡題目佔的那幾格照新順序填回（題目以外的節點不動）
  const slots = nodes.flatMap((n, idx) => (n.type === 'collect' || n.type === 'quickReply' ? [idx] : []))
  slots.forEach((slot, k) => { nodes[slot] = reordered[k]! })

  reordered.forEach((it, j) => {
    const d = reordered[j + 1]?.id ?? view.endId
    const f = followsOrder[order[j]!]!
    if (it.type === 'collect') {
      if (f.next) it.next = d
      if (f.skip) it.skipNext = d
    }
    else {
      it.options.forEach((o, oi) => { if (f.options[oi]) o.next = d })
    }
  })
  view.trigger.next = reordered[0]!.id
}

/** 某一種結尾（預設第一種）換成另一種（回一段話 ↔ 送一個模組）：同一個 id，指到結尾的路都不用動 */
export function replaceTerminal(nodes: ScriptNode[], view: QuestionListView, next: ScriptReplyNode | ScriptModuleNode, ending: QuestionEnding = view.endings[0]!): void {
  const idx = nodes.findIndex(n => n.id === ending.terminal.id)
  if (idx < 0) return
  nodes.splice(idx, 1, { ...next, id: ending.terminal.id })
}

/**
 * 多一種結尾（`D-149`，按鈕「去哪」選「＋ 新的結尾」）：排在最後一種後面；第一種有「存進客人資料」的話
 * 照抄一份掛在前面——題目上勾的「存進客人資料」講的是「問到就存」，不管客人最後走到哪一種結尾。
 * 回傳新結尾的入口（給那顆按鈕接）。
 */
export function addEnding(nodes: ScriptNode[], view: QuestionListView, terminal: ScriptReplyNode | ScriptModuleNode, saveLead?: ScriptSaveLeadNode): string {
  const lastTerminal = view.endings[view.endings.length - 1]!.terminal
  const at = nodes.findIndex(n => n.id === lastTerminal.id) + 1
  const copyFrom = view.endings[0]!.saveLead
  if (copyFrom && saveLead) {
    saveLead.fieldMap = copyFrom.fieldMap.map(m => ({ ...m }))
    saveLead.next = terminal.id
    nodes.splice(at, 0, saveLead, terminal)
    return saveLead.id
  }
  nodes.splice(at, 0, terminal)
  return terminal.id
}

/** 拿掉一種結尾（至少留一種）：指到它的路改接 fallback 那一種，它的存進客人資料／貼標籤一起拿掉 */
export function removeEnding(nodes: ScriptNode[], view: QuestionListView, entryId: string, fallbackEntryId: string): void {
  const ending = view.endings.find(e => e.entryId === entryId)
  if (!ending || view.endings.length < 2 || entryId === fallbackEntryId) return
  const ids = new Set([ending.terminal.id, ending.saveLead?.id, ending.tag?.id].filter(Boolean) as string[])
  for (let i = nodes.length - 1; i >= 0; i--) if (ids.has(nodes[i]!.id)) nodes.splice(i, 1)
  retargetAll(nodes, entryId, fallbackEntryId)
}
