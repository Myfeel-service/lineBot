/**
 * 背景掃描器的健康狀態（08-25，`C-68` 的治本）。
 *
 * 為什麼需要：`C-68` 的 AI 貼標掃描器因為缺一個索引，**每一輪都在同一支查詢炸掉**，
 * 而錯誤被 `catch { console.warn }` 吞掉 → 開關明明開著、畫面上什麼都不會說，
 * 兩天後才有人問「怎麼都沒建議」才查出來。
 *
 * ⛔ **不能用「游標有沒有往前走」當健康訊號**：掃描器追上進度之後本來就不會寫入
 *    （沒有新的對話要處理），游標停著是正常的。08-25 實查 MYFEEL 確認過這件事。
 *    唯一可靠的訊號是**掃描器自己說它失敗了**。
 *
 * 資料放哪：**掃描器本來就會讀寫的那份狀態文件**（tag-suggest 在 `cronState/tag-suggest-{wid}`、
 * tag-discovery 在 `tagDiscovery/{wid}`）——掃描器零額外讀取，異常中心才多讀那一兩份。
 *
 * 寫入時機（⛔ 不要每輪都寫，那是每天 288 次的寫入風暴）：
 *   · 失敗 → 記下來（壞掉時每輪寫一次，可接受）
 *   · 從失敗恢復 → 清掉（掃描器本來就讀了那份文件，知道先前有沒有錯）
 *   · 一路正常 → 不寫
 */

/** 連續失敗超過這麼久才報異常：偶發一次（LLM 逾時、瞬斷）不值得吵人 */
export const SCANNER_STALE_MS = 45 * 60 * 1000

export interface ScannerHealth {
  /** 最後一次失敗的時間（0＝目前沒有記錄在案的失敗） */
  lastErrorMs: number
  /** 失敗訊息（截短，給工程師看的；畫面只講白話） */
  lastError: string
  /** 第一次連續失敗的時間——用來算「壞多久了」，中間成功過就重算 */
  failingSinceMs: number
}

export const HEALTHY_SCANNER: ScannerHealth = { lastErrorMs: 0, lastError: '', failingSinceMs: 0 }

export function readScannerHealth(data: Record<string, unknown> | null | undefined): ScannerHealth {
  const raw = (data?.health ?? null) as Partial<ScannerHealth> | null
  if (!raw) return HEALTHY_SCANNER
  return {
    lastErrorMs: Number(raw.lastErrorMs ?? 0),
    lastError: String(raw.lastError ?? ''),
    failingSinceMs: Number(raw.failingSinceMs ?? 0),
  }
}

/**
 * 這台掃描器現在算不算「壞了」（純函式，可測）。
 *
 * ⛔ 判斷用的是 `failingSinceMs`（第一次連續失敗）不是 `lastErrorMs`：
 *    否則「壞了三天但剛剛才又失敗一次」會因為 lastErrorMs 很新而被判成健康。
 */
export function isScannerStalled(health: ScannerHealth, now: number = Date.now()): boolean {
  if (!health.failingSinceMs) return false
  return now - health.failingSinceMs >= SCANNER_STALE_MS
}

/**
 * 依「這次成功還是失敗」算出要寫回文件的 health 欄位；回 null＝不用寫（省下寫入）。
 *
 * 純函式：呼叫端只負責把回傳值 merge 進文件。
 */
export function nextScannerHealth(
  current: ScannerHealth,
  outcome: { ok: true } | { ok: false; error: unknown },
  now: number = Date.now(),
): ScannerHealth | null {
  if (outcome.ok) {
    // 本來就沒失敗過 → 不用寫（一路正常的帳號不該每 10 分鐘產生一次寫入）
    return current.failingSinceMs || current.lastErrorMs ? HEALTHY_SCANNER : null
  }
  return {
    lastErrorMs: now,
    lastError: String((outcome.error as Error)?.message ?? outcome.error ?? '').slice(0, 300),
    // 連續失敗只認第一次的時間，中間成功過會被上面那條清掉
    failingSinceMs: current.failingSinceMs || now,
  }
}
