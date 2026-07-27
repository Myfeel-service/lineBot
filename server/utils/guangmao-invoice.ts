/**
 * 光貿(Amego)電子發票 API 加值中心 —— 開立工具。
 *
 * 取代原本的 ezPay(藍新)電子發票。光貿走標準 REST JSON,規格比 ezPay 單純:
 *   - 端點      https://invoice-api.amego.tw/json/f0401  (B2C/B2B 開立;POST form)
 *   - 外層 4 欄  invoice(賣方統編) / data(發票資料 JSON 字串) / time(Unix 秒) / sign
 *   - 簽章      sign = md5(data + time + APP_KEY)  ← 只要一把 APP_KEY,不用對稱加密
 *   - 回應      { code, msg, ... };code === 0 為成功
 *
 * ⚠️ **未設定金鑰 → 靜默跳過**(見 isInvoiceConfigured),收款照常、只是不開發票。
 *    這點與 ezPay 版本一致,invoice.ts 的流程不用改。
 *
 * ⚠️ **sign 用的 data 字串必須與 POST 出去的 data 是「同一個字串」**。JSON.stringify
 *    的欄位順序/空白只要有一點不同,光貿就會回 code 16(簽名驗證錯誤)。所以下面
 *    一律先 stringify 成 dataStr,再拿同一個 dataStr 去算 sign 與送出,不可各算一次。
 *
 * 規格來源:https://invoice.amego.tw/api_doc/example 與錯誤碼頁 info_detail?mid=71。
 * 標 `TODO(光貿文件)` 的是還沒從官方後台文件/沙盒實測確認的欄位,拿到測試帳號後補實。
 */
import { createHash } from 'crypto'
import { splitTax, TAX_RATE_PERCENT } from '~~/shared/billing/tax'
import type { IssueInvoiceInput, IssueInvoiceResult } from './invoice-profile'

/** 光貿商店金鑰:賣方統編 + 一把 APP_KEY + API 網址。 */
export interface GuangmaoInvoiceKeys {
  /** 賣方(開立方)統一編號 —— 對應外層 `invoice` 欄位。 */
  sellerUBN: string
  /** 光貿後台核發的 APP_KEY —— 用來算 sign,不會送出去。 */
  appKey: string
  /** 沙盒/正式 API 原點,如 https://invoice-api.amego.tw */
  apiUrl: string
}

/** 三個值都設好才算開通;未開通 → 不開發票(但不擋收款)。 */
export function isInvoiceConfigured(keys: Partial<GuangmaoInvoiceKeys> | null | undefined): keys is GuangmaoInvoiceKeys {
  return Boolean(keys?.sellerUBN && keys?.appKey && keys?.apiUrl)
}

/**
 * 光貿各訊息的端點(外層欄位與 sign 三支都一樣,只有路徑不同)。
 * f0501/g0401 為 2025 官方文件異動後的新路徑(舊 c0501/d0401 已停用)。
 */
const ENDPOINT = {
  issue: '/json/f0401', // 開立
  void: '/json/f0501', // 作廢
  allowance: '/json/g0401', // 開立折讓
  voidAllowance: '/json/g0501', // 作廢折讓  TODO(光貿文件): 確認路徑(MOF D0501)
} as const

/** B2C 無統編時的買方統編填法(財政部標準:十個 0)。 */
const B2C_BUYER_IDENTIFIER = '0000000000'

/**
 * 手機條碼載具的載具類別碼(財政部標準)。
 * TODO(光貿文件): 確認光貿是否沿用財政部標準碼 3J0002;自然人憑證為 CQ0001。
 */
const CARRIER_TYPE_MOBILE_BARCODE = '3J0002'

/** md5(data + time + appKey),小寫 hex。 */
export function makeSign(dataStr: string, time: number | string, appKey: string): string {
  return createHash('md5').update(`${dataStr}${time}${appKey}`, 'utf8').digest('hex')
}

/**
 * 組 f0401 的 data 物件(尚未 stringify)。
 *
 * 稅務:方案價是**含稅**價(見 shared/billing/tax.ts),TotalAmount 就是刷卡金額,
 * SalesAmount(未稅)與 TaxAmount 由它反推,三者保證相加相等(財政部會檢核)。
 *
 * B2B(有統編)→ BuyerIdentifier 帶統編、PrintMark=Y(公司要報帳,不能只給載具)。
 * B2C → 載具 / 捐贈 / 紙本 三選一;都沒填就開紙本。
 */
export function buildIssueInvoiceData(input: IssueInvoiceInput): Record<string, unknown> {
  const { totalAmt, amt, taxAmt } = splitTax(input.totalAmt)
  const p = input.profile
  const ubn = String(p.buyerUBN || '').trim()
  const isB2B = /^\d{8}$/.test(ubn)

  // 單一品項:B2B 單價未稅、B2C 單價含稅(與財政部/加值中心的檢核一致)
  // TODO(光貿文件): 對一下光貿 ProductItem 的 UnitPrice/Amount 是否也依 B2B/B2C 分未稅/含稅。
  const unit = isB2B ? amt : totalAmt

  const data: Record<string, unknown> = {
    OrderId: input.merchantOrderNo,
    BuyerIdentifier: isB2B ? ubn : B2C_BUYER_IDENTIFIER,
    BuyerName: String(p.buyerName || '').trim() || input.fallbackBuyerName,
    TaxType: '1', // 應稅
    // TODO(光貿文件): 確認 TaxRate 要送小數(0.05)還是整數(5)。財政部 MIG F0401 用小數。
    TaxRate: TAX_RATE_PERCENT / 100,
    SalesAmount: amt,
    FreeTaxSalesAmount: 0,
    ZeroTaxSalesAmount: 0,
    TaxAmount: taxAmt,
    TotalAmount: totalAmt,
    ProductItem: [
      {
        Description: input.itemName,
        Quantity: 1,
        UnitPrice: unit,
        Amount: unit,
        TaxType: '1',
      },
    ],
  }

  const email = String(p.buyerEmail || '').trim()
  if (email) data.BuyerEmailAddress = email // TODO(光貿文件): 確認欄位名是否為 BuyerEmailAddress

  if (isB2B) {
    data.PrintMark = 'Y' // TODO(光貿文件): 確認「索取紙本」欄位名(PrintMark) 與值(Y/N)
    return data
  }

  // ── B2C：載具 / 捐贈 / 紙本,三者互斥 ──
  const carrier = String(p.carrierNum || '').trim().toUpperCase()
  const love = String(p.loveCode || '').trim()
  if (carrier) {
    // TODO(光貿文件): 確認載具欄位名(CarrierType/CarrierId1/CarrierId2) 與手機條碼類別碼
    data.CarrierType = CARRIER_TYPE_MOBILE_BARCODE
    data.CarrierId1 = carrier
    data.CarrierId2 = carrier
    data.PrintMark = 'N'
  }
  else if (love) {
    data.NPOBAN = love // 捐贈碼(愛心碼)
    data.PrintMark = 'N'
  }
  else {
    data.PrintMark = 'Y' // 沒載具沒捐贈 → 開紙本
  }
  return data
}

/** 光貿呼叫的結果外殼:httpError 非 null = 連 HTTP 層都沒成功;否則看 code(0=成功)。 */
interface AmegoCallResult {
  httpError: string | null
  code: number
  raw: Record<string, unknown>
}

/**
 * 送一包 data 到光貿某支端點。三支端點(f0401/f0501/g0401)外層與 sign 都一樣,
 * 只有路徑與 data 內容不同,所以共用這支。
 *
 * ⚠️ sign 用的 dataStr 與送出的 data **必須是同一個字串**(見檔頭說明),否則回 code 16。
 */
async function callAmego(
  endpoint: string,
  data: Record<string, unknown>,
  keys: GuangmaoInvoiceKeys,
): Promise<AmegoCallResult> {
  const dataStr = JSON.stringify(data)
  const time = Math.floor(Date.now() / 1000)
  const sign = makeSign(dataStr, time, keys.appKey)

  const body = new URLSearchParams({
    invoice: keys.sellerUBN,
    data: dataStr,
    time: String(time),
    sign,
  })

  const res = await fetch(`${keys.apiUrl.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    return { httpError: `HTTP_${res.status}`, code: Number.NaN, raw: {} }
  }
  const raw = await res.json() as Record<string, unknown>
  return { httpError: null, code: Number(raw?.code), raw }
}

/**
 * 呼叫光貿開立發票(server→server)。
 * 網路錯誤 / 平台回錯一律回 ok:false,由呼叫端記錄——**開票失敗絕不能回頭影響收款**。
 */
export async function issueInvoice(
  input: IssueInvoiceInput,
  keys: GuangmaoInvoiceKeys,
): Promise<IssueInvoiceResult> {
  const r = await callAmego(ENDPOINT.issue, buildIssueInvoiceData(input), keys)
  if (r.httpError) return { ok: false, status: r.httpError, message: `光貿回應 ${r.httpError}` }

  // TODO(光貿文件): 確認回應欄位名。已知 code===0 成功、16 簽名錯、3040171 OrderId 重複。
  //   invoice_number / random_number / invoice_time 為推測欄位名,拿到沙盒回應後對實。
  const raw = r.raw as { msg?: string; invoice_number?: string; invoice_time?: string; random_number?: string }
  const message = String(raw?.msg || '')
  if (r.code !== 0) return { ok: false, status: String(r.raw?.code ?? 'UNKNOWN'), message }

  return {
    ok: true,
    status: '0',
    message,
    invoiceNumber: raw.invoice_number != null ? String(raw.invoice_number) : undefined,
    randomNum: raw.random_number != null ? String(raw.random_number) : undefined,
    createTime: raw.invoice_time != null ? String(raw.invoice_time) : undefined,
  }
}

// ── 作廢發票(f0501) ──────────────────────────────────────────────────

export interface VoidInvoiceInput {
  /** 要作廢的發票號碼(10 碼)。 */
  invoiceNumber: string
  /** 該發票的開立日期。TODO(光貿文件): 確認格式(YYYYMMDD 或 YYYY-MM-DD)。 */
  invoiceDate: string
  /** 作廢原因(財政部規定必填)。 */
  reason: string
}

export interface VoidInvoiceResult {
  ok: boolean
  status: string
  message: string
}

/**
 * 組作廢 data。TODO(光貿文件): 確認欄位名——MOF C0501 用 CancelInvoiceNumber/InvoiceDate/
 *   CancelReason;光貿 JSON 版可能簡化成 InvoiceNumber/InvoiceDate/CancelReason,待沙盒對實。
 */
export function buildVoidInvoiceData(input: VoidInvoiceInput): Record<string, unknown> {
  return {
    InvoiceNumber: input.invoiceNumber,
    InvoiceDate: input.invoiceDate,
    CancelReason: input.reason,
  }
}

/** 作廢一張已開立的發票。與開立一樣,失敗只回 ok:false 由呼叫端記錄。 */
export async function voidInvoice(
  input: VoidInvoiceInput,
  keys: GuangmaoInvoiceKeys,
): Promise<VoidInvoiceResult> {
  const r = await callAmego(ENDPOINT.void, buildVoidInvoiceData(input), keys)
  if (r.httpError) return { ok: false, status: r.httpError, message: `光貿回應 ${r.httpError}` }
  const message = String((r.raw as { msg?: string })?.msg || '')
  return { ok: r.code === 0, status: String(r.raw?.code ?? 'UNKNOWN'), message }
}

// ── 開立折讓(g0401) ──────────────────────────────────────────────────
//
// 折讓 = 部分退款/折抵時,對「原發票」開一張折讓證明單(不是作廢整張)。升級退費採
// 「折抵不退現金」時會用到(見升級退費評估)。整張退款且發票當期未跨月 → 用作廢較單純。

export interface AllowanceInput {
  /** 原發票號碼。 */
  invoiceNumber: string
  /** 折讓品項名稱。 */
  itemName: string
  /** 折讓總額(含稅)。由此反推未稅/稅額,三者相加相等。 */
  totalAmt: number
  /** 折讓證明單號(不給則交由光貿配號)。TODO(光貿文件): 確認是否需自帶。 */
  allowanceNumber?: string
  /** 折讓日期。TODO(光貿文件): 確認格式與是否必填。 */
  allowanceDate?: string
}

export interface AllowanceResult {
  ok: boolean
  status: string
  message: string
  /** 折讓證明單號(成功才有)。 */
  allowanceNumber?: string
}

/**
 * 組折讓 data。TODO(光貿文件): 欄位名待沙盒對實——MOF D0401 折讓含 AllowanceNumber/
 *   AllowanceDate/原發票號碼、ProductItem(每項要帶原發票號碼與日期)、TaxAmount/TotalAmount。
 *   下面是依標準組的骨架,拿到文件後校正欄位名與「品項是否需逐項對應原發票」。
 */
export function buildAllowanceData(input: AllowanceInput): Record<string, unknown> {
  const { totalAmt, amt, taxAmt } = splitTax(input.totalAmt)
  const data: Record<string, unknown> = {
    InvoiceNumber: input.invoiceNumber,
    TaxType: '1',
    TaxAmount: taxAmt,
    TotalAmount: totalAmt,
    ProductItem: [
      {
        Description: input.itemName,
        Quantity: 1,
        UnitPrice: amt, // 折讓品項一般以未稅計,TODO(光貿文件)確認
        Amount: amt,
        Tax: taxAmt,
        TaxType: '1',
        OriginalInvoiceNumber: input.invoiceNumber,
      },
    ],
  }
  if (input.allowanceNumber) data.AllowanceNumber = input.allowanceNumber
  if (input.allowanceDate) data.AllowanceDate = input.allowanceDate
  return data
}

/** 對原發票開立折讓證明單。 */
export async function issueAllowance(
  input: AllowanceInput,
  keys: GuangmaoInvoiceKeys,
): Promise<AllowanceResult> {
  const r = await callAmego(ENDPOINT.allowance, buildAllowanceData(input), keys)
  if (r.httpError) return { ok: false, status: r.httpError, message: `光貿回應 ${r.httpError}` }
  const raw = r.raw as { msg?: string; allowance_number?: string }
  const message = String(raw?.msg || '')
  return {
    ok: r.code === 0,
    status: String(r.raw?.code ?? 'UNKNOWN'),
    message,
    // TODO(光貿文件): 確認折讓單號回應欄位名(allowance_number 為推測)
    allowanceNumber: raw?.allowance_number != null ? String(raw.allowance_number) : undefined,
  }
}
