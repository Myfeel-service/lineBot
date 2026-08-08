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

/**
 * UPP 版本號。
 * ⚠️ **建立信用卡約定要用 2.0**:官方 UPP 文件現行版本為 2.0,回應才會在信用卡區帶回
 *    `CreditHash` / `CreditLife` / `Card4No`。單次付款沿用已對沙盒實測通過的 `1.0`
 *    （不動它 = 不冒回歸風險）,等 2.0 也實測過再考慮統一。
 */
export const PAYUNI_UPP_VERSION = '1.0'
export const PAYUNI_UPP_TOKEN_VERSION = '2.0'

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
 * 信用卡 Token 取消（約定／記憶卡號）端點。
 * ⚠️ 路徑是「底線 + 斜線」(`credit_bind/cancel`),不是 `credit_bind_cancel`——
 *    後者不存在,會回一個 HTML 前端頁。已對官方文件與沙盒實測雙重確認。
 */
export const PAYUNI_BIND_CANCEL_ENDPOINTS = {
  test: 'https://sandbox-api.payuni.com.tw/api/credit_bind/cancel',
  prod: 'https://api.payuni.com.tw/api/credit_bind/cancel',
} as const

/** 信用卡 Token 查詢（約定）端點。必填 `CreditToken` 或 `CreditHash` 擇一。 */
export const PAYUNI_BIND_QUERY_ENDPOINTS = {
  test: 'https://sandbox-api.payuni.com.tw/api/credit_bind/query',
  prod: 'https://api.payuni.com.tw/api/credit_bind/query',
} as const

/**
 * 把「幕後」API 的網址改指向我方的固定 IP 中繼站（`PAYUNI_RELAY_BASE`）。
 *
 * ── 為什麼需要這個 ────────────────────────────────────────────────────────
 * PAYUNi 的幕後 API 會檢查來源 IP（後台「限定 API 之 IP 設定」,上限 10 組單一 IP,
 * **不支援網段**）。我方跑在 AWS Amplify,對外 IP 來自共用池且會變動——2026-08-04
 * 實測同一台機器一天內換了 4 個 IP,清單方式撐不住。業界（含 ShopStore 這類台灣開店平台,
 * 其教學要商家填的 `35.221.226.156` 就是 GCP IP）的解法一致:**把幕後呼叫收斂到一個固定出口**。
 *
 * ── 為什麼只改網址、不用系統層 proxy ─────────────────────────────────────
 * Node 的 `NODE_USE_ENV_PROXY` 是**全域**的,會把 Gemini／LINE／光貿發票的流量一起繞進
 * 那台小機器 → 它就變成整個系統的單點故障。這裡只換「幕後那幾支」的網址,
 * 其餘流量一行都不受影響;中繼站掛掉也只影響「本期自動扣款延到隔天」,客人照樣付得到錢
 * （UPP 付款頁是瀏覽器導轉,永遠直連 PAYUNi,絕不經過中繼站)。
 *
 * ── 為什麼中繼站不需要被信任 ─────────────────────────────────────────────
 * 請求在我方就已用特店金鑰加密（`EncryptInfo`）+ 簽章（`HashInfo`）,回應也要用同一組金鑰
 * 驗簽才會被採信（見 `verifyAndDecryptPayuniNotify`）。所以一台被入侵的中繼站
 * **無法偽造「扣款成功」**——它拿不到金鑰,簽不出通得過驗證的回應。
 *
 * 設定範例:`PAYUNI_RELAY_BASE=https://relay.example.com`（無尾斜線）
 * 中繼站只要把 `/api/*` 原樣轉發到對應環境的 PAYUNi 主機即可（Caddy 一行 reverse_proxy）。
 * ⚠️ 中繼站要與 `PAYUNI_ENV` 指向同一個環境（正式對正式、測試對測試）;
 *    留白 = 直連 PAYUNi（現行行為,一行不變）。
 */
export function resolveBackendUrl(payuniUrl: string, relayBase: unknown): string {
  const base = String(relayBase ?? '').trim().replace(/\/$/, '')
  if (!base) return payuniUrl
  return base + new URL(payuniUrl).pathname
}

/**
 * 把 PAYUNI_ENV 正規化成 'test' | 'prod'。
 * ⚠️ **不要**用 `=== 'prod'` 硬比：`production`/`PROD`/前後空白 都該算正式,否則正式環境一個
 *    小拼字就靜默把真客戶導到沙盒、刷不到錢。無法識別的值**保守用 test 並警告**（寧可測試站
 *    也不要拿設定錯的環境去真的扣客戶錢）。
 */
/**
 * `PAYUNI_ENV` 是不是**明確設定**過的值（而不是留白／打錯字被保守退回 test）。
 *
 * 為什麼需要分辨：resolvePayuniEnv 把「沒設定」和「設成 test」都變成 test，兩者在多數情況
 * 等價，但有一種情況差很多——設了中繼站時，扣款到底進哪個環境由**中繼站**決定，而查單是照
 * PAYUNI_ENV 選端點。環境不一致時，已經授權成功的續扣單會被查成「查無此單」；
 * 若還照這個結論把訂單作廢，下一輪就會對同一期再刷一次卡。
 * 所以「會動到訂單狀態」的判斷要求 PAYUNI_ENV 是有人真的寫下來的值。
 */
export function isPayuniEnvExplicit(raw: unknown): boolean {
  const v = String(raw ?? '').trim().toLowerCase()
  return ['prod', 'production', 'live', 'core', 'test', 'sandbox', 'dev', 'staging'].includes(v)
}

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

/**
 * 驗證金鑰長度。對外開放是為了讓「批次扣款」這類流程能**先驗一次再進迴圈**——
 * 否則設定錯誤會在每一筆扣款呼叫裡才 throw,被誤歸類成「結果未定」。
 */
export function assertPayuniKeys(keys: PayuniKeys): void {
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
  assertPayuniKeys(keys)
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
  assertPayuniKeys(keys)
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
  version: string = PAYUNI_UPP_VERSION,
): PayuniUppForm {
  const EncryptInfo = encrypt(encryptInfo, keys)
  return {
    MerID: String(encryptInfo.MerID ?? ''),
    Version: version,
    EncryptInfo,
    HashInfo: makeHashInfo(EncryptInfo, keys),
  }
}

// ── UPP 首刷:建立信用卡約定（拿 CreditHash）──────────────────────────────────
//
// PAYUNi 的「自動扣款」= 首刷經 UPP 過一次 3D 驗證、持卡人同意約定 → 回傳一組信用卡 Token
// (CreditHash),之後每期由**我方**拿它打 /api/credit 幕後扣款(見本檔末段)。
// 單次付款不帶這組參數 → 行為完全不變。

/** `CreditToken` 允許的字元(官方:≤200、[A-Za-z0-9@.#$%_\-+])。 */
const CREDIT_TOKEN_REF_RE = /[^A-Za-z0-9@.#$%_\-+]/g

/**
 * 把我方的參照字串(workspaceId)清成 PAYUNi `CreditToken` 允許的形狀。
 * ⚠️ 清完是空的就 **throw**,不可靜默改走「不建約定」——那會讓客戶付了首月、
 *    以為自己訂閱了,實際上沒有任何委託(訂閱靜默失敗,最難查的那種)。
 */
export function sanitizeCreditTokenRef(raw: string): string {
  const v = String(raw ?? '').replace(CREDIT_TOKEN_REF_RE, '').slice(0, 200)
  if (!v) throw new Error('[payuni] CreditToken 參照字串清理後為空,無法建立信用卡約定')
  return v
}

/**
 * 首刷「建立約定」要疊進 UPP EncryptInfo 的欄位。
 *
 * - `Credit=1`：啟用信用卡一次付清。
 * - `UseTokenType=3`：**強制約定**(消費者無法在 PAYUNi 付款頁自行取消約定)。刻意不用 `1`——
 *   客戶若在金流頁把約定取消掉,我方會收到「付款成功」卻拿不到可續扣的 Token,變成
 *   收了首月卻沒有委託。取消訂閱走我方後台的「取消訂閱」入口（可控、有稽核）。
 * - `CreditToken`：我方自訂參照字串(用 workspaceId);用 UseTokenType 時為必填。
 * - `CreditTokenType=2`：商店級 Token（本專案每租戶一組特店）。
 *   `CreditTokenExpired` 省略 → 預設跟卡片到期日。
 */
export function buildTokenBindFields(reference: string): Record<string, string | number> {
  return {
    Credit: 1,
    UseTokenType: 3,
    CreditToken: sanitizeCreditTokenRef(reference),
    CreditTokenType: 2,
  }
}

/** 首刷成功後從交易結果取出的「約定卡」資訊（存進訂閱,供每期續扣）。 */
export interface PayuniCardMandate {
  /** 信用卡 Token(CreditHash)——續扣憑證,**不得外洩到前端**。 */
  token: string
  /** 末四碼(Card4No);UI 顯示用。 */
  last4: string | null
  /** 有效期(CreditLife,MMYY)。 */
  expiry: string | null
}

/**
 * 從 Notify／查單結果取出約定卡資訊；沒有 `CreditHash` 回 null（= 這筆沒建成約定）。
 * 呼叫端必須把「沒拿到 Token」當成「沒有自動續訂」處理,不能假設有。
 */
export function parseCardMandate(result: PayuniTradeResult | null | undefined): PayuniCardMandate | null {
  const token = String(result?.CreditHash ?? '').trim()
  if (!token) return null
  const last4 = String(result?.Card4No ?? '').trim()
  const expiry = String(result?.CreditLife ?? '').trim()
  return { token, last4: last4 || null, expiry: expiry || null }
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
  /**
   * 信用卡約定 Token（首刷帶 UseTokenType 建約定成功才有）——每期幕後續扣的憑證。
   * 見 parseCardMandate / buildCreditCharge。
   */
  CreditHash?: string
  /** 約定卡有效期（MMYY） */
  CreditLife?: string
  /** 卡號末四碼 */
  Card4No?: string
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
 *
 * 官方文件（交易查詢 Ver 2.0）:TradeStatus `0`=取號成功 `9`=未付款 **`1`=已付款**
 * `2`=付款失敗 `3`=付款取消 `4`=交易逾期 `8`=訂單待確認 —— 與 Notify 同語意。
 *
 * ⚠️ **2026-08-04 修正過一個會「沒收到錢卻開通+開發票」的 bug**:本函式曾寫成
 *    `TradeStatus==='2' && 有 PaymentDay` —— 來自 7/24 一筆被誤讀的交易。真沙盒實測:
 *    已付款單回 `1`（CloseStatus=2 請款成功）,**失敗/取消的單也有 `PaymentDay`**（3D 取消
 *    的單回 `3` 且 PaymentDay 有值）→ 舊判斷會把真正的「付款失敗(2)」當成已付款結算。
 *    教訓:**單一樣本的實測不能推翻官方文件;兩者矛盾時要兩邊都再驗。**
 */
export function isQueryTradePaid(result: PayuniTradeResult): boolean {
  return String(result.TradeStatus ?? '') === '1'
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
 * 這筆 `/api/credit` 的結果是否「**未定**」——既不能當成功、也**絕不能當失敗去重扣**。
 *
 * 四種都算未定,理由都一樣:**PAYUNi／銀行那邊可能已經授權成功了**,我方只是沒拿到答案。
 *   · `UNKNOWN`      銀行 60 秒沒回,官方明說之後才有結果
 *   · `TradeStatus=8` 待確認（官方文件 CREDIT 的狀態碼之一）
 *   · `HTTP_5xx/4xx` 閘道逾時或錯誤,授權可能已在對方成立
 *   · `BAD_JSON` / `FETCH_FAILED` 連回應都沒讀到
 *
 * ⚠️ 把這些當失敗的代價很具體:`settlePaidOrder` 會把訂單寫成 `failed`,而那是**終態**
 *    （下一個分支就是「paid/failed 一律跳過」）→ 銀行事後核准也再也結算不了,
 *    錢收了、期間沒開通、還寄了一封扣款失敗信給客戶。
 */
export function isCreditChargeIndeterminate(r: Pick<CreditChargeResult, 'outerStatus' | 'result'>): boolean {
  const s = String(r.outerStatus || '').trim().toUpperCase()
  if (s === 'UNKNOWN' || s === 'BAD_JSON' || s === 'FETCH_FAILED') return true
  if (s.startsWith('HTTP_')) return true
  if (String(r.result?.TradeStatus ?? '') === '8') return true
  return false
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
  /** 選填:固定 IP 中繼站基底網址（`PAYUNI_RELAY_BASE`）。留白 = 直連 PAYUNi。 */
  relayBase?: unknown,
): Promise<CreditChargeResult> {
  const fields = buildCreditCharge(input, keys)
  const url = resolveBackendUrl(PAYUNI_CREDIT_ENDPOINTS[resolvePayuniEnv(env)], relayBase)
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

// ── 解除信用卡約定（credit_bind/cancel）──────────────────────────────────────
//
// 用途:客戶取消訂閱、或寬限期滿被降回免費層之後,把那張卡在 PAYUNi 的約定解掉,
// 不留一個沒人會用的授權在金流端（對客戶也是好事:他的卡不再被我們綁著）。
//
// ⚠️ 這是**清潔工作,不是安全需求**。PAYUNi 是「我方主動發動扣款」的模型,
//    `autoRenew=false` 之後沒有任何排程會扣他——不像藍新那種「不終止委託就會一直扣」。
//    所以解約失敗只要留著 Token、下次對帳再試即可,不必當成錯誤中斷流程。
//
// 規格來源:官方文件「信用卡Token取消(約定/記憶卡號)(CREDIT)」Ver 1.0 + 沙盒探針雙重確認。

/** Token 取消／查詢的版本號,官方固定 1.0（帶 1.3 會回 `API00003` 版本錯誤）。 */
export const PAYUNI_BIND_VERSION = '1.0'

/**
 * 綁定類型（`UseTokenType`）。
 * ⚠️ 與 UPP 建約定時的 `UseTokenType` **值域不同**:UPP 是 1=約定可取消／2=記憶卡號／3=強制約定,
 *    這裡只有 1=綁定(約定)／2=記憶卡號（給 3 會回 `CANCEL02006 綁定類型，格式錯誤`）。
 */
export const BIND_TYPE_MANDATE = 1
export const BIND_TYPE_REMEMBER_CARD = 2

export interface BindCancelInput {
  merchantId: string
  /**
   * 「綁定唯一值」——官方欄位名 `BindVal`。**要帶哪一個由 useTokenType 決定**:
   *   · 約定(1)     → 帶 **`CreditHash`**
   *   · 記憶卡號(2) → 帶 **`CreditToken`**
   * 我方訂閱一律是約定,所以這裡放 `subscription.payuniCardToken`（= CreditHash）。
   */
  bindVal: string
  /** 預設 1（約定）。 */
  useTokenType?: typeof BIND_TYPE_MANDATE | typeof BIND_TYPE_REMEMBER_CARD
  /**
   * Token 紀錄類型:1=會員(預設)、2=商店。
   * 我方首刷送的是 `CreditTokenType=2`（商店級,每租戶一組特店）→ 取消也要帶 2,才對得上。
   */
  creditTokenType?: 1 | 2
  /** Unix 秒。由呼叫端提供以保持純函式可測。 */
  timestamp: number
}

/** 解約的 EncryptInfo 欄位（純函式,好單元測試）。 */
export function buildBindCancelFields(input: BindCancelInput): Record<string, string | number> {
  return {
    MerID: input.merchantId,
    UseTokenType: input.useTokenType ?? BIND_TYPE_MANDATE,
    BindVal: input.bindVal,
    CreditTokenType: input.creditTokenType ?? 2,
    Timestamp: input.timestamp,
  }
}

/** 組 credit_bind/cancel 的外層 POST 欄位。 */
export function buildBindCancel(input: BindCancelInput, keys: PayuniKeys): PayuniUppForm {
  const EncryptInfo = encrypt(buildBindCancelFields(input), keys)
  return {
    MerID: input.merchantId,
    Version: PAYUNI_BIND_VERSION,
    EncryptInfo,
    HashInfo: makeHashInfo(EncryptInfo, keys),
  }
}

export interface BindCancelResult {
  /** 兩層都成立（外層 Status=SUCCESS + 解密後 Status=SUCCESS）才算解約成功。 */
  ok: boolean
  /** 外層狀態碼（SUCCESS / CANCEL02005 未有綁定類型 / CANCEL02007 未有綁定唯一值 …）。 */
  outerStatus: string
  /** 解密後的訊息（成功為「取消成功」）。 */
  message: string
  /**
   * PAYUNi 說「查無這筆約定」→ 對我方而言**與成功等價**（本來就沒有東西要解）,
   * 呼叫端可以放心把 Token 清掉,不必無限重試。
   * **只認實測確認的 `CANCEL03001`**（`取消失敗，查無符合約定資料`）——不做寬鬆的訊息比對,
   * 因為「查無此特店」這類設定錯誤也含「查無」,誤判會讓呼叫端刪掉唯一能解約的憑證。
   */
  notFound: boolean
}

/**
 * 解除一張卡在 PAYUNi 的約定。
 * 失敗**不 throw**——這支永遠是在對帳／取消流程的尾巴被呼叫,不能因為清潔工作失敗而中斷主流程。
 */
export async function cancelCardBinding(
  input: BindCancelInput,
  keys: PayuniKeys,
  env: unknown,
  /** 選填:固定 IP 中繼站基底網址（`PAYUNI_RELAY_BASE`）。留白 = 直連 PAYUNi。 */
  relayBase?: unknown,
): Promise<BindCancelResult> {
  const url = resolveBackendUrl(PAYUNI_BIND_CANCEL_ENDPOINTS[resolvePayuniEnv(env)], relayBase)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'user-agent': 'payuni' },
      body: new URLSearchParams({ ...buildBindCancel(input, keys) }).toString(),
    })
    if (!res.ok) return { ok: false, outerStatus: `HTTP_${res.status}`, message: '', notFound: false }
    const outer = await res.json() as Record<string, unknown>
    const outerStatus = String(outer.Status ?? '')
    const inner = outer.EncryptInfo
      ? verifyAndDecryptPayuniNotify(String(outer.EncryptInfo), String(outer.HashInfo ?? ''), keys)
      : null
    const message = String(inner?.Message ?? outer.Message ?? '')
    const innerOk = String(inner?.Status ?? '').toUpperCase() === 'SUCCESS'
    return {
      ok: outerStatus.toUpperCase() === 'SUCCESS' && innerOk,
      outerStatus,
      message,
      // ⚠️ 只認**實測確認**的 CANCEL03001（取消失敗，查無符合約定資料）。
      // 刻意**不**用「訊息含『查無』就算」那種寬鬆比對:PAYUNi 還有「查無此特店」這類
      // 設定錯誤也含「查無」,一旦誤判成 notFound,呼叫端就會把 Token 刪掉——而那是
      // 唯一能解除該卡約定的憑證,約定卻還活著。寧可多重試幾次,不要毀掉憑證。
      notFound: outerStatus.toUpperCase() === 'CANCEL03001',
    }
  }
  catch (e) {
    return { ok: false, outerStatus: 'FETCH_FAILED', message: (e as Error)?.message ?? '', notFound: false }
  }
}

// ── 查詢信用卡約定（credit_bind/query）─────────────────────────────────────────
//
// 用途一（**真正的理由**）:**把漏接 Notify 的首刷約定救回來**。
//   首刷的 `CreditHash` 只在 **UPP 的 Notify／Return 回傳裡**出現一次。若 Notify 沒送達,
//   補救路徑 `reconcilePayuniPending` 是靠 `trade/query` 把訂單補成已付款——而
//   **`trade/query` 的回傳結構裡沒有 `CreditHash`**（2026-08-06 實測,20 個欄位全列過:
//   MerTradeNo/TradeNo/TradeAmt/TradeFee/TradeStatus/PaymentType/PaymentDay/CreateDay/
//   Gateway/DataSource/Card6No/Card4No/CardExp/CardInst/AuthCode/AuthType/CardBank/
//   CloseStatus/CloseAmt/RemainAmt）→ 客戶付了首期、卻沒有任何續扣憑證 → 期末靜默降級。
//   這支就是那條救援路徑:拿我方自己送出的參照字串（`CreditToken` = workspaceId）反查憑證。
// 用途二:帳單頁顯示「這張卡在 PAYUNi 還有效嗎」（CreditTokenStatus）。
//
// ⚠️ **`CreditTokenType` 必填且必須與建約定時一致（=2 商店級）**——2026-08-06 逐個變體實測:
//      · `{ CreditToken }` 只帶 token            → `QUERY03001 查無符合綁定資料`
//      · `{ CreditToken, CreditTokenType: 1 }`   → `QUERY03001`（會員級,不是我方用的那層）
//      · `{ CreditToken, CreditTokenType: 2 }`   → **SUCCESS**,回 CreditHash / Card4No
//    官方文件只寫「CreditToken 或 CreditHash 擇一必填」,沒提 type 也是必要條件 → 別照文件猜。

export interface BindQueryInput {
  merchantId: string
  /** 我方參照字串（首刷時送的 `CreditToken`,本專案用 workspaceId）。與 creditHash 擇一。 */
  creditToken?: string
  /** 已知的約定 Token。與 creditToken 擇一。 */
  creditHash?: string
  /** Token 紀錄類型:1=會員、2=商店。**預設 2**（本專案每租戶一組特店,首刷送的就是 2）。 */
  creditTokenType?: 1 | 2
  /** Unix 秒。由呼叫端提供以保持純函式可測。 */
  timestamp: number
}

/** credit_bind/query 的 EncryptInfo 欄位（純函式,好單元測試）。 */
export function buildBindQueryFields(input: BindQueryInput): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    MerID: input.merchantId,
    CreditTokenType: input.creditTokenType ?? 2,
    Timestamp: input.timestamp,
  }
  // 兩者擇一;同時給就以 creditHash 為準（比參照字串精確,參照字串可能對到多張卡）。
  if (input.creditHash) fields.CreditHash = input.creditHash
  else if (input.creditToken) fields.CreditToken = input.creditToken
  return fields
}

export interface BindQueryResult {
  ok: boolean
  /** 外層狀態碼（SUCCESS / QUERY03001 查無符合綁定資料 / …）。 */
  outerStatus: string
  /** PAYUNi 說「查無這筆綁定」——與「查詢失敗」要分開:查無是確定沒有,不必重試。 */
  notFound: boolean
  /** 查到的約定卡（沒查到為 null）。欄位語意與首刷回傳的 PayuniCardMandate 一致。 */
  mandate: { token: string; last4: string | null; expiry: string | null; status: string | null } | null
}

/**
 * 查詢一組信用卡約定。失敗**不 throw**（與 cancelCardBinding 同原則:這支永遠在對帳／補救
 * 流程裡被呼叫,不能因為查詢失敗而中斷主流程）。
 */
export async function queryCardBinding(
  input: BindQueryInput,
  keys: PayuniKeys,
  env: unknown,
  /** 選填:固定 IP 中繼站基底網址（`PAYUNI_RELAY_BASE`）。留白 = 直連 PAYUNi。 */
  relayBase?: unknown,
): Promise<BindQueryResult> {
  const url = resolveBackendUrl(PAYUNI_BIND_QUERY_ENDPOINTS[resolvePayuniEnv(env)], relayBase)
  const EncryptInfo = encrypt(buildBindQueryFields(input), keys)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'user-agent': 'payuni' },
      body: new URLSearchParams({
        MerID: input.merchantId,
        Version: PAYUNI_BIND_VERSION,
        EncryptInfo,
        HashInfo: makeHashInfo(EncryptInfo, keys),
      }).toString(),
    })
    if (!res.ok) return { ok: false, outerStatus: `HTTP_${res.status}`, notFound: false, mandate: null }
    const outer = await res.json() as Record<string, unknown>
    const outerStatus = String(outer.Status ?? '')
    const inner = outer.EncryptInfo
      ? verifyAndDecryptPayuniNotify(String(outer.EncryptInfo), String(outer.HashInfo ?? ''), keys)
      : null
    // 查單類回傳是 PHP http_build_query 的巢狀 `Result[0][X]`（同 trade/query）。
    const flat = parsePayuniQueryResult(inner as Record<string, string | undefined> | null)
    const token = String(flat.CreditHash ?? '').trim()
    return {
      ok: outerStatus.toUpperCase() === 'SUCCESS' && Boolean(token),
      outerStatus,
      // ⚠️ 只認實測確認的 `QUERY03001`,不做「訊息含『查無』」的寬鬆比對（同 cancelCardBinding 的理由）。
      notFound: outerStatus.toUpperCase() === 'QUERY03001',
      mandate: token
        ? {
            token,
            last4: flat.Card4No ? String(flat.Card4No) : null,
            // 查詢回的是 `CreditTokenExpired`（MMYY）,語意同首刷回傳的 `CreditLife`。
            expiry: flat.CreditTokenExpired ? String(flat.CreditTokenExpired) : null,
            status: flat.CreditTokenStatus != null ? String(flat.CreditTokenStatus) : null,
          }
        : null,
    }
  }
  catch (e) {
    return { ok: false, outerStatus: 'FETCH_FAILED', notFound: false, mandate: null }
  }
}
