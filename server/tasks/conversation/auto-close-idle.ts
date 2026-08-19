import { autoCloseIdleHumanSessions } from '~~/server/utils/cron-maintenance'
import { getDb } from '~~/server/utils/firebase'
import { localScheduledTasksEnabled, LOCAL_SCHEDULED_TASK_SKIPPED } from '~~/server/utils/local-scheduled-tasks'

/**
 * Nitro scheduled task：真人接手中的會話閒置過久自動結束。
 * 實作本體在 server/utils/cron-maintenance.ts（生產由 /api/cron/run-tasks 觸發——
 * Amplify 不打包 Nitro tasks，此檔只給本機 dev 的 scheduledTasks 用）。
 */
export default defineTask({
  meta: {
    name: 'conversation:auto-close-idle',
    description: '真人接手中但雙方都沒動靜太久的會話自動結束',
  },
  async run() {
    if (!localScheduledTasksEnabled()) return { result: LOCAL_SCHEDULED_TASK_SKIPPED }
    return { result: await autoCloseIdleHumanSessions(getDb()) }
  },
})
