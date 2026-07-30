/**
 * 依 PAYUNi 交易結果結算訂單並（成功時）開通、開發票、寄收據。
 *
 * Notify webhook 與「主動查單對帳」共用這一支——確保「漏接 Notify 後補查」走的是與
 * Notify 完全相同的開通/開票/通知路徑,不會有兩套會漂移的邏輯。全程冪等
 * （settlePaidOrder 以訂單現況擋重複;發票開立內部也擋重開）。
 */
import { cancelCardBinding, parseCardMandate, payuniPaymentType, type PayuniTradeResult } from './payuni'
import { settlePaidOrder } from './payment'
import { invoiceKeysFromConfig, issueInvoiceForOrder } from './invoice'
import { sendReceiptNotification } from './billing-emails'

export interface PayuniFulfillResult {
  merchantOrderNo: string
  paid: boolean
  /** 'no-order' = 回傳缺 MerTradeNo,無法對應訂單 */
  outcome: 'settled' | 'already' | 'unknown' | 'no-order'
  amountMismatch?: boolean
  /** 訂閱首期收到錢卻沒拿到約定 Token（見 SettleOrderResult.cardBindFailed）。 */
  cardBindFailed?: boolean
}

/**
 * @param paid  這筆是否已付款。**由呼叫端決定**（Notify 用 isPayuniPaid、查單對帳用 isTradePaid）——
 *              因為 Notify 與查單的外層狀態碼不同,paid 的判法也不同。
 */
export async function fulfillPayuniTrade(
  paid: boolean,
  result: PayuniTradeResult,
  config: Record<string, unknown>,
): Promise<PayuniFulfillResult> {
  const merchantOrderNo = String(result.MerTradeNo || '').trim()
  if (!merchantOrderNo) return { merchantOrderNo: '', paid: false, outcome: 'no-order' }

  const amtNum = Number(result.TradeAmt)
  const amount = Number.isFinite(amtNum) ? amtNum : undefined

  // 首刷建立的信用卡約定（CreditHash + 末四碼 + 有效期）。**是否採用由訂單 kind 決定**
  // （settlePaidOrder 內把關）——這裡只負責把回傳的欄位攤出來,不做授權判斷。
  const card = parseCardMandate(result)

  const settled = await settlePaidOrder({
    merchantOrderNo,
    paid,
    amount,
    payuniCard: card,
    tradeNo: result.TradeNo != null ? String(result.TradeNo) : null,
    paymentType: payuniPaymentType(result.PaymentType),
    // 失敗時把 PAYUNi 的錯誤訊息帶進去(卡片被拒/餘額不足…),供帳單頁顯示
    failReason: paid ? null : (result.Message ? String(result.Message) : null),
    now: new Date(),
    notifyRaw: {
      TradeStatus: result.TradeStatus ?? null,
      MerTradeNo: merchantOrderNo,
      TradeAmt: amount ?? null,
      TradeNo: result.TradeNo ?? null,
      PaymentType: result.PaymentType ?? null,
      PayTime: result.PayTime ?? null,
    },
  })

  // 開立電子發票 + 收據信。**吞掉所有失敗**——錢已經收了,開票/寄信失敗不能讓上游
  // 回非 200（PAYUNi 會重送 → 重複結算）。失敗會記在 invoices / 訂單上供補開。
  if (paid && settled.outcome === 'settled' && !settled.amountMismatch && settled.workspaceId) {
    await issueInvoiceForOrder({
      merchantOrderNo,
      workspaceId: settled.workspaceId,
      planId: settled.planId!,
      totalAmt: settled.amount!,
    }, invoiceKeysFromConfig(config))
    await sendReceiptNotification(merchantOrderNo)
  }

  // 訂閱首期收了錢卻沒建成約定 → 不會有下一期自動扣款,期末會默默掉回免費層。
  // 大聲記錄（P3 接上通知後改為主動告警）。
  if (settled.cardBindFailed) {
    console.error('[payuni] 訂閱首期已付款但未取得約定 Token,自動續扣不會發生:', merchantOrderNo)
  }

  // 換卡:新 Token 取代了舊的 → 把**舊約定**解掉。
  // 不解的話,舊 CreditHash 已經被覆蓋、我方再也拿不到它,那組約定就永遠留在客戶的卡上
  // （見 SettleOrderResult.replacedCardToken）。失敗只記錄,不影響開通——錢已經收了。
  if (settled.replacedCardToken) {
    const merchantId = String(config.payuniMerchantId || '').trim()
    const keys = { merKey: String(config.payuniHashKey || ''), merIV: String(config.payuniHashIV || '') }
    if (merchantId && keys.merKey && keys.merIV) {
      const r = await cancelCardBinding({
        merchantId,
        bindVal: settled.replacedCardToken,
        timestamp: Math.floor(Date.now() / 1000),
      }, keys, config.payuniEnv)
      if (r.ok || r.notFound) console.log('[payuni] 已解除被取代的舊卡約定', merchantOrderNo)
      else console.error('[payuni] 舊卡約定解除失敗,該組約定將無法再解除', merchantOrderNo, r.outerStatus, r.message)
    }
  }

  return {
    merchantOrderNo,
    paid,
    outcome: settled.outcome,
    amountMismatch: settled.amountMismatch,
    cardBindFailed: settled.cardBindFailed,
  }
}
