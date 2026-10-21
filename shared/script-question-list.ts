/**
 * 自動回應的「問答清單」看法（`D-138`④）：照順序問的流程不用接線，一題一列就講得完。
 *
 * 哪些流程可以用清單編：一個開始、一個結尾（回一段話或送一個模組），中間只有「問一題」與「給按鈕選」，
 * 結尾前面可以掛「存進客人資料」與「貼標籤」各一個。每一題的去向只能是別一題或「最後」——
 * MYFEEL 的查詢訂單、更改地址、新增備註都是這種。有「依答案分路」、或好幾個結尾（服務分流那種）的，
 * 照舊用流程圖編，資料一樣、只是看法不同。
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

export interface QuestionListView {
  trigger: ScriptTriggerNode
  /** 照節點順序排好的題目 */
  items: QuestionItem[]
  /** 「最後」那一段的入口（存進客人資料／貼標籤／結尾三者中最前面那個）：題目的去向指這裡＝直接到最後 */
  endId: string
  terminal: ScriptReplyNode | ScriptModuleNode
  saveLead: ScriptSaveLeadNode | null
  tag: ScriptTagNode | null
}

function isItem(n: ScriptNode): n is QuestionItem {
  return n.type === 'collect' || n.type === 'quickReply'
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
  if (terminals.length !== 1) return null
  const terminal = terminals[0]!
  const saveLeads = nodes.filter((n): n is ScriptSaveLeadNode => n.type === 'saveLead')
  const tags = nodes.filter((n): n is ScriptTagNode => n.type === 'tag')
  if (saveLeads.length > 1 || tags.length > 1) return null

  // 「最後」那一段：存進客人資料／貼標籤要排成一條直線接到結尾，入口是沒有被它們指到的那一個
  const chain = [...saveLeads, ...tags]
  const chainIds = new Set<string>([terminal.id, ...chain.map(n => n.id)])
  for (const n of chain) if (!chainIds.has(n.next)) return null
  const pointedInChain = new Set(chain.map(n => n.next))
  const heads = [...chainIds].filter(id => !pointedInChain.has(id))
  if (heads.length !== 1) return null
  const endId = heads[0]!
  // 從入口走一遍要經過整條、到得了結尾（不能有圈）
  let cursor = endId
  const seen = new Set<string>()
  while (cursor !== terminal.id) {
    if (seen.has(cursor)) return null
    seen.add(cursor)
    const n = chain.find(c => c.id === cursor)
    if (!n) return null
    cursor = n.next
  }
  if (seen.size !== chain.length) return null

  const items = nodes.filter(isItem)
  if (items.length + chain.length + 2 !== nodes.length) return null // 有清單不認得的步驟
  const allowed = new Set([...items.map(i => i.id), endId])
  if (!allowed.has(trigger.next)) return null
  if (items.length && trigger.next !== items[0]!.id) return null // 第一題要是開頭接的那一題
  if (!items.length && trigger.next !== endId) return null
  for (const item of items) {
    if (itemTargets(item).some(t => !allowed.has(t))) return null
  }

  return {
    trigger,
    items,
    endId,
    terminal,
    saveLead: saveLeads[0] ?? null,
    tag: tags[0] ?? null,
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

/**
 * 在最後一題後面加一題（沒有題目＝加在開頭後面）。
 * 原本最後一題「答了 → 直接到最後」的路改接到新的這題，新的這題答了 → 直接到最後。
 * 前面那幾題指「直接到最後」的不動（「答得出編號就收尾」是刻意的）。
 */
export function appendQuestion(nodes: ScriptNode[], view: QuestionListView, item: QuestionItem): void {
  const last = view.items[view.items.length - 1]
  if (item.type === 'collect') item.next = view.endId
  else for (const o of item.options) o.next = view.endId
  if (!last) view.trigger.next = item.id
  else if (last.type === 'collect') { if (last.next === view.endId) last.next = item.id }
  else for (const o of last.options) if (o.next === view.endId) o.next = item.id
  const at = last ? nodes.findIndex(n => n.id === last.id) + 1 : nodes.findIndex(n => n.id === view.trigger.id) + 1
  nodes.splice(at, 0, item)
}

/** 拿掉一題：指到它的路改接它「答了之後」那條；存進客人資料裡這題的欄位一起拿掉 */
export function removeQuestion(nodes: ScriptNode[], view: QuestionListView, itemId: string): void {
  const item = view.items.find(i => i.id === itemId)
  if (!item) return
  const fallback = item.type === 'collect' ? item.next : (item.options[0]?.next ?? view.endId)
  const idx = nodes.findIndex(n => n.id === itemId)
  nodes.splice(idx, 1)
  retargetAll(nodes, itemId, fallback === itemId ? view.endId : fallback)
  if (item.type === 'collect' && view.saveLead) {
    view.saveLead.fieldMap = view.saveLead.fieldMap.filter(m => m.fromField !== item.fieldName)
    if (!view.saveLead.fieldMap.length) removeEndStep(nodes, view.saveLead.id)
  }
}

/** 在「最後」那一段最前面掛一步（存進客人資料／貼標籤）：原本指「直接到最後」的路都改接它 */
export function insertEndStep(nodes: ScriptNode[], view: QuestionListView, step: ScriptSaveLeadNode | ScriptTagNode): void {
  step.next = view.endId
  retargetAll(nodes, view.endId, step.id)
  const at = nodes.findIndex(n => n.id === view.terminal.id)
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

/** 第 index 題「照順序」的下一步：下一題；最後一題就是「直接到最後」 */
export function orderNextOf(view: QuestionListView, index: number): string {
  return view.items[index + 1]?.id ?? view.endId
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
    const d = orderNextOf(view, i)
    return it.type === 'collect'
      ? { next: it.next === d, skip: Boolean(it.skipNext) && it.skipNext === d, options: [] as boolean[] }
      : { next: false, skip: false, options: it.options.map(o => o.next === d) }
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

/** 結尾換成另一種（回一段話 ↔ 送一個模組）：同一個 id，指到結尾的路都不用動 */
export function replaceTerminal(nodes: ScriptNode[], view: QuestionListView, next: ScriptReplyNode | ScriptModuleNode): void {
  const idx = nodes.findIndex(n => n.id === view.terminal.id)
  if (idx < 0) return
  nodes.splice(idx, 1, { ...next, id: view.terminal.id })
}
