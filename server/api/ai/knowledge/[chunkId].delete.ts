import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { RECYCLE_RETENTION_DAYS } from '~~/server/utils/ai-knowledge-chunks'
import { softDeleteKnowledgeChunk } from '~~/server/utils/ai-knowledge-chunk-delete'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/ai/knowledge/:chunkId
 *
 * 刪除＝進回收桶（軟刪除，30 天內可還原；到期由排程真刪）。
 * 若這張卡屬於 type='manual' 的 source（一個 source = 一張卡），source 跟著一起進回收桶
 * （不能真刪：還原時卡片的 sourceId 會指向不存在的來源）；file/url 的 source 只重算 chunkCount
 * （用實數重算，不用 increment——單卡刪除與 resync/gsheet 的重算並存時 increment 會漂，
 * 刪除確認框顯示的「底下 N 條」就會說謊）。
 *
 * 試算表來的那一條（`D-125`②，2026-10-13 拍板 A）：在後台刪掉＝「這一列不要了」，標題記進那一份的
 * `gsheetExcludedTitles`，之後同步跳過它。以前表格下次有任何變動它就長回來——空間滿時照提示
 * 「刪掉用不到的」去刪這種條目，下一輪同步又建回來，空間根本沒空出來。
 * ⚠️ 這是後台刪除唯一的入口（2026-10-13 查過：前端只有資料頁的「刪除」打這支）；
 *    同步自己因為表格少了那一列而收進回收桶的走 gsheet-sync，⛔ 不記進名單。
 *    （2026-10-28 起操作紀錄的「還原新增的知識」也走同一支 `softDeleteKnowledgeChunk`，`D-156`）
 *
 * 別家的卡＝當作不存在（`G-106`）：回 404 的話，「200 還是 404」就洩漏了「別家有這張卡」。
 * 刪除本來就是冪等的，什麼都沒動、回 ok 不會騙到人。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const db = getDb()
  const res = await softDeleteKnowledgeChunk(db, workspaceId, chunkId)
  if (!res.deleted) return { ok: true }

  // 稽核（`C-254`）：少一條＝AI 少會答一件事，而且症狀是「以前會答、現在不會了」，
  // 沒有紀錄的話根本無從查起。⚠️ 這裡是軟刪除（30 天內救得回來），備註要講清楚
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.delete',
    targetId: chunkId,
    before: { title: res.title },
    note: `${res.title}（進回收桶，${RECYCLE_RETENTION_DAYS} 天內還原得回來`
      + (res.excludedRow ? '；試算表上這一列之後不會再收' : '')
      + '）',
  }, db)

  return { ok: true }
})
