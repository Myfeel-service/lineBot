import type { Firestore } from 'firebase-admin/firestore'

/**
 * 一批 users 主鍵 → 顯示名稱的對照表（一次 getAll，查不到或沒名字就留空字串）。
 *
 * ⛔ **沒有名字時回空字串，不要拿 userId 充數**：呼叫端要分得出「這個人沒名字」
 * （該略過不顯示）和「這個人叫某某」。畫面上冒出一串 `U89c6d4...` 比不顯示更糟。
 *
 * ⚠️ 為什麼沒把 `broadcast/[id]/report.get.ts` 與 `users/list.get.ts` 那兩處併進來：
 * 它們的退路語意**不一樣**——那兩支查不到名字時刻意退回 lineUserId（報表要有東西可指認），
 * 正是這裡明文禁止的行為；併成一支會逼出一個兩邊都不合用的最小公倍數。
 * 三處共通的只有「getAll 一批 users」這行 Firestore 呼叫，不值得為它做抽象。
 */
export async function fetchUserDisplayNames(
  db: Firestore,
  userDocIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!userDocIds.length) return out
  try {
    const snaps = await db.getAll(...userDocIds.map(id => db.collection('users').doc(id)))
    for (const snap of snaps) {
      out[snap.id] = String(snap.data()?.displayName ?? '').trim()
    }
  }
  catch (e) {
    // 查不到名字不該讓呼叫端整個失敗（它通常只是拿來當附註）；回空表，呼叫端自然不顯示
    console.warn('[user-display-names] 查名字失敗:', e)
  }
  return out
}
