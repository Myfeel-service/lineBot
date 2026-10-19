import { listDocs } from '~~/server/utils/firebase'
import { paginateInMemoryList } from '~~/server/utils/paginated-collection-list'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { workspaceBroadcastTier } from '~~/server/utils/broadcast-plan-gate'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'

/**
 * GET /api/broadcast/list
 * Query: ?status=draft|scheduled|completed|...
 * Query: page, limit（有帶則回傳 { items, total, page, limit, hasMore }）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')

  const query = getQuery(event)

  /**
   * `planOnly=1`：**只問推播等級**（`C-352`①）——好友頁、好友統計、首頁檔期卡、活動精靈要在入口就講方案限制，
   * 它們只需要這一格。⛔ 排在讀清單之前：清單是整個推播集合，為了一個等級把每一則都讀一遍是白付讀取費。
   * 跟 `withPlan` 同一個規矩：只回等級、不回方案名（`G-103`）；null＝讀不到訂閱（畫面不鎖，推播頁與送出端照擋）。
   */
  if (query.planOnly) {
    return { broadcastTier: await workspaceBroadcastTier(workspaceId) }
  }

  const statusFilter = query.status as string | undefined

  const broadcasts = await listDocs<BroadcastDoc>('broadcasts', ref =>
    ref.where('workspaceId', '==', workspaceId).orderBy('createdAt', 'desc'),
  )

  const filtered = statusFilter
    ? broadcasts.filter(b => b.status === statusFilter)
    : broadcasts

  /**
   * ⛔ `sentContent`（`C-246` 存的「當時真的送出去的那幾則」）**不跟著清單回**：
   * 它含圖文訊息的整份設定，一則好幾 KB，而清單一次回幾十則、背景還會定時刷新。
   * 要看那一份的只有「點開某一則」那個當下，去 `GET /api/broadcast/:id` 拿就好
   * （同 `messages` 當初被拿掉的理由，見 `docs/ADMIN-PERF-AUDIT-20260827.md`）。
   */
  const rows = filtered.map(({ audienceSnapshot, messages, sentContent, ...rest }) => ({
    ...rest,
    audienceSnapshot: {
      estimatedCount: audienceSnapshot?.estimatedCount ?? 0,
      filter: audienceSnapshot?.filter ?? null,
    },
    messageCount: Array.isArray(messages) ? messages.length : 0,
  }))

  const result = paginateInMemoryList(rows, query)

  /**
   * `withPlan=1`（要配分頁參數）：順便回這個帳號的推播等級（`D-131`）——推播頁拿它先把選不到的發送對象鎖起來，
   * 不要等按了送出才失敗。放在推播自己的端點而不是方案摘要：客服（agent）也會發推播、也要知道哪些選不了，
   * 而方案摘要要管理員權限。⛔ 只回等級、不回方案名（方案名屬計費資訊，`G-103`）。null＝讀不到訂閱（畫面不鎖，送出端照擋）。
   */
  if (query.withPlan && !Array.isArray(result)) {
    return { ...result, broadcastTier: await workspaceBroadcastTier(workspaceId) }
  }
  return result
})
