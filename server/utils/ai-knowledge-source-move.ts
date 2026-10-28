import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import { RELEARN_PENDING_FIELD, syncSourceProductWithGroup, type SourceGroupSyncResult } from './ai-knowledge-product-group'

/**
 * 一份資料換了分組之後那一步（`D-127` 分組就是商品）：商品名改成新組的組名，有變就當場重新學習。
 *
 * 2026-10-28 從 `PUT /api/ai/sources/:sourceId` 抽出來（`D-156`）：「還原」把資料搬回原本的分組時
 * 也要走同一條路——⛔ 只把 folderId 寫回去的話，商品名還停在搬過去那一組，AI 會一直當成別台商品。
 *
 * ⛔ 學失敗不往外丟（`C-320` /code-review 第 3 條）：分組已經換好，回 500 的話畫面以為搬移失敗。
 * 留「還沒重新學」的記號（`D-129`），排程（relearnPendingProductSources）自己對齊組名、補學完。
 */
export async function syncSourceAfterMove(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  uid: string,
): Promise<{ error: false, sync: SourceGroupSyncResult } | { error: true }> {
  try {
    return { error: false, sync: await syncSourceProductWithGroup(db, workspaceId, sourceId, { uid }) }
  }
  catch (e) {
    console.warn(`[sources] ${sourceId} group product sync failed:`, (e as Error)?.message)
    // 對齊那一步已經留過的話這裡是重寫一次；斷在對齊之前的（記號還沒寫）靠這一筆才找得到
    try {
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId)
        .update({ [RELEARN_PENDING_FIELD]: true, updatedAt: FieldValue.serverTimestamp() })
    }
    catch { /* 記號寫不進去：資料剛被刪、或資料庫一時寫不進去——搬移照樣算成功 */ }
    return { error: true }
  }
}
