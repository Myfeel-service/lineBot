import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { deleteSourceWithChunks, getSource } from '~~/server/utils/ai-knowledge-sources'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/ai/sources/:sourceId
 * 連同底下所有 chunk 一併刪除（一鍵清乾淨來源）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  // 名字要在刪之前拿：刪完就查不到了，紀錄上只剩一串 id 等於沒有紀錄
  const source = await getSource(db, sourceId, workspaceId)
  const result = await deleteSourceWithChunks(db, workspaceId, sourceId)

  /*
   * 稽核（`C-254`）。⚠️ 這支是**真刪**（連底下的卡一起），跟單張卡的「進回收桶」不同——
   * 救不回來，所以張數一定要記下來：事後「AI 怎麼突然什麼都不會了」只有這一筆答得出來。
   * ⛔ 找不到來源（已經被刪過）就不記，免得留下一筆什麼都沒發生的紀錄。
   */
  if (source) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'source.delete',
      targetId: sourceId,
      before: { name: String(source.data.name ?? ''), chunkIdsCount: result.chunksDeleted },
      note: `${String(source.data.name ?? '')}：連同底下 ${result.chunksDeleted} 張知識卡一起刪掉了（救不回來）`,
    }, db)
  }

  return result
})
