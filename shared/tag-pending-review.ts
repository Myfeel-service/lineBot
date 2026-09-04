/**
 * 「一次審一顆標籤」的純邏輯（`D-61`）。
 *
 * 為什麼要有這一頁：標籤頁的「待審 N 位」先前是連到好友頁的收件匣，而那頁**列的是
 * 全部有建議的客人、不分標籤**（`D-42` 拍板的簡單版，users.vue 裡還留著一段跟人道歉的
 * 說明文字）。於是「待審 34 位」點進去看到 64 位，要處理那 34 條得一位一位開抽屜——
 * 09-04 線上 116 條積壓沒有人清得完，這就是原因。
 *
 * 這支只放**不碰資料庫的那一半**，讓「挑出這顆的待審」與「結果怎麼講」兩件事測得到。
 */

/**
 * 一次最多掃幾份收件匣文件。
 *
 * ⛔ **必須跟 `/api/tag/pending-counts` 用同一個值**（那支的「待審 N 位」與這支的清單
 * 是同一批資料的兩種呈現）：兩邊掃描深度不同的話，badge 寫 34、點進去列出 30，
 * 而且沒有任何東西說得出少的那 4 條在哪——所以常數放在這裡讓兩支一起 import。
 */
export const PENDING_SCAN_LIMIT = 500

/** 一次最多回傳幾列（畫面要能一次看完；超過的要講出來，不可以靜靜截斷） */
export const PENDING_ROWS_LIMIT = 200

/** 一次批次處理幾位客人（後端硬上限，避免一個請求跑到逾時） */
export const PENDING_BULK_LIMIT = 100

export interface PendingReviewRow {
  /** users 主鍵：`${workspaceId}_${lineUserId}` */
  userId: string
  /** 顯示名稱；⛔ 查不到就空字串，不要拿 userId 充數（見 fetchUserDisplayNames） */
  displayName: string
  /** AI 寫的那一句依據（30 字內）。舊資料可能是空的 */
  reason: string
  /** 產生這條建議的那一場對話；舊資料沒有就 null（別給會跑錯地方的連結） */
  sessionId: string | null
  /** 建議產生時間；0＝舊資料沒記，畫面要講「時間不明」不要顯示 1970 */
  suggestedAtMs: number
}

interface RawSuggestionDoc {
  /** 文件 id＝users 主鍵 */
  id: string
  pending?: Array<{ tagId?: string, reason?: string, sessionId?: string | null, suggestedAtMs?: number }> | null
}

/**
 * 從「一位客人一份」的收件匣文件裡，挑出**這一顆標籤**的待審清單。
 *
 * 排序＝最舊的排前面（等最久的先處理）。⛔ 沒有時間的舊資料排在最後、不假裝它很舊：
 * 把 0 當成「1970 年」會讓一批時間不明的東西霸佔清單頂端。
 *
 * ⛔ 撞到 `max` 要回報丟了幾筆（`feedback_filters_must_report_what_they_dropped`）：
 * 靜靜截斷的話，畫面看起來就是「這顆只有這麼多人在等」。
 */
export function pickPendingForTag(
  docs: RawSuggestionDoc[],
  tagId: string,
  max: number = PENDING_ROWS_LIMIT,
): { rows: PendingReviewRow[], dropped: number } {
  /**
   * ⛔ 比對前要 trim、而且**以客人為單位去重**——這兩件事都是為了跟徽章對得起來。
   *
   * 徽章那支（`aggregatePendingByTag`）做的就是這兩件事，它的註解寫著
   * 「數字的單位必須跟文案一致，不能靠上游保證」。這裡漏做的話：
   *  · 某筆的 tagId 存成 `' t_ship'` → 徽章算它、清單漏它（34 vs 33，而且沒有人說得出少的是誰）
   *  · 同一位客人同一顆有兩條 → 徽章算 1 人、清單列 2 列（畫面 key 重複、
   *    送兩份重複的查詢，標題「N 位等你決定」數的變成筆數不是人數）
   * 同一位有多條時留**最舊的那一條**（等最久的資訊才是這張清單要呈現的）。
   */
  const wanted = String(tagId ?? '').trim()
  const byUser = new Map<string, PendingReviewRow>()
  for (const doc of docs) {
    const pending = Array.isArray(doc.pending) ? doc.pending : []
    for (const p of pending) {
      if (String(p?.tagId ?? '').trim() !== wanted) continue
      const at = Number(p?.suggestedAtMs)
      const row: PendingReviewRow = {
        userId: doc.id,
        displayName: '',
        reason: String(p?.reason ?? '').trim(),
        sessionId: p?.sessionId ? String(p.sessionId) : null,
        suggestedAtMs: Number.isFinite(at) && at > 0 ? at : 0,
      }
      const prev = byUser.get(doc.id)
      // 留最舊的；沒有時間的（0）不算「更舊」，只在還沒有任何一條時才用
      if (!prev) byUser.set(doc.id, row)
      else if (row.suggestedAtMs && (!prev.suggestedAtMs || row.suggestedAtMs < prev.suggestedAtMs)) byUser.set(doc.id, row)
    }
  }
  const all = [...byUser.values()]
  all.sort((a, b) => {
    // 時間不明的一律沉到最後（0 不是「很舊」，是「不知道」）
    const av = a.suggestedAtMs || Number.POSITIVE_INFINITY
    const bv = b.suggestedAtMs || Number.POSITIVE_INFINITY
    return av - bv
  })
  return { rows: all.slice(0, max), dropped: Math.max(0, all.length - max) }
}

/**
 * 建議是什麼時候產生的，寫成一行小字。
 *
 * ⛔ 0 不是「1970 年」是「舊資料沒記」——照著印會變成一個看起來壞掉的日期。
 * ⛔ 不印秒：這一列的重點是「等多久了」，`下午7:30:11` 的那個 11 秒是純噪音
 *    （老闆對小字冗贅有意見過，見 `G-43`）。
 */
export function pendingWhenText(ms: number, locale = 'zh-TW'): string {
  if (!ms) return '時間不明'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '時間不明'
  return d.toLocaleString(locale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export interface BulkReviewResult {
  /** 真的處理掉的條數 */
  processed: number
  /** 已經被別人按過／已經不在待審裡的（不是失敗，但一定要講） */
  alreadyHandled: number
  /** 這次沒送出去處理的（撞到單次上限） */
  notProcessed: number
  /** 中途出錯的 */
  failed: number
  /**
   * 找不到這位客人的收件匣（id 對不上、資料已刪、不是這個工作區的）。
   *
   * ⛔ **不可以併進 `alreadyHandled`**：那句話會讓人以為「同事已經處理掉了、不用管」，
   * 但實際上是**什麼都沒找到、什麼都沒寫**——下一步完全不同（一個是不用管、
   * 一個是資料有問題要查）。這支端點的四個數字本來就是為了分辨這件事而存在的。
   */
  notFound: number
}

/**
 * 批次結果要怎麼講給人聽（純函式，跟畫面分開才測得到）。
 *
 * ⛔ 只講「已處理 30 位」是不夠的：勾了 34 位卻只成功 30 位時，人需要知道另外 4 位
 * 是「別人先按掉了」還是「出錯了」——兩者的下一步完全不同（前者不用管，後者要重試）。
 */
export function bulkReviewOutcomeText(
  action: 'apply' | 'dismiss',
  res: BulkReviewResult,
): string {
  const verb = action === 'apply' ? '已貼上標籤' : '已忽略'
  const parts = [`${verb} ${res.processed} 位`]
  if (res.alreadyHandled) parts.push(`${res.alreadyHandled} 位已經被處理過（略過）`)
  // 「找不到」要跟「已經被處理過」分開講：後者不用管，前者是資料對不上、要查
  if (res.notFound) parts.push(`${res.notFound} 位找不到資料（不是被處理掉，請回報）`)
  if (res.notProcessed) parts.push(`還有 ${res.notProcessed} 位沒處理，再按一次`)
  if (res.failed) parts.push(`${res.failed} 位失敗`)
  return parts.join('；')
}
