import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateWorkspaceSubscriptionCache } from '~~/server/utils/billing'
import { BILLING_PLAN_ORDER, getBillingPlan, isSelfServePaidPlan, type BillingPlanId } from '~~/shared/billing/plans'
import { isDowngrade } from '~~/shared/billing/recurring'
import type { WorkspaceDoc } from '~~/shared/types/organization'

/**
 * POST /api/payment/schedule-plan-change
 * body: { workspaceId, planId }   planId = null → 取消已排程的變更
 *
 * **降級：期末生效**（老闆 2026-07-29 拍板）。客戶已經付了這一期的錢,服務要用到期末——
 * 按下降級**不立即換方案、不立即扣款**,只把目標方案記在 `subscription.pendingPlanId`,
 * 期末續扣時才以它為準扣款並開通（見 shared/billing/recurring.ts）。
 *
 * ⚠️ 只服務「背後有自動續扣」的訂閱。單次付款沒有「期末扣款」那一刻,排了永遠不會生效——
 *    那種客戶要降級就是下次自己買便宜的方案（走 create-order），不能給他一個假的排程。
 *
 * 升級不走這裡：升級的人是想要**現在**就有更多額度,走 create-order 立即付款、立即生效。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const body = await readBody(event)
  const raw = body?.planId
  const target = raw == null || raw === '' ? null : String(raw) as BillingPlanId

  if (target !== null && !BILLING_PLAN_ORDER.includes(target)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid planId' })
  }

  const db = getDb()
  // ⚠️ 讀**原始 doc**,不用 getWorkspaceSubscription。後者帶 60 秒快取（而且快取是每個
  //    Lambda 實例各自的記憶體）,又會就地 roll 過一輪。拿那份資料回寫整個 subscription,
  //    就會把「這 60 秒內續扣排程剛寫進去的結果」整包蓋掉——包含已經用掉的折抵餘額。
  const wsRef = db.collection('workspaces').doc(workspaceId)
  const snap = await wsRef.get()
  const sub = snap.exists ? (snap.data() as WorkspaceDoc).subscription : null
  if (!sub) throw createError({ statusCode: 404, statusMessage: '找不到此帳號的訂閱' })

  // 沒有自動續扣 = 沒有「期末扣款」那一刻 → 排程不會生效,直接說清楚而不是靜默寫入。
  if (!sub.payuniCardToken) {
    throw createError({ statusCode: 400, statusMessage: '此帳號未啟用自動續訂,無法預約期末變更方案' })
  }

  let scheduled: BillingPlanId | null = null
  if (target !== null && target !== sub.planId) {
    if (!isSelfServePaidPlan(target) && target !== 'free') {
      throw createError({ statusCode: 400, statusMessage: '此方案不支援自助變更,請聯繫業務' })
    }
    // 這支只做降級。升級要立即生效（客戶要的是現在就有額度）→ 走 create-order。
    if (!isDowngrade(sub.planId, target)) {
      throw createError({ statusCode: 400, statusMessage: '升級請直接前往付款,立即生效' })
    }
    scheduled = target
  }

  // ⚠️ **只動 pendingPlanId 這一個欄位**（點狀路徑）,不回寫整個 subscription。
  //    這支端點與續扣排程會同時碰同一份訂閱,整包回寫等於把對方的結果抹掉。
  await wsRef.update({
    'subscription.pendingPlanId': scheduled ?? FieldValue.delete(),
    'updatedAt': FieldValue.serverTimestamp(),
  })
  invalidateWorkspaceSubscriptionCache(workspaceId)
  console.log('[payment] 排程期末方案變更', workspaceId, sub.planId, '→', scheduled ?? '(取消排程)')
  return {
    ok: true,
    pendingPlanId: scheduled,
    pendingPlanName: scheduled ? getBillingPlan(scheduled).name : null,
    /** 生效日 = 下次扣款日 = 本期到期日的隔天 */
    effectiveFrom: sub.currentPeriodEnd,
  }
})
