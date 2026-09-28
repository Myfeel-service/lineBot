import { getDb } from '~~/server/utils/firebase'
import { handleFollowEvent } from '~~/server/utils/handler'
import { getLineWorkspaceCredentials } from '~~/server/utils/line-workspace-credentials'
import { verifyLiffAccessToken, warnOnLiffChannelMismatch } from '~~/server/utils/liff-token'

/**
 * POST /api/liff/apply
 *
 * 由 LIFF 前端在顯示成功畫面後，以背景 fetch（keepalive: true）呼叫。
 * 負責執行貼標、模組推播等耗時操作，不阻塞 /api/liff/claim 的回應。
 *
 * 前端使用 keepalive: true，確保頁面跳轉或 LIFF 關閉後請求仍能完成。
 * 若本次呼叫失敗，claim 的 status 仍為 'claimed'，使用者重新點擊活動連結可再次觸發。
 *
 * Body: { accessToken: string, workspaceId: string }
 * userId 由後端向 LINE 驗證 accessToken 取得，不信任 client 自報。
 *
 * 🔴 `G-94`：**一定要真的在這個帳號登記過活動**才往下做。
 * 以前只驗「這是一個真的 LINE 使用者」，而 workspaceId 是 body 帶的——`/api/liff/claim`
 * 會把帳號 id 回給任何參加活動的人，等於公開。任何 LINE 帳號都能把自己塞進任一家的好友名單
 * （`handleFollowEvent` → `ensureUser` 建一位好友、開一場對話），換幾個帳號就能灌一批假好友，
 * 污染名單、統計、「全部好友」推播的對象。
 * 現在要求 `leadClaims` 裡有「這個人、這個帳號、狀態 claimed」的那一筆——那一筆只有
 * `/api/liff/claim` 驗過活動連結之後才寫得出來，而且在回應前就寫好了（claim 回應時一定查得到）。
 * 查詢刻意跟 `applyPendingClaims` 用同一個形狀（lineUserId＋status），⛔ 不另開索引。
 *
 * ⚠️ 擋下來回 403 `{ ok: false }`：前端是丟出去就不管（`.catch(() => {})`），成功畫面在這之前
 * 就已經顯示了，所以真的客人不受影響。follow webhook 先搶到那筆（claimed → applying／applied）
 * 時也會落到這裡——那代表貼標已經在做了，不需要這支再做一次。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const accessToken = String(body?.accessToken || '').trim()
  const workspaceId = String(body?.workspaceId || '').trim()

  if (!accessToken || !workspaceId) {
    throw createError({ statusCode: 400, statusMessage: 'accessToken and workspaceId are required' })
  }

  const verifiedUser = await verifyLiffAccessToken(accessToken)
  const lineUserId = verifiedUser.userId

  const claimed = await getDb().collection('leadClaims')
    .where('lineUserId', '==', lineUserId)
    .where('status', '==', 'claimed')
    .get()
  const hasClaimHere = claimed.docs.some(d => String(d.data()?.workspaceId || '').trim() === workspaceId)
  if (!hasClaimHere) {
    console.warn('[liff/apply] no claimed lead for this user in this workspace, skipped:', lineUserId, workspaceId.slice(0, 64))
    setResponseStatus(event, 403)
    return { ok: false }
  }

  // 觀測用：token 所屬 Login channel 與 workspace LIFF 設定不一致時記 log（不阻擋，同 /api/liff/claim）
  getLineWorkspaceCredentials(workspaceId)
    .then(c => warnOnLiffChannelMismatch(verifiedUser, c.defaultLiffId, 'liff/apply'))
    .catch(() => {})

  try {
    // 驗證時已取得 profile，直接帶入省一次 LINE API round-trip
    await handleFollowEvent(lineUserId, {
      displayName: verifiedUser.displayName || lineUserId,
      pictureUrl: verifiedUser.pictureUrl,
    }, workspaceId)
  }
  catch (e) {
    console.error('[liff/apply] handleFollowEvent failed:', lineUserId, workspaceId, e)
    return { ok: false }
  }

  return { ok: true }
})
