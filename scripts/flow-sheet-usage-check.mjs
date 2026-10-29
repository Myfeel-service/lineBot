/**
 * `C-423`／`C-425`／`C-426`／`C-428`／`C-429` 實機守門員：機器人模組（MYFEEL 真資料、零寫入）
 *
 *   BROADCAST_CRON_ENABLED=false npx nuxi dev --port 3123              # 另一個終端先跑起來（關掉本機推播排程）
 *   CHECK_BASE_URL=http://localhost:3123 node --env-file=.env_myfeel scripts/flow-sheet-usage-check.mjs
 *
 * 驗五件事：
 *   D. 近 30 天幾位客人收到（`C-425`→`C-428`）：讀不到／還沒記錄時一個數字都不畫（對照組，⛔ 空白不等於 0 位）；
 *      有資料時篩選多一格「沒人收到 N」、每列右邊不掛數字、選中的模組標題下接一句
 *   S. 試算表改了、模組還寫著舊的（`C-429`）：沒有記錄時什麼都不出現（對照組）；有記錄時清單最上面點名、
 *      模組上面一條提醒對照舊／新，按「換成跟試算表同步」舊字變藍色膠囊、提醒消失、⛔ 不自動存檔
 *   F. 試算表的一格（`C-423`→`C-428`）：先選取手打的舊字 →「＋ 插入」→「商品資料」→ 挑 Giaretti／出貨時間 →
 *      小視窗秀現在寫的 → 舊字換成一顆藍色短名膠囊、預覽畫的是試算表上的字（兩批出貨時間）
 *   G. 快速回覆在最後一則時，「＋ 文字」插在它前面（`C-424`）
 *   E. 試發（`C-426`→`C-428`）：送的是畫面上那一份（含還沒存的字與試算表那一格的存檔格式），⛔ 沒有任何存檔請求
 *
 * 選項：
 *   SHEET_FIELDS_JSON＝路徑：用這份回答「試算表清單」。上線前正式庫的試算表還沒記欄名（要等新版同步一次），
 *     先用唯讀讀真試算表算出來的那份頂上（`scratchpad/sheet-real.ts` 產的）。上線同步過之後不用帶。
 *   USAGE_FAKE＝1：第二輪用假的「幾位客人收到」驗版面（數字是假的，只量排版）。
 *   S 段的「改過」記錄一律是假的（攔 `?part=sheet-stale` 回一筆），⛔ 不往正式庫寫記錄。
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
// 模組裡手打的那段出貨時間（2026-10-29 唯讀抄的），跟試算表現在寫的
const OLD_SHIP = '依原廠公告：\n商品將於 10 月底 依照訂單順序陸續出貨，實際到貨時間仍需以廠商實際出貨日為準。'
const NEW_SHIP = '依原廠公告：\n第一批商品將於 10 月底 依照訂單順序陸續出貨，\n10/7號開始的訂單為第二批出貨，將於 11 月底 依照訂單順序陸續出貨，\n實際到貨時間仍需以廠商實際出貨日為準。'
let fakeStale = false
const FAKE_STALE = { records: [{
  sourceName: '客服（商品資訊）', row: 'Giaretti 珈樂堤《小滑手》全自動義式咖啡機 GL-5680', field: '出貨時間',
  oldValues: [OLD_SHIP], newValue: NEW_SHIP, moduleIds: [ship.id], changedAt: '2026-10-29T03:00:00.000Z',
}] }
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
    if (url.searchParams.get('part') === 'sheet-stale' && fakeStale) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_STALE) })
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
    unused: !!document.querySelector('[data-tour="flow-list-unused"]'),
    chips: [...document.querySelectorAll('.split-list .split-list-item__time')].filter(e => /人$/.test(e.innerText.trim())).length,
    caption: !!document.querySelector('.flow-usage-count'),
  }))
  check('D0 對照組：還沒有紀錄時一個數字都不畫（空白不等於 0 位）', !none.unused && none.chips === 0 && !none.caption,
    `「沒人收到」那格 ${none.unused}、清單數字 ${none.chips}、標題下 ${none.caption}`)
}
const realStale = await get('/api/flow/list?part=sheet-stale')
if (!realStale.records?.length) {
  const none = await page.evaluate(() => ({
    list: !!document.querySelector('[data-tour="flow-sheet-stale"]'),
    banner: !!document.querySelector('[data-tour="flow-stale-banner"]'),
  }))
  check('S0 對照組：沒有「試算表改了」的記錄＝清單跟模組上面都不出現提醒', !none.list && !none.banner, `清單 ${none.list}、模組上面 ${none.banner}`)
}
if (USAGE_FAKE) {
  fakeUsage = true
  await openFlowPage()
  await waitFor(() => document.querySelector('[data-tour="flow-list-unused"]'))
  const d = await page.evaluate(() => {
    const seg = [...document.querySelectorAll('.flow-list-filter .el-radio-button')]
    const list = document.querySelector('.split-list')
    return {
      segs: seg.map(b => b.innerText.trim()),
      // 三格都要擠得下：字不被切、整排不超出側欄
      segFits: seg.every((b) => {
        const inner = b.querySelector('.el-radio-button__inner')
        return inner && inner.scrollWidth <= inner.clientWidth + 1
      }) && seg.length > 0 && seg[seg.length - 1].getBoundingClientRect().right <= list.getBoundingClientRect().right + 0.5,
      // `C-428`：每一列右邊不再掛數字（那會把「客服 - 出貨進度查詢 - 商品名」的後半段擠掉）
      rowChips: document.querySelectorAll('.split-list [data-flow-id] .split-list-item__time, .split-list [data-tour^="flow-sys-"] .split-list-item__time').length,
      caption: document.querySelector('.flow-usage-count')?.innerText.trim() ?? '',
    }
  })
  check('D1 篩選多一格「沒人收到」，三格都擠得下', d.segs.some(t => /^沒人收到 \d+$/.test(t)) && d.segFits, d.segs.join('｜'))
  check('D2 每一列右邊不掛數字（名字不被擠掉）', d.rowChips === 0, `列上的數字 ${d.rowChips}`)
  check('D3 選中的模組標題下接「近 30 天 80 位客人收到」', d.caption === '近 30 天 80 位客人收到', d.caption)
  await page.screenshot({ path: join(SHOT_DIR, 'flow-usage-list.png'), clip: { x: 0, y: 0, width: 900, height: 700 } })
  await page.evaluate(() => document.querySelector('[data-tour="flow-list-unused"]')?.click())
  await sleep(600)
  const only = await page.evaluate((shipId) => ({
    rows: document.querySelectorAll('.split-list .flow-sidebar-row').length,
    hasShip: !!document.querySelector(`.split-list [data-flow-id="${shipId}"]`),
    sys: document.querySelectorAll('.split-list [data-tour^="flow-sys-"]').length,
    hint: document.querySelector('.flow-list-filter__hint')?.innerText.trim() ?? '',
    handles: document.querySelectorAll('.split-list .drag-handle').length,
    want: Number(document.querySelector('[data-tour="flow-list-unused"]')?.innerText.match(/\d+/)?.[0] ?? -1),
  }), ship.id)
  check('D4 只看沒人收到：列數＝那一格的數字、有人收到的（80 人那個）不在裡面、系統模組不列、不給拖', only.rows === only.want && !only.hasShip && only.sys === 0 && only.handles === 0,
    `列 ${only.rows}／格上寫 ${only.want}、受測模組在裡面 ${only.hasShip}、系統 ${only.sys}、把手 ${only.handles}`)
  check('D5 只看沒人收到：一句說明', only.hint.includes('沒有客人收到'), only.hint)
  await page.screenshot({ path: join(SHOT_DIR, 'flow-usage-unused.png'), clip: { x: 0, y: 0, width: 900, height: 700 } })
  fakeUsage = false
}

// ── S. 試算表改了、模組還寫著舊的（假記錄）──────────────────────
fakeStale = true
await openFlowPage()
await waitFor(() => document.querySelector('[data-tour="flow-stale-banner"]'))
const sq = s => s.replace(/\s+/g, '')
const stale = await page.evaluate(() => ({
  listTitle: document.querySelector('.flow-stale-list__title')?.innerText.trim() ?? '',
  listItems: [...document.querySelectorAll('.flow-stale-list__item')].map(b => b.innerText.trim()),
  bannerTitle: document.querySelector('.flow-stale-banner__title')?.innerText.trim() ?? '',
  why: document.querySelector('.flow-stale-banner__why')?.innerText.trim() ?? '',
  old: document.querySelector('.flow-stale-banner__box--old p')?.innerText ?? '',
  now: document.querySelector('.flow-stale-banner__box--new p')?.innerText ?? '',
  // 提醒要在這個模組的第一則訊息上面（⚠️「＋ 文字」那排工具列本來就在提醒上方，別拿它比）
  aboveMessages: (() => {
    const b = document.querySelector('[data-tour="flow-stale-banner"]')?.getBoundingClientRect()
    const m = document.querySelector('.fem-rail [class*="badge-"]')?.getBoundingClientRect()
    return !!b && !!m && b.bottom <= m.top
  })(),
  // 側欄窄：標題刻意斷成兩行，⛔ 不可以剩一個字掉下去
  titleLines: [...document.querySelectorAll('.flow-stale-list__title, .flow-stale-list__title span')].map(e => e.getClientRects().length),
}))
check('S1 清單最上面點名：「試算表改了／這 1 個模組還寫著舊的」兩行＋那個模組', stale.listTitle.replace(/\n/g, '／') === '試算表改了／這 1 個模組還寫著舊的' && stale.titleLines.every(n => n <= 2)
  && stale.listItems.length === 1 && stale.listItems[0] === ship.name,
  `「${stale.listTitle.replace(/\n/g, '／')}」（行 ${stale.titleLines.join('/')}）｜${stale.listItems.join('、')}`)
check('S2 模組上面一條提醒：講哪一格哪天改的、舊的跟現在的並排', stale.bannerTitle.includes('還寫著改之前的字') && stale.why.includes('「出貨時間」10/29 改了')
  && sq(stale.old) === sq(OLD_SHIP) && stale.now.includes('第二批') && stale.aboveMessages,
  `「${stale.why}」；舊「${stale.old.replace(/\n/g, ' ').slice(0, 30)}…」；新「${stale.now.replace(/\n/g, ' ').slice(0, 30)}…」；在訊息上面 ${stale.aboveMessages}`)
await page.screenshot({ path: join(SHOT_DIR, 'flow-stale-banner.png') })
const savesBeforeSync = blocked.length
await page.click('[data-tour="flow-stale-sync"]')
// 換完模組才用到試算表＝這時才去讀（短名對照晚到），等預覽畫出試算表的字再量
await waitFor(() => document.querySelector('aside.fmp')?.innerText.includes('第二批'))
await sleep(400)
/** 輸入框底下的字跟膠囊那層要一模一樣，⛔ 不然膠囊畫短名、底下還是全名，膠囊後面會多一串字 */
const fieldMatchesLayer = sel => page.evaluate((s) => {
  const field = document.querySelector(`${s} textarea`)
  const layer = document.querySelector(`${s} .var-field__layer-inner`)
  return !!field && !!layer && field.value === layer.textContent.replace(/​$/, '')
}, sel)
const synced = await page.evaluate((old) => {
  const field = document.querySelector('[data-tour="quick-prompt"] textarea')
  return {
    banner: !!document.querySelector('[data-tour="flow-stale-banner"]'),
    oldGone: !!field && !field.value.replace(/\s+/g, '').includes(old.replace(/\s+/g, '')),
    pills: [...document.querySelectorAll('[data-tour="quick-prompt"] .var-field__pill--sheet')].map(p => p.innerText.replace(/ /g, '').trim()),
    preview: document.querySelector('aside.fmp')?.innerText ?? '',
  }
}, OLD_SHIP)
const syncedAligned = await fieldMatchesLayer('[data-tour="quick-prompt"]')
check('S3 按「換成跟試算表同步」：舊字換成藍色膠囊、提醒消失、預覽畫試算表上的字', synced.oldGone && !synced.banner && synced.pills.includes('出貨時間・Giaretti 珈樂堤…')
  && synced.preview.includes('第二批') && !synced.preview.includes('{{sheet:'),
  `舊字還在 ${!synced.oldGone}、提醒還在 ${synced.banner}、膠囊 ${synced.pills.join('｜') || '（沒有）'}`)
check('S3b 試算表晚到：輸入框底下的字也換成短名，跟膠囊對得上（膠囊後面沒有多一串字）', syncedAligned, `對得上 ${syncedAligned}`)
check('S4 ⛔ 換完不自動存檔（要店家自己按儲存）', blocked.length === savesBeforeSync, blocked.slice(savesBeforeSync).join('、') || '沒有')
await page.screenshot({ path: join(SHOT_DIR, 'flow-stale-synced.png') })
fakeStale = false
await openFlowPage()

// ── G. 快速回覆在最後一則：「＋ 文字」插在它前面 ───────────────────
const badgesBefore = await page.evaluate(() => [...document.querySelectorAll('.fem-rail .card-badge, .fem-rail [class*="badge-"]')].map(b => b.innerText.trim()).filter(Boolean))
await page.evaluate(() => document.querySelector('[data-tour="fmt-text"]')?.click())
await sleep(500)
const order = await page.evaluate(() => [...document.querySelectorAll('.fem-rail [class*="badge-"]')].map(b => b.innerText.trim()).filter(Boolean))
check('G1 「＋ 文字」插在快速回覆前面，快速回覆還是最後一則', order[order.length - 1] === '快速回覆' && order.includes('文字訊息'),
  `加之前 ${badgesBefore.join('→')}／加之後 ${order.join('→')}`)

// ── F. 試算表的一格 ───────────────────────────────────────
const prompt = '[data-tour="quick-prompt"]'
// `C-428`：店家要的是「把手打的那段換成跟試算表同步」——先在輸入框選取那段舊字，再按插入
const selected = await page.evaluate((sel, old) => {
  const field = document.querySelector(`${sel} textarea`)
  const at = field?.value.indexOf(old) ?? -1
  if (!field || at < 0) return false
  field.scrollIntoView({ block: 'center' })
  field.focus()
  field.setSelectionRange(at, at + old.length)
  return true
}, prompt, OLD_SHIP)
// ⚠️ 用真的滑鼠點（pointerdown 那一刻記下選取範圍），⛔ 不用 el.click()
await page.click(`${prompt} .flow-var-inset__btn`)
await sleep(600)
const menu = await page.evaluate(() => ({
  items: [...document.querySelectorAll('.el-dropdown-menu__item')].filter(i => i.offsetParent !== null).map(i => i.innerText.trim()),
  groups: [...document.querySelectorAll('.flow-var-inset__group')].filter(i => i.offsetParent !== null).map(i => i.innerText.trim()),
}))
const glyph = await page.evaluate(sel => document.querySelector(`${sel} .flow-var-inset__btn`)?.innerText.trim() ?? '', prompt)
check('F1 按鈕叫「＋ 插入」，選單分「客人資料／試算表」兩組，有「商品資料」', glyph === '＋ 插入' && menu.groups.join('/') === '客人資料/試算表' && menu.items.some(t => t.startsWith('商品資料')),
  `按鈕「${glyph}」、組 ${menu.groups.join('/')}、項目 ${menu.items.map(t => t.split('\n')[0]).join('｜')}；選取舊字 ${selected}`)
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
const dialogText = await page.evaluate(() => ({
  labels: [...document.querySelectorAll('.flow-sheet-dialog .admin-field-label, .flow-sheet-dialog label')].filter(e => e.offsetParent !== null).map(e => e.innerText.trim()),
  hint: document.querySelector('.flow-sheet-dialog__hint')?.innerText.trim() ?? '',
}))
check('F2 挑 Giaretti／出貨時間：小視窗秀現在寫的（兩批出貨）', rowPicked && fieldPicked && value.includes('第二批') && value.includes('11 月底'),
  `挑到列 ${rowPicked}、欄 ${fieldPicked}、內容「${value.replace(/\n/g, ' ').slice(0, 80)}」`)
check('F2b 小視窗用店家的話（商品／哪一項），講明會換掉選取的那段字', dialogText.labels.join('/').includes('商品') && dialogText.labels.join('/').includes('哪一項')
  && !dialogText.labels.join('/').includes('哪一列') && dialogText.hint.includes(`（${[...OLD_SHIP].length} 字）`),
  `標籤 ${dialogText.labels.join('/')}；提示「${dialogText.hint}」`)
await page.screenshot({ path: join(SHOT_DIR, 'flow-sheet-dialog.png') })
await page.evaluate(() => [...document.querySelectorAll('.flow-sheet-dialog .el-button--primary')].find(b => b.offsetParent !== null)?.click())
await sleep(800)
const inserted = await page.evaluate((sel, old) => {
  const sheetPills = [...document.querySelectorAll(`${sel} .var-field__pill--sheet`)].map(p => p.innerText.replace(/ /g, '').trim())
  const pillRows = [...document.querySelectorAll(`${sel} .var-field__pill--sheet`)].map(p => p.getClientRects().length)
  const field = document.querySelector(`${sel} textarea`)
  // ⚠️ 只能找手機預覽本身（`.fmp`）：用 [class*="preview"] 會先撿到「隱藏預覽」那顆開關
  const preview = document.querySelector('aside.fmp')?.innerText ?? ''
  return {
    sheetPills,
    pillRows,
    oldGone: !(field?.value ?? '').includes(old),
    previewHasValue: preview.includes('第二批') && preview.includes('11 月底'),
    previewHasToken: preview.includes('{{sheet:'),
  }
}, prompt, OLD_SHIP)
check('F3 插進去是一顆藍色短名膠囊「出貨時間・Giaretti 珈樂堤…」、只佔一行', inserted.sheetPills.includes('出貨時間・Giaretti 珈樂堤…') && inserted.pillRows.every(n => n === 1),
  `${inserted.sheetPills.join('｜') || '（沒有藍色膠囊）'}；行數 ${inserted.pillRows.join('/')}`)
check('F3b 先選取的那段手打舊字被換掉了', inserted.oldGone, `舊字還在 ${!inserted.oldGone}`)
const insertedAligned = await fieldMatchesLayer(prompt)
check('F3c 輸入框底下的字跟膠囊對得上', insertedAligned, `對得上 ${insertedAligned}`)
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
check('E1 打開「試發」：標題「試發到手機看」、講明送畫面上這一份不會幫你存；收件人名單照推播試發那份', dlg.title === '試發到手機看' && dlg.hint.includes('不會幫你存') && dlg.groups.includes('常找來看稿的人'),
  `標題「${dlg.title}」、名單 ${dlg.groups.join('／')}、已勾 ${dlg.checked}`)
// `C-428`：組名跟下面那一行不可以疊在一起（Element 的勾選群組把行高設成 0，推播頁原本就疊）
const overlap = await page.evaluate(() => {
  const d = [...document.querySelectorAll('.bc-dialog-testsend')].find(x => x.offsetParent !== null)
  const titles = [...(d?.querySelectorAll('.bc-testsend-group__title') ?? [])]
  return titles.map((t) => {
    const next = t.nextElementSibling
    const a = t.getBoundingClientRect()
    const b = next?.getBoundingClientRect()
    return { name: t.innerText.trim(), lh: getComputedStyle(t).lineHeight, ok: a.height > 10 && (!b || a.bottom <= b.top + 1) }
  })
})
check('E1b 試發框組名沒有跟下一行疊在一起', overlap.length > 0 && overlap.every(o => o.ok), overlap.map(o => `${o.name}:${o.ok ? '分開' : '疊到'}（行高 ${o.lh}）`).join('、'))
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
