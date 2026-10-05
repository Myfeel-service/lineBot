/**
 * 小幫手出場時機（`D-112`）的實機守門員。
 *
 *   BROADCAST_CRON_ENABLED=false npx nuxt dev --port 3412          # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3412 node --env-file=.env_myfeel scripts/agent-entry-check.mjs
 *   （要截圖就加 CHECK_SHOT_DIR=<資料夾>）
 *
 * 驗的是「按下去真的會發生」的那幾件——單元測試只驗得到對照表，驗不到：
 *   ① 頁面上的「用一句話建立」按了，小幫手真的開在對話（狀況收著）、游標在輸入框、範例字是這一頁的
 *   ② 建議真的跟著頁面換；「做」的建議只放進輸入框、⛔不送出；「查」的按了就送
 *   ③ 送出去的請求帶著「從哪個入口來」（量入口用）
 *   ④ 按了確定之後，那一頁真的重讀、那一列真的亮了；不在那一頁時給「前往查看」，按了真的帶過去並打開
 *   ⑤ AI 設定頁有沒存的修改時⛔不重讀，而且聊天照實講「直接存會改回去」
 *   ⑥ 「目前狀況」待辦卡上的「交給小幫手」按了，替他講的那句話真的送出去
 *   ⑦ 觀察者看不到任何「做」的建議與按鈕
 *   ⑧ 版面：側欄那一排與標籤頁標頭沒折行、聊過之後建議縮成一排
 *   ⑨ `D-114` 一頁：沒有分頁、高度固定（展開狀況／15 件／全部教學都一樣高）、狀況展開時輸入框還在、
 *      紅的時候打開就自動展開、紅線收進 15 件清單、每頁「？」的「看全部教學」真的打開全部教學
 *
 * ⚠️ 寫入範圍：**零寫入**。所有 POST/PUT/PATCH/DELETE 都在瀏覽器層攔下——
 *    小幫手的聊天與確認兩支換成假回應（否則會呼叫模型、會真的改設定），其餘一律擋下並列出來；
 *    Firestore 的寫入通道（`/Write/`）也擋。GET 放行打正式資料，只有四支換成假的：
 *    導覽已讀（不讓自動導覽擋畫面）、設定體檢與角色（演待辦卡與觀察者）、「等你看過」（演一張剛補的卡）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3412'
const WID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL
const SHOT_DIR = process.env.CHECK_SHOT_DIR ?? ''

const {
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_CLIENT_EMAIL: clientEmail,
  FIREBASE_PRIVATE_KEY: privateKey,
  FIREBASE_API_KEY: apiKey,
} = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}

// ── 先確認連到的是這個專案的 dev server（記憶：3000 埠常常是別的專案） ──
{
  const r = await fetch(`${BASE}/api/admin/tour-seen`).catch(() => null)
  if (!r || r.status !== 401) {
    console.error(`${BASE} 沒帶憑證打 /api/admin/tour-seen 應該回 401，實際是 ${r?.status ?? '連不上'}——連到的不是這個專案的 dev server`)
    process.exit(1)
  }
}

initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()
const members = await db.collection('workspaceMembers').where('workspaceId', '==', WID).get()
const rows = members.docs.map(d => ({ id: d.id, ...d.data() }))
const admin = rows.find(r => r.role === 'owner') ?? rows.find(r => r.role === 'admin')
if (!admin) { console.error('這個工作區查不到管理員'); process.exit(1) }
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

let failures = 0
const fail = (msg) => { failures++; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)
const info = msg => console.log(`ℹ️ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitUntil(fn, ms = 10_000, step = 150) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try { if (await fn()) return true }
    catch {}
    await sleep(step)
  }
  return false
}

/** 用登入者的憑證在 node 這邊直接問 dev server（拿真的 id、或改寫成假的回應時用） */
async function getReal(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${session.idToken}` } })
  if (!r.ok) throw new Error(`${path} 回 ${r.status}`)
  return r.json()
}
const listOf = res => (Array.isArray(res) ? res : res?.items ?? res?.tags ?? [])

// ── 對照表（跟 shared/agent-entry.ts 講同一件事；改那邊這裡要跟著改） ──
const EXPECT = {
  'ai-scripts': { label: '自動回應', placeholder: '例：把「退換貨」回覆改成「先填表單」', firstDo: '有人問「運費」，就回「滿千免運」', ask: '哪幾條自動回應還沒上架？', dos: 3 },
  'broadcasts': { label: '推播', placeholder: '例：擬一則母親節草稿，發給全部好友' },
  'line-notify': { label: 'LINE 通知' },
}

/** 每一頁頁首問號的導覽鑰匙（自動導覽一律當成看過，免得遮罩吃掉點擊） */
function tourKeys() {
  const keys = new Set()
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.vue')) {
        // 兩種寫法都要抓：頁首問號 `:topics=`，以及單頁標題 AdminSoloPageHeading 的 `:help-topics=`
        // （⛔ 漏抓的那幾頁會自動跑導覽，導覽一開跑就把小幫手面板收掉——第一輪就是這樣在 AI 設定頁停下來的）
        for (const m of readFileSync(p, 'utf8').matchAll(/:(?:help-)?topics="\[([^\]]+)\]"/g))
          keys.add([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).join('|'))
      }
    }
  }
  walk('app')
  return [...keys]
}
const TOUR_KEYS = tourKeys()

// ── 真的 id（GET，唯讀） ──
const scripts = listOf(await getReal(`/api/ai/scripts/list?workspaceId=${WID}&page=1&limit=20`))
const broadcasts = listOf(await getReal(`/api/broadcast/list?workspaceId=${WID}&page=1&limit=20`))
const tags = listOf(await getReal(`/api/tag/list?workspaceId=${WID}&page=1&limit=20&includeMemberCount=true`))
const script = scripts.find(s => s.triggerEvent !== 'follow') ?? scripts[0]
const broadcast = broadcasts[0]
const tag = tags[0]
info(`拿來演的真資料：自動回應「${script?.name}」、推播「${broadcast?.name}」、標籤「${tag?.name}」`)
if (!script || !broadcast || !tag) { console.error('這個工作區缺自動回應／推播／標籤，演不了'); process.exit(1) }

/** 假的待確認操作（形狀照 shared/types/admin-ops 的 AdminOpPending） */
function pendingOf(opId, label, token) {
  return {
    opId, label, risk: 'medium', token, expiresInSec: 600,
    preview: { opId, summary: `（守門員）我會${label}。`, items: [{ label: '現在', note: '舊的' }, { label: '改成', note: '新的' }], confirmLabel: '確定' },
  }
}

const state = {
  chatBodies: [],
  confirmHits: 0,
  nextChat: null,
  nextConfirm: null,
  getLog: [],
  blocked: [],
  fakeSetup: false,
  fakeViewer: false,
  fakeDrafts: false,
}
const json = (req, body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
page.on('dialog', d => d.accept().catch(() => {}))
// 亮一下用的是 element.animate()：記下被亮的是哪一塊（不靠時間差去量動畫）
await page.evaluateOnNewDocument(() => {
  window.__flashes = []
  const orig = Element.prototype.animate
  Element.prototype.animate = function (...a) {
    try {
      const k = this.getAttribute?.('data-agent-target')
      if (k) window.__flashes.push(k)
    }
    catch {}
    return orig.apply(this, a)
  }
  // Nuxt DevTools 的浮窗會蓋住截圖
  document.addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style')
    s.textContent = '#nuxt-devtools-container{display:none!important}'
    document.head.appendChild(s)
  })
})

await page.setRequestInterception(true)
page.on('request', async (req) => {
  const url = req.url()
  const method = req.method()
  // Firestore 用戶端的寫入通道：擋（讀取的 Listen 照放）
  if (url.includes('firestore.googleapis.com') && url.includes('/Write/')) {
    state.blocked.push(`firestore Write ${url.slice(0, 80)}`)
    return req.abort()
  }
  if (!url.startsWith(BASE)) return req.continue()
  const path = url.slice(BASE.length)
  if (!path.startsWith('/api/')) return req.continue()
  try {
    if (method === 'GET') {
      state.getLog.push({ path, at: Date.now() })
      if (path.startsWith('/api/admin/tour-seen')) return json(req, { seen: TOUR_KEYS })
      if (state.fakeSetup && path.startsWith('/api/admin/setup-status')) {
        const real = await getReal(path)
        for (const it of real.items) if (it.id === 'aiEnabled' || it.id === 'scriptReady') it.status = 'incomplete'
        return json(req, real)
      }
      if (state.fakeViewer && path.startsWith('/api/admin/workspaces/my')) {
        const real = await getReal(path)
        const list = Array.isArray(real) ? real : real.workspaces ?? real.items ?? []
        for (const w of list) if ((w.workspaceId ?? w.id) === WID) w.role = 'viewer'
        return json(req, real)
      }
      if (state.fakeDrafts && path.startsWith('/api/ai/knowledge/drafts')) {
        return json(req, {
          total: 1,
          pages: [{ sourceId: 'agent-check-src', name: '小幫手補的', url: '', cards: [{ id: 'agent-check-card', title: '可以刷卡嗎', content: '可以，Visa、Master 都收', questions: ['可以刷卡嗎'], tags: [] }] }],
          generating: null,
          quota: null,
        })
      }
      return req.continue()
    }
    if (path.startsWith('/api/admin/agent/chat')) {
      state.chatBodies.push(JSON.parse(req.postData() || '{}'))
      const body = state.nextChat ?? { reply: '（守門員）好的。', toolCalls: [], messages: [] }
      state.nextChat = null
      return json(req, body)
    }
    if (path.startsWith('/api/admin/agent/confirm')) {
      state.confirmHits++
      return json(req, state.nextConfirm)
    }
    state.blocked.push(`${method} ${path.split('?')[0]}`)
    return req.abort()
  }
  catch (e) {
    console.log('  [攔截出錯]', path, String(e).slice(0, 120))
    return req.abort().catch(() => {})
  }
})

// ── 登入（同 agent-ops-check：把 Firebase 的使用者寫進 IndexedDB） ──
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 120_000 })
await page.evaluate(async (s) => {
  const user = {
    uid: s.uid,
    email: s.email,
    emailVerified: true,
    isAnonymous: false,
    providerData: [{ providerId: 'google.com', uid: s.email, displayName: null, email: s.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
    createdAt: String(Date.now() - 86400_000),
    lastLoginAt: String(Date.now()),
    apiKey: s.apiKey,
    appName: '[DEFAULT]',
  }
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

// ── 小工具 ──
async function go(path, readySel) {
  await page.goto(`${BASE}/admin/${WID}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  const ok = await waitUntil(() => page.evaluate(sel => !!document.querySelector(sel), readySel), 90_000, 300)
  if (!ok) throw new Error(`${path} 等不到 ${readySel}（這次沒驗到，⛔ 不算綠）`)
  await sleep(600)
}
/** 側欄點過去（站內換頁：小幫手的對話與面板都還在） */
async function navTo(suffix, readySel) {
  const clicked = await page.evaluate((s) => {
    const a = [...document.querySelectorAll('a[href]')].find(el => el.getAttribute('href')?.endsWith(s))
    if (!a) return false
    a.click()
    return true
  }, suffix)
  if (!clicked) throw new Error(`側欄找不到 ${suffix} 的連結`)
  const ok = await waitUntil(() => page.evaluate(sel => !!document.querySelector(sel), readySel), 60_000, 300)
  if (!ok) throw new Error(`換到 ${suffix} 等不到 ${readySel}`)
  await sleep(500)
}
async function openPanel() {
  const open = await page.evaluate(() => !!document.querySelector('.ta-panel'))
  if (!open) await page.evaluate(() => document.querySelector('.ta-fab')?.click())
  if (!await waitUntil(() => page.evaluate(() => !!document.querySelector('.ta-panel')), 10_000)) throw new Error('小幫手面板沒打開')
}
// `D-114`（2026-10-05）：小幫手沒有分頁了——最上面一條「目前狀況」（按了展開）＋下面一直是對話
const statusExpanded = () => page.evaluate(() => document.querySelector('.ta-strip')?.getAttribute('aria-expanded') === 'true')
/** 對話紀錄看得到（狀況收著）＝以前的「在問／交辦分頁」 */
const chatVisible = () => page.evaluate(() => {
  const list = document.querySelector('.aa-chat__list')
  return !!list && list.offsetParent !== null && document.querySelector('.ta-strip')?.getAttribute('aria-expanded') === 'false'
})
async function showChat() {
  if (await statusExpanded()) await page.evaluate(() => document.querySelector('.ta-strip')?.click())
  await waitUntil(chatVisible, 5000)
}
async function expandStatus() {
  if (!await statusExpanded()) await page.evaluate(() => document.querySelector('.ta-strip')?.click())
  await waitUntil(() => page.evaluate(() => document.querySelector('#ta-status')?.offsetParent !== null), 5000)
}
// ⚠️ 量 offsetHeight 不量 getBoundingClientRect：面板打開有縮放動畫（ta-pop），動畫跑到一半量到的是縮小的樣子
//    （第一輪就是這樣報「全部教學 557px、回來 577px」的假紅——外框其實一直是 580）
const panelHeight = () => page.evaluate(() => document.querySelector('.ta-panel')?.offsetHeight ?? 0)
const inputShown = () => page.evaluate(() => document.querySelector('.aa-chat__field input')?.offsetParent !== null)
const pillsHead = () => page.evaluate(() => document.querySelector('.aa-chat__pills-head span')?.textContent?.trim() ?? '')
const inputValue = () => page.evaluate(() => document.querySelector('.aa-chat__field input')?.value ?? '')
const placeholder = () => page.evaluate(() => document.querySelector('.aa-chat__field input')?.getAttribute('placeholder') ?? '')
const lastAi = () => page.evaluate(() => [...document.querySelectorAll('.aa-msg--ai .aa-msg__bubble')].at(-1)?.textContent ?? '')
const flashed = key => page.evaluate(k => window.__flashes.includes(k), key)
const resetFlashes = () => page.evaluate(() => { window.__flashes = [] })
async function sendTyped(text) {
  await page.click('.aa-chat__field input')
  await page.evaluate(() => { const i = document.querySelector('.aa-chat__field input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.type('.aa-chat__field input', text, { delay: 5 })
  await page.evaluate(() => [...document.querySelectorAll('.aa-chat__input button')].find(b => /送出/.test(b.textContent ?? ''))?.click())
}
async function lastChatBody(n0) {
  if (!await waitUntil(() => state.chatBodies.length > n0, 8000)) return null
  return state.chatBodies.at(-1)
}
/** 等確認卡出現、換好確認的假回應、按下確定 */
async function confirmWith(result) {
  if (!await waitUntil(() => page.evaluate(() => !!document.querySelector('.aa-op .el-button--primary')), 8000)) throw new Error('確認卡沒出現')
  state.nextConfirm = result
  const getsBefore = state.getLog.length
  await page.evaluate(() => [...document.querySelectorAll('.aa-op .el-button--primary')].at(-1)?.click())
  if (!await waitUntil(() => state.confirmHits > 0, 5000)) throw new Error('確定按了沒送出')
  return getsBefore
}
async function shot(name) {
  if (!SHOT_DIR) return
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) })
}
const getsSince = (i, prefix) => state.getLog.slice(i).filter(g => g.path.startsWith(prefix)).length

try {
  // ═══ ① 自動回應：頁面按鈕、建議、填進輸入框、確認後亮那一列 ═══════════════════
  await go('/ai-scripts', '.split-list-item')
  const row = await page.evaluate(() => {
    const r = document.querySelector('.agent-ask-row')
    const b = r?.querySelector('.agent-ask-btn')
    return r && b ? { h: Math.round(r.getBoundingClientRect().height), text: b.textContent.trim(), clipped: b.scrollWidth > b.clientWidth + 1 } : null
  })
  if (!row) fail('自動回應頁的側欄沒有「用一句話建立」那一排')
  else {
    pass(`自動回應頁側欄有「${row.text}」那一排（高 ${row.h}px）`)
    if (row.text !== '用一句話建立') fail(`按鈕字是「${row.text}」`)
    if (row.h > 52 || row.clipped) fail(`那一排高 ${row.h}px／字被切到：${row.clipped}`)
  }

  await page.evaluate(() => document.querySelector('.agent-ask-row .agent-ask-btn')?.click())
  await waitUntil(() => page.evaluate(() => !!document.querySelector('.aa-chat__pills')), 8000)
  if (await chatVisible()) pass('按了直接看得到對話（狀況收著，沒有分頁要切）')
  else fail(`按了之後對話沒露出來（狀況展開：${await statusExpanded()}）`)
  const focused = await waitUntil(() => page.evaluate(() => document.activeElement === document.querySelector('.aa-chat__field input')), 3000)
  if (focused) pass('游標已經在輸入框裡')
  else fail('游標沒有在輸入框（面板搶走了焦點）')
  if ((await placeholder()) === EXPECT['ai-scripts'].placeholder) pass('輸入框範例字是這一頁的')
  else fail(`輸入框範例字是「${await placeholder()}」`)
  if ((await pillsHead()) === '在「自動回應」可以這樣跟我說') pass('建議標題講得出在哪一頁')
  else fail(`建議標題是「${await pillsHead()}」`)
  const chips = await page.evaluate(() => ({
    dos: [...document.querySelectorAll('.aa-chip--do')].map(b => b.textContent.trim()),
    asks: [...document.querySelectorAll('.aa-chip:not(.aa-chip--do)')].map(b => b.textContent.trim()),
    all: document.querySelector('.aa-chat__all-toggle')?.textContent?.trim() ?? '',
    opener: document.querySelector('.aa-msg--ai .aa-msg__bubble')?.textContent?.trim() ?? '',
  }))
  if (chips.dos.length === EXPECT['ai-scripts'].dos && chips.dos[0] === EXPECT['ai-scripts'].firstDo) pass(`「直接幫你做」${chips.dos.length} 個，第一個是這一頁的事`)
  else fail(`「做」的建議是：${JSON.stringify(chips.dos)}`)
  if (chips.asks.includes(EXPECT['ai-scripts'].ask)) pass('「幫你查」是這一頁的事')
  else fail(`「查」的建議是：${JSON.stringify(chips.asks)}`)
  if (chips.all === '我會做的 15 件') pass('管理員看得到「我會做的 15 件」')
  else fail(`「我會做的 N 件」顯示成「${chips.all}」`)
  // 綠的前面那支筆（`D-114`）是 ::before，textContent 讀不到——直接量偽元素
  const pen = await page.evaluate(() => {
    const d = document.querySelector('.aa-chip--do')
    return d ? getComputedStyle(d, '::before').content : ''
  })
  if (pen.includes('✎')) pass('「做」的建議前面有一支筆（按了是放進輸入框讓你改）')
  else fail(`「做」的建議前面是：${pen}`)
  if (chips.opener.startsWith('我可以幫你查，也可以直接幫你改')) pass('開場白先講會做事')
  else fail(`開場白是「${chips.opener}」`)
  await shot('01-scripts-pills')

  // 「做」的建議：只放進輸入框，不送
  let n0 = state.chatBodies.length
  await page.evaluate(() => document.querySelector('.aa-chip--do')?.click())
  await sleep(700)
  if ((await inputValue()) === EXPECT['ai-scripts'].firstDo && state.chatBodies.length === n0) pass('按「做」的建議：字放進輸入框、⛔沒有送出去')
  else fail(`按了「做」的建議：輸入框是「${await inputValue()}」、送出了 ${state.chatBodies.length - n0} 次`)

  // 送出：帶「從建議來」與頁面；回一張下架的確認卡
  state.nextChat = { reply: '我打算這樣做。', toolCalls: [], messages: [], pendingOp: pendingOf('script-set-enabled', '上架或下架一條自動回應', 'fake-entry-1') }
  n0 = state.chatBodies.length
  await page.evaluate(() => [...document.querySelectorAll('.aa-chat__input button')].find(b => /送出/.test(b.textContent ?? ''))?.click())
  let body = await lastChatBody(n0)
  if (body?.source === 'suggestion' && body?.page === 'ai-scripts') pass('送出的請求記得「從建議來、在自動回應頁」')
  else fail(`送出的請求：source=${body?.source} page=${body?.page}`)

  await resetFlashes()
  let g0 = await confirmWith({ ok: true, opId: 'script-set-enabled', label: '上架或下架一條自動回應', message: `「${script.name}」已經下架（守門員假回應）。`, targetId: script.id })
  // ⚠️ 等的是正式資料重讀完（記憶 reference_headless_admin_harness_traps 第 5 條：短等待一定忽紅忽綠）
  if (await waitUntil(() => flashed(script.id), 25_000)) pass(`按了確定：「${script.name}」那一列亮了`)
  else fail('按了確定之後，那一列沒有亮')
  if (getsSince(g0, '/api/ai/scripts/list') > 0) pass('清單真的重讀了（不是只亮舊的那份）')
  else fail('按了確定之後沒有重讀自動回應清單')
  if (await waitUntil(async () => (await lastAi()).includes('畫面上亮起來的就是'), 5000)) pass('對話裡講「亮起來的就是」')
  else fail(`對話最後一句：${await lastAi()}`)
  await shot('02-scripts-flashed')

  // 「查」的建議：按了就送
  n0 = state.chatBodies.length
  await page.evaluate(() => document.querySelector('.aa-chip:not(.aa-chip--do)')?.click())
  body = await lastChatBody(n0)
  if (body?.message === EXPECT['ai-scripts'].ask && body?.source === 'suggestion') pass('按「查」的建議：直接送出')
  else fail(`按「查」的建議：${JSON.stringify(body)}`)
  await sleep(500)

  // ═══ ② 換到推播：建議跟著換、聊過之後縮成一排、頁面按鈕記成 page-button ═══════════
  await navTo('/broadcasts', '.split-list-item')
  if (await waitUntil(async () => (await pillsHead()) === '在「推播」可以這樣跟我說', 5000)) pass('換頁之後，建議標題跟著換成「推播」')
  else fail(`換到推播之後建議標題是「${await pillsHead()}」`)
  if ((await placeholder()) === EXPECT.broadcasts.placeholder) pass('輸入框範例字跟著換')
  else fail(`推播頁的範例字是「${await placeholder()}」`)
  const compact = await page.evaluate(() => {
    const p = document.querySelector('.aa-chat__pills')
    const tops = new Set([...document.querySelectorAll('.aa-chip')].map(c => Math.round(c.getBoundingClientRect().top)))
    return { compact: p?.classList.contains('is-compact'), rows: tops.size }
  })
  if (compact.compact && compact.rows === 1) pass('聊過之後建議縮成一排')
  else fail(`聊過之後的建議：compact=${compact.compact}、${compact.rows} 排`)
  const bcBtn = await page.evaluate(() => document.querySelector('.agent-ask-row .agent-ask-btn')?.textContent?.trim() ?? '')
  if (bcBtn === '用一句話擬草稿') pass('推播頁側欄是「用一句話擬草稿」')
  else fail(`推播頁的按鈕是「${bcBtn}」`)
  await page.evaluate(() => document.querySelector('.agent-ask-row .agent-ask-btn')?.click())
  await sleep(400)
  if ((await inputValue()) === '') pass('按頁面按鈕：輸入框是空的（⛔ 不替他講話）')
  else fail(`按頁面按鈕後輸入框有字：「${await inputValue()}」`)
  n0 = state.chatBodies.length
  await sendTyped('擬一則守門員測試草稿')
  body = await lastChatBody(n0)
  if (body?.source === 'page-button' && body?.page === 'broadcasts') pass('從頁面按鈕進來打字送出：記成「頁面按鈕」')
  else fail(`頁面按鈕那句：source=${body?.source} page=${body?.page}`)
  await sleep(500)

  // ═══ ③ 在別頁叫它做：給「前往查看」、按了帶過去並打開那一則 ═══════════════════
  await navTo('/ai-settings', '[data-agent-target="service-hours"]')
  state.nextChat = { reply: '我打算這樣做。', toolCalls: [], messages: [], pendingOp: pendingOf('broadcast-draft-create', '建一則推播草稿（不發送）', 'fake-entry-2') }
  n0 = state.chatBodies.length
  await sendTyped('擬一則國慶日草稿')
  body = await lastChatBody(n0)
  if (body?.source === 'typed') pass('自己打字：記成「自己打字」')
  else fail(`自己打字那句：source=${body?.source}`)
  state.confirmHits = 0
  await confirmWith({ ok: true, opId: 'broadcast-draft-create', label: '建一則推播草稿（不發送）', message: '草稿建好了（守門員假回應）。', targetId: broadcast.id })
  if (await waitUntil(() => page.evaluate(() => !!document.querySelector('.aa-view')), 6000)) pass(`在 AI 設定頁做的推播草稿：給「${await page.evaluate(() => document.querySelector('.aa-view').textContent.trim())}」`)
  else fail('在別頁做完沒有「前往查看」')
  await resetFlashes()
  await page.evaluate(() => [...document.querySelectorAll('.aa-view')].at(-1)?.click())
  if (await waitUntil(() => page.evaluate(() => location.pathname.endsWith('/broadcasts')), 20_000)) pass('按了「前往查看」：換到推播頁')
  else fail(`按了「前往查看」之後在 ${await page.evaluate(() => location.pathname)}`)
  if (await waitUntil(() => flashed(broadcast.id), 25_000)) pass(`到了之後「${broadcast.name}」那一列亮了`)
  else fail('到了推播頁，那一則沒有亮')
  if (await waitUntil(() => page.evaluate(id => !!document.querySelector(`.split-list-item.active[data-agent-target="${id}"]`), broadcast.id), 25_000)) pass('而且那一則已經打開（`?id=` 深連結接手）')
  else fail('到了推播頁，那一則沒有被打開')
  await shot('03-broadcast-view')

  // ═══ ④ AI 設定：重讀＋亮那一塊；有沒存的修改時不重讀、照實講 ═════════════════
  await navTo('/ai-settings', '[data-agent-target="service-hours"]')
  await resetFlashes()
  state.nextChat = { reply: '我打算這樣做。', toolCalls: [], messages: [], pendingOp: pendingOf('ai-settings-service-hours', '調整服務時間／勿擾時段', 'fake-entry-3') }
  n0 = state.chatBodies.length
  await sendTyped('服務時間改成平日 9 點到 6 點')
  await lastChatBody(n0)
  state.confirmHits = 0
  g0 = await confirmWith({ ok: true, opId: 'ai-settings-service-hours', label: '調整服務時間／勿擾時段', message: '改好了（守門員假回應）。' })
  if (await waitUntil(() => flashed('service-hours'), 8000)) pass('AI 設定頁：「服務時間」那一塊亮了')
  else fail('AI 設定頁：「服務時間」沒有亮')
  if (getsSince(g0, '/api/ai/settings') > 0) pass('AI 設定真的重讀了（畫面不會停在舊值被他存回去）')
  else fail('按了確定之後沒有重讀 AI 設定')

  // 弄髒表單：動「服務時間」那顆開關
  await page.evaluate(() => document.querySelector('[data-agent-target="service-hours"] .el-switch')?.click())
  const dirty = await waitUntil(() => page.evaluate(() => {
    const b = [...document.querySelectorAll('.admin-header-actions .el-button--primary')].find(x => /儲存設定/.test(x.textContent ?? ''))
    return b && !b.disabled && !b.classList.contains('is-disabled')
  }), 3000)
  if (!dirty) fail('動了開關，儲存鈕卻沒亮起來（演不出「有沒存的修改」）')
  state.nextChat = { reply: '我打算這樣做。', toolCalls: [], messages: [], pendingOp: pendingOf('ai-settings-reply-mode', '切換 AI 直接回客人／只給草稿', 'fake-entry-4') }
  n0 = state.chatBodies.length
  await sendTyped('AI 先只給草稿')
  await lastChatBody(n0)
  state.confirmHits = 0
  g0 = await confirmWith({ ok: true, opId: 'ai-settings-reply-mode', label: '切換 AI 直接回客人／只給草稿', message: '改好了（守門員假回應）。' })
  if (await waitUntil(async () => (await lastAi()).includes('沒存的修改'), 6000)) pass('有沒存的修改：對話照實講「畫面上還是舊的、直接存會改回去」')
  else fail(`有沒存的修改時，對話最後一句：${await lastAi()}`)
  await sleep(800)
  if (getsSince(g0, '/api/ai/settings') === 0) pass('而且⛔沒有重讀（沒蓋掉他打到一半的東西）')
  else fail('有沒存的修改，頁面還是重讀了（會蓋掉他的修改）')
  await shot('04-settings-dirty')
  // 收掉：按取消、確認放棄（全程沒有寫入）
  await page.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button')].find(b => /取消/.test(b.textContent ?? ''))?.click())
  await waitUntil(() => page.evaluate(() => !!document.querySelector('.el-message-box')), 3000)
  await page.evaluate(() => document.querySelector('.el-message-box__btns .el-button--primary')?.click())
  await sleep(600)

  // ═══ ⑤ 一頁（`D-114`）：沒有分頁、高度固定、狀況展開時輸入框還在、紅線收進清單 ═════════
  const head = await page.evaluate(() => {
    const name = document.querySelector('.ta-panel__name')
    return {
      tabs: document.querySelectorAll('.ta-panel [role="tab"]').length,
      strip: !!document.querySelector('.ta-panel .ta-strip'),
      foot: !!document.querySelector('.ta-panel__foot'),
      nameOk: name ? name.scrollWidth <= name.clientWidth + 1 && name.getBoundingClientRect().height < parseFloat(getComputedStyle(name).fontSize) * 2 : false,
    }
  })
  if (head.tabs === 0 && head.strip && !head.foot && head.nameOk) pass('面板：沒有分頁、最上面是狀況那一條、頁尾那行不見了、「小幫手」一行')
  else fail(`面板：${JSON.stringify(head)}`)

  const hChat = await panelHeight()
  await expandStatus()
  const hStatus = await panelHeight()
  const statusInput = await inputShown()
  const listHidden = await page.evaluate(() => document.querySelector('.aa-chat__list')?.offsetParent === null)
  await shot('04b-status-expanded')
  await showChat()
  await page.evaluate(() => document.querySelector('.aa-chat__all-toggle')?.click())
  await sleep(300)
  const hAll = await panelHeight()
  const selfLine = await page.evaluate(() => document.querySelector('.aa-chat__all-self')?.textContent?.trim() ?? '')
  await shot('04c-all15')
  await page.evaluate(() => document.querySelector('.aa-chat__all-toggle')?.click())
  if (hChat > 0 && hChat === hStatus && hChat === hAll) pass(`高度固定：對話、展開狀況、打開「我會做的 15 件」都是 ${hChat}px`)
  else fail(`高度會跳：對話 ${hChat}／展開狀況 ${hStatus}／15 件 ${hAll}`)
  if (statusInput && listHidden) pass('狀況展開時：對話紀錄讓位、輸入框還在（任何時候都能直接打字）')
  else fail(`狀況展開時：輸入框看得到 ${statusInput}、對話紀錄藏起來 ${listHidden}`)
  if (selfLine.startsWith('這些要你自己按') && selfLine.includes('發推播')) pass(`紅線收進清單最後一行：「${selfLine}」`)
  else fail(`清單最後一行是「${selfLine}」`)

  // ═══ ⑥ 標籤管理：標頭那顆＋建好標籤亮那一列 ════════════════════════════════
  await go('/tags', '.tags-table tbody tr')
  const tagHead = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.admin-header-actions .el-button')]
    return { texts: btns.map(b => b.textContent.trim()), rows: new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size }
  })
  if (tagHead.texts[0] === '用一句話建立' && tagHead.rows === 1) pass(`標籤頁標頭：${tagHead.texts.join('｜')}（一排）`)
  else fail(`標籤頁標頭：${JSON.stringify(tagHead)}`)
  await page.evaluate(() => document.querySelector('.admin-header-actions .agent-ask-btn')?.click())
  await waitUntil(() => page.evaluate(() => !!document.querySelector('.aa-chat__pills')), 8000)
  await resetFlashes()
  state.nextChat = { reply: '我打算這樣做。', toolCalls: [], messages: [], pendingOp: pendingOf('tag-create', '建一個標籤', 'fake-entry-5') }
  n0 = state.chatBodies.length
  await sendTyped('建一個標籤')
  await lastChatBody(n0)
  state.confirmHits = 0
  g0 = await confirmWith({ ok: true, opId: 'tag-create', label: '建一個標籤', message: '標籤建好了（守門員假回應）。', targetId: tag.id })
  // ⚠️ 標籤清單要連每顆的好友數一起算，正式資料上實測慢到十幾秒（2026-10-01 第 7 輪就是 10 秒等不到而假紅）
  if (await waitUntil(() => flashed(tag.id), 25_000)) pass(`標籤頁：「${tag.name}」那一列亮了`)
  else fail('標籤頁：那一列沒有亮')
  if (getsSince(g0, '/api/tag/list') > 0) pass('標籤清單真的重讀了')
  else fail('標籤清單沒有重讀')
  await shot('05-tags')

  // ═══ ⑦ 知識庫：「等你看過」那張卡亮了 ═══════════════════════════════════
  state.fakeDrafts = true
  await go('/knowledge/sources', '.agent-ask-row')
  await waitUntil(() => page.evaluate(() => !!document.querySelector('[data-agent-target="agent-check-card"]')), 20_000)
  await page.evaluate(() => document.querySelector('.agent-ask-row .agent-ask-btn')?.click())
  await waitUntil(() => page.evaluate(() => !!document.querySelector('.aa-chat__pills')), 8000)
  if ((await pillsHead()) === '在「知識庫」可以這樣跟我說') pass('知識庫頁：建議標題是「知識庫」')
  else fail(`知識庫頁的建議標題是「${await pillsHead()}」`)
  await resetFlashes()
  state.nextChat = { reply: '我打算這樣做。', toolCalls: [], messages: [], pendingOp: pendingOf('knowledge-draft-create', '補一張知識卡', 'fake-entry-6') }
  n0 = state.chatBodies.length
  await sendTyped('補一張知識卡')
  await lastChatBody(n0)
  state.confirmHits = 0
  g0 = await confirmWith({ ok: true, opId: 'knowledge-draft-create', label: '補一張知識卡', message: '放好了（守門員假回應）。', targetId: 'agent-check-card' })
  if (await waitUntil(() => flashed('agent-check-card'), 10_000)) pass('知識庫：「等你看過」裡那張卡亮了')
  else fail('知識庫：那張卡沒有亮')
  if (getsSince(g0, '/api/ai/knowledge/drafts') > 0) pass('「等你看過」真的重讀了')
  else fail('「等你看過」沒有重讀')
  state.fakeDrafts = false

  // ═══ ⑧ LINE 通知：等幾分鐘提醒那一張亮了 ═══════════════════════════════
  await go('/settings/line-notify', '[data-agent-target="handoff-sla"]')
  await openPanel()
  await showChat()
  if ((await pillsHead()) === '在「LINE 通知」可以這樣跟我說') pass('LINE 通知頁：建議標題是「LINE 通知」')
  else fail(`LINE 通知頁的建議標題是「${await pillsHead()}」`)
  await resetFlashes()
  state.nextChat = { reply: '我打算這樣做。', toolCalls: [], messages: [], pendingOp: pendingOf('ai-settings-handoff-sla', '調整「客人等太久」的提醒時間', 'fake-entry-7') }
  n0 = state.chatBodies.length
  await sendTyped('客人等超過 15 分鐘就提醒')
  await lastChatBody(n0)
  state.confirmHits = 0
  await confirmWith({ ok: true, opId: 'ai-settings-handoff-sla', label: '調整「客人等太久」的提醒時間', message: '改好了（守門員假回應）。' })
  if (await waitUntil(() => flashed('handoff-sla'), 8000)) pass('LINE 通知頁：「什麼時候通知」那一張亮了')
  else fail('LINE 通知頁：那一張沒有亮')

  // ═══ ⑨ 目前狀況的待辦卡：「交給小幫手」替他講那句話 ═════════════════════════
  state.fakeSetup = true
  await go('/conversations', '.ta-fab')
  // 換頁是整頁載入：面板關著。必要設定沒做＝紅的，打開就要自己展開（`D-114`「壞了的事先講」）
  await openPanel()
  if (await waitUntil(statusExpanded, 15_000)) pass('有必要設定沒做（紅的）：一打開就自動展開狀況')
  else fail(`紅的時候打開沒有自動展開（最上面那一條：${await page.evaluate(() => document.querySelector('.ta-strip')?.textContent?.trim())}）`)
  await expandStatus()
  const hasTodo = await waitUntil(() => page.evaluate(() => [...document.querySelectorAll('.ta-todo--split .ta-alert__act--primary')].some(b => b.textContent.includes('交給小幫手'))), 15_000)
  if (hasTodo) pass(`待辦卡上有「交給小幫手」：${await page.evaluate(() => [...document.querySelectorAll('.ta-todo--split .ta-todo__title')].map(t => t.textContent.trim()).join('、'))}`)
  else fail('「目前狀況」的待辦卡上沒有「交給小幫手」')
  await shot('06-status-todo')

  // 節慶卡：只有在節日前 7 天窗內才會出現（⛔ 不在窗內＝這關沒驗到，不算綠）
  const festival = await page.evaluate(() => {
    const card = document.querySelector('.ta-festival')
    if (!card) return null
    return { head: card.querySelector('.ta-festival__head')?.textContent?.trim() ?? '', btn: card.querySelector('.ta-alert__act--primary')?.textContent?.trim() ?? '' }
  })
  if (!festival) info('今天不在任何節日的 7 天窗內，節慶卡上的「交給小幫手擬草稿」這一輪沒驗到')
  else {
    if (festival.btn === '交給小幫手擬草稿') pass(`節慶卡「${festival.head}」上有「交給小幫手擬草稿」`)
    else fail(`節慶卡上的按鈕是「${festival.btn}」`)
    n0 = state.chatBodies.length
    await page.evaluate(() => document.querySelector('.ta-festival .ta-alert__act--primary')?.click())
    body = await lastChatBody(n0)
    if (/^幫我擬一則「.+」的推播草稿$/.test(body?.message ?? '') && body?.source === 'status-card') pass(`按了：替他講「${body.message}」，記成「目前狀況卡片」`)
    else fail(`按了節慶卡送出的是：${JSON.stringify(body)}`)
    await expandStatus()
    await waitUntil(() => page.evaluate(() => !!document.querySelector('.ta-todo--split')), 8000)
  }

  n0 = state.chatBodies.length
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.ta-todo--split')].find(c => c.textContent.includes('開啟 AI 自動回覆'))
    card?.querySelector('.ta-alert__act--primary')?.click()
  })
  body = await lastChatBody(n0)
  if (body?.message === '幫我打開 AI 自動回覆' && body?.source === 'status-card') pass('按了「交給小幫手」：替他講「幫我打開 AI 自動回覆」，記成「目前狀況卡片」')
  else fail(`按了「交給小幫手」送出的是：${JSON.stringify(body)}`)
  if (await waitUntil(chatVisible, 5000)) pass('而且狀況收起來、對話露出來了（看得到它在回什麼）')
  else fail('按了「交給小幫手」之後，對話沒露出來')
  if ((await pillsHead()) === '可以這樣跟我說') pass('沒有專屬建議的頁（客服對話）：標題不硬講頁名')
  else fail(`客服對話頁的建議標題是「${await pillsHead()}」`)
  state.fakeSetup = false

  // ═══ ⑩ 觀察者：一個「做」都看不到 ═══════════════════════════════════════
  state.fakeViewer = true
  await go('/ai-scripts', '.split-list-item')
  await sleep(1500)
  if (!await page.evaluate(() => !!document.querySelector('.agent-ask-row'))) pass('觀察者：自動回應頁沒有「用一句話建立」')
  else fail('觀察者看得到「用一句話建立」')
  await openPanel()
  await showChat()
  const viewer = await page.evaluate(() => ({
    dos: document.querySelectorAll('.aa-chip--do').length,
    asks: document.querySelectorAll('.aa-chip:not(.aa-chip--do)').length,
    all: !!document.querySelector('.aa-chat__all-toggle'),
  }))
  if (viewer.dos === 0 && viewer.asks > 0 && !viewer.all) pass('觀察者：只看得到「查」的建議，沒有「做」、沒有「我會做的 N 件」')
  else fail(`觀察者看到的建議：${JSON.stringify(viewer)}`)
  state.fakeViewer = false

  // ═══ ⑩½ 每頁的「？」：最下面那一行「看全部教學」真的打開全部教學（`D-114`：「教學」分頁拿掉了） ═══
  // 自動回應頁只有一支教學——以前這種頁的問號按了直接開跑、沒有選單，現在一律先出選單
  await go('/ai-scripts', '.page-help-btn')
  await page.evaluate(() => document.querySelector('.page-help-btn')?.click())
  const menu = await waitUntil(() => page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].some(i => i.offsetParent !== null && i.textContent.includes('看全部教學'))), 5000)
  const items = await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(i => i.offsetParent !== null).map(i => i.textContent.trim()))
  if (menu) pass(`自動回應頁的「？」先出選單：${items.join('｜')}`)
  else fail(`按了「？」沒有出現「看全部教學」：${JSON.stringify(items)}（導覽開了：${await page.evaluate(() => !!document.querySelector('.el-tour'))}）`)
  // 選單第一項＝這一頁的導覽，按了照樣開跑（以前這頁是按問號直接開跑；「記成看過」那支 POST 會被上面攔下＝零寫入）
  await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].find(i => i.offsetParent !== null && !i.textContent.includes('看全部教學'))?.click())
  const tourTitle = await waitUntil(() => page.evaluate(() => [...document.querySelectorAll('.ta-tour-title')].some(t => t.getBoundingClientRect().width > 0)), 10_000)
  if (tourTitle) pass(`按選單第一項：這一頁的導覽開跑了（「${await page.evaluate(() => [...document.querySelectorAll('.ta-tour-title')].find(t => t.getBoundingClientRect().width > 0)?.textContent?.trim())}」）`)
  else fail('按選單第一項，導覽沒有開跑')
  // 關掉導覽（右上角的叉），再從問號進全部教學
  for (let i = 0; i < 5 && await page.evaluate(() => [...document.querySelectorAll('.ta-tour-title')].some(t => t.getBoundingClientRect().width > 0)); i++) {
    await page.evaluate(() => document.querySelector('.el-tour__closebtn')?.click())
    await sleep(500)
  }
  await page.evaluate(() => document.querySelector('.page-help-btn')?.click())
  await waitUntil(() => page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].some(i => i.offsetParent !== null && i.textContent.includes('看全部教學'))), 5000)
  await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].find(i => i.offsetParent !== null && i.textContent.includes('看全部教學'))?.click())
  if (await waitUntil(() => page.evaluate(() => document.querySelector('.ta-catalogue__title')?.textContent?.trim() === '全部教學'), 8000)) pass('按「看全部教學」：小幫手打開、停在全部教學')
  else fail('按了「看全部教學」，小幫手沒有停在全部教學')
  const hCat = await panelHeight()
  await shot('08-catalogue')
  await page.evaluate(() => document.querySelector('.ta-catalogue__back')?.click())
  if (await waitUntil(() => page.evaluate(() => !!document.querySelector('.ta-strip') && !document.querySelector('.ta-catalogue')), 5000)) pass('「← 回到小幫手」回到狀況＋對話那一頁')
  else fail('按「← 回到小幫手」沒有回去')
  if (hCat === await panelHeight()) pass(`全部教學跟對話一樣高（${hCat}px）`)
  else fail(`全部教學 ${hCat}px，回來之後 ${await panelHeight()}px`)

  // ═══ ⑪ 390px：面板標頭與建議沒有擠爆（後台本身沒有手機版，但小幫手面板在手機上照樣會被打開） ═══
  await page.setViewport({ width: 390, height: 844 })
  await go('/ai-settings', '[data-agent-target="service-hours"]')
  await openPanel()
  await showChat()
  await sleep(500)
  const narrow = await page.evaluate(() => {
    const panel = document.querySelector('.ta-panel')?.getBoundingClientRect()
    const pills = document.querySelector('.aa-chat__pills')
    const chips = [...document.querySelectorAll('.aa-chip')]
    const name = document.querySelector('.ta-panel__name')
    const strip = document.querySelector('.ta-strip')
    return {
      panelW: Math.round(panel?.width ?? 0),
      // 2026-10-01 第一輪實測：「小幫手」被擠成直排三行（當時標頭還有三個分頁）
      nameOneLine: name ? name.getBoundingClientRect().height < parseFloat(getComputedStyle(name).fontSize) * 2 : false,
      nameFull: name ? name.scrollWidth <= name.clientWidth + 1 : false,
      // 高度固定之後，矮螢幕要靠「視窗高度扣掉按鈕」讓位，整片都要在畫面裡
      inViewport: panel ? panel.left >= 0 && panel.right <= window.innerWidth && panel.top >= 0 : false,
      stripFits: strip ? strip.scrollWidth <= strip.clientWidth + 1 : false,
      pillsOverflow: pills ? pills.scrollWidth > pills.clientWidth + 1 : null,
      chipOut: chips.some(c => c.getBoundingClientRect().right > (pills?.getBoundingClientRect().right ?? 0) + 1),
    }
  })
  if (narrow.inViewport && narrow.stripFits && !narrow.pillsOverflow && !narrow.chipOut && narrow.nameOneLine && narrow.nameFull)
    pass(`390px：面板 ${narrow.panelW}px 整片在畫面裡、「小幫手」一行沒被切、狀況那一條沒撐出去、建議沒有撐出去`)
  else fail(`390px：${JSON.stringify(narrow)}`)
  await shot('07-narrow')
}
catch (e) {
  fail(`跑到一半停下來了：${e?.message ?? e}`)
}
finally {
  await browser.close()
}

const agentWrites = state.blocked.filter(b => b.includes('/api/admin/agent'))
if (agentWrites.length) fail(`有小幫手的寫入沒被假回應接住：${agentWrites.join('；')}`)
info(state.blocked.length ? `攔下來沒送出的寫入（${state.blocked.length}）：${[...new Set(state.blocked)].join('；')}` : '整趟沒有任何寫入要攔')
console.log(failures ? `\n${failures} 關沒過` : '\n全部通過')
process.exit(failures ? 1 : 0)
