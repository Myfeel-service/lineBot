import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  buildChunkSoftDeletePatch,
  invalidateTagIndexCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
  RECYCLE_RETENTION_DAYS,
} from '~~/server/utils/ai-knowledge-chunks'
import { countSourceChunks, KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { invalidateKnowledgeChunkCount } from '~~/server/utils/ai-knowledge-quota'
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
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: true }

  const existing = snap.data() as { workspaceId?: string; sourceId?: string | null; status?: string; deletedAt?: unknown; title?: string; isOverview?: boolean }
  // 別家的卡＝當作不存在，跟上面那行回一樣的東西（`G-106`）：回 404 的話，「200 還是 404」
  // 就洩漏了「別家有這張卡」。刪除本來就是冪等的，什麼都沒動、回 ok 不會騙到人。
  if (existing.workspaceId !== workspaceId) {
    return { ok: true }
  }
  if (existing.deletedAt != null) return { ok: true } // 已在回收桶，冪等

  const title = String(existing.title ?? '').trim()
  const sourceRef = existing.sourceId ? db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(existing.sourceId) : null
  const sourceSnap = sourceRef ? await sourceRef.get().catch(() => null) : null
  const sourceData = sourceSnap?.exists ? sourceSnap.data() as { type?: string; workspaceId?: string } : undefined
  const sourceMine = sourceData?.workspaceId === workspaceId
  // 總覽那一條不是表上的任何一列（是整份合成的），不記
  const excludeRow = !!sourceRef && sourceMine && sourceData?.type === 'gsheet' && existing.isOverview !== true && !!title

  // ⛔ 先記「這一列不要了」再刪：反過來的話，記的那一步失敗、他重按時這條已經在回收桶（冪等早退），
  //    名單就永遠沒記上，下一輪同步又把它建回來。記成功、刪失敗＝這條還活著，同步照常比對它，不會壞。
  if (excludeRow) {
    await sourceRef!.update({ gsheetExcludedTitles: FieldValue.arrayUnion(title) })
  }

  await ref.update(buildChunkSoftDeletePatch(existing.status))
  invalidateTagIndexCache(workspaceId)
  // 「還剩幾條空間」的快取（60 秒）馬上作廢（`C-308`⑧）：照提示刪完馬上再加，以前還是說滿了
  invalidateKnowledgeChunkCount(workspaceId)

  // 稽核（`C-254`）：少一條＝AI 少會答一件事，而且症狀是「以前會答、現在不會了」，
  // 沒有紀錄的話根本無從查起。⚠️ 這裡是軟刪除（30 天內救得回來），備註要講清楚
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.delete',
    targetId: chunkId,
    before: { title: String(existing.title ?? '') },
    note: `${String(existing.title ?? '')}（進回收桶，${RECYCLE_RETENTION_DAYS} 天內還原得回來`
      + (excludeRow ? '；試算表上這一列之後不會再收' : '')
      + '）',
  }, db)

  // 同步維護 source：manual 單張 → source 一起進回收桶；其他 → 重算 chunkCount
  if (sourceRef && sourceMine) {
    const remaining = await countSourceChunks(db, workspaceId, existing.sourceId!)
    // manual 來源只有「一張卡都不剩」才連坐進回收桶：
    // 貼上文字匯入（C-47）是一個 manual source 掛多張卡，刪其中一張就收掉整個來源
    // 會讓其他卡變成指向回收桶來源的隱形卡（列表看不到、卻還在被檢索）。
    if (sourceData?.type === 'manual' && remaining === 0) {
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

  return { ok: true }
})
