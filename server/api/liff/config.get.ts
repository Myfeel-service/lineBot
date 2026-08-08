import { findWorkspacesByLiffChannelId, getLineWorkspaceCredentials } from '~~/server/utils/line-workspace-credentials'
import { resolveLineOaBasicId } from '~~/server/utils/line-oa-basic-id'
import { liffChannelIdFromLiffId } from '~~/server/utils/liff-token'

/**
 * 活動 LIFF 頁的公開設定（liffId／OA basicId）。兩種指定租戶的方式：
 *
 * - `workspaceId`：後台頁面用（`useWorkspaceApiFetch` 的 GET 會自動帶上）。
 * - `liffClientId`：LIFF 進入頁用。LINE 在外部瀏覽器登入後，callback 網址只剩
 *   code/state/liffClientId，原本帶的 liffId 會不見；liffId 格式是
 *   `{loginChannelId}-{suffix}`，而 liffClientId 就是前半段，可用來反查是哪個租戶、
 *   把 liffId 補回來讓 `liff.init()` 跑得起來（init 成功後 LIFF 會自己把原網址還原）。
 *
 * ⛔ 兩個租戶共用同一個 Login channel 時前綴會撞號，這種情況一律回空、不猜租戶：
 * 猜錯會讓客人去別的 Login channel 登入，拿到別的 provider scope 下的 userId，
 * 貼標就貼到一個不存在的人身上。也因此這裡不接受「預設租戶」的退路。
 */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const workspaceId = String(q.workspaceId || '').trim()
  const liffClientId = String(q.liffClientId || '').trim()

  let resolvedWorkspaceId = ''
  let liffId = ''

  if (workspaceId) {
    resolvedWorkspaceId = workspaceId
    liffId = (await getLineWorkspaceCredentials(workspaceId)).defaultLiffId
  }
  else if (/^\d+$/.test(liffClientId)) {
    // 前綴範圍查詢最多讀 2 筆（見 findWorkspacesByLiffChannelId）；再用同一支解析函式復核，
    // 免得「前綴相同但格式不是 {id}-{suffix}」的資料被當成命中
    const matches = (await findWorkspacesByLiffChannelId(liffClientId))
      .filter(r => liffChannelIdFromLiffId(r.credentials.defaultLiffId) === liffClientId)
    const only = matches.length === 1 ? matches[0] : undefined
    if (only) {
      resolvedWorkspaceId = only.workspaceId
      liffId = only.credentials.defaultLiffId
    }
    else if (matches.length > 1) {
      console.warn(
        '[liff/config] liffClientId matches multiple workspaces, refusing to guess:',
        liffClientId,
        matches.map(m => m.workspaceId),
      )
    }
  }

  // 認不出租戶：回空值且不設快取標頭，避免把「查不到」快取五分鐘
  if (!resolvedWorkspaceId) return { liffId: '', lineOaBasicId: '' }

  let lineOaBasicId = ''
  try {
    lineOaBasicId = await resolveLineOaBasicId(resolvedWorkspaceId)
  }
  catch {
    // non-critical — LIFF page degrades gracefully without add-friend link
  }

  // Allow browser and CDN to cache this response for 5 minutes
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')

  return { liffId, lineOaBasicId }
})
