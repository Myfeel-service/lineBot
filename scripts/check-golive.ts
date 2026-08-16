/**
 * 上線前健檢：一次驗完金流與發票這條線，**不會動到任何錢、不會開出任何發票、不會發訊息**。
 *
 * 為什麼要這支：上線卡關的東西散在三個別人的後台（光貿客服、PAYUNi 商店設定、Amplify
 * 環境變數），每次「我改好了」之後都要重新確認一遍。與其每次臨時寫，不如固定一支。
 *
 * 怎麼做到不動錢：
 *   · 光貿 —— 送「簽章正確但內容是空的」開立請求。帳號對不對看得出來，發票開不出來。
 *   · PAYUNi —— 只查一筆不存在的訂單編號（trade/query 是唯讀）。
 *   ⛔ 刻意不打 /api/credit（幕後扣款）：那支會動錢，而且用假 Token 測也問不出 IP 白名單
 *      有沒有生效（PAYUNi 先擋 Token 才檢查 IP），白測。
 *
 * 用法：
 *   node --env-file=.env_production --experimental-strip-types scripts/check-golive.ts
 *   node --env-file=.env --experimental-strip-types scripts/check-golive.ts        # 沙盒那組
 */
import { createCipheriv, createHash } from 'node:crypto'

const SITE = process.env.PUBLIC_BASE_URL || 'https://lineminime.com'
const PASS = '✅', FAIL = '❌', WARN = '⚠️ ', INFO = 'ℹ️ '

let failures = 0
function report(mark: string, title: string, detail: string) {
  if (mark === FAIL) failures++
  console.log(`\n${mark} ${title}\n   ${detail}`)
}

// ── ① 光貿：帳號通不通 ────────────────────────────────────────────────
async function checkAmego() {
  const ubn = String(process.env.GUANGMAO_INVOICE_SELLER_UBN || '')
  const appKey = String(process.env.GUANGMAO_INVOICE_APP_KEY || '')
  const apiUrl = String(process.env.GUANGMAO_INVOICE_API_URL || '')
  if (!ubn || !appKey || !apiUrl) {
    return report(FAIL, '光貿發票', '三個值沒設齊 → 收款照常，但每一筆訂單都不會開發票')
  }
  if (ubn === '12345678') {
    report(WARN, '光貿發票：用的是公開測試統編', '真客戶的發票會開到光貿測試平台（稅務問題）。正式統編應為公司統編')
  }

  // 簽章正確、內容故意留空 → 只會被欄位檢核擋下，開不出任何發票
  const dataStr = '{}'
  const time = Math.floor(Date.now() / 1000)
  const sign = createHash('md5').update(`${dataStr}${time}${appKey}`, 'utf8').digest('hex')
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/json/f0401`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ invoice: ubn, data: dataStr, time: String(time), sign }).toString(),
    signal: AbortSignal.timeout(25_000),
  })
  const j = await res.json() as { code?: number, msg?: string }

  if (j.code === 14) {
    return report(FAIL, `光貿發票（統編 ${ubn}）`, `被 IP 擋住 → 每一張發票都開不出來，而且收款照常成功、畫面不會報錯。\n   光貿原文：${j.msg}\n   解法：請光貿客服把「允許 IP」設成 0.0.0.0（不限制）——那格商家自己改不了`)
  }
  if (j.code === 16) {
    return report(FAIL, `光貿發票（統編 ${ubn}）`, '簽章驗證失敗 → 統編與 App Key 配不起來，兩個值要同時換成同一組')
  }
  report(PASS, `光貿發票（統編 ${ubn}）`, `帳號與金鑰通過驗證（回 code ${j.code}「${j.msg ?? ''}」＝欄位檢核擋下空資料，這是預期結果）`)
}

// ── ② PAYUNi：商店狀態與中繼站 ────────────────────────────────────────
function payuniQueryBody(): { merID: string, body: string } {
  const merID = String(process.env.PAYUNI_MERCHANT_ID || '')
  const merKey = String(process.env.PAYUNI_HASH_KEY || '')
  const merIV = String(process.env.PAYUNI_HASH_IV || '')
  const sp = new URLSearchParams({ MerID: merID, MerTradeNo: `HEALTH${Date.now()}`, Timestamp: String(Math.floor(Date.now() / 1000)) })
  const c = createCipheriv('aes-256-gcm', Buffer.from(merKey), Buffer.from(merIV))
  const ct = Buffer.concat([c.update(sp.toString(), 'utf8'), c.final()])
  const enc = Buffer.from(`${ct.toString('base64')}:::${c.getAuthTag().toString('base64')}`, 'utf8').toString('hex')
  const hash = createHash('sha256').update(`${merKey}${enc}${merIV}`, 'utf8').digest('hex').toUpperCase()
  return { merID, body: new URLSearchParams({ MerID: merID, Version: '1.0', EncryptInfo: enc, HashInfo: hash }).toString() }
}

/** QUERY03001＝查無這筆交易，也就是「商店正常，只是這個訂單號不存在」——健檢要的就是它。 */
async function payuniStatus(origin: string): Promise<string> {
  const { body } = payuniQueryBody()
  const res = await fetch(`${origin}/api/trade/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    signal: AbortSignal.timeout(25_000),
  })
  return String((await res.json() as Record<string, string>).Status || '')
}

const PAYUNI_HINT: Record<string, string> = {
  QUERY03001: '商店正常（查無這個測試訂單號，本來就查不到）',
  DEF01005: '商店不存在 → 特店代號與環境對不起來（正式特店打到沙盒站，或反過來）',
  DEF01006: '商店狀態不符合 → 特店還沒開通，要催 PAYUNi',
  DEF01007: '檢查碼錯誤 → 特店代號與金鑰不是同一組',
}

async function checkPayuni() {
  const env = String(process.env.PAYUNI_ENV || 'test')
  const direct = env === 'prod' ? 'https://api.payuni.com.tw' : 'https://sandbox-api.payuni.com.tw'
  const { merID } = payuniQueryBody()

  const s = await payuniStatus(direct)
  const ok = s === 'QUERY03001'
  report(ok ? PASS : FAIL, `PAYUNi 金流（特店 ${merID}／${env === 'prod' ? '正式' : '沙盒'}站）`, PAYUNI_HINT[s] ?? `未預期的回應 ${s}`)

  const relay = String(process.env.PAYUNI_RELAY_BASE || '').replace(/\/$/, '')
  if (!relay) {
    return report(WARN, '固定 IP 中繼站', '沒設 → 自動扣款會從主機直接打去 PAYUNi，因為 IP 每天換會被擋')
  }
  if (env === 'prod' && /-test\./.test(relay)) {
    report(FAIL, '固定 IP 中繼站', `正式環境卻指到沙盒那台（${relay}）→ 自動扣款會失敗。要用沒有 -test 的那個網址`)
  }

  const rs = await payuniStatus(relay)
  report(rs === s ? PASS : FAIL, `固定 IP 中繼站（${relay}）`,
    rs === s ? '轉發正常（經中繼站與直連拿到相同結果）' : `轉發結果與直連不一致：直連 ${s}／中繼站 ${rs}`)

  // 中繼站不該變成公開跳板：只有幕後那幾支該通，其餘一律 404
  const openProxy = await fetch(`${relay}/`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).then(r => r.status).catch(() => 0)
  report(openProxy === 404 ? PASS : WARN, '中繼站把關', openProxy === 404 ? '非約定路徑一律 404，沒有變成公開跳板' : `根路徑回 ${openProxy}，確認一下只開放了必要路徑`)
}

// ── ③ 線上網站：三個開關是不是真的生效了 ──────────────────────────────
async function checkSite() {
  const html = await fetch(SITE, { signal: AbortSignal.timeout(25_000) }).then(r => r.text())
  const read = (k: string) => new RegExp(`${k}:(true|false)`).exec(html)?.[1]
  const flags = { 付款: read('paymentEnabled'), 發票: read('invoiceEnabled'), 自動扣款: read('recurringEnabled') }
  const off = Object.entries(flags).filter(([, v]) => v !== 'true').map(([k]) => k)
  report(off.length === 0 ? PASS : FAIL, `線上網站（${SITE}）`,
    off.length === 0
      ? '付款／發票／自動扣款三個開關都是開的'
      : `這幾個還沒生效：${off.join('、')}。⚠️ 這些值是「打包時」算的 → 改完環境變數必須重新部署才會變`)
}

console.log('上線前健檢（唯讀：不動錢、不開發票、不發訊息）')
for (const [name, fn] of [['光貿', checkAmego], ['PAYUNi', checkPayuni], ['網站', checkSite]] as const) {
  try { await fn() }
  catch (e) { report(FAIL, `${name} 檢查沒跑完`, (e as Error).message) }
}

console.log(`\n${'─'.repeat(60)}`)
console.log(failures === 0 ? `${PASS} 全部通過` : `${FAIL} 有 ${failures} 項要處理`)
console.log(`${INFO} 這支驗不到的兩件事，只有真實交易能證明：`)
console.log('   · PAYUNi 的 IP 白名單有沒有生效（它先擋 Token 才檢查 IP，假 Token 測不出來）')
console.log('   · 客人實際刷卡的付款頁能不能成功收款')
process.exit(failures === 0 ? 0 : 1)
