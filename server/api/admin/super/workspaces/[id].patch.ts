import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { invalidateWorkspaceSubscriptionCache } from '~~/server/utils/billing'
import type { WorkspaceSubscription } from '~~/shared/billing/plans'
import { applySuperSubscriptionEdit, SubscriptionEditError } from '~~/shared/billing/subscription-edit'

/**
 * PATCH /api/admin/super/workspaces/:id
 * 更新 workspace 名稱、所屬組織或計費訂閱。Body: { name?, organizationId?, subscription? }
 *
 * subscription：{ planId, status?, currentPeriodStart?/End?, anchorDay?, quotaOverride?, note? }
 *   - null → 刪掉訂閱欄位。該帳號會被**當成免費層（200 則）並照常攔截**——
 *     沒有「未開通就不攔截」這種後門了（見 server/utils/billing.ts）。
 *   - 非 null → **只覆寫表單欄位**，綁卡／折抵／續扣狀態原樣保留
 *     （applySuperSubscriptionEdit；2026-08-16 稽核前是整包取代，超管改個備註
 *     就會把客戶的 payuniCardToken／creditBalance 靜默清掉）。
 *     因此寫入走 transaction：讀舊值→合併→寫回，避免與續扣排程互踩。
 *   - 寫入後清 billing 快取，則數額度攔截即時生效
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const body = await readBody(event)
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw createError({ statusCode: 400, statusMessage: 'name cannot be empty' })
    updates.name = String(body.name).trim()
  }
  if ('organizationId' in body) {
    updates.organizationId = body.organizationId ?? null
  }

  const db = getDb()
  const ref = db.collection('workspaces').doc(id)
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此官方帳號' })
      if ('subscription' in body) {
        updates.subscription = body.subscription == null
          ? FieldValue.delete()
          : applySuperSubscriptionEdit(snap.data()?.subscription as WorkspaceSubscription | undefined, body.subscription)
      }
      tx.update(ref, updates)
    })
  } catch (e) {
    if (e instanceof SubscriptionEditError) {
      throw createError({ statusCode: 400, statusMessage: e.message })
    }
    throw e
  }
  // 訂閱可能變更 → 清 billing 快取，讓則數額度攔截立即生效
  invalidateWorkspaceSubscriptionCache(id)

  const after = await ref.get()
  return { id, ...after.data() }
})
