import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import type { SuperImageReadFailureRow, SuperImageReadFailures } from '~~/shared/types/super-alerts'

/**
 * 客人傳的圖讀不出來（`C-164`）——超管「全站異常總覽」那一區的查詢與彙總。
 *
 * 為什麼要有：讀圖結果存在每則圖片訊息上（`mediaReadState`，見 handler.ts 的 describeAndAttachImage），
 * 但以前**沒有任何地方去讀它**。`C-163` 那次（模型在 JSON 後面多吐殘句）從 8/17 壞到 9/6、
 * 45 張圖中鏢，只寫進主機日誌，最後是老闆自己看到對話截圖才問出來。
 *
 * 只算 `malformed`（AI 讀了圖、交回來的格式壞掉）：那是我們系統壞掉。
 * `noQuestion`（AI 說看不出客人想問什麼）是正常結果，算進來就變雜訊。
 *
 * 給超管看、不給店家（`D-44`：使用者修不了的錯誤不放進他的待辦）。
 */

/** 看最近幾天 */
export const IMAGE_READ_FAILURE_WINDOW_DAYS = 7
/**
 * 一次最多讀幾張：正常是 0 張（近 30 天全站 174 張圖、0 張讀不出來），這是保險絲不是分頁。
 * 撞到就在畫面上講「更早的沒算進來」。
 */
export const IMAGE_READ_FAILURE_SCAN_LIMIT = 500
/**
 * 「偶發」與「真的壞了」的分界：一小時內 3 張以上（同 `D-44`② 老闆給 AI 服務失敗定的那把尺）。
 * 偶發一張不吵人——客人照樣收到問句，只是少了猜的選項。
 */
export const IMAGE_READ_BURST_WINDOW_MS = 60 * 60_000
export const IMAGE_READ_BURST_MIN = 3
/** 只看近 24 小時有沒有連著壞：上週壞過一陣、已經好了，不該讓側欄點一直紅 */
export const IMAGE_READ_BURST_RECENT_MS = 24 * 3600_000

export interface ImageReadFailureEvent {
  workspaceId: string
  /** 對話文件 id（訊息的上一層） */
  conversationId: string
  atMs: number
}

/** Firestore 讀回來的訊息 → 這裡要的三個欄位 */
export function toImageReadFailureEvent(doc: {
  ref: { parent: { parent: { id: string } | null } }
  data(): unknown
}): ImageReadFailureEvent {
  const d = (doc.data() ?? {}) as { workspaceId?: unknown, timestamp?: { toMillis?: () => number } }
  return {
    workspaceId: typeof d.workspaceId === 'string' ? d.workspaceId : '',
    conversationId: doc.ref.parent.parent?.id ?? '',
    atMs: typeof d.timestamp?.toMillis === 'function' ? d.timestamp.toMillis() : 0,
  }
}

/**
 * 全站近 N 天讀不出來的圖，新的在前。
 *
 * 走 collectionGroup（訊息是每段對話底下的子集合），要一支複合索引
 * `messages`（collection group）：`mediaReadState` 升冪＋`timestamp` **降冪**——見 firestore.indexes.json。
 * ⛔ 改 orderBy 方向就要另一支索引（反方向那支救不了，正式站踩過兩次）。
 * 沒有索引時這支會丟錯：呼叫端要講「查不到」，⛔ 不可以當成「沒有」。
 */
export async function readImageReadFailureEvents(
  db: Firestore,
  nowMs: number,
): Promise<{ events: ImageReadFailureEvent[], truncated: boolean }> {
  const since = nowMs - IMAGE_READ_FAILURE_WINDOW_DAYS * 24 * 3600_000
  const snap = await db.collectionGroup('messages')
    .where('mediaReadState', '==', 'malformed')
    .where('timestamp', '>=', Timestamp.fromMillis(since))
    .orderBy('timestamp', 'desc')
    .limit(IMAGE_READ_FAILURE_SCAN_LIMIT + 1)
    // 只要算數與連結用的欄位：訊息上的 payload 是整包 LINE 原始資料
    .select('workspaceId', 'timestamp')
    .get()
  const truncated = snap.docs.length > IMAGE_READ_FAILURE_SCAN_LIMIT
  if (truncated) console.warn(`[image-read-failures] 近 ${IMAGE_READ_FAILURE_WINDOW_DAYS} 天讀不出來的圖超過 ${IMAGE_READ_FAILURE_SCAN_LIMIT} 張，只算了最新的 ${IMAGE_READ_FAILURE_SCAN_LIMIT} 張`)
  const docs = truncated ? snap.docs.slice(0, IMAGE_READ_FAILURE_SCAN_LIMIT) : snap.docs
  return { events: docs.map(toImageReadFailureEvent), truncated }
}

/**
 * 任一段 `windowMs` 長的時間裡最多擠了幾張（時間點不用先排序）。
 * 一樣多時取比較晚的那一段：畫面上講的是「最近一次」。
 */
export function densestWindow(times: readonly number[], windowMs: number): { count: number, startMs: number, endMs: number } | null {
  const t = [...times].sort((a, b) => a - b)
  let best: { count: number, startMs: number, endMs: number } | null = null
  let i = 0
  for (let j = 0; j < t.length; j++) {
    while (t[j]! - t[i]! > windowMs) i++
    const count = j - i + 1
    if (!best || count >= best.count) best = { count, startMs: t[i]!, endMs: t[j]! }
  }
  return best
}

/**
 * 每個帳號一列（幾張、最近一張的時間、最近那段對話）＋近 24 小時有沒有連著壞。
 * ⛔ 一張都不丟：訊息上沒記帳號的也列成一列（點不進對話，但算得到）。
 */
export function summarizeImageReadFailures(
  events: readonly ImageReadFailureEvent[],
  opts: { nowMs: number, workspaceNames: ReadonlyMap<string, string>, truncated: boolean },
): SuperImageReadFailures {
  const sorted = [...events].sort((a, b) => b.atMs - a.atMs)
  const rows = new Map<string, SuperImageReadFailureRow>()
  for (const e of sorted) {
    const row = rows.get(e.workspaceId)
    if (row) {
      row.count += 1
      continue
    }
    rows.set(e.workspaceId, {
      workspaceId: e.workspaceId,
      workspaceName: e.workspaceId ? (opts.workspaceNames.get(e.workspaceId) ?? e.workspaceId) : '（訊息上沒有記帳號）',
      count: 1,
      lastAtMs: e.atMs,
      lastConversationId: e.conversationId,
    })
  }

  const recent = sorted.filter(e => e.atMs >= opts.nowMs - IMAGE_READ_BURST_RECENT_MS).map(e => e.atMs)
  const densest = densestWindow(recent, IMAGE_READ_BURST_WINDOW_MS)

  return {
    windowDays: IMAGE_READ_FAILURE_WINDOW_DAYS,
    total: sorted.length,
    truncated: opts.truncated,
    burst: densest && densest.count >= IMAGE_READ_BURST_MIN ? densest : null,
    workspaces: [...rows.values()],
  }
}
