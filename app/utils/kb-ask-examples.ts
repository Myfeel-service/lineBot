/**
 * 「問 AI 一題」還沒問過時列的那幾句（`D-168`，2026-11-04 老闆「好改」，示意頁 P2eM2kiRXe6X6SZsWNT6y6）。
 *
 * 以前還沒問過時整欄只有一格輸入框、下面全空白：第一次來不知道該問什麼、問了會看到什麼。
 * 範例就是最好的說明——點一句就直接問，答案會標出用了哪幾條。
 *
 * 兩個來源都是頁面手上現成的資料，⛔ 不另外叫 AI 想題目（多花錢、而且想出來的未必是客人會問的）：
 * - 打開一份資料時：那一份裡 AI 會用的知識，每條存著的客人問法（`questions`，整理時就產生的）
 * - 沒打開資料時：「AI 建議補的知識」那幾組客人真的問過、AI 答不出來的原句——補完答案點一下就知道現在會不會答
 * 兩種都沒有就不列（只留輸入框），⛔ 不拿標題湊（「後進氣面板清潔」不是客人會打的話）。
 */

export const ASK_EXAMPLE_COUNT = 3
/** 太長的不列：一顆按鈕折成四五行，看起來不像「一句話」；客人原句常帶一長串前情 */
export const ASK_EXAMPLE_MAX_CHARS = 50

export interface AskExamples {
  /** 那幾句上面的一行字（講這幾句是哪來的） */
  label: string
  questions: string[]
}

function usable(q: unknown): string {
  const s = String(q ?? '').replace(/\s+/g, ' ').trim()
  return s && [...s].length <= ASK_EXAMPLE_MAX_CHARS ? s : ''
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  return list.filter((q) => {
    const k = q.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * 打開一份資料時：只挑 AI 真的會用的那幾條（`indexed`；停用、處理中、學失敗、等你看過、總覽都不算——
 * 拿等你看過的那條當範例，答出來會標「還沒上線」，第一眼看到的就是例外）。
 * 每條拿第一句能用的問法，平均分散在整份裡挑（前幾條常是「產品簡介」，三句都問同一件事沒意思）。
 */
export function exampleQuestionsFromChunks(
  chunks: ReadonlyArray<{ status: string, isOverview?: boolean, questions?: readonly string[] | null }>,
  n = ASK_EXAMPLE_COUNT,
): string[] {
  const pool = dedupe(chunks
    .filter(c => c.status === 'indexed' && !c.isOverview)
    .map(c => (c.questions ?? []).map(usable).find(Boolean) ?? '')
    .filter(Boolean))
  if (pool.length <= n) return pool
  return Array.from({ length: n }, (_, i) => pool[Math.floor((i * pool.length) / n)]!)
}

/**
 * 沒打開資料時：「AI 建議補的知識」每一組拿第一句客人原句，照清單順序（伺服器排好的，被問最多次的在前）。
 * `queries` 是這一組全部的原句（新版才有），沒有就用樣本句。
 */
export function exampleQuestionsFromSuggestions(
  items: ReadonlyArray<{ sampleQueries?: readonly string[] | null, queries?: readonly string[] | null }>,
  n = ASK_EXAMPLE_COUNT,
): string[] {
  return dedupe(items
    .map((s) => {
      const qs = s.sampleQueries?.length ? s.sampleQueries : (s.queries ?? [])
      return qs.map(usable).find(Boolean) ?? ''
    })
    .filter(Boolean))
    .slice(0, n)
}
