/**
 * 異常「一鍵幫我修」的共用型別（`D-34`，2026-08-27 老闆拍板執行）。
 *
 * 一個 fix op ＝ 一種異常的確定性修復動作，走「preview → 人按確定 → execute → 重查驗證」：
 *   - preview：後端**當下查實況**回「會動哪幾筆、做什麼」，⛔popup 文案不由前端寫死——
 *     寫死的說明跟實際影響遲早漂移，「講的」與「做的」必須出自同一次查詢。
 *   - execute：冪等、可重按；每次寫 `auditLogs`（actor='human'——是人按的確定，不是 AI 代辦）。
 *   - 驗證：前端執行完用 `useWorkspaceAlerts.refresh({ force: true })` 重跑**同一份**異常訊號，
 *     綠了才說修好——不另立第二套「修好了沒」的判定。
 *
 * 紅線（08-14 拍板、永久原則）：錢／群發／對客人說話／刪除／憑證／成員，最後一顆按鈕留人。
 * 這裡的 op 全部是確定性動作、零 LLM：模型不參與、不生 ID、不重生內容。
 *
 * 加一個 op ＝ 這裡加 id ＋ server/utils/alert-fix-ops.ts 加一筆 ＋
 * useWorkspaceAlerts 註冊表對應異常掛 `fixOpId`（測試會釘住三處一致）。
 */
import type { WorkspaceAlertId, WorkspaceAlertScope } from './alerts'

export const ALERT_FIX_OP_IDS = [
  /** 把 LINE 上的收訊網址（Webhook URL）換成正式網址——LINE 有官方寫入 API */
  'line-webhook-set-url',
  /** 同步失敗的資料來源：現在就去抓一次（url 走 resync、gsheet 走立即同步） */
  'knowledge-refetch-sources',
  /** 學習失敗（embedding failed）的知識卡：重試學習 */
  'knowledge-retry-index',
  /** 卡在 pending 超過一小時沒學完的知識卡：再排一次學習 */
  'knowledge-retry-index-stuck',
  /** 「輸入任何內容」擋住 AI 的那條設定：停用（可隨時再開回來） */
  'script-disable-anytext',
  /** 客服流程卡死的那一題：補「我沒有這項資料」跳過出口（與 AI 生成端同一套確定性補法） */
  'script-add-skip-exit',
  /** 發送失敗的推播：重設回草稿（⛔不代發——要不要再發、何時發由人按，群發紅線） */
  'broadcast-reset-failed',
] as const

export type AlertFixOpId = (typeof ALERT_FIX_OP_IDS)[number]

export interface AlertFixPreviewItem {
  /** 會被動到的那一筆（來源／腳本／推播…）的名稱或說明 */
  label: string
  /** 這一筆的補充：會怎麼處理、或為什麼動不了 */
  note?: string
}

export interface AlertFixPreview {
  opId: AlertFixOpId
  alertId: WorkspaceAlertId
  /**
   * fixable＝按確定會做事；clear＝現在再查已經沒事（不用做）；
   * blocked＝這種病因一鍵修不了（summary 要講原因與下一步，例如 Token 失效要走劇本）。
   */
  state: 'fixable' | 'clear' | 'blocked'
  /** popup 主句：白話講「我會做什麼」；blocked 時講為什麼不行＋下一步 */
  summary: string
  items: AlertFixPreviewItem[]
  /** 要特別讓人看一眼的風險（例：換網址會把訊息從舊系統搬過來） */
  warning?: string
  /** 確認鈕字樣（fixable 才有意義），例：「確定換網址」「確定停用」 */
  confirmLabel?: string
}

// ── 壞按鈕修復（引導劇本 broken-module 專用的端點合約）───────────
// ⛔前端不要再自己宣告一份：`sourceKind` 是 `WorkspaceAlertScope`（同一個列舉），
// 欄位改名時兩份各自編譯得過、畫面才靜靜壞掉（2026-08-27 code review）。

export interface BrokenModuleRefRow {
  moduleId: string
  /** 被指向那個模組的名稱；已被刪除時查不到＝空字串（⛔不硬掰名字） */
  moduleName: string
  /** 引用它的地方（選單／模組／流程／活動的名稱） */
  sourceLabel: string
  sourceKind: WorkspaceAlertScope
  /** missing＝模組被刪了；inactive＝還在但停用了 */
  reason: 'missing' | 'inactive'
}

export interface BrokenModuleFixState {
  refs: BrokenModuleRefRow[]
  /** 可以指過去的模組白名單（啟用中）——⛔劇本只能從這裡挑，不收自由輸入的 ID */
  modules: { id: string; name: string }[]
}

export interface BrokenModuleRepointResult {
  ok: boolean
  toName: string
  /** 使用者在清單上看到的那些（啟用中的流程／活動）改了幾筆 */
  scripts: number
  campaigns: number
  flows: number
  /**
   * 順手改掉、但**使用者清單上沒看到**的停用中設定筆數。
   * 偵測刻意跳過停用的流程與活動（沒有客人受影響），但代改會一起改
   * （之後被打開不該又冒出同一顆壞按鈕）——這個落差要如實回報，不能混進上面的數字。
   */
  hiddenDisabled: number
  /** 還指著舊模組的圖文選單名稱：代改不了，要人去選單頁改完**重新發佈** */
  richmenus: string[]
}

export interface AlertFixExecuteResult {
  /** 動作本身有沒有做成（不等於異常已解除——那由前端重查同一份訊號判定） */
  ok: boolean
  /** 白話結果：做了什麼、幾筆成功幾筆沒成、下一步（若有） */
  message: string
  /** 逐筆明細（給 popup 展開看） */
  details?: string[]
}
