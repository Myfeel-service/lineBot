/**
 * 推播成效頁「跟上一則發給同一群人的比」（`D-154`①，2026-10-28 老闆拍板）。
 *
 * ── 為什麼 ─────────────────────────────────────────────────────
 * LINE 不給「哪位客人打開了」，只給每則幾個人打開。單看一則的打開比例看不出好壞；
 * 跟上一則發給同一群人的比，才看得出「同一群人連著收，打開的人變少了」——
 * MYFEEL 小滑手開賣 9/29 打開 35.94%，5 天後同一群人收超早鳥倒數只剩 21.52%。
 *
 * ── 口徑 ──────────────────────────────────────────────────────
 * - 「同一群人」＝同一種挑法、同一組標籤（順序不論）。標籤裡的人會進出，所以送出人數不會一模一樣，
 *   但店家挑的是同一群。⛔ 匯入名單每次都是另一份，一律不算同一群。
 * - 「上一則」＝比這則早發完、發給同一群人的裡面**最近的那一則**。
 *   ⛔ 那一則沒有打開數（太少人 LINE 不給、當時沒帶到統計標記…）就不比，**不往前找更早的**——
 *   畫面講的是「上一則」，跳過去拿更早的來比就是講錯。
 * - 上一則用的是發完後存下來的數字（`lineStats`，發完第 1／3／7 天各存一次，見 broadcast-line-stats.ts）。
 *   打開的人會隨天數變多，所以發完還不到 7 天的要講一聲，不然剛發完那天看起來一定「掉很多」。
 */
import type { BroadcastAudienceSource } from './types/tag-broadcast'

const DAY = 86_400_000
/** LINE 打開數存到第 7 天就不再變（`LINE_STATS_ROUND_DAYS` 最後一輪） */
const FINAL_DAYS = 7

export type AudienceLike = Partial<Pick<BroadcastAudienceSource, 'type' | 'tagIds' | 'audienceId'>> | null | undefined

/** 這種挑法有沒有「同一群人」可言（匯入名單沒有：每次都是另一份） */
export function audienceComparable(a: AudienceLike): boolean {
  if (!a?.type) return false
  if (a.type === 'all') return true
  if (a.type === 'tags') return Array.isArray(a.tagIds) && a.tagIds.length > 0
  if (a.type === 'audience') return Boolean(a.audienceId)
  return false
}

/** 兩則推播是不是發給「同一群人」 */
export function sameBroadcastAudience(a: AudienceLike, b: AudienceLike): boolean {
  if (!audienceComparable(a) || !audienceComparable(b) || a!.type !== b!.type) return false
  if (a!.type === 'all') return true
  if (a!.type === 'audience') return a!.audienceId === b!.audienceId
  const x = new Set(a!.tagIds)
  const y = new Set(b!.tagIds)
  return x.size === y.size && [...x].every(t => y.has(t))
}

export interface PreviousOpenCandidate {
  id: string
  name: string
  status: string
  audienceSource: AudienceLike
  sentCount: number
  /** 存下來的 LINE 打開人數；沒有＝null */
  opened: number | null
  completedMs: number | null
}

export interface PreviousOpen {
  name: string
  completedMs: number
  opened: number
  sentCount: number
  /** opened ÷ sentCount，四位小數（跟成效頁的 openRate 同一個寫法） */
  openRate: number
}

/**
 * 只有真的送出去、而且送到人的推播才算數（跟存 LINE 數字的排程同一條）。
 * ⛔ 好友統計（`shared/friend-report.ts`）也吃這一支，不要再抄一份——兩份規則會漂開（`C-404`）。
 */
export function wasSent(c: { status: string, sentCount: number }): boolean {
  return (c.status === 'completed' || c.status === 'failed') && c.sentCount > 0
}

/** 找上一則發給同一群人的推播（口徑見檔頭）。沒有、或那一則沒有打開數＝null */
export function pickPreviousSameAudience(
  current: { id: string; audienceSource: AudienceLike; completedMs: number },
  candidates: PreviousOpenCandidate[],
): PreviousOpen | null {
  let latest: PreviousOpenCandidate | null = null
  for (const c of candidates) {
    if (c.id === current.id || !wasSent(c) || c.completedMs == null) continue
    if (c.completedMs >= current.completedMs) continue
    if (!sameBroadcastAudience(current.audienceSource, c.audienceSource)) continue
    if (!latest || c.completedMs > latest.completedMs!) latest = c
  }
  if (!latest || latest.opened == null) return null
  return {
    name: latest.name,
    completedMs: latest.completedMs!,
    opened: latest.opened,
    sentCount: latest.sentCount,
    openRate: Math.round((latest.opened / latest.sentCount) * 10000) / 10000,
  }
}

/**
 * 成效頁「打開的比例」底下那一句。
 * 例：上一則發給同一群人的「小滑手_開賣」（9/29）是 35.94%，這則少了 14 個百分點。
 */
export function describeOpenRateChange(input: {
  prev: PreviousOpen
  currentRate: number
  currentCompletedMs: number | null
  nowMs: number
  formatRate: (rate: number) => string
  formatDate: (ms: number) => string
}): string {
  const { prev, currentRate, currentCompletedMs, nowMs, formatRate, formatDate } = input
  const points = Math.round((currentRate - prev.openRate) * 100)
  const change = points <= -1
    ? `這則少了 ${-points} 個百分點。`
    : points >= 1
      ? `這則多了 ${points} 個百分點。`
      : '這則差不多。'
  let text = `上一則發給同一群人的「${prev.name}」（${formatDate(prev.completedMs)}）是 ${formatRate(prev.openRate)}，${change}`

  const young = (ms: number | null) => ms != null && nowMs - ms < FINAL_DAYS * DAY
  // 上一則比這則早發完：上一則還不到 7 天，這則一定也還不到
  if (young(prev.completedMs)) text += `兩則發完都還不到 ${FINAL_DAYS} 天，數字還會再變。`
  else if (young(currentCompletedMs)) text += `這則發完還不到 ${FINAL_DAYS} 天，打開的人還會再多一些。`
  return text
}
