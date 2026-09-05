import { autoCloseIdleBotSessions } from '~~/server/utils/cron-maintenance'
import { getDb } from '~~/server/utils/firebase'
import { localScheduledTasksEnabled, LOCAL_SCHEDULED_TASK_SKIPPED } from '~~/server/utils/local-scheduled-tasks'

/**
 * Nitro scheduled task：客人問完就沒再回來的對話，超過設定天數自動結束（`D-64`）。
 * 實作本體在 server/utils/cron-maintenance.ts（生產由 /api/cron/run-tasks 觸發——
 * Amplify 不打包 Nitro tasks，此檔只給本機 dev 的 scheduledTasks 用）。
 */
export default defineTask({
  meta: {
    name: 'conversation:auto-close-idle-bot',
    description: '機器人在處理、但客人已經很久沒再回來的會話自動結束',
  },
  async run() {
    if (!localScheduledTasksEnabled()) return { result: LOCAL_SCHEDULED_TASK_SKIPPED }
    return { result: await autoCloseIdleBotSessions(getDb()) }
  },
})
