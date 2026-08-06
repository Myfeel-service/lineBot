/**
 * AI 回覆的人工回饋事件流 `aiFeedbackEvents` ——「答錯學習」的資料地基。
 *
 * handoff 事件流只涵蓋「AI 自己知道答不出」；「AI 自信地答錯」只有人看得出來。
 * 這裡收兩種訊號：
 *   - wrong_answer：客服在對話頁按「AI 答錯了」——會進知識缺口掃描聚類（比 handoff 更強的訊號，
 *     且帶當時命中的 chunkIds，直接指向該修哪張卡）。
 *   - draft_applied：客服把 AI 建議草稿填入回覆框——採用率是草稿品質的長期指標。
 *
 * 保留期同 aiHandoffEvents（240 天 TTL，expireAt 欄位；TTL policy 兩專案各手動設一次）。
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore'

export const AI_FEEDBACK_EVENTS_COLLECTION = 'aiFeedbackEvents'

const EVENT_TTL_DAYS = 240
const MAX_QUERY_LEN = 500

export type AiFeedbackType = 'wrong_answer' | 'draft_applied'

export interface AiFeedbackEventInput {
  workspaceId: string
  userId: string
  type: AiFeedbackType
  /** 當時的客人問句（aiMeta.lastQuery） */
  query: string
  /** 當時命中的知識卡（aiMeta.lastSourceChunkIds）——答錯時直接指向該修哪張卡 */
  chunkIds: string[]
  /**
   * 這一次 AI 回合的識別（`aiTurns` 的 doc id）。**新路徑一律帶這個**。
   *
   * 舊做法用 `aiMeta.updatedAt` 的毫秒當識別，代價是「只有最新那一次標得到」：
   * 客人再問一題 aiMeta 就被覆寫，先前標記的 doc id 再也算不出來 → 取消不掉。
   * 綁在回合上就沒有這個問題（回合是 append-only 的，不會被蓋掉）。
   */
  turnId?: string
  /**
   * 舊路徑的識別（aiMeta.updatedAt 毫秒）。turnId 有值時忽略。
   * 保留是為了那些**這功能上線前就送出**、訊息上沒有 aiTurnId 的舊回覆仍標得到。
   */
  interactionAtMs?: number
}

type FeedbackKey = Pick<AiFeedbackEventInput, 'workspaceId' | 'userId' | 'type' | 'turnId' | 'interactionAtMs'>

/**
 * 固定 doc id：type + 對話 + 「哪一次」。Firestore doc id 不可含 '/'。
 *
 * 「可以算得出來」是刻意的：後台要能問「這一次標過答錯了嗎」與「把它取消掉」，
 * 兩件事都只需要這個 id，不必另外查詢或再存一份狀態。
 *
 * 「哪一次」優先用 turnId（回合不會被覆寫，舊回合也算得出來）；沒有才退回舊的時間戳規則，
 * 讓上線前標記過的事件仍指得回同一筆（換規則卻不相容＝那些人的取消鈕全部失效）。
 */
export function aiFeedbackDocId(evt: FeedbackKey): string {
  const safeUser = evt.userId.replace(/[^\w-]/g, '_')
  const turnId = String(evt.turnId ?? '').trim()
  if (turnId) return `${evt.type}_${evt.workspaceId}_${safeUser}_t${turnId.replace(/[^\w-]/g, '_')}`
  return `${evt.type}_${evt.workspaceId}_${safeUser}_${evt.interactionAtMs ?? 0}`
}

/**
 * 取消一筆回饋（客服按錯「AI 答錯了」）。
 *
 * 直接刪掉那筆事件就夠：缺口聚類每輪都是重新掃事件流、沒有「已消費」標記
 * （見 ai-knowledge-suggest.ts 的 scanKnowledgeGaps），所以刪掉之後下一輪就不再算它。
 * 已經被聚成建議的那一條不會回頭撤掉——建議本來就要人審核，忽略即可。
 *
 * 回傳是否真的刪到（false = 本來就沒標記過，前端不必當成錯誤）。
 */
export async function deleteAiFeedbackEvent(
  db: Firestore,
  evt: FeedbackKey,
): Promise<boolean> {
  const ref = db.collection(AI_FEEDBACK_EVENTS_COLLECTION).doc(aiFeedbackDocId(evt))
  const snap = await ref.get()
  // 跨租戶保護：doc id 已含 workspaceId，但仍比對欄位，避免將來 id 規則變動時形成破口
  if (!snap.exists) return false
  if (snap.data()?.workspaceId !== evt.workspaceId) return false
  await ref.delete()
  return true
}

/** 一張卡被標「答錯」的彙總：被標幾次、最後一次是什麼時候 */
export interface WrongAnswerMark {
  count: number
  lastMarkedAtMs: number
}

/**
 * 把回饋事件聚合成「哪一張卡被標了幾次」。
 *
 * 按**卡**聚合而不是按事件：能動手修的單位是卡，而「同一張卡被標 3 次」比三筆
 * 各自的事件強得多。沒有 chunkIds 的事件（AI 沒引用任何卡就答錯）不計——
 * 那是知識缺口、沒有卡可修，由建議收件匣涵蓋。
 */
export function aggregateWrongAnswerMarks(
  events: Array<{ type?: string; chunkIds?: string[]; createdAtMs: number }>,
  sinceMs: number,
): Map<string, WrongAnswerMark> {
  const byChunk = new Map<string, WrongAnswerMark>()
  for (const e of events) {
    if (e.type !== 'wrong_answer') continue
    if (e.createdAtMs < sinceMs) continue
    for (const raw of e.chunkIds ?? []) {
      const id = String(raw ?? '').trim()
      if (!id) continue
      const cur = byChunk.get(id) ?? { count: 0, lastMarkedAtMs: 0 }
      cur.count++
      cur.lastMarkedAtMs = Math.max(cur.lastMarkedAtMs, e.createdAtMs)
      byChunk.set(id, cur)
    }
  }
  return byChunk
}

/**
 * 這張卡被標記之後，還沒有人動過它嗎？
 *
 * 「有人改過就自動離開清單」是刻意的設計：不另外存一份「已處理」狀態，就不會有
 * 「修好了但清單還掛著」的第二種真相。代價是改了卻沒真的改對時它會消失——
 * 但那種情況客人會再問、客服會再標一次，訊號自己會回來。
 *
 * 知識庫工作台與右下角小幫手**共用這一支**：兩邊講的必須是同一件事，
 * 小幫手說沒事、工作台卻紅著，是最傷信任的那種矛盾。
 */
export function isChunkUnfixedSinceMark(chunkUpdatedAtMs: number, mark: WrongAnswerMark): boolean {
  return chunkUpdatedAtMs <= mark.lastMarkedAtMs
}

export async function logAiFeedbackEvent(db: Firestore, evt: AiFeedbackEventInput): Promise<void> {
  const now = Timestamp.now()
  await db.collection(AI_FEEDBACK_EVENTS_COLLECTION).doc(aiFeedbackDocId(evt)).set({
    workspaceId: evt.workspaceId,
    userId: evt.userId,
    type: evt.type,
    query: String(evt.query ?? '').slice(0, MAX_QUERY_LEN),
    chunkIds: (evt.chunkIds ?? []).slice(0, 5),
    createdAt: now,
    expireAt: Timestamp.fromMillis(now.toMillis() + EVENT_TTL_DAYS * 24 * 60 * 60 * 1000),
  })
}
