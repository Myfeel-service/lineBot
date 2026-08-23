import type { Firestore } from 'firebase-admin/firestore'

const CHUNK = 30

/** 僅統計指定 tagId 的好友數（避免掃描整個 userTags） */
export async function memberCountsForTagIds(
  db: Firestore,
  workspaceId: string,
  tagIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (!tagIds.length) return counts

  for (let i = 0; i < tagIds.length; i += CHUNK) {
    const chunk = tagIds.slice(i, i + CHUNK)
    const snap = await db.collection('userTags')
      .where('workspaceId', '==', workspaceId)
      .where('tagId', 'in', chunk)
      .select('tagId')
      .get()

    for (const doc of snap.docs) {
      const tagId = doc.data().tagId as string
      counts[tagId] = (counts[tagId] ?? 0) + 1
    }
  }

  return counts
}
