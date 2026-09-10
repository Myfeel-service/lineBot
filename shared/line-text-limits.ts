/**
 * LINE 訊息文字長度上限：**單一事實來源**。
 *
 * ⛔ 為什麼要獨立成一支檔案：文字訊息一旦掛上按鈕，就必須改用 LINE 的 buttons template
 * 送，而那個格式的文字上限是 **160 字**（純文字訊息是 5000 字）。送出端本來就在切，
 * 但編輯器、存檔驗證、右側預覽三邊各自寫死不同的數字（或根本沒檢查），結果是：
 *
 *   1. 先把長文貼好、之後才加按鈕 → 編輯器的上限形同虛設（舊值不會被裁）
 *   2. 存檔前後端都只驗按鈕欄位有沒有填完，**一行字數檢查都沒有**
 *   3. 右側預覽原封顯示全文 → 預覽在說謊，看起來好好的，客人收到半截
 *
 * 2026-09-10 實際發生（`H-27`）：正式資料有 5 則模組處於會被截斷的狀態且都已發送過，
 * 最嚴重的一則整段抽獎規則沒送出去（含「留言別寫『抽獎』否則喪失資格」）。
 *
 * ⛔ 別再在別處寫死 160／5000，也別自己寫 `.slice()`——預覽跟送出必須切在同一格，
 * 不然就是換個地方繼續說謊。要切一律走 `truncateLineText()`／`measureLineText()`。
 */

/** 純文字訊息（TextMessage）的上限 */
export const LINE_TEXT_MESSAGE_MAX = 5000

/**
 * 按鈕範本（buttons template）文字的上限。
 * ⚠️ LINE 的規格是「沒有標題與縮圖時 160 字，有的話 60 字」；我們的組裝端
 * （`buildLineMessages`）從不帶 title／thumbnail，所以恆為 160。
 */
export const LINE_BUTTONS_TEMPLATE_TEXT_MAX = 160

/** 這則文字訊息實際適用的上限：掛了按鈕就是 160，否則 5000 */
export function lineTextLimit(hasButtons: boolean): number {
  return hasButtons ? LINE_BUTTONS_TEMPLATE_TEXT_MAX : LINE_TEXT_MESSAGE_MAX
}

/** `msg.buttons` 有沒有真的掛按鈕（空陣列不算） */
export function messageHasButtons(msg: { buttons?: unknown } | null | undefined): boolean {
  return Array.isArray(msg?.buttons) && msg.buttons.length > 0
}

/**
 * 該切在第幾格。
 * ⚠️ 上限是以 UTF-16 計（跟 `String.length`／`slice` 同一把尺，emoji 佔 2 格），
 * 但**不能把代理對切成一半**——切一半會變成一個亂碼字元。落在高位代理就退一格。
 */
function cutIndex(text: string, limit: number): number {
  if (text.length <= limit) return text.length
  const code = text.charCodeAt(limit - 1)
  const isHighSurrogate = code >= 0xD800 && code <= 0xDBFF
  return isHighSurrogate ? limit - 1 : limit
}

/** 照 LINE 的上限截斷（送出端與預覽端共用同一份，兩邊才會切在同一格） */
export function truncateLineText(text: string, limit: number): string {
  const s = String(text ?? '')
  return s.length <= limit ? s : s.slice(0, cutIndex(s, limit))
}

export type LineTextMeasure = {
  /** 這則適用的上限 */
  limit: number
  /** 目前字數（UTF-16，與上限同一把尺） */
  length: number
  /** 超出幾字；沒超出為 0 */
  overflow: number
  /** 送出時會不會被切 */
  willTruncate: boolean
  /** 客人看得到的部分 */
  kept: string
  /** 會被丟掉的部分（要拿去給人看，不要只寫 log） */
  dropped: string
}

/** 量一則文字訊息：現在幾字、上限幾字、會被丟掉哪一段 */
export function measureLineText(text: string, hasButtons: boolean): LineTextMeasure {
  const s = String(text ?? '')
  const limit = lineTextLimit(hasButtons)
  const cut = cutIndex(s, limit)
  return {
    limit,
    length: s.length,
    overflow: Math.max(0, s.length - limit),
    willTruncate: s.length > limit,
    kept: s.slice(0, cut),
    dropped: s.slice(cut),
  }
}

/**
 * 存檔被擋下來時給人看的那句話。前後端共用同一份，
 * 免得「後台說一種、伺服器說另一種」。
 */
export function lineTextOverflowMessage(measure: LineTextMeasure, prefix = '文字模組'): string {
  if (measure.limit === LINE_BUTTONS_TEMPLATE_TEXT_MAX) {
    return `${prefix}：文字底下有按鈕時，LINE 最多只收 ${measure.limit} 字（目前 ${measure.length} 字，請刪掉 ${measure.overflow} 字）。超過的部分客人收不到。若要寫長文，請把按鈕移除，純文字最多 ${LINE_TEXT_MESSAGE_MAX} 字。`
  }
  return `${prefix}：文字最多 ${measure.limit} 字（目前 ${measure.length} 字，請刪掉 ${measure.overflow} 字）。超過的部分客人收不到。`
}
