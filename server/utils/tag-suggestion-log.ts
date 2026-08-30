/**
 * AI 貼標建議的成效底帳（D-42 第一步）。
 *
 * 為什麼要有這支：8/23 拍板的玩法是「AI 先建議、人按採用，跑一兩週看準不準，
 * 準了再把該顆改成『AI 判到直接貼』」。但在這支之前，系統只留得住「採用」那一半——
 * **被忽略的建議沒有任何時間紀錄**（只寫進那位客人的「永不再提」名單，而手動移除標籤
 * 也混在同一份名單裡，拿它數忽略次數會灌水），「AI 總共提過幾次」則是處理完就消失。
 * 採用率的分母因此算不出來。⛔ 這種帳現在不記，之後永遠補不回來（同 AI 表現頁那次
 * 「不能數畫面清單、要有獨立底帳」的教訓）。
 *
 * 設計：
 * - **寫入失敗一律不影響主流程**：貼標／採用／忽略本身才是使用者要的結果，
 *   底帳寫不進去頂多少一筆統計，不能讓它反過來害操作失敗。
 * - 一次一位客人、可多顆標籤，走 batch 一次 commit。
 * - ⛔ 只在真的發生時記：採用時若標籤已在客人身上（冪等略過），這裡仍記——
 *   人確實做了決定，見型別註解。
 */
import { v4 as uuidv4 } from 'uuid'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import type { TagSuggestionEvent, TagSuggestionLogDoc } from '~~/shared/types/tag-broadcast'

export async function recordTagSuggestionEvents(
  db: Firestore,
  workspaceId: string,
  event: TagSuggestionEvent,
  /** users 主鍵：`${workspaceId}_${lineUserId}` */
  userId: string,
  tagIds: string[],
  extra: { sessionId?: string | null, operatorId?: string | null } = {},
): Promise<void> {
  if (!workspaceId || !userId || !tagIds.length) return
  try {
    const batch = db.batch()
    const now = FieldValue.serverTimestamp()
    for (const tagId of tagIds) {
      const doc: TagSuggestionLogDoc = {
        workspaceId,
        event,
        tagId,
        userId,
        sessionId: extra.sessionId ?? null,
        operatorId: extra.operatorId ?? null,
        createdAt: now,
      }
      batch.set(db.collection('tagSuggestionLogs').doc(uuidv4()), doc)
    }
    await batch.commit()
  }
  catch (e) {
    console.warn('[tag-suggest] log failed:', event, userId, e)
  }
}
