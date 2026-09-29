import { FieldValue } from 'firebase-admin/firestore'
import { syncPublishedEntryUrlForCampaign } from '~~/server/utils/lead-campaign-published-url'
import { normalizeCampaignScheduleInput, schedulePatchForUpdate } from '~~/server/utils/campaign-schedule'
import { normalizeAutoReplyAction } from '~~/shared/auto-reply-rule'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog, diffChangedFields } from '~~/server/utils/audit-log'

function normalizeCampaignAction(body: any): { action: ReturnType<typeof normalizeAutoReplyAction> | null; moduleId: string | null } {
  const hasActionType = Boolean(String(body?.action?.type ?? '').trim())
  const fallbackModule = String(body?.moduleId ?? '').trim()
  if (!hasActionType && !fallbackModule) return { action: null, moduleId: null }
  const action = normalizeAutoReplyAction(body?.action, fallbackModule)
  const moduleId = action.type === 'module' && action.moduleId ? action.moduleId : null
  return { action, moduleId }
}

function validateCampaign(body: any): string | null {
  if (!String(body?.name || '').trim()) return '請輸入活動名稱'
  if (!Array.isArray(body?.tagIds) || body.tagIds.length === 0) return '請至少選擇一個標籤'
  const { action } = normalizeCampaignAction(body)
  if (action?.type === 'module' && !action.moduleId) return '請選擇要觸發的機器人模組'
  if (action?.type === 'message' && !action.text) return '請輸入回覆文字'
  if (action?.type === 'uri' && !action.uri) return '請輸入網址'
  return null
}

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)
  const error = validateCampaign(body)
  if (error) throw createError({ statusCode: 400, statusMessage: error })

  const sched = normalizeCampaignScheduleInput(body)
  if (typeof sched === 'string') throw createError({ statusCode: 400, statusMessage: sched })

  const db = getDb()
  const snap = await db.collection('leadCampaigns').doc(id).get()
  if (!snap.exists || snap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Campaign not found' })
  }
  const { action, moduleId } = normalizeCampaignAction(body)

  const updates: Record<string, unknown> = {
    name: String(body.name).trim(),
    liffId: String(body.liffId ?? '').trim(),
    tagIds: (body.tagIds as string[]).map(String).filter(Boolean),
    moduleId,
    action,
    description: String(body.description || '').trim(),
    redirectUrl: String(body.redirectUrl || '').trim() || null,
    isActive: body.isActive !== false,
    updatedAt: FieldValue.serverTimestamp(),
    ...schedulePatchForUpdate(sched),
  }

  await db.collection('leadCampaigns').doc(id).update(updates)

  const merged = { ...snap.data(), ...updates }
  const urlRes = await syncPublishedEntryUrlForCampaign(db, id, {
    workspaceId,
    liffId: String(merged.liffId ?? ''),
    campaignCode: String(merged.campaignCode ?? ''),
    isActive: merged.isActive !== false,
    tagIds: merged.tagIds,
    moduleId: merged.moduleId,
    action: merged.action,
    redirectUrl: String(merged.redirectUrl ?? '') || null,
    publishedClaimId: snap.data()?.publishedClaimId ?? null,
    publishedCtaUrl: snap.data()?.publishedCtaUrl ?? null,
  })

  // 稽核（`C-254`）：`isActive` 一關，那條活動連結就失效了，客人點進去會撲空
  const summarize = (d: Record<string, unknown>) => ({
    name: String(d.name ?? ''),
    isActive: d.isActive !== false,
    itemsCount: Array.isArray(d.tagIds) ? (d.tagIds as unknown[]).length : 0,
    type: String((d.action as { type?: string } | null)?.type ?? ''),
  })
  const diff = diffChangedFields(summarize(snap.data()!), summarize(merged))
  if (diff.changedKeys.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'campaign.put',
      targetId: id,
      before: diff.before,
      after: diff.after,
      note: String(snap.data()?.name ?? ''),
    }, db)
  }

  return {
    id,
    name: String(updates.name),
    liffId: String(updates.liffId),
    tagIds: updates.tagIds as string[],
    moduleId: updates.moduleId as string | null,
    action,
    description: String(updates.description),
    isActive: Boolean(updates.isActive),
    startsAt: sched.startsAt,
    endsAt: sched.endsAt,
    publishedCtaUrl: urlRes.publishedCtaUrl,
  }
})
