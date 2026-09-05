import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { reviewSuggestions } from '~~/server/utils/tag-suggestion-review'
import { PENDING_BULK_LIMIT, PENDING_ROWS_LIMIT, PENDING_SCAN_LIMIT, pickPendingForTag } from '~~/shared/tag-pending-review'
import { aggregatePendingByTag } from '~~/shared/tag-suggestion-stats'
import { fetchUserDisplayNames } from '~~/server/utils/user-display-names'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

/** 同時處理幾位（Firestore 是不同文件，衝突風險為零；控併發只是不想一次開 100 條連線） */
const CONCURRENCY = 8

/**
 * POST /api/tag/:id/pending — 一次採用／忽略**這顆標籤**的多位客人建議（`D-61`）
 *
 * Body: { action: 'apply' | 'dismiss', userIds: string[] }
 * Response: { processed, alreadyHandled, notProcessed, failed }
 *
 * ⛔ **四個數字都要回**：勾了 34 位、成功 30 位時，人要分得出另外 4 位是「別人先按掉了」
 * 還是「出錯了」——兩者的下一步完全不同（同 `feedback_filters_must_report_what_they_dropped`）。
 *
 * ⚠️ 忽略是**永久**的：那顆標籤對那位客人 AI 永不再提（連「判到直接貼」也不會貼，
 * 因為 `dismissedTagIds` 在候選階段就被排除）。畫面上一定要講，別讓人以為只是清掉待辦。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const tagId = getRouterParam(event, 'id')
  if (!tagId) throw createError({ statusCode: 400, statusMessage: 'tagId is required' })

  const body = await readBody(event)
  const action = body?.action
  if (action !== 'apply' && action !== 'dismiss') {
    throw createError({ statusCode: 400, statusMessage: 'action must be apply or dismiss' })
  }
  /**
   * ⛔ 一律正規化成帶租戶前綴的主鍵，跟隔壁那支（`users/[id]/tag-suggestions`）同一招。
   * 少了這一步，前端傳來裸的 LINE id（`U89c6…`）會直接被當成文件 id 去查 →
   * 一定查不到，而下面又把「查不到」講成「已經被處理過」，操作者會以為同事清完了。
   */
  const userIds: string[] = Array.isArray(body?.userIds)
    ? [...new Set<string>(
        body.userIds
          .map((u: unknown) => String(u ?? '').trim())
          .filter((u: string) => !!u)
          .map((u: string) => lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(u, workspaceId), workspaceId)),
      )]
    : []
  if (!userIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'userIds array is required and must not be empty' })
  }

  const db = getDb()
  const tagSnap = await db.collection('tags').doc(tagId).get()
  if (!tagSnap.exists || tagSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到這顆標籤' })
  }

  // ⛔ 撞上限的那幾位要回報，不可以靜靜丟掉（呼叫端會拿 notProcessed 叫人再按一次）
  const batch = userIds.slice(0, PENDING_BULK_LIMIT)
  const notProcessed = userIds.length - batch.length

  let processed = 0
  let alreadyHandled = 0
  let notFound = 0
  let failed = 0

  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY)
    const results = await Promise.all(slice.map(async (userDocId) => {
      try {
        // 一位客人一次只處理這一顆：別順手把他其他顆待審一起做掉（人只勾了這一顆）
        return await reviewSuggestions(db, { workspaceId, userDocId, tagIds: [tagId], action, operatorId: uid })
      }
      catch (e) {
        console.warn('[tag-pending] 單位失敗:', userDocId, e)
        return null
      }
    }))
    for (const r of results) {
      if (!r) { failed += 1; continue }
      /**
       * ⛔ 「找不到」與「已經被處理過」**不可以合併**（2026-09-04 code review 抓到）。
       * 前者是這位客人根本沒有收件匣文件——id 對不上、資料被刪、或不是這個工作區的：
       * **什麼都沒找到、什麼都沒寫**，要有人去查。後者是同事先按掉了：不用管。
       * 合成一句「N 位已經被處理過」會讓人以為佇列被清乾淨了，實際上一筆都沒動。
       */
      if (r.outcome === 'done') processed += 1
      else if (r.outcome === 'not_found') notFound += 1
      else alreadyHandled += 1
    }
  }

  /**
   * 處理完順手把**更新後的畫面資料**一起回去（`D-61` code review：讀取成本）。
   *
   * 舊流程按一次「採用」要掃三輪同一批文件：這支自己不掃、但前端收到結果後
   * ①`emit('changed')` → 重抓每顆標籤的待審數（掃 501 份）
   * ②`load()` → 重抓這顆的清單（又掃 501 份 ＋ 一次 getAll）
   * 清完 116 條積壓就是好幾千次讀取，形狀跟 08-11 讀取費暴衝一樣。
   * 現在在這裡掃**一次**，同時算出「這顆的剩餘清單」與「每顆的待審數」帶回去，
   * 前端兩件事都不用再打 API。
   * ⛔ 掃描深度沿用同一個常數：跟徽章／清單那兩支不同的話，三個地方會各說一個數字。
   */
  const afterSnap = await db.collection('userTagSuggestions')
    .where('workspaceId', '==', workspaceId)
    .where('hasPending', '==', true)
    .select('pending')
    .limit(PENDING_SCAN_LIMIT + 1)
    .get()
  const scanTruncated = afterSnap.size > PENDING_SCAN_LIMIT
  const afterDocs = afterSnap.docs.slice(0, PENDING_SCAN_LIMIT).map(d => ({
    id: d.id,
    pending: (d.data()?.pending ?? []) as Array<{ tagId?: string }>,
  }))
  const { rows, dropped } = pickPendingForTag(afterDocs, tagId, PENDING_ROWS_LIMIT)
  const names = await fetchUserDisplayNames(db, rows.map(r => r.userId))

  return {
    processed,
    alreadyHandled,
    notFound,
    notProcessed,
    failed,
    /** 這顆標籤處理完之後還剩哪些人（前端直接換上，不用再打一次 GET） */
    rows: rows.map(r => ({ ...r, displayName: names[r.userId] ?? '' })),
    dropped,
    scanTruncated,
    /** 每顆標籤的待審人數（前端直接換上，不用再打 pending-counts） */
    counts: aggregatePendingByTag(afterDocs),
    /**
     * 全帳號還有幾**位**客人在等（`D-63` UI/UX 審查⑤）。
     *
     * ⛔ 一定要跟 `counts` 一起回：標籤頁頂端那條橫幅同時講「幾位客人」與「幾條建議」，
     * 條數可以從 `counts` 加總得到，**位數不行**（一位客人可能有好幾顆標籤在等）。
     * 少回這個欄位的話，審完一顆之後橫幅的「45 位」會停在舊數字＝畫面說謊。
     */
    users: afterDocs.length,
  }
})
