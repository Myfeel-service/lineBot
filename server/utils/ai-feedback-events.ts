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
   * 「這一次 AI 互動」的識別（aiMeta.updatedAt 毫秒）。用它組成固定 doc id，
   * 同一次互動被重複標記就是覆寫同一筆——否則客服多點幾下、或換分頁重開再點，
   * 同一個問題會變成好幾筆事件，把缺口聚類的「被問 N 次」灌大。
   */
  interactionAtMs: number
}

/** 固定 doc id：type + 對話 + 那一次互動的時間戳。Firestore doc id 不可含 '/'。 */
function feedbackDocId(evt: AiFeedbackEventInput): string {
  const safeUser = evt.userId.replace(/[^\w-]/g, '_')
  return `${evt.type}_${evt.workspaceId}_${safeUser}_${evt.interactionAtMs}`
}

export async function logAiFeedbackEvent(db: Firestore, evt: AiFeedbackEventInput): Promise<void> {
  const now = Timestamp.now()
  await db.collection(AI_FEEDBACK_EVENTS_COLLECTION).doc(feedbackDocId(evt)).set({
    workspaceId: evt.workspaceId,
    userId: evt.userId,
    type: evt.type,
    query: String(evt.query ?? '').slice(0, MAX_QUERY_LEN),
    chunkIds: (evt.chunkIds ?? []).slice(0, 5),
    createdAt: now,
    expireAt: Timestamp.fromMillis(now.toMillis() + EVENT_TTL_DAYS * 24 * 60 * 60 * 1000),
  })
}
