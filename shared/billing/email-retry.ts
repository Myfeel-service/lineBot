// ═══════════════════════════════════════════════════════════════════
//  帳務信「寄失敗要重試、但不能無限重寄」的節流規則（純函式，`B-49`）
//
//  為什麼要有這支：以前續扣提醒、額度信、綁卡提醒寄完就**無條件**記「這期寄過了」，
//  而寄信那層（sendEmail）設計成永不丟錯——SES 權限掉了、寄件網域失效，程式照樣記成寄過，
//  之後再也不會重寄。客人漏收扣款前提醒，然後問「怎麼沒通知就扣錢」，我們也查不到是沒寄還是寄失敗。
//
//  現在：寄成功才記「寄過了」；失敗只記一筆「試過第幾次、什麼時候試的」，下一輪排程再試。
//  排程每 10 分鐘跑一次，所以一定要有冷卻——否則設定壞掉時同一封信一天會被試 144 次。
// ═══════════════════════════════════════════════════════════════════

/** 失敗後隔多久才再試（排程每 10 分鐘一輪，這個值決定實際重試間隔）。 */
export const EMAIL_RETRY_COOLDOWN_MS = 3 * 60 * 60 * 1000
/** 同一封信最多試幾次（含第一次）。5 次 × 3 小時 ≈ 12 小時內都在重試，之後放棄並留 log。 */
export const EMAIL_MAX_ATTEMPTS = 5

/** 一封信（以 `key` 區分是哪一期／哪一種）試過的紀錄。 */
export interface EmailAttempt {
  /** 這筆紀錄屬於哪一封：通常是期別（`2026-10-20`）或期別＋類型（`2026-10-20:near`） */
  key: string
  /** 已經試過幾次（都失敗了才會留著這筆） */
  attempts: number
  /** 最後一次試的時間（毫秒） */
  lastAttemptAt: number
}

/**
 * 這一輪可不可以試著寄 `key` 這封信。
 * 沒試過（或上次試的是別封）→ 可以；試滿上限 → 不再試；還在冷卻 → 等下一輪。
 */
export function emailAttemptAllowed(prev: EmailAttempt | null | undefined, key: string, nowMs: number): boolean {
  if (!prev || prev.key !== key) return true
  if ((prev.attempts ?? 0) >= EMAIL_MAX_ATTEMPTS) return false
  return nowMs - (prev.lastAttemptAt ?? 0) >= EMAIL_RETRY_COOLDOWN_MS
}

/** 寄失敗之後要存回去的紀錄（同一封累加次數；換了一封就從 1 開始）。 */
export function nextEmailAttempt(prev: EmailAttempt | null | undefined, key: string, nowMs: number): EmailAttempt {
  const attempts = prev && prev.key === key ? (prev.attempts ?? 0) + 1 : 1
  return { key, attempts, lastAttemptAt: nowMs }
}

/** 這次失敗之後是不是已經用完次數（呼叫端據此大聲留 log：之後不會再試了）。 */
export function emailAttemptsExhausted(attempt: EmailAttempt): boolean {
  return attempt.attempts >= EMAIL_MAX_ATTEMPTS
}
