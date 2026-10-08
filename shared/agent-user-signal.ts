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

// ── 推播草稿：客人會看到的字、發給誰，都要是使用者講過的（`D-116`，2026-10-08）──────────

/**
 * 像是在對小幫手下指令的字——這種句子是給「它」的，不是給客人看的。
 * ⛔ 實測：「中秋節快到了，幫我弄個活動」被原封不動當成推播內容，準備發給 9,076 人。
 */
const INSTRUCTION_TO_AGENT = /(幫我|幫忙|請你|你幫|擬一則|擬個|擬一個|寫一則|弄個|弄一個|推播|草稿|發一則)/

/** 兩個字一組（去掉空白標點後）：拿來量「這段字有多少出自他講過的話」 */
function bigrams(s: string): string[] {
  const t = squash(s)
  const out: string[] = []
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2))
  return out
}

/**
 * 至少要有幾成的字出自使用者講過的話：七成。
 * 模型常把他的話潤飾一下（加個句號、換個語序），那是好事；整句自己寫才是要擋的。
 */
const OWN_WORDS_MIN_SHARE = 0.7

/**
 * 推播內容是不是使用者講的。
 *
 * 要防的兩件事（2026-10-08 實測）：
 * ① 節慶卡送出「幫我擬一則「國慶日」的推播草稿」→ 它自己寫了「國慶日快樂！」，一個字都沒問。
 * ② 「中秋節快到了，幫我弄個活動」→ 這句**指令**被當成客人會看到的內容。
 * ⛔ prompt 裡早就寫著「內容要照使用者說的寫」，照樣中，所以改成機制（同 `hasNumberSignal`）。
 *
 * @returns 要回給模型的話（它會照著去問）；沒問題回 null
 */
export function broadcastTextIssue(text: string, userTexts: readonly string[]): string | null {
  const body = String(text ?? '').trim()
  if (INSTRUCTION_TO_AGENT.test(body)) {
    return `「${body.slice(0, 30)}」是使用者對你下的指令，不是要給客人看的字。`
      + '⛔ 不可以把它當成推播內容，也不可以自己寫一段。請先問他：要跟客人說什麼（例如優惠內容、出貨時間）、要發給全部好友還是某個標籤的人。'
  }
  return userAuthoredTextIssue(body, userTexts, '這段推播內容', '要跟客人說什麼（例如優惠內容、出貨時間）、要發給全部好友還是某個標籤的人')
}

/**
 * 一段會被客人看到（或 AI 照著回答）的字，是不是使用者講的（推播、知識卡的答案、自動回應的回覆字共用）。
 *
 * ⛔ 2026-10-08 第三輪實測：「AI 回的運費是錯的」→ 它直接提議一張知識卡，答案寫「請提供正確的運費資訊。」——
 *    拿一句佔位的話當成要教 AI 的內容。跟推播草稿自己編「國慶日快樂！」是同一件事。
 * @param what 這段字是什麼（「要回答的內容」），會出現在回給模型的話裡
 * @param ask 要回去問他什麼
 */
export function userAuthoredTextIssue(text: string, userTexts: readonly string[], what: string, ask: string): string | null {
  const grams = bigrams(text)
  if (!grams.length) return null
  const user = squash(userTexts.join(' '))
  const own = grams.filter(g => user.includes(g)).length / grams.length
  if (own >= OWN_WORDS_MIN_SHARE) return null
  return `${what}不是使用者講的（是你自己寫的）。⛔ 這段字一律照他講的話，不可以自己編，也不可以用「請提供…」這種句子先佔位。`
    + `請先問他：${ask}；他講了再提議。`
}

/** 「發給全部」的講法 */
const ALL_AUDIENCE = /(全部|所有|全體|每個人|每位|每一位|大家|全員|all|everyone)/

/**
 * 發給誰，是不是使用者講過的。⛔ 沒講就選「全部好友」＝替他決定把訊息發給幾千個人。
 * @param tagName 這次要發的標籤；沒有＝全部好友
 */
export function broadcastAudienceIssue(tagName: string | undefined, userTexts: readonly string[]): string | null {
  const user = squash(userTexts.join(' '))
  const tag = squash(String(tagName ?? ''))
  if (tag) {
    return user.includes(tag)
      ? null
      : `使用者沒有講過「${tagName}」這個標籤。⛔ 不可以替他挑對象：請問他要發給全部好友，還是哪一個標籤的人。`
  }
  if (ALL_AUDIENCE.test(user)) return null
  return '使用者還沒講要發給誰。⛔ 不可以自己選「全部好友」。'
    + '請問他要發給全部好友，還是某個標籤的人（可以先用 get_tag_audience 查各有幾人告訴他）。'
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
