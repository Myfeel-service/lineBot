/**
 * `C-423`／`C-425`／`C-426` 實機守門員：機器人模組（MYFEEL 真資料、零寫入）
 *
 *   BROADCAST_CRON_ENABLED=false npx nuxi dev --port 3123              # 另一個終端先跑起來（關掉本機推播排程）
 *   CHECK_BASE_URL=http://localhost:3123 node --env-file=.env_myfeel scripts/flow-sheet-usage-check.mjs
 *
 * 驗四件事：
 *   D. 近 30 天幾位客人收到（`C-425`）：讀不到／還沒記錄時一個數字都不畫（對照組，⛔ 空白不等於 0 位）；
 *      有資料時清單最上面一句圖例、每列右邊「N 人」不擠掉名字、選中的模組標題下接一句
 *   F. 試算表的一格（`C-423`）：插入選單有「試算表的一格」→ 挑 Giaretti／出貨時間 → 小視窗秀現在寫的 →
 *      插進去是一顆膠囊、預覽畫的是試算表上的字（兩批出貨時間）
 *   G. 快速回覆在最後一則時，「＋ 文字」插在它前面（`C-424`）
 *   E. 傳給我自己看（`C-426`）：送的是畫面上那一份（含還沒存的字與試算表那一格的存檔格式），⛔ 沒有任何存檔請求
 *
 * 選項：
 *   SHEET_FIELDS_JSON＝路徑：用這份回答「試算表清單」。上線前正式庫的試算表還沒記欄名（要等新版同步一次），
 *     先用唯讀讀真試算表算出來的那份頂上（`scratchpad/sheet-real.ts` 產的）。上線同步過之後不用帶。
 *   USAGE_FAKE＝1：第二輪用假的「幾位客人收到」驗版面（數字是假的，只量排版）。
 *
 * ⛔ 所有非 GET 的 /api 一律攔下；「傳給我自己看」那一支回假的成功並記下送了什麼，⛔ 不真的送。
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99'
const SHOT_DIR = process.env.SHOT_DIR ?? tmpdir()
const SHEET_JSON = process.env.SHEET_FIELDS_JSON ? readFileSync(process.env.SHEET_FIELDS_JSON, 'utf8') : null
const USAGE_FAKE = process.env.USAGE_FAKE === '1'

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()
const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
const admin = members.docs.map(d => ({ id: d.id, ...d.data() })).find(r => r.role === 'owner' || r.role === 'admin')
if (!admin) { console.error('這個工作區查不到管理員'); process.exit(1) }
const uid = String(admin.uid ?? admin.id)
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: await getAuth().createCustomToken(uid), returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }

const get = async path => (await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspaceId=${WORKSPACE_ID}`, {
  headers: { Authorization: `Bearer ${session.idToken}` },
})).json()
const allFlows = await get('/api/flow/list')
const ship = allFlows.find(f => /^客服 - 出貨進度查詢 - Giaretti/.test(String(f.name)))
const liveAgent = allFlows.find(f => f.isSystem && f.moduleType === 'live_agent')
if (!ship) { console.error('找不到 Giaretti 出貨進度那個模組'); process.exit(1) }
const realUsage = await get('/api/flow/list?part=usage')
console.log(`受測：「${ship.name}」（${ship.messages?.map(m => m.type).join(' → ')}）；正式庫近 30 天紀錄從 ${realUsage.trackedSince ?? '（還沒有）'} 起`)

let fakeUsage = false
const FAKE_USAGE = {
  from: realUsage.from, to: realUsage.to, trackedSince: realUsage.from,
  modules: { [ship.id]: { users: 80, sends: 95 }, ...(liveAgent ? { [liveAgent.id]: { users: 312, sends: 542 } } : {}) },
}
const blocked = []
const testSends = []

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1100 })
page.on('dialog', d => d.accept())
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 160)))
await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = new URL(req.url())
  if (url.pathname === '/api/flow/list' && req.method() === 'GET') {
    if (url.searchParams.get('part') === 'sheet-fields' && SHEET_JSON) {
      return req.respond({ status: 200, contentType: 'application/json', body: SHEET_JSON })
    }
    if (url.searchParams.get('part') === 'usage' && fakeUsage) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_USAGE) })
    }
  }
  if (req.method() !== 'GET' && url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/flow/create' && url.searchParams.get('part') === 'test-send') {
      const body = JSON.parse(req.postData() || '{}')
      testSends.push(body)
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, messageCount: body.messages?.length ?? 0, sent: (body.lineUserIds ?? []).map(id => ({ lineUserId: id, displayName: '（守門員假送出）', ok: true })),
      }) })
    }
    blocked.push(`${req.method()} ${url.pathname}${url.search}`)
    return req.abort()
  }
  req.continue()
})

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 120_000 })
await page.evaluate(async (s) => {
  const user = { uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'google.com', uid: s.email, displayName: null, email: s.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
    createdAt: String(Date.now() - 86400_000), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]' }
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('firebaseLocalStorageDb', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
    req.onsuccess = () => {
      const tx = req.result.transaction('firebaseLocalStorage', 'readwrite')
      tx.objectStore('firebaseLocalStorage').put({ fbase_key: `firebase:authUser:${s.apiKey}:[DEFAULT]`, value: user })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}, session)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const closeTours = () => page.evaluate(() => { document.querySelectorAll('.el-tour__closebtn').forEach(b => b.click()) })
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const waitFor = (fn, arg, timeout = 15_000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false)
const openFlowPage = async () => {
  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow?id=${ship.id}`, { waitUntil: 'networkidle2', timeout: 120_000 })
  await waitFor(() => document.querySelectorAll('.split-list .split-list-item').length > 3, null, 60_000)
  await waitFor(() => document.querySelector('.msg-type-btns'), null, 30_000)
  await sleep(1200)
  await closeTours()
}

// ── D. 近 30 天幾位客人收到 ─────────────────────────────────
await openFlowPage()
if (!realUsage.trackedSince) {
  const none = await page.evaluate(() => ({
    note: !!document.querySelector('.flow-list-usage-note'),
    chips: [...document.querySelectorAll('.split-list .split-list-item__time')].filter(e => /人$/.test(e.innerText.trim())).length,
    caption: !!document.querySelector('.flow-usage-count'),
  }))
  check('D0 對照組：還沒有紀錄時一個數字都不畫（空白不等於 0 位）', !none.note && none.chips === 0 && !none.caption,
    `圖例 ${none.note}、清單數字 ${none.chips}、標題下 ${none.caption}`)
}
if (USAGE_FAKE) {
  fakeUsage = true
  await openFlowPage()
  await waitFor(() => document.querySelector('.flow-list-usage-note'))
  const d = await page.evaluate((ids) => {
    const note = document.querySelector('.flow-list-usage-note')?.innerText.trim() ?? ''
    const sys = [...document.querySelectorAll('.split-list [data-tour^="flow-sys-"]')]
    const sysChips = sys.map(el => el.querySelector('.split-list-item__time')?.innerText.trim() ?? '')
    const row = document.querySelector(`.split-list [data-flow-id="${ids.ship}"]`)
    const chip = row?.querySelector('.split-list-item__time')
    const name = row?.querySelector('.split-list-name')
    const chips = [...document.querySelectorAll('.split-list [data-flow-id] .split-list-item__time')].map(e => e.innerText.trim())
    return {
      note,
      sysChips,
      shipChip: chip?.innerText.trim() ?? '',
      // 名字被截短沒關係，但不可以疊到數字上；數字要整顆在這一列裡面
      fits: !!chip && !!name && !!row && name.getBoundingClientRect().right <= chip.getBoundingClientRect().left + 0.5 && chip.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5,
      zeroRows: chips.filter(t => t === '0 人').length,
      caption: document.querySelector('.flow-usage-count')?.innerText.trim() ?? '',
    }
  }, { ship: ship.id })
  check('D1 清單最上面一句圖例', d.note === '右邊數字＝近 30 天幾位客人收到', d.note)
  check('D2 受測模組那一列「80 人」，名字不疊到數字、數字在列內', d.shipChip === '80 人' && d.fits, `「${d.shipChip}」、排得下 ${d.fits}`)
  check('D3 沒紀錄的模組寫「0 人」（有紀錄之後 0 才是 0）', d.zeroRows > 0, `0 人的列 ${d.zeroRows}`)
  check('D4 系統模組（真人客服）也有數字', !liveAgent || d.sysChips.includes('312 人'), d.sysChips.join('、'))
  check('D5 選中的模組標題下接「近 30 天 80 位客人收到」', d.caption === '近 30 天 80 位客人收到', d.caption)
  await page.screenshot({ path: join(SHOT_DIR, 'flow-usage-list.png'), clip: { x: 0, y: 0, width: 900, height: 700 } })
  fakeUsage = false
}

// ── G. 快速回覆在最後一則：「＋ 文字」插在它前面 ───────────────────
const badgesBefore = await page.evaluate(() => [...document.querySelectorAll('.fem-rail .card-badge, .fem-rail [class*="badge-"]')].map(b => b.innerText.trim()).filter(Boolean))
await page.evaluate(() => document.querySelector('[data-tour="fmt-text"]')?.click())
await sleep(500)
const order = await page.evaluate(() => [...document.querySelectorAll('.fem-rail [class*="badge-"]')].map(b => b.innerText.trim()).filter(Boolean))
check('G1 「＋ 文字」插在快速回覆前面，快速回覆還是最後一則', order[order.length - 1] === '快速回覆' && order.includes('文字訊息'),
  `加之前 ${badgesBefore.join('→')}／加之後 ${order.join('→')}`)

// ── F. 試算表的一格 ───────────────────────────────────────
const prompt = '[data-tour="quick-prompt"]'
await page.evaluate(sel => document.querySelector(`${sel} .flow-var-inset__btn`)?.click(), prompt)
await sleep(600)
const menu = await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(i => i.offsetParent !== null).map(i => i.innerText.trim()))
check('F1 插入選單裡有「試算表的一格」', menu.some(t => t.startsWith('試算表的一格')), menu.join('｜'))
await page.evaluate(() => [...document.querySelectorAll('[data-tour="var-sheet-field"]')].find(i => i.offsetParent !== null)?.click())
await waitFor(() => [...document.querySelectorAll('.flow-sheet-dialog')].some(d => d.offsetParent !== null), null, 20_000)
await waitFor(() => document.querySelectorAll('.flow-sheet-dialog .el-select').length >= 3, null, 20_000)
await sleep(500)
// 挑列：打開下拉、找 Giaretti 那一項
const pickOption = async (selectIndex, startsWith) => {
  await page.evaluate(i => document.querySelectorAll('.flow-sheet-dialog .el-select .el-select__wrapper')[i]?.click(), selectIndex)
  await sleep(500)
  const ok = await page.evaluate((t) => {
    const item = [...document.querySelectorAll('.el-select-dropdown__item')].find(li => li.offsetParent !== null && li.innerText.trim().startsWith(t))
    item?.click()
    return !!item
  }, startsWith)
  await sleep(400)
  return ok
}
const rowPicked = await pickOption(1, 'Giaretti')
const fieldPicked = await pickOption(2, '出貨時間')
const value = await page.evaluate(() => document.querySelector('.flow-sheet-dialog__value')?.innerText ?? '')
check('F2 挑 Giaretti／出貨時間：小視窗秀現在寫的（兩批出貨）', rowPicked && fieldPicked && value.includes('第二批') && value.includes('11 月底'),
  `挑到列 ${rowPicked}、欄 ${fieldPicked}、內容「${value.replace(/\n/g, ' ').slice(0, 80)}」`)
await page.screenshot({ path: join(SHOT_DIR, 'flow-sheet-dialog.png') })
await page.evaluate(() => [...document.querySelectorAll('.flow-sheet-dialog .el-button--primary')].find(b => b.offsetParent !== null)?.click())
await sleep(800)
const inserted = await page.evaluate((sel) => {
  const pills = [...document.querySelectorAll(`${sel} .var-field__pill`)].map(p => p.innerText.replace(/ /g, '').trim())
  // ⚠️ 只能找手機預覽本身（`.fmp`）：用 [class*="preview"] 會先撿到「隱藏預覽」那顆開關
  const preview = document.querySelector('aside.fmp')?.innerText ?? ''
  return { pills, previewHasValue: preview.includes('第二批') && preview.includes('11 月底'), previewHasToken: preview.includes('{{sheet:') }
}, prompt)
check('F3 插進去是一顆膠囊「Giaretti…・出貨時間」', inserted.pills.some(p => p.startsWith('Giaretti') && p.endsWith('・出貨時間')), inserted.pills.join('｜'))
check('F4 預覽畫試算表上的字、不露出標記', inserted.previewHasValue && !inserted.previewHasToken, `有兩批 ${inserted.previewHasValue}、露標記 ${inserted.previewHasToken}`)
await page.screenshot({ path: join(SHOT_DIR, 'flow-sheet-inserted.png') })

// ── E. 傳給我自己看 ───────────────────────────────────────
await page.evaluate(() => document.querySelector('[data-tour="flow-test-send"]')?.click())
await waitFor(() => [...document.querySelectorAll('.bc-dialog-testsend')].some(d => d.offsetParent !== null), null, 20_000)
await waitFor(() => !document.querySelector('.bc-dialog-testsend .tags-loading'), null, 20_000)
await sleep(600)
const dlg = await page.evaluate(() => {
  const d = [...document.querySelectorAll('.bc-dialog-testsend')].find(x => x.offsetParent !== null)
  return {
    title: d?.querySelector('.el-dialog__title')?.innerText.trim() ?? '',
    hint: d?.querySelector('.tags-hint')?.innerText.trim() ?? '',
    groups: [...(d?.querySelectorAll('.bc-testsend-group__title') ?? [])].map(e => e.innerText.trim()),
    checked: d?.querySelectorAll('.el-checkbox.is-checked').length ?? 0,
  }
})
check('E1 打開「傳給我自己看」：講明送畫面上這一份、不會幫你存；收件人名單照推播試發那份', dlg.title === '傳給我自己看' && dlg.hint.includes('不會幫你存') && dlg.groups.includes('常找來看稿的人'),
  `標題「${dlg.title}」、名單 ${dlg.groups.join('／')}、已勾 ${dlg.checked}`)
await page.screenshot({ path: join(SHOT_DIR, 'flow-test-send.png') })
if (dlg.checked > 0) {
  await page.evaluate(() => [...document.querySelectorAll('.bc-dialog-testsend .el-button--primary')].find(b => b.offsetParent !== null)?.click())
  await waitFor(() => document.querySelector('.bc-dialog-testsend .bc-testsend-done'), null, 15_000)
  const sentBody = testSends[0]
  const qr = sentBody?.messages?.find(m => m.type === 'quickReply')
  check('E2 送出的是畫面上那一份：含剛插的試算表那一格（存的格式）、含剛加的那則文字', !!qr && String(qr.text).includes('{{sheet:') && sentBody.messages.some(m => m.type === 'text'),
    `送了 ${sentBody?.messages?.map(m => m.type).join('→') ?? '（沒送）'}`)
}
else {
  check('E2 這個帳號的管理員名單上沒有人可勾，這次沒按送出', false, '先把手機加進試發名單再跑')
}
const saves = blocked.filter(b => /\/api\/flow\/(create|[0-9a-f-]{36})(\?|$)/.test(b.replace(/^(PUT|POST) /, '')))
check('E3 ⛔ 整段沒有任何存檔請求（傳給自己看不存檔）', saves.length === 0, saves.join('、') || '沒有')

await browser.close()
console.log('\n攔下的非 GET：', blocked.length ? blocked.join('、') : '（沒有）')
console.log(`截圖在 ${SHOT_DIR}`)
let bad = 0
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `　${r.detail}` : ''}`)
  if (!r.ok) bad++
}
process.exit(bad ? 1 : 0)
