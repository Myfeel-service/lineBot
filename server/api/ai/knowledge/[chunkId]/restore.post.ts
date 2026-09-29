import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  buildEmbeddingText,
  invalidateTagIndexCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
  resolveRestoredStatus,
  runIndexOnChunk,
} from '~~/server/utils/ai-knowledge-chunks'
import { countSourceChunks, KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { assertKnowledgeChunkQuota, invalidateKnowledgeChunkCount } from '~~/server/utils/ai-knowledge-quota'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/knowledge/:chunkId/restore
 *
 * 從回收桶還原一張卡：回到刪除前的狀態（刪除前就停用的卡還原後仍是停用，
 * 還原≠重新上架）。連坐進回收桶的 manual 來源一併還原；其他來源重算 chunkCount。
 * 還原成 pending（向量已被清）時當場重建索引，不等 retry 排程。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到這張卡（可能已超過保留期被清除）' })

  const chunk = snap.data() as any
  if (chunk.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到這張卡（可能已超過保留期被清除）' })
  }
  if (chunk.deletedAt == null) return { id: chunkId, status: String(chunk.status ?? 'pending') } // 不在回收桶，冪等

  /**
   * 還原＝知識量 +1，所以這裡也要守門（`D-69` 二次掃描抓到的洞）。
   * 不擋的話「刪 100 條 → 匯入 100 條新的 → 把舊的還原回來」就繞過了上限。
   *
   * ⚠️ 擺在冪等早退之後：對「已經不在回收桶」的卡重按不該噴錯。
   */
  await assertKnowledgeChunkQuota(workspaceId, 1, db)

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
  invalidateKnowledgeChunkCount(workspaceId)

  // 稽核（`C-254`）：還原＝知識量 +1，也是計費維度的變動。
  // ⚠️ 還原**不等於重新上架**（刪之前是停用的，還原後仍是停用），備註要講清楚
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.restore',
    targetId: chunkId,
    after: { title: String(chunk.title ?? ''), cardStatus: restored },
    note: restored === 'disabled'
      ? `${String(chunk.title ?? '')}（救回來了，但它刪之前就是停用的，所以還是停用）`
      : String(chunk.title ?? ''),
  }, db)

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
