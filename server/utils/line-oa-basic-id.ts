import { $fetch } from 'ofetch'
import { getLineWorkspaceCredentials } from '~~/server/utils/line-workspace-credentials'

// Bot basicId rarely changes — shared in-memory cache (config + claim endpoints)
const cacheByWorkspace = new Map<string, { lineOaBasicId: string; displayName: string; pictureUrl: string; expiresAt: number }>()
const TTL_MS = 24 * 60 * 60 * 1000
/**
 * 問 LINE「你是誰」的逾時。
 * 這支被送訊息熱路徑與開通引導共用，兩邊都禁得起「查不到」但禁不起「一直等」——
 * 拿不到 basicId 的下場只是少一個帳號代號，卡住的下場是整個請求陪葬。
 */
const BOT_INFO_TIMEOUT_MS = 5000

/**
 * 解析官方帳號 Messaging API bot `basicId`（例：@abc123）。失敗或非 OA 環境時回傳空字串。
 */
export async function resolveLineOaBasicId(workspaceId: string): Promise<string> {
  return (await resolveLineOaProfile(workspaceId)).basicId
}

/**
 * 官方帳號在 LINE 上長什麼樣：代號＋名稱＋頭像（`C-250`③ 開帳見證卡「加你的官方帳號為好友」用）。
 * ⭐ 用**他待會在手機上看到的那個名字與頭像**講「加哪一個」——⛔ 不用 MiniMe 這邊的店名，兩邊可能不一樣。
 * 查不到就三格都是空字串（呼叫端退回純文字說法）。跟 basicId 共用同一份 24 小時快取。
 */
export async function resolveLineOaProfile(workspaceId: string): Promise<{ basicId: string, displayName: string, pictureUrl: string }> {
  const empty = { basicId: '', displayName: '', pictureUrl: '' }
  const wid = String(workspaceId || '').trim()
  if (!wid) return empty

  const hit = cacheByWorkspace.get(wid)
  if (hit && hit.expiresAt > Date.now())
    return { basicId: hit.lineOaBasicId, displayName: hit.displayName, pictureUrl: hit.pictureUrl }

  const { channelAccessToken } = await getLineWorkspaceCredentials(wid)
  if (!channelAccessToken)
    return empty

  try {
    const botInfo = await $fetch<{ basicId?: string, displayName?: string, pictureUrl?: string }>(
      'https://api.line.me/v2/bot/info',
      {
        headers: { Authorization: `Bearer ${channelAccessToken}` },
        // ⛔ 一定要有逾時（2026-08-28 code review 修）：這支沒逾時的話，LINE 慢或不回應時
        //    整個 Lambda 就卡在這裡直到平台逾時、白佔一個併發額度。呼叫端全部都把失敗
        //    當成「查不到」處理（回空字串），所以早點放棄比一直等有用。
        timeout: BOT_INFO_TIMEOUT_MS,
      },
    )
    const lineOaBasicId = String(botInfo?.basicId || '').trim()
    const displayName = String(botInfo?.displayName || '').trim()
    const pictureUrl = String(botInfo?.pictureUrl || '').trim()
    cacheByWorkspace.set(wid, { lineOaBasicId, displayName, pictureUrl, expiresAt: Date.now() + TTL_MS })
    return { basicId: lineOaBasicId, displayName, pictureUrl }
  }
  catch {
    return empty
  }
}
