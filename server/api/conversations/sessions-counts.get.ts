import { getDb } from '~~/server/utils/firebase'
import type { ConversationStatus } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { countOpenQueueSessions } from '~~/server/utils/conversation-queue'

const STATUSES: ConversationStatus[] = [
  'open',
  'bot_handling',
  'pending_human',
  'human_handling',
  'closed',
]

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  const counts = {} as Record<ConversationStatus, number>
  await Promise.all(
    STATUSES.map(async (status) => {
      const snap = await db
        .collection('conversationSessions')
        .where('workspaceId', '==', workspaceId)
        .where('status', '==', status)
        .count()
        .get()
      counts[status] = snap.data().count
    }),
  )

  // 「全部」的總數先算(包含一切,與「全部」列表一致)
  const total = STATUSES.reduce((sum, s) => sum + counts[s], 0)

  // 「未首接」分頁 = 待處理佇列:扣掉活動/加好友進來、客人未開口的 session
  // (它們不佔待處理佇列;客人開口後 hasInbound=true 自然回歸)。
  // 口徑與 sessions.get.ts 的列表共用 conversation-queue,不再各算各的。
  counts.open = await countOpenQueueSessions(db, workspaceId)

  return { counts, total, followUp: await countFollowUps(db, workspaceId) }
})

/**
 * 客服右鍵標成「待跟進」的對話數（人工標記，不是上面那幾個會話狀態）。
 * 刻意跟 counts.open（分頁「待處理」）分開:一個是人說要回頭跟,一個是系統說還沒人處理。
 * 與側欄分頁的數字刻意分開回傳，不要加進 counts —— 那個 record 是會話狀態的口徑。
 */
async function countFollowUps(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<number | null> {
  try {
    const snap = await db
      .collection('conversations')
      .where('workspaceId', '==', workspaceId)
      .orderBy('followUpAt', 'desc')
      .count()
      .get()
    return snap.data().count
  }
  catch (e) {
    // 缺複合索引時不要讓整排分頁數字消失，但也⛔不可以回 0 冒充「沒有待跟進」——
    // 0 會讓數字無聲消失、沒人知道壞了（D-43④順帶修）。回 null＝「這次查不到」，
    // 前端一樣不顯示數字，但 tooltip 會講出「數量讀不到」而不是裝作沒事。
    console.warn('[sessions-counts] followUp count failed (缺 conversations followUpAt 複合索引?):', (e as Error)?.message)
    return null
  }
}
