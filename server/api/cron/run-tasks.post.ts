import { assertCronAuthorized } from '~~/server/utils/cron-auth'
import {
  detectSourceUpdates,
  autoHandbackIdleSessions,
  remindOverdueHandoffs,
  cleanupExpiredWebhookEventLocks,
  dailyBacklogDigest,
} from '~~/server/utils/cron-maintenance'
import { retryStuckChunks } from '~~/server/utils/ai-knowledge-chunks'
import { cleanupExpiredPreviewJobs } from '~~/server/utils/ai-preview-jobs'
import { getDb } from '~~/server/utils/firebase'

/**
 * POST /api/cron/run-tasks
 *
 * 定時維護工作的統一觸發入口，由 Cloud Scheduler 每 10 分鐘呼叫（Header 帶
 * X-Cron-Secret）。Amplify 不打包 Nitro scheduledTasks，這些工作在生產環境
 * 一律經此端點執行；每項工作內部都有「沒到期／沒東西就不動」的保護，
 * 高頻呼叫只是便宜的空查詢。
 *
 * 六項工作並行執行、單項失敗不影響其他項；回傳各項統計供 Cloud Scheduler
 * 執行紀錄檢視。排程推播（trigger-scheduled）有自己的每分鐘排程，不在此列。
 */
export default defineEventHandler(async (event) => {
  assertCronAuthorized(event)

  const db = getDb()
  const startedAt = Date.now()
  const tasks: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'ai:retry-stuck-chunks', run: () => retryStuckChunks(db) },
    { name: 'ai:cleanup-preview-jobs', run: () => cleanupExpiredPreviewJobs(db) },
    { name: 'ai:detect-source-updates', run: () => detectSourceUpdates(db) },
    { name: 'conversation:auto-handback', run: () => autoHandbackIdleSessions(db) },
    { name: 'conversation:handoff-sla', run: () => remindOverdueHandoffs(db) },
    { name: 'conversation:backlog-digest', run: () => dailyBacklogDigest(db) },
    { name: 'webhook:cleanup-event-locks', run: () => cleanupExpiredWebhookEventLocks(db) },
  ]

  const settled = await Promise.allSettled(tasks.map(t => t.run()))
  const results = tasks.map((t, i) => {
    const s = settled[i]!
    return s.status === 'fulfilled'
      ? { task: t.name, ok: true as const, result: s.value }
      : { task: t.name, ok: false as const, error: String((s.reason as any)?.message ?? s.reason).slice(0, 300) }
  })

  const failed = results.filter(r => !r.ok)
  if (failed.length) console.warn('[cron/run-tasks] failed:', failed)

  return { ok: failed.length === 0, ms: Date.now() - startedAt, results }
})
