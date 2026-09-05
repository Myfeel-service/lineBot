import { getDb, listDocs } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { aggregatePendingByTag } from '~~/shared/tag-suggestion-stats'
import { PENDING_SCAN_LIMIT } from '~~/shared/tag-pending-review'
import {
  TAG_INSIGHTS_SCAN_LIMIT,
  TAG_SUGGESTION_LOG_SCAN_LIMIT,
  aggregateCoverage,
  aggregateSourceMix,
  aggregateSuggestionOutcomes,
  findTagHealthIssues,
  memberCountsFromRows,
  rankCustomerExpressedTags,
  splitEventVsIntent,
  topTagIntersections,
  type UserTagRow,
} from '~~/shared/tag-insights'
import type { TagDoc, TagSuggestionEvent } from '~~/shared/types/tag-broadcast'

/**
 * GET /api/tag/insights — 貼標分析的數字來源（`D-63`／`D-28`）
 *
 * **⛔ 這支只負責「算得對」，不負責「放在哪」**：獨立頁還是掛在好友頁頂部還沒拍板
 * （`D-63` 第一題），兩種版面吃的都是這一份 payload。
 *
 * **成本設計（`D-28` 的關鍵決定）**：`userTags` **只掃一趟**，人數／名單／排行／交集／
 * 覆蓋率全部從同一批列在記憶體裡分派出去——⛔ 不要每張卡各查一次，那是同一份資料付三次錢
 * （08-11 讀取費暴衝的形狀）。一次呼叫約等於「貼標筆數 ＋ 標籤數 ＋ 底帳筆數 ＋ 收件匣份數」
 * 的讀取量，MYFEEL 今天約三四千次。
 *
 * ⚠️ **還沒有「產生－存檔－沿用」那層**：`D-28` 拍板要按需鈕＋1 小時冷卻＋每份存檔
 * （沿用 `takeoverSummary` 模式），但那層要等版面拍板才知道包在哪裡，先不寫。
 * 在那之前**呼叫端不要放在會自動刷新的地方**。
 *
 * 索引：全部是單一等值條件（`workspaceId`）＋ 既有的 `(workspaceId, hasPending)`，
 * ⛔ 不需要新的複合索引。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  /**
   * ⛔ 每一段都各自 catch 並回報自己失不失敗，不要讓一段掛掉就整頁空白，
   * 也不要 catch 完回空值裝沒事——「查不到」跟「真的是零」在畫面上要講不同的話
   * （群發泡泡消失 25 天、知識庫清單消失兩週都是這個形狀）。
   */
  const failed: string[] = []

  const [tags, userTagScan, totalUsers, suggestionLogs, pendingScan] = await Promise.all([
    listDocs<TagDoc>('tags', ref => ref.where('workspaceId', '==', workspaceId))
      .catch((e) => { console.warn('[tag-insights] tags failed:', e); failed.push('tags'); return [] }),

    // 一趟掃描：多讀一筆用來判斷「還有沒有更多」
    db.collection('userTags')
      .where('workspaceId', '==', workspaceId)
      .select('userId', 'tagId', 'sourceType')
      .limit(TAG_INSIGHTS_SCAN_LIMIT + 1)
      .get()
      .catch((e) => { console.warn('[tag-insights] userTags failed:', e); failed.push('userTags'); return null }),

    db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .count().get()
      .then(s => s.data().count)
      .catch((e) => { console.warn('[tag-insights] users count failed:', e); failed.push('userCount'); return null }),

    db.collection('tagSuggestionLogs')
      .where('workspaceId', '==', workspaceId)
      .select('event', 'tagId')
      .limit(TAG_SUGGESTION_LOG_SCAN_LIMIT + 1)
      .get()
      .catch((e) => { console.warn('[tag-insights] suggestion logs failed:', e); failed.push('suggestionLogs'); return null }),

    db.collection('userTagSuggestions')
      .where('workspaceId', '==', workspaceId)
      .where('hasPending', '==', true)
      .select('pending')
      .limit(PENDING_SCAN_LIMIT + 1)
      .get()
      .catch((e) => { console.warn('[tag-insights] pending failed:', e); failed.push('pending'); return null }),
  ])

  // ── 一趟掃描的結果，分派給每一張卡 ──────────────────────────────
  const scanTruncated = userTagScan ? userTagScan.size > TAG_INSIGHTS_SCAN_LIMIT : false
  const rows: UserTagRow[] = (userTagScan?.docs ?? [])
    .slice(0, TAG_INSIGHTS_SCAN_LIMIT)
    .map((d) => {
      const v = d.data() as Partial<UserTagRow>
      return { userId: String(v.userId ?? ''), tagId: String(v.tagId ?? ''), sourceType: v.sourceType! }
    })

  const memberCounts = memberCountsFromRows(rows)

  /**
   * 「N 天沒互動」那顆系統標籤要從興趣排行裡拿掉：它算系統事件（＝客人訊號），
   * 但講的是「這個人沒有動作」不是興趣，量級又大，混進來會永遠佔第一名。
   * ⛔ 用 code 反查不要寫死 id：那顆是每個工作區各自建的。
   */
  const inactiveTagIds = tags.filter(t => t.code === INACTIVE_TAG_CODE).map(t => t.id)

  const ranking = rankCustomerExpressedTags(rows, { excludeTagIds: inactiveTagIds, limit: 10 })
  const intersections = topTagIntersections(rows, {
    tagIds: ranking.map(r => r.tagId),
    minUsers: 5,
    limit: 5,
  })

  // AI 真的判出過人的標籤（健康檢查要用）——同一批列，不另外查
  const aiProducedTagIds = new Set(rows.filter(r => r.sourceType === 'ai').map(r => r.tagId))
  const health = findTagHealthIssues(tags, memberCounts, aiProducedTagIds)

  const logRows = (suggestionLogs?.docs ?? [])
    .slice(0, TAG_SUGGESTION_LOG_SCAN_LIMIT)
    .map(d => ({ event: (d.data() as { event?: TagSuggestionEvent }).event! }))

  const pendingDocs = (pendingScan?.docs ?? [])
    .slice(0, PENDING_SCAN_LIMIT)
    .map(d => d.data() as { pending?: Array<{ tagId?: string }> })

  const nameOf = (id: string) => tags.find(t => t.id === id)?.name ?? '(已刪除的標籤)'
  const decorate = (id: string) => {
    const t = tags.find(x => x.id === id)
    return { tagId: id, name: t?.name ?? '(已刪除的標籤)', category: t?.category ?? null, color: t?.color ?? null }
  }

  return {
    /** ⛔ 畫面一定要讀這一段：哪幾塊算不出來、哪幾塊只算了一部分 */
    integrity: {
      failed,
      userTagsTruncated: scanTruncated,
      suggestionLogsTruncated: suggestionLogs ? suggestionLogs.size > TAG_SUGGESTION_LOG_SCAN_LIMIT : false,
      pendingTruncated: pendingScan ? pendingScan.size > PENDING_SCAN_LIMIT : false,
      scannedUserTags: rows.length,
      /** 這本底帳 2026-08-30 才開始寫——畫面上的採用率一定要標這個起算日 */
      suggestionLedgerSince: '2026-08-30',
    },

    /** 卡 1：還沒審的建議（幾位客人） */
    pendingReview: {
      users: pendingDocs.length,
      byTag: Object.entries(aggregatePendingByTag(pendingDocs))
        .map(([tagId, users]) => ({ ...decorate(tagId), users }))
        .sort((a, b) => b.users - a.users),
    },

    /** 卡 2：客人自己表現出來的興趣 */
    customerExpressed: ranking.map(r => ({ ...decorate(r.tagId), users: r.users })),

    /** 卡 2 附：兩兩交集 */
    intersections: intersections.map(x => ({
      a: decorate(x.a), b: decorate(x.b), users: x.users,
    })),

    /**
     * 卡 3：這些標籤在回答什麼。
     *
     * ⚠️ **畫面要講的是 `eventVsIntent`，不是 `sourceMix`**（2026-09-04 拿正式資料跑過才發現）：
     * MYFEEL 的來源占比是「客人自己表現的 99.96%」——數字漂亮但沒有資訊量，
     * 因為那 97.4% 是問卷／活動報名時自動貼的名冊，不是 AI 理解出來的意圖。
     * `sourceMix` 留著給「自動化程度」的診斷用，主角是事件 vs 意圖那一組。
     */
    eventVsIntent: splitEventVsIntent(rows, tags),
    sourceMix: aggregateSourceMix(rows),

    /** 卡 4：覆蓋率（分母是「有互動的客人」，不是「好友」） */
    coverage: aggregateCoverage(rows, totalUsers, { truncated: scanTruncated }),

    /** 卡 5：標籤健康檢查 */
    health: {
      zeroMember: health.zeroMember.map(t => ({ tagId: t.id, name: nameOf(t.id) })),
      aiOnButNeverProduced: health.aiOnButNeverProduced.map(t => ({ tagId: t.id, name: nameOf(t.id) })),
    },

    /** 卡 6：AI 貼標的成績 */
    suggestions: aggregateSuggestionOutcomes(logRows),
  }
})
