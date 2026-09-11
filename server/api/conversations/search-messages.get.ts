import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  MESSAGE_SEARCH_MIN_CHARS,
  messageSearchMatches,
  messageSearchSnippet,
  normalizeMessageSearchText,
  pickMessageSearchToken,
  type MessageSearchSnippet,
} from '~~/shared/message-search'
import { MESSAGE_SEARCH_STATE_COLLECTION, type MessageSearchIndexState } from '~~/shared/message-search-state'

const DISPLAY_FALLBACK = 'LINE 用戶'

/**
 * 一次搜尋最多讀幾則候選訊息＝這支端點的讀取量上限。
 *
 * 候選 = 「含有查詢片段」的訊息（見 shared/message-search.ts），不是全部訊息。關鍵字
 * 稍微具體一點（「退貨」「洗衣機」）候選通常只有幾十則，這個上限碰不到；碰到的是
 * 「訂單」這種每天都在講的字，那時**由新到舊**取前 500 則、並把 truncated 帶回去明講
 * 「更早的沒找過」——不可以靜靜只給一部分。
 */
const SCAN_LIMIT = 500

/** 結果最多列幾位客人（側欄是 239px，超過這個數字沒有人會往下翻） */
const MAX_RESULT_CONVERSATIONS = 40

type SearchRow = {
  /** conversations / users 的文件 id（含 workspace 前綴），點進去就是這條對話 */
  userId: string
  displayName: string
  pictureUrl: string
  /** 命中的那一則：畫面要用它跳到對話裡的那個位置 */
  messageId: string
  timestamp: unknown
  direction: 'incoming' | 'outgoing'
  /** 這次掃描範圍內，這位客人有幾則命中（truncated 時是下限） */
  matchCount: number
  snippet: MessageSearchSnippet
}

/**
 * GET /api/conversations/search-messages
 *
 * 「哪一位客人講過這句話」——對話**內容**搜尋。名字搜尋走 list.get.ts，兩者分開：
 * 名字是掃 users 一趟查詢就完事（見那支的說明），內容要走片段索引，
 * 涵蓋範圍與失敗模式都不一樣，混在同一支裡只會讓兩邊都說不清自己漏了什麼。
 *
 * Query：q（關鍵字，至少兩個字）
 * Response：{ status, rows, scanned, truncated, oldestScannedMs, backfill }
 *
 * status 刻意分三態，因為「沒有結果」下一步完全不同：
 *   · ok         → 真的找完了（在 scanned / backfill 說明的範圍內）
 *   · too_short  → 關鍵字只有一個字，這條路走不了（不是沒有結果）
 *   · unavailable→ 索引還沒部署到這個專案 → 整個功能不能用，要有人去部署
 * 少了這個分型，三種情況在畫面上都長成「無符合結果」，而那是說謊。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const keyword = normalizeMessageSearchText(String(getQuery(event).q ?? ''))
  const db = getDb()

  /**
   * 舊訊息有沒有補過片段（回填腳本跑完才會寫這份狀態，見
   * scripts/backfill-message-search-tokens.ts）。
   *
   * ⛔ 一定要回報：片段是這次改版才開始寫的，沒回填的話搜尋只找得到上線後的新訊息。
   * 不講的話客服搜不到上個月那句話，會以為「搜尋壞了」或更糟——以為客人沒講過。
   */
  const stateSnap = await db.collection(MESSAGE_SEARCH_STATE_COLLECTION).doc(workspaceId).get().catch(() => null)
  const state = (stateSnap?.data() ?? null) as MessageSearchIndexState | null
  const backfill = {
    done: Boolean(state?.completedAt),
    /** 回填涵蓋到的最舊訊息時間（0＝不知道／還沒回填） */
    indexedFromMs: Number(state?.oldestIndexedMs ?? 0) || 0,
  }

  const token = pickMessageSearchToken(keyword)
  if ([...keyword].length < MESSAGE_SEARCH_MIN_CHARS || !token) {
    return {
      status: 'too_short' as const,
      rows: [] as SearchRow[],
      scanned: 0,
      truncated: false,
      oldestScannedMs: 0,
      backfill,
    }
  }

  let docs: FirebaseFirestore.QueryDocumentSnapshot[]
  try {
    const snap = await db.collectionGroup('messages')
      .where('workspaceId', '==', workspaceId)
      .where('searchTokens', 'array-contains', token)
      .orderBy('timestamp', 'desc')
      .limit(SCAN_LIMIT + 1)
      // 只取比對與顯示要用的欄位：payload 裡有整包 LINE 訊息（Flex 可以上百 KB），
      // 搜尋一次搬 500 份回來純粹是白花的流量
      .select('text', 'mediaDescription', 'direction', 'timestamp')
      .get()
    docs = snap.docs
  }
  catch (e: unknown) {
    /**
     * 多半是複合索引還沒部署到這個 Firebase 專案（索引是逐專案手動部署的，
     * 見 reference_firestore_index_deploy）。
     *
     * ⛔ 不可以 catch 完回空陣列：那會變成「對話內容裡沒有這句話」——一個完全錯誤的答案，
     * 而且畫面上看不出功能其實整個沒在跑。回 unavailable 讓畫面說實話。
     */
    console.error(
      `[search-messages] 內容搜尋查不了（${workspaceId}，多半是 messages 的 collection-group 索引未部署）：`,
      String((e as Error)?.message ?? e).slice(0, 300),
    )
    return {
      status: 'unavailable' as const,
      rows: [] as SearchRow[],
      scanned: 0,
      truncated: false,
      oldestScannedMs: 0,
      backfill,
    }
  }

  const truncated = docs.length > SCAN_LIMIT
  const scanned = truncated ? docs.slice(0, SCAN_LIMIT) : docs
  const oldestScannedMs = truncated
    ? timestampMillis(scanned[scanned.length - 1]?.data().timestamp)
    : 0

  /**
   * 片段查詢只是把候選縮小，這裡才判「算不算命中」：片段是兩個字一組，
   * 搜「退貨流程」時只用其中一組去查，所以回來的候選有一部分只含那兩個字。
   */
  const byConversation = new Map<string, SearchRow>()
  let droppedOtherWorkspace = 0
  for (const doc of scanned) {
    const convDocId = doc.ref.parent.parent?.id ?? ''
    // 防線而非主要條件（主要靠 workspaceId）：訊息上的 workspaceId 是這次改版才加的，
    // 回填漏掉或寫錯時不該把別家的對話端到這一家的畫面上
    if (!convDocId || !convDocId.startsWith(`${workspaceId}_`)) {
      droppedOtherWorkspace += 1
      continue
    }
    const data = doc.data()
    const text = String(data.text ?? '')
    const mediaDescription = String(data.mediaDescription ?? '')
    if (!messageSearchMatches(keyword, [text, mediaDescription])) continue

    const existing = byConversation.get(convDocId)
    if (existing) {
      existing.matchCount += 1
      continue
    }
    if (byConversation.size >= MAX_RESULT_CONVERSATIONS) continue
    byConversation.set(convDocId, {
      userId: convDocId,
      displayName: '',
      pictureUrl: '',
      messageId: doc.id,
      timestamp: data.timestamp ?? null,
      direction: data.direction === 'outgoing' ? 'outgoing' : 'incoming',
      matchCount: 1,
      // 摘要以命中的字為中心（見 messageSearchSnippet）：訊息開頭多半是「你好 想請問」，
      // 拿開頭當摘要會讓每一列長得一樣，看不出自己為什麼搜到這一列
      snippet: messageSearchSnippet(text || mediaDescription, keyword),
    })
  }
  if (droppedOtherWorkspace > 0) {
    console.warn(`[search-messages] 有 ${droppedOtherWorkspace} 則候選的 workspaceId 與文件路徑不一致，已排除（${workspaceId}）`)
  }

  // 名字不在訊息上（存在 users），照編號讀命中的那幾位就好
  const rows = [...byConversation.values()]
  if (rows.length) {
    const userSnaps = await db.getAll(...rows.map(r => db.collection('users').doc(r.userId)))
    const userById = new Map(userSnaps.map(s => [s.id, s.data() ?? {}] as const))
    for (const row of rows) {
      const user = userById.get(row.userId) ?? {}
      row.displayName = String(user.displayName || '').trim() || DISPLAY_FALLBACK
      row.pictureUrl = String(user.pictureUrl || '').trim()
    }
  }

  return {
    status: 'ok' as const,
    rows,
    /** 這次讀了幾則候選（truncated 時等於 SCAN_LIMIT） */
    scanned: scanned.length,
    truncated,
    oldestScannedMs,
    backfill,
  }
})

/** Firestore 時間欄位 → 毫秒（讀不出來就 0） */
function timestampMillis(v: unknown): number {
  const ts = v as { toMillis?: () => number } | null
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0
}
