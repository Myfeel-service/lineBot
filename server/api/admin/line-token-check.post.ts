import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { fetchLineBotInfo } from '~~/server/utils/line-webhook-remote'

export type LineTokenCheckResponse = {
  /** true＝LINE 認得這把鑰匙；false＝明確不認得；null＝這次問不到（查不到 ≠ 有問題） */
  valid: boolean | null
  /** valid 時回官方帳號名稱，讓使用者自己確認「是不是我要接的那個帳號」 */
  displayName?: string
  basicId?: string
}

/**
 * POST /api/admin/line-token-check —— 存檔前先問 LINE：這把 Channel Access Token 是真的嗎、是誰的？
 *
 * 為什麼要有這支：開通引導原本只擋「字串太短」，所以貼到別家帳號的鑰匙、或已經被重發作廢的舊鑰匙，
 * 都會被說成「收到 ✓ 已經幫你存好」，要到兩步之後的接線檢查才爆——那時使用者已經不會聯想到鑰匙。
 *
 * ⚠️ 三態誠實：LINE 明說不認得才回 false；我們自己連不出去、LINE 忙、5xx 一律回 null（不擋人存檔）。
 * ⚠️ token 只用來打 LINE，不寫 log、不回傳（回傳的只有帳號名稱）。
 */
export default defineEventHandler(async (event): Promise<LineTokenCheckResponse> => {
  await requireWorkspaceAccess(event, 'admin')

  const body = await readBody(event).catch(() => ({})) as Record<string, unknown>
  const token = String(body?.channelAccessToken ?? '').trim()
  if (!token)
    throw createError({ statusCode: 400, statusMessage: '缺少 Channel Access Token' })

  let res: Awaited<ReturnType<typeof fetchLineBotInfo>>
  try {
    res = await fetchLineBotInfo(token)
  }
  catch {
    // 出不去（網路/DNS）：不能說鑰匙是壞的
    return { valid: null }
  }

  if (res.ok)
    return { valid: true, displayName: res.data.displayName, basicId: res.data.basicId }

  // LINE 明確拒絕這把鑰匙才下定論；其餘（429 太頻繁、5xx LINE 自己出事）一律「這次問不到」
  if (res.status === 401 || res.status === 403)
    return { valid: false }
  return { valid: null }
})
