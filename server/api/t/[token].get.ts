import { verifyUriTagToken } from '~~/server/utils/line-action-tag-token'
import { addTagsToUser } from '~~/server/utils/tagging'
import { listWorkspaceLineCredentials } from '~~/server/utils/line-workspace-credentials'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

/**
 * GET /api/t/:token
 * 點擊 URI 後先套用貼標，再 302 到原目標網址。
 *
 * `C-322`：連結過期（14 天）但簽章對得上＝目標網址是我們放的，**照樣帶去原網址、只是不貼標**。
 * ⛔ 以前過期回首頁：推播一人一則送之後這種連結會在聊天紀錄裡躺很久，兩週後按鈕就壞掉。
 */
export default defineEventHandler(async (event) => {
  const token = String(getRouterParam(event, 'token') || '')
  if (!token) return sendRedirect(event, '/', 302)

  const candidates = await listWorkspaceLineCredentials()
  let parsed: { targetUrl: string; userId: string; tagIds: string[]; expired: boolean } | null = null
  let matchedWorkspaceId = ''
  for (const row of candidates) {
    const secret = String(row.credentials.channelSecret || '').trim()
    if (!secret) continue
    const verified = verifyUriTagToken(token, secret, { allowExpired: true })
    if (verified) {
      parsed = verified
      matchedWorkspaceId = row.workspaceId
      break
    }
  }
  if (!parsed) return sendRedirect(event, '/', 302)

  try {
    if (parsed.tagIds.length > 0 && !parsed.expired) {
      await addTagsToUser(
        lineUserFirestoreDocId(parsed.userId, matchedWorkspaceId),
        parsed.tagIds,
        'system',
        'uri-click',
        matchedWorkspaceId,
      )
    }
  }
  catch (e) {
    console.error('[uri-tag] failed to apply tags:', e)
  }

  return sendRedirect(event, parsed.targetUrl, 302)
})

