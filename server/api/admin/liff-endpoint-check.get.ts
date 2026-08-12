import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { collectLiffEndpointChecks } from '~~/server/utils/liff-endpoint-remote'
import type { LiffEndpointCheckItem } from '~~/server/utils/liff-endpoint-remote'
import { leadEndpointUrl } from '~~/shared/liff-lead-path'

/**
 * GET /api/admin/liff-endpoint-check?workspaceId=...
 *
 * 檢查這個工作區用到的每個 LIFF（預設＋活動指定）在 LINE 登記的 Endpoint URL
 * 是不是這套系統的活動頁。設定頁「LIFF（活動頁）」區塊的登記狀態面板用；
 * 訊號口徑與小幫手的 liffEndpointBroken／liffEndpointUrlMismatch 同一份
 * （probe 本體在 server/utils/liff-endpoint-remote.ts）。
 *
 * ?force=1：使用者剛去 LINE 後台改完回頭確認——要跳過 5 分鐘快取真的再查一次，
 * 否則會一直拿到修好前的答案。查的是 LINE 的公開轉址頁（免費 GET），沒有次數上限問題。
 */
export default defineEventHandler(async (event): Promise<{
  workspaceId: string
  /** 應該登記的網址（正式網址＋活動頁路徑）；後端沒設定正式網址時為空字串 */
  expectedUrl: string
  checks: LiffEndpointCheckItem[]
}> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const wid = String(workspaceId || '').trim()
  if (!wid) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const canonicalBase = String(useRuntimeConfig(event).appBaseUrl || '').trim().replace(/\/$/, '')
  const force = String(getQuery(event).force ?? '') === '1'

  const checks = await collectLiffEndpointChecks(getDb(), wid, {
    canonicalBase,
    skipCache: force,
  })

  return {
    workspaceId: wid,
    expectedUrl: leadEndpointUrl(canonicalBase),
    checks,
  }
})
