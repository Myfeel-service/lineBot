/**
 * 好友統計報告的數字怎麼算（`D-155`，取代 `D-28`／`D-63` 的 `tag-insights-compute.ts`）。
 *
 * ⚠️ **這支只算、不決定什麼時候算**。什麼時候算在 `server/utils/tag-report.ts`
 *   （按需鈕＋1 小時冷卻＋存檔）。⛔ **不要再開一支「即時算」的端點**——
 *   一趟約一萬次 Firestore 讀取＋約 31 次問 LINE，掛在會自動刷新的地方就是 08-11 讀取費暴衝重演。
 *
 * **成本設計（`D-28` 的關鍵決定，照舊）**：`userTags` **只掃一趟**，意圖人數／最近新增／交集／
 * 新進名單來源／沒標籤的人全部從同一批列在記憶體裡分派出去。推播也只讀一趟，
 * 「誰最近收過推播」直接用推播存的收件名單，不另外查人。
 *
 * 索引：全部用既有的——`userTags`／`tags`／`tagSuggestionLogs` 單一等值；`userTagSuggestions (workspaceId, hasPending)`；
 * `users (workspaceId, createdAt ASC)`（對話統計「新加好友」在用）；`conversations (workspaceId, lastPeerActivityAt DESC)`
 * （對話列表在用，⛔ 範圍查詢一定要 `orderBy(desc)` 才吃得到，不然報缺索引）；`broadcasts (workspaceId, createdAt DESC)`。
 *
 * ⛔ 每一段各自 catch 並回報自己失不失敗：「查不到」跟「真的是零」在畫面上要講不同的話。
 */

import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { listDocs } from '~~/server/utils/firebase'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { fetchFollowerDays } from '~~/server/utils/line-follower-insight'
import { getMarketingEvents } from '~~/server/utils/marketing-events'
import { getMarketingSkips } from '~~/server/utils/marketing-skips'
import { parseStoredLineStats } from '~~/shared/broadcast-line-stats'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import {
  FRIEND_REPORT_VERSION,
  intentTagStats,
  lineFriendStats,
  lineQueryDates,
  newMemberSources,
  pushedUserSets,
  pushRows,
  recentIntentPairs,
  reportWindow,
  type BroadcastLite,
  type FriendReportPayload,
  type LineFriendStats,
  type UserTagTimedRow,
} from '~~/shared/friend-report'
import { pickProposalFestival } from '~~/shared/friend-report-advice'
import { ownEventFestival } from '~~/shared/marketing-events'
import { aggregateSuggestionOutcomes, findTagHealthIssues, memberCountsFromRows, aggregateCoverage, TAG_INSIGHTS_SCAN_LIMIT, TAG_SUGGESTION_LOG_SCAN_LIMIT } from '~~/shared/tag-insights'
import { PENDING_SCAN_LIMIT } from '~~/shared/tag-pending-review'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { taipeiDate } from '~~/shared/time'
import type { AudienceLike } from '~~/shared/broadcast-open-compare'
import type { TagDoc, TagSuggestionEvent, UserTagSourceType } from '~~/shared/types/tag-broadcast'

/** 這 30 天新進名單最多讀幾位（MYFEEL 10-28：1,572；9 月大型問卷那個月是 4,411） */
const NEW_MEMBERS_SCAN_LIMIT = 8000
/** 推播往回讀幾則（照建立時間）；30 天內的推播一定在裡面，多的是給「上一則同一群人」用 */
const BROADCAST_SCAN_LIMIT = 80

export async function computeFriendReport(db: Firestore, workspaceId: string, nowMs = Date.now()): Promise<FriendReportPayload> {
  const failed: string[] = []
  const win = reportWindow(nowMs)
  const lineDates = lineQueryDates(win)
  const startTs = Timestamp.fromMillis(win.startMs)
  const endTs = Timestamp.fromMillis(win.endMs)

  const [tags, userTagScan, totalUsers, suggestionLogs, pendingScan, newUsersScan, activeUsers, broadcastSnap, lineDays, skips, ownEvents] = await Promise.all([
    listDocs<TagDoc>('tags', ref => ref.where('workspaceId', '==', workspaceId))
      .catch((e) => { console.warn('[friend-report] tags failed:', e); failed.push('標籤'); return [] }),

    // 一趟掃描：多讀一筆用來判斷「還有沒有更多」
    db.collection('userTags')
      .where('workspaceId', '==', workspaceId)
      .select('userId', 'tagId', 'sourceType', 'createdAt')
      .limit(TAG_INSIGHTS_SCAN_LIMIT + 1)
      .get()
      .catch((e) => { console.warn('[friend-report] userTags failed:', e); failed.push('貼標紀錄'); return null }),

    db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .count().get()
      .then(s => s.data().count)
      .catch((e) => { console.warn('[friend-report] users count failed:', e); failed.push('名單人數'); return null }),

    db.collection('tagSuggestionLogs')
      .where('workspaceId', '==', workspaceId)
      .select('event')
      .limit(TAG_SUGGESTION_LOG_SCAN_LIMIT + 1)
      .get()
      .catch((e) => { console.warn('[friend-report] suggestion logs failed:', e); failed.push('AI 建議紀錄'); return null }),

    db.collection('userTagSuggestions')
      .where('workspaceId', '==', workspaceId)
      .where('hasPending', '==', true)
      .select('pending')
      .limit(PENDING_SCAN_LIMIT + 1)
      .get()
      .catch((e) => { console.warn('[friend-report] pending failed:', e); failed.push('待審建議'); return null }),

    // 這 30 天第一次進名單的人（跟對話統計「新加好友」同一個母數）
    db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<', endTs)
      .select()
      .limit(NEW_MEMBERS_SCAN_LIMIT + 1)
      .get()
      .catch((e) => { console.warn('[friend-report] new users failed:', e); failed.push('新進名單'); return null }),

    // 最近 30 天有互動（傳訊息、按選單或按鈕）的人——`C-401` 同一個欄位
    db.collection('conversations')
      .where('workspaceId', '==', workspaceId)
      .where('lastPeerActivityAt', '>=', startTs)
      .where('lastPeerActivityAt', '<', endTs)
      .orderBy('lastPeerActivityAt', 'desc')
      .count().get()
      .then(s => s.data().count)
      .catch((e) => { console.warn('[friend-report] active users failed:', e); failed.push('有互動的人數'); return null }),

    db.collection('broadcasts')
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(BROADCAST_SCAN_LIMIT)
      .select('name', 'status', 'completedAt', 'audienceSource.type', 'audienceSource.tagIds', 'audienceSource.audienceId',
        'sentCount', 'lineStats', 'audienceSnapshot.resolvedUserIds', 'proposalTagId')
      .get()
      .catch((e) => { console.warn('[friend-report] broadcasts failed:', e); failed.push('推播'); return null }),

    fetchFollowerDays(workspaceId, lineDates),

    // 收起來的檔期與自己的檔期：查不到就當沒有（只影響提案搭哪一檔，⛔ 不擋整份報告）
    getMarketingSkips(db, workspaceId).catch(() => ({})),
    getMarketingEvents(db, workspaceId).catch(() => []),
  ])

  // ── 一趟掃描的結果 ──────────────────────────────────────────────
  const userTagsTruncated = userTagScan ? userTagScan.size > TAG_INSIGHTS_SCAN_LIMIT : false
  const rows: Array<UserTagTimedRow & { sourceType: UserTagSourceType }> = (userTagScan?.docs ?? [])
    .slice(0, TAG_INSIGHTS_SCAN_LIMIT)
    .map((d) => {
      const v = d.data() as { userId?: string, tagId?: string, sourceType?: UserTagSourceType, createdAt?: unknown }
      return {
        userId: String(v.userId ?? ''),
        tagId: String(v.tagId ?? ''),
        sourceType: v.sourceType!,
        createdAtMs: parseFirestoreDate(v.createdAt)?.getTime() ?? null,
      }
    })
  const memberCounts = memberCountsFromRows(rows)
  // ⛔ 用 code 反查不要寫死 id：「N 天沒互動」那顆是每個工作區各自建的
  const inactiveTagIds = tags.filter(t => t.code === INACTIVE_TAG_CODE).map(t => t.id)
  const tagName = (id: string) => tags.find(t => t.id === id)?.name ?? null

  // ── 推播 ────────────────────────────────────────────────────────
  const lites: BroadcastLite[] = (broadcastSnap?.docs ?? []).map((d) => {
    const v = d.data() as Record<string, any>
    const stats = parseStoredLineStats(v.lineStats)
    return {
      id: d.id,
      name: String(v.name ?? ''),
      status: String(v.status ?? ''),
      completedMs: parseFirestoreDate(v.completedAt)?.getTime() ?? null,
      audienceSource: (v.audienceSource ?? null) as AudienceLike,
      sentCount: Number(v.sentCount) || 0,
      opened: stats?.opened ?? null,
      clicked: stats?.clicked ?? null,
      proposalTagId: typeof v.proposalTagId === 'string' && v.proposalTagId ? v.proposalTagId : null,
      resolvedUserIds: Array.isArray(v.audienceSnapshot?.resolvedUserIds) ? v.audienceSnapshot.resolvedUserIds.map(String) : [],
    }
  })
  // ⛔ 推播讀不到時，「最近有沒有收過推播」要回 null，不可以當成「都沒收過」
  const pushed = broadcastSnap ? pushedUserSets(lites, win) : null
  const intents = intentTagStats(rows, tags, win, pushed)

  // ── LINE ────────────────────────────────────────────────────────
  const line: LineFriendStats = lineDays.status === 'ok'
    ? lineFriendStats(lineDays.byDate, lineDates)
    : { status: lineDays.status, followers: null, followersDelta: null, blocks: null, blocksDelta: null, asOfDate: null, blocksByDay: {} }
  if (line.status === 'failed') failed.push('LINE 好友數')

  // ── 新進名單 ────────────────────────────────────────────────────
  const newMembersTruncated = newUsersScan ? newUsersScan.size > NEW_MEMBERS_SCAN_LIMIT : false
  const newUserIds = new Set((newUsersScan?.docs ?? []).slice(0, NEW_MEMBERS_SCAN_LIMIT).map(d => d.id))

  // ── 標籤整理 ────────────────────────────────────────────────────
  const aiProducedTagIds = new Set(rows.filter(r => r.sourceType === 'ai').map(r => r.tagId))
  const health = findTagHealthIssues(tags, memberCounts, aiProducedTagIds)
  const coverage = aggregateCoverage(rows, totalUsers, { truncated: userTagsTruncated })
  const outcomes = aggregateSuggestionOutcomes((suggestionLogs?.docs ?? [])
    .slice(0, TAG_SUGGESTION_LOG_SCAN_LIMIT)
    .map(d => ({ event: (d.data() as { event?: TagSuggestionEvent }).event! })))

  return {
    version: FRIEND_REPORT_VERSION,
    window: win,
    integrity: {
      failed,
      userTagsTruncated,
      scannedUserTags: rows.length,
      suggestionLogsTruncated: suggestionLogs ? suggestionLogs.size > TAG_SUGGESTION_LOG_SCAN_LIMIT : false,
      pendingTruncated: pendingScan ? pendingScan.size > PENDING_SCAN_LIMIT : false,
      newMembersTruncated,
      /** 這本底帳 2026-08-30 才開始寫——畫面上的同意率一定要標這個起算日 */
      suggestionLedgerSince: '2026-08-30',
    },
    overview: { line, activeUsers, listSize: totalUsers },
    intents,
    intentPairs: recentIntentPairs(rows, intents.map(t => t.tagId), win),
    pushes: broadcastSnap ? pushRows(lites, win, tagName) : null,
    newMembers: {
      total: newUsersScan ? newUserIds.size : null,
      truncated: newMembersTruncated,
      rows: newUsersScan ? newMemberSources(newUserIds, rows, tags, { excludeTagIds: inactiveTagIds }) : [],
    },
    upcomingFestival: pickProposalFestival(
      [...TAIWAN_FESTIVALS, ...ownEvents.map(ownEventFestival)],
      taipeiDate(new Date(nowMs)),
      skips,
    ),
    housekeeping: {
      zeroMember: health.zeroMember.map(t => ({ tagId: t.id, name: tagName(t.id) ?? '(已刪除的標籤)' })),
      aiOnButNeverProduced: health.aiOnButNeverProduced.map(t => ({ tagId: t.id, name: tagName(t.id) ?? '(已刪除的標籤)' })),
      untaggedUsers: coverage.untaggedUsers,
      suggestions: {
        decided: outcomes.decided,
        agreed: outcomes.agreed,
        autoApplied: outcomes.autoApplied,
        acceptanceRate: outcomes.acceptanceRate,
      },
      pendingUsers: Math.min(pendingScan?.size ?? 0, PENDING_SCAN_LIMIT),
    },
  }
}
