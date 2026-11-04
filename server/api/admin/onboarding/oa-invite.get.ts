import QRCode from 'qrcode'
import { fetchLineAvatarDataUrl } from '~~/server/utils/line-avatar-data-url'
import { resolveLineOaProfile } from '~~/server/utils/line-oa-basic-id'
import { requireCapability } from '~~/server/utils/workspace-auth'

/**
 * GET /api/admin/onboarding/oa-invite?workspaceId=...
 *
 * 開通引導「等第一則訊息」那一步：回這個官方帳號的**加好友方式**。
 * 2026-11-04 起「好友」頁的邀請卡（`C-458`／`D-169`）也用這支，帶 `?avatar=1` 多拿頭像本體。
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
  /**
   * 官方帳號在 LINE 上的名稱與頭像（`C-250`③）：見證卡用「他待會在手機上看到的樣子」講加哪一個，
   * ⛔ 不用 MiniMe 這邊的店名（兩邊可能不一樣）。查不到為空字串。
   */
  displayName: string
  pictureUrl: string
  /**
   * 頭像轉成的 data URL——只有帶 `?avatar=1` 才給（`C-458` 邀請卡：canvas 畫跨網域的圖會存不出來，
   * 理由見 `line-avatar-data-url.ts`）。⛔ 開通引導那一頁不帶：多抓一張圖只會讓見證卡變慢。
   * 抓不到為空字串（邀請卡改畫店名第一個字）。
   */
  pictureDataUrl?: string
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

/**
 * 頭像 data URL 也記著，鍵是頭像網址（換頭像＝LINE 給新網址，自然失效）。
 * ⛔ 只存抓到的：抓不到（暫時性）存成空字串就變成永久沒頭像。上限壓小：一張頭像幾十 KB。
 */
const avatarCache = new Map<string, string>()
const AVATAR_CACHE_MAX = 100

async function avatarDataUrl(pictureUrl: string): Promise<string> {
  if (!pictureUrl) return ''
  const hit = avatarCache.get(pictureUrl)
  if (hit) return hit
  const dataUrl = await fetchLineAvatarDataUrl(pictureUrl)
  if (dataUrl) {
    if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.clear()
    avatarCache.set(pictureUrl, dataUrl)
  }
  return dataUrl
}

export default defineEventHandler(async (event): Promise<OaInviteResponse> => {
  // 開通引導只有 owner/admin 走得到（agent/viewer 會落在 locked 版面），但這支只讀不寫，
  // 門檻與同資料夾的 first-message 一致
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const wid = String(workspaceId || '').trim()
  if (!wid)
    throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const { basicId, displayName, pictureUrl } = await resolveLineOaProfile(wid)
  if (!basicId)
    return { basicId: '', addFriendUrl: '', qrDataUrl: '', displayName, pictureUrl }

  // 邀請卡（`C-458`）才要頭像本體；開通引導不帶這個參數，照舊不多抓
  const avatar = getQuery(event).avatar === '1'
    ? { pictureDataUrl: await avatarDataUrl(pictureUrl) }
    : {}

  const cached = inviteCache.get(basicId)
  if (cached)
    return { basicId, ...cached, displayName, pictureUrl, ...avatar }

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

  return { basicId, addFriendUrl, qrDataUrl, displayName, pictureUrl, ...avatar }
})
