import type { Timestamp, FieldValue } from 'firebase-admin/firestore'
import type { BillingPlanId } from '../billing/plans'

// ═══════════════════════════════════════════════════════════════════
//  Collection: paymentOrders
//  Doc ID: merchantOrderNo（金流的商店訂單編號，僅英數，長度上限見 INVOICE_ORDER_NO_MAX）
//
//  一筆付款訂單即一次「開通某方案一期」的請求。建單時寫入 pending，
//  金額／方案以「建單當下後端寫入的值」為準（Notify 回傳只做比對，防竄改）。
//  金流 Notify（server→server）確認付款成功後由 webhook 改為 paid 並開通訂閱。
// ═══════════════════════════════════════════════════════════════════

export type PaymentOrderStatus = 'pending' | 'paid' | 'failed' | 'expired'

/**
 * 這筆帳是怎麼來的：
 * - `one_time`         單次付款（客戶自己回來刷一期；PAYUNi 自動扣款未開時的預設）
 * - `period_first`     訂閱首期（客戶按下訂閱那一刻）。**PAYUNi：這個 kind 就是「要建立
 *                      信用卡約定」的授權依據**——開通時只有這種單才會把回傳的 `CreditHash`
 *                      存成約定卡（見 settlePaidOrder），避免單次付款被悄悄變成每月扣款。
 * - `period_recurring` 第 2 期以後。**PAYUNi 與藍新語意相反**：藍新是金流自動扣完才回拋、
 *                      我方不建單；PAYUNi 是**我方排程主動建單**再打 /api/credit 幕後扣款。
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
   * 建單時決定的錨定日（每期在這一天續期／續扣）。
   * **開通時必須沿用這個值,不能重算**——跨午夜建單（23:59 建、00:00 開通）會讓續扣日
   * 與續期日差一天,之後每個月都會在寬限期的縫隙裡把付費客戶降級。
   */
  anchorDay?: number | null
  /** @deprecated 藍新定期定額委託單號；程式已移除,欄位保留只為歷史文件相容。 */
  periodNo?: string | null
  /** @deprecated 藍新定期定額遺留（程式已於 2026-07-30 移除）；欄位保留只為歷史文件相容。 */
  supersedesPeriodNo?: string | null
  /** @deprecated 同上，勿使用。 */
  supersedesPeriodOrderNo?: string | null
  /** @deprecated 同上，勿使用。 */
  periodTimes?: number | null
  /**
   * PAYUNi：這筆 `period_first` 有沒有真的建成信用卡約定（拿到 CreditHash）。
   * false 而 status=paid → 收了首期的錢但**不會有下一期自動扣款**,要人工處理。
   * Token 本身只存在訂閱上（敏感憑證不重複落在帳本）。
   */
  cardBound?: boolean | null
  /** 約定卡末四碼（非憑證，稽核／客服對帳用）。 */
  cardLast4?: string | null
  /**
   * 這筆用掉的折抵金額（`subscription.creditBalance`）。
   * `amount` 已經是**扣掉折抵後的實收金額**——發票也開這個數字（見 recurring.ts 的稅務說明）。
   * 結算成功時由 settlePaidOrder 依這個值把餘額扣掉,所以它必須存在訂單上（不能只存在記憶體裡,
   * 否則重試／補查時會重複扣或漏扣餘額）。
   */
  creditApplied?: number | null
  /** 金流端交易序號（Notify 回傳） */
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
  /**
   * 結帳前勾選同意條款的時間。
   *
   * 這是「本次交易不適用七日猶豫期」的舉證資料——法律前提是《通訊交易解除權合理例外
   * 情事適用準則》第 2 條第 5 款的「經消費者**事先**同意始提供」（見 shared/legal.ts）。
   * 沒有這個時間戳就等於沒有同意紀錄，發生爭議時排除猶豫期的主張站不住。
   */
  termsAcceptedAt?: Timestamp | FieldValue | null
  /** 客戶當時同意的條款版本（POLICY_VERSION）；條款改版後才知道他同意的是哪一版。 */
  termsVersion?: string | null
  createdAt: Timestamp | FieldValue
  paidAt?: Timestamp | FieldValue | null
  updatedAt: Timestamp | FieldValue
  /**
   * 對帳時**第一次**觀測到「PAYUNi 查無此單」的時間（只用在 period_recurring）。
   * 續扣單要相隔數分鐘、跨兩輪對帳都查無才作廢——理由見 payment.ts 的
   * markRecurringNotFoundSeen（一次誤判等於把可能已授權的那期作廢,下輪重複扣款）。
   */
  notFoundSeenAt?: Timestamp | FieldValue | null
  /** Notify 解密後的重點欄位（對帳／稽核用） */
  notifyRaw?: Record<string, unknown> | null
  /** 電子發票開立結果（見 invoices collection；這裡只留摘要供帳單頁顯示） */
  invoiceNumber?: string | null
  invoiceStatus?: 'issued' | 'failed' | 'skipped' | 'voided' | null
  /**
   * 已開折讓的累計金額（含稅）。折讓明細在 invoices doc 的 allowances；
   * 這裡只留總額,讓付款紀錄列表不用逐筆 join invoices 就能標「已折讓」。
   */
  invoiceAllowanceTotal?: number | null
  /**
   * 人工退款的累計金額（含稅）。**純紀錄,不動金流**——實際退款是人在 PAYUNi 商店
   * 後台操作的,系統原本完全不留痕（發票作廢有紀錄、錢退了沒有,對帳會斷,2026-08-16
   * 稽核 B-44③）。明細在 billingRefunds collection;之後若做 trade/close 自動退款,
   * 也沿用同一組欄位落帳。
   */
  manualRefundTotal?: number | null
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
  /**
   * 開立時實際送出的買方統編／抬頭（B2C 統編為 '0000000000'）。
   * 開折讓時買方須與原發票一致，故留快照；此欄上線前開立的舊發票沒有，開折讓時擋下請人工處理。
   */
  buyerIdentifier?: string | null
  buyerName?: string | null
  /**
   * 開立時送出的品名快照。發票上的品名以開立當下為準——方案日後改名不能回頭
   * 改歷史發票的顯示；沒有此欄的舊發票由明細端點用方案名回推並標註。
   */
  itemName?: string | null
  /** 作廢：超管把這張已開立發票作廢後留下的稽核欄位（見 /api/admin/super/void-invoice） */
  voided?: boolean
  voidReason?: string | null
  /** 光貿作廢回應的 code 字串（'0'=成功） */
  voidStatus?: string | null
  voidedAt?: Timestamp | FieldValue | null
  /** 折讓：對這張發票開過的折讓證明單（可多筆，部分折讓累加；見 /api/admin/super/allowance） */
  allowances?: InvoiceAllowanceRecord[]
}

/** 一筆折讓證明單的稽核紀錄（存在對應發票 doc 的 allowances 陣列裡）。 */
export interface InvoiceAllowanceRecord {
  /** 折讓證明單號（我方產生、≤16 碼、唯一）。 */
  allowanceNumber: string
  /** 折讓金額（含稅）。 */
  amount: number
  reason: string
  /** 光貿回應 code 字串（'0'=成功）。 */
  status: string
  /** 開立當下的毫秒時間（陣列元素不能放 serverTimestamp，故存數值）。 */
  createdAtMs: number
}
