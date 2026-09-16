/**
 * 小幫手的請求節流（`C-31` Phase 2 地基）。
 *
 * 為什麼需要：問答小幫手到今天為止**沒有任何速率或費用閘門**——一句話會打 1~5 次模型，
 * 而它既沒有包進額度境域（`runWithLlmBudget`），端點也沒有節流。唯讀時代成本小到無所謂，
 * 但代辦上場後每句話會多跑預覽、多問一輪，按住 Enter 連送就是真的在燒錢。
 *
 * 性質：**best-effort**。模組級 Map 只在同一個暖啟動的 Lambda 實例內有效
 * （與 `leads.post.ts` 的 per-IP 節流同款）。真正的上限是額度境域那道（跨實例、看用量），
 * 這裡擋的是「同一個人連續猛按」這種手滑型浪費。
 */

const HITS = new Map<string, number[]>()

/** 超過幾筆就擋：一分鐘 12 句對正常使用綽綽有餘（打字都沒那麼快） */
export const AGENT_CHAT_WINDOW_MS = 60_000
export const AGENT_CHAT_MAX = 12

/** 防止長時間執行的實例把 Map 養胖：超過這個量就清掉過期的 key */
const CLEANUP_THRESHOLD = 500

/**
 * 記一次呼叫並回答「這次超過了沒」。
 * @param key 節流對象，慣例是 `${workspaceId}:${uid}`——一個人在 A 工作區猛按，不該影響他在 B 的操作
 */
export function hitAgentRateLimit(
  key: string,
  opts: { windowMs?: number, max?: number, now?: number } = {},
): { limited: boolean, retryAfterMs: number } {
  const windowMs = opts.windowMs ?? AGENT_CHAT_WINDOW_MS
  const max = opts.max ?? AGENT_CHAT_MAX
  const now = opts.now ?? Date.now()

  if (HITS.size > CLEANUP_THRESHOLD) {
    for (const [k, times] of HITS)
      if (!times.some(t => now - t < windowMs)) HITS.delete(k)
  }

  const recent = (HITS.get(key) ?? []).filter(t => now - t < windowMs)
  recent.push(now)
  HITS.set(key, recent)

  if (recent.length <= max) return { limited: false, retryAfterMs: 0 }
  // 最舊那一筆滾出視窗的時間＝還要等多久（如實回報，不要只說「稍後再試」）
  const oldest = recent[0]!
  return { limited: true, retryAfterMs: Math.max(0, windowMs - (now - oldest)) }
}

/** 測試用：清掉累積的計數 */
export function resetAgentRateLimit(): void {
  HITS.clear()
}
