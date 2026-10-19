/**
 * 這個帳號的 AI 回覆額度用完了沒（`D-132`③，2026-10-19）。
 *
 * 給「不經過 answerWithAi、但也要叫 AI 對客人出手」的路徑用：客人只傳照片時，AI 讀圖、猜客人想問什麼、
 * 做成按鈕給他點——老闆 10-19 拍板這一則照「反問」算一則，**而且要先看額度**：用完了就不叫 AI 猜，
 * 只問一句。以前這條路不看額度，額度用完後客人照樣收到 AI 猜的按鈕。
 *
 * 判斷跟 answerWithAi 第 2 步「quota 護欄」同一把尺（`resolveQuotaAction`）：
 *   · 內部／測試方案 → 沒用完
 *   · 有則數上限 → 本期計費則數 ≥ 上限＝用完
 *   · 沒則數上限 → token 護欄；設定是「降級模型繼續答」的不算用完（AI 還在答）
 * 讀取失敗一律當「沒用完」（同 billing.ts 的 fail-open：基礎設施出問題不該把客人擋在門外）。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { resolveAnsweredQuota, resolveQuotaAction } from './billing'
import { getCurrentMonthTokens, getQuotaAnswered } from './ai-usage'
import { getAiSettings } from './ai-settings'

export async function isReplyQuotaExhausted(workspaceId: string, db: Firestore = getDb()): Promise<boolean> {
  try {
    const billing = await resolveAnsweredQuota(workspaceId, db)
    if (billing.internal) return false
    const settings = await getAiSettings(workspaceId, db)
    const tokenCap = settings.quota.monthlyTokenCap
    let usage: { answered: number; tokens: number } | null = null
    if (billing.quota != null && billing.periodStart) {
      usage = { answered: await getQuotaAnswered(workspaceId, billing.periodStart, db), tokens: 0 }
    }
    else if (tokenCap > 0) {
      usage = { answered: 0, tokens: await getCurrentMonthTokens(workspaceId, db) }
    }
    if (!usage) return false
    return resolveQuotaAction(billing, usage, tokenCap, settings.quota.onExceed) === 'handoff'
  }
  catch (e) {
    console.warn('[reply-quota] check failed, treat as not exhausted:', e instanceof Error ? e.message : e)
    return false
  }
}
