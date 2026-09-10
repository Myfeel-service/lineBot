/**
 * 「免費打造／免費註冊」這條路的唯一來源：入口網址、意圖判定、登入後落點。
 *
 * 為什麼要有這一份（2026-09-10 `D-74` 老闆拍板 A 案）：
 * 門面八顆按鈕原本全是裸 `/login`，登入後系統不知道這個人是**來註冊的**，於是
 * 落到帳號選擇頁先被問「選擇要管理的官方帳號」（他一個都沒有）、再被問一次
 * 「選一個最符合你狀況的方式」三選一——而他按「免費打造」時就已經回答過這題。
 * 帶一個 `?intent=start` 過去，登入頁換成註冊口吻、零帳號的人直接進開通引導。
 *
 * ⚠️ 這裡的 `intent` 只是**招呼語與落點**的依據，不是權限：
 *    帶了 `intent=start` 不會多拿到任何東西，每支 API 在伺服器端照樣各自驗權限。
 * ⛔ 裸 `/login`（導覽列「登入」、書籤、middleware 轉址）**刻意維持中性文案與舊落點**：
 *    那是回訪的客戶與被邀請的成員在走的路，2026-08-05 `8f8de5d` 把登入頁從「邀請制」
 *    改成中性歡迎語＋登入後迎賓分流是刻意的，A 案只是替 CTA 這條路加一條快車道。
 */

/** 網址參數名與值；門面連結與登入頁的判定共用，別在任何一邊寫死字串。 */
export const SIGNUP_INTENT_KEY = 'intent'
export const SIGNUP_INTENT_START = 'start'

/**
 * 註冊入口：門面所有「免費打造我的 MiniMe」／「免費註冊」按鈕都連這一個。
 *
 * ⛔ 別在 `.vue` 裡改寫成字面 `/login?intent=start`——八顆按鈕散在三個檔
 * （`index.vue` 六顆、`SiteLegalPage.vue`、`SiteFooter.vue` 各一顆），
 * 一漏改就會有按鈕悄悄掉回舊的三道確認，而且從畫面上看不出來。
 */
export const SIGNUP_ENTRY_PATH = `/login?${SIGNUP_INTENT_KEY}=${SIGNUP_INTENT_START}`

/**
 * 這個 query 值是不是「我要開始用」。
 *
 * Vue router 的 query 值可能是字串、`null`（`?intent`）或字串陣列（`?intent=a&intent=b`），
 * 所以型別收得比 `string` 寬——判斷失敗一律當成沒帶（回中性文案），不丟例外：
 * 招呼語猜錯的代價是文案，把人擋在門外的代價是客訴。
 */
export function isSignupStartIntent(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.some(v => isSignupStartIntent(v))
  return String(raw ?? '').trim() === SIGNUP_INTENT_START
}

/**
 * 登入成功後要去哪。
 *
 * 優先序（⛔ 不可對調）：
 *   ① `?redirect=/admin/...`＝被 middleware 從某一頁擋下來的人，他有明確目的地，
 *      註冊意圖不可以把他劫走（他可能是點 email 連結進來看某個帳號的）。
 *   ② `?intent=start`＝來註冊的，把意圖**帶過去**給帳號選擇頁（見 shouldFastLaneToOnboarding）。
 *   ③ 其餘＝維持原本的帳號選擇頁。
 *
 * ⚠️ `redirect` 只認 `/admin` 開頭是刻意的（沿用 2026-08 原本的判斷，不是這輪新加的）：
 *    `//evil.com` 這種站外網址不以 `/admin` 開頭，攔在這裡。
 */
export function resolveLoginRedirect(query: { redirect?: unknown, intent?: unknown }): string {
  const redirect = query.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/admin')) return redirect
  return isSignupStartIntent(query.intent)
    ? `/admin/workspaces?${SIGNUP_INTENT_KEY}=${SIGNUP_INTENT_START}`
    : '/admin/workspaces'
}

/**
 * 帳號選擇頁要不要把人直接送進開通引導（跳過三選一的迎賓頁）。
 *
 * 四個條件全中才送，每一條都是擋一種誤送：
 * - `intentIsStart`：他自己按的是「免費打造」。裸 `/login` 進來的人維持迎賓頁。
 * - `listLoaded`：清單**真的查到了**。⛔ 不可省——`loadWorkspaceList` 失敗時
 *   呼叫端的 catch 會把清單設成空陣列，那時「零帳號」是假的（斷網／token 剛過期），
 *   照送就會把一個已經有帳號的人推進「建立新帳號」的劇本（`G-25` 同款教訓：
 *   查不到 ≠ 沒有）。
 * - `groupCount === 0`：跟迎賓頁空狀態**同一個條件**（`groupedWorkspaces.length`，
 *   已含「是 org admin 但底下還沒有帳號」的組）。⛔ 別改用 workspaceList.length：
 *   那會把「組織管理員、底下零帳號」的人也送進自助開通，他要的是在既有組織裡新增。
 *   ⚠️ 被 email 邀請、還沒轉正的成員本來就會出現在清單裡
 *   （`server/api/admin/workspaces/my.get.ts` 讀 `workspaceInvites`），
 *   所以不會落到空狀態、不會被推去自己建帳號。
 * - `!isSuperAdmin`：超管的空狀態畫面上有「超級管理員後台」入口，送走就看不到了。
 */
export function shouldFastLaneToOnboarding(opts: {
  intentIsStart: boolean
  listLoaded: boolean
  groupCount: number
  isSuperAdmin: boolean
}): boolean {
  return opts.intentIsStart
    && opts.listLoaded
    && opts.groupCount === 0
    && !opts.isSuperAdmin
}
