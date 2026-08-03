import { scanKnowledgeGaps } from '~~/server/utils/ai-knowledge-suggest'
import { getDb } from '~~/server/utils/firebase'

/**
 * Nitro scheduled task：知識缺口掃描（聚類「客人問了但 AI 答不出」→ LLM 擬卡草稿）。
 * 排程於 nuxt.config.ts scheduledTasks（本機 dev）；生產由 /api/cron/run-tasks 執行。
 */
export default defineTask({
  meta: {
    name: 'ai:knowledge-gap-scan',
    description: '聚類未答問題並草擬知識卡建議',
  },
  async run() {
    const result = await scanKnowledgeGaps(getDb())
    return { result }
  },
})
