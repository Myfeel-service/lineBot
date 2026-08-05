import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  BIND_TYPE_MANDATE,
  BIND_TYPE_REMEMBER_CARD,
  buildBindCancel,
  buildBindCancelFields,
  buildCreditCharge,
  buildCreditChargeFields,
  buildTokenBindFields,
  buildTradeQuery,
  buildUppForm,
  decrypt,
  encodeEncryptInfo,
  encrypt,
  isPayuniPaid,
  isQueryTradePaid,
  isTradePaid,
  makeHashInfo,
  parseCardMandate,
  parsePayuniQueryResult,
  payuniPaymentType,
  resolvePayuniEnv,
  sanitizeCreditTokenRef,
  verifyAndDecryptPayuniNotify,
  verifyHashInfo,
  resolveBackendUrl,
  PAYUNI_ENDPOINTS,
  PAYUNI_CREDIT_ENDPOINTS,
  PAYUNI_BIND_CANCEL_ENDPOINTS,
} from './payuni'

// 測試用假金鑰(長度須合規:Hash Key 32 碼、IV Key 16 碼)。非真實特店金鑰。
const KEYS = {
  merKey: 'abcdefghijklmnopqrstuvwxyz123456', // 32
  merIV: '1234567890abcdef', // 16
}

describe('金鑰長度驗證', () => {
  it('Hash Key 非 32 碼會丟錯', () => {
    expect(() => encrypt({ x: 1 }, { merKey: 'too-short', merIV: KEYS.merIV })).toThrow()
  })
  it('IV Key 非 16 碼會丟錯', () => {
    expect(() => encrypt({ x: 1 }, { merKey: KEYS.merKey, merIV: 'short' })).toThrow()
  })
})

describe('AES-256-GCM 往返', () => {
  it('加密後可解回原參數,且 EncryptInfo 為小寫 hex', () => {
    const params = { MerID: 'ABC123', MerTradeNo: 'NP2026', TradeAmt: 499, ProdDesc: '輕量方案' }
    const enc = encrypt(params, KEYS)
    expect(enc).toMatch(/^[0-9a-f]+$/)
    expect(decrypt(enc, KEYS)).toEqual({
      MerID: 'ABC123',
      MerTradeNo: 'NP2026',
      TradeAmt: '499', // 解回都是字串(query string 本質)
      ProdDesc: '輕量方案',
    })
  })

  it('EncryptInfo 內層是 base64(密文):::base64(tag) 的 hex(對齊 PHP SDK 格式)', () => {
    const enc = encrypt({ Timestamp: 1700000000 }, KEYS)
    const combined = Buffer.from(enc, 'hex').toString('utf8')
    expect(combined).toContain(':::')
    const [ctB64, tagB64] = combined.split(':::') as [string, string]
    // 兩段都是合法 base64
    expect(Buffer.from(ctB64, 'base64').toString('base64')).toBe(ctB64)
    expect(Buffer.from(tagB64, 'base64')).toHaveLength(16) // GCM tag 16 bytes
  })

  it('中文與空值都能往返', () => {
    const params = { ProdDesc: '成長方案 ×1', Note: '', MerID: '測試店' }
    expect(decrypt(encrypt(params, KEYS), KEYS)).toEqual(params)
  })

  it('金鑰不符 → 解密丟錯(GCM tag 驗證失敗)', () => {
    const enc = encrypt({ MerID: 'ABC' }, KEYS)
    expect(() => decrypt(enc, { merKey: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', merIV: KEYS.merIV })).toThrow()
  })
})

describe('HashInfo 簽章', () => {
  it('等於 SHA256(merKey + EncryptInfo + merIV) 全大寫', () => {
    const enc = encrypt({ MerID: 'ABC' }, KEYS)
    const expected = createHash('sha256').update(KEYS.merKey + enc + KEYS.merIV).digest('hex').toUpperCase()
    expect(makeHashInfo(enc, KEYS)).toBe(expected)
    expect(makeHashInfo(enc, KEYS)).toMatch(/^[0-9A-F]{64}$/)
  })

  it('驗簽:相符回 true、竄改回 false', () => {
    const enc = encrypt({ MerID: 'ABC' }, KEYS)
    const hash = makeHashInfo(enc, KEYS)
    expect(verifyHashInfo(enc, hash, KEYS)).toBe(true)
    expect(verifyHashInfo(enc, hash.replace(/.$/, '0'), KEYS)).toBe(false)
    expect(verifyHashInfo(`${enc}00`, hash, KEYS)).toBe(false)
  })
})

describe('buildTradeQuery(交易查詢)', () => {
  it('簽章正確,內層帶 MerID/MerTradeNo/Timestamp,回傳與 UPP 同形狀', () => {
    const q = buildTradeQuery('S076820628', 'NP1', KEYS, 1700000000)
    expect(q.MerID).toBe('S076820628')
    expect(q.Version).toBe('1.0')
    expect(verifyHashInfo(q.EncryptInfo, q.HashInfo, KEYS)).toBe(true)
    expect(decrypt(q.EncryptInfo, KEYS)).toEqual({
      MerID: 'S076820628',
      MerTradeNo: 'NP1',
      Timestamp: '1700000000',
    })
  })
})

describe('buildUppForm', () => {
  it('產出四個 POST 欄位,HashInfo 對得上 EncryptInfo', () => {
    const form = buildUppForm(
      { MerID: 'ABC', MerTradeNo: 'NP1', TradeAmt: 499, Timestamp: 1700000000 },
      KEYS,
    )
    expect(form.MerID).toBe('ABC')
    expect(form.Version).toBe('1.0')
    expect(verifyHashInfo(form.EncryptInfo, form.HashInfo, KEYS)).toBe(true)
    // 內層可解回原參數
    expect(decrypt(form.EncryptInfo, KEYS)).toMatchObject({ MerID: 'ABC', TradeAmt: '499' })
  })
})

describe('buildCreditCharge / buildCreditChargeFields(幕後 Token 續扣 /api/credit)', () => {
  const base = {
    merchantId: 'S076820628',
    merchantOrderNo: 'NP260730001',
    tradeAmt: 499,
    creditHash: 'HASHTOKEN123',
    prodDesc: 'MiniMe 輕量方案 訂閱服務',
    timestamp: 1700000000,
  }

  it('EncryptInfo 欄位齊全、帶 CreditHash 與自訂 TradeAmt', () => {
    expect(buildCreditChargeFields(base)).toEqual({
      MerID: 'S076820628',
      MerTradeNo: 'NP260730001',
      TradeAmt: 499,
      Timestamp: 1700000000,
      ProdDesc: 'MiniMe 輕量方案 訂閱服務',
      CreditHash: 'HASHTOKEN123',
    })
  })

  it('TradeAmt 四捨五入為整數(折抵可能算出小數)', () => {
    expect(buildCreditChargeFields({ ...base, tradeAmt: 498.6 }).TradeAmt).toBe(499)
  })

  it('外層四欄:Version 固定 1.3、簽章對得上、內層可解回帶 CreditHash', () => {
    const form = buildCreditCharge(base, KEYS)
    expect(form.MerID).toBe('S076820628')
    expect(form.Version).toBe('1.3')
    expect(verifyHashInfo(form.EncryptInfo, form.HashInfo, KEYS)).toBe(true)
    expect(decrypt(form.EncryptInfo, KEYS)).toMatchObject({ CreditHash: 'HASHTOKEN123', TradeAmt: '499' })
  })
})

describe('verifyAndDecryptPayuniNotify(模擬 PAYUNi 回傳)', () => {
  it('驗簽 + 解密成功回交易明細', () => {
    const result = { Status: 'SUCCESS', MerID: 'ABC', MerTradeNo: 'NP1', TradeNo: 'UNI123', TradeAmt: '499' }
    const enc = encrypt(result, KEYS)
    const hash = makeHashInfo(enc, KEYS)
    expect(verifyAndDecryptPayuniNotify(enc, hash, KEYS)).toMatchObject(result)
  })

  it('簽章不符一律回 null(不得開通)', () => {
    const enc = encrypt({ Status: 'SUCCESS' }, KEYS)
    expect(verifyAndDecryptPayuniNotify(enc, 'DEADBEEF', KEYS)).toBeNull()
  })
})

describe('encodeEncryptInfo', () => {
  it('串成 x-www-form-urlencoded query', () => {
    expect(encodeEncryptInfo({ a: 1, b: 'x y' })).toBe('a=1&b=x+y')
  })
})

describe('isTradePaid(查單對帳:只看 TradeStatus)', () => {
  it('TradeStatus=1 → 已付款,不管外層狀態', () => {
    expect(isTradePaid({ TradeStatus: '1' })).toBe(true)
  })
  it('查無訂單(無 TradeStatus)/未付/失敗 → false', () => {
    expect(isTradePaid({ Message: '查無符合訂單資料' })).toBe(false) // 查單 not-found 解密結果
    expect(isTradePaid({ TradeStatus: '0' })).toBe(false)
    expect(isTradePaid({ TradeStatus: '2' })).toBe(false)
    expect(isTradePaid(null)).toBe(false)
  })
})

describe('isPayuniPaid(兩層成功判定)', () => {
  it('外層 Status=SUCCESS 且 TradeStatus=1 → 付款成功', () => {
    expect(isPayuniPaid('SUCCESS', { TradeStatus: '1' })).toBe(true)
    expect(isPayuniPaid('OK', { TradeStatus: '1' })).toBe(true)
  })
  it('外層 SUCCESS 但 TradeStatus 非 1（待付款/失敗/取消）→ 不算成功', () => {
    expect(isPayuniPaid('SUCCESS', { TradeStatus: '0' })).toBe(false)
    expect(isPayuniPaid('SUCCESS', { TradeStatus: '2' })).toBe(false)
    expect(isPayuniPaid('SUCCESS', { TradeStatus: '3' })).toBe(false)
  })
  it('外層非 SUCCESS → 一律不算成功(就算 TradeStatus=1)', () => {
    expect(isPayuniPaid('ERROR', { TradeStatus: '1' })).toBe(false)
    expect(isPayuniPaid('', { TradeStatus: '1' })).toBe(false)
  })
  it('result 為 null 不炸,回 false', () => {
    expect(isPayuniPaid('SUCCESS', null)).toBe(false)
  })
})

describe('parsePayuniQueryResult + isQueryTradePaid（真實查單格式:巢狀 Result[0]）', () => {
  // 取自 2026-08-04 對 PAYUNi 沙盒「真的已付款」單 NP2608041503069QQ 的 trade/query 回傳
  // （已付款 = TradeStatus '1',與 Notify 同語意;CloseStatus '2' = 請款成功）
  const paidQuery = {
    Status: 'SUCCESS', Message: '查詢成功',
    'Result[0][MerTradeNo]': 'NP2608041503069QQ',
    'Result[0][TradeNo]': '1785855858256599355',
    'Result[0][TradeAmt]': '1499',
    'Result[0][TradeStatus]': '1',
    'Result[0][PaymentType]': '1',
    'Result[0][PaymentDay]': '2026-08-04 23:04:18',
    'Result[0][CloseStatus]': '2',
  }
  it('把 Result[0][X] 攤平成扁平欄位', () => {
    expect(parsePayuniQueryResult(paidQuery)).toMatchObject({
      MerTradeNo: 'NP2608041503069QQ', TradeNo: '1785855858256599355', TradeAmt: '1499',
      TradeStatus: '1', PaymentType: '1', PaymentDay: '2026-08-04 23:04:18',
    })
  })
  it('查單已付款 = TradeStatus 1（可餵給 fulfillPayuniTrade 開通）', () => {
    expect(isQueryTradePaid(parsePayuniQueryResult(paidQuery))).toBe(true)
  })
  it('**付款失敗(2)就算有 PaymentDay 也不是已付款** —— 舊版曾把這種單當已付款結算(回歸釘)', () => {
    // 實測證據:失敗/取消的單「也有」PaymentDay(2026-08-04 沙盒 3D 取消單:TradeStatus 3 + PaymentDay 有值)
    // → PaymentDay 不能當付款證據;TradeStatus 2 按官方文件是「付款失敗」。
    expect(isQueryTradePaid({ TradeStatus: '2', PaymentDay: '2026-08-04 23:02:36' })).toBe(false)
  })
  it('取消(3)/未付款(9)/待確認(8)/逾期(4) 一律不是已付款', () => {
    for (const st of ['3', '9', '8', '4', '0']) {
      expect(isQueryTradePaid({ TradeStatus: st, PaymentDay: '2026-08-04 23:02:36' })).toBe(false)
    }
  })
  it('查無訂單（沒有 Result[0]）→ 攤平成空、判為未付,不誤開通', () => {
    const notFound = { Status: 'QUERY03001', Message: '查無符合訂單資料', MerTradeNo: 'NP1' }
    expect(parsePayuniQueryResult(notFound)).toEqual({})
    expect(isQueryTradePaid(parsePayuniQueryResult(notFound))).toBe(false)
  })
})

describe('resolvePayuniEnv(別讓拼字把正式導到沙盒)', () => {
  it('各種正式寫法都算 prod', () => {
    for (const v of ['prod', 'production', 'PROD', 'Production', ' prod ', 'live', 'core']) {
      expect(resolvePayuniEnv(v)).toBe('prod')
    }
  })
  it('測試/空值算 test', () => {
    for (const v of ['test', 'sandbox', 'dev', 'staging', '', undefined, null]) {
      expect(resolvePayuniEnv(v)).toBe('test')
    }
  })
  it('無法識別的值保守用 test（不拿設定錯的環境去扣真客戶）', () => {
    expect(resolvePayuniEnv('prd')).toBe('test')
    expect(resolvePayuniEnv('xyz')).toBe('test')
  })
})

describe('payuniPaymentType', () => {
  it("'1' → CREDIT(對齊帳單頁 payTypeLabel);未知碼原樣保留;空值 null", () => {
    expect(payuniPaymentType('1')).toBe('CREDIT')
    expect(payuniPaymentType('9')).toBe('9')
    expect(payuniPaymentType('')).toBeNull()
    expect(payuniPaymentType(null)).toBeNull()
  })
})

// ── 首刷建立信用卡約定（拿 CreditHash 供每期幕後續扣）────────────────────────

describe('sanitizeCreditTokenRef（CreditToken 參照字串）', () => {
  it('合法字元原樣保留', () => {
    expect(sanitizeCreditTokenRef('MYFEEL')).toBe('MYFEEL')
    expect(sanitizeCreditTokenRef('ws-01_a.b+c@d#e$f%g')).toBe('ws-01_a.b+c@d#e$f%g')
  })
  it('剃掉官方不允許的字元（斜線/空白/中文）,避免整筆被 PAYUNi 退', () => {
    expect(sanitizeCreditTokenRef('ws/01 測試')).toBe('ws01')
  })
  it('超過 200 碼截斷', () => {
    expect(sanitizeCreditTokenRef('a'.repeat(250))).toHaveLength(200)
  })
  it('清完為空 → throw（**不可**靜默改走不建約定：客戶會付了首月卻沒有委託）', () => {
    expect(() => sanitizeCreditTokenRef('///')).toThrow()
    expect(() => sanitizeCreditTokenRef('')).toThrow()
  })
})

describe('buildTokenBindFields（UPP 首刷建約定參數）', () => {
  const f = buildTokenBindFields('ws1')
  it('UseTokenType=3 強制約定——不能用 1', () => {
    // 1 = 消費者可在 PAYUNi 付款頁自行取消約定 → 我方會「收到付款成功卻拿不到可續扣的
    // Token」,變成收了首月卻沒委託的靜默失敗。取消一律走我方後台入口（可控、有稽核）。
    expect(f.UseTokenType).toBe(3)
  })
  it('Credit=1 / CreditTokenType=2（商店級）/ CreditToken 帶我方參照', () => {
    expect(f).toEqual({ Credit: 1, UseTokenType: 3, CreditToken: 'ws1', CreditTokenType: 2 })
  })
  it('疊進 UPP EncryptInfo 後可完整往返（加解密不吃掉這些欄位）', () => {
    const enc = encrypt({ MerID: 'MER1', MerTradeNo: 'NP1', TradeAmt: 399, ...f }, KEYS)
    expect(decrypt(enc, KEYS)).toMatchObject({ UseTokenType: '3', CreditToken: 'ws1', CreditTokenType: '2', Credit: '1' })
  })
})

describe('parseCardMandate（從回傳取出約定卡）', () => {
  it('有 CreditHash → 取出 Token / 末四碼 / 有效期', () => {
    expect(parseCardMandate({ CreditHash: 'HASH123', Card4No: '1234', CreditLife: '0929' }))
      .toEqual({ token: 'HASH123', last4: '1234', expiry: '0929' })
  })
  it('只有 Token、沒末四碼/有效期 → 兩者為 null（不編造）', () => {
    expect(parseCardMandate({ CreditHash: 'HASH123' })).toEqual({ token: 'HASH123', last4: null, expiry: null })
  })
  it('沒有 CreditHash / 空字串 / null → 一律 null（呼叫端須當「沒有自動續訂」處理）', () => {
    expect(parseCardMandate({ TradeStatus: '1' })).toBeNull()
    expect(parseCardMandate({ CreditHash: '  ' })).toBeNull()
    expect(parseCardMandate(null)).toBeNull()
    expect(parseCardMandate(undefined)).toBeNull()
  })
})

// ── 解除信用卡約定（credit_bind/cancel）─────────────────────────────────────
// 規格來源:官方文件「信用卡Token取消(約定/記憶卡號)(CREDIT)」Ver 1.0 + 沙盒探針。

describe('buildBindCancelFields / buildBindCancel（解約）', () => {
  const base = { merchantId: 'S076820628', bindVal: 'HASHTOKEN123', timestamp: 1700000000 }

  it('欄位名是 **BindVal**（不是 CreditHash／CreditToken）', () => {
    // 這一行是踩了 30+ 個猜測才問出來的:官方欄位名為 BindVal,
    // 「要放 CreditHash 還是 CreditToken」由 UseTokenType 決定。
    expect(buildBindCancelFields(base)).toEqual({
      MerID: 'S076820628',
      UseTokenType: 1, // 1 = 綁定（約定）
      BindVal: 'HASHTOKEN123',
      CreditTokenType: 2, // 2 = 商店級,與首刷送的一致
      Timestamp: 1700000000,
    })
  })

  it('預設是約定(1) + 商店級(2)——與我方首刷 UseTokenType=3/CreditTokenType=2 對得上', () => {
    const f = buildBindCancelFields(base)
    expect(f.UseTokenType).toBe(BIND_TYPE_MANDATE)
    expect(f.CreditTokenType).toBe(2)
  })

  it('記憶卡號(2) 時呼叫端要改帶 CreditToken(語意由 useTokenType 標示)', () => {
    const f = buildBindCancelFields({ ...base, bindVal: 'MYFEEL', useTokenType: BIND_TYPE_REMEMBER_CARD })
    expect(f.UseTokenType).toBe(2)
    expect(f.BindVal).toBe('MYFEEL')
  })

  it('外層四欄:Version 固定 1.0、簽章對得上、內層可解回帶 BindVal', () => {
    const form = buildBindCancel(base, KEYS)
    expect(form.MerID).toBe('S076820628')
    expect(form.Version).toBe('1.0') // 帶 1.3 官方會回 API00003
    expect(verifyHashInfo(form.EncryptInfo, form.HashInfo, KEYS)).toBe(true)
    expect(decrypt(form.EncryptInfo, KEYS)).toMatchObject({ BindVal: 'HASHTOKEN123', UseTokenType: '1' })
  })
})

describe('resolveBackendUrl（固定出口 IP 中繼站）', () => {
  const CREDIT = PAYUNI_CREDIT_ENDPOINTS.prod
  const CANCEL = PAYUNI_BIND_CANCEL_ENDPOINTS.prod

  it('沒設中繼站 → 原樣直連 PAYUNi（現行行為必須一行不變）', () => {
    for (const blank of [undefined, null, '', '   ']) {
      expect(resolveBackendUrl(CREDIT, blank)).toBe(CREDIT)
    }
  })

  it('設了中繼站 → 只換主機,**路徑原樣保留**（PAYUNi 靠路徑分辨是扣款還是解約）', () => {
    expect(resolveBackendUrl(CREDIT, 'https://relay.example.com')).toBe('https://relay.example.com/api/credit')
    expect(resolveBackendUrl(CANCEL, 'https://relay.example.com')).toBe('https://relay.example.com/api/credit_bind/cancel')
  })

  it('尾斜線與前後空白都要吃掉（不然會變 //api/credit 打到 404,整個自動扣款靜默失效）', () => {
    expect(resolveBackendUrl(CREDIT, ' https://relay.example.com/ ')).toBe('https://relay.example.com/api/credit')
  })

  it('中繼站帶 port / 子路徑也不吃掉路徑（子路徑不支援 → 由設定文件約束只填原點）', () => {
    expect(resolveBackendUrl(CREDIT, 'https://10.0.0.9:8443')).toBe('https://10.0.0.9:8443/api/credit')
  })

  it('**UPP 付款頁不受中繼站影響** —— 那是瀏覽器導轉,繞中繼站等於把客人的刷卡頁掛在小機器上', () => {
    // 付款頁網址在 payment/create-order 直接取 PAYUNI_ENDPOINTS,不經過 resolveBackendUrl。
    // 這個測試釘住「中繼站只服務幕後 API」這個邊界。
    expect(PAYUNI_ENDPOINTS.prod).toContain('api.payuni.com.tw')
    expect(resolveBackendUrl(PAYUNI_ENDPOINTS.prod, 'https://relay.example.com')).not.toBe(PAYUNI_ENDPOINTS.prod)
  })
})
