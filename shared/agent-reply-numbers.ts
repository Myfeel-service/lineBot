/**
 * 「泡泡裡的數字，卡片上有沒有這個數字」——提議回覆的數字把關（`C-192` 第二輪）。
 *
 * 要防的事（2026-09-16 實測）：使用者連著調兩次提醒時間，但**一次確定都沒按**，
 * 第二次的泡泡卻寫「我會將提醒時間**從 30 分鐘**調整為 5 分鐘」——
 * 而現在其實還是 60 分鐘（30 是它自己上一次提議、使用者沒答應的那個數字）。
 * 卡片寫的是對的（「等超過 60 分鐘就提醒 ── 現在」），泡泡跟卡片各講一套。
 *
 * 做法：卡片上的每一句都是**後端當場查出來的**，所以拿它當唯一事實來源——
 * 模型那句話裡只要出現一個卡片上沒有的數字，整句就不採用，改用卡片的主句。
 * ⛔ 不是把數字挖掉改寫：句子被動過手腳比整句換掉更難察覺。
 *
 * ⚠️ 刻意允許換算：模型常把「23:00」講成「晚上 11 點」，那是好事不是錯。
 *    所以鐘點類的寫法會同時認「11」與「23」，只要其中一個在卡片上就放行。
 */

const CJK_DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 「十一」「二十」「十」這種寫法轉成數字；轉不出來回 null */
function cjkToNumber(s: string): number | null {
  if (!s) return null
  if (/^[0-9０-９]+$/.test(s)) return Number(s.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xFF10)))
  if (!/^[零一二兩三四五六七八九十]+$/.test(s)) return null
  const i = s.indexOf('十')
  if (i < 0) {
    let n = 0
    for (const c of s) {
      const d = CJK_DIGIT[c]
      if (d === undefined) return null
      n = n * 10 + d
    }
    return n
  }
  const tensPart = s.slice(0, i)
  const onesPart = s.slice(i + 1)
  const tens = tensPart ? CJK_DIGIT[tensPart] : 1
  const ones = onesPart ? CJK_DIGIT[onesPart] : 0
  if (tens === undefined || ones === undefined) return null
  return tens * 10 + ones
}

/** 一個「數字的出現」：鐘點可能有兩種寫法，只要有一種對得上卡片就算有出處 */
interface NumberToken { candidates: number[] }

const TOD = '早上|上午|中午|下午|晚上|晚間|夜間|凌晨|半夜|深夜'
const NUM = '[0-9０-９]+|[零一二兩三四五六七八九十]+'
/** 「晚上 11 點」「下午2點」——時段詞在前的鐘點 */
const CLOCK_WITH_TOD = new RegExp(`(${TOD})\\s*(${NUM})\\s*點`, 'g')

/** 把 12 小時制換成 24 小時制（早上／凌晨不動，下午／晚上加 12） */
function to24h(tod: string, n: number): number {
  if (n >= 13 || n === 0) return n
  if (/下午|晚上|晚間|夜間|深夜/.test(tod)) return n === 12 ? 12 : n + 12
  return n
}

/** 抓出一段文字裡所有「數字的出現」 */
function tokenize(text: string): NumberToken[] {
  const tokens: NumberToken[] = []
  // ⛔ 先吃掉鐘點寫法再掃純數字，否則「晚上 11 點」的 11 會被算兩次
  //    （一次當鐘點、一次當裸數字），裸數字那次永遠對不上換算後的卡片。
  const rest = String(text ?? '').replace(CLOCK_WITH_TOD, (_m, tod: string, num: string) => {
    const n = cjkToNumber(num)
    if (n !== null) tokens.push({ candidates: [n, to24h(tod, n)] })
    return ' '
  })
  for (const m of rest.matchAll(/[0-9０-９]+/g)) {
    const n = cjkToNumber(m[0])
    if (n !== null) tokens.push({ candidates: [n] })
  }
  return tokens
}

/** 卡片上出現過的所有數字（含把「十一點」這種中文寫法也算進去） */
function sourceNumbers(previewTexts: readonly string[]): Set<number> {
  const out = new Set<number>()
  for (const t of previewTexts) {
    for (const tok of tokenize(t))
      for (const c of tok.candidates) out.add(c)
    // 卡片偶爾會用中文數字（「共 19 個字」是數字，但「一提到就轉真人」不是）——
    // 這裡只補鐘點以外的中文數字，寧可多收也不要誤判成「沒有出處」
    for (const m of String(t ?? '').matchAll(/[零一二兩三四五六七八九十]+/g)) {
      const n = cjkToNumber(m[0])
      if (n !== null) out.add(n)
    }
  }
  return out
}

/**
 * 模型寫的那句話裡，有沒有卡片上找不到的數字。
 *
 * @param text 模型自己寫的那句話（會顯示成聊天泡泡）
 * @param previewTexts 確認卡上的每一句（主句、每一列、影響、按鈕字樣）——⛔全部由後端當場查出來
 * @returns 對不上的那些數字；空陣列代表每個數字都有出處
 */
export function numbersWithoutSource(text: string, previewTexts: readonly string[]): number[] {
  const source = sourceNumbers(previewTexts)
  const bad: number[] = []
  for (const tok of tokenize(text)) {
    if (!tok.candidates.some(c => source.has(c))) bad.push(tok.candidates[0]!)
  }
  return bad
}
