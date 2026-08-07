import { detectSourceUpdates } from '~~/server/utils/cron-maintenance'
import { getDb } from '~~/server/utils/firebase'
import { localScheduledTasksEnabled, LOCAL_SCHEDULED_TASK_SKIPPED } from '~~/server/utils/local-scheduled-tasks'

/**
 * Nitro scheduled task：對 type='url' 的 source 做變動偵測、gsheet 自動同步。
 * 實作本體在 server/utils/cron-maintenance.ts（生產由 /api/cron/run-tasks 觸發——
 * Amplify 不打包 Nitro tasks，此檔只給本機 dev 的 scheduledTasks 用）。
 */
export default defineTask({
  meta: {
    name: 'ai:detect-source-updates',
    description: '偵測 URL 來源內容變動，標記 outdated 等使用者確認',
  },
  async run() {
    if (!localScheduledTasksEnabled()) return { result: LOCAL_SCHEDULED_TASK_SKIPPED }
    return { result: await detectSourceUpdates(getDb()) }
  },
})
