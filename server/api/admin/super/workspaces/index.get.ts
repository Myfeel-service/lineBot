import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { AI_USAGE_COLLECTION, currentYyyyMm, monthlyBillable } from '~~/server/utils/ai-usage'
import { bucketAiCosts } from '~~/server/utils/ai-cost-buckets'
import type { AiUsageDoc } from '~~/shared/types/ai-knowledge'

/**
 * GET /api/admin/super/workspaces
 * 列出所有 workspaces，並附上「本月用量摘要」——讓 super admin 一眼掌握每個帳號
 * 有沒有在用、用多少、跟客人對話花多少（成本只算客人對話，與用量頁 headline 同口徑）。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const db = getDb()
  const period = currentYyyyMm()

  const [wsSnap, usageSnap, settingsSnap] = await Promise.all([
    db.collection('workspaces').get(),
    // 本月所有 workspace 的月結桶一次撈（單欄位 equality，Firestore 自動索引）
    db.collection(AI_USAGE_COLLECTION).where('period', '==', period).get(),
    // 是否啟用 AI（aiSettings doc id = workspaceId）
    db.collection('aiSettings').get(),
  ])

  const usageByWs = new Map<string, Partial<AiUsageDoc>>()
  usageSnap.docs.forEach((d) => {
    const data = d.data() as Partial<AiUsageDoc>
    if (data.workspaceId) usageByWs.set(data.workspaceId, data)
  })
  const enabledByWs = new Map<string, boolean>()
  settingsSnap.docs.forEach(d => enabledByWs.set(d.id, (d.data() as { enabled?: boolean }).enabled === true))

  return wsSnap.docs.map((d) => {
    const u = usageByWs.get(d.id)
    // 客人對話成本：與成本總覽同一份算式（ai-cost-buckets.ts，照實際模型分價）。
    // ⛔ 以前這裡自己寫死一份 flash 單價——改價時這頁會跟成本總覽對不起來（`D-130`② 收斂成一份）
    const conversationCostUsd = bucketAiCosts(u).conversation.costUsd

    return {
      id: d.id,
      name: d.data().name ?? d.id,
      organizationId: d.data().organizationId ?? null,
      channelAccessTokenConfigured: !!d.data().channelAccessToken,
      channelSecretConfigured: !!d.data().channelSecret,
      subscription: d.data().subscription ?? null,
      // 本月用量摘要（super admin 掌控用）
      usage: {
        period,
        aiEnabled: enabledByWs.get(d.id) ?? false,
        invocations: Number(u?.invocations ?? 0),
        answered: Number(u?.answered ?? 0),
        // 計費則數（含反問）。與 answered 分開回：answered 是「AI 自己答完幾題」的品質數字，
        // 畫面上講「收得到多少錢」時要用這個（`D-69`）。
        billable: monthlyBillable(u),
        handoffs: Number(u?.handoffs ?? 0),
        conversationCostUsd: Number(conversationCostUsd.toFixed(4)),
      },
    }
  })
})
