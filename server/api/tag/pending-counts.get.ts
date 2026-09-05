import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { aggregatePendingByTag } from '~~/shared/tag-suggestion-stats'
import { PENDING_SCAN_LIMIT } from '~~/shared/tag-pending-review'

/**
 * 一次最多讀幾份收件匣。
 *
 * 為什麼要有上限：這支是「掃全工作區還沒決定的建議」，沒人清的話會一直長
 * （08-11 讀取費暴衝就是這種形狀）。⛔ 撞到上限**一定要講出來**，
 * 否則「待審 3 位」會被當成精確值，實際上是「掃到的前 500 份裡有 3 位」。
 *
 * ⛔ 常數放在 shared 是刻意的：`/api/tag/:id/pending`（點進去看清單那支）掃的是同一批資料，
 * 兩邊深度不同的話會變成「badge 寫 34、點進去列 30」，而且沒有人說得出少的在哪。
 */
const SCAN_LIMIT = PENDING_SCAN_LIMIT

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

  const counts = aggregatePendingByTag(docs)

  /**
   * 有人在等的那幾顆標籤，附上名字／顏色／判斷模式（`D-63` UI/UX 審查①）。
   *
   * 為什麼要在這裡回：標籤頁頂端那條「有人在等你決定」要**直接列出是哪幾顆**並且能點進去審，
   * 而標籤列表是分頁的——有待審的那顆不一定在當前這一頁，光靠畫面上的清單湊不出名字。
   *
   * ⛔ 用 `getAll` 逐顆主鍵直讀，不要為了幾顆標籤去掃整個 `tags` 集合。
   * ⛔ 讀不到的（標籤已被刪、建議還沒清）直接不列：與其列一顆點進去是空的，
   *   不如不列——那條路是死路（見 `feedback_filters_must_report_what_they_dropped` 的精神）。
   */
  const tagIds = Object.keys(counts)
  let tags: Array<{ id: string, name: string, color?: string, aiMode?: string }> = []
  if (tagIds.length) {
    const refs = tagIds.map(id => db.collection('tags').doc(id))
    const tagSnaps = await db.getAll(...refs)
    tags = tagSnaps
      .filter(s => s.exists && (s.data() as { workspaceId?: string })?.workspaceId === workspaceId)
      .map((s) => {
        const v = s.data() as { name?: string, color?: string, aiMode?: string }
        return { id: s.id, name: String(v.name ?? ''), color: v.color, aiMode: v.aiMode }
      })
      .filter(t => t.name)
  }

  return {
    counts,
    users: docs.length,
    /** 建議條數＝每顆標籤的客人數加總。⛔ 跟 `users` 不會相等（一位客人可能有好幾顆在等） */
    suggestions: Object.values(counts).reduce((a, b) => a + b, 0),
    tags,
    truncated,
  }
})
