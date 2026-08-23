/**
 * 洞察週報——「本週顧客觀察」（D-25 第二階，CRM-EVAL-20260822 發想二）。
 *
 * 每週一搭在每日客服摘要**同一則** LINE 訊息裡（同節慶提醒的掛法，不另發一則），
 * 講三件店家聽得懂、而且立刻有下一步的觀察：
 *   1. 這週被貼最多的標籤（tagLogs 聚合）——「大家最近在問什麼」的代理指標
 *   2. 待處理的 AI 標籤建議數——收件匣的每週提醒（列表那顆章的補強，不是取代）
 *   3. 上月有來訊、最近兩週安靜下來的客人數——沉睡前的最後窗口
 *
 * 設計約束：
 * - **只講有資料的觀察**：全部為零就整段不出現（return null），不硬湊一段空話——
 *   D-25 的信任要靠「它的觀察常常是對的」累積，空話只會教店家忽略它。
 * - **查詢排在所有便宜閘門之後**（見 dailyBacklogDigest 的呼叫點）：只有真的要發的
 *   帳號、而且是週一，才花這 3~4 個查詢。
 * - 不帶網址、用文字指路（「好友頁勾『只看有 AI 建議的』」）——每日摘要的既有慣例。
 * - tagLogs 聚合需要複合索引 (workspaceId, action, createdAt)，見 firestore.indexes.json。
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { INACTIVE_TAG_CODE } from './inactive-tag'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/** 本週 tagLogs 取樣上限：超過就講明是取樣（批次貼標一次幾千筆的週會撞到） */
const TAG_LOG_SCAN_LIMIT = 1000
/** 「被貼最多」列前幾名 */
const TOP_TAGS = 3

/** 今天（台北日期字串 YYYY-MM-DD）是不是週一——週報只在週一附上 */
export function isTaipeiMonday(taipeiDateStr: string): boolean {
  // 日期字串不含時區 → Date 當 UTC 午夜解析，getUTCDay 恰好就是那個「日曆日」的星期幾
  return new Date(`${taipeiDateStr}T00:00:00Z`).getUTCDay() === 1
}

/**
 * 統計窗口＝**台北日曆週**（上週一 00:00 ～ 本週一 00:00），不是「發送當下往回 7×24 小時」。
 *
 * 為什麼（G-22①）：滾動窗口的數字跟發送時刻綁在一起——同一週不同時間重算會漂、
 * 跟後台對帳對不起來，而且標題「8/17–8/24」橫跨八個日曆日看起來就錯。
 * 日曆週＝可重現、可解釋，標題顯示「8/17–8/23」（週一到週日）。
 */
export function weeklyWindow(taipeiToday: string): { startMs: number; endMs: number; rangeText: string } {
  const endMs = Date.parse(`${taipeiToday}T00:00:00+08:00`) // 本週一台北 00:00（不含）
  const startMs = endMs - WEEK_MS
  return { startMs, endMs, rangeText: `${taipeiMd(startMs)}–${taipeiMd(endMs - DAY_MS)}` }
}

/** 純聚合（可測）：一週的貼標紀錄 → 各標籤次數，多到少排序、同數量照首次出現順序 */
export function aggregateTagAdds(tagIds: string[]): Array<{ tagId: string; count: number }> {
  const counts = new Map<string, number>()
  for (const raw of tagIds) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tagId, count]) => ({ tagId, count }))
    .sort((a, b) => b.count - a.count)
}

export interface WeeklyInsightInput {
  /** 「8/17–8/23」這種區間字樣 */
  rangeText: string
  /** 本週被貼最多的一般標籤（已排除系統的「沒互動」標） */
  topTags: Array<{ name: string; count: number }>
  /** 本週被標成「沒互動」的人數與標籤名（0＝不講） */
  inactiveAdds: { count: number; name: string }
  /** 待處理 AI 標籤建議的客人數 */
  pendingSuggestUsers: number
  /** 上月有來訊、最近兩週安靜的客人數 */
  quietDown: number
  /** tagLogs 撞到取樣上限（要講明，否則「+1,000」會被當成精確值） */
  truncated: boolean
}

/**
 * 純格式化（可測）：組出週報段落。**全部觀察都是零 → null**（整段不出現）。
 * 第一行是段落標題，呼叫端直接接在摘要後面（前面補一個空行隔開）。
 */
export function formatWeeklyInsightLines(input: WeeklyInsightInput): string[] | null {
  const lines: string[] = []

  // ⛔ 指路一律用**側欄的名字**（「好友」「AI 設定」）——人是拿著訊息對照側欄找的，
  //    寫「好友頁」這種頁面別名會找不到（G-22③：同一頁曾有三個名字）
  if (input.topTags.length) {
    const parts = input.topTags.map(t => `「${t.name}」+${t.count} 位`).join('、')
    lines.push(`・這週被貼最多的標籤：${parts}——後台「好友」頁可依標籤篩出名單`)
  }
  if (input.inactiveAdds.count > 0) {
    lines.push(`・${input.inactiveAdds.count} 位客人這週被標成「${input.inactiveAdds.name}」——想喚醒他們，發推播時選這個標籤`)
  }
  if (input.pendingSuggestUsers > 0) {
    lines.push(`・${input.pendingSuggestUsers} 位客人的 AI 標籤建議還沒看——後台「好友」頁勾「只看有 AI 建議的」`)
  }
  if (input.quietDown > 0) {
    // 文案跟資料窗口一字不差（14~28 天前，不是日曆上個月）＋這一行也要有下一步（G-22②④）
    lines.push(`・最近一個月內有來訊、但兩週沒再出現的客人：${input.quietDown} 位——想提早喚醒，到「AI 設定」把「沒互動」天數調低，就能用標籤把他們撈出來發推播`)
  }

  if (!lines.length) return null
  if (input.truncated) lines.push(`・（標籤統計為本週前 ${TAG_LOG_SCAN_LIMIT.toLocaleString('en-US')} 筆取樣）`)
  return [`📈 本週顧客觀察（${input.rangeText}）`, ...lines]
}

function taipeiMd(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

/**
 * 查資料＋組段落。回 null＝這週沒有值得講的（或查詢失敗——由呼叫端 catch，
 * 週報壞了不准拖垮每日摘要本體）。
 *
 * @param taipeiToday 台北日期字串（發送日＝週一）；窗口錨定在它的 00:00，同一週怎麼重算都一樣
 */
export async function buildWeeklyInsights(
  db: Firestore,
  workspaceId: string,
  taipeiToday: string,
): Promise<string[] | null> {
  const { startMs, endMs, rangeText } = weeklyWindow(taipeiToday)
  const [logSnap, pendingSuggestUsers, quietDown] = await Promise.all([
    db.collection('tagLogs')
      .where('workspaceId', '==', workspaceId)
      .where('action', '==', 'add')
      .where('createdAt', '>=', Timestamp.fromMillis(startMs))
      .where('createdAt', '<', Timestamp.fromMillis(endMs))
      .limit(TAG_LOG_SCAN_LIMIT)
      .select('tagId')
      .get(),
    // count 聚合：不論命中幾筆都只計 1 次讀取。
    // 「還沒看的建議」是**現在的狀態**不是週統計，刻意不套窗口——套了反而說謊
    db.collection('userTagSuggestions')
      .where('workspaceId', '==', workspaceId)
      .where('hasPending', '==', true)
      .count().get().then(s => s.data().count)
      .catch(() => 0),
    // 「最近一個月內有來訊、但兩週沒再出現」：最後來訊落在 [週界-28天, 週界-14天) 的對話數。
    // 錨定週界＝同一週重算數字不漂。lastInboundMessageAt 是 08-19 起才有的欄位 →
    // 這個窗口要到 9 月初才開始有值，在那之前自然為 0＝這一條整週不出現（誠實的漸進）
    db.collection('conversations')
      .where('workspaceId', '==', workspaceId)
      .where('lastInboundMessageAt', '>=', Timestamp.fromMillis(endMs - 28 * DAY_MS))
      .where('lastInboundMessageAt', '<', Timestamp.fromMillis(endMs - 14 * DAY_MS))
      .count().get().then(s => s.data().count)
      .catch(() => 0),
  ])

  const counted = aggregateTagAdds(logSnap.docs.map(d => String(d.data()?.tagId ?? '')))

  // 前幾名抓寬一點再解析名稱：排除掉「沒互動」系統標之後要仍湊得滿 TOP_TAGS 名
  const headIds = counted.slice(0, TOP_TAGS + 3).map(c => c.tagId)
  const tagSnaps = headIds.length
    ? await db.getAll(...headIds.map(id => db.collection('tags').doc(id)))
    : []
  const meta = new Map(tagSnaps.filter(s => s.exists).map(s => [
    s.id,
    { name: String(s.data()?.name ?? ''), code: String(s.data()?.code ?? '') },
  ]))

  const topTags: Array<{ name: string; count: number }> = []
  const inactiveAdds = { count: 0, name: '' }
  for (const c of counted) {
    const m = meta.get(c.tagId)
    if (!m) continue // 已刪掉的標籤或排名太後沒解析——不猜名字
    if (m.code === INACTIVE_TAG_CODE) {
      // 「沒互動」是系統標，混進「被貼最多」會蓋掉真正的主題訊號，單獨一行講
      inactiveAdds.count = c.count
      inactiveAdds.name = m.name
      continue
    }
    if (topTags.length < TOP_TAGS && m.name) topTags.push({ name: m.name, count: c.count })
  }

  return formatWeeklyInsightLines({
    rangeText,
    topTags,
    inactiveAdds,
    pendingSuggestUsers,
    quietDown,
    truncated: logSnap.size >= TAG_LOG_SCAN_LIMIT,
  })
}
