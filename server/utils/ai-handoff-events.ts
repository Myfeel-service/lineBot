/**
 * 轉真人事件流 `aiHandoffEvents` —— 知識缺口報表的資料地基。
 *
 * 既有的 `conversations/{doc}.aiMeta` 是 per-conversation 快照（merge 覆寫），同一位客人
 * 問了 5 個答不出的問題只留最後一筆 `lastQuery`——做「答不出問題聚類排行」需要事件流。
 * 這裡每次 handoff append 一筆，fire-and-forget（失敗只 log，絕不影響答題）。
 *
 * 保留期：寫入時帶 `expireAt`（240 天），之後在 Firestore 掛 TTL policy 即自動清理
 * （TTL policy 要在兩個專案各手動設一次，同 myfeel 既有 TTL 待辦）。
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import type { HandoffReason } from '~~/shared/types/ai-knowledge'

export const HANDOFF_EVENTS_COLLECTION = 'aiHandoffEvents'

const EVENT_TTL_DAYS = 240
/** 客人原話截長：聚類/顯示都用不到更長的內容，也避免單筆 doc 无限膨脹 */
const MAX_QUERY_LEN = 500

export interface HandoffEventInput {
  workspaceId: string
  /** 客人原話（觸發這次 handoff 的那句） */
  query: string
  reason: HandoffReason
  /** top-1 相似度（沒有檢索結果時為 0） */
  confidence: number
  /** intent router 的判定（router 沒跑到 / 失敗為 null） */
  intent: string | null
  /** 反問 followup 場景的原始問題 */
  followupOf: string | null
  /** 命中的前幾張卡（最多 3 張），供報表顯示「差一點就答出」的擦邊案例 */
  sources: Array<{ chunkId: string, title: string, similarity: number }>
  isFollowup: boolean
}

/** fire-and-forget：呼叫端不 await。 */
export function logHandoffEvent(db: Firestore, evt: HandoffEventInput): void {
  // 整段包 try/catch 才真的「絕不影響答題」：只 catch promise 的話，
  // 同步就丟出來的錯（例如 db 還沒初始化）會直接打斷正在轉真人的那條主流程。
  try {
    logHandoffEventUnsafe(db, evt)
  }
  catch (e) {
    console.error('[ai-handoff-events] log failed (sync):', e)
  }
}

function logHandoffEventUnsafe(db: Firestore, evt: HandoffEventInput): void {
  const now = Timestamp.now()
  db.collection(HANDOFF_EVENTS_COLLECTION)
    .add({
      workspaceId: evt.workspaceId,
      query: evt.query.slice(0, MAX_QUERY_LEN),
      reason: evt.reason,
      confidence: evt.confidence,
      intent: evt.intent,
      followupOf: evt.followupOf ? evt.followupOf.slice(0, MAX_QUERY_LEN) : null,
      sources: evt.sources.slice(0, 3),
      isFollowup: evt.isFollowup,
      createdAt: now,
      expireAt: Timestamp.fromMillis(now.toMillis() + EVENT_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .catch(e => console.error('[ai-handoff-events] log failed:', e))
}
