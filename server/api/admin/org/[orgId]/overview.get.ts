import { getDb } from '~~/server/utils/firebase'
import { requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { buildPlanView, defaultFreeSubscription } from '~~/server/utils/billing'
import { getQuotaAnswered } from '~~/server/utils/ai-usage'
import { rollSubscriptionToCurrentPeriod } from '~~/shared/billing/period'
import { taipeiDate } from '~~/shared/time'
import type { OrganizationDoc, WorkspaceDoc } from '~~/shared/types/organization'

/**
 * GET /api/admin/org/:orgId/overview — 組織總覽（給組織管理員）。
 *
 * 一次回傳組織底下**每個官方帳號**的健康度：方案、本期已用則數、額度狀態、LINE 接上了沒。
 * 解掉「代理商管 10 個 OA 就要一個一個點進去看」的問題。
 *
 * 效能：workspace doc 在第一次查詢時就全拿到了,訂閱週期直接**就地推算**
 * （rollSubscriptionToCurrentPeriod 是純函式）,不要再走 getWorkspaceSubscription——
 * 那會為了每個 OA 多打一次 Firestore。額度計數是唯一必須逐一讀的（各自一顆 doc）,並行取。
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.params?.orgId
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'orgId is required' })

  await requireActiveOrgAdmin(event, orgId)

  const db = getDb()
  const today = taipeiDate()

  const [orgSnap, wsSnap] = await Promise.all([
    db.collection('organizations').doc(orgId).get(),
    db.collection('workspaces').where('organizationId', '==', orgId).get(),
  ])
  if (!orgSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此組織' })
  const org = orgSnap.data() as OrganizationDoc

  const workspaces = await Promise.all(wsSnap.docs.map(async (doc) => {
    const w = doc.data() as WorkspaceDoc
    // 沒掛訂閱 = 免費層（與額度攔截同一套規則，見 server/utils/billing.ts）
    const { sub } = rollSubscriptionToCurrentPeriod(w.subscription ?? defaultFreeSubscription(today), today)
    const plan = buildPlanView(sub)

    const answered = sub.currentPeriodStart
      ? await getQuotaAnswered(doc.id, sub.currentPeriodStart, db)
      : 0

    return {
      workspaceId: doc.id,
      name: w.name ?? doc.id,
      plan,
      answered,
      // 與開通檢查清單（setup-status 的 lineConnected）同一個定義：Token / Secret 都有才算接上。
      // 預設 LIFF 已拆成獨立加分項（liffReady），不再擋「接上 LINE」。
      lineConnected: Boolean(
        String(w.channelAccessToken ?? '').trim()
        && String(w.channelSecret ?? '').trim(),
      ),
    }
  }))

  return {
    org: { id: orgId, name: org.name ?? orgId },
    workspaces,
  }
})
