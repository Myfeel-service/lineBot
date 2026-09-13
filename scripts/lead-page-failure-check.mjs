/**
 * 活動頁失敗統計的實機守門員（`G-88`）。
 *
 *   npm run dev                                        # 另一個終端先跑起來
 *   node scripts/lead-page-failure-check.mjs [BASE_URL]
 *
 * 驗兩件事，都是純函式測不到、只有真的開一次瀏覽器才知道的：
 *   ① **綁定成功不可以被記成逾時**——2026-09-13 查 myfeel 的 117 次「打不開活動頁」，
 *      94 次逾時與成功人數等比例；原因是成功之後畫面還停在 `loading`，靠 LINE 關窗收尾，
 *      關窗沒生效就被 20 秒看門狗收成一次失敗，客人明明綁定成功卻看到「無法完成綁定」。
 *   ② **逾時要說得出卡在哪一步**——在此之前只記一句寫死的 `loading_watchdog`，
 *      「網路慢」「SDK 載不下來」「LINE 沒回應」「綁定卡住」全擠在同一個數字裡。
 *
 * ⛔ 不需要憑證，也不碰正式資料：claim 與回報端點都被攔下，LIFF SDK 換成假的。
 * ⛔ launch 的三個 throttling 旗標不可以拿掉：headless 的分頁雖然
 *    `visibilityState === 'visible'`，Chrome 仍當它被遮住而節流計時器——
 *    `setTimeout(20000)` 會 28 秒都不到期，看門狗測起來像壞了其實是測試環境的事。
 */
import puppeteer from 'puppeteer'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const LIFF_ID = process.env.CHECK_LIFF_ID ?? '2000009466-6XZKt7ZF' // MYFEEL
const UA_LINE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.19.0'
const WATCHDOG_WAIT_MS = 26_000 // 比程式裡的 20 秒看門狗長

/** 假的 @line/liff：`closeWindow` 故意不生效＝模擬 LINE 沒把 LIFF 關掉 */
const FAKE_LIFF = `
const calls = (window.__fake = { openWindow: 0, closeWindow: 0 })
export default {
  init: async () => {},
  isLoggedIn: () => true,
  getAccessToken: () => 'fake-access-token',
  isInClient: () => true,
  openWindow: () => { calls.openWindow++ },
  closeWindow: () => { calls.closeWindow++ },
}
`

let failures = 0
const fail = (msg) => { console.error(`❌ ${msg}`); failures++ }
const pass = (msg) => console.log(`✅ ${msg}`)

async function open() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA_LINE)
  await page.setViewport({ width: 500, height: 900 })
  return { browser, page }
}

// ── ① 綁定成功之後，不可以再送出任何逾時回報 ──────────────────────────
{
  const { browser, page } = await open()
  const reports = []
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const url = r.url()
    if (url.includes('/api/liff/lead-error')) {
      try { reports.push(JSON.parse(r.postData() || '{}')) } catch { reports.push({ 原文: r.postData() }) }
      return void r.abort().catch(() => {})
    }
    if (url.includes('/api/liff/claim')) {
      // 最糟的組合：沒有轉址網址、沒有官方帳號基本 ID＝原本那條「無處可跳」的死路
      return void r.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, immediatelyApplied: true, campaignCode: 'probe' }),
      }).catch(() => {})
    }
    if (url.includes('/api/liff/apply')) return void r.abort().catch(() => {})
    if (/@line[_/]liff/.test(url))
      return void r.respond({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF }).catch(() => {})
    r.continue().catch(() => {})
  })

  await page.goto(`${BASE}/liff/lead?liffId=${LIFF_ID}&ct=probe-token&c=probe`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await new Promise(r => setTimeout(r, WATCHDOG_WAIT_MS))
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')

  if (reports.length)
    fail(`綁定成功卻送出了失敗回報：${reports.map(r => JSON.stringify(r)).join(' , ')}`)
  else
    pass('綁定成功不再被記成逾時（關窗刻意無效的情況下）')

  if (/綁定完成/.test(text)) pass('畫面停在「綁定完成」')
  else fail(`畫面沒有收成完成：${text.slice(0, 120)}`)

  await browser.close()
}

// ── ② 逾時要說得出卡在哪一步 ──────────────────────────────────────────
{
  const { browser, page } = await open()
  const reports = []
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const url = r.url()
    if (url.includes('/api/liff/lead-error')) {
      try { reports.push(JSON.parse(r.postData() || '{}')) } catch { reports.push({ 原文: r.postData() }) }
      return void r.abort().catch(() => {})
    }
    // 擋掉 LINE 的 SDK＝模擬「客人網路爛到 SDK 載不下來」。
    // ⛔ 只能擋 @line/liff 本身：路徑裡有 liff 的還包含頁面自己（pages/liff/lead.vue），
    //    連頁面一起擋掉就什麼都不會發生，測了個寂寞。
    if (/@line[_/]liff/.test(url)) return void r.abort().catch(() => {})
    r.continue().catch(() => {})
  })

  await page.goto(`${BASE}/liff/lead?liffId=${LIFF_ID}&ct=probe-token&c=probe`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await new Promise(r => setTimeout(r, WATCHDOG_WAIT_MS))

  const timeout = reports.find(r => r.reason === 'load_timeout')
  if (!timeout) fail('SDK 載不下來時看門狗沒有回報（它本來就是為了這種情形存在的）')
  else if (timeout.stage !== 'load_sdk') fail(`階段回報錯了：拿到 ${JSON.stringify(timeout.stage)}，應該是 load_sdk`)
  else pass(`逾時說得出卡在哪一步：stage=${timeout.stage}`)

  await browser.close()
}

console.log(failures ? `\n${failures} 項不通過` : '\n全部通過')
process.exitCode = failures ? 1 : 0
