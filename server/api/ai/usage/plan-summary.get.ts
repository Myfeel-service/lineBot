import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getQuotaAnswered } from '~~/server/utils/ai-usage'
import { buildPlanView, getWorkspaceSubscription } from '~~/server/utils/billing'

/**
 * GET /api/ai/usage/plan-summary
 *
 * 輕量端點：只回「目前方案 + **本期**已用則數」，供設定頁 / 帳號選單顯示精簡方案卡，
 * 不含完整 KPI（那是 summary）。計費資訊 → 需 admin。
 *
 * 「本期」= 訂閱週期（錨定日制）。這裡讀的是額度攔截用的同一顆計數器,所以進度條上的
 * 數字跟客人實際會被擋下來的那個點永遠一致（不會出現「顯示還有額度但已經被轉真人」）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'usage.read')
  const db = getDb()

  const sub = await getWorkspaceSubscription(workspaceId, db)
  const plan = buildPlanView(sub)

  const answered = sub?.currentPeriodStart
    ? await getQuotaAnswered(workspaceId, sub.currentPeriodStart, db)
    : 0

  return { plan, answered }
})
