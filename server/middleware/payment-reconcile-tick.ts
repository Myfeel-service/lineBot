import { runBillingReconcile } from '../utils/run-billing-reconcile'
import { isLambdaRuntime } from '../utils/lambda-runtime'

// 對帳不需即時（查漏接 Notify、到期降級都容得下延遲）→ 半小時最多一次,壓低請求負擔。
const TICK_INTERVAL_MS = 30 * 60 * 1000

let lastTickAt = 0
let ticking = false

/**
 * 有 API 流量時順便跑計費對帳（給**有長駐進程**的部署用）。與手動端點 /api/payment/reconcile
 * 及外部排程並存——runBillingReconcile 全程冪等,重複跑安全。in-memory 節流是「每個 instance」層級,
 * 多 instance 各自跑也沒關係（冪等）。金流未設定就跳過,不空轉。
 *
 * ⛔ Lambda（Amplify）上一律停用:這裡是 fire-and-forget,回應一送出執行環境就被凍結——
 * 對帳做到一半停住,而且 `.finally()` 不會跑 → `ticking` 永遠是 true,那個容器之後再也不對帳。
 * 這條路在 Lambda 上不是備援,是「看起來有在做、其實半殘」（2026-08-13 code review;
 * 同款寫法讓排程推播整批沒送出,見 docs/STATUS.md `A-10`）。
 * Lambda 的對帳由 Cloud Scheduler 每 10 分鐘打 `/api/cron/run-tasks` 的
 * `billing:reconcile-and-charge` 負責——那條會等它跑完,而且是唯一能刷卡的路。
 */
export default defineEventHandler((event) => {
  if (import.meta.prerender) return
  if (isLambdaRuntime()) return
  // 只在正式部署跑。本機 dev 常連正式 Firestore,不該讓一次本機請求就觸發全站對帳/降級。
  // 手動端點 /api/payment/reconcile 在任何環境都能測。
  if (import.meta.dev) return

  const path = String(event.path || '')
  if (!path.startsWith('/api/')) return
  if (path.includes('/payment/reconcile')) return // 別跟手動端點打架

  const now = Date.now()
  if (ticking || now - lastTickAt < TICK_INTERVAL_MS) return

  const config = useRuntimeConfig(event) as unknown as Record<string, unknown>
  // 沒設任何金流特店 → 沒有訂單要對帳,直接跳過（避免每半小時空掃 workspaces）
  if (!config.payuniMerchantId && !config.newebpayMerchantId) return

  ticking = true
  lastTickAt = now

  // ⚠️ 刻意**不帶 charge**:這裡是 fire-and-forget（下面沒有 await）,不能拿來刷卡。
  //    續扣只走 /api/payment/reconcile（外部排程 + 會等它跑完）。這支只做對帳與清理。
  runBillingReconcile(config)
    .then((out) => {
      if (out.payuni?.recovered || out.downgraded || out.expiredOrders) {
        console.log('[payment-reconcile-tick]', JSON.stringify({ recovered: out.payuni?.recovered, downgraded: out.downgraded, expiredOrders: out.expiredOrders }))
      }
    })
    .catch((e) => {
      console.error('[payment-reconcile-tick] 失敗', e)
    })
    .finally(() => {
      ticking = false
    })
})
