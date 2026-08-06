/**
 * 主動查單對帳（漏接 Notify 的補救）。
 *
 * 對每筆 pending 訂單打 PAYUNi 交易查詢（trade/query），已付款就走與 Notify 完全相同的
 * 開通路徑（fulfillPayuniTrade）。用途:客戶付了錢、但 Notify 沒送達／我方當機／有 bug 時,
 * 訂單不會卡在 pending 被 runPaymentReconcile 誤判逾期 → 避免「收了錢卻沒開通」。
 *
 * 金流未設定、單筆查詢失敗都安全跳過（try/catch），不影響其餘對帳。
 *
 * ⚠️ trade/query 的 HTTP 送法（本檔用 x-www-form-urlencoded）尚未對真實 PAYUNi 驗證;
 *    上線前請對測試特店跑一次確認回傳可解（純函式 buildTradeQuery/簽章已有單元測試）。
 */
import { getDb } from './firebase'
import { getPendingOrders } from './payment'
import { PAYUNI_QUERY_ENDPOINTS, buildTradeQuery, isQueryTradePaid, parsePayuniQueryResult, queryCardBinding, resolvePayuniEnv, sanitizeCreditTokenRef, verifyAndDecryptPayuniNotify, type PayuniKeys } from './payuni'
import { fulfillPayuniTrade } from './payuni-fulfill'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

/** 一次對帳最多查幾筆 pending（上限,避免 backlog 一次打爆 PAYUNi） */
const MAX_PENDING_PER_RUN = 200
/** 同時併發幾筆查詢（別對閘道一次開太多連線） */
const QUERY_CONCURRENCY = 5

export async function reconcilePayuniPending(
  config: Record<string, unknown>,
  now: Date = new Date(),
): Promise<{ checked: number; recovered: number }> {
  const merchantId = String(config.payuniMerchantId || '').trim()
  const keys: PayuniKeys = { merKey: String(config.payuniHashKey || ''), merIV: String(config.payuniHashIV || '') }
  if (!merchantId || !keys.merKey || !keys.merIV) return { checked: 0, recovered: 0 } // 金流未設定 → 略過
  const url = PAYUNI_QUERY_ENDPOINTS[resolvePayuniEnv(config.payuniEnv)]
  const ts = Math.floor(now.getTime() / 1000)

  const pending = await getPendingOrders(getDb(), MAX_PENDING_PER_RUN)

  /** 查一筆:已付款就補開通,回傳是否有真的補到。全程 try/catch,失敗回 false 不影響其他筆。 */
  const queryOne = async (order: PaymentOrderDoc): Promise<boolean> => {
    try {
      const fields = buildTradeQuery(merchantId, order.merchantOrderNo, keys, ts)
      // 明確用 text 讀回再自己 JSON.parse——不倚賴 PAYUNi 有沒有給 JSON content-type
      // （否則 $fetch 會回字串、EncryptInfo 變 undefined,整個補救靜默失效）。
      const raw = await $fetch<string>(url, {
        method: 'POST',
        body: new URLSearchParams({
          MerID: fields.MerID,
          Version: fields.Version,
          EncryptInfo: fields.EncryptInfo,
          HashInfo: fields.HashInfo,
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        responseType: 'text',
      })
      let resp: Record<string, string>
      try { resp = JSON.parse(raw) }
      catch { console.warn('[payuni:reconcile] 回應非 JSON,略過', order.merchantOrderNo); return false }

      const enc = String(resp?.EncryptInfo || '')
      const hash = String(resp?.HashInfo || '')
      if (!enc || !hash) return false
      // 查單回傳是巢狀 Result[0][...],格式與 Notify 不同 → 先攤平,再用「查單語意」判付款。
      const decrypted = verifyAndDecryptPayuniNotify(enc, hash, keys)
      const result = parsePayuniQueryResult(decrypted as Record<string, string | undefined> | null)
      // **只在 PAYUNi 確認已付款時補開通**;未付／查無訂單 → 留著讓它照時間到期,
      // 絕不能把還在等付款的 pending 丟給 settle(paid=false) 誤標成 failed。
      if (!isQueryTradePaid(result)) return false

      // ⚠️ **首刷的約定 Token 要在這裡補回來,否則客戶付了首期卻不會有下一期扣款。**
      // `trade/query` 的回傳結構裡**沒有** CreditHash（2026-08-06 實測確認,欄位清單見
      // payuni.ts 的 queryCardBinding 註解）→ 走這條補救路徑結算的 `period_first` 訂單,
      // 會被 settlePaidOrder 判成 cardBindFailed:autoRenew 不開、期末寬限期滿靜默降級。
      // 補法:拿我方首刷時送出的參照字串（CreditToken = workspaceId）向
      // credit_bind/query 反查憑證,塞回 result 讓下游 parseCardMandate 照原路吃。
      // 查不到也照樣結算（錢已經收了,開通不能等）——只是 cardBindFailed 會被記錄。
      if (order.kind === 'period_first' && !result.CreditHash && order.workspaceId) {
        const bind = await queryCardBinding({
          merchantId,
          creditToken: sanitizeCreditTokenRef(order.workspaceId),
          timestamp: ts,
        }, keys, config.payuniEnv, config.payuniRelayBase)
        if (bind.mandate) {
          result.CreditHash = bind.mandate.token
          if (bind.mandate.last4) result.Card4No = bind.mandate.last4
          if (bind.mandate.expiry) result.CreditLife = bind.mandate.expiry
          console.log('[payuni:reconcile] 首刷約定已由 credit_bind/query 補回', order.merchantOrderNo)
        }
        else {
          console.warn('[payuni:reconcile] 首刷訂單補開通但查不到約定憑證,自動續扣不會發生:', order.merchantOrderNo, bind.outerStatus)
        }
      }

      const r = await fulfillPayuniTrade(true, result, config)
      return r.outcome === 'settled'
    }
    catch (e) {
      console.warn('[payuni:reconcile] 查單失敗', order.merchantOrderNo, (e as Error)?.message)
      return false
    }
  }

  let recovered = 0
  for (let i = 0; i < pending.length; i += QUERY_CONCURRENCY) {
    const chunk = pending.slice(i, i + QUERY_CONCURRENCY)
    const results = await Promise.all(chunk.map(queryOne))
    recovered += results.filter(Boolean).length
  }
  return { checked: pending.length, recovered }
}
