import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import type { BroadcastDoc, BroadcastAudienceSource } from '~~/shared/types/tag-broadcast'

/**
 * POST /api/broadcast/create
 * 建立推播草稿
 *
 * Body:
 * {
 *   name: string
 *   audienceSource: BroadcastAudienceSource
 *   messages: any[]           // LINE messagingApi.Message[]
 *   scheduleAt 請勿於建立時帶入；排程請在建立後以 PUT 設定
 * }
 *
 * Response: BroadcastDoc & { id: string }
 */
export default defineEventHandler(async (event) => {
  const { uid, workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const { name, audienceSource, messages } = body

  if (!name || !audienceSource || !messages?.length) {
    throw createError({ statusCode: 400, statusMessage: 'name, audienceSource, messages are required' })
  }

  const validSourceTypes = ['all', 'tags', 'audience', 'import']
  if (!validSourceTypes.includes(audienceSource.type)) {
    throw createError({ statusCode: 400, statusMessage: `audienceSource.type must be one of: ${validSourceTypes.join(', ')}` })
  }

  const id = uuidv4()
  const now = FieldValue.serverTimestamp()

  const doc: BroadcastDoc = {
    workspaceId,
    name,
    status: 'draft',
    channel: 'line',
    audienceSource,
    audienceSnapshot: {
      filter: null,
      resolvedUserIds: [],
      estimatedCount: 0,
    },
    messages,
    // `C-213`：發完幫收到的人貼的標籤（選填）
    completionTagIds: Array.isArray(body.completionTagIds)
      ? body.completionTagIds.map((t: unknown) => String(t ?? '').trim()).filter(Boolean)
      : [],
    /**
     * `C-240`：這則推播是為了哪一檔節慶發的（選填，只有從「為這一檔擬推播」建立的才有）。
     *
     * ⭐ **這一欄是「知道」與「猜」的分界線**：沒有它的話，檔期回顧只能照日期抓——
     * 2026-09-23 實測，那樣會把八則商品檔期推播算成「中元節的成績」（`shared/festival-outcome.ts`）。
     * ⛔ 存空字串沒有意義，沒有就不要寫這個欄位。
     */
    ...(typeof body.festivalId === 'string' && body.festivalId.trim()
      ? { festivalId: body.festivalId.trim().slice(0, 64) }
      : {}),
    scheduleAt: null,
    startedAt: null,
    completedAt: null,
    totalCount: 0,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  }

  const db = getDb()
  await db.collection('broadcasts').doc(id).set(doc)
  return { id, ...doc }
})
