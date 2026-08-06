/**
 * 清單重新抓回來時，把新資料「併」進舊清單，而不是整份換掉。
 *
 * 為什麼要這樣：對話列表每 30 秒輪詢一次、每送出一句也刷一次。整份換掉的話
 * 每一列都是新物件，Vue 會把整排列重繪一遍——畫面閃一下、捲軸跳掉、
 * hover 中的 ⋯ 按鈕消失、右鍵選單被沖掉。實際上多數輪詢只有一兩列變了。
 *
 * 判斷「有沒有變」用 JSON.stringify 比對，不列舉欄位：
 * 列的欄位會長（現在已有 9 個），列舉法每次後端多回一欄就要記得同步，
 * 漏掉的那一欄從此永遠不會更新，而且不會有人發現。序列化後端來的純資料物件
 * 鍵序是固定的（同一段程式產生），所以可以直接比字串。
 * 時間戳是 `{_seconds,_nanoseconds}` 這種巢狀物件，用 === 比永遠不相等，也要靠這個。
 */
function sameRow(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 逐列比對：沒變的沿用**原本那個物件**（identity 不變 → Vue 跳過那一列），
 * 有變的和新出現的才用新物件。回傳的順序完全照 incoming。
 *
 * 用在「後端回來的就是完整清單」的情境，例如一則一則的訊息。
 */
export function reuseUnchangedRows<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  if (!existing.length) return [...incoming]
  const prev = new Map(existing.map(row => [keyOf(row), row]))
  return incoming.map((row) => {
    const old = prev.get(keyOf(row))
    return old !== undefined && sameRow(old, row) ? old : row
  })
}

/**
 * 背景刷新時把重抓的第一頁併進現有清單。
 *
 * `hasMore=false` ＝這一頁就是全部（多數 workspace 的對話數根本不到一頁）：
 * 直接照它，該消失的列就會消失。
 *
 * `hasMore=true` ＝後面還有，而且使用者可能已經往下捲載到第三頁了。這時第一頁沒有某一列
 * **不代表它被刪掉**，多半只是被新訊息擠到後面去，所以已載入的舊列接在後面留著——
 * 整份換掉會讓下面兩頁憑空消失、捲軸瞬間縮短。代價是真的被刪掉的列會停在原地，
 * 直到下次完整重載（按「重整」、換分頁、搜尋）；比每 30 秒讓清單抖一次划算。
 */
export function mergeIntoList<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string,
  hasMore: boolean,
): T[] {
  const merged = reuseUnchangedRows(existing, incoming, keyOf)
  if (!hasMore || !existing.length) return merged
  const seen = new Set(incoming.map(keyOf))
  for (const row of existing) {
    if (!seen.has(keyOf(row))) merged.push(row)
  }
  return merged
}
