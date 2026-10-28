import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import {
  buildChunkSoftDeletePatch,
  invalidateTagIndexCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
  RECYCLE_RETENTION_DAYS,
} from './ai-knowledge-chunks'
import { countSourceChunks, KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import { invalidateKnowledgeChunkCount } from './ai-knowledge-quota'

export type ChunkSoftDeleteResult =
  | { deleted: false }
  | { deleted: true, title: string, /** 試算表上那一列之後不再收 */ excludedRow: boolean }

/**
 * 一條知識進回收桶（30 天內可還原；到期由排程真刪）。
 *
 * 2026-10-28 從 `DELETE /api/ai/knowledge/:chunkId` 抽出來（`D-156`）：操作紀錄「還原新增的知識」
 * 也是丟回收桶，⛔ 要跟頁面上的刪除同一套（試算表那一列記進不收名單、單張手寫來源一起進回收桶、
 * 空間快取作廢）——只改狀態的話，試算表下一輪同步會把它建回來、「還剩幾條空間」也不會更新。
 * 規則的來龍去脈寫在那支端點的檔頭。不存在／別家的／已經在回收桶的＝什麼都不做（`deleted: false`）。
 */
export async function softDeleteKnowledgeChunk(db: Firestore, workspaceId: string, chunkId: string): Promise<ChunkSoftDeleteResult> {
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) return { deleted: false }

  const existing = snap.data() as { workspaceId?: string; sourceId?: string | null; status?: string; deletedAt?: unknown; title?: string; isOverview?: boolean }
  if (existing.workspaceId !== workspaceId) return { deleted: false }
  if (existing.deletedAt != null) return { deleted: false }

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

  // 同步維護 source：manual 單張 → source 一起進回收桶；其他 → 重算 chunkCount。
  // ⛔ 這一步出錯不往上丟（code review `C-412`）：這條已經進回收桶了，丟出去的話呼叫的那邊
  //    不會寫操作紀錄（抽出來之前紀錄是先寫的），畫面還說刪除失敗。數字下次同步會重算
  if (sourceRef && sourceMine) {
    try {
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
        })
      }
      else {
        await sourceRef.update({
          chunkCount: remaining,
          updatedAt: FieldValue.serverTimestamp(),
        })
      }
    }
    catch (e) {
      console.warn('[knowledge-delete] source upkeep failed:', existing.sourceId, e)
    }
  }

  return { deleted: true, title: String(existing.title ?? ''), excludedRow: excludeRow }
}
