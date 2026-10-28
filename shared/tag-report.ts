/**
 * 好友統計報告（`D-28`＋`D-63` 起家，`D-155` 改版）——什麼時候可以重新產生、存檔長什麼樣。
 *
 * 報告的內容與規則在 `shared/friend-report.ts`（事實）與 `shared/friend-report-advice.ts`（接下來該做什麼）。
 *
 * ── 還在的鐵律 ──────────────────────────────────────────────────
 * ① **產生－存檔－沿用**：按需鈕＋1 小時冷卻＋存檔，⛔ **不是每次開頁重算**。
 *    一份報告約一萬次 Firestore 讀取，掛在開頁上就是 08-11 讀取費暴衝重演。
 * ② **數字一律程式算**。`D-155` 起整份報告不用 LLM：舊版「一句話總結」只拿得到標籤維護的數字，
 *    四點有三點在叫人多建標籤、封存標籤；改成照規則挑的行銷提案與也要留意。
 *    AI 只在店家按「幫我擬」時寫推播文案（`server/utils/broadcast-copy-gen.ts`）。
 */
import { FRIEND_REPORT_VERSION, type FriendReportPayload } from './friend-report'

/** 兩次產生之間至少隔多久。⛔ 這是成本閘門，不是 UX 潤飾，不要為了「即時」拿掉。 */
export const TAG_REPORT_COOLDOWN_MS = 60 * 60 * 1000

export interface TagReportDoc {
  generatedAtMs: number
  /** 誰按的產生；顯示用，查不到就空字串 */
  generatedBy: string
  /**
   * 這一版的報告內容。
   * ⚠️ `D-155` 以前存的是另一種形狀（六張卡＋AI 總結），讀出來時 `payload` 是 `null`、`legacy` 是 true——
   *   ⛔ 畫面不可以把它畫成空的報告，要請他重新產生。
   */
  payload: FriendReportPayload | null
  legacy: boolean
}

/** 存檔裡那一份是不是這一版的形狀 */
export function isCurrentReportPayload(raw: unknown): raw is FriendReportPayload {
  return !!raw && typeof raw === 'object' && (raw as { version?: unknown }).version === FRIEND_REPORT_VERSION
}

// ═══════════════════════════════════════════════════════════════════
//  冷卻（鐵律①）
// ═══════════════════════════════════════════════════════════════════

/** 還要等多久才能再產生一份（毫秒）。0＝現在就可以。 */
export function cooldownRemainingMs(lastGeneratedAtMs: number | null | undefined, nowMs: number): number {
  const last = Number(lastGeneratedAtMs ?? 0)
  if (!last || !Number.isFinite(last)) return 0
  // 未來時間（機器時鐘歪掉／資料髒）當成可以重算，⛔ 不要把人鎖死在一個算不完的冷卻裡
  if (last > nowMs) return 0
  return Math.max(0, TAG_REPORT_COOLDOWN_MS - (nowMs - last))
}

export function canRegenerate(lastGeneratedAtMs: number | null | undefined, nowMs: number): boolean {
  return cooldownRemainingMs(lastGeneratedAtMs, nowMs) === 0
}

/** 冷卻中要講的話。⛔ 只寫「請稍後再試」等於沒講，要說得出還要多久。 */
export function cooldownText(remainingMs: number): string {
  if (remainingMs <= 0) return ''
  const mins = Math.ceil(remainingMs / 60_000)
  return `這份報告是 ${TAG_REPORT_COOLDOWN_MS / 60_000} 分鐘內才算過的，${mins} 分鐘後可以重新產生。`
}
