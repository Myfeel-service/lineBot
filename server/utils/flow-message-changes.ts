/**
 * 模組存檔改了哪幾則訊息（`C-411`）：操作紀錄只記「第幾則改過了」，⛔ 不存整份內容（會被截斷、反而整筆不能還原）。
 * 比的時候不算：
 *  - 存檔時系統自己附的試算表格子備份（`sheetSnapshots`，`C-423`）：試算表一變它就跟著變，不是店家改的
 *  - 欄位順序：Firestore 讀回來的順序跟畫面送來的不保證一樣
 * 則數有變時只比兩邊都有的那幾則：多出來、少掉的那則「訊息則數 2 → 3」已經講了，不再講一次。
 */
export function changedMessageNumbers(before: unknown, after: unknown): number[] {
  const a = Array.isArray(before) ? before : []
  const b = Array.isArray(after) ? after : []
  const out: number[] = []
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (stableJson(withoutSnapshots(a[i])) !== stableJson(withoutSnapshots(b[i]))) out.push(i + 1)
  }
  return out
}

/** 「第 1、3 則」 */
export function messageNumbersText(numbers: readonly number[]): string {
  return `第 ${numbers.join('、')} 則`
}

function withoutSnapshots(msg: unknown): unknown {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg
  const { sheetSnapshots: _snapshots, ...rest } = msg as Record<string, unknown>
  return rest
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, (x as Record<string, unknown>)[k]]))
    : x)) ?? 'undefined'
}
