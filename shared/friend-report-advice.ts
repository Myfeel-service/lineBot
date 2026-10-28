/**
 * 好友統計的「接下來該做什麼」（`D-155`）——照報告的事實套規則，⛔ 不用 LLM。
 *
 * ── 為什麼不讓 AI 寫建議 ─────────────────────────────────────────
 * 舊版的「一句話總結」證明了：模型手上只有數字，寫出來就是把數字再講一遍、最後補一句「建議多…」。
 * 這裡要的判斷（門檻、比較、挑最大）程式做得更準、可測、不花錢。AI 只在店家按了「幫我擬」之後
 * 寫推播文案（`server/utils/broadcast-copy-gen.ts`）——數字、對象、時機一個都不碰。
 *
 * ── 三種東西 ────────────────────────────────────────────────────
 * - **行銷提案**：最近有一群人表現出「想要」（興趣偏好分類的意圖標籤）→ 發給誰、為什麼、什麼時候
 * - **也要留意**：服務類訊號變多（例：退換貨）、推播那天封鎖變多／同一群人連著收打開變少
 * - **上次提案的成績**：從提案開的推播發出去之後，下一份報告回報
 *
 * ⛔ 每一條門檻都是常數＋測試；改門檻要連測試一起改，⛔ 不要散在畫面裡。
 */
import { fmt, lineDayOfMs, md, mdOfMs, blockBaseline, type FriendReportPayload, type IntentTagStat, type PushRow } from './friend-report'
import { isSkipped, type MarketingSkipMap } from './marketing-skips'
import { daysBetween } from './time'
import type { TaiwanFestival } from './taiwan-festivals'

/** 最近 30 天新增幾位以上才提案（MYFEEL 10-28：在看咖啡機 40、在看 AI 錄音耳機 25） */
export const PROPOSAL_MIN_RECENT = 10
/** 一次最多幾則提案（第 1 則展開、第 2 則收合）——多了就是清單，不是提案 */
export const PROPOSAL_MAX = 2
/** 這群人有一半以上 7 天內收過推播就不提：推播那天封鎖是平常的 3 倍，提案不能叫人連發 */
export const PUSHED_7D_SKIP_RATIO = 0.5
/** 檔期要在幾天之後、幾天之內才搭：太近來不及準備（萬聖節剩 3 天）、太遠不叫「接下來」 */
export const FESTIVAL_LEAD_MIN_DAYS = 5
export const FESTIVAL_LEAD_MAX_DAYS = 21

/** 服務類訊號：最近 30 天新增至少幾位、而且是前 30 天的幾倍以上才講 */
export const RISING_MIN_RECENT = 10
export const RISING_RATIO = 1.5

/** 推播那天封鎖數是平常的幾倍以上、而且至少幾位才講（平常 1 位、那天 2 位不算事） */
export const BLOCK_SPIKE_RATIO = 2
export const BLOCK_SPIKE_MIN = 5
/** 同一群人第二則：打開比例掉幾個百分點以上、兩則相隔幾天以內才講 */
export const OPEN_DROP_POINTS = 10
export const OPEN_DROP_MAX_GAP_DAYS = 14

const DAY = 86_400_000

// ═══════════════════════════════════════════════════════════════════
//  檔期
// ═══════════════════════════════════════════════════════════════════

/**
 * 提案要搭哪一檔：5～21 天後最近的那一檔，店家收起來的不算（`C-236`）。
 * 節日表＋店家自己的檔期由呼叫端合在一起傳進來。
 */
export function pickProposalFestival(
  festivals: readonly TaiwanFestival[],
  today: string,
  skips: MarketingSkipMap,
): { id: string, name: string, date: string } | null {
  const hit = [...festivals]
    .filter((f) => {
      const d = daysBetween(today, f.date)
      return d >= FESTIVAL_LEAD_MIN_DAYS && d <= FESTIVAL_LEAD_MAX_DAYS && !isSkipped(skips, f.id)
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))[0]
  return hit ? { id: hit.id, name: hit.name, date: hit.date } : null
}

// ═══════════════════════════════════════════════════════════════════
//  行銷提案
// ═══════════════════════════════════════════════════════════════════

export interface Proposal {
  tagId: string
  tagName: string
  members: number
  festival: { id: string, name: string, date: string } | null
  /** 例：雙 11 購物節前，發一則給「在看咖啡機」的 55 位 */
  title: string
  /** 發給誰：在看咖啡機 55 位，其中 22 位最近 30 天沒收過任何推播 */
  who: string
  /** 為什麼：最近 30 天新增 40 位，前 30 天 14 位；其中 7 位也有「問過價格優惠」 */
  why: string
  /** 什麼時候：雙 11 購物節（11/11）前 */
  when: string
}

/**
 * 跟這顆標籤一起出現最多的另外幾顆（最近 30 天都是新增的人）。
 * `onlyInterest`：提案只引用其他「興趣偏好」——⚠️ 2026-10-28 拿 MYFEEL 實跑，不篩的話「在看 AI 錄音耳機」
 * 的理由會寫出「4 位也有『回報過商品故障』」，把客訴當成推銷的理由。
 */
function pairsOf(p: FriendReportPayload, tagId: string, limit: number, onlyInterest = false): Array<{ name: string, users: number }> {
  const byId = new Map(p.intents.map(t => [t.tagId, t]))
  const out: Array<{ name: string, users: number }> = []
  // intentPairs 已照人數多到少排好
  for (const x of p.intentPairs) {
    if (x.a !== tagId && x.b !== tagId) continue
    const other = byId.get(x.a === tagId ? x.b : x.a)
    if (!other?.name || (onlyInterest && other.category !== 'interest')) continue
    out.push({ name: other.name, users: x.users })
    if (out.length >= limit) break
  }
  return out
}

function pushedTooRecently(t: IntentTagStat): boolean {
  return t.pushedWithin7d !== null && t.members > 0 && t.pushedWithin7d / t.members >= PUSHED_7D_SKIP_RATIO
}

function proposalCandidates(p: FriendReportPayload): IntentTagStat[] {
  return p.intents.filter(t => t.category === 'interest' && t.recent >= PROPOSAL_MIN_RECENT && t.members > 0)
}

/**
 * 挑哪幾群人提案：「興趣偏好」分類的意圖標籤、最近 30 天新增 ≥10 位，
 * 依最近新增多的優先（剛表現出想要的人最熱），7 天內大半收過推播的跳過。
 */
export function buildProposals(p: FriendReportPayload): Proposal[] {
  const festival = p.upcomingFestival
  return proposalCandidates(p)
    .filter(t => !pushedTooRecently(t))
    // intents 已經照「最近新增多的在前」排好；這裡再排一次，不靠上游
    .sort((a, b) => b.recent - a.recent || (b.notPushedRecent ?? 0) - (a.notPushedRecent ?? 0) || a.tagId.localeCompare(b.tagId))
    .slice(0, PROPOSAL_MAX)
    .map((t) => {
      const pairs = pairsOf(p, t.tagId, 2, true)
      const who = t.notPushedRecent === null
        ? `${t.name} ${fmt(t.members)} 位`
        : t.notPushedRecent === 0
          ? `${t.name} ${fmt(t.members)} 位，最近 30 天每一位都收過推播`
          : `${t.name} ${fmt(t.members)} 位，其中 ${fmt(t.notPushedRecent)} 位最近 30 天沒收過任何推播`
      const why = `最近 30 天新增 ${fmt(t.recent)} 位，前 30 天 ${fmt(t.prev)} 位`
        + (pairs.length ? `；其中 ${pairs.map(x => `${fmt(x.users)} 位也有「${x.name}」`).join('、')}` : '')
      return {
        tagId: t.tagId,
        tagName: t.name,
        members: t.members,
        festival,
        title: `${festival ? `${festival.name}前，` : ''}發一則給「${t.name}」的 ${fmt(t.members)} 位`,
        who,
        why,
        when: festival ? `${festival.name}（${md(festival.date)}）前` : '這週就可以',
      }
    })
}

/**
 * 沒有提案時講的那一句。⛔ 三種原因三句不同的話（沒標籤、量不夠、剛發過），不可以只寫「沒有提案」。
 */
export function proposalsEmptyText(p: FriendReportPayload): string {
  if (!p.intents.length) {
    return '還沒有標籤開 AI 判斷。開了之後，客人在對話裡表現出想要什麼會自動被貼上，這裡才提得出案。'
  }
  const recentlyPushed = proposalCandidates(p).filter(pushedTooRecently)
  if (recentlyPushed.length) {
    return `${recentlyPushed.map(t => `「${t.name}」`).join('、')}最近 7 天才收過推播，這次先不提案——同一群人連著收，封鎖的人會變多。`
  }
  return `最近 30 天沒有哪一群「興趣偏好」的人新增到 ${PROPOSAL_MIN_RECENT} 位以上，這次先不提案。`
}

// ═══════════════════════════════════════════════════════════════════
//  也要留意
// ═══════════════════════════════════════════════════════════════════

export interface WatchItem {
  kind: 'rising' | 'push'
  title: string
  why: string
  action: { type: 'users', tagId: string, label: string } | { type: 'pushes', label: string }
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

function audienceLabel(row: PushRow): string {
  if (row.audience.type === 'tags' && row.audience.tagNames.length) return `「${row.audience.tagNames.join('、')}」`
  if (row.audience.type === 'all') return '全部好友'
  return '同一群人'
}

/** 服務類訊號（不是興趣偏好的意圖標籤）變多最多的那一顆 */
function risingItem(p: FriendReportPayload): WatchItem | null {
  const ratio = (t: IntentTagStat) => (t.prev === 0 ? Number.POSITIVE_INFINITY : t.recent / t.prev)
  const hit = p.intents
    .filter(t => t.category !== 'interest' && t.recent >= RISING_MIN_RECENT && (t.prev === 0 || t.recent >= t.prev * RISING_RATIO))
    .sort((a, b) => ratio(b) - ratio(a) || b.recent - a.recent || a.tagId.localeCompare(b.tagId))[0]
  if (!hit) return null
  const pair = pairsOf(p, hit.tagId, 1)[0]
  return {
    kind: 'rising',
    title: `「${hit.name}」的人變多了`,
    why: `最近 30 天新增 ${fmt(hit.recent)} 位，前 30 天 ${fmt(hit.prev)} 位`
      + (pair ? `；其中 ${fmt(pair.users)} 位也有「${pair.name}」。` : '。'),
    action: { type: 'users', tagId: hit.tagId, label: `看這 ${fmt(hit.members)} 位` },
  }
}

/** 同一群人連著收、打開比例掉最多的那一則（口徑跟推播成效頁 `C-401` 同一支） */
function openDropSentence(pushes: readonly PushRow[]): string | null {
  let best: { drop: number, text: string } | null = null
  for (const row of pushes) {
    if (!row.prevOpen || row.opened === null || row.sent <= 0) continue
    const gap = Math.round((row.completedMs - row.prevOpen.completedMs) / DAY)
    if (gap > OPEN_DROP_MAX_GAP_DAYS) continue
    const rate = row.opened / row.sent
    const drop = (row.prevOpen.openRate - rate) * 100
    if (drop < OPEN_DROP_POINTS) continue
    if (!best || drop > best.drop) {
      const who = audienceLabel(row)
      // 「」後面不空格、一般字後面空一格再接數字（全站寫法：「最近 30 天」）
      best = {
        drop,
        text: `${who}${who.endsWith('」') ? '' : ' '}${gap} 天後收到第二則，打開的比例從 ${pct(row.prevOpen.openRate)} 掉到 ${pct(rate)}`,
      }
    }
  }
  return best?.text ?? null
}

function pushItem(p: FriendReportPayload): WatchItem | null {
  const pushes = p.pushes ?? []
  if (!pushes.length) return null
  const byDay = p.overview.line.blocksByDay
  const pushDays = new Set(pushes.map(x => lineDayOfMs(x.completedMs)))
  const baseline = blockBaseline(byDay, pushDays)
  const spikes = baseline !== null && baseline >= 1
    ? [...pushDays]
        .filter(d => byDay[d] !== undefined && byDay[d]! >= baseline * BLOCK_SPIKE_RATIO && byDay[d]! >= BLOCK_SPIKE_MIN)
        .sort()
        .slice(-3)
    : []
  const drop = openDropSentence(pushes)
  const action = { type: 'pushes' as const, label: '看各則推播' }

  if (spikes.length && baseline !== null) {
    const counts = spikes.map(d => byDay[d]!)
    const times = Math.round(Math.max(...counts) / baseline)
    const days = counts.every(c => c === counts[0])
      ? `${spikes.map(md).join('、')}${spikes.length > 1 ? ' 各' : ' '}封鎖 ${fmt(counts[0]!)} 位`
      : spikes.map(d => `${md(d)} 封鎖 ${fmt(byDay[d]!)} 位`).join('、')
    return {
      kind: 'push',
      title: `推播那天，封鎖的人是平常的 ${times} 倍`,
      why: `${days}，平常一天約 ${fmt(baseline)} 位。${drop ? `${drop}。` : ''}`,
      action,
    }
  }
  if (drop) return { kind: 'push', title: '同一群人連著收，打開的人變少了', why: `${drop}。`, action }
  return null
}

/** 也要留意：最多兩件（服務訊號、推播），沒有就整段不出現 */
export function buildWatchItems(p: FriendReportPayload): WatchItem[] {
  return [risingItem(p), pushItem(p)].filter((x): x is WatchItem => x !== null)
}

// ═══════════════════════════════════════════════════════════════════
//  上次提案的成績
// ═══════════════════════════════════════════════════════════════════

/**
 * 最近 30 天照提案發的那一則（最近的一則）的成績，跟其他推播比。
 * ⛔ 沒照著發不追問、不記成「忽略」——發不發是店家的判斷，不是我們的指標。
 * ⛔ 不寫預估：還沒有可以比的推播時，用問卷名單的比例去推會誤導。
 */
export function proposalOutcomeText(p: FriendReportPayload): string | null {
  const pushes = p.pushes ?? []
  const mine = pushes.find(x => x.proposalTagId)
  if (!mine) return null
  const head = `上次照提案發的「${mine.name}」（${mdOfMs(mine.completedMs)}）`
  if (mine.opened === null) return `${head}：LINE 還沒給打開人數，發完隔天才有。`
  const parts = [`打開 ${pct(mine.opened / mine.sent)}`]
  if (mine.clicked !== null) parts.push(`點連結 ${pct(mine.clicked / mine.sent)}`)
  const others = pushes.filter(x => !x.proposalTagId && x.opened !== null && x.sent > 0).map(x => x.opened! / x.sent)
  let tail = ''
  if (others.length) {
    const lo = pct(Math.min(...others))
    const hi = pct(Math.max(...others))
    tail = `；最近 30 天其他推播打開 ${lo === hi ? lo : `${lo}–${hi}`}`
  }
  return `${head}：${parts.join('、')}${tail}。`
}
