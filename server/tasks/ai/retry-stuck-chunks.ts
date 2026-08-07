import { retryStuckChunks } from '~~/server/utils/ai-knowledge-chunks'
import { getDb } from '~~/server/utils/firebase'
import { localScheduledTasksEnabled, LOCAL_SCHEDULED_TASK_SKIPPED } from '~~/server/utils/local-scheduled-tasks'

/**
 * Nitro scheduled task：撿 failed / 卡住的 pending 知識卡重新索引。
 * 排程於 nuxt.config.ts scheduledTasks（每 5 分鐘）。
 */
export default defineTask({
  meta: {
    name: 'ai:retry-stuck-chunks',
    description: '重新索引失敗或卡住的知識卡',
  },
  async run() {
    if (!localScheduledTasksEnabled()) return { result: LOCAL_SCHEDULED_TASK_SKIPPED }
    const result = await retryStuckChunks(getDb())
    if (result.scanned > 0) {
      console.log('[ai:retry-stuck-chunks]', result)
    }
    return { result }
  },
})
