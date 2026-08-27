import type { Firestore, Query } from 'firebase-admin/firestore'
import { isPreInboundFollowSession } from '~~/shared/types/conversation-stats'
import { KPI_SESSION_FIELDS } from './conversation-stats-fields'
import { taipeiDateKey, taipeiDayEnd, taipeiDayStart } from '~~/shared/taipei-day'

/**
 * 對話統計的「日結」（`E-29`）。
 *
 * 為什麼要有：統計頁原本每次開頁都把區間內**每一場對話**翻出來現場數——MYFEEL 近 30 天
 * 2,014 場，而且要數三遍（本期 KPI／上期 KPI／趨勢圖）＝一次開頁約 6,000 筆讀取，
 * 那一頁「最後在等」的就是它自己（線上 2.9 秒）。改成每天結算一筆，查 30 天只讀 30 筆。
 * ⚠️（更正過的認知）這不是「不做會越來越慢」：查的是滾動區間，跟歷史累積無關；
 *    它只在對話量變大或使用者選 90 天時變慢。所以這件事的價值是「快」與「省讀取」，不是救火。
 *
 * ── 三條設計原則（動它之前先讀）──────────────────────────────
 *
 * ① **算式只有一份**：日結與現場算共用下面的 `foldSessionIntoDay`。分兩份寫的話，
 *    兩邊遲早算出不同的數字，而使用者只會看到「同一頁的數字自己會變」。
 *
 * ② **日結缺了就現場算**，所以最壞情況＝原本的行為（見 `loadDayStats`）。
 *    「今天」永遠現場算：今天還沒過完，數字本來就還在動。
 *
 * ③ **會被設定影響的東西不預先算**：轉真人等太久的門檻（`slaRemindMinutes`）與服務時間
 *    隨時可改。所以日結只存**原料**（每一筆轉真人的請求時間／真人第一次回的時間），
 *    門檻在讀取端才套。否則老闆把門檻從 30 分改成 60 分，歷史數字不會跟著更新，
 *    畫面上就會出現「同一段期間、兩種說法」。
 *    同理「還沒有人回」的那幾筆存 `repliedAtMs: null`，等待時間在讀取端用「現在」算
 *    ——它本來就會隨時間長大（客人確實還在等）。
 */

export const STATS_DAILY_COLLECTION = 'conversationStatsDaily'

/**
 * 日結格式版本。**改了算式或欄位就要 +1**：讀取端看到舊版本會當作沒有日結、
 * 改走現場算，然後由排程重建。這是唯一能保證「不會拿舊算式的數字混新算式」的閘門。
 */
export const ROLLUP_VERSION = 2

/** 一天的統計。欄位對得起 `TrendBucket` 與 KPI 卡的每一格 */
export interface DayStats {
  /** 台北日曆日 `YYYY-MM-DD` */
  date: string
  total: number
  bot: number
  ai: number
  human: number
  unhandled: number
  handoff: number
  closed: number
  /** AI 首接又轉真人（AI 表現頁的「全程搞定率」用） */
  aiEscalated: number
  /** 機器人首接又轉真人 */
  botEscalated: number
  /** 已結束**且**有人首接過（分子必須是「已處理」的子集，否則結案率會超過 100%） */
  closedHandled: number
  /** 這天加入的新朋友；`null`＝當時查不到（不可以當成 0，見 kpi 的 -1 語意） */
  newFriends: number | null
  /** 這天最早的 3 場「沒人回」——點名用（範圍內取最早 3 場＝各天最早 3 場裡再取最早 3 場） */
  unhandledSamples: { userId: string, openedAtMs: number }[]
  /** 這天每一筆轉真人的等待原料（門檻與服務時間在讀取端才套，見檔頭原則③） */
  handoffWaits: { userId: string, requestedAtMs: number, repliedAtMs: number | null, openedAtMs: number }[]
}

/**
 * 一天最多存幾筆轉真人原料。超過就標 `waitsTruncated`，讀取端會改成現場算那一天
 * ——寧可慢一點，也不要讓「等太久」的數字默默少算（同 `truncated` 的一貫做法）。
 */
const MAX_WAITS_PER_DAY = 300

export interface DailyStatsDoc extends DayStats {
  workspaceId: string
  version: number
  builtAt: number
  waitsTruncated: boolean
}

export function emptyDayStats(date: string): DayStats {
  return {
    date,
    total: 0,
    bot: 0,
    ai: 0,
    human: 0,
    unhandled: 0,
    handoff: 0,
    closed: 0,
    aiEscalated: 0,
    botEscalated: 0,
    closedHandled: 0,
    newFriends: null,
    unhandledSamples: [],
    handoffWaits: [],
  }
}

/**
 * 把一場對話折進某一天的統計。**這是唯一的算式**（日結與現場算共用）。
 *
 * ⛔ 活動／加好友出生、客人還沒開口的場不進統計（不算未首接、也不算首接）——
 *    呼叫端要先過 `isPreInboundFollowSession`，這裡不重複判斷（保持單一職責）。
 */
export function foldSessionIntoDay(day: DayStats, s: Record<string, any>): void {
  day.total++
  if (s.initialHandler === 'bot') day.bot++
  else if (s.initialHandler === 'ai') day.ai++
  else if (s.initialHandler === 'human') day.human++
  else day.unhandled++

  if (s.hasHandoff === true) day.handoff++
  if (s.status === 'closed') day.closed++
  if (s.initialHandler === 'ai' && s.hasHandoff === true) day.aiEscalated++
  if (s.initialHandler === 'bot' && s.hasHandoff === true) day.botEscalated++
  if (s.status === 'closed' && s.initialHandler !== 'unhandled') day.closedHandled++

  const openedAtMs = s.openedAt?.toMillis?.() ?? 0
  const userId = String(s.userId || '')

  if (s.initialHandler === 'unhandled') {
    day.unhandledSamples.push({ userId, openedAtMs })
    // 只留最早 3 筆：範圍再大也不會讓這個陣列長大
    day.unhandledSamples.sort((a, b) => a.openedAtMs - b.openedAtMs)
    if (day.unhandledSamples.length > 3) day.unhandledSamples.length = 3
  }

  const requestedAtMs = s.handoffRequestedAt?.toMillis?.()
  if (s.hasHandoff === true && requestedAtMs) {
    day.handoffWaits.push({
      userId,
      requestedAtMs,
      repliedAtMs: s.humanFirstRepliedAt?.toMillis?.() ?? null,
      openedAtMs,
    })
  }
}

/** 把一批對話場依台北日曆日折成各天的統計（現場算與日結都走這支） */
export function buildDaysFromSessions(sessions: Record<string, any>[]): Map<string, DayStats> {
  const days = new Map<string, DayStats>()
  for (const s of sessions) {
    const openedAt = s.openedAt?.toDate?.()
    if (!openedAt) continue
    if (isPreInboundFollowSession(s)) continue
    const key = taipeiDateKey(openedAt)
    let day = days.get(key)
    if (!day) {
      day = emptyDayStats(key)
      days.set(key, day)
    }
    foldSessionIntoDay(day, s)
  }
  return days
}

/** 把幾天加成一格（趨勢圖的週／月分桶、KPI 的整段區間都用這支） */
export function mergeDays(date: string, list: DayStats[]): DayStats {
  const out = emptyDayStats(date)
  // ⛔ 只要有一天查不到新朋友，整段就是「查不到」——補 0 會把缺資料講成「沒有人加入」
  const friendsUnavailable = list.some(d => d.newFriends === null)
  let friends = 0
  for (const d of list) {
    out.total += d.total
    out.bot += d.bot
    out.ai += d.ai
    out.human += d.human
    out.unhandled += d.unhandled
    out.handoff += d.handoff
    out.closed += d.closed
    out.aiEscalated += d.aiEscalated
    out.botEscalated += d.botEscalated
    out.closedHandled += d.closedHandled
    friends += d.newFriends ?? 0
    out.unhandledSamples.push(...d.unhandledSamples)
    out.handoffWaits.push(...d.handoffWaits)
  }
  out.newFriends = friendsUnavailable ? null : friends
  out.unhandledSamples.sort((a, b) => a.openedAtMs - b.openedAtMs)
  if (out.unhandledSamples.length > 3) out.unhandledSamples.length = 3
  return out
}

/** `YYYY-MM-DD` 的區間展開成每一天（含頭尾） */
export function taipeiDayKeysBetween(startDate: Date, endDate: Date): string[] {
  const keys: string[] = []
  // 逐日往前推：用台北日界線推，不用本機時區（見 taipei-day.ts 檔頭）
  let cursor = taipeiDayStart(taipeiDateKey(startDate))!.getTime()
  const last = taipeiDayStart(taipeiDateKey(endDate))!.getTime()
  while (cursor <= last) {
    keys.push(taipeiDateKey(new Date(cursor)))
    cursor += 24 * 3600_000
    // 台灣沒有日光節約，固定加一天不會漂
  }
  return keys
}

export function dailyDocId(workspaceId: string, date: string): string {
  return `${workspaceId}_${date}`
}

/** 今天的台北日曆日 */
export function todayTaipeiKey(now = new Date()): string {
  return taipeiDateKey(now)
}

function sessionQuery(db: Firestore, workspaceId: string, fromMs: number, toMs: number): Query {
  return db.collection('conversationSessions')
    .where('workspaceId', '==', workspaceId)
    .where('openedAt', '>=', new Date(fromMs))
    .where('openedAt', '<=', new Date(toMs))
    .select(...KPI_SESSION_FIELDS) as Query
}

/**
 * 這幾天各有幾位新朋友。
 *
 * ⛔ 用**一支**範圍查詢再分桶，不要一天一個 `count()`：後者查 30 天就是 30 趟往返
 *    （讀取數少一點，但延遲整整多 30 趟，退路會比原本更慢）。
 * 查不到時回空 Map → 那幾天的 `newFriends` 維持 `null`（＝「查不到」，不是 0）。
 */
async function friendsByDay(
  db: Firestore,
  workspaceId: string,
  dayKeys: string[],
): Promise<Map<string, number>> {
  const sorted = [...dayKeys].sort()
  const start = taipeiDayStart(sorted[0]!)
  const end = taipeiDayEnd(sorted[sorted.length - 1]!)
  const out = new Map<string, number>()
  if (!start || !end) return out
  try {
    const snap = await db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .where('createdAt', '>=', start)
      .where('createdAt', '<=', end)
      .select('createdAt')
      .get()
    for (const key of dayKeys) out.set(key, 0)
    for (const d of snap.docs) {
      const at = d.data().createdAt?.toDate?.()
      if (!at) continue
      const key = taipeiDateKey(at)
      if (out.has(key)) out.set(key, out.get(key)! + 1)
    }
    return out
  }
  catch (e) {
    // ⚠️ 索引方向要 users(workspaceId ASC, createdAt ASC)：這支沒有 orderBy，
    //    範圍條件隱含的排序是 ASC（歷史上這個數字曾因索引方向不對而一路回不出來）
    console.error('[stats-rollup] newFriends 查詢失敗', String((e as any)?.message).slice(0, 140))
    return new Map()
  }
}

/**
 * 現場算指定的那幾天（日結沒有／過期／是今天時走這條）。
 * 連續的日子併成一支查詢，不是一天一支——一天一支的話 30 天就是 30 趟往返。
 */
export async function liveBuildDays(
  db: Firestore,
  workspaceId: string,
  dayKeys: string[],
  opts: { withFriends?: boolean } = {},
): Promise<Map<string, DayStats>> {
  if (!dayKeys.length) return new Map()
  const sorted = [...dayKeys].sort()
  const fromMs = taipeiDayStart(sorted[0]!)!.getTime()
  const toMs = taipeiDayEnd(sorted[sorted.length - 1]!)!.getTime()

  const snap = await sessionQuery(db, workspaceId, fromMs, toMs).get()
  const built = buildDaysFromSessions(snap.docs.map(d => d.data()))

  // 要求的每一天都要有一格（那天沒有對話也是答案：0 場）
  const out = new Map<string, DayStats>()
  for (const key of dayKeys) out.set(key, built.get(key) ?? emptyDayStats(key))

  if (opts.withFriends) {
    const friends = await friendsByDay(db, workspaceId, dayKeys)
    // 查不到就維持 null（＝「查不到」）；查到了才寫數字，含 0
    for (const key of dayKeys) {
      if (friends.has(key)) out.get(key)!.newFriends = friends.get(key)!
    }
  }
  return out
}

/**
 * 取區間內每一天的統計：有日結就用日結，沒有／過期／是今天就現場算。
 *
 * 回傳 `liveDays` 讓呼叫端與測試看得出「這次有幾天是現場算的」——
 * 這是判斷日結有沒有真的生效的唯一方法（不然全部現場算也一樣安靜地正確）。
 */
export async function loadDayStats(
  db: Firestore,
  workspaceId: string,
  dayKeys: string[],
  opts: { now?: Date } = {},
): Promise<{ days: Map<string, DayStats>, liveDays: string[], rollupDays: string[] }> {
  if (!dayKeys.length) return { days: new Map(), liveDays: [], rollupDays: [] }

  const todayKey = todayTaipeiKey(opts.now)
  const days = new Map<string, DayStats>()
  const needLive: string[] = []
  const fromRollup: string[] = []

  // 今天一律現場算（今天還沒過完），其餘先看有沒有日結
  const lookupKeys = dayKeys.filter(k => k !== todayKey && k < todayKey)
  const futureOrToday = dayKeys.filter(k => k === todayKey || k > todayKey)

  let docs: Array<{ exists: boolean, data: () => any }> = []
  if (lookupKeys.length) {
    docs = await db.getAll(
      ...lookupKeys.map(k => db.collection(STATS_DAILY_COLLECTION).doc(dailyDocId(workspaceId, k))),
    ).catch((e) => {
      console.error('[stats-rollup] 讀日結失敗，整批改現場算', String((e as any)?.message).slice(0, 120))
      return []
    })
  }

  const byKey = new Map<string, any>()
  for (const d of docs) {
    if (!d.exists) continue
    const data = d.data()
    if (!data || data.version !== ROLLUP_VERSION || data.waitsTruncated) continue
    byKey.set(String(data.date), data)
  }

  for (const key of lookupKeys) {
    const data = byKey.get(key)
    if (!data) { needLive.push(key); continue }
    days.set(key, {
      date: key,
      total: data.total ?? 0,
      bot: data.bot ?? 0,
      ai: data.ai ?? 0,
      human: data.human ?? 0,
      unhandled: data.unhandled ?? 0,
      handoff: data.handoff ?? 0,
      closed: data.closed ?? 0,
      aiEscalated: data.aiEscalated ?? 0,
      botEscalated: data.botEscalated ?? 0,
      closedHandled: data.closedHandled ?? 0,
      newFriends: data.newFriends ?? null,
      unhandledSamples: Array.isArray(data.unhandledSamples) ? data.unhandledSamples : [],
      handoffWaits: Array.isArray(data.handoffWaits) ? data.handoffWaits : [],
    })
    fromRollup.push(key)
  }

  const liveKeys = [...needLive, ...futureOrToday]
  if (liveKeys.length) {
    const live = await liveBuildDays(db, workspaceId, liveKeys, { withFriends: true })
    for (const [k, v] of live) days.set(k, v)
  }

  return { days, liveDays: liveKeys, rollupDays: fromRollup }
}

// ── 排程：建立／更新日結 ──────────────────────────────────────

/** 每輪重算最近幾天：24 小時自動結束、客服補結案都會改到「開場那天」的數字 */
const REFRESH_TRAILING_DAYS = 3
/** 每輪另外挑一天更舊的重算（輪播），讓「三週後才被手動結案」這種也會自己修回來 */
const ROTATING_LOOKBACK_DAYS = 90
/** 一輪最多處理幾個工作區（其餘留給下一輪，見下方輪播） */
const MAX_WORKSPACES_PER_RUN = 4
/** 一輪最多補幾天缺的（新裝上線時慢慢補完，不要一次撐爆一輪） */
const MAX_BACKFILL_PER_RUN = 5
/**
 * 一輪最多做多久。
 *
 * ⛔ 這支掛在 `/api/cron/run-tasks`，那條路是**一個 HTTP 請求**、有閘道逾時
 * （`C-48` 就是被某一項拖太久害心跳沒寫到）。日結是「晚幾分鐘完全沒差」的工作，
 * 所以寧可做一半、下一輪（10 分鐘後）接著做，不要把整輪拖下水。
 */
const MAX_RUN_MS = 8_000

export async function rollupWorkspaceDays(
  db: Firestore,
  workspaceId: string,
  dayKeys: string[],
): Promise<number> {
  if (!dayKeys.length) return 0
  const days = await liveBuildDays(db, workspaceId, dayKeys, { withFriends: true })
  const batch = db.batch()
  let n = 0
  for (const key of dayKeys) {
    const day = days.get(key)
    if (!day) continue
    const doc: DailyStatsDoc = {
      ...day,
      handoffWaits: day.handoffWaits.slice(0, MAX_WAITS_PER_DAY),
      waitsTruncated: day.handoffWaits.length > MAX_WAITS_PER_DAY,
      workspaceId,
      version: ROLLUP_VERSION,
      builtAt: Date.now(),
    }
    batch.set(db.collection(STATS_DAILY_COLLECTION).doc(dailyDocId(workspaceId, key)), doc)
    n++
  }
  await batch.commit()
  return n
}

/**
 * 排程進來時做的事（掛在 `/api/cron/run-tasks`，10 分鐘一輪）：
 *   1. 最近 3 天重算（含昨天：24 小時自動結束會改到昨天的數字）
 *   2. 輪播一天更舊的重算（自我修復：三週後才手動結案的那種）
 *   3. 缺的日子補建（新裝上線時把過去 90 天補起來，一輪補 7 天，慢慢補完）
 *
 * ⚠️ 今天不建日結——今天還沒過完，讀取端一律現場算它。
 */
export async function rollupConversationStats(
  db: Firestore,
  now = new Date(),
): Promise<{ workspaces: number, days: number, stoppedEarly: boolean }> {
  const deadline = now.getTime() + MAX_RUN_MS
  const wsSnap = await db.collection('workspaces').select('name').get()
  const allIds = wsSnap.docs.map(d => d.id).sort()
  /**
   * 輪播工作區，⛔不要固定取前幾個：固定切的話帳號一旦超過上限，後面那幾個**永遠**
   * 不會被建日結——而且完全沒有徵兆（那些帳號的統計頁只是一直走現場算）。
   * 用時間當偏移，每 10 分鐘往後挪一格，所有帳號輪得到。
   */
  const slot = Math.floor(now.getTime() / (10 * 60_000))
  const offset = allIds.length ? (slot * MAX_WORKSPACES_PER_RUN) % allIds.length : 0
  const workspaceIds = allIds.length <= MAX_WORKSPACES_PER_RUN
    ? allIds
    : Array.from({ length: MAX_WORKSPACES_PER_RUN }, (_, i) => allIds[(offset + i) % allIds.length]!)

  const todayMs = taipeiDayStart(taipeiDateKey(now))!.getTime()
  const dayKeyAgo = (n: number) => taipeiDateKey(new Date(todayMs - n * 24 * 3600_000))

  // 輪播的那一天：用「距離台北紀元的天數」當種子，每輪往前挪一天（不需要存狀態）
  const rotation = slot % ROTATING_LOOKBACK_DAYS
  const rotatingDay = dayKeyAgo(Math.max(REFRESH_TRAILING_DAYS + 1, rotation))

  let total = 0
  let stoppedEarly = false
  for (const wid of workspaceIds) {
    if (Date.now() > deadline) { stoppedEarly = true; break }
    // 最近幾天 + 輪播那天
    const keys = new Set<string>()
    for (let i = 1; i <= REFRESH_TRAILING_DAYS; i++) keys.add(dayKeyAgo(i))
    keys.add(rotatingDay)

    // 缺的日子（過去 90 天內）：一輪最多補 7 天
    const wanted = Array.from({ length: ROTATING_LOOKBACK_DAYS }, (_, i) => dayKeyAgo(i + 1))
    const existing = await db.getAll(
      ...wanted.map(k => db.collection(STATS_DAILY_COLLECTION).doc(dailyDocId(wid, k))),
    ).catch(() => [])
    const have = new Set(
      existing.filter(d => d.exists && d.data()?.version === ROLLUP_VERSION).map(d => String(d.data()?.date)),
    )
    const missing = wanted.filter(k => !have.has(k)).slice(0, MAX_BACKFILL_PER_RUN)
    for (const k of missing) keys.add(k)

    total += await rollupWorkspaceDays(db, wid, [...keys].sort())
  }
  return { workspaces: workspaceIds.length, days: total, stoppedEarly }
}
