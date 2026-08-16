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
 * 規格來源:官方 API 文件 https://invoice.amego.tw/api_doc/(JS 渲染單頁,curl 只會看到
 * Loading;實際內容在 invoice-static.amego.tw/www/api_doc/assets/main.bundle.js)、
 * 範例頁 /api_doc/example、錯誤碼頁 info_detail?mid=71、文件異動紀錄 info_detail?mid=76。
 * 標 `TODO(光貿文件)` 的是還沒從官方後台文件/沙盒實測確認的欄位,拿到測試帳號後補實。
 *
 * 光貿**沒有**「重寄發票通知 Email」的 API(2026-08-14 全文件查證):補發通知只存在
 * 商家後台網頁的「補發發票開立通知」按鈕。要自動重寄只能自己寄(取 PDF 附檔,見 B-29)。
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
  barcode: '/json/barcode', // 手機條碼查詢(驗「這組條碼存不存在」,格式檢查驗不出來)
  invoiceFile: '/json/invoice_file', // 發票證明聯 PDF(⚠️ 別跟 invoice_print 搞混,那支回熱感應機列印字串)
  // 折讓證明單也有 PDF:/json/allowance_file(帶 allowance_number + download_style),要用時再接
} as const

/** B2C 無統編時的買方統編填法(財政部標準:十個 0)。 */
const B2C_BUYER_IDENTIFIER = '0000000000'

/** 手機條碼載具的載具類別碼(財政部 F0401 標準,已對實;自然人憑證為 CQ0001)。 */
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
 *
 * 欄位名與型別已對過光貲官方 f0401 範例 + 財政部 MIG F0401 標準:
 *   · **金額/稅率一律送字串**(光貲範例是 'SalesAmount'=>'160'、'TaxRate'=>'0.05')。
 *   · TaxRate = '0.05'(小數,非 5)。
 *   · 載具 CarrierType='3J0002'(手機條碼)、CarrierId1=顯碼/CarrierId2=隱碼(手機條碼兩者同值)。
 *   · PrintMark 'Y'/'N'、NPOBAN(捐贈碼)、BuyerEmailAddress —— 皆為標準欄位名。
 *   · 回應欄位 invoice_number / invoice_time / random_number(見 issueInvoice)—— 已沙盒實測確認。
 *
 * ⚠️ **金額模型 B2B / B2C 不同,已用光貲測試環境實測(否則 B2C 全部 3040174/3040177 開不出來)**:
 *   · 品項 Amount **一律含稅**,加總 = TotalAmount(光貲檢核基準)。
 *   · B2B(三聯式,有統編):SalesAmount=未稅、TaxAmount=稅額、相加=TotalAmount。
 *   · B2C(二聯式,無統編):**SalesAmount=含稅(=TotalAmount)、TaxAmount=0**(稅內含,不另拆)。
 */
export function buildIssueInvoiceData(input: IssueInvoiceInput): Record<string, unknown> {
  const { totalAmt, amt, taxAmt } = splitTax(input.totalAmt)
  const p = input.profile
  const ubn = String(p.buyerUBN || '').trim()
  const isB2B = /^\d{8}$/.test(ubn)

  // 表頭:三聯式拆未稅+稅額;二聯式送含稅、稅額 0(見上面實測結論)。
  const salesAmount = isB2B ? amt : totalAmt
  const taxAmount = isB2B ? taxAmt : 0

  const data: Record<string, unknown> = {
    OrderId: input.merchantOrderNo,
    BuyerIdentifier: isB2B ? ubn : B2C_BUYER_IDENTIFIER,
    BuyerName: String(p.buyerName || '').trim() || input.fallbackBuyerName,
    TaxType: '1', // 應稅
    TaxRate: String(TAX_RATE_PERCENT / 100), // '0.05'(對過光貲範例)
    SalesAmount: String(salesAmount),
    FreeTaxSalesAmount: '0',
    ZeroTaxSalesAmount: '0',
    TaxAmount: String(taxAmount),
    TotalAmount: String(totalAmt),
    ProductItem: [
      {
        Description: input.itemName,
        Quantity: '1',
        // 品項一律含稅、加總 = TotalAmount(B2B/B2C 皆同,已實測)
        UnitPrice: String(totalAmt),
        Amount: String(totalAmt),
        TaxType: '1',
      },
    ],
  }

  const email = String(p.buyerEmail || '').trim()
  if (email) data.BuyerEmailAddress = email

  if (isB2B) {
    data.PrintMark = 'Y' // 公司報帳一定要能列印
    return data
  }

  // ── B2C：載具 / 捐贈 / 紙本,三者互斥 ──
  const carrier = String(p.carrierNum || '').trim().toUpperCase()
  const love = String(p.loveCode || '').trim()
  if (carrier) {
    data.CarrierType = CARRIER_TYPE_MOBILE_BARCODE // '3J0002'
    data.CarrierId1 = carrier // 顯碼
    data.CarrierId2 = carrier // 隱碼(手機條碼兩者同值)
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
 * 送一包 data 到光貲某支端點。三支端點外層與 sign 都一樣,只有路徑與 data 內容不同。
 *
 * ⚠️ **開立(f0401)的 data 是「單一物件」;作廢(f0501)/折讓(g0401)的 data 是「陣列」**
 *    (光貲這兩支支援一次多張,單物件會被退 3050112/4040112)。由呼叫端決定傳物件或陣列。
 * ⚠️ sign 用的 dataStr 與送出的 data **必須是同一個字串**(見檔頭說明),否則回 code 16。
 */
async function callAmego(
  endpoint: string,
  data: Record<string, unknown> | unknown[],
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
  // 光貲極少數情況(維護頁/被 WAF 擋)會回 200 但內容非 JSON → 不能讓它 throw,
  // 否則未包 try/catch 的呼叫端(void/allowance)會炸;一律轉成結構化失敗由呼叫端記錄。
  try {
    const raw = await res.json() as Record<string, unknown>
    return { httpError: null, code: Number(raw?.code), raw }
  }
  catch {
    return { httpError: 'BAD_JSON', code: Number.NaN, raw: {} }
  }
}

/**
 * 呼叫光貿開立發票(server→server)。
 * 網路錯誤 / 平台回錯一律回 ok:false,由呼叫端記錄——**開票失敗絕不能回頭影響收款**。
 */
export async function issueInvoice(
  input: IssueInvoiceInput,
  keys: GuangmaoInvoiceKeys,
): Promise<IssueInvoiceResult> {
  // 先組出 data,好把「實際送出的」買方統編/抬頭回傳存檔（折讓要對得上原發票，見 IssueInvoiceResult）。
  const data = buildIssueInvoiceData(input)
  const buyerIdentifier = String(data.BuyerIdentifier ?? '')
  const buyerName = String(data.BuyerName ?? '')

  const r = await callAmego(ENDPOINT.issue, data, keys)
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
    buyerIdentifier,
    buyerName,
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
 * 組作廢 data(單筆)。欄位已沙盒實測:作廢用 **CancelInvoiceNumber**(非 InvoiceNumber)、
 * InvoiceDate 為 YYYYMMDD、CancelReason 必填。呼叫端會把它包成陣列送出(f0501 收陣列)。
 */
export function buildVoidInvoiceData(input: VoidInvoiceInput): Record<string, unknown> {
  return {
    CancelInvoiceNumber: input.invoiceNumber,
    InvoiceDate: input.invoiceDate,
    CancelReason: input.reason,
  }
}

/** 作廢一張已開立的發票。與開立一樣,失敗只回 ok:false 由呼叫端記錄。 */
export async function voidInvoice(
  input: VoidInvoiceInput,
  keys: GuangmaoInvoiceKeys,
): Promise<VoidInvoiceResult> {
  // f0501 的 data 是陣列(支援多張),單筆也要包成 [ {…} ]
  const r = await callAmego(ENDPOINT.void, [buildVoidInvoiceData(input)], keys)
  if (r.httpError) return { ok: false, status: r.httpError, message: `光貲回應 ${r.httpError}` }
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
  /** 原發票開立日期 YYYYMMDD(折讓品項要逐項帶原發票日期)。 */
  invoiceDate: string
  /** 折讓品項名稱。 */
  itemName: string
  /** 折讓總額(含稅)。由此反推未稅/稅額。 */
  totalAmt: number
  /** 折讓證明單號 —— **必填、≤16 字、需自帶且唯一**(光貲不代配號,實測 4040121)。 */
  allowanceNumber: string
  /** 折讓日期 YYYYMMDD。 */
  allowanceDate: string
  /**
   * 買方抬頭 —— **必填、不可空**(實測 4040127),且**須與原發票的買方一致**。
   * B2C 原發票用的是帳號名稱(見 issueInvoice 的 fallbackBuyerName),折讓要帶同一個。
   */
  buyerName: string
  /** 原買方統編;**須與原發票一致**(實測 4040157),B2C 為 '0000000000'(預設)。 */
  buyerIdentifier?: string
}

export interface AllowanceResult {
  ok: boolean
  status: string
  message: string
  /** 折讓證明單號(= 我方送出的 allowanceNumber;光貲成功回應不另回號)。 */
  allowanceNumber?: string
}

/**
 * 組折讓 data(單筆)。已沙盒實測(g0401):
 *   · **AllowanceType='2'**(賣方開立;1 買方開立自 114/1/1 起禁用,實測 4040145)。
 *   · **AllowanceNumber 必填 ≤16 字**、**BuyerIdentifier 必填**(B2C='0000000000',實測 4040126)。
 *   · 品項金額用**未稅 Amount + 另帶 Tax**、表頭 TotalAmount 含稅(這組實測 code 0)。
 *   · 每項帶 OriginalInvoiceNumber/OriginalInvoiceDate/OriginalDescription。金額一律字串。
 * 呼叫端會把它包成陣列送出(g0401 收陣列)。
 */
export function buildAllowanceData(input: AllowanceInput): Record<string, unknown> {
  const { totalAmt, amt, taxAmt } = splitTax(input.totalAmt)
  const data: Record<string, unknown> = {
    AllowanceType: '2', // 賣方開立
    AllowanceNumber: input.allowanceNumber,
    BuyerIdentifier: input.buyerIdentifier || '0000000000',
    BuyerName: input.buyerName, // 不可空、須與原發票一致(實測 4040127/4040157)
    InvoiceNumber: input.invoiceNumber,
    AllowanceDate: input.allowanceDate,
    TaxType: '1',
    TaxAmount: String(taxAmt),
    TotalAmount: String(totalAmt),
    ProductItem: [
      {
        Description: input.itemName,
        Quantity: '1',
        UnitPrice: String(amt), // 折讓品項以未稅計(實測折讓 Amount 用未稅)
        Amount: String(amt),
        Tax: String(taxAmt),
        TaxType: '1',
        OriginalInvoiceNumber: input.invoiceNumber,
        OriginalInvoiceDate: input.invoiceDate,
        OriginalDescription: input.itemName,
      },
    ],
  }
  return data
}

/** 對原發票開立折讓證明單。 */
export async function issueAllowance(
  input: AllowanceInput,
  keys: GuangmaoInvoiceKeys,
): Promise<AllowanceResult> {
  // g0401 的 data 是陣列(支援多張),單筆也要包成 [ {…} ]
  const r = await callAmego(ENDPOINT.allowance, [buildAllowanceData(input)], keys)
  if (r.httpError) return { ok: false, status: r.httpError, message: `光貲回應 ${r.httpError}` }
  const message = String((r.raw as { msg?: string })?.msg || '')
  return {
    ok: r.code === 0,
    status: String(r.raw?.code ?? 'UNKNOWN'),
    message,
    // 成功時光貲不另回折讓單號,回傳我方送出的那組(即 input.allowanceNumber)
    allowanceNumber: r.code === 0 ? input.allowanceNumber : undefined,
  }
}

// ── 發票證明聯 PDF(invoice_file) ─────────────────────────────────────
//
// 官方描述:「下載發票檔案(PDF格式)。載具發票中獎後才可下載,非載具發票可無限次下載。」
// 限制:以發票日期起 **180 天內**(逾期回 code 51、查無回 71);⚠️ 回應的 file_url
// **只有 10 分鐘有效**——不能存起來重用,一律按需取、當場給使用者開。

export interface InvoiceFileInput {
  /** 發票號碼(10 碼)。 */
  invoiceNumber: string
  /**
   * 版式:0=A4 整張(預設;無統編只有這款,背面是兌獎聯需雙面列印)、
   * 1=A4(地址+A5)、2=A4(A5x2)、3=A5、5=QRcode_A4(1/2/3/5 限有統編)。
   */
  downloadStyle?: number
}

export interface InvoiceFileResult {
  ok: boolean
  status: string
  message: string
  /** PDF 下載連結(10 分鐘有效)。 */
  fileUrl?: string
}

// ── 手機條碼查詢(barcode) ──────────────────────────────────────────────
//
// 為什麼需要:格式檢查驗不出「這組條碼到底存不存在」。2026-08-16 實測,帶一個格式
// 完全合法但不存在的條碼去開立,光貿回 `3040132 載具號碼不存在`——**發票開不出來,
// 而錢已經收了**,而且每日自動補開會拿同一組錯條碼一直重試,永遠不會成功。
// 所以在「客戶存發票資訊」的當下就先問光貿一次,把錯的擋在前面。

/** 手機條碼查詢結果。`exists: null` = 問不到（沒設金鑰／連不上／被 IP 擋），不是「不存在」。 */
export interface BarcodeCheckResult {
  /** true=存在、false=確定不存在、null=無法查證 */
  exists: boolean | null
  code: number
  message: string
}

/**
 * 問光貿「這組手機條碼存不存在」。
 *
 * ⚠️ **查不到不等於不存在**：連線失敗、金鑰未設、被 IP 擋都會回 `exists: null`，
 *    呼叫端必須放行——否則光貿一出問題，客戶連發票資訊都存不了。
 *    （這就是「查不到就等於沒問題」那個假綠燈的反面：不能把「不知道」當成「錯」，
 *      也不能當成「對」，要留三態讓呼叫端自己決定。）
 */
export async function checkMobileBarcode(
  barcode: string,
  keys: GuangmaoInvoiceKeys,
): Promise<BarcodeCheckResult> {
  const r = await callAmego(ENDPOINT.barcode, { barCode: barcode }, keys)
  if (r.httpError || Number.isNaN(r.code)) {
    return { exists: null, code: Number.NaN, message: r.httpError ?? '光貿無回應' }
  }
  const message = String((r.raw as { msg?: string })?.msg || '')
  // 9000113 = 手機條碼不存在、9000112 = 格式錯誤 → 兩者都是「這組不能用」
  if (r.code === 0) return { exists: true, code: 0, message }
  if (r.code === 9000112 || r.code === 9000113) return { exists: false, code: r.code, message }
  // 其他代碼（IP 錯誤 14、簽章 16、平台維護 10…）＝我方問不到,不是客戶填錯
  return { exists: null, code: r.code, message }
}

/** 組 invoice_file 的 data。type 也可用 'order'+order_id 查,我們固定用發票號碼。 */
export function buildInvoiceFileData(input: InvoiceFileInput): Record<string, unknown> {
  return {
    type: 'invoice',
    invoice_number: input.invoiceNumber,
    download_style: String(input.downloadStyle ?? 0),
  }
}

/** 取一張發票的證明聯 PDF 下載連結。失敗回 ok:false(逾 180 天、載具未中獎都會走這)。 */
export async function getInvoiceFileUrl(
  input: InvoiceFileInput,
  keys: GuangmaoInvoiceKeys,
): Promise<InvoiceFileResult> {
  const r = await callAmego(ENDPOINT.invoiceFile, buildInvoiceFileData(input), keys)
  if (r.httpError) return { ok: false, status: r.httpError, message: `光貿回應 ${r.httpError}` }
  const raw = r.raw as { msg?: string; data?: { file_url?: string } }
  const message = String(raw?.msg || '')
  const fileUrl = String(raw?.data?.file_url || '') || undefined
  // code 0 但沒回連結也算失敗——回一個空連結給前端開等於開一個壞分頁
  return { ok: r.code === 0 && Boolean(fileUrl), status: String(r.raw?.code ?? 'UNKNOWN'), message, fileUrl }
}
