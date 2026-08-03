import { isPreInboundFollowSession } from '~~/shared/types/conversation-stats'

/**
 * 「未首接」待處理佇列的單一口徑（側欄數字與側欄列表共用，避免兩邊各算各的）。
 *
 * ⚠️ 這裡是**佇列**口徑（「還需不需要人處理」），與統計看板的「未首接」
 *    （`initialHandler === 'unhandled'`，「有沒有人回答過」）**刻意不同**。
 *    兩個數字不一樣不是 bug——完整說明見 docs/CONVERSATION-STATS-DEFINITIONS.md。
 *
 * 佇列 = status 'open' 扣掉「活動／加好友出生、客人還沒開口」的 session。
 * 這個條件沒辦法直接下到 Firestore：舊資料沒有 origin／hasInbound 欄位，
 * 用 `hasInbound == true` 查會把它們一起弄消失（等值查詢不匹配缺欄位的文件）。
 * 所以列表端用 {@link isOpenQueueSession} 逐筆判斷，計數端用 `hasInbound == false` 扣除——
 * 兩者等價：hasInbound=false 只會跟 origin='follow' 一起寫入，缺欄位的舊資料兩邊都保留。
 */
export function isOpenQueueSession(data: { origin?: unknown; hasInbound?: unknown } | undefined): boolean {
  return !isPreInboundFollowSession(data)
}

/** 邊撈邊過濾時每輪抓幾筆（越大 round-trip 越少，但單輪讀取成本越高） */
const SCAN_BATCH = 300
/** 單次請求最多掃幾筆，防止過濾率極低時無限撈 */
const SCAN_MAX = 6000

/**
 * 帶「逐筆判斷」條件的分頁：游標往下撈，過濾後湊滿一頁才停。
 *
 * 為什麼不能直接 offset+limit 再過濾：那是「先切 30 筆、再砍掉不合格的」，
 * 每頁都會縮水（30 筆裡 27 筆被砍就只剩 3 筆），而且頁數與總數永遠對不上。
 * 這裡把過濾放在分頁之前，每頁就都是實打實的 limit 筆。
 */
export async function scanFilteredPage<T extends { data: () => any }>(
  baseQuery: {
    limit: (n: number) => any
  },
  keep: (data: any) => boolean,
  offset: number,
  limit: number,
): Promise<{ docs: T[]; hasMore: boolean; truncated: boolean }> {
  const docs: T[] = []
  let matched = 0
  let scanned = 0
  let cursor: T | null = null
  let exhausted = false

  while (docs.length < limit && scanned < SCAN_MAX) {
    let q = baseQuery.limit(SCAN_BATCH)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    const batch: T[] = snap.docs ?? []
    if (batch.length === 0) {
      exhausted = true
      break
    }
    scanned += batch.length
    cursor = batch[batch.length - 1]!

    // 整批掃完（不中途 break）：這樣 matched 才能反映「這一頁之後還有沒有」
    for (const d of batch) {
      if (!keep(d.data())) continue
      matched++
      if (matched > offset && docs.length < limit) docs.push(d)
    }

    if (batch.length < SCAN_BATCH) {
      exhausted = true
      break
    }
  }

  return {
    docs,
    // 這一批就已經看到超出本頁的合格筆數 → 確定還有；沒掃到底 → 也還有
    hasMore: matched > offset + docs.length || !exhausted,
    truncated: !exhausted && scanned >= SCAN_MAX,
  }
}

/** 佇列筆數：count(open) − count(open 且客人未開口)。索引缺失就不扣，寧可偏多也不炸頁。 */
export async function countOpenQueueSessions(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<number> {
  const base = db.collection('conversationSessions')
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'open')

  const openSnap = await base.count().get()
  const open = openSnap.data().count

  try {
    // 三個等值條件 Firestore 會自動合併單欄索引，免複合索引
    const preSnap = await base.where('hasInbound', '==', false).count().get()
    return Math.max(0, open - preSnap.data().count)
  }
  catch (e: any) {
    console.warn('[conversation-queue] pre-inbound subtract failed:', String(e?.message).slice(0, 120))
    return open
  }
}
