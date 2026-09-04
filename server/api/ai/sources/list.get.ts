import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { listSources } from '~~/server/utils/ai-knowledge-sources'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'

/**
 * GET /api/ai/sources/list
 *
 * 回傳：
 *   - items: 所有來源（依 updatedAt 倒序）
 *   - orphanCount: sourceId === null 的舊版手寫卡片數（給 UI 顯示「整理舊資料」橫幅用）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  const [listed, orphanSnap] = await Promise.all([
    listSources(db, workspaceId),
    db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('sourceId', '==', null)
      .count()
      .get(),
  ])

  return {
    items: listed.items,
    orphanCount: orphanSnap.data().count,
    /**
     * 這份清單可能不完整（`C-137`）。畫面一定要講出來——
     * 2026-09-04 就是因為少了東西卻長得很正常，老闆傳了三次同一份說明書。
     */
    degraded: listed.degraded,
    /** 份數撞到上限、後面的沒回（`C-138`）：一樣要講，不能默默切掉 */
    truncated: listed.truncated,
  }
})
