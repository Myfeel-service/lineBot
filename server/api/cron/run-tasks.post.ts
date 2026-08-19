import { assertCronAuthorized } from '~~/server/utils/cron-auth'
import {
  detectSourceUpdates,
  autoHandbackIdleSessions,
  autoCloseIdleHumanSessions,
  remindOverdueHandoffs,
  cleanupExpiredWebhookEventLocks,
  dailyBacklogDigest,
  expireKnowledgeCards,
} from '~~/server/utils/cron-maintenance'
import { retryStuckChunks } from '~~/server/utils/ai-knowledge-chunks'
import { cleanupExpiredPreviewJobs } from '~~/server/utils/ai-preview-jobs'
import { scanKnowledgeGaps } from '~~/server/utils/ai-knowledge-suggest'
import { runBillingReconcile } from '~~/server/utils/run-billing-reconcile'
import { getDb } from '~~/server/utils/firebase'

/**
 * POST /api/cron/run-tasks
 *
 * 定時維護工作的統一觸發入口，由 Cloud Scheduler 每 10 分鐘呼叫（Header 帶
 * X-Cron-Secret）。Amplify 不打包 Nitro scheduledTasks，這些工作在生產環境
 * 一律經此端點執行；每項工作內部都有「沒到期／沒東西就不動」的保護，
 * 高頻呼叫只是便宜的空查詢。
 *
 * 各項工作並行執行、單項失敗不影響其他項；回傳各項統計供 Cloud Scheduler
 * 執行紀錄檢視。排程推播（trigger-scheduled）有自己的每分鐘排程，不在此列。
 *
 * ⚠️ **`billing:reconcile-and-charge` 會真的刷客戶的卡**（見下方註解）。這裡是唯一被
 *    `await` 且真的有排程在打的路徑——`/api/payment/reconcile` 雖然也做同一件事，但它
 *    需要另外建一個 Cloud Scheduler 任務；只要那個任務沒建，每月自動扣款就**完全不會發生**
 *    而且沒有任何錯誤（客戶寬限 3 天後靜默降級）。掛在這裡就不必依賴額外排程。
 */
export default defineEventHandler(async (event) => {
  assertCronAuthorized(event)

  const config = useRuntimeConfig(event)
  const db = getDb()
  const startedAt = Date.now()
  const tasks: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'ai:retry-stuck-chunks', run: () => retryStuckChunks(db) },
    { name: 'ai:cleanup-preview-jobs', run: () => cleanupExpiredPreviewJobs(db) },
    { name: 'ai:detect-source-updates', run: () => detectSourceUpdates(db) },
    { name: 'ai:expire-knowledge-cards', run: () => expireKnowledgeCards(db) },
    // 知識缺口掃描（每輪最多 2 個 workspace，內含 LLM）。
    // 缺口週報已併入 conversation:backlog-digest 的每日摘要（2026-08-06 拍板）
    { name: 'ai:knowledge-gap-scan', run: () => scanKnowledgeGaps(db) },
    { name: 'conversation:auto-handback', run: () => autoHandbackIdleSessions(db) },
    // 真人接手中的會話不吃 24 小時自動結束，這是唯一會收殮它們的機制——停掉的話
    // 忘記按「結束會話」的對話會永遠掛著（那位客人也永遠收不到自動回覆）
    { name: 'conversation:auto-close-idle', run: () => autoCloseIdleHumanSessions(db) },
    { name: 'conversation:handoff-sla', run: () => remindOverdueHandoffs(db) },
    { name: 'conversation:backlog-digest', run: () => dailyBacklogDigest(db) },
    { name: 'webhook:cleanup-event-locks', run: () => cleanupExpiredWebhookEventLocks(db) },
    // 計費對帳 + **每期自動續扣**（會刷卡）。安全性靠三層,不靠呼叫頻率:
    //   ① `PAYUNI_PERIOD_ENABLED !== true` 或金鑰未設 → chargeDueRecurring 直接回 0,零副作用
    //   ② 每筆訂閱在 transaction 內 claim `lastChargeDate=今天` → 同一天最多扣一次
    //   ③ 訂單號含期別與日期,重複建單會撞冪等鍵
    // 所以 10 分鐘一次的呼叫在絕大多數時候只是一個 `status=='past_due'` 的空查詢。
    // 用整支 runBillingReconcile（而非只呼叫 chargeDueRecurring）是因為順序有意義:
    // 必須先 roll 把到期訂閱標成 past_due,續扣才挑得到人（見該檔註解）。
    { name: 'billing:reconcile-and-charge', run: () => runBillingReconcile(config as unknown as Record<string, unknown>, new Date(), { charge: true }) },
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

  // 心跳：讓異常提醒中心能發現「排程整批沒在跑」（Cloud Scheduler 停了、secret 換了、
  // 端點壞了都會停止跳動）。寫失敗只記 log，不影響任務本身的回報。
  await db.collection('cronState').doc('maintenance-heartbeat').set({
    lastRunAt: Date.now(),
    failedTasks: failed.map(f => f.task),
  }, { merge: true }).catch(e => console.warn('[cron/run-tasks] heartbeat write failed:', e))

  return { ok: failed.length === 0, ms: Date.now() - startedAt, results }
})
