/**
 * 「提醒文字」＝客人手機跳出的通知、聊天列表那一行會看到的字（LINE 的 altText）。
 * **單一事實來源**：上限、沒填時補的字、哪幾種模組有這一格，都只在這裡寫一次。
 *
 * `C-469`（2026-11-05，老闆問「提醒文字是否可以單獨拉出來」）之前的狀況：同一件事五種做法——
 *   ① 圖文訊息：必填、不能插變數、錯誤訊息還寫著英文「（Alt Text）」
 *   ② 卡片訊息／輪播／圖片輪播：選填、可以插變數，沒填各自補一個字串
 *   ③ 文字＋圖、文字＋按鈕（都會送成一張卡）：**後台根本沒有這一格**，店家改不了
 *   ④ 上限 400 在前端與送出端各寫死一次，沒填補的字也在兩邊各寫一份
 * ⛔ 別再在別處寫死 400，也別自己寫一份「沒填就用這個字」。
 *
 * ⚠️ **填了會多一個副作用**：這行字同時是**對話紀錄**那一行（`handler.ts` 的 `toConversationText`：
 *    Flex／按鈕範本的紀錄存的就是 altText），後台對話頁的摘要、AI 讀到的脈絡都是它。
 *    所以它要寫成「這則在講什麼」，⛔ 不要寫成像客人在問話的句子——AI 會把它當客人說的話
 *    （`C-398` code review 第 1 條就是為了這個，才不准拿卡片標題當預設）。
 *
 * **LINE 沒有給每種訊息這一行字**（2026-11-05 查證過兩次，老闆問「真的做不到嗎」）：
 *   ① 官方 SDK `@line/bot-sdk` 的型別（LINE 自己的 OpenAPI 規格產生的）：共通屬性 `MessageBase`
 *      只有 `type`／`quickReply`／`sender` 三個，**沒有 altText**；`altText` 只出現在
 *      `flexMessage`／`imagemapMessage`／`templateMessage` 三種上，而且是必填。
 *      text／image／video／audio／sticker／location 全都沒有。
 *   ② 拿 LINE 的 `validate/push` 端點實測：`{type:'text', altText:'…'}` 這種**不會被退**——
 *      ⛔ 但那是「未知屬性被忽略」，不是支援；Flex 少了 altText 才會當場退
 *      （`messages[0].altText May not be empty`），可見它只認得那三種上的 altText。
 *   ③ `sender`（name／iconUrl）能改的是通知列上「誰傳的」那半邊，不是內容。
 *
 * ⭐ **繞得過去，但要換一種訊息**：把那則改送成卡片（Flex）就有這行字了——
 *   文字＋圖／文字＋按鈕正是這樣做的（`C-416`／`C-397`）；只有一張圖的 Flex 卡、Flex 裡放影片
 *   格式上也都過得了 LINE 的檢查（同上實測）。代價是客人看到的東西會變
 *   （圖片訊息點下去會開全螢幕大圖、可以存；Flex 卡裡的圖只會執行你設的動作），
 *   ⚠️ 代價的細節沒在真手機上量過，要改之前先驗。
 *
 * `flowMessageHasAltText()` 就是這條線：**照現在的送法**有沒有這一行字可以設。
 */

/** LINE altText 的上限（Flex／imagemap／按鈕範本都是這個數） */
export const LINE_ALT_TEXT_MAX = 400

/**
 * 沒填提醒文字時，客人通知列會看到的字。
 * ⛔ 改這裡等於改客人手機上看到的字，前端的 placeholder（「沒填的話會顯示…」）也是讀這份，
 *    所以改完兩邊一定一致；分成兩份就會變成「後台說會顯示 A、實際送出 B」。
 */
export const ALT_TEXT_FALLBACK: Record<string, string> = {
  richMessage: '圖文訊息',
  carousel: '輪播訊息',
  imageCarousel: '圖片輪播',
  flexImageCarousel: '卡片訊息',
  /** 文字＋圖／文字＋按鈕：內文、標題都空白才會走到（正常是拿內文當通知文字） */
  text: '卡片訊息',
}

/** 這種模組沒填時會補的字；沒有對照的（理論上不會走到）回「訊息」 */
export function altTextFallbackFor(type: unknown): string {
  return ALT_TEXT_FALLBACK[String(type || '')] || '訊息'
}

/**
 * 這一則模組送出去之後，店家有沒有「提醒文字」可以設。
 *
 * 文字模組要看狀態：**加了圖或加了按鈕才會送成一張卡**（`C-416`／`C-397`），卡片才有這一行字；
 * 什麼都沒加的純文字送的是 LINE 文字訊息，通知列顯示的就是店家寫的那段字，沒有可以另外設定的餘地。
 */
export function flowMessageHasAltText(msg: { type?: unknown, imageUrl?: unknown, buttons?: unknown } | null | undefined): boolean {
  const type = String(msg?.type || '')
  if (type === 'richMessage' || type === 'carousel' || type === 'imageCarousel' || type === 'flexImageCarousel') return true
  if (type !== 'text') return false
  return String(msg?.imageUrl ?? '').trim().length > 0 || (Array.isArray(msg?.buttons) && msg.buttons.length > 0)
}
