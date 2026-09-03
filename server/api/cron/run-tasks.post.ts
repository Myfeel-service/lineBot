import { assertCronAuthorized } from '~~/server/utils/cron-auth'
import {
  detectSourceUpdates,
  autoHandbackIdleSessions,
  autoCloseIdleHumanSessions,
  remindOverdueHandoffs,
  cleanupExpiredWebhookEventLocks,
  dailyBacklogDigest,
  pushCriticalAlerts,
  expireKnowledgeCards,
  purgeRecycledKnowledge,
} from '~~/server/utils/cron-maintenance'
import { retryStuckChunks } from '~~/server/utils/ai-knowledge-chunks'
import { scanNextWorkspaceForDuplicates } from '~~/server/utils/ai-duplicate-scan'
import { cleanupExpiredPreviewJobs, cleanupOrphanUploads } from '~~/server/utils/ai-preview-jobs'
import { advanceStalePreviewJobs } from '~~/server/utils/ai-preview-job-runner'
import { scanKnowledgeGaps } from '~~/server/utils/ai-knowledge-suggest'
import { runBillingReconcile } from '~~/server/utils/run-billing-reconcile'
import { scanInactiveTag } from '~~/server/utils/inactive-tag'
import { scanTagSuggestions } from '~~/server/utils/ai-tag-suggest'
import { scanTagDiscovery } from '~~/server/utils/tag-discovery'
import { rollupConversationStats } from '~~/server/utils/conversation-stats-rollup'
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
    /**
     * 沒人在看的匯入工作，由這裡接手往前推（`D-50` 簡化 3）。
     * 這支讓等待畫面那句「先去忙別的、整理會在背景繼續」真的成立——在它之前，
     * 整理只在有人盯著畫面輪詢時才前進，關掉視窗就停在原地。
     * 一輪最多推 2 份、每份 15 秒預算，且**跳過使用者正在輪詢的那份**（不跟前端搶）。
     */
    { name: 'ai:advance-preview-jobs', run: () => advanceStalePreviewJobs(db) },
    // 取消上傳留下的孤兒檔（只在排程清，不塞進使用者請求路徑——列舉+逐檔刪會拖垮匯入端點）
    { name: 'ai:cleanup-orphan-uploads', run: () => cleanupOrphanUploads() },
    { name: 'ai:detect-source-updates', run: () => detectSourceUpdates(db) },
    { name: 'ai:expire-knowledge-cards', run: () => expireKnowledgeCards(db) },
    // 回收桶到期清運：軟刪除的知識卡（含連坐的 manual 來源）過了 30 天保留期真刪
    { name: 'ai:purge-recycled-knowledge', run: () => purgeRecycledKnowledge(db) },
    // 知識缺口掃描（每輪最多 2 個 workspace，內含 LLM）。
    // 缺口週報已併入 conversation:backlog-digest 的每日摘要（2026-08-06 拍板）
    { name: 'ai:knowledge-gap-scan', run: () => scanKnowledgeGaps(db) },
    // 跨來源重複偵測（C-40(c)）:一輪一個 workspace,指紋沒變/24h 內掃過＝零 LLM 費
    { name: 'ai:dup-scan', run: () => scanNextWorkspaceForDuplicates(db) },
    // 「N 天沒互動」自動標籤（CRM 分眾）：每工作區每天只真跑一次（內有 lastRunDay 閘），
    // 其餘輪次都是一次 cronState 空讀。窗口掃描＋修復輪掃都有上限，見 inactive-tag.ts
    { name: 'crm:inactive-tag', run: () => scanInactiveTag(db) },
    // AI 讀對話貼標建議（D-24 建議式）：只掃 autoTagSuggest 開著的工作區、
    // 游標只往前走、每輪每工作區上限 8 場、每場最多一次 LLM，見 ai-tag-suggest.ts
    { name: 'crm:tag-suggest', run: () => scanTagSuggestions(db) },
    // AI 發現新標籤（老闆 08-25 拍板）：每工作區約每週真跑一次（間隔閘在 tagDiscovery 文件上），
    // 其餘輪次每工作區只花 1 次讀取；一次掃描只打一次 LLM，見 tag-discovery.ts
    { name: 'crm:tag-discovery', run: () => scanTagDiscovery(db) },
    // 對話統計日結（`E-29`）：每輪重算最近 3 天＋輪播一天更舊的＋補缺的日子。
    // ⛔ 今天不建（今天還沒過完，讀取端一律現場算）。這支停掉不會壞畫面——
    //    統計端點找不到日結就自動現場算，只是慢回原本的樣子。
    { name: 'stats:rollup-daily', run: () => rollupConversationStats(db) },
    { name: 'conversation:auto-handback', run: () => autoHandbackIdleSessions(db) },
    // 真人接手中的會話不吃 24 小時自動結束，這是唯一會收殮它們的機制——停掉的話
    // 忘記按「結束會話」的對話會永遠掛著（那位客人也永遠收不到自動回覆）
    { name: 'conversation:auto-close-idle', run: () => autoCloseIdleHumanSessions(db) },
    { name: 'conversation:handoff-sla', run: () => remindOverdueHandoffs(db) },
    { name: 'conversation:backlog-digest', run: () => dailyBacklogDigest(db) },
    // 紅色異常主動推到值班人員的 LINE（D-8②）。掛在這支既有排程上＝不用再去
    // Cloud Scheduler 建第三個任務（兩個租戶各一次的手動工）；內部有節流：
    // 台北時間 09–21 點外整支早退，每個帳號一小時才真的查一次。
    { name: 'alerts:critical-push', run: () => pushCriticalAlerts(db) },
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

  // 心跳先寫（C-48）：原本寫在所有 await 之後——任何一項任務拖到撞閘道逾時，
  // 心跳就沒寫到 → 小幫手誤報「背景維護停擺」，而任務其實每輪都跑了大半。
  // 心跳的語意是「排程有進來」（Cloud Scheduler 停了/secret 換了才該紅），不是「全部成功」；
  // 成功與否由下面的 failedTasks 補記。
  await db.collection('cronState').doc('maintenance-heartbeat').set({
    lastRunAt: Date.now(),
  }, { merge: true }).catch(e => console.warn('[cron/run-tasks] heartbeat write failed:', e))

  const settled = await Promise.allSettled(tasks.map(t => t.run()))
  const results = tasks.map((t, i) => {
    const s = settled[i]!
    return s.status === 'fulfilled'
      ? { task: t.name, ok: true as const, result: s.value }
      : { task: t.name, ok: false as const, error: String((s.reason as any)?.message ?? s.reason).slice(0, 300) }
  })

  const failed = results.filter(r => !r.ok)
  if (failed.length) console.warn('[cron/run-tasks] failed:', failed)

  await db.collection('cronState').doc('maintenance-heartbeat').set({
    lastCompletedAt: Date.now(),
    failedTasks: failed.map(f => f.task),
  }, { merge: true }).catch(e => console.warn('[cron/run-tasks] heartbeat write failed:', e))

  return { ok: failed.length === 0, ms: Date.now() - startedAt, results }
})
