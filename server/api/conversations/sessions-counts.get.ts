import { getDb } from '~~/server/utils/firebase'
import type { ConversationStatus } from '~~/shared/types/conversation-stats'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { countOpenQueueSessions } from '~~/server/utils/conversation-queue'

const STATUSES: ConversationStatus[] = [
  'open',
  'bot_handling',
  'pending_human',
  'human_handling',
  'closed',
]

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const db = getDb()

  /**
   * 兩組數字彼此不相干，一次全部發出去。
   *
   * 先前是「五個狀態 → 等完 → 佇列 → 等完 → 待跟進」三段排隊，而每一段都是一趟 Firestore
   * 往返。這支不是只有換分頁時才跑：清單每次載入（含每 30 秒的背景刷新）開頭就發它一次，
   * 客服按「結束會話」等的也有它一份（2026-09-11 實測本機打正式資料約 2.4 秒）。
   * `H-17`（2026-10-20）：「只看待跟進（N）」那顆篩選下架，待跟進的數字改由列表最上面那一區自己數，
   * 這裡不再多數一次（每 30 秒省一次計數查詢）。
   */
  const counts = {} as Record<ConversationStatus, number>
  const [, openQueue] = await Promise.all([
    Promise.all(
      STATUSES.map(async (status) => {
        const snap = await db
          .collection('conversationSessions')
          .where('workspaceId', '==', workspaceId)
          .where('status', '==', status)
          .count()
          .get()
        counts[status] = snap.data().count
      }),
    ),
    // 「未首接」分頁 = 待處理佇列:扣掉活動/加好友進來、客人未開口的 session
    // (它們不佔待處理佇列;客人開口後 hasInbound=true 自然回歸)。
    // 口徑與 sessions.get.ts 的列表共用 conversation-queue,不再各算各的。
    countOpenQueueSessions(db, workspaceId),
  ])

  // 「全部」的總數用**原始的** open 算(包含一切,與「全部」列表一致)——要在覆蓋之前
  const total = STATUSES.reduce((sum, s) => sum + counts[s], 0)
  counts.open = openQueue

  return { counts, total }
})
