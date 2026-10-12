import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { countSourceChunks, getSource, invalidateCatalogSourceCache, KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { assertKnowledgeChunkQuota, invalidateKnowledgeChunkCount } from '~~/server/utils/ai-knowledge-quota'
import { regenerateOverviewCard } from '~~/server/utils/ai-overview'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/sources/:sourceId/overview
 *
 * 匯入**之後**才問「要不要再做一張『我們有賣什麼』」（`D-123`②，2026-10-12）。
 * 一份資料改成直接加入、不停在預覽之後，原本長在預覽頁的那個問題沒地方問了——
 * 而它本來就是「看到切出幾條」才答得出來的問題，結果頁正好是那一刻。
 *
 * 跟預覽頁那條（請 AI 把整份原文再讀一次）不同：這裡拿**已經進庫、學好的那幾條**合成，
 * 不用原檔、不重做任何一條（同步那兩條路重生總表用的是同一支 `regenerateOverviewCard`）。
 *
 * ⚠️ 做出來要把來源標成 `generateOverview`：那是「型錄來源」的記號——答題時同一份底下不同商品不被併成一條、
 *    之後網址重新同步也會跟著重做總表。只建卡不標記，客人問「有賣哪些」時照樣只拿得到一條。
 * ⚠️ 新建才算一條額度（已經有總表就是原地重做）；空間滿了先擋，不付了 AI 的錢才發現放不進去。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: '找不到這份資料（可能已經被刪掉了）' })

  await assertMaintenanceBudget(workspaceId)

  // 跟 regenerateOverviewCard 同一個查詢形狀（workspaceId＋sourceId），不多要一組索引
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .select('isOverview', 'deletedAt')
    .get()
  const hasOverview = snap.docs.some(d => d.data()?.isOverview === true && d.data()?.deletedAt == null)
  if (!hasOverview) await assertKnowledgeChunkQuota(workspaceId, 1, db)

  const outcome = await regenerateOverviewCard(db, workspaceId, sourceId)
  const made = outcome === 'created' || outcome === 'updated'

  if (made) {
    // 條數要跟著重算（2026-10-13 `/code-review`）：新做一張＝多一條，清單上寫的還是舊數字；
    // 之後「換新版」沒對到同名清單時是拿這個數字估會空出多少空間，少一條就少算一條。
    // 跟同步、套用改動那幾條重做總表的路同一種寫法（countSourceChunks，聚合查詢不逐筆讀）
    const chunkCount = await countSourceChunks(db, workspaceId, sourceId)
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId)
      .update({ generateOverview: true, chunkCount, updatedAt: FieldValue.serverTimestamp() })
    invalidateCatalogSourceCache(workspaceId)
    invalidateKnowledgeChunkCount(workspaceId)
    // 稽核（`C-254`）：會花一次 AI 整理＋學習的錢；沒做出來就沒有變動，不記
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'source.overview',
      targetId: sourceId,
      after: { name: String(source.data.name ?? '') },
      note: `${String(source.data.name ?? '')}：${outcome === 'created' ? '新做了' : '重做了'}一張「我們有賣什麼」總表`,
    }, db)
  }

  return { outcome, made }
})
