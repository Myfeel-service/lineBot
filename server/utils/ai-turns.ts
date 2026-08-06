/**
 * 每一次 AI 回合的脈絡快照 `conversations/{doc}/aiTurns/{turnId}`。
 *
 * 契約見 {@link AiTurnDoc}。這支只做兩件事：**發號**（回合開始時先要一個 id，好蓋在該回合
 * 送出的訊息上）與**寫入**（回合結束時把當時的判斷存下來）。
 *
 * 為什麼 id 要在回合「開始」就拿到：訊息是先送出、aiMeta 後寫的（客人的回覆不能等 Firestore），
 * 兩邊要對得起來就必須共用同一個先產生好的 id。Firestore 的 doc() 不打網路就能給 id，
 * 正好適合——不必自己用時間戳湊一個「大概不會撞」的鍵。
 */
import { Timestamp, FieldValue, type Firestore } from 'firebase-admin/firestore'
import type { AiTurnDoc } from '~~/shared/types/ai-knowledge'

export const AI_TURNS_COLLECTION = 'aiTurns'

/** 保留期同 aiHandoffEvents / aiFeedbackEvents */
const TURN_TTL_DAYS = 240

const MAX_QUERY_LEN = 500
const MAX_REPLY_LEN = 2000

function turnCollection(db: Firestore, convDocId: string) {
  return db.collection('conversations').doc(convDocId).collection(AI_TURNS_COLLECTION)
}

/**
 * 先要一個 turn id（不打網路）。回合中送出的每一則訊息都蓋這個 id，
 * 回合結束再用同一個 id 寫入脈絡。
 */
export function newAiTurnId(db: Firestore, convDocId: string): string {
  return turnCollection(db, convDocId).doc().id
}

/**
 * 寫入這一回合的脈絡。
 *
 * best-effort：寫失敗只是少一張「為什麼這樣答」，不能讓客人的回覆流程掛掉
 * （aiMeta 的寫入也是同樣的態度，見 handler.ts 的 writeAiMeta）。
 */
export async function writeAiTurn(
  db: Firestore,
  convDocId: string,
  turnId: string,
  turn: Omit<AiTurnDoc, 'createdAt' | 'expireAt' | 'userId'>,
): Promise<void> {
  try {
    const doc: AiTurnDoc = {
      ...turn,
      userId: convDocId,
      query: String(turn.query ?? '').slice(0, MAX_QUERY_LEN),
      suggestedReply: String(turn.suggestedReply ?? '').slice(0, MAX_REPLY_LEN),
      handoffSummary: String(turn.handoffSummary ?? '').slice(0, MAX_REPLY_LEN),
      createdAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + TURN_TTL_DAYS * 86_400_000),
    }
    await turnCollection(db, convDocId).doc(turnId).set(doc)
  }
  catch (e) {
    console.error('[ai-turns] writeAiTurn failed:', e)
  }
}
