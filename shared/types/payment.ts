import type { Timestamp, FieldValue } from 'firebase-admin/firestore'
import type { BillingPlanId } from '../billing/plans'

// ═══════════════════════════════════════════════════════════════════
//  Collection: paymentOrders
//  Doc ID: merchantOrderNo（藍新 MerchantOrderNo，僅英數，<=30 碼）
//
//  一筆付款訂單即一次「開通某方案一期」的請求。建單時寫入 pending，
//  金額／方案以「建單當下後端寫入的值」為準（Notify 回傳只做比對，防竄改）。
//  藍新 Notify（server→server）確認付款成功後由 webhook 改為 paid 並開通訂閱。
// ═══════════════════════════════════════════════════════════════════

export type PaymentOrderStatus = 'pending' | 'paid' | 'failed' | 'expired'

/**
 * 這筆帳是怎麼來的：
 * - `one_time`         單次付款（MPG；藍新未開通定期定額時的退路）
 * - `period_first`     定期定額委託的首期（客戶按下訂閱那一刻）
 * - `period_recurring` 定期定額的第 2 期以後（藍新自動扣款後回拋，我方不主動建單）
 */
export type PaymentOrderKind = 'one_time' | 'period_first' | 'period_recurring'

export interface PaymentOrderDoc {
  merchantOrderNo: string
  workspaceId: string
  organizationId?: string | null
  planId: BillingPlanId
  /** 應付金額（TWD 整數，含稅）；以建單時後端寫入為準 */
  amount: number
  status: PaymentOrderStatus
  kind?: PaymentOrderKind
  /**
   * 建單時決定的錨定日（= 送給藍新的 PeriodPoint）。
   * **開通時必須沿用這個值,不能重算**——跨午夜建單（23:59 建、00:00 開通）會讓藍新的
   * 扣款日與我方的續期日差一天,之後每個月都會在寬限期的縫隙裡把付費客戶降級。
   */
  anchorDay?: number | null
  /** 藍新定期定額委託單號（PeriodNo）；取消／暫停要拿它去打 AlterStatus */
  periodNo?: string | null
  /**
   * 換方案時「這張新委託要取代的**舊**委託」的單號。
   *
   * 舊委託不在建單當下終止——那會讓「放棄付款」的客戶白白丟掉他原本還在用的訂閱。
   * 改成把舊委託單號記在這裡,等新委託**首期扣款成功**（settlePaidOrder 開通）之後,
   * 才在 period-notify 裡終止舊委託。放棄付款 → 這張 pending 訂單被 reconcile 清成 expired、
   * 舊訂閱原封不動。
   */
  supersedesPeriodNo?: string | null
  supersedesPeriodOrderNo?: string | null
  /** 這是委託的第幾期（定期定額續期帳才有） */
  periodTimes?: number | null
  /** 藍新交易序號（Notify 回傳） */
  tradeNo?: string | null
  /** 付款方式（CREDIT / VACC / CVS…；Notify 回傳） */
  paymentType?: string | null
  /** 付款失敗原因（PAYUNi 回傳的 Message 或「金額不符」等）；顯示在帳單頁供客戶/客服排查 */
  failReason?: string | null
  /** 成功開通的本期起訖（YYYY-MM-DD，與訂閱一致） */
  periodStart?: string | null
  periodEnd?: string | null
  /** 建單者 uid（稽核用） */
  createdBy?: string | null
  createdAt: Timestamp | FieldValue
  paidAt?: Timestamp | FieldValue | null
  updatedAt: Timestamp | FieldValue
  /** Notify 解密後的重點欄位（對帳／稽核用） */
  notifyRaw?: Record<string, unknown> | null
  /** 電子發票開立結果（見 invoices collection；這裡只留摘要供帳單頁顯示） */
  invoiceNumber?: string | null
  invoiceStatus?: 'issued' | 'failed' | 'skipped' | null
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: invoices
//  Doc ID: merchantOrderNo（與付款訂單一對一）
// ═══════════════════════════════════════════════════════════════════

export interface InvoiceDoc {
  merchantOrderNo: string
  workspaceId: string
  /** 含稅總額（= 請款金額）、銷售額、稅額；三者相加必須相等 */
  totalAmt: number
  amt: number
  taxAmt: number
  ok: boolean
  /** 發票平台回傳狀態（光貿 code 字串，如 '0'=成功；或錯誤代碼） */
  status: string
  message?: string | null
  invoiceNumber?: string | null
  /** ezPay 專屬交易序號（沿用舊資料用；光貿不產生此欄） */
  invoiceTransNo?: string | null
  randomNum?: string | null
  /** ezPay CheckCode 驗證是否通過（沿用舊資料用）；false = 回應可疑，需人工確認 */
  checkCodeValid?: boolean | null
  createdAt: Timestamp | FieldValue
}
