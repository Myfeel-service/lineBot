/**
 * 自動回應的設定畫面＝「問答清單」（`D-138`④；`D-150` 起只留這一套）。
 *
 * 2026-10-23 老闆：「應該做成通用的版本，讓 UX 操作盡量一致，而不是這樣硬改」——以前清單不會畫的
 * （好幾種結尾、看答案分路、中途貼標籤、接錯的步驟）就退回流程圖編法，碰到沒補的那一種，店家就看到另一套畫面。
 * 現在**任何一份流程都排得進清單**：
 * - 一題一張卡（問一題／給客人按鈕選），照節點順序；
 * - 「看答案走不同路」掛在那一題上：問一題的「答了」直接接一個依答案分路、而且只有它接過去（`D-150`①）；
 * - 貼在路上的標籤掛在那條路上：按了那顆按鈕就貼（`D-150`②）；
 * - 最後是一種或好幾種結尾（回一段話或送一個模組；前面可以掛存進客人資料與貼標籤各一個，`D-149`）；
 * - 剩下排不進去的步驟（舊資料、AI 草稿、改到一半）照樣列出來標黃，讓他刪掉或接回去（`D-150`③）——⛔ 不換畫面。
 *
 * ⛔ 這裡只「解讀」與「搬動」同一份節點，不另存一種格式，存檔的格式不變。
 */
import type {
  ScriptBranchNode,
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

/** 一題往外的一條路：答了／客人說沒有／一顆按鈕／看答案的一條／其他答案 */
export interface QuestionRoute {
  kind: 'answer' | 'skip' | 'option' | 'case' | 'other'
  /** 第幾顆按鈕、看答案的第幾條；其他種是 -1 */
  index: number
  /** 這條路現在直接指到的步驟（路上貼了標籤時是那個標籤步驟） */
  raw: string
  /** 穿過路上的標籤之後真正去的地方：一題、某一種結尾的入口、排不進清單的步驟，或空的（還沒選） */
  target: string
  /** 貼在這條路上的標籤步驟（照經過的順序；畫面上做出來的最多一個） */
  tags: ScriptTagNode[]
}

/** 排不進清單的步驟（`D-150`③）：照樣列出來標黃 */
export interface QuestionStray {
  node: ScriptNode
  /** 客人照樣走得到（只是清單排不進去）；false＝沒有路接到這裡 */
  reachable: boolean
}

export interface QuestionListView {
  trigger: ScriptTriggerNode
  /** 照節點順序排好的題目 */
  items: QuestionItem[]
  /** 題目 id → 接在它「答了」後面的看答案走不同路 */
  branches: Map<string, ScriptBranchNode>
  /** 貼在路上的標籤步驟（解讀一條路去哪時穿過它們） */
  routeTagIds: Set<string>
  /** 每一種結尾（至少一種），照結尾節點的順序（`D-149`） */
  endings: QuestionEnding[]
  strays: QuestionStray[]
  /** 從開頭沿著路走不到的題目與結尾入口（還在清單上，畫面標黃） */
  unreachable: Set<string>
  /** 第一種結尾的入口：只有一種結尾時＝「直接到最後」（以下三格同樣是第一種結尾的，舊程式照用） */
  endId: string
  terminal: ScriptReplyNode | ScriptModuleNode
  saveLead: ScriptSaveLeadNode | null
  tag: ScriptTagNode | null
  byId: Map<string, ScriptNode>
}

function isItem(n: ScriptNode | undefined): n is QuestionItem {
  return n?.type === 'collect' || n?.type === 'quickReply'
}

type EdgeKind = 'next' | 'skip' | 'option' | 'case' | 'other'
/** 一個步驟往外的每一條邊（跟存檔驗證的 outgoingNodeIds 同一套：客人說沒有只要有去處就算） */
function edges(n: ScriptNode): Array<{ to: string; kind: EdgeKind }> {
  const out: Array<{ to: string; kind: EdgeKind }> = []
  if (n.type === 'trigger' || n.type === 'tag' || n.type === 'saveLead') {
    if (n.next) out.push({ to: n.next, kind: 'next' })
  }
  else if (n.type === 'collect') {
    if (n.next) out.push({ to: n.next, kind: 'next' })
    if (n.skipNext) out.push({ to: n.skipNext, kind: 'skip' })
  }
  else if (n.type === 'quickReply') {
    for (const o of n.options) if (o.next) out.push({ to: o.next, kind: 'option' })
  }
  else if (n.type === 'branch') {
    for (const c of n.cases) if (c.next) out.push({ to: c.next, kind: 'case' })
    if (n.defaultNext) out.push({ to: n.defaultNext, kind: 'other' })
  }
  return out
}

/** 這個步驟屬於哪一種結尾（入口、存進客人資料、貼標籤、結尾本身都算）；不屬於任何一種回 null */
export function endingOfNode(view: QuestionListView, nodeId: string): QuestionEnding | null {
  return view.endings.find(e => e.entryId === nodeId || e.terminal.id === nodeId || e.saveLead?.id === nodeId || e.tag?.id === nodeId) ?? null
}

/** 解讀成清單；只有連開頭或結尾都沒有（資料壞掉）才回 null */
export function toQuestionList(nodes: ScriptNode[], rootNodeId: string): QuestionListView | null {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const trigger = byId.get(rootNodeId)
  if (!trigger || trigger.type !== 'trigger') return null
  const terminals = nodes.filter((n): n is ScriptReplyNode | ScriptModuleNode => n.type === 'reply' || n.type === 'module')
  if (!terminals.length) return null
  const terminalIds = new Set(terminals.map(t => t.id))

  const incoming = new Map<string, Array<{ from: ScriptNode; kind: EdgeKind }>>()
  for (const n of nodes) {
    for (const e of edges(n)) {
      if (!incoming.has(e.to)) incoming.set(e.to, [])
      incoming.get(e.to)!.push({ from: n, kind: e.kind })
    }
  }
  const inc = (id: string) => incoming.get(id) ?? []

  const items = nodes.filter(isItem)
  const itemIds = new Set(items.map(i => i.id))

  // ① 看答案走不同路：只有一題的「答了」接過去，才掛在那一題上
  const branches = new Map<string, ScriptBranchNode>()
  for (const n of nodes) {
    if (n.type !== 'branch') continue
    const ins = inc(n.id)
    if (ins.length === 1 && ins[0]!.kind === 'next' && ins[0]!.from.type === 'collect' && !branches.has(ins[0]!.from.id)) branches.set(ins[0]!.from.id, n)
  }
  const attachedBranchIds = new Set([...branches.values()].map(b => b.id))

  // ② 貼在路上的標籤：從一題（或它的看答案分路）出來的路上那一個；
  //    沒有記號的舊資料：後面接的是一題、或後面那一步還有別的路接過去（＝不是那一種結尾自己的標籤）
  const routeTagIds = new Set<string>()
  const isRouteSource = (n: ScriptNode) => isItem(n) || attachedBranchIds.has(n.id) || routeTagIds.has(n.id)
  for (let grew = true; grew;) {
    grew = false
    for (const n of nodes) {
      if (n.type !== 'tag' || routeTagIds.has(n.id) || !n.next || n.next === n.id) continue
      const ins = inc(n.id)
      const fromRoute = n.onRoute
        ? ins.length >= 1 && ins.every(i => isRouteSource(i.from))
        : ins.length === 1 && isRouteSource(ins[0]!.from)
      if (fromRoute && (n.onRoute || itemIds.has(n.next) || inc(n.next).length >= 2)) {
        routeTagIds.add(n.id)
        grew = true
      }
    }
  }

  // ③ 每一種結尾：其餘的存進客人資料／貼標籤要排成一條直線接到那個結尾，一種結尾各最多一個
  const chain = nodes.filter((n): n is ScriptSaveLeadNode | ScriptTagNode => (n.type === 'saveLead' || n.type === 'tag') && !routeTagIds.has(n.id))
  const chainIds = new Set(chain.map(c => c.id))
  const byTerminal = new Map<string, Array<ScriptSaveLeadNode | ScriptTagNode>>(terminals.map(t => [t.id, []]))
  const loose: ScriptNode[] = []
  for (const n of chain) {
    let cursor: string = n.id
    const seen = new Set<string>()
    let reached = true
    while (!terminalIds.has(cursor)) {
      // 繞圈、接到題目、接到不存在的步驟：排不進任何一種結尾
      if (seen.has(cursor) || !chainIds.has(cursor)) { reached = false; break }
      seen.add(cursor)
      cursor = (byId.get(cursor) as ScriptSaveLeadNode | ScriptTagNode).next
    }
    if (reached) byTerminal.get(cursor)!.push(n)
    else loose.push(n)
  }
  const endings: QuestionEnding[] = []
  for (const terminal of terminals) {
    const steps = byTerminal.get(terminal.id)!
    const saveLeads = steps.filter((n): n is ScriptSaveLeadNode => n.type === 'saveLead')
    const tags = steps.filter((n): n is ScriptTagNode => n.type === 'tag')
    const pointed = new Set(steps.map(n => n.next))
    const heads = [terminal.id, ...steps.map(n => n.id)].filter(id => !pointed.has(id))
    if (heads.length === 1 && saveLeads.length <= 1 && tags.length <= 1) {
      endings.push({ entryId: heads[0]!, terminal, saveLead: saveLeads[0] ?? null, tag: tags[0] ?? null })
    }
    else {
      // 排不成一條直線（兩條路各掛不同的步驟、同一種掛了兩個標籤…）：結尾照樣是一種，前面那幾步列成排不進去的
      endings.push({ entryId: terminal.id, terminal, saveLead: null, tag: null })
      loose.push(...steps)
    }
  }

  // ④ 其餘排不進去的：沒掛在題目上的看答案分路、多出來的開始、不認得的種類
  for (const n of nodes) {
    if (n.id === trigger.id || isItem(n) || terminalIds.has(n.id) || routeTagIds.has(n.id) || chainIds.has(n.id) || attachedBranchIds.has(n.id)) continue
    loose.push(n)
  }

  // ⑤ 從開頭沿著每一條路走得到哪些（跟存檔驗證同一套）
  const reach = new Set<string>()
  const queue = [trigger.id]
  while (queue.length) {
    const id = queue.shift()!
    if (reach.has(id)) continue
    reach.add(id)
    const n = byId.get(id)
    if (n) for (const e of edges(n)) queue.push(e.to)
  }
  const unreachable = new Set<string>()
  for (const it of items) if (!reach.has(it.id)) unreachable.add(it.id)
  for (const e of endings) if (!reach.has(e.entryId)) unreachable.add(e.entryId)

  const first = endings[0]!
  return {
    trigger,
    items,
    branches,
    routeTagIds,
    endings,
    strays: loose.map(node => ({ node, reachable: reach.has(node.id) })),
    unreachable,
    endId: first.entryId,
    terminal: first.terminal,
    saveLead: first.saveLead,
    tag: first.tag,
    byId,
  }
}

/** 穿過路上的標籤，這條路真正去哪 */
function followRouteTags(view: QuestionListView, raw: string): { target: string; tags: ScriptTagNode[] } {
  const tags: ScriptTagNode[] = []
  let cursor = raw
  while (view.routeTagIds.has(cursor) && !tags.some(t => t.id === cursor)) {
    const t = view.byId.get(cursor) as ScriptTagNode
    tags.push(t)
    cursor = t.next
  }
  return { target: cursor, tags }
}

/** 這條路（直接指到的是 raw）真正去哪 */
export function resolveTarget(view: QuestionListView, raw: string): string {
  return followRouteTags(view, raw).target
}

/** 一題往外的每一條路（看答案走不同路的那幾條取代「答了」） */
export function routesOf(view: QuestionListView, item: QuestionItem): QuestionRoute[] {
  const mk = (kind: QuestionRoute['kind'], index: number, raw: string): QuestionRoute => ({ kind, index, raw, ...followRouteTags(view, raw) })
  if (item.type === 'quickReply') return item.options.map((o, i) => mk('option', i, o.next))
  const out: QuestionRoute[] = []
  const branch = view.branches.get(item.id)
  if (branch) {
    branch.cases.forEach((c, i) => out.push(mk('case', i, c.next)))
    out.push(mk('other', -1, branch.defaultNext))
  }
  else out.push(mk('answer', -1, item.next))
  if (item.skipLabel?.trim() || item.skipNext) out.push(mk('skip', -1, item.skipNext ?? ''))
  return out
}

/** 改這條路直接指到哪（路上的標籤由 setRouteTags 管） */
function setRouteRaw(view: QuestionListView, item: QuestionItem, route: QuestionRoute, raw: string): void {
  if (item.type === 'quickReply') {
    if (route.kind === 'option' && item.options[route.index]) item.options[route.index]!.next = raw
    return
  }
  const branch = view.branches.get(item.id)
  if (route.kind === 'answer') item.next = raw
  else if (route.kind === 'skip') item.skipNext = raw
  else if (route.kind === 'case' && branch?.cases[route.index]) branch.cases[route.index]!.next = raw
  else if (route.kind === 'other' && branch) branch.defaultNext = raw
}

/** 改這條路去哪：路上貼了標籤的，標籤照貼、改標籤後面接哪 */
export function setRouteTarget(view: QuestionListView, item: QuestionItem, route: QuestionRoute, target: string): void {
  const last = route.tags[route.tags.length - 1]
  if (last) last.next = target
  else setRouteRaw(view, item, route, target)
}

function removeNodes(nodes: ScriptNode[], ids: Iterable<string>): void {
  const drop = new Set(ids)
  for (let i = nodes.length - 1; i >= 0; i--) if (drop.has(nodes[i]!.id)) nodes.splice(i, 1)
}

/** 拿掉路上的標籤：接到它的路改接它後面那一步（萬一有兩條路共用同一個也不會斷） */
function unlinkTags(nodes: ScriptNode[], tags: ScriptTagNode[]): void {
  for (const t of tags) {
    removeNodes(nodes, [t.id])
    retargetAll(nodes, t.id, t.next)
  }
}

/**
 * 這條路上貼哪些標籤（`D-150`②，按了那顆按鈕就貼）：空的＝不貼了、這條路直接接回去處；
 * 新貼的放一個標籤步驟在路上、記號 onRoute（不然「按鈕 → 貼標籤 → 結尾」會被讀成那一種結尾自己的標籤）。
 */
export function setRouteTags(nodes: ScriptNode[], view: QuestionListView, item: QuestionItem, route: QuestionRoute, tagIds: string[], newId: string): void {
  const [first, ...rest] = route.tags
  if (!tagIds.length) {
    unlinkTags(nodes, route.tags)
    return
  }
  if (first) {
    first.addTagIds = tagIds
    first.onRoute = true
    unlinkTags(nodes, rest)
    return
  }
  const tag: ScriptTagNode = { id: newId, type: 'tag', addTagIds: tagIds, next: route.target, onRoute: true }
  setRouteRaw(view, item, route, tag.id)
  // 排在那一題後面：節點順序不影響怎麼走，只是讀資料的人好找
  nodes.splice(nodes.findIndex(n => n.id === item.id) + 1, 0, tag)
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
 * 好幾種結尾（`D-149`）：最後一題的路（「客人說沒有」不算）全都去同一種結尾 → 新的這題接手那一種；
 * 各去不同的結尾（服務分流那種、看答案分到不同結尾）→ ⛔ 不動任何一條，新的這題先接第一種結尾、
 * 由他自己選哪條路要先問這題（猜錯一條就是把客人帶去別的結尾）。
 */
export function appendQuestion(nodes: ScriptNode[], view: QuestionListView, item: QuestionItem): void {
  const last = view.items[view.items.length - 1]
  const ends = new Set(view.endings.map(e => e.entryId))
  setItemNext(item, view.endId)
  if (!last) view.trigger.next = item.id
  else {
    const routes = routesOf(view, last).filter(r => r.kind !== 'skip')
    const toEnds = routes.filter(r => ends.has(r.target))
    const oneEnd = toEnds.length > 0 && toEnds.every(r => r.target === toEnds[0]!.target)
    if (view.endings.length === 1 || (oneEnd && toEnds.length === routes.length)) {
      if (toEnds[0]) setItemNext(item, toEnds[0].target)
      for (const r of toEnds) setRouteTarget(view, last, r, item.id)
    }
  }
  const at = last ? nodes.findIndex(n => n.id === last.id) + 1 : nodes.findIndex(n => n.id === view.trigger.id) + 1
  nodes.splice(at, 0, item)
}

/**
 * 拿掉一題＝不問這題了：指到它的路改接清單上的下一題（最後一題就是「直接到最後」）；
 * 掛在它上面的看答案分路、它路上貼的標籤一起拿掉；存進客人資料裡這題的欄位一起拿掉。
 * ⛔ 不接它「答了 →」的去處：MYFEEL 查詢訂單第 1 題答了直接到最後、後面四題只從「客人說沒有」走得到，
 * 照那條接＝開頭直接跳到最後、後面整串接不到、存不了檔（`C-379`）。
 */
export function removeQuestion(nodes: ScriptNode[], view: QuestionListView, itemId: string): void {
  const index = view.items.findIndex(i => i.id === itemId)
  const item = view.items[index]
  if (!item) return
  const branch = item.type === 'collect' ? view.branches.get(item.id) : undefined
  const routeTags = routesOf(view, item).flatMap(r => r.tags)
  removeNodes(nodes, [itemId, ...(branch ? [branch.id] : [])])
  unlinkTags(nodes, routeTags)
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
 * 這條路（傳真正的去處）算不算「照順序」（畫面上不寫「答了 →」、換順序時跟著新順序走）：接下一題；
 * 最後一題接「最後」也算——但⛔ 好幾種結尾時不算：去哪一種結尾一定是他刻意選的（`D-149`）。
 */
export function isOrderTarget(view: QuestionListView, index: number, targetId: string): boolean {
  const next = view.items[index + 1]
  if (next) return targetId === next.id
  return view.endings.length === 1 && targetId === view.endId
}

/** 第 index 題的這條路（傳真正的去處）會不會往回跳（指到自己或前面的題目）：換順序之後才可能出現，畫面要標紅 */
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

  // 「排在最後的那一題」接哪一種結尾：一種結尾就是它；好幾種時，原本最後一題的路（客人說沒有不算）全去同一種
  // 就是那一種——⛔ 不能一律用第一種：會員分流把最後一題（電話）往上拖，換到最後的那題會接到 VIP 的結尾
  const lastRoutes = routesOf(view, items[items.length - 1]!).filter(r => r.kind !== 'skip')
  const lastTargets = new Set(lastRoutes.map(r => r.target))
  const oneTail = lastTargets.size === 1 && view.endings.some(e => lastTargets.has(e.entryId))
  const tailEnd = oneTail ? [...lastTargets][0]! : view.endId

  // 先記下每一條路是不是「照順序」（用舊順序判；看答案的每一條、路上貼了標籤的都一樣算）。
  // 原本最後一題全去同一種結尾的也算照順序（好幾種結尾時 isOrderTarget 不算，那是給畫面寫出「答了 → 哪一種」用的）；
  // 各去不同結尾的（服務分流那種）照舊每一條都是指定的
  const lastIndex = items.length - 1
  const followsOrder = items.map((it, i) => routesOf(view, it).map(r => Boolean(r.target)
    && (isOrderTarget(view, i, r.target) || (oneTail && i === lastIndex && r.kind !== 'skip' && r.target === tailEnd))))

  const order = items.map((_, i) => i)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved!)
  const reordered = order.map(i => items[i]!)

  // 節點陣列裡題目佔的那幾格照新順序填回（題目以外的節點不動）
  const slots = nodes.flatMap((n, idx) => (isItem(n) ? [idx] : []))
  slots.forEach((slot, k) => { nodes[slot] = reordered[k]! })

  reordered.forEach((it, j) => {
    const d = reordered[j + 1]?.id ?? tailEnd
    const f = followsOrder[order[j]!]!
    routesOf(view, it).forEach((r, k) => { if (f[k]) setRouteTarget(view, it, r, d) })
  })
  view.trigger.next = reordered[0]!.id
}

/**
 * 開頭接的那一題排第一（舊資料、AI 草稿的節點順序可能跟走的順序對不上，「第 1 題」就講錯了）。
 * 只換題目在陣列裡的位置，客人怎麼走不變；打開一條時做一次。
 */
export function startFirst(nodes: ScriptNode[], rootNodeId: string): void {
  const trigger = nodes.find(n => n.id === rootNodeId)
  if (trigger?.type !== 'trigger') return
  const slots = nodes.flatMap((n, i) => (isItem(n) ? [i] : []))
  const startAt = nodes.findIndex(n => n.id === trigger.next)
  if (!slots.length || startAt < 0 || !isItem(nodes[startAt]) || startAt === slots[0]) return
  const ordered = slots.map(i => nodes[i]!)
  const [start] = ordered.splice(slots.indexOf(startAt), 1)
  ordered.unshift(start!)
  slots.forEach((slot, k) => { nodes[slot] = ordered[k]! })
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
  removeNodes(nodes, [ending.terminal.id, ending.saveLead?.id, ending.tag?.id].filter(Boolean) as string[])
  retargetAll(nodes, entryId, fallbackEntryId)
}

// ── 看答案走不同路（`D-150`①）──────────────────────────────────────────────

/**
 * 「⋯ → 看答案走不同路」：在這一題「答了」後面接一個依答案分路。
 * 原本答了去哪＝「其他答案」去哪（不改變現在的走法）；先給一條空的讓他填答案和去哪（存檔前沒填會被擋）。
 */
export function addBranch(nodes: ScriptNode[], item: ScriptCollectNode, id: string): ScriptBranchNode {
  const branch: ScriptBranchNode = {
    id,
    type: 'branch',
    cases: [{ field: item.fieldName, op: 'equals', value: '', next: '' }],
    defaultNext: item.next,
  }
  item.next = id
  nodes.splice(nodes.findIndex(n => n.id === item.id) + 1, 0, branch)
  return branch
}

/** 再加一條：看同一題的答案 */
export function addBranchCase(view: QuestionListView, item: ScriptCollectNode): void {
  view.branches.get(item.id)?.cases.push({ field: item.fieldName, op: 'equals', value: '', next: '' })
}

/** 拿掉一條（它路上貼的標籤一起）；拿光了＝不看答案了，這一題答了直接去「其他答案」那裡 */
export function removeBranchCase(nodes: ScriptNode[], view: QuestionListView, item: ScriptCollectNode, caseIndex: number): void {
  const branch = view.branches.get(item.id)
  if (!branch?.cases[caseIndex]) return
  const route = routesOf(view, item).find(r => r.kind === 'case' && r.index === caseIndex)
  branch.cases.splice(caseIndex, 1)
  // 這一條拿掉了，它路上的標籤沒有人接得到；拿掉時別的路如果共用，改接它後面那一步
  unlinkTags(nodes, route?.tags ?? [])
  if (!branch.cases.length) {
    item.next = branch.defaultNext
    removeNodes(nodes, [branch.id])
  }
}

// ── 排不進清單的步驟（`D-150`③）────────────────────────────────────────────

/** 刪掉一個排不進清單的步驟：接到它的路改接它後面那一步（保住後面的路） */
export function removeStray(nodes: ScriptNode[], nodeId: string): void {
  const idx = nodes.findIndex(n => n.id === nodeId)
  const node = nodes[idx]
  if (!node) return
  const onward = node.type === 'branch' ? node.defaultNext
    : node.type === 'tag' || node.type === 'saveLead' ? node.next
      : ''
  nodes.splice(idx, 1)
  retargetAll(nodes, nodeId, onward)
}
