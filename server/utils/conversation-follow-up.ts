/**
 * 待跟進（`H-17`：原本的釘選，欄位 `pinnedAt`）的伺服器端共用：單筆與批次標記都要數「現在標了幾筆」來擋上限。
 * 規則與命名的來龍去脈見 ~~/shared/conversation-flags.ts。
 */

/** 目前標了幾筆待跟進；缺複合索引時回 null（＝這次不檢查上限，⛔ 不要因此擋住標記） */
export async function countPinnedConversations(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<number | null> {
  try {
    const snap = await db.collection('conversations')
      .where('workspaceId', '==', workspaceId)
      .orderBy('pinnedAt', 'desc')
      .count()
      .get()
    return snap.data().count
  }
  catch (e: any) {
    console.warn('[conversations/follow-up] 待跟進數量查詢失敗，略過上限檢查:', String(e?.message || '').slice(0, 200))
    return null
  }
}
