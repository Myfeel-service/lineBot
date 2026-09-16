/**
 * 小幫手「代你操作」的操作模組表——共用型別與白話名稱（`C-31` Phase 2）。
 *
 * 這張表是 `ai-admin-agent.ts` 那道 `mutates` 閘門的**合法出口**：
 * 工具層依然一個寫入工具都不掛（手滑掛上去也走不到 run()），要動東西一律走這裡，
 * 而這裡的每一筆都必須經過「提議 → 人按確定 → 執行」。
 *
 * 紅線（2026-08-14 老闆拍板，永久原則，工程不自行放寬）：
 *   錢／群發／對客人說話／刪除／憑證／成員——**最後一顆按鈕永遠留給人**，
 *   這類操作連掛都不掛進這張表。所以這裡只有 low/medium 兩級，沒有 high。
 *
 * ⛔ 明文排除清單（名字看起來無害、實際會對外發生的）：
 *   broadcast/send・broadcast/schedule・broadcast/process-due・conversations/send・
 *   richmenu/setDefault・richmenu/create・任何 delete・LINE 憑證・成員權限・計費四支・
 *   cron/run-tasks。未來加 op 前先確認不在這份清單上。
 *
 * 加一個 op ＝ 這裡加 id ＋ `server/utils/admin-ops.ts` 加一筆 ＋
 * `shared/types/audit.ts` 補 `agent-op/<id>` 的白話說明（測試會釘住三處一致）。
 */

/** op id → 人看得懂的動作名（給模型的說明、確認卡標題、操作紀錄同源） */
export const ADMIN_OP_LABELS = {
  'ai-settings-service-hours': '調整服務時間／勿擾時段',
  'script-set-enabled': '上架或下架一條自動回應',
  'ai-settings-handoff-sla': '調整「客人等太久」的提醒時間',
  'ai-settings-sensitive-topic': '增減「一提到就轉真人」的字',
} as const satisfies Record<string, string>

export type AdminOpId = keyof typeof ADMIN_OP_LABELS

/**
 * 風險級別。
 * - low：只影響後台自己看的東西。
 * - medium：客人會感受到差別，但可以原樣改回來。
 *
 * ⚠️ 即使是 low 也**一律先問再做**：小幫手只有一種行為模式（提議→確認→執行），
 *    使用者不必去記「哪些它會自己做掉」。評估報告允許 low 直接執行，這裡刻意更保守——
 *    多按一次的成本，遠低於「它自己動了我沒發現」的信任損失。
 */
export const ADMIN_OP_RISK: Record<AdminOpId, 'low' | 'medium'> = {
  'ai-settings-service-hours': 'medium',
  'script-set-enabled': 'medium',
  // 只影響後台的人什麼時候被提醒，客人那一側毫無感覺
  'ai-settings-handoff-sla': 'low',
  // 加字＝更容易轉給真人（往保守的方向動）；拿掉字才是放寬，所以預覽一定要分開講
  'ai-settings-sensitive-topic': 'medium',
}

/** 稽核動作代號：操作紀錄上看到的就是這個（與 audit 的白話對照成對） */
export function adminOpAuditAction(opId: AdminOpId): string {
  return `agent-op/${opId}`
}

export interface AdminOpPreviewItem {
  /** 會被動到的那一筆（或現況的一行） */
  label: string
  /** 補充：會怎麼變、或為什麼是這樣 */
  note?: string
}

/**
 * 預覽＝「我打算做什麼」。**每一句都由後端當下查實況產生**，
 * ⛔前端與模型都不准自己編動作說明：講的跟做的必須出自同一次查詢
 * （這條紀律沿用一鍵修 `alert-fix`，它踩過的坑不必再踩一次）。
 */
export interface AdminOpPreview {
  opId: AdminOpId
  /** 主句：白話講「我會做什麼」 */
  summary: string
  items: AdminOpPreviewItem[]
  /** 要讓人看一眼的影響（客人會感受到什麼） */
  warning?: string
  /** 確認鈕字樣，例：「確定改時間」 */
  confirmLabel: string
  /**
   * 查完發現「本來就是這樣，不用改」。
   * 畫面看到這個就只給一顆「知道了」——⛔不要給一顆按下去什麼都不會發生的確認鈕，
   * 那會讓人以為自己改了什麼。
   */
  noop?: boolean
}

export interface AdminOpResult {
  ok: boolean
  /** 白話結果：做了什麼、沒做成的話為什麼 */
  message: string
  details?: string[]
}

/**
 * 待確認的操作：跟著這一則訊息走的短命憑證。
 *
 * ⛔ 不存 Firestore、不開狀態機：重整聊天室＝這件事自動作廢（這是特性不是缺陷）。
 * token 內含簽章與到期時間，也綁死是誰提的——別人拿到也用不了。
 */
export interface AdminOpPending {
  opId: AdminOpId
  label: string
  risk: 'low' | 'medium'
  preview: AdminOpPreview
  /** 簽章憑證：按下確定時原樣送回後端 */
  token: string
  /** 幾秒後失效（畫面用來講「這個提議已經過期，請再問一次」） */
  expiresInSec: number
}
