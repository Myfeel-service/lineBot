/**
 * 後台登入者（不是 LINE 客人）自己的偏好記錄。
 *
 * ⛔ `users` 那個集合裝的是 LINE 的客人，跟這裡完全無關，不要混用。後台帳號本身
 *    之前沒有任何「屬於這個人」的存放處（成員資格在 `workspaceMembers`，那是
 *    「這個人在哪幾家」不是「這個人的偏好」），所以 2026-09-16 為了「每頁第一次
 *    自動跑導覽」新開這一份。
 *
 * 文件路徑：`adminUserPrefs/{uid}`，uid ＝ Firebase Auth 的使用者編號。
 */

export const ADMIN_USER_PREFS_COLLECTION = 'adminUserPrefs'

/** 一個人最多記這麼多頁。全站只有 ~21 個導覽入口，這個上限純粹是防呆（見 post 端） */
export const MAX_SEEN_TOURS = 200

/**
 * 導覽記憶的鑰匙＝那一頁掛的教學 id 用 `|` 串起來（例如 `msg-basic|msg-rich`）。
 * ⛔ 用教學 id 不用網址：同一頁在不同官方帳號底下路徑不同，但教學是同一批。
 */
const SEEN_TOUR_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\|[a-z0-9]+(?:-[a-z0-9]+)*)*$/

export function isValidSeenTourKey(key: string): boolean {
  return key.length > 0 && key.length <= 200 && SEEN_TOUR_KEY_RE.test(key)
}

/**
 * 把文件裡的 `seenTours` 讀成乾淨的 map。
 * 舊資料、手改過的資料、型別不對的值一律丟掉——這份東西只用來決定「要不要再跳一次
 * 導覽」，猜錯的代價是多跳一次，不值得為它讓整支端點壞掉。
 */
export function readSeenTours(data: FirebaseFirestore.DocumentData | null | undefined): Record<string, number> {
  const raw = data?.seenTours
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return {}
  const out: Record<string, number> = {}
  for (const [key, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at) && isValidSeenTourKey(key))
      out[key] = at
  }
  return out
}

/**
 * 加一筆並套上限。滿了就丟掉最早看過的那幾筆——被丟掉的頁最多就是再被帶一次導覽，
 * 比讓文件無限長大安全。
 */
export function withSeenTour(prev: Record<string, number>, key: string, now: number): Record<string, number> {
  const next: Record<string, number> = { ...prev, [key]: now }
  const keys = Object.keys(next)
  if (keys.length <= MAX_SEEN_TOURS)
    return next
  for (const k of keys.sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0)).slice(0, keys.length - MAX_SEEN_TOURS))
    delete next[k]
  return next
}
