/**
 * AI 貼標建議的統計純函式（D-42）——抽出來讓測試不用碰 Firestore。
 */

/** 一份收件匣文件裡「還沒決定」的建議（只取聚合要用的欄位） */
export interface PendingLike {
  pending?: Array<{ tagId?: string }> | null
}

/**
 * 每顆標籤有幾位**客人**還在等人決定。
 *
 * ⛔ 算的是「幾位客人」不是「幾條建議」：同一位客人同一顆標籤理論上只會有一條
 * （候選會排除已在 pending 的），但這裡仍以客人為單位去重——畫面上寫的是
 * 「待審 3 位」，數字的單位必須跟文案一致，不能靠上游保證。
 */
export function aggregatePendingByTag(docs: PendingLike[]): Record<string, number> {
  const seen = new Map<string, Set<number>>()
  docs.forEach((doc, idx) => {
    const pending = Array.isArray(doc?.pending) ? doc.pending : []
    for (const p of pending) {
      const tagId = String(p?.tagId ?? '').trim()
      if (!tagId) continue
      if (!seen.has(tagId)) seen.set(tagId, new Set())
      seen.get(tagId)!.add(idx)
    }
  })
  const out: Record<string, number> = {}
  for (const [tagId, users] of seen) out[tagId] = users.size
  return out
}
