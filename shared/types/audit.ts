/**
 * 操作紀錄（auditLogs）的共用型別與白話對照——**單一事實來源**。
 *
 * 為什麼要有這一份：`server/utils/audit-log.ts` 從 2026-08-14 起就在寫紀錄，
 * 但那是一個**只進不出**的 collection——沒有任何端點或畫面讀得到它。
 * 在小幫手開始代人動手（`C-31` Phase 2）之前，系統必須答得出「這筆是誰改的、改前是什麼」，
 * 所以這一輪把它讀出來，而「動作代號 → 人看得懂的一句話」只能有一份對照表：
 * 後端寫入用的代號、畫面上顯示的名稱都從這裡長出來。
 *
 * ⛔ 新增一種會寫稽核的動作時，這裡要一起補一行——
 *    `shared/types/audit.test.ts` 會掃 server 原始碼，漏了直接紅。
 */

/** 誰動的手：人自己在頁面上按的，還是小幫手代辦的 */
export type AuditActor = 'human' | 'agent'

export const AUDIT_ACTOR_LABELS: Record<AuditActor, string> = {
  human: '成員操作',
  agent: '小幫手代辦',
}

/**
 * 動作代號 → 白話說明。代號慣例是端點路徑或 `alert-fix/<op>`、`agent-op/<op>`。
 *
 * ⛔ 這裡寫的是「發生了什麼事」，不是功能名稱：看紀錄的人想知道的是
 *    「AI 設定被改了」而不是「呼叫了 ai/settings.put」。
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'ai/settings.put': '改了 AI 設定',
  'richmenu/setDefault': '換了預設圖文選單',
  'conversations/sessions.batchClose': '批次結束對話',
  'alert-fix/broken-module-reenable': '把停用的模組重新啟用',
  'alert-fix/broken-module-repoint': '把壞掉的按鈕改指到別的模組',
  'alert-fix/line-webhook-set-url': '換掉 LINE 上登記的收訊網址',
  'alert-fix/knowledge-refetch-sources': '重新抓取同步失敗的資料',
  'alert-fix/knowledge-retry-index': '重試學習失敗的知識卡',
  'alert-fix/knowledge-retry-index-stuck': '重試卡住沒學完的知識卡',
  'alert-fix/script-disable-anytext': '停用「輸入任何內容」的攔截',
  'alert-fix/script-add-skip-exit': '幫卡住的問題補上跳過按鈕',
  'alert-fix/broadcast-reset-failed': '把發送失敗的推播重設回草稿',
  // 小幫手代辦（`C-31` Phase 2）：actor 欄位會顯示「小幫手代辦」，所以這裡只寫做了什麼
  'agent-op/ai-settings-service-hours': '改了服務時間／勿擾時段',
  'agent-op/script-set-enabled': '上架或下架一條自動回應',
  'agent-op/ai-settings-handoff-sla': '改了「客人等太久」的提醒時間',
  'agent-op/ai-settings-sensitive-topic': '增減「一提到就轉真人」的字',
  'agent-op/ai-settings-reply-mode': '切換 AI 直接回客人／只給草稿',
  'agent-op/script-create-from-description': '用一句話建了一條自動回應（建好是停用的）',
  'agent-op/broadcast-draft-create': '建了一則推播草稿（沒有發送）',
  // 還原也是一次操作：⛔原本那一筆不刪不改，這裡再記一筆
  'audit/revert': '把先前的某一筆改動還原回去',
  // 人自己在頁面上改的（2026-09-16 補接）：小幫手的每一筆都記了，人改的卻沒有，時間軸會是斷的
  'ai/scripts.put': '編輯了一條自動回應',
  'ai/scripts.create': '新增了一條自動回應',
  'ai/scripts.delete': '刪掉了一條自動回應',
  'members/role.put': '改了某位成員的權限',
  'line-workspace.put': '改了 LINE 連線設定',
  'line-workspace.clear': '清空了整個 LINE 工作區設定',
}

/** 找不到對照時的退路：寧可顯示代號，也不要顯示空白（空白會讓人以為紀錄壞了） */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action
}

/**
 * 設定欄位 → 白話名稱（盡力而為）。
 *
 * ⚠️ 這份**不可能完整**：紀錄裡的欄位是「這次剛好有變的那幾個」，隨設定長出來。
 *    對不到的一律原樣顯示欄位代號——顯示代號至少看得出有東西變了，
 *    省略掉才是真的騙人。
 */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  enabled: '開關',
  replyMode: '回覆方式',
  confidenceThreshold: '信心門檻',
  groundingThreshold: '有憑有據門檻',
  replyMaxLen: '回覆長度上限',
  systemPrompt: '給 AI 的說明',
  shopUrl: '商店網址',
  sensitiveTopics: '敏感情境詞',
  handoffNotify: '轉真人通知',
  serviceHours: '勿擾時段',
  disambiguation: '反問設定',
  quota: '用量上限',
  imageAnswer: '看圖回答',
  richMenuId: '圖文選單',
  endpoint: '收訊網址',
  nodes: '流程步驟',
  autoTagSuggest: 'AI 自動貼標建議',
  inactiveTag: '沉睡客人自動標籤',
  // 巢狀在上面那些設定底下的欄位（展開之後才會被看到，2026-09-18 補）
  slaRemindMinutes: '等太久的提醒時間（分鐘）',
  lineUserIds: '通知對象',
  displayNames: '通知對象的名稱',
  mode: '通知時機',
  digestHour: '每日摘要時間（點）',
  festivalTips: '節慶行銷提醒',
  weeklyInsights: '每週顧客觀察',
  criticalAlertPush: '重大異常推播',
  start: '服務時段起',
  end: '服務時段迄',
  weekendOff: '週末整天不打擾',
  dndReply: '勿擾時段回給客人的話',
  days: '幾天沒來訊算沉睡',
  role: '權限',
}

export function auditFieldLabel(key: string): string {
  return AUDIT_FIELD_LABELS[key] ?? key
}

/**
 * 某些欄位的值本身是代號（`always`／`draft`…）。
 *
 * ⛔ 直接把代號秀給店家，跟秀欄位代號是同一個毛病：畫面上出現 `missed_only`，
 *    看的人只知道「有東西變了」，不知道變成什麼。對不到的一樣原樣顯示。
 */
export const AUDIT_VALUE_LABELS: Record<string, Record<string, string>> = {
  mode: { always: '每次都通知', missed_only: '沒人接手才通知' },
  replyMode: { auto: 'AI 直接回客人', draft: '只給草稿' },
}

/**
 * 稽核值 → 一行字。`fieldKey` 有給的話會把代號換成白話（`always` → 每次都通知）。
 *
 * ⚠️ 物件到這裡只會得到「（一組設定）」——那是**最後的退路**，正常路徑請走
 *    `auditChangeLines()`，它會展開到真的有變的那一格。
 */
export function auditValueText(v: unknown, fieldKey = ''): string {
  if (v === null || v === undefined) return '（空白）'
  if (typeof v === 'boolean') return v ? '開' : '關'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    if (v.trim() === '') return '（空白）'
    return AUDIT_VALUE_LABELS[fieldKey]?.[v] ?? v
  }
  if (Array.isArray(v)) return `${v.length} 項`
  return '（一組設定）'
}

/** 畫面上的一行前後對照。`key` 是欄位路徑，只拿來當 v-for 的 key */
export interface AuditChangeLine {
  key: string
  /** 「轉真人通知 › 等太久的提醒時間（分鐘）」 */
  label: string
  before: string
  after: string
}

export interface AuditChangeSummary {
  lines: AuditChangeLine[]
  /**
   * 超過上限、沒印出來的行數。
   * ⛔ 一定要顯示：安靜地少講幾行，看的人會以為「這次就只改了這些」。
   */
  omitted: number
}

/** 一筆最多印幾行（一次改十幾格的情況存在，但表格不能被撐爆） */
const MAX_CHANGE_LINES = 12
/** 展開幾層。寫入端 sanitize 也是 4 層，超過的本來就存不進來 */
const MAX_CHANGE_DEPTH = 4
/** 清單型欄位最多逐項列出幾個差異，超過就只講數量 */
const MAX_LIST_DIFF_ITEMS = 5

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * 清單型欄位（敏感情境詞、通知對象…）：講出「多了誰、少了誰」。
 *
 * ⛔「19 項 → 20 項」等於沒講：看紀錄的人要知道的正是**哪一個字**被加進去，
 *    因為那個字決定了客人講到它會不會直接被轉給真人。
 * 回 null＝這不是可以逐項比對的清單，交回上層用一般方式顯示。
 */
function listChangeText(before: unknown, after: unknown): { before: string, after: string } | null {
  if (!Array.isArray(before) || !Array.isArray(after)) return null
  if (![...before, ...after].every(v => typeof v === 'string' || typeof v === 'number')) return null

  const b = before.map(String)
  const a = after.map(String)
  const added = a.filter(v => !b.includes(v))
  const removed = b.filter(v => !a.includes(v))
  // 只是順序換了（內容沒變）：不要編一個「新增／移除」出來
  if (!added.length && !removed.length) return null

  // 太多項就只講數量：一行塞進 60 個詞沒有人看得完，反而把旁邊的行擠掉
  if (added.length + removed.length > MAX_LIST_DIFF_ITEMS)
    return { before: `${b.length} 項`, after: `${a.length} 項（新增 ${added.length}、移除 ${removed.length}）` }

  const parts = [
    added.length ? `新增「${added.join('、')}」` : '',
    removed.length ? `移除「${removed.join('、')}」` : '',
  ].filter(Boolean)
  return { before: `${b.length} 項`, after: `${a.length} 項（${parts.join('；')}）` }
}

/**
 * 前後對照展開成「人看得懂的幾行」。
 *
 * 為什麼要有這一支（2026-09-18）：稽核存的是**設定裡的真實層級**
 * （`{ handoffNotify: { slaRemindMinutes: 37 } }`，這樣「還原」才知道要改回哪一格），
 * 但畫面原本只走到第一層，於是整欄變成「轉真人通知：（一組設定） → （一組設定）」——
 * 資料明明都在，卻一個字都沒講出來。這支往下走到**真的有變的那一格**再印。
 *
 * 紀律：
 * - ⛔ 上一層整顆有變、但這一格前後相同的，不印（印了會把真正改動的那行淹掉）。
 * - ⛔ 超過行數上限要 `continue` 繼續數，不可以 `break`——break 之後連「還有幾行」都說不出來。
 * - ⛔ 展不出任何一行時退回第一層顯示，不可以留空：空白會被讀成「沒改到東西」。
 */
export function auditChangeLines(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): AuditChangeSummary {
  const lines: AuditChangeLine[] = []
  let omitted = 0

  const walk = (
    b: Record<string, unknown> | null | undefined,
    a: Record<string, unknown> | null | undefined,
    path: string[],
    labels: string[],
  ): void => {
    for (const k of new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])) {
      const bv = b?.[k]
      const av = a?.[k]
      if (sameValue(bv, av)) continue

      const nextPath = [...path, k]
      const nextLabels = [...labels, auditFieldLabel(k)]

      // 兩邊都是「物件或沒有」才往下走：物件被換成一個字串時往下走會把那個字串弄丟
      const bObj = isPlainObject(bv)
      const aObj = isPlainObject(av)
      const bGone = bv === null || bv === undefined
      const aGone = av === null || av === undefined
      if ((bObj || bGone) && (aObj || aGone) && (bObj || aObj) && nextPath.length < MAX_CHANGE_DEPTH) {
        walk(bObj ? bv : null, aObj ? av : null, nextPath, nextLabels)
        continue
      }

      if (lines.length >= MAX_CHANGE_LINES) { omitted++; continue }

      const list = listChangeText(bv, av)
      lines.push({
        key: nextPath.join('.'),
        label: nextLabels.join(' › '),
        before: list ? list.before : auditValueText(bv, k),
        after: list ? list.after : auditValueText(av, k),
      })
    }
  }

  walk(before, after, [], [])

  // 展不出東西的極少數情況（例如整份物件只有欄位順序不同）：退回第一層，至少看得出動過哪一項
  if (!lines.length && !omitted) {
    for (const k of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      lines.push({
        key: k,
        label: auditFieldLabel(k),
        before: auditValueText(before?.[k], k),
        after: auditValueText(after?.[k], k),
      })
    }
  }

  return { lines, omitted }
}

/** 一筆操作紀錄（API 回給畫面的形狀；憑證類欄位在寫入時就已遮罩） */
export interface AuditLogRow {
  id: string
  /** 動作代號（對照 AUDIT_ACTION_LABELS） */
  action: string
  actor: AuditActor
  /** 操作者的 Firebase uid（畫面上會換成 Email／名字，換不到就顯示 uid 本身） */
  uid: string
  /** 這次真的有變的欄位：改之前 */
  before: Record<string, unknown> | null
  /** 這次真的有變的欄位：改之後 */
  after: Record<string, unknown> | null
  /** 補充說明（有些動作沒有前後值，只有一句「動了幾筆」） */
  note?: string
  /** 發生時間（毫秒）。⛔可能是 null：serverTimestamp 寫入後到讀取前有極短的空窗 */
  createdAt: number | null
  /** 這一筆能不能一鍵還原（後端算，⛔前端不要自己判斷） */
  revertible?: boolean
  /** 不能還原時的原因（人看得懂的一句話，畫面直接顯示） */
  revertReason?: string
}

export interface AuditLogListResult {
  items: AuditLogRow[]
  /** 還有更多時帶回來的游標（⛔用游標不用 offset：Firestore 跳過的每一筆都要收錢） */
  nextCursor: string | null
}
