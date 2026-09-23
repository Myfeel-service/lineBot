/**
 * 「接下來的檔期」那張卡的實機守門員（2026-09-23，`C-235`）。
 *
 *   npm run dev -- --port 3318
 *   CHECK_BASE_URL=http://localhost:3318 node --env-file=.env_myfeel scripts/marketing-calendar-check.mjs
 *
 * **為什麼要有**：這一輪加的是**模板分支**與**理由文字**，typecheck 與單元測試一條都驗不到
 * 「那句話有沒有真的畫出來」（記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * ⚠️ 連正式庫（myfeel）**唯讀**：只讀 `workspaceMembers` 換 token。
 * ⛔ 瀏覽器端所有非 GET 一律攔截擋掉；`/api/marketing-calendar` 一律假造
 *    （要用各種極端狀態驗，正式庫那一份驗不到）。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99'

const {
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_CLIENT_EMAIL: clientEmail,
  FIREBASE_PRIVATE_KEY: privateKey,
  FIREBASE_API_KEY: apiKey,
} = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
const rows = members.docs.map(d => ({ id: d.id, ...d.data() }))
const admin = rows.find(r => r.role === 'owner' || r.role === 'admin') ?? rows[0]
if (!admin) { console.error('這個工作區查不到成員'); process.exit(1) }
const uid = String(admin.uid ?? admin.id)

const custom = await getAuth().createCustomToken(uid)
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }
console.log(`登入身分：${session.email}（${admin.role}）`)

let failed = false
const fail = msg => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const blocked = []

async function openPage(fakeReads) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1200 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  page.on('dialog', async d => { await d.accept().catch(() => {}) })
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    const method = req.method()
    if (method === 'GET' || method === 'OPTIONS' || !url.includes('/api/')) {
      const fake = method === 'GET' ? fakeReads?.(url) : null
      if (fake) { req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }); return }
      req.continue()
      return
    }
    blocked.push(`${method} ${url}`)
    req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusMessage: '守門員擋下了這個寫入' }) })
  })
  await page.evaluateOnNewDocument((s) => {
    const key = `firebase:authUser:${s.apiKey}:[DEFAULT]`
    try {
      window.localStorage.setItem(key, JSON.stringify({
        uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
        providerData: [{ providerId: 'password', uid: s.email, email: s.email }],
        stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
        createdAt: String(Date.now()), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]',
      }))
      window.localStorage.setItem('minime:tour-disabled', '1')
    }
    catch { /* 無痕視窗 */ }
  }, session)
  return { ctx, page }
}

async function waitForText(page, needles, timeout = 45_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await page.evaluate(() => document.body?.innerText ?? '')
    const hit = needles.find(n => body.includes(n))
    if (hit) return { hit, body }
    await new Promise(r => setTimeout(r, 400))
  }
  return { hit: null, body: await page.evaluate(() => document.body?.innerText ?? '') }
}

function calendar(over = {}) {
  return {
    today: '2026-09-23',
    ready: true,
    hasProducts: true,
    headline: '接下來 90 天有 3 檔值得做',
    entries: [{
      festivalId: 'midautumn-2026',
      date: '2026-09-25',
      name: '中秋節',
      inDays: 2,
      soon: true,
      generalAngle: '禮盒與送禮的需求會明顯升溫',
      reasons: [{
        text: '你有 12 位客人貼著「在看咖啡機」——他們在對話裡表現出想要「咖啡機」，這一檔可以直接發給他們',
        source: '標籤管理的實際人數',
      }],
      actions: ['最後確認推播排了沒、庫存和出貨來不來得及'],
    }],
    outcomes: [],
    outcomeHeadline: '',
    outcomeIntegrity: { truncated: false, failed: false },
    skippedFestivalIds: [],
    ...over,
  }
}

/** 多加一檔，才驗得到「收一檔、另一檔還在」 */
function twoEntries() {
  const base = calendar()
  return {
    ...base,
    entries: [base.entries[0], {
      ...base.entries[0],
      festivalId: 'nationalday-2026',
      date: '2026-10-10',
      name: '國慶日',
      inDays: 17,
      soon: false,
    }],
  }
}

/** `C-55`② 的回顧。`linked` 決定話講得多肯定。 */
function outcome(linked) {
  return {
    festivalId: 'ghost-2026',
    name: '中元節',
    date: '2026-08-27',
    broadcasts: [],
    sentTotal: 3025,
    clickTotal: 532,
    clicksPer100: 17.6,
    linked,
    text: linked
      ? '「中元節」發了 8 則推播，送到 3025 人，連結被點了 532 次（每 100 人收到被點 17.6 次）。'
      : '「中元節」前後兩週你發了 8 則推播，送到 3025 人，連結被點了 532 次（每 100 人收到被點 17.6 次）。'
        + '⚠️ 這幾則不一定是為了這一檔發的——是照日期抓的。以後用「為這一檔擬推播」建立的，才對得起來。',
  }
}

const reply = body => url => (url.includes('/api/marketing-calendar') ? body : null)
const PAGE = `${BASE}/admin/${WORKSPACE_ID}/conversation-stats`

// ── 關 1：主打商品空的 → 要跳出來講，而且指得出路 ──────────────
{
  const { ctx, page } = await openPage(reply(calendar({ hasProducts: false })))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['補上「主打商品」'])
  if (!r.hit) fail(`關 1：主打商品空的卻一聲不吭。畫面上是：${r.body.slice(0, 200)}`)
  else if (!r.body.includes('去補主打商品')) fail('關 1：講了但沒有出口，那就是死路')
  else pass('關 1：主打商品空的會講出來，而且有出口')
  await ctx.close()
}

// ── 關 2 對照組：有商品時**不可以**跳這句（否則是在指責他沒做的事）──
{
  const { ctx, page } = await openPage(reply(calendar({ hasProducts: true })))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['接下來的檔期', '中秋節'])
  if (!r.hit) fail(`關 2：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else if (r.body.includes('補上「主打商品」')) fail('關 2 對照組：有商品卻還在叫他補——那句話等於永遠都在')
  else pass('關 2：有商品時不出現那句（對照組成立）')
  await ctx.close()
}

// ── 關 3：理由帶得出「憑什麼」（`C-235` 的 why）─────────────────
{
  const { ctx, page } = await openPage(reply(calendar()))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['在看咖啡機'])
  if (!r.hit) fail(`關 3：理由沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else if (!r.body.includes('表現出想要')) fail('關 3：只講了人數沒講憑什麼——那句會被讀成「12 個人想買」')
  else pass('關 3：理由講得出憑什麼')
  await ctx.close()
}

// ── 關 4：還不認識這家店時，講的是另一句（⛔ 兩句不可以同時出現）──
{
  const { ctx, page } = await openPage(reply(calendar({ ready: false, hasProducts: false })))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['MiniMe 還不認識你的店'])
  if (!r.hit) fail(`關 4：不認識時沒講。畫面上是：${r.body.slice(0, 200)}`)
  else if (r.body.includes('補上「主打商品」')) fail('關 4：兩句同時出現了——還不認識的人不該被叫去補其中一格')
  else pass('關 4：還不認識時只講「不認識」，不疊第二句')
  await ctx.close()
}

// ── 關 5：回顧畫得出來，而且口徑那句在（`C-55`②）──────────────
{
  const { ctx, page } = await openPage(reply(calendar({
    outcomes: [outcome(false)],
    outcomeHeadline: '最近 1 檔前後你發過什麼',
  })))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['最近 1 檔前後你發過什麼'])
  if (!r.hit) fail(`關 5：回顧沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const want = [
      ['回顧內容', '送到 3025 人'],
      // ⭐ 口徑紅線：次數不是人數，這句一定要在畫面上
      ['次數不是人數', '數的是次數不是人數'],
      // ⭐ 沒有綁定時的警語
      ['照日期抓的警語', '照日期抓的'],
    ]
    const missing = want.filter(([, t]) => !r.body.includes(t))
    if (missing.length) fail(`關 5：少了 ${missing.map(([k]) => k).join('、')}`)
    else pass('關 5：回顧畫得出來，口徑與「照日期抓的」警語都在')
  }
  await ctx.close()
}

// ── 關 6 對照組：沒有回顧時整段不出現（⛔ 不要留一個空殼）──────
{
  const { ctx, page } = await openPage(reply(calendar()))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['中秋節'])
  if (!r.hit) fail(`關 6：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else if (r.body.includes('數的是次數不是人數')) fail('關 6 對照組：沒有回顧卻還畫了回顧區')
  else pass('關 6：沒有回顧時整段不出現（對照組成立）')
  await ctx.close()
}

// ── 關 7：真的綁在那一檔上時，⛔ 不可以再掛「不一定是為了這一檔」──
{
  const { ctx, page } = await openPage(reply(calendar({
    outcomes: [outcome(true)],
    outcomeHeadline: '最近 1 檔的結果',
  })))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['最近 1 檔的結果'])
  if (!r.hit) fail(`關 7：綁定版的回顧沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else if (r.body.includes('照日期抓的')) fail('關 7：明明對得上，卻還在說「照日期抓的」——那會讓人白白不信任準的數字')
  else pass('關 7：綁定版講得肯定，不掛多餘警語')
  await ctx.close()
}

// ── 關 8：收起來的那一檔要從清單消失，但**要看得見、能還原**（`C-236`）──
{
  const two = twoEntries()
  const { ctx, page } = await openPage(reply({ ...two, skippedFestivalIds: ['nationalday-2026'] }))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['你收起了'])
  if (!r.hit) fail(`關 8：收起來的那一檔一聲不吭。畫面上是：${r.body.slice(0, 200)}`)
  else if (!r.body.includes('還原「國慶日」')) fail('關 8：收起來了卻還原不回來——那就是靜靜消失')
  else if (!r.body.includes('中秋節')) fail('關 8：收一檔卻把別檔也收掉了')
  else pass('關 8：收起來的看得見、還原得回來，其他檔不受影響')
  await ctx.close()
}

// ── 關 9 對照組：一檔都沒收時，那一列⛔不可以出現 ─────────────
{
  const { ctx, page } = await openPage(reply(twoEntries()))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['中秋節'])
  if (!r.hit) fail(`關 9：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else if (r.body.includes('你收起了')) fail('關 9 對照組：一檔都沒收卻還畫了「你收起了」那一列')
  else if (!r.body.includes('這次不做')) fail('關 9：每一檔都該有「這次不做」可以按')
  else pass('關 9：沒收東西時那一列不出現（對照組成立）')
  await ctx.close()
}

// ── 關 10：全部收光時要講「是你自己收的」，⛔ 不可以只剩一張空白卡 ──
{
  const two = twoEntries()
  const { ctx, page } = await openPage(reply({
    ...two,
    skippedFestivalIds: ['midautumn-2026', 'nationalday-2026'],
  }))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['都收起來了'])
  if (!r.hit) fail(`關 10：全收光卻只剩空白。畫面上是：${r.body.slice(0, 200)}`)
  else if (!r.body.includes('還原')) fail('關 10：全收光了卻沒有還原的出口＝死路')
  else pass('關 10：全部收光時講得出「是你自己收的」並給出口')
  await ctx.close()
}

console.log('')
console.log(`被擋下的寫入請求：${blocked.length} 筆${blocked.length ? `（${[...new Set(blocked)].join('、')}）` : '＝全程沒有任何寫入送出去'}`)
await browser.close()
if (failed) { console.error('\n有關卡沒過'); process.exit(1) }
console.log('\n全部通過')
