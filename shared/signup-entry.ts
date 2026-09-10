/**
 * 「免費打造／免費註冊」這條路的唯一來源：入口網址、意圖判定、登入後落點。
 *
 * 為什麼要有這一份（2026-09-10 `D-74` 老闆拍板 A 案）：
 * 門面八顆按鈕原本全是裸 `/login`，登入後系統不知道這個人是**來註冊的**，於是
 * 落到帳號選擇頁先被問「選擇要管理的官方帳號」（他一個都沒有）、再被問一次
 * 「選一個最符合你狀況的方式」三選一——而他按「免費打造」時就已經回答過這題。
 * 帶一個 `?intent=start` 過去，登入頁換成註冊口吻、零帳號的人直接進開通引導。
 *
 * ⚠️ 2026-09-10 `D-77`：`intent` 現在**只影響登入頁的招呼語**，不再影響登入後的落點
 *    （「註冊快車道」被推翻，理由見檔尾那段 ⛔）。
 * ⚠️ 這裡的 `intent` 只是**招呼語**的依據，不是權限：
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
 *   ② 其餘＝帳號選擇頁（零帳號的人在那裡看到三選一的迎賓卡）。
 *
 * ⚠️ `redirect` 只認 `/admin` 開頭是刻意的（沿用 2026-08 原本的判斷，不是這輪新加的）：
 *    `//evil.com` 這種站外網址不以 `/admin` 開頭，攔在這裡。
 *
 * ⚠️ 2026-09-10 `D-77`：這裡**不再把 `?intent=start` 帶去帳號選擇頁**。
 *    原本帶過去是給「註冊快車道」用的（零帳號直接進開通引導），那條路已被推翻（見檔尾）。
 *    ⛔ 別再加回 `?intent=start`：那一頁現在沒有任何東西讀它，帶過去只是一個沒人看的參數。
 */
export function resolveLoginRedirect(query: { redirect?: unknown, intent?: unknown }): string {
  const redirect = query.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/admin')) return redirect
  return '/admin/workspaces'
}

/**
 * ⛔ **「註冊快車道」已整支移除，不要再實作回來**（2026-09-10 `D-77`）。
 *
 * `D-74` 曾經拍板 A 案：從門面「免費打造」按進來、零帳號的人登入後**直接進 `/admin/onboarding`**、
 * 跳過帳號選擇頁那張三選一的迎賓卡，理由是「他按那顆按鈕時就已經回答過這題」。
 * 當時還為它寫了四個防呆條件（清單沒查到不送／已有帳號不送／org admin 不送／超管不送）。
 *
 * 實際跑起來之後**使用者的指示是相反的**：
 * 「第一次登入後應該來到這個畫面（迎賓三選一），**按下開始使用才進入引導教學**」。
 * 原因很實在：第一次登入的人需要先看到自己有哪些路可以走（開始使用／我是被邀請的／
 * 有企業需求），被直接丟進一段聊天引導是沒得選。
 *
 * 所以 `shouldFastLaneToOnboarding()` 連同它的測試一起刪掉了，`workspaces.vue` 也不再讀
 * `?intent=start`。⚠️ **被推翻的只有落點這一半**——`?intent=start` 仍然在用，
 * 登入頁靠它換成註冊口吻（標題／第一步／下一步／不用綁卡），那部分沒有被推翻。
 */
