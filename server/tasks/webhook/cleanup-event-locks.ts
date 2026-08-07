import { cleanupExpiredWebhookEventLocks } from '~~/server/utils/cron-maintenance'
import { getDb } from '~~/server/utils/firebase'
import { localScheduledTasksEnabled, LOCAL_SCHEDULED_TASK_SKIPPED } from '~~/server/utils/local-scheduled-tasks'

/**
 * Nitro scheduled task：刪除過期的 webhook 冪等鎖（expiresAt < now）。
 * 實作本體在 server/utils/cron-maintenance.ts（生產由 /api/cron/run-tasks 觸發——
 * Amplify 不打包 Nitro tasks，此檔只給本機 dev 的 scheduledTasks 用）。
 */
export default defineTask({
  meta: {
    name: 'webhook:cleanup-event-locks',
    description: '清理過期的 webhook 事件冪等鎖',
  },
  async run() {
    if (!localScheduledTasksEnabled()) return { result: LOCAL_SCHEDULED_TASK_SKIPPED }
    return { result: await cleanupExpiredWebhookEventLocks(getDb()) }
  },
})
