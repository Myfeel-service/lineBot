/**
 * 系統標籤（同一個工作區裡 `code` 唯一）的「找，找不到就建」：「N 天沒互動」（`inactive-tag.ts`）與
 * 「本月壽星」（`birthday-tag.ts`）共用一支（2026-11-04 code review 第 14 條：兩份幾乎一樣的找法，改一邊會忘另一邊）。
 *
 * ⭐ 建立用**固定的文件 id**（`<workspaceId>__<code>`）＋ `create()`（code review 第 5 條）：
 *    以前是查不到就各自 `set()` 一個隨機 id——同一秒好幾台伺服器一起建（例如推播「問生日」之後好幾位客人同時選日期），
 *    每台都查不到、各建一顆，之後只有其中一顆會被找到，其他顆上的客人永遠摘不掉。
 *    現在同時建只有一台成功，其他台拿到 ALREADY_EXISTS 就用同一個 id。
 * ⚠️ **先照 code 查**：上線前用隨機 id 建好的舊標籤（「N 天沒互動」早就有）照樣找得到、⛔ 不會多建一顆。
 */
import type { Firestore } from 'firebase-admin/firestore'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

export function systemTagDocId(workspaceId: string, code: string): string {
  return `${workspaceId}__${code}`
}

/**
 * @param build 給了＝找不到就建（只在會用到它的路徑給，例如每日掃描、客人剛留生日）；沒給＝只找
 * @returns existing＝找到的那顆的內容（剛建的、或撞到別台剛建的＝null）
 */
export async function findOrCreateSystemTag(
  db: Firestore,
  workspaceId: string,
  code: string,
  build?: () => TagDoc,
): Promise<{ tagId: string | null, existing: Record<string, unknown> | null }> {
  const snap = await db.collection('tags')
    .where('workspaceId', '==', workspaceId)
    .where('code', '==', code)
    .limit(1)
    .get()
  const hit = snap.docs[0]
  if (hit) return { tagId: hit.id, existing: hit.data() ?? {} }
  if (!build) return { tagId: null, existing: null }
  const id = systemTagDocId(workspaceId, code)
  try {
    await db.collection('tags').doc(id).create(build())
  }
  catch (e) {
    // ALREADY_EXISTS（6）＝別台剛建好同一顆，直接用；其他錯照丟
    if (Number((e as { code?: unknown })?.code) !== 6) throw e
  }
  return { tagId: id, existing: null }
}
