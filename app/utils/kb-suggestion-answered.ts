/**
 * 「AI 建議補的知識」審核時的「這一條回答了哪幾題？」（`C-311`，2026-10-14 老闆拍板）。
 *
 * 同一組常是同一個產品的不同問題（正式站「小滑手」那組：哪一國做的／只能沖義式嗎／能邊萃取邊打奶泡嗎／寬深高）。
 * 以前寫一條、按採用就整組消失，其他題目沒人回答。現在讓他勾這一條回答了哪幾題，沒勾的留在清單上。
 */

/** 比對用：拿掉空白與標點、英文不分大小寫（「小滑手是哪國做的?」＝「小滑手是哪國做的？」） */
function normalizeQuestion(q: string): string {
  return String(q ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/**
 * 預設勾哪幾題。
 *
 * 草稿是 AI 拿整組的樣本句一起擬的，**沒有記下它是寫給哪一題的**。認得出來的有兩種：
 * ① AI 擬的「客人可能怎麼問」裡原封不動用了某幾題客人原句——那幾題就是它寫的對象，預設勾；
 * ② 標題欄要填的字（AI 擬的標題；沒有草稿時是主題名）就是其中一題（正式站「小滑手」那組：主題「小滑手只能沖義式咖啡嗎？」＝第 3 題）——勾那一題。
 *    ⛔ 少了這條，2026-10-14 本機看正式庫那組：勾的是「哪一國做的」、標題欄卻是「只能沖義式嗎」，
 *    直接按採用就建出一條標題跟它回答的題目對不上的知識。
 * 認不出來就只勾第一題：清單照被問次數排、第一題是這一組的代表句（聚類時開桶的那句，
 * AI 草擬時也排第一），草稿最可能是在回答它。
 *
 * ⛔ 不預設全勾：全勾＝回到改版前「整組消失」，他沒細看就按採用的話，沒回答到的題目又不見了。
 * 少勾的代價小得多——沒勾的只是留在清單上，下次再補。
 */
export function defaultAnsweredQueries(
  queries: readonly string[],
  draftQuestions?: readonly string[] | null,
  draftTitle?: string | null,
): string[] {
  if (!queries.length) return []
  const fromDraft = new Set((draftQuestions ?? []).map(normalizeQuestion).filter(Boolean))
  const matched = queries.filter(q => fromDraft.has(normalizeQuestion(q)))
  if (matched.length) return matched
  const title = normalizeQuestion(draftTitle ?? '')
  const byTitle = title ? queries.find(q => normalizeQuestion(q) === title) : undefined
  return [byTitle ?? queries[0]!]
}

/**
 * 勾選一變，「客人可能怎麼問」跟著變（畫面上看得到，送出的就是看到的）。
 *
 * - 勾了的客人原句放進去：那正是客人實際的問法，放進「客人可能怎麼問」AI 最容易找到這一條。
 * - 取消勾的拿掉：留著＝這一條宣稱回答了他剛說沒回答的題目。
 * - 一條知識最多 3 個問法（伺服器 normalizeChunkInput 也切 3，超過的會被默默丟掉），滿了就換掉
 *   最後一個「不是勾選題目」的（AI 擬的問法或他自己打的）；三個都是勾的題目就不再塞——那一題照樣算回答了，
 *   只是沒放進問法。
 * - 他自己從下拉拿掉的勾選題目不會被塞回來（只處理「這次新勾的」）。
 */
export function syncTickedQuestions(
  questions: readonly string[],
  prevTicked: readonly string[],
  nextTicked: readonly string[],
  limit = 3,
): string[] {
  const prev = new Set(prevTicked)
  const next = new Set(nextTicked)
  let out = questions.filter(q => !(prev.has(q) && !next.has(q)))
  for (const q of nextTicked) {
    if (prev.has(q) || out.includes(q)) continue
    if (out.length < limit) {
      out = [...out, q]
      continue
    }
    const idx = out.map(x => next.has(x)).lastIndexOf(false)
    if (idx >= 0) out = out.map((x, i) => (i === idx ? q : x))
  }
  return out
}
