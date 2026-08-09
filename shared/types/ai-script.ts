import type { Timestamp, FieldValue } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════
//  Script types
//  Path: scripts/{scriptId}  （top-level + workspaceId 欄位）
//
//  腳本 = 多步驟客服情境。線性流程：trigger → collect → reply
//  簡報 p23 提到的四種步驟：觸發 / 收集 / API / 回覆
//  Phase 3 不含 API 步驟（屬 Phase 5 即時資料工具）
// ═══════════════════════════════════════════════════════════════════

export type ScriptNodeType = 'trigger' | 'collect' | 'reply' | 'branch' | 'quickReply' | 'tag' | 'saveLead' | 'module'

/**
 * 步驟類型的顯示名稱：驗證訊息、編輯器節點卡、流程圖、下拉選項、積木選單共用同一份，
 * 改名只改這裡（散在四處各寫一份的時候，改一半就會出現同一個東西兩個名字）。
 * 「快速回覆」是 LINE 官方術語刻意保留原文；其餘用白話（分支→依答案分路、寫名單→存進客人資料）。
 */
export const SCRIPT_NODE_TYPE_LABELS: Record<ScriptNodeType, string> = {
  trigger: '觸發',
  collect: '收集',
  reply: '回覆',
  branch: '依答案分路',
  quickReply: '快速回覆',
  tag: '貼標',
  saveLead: '存進客人資料',
  module: '機器人模組',
}

/** 觸發比對方式：keyword=關鍵字子字串；semantic=意圖範例向量比對（看意思不看用字） */
export type TriggerMatchMode = 'keyword' | 'semantic'

/**
 * 關鍵字要怎麼比對。與自動回覆規則的 matchType 同一組語意——
 * 兩邊要能互換（一句話的設定和多步驟流程是同一種東西的不同深度），比對能力就不能只有一邊有。
 * 省略時視為 'any'，等同舊行為（任一關鍵字是子字串即命中）。
 */
export type TriggerKeywordMatch = 'any' | 'all' | 'exact' | 'anyText'

export interface ScriptTriggerNode {
  id: string
  type: 'trigger'
  /** keyword 模式：任一關鍵字命中就觸發 */
  keywords: string[]
  /** 比對方式；省略時視為 'keyword'（向後相容舊腳本） */
  matchMode?: TriggerMatchMode
  /** 關鍵字怎麼比；省略時視為 'any'（向後相容舊腳本） */
  keywordMatch?: TriggerKeywordMatch
  /** semantic 模式：意圖範例句（使用者填，例「我要退貨」「想退」「能不能取消訂單」） */
  examples?: string[]
  /**
   * semantic 模式：examples 對應的 embedding（768 維，順序與 examples 對齊）。
   * 由 server 在存檔時計算，**不接受前端傳入、也不回傳給前端編輯器**。
   *
   * 注意：每個向量包一層 `{ values }` map——Firestore 不允許「陣列直接包陣列」，
   * 純 number[][] 會被拒（INVALID_ARGUMENT: array contains an invalid nested entity）。
   */
  exampleEmbeddings?: Array<{ values: number[] }>
  /**
   * 選填：同一位客人在這段毫秒數內不會再被這條腳本接走一次（＝自動回覆的「防重複觸發」）。
   * 0／省略＝不設限。可選值同 AUTO_REPLY_COOLDOWN_DURATIONS_MS，兩邊講的是同一件事。
   */
  cooldownMs?: number
  /** 1–100，越大越優先；多腳本同時命中時取最高 */
  priority: number
  /** 下一個步驟 id；空字串視為直接結束 */
  next: string
}

/** collect 步驟的答案格式：用來「抽取」命中片段並「驗證」格式，不符就重問 */
export type CollectFormat = 'any' | 'phone' | 'email' | 'number' | 'alphanumeric' | 'alphanumericSymbol' | 'custom'

export interface ScriptCollectNode {
  id: string
  type: 'collect'
  /** 問使用者的問題（例：請輸入您的訂單編號） */
  question: string
  /** 收到的值要存到 collected[fieldName]，後面 reply 可用 {{fieldName}} 取用 */
  fieldName: string
  /** 等待使用者輸入的逾時毫秒；超過後 activeScript 失效 */
  expireMs: number
  /** 答案格式；'any'（預設）= 整句原樣存。其餘會從訊息中抽出命中片段、抽不到就重問 */
  format?: CollectFormat
  /** format==='custom' 時的正則字串（用來抽取＋驗證） */
  pattern?: string
  /** 驗證失敗時的重問話術；空字串時用預設重問語 */
  reaskText?: string
  /**
   * 跳過出口（選填、成對）：客人「沒有這個資料」的退路。
   * 問問題與格式重問時都會多一顆 skipLabel 按鈕（LINE Quick Reply），
   * 客人點了（或手打整句 label）就不收值、直接跳到 skipNext。
   * 例：問訂單編號附「我沒有訂單編號」→ 跳去改問 Email。
   */
  skipLabel?: string
  /** 跳過按鈕要跳到的步驟 id；與 skipLabel 成對出現 */
  skipNext?: string
  next: string
}

export interface ScriptReplyNode {
  id: string
  type: 'reply'
  /** 回覆文字；可用 {{fieldName}} 與 {{屬性名}} 變數 */
  text: string
  /**
   * 選填：回覆後附一顆連結按鈕（＝自動回覆的「開啟網址」動作）。
   * 網址同樣吃 {{變數}}，所以可以把收集到的訂單編號帶進查詢頁。
   */
  linkUrl?: string
  /** 連結按鈕上的字；留空用預設 */
  linkLabel?: string
  /** 回覆完是否轉真人（live_agent） */
  thenHandoff: boolean
}

/** 連結按鈕沒填文字時的預設（與自動回覆的「開啟網址」一致） */
export const DEFAULT_REPLY_LINK_LABEL = '開啟網址'

/** 取這條腳本的冷卻毫秒數（沒設／不合法＝0，代表不設限） */
export function scriptCooldownMs(script: Pick<ScriptDoc, 'nodes' | 'rootNodeId'>): number {
  const root = script.nodes?.find(n => n.id === script.rootNodeId)
  if (root?.type !== 'trigger') return 0
  const ms = Number(root.cooldownMs ?? 0)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** 分支條件：對某個已收集欄位做確定性判斷（零 LLM） */
export type BranchOp = 'exists' | 'equals' | 'contains'

export interface ScriptBranchCase {
  /** exists=有沒有收集到；equals=完全相等；contains=包含子字串 */
  op: BranchOp
  /** 要判斷的已收集欄位名（對應 collect 的 fieldName） */
  field: string
  /** equals / contains 用的比較值；exists 不需要 */
  value?: string
  /** 條件成立要跳到的步驟 id */
  next: string
}

export interface ScriptBranchNode {
  id: string
  type: 'branch'
  /** 由上而下逐條判斷，第一條成立者勝出 */
  cases: ScriptBranchCase[]
  /** 全部條件都不成立時的預設出口步驟 id */
  defaultNext: string
}

export interface ScriptQuickReplyOption {
  /** 按鈕文字（≤20 字，LINE 規格）；也是客人點按後送出的文字、用來比對走哪條路 */
  label: string
  /** 點這顆要跳到的步驟 id */
  next: string
}

export interface ScriptQuickReplyNode {
  id: string
  type: 'quickReply'
  /** 出選項時一起送出的問句 */
  question: string
  /** 互動等待逾時毫秒；超過後 activeScript 失效 */
  expireMs: number
  options: ScriptQuickReplyOption[]
}

/** ⑩ 貼標步驟：流程走到這裡就替客人貼上指定標籤，然後往下 */
export interface ScriptTagNode {
  id: string
  type: 'tag'
  /** 要貼的標籤 id（對應 workspace 既有標籤系統） */
  addTagIds: string[]
  next: string
}

/** ⑪「存進客人資料」的單欄映射：把 collected[fromField] 寫進 user attributes[attrKey] */
export interface ScriptSaveLeadField {
  /** 來源：collect 收集到的 fieldName */
  fromField: string
  /** 目標：要寫進的使用者屬性名（之後可用 {{attrKey}} 取用、後台也看得到） */
  attrKey: string
}

/** ⑪「存進客人資料」步驟：把收集到的欄位映射寫進使用者屬性（持久化、後台可見），然後往下 */
export interface ScriptSaveLeadNode {
  id: string
  type: 'saveLead'
  fieldMap: ScriptSaveLeadField[]
  next: string
}

/**
 * ⑫ 機器人模組步驟：送出某個機器人模組的全部訊息，然後結束流程
 * （＝自動回覆的「觸發機器人模組」動作）。和 reply 一樣是終點，沒有 next。
 */
export interface ScriptModuleNode {
  id: string
  type: 'module'
  moduleId: string
}

export type ScriptNode =
  | ScriptTriggerNode
  | ScriptCollectNode
  | ScriptReplyNode
  | ScriptBranchNode
  | ScriptQuickReplyNode
  | ScriptTagNode
  | ScriptSaveLeadNode
  | ScriptModuleNode

/** 腳本成效統計（FieldValue.increment 累計；近似值，供後台觀察哪些腳本真的跑完） */
export interface ScriptStats {
  /** 啟動次數（命中觸發、進入腳本） */
  starts: number
  /** 完成次數（流程跑到 reply 步驟、正常收工） */
  completions: number
}

export interface ScriptDoc {
  workspaceId: string
  name: string
  enabled: boolean
  /** 多腳本同時命中時的優先序：由 trigger.priority 決定，這欄為快取方便 list 排序 */
  priority: number
  nodes: ScriptNode[]
  /** 起始步驟 id（必為 trigger 步驟） */
  rootNodeId: string
  /** 成效統計（可能不存在＝尚未跑過） */
  stats?: ScriptStats
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  User active script state（會掛在 UserDoc.activeScript）
// ═══════════════════════════════════════════════════════════════════

export interface ActiveScriptState {
  scriptId: string
  currentNodeId: string
  collected: Record<string, string>
  startedAt: number
  /** epoch ms；超過此時間下一則訊息進來會直接重置（避免使用者放著不回，下次入店被中斷流程攔截） */
  expiresAt: number
}

// ═══════════════════════════════════════════════════════════════════
//  Defaults & validators
// ═══════════════════════════════════════════════════════════════════

/**
 * 客人「明確要求真人」的說法(整句精確比對,trim 後)。
 * AI 層攔截、腳本逃生門、試跑面板共用同一份——要加詞改這裡,全系統生效。
 * 用精確比對(非子字串)避免誤傷:客人的答案(訂單編號、姓名…)不可能整句剛好等於這些詞。
 */
export const HUMAN_REQUEST_TEXTS = new Set(['找真人', '🙋 找真人', '轉真人', '真人客服'])

/** 這句話是不是在喊找真人(腳本進行中優先於「當答案處理」) */
export function isHumanRequestText(text: string): boolean {
  return HUMAN_REQUEST_TEXTS.has(String(text || '').trim())
}

export const DEFAULT_SCRIPT_PRIORITY = 50
export const DEFAULT_COLLECT_EXPIRE_MS = 10 * 60 * 1000 // 10 分鐘沒回就放棄
export const MAX_SCRIPT_NODES = 20
/** semantic 觸發每個步驟最多幾句範例 */
export const MAX_TRIGGER_EXAMPLES = 10
/** 快速回覆每個步驟最多幾個選項（LINE Quick Reply 上限 13，這裡留保守值） */
export const MAX_QUICK_REPLY_OPTIONS = 10
/**
 * semantic 觸發命中門檻（inbound 與範例的 cosine 相似度上限需 ≥ 此值）。
 * 實測（gemini-embedding-001，doc/query 非對稱）：同義句如「我要預約」對範例「預約」約 0.75–0.80、
 * 「預約咖啡機」約 0.75；不相關腳本則落在 0.57–0.65。兩者之間有清楚的縫，門檻取 0.72
 * 可全抓對的、全擋掉錯的。早期設 0.80 過嚴、把明顯同義句也漏接。可日後做成 per-workspace 設定。
 */
export const DEFAULT_SEMANTIC_TRIGGER_THRESHOLD = 0.72

/**
 * 步驟所有「出口」步驟 id（圖驗證 / 可達性用）。
 * reply 是終點無出口；branch 有 cases + defaultNext 多出口；trigger/collect 單一 next。
 * 空字串會被過濾掉（代表未接線，交給驗證另外報錯）。
 */
export function outgoingNodeIds(node: ScriptNode): string[] {
  if (node.type === 'reply' || node.type === 'module') return []
  if (node.type === 'branch') return [...node.cases.map(c => c.next), node.defaultNext].filter(Boolean)
  if (node.type === 'quickReply') return node.options.map(o => o.next).filter(Boolean)
  if (node.type === 'collect') return [node.next, node.skipNext ?? ''].filter(Boolean)
  return node.next ? [node.next] : []
}

/** 單一分支條件對已收集欄位求值（純函式、確定性、零 LLM） */
export function evaluateBranchCase(c: ScriptBranchCase, collected: Record<string, string>): boolean {
  const v = collected[c.field]
  if (c.op === 'exists') return v != null && v !== ''
  if (c.op === 'equals') return v === (c.value ?? '')
  if (c.op === 'contains') return (v ?? '').includes(c.value ?? '')
  return false
}

/** 依序求值，第一條成立的 case.next 勝出；都不成立回 defaultNext */
export function resolveBranchNext(node: ScriptBranchNode, collected: Record<string, string>): string {
  for (const c of node.cases) {
    if (evaluateBranchCase(c, collected)) return c.next
  }
  return node.defaultNext
}

export function validateScriptDoc(doc: Pick<ScriptDoc, 'name' | 'nodes' | 'rootNodeId'>): string | null {
  if (!String(doc.name || '').trim()) return '請輸入腳本名稱'
  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) return '請至少新增一個步驟'
  if (doc.nodes.length > MAX_SCRIPT_NODES) return `步驟數超過上限 ${MAX_SCRIPT_NODES}`

  const ids = new Set<string>()
  for (const n of doc.nodes) {
    if (!n.id) return '步驟 id 不能為空'
    if (ids.has(n.id)) return `步驟 id 重複：${n.id}`
    ids.add(n.id)
  }

  if (!doc.rootNodeId || !ids.has(doc.rootNodeId)) return '請指定起始步驟'
  const root = doc.nodes.find(n => n.id === doc.rootNodeId)
  if (!root || root.type !== 'trigger') return '起始步驟必須是「觸發」類型'

  // trigger 步驟只能有一個（單一入口）
  const triggerCount = doc.nodes.filter(n => n.type === 'trigger').length
  if (triggerCount !== 1) return '腳本必須有且僅有一個觸發步驟'

  // 至少要有一個「終點」步驟（且下方會驗它可達）：回覆，或送出機器人模組
  if (!doc.nodes.some(n => n.type === 'reply' || n.type === 'module')) {
    return '腳本至少要有一個結尾步驟（回覆，或送出機器人模組）'
  }

  // collected 只會由 collect 步驟寫入；branch 條件與 saveLead 來源都讀 collected，
  // 故其欄位名必須對應某個 collect 的 fieldName，否則永遠是空值（typo / 順序錯）會靜默失效。
  const collectFieldNames = new Set(
    doc.nodes.filter(n => n.type === 'collect').map(n => (n as ScriptCollectNode).fieldName.trim()).filter(Boolean),
  )

  // 所有出口必須指到存在的步驟；非 reply 步驟不能有空出口
  for (const n of doc.nodes) {
    // reply / module 是終點，沒有出口要驗
    if (n.type === 'reply') continue
    if (n.type === 'module') {
      if (!n.moduleId?.trim()) return '「機器人模組」步驟請選擇要送出的模組'
      continue
    }
    const outs = outgoingNodeIds(n)
    if (n.type === 'branch') {
      if (!n.defaultNext || !ids.has(n.defaultNext)) return `「依答案分路」步驟請設定「其餘情況」的下一步`
      for (const c of n.cases) {
        const field = c.field?.trim() ?? ''
        if (!field) return '分路條件請選擇要判斷的欄位'
        if (!collectFieldNames.has(field)) return `分路條件的欄位「${field}」沒有對應的收集步驟，請確認欄位名`
        if ((c.op === 'equals' || c.op === 'contains') && !String(c.value ?? '').trim()) {
          return '分路條件（等於／包含）請填寫比較值'
        }
        if (!c.next || !ids.has(c.next)) return '分路條件請指定條件成立要跳到的步驟'
      }
    }
    else if (n.type === 'quickReply') {
      if (!n.question?.trim()) return '快速回覆步驟請填寫問句（會和按鈕一起送出）'
      if (n.options.length === 0) return '快速回覆步驟請至少新增一個選項'
      const seenLabels = new Set<string>()
      for (const o of n.options) {
        const label = o.label?.trim() ?? ''
        if (!label) return '快速回覆的選項請填寫按鈕文字'
        // label 是「客人送出的文字」用來比對走哪條路；重複會讓後面那顆永遠選不到
        if (seenLabels.has(label)) return `快速回覆有重複的按鈕文字「${label}」，請改成不同名稱`
        seenLabels.add(label)
        if (!o.next || !ids.has(o.next)) return `快速回覆選項「${label}」請指定要跳到的步驟`
      }
    }
    else if (n.type === 'tag') {
      if (!n.addTagIds.length) return '貼標步驟請至少選一個標籤'
      if (!n.next || !ids.has(n.next)) return `步驟「${nodeLabelOf(n)}」未指定下一步`
    }
    else if (n.type === 'saveLead') {
      if (!n.fieldMap.length) return '「存進客人資料」步驟請至少設定一個欄位對應'
      for (const m of n.fieldMap) {
        const from = m.fromField?.trim() ?? ''
        if (!from || !m.attrKey?.trim()) return '「存進客人資料」的欄位對應請填寫來源欄位與屬性名'
        if (!collectFieldNames.has(from)) return `「存進客人資料」的來源欄位「${from}」沒有對應的收集步驟，請確認欄位名`
      }
      if (!n.next || !ids.has(n.next)) return `步驟「${nodeLabelOf(n)}」未指定下一步`
    }
    else if (n.type === 'collect') {
      if (!n.next || !ids.has(n.next)) return `步驟「${nodeLabelOf(n)}」未指定下一步`
      // 跳過出口：skipLabel / skipNext 必須成對且有效，否則按鈕會是死路
      const skipLabel = String(n.skipLabel ?? '').trim()
      const skipNext = String(n.skipNext ?? '').trim()
      if (skipLabel && !skipNext) return `收集步驟「${n.fieldName || ''}」的跳過按鈕「${skipLabel}」還沒指定要跳到哪一步`
      if (!skipLabel && skipNext) return `收集步驟「${n.fieldName || ''}」設定了跳過路線，請填寫按鈕文字（例：我沒有訂單編號）`
      if (skipNext && !ids.has(skipNext)) return `收集步驟「${n.fieldName || ''}」的跳過按鈕接到不存在的步驟`
      // 撞名保護:跳過按鈕若剛好是「找真人」這類求助詞,逃生門會先攔走、永遠到不了 skipNext
      if (skipLabel && isHumanRequestText(skipLabel)) return `跳過按鈕文字「${skipLabel}」是轉真人的求助詞，客人點了會直接轉真人；請換個說法（例：我沒有訂單編號）`
    }
    else if (outs.length === 0 || outs.some(t => !ids.has(t))) {
      return `步驟「${nodeLabelOf(n)}」未指定下一步`
    }
  }

  // custom 格式的 collect 必須有正則，否則會變成「全部放行」的假驗證
  for (const n of doc.nodes) {
    if (n.type === 'collect' && n.format === 'custom' && !String(n.pattern || '').trim()) {
      return `收集步驟「${n.fieldName || ''}」選了自訂格式，請填寫正則表達式`
    }
    // 連結按鈕：LINE 只收 https/http/tel/line 開頭的網址，其餘會在送出當下被整則退掉——
    // 那是客人收不到訊息、後台卻看不出原因的失敗，所以在存檔就擋下來。
    // 開頭是 {{變數}} 的放行（例：{{shopUrl}}/order），真正的網址是執行時才組出來的。
    if (n.type === 'reply' && n.linkUrl) {
      const url = String(n.linkUrl).trim()
      if (!url.includes('{{') && !/^(https?|tel|line):/i.test(url)) {
        return `連結按鈕的網址要以 https:// 開頭（目前是「${url.slice(0, 30)}」），LINE 只接受這種格式`
      }
    }
  }

  // trigger 的觸發條件：依模式檢查（keyword 要關鍵字、semantic 要範例句）
  const trigger = root as ScriptTriggerNode
  if ((trigger.matchMode ?? 'keyword') === 'semantic') {
    if ((trigger.examples ?? []).filter(e => e.trim()).length === 0) {
      return '語意觸發請至少填一句意圖範例'
    }
  }
  // anyText 的意思就是「不看關鍵字、有文字就命中」，這時候要求填關鍵字是自相矛盾的
  else if ((trigger.keywordMatch ?? 'any') !== 'anyText' && trigger.keywords.filter(k => k.trim()).length === 0) {
    return '請為觸發步驟設定至少一個關鍵字'
  }

  // 圖驗證：① 每個步驟都從觸發可達（無孤兒）② 每個步驟都能走到某個 reply（無死路 / 無法收尾的循環）
  const byId = new Map(doc.nodes.map(n => [n.id, n]))
  const reachableFromRoot = new Set<string>()
  const queue = [doc.rootNodeId]
  while (queue.length) {
    const id = queue.shift()!
    if (reachableFromRoot.has(id)) continue
    reachableFromRoot.add(id)
    const node = byId.get(id)
    if (node) for (const t of outgoingNodeIds(node)) if (ids.has(t)) queue.push(t)
  }
  for (const n of doc.nodes) {
    if (!reachableFromRoot.has(n.id)) return `步驟「${nodeLabelOf(n)}」接不到流程裡，請把它接上或刪除`
  }

  // 反向可達：從所有 reply 往回 BFS，標出「能走到 reply」的步驟
  const reverse = new Map<string, string[]>()
  for (const n of doc.nodes) {
    for (const t of outgoingNodeIds(n)) {
      if (!reverse.has(t)) reverse.set(t, [])
      reverse.get(t)!.push(n.id)
    }
  }
  // 從「終點」倒著走：回覆與機器人模組都是合法結尾（trigger → module 就是一條完整的設定）
  const canReachEnd = new Set<string>()
  const rq = doc.nodes.filter(n => n.type === 'reply' || n.type === 'module').map(n => n.id)
  while (rq.length) {
    const id = rq.shift()!
    if (canReachEnd.has(id)) continue
    canReachEnd.add(id)
    for (const p of reverse.get(id) ?? []) rq.push(p)
  }
  for (const n of doc.nodes) {
    if (!canReachEnd.has(n.id)) return `步驟「${nodeLabelOf(n)}」沒有任何路徑通到結尾，流程會卡住`
  }

  // ③ 由「只含非互動步驟」的邊構成的循環會在 runtime 無限跳轉（branch/trigger/tag/saveLead 不等輸入，
  //    分支條件又不變）。collect / quickReply 是「停等輸入」點，每輪會停下，故凡是邊的任一端是互動步驟
  //    就排除——只在「非互動 → 非互動」的子圖上找環。
  //    注意：runtime 會從每個互動步驟的 next「重新開走」，所以環可能藏在某個 collect 後面，
  //    DFS 必須從每個非互動步驟起跑（不能只從 root），否則藏在互動步驟後的環會漏判。
  const INTERACTIVE_TYPES = new Set<ScriptNodeType>(['collect', 'quickReply'])
  const isInteractive = (id: string): boolean => {
    const nd = byId.get(id)
    return nd ? INTERACTIVE_TYPES.has(nd.type) : false
  }
  const color = new Map<string, 1 | 2>() // 1=走訪中(gray) 2=完成(black)
  const dfsCycle = (id: string): boolean => {
    color.set(id, 1)
    const node = byId.get(id)
    if (node) {
      for (const t of outgoingNodeIds(node)) {
        if (!ids.has(t) || isInteractive(t)) continue // 只走「非互動 → 非互動」的邊
        const c = color.get(t)
        if (c === 1) return true
        if (c === undefined && dfsCycle(t)) return true
      }
    }
    color.set(id, 2)
    return false
  }
  for (const n of doc.nodes) {
    if (INTERACTIVE_TYPES.has(n.type) || color.get(n.id) !== undefined) continue
    if (dfsCycle(n.id)) {
      return '流程有繞回自己的死循環（步驟之間互指、中間卻沒有任何「收集／快速回覆」讓客人輸入），請調整'
    }
  }

  return null
}

function nodeLabelOf(node: ScriptNode): string {
  if (node.type === 'collect') return `收集 ${node.fieldName || ''}`.trim()
  // 舊資料可能帶著對照表裡沒有的類型；沒有這個保底會讓錯誤訊息變成「步驟「undefined」…」
  return SCRIPT_NODE_TYPE_LABELS[node.type] ?? '步驟'
}

// ═══════════════════════════════════════════════════════════════════
//  Template rendering（簡報 p15 的勾選式動作之外，這裡是 Phase 3 變數機制）
//  {{fieldName}} 從 collected 取；不存在會被原樣留下避免誤刪
// ═══════════════════════════════════════════════════════════════════

export function renderScriptTemplate(
  template: string,
  ctx: { collected?: Record<string, string>; attributes?: Record<string, string> } = {},
): string {
  if (!template) return ''
  return String(template).replace(/\{\{\s*([\w一-龥]+)\s*\}\}/g, (_, key) => {
    const c = ctx.collected?.[key]
    if (c != null && c !== '') return c
    const a = ctx.attributes?.[key]
    if (a != null && a !== '') return a
    return `{{${key}}}` // 找不到值就留原字串方便排查
  })
}

// ═══════════════════════════════════════════════════════════════════
//  Collect 抽取 / 驗證
//  預設 regex 同時負責「抽出命中片段」與「驗證格式」：抽得到 = 通過，抽不到 = 重問。
//  CJK 句子裡數字/電話前後沒有 \b，故用非邊界寫法。
// ═══════════════════════════════════════════════════════════════════

const COLLECT_FORMAT_PATTERNS: Record<Exclude<CollectFormat, 'any' | 'custom'>, RegExp> = {
  // 台灣手機 09xxxxxxxx 或市話 0x-xxxxxxxx（允許中間有 - 或空白）。
  // 前後加數字邊界，避免從更長的數字串（如卡號、長編號）裡截一段假電話；長度另在下方驗 9–10 碼。
  phone: /(?<!\d)0\d{1,3}[-\s]?\d{6,8}(?!\d)/,
  email: /[^\s@]+@[^\s@]+\.[^\s@]+/,
  number: /\d+/,
  // 英文+數字：連續 ≥2 碼英數（訂單編號、序號、代碼）。「由英數組成」的字元集語意——
  // 純英文或純數字也放行（客人的編號剛好沒字母不該被重問）。單一散字（句中的 a、1）抓不到。
  alphanumeric: /[A-Za-z0-9]{2,}/,
  // 英文+數字+符號：英數開頭結尾、中間可含 - _ / # .（例 OD-2024/001、AB_12#3）。
  // 首尾限英數 → 句尾標點（「編號是A123。」）不會被誤收進值裡。
  alphanumericSymbol: /[A-Za-z0-9][A-Za-z0-9#/._-]*[A-Za-z0-9]/,
}

/** 台灣電話清理後的合法碼數（市話 9 碼、手機 10 碼） */
const PHONE_DIGIT_LENGTHS = new Set([9, 10])

export const DEFAULT_COLLECT_REASK = '格式好像不太對，可以再輸入一次嗎？'

/** 安全編譯 custom 正則；失敗回 null（呼叫端視為不驗證） */
function compileCustomPattern(pattern: string | undefined): RegExp | null {
  const p = String(pattern || '').trim()
  if (!p) return null
  try {
    return new RegExp(p)
  }
  catch {
    return null
  }
}

/**
 * collect 節點的跳過按鈕文字；skipLabel/skipNext 必須成對才算有設（單邊視為沒設）。
 * 引擎（ai-scripts.ts）與編輯器試跑共用，行為保持一致。
 */
export function collectSkipLabel(node: Pick<ScriptCollectNode, 'skipLabel' | 'skipNext'>): string {
  const label = String(node.skipLabel ?? '').trim()
  return label && String(node.skipNext ?? '').trim() ? label : ''
}

/**
 * 「客人拿不出這筆資料就卡死」的格式：訂單編號、序號、發票號碼、單號這類**代碼**。
 * 客人手上沒有就是沒有，再重問一百次也生不出來——這種題目一定要有跳過出口。
 * phone/email 刻意不算：那是人人給得出的聯絡方式，重問是在修錯字，不是死路。
 */
const CODE_LIKE_FORMATS = new Set<CollectFormat>(['alphanumeric', 'alphanumericSymbol', 'number', 'custom'])

export interface ScriptStuckCollect {
  nodeId: string
  fieldName: string
  question: string
}

/**
 * 找出「答不出來就出不去」的收集步驟：問代碼類資料、又沒有跳過出口（skipLabel+skipNext）。
 * 引擎對這種節點的行為是「抽不到合格值 → 重問、停在原地」，所以沒有跳過出口 = 沒有編號的
 * 客人永遠走不到後面任何一步（把「如果沒有編號…」的快速回覆擺在這題**後面**也救不了，
 * 因為要先答得出編號才看得到那顆按鈕）。
 *
 * 這是**建議**不是硬性錯誤，所以刻意不放進 validateScriptDoc（會擋掉既有腳本存檔）；
 * 由 AI 生成端當作重生條件、編輯器當作存檔前提醒。
 */
export function findStuckCollects(nodes: ScriptNode[]): ScriptStuckCollect[] {
  const out: ScriptStuckCollect[] = []
  for (const n of nodes) {
    if (n.type !== 'collect') continue
    if (!CODE_LIKE_FORMATS.has(n.format ?? 'any')) continue
    if (collectSkipLabel(n)) continue
    out.push({ nodeId: n.id, fieldName: n.fieldName || '', question: n.question || '' })
  }
  return out
}

export interface CollectExtractResult {
  /** 是否通過格式（'any' 一律通過） */
  ok: boolean
  /** 通過時要存進 collected 的值（已抽取／清理） */
  value: string
}

/**
 * 依 collect 步驟的 format 從使用者訊息抽取＋驗證。
 * - 'any'：整句 trim 後原樣存（永遠 ok）。
 * - phone/email/number/custom：抽出第一個命中片段；抽不到 → ok=false（重問）。
 *   phone 會清掉抽出片段裡的 - 與空白，只留數字。
 */
export function extractCollectValue(node: Pick<ScriptCollectNode, 'format' | 'pattern'>, raw: string): CollectExtractResult {
  const text = String(raw || '').trim()
  const format = node.format ?? 'any'
  if (format === 'any') return { ok: true, value: text }

  const re = format === 'custom' ? compileCustomPattern(node.pattern) : COLLECT_FORMAT_PATTERNS[format]
  if (!re) return { ok: true, value: text } // custom 正則壞掉 → 不擋，原樣存

  const m = text.match(re)
  if (!m) return { ok: false, value: '' }
  let value = m[0]
  if (format === 'phone') {
    value = value.replace(/[-\s]/g, '')
    // 命中片段碼數不對（太長/太短）→ 視為格式不符、重問，而非存一段截斷的假號碼
    if (!PHONE_DIGIT_LENGTHS.has(value.length)) return { ok: false, value: '' }
  }
  return { ok: true, value }
}

// ═══════════════════════════════════════════════════════════════════
//  Trigger matching
// ═══════════════════════════════════════════════════════════════════

/**
 * 關鍵字比對——**不分 matchMode**。把 keywords 一律當「明確觸發詞」的確定性快速通道：
 * 即使腳本是 semantic 模式，只要填了 keywords，核心詞（預約/退貨/找真人）也能被確定性命中，
 * 不必每次都靠 LLM 路由（避免明顯意圖偶爾被路由判錯）。語意範例則留給 LLM 路由補捉變體說法。
 *
 * keywordMatch 決定怎麼比（與自動回覆規則的 matchType 同一組語意）：
 *   any（預設）＝任一關鍵字是子字串／all＝每個關鍵字都要出現／exact＝整句就是那個詞／
 *   anyText＝有文字就命中（不看關鍵字）。
 *
 * ⛔ 這是**唯一**一支腳本關鍵字比對。曾經還有一支 matchesScriptTrigger 沒人呼叫，
 * 留著只會讓下一個人改到錯的那支、然後兩把尺開始分岔。
 */
export function matchesScriptKeywords(script: Pick<ScriptDoc, 'nodes' | 'rootNodeId' | 'enabled'>, inputText: string): boolean {
  if (!script.enabled) return false
  const text = String(inputText || '').trim().toLowerCase()
  if (!text) return false
  const root = script.nodes.find(n => n.id === script.rootNodeId)
  if (!root || root.type !== 'trigger') return false

  // anyText：有文字就命中，不看關鍵字（和自動回覆的同名選項一樣，會蓋掉 AI，編輯器要跳警告）
  const mode = root.keywordMatch ?? 'any'
  if (mode === 'anyText') return true

  const keywords = (root.keywords ?? []).map(k => String(k).trim().toLowerCase()).filter(Boolean)
  if (!keywords.length) return false
  if (mode === 'exact') return keywords.includes(text)
  if (mode === 'all') return keywords.every(k => text.includes(k))
  return keywords.some(k => text.includes(k))
}

/** 餘弦相似度（gemini 768 維截斷向量未必正規化，須完整計算 dot/|a||b|） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 判斷 inbound 向量是否語意觸發某腳本：與任一範例 embedding 的相似度 ≥ threshold 即觸發。
 * 回傳命中的最高相似度（未命中回 0），方便 caller 比較 / debug。
 */
export function matchesSemanticTrigger(
  script: Pick<ScriptDoc, 'nodes' | 'rootNodeId' | 'enabled'>,
  queryVector: number[],
  threshold: number = DEFAULT_SEMANTIC_TRIGGER_THRESHOLD,
): number {
  if (!script.enabled || !queryVector?.length) return 0
  const root = script.nodes.find(n => n.id === script.rootNodeId)
  if (!root || root.type !== 'trigger' || (root.matchMode ?? 'keyword') !== 'semantic') return 0
  const embeddings = root.exampleEmbeddings ?? []
  let best = 0
  for (const emb of embeddings) {
    const sim = cosineSimilarity(queryVector, emb.values)
    if (sim > best) best = sim
  }
  return best >= threshold ? best : 0
}
