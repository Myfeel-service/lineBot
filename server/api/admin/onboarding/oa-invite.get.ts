import QRCode from 'qrcode'
import { resolveLineOaBasicId } from '~~/server/utils/line-oa-basic-id'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * GET /api/admin/onboarding/oa-invite?workspaceId=...
 *
 * 開通引導「等第一則訊息」那一步專用：回這個官方帳號的**加好友方式**。
 *
 * 為什麼要有這支（2026-08-28 老闆拍板）：那一步只說「拿手機加你的官方帳號好友」，
 * **沒說去哪加**——剛開通的帳號零好友，新手根本不知道要在 LINE 搜什麼。
 * 排障文案裡的原因③「手機加好友加到別的帳號」就是從這裡長出來的。
 *
 * 資料哪裡來：`resolveLineOaBasicId` 拿已經存好的 Channel Access Token 去問 LINE
 * `/v2/bot/info`（有 24 小時快取）。所以這支只有在**鑰匙已經貼好之後**才拿得到東西——
 * 剛好就是這一步的前提。
 *
 * ⛔ 查不到就回 `basicId: ''`，讓前端**退回原本的純文字說法**，不要生一張半殘的卡：
 *    「查不到」跟「沒有」是兩件事，畫一個空 QR 比不畫更糟。
 */

interface OaInviteResponse {
  /** 例：@abc123；查不到時為空字串 */
  basicId: string
  /** LINE 官方的加好友連結（手機點了直接開 LINE）；basicId 查不到時為空字串 */
  addFriendUrl: string
  /**
   * 加好友連結的 QR，PNG data URL。
   * ⛔ 刻意不回 SVG 字串：那樣前端得用 v-html 才畫得出來，為了一張條碼開一個 HTML 注入面
   *    不划算；PNG data URL 用一般的 <img> 就好。
   */
  qrDataUrl: string
}

/**
 * 產好的整包（連結＋QR PNG）記在記憶體裡，鍵是 basicId（2026-08-28 code review 修）。
 *
 * 為什麼：`resolveLineOaBasicId` 已經把「問 LINE」那一半快取 24 小時了，但**貴的那一半
 * 是沒快取的那一半**——每次請求都重新建 QR 矩陣、重新編 PNG，產出一模一樣的字串。
 * 而開通引導的「回去做傳話測試」是個迴圈，每次重進都付一次這個 CPU。
 *
 * 鍵用 basicId 不用 workspaceId：帳號換了 LINE 頻道，basicId 就跟著換，快取自然失效——
 * ⛔用 workspaceId 當鍵的話，換頻道之後會拿到舊帳號的 QR，那是會讓客人加錯帳號的錯。
 * 上限擋住多租戶下無限成長；basicId 只有幾十個字元，整包很小。
 */
const inviteCache = new Map<string, { addFriendUrl: string, qrDataUrl: string }>()
const INVITE_CACHE_MAX = 500

export default defineEventHandler(async (event): Promise<OaInviteResponse> => {
  // 開通引導只有 owner/admin 走得到（agent/viewer 會落在 locked 版面），但這支只讀不寫，
  // 門檻與同資料夾的 first-message 一致
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const wid = String(workspaceId || '').trim()
  if (!wid)
    throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const basicId = await resolveLineOaBasicId(wid)
  if (!basicId)
    return { basicId: '', addFriendUrl: '', qrDataUrl: '' }

  const cached = inviteCache.get(basicId)
  if (cached)
    return { basicId, ...cached }

  const addFriendUrl = `https://line.me/R/ti/p/${encodeURIComponent(basicId)}`

  // QR 產不出來不是致命錯誤——帳號 ID 與連結本身就夠用，別讓一張圖擋掉整張卡
  let qrDataUrl = ''
  try {
    qrDataUrl = await QRCode.toDataURL(addFriendUrl, {
      margin: 1,
      width: 220,
      errorCorrectionLevel: 'M',
      color: { dark: '#303133', light: '#ffffff' },
    })
  }
  catch {
    qrDataUrl = ''
  }

  // ⛔ 只有 QR 真的產出來才存：存下失敗的空字串，等於把一次暫時性失敗變成永久沒有 QR
  if (qrDataUrl) {
    if (inviteCache.size >= INVITE_CACHE_MAX)
      inviteCache.clear() // 粗暴但夠用：這是純衍生資料，清掉最多就是下一次重算一張
    inviteCache.set(basicId, { addFriendUrl, qrDataUrl })
  }

  return { basicId, addFriendUrl, qrDataUrl }
})
