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
}

export function auditFieldLabel(key: string): string {
  return AUDIT_FIELD_LABELS[key] ?? key
}

/** 稽核值 → 一行字（給列表用）。物件不展開，只說「有變」——展開會把表格撐爆 */
export function auditValueText(v: unknown): string {
  if (v === null || v === undefined) return '（空白）'
  if (typeof v === 'boolean') return v ? '開' : '關'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v.trim() === '' ? '（空白）' : v
  if (Array.isArray(v)) return `${v.length} 項`
  return '（一組設定）'
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
