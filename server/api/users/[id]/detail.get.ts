import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { readConversationAssignee } from '~~/shared/conversation-assignee'
import { readConversationFlags } from '~~/shared/conversation-flags'

/**
 * GET /api/users/:id/detail — 客人單頁（G-6）
 *
 * 一位客人的完整檔案：基本資料、標籤（含來源）、腳本收集到的欄位（attributes）、
 * 最後互動、AI 建議標籤（D-24 的收件匣，尚無建議時為 null）。
 *
 * 讀取全部走主鍵直讀／單欄位等值查詢，**零掃描**（08-11 讀取費教訓）：
 *   users / conversations / userTagSuggestions 三份文件同一把鍵（{wid}_{lineUserId}），
 *   userTags 用 userId 等值查（鍵本身就含租戶前綴，天生隔離）。
 */

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/**
 * 一條待處理的 AI 建議 → 畫面要的形狀。
 *
 * **抽出來是為了測得到**：`sessionId`（產生這條建議的那場對話）掃描器一直有存，
 * 但先前在這一層被丟掉，於是卡片上只剩 AI 自己的一句轉述、沒有任何路可以看到
 * 客人實際說了什麼——而那正是「要不要採用」唯一的判斷依據。
 * 這種「中途被靜靜丟掉一個欄位」型別檢查抓不到（同 `G-21` 的篩選沒接上），只能靠測試。
 */
export function toPendingSuggestionView(raw: unknown) {
  const p = (raw ?? {}) as Record<string, unknown>
  return {
    tagId: String(p.tagId ?? ''),
    reason: String(p.reason ?? ''),
    /** 舊資料可能沒有＝空字串，畫面就不給那個連結（不給一個點了會跑錯地方的路） */
    sessionId: String(p.sessionId ?? ''),
    suggestedAtMs: Number(p.suggestedAtMs ?? 0),
  }
}

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const userIdParam = getRouterParam(event, 'id')
  if (!userIdParam) throw createError({ statusCode: 400, statusMessage: 'userId is required' })
  const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userIdParam, workspaceId), workspaceId)

  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(fsUserDocId, workspaceId)
  const [userSnap, tagSnap, convSnap, suggestSnap, sessionCount] = await Promise.all([
    db.collection('users').doc(fsUserDocId).get(),
    db.collection('userTags').where('userId', '==', fsUserDocId).get(),
    db.collection('conversations').doc(fsUserDocId).get(),
    db.collection('userTagSuggestions').doc(fsUserDocId).get(),
    /**
     * 來過幾次（D-29③）：第一次來的新客與來過 14 次的常客，接手時的語氣完全不同。
     * ⛔ 用 count() 聚合不是撈回來數——不論幾場都只算 1 次讀取（08-11 讀取費鐵律）。
     * ⛔ `conversationSessions.userId` 存的是**純 LINE userId**（不是 users 主鍵），
     *    帶錯的話每個人都會顯示 0 次。既有索引 (userId, workspaceId) 直接吃得下。
     */
    db.collection('conversationSessions')
      .where('userId', '==', lineUserId)
      .where('workspaceId', '==', workspaceId)
      .count().get()
      .then(s => s.data().count)
      // 查不到就回 null＝畫面不顯示這一列，⛔ 不要回 0（那是「來過 0 次」的謊話）
      .catch((e) => { console.warn('[user detail] session count failed:', e); return null }),
  ])

  // 主鍵是拿授權過的 workspaceId 組出來的，跨租戶讀不到別人的文件；
  // workspaceId 欄位再驗一次是保險（最早期的 user doc 可能沒有這個欄位，缺欄不擋）
  const user = userSnap.data()
  if (!userSnap.exists || (user?.workspaceId && user.workspaceId !== workspaceId)) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const conv = convSnap.exists ? convSnap.data()! : null
  const rawAttributes = user!.attributes
  const attributes: Record<string, string> = {}
  if (rawAttributes && typeof rawAttributes === 'object') {
    for (const [k, v] of Object.entries(rawAttributes)) {
      if (typeof v === 'string' && k.trim()) attributes[k] = v
    }
  }

  const suggestions = suggestSnap.exists ? suggestSnap.data() : null
  const taggedIds = new Set(tagSnap.docs.map(d => String(d.data()?.tagId ?? '')))
  // 已經貼上的標籤不再顯示成「待你決定」（剪枝在貼標端做，這裡是顯示層的保險：
  // 涵蓋舊資料與同時有人在別的分頁貼標的情況）——手上已有 userTags，零額外讀取
  const pending = (Array.isArray(suggestions?.pending) ? suggestions!.pending : [])
    .filter((p: any) => !taggedIds.has(String(p?.tagId ?? '')))

  return {
    id: fsUserDocId,
    lineUserId,
    /** 來過幾次（null＝查不到，畫面就不顯示這列——不要拿 0 充數） */
    sessionCount,
    /**
     * 誰在跟這條線、有沒有被標「待跟進」（D-29①②）。
     * 兩者都存在 conversations 文件上，這支端點本來就撈了那份，零額外讀取。
     */
    assignee: readConversationAssignee(conv ?? undefined),
    flags: readConversationFlags(conv ?? undefined),
    displayName: String(user!.displayName ?? ''),
    pictureUrl: String(user!.pictureUrl ?? ''),
    isBlocked: user!.isBlocked === true,
    createdAtMs: tsToMs(user!.createdAt),
    attributes,
    /**
     * 客服交接用的備註（G-27 功能缺口①）。與 user 文件同一份，零額外讀取。
     * ⛔ 只給後台：這支端點要 viewer 以上，而備註不會出現在任何送給客人的路徑。
     */
    note: {
      text: String(user!.note ?? ''),
      updatedByName: String(user!.noteUpdatedByName ?? ''),
      updatedAtMs: tsToMs(user!.noteUpdatedAt),
    },
    tags: tagSnap.docs.map((d) => {
      const t = d.data()
      return {
        tagId: String(t.tagId ?? ''),
        sourceType: String(t.sourceType ?? 'manual'),
        sourceRefId: t.sourceRefId ?? null,
        createdAtMs: tsToMs(t.createdAt),
        /**
         * `D-55`：最近一次「客人又表現了這個意圖」與累計次數。
         *
         * ⛔ 跟 `createdAtMs` 是兩件不同的事實（第一次貼上 vs 最後一次被判到），
         * 沒有值時**不可以拿 createdAtMs 頂替**——那是製造假資料。
         * 沒有值＝從來沒被自動判到過（後台手動貼的天生如此），次數讀成 0。
         */
        lastHitAtMs: typeof t.lastHitAtMs === 'number' ? t.lastHitAtMs : null,
        hitCount: typeof t.hitCount === 'number' ? t.hitCount : 0,
      }
    }),
    conversation: conv
      ? {
          lastMessage: String(conv.lastMessage ?? ''),
          lastDirection: (conv.lastDirection === 'incoming' || conv.lastDirection === 'outgoing') ? conv.lastDirection : null,
          lastMessageAtMs: tsToMs(conv.lastMessageAt),
          lastInboundMessageAtMs: tsToMs(conv.lastInboundMessageAt),
        }
      : null,
    tagSuggestions: pending.length
      ? {
          pending: pending.map(toPendingSuggestionView),
        }
      : null,
  }
})
