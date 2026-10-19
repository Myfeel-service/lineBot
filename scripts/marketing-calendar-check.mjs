/**
 * 「接下來的檔期」那張卡的實機守門員（2026-09-23，`C-235`）。
 *
 *   npm run dev -- --port 3318
 *   CHECK_BASE_URL=http://localhost:3318 node --env-file=.env_myfeel scripts/marketing-calendar-check.mjs
 *   # 不碰正式庫（2026-10-19 `D-122` 加）：假登入＋全部 /api 在瀏覽器攔下，不用任何 .env
 *   CHECK_FAKE_LOGIN=1 CHECK_BASE_URL=http://localhost:3318 node scripts/marketing-calendar-check.mjs
 *
 * **為什麼要有**：這一輪加的是**模板分支**與**理由文字**，typecheck 與單元測試一條都驗不到
 * 「那句話有沒有真的畫出來」（記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * ⚠️ 連正式庫（myfeel）**唯讀**：只讀 `workspaceMembers` 換 token。`CHECK_FAKE_LOGIN=1` 連這個都不做。
 * ⛔ 瀏覽器端所有非 GET 一律攔截擋掉；`/api/marketing-calendar` 一律假造
 *    （要用各種極端狀態驗，正式庫那一份驗不到）。
 */
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const FAKE_LOGIN = process.env.CHECK_FAKE_LOGIN === '1'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? (FAKE_LOGIN ? 'w-check' : '212405d2-d782-443b-9670-adac3b3e1f99')

/** 真登入：用 .env_myfeel 的服務帳號換一顆 token（唯讀） */
async function realSession() {
  const { cert, initializeApp } = await import('firebase-admin/app')
  const { getAuth } = await import('firebase-admin/auth')
  const { getFirestore } = await import('firebase-admin/firestore')
  const {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: clientEmail,
    FIREBASE_PRIVATE_KEY: privateKey,
    FIREBASE_API_KEY: apiKey,
  } = process.env
  if (!projectId || !clientEmail || !privateKey || !apiKey) {
    console.error('缺環境變數（要 --env-file=.env_myfeel；不想碰正式庫就用 CHECK_FAKE_LOGIN=1）')
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
  console.log(`登入身分：${(await getAuth().getUser(uid)).email ?? ''}（${admin.role}）`)
  return { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }
}

/** 假登入的 token：SDK 只解 payload 不驗簽（記憶 reference_role_simulation_harness） */
function fakeJwt() {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: 'https://securetoken.google.com/fake', aud: 'fake', sub: 'uid-check', user_id: 'uid-check',
    email: 'check@example.com', email_verified: true, auth_time: now, iat: now, exp: now + 3600,
    firebase: { sign_in_provider: 'google.com' },
  })}.fake-signature`
}
const FAKE_WORKSPACES = {
  workspaces: [{ workspaceId: WORKSPACE_ID, name: '守門員', role: 'owner', organizationId: 'o-check', organizationName: '守門員', plan: { id: 'internal', name: '內部／測試' } }],
  orgAdminOf: [],
}

const session = FAKE_LOGIN ? null : await realSession()
if (FAKE_LOGIN) console.log('假登入（不碰正式庫）')

let failed = false
const fail = msg => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const blocked = []

async function openPage(fakeReads) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  // 要驗窄版（卡片 < 520px 時切角掉到第二行）：CHECK_VIEWPORT_W=760
  await page.setViewport({ width: Number(process.env.CHECK_VIEWPORT_W) || 1440, height: 1200 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  page.on('dialog', async d => { await d.accept().catch(() => {}) })
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    const method = req.method()
    if (FAKE_LOGIN && /identitytoolkit|securetoken|firestore\.googleapis|firebaseinstallations/.test(url)) { req.abort('failed'); return }
    if (method === 'GET' || method === 'OPTIONS' || !url.includes('/api/')) {
      const fake = method === 'GET' ? fakeReads?.(url) : null
      if (fake) { req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }); return }
      // 假登入：伺服器那邊沒有這個人，其餘的 /api 一律在瀏覽器回空的（⛔ 不讓它打到我們的伺服器）
      if (FAKE_LOGIN && url.startsWith(BASE) && url.includes('/api/')) {
        const body = url.includes('/api/admin/workspaces/my') ? FAKE_WORKSPACES : {}
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        return
      }
      req.continue()
      return
    }
    blocked.push(`${method} ${url}`)
    req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusMessage: '守門員擋下了這個寫入' }) })
  })
  if (FAKE_LOGIN) {
    // ⚠️ 儲存鍵裡的 apiKey 必須是這個 app 自己在用的那一把（從 /login 頁原始碼抓），照 entry-pages-check 的做法寫 IndexedDB
    await page.evaluateOnNewDocument(() => {
      try { window.localStorage.setItem('minime:tour-disabled', '1') }
      catch { /* 無痕視窗 */ }
    })
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 120_000 })
    const key = (await page.content()).match(/AIza[\w-]{20,}/)?.[0]
    if (!key) { console.error('讀不到 firebaseApiKey'); process.exit(1) }
    await page.evaluate(async ({ apiKey, idToken }) => {
      const user = {
        uid: 'uid-check', email: 'check@example.com', emailVerified: true, isAnonymous: false, providerData: [],
        stsTokenManager: { refreshToken: 'r', accessToken: idToken, expirationTime: Date.now() + 3600_000 },
        createdAt: '0', lastLoginAt: '0', apiKey, appName: '[DEFAULT]',
      }
      await new Promise((res, rej) => {
        const r = indexedDB.open('firebaseLocalStorageDb', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
        r.onsuccess = () => {
          const tx = r.result.transaction('firebaseLocalStorage', 'readwrite')
          tx.objectStore('firebaseLocalStorage').put({ fbase_key: `firebase:authUser:${apiKey}:[DEFAULT]`, value: user })
          tx.oncomplete = res
          tx.onerror = () => rej(tx.error)
        }
        r.onerror = () => rej(r.error)
      })
    }, { apiKey: key, idToken: fakeJwt() })
    return { ctx, page }
  }
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
      planned: [],
    }],
    outcomes: [],
    outcomeLabel: '',
    outcomeLines: [],
    outcomeIntegrity: { truncated: false, failed: false },
    skippedFestivalIds: [],
    ...over,
  }
}

/**
 * `D-121`：照 2026-10-11 截圖那一刻的 MYFEEL 畫出來的樣子（還不認識這家店、5 檔、最近 3 檔都沒有為節日發推播）。
 * 字數、對齊、「只講一次」都拿這一份量。
 */
function myfeelToday(over = {}) {
  const e = (festivalId, date, name, inDays, generalAngle, extra = {}) => ({
    festivalId, date, name, inDays, soon: inDays <= 14, generalAngle, reasons: [], actions: [], planned: [], ...extra,
  })
  return calendar({
    ready: false,
    hasProducts: false,
    headline: '未來 90 天',
    entries: [
      e('doubleninth-2026', '2026-10-18', '重陽節', 7, '敬老送禮與長輩用的東西會被找'),
      e('halloween-2026', '2026-10-31', '萬聖節', 20, '應景裝飾、變裝與打卡活動最容易帶氣氛'),
      e('double11-2026', '2026-11-11', '雙 11 購物節', 31, '全年最大的線上折扣檔期，客人會比價比得特別兇'),
      e('christmas-2026', '2026-12-25', '聖誕節', 75, '交換禮物與聚餐的檔期，送禮客群最捨得花'),
      e('newyear-2027', '2027-01-01', '元旦（跨年）', 82, '跨年聚會與「新年新目標」的話題最好切入'),
    ],
    outcomeLabel: '最近 3 檔',
    outcomeLines: [{ before: '', after: '中元節、中秋節、國慶日都沒有為節日發的推播。從這裡擬的推播，發完會在這裡看到幾個人打開、幾個人點。' }],
    ...over,
  })
}

/** 讀卡片的文字（⛔ 不讀整頁：首頁別的卡也有字） */
const cardText = page => page.evaluate(() => document.querySelector('.mkt-cal')?.innerText ?? '')

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

/** `D-121` 的回顧：為節日發的那一則，一行、名字是連結、LINE 的人數 */
const SENT_LINE = {
  before: '國慶日',
  broadcast: { id: 'bc-national', name: '國慶連假早鳥' },
  after: '送 2,140 人，612 人打開，198 人點連結（LINE 官方統計）',
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

// ── 關 5：為節日發過推播時，最下面一行講 LINE 的人數，名字點得進那一則（`D-121`②）──
{
  const { ctx, page } = await openPage(reply(calendar({ outcomeLabel: '上一檔', outcomeLines: [SENT_LINE] })))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['612 人打開'])
  if (!r.hit) fail(`關 5：回顧沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const t = await cardText(page)
    const link = await page.evaluate(() => [...document.querySelectorAll('.mkt-cal__past .mkt-cal__link')].map(b => b.textContent))
    if (!t.includes('上一檔') || !t.includes('198 人點連結')) fail('關 5：標題或點連結的人數沒畫出來')
    else if (link.join() !== '國慶連假早鳥') fail(`關 5：推播名字不是連結（量到 ${JSON.stringify(link)}）`)
    // ⛔ 舊版那段「次數不是人數」口徑說明已經不需要（LINE 給的就是人數），長回來就是重複
    else if (/次數不是人數|照日期抓|沒有放連結/.test(t)) fail('關 5：舊版的警語又長回來了')
    else pass('關 5：回顧是 LINE 的人數、一行、名字點得進那一則，舊警語都沒了')
  }
  await ctx.close()
}

// ── 關 6 對照組：回看窗內沒有過去的節日時整段不出現（⛔ 不要留一個空殼）──
{
  const { ctx, page } = await openPage(reply(calendar()))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['中秋節'])
  if (!r.hit) fail(`關 6：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else if (await page.$('.mkt-cal__past')) fail('關 6 對照組：沒有回顧卻還畫了回顧那一行')
  else pass('關 6：沒有回顧時整段不出現（對照組成立）')
  await ctx.close()
}

// ── 關 7：今天的 MYFEEL——「還不認識你的店」只講一次、回顧一行講完、整張卡字數鎖住（`D-121`）──
{
  const { ctx, page } = await openPage(reply(myfeelToday()))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['都沒有為節日發的推播'])
  if (!r.hit) fail(`關 7：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const t = await cardText(page)
    const count = (re) => (t.match(re) ?? []).length
    const chars = [...t.replace(/\s/g, '')].length
    // ⭐ 回歸鎖釘在量出來的現值（改版前約 1,030 字）。⛔ 不要為了保險放寬——留了空間下次就會被填滿
    // 2026-10-19 `D-122`②：272 → 279，多的 7 個字就是「＋ 加自己的檔期」那一行（示意頁 v2 那張就有），其他一字沒加
    const CHAR_CAP = 279
    if (count(/還不認識你的店/g) !== 1) fail(`關 7：「還不認識你的店」講了 ${count(/還不認識你的店/g)} 次，要剛好一次`)
    else if (count(/通用/g) > 1) fail(`關 7：「通用」出現 ${count(/通用/g)} 次（改版前是 7 次）`)
    else if (!t.includes('最近 3 檔')) fail('關 7：回顧那一行的標題不見了')
    else if (chars > CHAR_CAP) fail(`關 7：整張卡 ${chars} 字，超過鎖住的 ${CHAR_CAP} 字——又長回來了`)
    else pass(`關 7：只講一次、回顧一行講完，整張卡 ${chars} 字（鎖 ${CHAR_CAP}）`)
    // 要看樣子時：SHOT_DIR=<資料夾> 會把這張卡截下來（跟示意頁並排比）
    if (process.env.SHOT_DIR) await (await page.$('.mkt-cal'))?.screenshot({ path: `${process.env.SHOT_DIR}/mkt-cal-today.png` })
  }
  await ctx.close()
}

// ── 關 11：最近那一檔攤開、其他一行一檔；點別的一檔就換它攤開（`D-121`）──
{
  const { ctx, page } = await openPage(reply(myfeelToday()))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['萬聖節'])
  const openState = () => page.evaluate(() => [...document.querySelectorAll('.mkt-cal__row')].map(el => el.classList.contains('is-open')))
  if (!r.hit) fail(`關 11：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const before = await openState()
    if (JSON.stringify(before) !== JSON.stringify([true, false, false, false, false])) fail(`關 11：預設應該只有第一檔攤開，量到 ${JSON.stringify(before)}`)
    else {
      await page.evaluate(() => document.querySelectorAll('.mkt-cal__row-head')[1]?.click())
      await new Promise(r2 => setTimeout(r2, 300))
      const after = await openState()
      const btn = await page.evaluate(() => document.querySelectorAll('.mkt-cal__row')[1]?.innerText.includes('為這一檔擬推播'))
      if (JSON.stringify(after) !== JSON.stringify([false, true, false, false, false])) fail(`關 11：點第二檔後量到 ${JSON.stringify(after)}`)
      else if (!btn) fail('關 11：攤開的那一檔沒有「為這一檔擬推播」')
      else pass('關 11：最近那一檔攤開；點第二檔就換它攤開、按鈕跟著它')
    }
  }
  await ctx.close()
}

// ── 關 12：對齊——攤開的那一列跟其他列，日期、節日名都切在同一條線（`D-121`）──
{
  const { ctx, page } = await openPage(reply(myfeelToday()))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['萬聖節'])
  if (!r.hit) fail(`關 12：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const xs = await page.evaluate(() => ({
      when: [...document.querySelectorAll('.mkt-cal__when')].map(el => Math.round(el.getBoundingClientRect().left)),
      name: [...document.querySelectorAll('.mkt-cal__name')].map(el => Math.round(el.getBoundingClientRect().left)),
      body: Math.round(document.querySelector('.mkt-cal__angle-full')?.getBoundingClientRect().left ?? -1),
    }))
    const one = arr => new Set(arr).size === 1
    if (!one(xs.when)) fail(`關 12：日期沒對齊 ${JSON.stringify(xs.when)}`)
    else if (!one(xs.name)) fail(`關 12：節日名沒對齊 ${JSON.stringify(xs.name)}`)
    else if (xs.body !== xs.name[0]) fail(`關 12：攤開的內容沒跟節日名對齊（內容 ${xs.body}、名字 ${xs.name[0]}）`)
    else pass(`關 12：日期 x=${xs.when[0]}、節日名 x=${xs.name[0]}，所有列同一條線；攤開的內容跟名字對齊`)
  }
  await ctx.close()
}

// ── 關 13：已經為這一檔排好推播——收起來那列講排在哪天；攤開只給「查看推播」，⛔ 不給再擬一份 ──
{
  const sched = Date.UTC(2026, 10, 9, 12) // 台灣 11/09 20:00
  const data = myfeelToday()
  data.entries[0].planned = [{ id: 'bc-ninth', name: '重陽敬老早鳥', status: 'scheduled', atMs: sched }]
  data.entries[2].planned = [{ id: 'bc-d11', name: '雙 11 早鳥', status: 'scheduled', atMs: sched }]
  const { ctx, page } = await openPage(reply(data))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['雙 11 早鳥'])
  if (!r.hit) fail(`關 13：已排程那一檔沒講出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const rows = await page.evaluate(() => [...document.querySelectorAll('.mkt-cal__row')].map(el => el.innerText))
    if (!rows[2]?.includes('✓ 已排程 11/09 20:00')) fail(`關 13：收起來那列沒講排在哪天：${rows[2]}`)
    else if (!rows[0]?.includes('查看推播')) fail('關 13：攤開的那一檔排好了卻沒有「查看推播」')
    else if (rows[0]?.includes('為這一檔擬推播') || rows[0]?.includes('這次不做')) fail('關 13：排好了還給「為這一檔擬推播／這次不做」——會擬出第二份')
    else pass('關 13：排好的那一檔講得出排在哪天、只給「查看推播」')
    if (process.env.SHOT_DIR) await (await page.$('.mkt-cal'))?.screenshot({ path: `${process.env.SHOT_DIR}/mkt-cal-planned.png` })
  }
  await ctx.close()
}

// ── 關 14：店家自己的檔期（`D-122`②，示意頁 v2 最下面那張）──
// 列上標「自己的」、沒推播講「還沒有推播」；攤開給「修改／刪除」，⛔ 不給「這次不做」；
// 「＋ 加自己的檔期」跟每一列的日期切在同一條線
{
  const data = myfeelToday({ ready: true, hasProducts: true })
  data.entries.splice(1, 0, {
    festivalId: 'own-anniv-check-0001', date: '2026-10-24', name: '週年慶', inDays: 13, soon: true, generalAngle: '',
    reasons: [], actions: [], own: true, planned: [{ id: 'bc-anniv', name: '週年慶早鳥', status: 'draft', atMs: null }],
  })
  data.entries.push({
    festivalId: 'own-launch-check-0001', date: '2026-11-20', name: '新品開賣', inDays: 40, soon: false, generalAngle: '',
    reasons: [], actions: [], own: true, planned: [],
  })
  const { ctx, page } = await openPage(reply(data))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['新品開賣'])
  if (!r.hit) fail(`關 14：卡片沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const rows = await page.evaluate(() => [...document.querySelectorAll('.mkt-cal__row')].map(el => el.innerText.replace(/\s+/g, ' ')))
    const xs = await page.evaluate(() => ({
      when: Math.round(document.querySelector('.mkt-cal__when')?.getBoundingClientRect().left ?? -1),
      add: Math.round(document.querySelector('.mkt-cal__add-own .el-link')?.getBoundingClientRect().left ?? -2),
    }))
    const ownRows = rows.filter(t => t.includes('自己的'))
    if (ownRows.length !== 2) fail(`關 14：「自己的」應該剛好兩列，量到 ${ownRows.length}：${JSON.stringify(rows)}`)
    else if (!rows[1]?.includes('草稿，還沒排程') || !rows[1]?.includes('「週年慶早鳥」')) fail(`關 14：週年慶那列沒講草稿：${rows[1]}`)
    else if (!rows.at(-1)?.includes('還沒有推播')) fail(`關 14：新品開賣那列沒講「還沒有推播」：${rows.at(-1)}`)
    else if (xs.add !== xs.when) fail(`關 14：「＋ 加自己的檔期」沒跟日期切齊（加 ${xs.add}、日期 ${xs.when}）`)
    else {
      await page.evaluate(() => document.querySelectorAll('.mkt-cal__row-head')[1]?.click())
      await new Promise(r2 => setTimeout(r2, 300))
      const open = await page.evaluate(() => document.querySelectorAll('.mkt-cal__row')[1]?.innerText ?? '')
      if (!open.includes('修改') || !open.includes('刪除')) fail(`關 14：攤開自己的那一檔沒有「修改／刪除」：${open}`)
      else if (open.includes('這次不做')) fail('關 14：自己的檔期不該有「這次不做」（那是給節日表、明年會回來的）')
      else pass('關 14：自己的檔期標得出來、講得出推播狀態、攤開給修改／刪除，「＋ 加自己的檔期」跟日期對齊')
    }
    if (process.env.SHOT_DIR) await (await page.$('.mkt-cal'))?.screenshot({ path: `${process.env.SHOT_DIR}/mkt-cal-own.png` })
  }
  await ctx.close()
}

// ── 關 15：未來 90 天一檔都沒有時，「＋ 加自己的檔期」照樣在（⛔ 空卡不可以是死路）──
{
  const { ctx, page } = await openPage(reply(calendar({ entries: [] })))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['未來 90 天沒有重要節日'])
  if (!r.hit) fail(`關 15：空卡沒畫出來。畫面上是：${r.body.slice(0, 200)}`)
  else if (!(await cardText(page)).includes('＋ 加自己的檔期')) fail('關 15：空卡沒有「＋ 加自己的檔期」')
  else pass('關 15：空卡也加得了自己的檔期')
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
