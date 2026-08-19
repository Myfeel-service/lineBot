import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import type { KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'

/**
 * POST /api/ai/knowledge/:chunkId/settings
 * Body: { enabled?: boolean; activeUntil?: string | null }
 *
 * 卡片的「供 AI 使用」開關與有效期限（與內容編輯分開：不動 embedding、不重新索引）。
 *   - enabled=false：status 'indexed' → 'disabled'（embedding 保留，重新啟用免重算）
 *   - enabled=true ：status 'disabled' → 'indexed'；一併清掉過期紀錄；已過去的期限順手清掉
 *                    （否則排程 10 分鐘內又把它關回去，使用者會以為開關壞了）
 *   - activeUntil：'YYYY-MM-DD' = 有效到該日結束（台灣時間 23:59:59）；null = 清除（永久）。
 *     把日期改到未來時，若卡片是「到期自動停用」狀態 → 視為要重新上架，自動重新啟用；
 *     手動關掉的卡則尊重開關、維持停用。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const body = await readBody(event).catch(() => ({}))
  const hasEnabled = typeof body?.enabled === 'boolean'
  const hasActiveUntil = 'activeUntil' in (body ?? {})
  // 解除手動編輯鎖（C-44）：鎖住的卡不吃表格/網頁更新，是「表格改了永遠不生效」
  // 唯一的來源；這裡給一條明確的解鎖路（解鎖後下一輪同步就會覆蓋回來源版本）。
  const hasClearLock = body?.clearManualLock === true
  if (!hasEnabled && !hasActiveUntil && !hasClearLock) {
    throw createError({ statusCode: 400, statusMessage: '至少要帶 enabled、activeUntil 或 clearManualLock' })
  }

  // 解析有效期限：當日結束（台灣時間）才到期，符合「設 8/15 = 8/15 整天都有效」的直覺
  let activeUntilTs: Timestamp | null | undefined
  if (hasActiveUntil) {
    if (body.activeUntil === null || body.activeUntil === '') {
      activeUntilTs = null
    }
    else {
      const raw = String(body.activeUntil)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw createError({ statusCode: 400, statusMessage: 'activeUntil 格式須為 YYYY-MM-DD' })
      }
      const d = new Date(`${raw}T23:59:59.999+08:00`)
      if (Number.isNaN(d.getTime())) throw createError({ statusCode: 400, statusMessage: 'activeUntil 不是有效日期' })
      activeUntilTs = Timestamp.fromDate(d)
    }
  }

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  const chunk = snap.data() as any
  if (chunk.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }

  // 回收桶的卡不接受開關/期限操作：它的 status 是 disabled 沒錯，但那是「已刪除」不是「停用」。
  // 不擋的話，API 直接 enable 會讓一張已刪除的卡復活上線，30 天後又被 purge 排程真刪掉。
  if (chunk.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: '這張卡在回收桶裡，請先還原再操作' })
  }

  const status = String(chunk.status ?? 'pending') as KnowledgeChunkStatus
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (hasEnabled) {
    if (body.enabled === false) {
      // 只有「可用」的卡有得關；pending/failed 本來就不會被 AI 引用
      if (status !== 'indexed' && status !== 'disabled') {
        throw createError({ statusCode: 400, statusMessage: '這張卡目前不是「可用」狀態，不需停用' })
      }
      update.status = 'disabled' satisfies KnowledgeChunkStatus
    }
    else {
      if (status !== 'indexed' && status !== 'disabled') {
        throw createError({ statusCode: 400, statusMessage: '這張卡尚未完成索引，無法啟用' })
      }
      if (!chunk.embedding) {
        throw createError({ statusCode: 400, statusMessage: '這張卡沒有索引資料，請改用「重新索引」' })
      }
      update.status = 'indexed' satisfies KnowledgeChunkStatus
      update.expiredAt = FieldValue.delete()
      // 期限已過而使用者按「啟用」= 想重新上架 → 順手清掉舊期限，避免排程馬上又關回去
      const untilMs = typeof chunk.activeUntil?.toMillis === 'function' ? chunk.activeUntil.toMillis() : 0
      if (untilMs && untilMs <= Date.now() && activeUntilTs === undefined) {
        update.activeUntil = FieldValue.delete()
      }
    }
  }

  if (hasClearLock) {
    update.manuallyEditedAt = null
  }

  if (activeUntilTs !== undefined) {
    update.activeUntil = activeUntilTs === null ? FieldValue.delete() : activeUntilTs
    if (activeUntilTs && activeUntilTs.toMillis() > Date.now()) {
      // 日期改到未來：若這張是「到期自動停用」的卡 → 視為重新上架
      if (status === 'disabled' && chunk.expiredAt && body?.enabled !== false) {
        update.status = 'indexed' satisfies KnowledgeChunkStatus
        update.expiredAt = FieldValue.delete()
      }
    }
  }

  await ref.update(update)
  const after = (await ref.get()).data() as any
  return {
    id: chunkId,
    status: String(after?.status ?? '') as KnowledgeChunkStatus,
    activeUntilMs: typeof after?.activeUntil?.toMillis === 'function' ? after.activeUntil.toMillis() : 0,
    expiredAtMs: typeof after?.expiredAt?.toMillis === 'function' ? after.expiredAt.toMillis() : 0,
  }
})
