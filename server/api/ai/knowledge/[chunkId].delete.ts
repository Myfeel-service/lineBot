import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  buildChunkSoftDeletePatch,
  invalidateTagIndexCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
  RECYCLE_RETENTION_DAYS,
} from '~~/server/utils/ai-knowledge-chunks'
import { countSourceChunks, KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'

/**
 * DELETE /api/ai/knowledge/:chunkId
 *
 * 刪除＝進回收桶（軟刪除，30 天內可還原；到期由排程真刪）。
 * 若這張卡屬於 type='manual' 的 source（一個 source = 一張卡），source 跟著一起進回收桶
 * （不能真刪：還原時卡片的 sourceId 會指向不存在的來源）；file/url 的 source 只重算 chunkCount
 * （用實數重算，不用 increment——單卡刪除與 resync/gsheet 的重算並存時 increment 會漂，
 * 刪除確認框顯示的「底下 N 條」就會說謊）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: true }

  const existing = snap.data() as { workspaceId?: string; sourceId?: string | null; status?: string; deletedAt?: unknown }
  if (existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }
  if (existing.deletedAt != null) return { ok: true } // 已在回收桶，冪等

  await ref.update(buildChunkSoftDeletePatch(existing.status))
  invalidateTagIndexCache(workspaceId)

  // 同步維護 source：manual 單張 → source 一起進回收桶；其他 → 重算 chunkCount
  if (existing.sourceId) {
    const sourceRef = db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(existing.sourceId)
    const sourceSnap = await sourceRef.get().catch(() => null)
    if (sourceSnap?.exists) {
      const sourceData = sourceSnap.data() as { type?: string; workspaceId?: string }
      if (sourceData.workspaceId === workspaceId) {
        const remaining = await countSourceChunks(db, workspaceId, existing.sourceId)
        // manual 來源只有「一張卡都不剩」才連坐進回收桶：
        // 貼上文字匯入（C-47）是一個 manual source 掛多張卡，刪其中一張就收掉整個來源
        // 會讓其他卡變成指向回收桶來源的隱形卡（列表看不到、卻還在被檢索）。
        if (sourceData.type === 'manual' && remaining === 0) {
          await sourceRef.update({
            isDeleted: true, // listSources 靠這個欄位在查詢層排除墓碑（見該函式註解）
            deletedAt: FieldValue.serverTimestamp(),
            purgeAfter: Timestamp.fromMillis(Date.now() + RECYCLE_RETENTION_DAYS * 86_400_000),
            updatedAt: FieldValue.serverTimestamp(),
          }).catch(() => {})
        }
        else {
          await sourceRef.update({
            chunkCount: remaining,
            updatedAt: FieldValue.serverTimestamp(),
          }).catch(() => {})
        }
      }
    }
  }

  return { ok: true }
})
