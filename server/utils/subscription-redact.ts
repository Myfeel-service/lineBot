/**
 * 訂閱「回給瀏覽器之前」把扣款憑證換掉（`B-51`，2026-10-20）。
 *
 * 為什麼要有：超管帳號列表（`GET /api/admin/super/workspaces`）整包回訂閱，裡面有 PAYUNi 約定扣款的
 * 卡片代碼 `payuniCardToken`——只有超管看得到，但扣款憑證不該離開伺服器（瀏覽器擴充套件、截圖、
 * DevTools 匯出都可能外流）。`plans.ts` 那一格的註解本來就寫「不得外洩到前端」，這支是兌現它。
 *
 * ⛔ 不是拿掉、是換成一個記號：改方案確認框（`describeSuperSubscriptionEdit`）、續扣判斷
 *    （`shared/billing/*`）都靠「有沒有這一格」判斷這個帳號會不會被自動扣款。拿掉＝畫面以為沒綁卡、
 *    確認框少講「存檔後 10 分鐘內會被扣款」。記號照樣是真值，判斷不變；真的代碼不出伺服器。
 *    PATCH 寫回時只覆寫表單欄位（`applySuperSubscriptionEdit`），卡片代碼一律留資料庫那份，記號不會被寫進去。
 * ⛔ 一律複製再換，不在原物件上改（同 ai-settings-redact 的理由）。
 */
import type { WorkspaceSubscription } from '~~/shared/billing/plans'

/** 「有綁卡」的記號：不是憑證，只代表資料庫裡有那一格 */
export const CARD_TOKEN_REDACTED = '已綁卡（憑證不外傳）'

export function redactSubscriptionForClient(
  sub: WorkspaceSubscription | null | undefined,
): WorkspaceSubscription | null {
  if (!sub) return null
  const copy: WorkspaceSubscription = { ...sub }
  if (copy.payuniCardToken) copy.payuniCardToken = CARD_TOKEN_REDACTED
  return copy
}
