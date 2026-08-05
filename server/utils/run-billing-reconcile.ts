/**
 * 每日/定期計費對帳的單一入口——手動端點（/api/payment/reconcile）與「有流量時順便跑」的
 * middleware tick 都呼叫這支,確保兩條路做的事完全一致。
 *
 * 順序有意義：① 先對每筆 pending 主動查 PAYUNi（漏接 Notify 的補救,已付就補開通）
 *            ② 再把「過期訂閱滾期/降級」「真的沒付且逾時的 pending 標逾期」落地
 *            ③ **每期自動續扣**（必須在 ② 之後——是 ② 的 roll 把到期的自動續訂標成
 *               past_due,續扣就是照這個狀態挑人;順序顛倒的話當天到期的人會晚一天才被扣）
 *            ④ 補開之前失敗的發票 ⑤ 續扣前提醒 + 額度通知（未設 SES 時內部略過,零成本）
 */
import { runPaymentReconcile } from './payment'
import { reconcilePayuniPending } from './payuni-reconcile'
import { chargeDueRecurring } from './payuni-recurring'
import { invoiceKeysFromConfig, reissueFailedInvoices } from './invoice'
import { sendDueBillingEmails } from './billing-emails'

export async function runBillingReconcile(
  config: Record<string, unknown>,
  now: Date = new Date(),
  opts?: {
    /**
     * 是否執行「每期自動續扣」（真的會刷客戶的卡）。
     *
     * ⚠️ **預設 false**,只有被 `await` 的 cron 端點（/api/payment/reconcile）該傳 true。
     *    `payment-reconcile-tick` middleware 是 fire-and-forget:HTTP 回應送出後 Lambda
     *    可能凍結／回收容器,正在授權中的 fetch 會被硬切——PAYUNi 已經授權、我方卻連
     *    「結果未定」的處理都跑不到,錢收了卻沒有任何紀錄。會動到錢的事只放在會等它跑完的路徑上。
     */
    charge?: boolean
  },
) {
  const payuni = await reconcilePayuniPending(config, now)
  // 降級時順手向 PAYUNi 解除卡片約定（清潔工作;金鑰沒設就只寫資料庫）
  const merchantId = String(config.payuniMerchantId || '').trim()
  const merKey = String(config.payuniHashKey || '')
  const merIV = String(config.payuniHashIV || '')
  const payuniCfg = merchantId && merKey && merIV
    ? { merchantId, keys: { merKey, merIV }, env: config.payuniEnv, relayBase: config.payuniRelayBase }
    : null
  const result = await runPaymentReconcile(now, undefined, payuniCfg)
  const recurring = opts?.charge
    ? await chargeDueRecurring(config, now)
    : null
  const invoices = await reissueFailedInvoices(invoiceKeysFromConfig(config))
  const emails = await sendDueBillingEmails(now)
  return { ...result, payuni, recurring, invoices, emails }
}
