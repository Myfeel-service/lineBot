import { cleanupExpiredPreviewJobs } from '~~/server/utils/ai-preview-jobs'
import { getDb } from '~~/server/utils/firebase'
import { localScheduledTasksEnabled, LOCAL_SCHEDULED_TASK_SKIPPED } from '~~/server/utils/local-scheduled-tasks'

/**
 * Nitro scheduled task：清掉過期的知識庫預覽 job（Firestore 文件 + Storage temp 檔）。
 * 排程於 nuxt.config.ts scheduledTasks（每 15 分鐘）。同 retry-stuck-chunks 的模式。
 */
export default defineTask({
  meta: {
    name: 'ai:cleanup-preview-jobs',
    description: '清理過期的知識庫預覽 job 與其暫存檔',
  },
  async run() {
    if (!localScheduledTasksEnabled()) return { result: LOCAL_SCHEDULED_TASK_SKIPPED }
    const result = await cleanupExpiredPreviewJobs(getDb())
    if (result.deleted > 0) {
      console.log('[ai:cleanup-preview-jobs]', result)
    }
    return { result }
  },
})
