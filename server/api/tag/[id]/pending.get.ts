import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { fetchUserDisplayNames } from '~~/server/utils/user-display-names'
import { PENDING_ROWS_LIMIT, PENDING_SCAN_LIMIT, pickPendingForTag } from '~~/shared/tag-pending-review'

/**
 * GET /api/tag/:id/pending — 這一顆標籤還有哪些客人的建議等人決定（`D-61`）
 *
 * Response: { tag, rows, dropped, scanTruncated }
 *
 * 為什麼要開這一支：標籤頁的「待審 34 位」先前只能連到好友頁，而那頁列的是
 * **全部**有建議的客人（不分標籤），要處理那 34 條得一位一位開抽屜——09-04 線上
 * 116 條積壓清不完就是卡在這裡。這支讓「一次審一顆」變得可能。
 *
 * 讀取成本：跟 `/api/tag/pending-counts` 同一種掃描（`hasPending` 等值，現有索引），
 * 差別只在這支帶回 `pending` 陣列本身並在記憶體裡挑出這一顆。
 * ⚠️ 收件匣長到 `PENDING_SCAN_LIMIT` 以上時要改走鏡像欄位（`pendingTagIds` array-contains），
 *    見 `D-42` 的註記；現在 64 份文件，先不為它多維護一個欄位。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const tagId = getRouterParam(event, 'id')
  if (!tagId) throw createError({ statusCode: 400, statusMessage: 'tagId is required' })

  const db = getDb()
  const tagSnap = await db.collection('tags').doc(tagId).get()
  const tag = tagSnap.data()
  // ⛔ 跨工作區一律當成不存在（別回「無權限」洩漏這顆標籤存在）
  if (!tagSnap.exists || tag?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到這顆標籤' })
  }

  const snap = await db.collection('userTagSuggestions')
    .where('workspaceId', '==', workspaceId)
    .where('hasPending', '==', true)
    .select('pending')
    .limit(PENDING_SCAN_LIMIT + 1) // 多讀一份純粹用來判斷「還有沒有更多」
    .get()

  const scanTruncated = snap.size > PENDING_SCAN_LIMIT
  const docs = snap.docs.slice(0, PENDING_SCAN_LIMIT).map(d => ({
    id: d.id,
    pending: (d.data()?.pending ?? []) as Array<{ tagId?: string }>,
  }))

  const { rows, dropped } = pickPendingForTag(docs, tagId, PENDING_ROWS_LIMIT)
  // 名字只查真的要顯示的那幾位（截斷掉的不查）
  const names = await fetchUserDisplayNames(db, rows.map(r => r.userId))

  return {
    tag: { id: tagSnap.id, name: String(tag?.name ?? ''), color: String(tag?.color ?? ''), aiMode: String(tag?.aiMode ?? 'off') },
    rows: rows.map(r => ({ ...r, displayName: names[r.userId] ?? '' })),
    /** 撞到單次回傳上限而沒列出來的條數（⛔ 不可以靜靜截斷） */
    dropped,
    /** 掃描撞到上限＝這顆的待審可能還有更多沒被看到 */
    scanTruncated,
  }
})
