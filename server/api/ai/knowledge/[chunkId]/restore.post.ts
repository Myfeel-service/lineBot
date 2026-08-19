import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  buildEmbeddingText,
  invalidateTagIndexCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
  resolveRestoredStatus,
  runIndexOnChunk,
} from '~~/server/utils/ai-knowledge-chunks'
import { countSourceChunks, KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'

/**
 * POST /api/ai/knowledge/:chunkId/restore
 *
 * 從回收桶還原一張卡：回到刪除前的狀態（刪除前就停用的卡還原後仍是停用，
 * 還原≠重新上架）。連坐進回收桶的 manual 來源一併還原；其他來源重算 chunkCount。
 * 還原成 pending（向量已被清）時當場重建索引，不等 retry 排程。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到這張卡（可能已超過保留期被清除）' })

  const chunk = snap.data() as any
  if (chunk.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }
  if (chunk.deletedAt == null) return { id: chunkId, status: String(chunk.status ?? 'pending') } // 不在回收桶，冪等

  const restored = resolveRestoredStatus(chunk.statusBeforeDelete, !!chunk.embedding)
  await ref.update({
    status: restored,
    isDeleted: false, // 與 deletedAt 成對維護（查詢層過濾靠它，見 countSourceChunks）
    deletedAt: FieldValue.delete(),
    purgeAfter: FieldValue.delete(),
    statusBeforeDelete: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  })
  invalidateTagIndexCache(workspaceId)

  // 來源側：manual 連坐的一併還原；一般來源重算張數
  if (chunk.sourceId) {
    const sourceRef = db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(String(chunk.sourceId))
    const sourceSnap = await sourceRef.get().catch(() => null)
    if (sourceSnap?.exists && (sourceSnap.data() as any)?.workspaceId === workspaceId) {
      if ((sourceSnap.data() as any)?.deletedAt != null) {
        await sourceRef.update({
          isDeleted: false,
          deletedAt: FieldValue.delete(),
          purgeAfter: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => {})
      }
      else {
        const chunkCount = await countSourceChunks(db, workspaceId, String(chunk.sourceId))
        await sourceRef.update({ chunkCount, updatedAt: FieldValue.serverTimestamp() }).catch(() => {})
      }
    }
  }

  // 向量已被清掉的卡：當場重建索引，不讓使用者等 retry 排程（最壞 10 分鐘）
  if (restored === 'pending') {
    const r = await runIndexOnChunk(
      db,
      chunkId,
      buildEmbeddingText(String(chunk.title ?? ''), String(chunk.content ?? ''), Array.isArray(chunk.questions) ? chunk.questions.map(String) : []),
      workspaceId,
    )
    return { id: chunkId, status: r.status }
  }

  return { id: chunkId, status: restored }
})
