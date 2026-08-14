/**
 * 產品名相似度：欄位端（打字當下攔「這會新增產品／是同一台嗎」）與
 * 偵測端（產品名稱整理列「可能是打錯字」候選）共用同一把尺。
 *
 * 兩邊各寫一份的話，欄位說「很像」、整理視窗卻不列（或反過來），
 * 使用者會在兩個畫面得到兩種說法——所以判定只有這一份。
 */

/** 比對用正規化：去空白、去裝飾符號、小寫（答題端的產品分組也用同一個函式） */
export function normalizeProductName(s: string): string {
  return String(s || '')
    .replace(/[《》〈〉（）()【】\[\]「」『』・·,，.。\-–—_/|｜]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 有上限的編輯距離（Levenshtein）。超過 max 提早回 max + 1：
 * 名字要兩兩比對（O(n²) 對），把完整 DP 花在注定不像的名字上是浪費。
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const n = a.length
  const m = b.length
  if (!n || !m) return Math.min(Math.max(n, m), max + 1)
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= n; i++) {
    const cur: number[] = new Array(m + 1)
    cur[0] = i
    let rowMin = i
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (cur[j]! < rowMin) rowMin = cur[j]!
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return Math.min(prev[m]!, max + 1)
}

/**
 * 允許的「打錯字」距離：名字越長容忍越多，最多 2。
 * 短名字（正規化後 < 4 字）一律不判打錯字——「W1」差一個字就是另一台。
 */
export function typoDistanceLimit(len: number): number {
  return len >= 8 ? 2 : len >= 4 ? 1 : 0
}

/** 名字裡的數字序列（照出現順序）。 */
function digitsOf(s: string): string {
  return (s.match(/\d+/g) ?? []).join(',')
}

/**
 * 兩個名字是不是「幾乎同字＝可能打錯字」。回編輯距離；不是就回 null。
 *
 * 刻意排除的兩類（都不是打錯字）：
 * - 數字不同（12L vs 16L）：多半是同系列不同型號，提示「是同一台嗎」反而誘導誤併。
 * - 一個包含另一個（全稱/簡稱、型號後綴）：這是既有「包含訊號」的守備範圍，
 *   那邊會正確標「可能是不同型號」的風險，這裡搶答會把風險標丟掉。
 */
export function likelyTypoDistance(a: string, b: string): number | null {
  const na = normalizeProductName(a)
  const nb = normalizeProductName(b)
  if (!na || !nb || na === nb) return null
  if (na.includes(nb) || nb.includes(na)) return null
  if (digitsOf(na) !== digitsOf(nb)) return null
  const limit = typoDistanceLimit(Math.min(na.length, nb.length))
  if (!limit) return null
  const d = boundedEditDistance(na, nb, limit)
  return d <= limit ? d : null
}

export interface ProductNameSimilarity {
  /**
   * spelling = 正規化後相同（只差空白/符號/大小寫，AI 本來就當同一台，建議統一寫法）
   * typo     = 只差 distance 個字（可能打錯字，要問人）
   */
  kind: 'spelling' | 'typo'
  match: string
  distance: number
}

/**
 * input 與現成名單裡「最像」的一個；沒有夠像的回 null。
 * 與 input 原樣完全相同的名字會跳過（那不是「像」，是「就是它」，呼叫端自行處理）。
 */
export function findSimilarProductName(input: string, existing: string[]): ProductNameSimilarity | null {
  const raw = String(input ?? '').trim()
  const ni = normalizeProductName(raw)
  if (!ni) return null
  let best: ProductNameSimilarity | null = null
  for (const e of existing) {
    const name = String(e ?? '').trim()
    if (!name || name === raw) continue
    const ne = normalizeProductName(name)
    if (!ne) continue
    if (ne === ni) return { kind: 'spelling', match: name, distance: 0 }
    const d = likelyTypoDistance(raw, name)
    if (d === null) continue
    if (!best || d < best.distance) best = { kind: 'typo', match: name, distance: d }
  }
  return best
}
