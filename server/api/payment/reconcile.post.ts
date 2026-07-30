import { runBillingReconcile } from '~~/server/utils/run-billing-reconcile'

/**
 * POST /api/payment/reconcile — 計費對帳（由排程 / 手動觸發）。
 * 內容見 runBillingReconcile（查單補開通、過期滾期降級、清逾時 pending、補發票、通知信）。
 *
 * Amplify 不跑 scheduledTasks,故：① 外部排程（EventBridge / Cloud Scheduler）帶 X-Cron-Secret 打此端點,
 * ② 另有 payment-reconcile-tick middleware「有 API 流量時順便跑」當保險（見該檔）。
 *
 * ⚠️ 這支只是把週期落地成資料。額度重置與到期降級的正確性不依賴它——每次讀訂閱都會就地推算當期。
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const cronSecret = String(config.cronSecret || '').trim()
  const headerSecret = String(getHeader(event, 'x-cron-secret') || '').trim()
  if (!cronSecret || headerSecret !== cronSecret) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  // charge: true —— **只有這條被 await 的路徑**才執行每期自動續扣（會真的刷卡）。
  // middleware 的 tick 是 fire-and-forget,不給它刷卡（見 runBillingReconcile 的 opts 註解）。
  const result = await runBillingReconcile(config as unknown as Record<string, unknown>, new Date(), { charge: true })
  return { ok: true, ...result }
})
