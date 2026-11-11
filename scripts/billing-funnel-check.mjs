/**
 * 付款漏斗埋點的實機守門員（`D-180`，2026-11-11）。
 *
 *   npm run dev -- --port 3351                                            # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3351 node --env-file=.env_myfeel scripts/billing-funnel-check.mjs
 *
 * **為什麼一定要真的開瀏覽器**：單元測試驗得到「事件名字在表上」「程式有呼叫」，
 * 驗不到「那一包真的打出去了、裡面長什麼樣」。這個專案吃過很多次
 * 「typecheck 綠＋測試綠，但新程式根本沒被執行到」（記憶 `feedback_verify_new_code_actually_runs`），
 * 而埋點壞掉的樣子正是**什麼都不會報錯，只是資料是空的**——等到要看漏斗才發現，那時第一批客人已經走完了。
 *
 * ⚠️ **連正式資料庫（myfeel），但全程零寫入**：
 *    - 只讀 `workspaceMembers` 找一個管理員換 token（唯讀）
 *    - 瀏覽器端**所有非 GET 一律攔截**：埋點那一包在這裡就被接住、印出來看，⛔ 沒有離開這台機器，
 *      Firestore 的 `onboardingEvents` 不會多出任何一筆
 *    - ⛔ 全程不碰 PAYUNi：確認框一律按「取消」，或讓建單被擋下來走失敗那條
 *
 * ⛔ **內建對照組**：每一關都先斷言「這個事件本來沒出現過」再斷言「做完之後出現」。
 *    少了前半，只要選擇器抓到別的東西，整份就是假綠燈。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL
/** ⛔ 自帶總時限：卡住的話自己收掉，不要留一個瀏覽器在那裡吃記憶體 */
const BUDGET_MS = Number(process.env.CHECK_BUDGET_MS ?? 180_000)

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
if (!admin) {
  console.error('這個工作區查不到成員')
  process.exit(1)
}
const uid = String(admin.uid ?? admin.id)
const custom = await getAuth().createCustomToken(uid)
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) {
  console.error('換 idToken 失敗：', JSON.stringify(signIn))
  process.exit(1)
}
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }
console.log(`登入身分：${session.email}（${admin.role}）\n`)

let failed = false
const fail = (msg) => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const killer = setTimeout(() => {
  console.error(`\n⏱ 超過 ${Math.round(BUDGET_MS / 1000)} 秒，自己收掉（當成紅燈）`)
  browser.close().finally(() => process.exit(1))
}, BUDGET_MS)

/** 被擋下來的寫入（＝證明零寫入），以及其中的埋點那幾包（解出來看內容） */
const blocked = []
/** 真的打出去的埋點：一筆一個事件，含 flow 與 props */
const tracked = []

const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
page.on('dialog', async d => { await d.accept().catch(() => {}) })

/**
 * 要不要把「方案與用量」假造成某個狀態。
 * ⭐ 非這樣不可：額度橫幅只在**有則數上限、而且快用完**時才出現，而手上跑得動的帳號
 *    （MYFEEL）是內部方案、永遠沒有上限 → 不假造的話 `billing_wall_seen` 這一格
 *    **永遠不會被跑到**，只能靠「程式裡有寫」自我安慰，那正是這個專案吃過很多次的假綠燈。
 * ⛔ 只假造**讀**，寫入照樣全擋。
 */
let fakePlanSummary = null

await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()
  const method = req.method()
  if (method === 'GET' || method === 'OPTIONS' || !url.includes('/api/')) {
    if (fakePlanSummary && url.includes('/api/ai/usage/plan-summary')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fakePlanSummary) })
      return
    }
    req.continue()
    return
  }
  // ⭐ 埋點那一包：解開來記下每一個事件（這就是這支守門員要看的東西）
  if (url.includes('/api/onboarding/events')) {
    try {
      const body = JSON.parse(req.postData() ?? '{}')
      for (const e of body.events ?? []) tracked.push({ flow: body.flow, event: e.event, props: e.props ?? {} })
    }
    catch { tracked.push({ flow: '?', event: '(解不開的 body)', props: {} }) }
  }
  // ⛔ 一律擋成 500 並記下來——包含埋點那一包（所以正式庫不會多出任何一筆）
  blocked.push(`${method} ${url.replace(BASE, '')}`)
  req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusMessage: '守門員擋下了這個寫入' }) })
})

await page.evaluateOnNewDocument((s) => {
  const key = `firebase:authUser:${s.apiKey}:[DEFAULT]`
  window.localStorage.setItem(key, JSON.stringify({
    uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'password', uid: s.email, email: s.email }],
    stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
    createdAt: String(Date.now()), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]',
  }))
  // ⛔ 導覽會自己彈出來蓋住畫面、還會自己點按鈕（`reference_headless_admin_harness_traps`）
  window.localStorage.setItem('minime:tour-disabled', '1')
}, session)

/** 等某個事件真的被打出去；⛔ 不要睡固定秒數——那是假綠燈的標準形狀（事件是 1.5 秒一批） */
async function waitForEvent(name, timeout = 12_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const hit = tracked.find(t => t.event === name)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}
async function waitForText(needles, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
    const hit = needles.find(n => body.includes(n))
    if (hit) return hit
    await new Promise(r => setTimeout(r, 400))
  }
  return null
}

/**
 * 導到某一頁，等它真的長出來；沒長出來就重新整理再等一次。
 * ⚠️ dev server 第一次編譯某條路由時，瀏覽器已經抓走的 entry.js 會對不上新的雜湊，
 *    整個 app 掛在「Failed to fetch dynamically imported module」——那是 dev 在換檔，
 *    不是功能壞了（重整一次就好）。⛔ 不重試的話這條每次冷啟動都紅成假的。
 */
async function gotoStable(url, needles, tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (i === 0) await page.goto(url, { waitUntil: 'domcontentloaded' })
    else await page.reload({ waitUntil: 'domcontentloaded' })
    const hit = await waitForText(needles, i === 0 ? 20_000 : 30_000)
    if (hit) return hit
    console.log(`  （第 ${i + 1} 次沒長出來，重新整理再等一次）`)
  }
  return null
}

/**
 * 設定「剛從金流回來」的記號，然後導到目標頁。
 * ⛔ **不可以用 `evaluateOnNewDocument`**：那是「之後每一次導航都跑一遍」，
 *    後面每一關都會被重新種記號，最後一關的對照組就會冤枉程式沒清乾淨（這支自己踩過）。
 *    改成先停在同網域、用 `evaluate` 設一次，再導過去（sessionStorage 同分頁同網域帶得過去）。
 */
async function seedGatewayReturn({ plan, fid }, target, needles) {
  await gotoStable(`${BASE}/admin/${WORKSPACE_ID}/settings/billing`, needles)
  await page.evaluate((p, f) => {
    window.sessionStorage.setItem('minime:billing-gateway', p)
    if (f) window.sessionStorage.setItem('minime:billing-funnel', f)
    else window.sessionStorage.removeItem('minime:billing-funnel')
  }, plan, fid ?? '')
  tracked.length = 0
  return gotoStable(target, needles)
}
const clickButton = (text, exact = true) => page.evaluate((t, ex) => {
  const b = [...document.querySelectorAll('button')].find(x => (ex ? x.textContent?.trim() === t : x.textContent?.includes(t)) && !x.disabled)
  if (!b) return false
  b.click()
  return true
}, text, exact)

// ═══ ⓪ 看到額度橫幅 ═════════════════════════════════════════════
console.log('── ⓪ 額度快用完的橫幅（假造一份「免費方案 45/50 則」的用量）──')
const freePlan = used => ({
  plan: {
    id: 'free', name: '免費', answeredQuota: 50, overagePerReply: null,
    currentPeriodStart: '2026-11-01', currentPeriodEnd: '2026-12-01',
    status: 'active', autoRenew: false, cancelAtPeriodEnd: false, hasMandate: false,
  },
  answered: used, monthBillable: null, callCeiling: null,
})
fakePlanSummary = freePlan(45) // 90%＝黃色那條
// ⛔ 橫幅掛在外殼（layout）上，任何一頁都看得到——⛔ 不要只在帳單頁試（那一頁刻意不顯示）
const wall = await gotoStable(`${BASE}/admin/${WORKSPACE_ID}/ai-usage`, ['AI 回覆本期只剩'])
if (!wall) {
  fail('假造成 45/50 則了，但額度橫幅沒有出現')
}
else {
  const seen = await waitForEvent('billing_wall_seen')
  if (!seen) fail('橫幅出現了，但沒有打出 billing_wall_seen')
  else if (seen.props.state !== 'near') fail(`state 是「${seen.props.state}」，45/50＝90% 應該是 near`)
  else if (seen.props.from !== 'quota_banner') fail(`from 是「${seen.props.from}」，應該是 quota_banner`)
  else pass(`billing_wall_seen：state=near、plan=${seen.props.plan}、from=${seen.props.from}`)

  // ⛔ 同一場只能記一次：橫幅掛在外殼上、換頁不會重新掛載，重複記會讓分母失真
  const before = tracked.filter(t => t.event === 'billing_wall_seen').length
  const wasAt = page.url()
  await page.evaluate(() => document.querySelector('a[href*="/settings/billing"]')?.click())
  await new Promise(r => setTimeout(r, 3500))
  // ⛔ 對照組：要先確定**真的換頁了**。沒換成功的話「沒有重複記」是必然的＝假綠燈。
  if (page.url() === wasAt) {
    fail(`根本沒換頁（還停在 ${wasAt.replace(BASE, '')}），這一關測不到東西`)
  }
  else {
    const after = tracked.filter(t => t.event === 'billing_wall_seen').length
    if (after > before) fail(`換頁又多記了 ${after - before} 筆「看到橫幅」（同一場應該只記一次）`)
    else pass(`換頁到 ${page.url().replace(BASE, '')} 沒有重複記（同一場只算一次）`)
  }
}
fakePlanSummary = null // 後面幾關要看真的方案
tracked.length = 0

// ═══ ① 打開方案表 ═══════════════════════════════════════════════
console.log('\n── ① 打開方案表 ──')
// ⛔ 不要等頁面標題（一進來就有）——要等真正按得下去的那顆按鈕（`B-54`① 踩過這個假紅燈）
const BILLING = `${BASE}/admin/${WORKSPACE_ID}/settings/billing`
const ENTRY_BUTTONS = ['升級 / 續訂', '查看方案']
const entry = await gotoStable(BILLING, ENTRY_BUTTONS)
if (!entry) {
  fail('帳單頁上找不到「升級 / 續訂」或「查看方案」')
}
else {
  // 對照組：還沒按之前，不該有任何付款埋點
  if (tracked.some(t => t.flow === 'billing')) fail(`對照組就髒了：還沒按就有 ${tracked.filter(t => t.flow === 'billing').map(t => t.event).join('、')}`)
  else pass('對照組：還沒按之前沒有任何付款埋點')

  await clickButton(entry)
  const open = await waitForEvent('billing_plans_open')
  if (!open) fail('按了「' + entry + '」但沒有打出 billing_plans_open')
  else if (open.flow !== 'billing') fail(`billing_plans_open 的 flow 是「${open.flow}」，應該是 billing`)
  else if (!open.props.fid) fail('billing_plans_open 沒帶 fid（漏斗串不起來）')
  else if (open.props.from !== 'billing_page') fail(`from 是「${open.props.from}」，應該是 billing_page`)
  else pass(`billing_plans_open：flow=${open.flow}、from=${open.props.from}、current=${open.props.current}、fid=${String(open.props.fid).slice(0, 8)}…`)
}

// ═══ ② 按方案 → 在確認框縮手 ═════════════════════════════════════
console.log('\n── ② 按了方案、在確認框按取消 ──')
await waitForText(['選擇方案'])
// ⛔ 方案鈕一開始是**灰的**：沒勾同意條款就按不下去（那是「不適用七日猶豫期」的法律前提，
//    見 shared/legal.ts）。跟真人一樣先勾，⛔ 不要繞過去直接呼叫 checkout()。
// ⛔ 只能點**一下**：`a?.click() ?? b.click()` 會兩個都跑（click() 回傳 undefined），
//    等於勾起來又取消，畫面看起來完全沒反應（這支自己踩過）。
const ticked = await page.evaluate(() => {
  const box = document.querySelector('.plan-upgrade-consent')
  if (!box) return 'no-box'
  const input = box.querySelector('input')
  if (input) input.click()
  else box.click()
  return box.querySelector('input')?.checked ? 'checked' : 'still-unchecked'
})
console.log(`  （同意條款：${ticked}）`)
if (ticked !== 'checked') fail(`勾不起同意條款（${ticked}）`)
await new Promise(r => setTimeout(r, 300))

// ⚠️ 表上有哪幾顆看這個帳號**現在**是什麼方案：免費看到「升級」、付費的看到「續訂／降級」、
//    內部方案（MYFEEL 就是）只看得到「降級」。⛔ 只找「升級」的話，拿內部方案的帳號跑就假紅燈。
//    「期末降級」不經過金流，是另一條路，所以排最後、而且只驗得到按下去那一格。
let picked = ''
for (const label of ['升級', '續訂', '降級', '期末降級']) {
  if (await clickButton(label)) { picked = label; break }
}
if (!picked) {
  // ⛔ 按不下去要說得出為什麼（記憶 `feedback_filters_must_report_what_they_dropped`）：
  //    灰掉的原因有三種（金流沒設定／沒勾條款／公司發票沒填完），光講「找不到按鈕」會查錯方向。
  const why = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.plan-compare-table button')]
      .map(b => `${b.textContent?.trim()}${b.disabled ? '（灰的）' : ''}`)
    return { rows, foot: document.querySelector('.plan-upgrade-foot')?.innerText?.slice(0, 200) ?? '' }
  })
  fail(`方案表上一顆按得下去的方案鈕都沒有；表上的按鈕＝${why.rows.join('、') || '（一顆都沒有）'}`)
  console.error(`   底下那段：${why.foot.replace(/\n/g, ' / ')}`)
}
else {
  console.log(`  （這個帳號表上按得到的是「${picked}」）`)
  const click = await waitForEvent('billing_plan_click')
  if (!click) fail('按了方案但沒有打出 billing_plan_click')
  else if (!click.props.plan || click.props.price == null) fail(`billing_plan_click 少了 plan／price：${JSON.stringify(click.props)}`)
  else pass(`billing_plan_click：plan=${click.props.plan}、action=${click.props.action}、price=${click.props.price}`)

  // 確認框（講價格、續扣條款、帳單名字、發票）→ 按取消＝全程不碰 PAYUNi
  const confirmed = await waitForText(['前往付款', '確認升級方案', '確認續訂方案', '確認降級方案', '確認預約降級'])
  if (!confirmed) {
    fail('沒有跳出確認框')
  }
  else if (picked === '期末降級') {
    await clickButton('取消')
    pass('期末降級不經過金流，驗到按下去那一格就夠（⛔ 這條路本來就沒有 billing_checkout）')
  }
  else {
    await clickButton('取消')
    const co = await waitForEvent('billing_checkout')
    if (!co) fail('在確認框按了取消，但沒有打出 billing_checkout')
    else if (co.props.confirmed !== false) fail(`billing_checkout 的 confirmed 是 ${co.props.confirmed}，按取消應該是 false`)
    else pass(`billing_checkout：confirmed=false（停在確認框，⛔ 沒有去 PAYUNi）`)
  }
}

// ═══ ③ 從金流回來：帶單號 ═══════════════════════════════════════
console.log('\n── ③ 從金流回來（帶單號）──')
await seedGatewayReturn({ plan: 'starter', fid: 'FID-FROM-BEFORE' }, `${BILLING}?order=NP_NOT_A_REAL_ORDER`, ENTRY_BUTTONS)
const back1 = await waitForEvent('billing_gateway_back', 20_000)
if (!back1) fail('帶著記號回到帳單頁，但沒有打出 billing_gateway_back')
else if (back1.props.fid !== 'FID-FROM-BEFORE') fail(`回來那一筆的 fid 是「${back1.props.fid}」，應該接走之前那一場的 FID-FROM-BEFORE`)
else if (back1.props.plan !== 'starter') fail(`plan 是「${back1.props.plan}」，應該是離開前記下的 starter`)
else pass(`billing_gateway_back：fid 接上了、plan=${back1.props.plan}、shown=${back1.props.shown}`)

// ═══ ④ 從金流回來：沒帶單號＝在付款頁按了返回 ════════════════════
console.log('\n── ④ 在 PAYUNi 付款頁按返回（沒帶單號）──')
await seedGatewayReturn({ plan: 'lite', fid: '' }, BILLING, ENTRY_BUTTONS)
const back2 = await waitForEvent('billing_gateway_back', 20_000)
if (!back2) fail('按返回回到帳單頁，但沒有打出 billing_gateway_back')
else if (back2.props.shown !== 'back') fail(`shown 是「${back2.props.shown}」，沒帶單號應該是 back`)
else pass(`billing_gateway_back：shown=back（他看到付款頁了然後掉頭，這格最值錢）`)

// ═══ ⑤ 對照組：記號讀完就清，不會每次打開都多一筆 ═══════════════
console.log('\n── ⑤ 對照組：正常逛到帳單頁不該記 ──')
tracked.length = 0
await gotoStable(BILLING, ENTRY_BUTTONS)
await new Promise(r => setTimeout(r, 3000)) // 事件是 1.5 秒一批，等過兩批才能說「真的沒有」
const phantom = tracked.filter(t => t.event === 'billing_gateway_back')
if (phantom.length) fail(`記號沒清乾淨：又多記了 ${phantom.length} 筆假的回訪`)
else pass('沒有假的回訪（記號讀完就清掉了）')

// ═══ 收尾 ═══════════════════════════════════════════════════════
console.log(`\n── 零寫入證據 ──\n被擋下的非 GET 共 ${blocked.length} 筆：`)
const counts = blocked.reduce((m, b) => ({ ...m, [b.split('?')[0]]: (m[b.split('?')[0]] ?? 0) + 1 }), {})
for (const [k, v] of Object.entries(counts)) console.log(`  ${v} × ${k}`)
const notEvents = Object.keys(counts).filter(k => !k.includes('/api/onboarding/events'))
if (notEvents.length) console.log(`  ⚠️ 其中不是埋點的：${notEvents.join('、')}（一樣被擋住，沒寫進去）`)

clearTimeout(killer)
await browser.close()
console.log(failed ? '\n❌ 有紅燈' : '\n✅ 全過')
process.exit(failed ? 1 : 0)
