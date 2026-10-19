/**
 * 這個帳號的 AI 回覆額度用完了沒（`D-132`③，2026-10-19）＋ AI 呼叫上限（`C-8`，2026-10-20）。
 *
 * 給「不經過 answerWithAi、但也要叫 AI 對客人出手」的路徑用：客人只傳照片時，AI 讀圖、猜客人想問什麼、
 * 做成按鈕給他點——老闆 10-19 拍板這一則照「反問」算一則，**而且要先看額度**：用完了就不叫 AI 猜，
 * 只問一句。以前這條路不看額度，額度用完後客人照樣收到 AI 猜的按鈕。
 *
 * 判斷跟 answerWithAi 第 2 步「quota 護欄」同一把尺：兩邊都用這裡的 {@link readQuotaUsage} 讀用量、
 * 用 `resolveQuotaDecision` 判斷（⛔ 別在任何一邊另外讀一份用量——兩條路對同一個帳號的答案必須一樣）：
 *   · 內部／測試方案 → 沒用完
 *   · 有則數上限 → 本期計費則數 ≥ 上限＝用完；**或**這個月 AI 被叫的次數 ≥ 上限 × 10（`C-8`）＝一樣停
 *   · 沒則數上限 → token 護欄；設定是「降級模型繼續答」的不算用完（AI 還在答）
 * 讀取失敗一律當「沒用完」（同 billing.ts 的 fail-open：基礎設施出問題不該把客人擋在門外）。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { resolveAnsweredQuota, resolveQuotaAction, type AnsweredQuotaResolution, type QuotaUsage } from './billing'
import { getCurrentMonthAiCalls, getCurrentMonthTokens, getQuotaAnswered } from './ai-usage'
import { getAiSettings } from './ai-settings'
import { aiCallCeilingOf, isAiCallCeilingHit, type AiCallCeilingStatus } from '~~/shared/billing/call-ceiling'

/**
 * 護欄要看的用量，只讀用得到的那幾格：
 *   · 有則數上限 → 本期則數（額度桶）＋這個月呼叫次數（月結桶，60 秒快取）；兩筆並行讀。
 *   · 沒則數上限、有 token 上限 → 本月 token。
 *   · 都沒有 → null（沒有東西可以擋，什麼都不讀）。
 *
 * 呼叫次數讀不到就當 0（fail-open）：這條是成本保險絲，讀取抖一下不該把正在答的 AI 停掉。
 */
export async function readQuotaUsage(
  workspaceId: string,
  billing: AnsweredQuotaResolution,
  tokenCap: number,
  db: Firestore = getDb(),
): Promise<QuotaUsage | null> {
  if (billing.internal) return null
  if (billing.quota != null && billing.periodStart) {
    const needsCalls = aiCallCeilingOf(billing) != null
    const [answered, calls] = await Promise.all([
      getQuotaAnswered(workspaceId, billing.periodStart, db),
      needsCalls ? getCurrentMonthAiCalls(workspaceId, db).catch(() => 0) : Promise.resolve(0),
    ])
    return { answered, tokens: 0, calls }
  }
  if (tokenCap > 0) return { answered: 0, tokens: await getCurrentMonthTokens(workspaceId, db) }
  return null
}

export async function isReplyQuotaExhausted(workspaceId: string, db: Firestore = getDb()): Promise<boolean> {
  try {
    const billing = await resolveAnsweredQuota(workspaceId, db)
    if (billing.internal) return false
    const settings = await getAiSettings(workspaceId, db)
    const tokenCap = settings.quota.monthlyTokenCap
    const usage = await readQuotaUsage(workspaceId, billing, tokenCap, db)
    if (!usage) return false
    return resolveQuotaAction(billing, usage, tokenCap, settings.quota.onExceed) === 'handoff'
  }
  catch (e) {
    console.warn('[reply-quota] check failed, treat as not exhausted:', e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * 後台要顯示的呼叫上限狀態（橫幅、方案頁、提醒、小幫手共用）。null＝這個帳號不套（內部／沒則數上限）。
 * 讀的是護欄同一支（同一份 60 秒快取），畫面說停了就是真的停了。讀不到次數時丟錯，由呼叫端決定。
 */
export async function getAiCallCeilingStatus(
  workspaceId: string,
  billing: Pick<AnsweredQuotaResolution, 'quota' | 'internal'>,
  db: Firestore = getDb(),
): Promise<AiCallCeilingStatus | null> {
  const limit = aiCallCeilingOf(billing)
  if (limit == null) return null
  const calls = await getCurrentMonthAiCalls(workspaceId, db)
  return { calls, limit, hit: isAiCallCeilingHit(calls, limit) }
}
