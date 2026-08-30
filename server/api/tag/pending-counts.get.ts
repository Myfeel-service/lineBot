import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { aggregatePendingByTag } from '~~/shared/tag-suggestion-stats'

/**
 * 一次最多讀幾份收件匣。
 *
 * 為什麼要有上限：這支是「掃全工作區還沒決定的建議」，沒人清的話會一直長
 * （08-11 讀取費暴衝就是這種形狀）。⛔ 撞到上限**一定要講出來**，
 * 否則「待審 3 位」會被當成精確值，實際上是「掃到的前 500 份裡有 3 位」。
 */
const SCAN_LIMIT = 500

/**
 * GET /api/tag/pending-counts — 每顆標籤還有幾位客人的 AI 建議等人決定（D-42②）
 *
 * Response: { counts: { [tagId]: 客人數 }, users, truncated }
 *
 * 為什麼不走「每顆標籤查一次」：建議存在「一位客人一份」的文件裡（pending 陣列），
 * 要反查「這顆標籤有誰在等」，Firestore 得先有 array-contains 的鏡像欄位才做得到。
 * 那個欄位的維護點跟 hasPending 完全重合、但**舊文件沒有它**（回填前一律漏算）——
 * 所以第一版走「掃 hasPending 的文件、讀 pending 陣列本身聚合」：多讀一些，
 * 但數字直接來自事實、不受欄位補沒補影響。要精確篩選（好友頁只列該顆標籤的待審）
 * 時再補鏡像欄位，見 STATUS `D-42`。
 *
 * 索引：(workspaceId, hasPending) 已存在（好友頁「只看有 AI 建議的」在用）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  // 多讀一份用來判斷「還有沒有更多」——回傳的統計仍只用前 SCAN_LIMIT 份
  const snap = await db.collection('userTagSuggestions')
    .where('workspaceId', '==', workspaceId)
    .where('hasPending', '==', true)
    .select('pending')
    .limit(SCAN_LIMIT + 1)
    .get()

  const truncated = snap.size > SCAN_LIMIT
  const docs = snap.docs.slice(0, SCAN_LIMIT).map(d => d.data() as { pending?: Array<{ tagId?: string }> })

  return {
    counts: aggregatePendingByTag(docs),
    users: docs.length,
    truncated,
  }
})
