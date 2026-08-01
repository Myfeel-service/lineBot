import { getDb } from '~~/server/utils/firebase'
import type { ConversationStatus } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

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

  // 「未首接」分頁 = status 'open':扣掉活動/加好友進來、客人未開口的 session
  // (它們不佔待處理佇列;客人開口後 hasInbound=true 自然回歸)。
  // 三個等值條件 Firestore 會自動合併單欄索引,免複合索引;失敗就不扣,數字寧可偏多。
  try {
    const pre = await db.collection('conversationSessions')
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'open')
      .where('hasInbound', '==', false)
      .count()
      .get()
    counts.open = Math.max(0, counts.open - pre.data().count)
  }
  catch (e: any) {
    console.warn('[sessions-counts] pre-inbound subtract failed:', String(e?.message).slice(0, 120))
  }

  return { counts, total }
})
