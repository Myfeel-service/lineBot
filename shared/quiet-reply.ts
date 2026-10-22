/**
 * AI 可能決定「這句不回」的兩種字（`C-350`，2026-10-19 正式站 12:44：客人打「g. 2l4」和「好的」，AI 兩次回「乾淨方MAX 產地是中國」）。
 *
 * 判斷本體原本寫在 server/utils/ai-answer.ts，2026-10-19 搬來這裡（內容一字未改）：handler 在叫 AI 之前就要用它
 * 決定**要不要先亮「輸入中…」**——AI 最後不回的那種，亮了點點又消失，客人會以為有人要回他。
 * 搬到 shared 是因為 handler 的測試把整個 ai-answer 換成假的，從那裡拿不到這兩支。
 *
 * ⚠️ 這兩支只是「字長得像」；AI 真的不回還要再看前文（是不是在回答客服剛問的問題）、這句查不查得到知識，
 *    在 answerWithAi 裡判斷（skipQuietly）。
 */

/**
 * 「好的」「收到」「OK」這種純回應（不是問題、也不是道謝）。只看字面、刻意收得很緊：
 * 帶問號（「OK?」可能是在問可不可以）、帶任何其他字（「好的那運費呢」）都不算。
 * 「謝謝」不在這裡——那是道謝，照舊回「不客氣」（老闆拍板：招呼語照舊計入則數）。
 */
const ACK_WORD = '好的?|好喔|好哦|好唷|好滴|好啊|好呀|好der|ok|okay|okok|okie|收到|了解|瞭解|知道了?|明白了?|懂了|沒問題|可以|行|嗯+|恩+|yes|yep'
const ACK_RE = new RegExp(`^(?:${ACK_WORD})+(?:了|啦|囉|喔|哦|唷|耶|欸|呦)?$`, 'i')
/** 只傳這幾個表情也算回應（讚、OK 手勢） */
const ACK_EMOJI_RE = /[👍👌🆗]/u

export function isAcknowledgementOnly(text: string): boolean {
  const t = String(text || '').trim()
  if (!t || /[?？]/.test(t)) return false
  const core = t.replace(/[\s!！。.~～、,，()（）…]+/g, '')
  if (!core || core.length > 10) return false
  const words = core.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '')
  if (!words) return ACK_EMOJI_RE.test(core)
  return ACK_RE.test(words)
}

/**
 * 道謝／道別的字（給 isPleasantryOnly 用）。
 *
 * 比 ai-answer.ts 的 THANKS_RE 寬：那邊一整句只能是一個詞（「謝謝」），這裡要認得出客人實際會打的
 * 組合——「好的謝謝」「了解，謝謝」「謝謝您～～～」「好、謝謝你們」（MYFEEL 2026-10-22 唯讀查：
 * 客服回完之後客人回的道謝，幾乎都是這種接在「好的」後面的）。
 */
const THANKS_WORD = '非常謝謝|謝謝(?:你們|你|您|妳)?|感謝(?:你們|你|您|妳)?|感恩|多謝|辛苦了|thanks?|thankyou|thx|3q'
const FAREWELL_WORD = '掰掰|拜拜|再見|bye+|byebye'
const PLEASANTRY_RE = new RegExp(
  `^(?:${ACK_WORD}|${THANKS_WORD}|${FAREWELL_WORD})+(?:了|啦|囉|喔|哦|唷|耶|欸|呦|哈)*$`,
  'i',
)

/**
 * 整句只有「好的／收到／謝謝／掰掰」這類客套（可以混在一起：「好的謝謝」「了解，感謝！」）。
 *
 * 給 `C-381` 用：真人處理中客人回這種話，不必把他放回待真人、也不必叫客服——事情多半已經講完，
 * 叫了只會讓客服的手機一直響「好的謝謝」。訊息照存、紅點照亮，客服打開對話照樣看得到。
 * 帶問號、帶任何其他字（「好的那運費呢」「謝謝 以後買不到便宜的濾芯了」）都不算。
 */
export function isPleasantryOnly(text: string): boolean {
  const t = String(text || '').trim()
  if (!t || /[?？]/.test(t)) return false
  const core = t.replace(/[\s!！。.~～、,，()（）…]+/g, '')
  if (!core || core.length > 16) return false
  const words = core.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '')
  if (!words) return true
  return PLEASANTRY_RE.test(words)
}

/** 注音鍵盤（標準排列）：聲母／介音／韻母各在哪幾個鍵，聲調是 3 4 6 7（一聲＝空白鍵） */
const ZHUYIN_INITIAL_KEYS = new Set('1qaz2wsxedcrfv5tgbyhn')
const ZHUYIN_MEDIAL_KEYS = new Set('ujm')
const ZHUYIN_FINAL_KEYS = new Set('8ik,9ol.0p;/-')
const ZHUYIN_TONE_KEYS = new Set('3467')

/**
 * 看不懂的一句——**注音輸入法沒切到中文**打出來的英數（正式站 2026-10-19 12:44 的「g. 2l4」＝「收到」，「ji3g4」＝「我是」）。
 * 整串照注音鍵盤拆得成一個個音節（聲母／介音／韻母＋聲調鍵或空白），而且至少有一個聲調鍵，才算。
 *
 * ⛔ 刻意不用「短的英數都當亂碼」：實測正式知識庫，客人只打「app」「usb」AI 原本答得出來（APP 下載方式、USB-C 接收器），
 *    「GL」「AP8」「HD7」是型號的一部分——這些照注音鍵盤都拆不開（「app」＝ㄇㄣ＋多一個ㄣ），不會被當成亂碼。
 * ⚠️ 只是「長得像打錯的注音」；answerWithAi 還要再確認這句單獨查不到知識、沒點名商品、不是在回答客服的問題，才不回。
 */
export function looksLikeZhuyinTypo(text: string): boolean {
  const s = String(text || '').trim().toLowerCase()
  if (!s || s.length > 30 || !/[a-z]/.test(s)) return false
  let i = 0
  let syllables = 0
  let toned = 0
  while (i < s.length) {
    const start = i
    if (ZHUYIN_INITIAL_KEYS.has(s[i]!)) i++
    if (i < s.length && ZHUYIN_MEDIAL_KEYS.has(s[i]!)) i++
    if (i < s.length && ZHUYIN_FINAL_KEYS.has(s[i]!)) i++
    if (i === start) return false
    syllables++
    if (i >= s.length) break
    // 一個音節打完一定接聲調鍵或空白（一聲），否則就不是注音打出來的
    if (ZHUYIN_TONE_KEYS.has(s[i]!)) {
      toned++
      i++
    }
    else if (s[i] === ' ') {
      i++
    }
    else {
      return false
    }
    while (s[i] === ' ') i++
  }
  return syllables > 0 && toned > 0
}

/** AI 決定不回的原因（記在那一回合的紀錄上，後台查得到） */
export type QuietReplyReason = 'acknowledgement' | 'garbled'

/**
 * 這句「可能」會被 AI 決定不回——handler 用它決定要不要先亮「輸入中…」。
 * 寧可少亮：猜錯（其實 AI 會答）只是那一則回覆前沒有點點；多亮的話客人看到點點出現又消失、什麼都沒來。
 */
export function quietReplyReasonOf(text: string): QuietReplyReason | null {
  if (isAcknowledgementOnly(text)) return 'acknowledgement'
  if (looksLikeZhuyinTypo(text)) return 'garbled'
  return null
}
