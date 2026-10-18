/**
 * 「這個商品什麼時候出貨／寄出／到貨」——純粹問出貨時程的題目（`C-343`）。
 *
 * 為什麼要單獨認出來：預購／募資商品的出貨時程是**整批共用**的（「10 月底依訂單順序陸續出貨」），
 * 客人報了自己的訂單編號，真人查完回的也是同一句。以前這種題要嘛被「查詢訂單」流程（關鍵字「訂單」）
 * 攔去問編號再轉真人，要嘛被判成「查他那一筆」答完照樣轉真人——2026-10-09 雙十連假，
 * 客人為了一句知識庫早就有的話，收到「非客服服務時間」然後等好幾天。
 *
 * 認出來之後兩處用它（都還要再加上「只認得出一個商品」，見 isSingleProductContext）：
 *   - handler 的 shipTimingGoesToAi：不進流程，直接交給 AI
 *   - answerWithAi 的 shipTimingAnswer：判成「查他那一筆」也照一般答題收尾、不強制轉真人
 *
 * ⛔ 方向單向：漏收＝照舊（進流程或轉真人）；誤收＝客人拿到這個商品的一般時程，旁邊附「找真人」按鈕。
 *    加詞前想清楚加在哪一組：SHIP_DELAY_RE／ORDER_CHANGE_RE 加多了只是回到修正前的樣子，
 *    SHIP_VERB_RE／SHIP_WHEN_RE 加多了才會讓不該自己答的題被 AI 答掉。
 */

/** 出貨類動詞 */
const SHIP_VERB_RE = /出貨|寄出|寄貨|寄送|發貨|到貨|送達|送到|收到/
/** 時間類問法。「出貨進度」刻意不算——那可能是在問「寄了沒」，那要查他那一筆 */
const SHIP_WHEN_RE = /什麼時候|甚麼時候|何時|幾時|哪時|多久|幾天|幾號|日期|時間|大約|大概|預計/
/**
 * 延遲／抱怨／查無：這一筆可能出了狀況（過了公告的日子、說好的沒做到、帳號裡找不到），要人去查。
 * 「找不到／查不到／沒有通知」是 2026-10-18 拿正式站 34 句出貨題對過補的：
 * 「要查商品何時出貨，可是竟然找不到購買紀錄？」「沒有通知出貨，只有銀行有付款」——問的是時程，要的是人。
 */
const SHIP_DELAY_RE = /還沒|還未|尚未|仍未|至今|迄今|怎麼還|為什麼還|為何還|已經過|過了|超過|延遲|延誤|延後|等了|等很久|太久|不是說|明明|沒收到|沒有收到|未收到|沒出貨|沒有出貨|沒寄|沒有寄|改成|變成|到底|找不到|查不到|沒有通知|沒通知|沒收到通知/
/** 同一句還要改單／取消／退貨：那件事要走它自己的流程（收編號給真人處理） */
const ORDER_CHANGE_RE = /取消|退貨|退款|退費|退刷|換貨|地址|備註|發票|修改|更改|合併|拆單/

/**
 * 有在問出貨／到貨的時間（不管是單純問、還是在抱怨「怎麼還沒出貨」）——`C-344`。
 * 用來判斷「答案一定跟是哪個商品有關」：認不出商品時不可以挑一台的出貨時程答。
 * 比 isShipTimingQuestion 寬：那支是「可以放心自己答完」，這支只是「在問時間」。
 */
export function asksShipTiming(text: string): boolean {
  const t = String(text || '')
  return SHIP_VERB_RE.test(t) && SHIP_WHEN_RE.test(t)
}

export function isShipTimingQuestion(text: string): boolean {
  const t = String(text || '')
  return SHIP_VERB_RE.test(t) && SHIP_WHEN_RE.test(t) && !SHIP_DELAY_RE.test(t) && !ORDER_CHANGE_RE.test(t)
}

/**
 * 這段對話**只**在談一個商品——出貨時程題的另一道門檻（繞過流程、答完不轉真人用同一把尺）。
 * 收的是產品鎖算出來的「目前在談的商品」（server 的 activeProductsInContext）。
 * 2026-10-18 拿正式站 34 句出貨題對過：「咖啡機何時出貨」對到小滑手和 SHARP iBarista 兩台、
 * 前文提過三台 SHARP 的也有——出貨日各不相同，答哪一台都可能是錯的，照舊走流程／轉真人。
 */
export function isSingleProductContext(ctx: { products: ReadonlySet<string> } | null | undefined): boolean {
  return !!ctx && ctx.products.size === 1
}
