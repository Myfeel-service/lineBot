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

  return { counts, total }
})
