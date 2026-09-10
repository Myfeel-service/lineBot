import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { readLeadPageFailures } from '~~/server/utils/lead-page-failures'

/** 預設看近 7 天：比這更久的數字對「現在要不要去修」沒有幫助 */
const DEFAULT_DAYS = 7
const MAX_DAYS = 30

/**
 * GET /api/campaigns/lead-errors?days=7
 *
 * 活動頁在客人手上失敗了幾次、各是哪一種。活動頁用來回答「客人到底進不進得來」——
 * 後台的 LIFF 登記檢查只查得到「Endpoint URL 有沒有寫對」，其他壞法它一概看不到。
 *
 * 權限比照 `/api/campaigns/list`（viewer 可讀）：看得到活動的人才需要知道活動壞了。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const rawDays = Number(getQuery(event).days ?? DEFAULT_DAYS)
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.trunc(rawDays), 1), MAX_DAYS) : DEFAULT_DAYS
  const sinceMs = Date.now() - days * 86_400_000

  try {
    const res = await readLeadPageFailures(getDb(), workspaceId, sinceMs)
    return { days, since: new Date(sinceMs).toISOString(), ok: true as const, ...res }
  }
  catch (e) {
    // ⛔ 查不到不可以回「0 次」：那正是「查不到＝沒問題」的假綠燈。
    // 回 ok:false 讓畫面顯示「這次查不到」，不下任何結論。
    console.warn('[campaigns/lead-errors] query failed:', String((e as Error)?.message ?? e).slice(0, 160))
    return {
      days,
      since: new Date(sinceMs).toISOString(),
      ok: false as const,
      byReason: null,
      total: 0,
      unknownReasons: [],
      truncated: false,
    }
  }
})
