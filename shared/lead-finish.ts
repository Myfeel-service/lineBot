/**
 * 活動連結綁定完成之後，畫面怎麼收尾（`D-46`，2026-10-20 老闆照建議學 Omnichat）。
 *
 * 以前一律主動用 `oaMessage` 深連結把客人丟回聊天室（`lead.vue`）——從 LINE 外面（官網、廣告、IG）
 * 進來的客人被丟進聊天室時，LINE 會停在「上次讀到的位置」（`F-8`），累積很多未讀的人會卡在中間、
 * 看不到剛傳來的活動訊息。Omnichat 的做法是**外面進來的不主動開聊天室**：結尾停在完成頁，
 * 活動訊息用推播送進聊天室，客人自己點通知——點通知會落在那則新訊息上。
 *
 * 規則：
 *   ① 店家在活動設了「完成後前往」的網址 → 照舊去那裡（那是店家指定的，跟從哪裡進來無關）
 *   ② 從 LINE **外面**進來的 → 停在「綁定完成」頁
 *   ③ 從 LINE **裡面**（聊天室、圖文選單）開的 → 照舊：LIFF 裡開聊天室再關窗／LINE 內建瀏覽器跳聊天室
 *
 * ⚠️ 「從外面進來」怎麼認：外部瀏覽器打開時頁面會先試著用 `line://app/{liffId}` 跳進 LINE App
 *    （`tryOpenInLineAppBeforeInit`），跳過去的那一趟在 LINE 裡看起來就是「LIFF 裡」——
 *    所以跳之前在網址上掛一個記號（`LEAD_FROM_OUTSIDE_PARAM`），LINE 裡那一頁看到記號就知道是外面來的。
 *    另外兩條線索：LIFF 裡、但 LIFF 說這一次**不是從聊天室開的**（`getContext().type` 是 'none'），
 *    或根本不在 LINE 裡（不是 LIFF、也不是 LINE 內建瀏覽器）。
 */

/** 從 LINE 外面跳進 LINE App 時掛在網址上的記號（`from=web`） */
export const LEAD_FROM_OUTSIDE_PARAM = 'from'
export const LEAD_FROM_OUTSIDE_VALUE = 'web'

/** 網址（或被 LIFF 包在 `liff.state` 裡的網址）上有沒有「從外面跳進來」的記號 */
export function hasOutsideMarker(href: string): boolean {
  let url: URL
  try {
    url = new URL(href)
  }
  catch {
    return false
  }
  if (url.searchParams.get(LEAD_FROM_OUTSIDE_PARAM) === LEAD_FROM_OUTSIDE_VALUE) return true
  // LIFF 在 init 前會把原本的路徑與參數包成 `liff.state`（已經解碼過一次的字串，例如 `?ct=…&from=web`）
  const state = url.searchParams.get('liff.state') ?? ''
  if (!state) return false
  const qs = state.includes('?') ? state.slice(state.indexOf('?') + 1) : state
  try {
    return new URLSearchParams(qs).get(LEAD_FROM_OUTSIDE_PARAM) === LEAD_FROM_OUTSIDE_VALUE
  }
  catch {
    return false
  }
}

/**
 * 外部瀏覽器要跳進 LINE App 時用的深連結：照搬現在網址上的參數，再掛上「從外面來的」記號。
 * ⛔ 記號只在這條路上掛：在 LINE 裡面開的那一趟沒有它，收尾照舊開聊天室。
 */
export function buildLineAppDeepLink(currentHref: string, liffId: string): string {
  if (!liffId) return ''
  let current: URL
  try {
    current = new URL(currentHref)
  }
  catch {
    return ''
  }
  const deepLink = new URL(`line://app/${liffId}`)
  current.searchParams.forEach((value, key) => deepLink.searchParams.set(key, value))
  deepLink.searchParams.set(LEAD_FROM_OUTSIDE_PARAM, LEAD_FROM_OUTSIDE_VALUE)
  return deepLink.toString()
}

export interface LeadOriginSignals {
  /** 目前網址（init 之後，LIFF 已經把 liff.state 還原回來） */
  href: string
  /** `liff.getContext()?.type`：'utou'／'group'／'room'／'square_chat'＝從聊天室開的；'none'＝LIFF 但不是從聊天室；'external'＝不在 LIFF */
  contextType?: string | null
  /** `liff.isInClient()` */
  isInClient: boolean
  /** User-Agent 帶 `Line/`（LINE 內建瀏覽器，不一定是 LIFF） */
  isLineUserAgent: boolean
}

/**
 * 這一趟是不是從 LINE 外面進來的（理由見檔頭）。
 * ⚠️ 只認 'none' 不認 'external'：'external' 就是「不在 LIFF 裡」，LINE 內建瀏覽器（從聊天室點開、
 *    但不是 LIFF 容器）也是 'external'——那是**裡面**，照舊用網址跳聊天室；真正的外部瀏覽器由最後一條認。
 */
export function leadOpenedOutsideLine(s: LeadOriginSignals): boolean {
  if (hasOutsideMarker(s.href)) return true
  if (s.isInClient && s.contextType === 'none') return true
  return !s.isInClient && !s.isLineUserAgent
}

export type LeadFinish =
  /** 去店家設的「完成後前往」網址 */
  | 'redirect'
  /** 停在「綁定完成」頁（外面進來的；或在 LINE 外也沒地方可跳） */
  | 'stay'
  /** LIFF 裡：開聊天室、再關窗（照舊） */
  | 'open-chat-and-close'
  /** LINE 內建瀏覽器但不是 LIFF：用網址跳聊天室（照舊） */
  | 'go-chat-by-location'

export function decideLeadFinish(o: LeadOriginSignals & { redirectUrl?: string | null }): LeadFinish {
  if (String(o.redirectUrl ?? '').trim()) return 'redirect'
  if (leadOpenedOutsideLine(o)) return 'stay'
  if (o.isInClient) return 'open-chat-and-close'
  if (o.isLineUserAgent) return 'go-chat-by-location'
  return 'stay'
}

/**
 * 「綁定完成」底下那一句（客人看的）。⛔ 不寫「貼標」這種後台的詞，也不承諾一則不會來的訊息：
 * 活動沒設要傳的內容（`sendsMessage` false）就不講「訊息會傳到 LINE」。
 * `sendsMessage` 讀不到（舊版後端沒回）＝照「會傳」講（以前那一句本來就這樣講）。
 */
export function leadDoneHint(o: { needAddFriend: boolean, sendsMessage?: boolean | null }): string {
  const sends = o.sendsMessage !== false
  if (o.needAddFriend)
    return sends
      ? '加入官方帳號為好友後，活動就會登記完成，活動訊息也會傳到你的 LINE。'
      : '加入官方帳號為好友後，活動就會登記完成。'
  return sends
    ? '活動訊息會傳到你的 LINE，收到通知時點開就能看到。'
    : '可以關掉這個頁面了。'
}
