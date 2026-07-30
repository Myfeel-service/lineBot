import { runBillingReconcile } from '../utils/run-billing-reconcile'

// 對帳不需即時（查漏接 Notify、到期降級都容得下延遲）→ 半小時最多一次,壓低請求負擔。
const TICK_INTERVAL_MS = 30 * 60 * 1000

let lastTickAt = 0
let ticking = false

/**
 * 有 API 流量時順便跑計費對帳（彌補 Amplify 無長駐 Cron）。與手動端點 /api/payment/reconcile
 * 及外部排程並存——runBillingReconcile 全程冪等,重複跑安全。in-memory 節流是「每個 instance」層級,
 * 多 instance 各自跑也沒關係（冪等）。金流未設定就跳過,不空轉。
 */
export default defineEventHandler((event) => {
  if (import.meta.prerender) return
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
