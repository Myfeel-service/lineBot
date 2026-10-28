/**
 * 「好友統計」頁的實機守門員（2026-09-23 `D-28`＋`D-63` 起家；2026-10-28 `D-155` 改版重寫）。
 *
 *   npm run dev -- --port 3318                                         # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3318 node --env-file=.env_myfeel scripts/friend-stats-check.mjs
 *
 * **為什麼一定要真的開瀏覽器**：純函式的測試驗得到「規則算出什麼」，驗不到
 * 「那幾區有沒有真的畫出來」「提案擬文案 → 開推播草稿 → 存檔時有沒有帶著提案來歷」這條跨兩頁的路。
 * 這個專案吃過很多次「typecheck 綠＋測試綠，但新程式根本沒被執行到」（記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * ⚠️ **連正式資料庫（myfeel），但全程零寫入**：
 *    - 只讀 `workspaceMembers` 找一個管理員換 token、讀一顆真標籤（唯讀）
 *    - 瀏覽器端**所有非 GET 一律攔截**：沒被指名的擋成 500 並記下來；
 *      指名要假造的（產生報告、擬文案、建推播草稿）在瀏覽器這端就回應，⛔ 請求沒有離開這台機器
 *    - `GET /api/tag/report` 一律**假造**：這頁要用各種資料驗（有提案／沒提案、讀不到 LINE、舊版報告…）
 *
 * ⛔ **內建對照組**：每一關都先斷言「這個東西本來不在」再斷言「做完之後在」。
 *    少了前半，選擇器只要寫成一個到處都在的東西，整份就是假綠燈。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

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

/**
 * 「發推播」與提案都要一顆**真的存在**的標籤（唯讀撈一顆啟用中的）。
 * ⛔ 用假 id 的話只驗得到「對不上時有沒有講出來」，「受眾真的被選好」那條主線沒被跑到。
 */
const tagSnap = await db.collection('tags').where('workspaceId', '==', WORKSPACE_ID).where('status', '==', 'active').limit(1).get()
const realTag = tagSnap.empty ? null : { id: tagSnap.docs[0].id, name: String(tagSnap.docs[0].data().name ?? '') }
console.log(realTag ? `會用真標籤：${realTag.name}` : '⚠️ 這個工作區沒有標籤，發推播那關只驗得到「對不上」那條分支')

/** 觀察者那關：拿真的帳號清單（唯讀）只改角色——⛔ 不整份手刻 */
function asViewer(node) {
  if (Array.isArray(node)) return node.map(asViewer)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = asViewer(v)
    if (out.workspaceId === WORKSPACE_ID && 'role' in out) out.role = 'viewer'
    return out
  }
  return node
}
const myRes = await fetch(`${BASE}/api/admin/workspaces/my`, { headers: { authorization: `Bearer ${signIn.idToken}` } })
const viewerList = myRes.ok ? asViewer(await myRes.json()) : null
if (!viewerList) console.log(`⚠️ 讀不到帳號清單（HTTP ${myRes.status}），觀察者那關會直接記紅燈`)

let failed = false
const fail = msg => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const blocked = []
/** 假造回應的寫入（瀏覽器以為送出去了，其實在這裡就被接住）——跟 blocked 分開記 */
const faked = []

async function openLoggedInPage({ fakeReads, fakeWrites } = {}) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  // ⛔ 原生 confirm 會把 JS 執行緒卡死到 puppeteer 逾時（看起來像頁面壞了）
  page.on('dialog', async d => { await d.accept().catch(() => {}) })

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    const method = req.method()
    if (method === 'GET' || method === 'OPTIONS' || !url.includes('/api/')) {
      const fake = method === 'GET' ? fakeReads?.(url) : null
      if (fake) {
        req.respond({ status: fake.status ?? 200, contentType: 'application/json', body: JSON.stringify(fake.body ?? {}) })
        return
      }
      req.continue()
      return
    }
    // 指名要假造的寫入：在瀏覽器這一端就回應，⛔ 請求從頭到尾沒有離開這台機器
    const fakeW = fakeWrites?.(url, method, req.postData() ?? '')
    if (fakeW) {
      faked.push(`${method} ${url.replace(BASE, '')}`)
      const reply = () => req.respond({ status: fakeW.status ?? 200, contentType: 'application/json', body: JSON.stringify(fakeW.body ?? {}) })
      if (fakeW.delayMs) setTimeout(reply, fakeW.delayMs)
      else reply()
      return
    }
    // ⛔ 沒被指名的寫入一律擋成 500，而且記下來跑完印出證據
    blocked.push(`${method} ${url.replace(BASE, '')}`)
    req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusMessage: '守門員擋下了這個寫入' }) })
  })

  // 假造 Firebase 登入：把 SDK 會讀的那份記錄先塞好
  await page.evaluateOnNewDocument((s) => {
    const key = `firebase:authUser:${s.apiKey}:[DEFAULT]`
    const val = JSON.stringify({
      uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
      providerData: [{ providerId: 'password', uid: s.email, email: s.email }],
      stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
      createdAt: String(Date.now()), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]',
    })
    try { window.localStorage.setItem(key, val) } catch { /* 無痕視窗 */ }
    // ⛔ 導覽會自動彈出來蓋住畫面、還會自己點按鈕（`reference_headless_admin_harness_traps`）
    try { window.localStorage.setItem('minime:tour-disabled', '1') } catch { /* noop */ }
  }, session)

  return { ctx, page }
}

/** 等到頁面上出現任一條件；⛔ 不要「睡固定秒數再量一次」——那是假綠燈的標準形狀 */
async function waitForText(page, needles, timeout = 25_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await page.evaluate(() => document.body?.innerText ?? '')
    const hit = needles.find(n => body.includes(n))
    if (hit) return { hit, body }
    await new Promise(r => setTimeout(r, 400))
  }
  const body = await page.evaluate(() => document.body?.innerText ?? '')
  return { hit: null, body }
}

/** 按第一顆字面等於（或包含）這段字的按鈕 */
function clickButton(page, text, { exact = true } = {}) {
  return page.evaluate((t, ex) => {
    const b = [...document.querySelectorAll('button')].find(x => (ex ? x.textContent?.trim() === t : x.textContent?.includes(t)) && !x.disabled)
    if (!b) return false
    b.click()
    return true
  }, text, exact)
}

// ═══════════════════════════════════════════════════════════════════
//  假報告：MYFEEL 2026-10-28 唯讀盤點的真實數字（窗口 9/28–10/27）
// ═══════════════════════════════════════════════════════════════════
const at = s => Date.parse(`${s}+08:00`)
const COFFEE = realTag?.id ?? 'coffee'

function blocksByDay() {
  const out = {}
  for (let t = Date.parse('2026-09-28T00:00:00Z'); t <= Date.parse('2026-10-27T00:00:00Z'); t += 86_400_000) {
    out[new Date(t).toISOString().slice(0, 10)] = 10
  }
  return { ...out, '2026-09-29': 29, '2026-09-30': 30, '2026-10-01': 14, '2026-10-04': 29, '2026-10-05': 16, '2026-10-15': 15 }
}

function pushRow(id, name, when, sent, opened, clicked, tagName, over = {}) {
  return { id, name, completedMs: at(when), audience: { type: 'tags', tagIds: [`t-${id}`], tagNames: [tagName] }, sent, opened, clicked, proposalTagId: null, prevOpen: null, ...over }
}

function payload(over = {}) {
  return {
    version: 2,
    window: {
      startMs: at('2026-09-28T00:00:00'), endMs: at('2026-10-28T00:00:00'), prevStartMs: at('2026-08-29T00:00:00'),
      startDate: '2026-09-28', endDate: '2026-10-27',
    },
    integrity: {
      failed: [], userTagsTruncated: false, scannedUserTags: 9404, suggestionLogsTruncated: false,
      pendingTruncated: false, newMembersTruncated: false, suggestionLedgerSince: '2026-08-30',
    },
    overview: {
      line: { status: 'ok', followers: 121370, followersDelta: 1282, blocks: 28744, blocksDelta: 353, asOfDate: '2026-10-27', blocksByDay: blocksByDay() },
      activeUsers: 811,
      listSize: 10810,
    },
    intents: [
      { tagId: 'shipping', name: '問過出貨進度', category: 'behavior', members: 141, recent: 71, prev: 66, notPushedRecent: 50, pushedWithin7d: 0 },
      { tagId: 'returns', name: '退換貨處理中', category: 'behavior', members: 100, recent: 62, prev: 37, notPushedRecent: 40, pushedWithin7d: 0 },
      { tagId: COFFEE, name: '在看咖啡機', category: 'interest', members: 55, recent: 40, prev: 14, notPushedRecent: 22, pushedWithin7d: 0 },
      { tagId: 'earbuds', name: '在看 AI 錄音耳機', category: 'interest', members: 45, recent: 25, prev: 20, notPushedRecent: 31, pushedWithin7d: 0 },
      { tagId: 'waiting', name: '在等開賣', category: 'interest', members: 57, recent: 24, prev: 33, notPushedRecent: 32, pushedWithin7d: 0 },
    ],
    intentPairs: [
      { a: 'shipping', b: 'returns', users: 15 },
      { a: COFFEE, b: 'waiting', users: 7 },
    ],
    pushes: [
      pushRow('p7', '乾淨方MAX-集資結束推播10/15', '2026-10-15T12:00:00', 819, 110, 28, '問卷 - 乾淨方MAX'),
      pushRow('p5', '小滑手_超早鳥倒數', '2026-10-04T12:00:00', 2165, 466, 124, '問卷_珈樂堤_小滑手', {
        audience: { type: 'tags', tagIds: ['t-gl'], tagNames: ['問卷_珈樂堤_小滑手'] },
        prevOpen: { name: '小滑手_開賣', completedMs: at('2026-09-29T12:00:00'), openRate: 0.3594 },
      }),
      pushRow('p4', '電淨艙_超早鳥倒數', '2026-10-04T12:00:00', 1592, 252, 68, '問卷_奇美_電淨艙'),
      pushRow('p2', '小滑手_開賣', '2026-09-29T12:00:00', 2187, 786, 443, '問卷_珈樂堤_小滑手', {
        audience: { type: 'tags', tagIds: ['t-gl'], tagNames: ['問卷_珈樂堤_小滑手'] },
      }),
      pushRow('p1', '電淨艙_開賣', '2026-09-29T12:00:00', 1613, 393, null, '問卷_奇美_電淨艙'),
    ],
    newMembers: {
      total: 1572,
      truncated: false,
      rows: [
        { kind: 'tag', tagId: 's1', name: '問卷_廚餘博士Pro', users: 453 },
        { kind: 'tag', tagId: 's2', name: 'Tefal小泡福_問卷客進入LINE@', users: 224 },
        { kind: 'other', tagId: null, name: '其他 7 種', users: 400 },
        { kind: 'none', tagId: null, name: '沒有來源標籤', users: 495 },
      ],
    },
    upcomingFestival: { id: 'double11-2026', name: '雙 11 購物節', date: '2026-11-11' },
    housekeeping: {
      zeroMember: [{ tagId: 'z1', name: 'YIMI水都會第一次推播有點' }, { tagId: 'z2', name: '水都會-超早鳥倒數' }, { tagId: 'z3', name: '問卷_好吉康動美雕' }],
      aiOnButNeverProduced: [],
      untaggedUsers: 3229,
      suggestions: { decided: 142, agreed: 121, autoApplied: 552, acceptanceRate: 85.2 },
      pendingUsers: 0,
    },
    ...over,
  }
}

const reportOf = (p, extra = {}) => ({
  report: { generatedAtMs: Date.now() - 2 * 3600_000, generatedBy: '守門員', payload: p, legacy: false, ...extra },
  canRegenerate: true,
  cooldownRemainingMs: 0,
})
const reportReply = body => url => (url.includes('/api/tag/report') ? { body } : null)
const countReportCards = page => page.evaluate(() =>
  document.querySelectorAll('.friend-stats .message-card:not(.friend-stats__empty-card)').length)

const WS = `${BASE}/admin/${WORKSPACE_ID}`

// ═══════════════════════════════════════════════════════════════════
//  關 1：側欄有這一項，而且點得進去
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({ fakeReads: reportReply({ report: null, canRegenerate: true, cooldownRemainingMs: 0 }) })
  // ⛔ 別用 `/users` 當起點：那頁在 dev 首次編譯要跑很久（`reference_headless_admin_harness_traps`）
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const nav = await waitForText(page, ['好友統計'], 60_000)
  if (!nav.hit) fail('關 1：側欄「好友經營」段找不到「好友統計」')
  else {
    const clicked = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => x.textContent?.trim() === '好友統計')
      if (!a) return ''
      a.click()
      return a.getAttribute('href') ?? ''
    })
    if (!clicked.endsWith('/friend-stats')) fail(`關 1：那一項指到 ${clicked || '(找不到連結)'}，不是 /friend-stats`)
    else pass(`關 1：側欄有「好友統計」，連到 ${clicked}`)
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 2：還沒產生過 → 只有一張空白卡＋一顆「產生報告」（`D-108`）；⛔ 對照組＝報告卡一張都不該在
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({ fakeReads: reportReply({ report: null, canRegenerate: true, cooldownRemainingMs: 0 }) })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['還沒有產生過報告'])
  if (!r.hit) fail(`關 2：沒看到空狀態。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const state = await page.evaluate(() => ({
      emptyCards: document.querySelectorAll('.friend-stats .friend-stats__empty-card').length,
      genButtons: [...document.querySelectorAll('button')].filter(b => /產生/.test(b.textContent ?? '')).length,
      text: document.body?.innerText ?? '',
    }))
    const reportCards = await countReportCards(page)
    const regrown = ['整理成六件事', '一小時內只算一次'].filter(t => state.text.includes(t))
    if (reportCards !== 0) fail(`關 2 對照組：還沒有報告卻畫出了 ${reportCards} 張卡`)
    else if (state.emptyCards !== 1) fail(`關 2：空狀態應該是一張白卡，找到 ${state.emptyCards} 張`)
    else if (state.genButtons !== 1) fail(`關 2：「產生」按鈕有 ${state.genButtons} 顆，應該只有中間那 1 顆`)
    else if (regrown.length) fail(`關 2：砍掉的說明又長回來了：${regrown.join('、')}`)
    else if (state.text.includes('要請客服或管理員來按')) fail('關 2：管理員看到了觀察者那句')
    else pass('關 2：還沒產生過只給一張空白卡＋一顆「產生報告」，報告卡＝0（對照組成立）')
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 2b：第一次產生，等的時候要講話；回來之後六張卡＋右上角「重新產生」
//        POST 在瀏覽器這端假造、晚 4 秒才回——⛔ 不會真的去算（那一趟會寫正式庫＋問 LINE 31 次）
// ═══════════════════════════════════════════════════════════════════
{
  const fresh = reportOf(payload()).report
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({ report: null, canRegenerate: true, cooldownRemainingMs: 0 }),
    fakeWrites: (url, method) => (method === 'POST' && url.includes('/api/tag/report')
      ? { delayMs: 4000, body: { report: fresh, canRegenerate: false, cooldownRemainingMs: 60 * 60_000 } }
      : null),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r0 = await waitForText(page, ['還沒有產生過報告'])
  if (!r0.hit) fail(`關 2b：沒看到空狀態。畫面上是：${r0.body.slice(0, 200)}`)
  else if (r0.body.includes('正在整理你的好友資料')) fail('關 2b 對照組：還沒按就出現「正在整理你的好友資料」')
  else if (!(await clickButton(page, '產生報告'))) fail('關 2b：找不到「產生報告」按鈕')
  else {
    const waiting = await waitForText(page, ['正在整理你的好友資料'], 3000)
    const buttonsWhileWaiting = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => /產生/.test(b.textContent ?? '')).length)
    const done = await waitForText(page, ['行銷提案'], 15_000)
    const cards = await countReportCards(page)
    const regen = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent?.includes('重新產生')))
    if (!waiting.hit) fail('關 2b：按下去之後沒有講「正在整理你的好友資料」——只有按鈕在轉')
    else if (buttonsWhileWaiting !== 0) fail(`關 2b：等待中畫面上還有 ${buttonsWhileWaiting} 顆「產生」按鈕，可以再按一次`)
    else if (!done.hit) fail('關 2b：假造的報告回來了，但報告沒畫出來')
    // 行銷提案、也要留意、客人在想什麼、推播、新進名單、標籤整理
    else if (cards !== 6) fail(`關 2b：報告卡 ${cards} 張，應該 6 張`)
    else if (!regen) fail('關 2b：報告出來了，右上角沒有「重新產生」')
    else pass('關 2b：按下去 →「正在整理你的好友資料」（等待中沒有第二顆可按）→ 六張卡＋右上角「重新產生」')
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 2c：觀察者 → 講清楚要請誰按，而且沒有按鈕；有報告時也看不到「幫我擬三版文案」
// ═══════════════════════════════════════════════════════════════════
if (!viewerList) fail('關 2c：讀不到帳號清單，沒辦法模擬觀察者')
else {
  let listServed = false
  const { ctx, page } = await openLoggedInPage({
    fakeReads: (url) => {
      if (url.includes('/api/tag/report')) return { body: { report: null, canRegenerate: true, cooldownRemainingMs: 0 } }
      if (url.includes('/api/admin/workspaces/my')) { listServed = true; return { body: viewerList } }
      return null
    },
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['要請客服或管理員來按', '產生報告'])
  const buttons = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => /產生/.test(b.textContent ?? '')).length)
  if (!listServed) fail('關 2c：頁面沒有來拿帳號清單，角色沒被換成觀察者，這關不算數')
  else if (r.hit !== '要請客服或管理員來按') fail(`關 2c：觀察者沒看到「要請客服或管理員來按」。畫面上是：${r.body.slice(0, 200)}`)
  else if (buttons !== 0) fail(`關 2c：觀察者畫面上有 ${buttons} 顆「產生」按鈕（按了只會被後端擋）`)
  else pass('關 2c：觀察者看到「要請客服或管理員來按」，畫面上沒有按鈕')
  await ctx.close()

  // 有報告時：觀察者看得到提案，但不能擬文案（後端要 broadcast.write）
  let served2 = false
  const v2 = await openLoggedInPage({
    fakeReads: (url) => {
      if (url.includes('/api/tag/report')) return { body: reportOf(payload()) }
      if (url.includes('/api/admin/workspaces/my')) { served2 = true; return { body: viewerList } }
      return null
    },
  })
  await v2.page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r2 = await waitForText(v2.page, ['要有推播權限的人才能擬文案'])
  const draftBtn = await v2.page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent?.includes('幫我擬三版文案')))
  if (!served2) fail('關 2c-2：角色沒被換成觀察者，這關不算數')
  else if (!r2.hit) fail('關 2c-2：觀察者看提案時沒講「要有推播權限的人才能擬文案」')
  else if (draftBtn) fail('關 2c-2：觀察者看得到「幫我擬三版文案」（按了只會被後端擋）')
  else pass('關 2c-2：觀察者看得到提案、看不到擬文案的按鈕，而且講了為什麼')
  await v2.ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 3：有報告 → 每一區畫得出來；⛔ 回歸鎖：舊版那幾張卡與提醒不可以長回來
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({ fakeReads: reportReply(reportOf(payload())) })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['行銷提案'])
  if (!r.hit) fail(`關 3：報告畫不出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const want = [
      ['時間窗', '最近 30 天（9/28–10/27）'],
      ['LINE 好友', '121,370'],
      ['30 天新加', '30 天新加 1,282 位'],
      ['封鎖', '28,744'],
      ['有互動', '811'],
      ['名單共', '名單共 10,810 位'],
      ['提案 1 標題', '雙 11 購物節前，發一則給「在看咖啡機」的 55 位'],
      ['提案 1 發給誰', '其中 22 位最近 30 天沒收過任何推播'],
      ['提案 1 為什麼', '最近 30 天新增 40 位，前 30 天 14 位'],
      ['提案 2 標題', '雙 11 購物節前，發一則給「在看 AI 錄音耳機」的 45 位'],
      ['留意：退換貨', '「退換貨處理中」的人變多了'],
      ['留意：推播', '推播那天，封鎖的人是平常的 3 倍'],
      ['留意：打開掉', '5 天後收到第二則，打開的比例從 36% 掉到 22%'],
      ['意圖分組', '興趣偏好'],
      ['推播點連結比例', '20%'],
      ['同一天不平分', '同一天'],
      ['沒有點擊資料', '這則沒有連結點擊資料'],
      ['新進名單', '這 30 天第一次進名單的 1,572 位'],
      ['來源', '問卷_廚餘博士Pro'],
      ['沒有來源', '沒有來源標籤'],
      ['標籤整理摘要', '3 顆建了沒人用'],
    ]
    const missing = want.filter(([, t]) => !r.body.includes(t))
    // 回歸鎖：舊版六張卡＋AI 總結＋寫給我們自己看的提醒（`D-155` 拿掉的）
    const regrown = ['一句話總結', '客人自己表現出來的', '這些標籤在回答什麼', '不要相加', '做過什麼', '10810', '提過 77 次']
      .filter(t => r.body.includes(t))
    // ⛔ 第 2 則提案預設收合：「31 位」那句本來不在（對照組），展開之後才在
    const before = r.body.includes('其中 31 位最近 30 天沒收過任何推播')
    const toggled = await clickButton(page, '展開')
    const after = await waitForText(page, ['其中 31 位最近 30 天沒收過任何推播'], 3000)
    if (missing.length) fail(`關 3：少了 ${missing.map(([k]) => k).join('、')}`)
    else if (regrown.length) fail(`關 3：拿掉的東西又長回來了：${regrown.join('、')}`)
    else if (before) fail('關 3：第 2 則提案預設就展開了（應該收合）')
    else if (!toggled || !after.hit) fail('關 3：第 2 則提案按「展開」之後內容沒出來')
    else pass(`關 3：每一區都在（${want.length} 項），舊版的卡與提醒沒長回來，第 2 則提案收合／展開正常`)
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 4：冷卻中按鈕真的按不動（⛔ 不是只有灰色，要真的 disabled）
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({ ...reportOf(payload()), canRegenerate: false, cooldownRemainingMs: 55 * 60_000 }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  await waitForText(page, ['行銷提案'])
  const state = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('重新產生'))
    return b ? { found: true, disabled: b.disabled } : { found: false }
  })
  if (!state.found) fail('關 4：找不到「重新產生」按鈕')
  else if (!state.disabled) fail('關 4：冷卻中按鈕竟然按得動——⛔ 那就沒有成本閘門')
  else pass('關 4：冷卻中「重新產生」是 disabled')
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 5：改版前存的舊報告 → 講「這份是改版前的報告」，⛔ 不可以畫成空的報告
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({ report: { generatedAtMs: Date.now() - 3 * 3600_000, generatedBy: '', payload: null, legacy: true }, canRegenerate: true, cooldownRemainingMs: 0 }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['這份是改版前的報告', '行銷提案'])
  const cards = await countReportCards(page)
  const genButtons = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => /產生/.test(b.textContent ?? '')).length)
  if (r.hit !== '這份是改版前的報告') fail(`關 5：舊報告沒講「這份是改版前的報告」。畫面上是：${r.body.slice(0, 200)}`)
  else if (cards !== 0) fail(`關 5：舊報告還畫出了 ${cards} 張報告卡`)
  else if (genButtons !== 1) fail(`關 5：「產生」按鈕有 ${genButtons} 顆，應該只有右上角那 1 顆`)
  else pass('關 5：舊報告講「這份是改版前的報告」，只有右上角一顆「重新產生」')
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 6：算不完整、讀不到 LINE、沒有提案 → 每一格都要出聲（三態）
// ═══════════════════════════════════════════════════════════════════
{
  const thin = payload({
    integrity: { failed: ['名單人數'], userTagsTruncated: true, scannedUserTags: 20000, suggestionLogsTruncated: false, pendingTruncated: true, newMembersTruncated: false, suggestionLedgerSince: '2026-08-30' },
    overview: { line: { status: 'failed', followers: null, followersDelta: null, blocks: null, blocksDelta: null, asOfDate: null, blocksByDay: {} }, activeUsers: null, listSize: null },
    intents: [{ tagId: 'a', name: '在看咖啡機', category: 'interest', members: 8, recent: 3, prev: 1, notPushedRecent: 5, pushedWithin7d: 0 }],
    intentPairs: [],
    pushes: null,
    newMembers: { total: null, truncated: false, rows: [] },
    housekeeping: { zeroMember: [], aiOnButNeverProduced: [], untaggedUsers: null, suggestions: { decided: 0, agreed: 0, autoApplied: 0, acceptanceRate: null }, pendingUsers: 45 },
  })
  const { ctx, page } = await openLoggedInPage({ fakeReads: reportReply(reportOf(thin)) })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['這份報告有幾塊不完整'])
  if (!r.hit) fail(`關 6：掃描截斷卻一聲不吭。畫面上是：${r.body.slice(0, 200)}`)
  else {
    await page.evaluate(() => document.querySelector('.friend-stats__housekeeping summary')?.click())
    const body = (await waitForText(page, ['這次算不出來'], 3000)).body
    const want = [
      ['截斷講出來', '貼標紀錄掃到上限'],
      ['查不到講出來', '這次查不到（名單人數）'],
      ['LINE 讀不到', '這次讀不到 LINE 的數字'],
      ['有互動查不到', '這次查不到'],
      ['沒有提案講為什麼', '新增到 10 位以上'],
      ['推播讀不到', '這次讀不到推播'],
      ['新進名單讀不到', '這次查不到新進名單'],
      ['沒標籤的人算不出來', '這次算不出來'],
      ['待審不當精確值', '掃到的那些裡有 45 位'],
      // ⛔ 沒有人決定過時講「還沒有」，不是 0%（0% 會被讀成 AI 全錯）
      ['同意率算不出來', '還沒有人決定過任何一筆建議'],
    ]
    const missing = want.filter(([, t]) => !body.includes(t))
    const zeroPct = /同意 0 次（0%）/.test(body)
    if (missing.length) fail(`關 6：少了 ${missing.map(([k]) => k).join('、')}`)
    else if (zeroPct) fail('關 6：沒有人決定過卻寫了 0%')
    else pass(`關 6：截斷／讀不到 LINE／查不到／沒有提案，${want.length} 處都出聲了`)
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 7：「客人最近在想什麼」的「發推播」→ 推播頁、受眾選好那顆標籤
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({ fakeReads: reportReply(reportOf(payload())) })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  await waitForText(page, ['客人最近在想什麼'])
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-tour="fs-intents"] button')].find(x => x.textContent?.trim() === '發推播' && !x.disabled)
    if (!b) return false
    b.click()
    return true
  })
  if (!clicked) fail('關 7：「客人最近在想什麼」興趣那組沒有「發推播」按鈕')
  else {
    const r = await waitForText(page, ['那顆標籤現在選不到了', '發送對象已選好'])
    const url = page.url()
    if (!url.includes('/broadcasts') || !url.includes('from=friend-stats')) fail(`關 7：按了沒有落到推播頁或沒帶參數：${url}`)
    else if (!r.hit) fail('關 7：落到推播頁了，但交接一聲不吭')
    else if (realTag && r.hit !== '發送對象已選好') fail(`關 7：用的是真標籤「${realTag.name}」，卻走到「${r.hit}」`)
    else pass(`關 7：落到推播頁（${url.split('?')[1]}），${r.hit}`)
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 8：行銷提案整條路——擬文案 → 換版 → 開推播草稿 → 存草稿時帶著提案來歷
//        擬文案與建推播都在瀏覽器這端假造回應，⛔ 沒有叫 AI、沒有寫正式庫
// ═══════════════════════════════════════════════════════════════════
{
  const V = ['咖啡機第一版：天氣轉涼，來杯現磨的。', '咖啡機第二版：雙 11 有新消息，想知道直接回我們。', '咖啡機第三版：想挑哪一台，回我們就好。']
  let draftBody = null
  let createBody = null
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply(reportOf(payload())),
    fakeWrites: (url, method, post) => {
      if (method === 'POST' && url.includes('/api/marketing-calendar/draft')) {
        draftBody = JSON.parse(post || '{}')
        return {
          delayMs: 800,
          body: {
            festivalId: 'double11-2026', festivalName: '雙 11 購物節', suggestedName: '在看咖啡機・雙 11 購物節',
            variants: V, suggestedTagIds: [COFFEE], audienceNotice: '發送對象選好「在看咖啡機」（目前 55 位）。',
            basis: '照你的輪廓與「在看咖啡機」這群人寫的', proposalTagId: COFFEE, ts: Date.now(), dropped: [],
          },
        }
      }
      if (method === 'POST' && url.includes('/api/broadcast/create')) {
        createBody = JSON.parse(post || '{}')
        return { body: { id: 'guard-fake-broadcast' } }
      }
      return null
    },
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  await waitForText(page, ['幫我擬三版文案'])
  // 對照組：還沒按之前，文案不在畫面上
  const pre = (await page.evaluate(() => document.body.innerText)).includes(V[0])
  const clicked = await clickButton(page, '幫我擬三版文案')
  const drafted = await waitForText(page, ['第 1 版／共 3 版'], 8000)
  const firstShown = drafted.body.includes(V[0])
  await page.evaluate(() => document.querySelector('[aria-label="下一版"]')?.click())
  const second = await waitForText(page, ['第 2 版／共 3 版'], 3000)
  if (pre) fail('關 8 對照組：還沒按就看得到文案')
  else if (!clicked) fail('關 8：找不到「幫我擬三版文案」')
  else if (!drafted.hit || !firstShown) fail('關 8：擬好之後沒顯示第 1 版')
  else if (!second.hit || !second.body.includes(V[1])) fail('關 8：按「下一版」沒換到第 2 版')
  else if (draftBody?.tagId !== COFFEE || draftBody?.festivalId !== 'double11-2026') fail(`關 8：擬文案送出去的不是提案那顆標籤＋檔期：${JSON.stringify(draftBody)}`)
  else if (!(await clickButton(page, '用這版開推播草稿'))) fail('關 8：找不到「用這版開推播草稿」')
  else {
    const landed = await waitForText(page, ['這是草稿，還沒有送出去', '文案沒有帶過來'], 20_000)
    const url = page.url()
    // 挑的是第 2 版，推播頁預設要帶第 2 版
    const editorHasPicked = await page.evaluate(t => [...document.querySelectorAll('textarea')].some(x => x.value.includes(t)) || document.body.innerText.includes(t), V[1])
    if (!url.includes('from=proposal')) fail(`關 8：沒有落到推播頁的提案入口：${url}`)
    else if (landed.hit !== '這是草稿，還沒有送出去') fail(`關 8：推播頁沒接到文案（${landed.hit ?? '一聲不吭'}）`)
    else if (!editorHasPicked) fail('關 8：推播頁帶的不是挑的那一版')
    else if (!(await clickButton(page, '儲存草稿'))) fail('關 8：推播頁找不到「儲存草稿」')
    else {
      const start = Date.now()
      while (!createBody && Date.now() - start < 8000) await new Promise(r => setTimeout(r, 200))
      if (!createBody) fail('關 8：按了儲存草稿，沒送出建立推播的請求')
      // ⭐ 這一條是成績回報的根：沒帶上，下一份報告就認不出哪一則是照提案發的
      else if (createBody.proposalTagId !== COFFEE) fail(`關 8：存草稿沒帶提案來歷（proposalTagId=${createBody.proposalTagId}）`)
      else if (createBody.festivalId !== 'double11-2026') fail(`關 8：存草稿沒帶檔期（festivalId=${createBody.festivalId}）`)
      else if (JSON.stringify(createBody.audienceSource) !== JSON.stringify({ type: 'tags', tagIds: [COFFEE] })) fail(`關 8：受眾不是提案那顆標籤：${JSON.stringify(createBody.audienceSource)}`)
      else pass('關 8：擬文案（帶標籤＋檔期）→ 換到第 2 版 → 推播頁帶第 2 版 → 存草稿時帶著提案來歷、檔期與受眾')
    }
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 9：「也要留意」的「看這 100 位」→ 好友頁照那顆標籤篩；標籤整理展開／收合
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({ fakeReads: reportReply(reportOf(payload())) })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  await waitForText(page, ['也要留意'])
  // 標籤整理：本來收著（對照組：AI 準不準那句看不到），點開之後看得到、而且不並列「提過幾次」
  const hiddenBefore = await page.evaluate(() => !document.querySelector('.friend-stats__housekeeping')?.open)
  await page.evaluate(() => document.querySelector('.friend-stats__housekeeping summary')?.click())
  const opened = await waitForText(page, ['人看過的 142 次裡同意 121 次（85%）'], 3000)
  const chevron = await page.evaluate(() => document.querySelector('.friend-stats__housekeeping summary')?.textContent?.includes('收合'))
  if (!hiddenBefore) fail('關 9：標籤整理預設就是打開的（應該收合在最底）')
  else if (!opened.hit) fail('關 9：標籤整理打開之後沒看到 AI 準不準那句')
  else if (!chevron) fail('關 9：打開之後右邊還寫「展開」')
  else pass('關 9：標籤整理預設收合，打開後講「人看過的 142 次裡同意 121 次」、右邊換成「收合」')

  const go = await clickButton(page, '看這 100 位')
  await new Promise(r => setTimeout(r, 300))
  const start = Date.now()
  while (!page.url().includes('/users') && Date.now() - start < 8000) await new Promise(r => setTimeout(r, 200))
  if (!go) fail('關 9：「也要留意」沒有「看這 100 位」')
  else if (!page.url().includes('/users?tagIds=returns')) fail(`關 9：「看這 100 位」沒落到好友頁的標籤篩選：${page.url()}`)
  else pass('關 9：「看這 100 位」落到好友頁、照「退換貨處理中」篩')
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
console.log('')
console.log(`被擋下的寫入請求：${blocked.length} 筆${blocked.length ? `（${[...new Set(blocked)].join('、')}）` : '＝全程沒有任何寫入送出去'}`)
console.log(`在瀏覽器端假造回應的寫入：${faked.length} 筆${faked.length ? `（${[...new Set(faked)].join('、')}，都沒有離開這台機器）` : ''}`)
await browser.close()
if (failed) { console.error('\n有關卡沒過'); process.exit(1) }
console.log('\n全部通過')
