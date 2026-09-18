/**
 * 「使用者這句話，夠不夠決定要動什麼」——代辦提議的前置判斷（`C-192`）。
 *
 * 要防的事（2026-09-16 當使用者實測時抓到的）：
 *
 * ① 小幫手拒絕批次之後，會留下一個**沒有預設值的問題**（「請問您想先關閉哪一個？」）。
 *    使用者只要回一個「做」，模型就自己挑了清單**第一條**——那是正在服務客人的那條，
 *    而且確認卡長得跟正常提議一模一樣。⛔ 2/2 重現；「嗯」「.」不會中，只有像答應／
 *    催促的字會中，因為模型把它讀成「對，照你說的做」，而它說的那句其實沒有指定對象。
 *
 * ② 使用者一個數字都沒講（「晚上太晚有人敲我，幫我設一下」），模型直接提議
 *    22:00–08:00。⛔ 而且順手把使用者沒抱怨的早上也提前兩小時。
 *
 * ⛔ prompt 裡本來就寫著「⛔不要自己補一個常見值——問清楚再提議」，兩題照樣中。
 *    這支存在的理由就是那句話不夠：擋它要靠機制，跟 `agent-arg-provenance` 同一個道理。
 */

/** 去掉空白與標點，英數轉小寫——「好，」「好 」「OK!」要算同一個字 */
function squash(s: string): string {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。、！？；：「」『』（）〈〉《》,.!?;:~～\-—…"'`·]/g, '')
    .toLowerCase()
}

/**
 * 語尾／語首的虛字：脫掉之後才比對，否則「那就做吧」「好了啦」要各列一條。
 * ⛔ 只脫頭尾、不脫中間：「關了嗎」脫成「關」會誤判成同意詞。
 */
const FILLER_HEAD = /^(那|就|然後|所以|嗯|恩|喔|哦|欸|欵)+/
const FILLER_TAIL = /(吧|啊|阿|呀|喔|哦|囉|咯|了|啦|嘛|呢|唷|喲|哩|欸|欵)+$/

/**
 * 只是「同意／催促」、沒有講要動哪一個東西的一句話。
 *
 * ⛔ 刻意用**整句完全比對**而不是關鍵字包含：「好，把查詢訂單關掉」裡面有「好」，
 *    但它明明講清楚了要動哪一條，擋它就是誤擋。
 */
const BARE_ASSENT = new Set([
  // 同意
  '好', '好的', '好啊', '好呀', '好喔', '好哦', '嗯', '恩', '嗯嗯', '是', '是的', '對', '對的',
  '沒錯', '可以', '行', '沒問題', '當然', '要', '好要', '同意', '這樣', '這樣就好', '就這樣',
  // 催促／叫它動手
  '做', '執行', '動手', '開始', '來', '去', '用', '弄', '處理', '幫我做', '幫我用', '幫我處理',
  '麻煩', '麻煩你', '麻煩了', '拜託', '拜託你', '請', '快', '繼續',
  // 按鈕字樣被打成文字
  '確定', '確認', '送出',
  // 把決定權丟回來——⛔這種更要問，不能替他挑
  '都可以', '隨便', '隨你', '你決定', '你看著辦', '都行', '無所謂',
  // 英文
  'ok', 'okay', 'k', 'yes', 'y', 'yeah', 'yep', 'sure', 'go', 'goahead', 'doit', 'do',
  'proceed', 'please', 'confirm', 'continue',
])

/**
 * 這句話是不是「只有同意、沒有指定對象」。
 *
 * @example isBareAssent('做') === true
 * @example isBareAssent('那就做吧') === true
 * @example isBareAssent('把查詢訂單關掉') === false
 * @example isBareAssent('第二條') === false
 */
export function isBareAssent(message: string): boolean {
  const core = squash(message).replace(FILLER_HEAD, '').replace(FILLER_TAIL, '')
  if (!core) return true // 只剩標點／虛字＝什麼都沒講
  return BARE_ASSENT.has(core)
}

/**
 * 有沒有講到「幾點／幾分鐘／幾倍」這種可以決定數值的訊息。
 *
 * 給**參數是時間或數量**的操作用（服務時間、提醒幾分鐘）：使用者一個數字都沒講，
 * 模型就不該生一組出來。⛔ 這裡刻意收得很窄——只認阿拉伯數字，或「中文數字＋單位」：
 * 「幫我設一**下**」裡的「一」不是數值，若只認中文數字就會整句誤放行（實測踩到）。
 */
// ⛔ 不收「幾」：「要改成幾點？」是使用者在問，不是他給了一個值。
const CJK_NUM = '零一二兩三四五六七八九十百半'
// 「一**個**小時」要算數，所以單位前面允許一個「個」
const NUMBER_SIGNAL = new RegExp(
  `[0-9０-９]|[${CJK_NUM}]\\s*個?\\s*(?:點半|點|時|分鐘|分|秒|小時|鐘頭|天|倍|成)`,
)

/**
 * 先拿掉「一」當程度副詞用的那些寫法，再去比對數值。
 *
 * ⛔ 「調短一**點**」的「一點」是程度、「晚上一**點**」的「一點」是鐘點，同一個詞兩種意思；
 *    不處理的話「調短一點」會被當成使用者給了時間（實測踩到）。
 * ⛔ 但**前面是數字或時段詞就不可以拿掉**：「晚上十一點」的「一」屬於「十一」，
 *    誤砍會把一句講得很清楚的話判成「他沒給數字」。
 */
function stripVagueOne(s: string): string {
  return String(s ?? '')
    .replace(/(?<![0-9０-９零一二兩三四五六七八九十百早上午中下晚凌晨半夜])一點/g, '')
    .replace(/一下|一些|一起|一直|一樣|一陣/g, '')
}

/**
 * 使用者自己講過的話裡，有沒有出現可以當成數值的東西。
 *
 * @param userTexts 使用者自己打的字（這一輪 ＋ 先前輪次他自己講的；⛔不要把助理的話算進去，
 *   那等於「助理自己講一個數字，然後自己拿來當使用者的要求」）
 */
export function hasNumberSignal(userTexts: readonly string[]): boolean {
  return userTexts.some(t => NUMBER_SIGNAL.test(stripVagueOne(t)))
}

/** 一個「幾點」的說法：「早上十點」「22:00」「晚上 11 點」都算一個 */
const CLOCK_MENTION = new RegExp(
  `[0-9０-９]{1,2}\\s*[:：]\\s*[0-9０-９]{2}`
  + `|(?:${'早上|上午|中午|下午|晚上|晚間|夜間|凌晨|半夜|深夜'})?\\s*(?:[0-9０-９]+|[零一二兩三四五六七八九十]+)\\s*點`,
  'g',
)

/** 看起來像 "HH:mm" 的值 */
function isClockValue(v: unknown): boolean {
  return /^\d{1,2}[:：]\d{2}$/.test(String(v ?? '').trim())
}

/**
 * 接續修改一個提議時，**時間格被動到的數量有沒有超過使用者這句話講的時間數**。
 *
 * 2026-09-18 回歸實測踩到：上一個提議是「勿擾 23:00–09:00」，使用者只說
 * 「剛剛那個**改成早上十點**」（一個時間），出來的卡片卻是「勿擾 **22:00**–10:00」——
 * 晚上那端被一起改掉了，而他從頭到尾沒提過晚上。
 *
 * ⛔ **刻意不擋下來**：「整個時段往後一小時」這種說法，一個時間、兩端都要動是對的。
 *    擋了會把合理的要求變成鬼打牆。這裡只回報「多動了哪幾格」，讓卡片自己講出來——
 *    使用者看得到就有機會喊停，這比擋錯更實在。
 *
 * @returns 多動的那幾格欄位名；空陣列＝沒有多動（或這根本不是接續修改）
 */
export function clockFieldsChangedBeyondUserWords(
  message: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  if (!before || !after) return []
  const changed = Object.keys(after).filter((k) => {
    if (!isClockValue(after[k]) && !isClockValue(before[k])) return false
    return String(before[k] ?? '').trim() !== String(after[k] ?? '').trim()
  })
  const mentions = (String(message ?? '').match(CLOCK_MENTION) ?? []).length
  return changed.length > mentions ? changed : []
}
