/**
 * 「要放進去的知識庫資料夾是不是這個帳號的」（`G-98`，2026-09-29 權限盤點）。
 *
 * 為什麼要有：建卡（create／bulk-create）與改來源設定都照收任意 folderId。
 * 填了不存在的資料夾（或別家的），那份資料在側欄就**整份消失**——側欄只畫自家的資料夾，
 * 掛在找不到的資料夾底下的來源哪一格都不會出現，而資料其實還在、AI 也照樣在用。
 *
 * ⛔ 查不到一律 404、不分「不存在」與「別家的」（分開講等於告訴對方別家有這個資料夾）。
 * ⛔ 不自動改成「未分類」：使用者按的是「放進某某資料夾」，默默放到別處是另一種說謊；
 *    前端資料夾清單過期（別的分頁刪了它）時，重新整理再選就好。
 *
 * 放在獨立檔案而不是 ai-knowledge-folders.ts：那支 import 了 ai-knowledge-sources，
 * 這道檢查又要給 ai-knowledge-sources 用，放一起就成了互相 import。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { KNOWLEDGE_FOLDERS_COLLECTION } from './ai-knowledge-folders'

/**
 * 把前端送來的 folderId 正規化並驗歸屬：沒帶／空字串／null → null（未分類）；
 * 有帶就必須是這個帳號的資料夾，否則丟 404。
 */
export async function resolveKnowledgeFolderId(
  db: Firestore,
  workspaceId: string,
  raw: unknown,
): Promise<string | null> {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const folderId = raw.trim()
  // 含 `/` 的 id 會被 Firestore 當成路徑直接丟例外（變成 500）；反正不可能是真的資料夾
  const snap = folderId.includes('/')
    ? null
    : await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId).get()
  if (!snap?.exists || (snap.data() as { workspaceId?: string } | undefined)?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到要放進去的資料夾（可能已被刪除），請重新整理後再選一次' })
  }
  return folderId
}
