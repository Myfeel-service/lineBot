/**
 * LINE 通知名單的比對（純函式，`C-271`⑭ 從 `server/utils/ai-settings.ts` 搬來、收成一份）。
 *
 * 為什麼要有：同一行「`v === id || v.endsWith('_' + id)`」原本抄了四份（加名單、拿名單、webhook、LINE 通知頁），
 * 改一處就會對不上。名單比對一律走 `notifyListHas`，存進資料前一律 `normalizeLineUserId`。
 */

/** 純 LINE userId：U＋32 位十六進位 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i

/**
 * 收斂成純 LINE userId。
 * users 的 Firestore doc id 是 {workspaceId}_{lineUserId}，若整串被存進通知名單，
 * pushMessage 會被 LINE 判成無效 userId 而靜默失敗——通知永遠不會到。
 * 純 LINE userId 不含底線，因此可安全地取最後一段來自我修正。
 */
export function normalizeLineUserId(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s.includes('_')) return s
  const tail = s.slice(s.lastIndexOf('_') + 1)
  return LINE_USER_ID_RE.test(tail) ? tail : s
}

/** 通知名單上有沒有這個 LINE 帳號（舊資料可能存成 `${workspaceId}_U…`，兩種都算） */
export function notifyListHas(ids: readonly unknown[], lineUserId: string): boolean {
  const id = normalizeLineUserId(lineUserId)
  return Boolean(id) && ids.some(v => normalizeLineUserId(v) === id)
}
