/**
 * PAYUNi 統一金流 加解密／簽章工具（整合式支付頁 UPP＝幕前支付）。
 *
 * 與 newebpay.ts 平行：只放「純函式」加解密／簽章邏輯——金鑰由呼叫端（建單 API /
 * Notify webhook）從 server-only runtimeConfig 取出後傳入,方便單元測試、也避免金鑰散落。
 * 每個租戶各一組特店金鑰。
 *
 * ── 協定（照 PAYUNi 官方 PHP SDK src/PayuniApi.php 逐位元對齊）──────────────
 *   加密演算法：AES-256-**GCM**（藍新是 CBC,兩者不相容）
 *   明文       ：encryptInfo 參數以 application/x-www-form-urlencoded 串成 query
 *   EncryptInfo：hex( base64(密文) + ":::" + base64(GCM authTag) )
 *                ↑ PHP openssl_encrypt(options=0) 會先 base64 密文,tag 另外 base64,
 *                  中間用字面 ":::" 串接,最後整段 bin2hex。
 *   HashInfo   ：SHA256( merKey + EncryptInfo + merIV ) 全大寫 hex
 *   外層 POST  ：{ MerID, Version, EncryptInfo, HashInfo }（回傳同樣這幾個欄位）
 *
 * ⚠️ 端點／版本號／回傳欄位以 PAYUNi 最新技術文件為準;上線前務必對「測試特店」
 *    (sandbox-api.payuni.com.tw) 跑通一筆真實付款,確認位元組層級相容
 *    (本檔測試只驗自身往返與簽章格式)。
 */
import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'crypto'

const ALGO = 'aes-256-gcm'

/** PAYUNi UPP 端點（測試特店掛 sandbox- 前綴）。 */
export const PAYUNI_ENDPOINTS = {
  test: 'https://sandbox-api.payuni.com.tw/api/upp',
  prod: 'https://api.payuni.com.tw/api/upp',
} as const

/** PAYUNi 交易查詢（trade/query）端點——主動對帳:漏接 Notify 時拿回真實付款狀態。 */
export const PAYUNI_QUERY_ENDPOINTS = {
  test: 'https://sandbox-api.payuni.com.tw/api/trade/query',
  prod: 'https://api.payuni.com.tw/api/trade/query',
} as const

/** PAYUNi 幕後 Token 扣款（credit）端點——每期定期扣款:用 CreditHash 直接對該卡授權。 */
export const PAYUNI_CREDIT_ENDPOINTS = {
  test: 'https://sandbox-api.payuni.com.tw/api/credit',
  prod: 'https://api.payuni.com.tw/api/credit',
} as const

/**
 * 把 PAYUNI_ENV 正規化成 'test' | 'prod'。
 * ⚠️ **不要**用 `=== 'prod'` 硬比：`production`/`PROD`/前後空白 都該算正式,否則正式環境一個
 *    小拼字就靜默把真客戶導到沙盒、刷不到錢。無法識別的值**保守用 test 並警告**（寧可測試站
 *    也不要拿設定錯的環境去真的扣客戶錢）。
 */
export function resolvePayuniEnv(raw: unknown): 'test' | 'prod' {
  const v = String(raw ?? '').trim().toLowerCase()
  if (['prod', 'production', 'live', 'core'].includes(v)) return 'prod'
  if (['test', 'sandbox', 'dev', 'staging', ''].includes(v)) return 'test'
  console.warn(`[payuni] 無法識別的 PAYUNI_ENV="${String(raw)}",保守用 test（沙盒）。正式請設 PAYUNI_ENV=prod`)
  return 'test'
}

/** PAYUNi 特店金鑰(每租戶各一組)。Hash Key 須 32 碼、IV Key 須 16 碼。 */
export interface PayuniKeys {
  /** 商店 Hash Key（AES-256 金鑰，32 bytes） */
  merKey: string
  /** 商店 IV Key（GCM nonce，16 bytes） */
  merIV: string
}

function assertKeys(keys: PayuniKeys): void {
  const keyLen = Buffer.byteLength(String(keys.merKey || ''))
  const ivLen = Buffer.byteLength(String(keys.merIV || ''))
  if (keyLen !== 32) throw new Error(`[payuni] Hash Key 長度須為 32 碼(實際 ${keyLen})`)
  if (ivLen !== 16) throw new Error(`[payuni] IV Key 長度須為 16 碼(實際 ${ivLen})`)
}

/** 參數物件 → PAYUNi 要的 URL-encoded query string（對齊 PHP http_build_query）。 */
export function encodeEncryptInfo(params: Record<string, string | number>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) sp.append(k, String(v))
  return sp.toString()
}

/**
 * AES-256-GCM 加密 → EncryptInfo。
 * 完全複刻 PHP：bin2hex( base64(ciphertext) . ':::' . base64(tag) )。
 */
export function encrypt(params: Record<string, string | number>, keys: PayuniKeys): string {
  assertKeys(keys)
  const cipher = createCipheriv(ALGO, Buffer.from(keys.merKey), Buffer.from(keys.merIV))
  const ct = Buffer.concat([cipher.update(encodeEncryptInfo(params), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const combined = `${ct.toString('base64')}:::${tag.toString('base64')}`
  return Buffer.from(combined, 'utf8').toString('hex')
}

/**
 * 解密 EncryptInfo → 參數物件。解不開（金鑰錯／tag 驗證失敗／格式壞）會 throw,
 * 呼叫端請包 try/catch 並於失敗時拒絕開通。
 */
export function decrypt(encryptStr: string, keys: PayuniKeys): Record<string, string> {
  assertKeys(keys)
  const combined = Buffer.from(String(encryptStr || '').trim(), 'hex').toString('utf8')
  const sep = combined.indexOf(':::')
  if (sep < 0) throw new Error('[payuni] EncryptInfo 格式錯誤(缺少 ::: 分隔)')
  const ct = Buffer.from(combined.slice(0, sep), 'base64')
  const tag = Buffer.from(combined.slice(sep + 3), 'base64')
  const decipher = createDecipheriv(ALGO, Buffer.from(keys.merKey), Buffer.from(keys.merIV))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  return Object.fromEntries(new URLSearchParams(plain))
}

/** 產生檢查碼 HashInfo：SHA256(merKey + EncryptInfo + merIV) 全大寫 hex。 */
export function makeHashInfo(encryptStr: string, keys: PayuniKeys): string {
  return createHash('sha256').update(`${keys.merKey}${encryptStr}${keys.merIV}`, 'utf8').digest('hex').toUpperCase()
}

/** 驗證 HashInfo 是否與 EncryptInfo 相符(timing-safe,避免時序側錄)。 */
export function verifyHashInfo(encryptStr: string, hashInfo: string, keys: PayuniKeys): boolean {
  const expected = makeHashInfo(encryptStr, keys)
  const got = String(hashInfo || '').trim().toUpperCase()
  if (got.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'))
  }
  catch {
    return false
  }
}

/** 整合式支付頁（UPP）自動送出表單所需的四個 POST 欄位。 */
export interface PayuniUppForm {
  MerID: string
  Version: string
  EncryptInfo: string
  HashInfo: string
}

/**
 * 組整合式支付頁（UPP）的表單欄位。
 * encryptInfo 至少要有 MerID／MerTradeNo／TradeAmt／Timestamp（PAYUNi 必填）;
 * 通常再帶 ReturnURL／NotifyURL／ProdDesc。回傳的四欄位直接塞進 auto-submit form。
 */
export function buildUppForm(
  encryptInfo: Record<string, string | number>,
  keys: PayuniKeys,
  version = '1.0',
): PayuniUppForm {
  const EncryptInfo = encrypt(encryptInfo, keys)
  return {
    MerID: String(encryptInfo.MerID ?? ''),
    Version: version,
    EncryptInfo,
    HashInfo: makeHashInfo(EncryptInfo, keys),
  }
}

/**
 * PAYUNi Notify／Return **解密後**的交易結果（僅列開通會用到的欄位；其餘保留）。
 * ⚠️ 判斷是否付款成功看的是這裡的 `TradeStatus`,不是外層回傳的 `Status`——
 *    外層 Status 只代表「API 回應正常」,錢有沒有進來要看 TradeStatus（見 isPayuniPaid）。
 */
export interface PayuniTradeResult {
  MerID?: string
  /** 我方送出的商店訂單編號（帳本冪等鍵） */
  MerTradeNo?: string
  /** PAYUNi 端交易序號（UNi 序號） */
  TradeNo?: string
  /** 交易金額 */
  TradeAmt?: string
  /** 交易狀態：'0'待付款 · '1'已付款 · '2'付款失敗 · '3'付款取消 */
  TradeStatus?: string
  /** 付款方式代碼：'1'=信用卡… */
  PaymentType?: string
  /** 錯誤／狀態訊息 */
  Message?: string
  /** 授權時間 */
  PayTime?: string
  [k: string]: string | undefined
}

/** PAYUNi 付款方式代碼 → 對齊帳單頁既有標籤（payTypeLabel 認得的 token）。未知碼原樣保留。 */
const PAYUNI_PAYMENT_TYPE: Record<string, string> = {
  1: 'CREDIT', // 信用卡
}
export function payuniPaymentType(code?: string | null): string | null {
  if (!code) return null
  return PAYUNI_PAYMENT_TYPE[String(code)] ?? String(code)
}

/**
 * 交易本身是否已付款——只看解密後的 `TradeStatus === '1'`（已付款）。
 * ⚠️ **查單對帳（trade/query）用這支**,不能用 isPayuniPaid:查單回傳的外層 Status 是查詢碼
 *    （如 QUERY03001「查無訂單」/查到時另有代碼）,**不是** Notify 的 'SUCCESS';用 isPayuniPaid
 *    會把「查到的已付款單」誤判成沒付。查無訂單時解密結果沒有 TradeStatus → 這裡回 false（安全）。
 */
export function isTradePaid(result: PayuniTradeResult | null): boolean {
  return String(result?.TradeStatus ?? '') === '1'
}

/**
 * 這筆 **Notify／Return** 是否代表「付款成功」。
 * 兩層都要成立（比藍新多一層）：外層 `Status` 是 SUCCESS/OK（API 正常）
 * 且解密後 `TradeStatus === '1'`（已付款）。任一不成立都不得開通。
 */
export function isPayuniPaid(outerStatus: string, result: PayuniTradeResult | null): boolean {
  const apiOk = ['SUCCESS', 'OK'].includes(String(outerStatus || '').trim().toUpperCase())
  return apiOk && isTradePaid(result)
}

/**
 * 把 **trade/query 解密後**的結果攤平成扁平交易欄位。
 * ⚠️ 查單回傳與 Notify **格式不同**:查單是 PHP http_build_query 出來的巢狀
 *    `Result[0][MerTradeNo]` / `Result[0][TradeStatus]` …（實測確認）,Notify 則是扁平的。
 *    這裡把第一筆 `Result[0][X]` 攤平成 `{ X: value }`,好用同一套下游邏輯。查無訂單時
 *    解密結果沒有 Result[0] 欄位 → 回空物件（下游判定不會誤開通）。
 */
export function parsePayuniQueryResult(decrypted: Record<string, string | undefined> | null): PayuniTradeResult {
  const out: PayuniTradeResult = {}
  if (!decrypted) return out
  for (const [k, v] of Object.entries(decrypted)) {
    const m = k.match(/^Result\[0\]\[(\w+)\]$/)
    if (m && m[1]) out[m[1]] = v
  }
  return out
}

/**
 * **查單（trade/query）語意**下這筆是否已付款。
 * ⚠️ 查單的 `TradeStatus` 代碼**與 Notify 不同**——實測「已付款」在查單是 `'2'`（Notify 是 '1'）。
 *    另要求有 `PaymentDay`（實際付款時間）當第二道保險,避免誤判。此代碼以實測交易為準,
 *    上線前建議對 PAYUNi 官方文件再確認一次。
 */
export function isQueryTradePaid(result: PayuniTradeResult): boolean {
  return String(result.TradeStatus ?? '') === '2' && !!String(result.PaymentDay ?? '').trim()
}

/**
 * 組交易查詢（trade/query）的 POST 欄位:以商店訂單編號 MerTradeNo 查一筆交易現況。
 * 與 buildUppForm 同一套簽章,只是內層 encryptInfo 帶查詢欄位。回傳格式與 Notify 相同
 * （{ Status, EncryptInfo, HashInfo }）→ 用 verifyAndDecryptPayuniNotify 解、isPayuniPaid 判定。
 */
export function buildTradeQuery(
  merchantId: string,
  merchantOrderNo: string,
  keys: PayuniKeys,
  timestamp: number,
  version = '1.0',
): PayuniUppForm {
  return buildUppForm({ MerID: merchantId, MerTradeNo: merchantOrderNo, Timestamp: timestamp }, keys, version)
}

/**
 * 驗簽 + 解密 PAYUNi 的 Notify／Return 回傳。
 * PAYUNi 回傳外層是 { MerID, Status, EncryptInfo, HashInfo }：
 *   1. 先用 HashInfo 驗 EncryptInfo（金鑰對不上就驗不過）
 *   2. 再解密 EncryptInfo 取出交易明細
 * 任一步失敗一律回 null（呼叫端據此拒絕、不得開通）。
 */
export function verifyAndDecryptPayuniNotify(
  encryptInfo: string,
  hashInfo: string,
  keys: PayuniKeys,
): PayuniTradeResult | null {
  if (!verifyHashInfo(encryptInfo, hashInfo, keys)) return null
  try {
    return decrypt(encryptInfo, keys) as PayuniTradeResult
  }
  catch {
    return null
  }
}

// ── 幕後 Token 續扣（/api/credit;定期扣款用）─────────────────────────────────
//
// PAYUNi 定期扣款 = 首刷經 UPP 建立「信用卡約定」拿到 CreditHash(UPP 帶 UseTokenType/CreditToken),
// 之後每期由「我方」拿 CreditHash 打此 API 幕後扣款,金額每期可自訂(折抵/降級即改 TradeAmt)。
// 版本固定 1.3;回應與 Notify 同形({ MerID, Status, EncryptInfo, HashInfo }),兩層成功判定沿用 isPayuniPaid。
// 見設計文件 docs/PAYUNI-RECURRING-DESIGN.md。

/** 幕後 Token 扣款版本號,官方文件固定 1.3。 */
export const PAYUNI_CREDIT_VERSION = '1.3'

export interface CreditChargeInput {
  merchantId: string
  /** 商店訂單編號:≤25、[A-Za-z0-9_-]、10 分鐘內不可重複。 */
  merchantOrderNo: string
  /** 本期扣款金額(含稅整數)——每期可不同(折抵/降級即改此值)。 */
  tradeAmt: number
  /** 首刷建立約定時回傳的信用卡 Token(CreditHash)。 */
  creditHash: string
  /** 商品說明(≤550;帶產品名,對帳/發票一致)。 */
  prodDesc: string
  /** Unix 秒時間戳。由呼叫端提供以保持純函式可測。 */
  timestamp: number
}

/** 續扣的 EncryptInfo 欄位(純函式,好單元測試;實際送出見 buildCreditCharge / chargeCreditToken)。 */
export function buildCreditChargeFields(input: CreditChargeInput): Record<string, string | number> {
  return {
    MerID: input.merchantId,
    MerTradeNo: input.merchantOrderNo,
    TradeAmt: Math.round(input.tradeAmt),
    Timestamp: input.timestamp,
    ProdDesc: input.prodDesc,
    CreditHash: input.creditHash,
  }
}

/** 組 /api/credit 幕後扣款的外層 POST 欄位({ MerID, Version, EncryptInfo, HashInfo })。 */
export function buildCreditCharge(input: CreditChargeInput, keys: PayuniKeys): PayuniUppForm {
  const EncryptInfo = encrypt(buildCreditChargeFields(input), keys)
  return {
    MerID: input.merchantId,
    Version: PAYUNI_CREDIT_VERSION,
    EncryptInfo,
    HashInfo: makeHashInfo(EncryptInfo, keys),
  }
}

export interface CreditChargeResult {
  /** 兩層都成立(外層 SUCCESS + 解密 TradeStatus==='1')才算扣款成功。 */
  ok: boolean
  /** 外層 Status(SUCCESS / UNKNOWN / 錯誤碼如 CREDIT02025…)。 */
  outerStatus: string
  /** 解密後交易明細(含 TradeStatus / Card4No / AuthCode / CreditHash…);驗簽失敗為 null。 */
  result: PayuniTradeResult | null
}

/**
 * 對已約定的卡(CreditHash)發動一筆幕後扣款(server→server)。
 * ⚠️ UNKNOWN(銀行 60 秒未回)既非成功也非失敗——呼叫端應保留待確認、稍後用 trade/query 補查
 *    (見設計 §2/§7),不可直接當失敗重扣。
 */
export async function chargeCreditToken(
  input: CreditChargeInput,
  keys: PayuniKeys,
  env: unknown,
): Promise<CreditChargeResult> {
  const fields = buildCreditCharge(input, keys)
  const url = PAYUNI_CREDIT_ENDPOINTS[resolvePayuniEnv(env)]
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'user-agent': 'payuni' },
    body: new URLSearchParams({ ...fields }).toString(),
  })
  if (!res.ok) return { ok: false, outerStatus: `HTTP_${res.status}`, result: null }
  let outer: Record<string, unknown>
  try {
    outer = await res.json() as Record<string, unknown>
  }
  catch {
    return { ok: false, outerStatus: 'BAD_JSON', result: null }
  }
  const outerStatus = String(outer.Status ?? '')
  const result = outer.EncryptInfo
    ? verifyAndDecryptPayuniNotify(String(outer.EncryptInfo), String(outer.HashInfo ?? ''), keys)
    : null
  return { ok: isPayuniPaid(outerStatus, result), outerStatus, result }
}
