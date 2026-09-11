/**
 * 「搜尋對話內容」的實機守門員（`H-30`）。
 *
 *   npm run dev                                          # 另一個終端先跑起來
 *   node --env-file=.env_myfeel scripts/conv-content-search-check.mjs
 *
 * 為什麼要有這支：這個專案吃過「typecheck 綠＋既有測試綠，但新程式根本沒被執行到」
 * （見記憶 `feedback_verify_new_code_actually_runs`）。純函式測得到的是片段怎麼切
 * （`shared/message-search.test.ts`）與端點怎麼答（`search-messages.get.test.ts`），
 * 但「打字之後畫面有沒有真的多一區、239px 的側欄有沒有被一句長訊息撐破、點下去有沒有
 * 真的跳到那一則」只有開一次瀏覽器才知道。
 *
 * ⛔ 這支**完全不寫任何資料**：
 *    · Admin SDK 只讀（找一位成員換登入 token、讀一則現成訊息當點擊目標）。
 *    · 瀏覽器只走查詢與讀取端點；點開對話會在**這個暫時瀏覽器設定檔**的 localStorage
 *      留下已讀章，關掉就沒了。
 * ⚠️ 第 ③ 段刻意攔截 `/api/conversations/search-messages` 回一筆**指向真實對話的**假結果：
 *    回填還沒跑之前正式資料上找不到任何內容命中，但「點結果 → 跳到那一則」這條路
 *    必須先驗過。被攔的只有搜尋那一支，跳轉、時間軸、highlight 全部是真的。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL
/** 拿來打字的關鍵字（兩個字以上才會走內容搜尋） */
const KEYWORD = process.env.CHECK_KEYWORD ?? '訂單'

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
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
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }
console.log(`登入身分：${session.email}（${admin.role}）`)

/**
 * 找一則**真的存在**的舊訊息當點擊目標（愈舊愈好：搜尋的價值就在於跳到翻不到的地方）。
 * 只讀不寫。
 */
const convSnap = await db.collection('conversations')
  .where('workspaceId', '==', WORKSPACE_ID)
  .orderBy('lastMessageAt', 'desc')
  .limit(1)
  .get()
if (convSnap.empty) { console.error('這個工作區還沒有任何對話，這支驗不了'); process.exit(1) }
const convDoc = convSnap.docs[0]
const msgSnap = await convDoc.ref.collection('messages').orderBy('timestamp', 'asc').limit(60).get()
if (msgSnap.empty) { console.error('這條對話一則訊息都沒有，這支驗不了'); process.exit(1) }

/**
 * 兩種目標各驗一次，因為它們在畫面上是**兩種東西**：
 *  · 一般訊息   → 泡泡（.conv-bubble-row）
 *  · 客人動作   → 事件行（.conv-timeline-event--action）——資料上仍是一則訊息，搜得到，
 *                 所以也要跳得到。這一條 2026-09-11 就是靠這支守門員抓出來的。
 */
const pickOldest = pred => msgSnap.docs.find(d => pred(d.data()))
const targets = [
  { kind: '一般訊息', doc: pickOldest(m => m.messageType !== 'customer_action' && String(m.text ?? '').trim()) },
  { kind: '客人動作', doc: pickOldest(m => m.messageType === 'customer_action') },
].filter(t => t.doc)
if (!targets.length) { console.error('這條對話沒有可用的訊息，這支驗不了'); process.exit(1) }
for (const t of targets) {
  console.log(`點擊目標（${t.kind}）：${t.doc.id}｜「${String(t.doc.data().text ?? '').trim().slice(0, 24)}」`)
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
const pageErrors = []
page.on('pageerror', (e) => { pageErrors.push(String(e).slice(0, 200)); console.log('  [page error]', String(e).slice(0, 200)) })

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
await page.evaluate(async (s) => {
  const user = {
    uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'google.com', uid: s.email, displayName: null, email: s.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
    createdAt: String(Date.now() - 86400_000), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]',
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

const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 側欄現況：內容搜尋那一區長什麼樣、有沒有破版 */
const snapshot = () => page.evaluate(() => {
  const box = el => (el ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }))(el.getBoundingClientRect()) : null)
  const list = document.querySelector('.split-list')
  const sidebar = document.querySelector('.split-sidebar') ?? document.querySelector('.conv-search-bar')?.parentElement
  return {
    placeholder: document.querySelector('.conv-search-bar input')?.placeholder ?? null,
    groupHeader: [...document.querySelectorAll('.conv-list-group--static')].map(el => el.innerText.trim()),
    hitRows: [...document.querySelectorAll('.conv-hit-row')].map(r => ({
      text: r.innerText.replace(/\n/g, ' ｜ ').slice(0, 60),
      mark: r.querySelector('.conv-hit-mark')?.innerText ?? null,
      ...box(r),
      // 可壓縮欄破版的量法：命中那一行有沒有超出自己的盒子（省略號沒生效就會撐出去）
      hitOverflow: (() => {
        const t = r.querySelector('.conv-hit-text')
        return t ? t.scrollWidth > t.clientWidth + 1 : null
      })(),
    })),
    notices: [...document.querySelectorAll('.conv-list-notice')].map(el => el.innerText.trim()),
    nameRows: document.querySelectorAll('.conv-list-row:not(.conv-hit-row)').length,
    /** 名字那一區列出來的名字：要跟搜尋框對得上，對不上就是清單停在上一個關鍵字 */
    nameTitles: [...document.querySelectorAll('.conv-list-row:not(.conv-hit-row) .split-list-name')].map(e => e.innerText.trim()),
    searchValue: document.querySelector('.conv-search-bar input')?.value ?? '',
    listOverflow: list ? list.scrollWidth > list.clientWidth + 1 : null,
    listBox: box(list),
    sidebarBox: box(sidebar),
    // 泡泡與「客人動作」事件行兩種都算：後者在資料上也是一則訊息，一樣搜得到、跳得到
    highlighted: [...document.querySelectorAll('.conv-bubble-row.is-search-hit, .conv-timeline-event.is-search-hit')].map(el => ({
      id: el.getAttribute('data-msg-id'),
      text: el.innerText.replace(/\n/g, ' ').slice(0, 40),
      ...box(el),
    })),
    messagesBox: box(document.querySelector('.conv-messages')),
  }
})

/**
 * 把搜尋框清空再打字。
 * ⛔ 不要用 click(clickCount:3)+Backspace 清：Element Plus 的 input 選取範圍不一定吃得到，
 *    上一輪的字會留著（實測打出「訂訂單」，整支測試就驗到一個不存在的關鍵字）。
 *    改成直接設值 + 派 input 事件，Vue 的 v-model 才會真的更新。
 */
const typeSearch = async (text) => {
  await page.evaluate(() => {
    const input = document.querySelector('.conv-search-bar input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(400)
  if (text) await page.type('.conv-search-bar input', text, { delay: 30 })
}

await page.bringToFront()
await page.goto(`${BASE}/admin/${WORKSPACE_ID}/conversations`, { waitUntil: 'networkidle2', timeout: 90_000 })
await page.waitForSelector('.conv-list-row', { timeout: 60_000 })
await sleep(1200)

// ── ① 搜尋框本身 ──────────────────────────────────────────────────
const idle = await snapshot()
console.log(`\n① 搜尋框提示：「${idle.placeholder}」`)
if (!String(idle.placeholder ?? '').includes('對話內容')) {
  fail('搜尋框沒說它也找得到對話內容＝沒有人會知道這個功能存在')
}
if (idle.groupHeader.length) fail('沒在搜尋時就出現了內容搜尋那一區')

// ── ② 真的打字：端點有沒有被呼叫、回什麼 ───────────────────────────
/**
 * 直接收「畫面自己那一次呼叫」的回應內容。
 * ⛔ 不要拿到 URL 之後自己再 fetch 一次：那一次沒有帶登入 token，回的是 401，
 *    整段就會拿一個假的「查不到」去下結論。
 */
const apiCalls = []
page.on('response', async (res) => {
  const url = res.url()
  if (!url.includes('/api/conversations/')) return
  const entry = { url: url.replace(/^https?:\/\/[^/]+/, ''), status: res.status(), body: null }
  if (url.includes('search-messages')) {
    entry.body = await res.json().catch(() => null)
  }
  apiCalls.push(entry)
})
const searchCalls = () => apiCalls.filter(c => c.url.includes('search-messages'))
await typeSearch(KEYWORD)
await sleep(5000)
const searched = await snapshot()
const apiBody = searchCalls().filter(c => c.body).slice(-1)[0]?.body ?? null
console.log(`\n② 打「${KEYWORD}」：端點被呼叫 ${searchCalls().length} 次（${searchCalls().map(c => c.status).join('/')}）`)
console.log(`   端點回答：status=${apiBody?.status} 命中 ${apiBody?.rows?.length ?? '?'} 位｜掃 ${apiBody?.scanned} 則｜truncated=${apiBody?.truncated}｜回填=${JSON.stringify(apiBody?.backfill)}`)
console.log(`   區塊標題：${searched.groupHeader.join('　') || '（沒有）'}`)
console.log(`   說明行：${searched.notices.map(n => `「${n}」`).join('　') || '（沒有）'}`)
if (!searchCalls().length) fail('打了字卻沒有呼叫內容搜尋端點＝前端根本沒接上（就是「按了沒反應」那種）')
if (!searched.groupHeader.length) fail('搜尋中卻沒有「講過這句話的對話」那一區')
if (apiBody?.status === 'unavailable' && !searched.notices.some(n => n.includes('索引'))) {
  fail('端點說索引沒建好，畫面卻沒講——那會被讀成「沒有人講過」')
}
if (apiBody?.status === 'ok' && !apiBody.rows?.length && !searched.notices.some(n => n.includes('沒有'))) {
  fail('沒有命中卻連一句說明都沒有')
}
if (searched.listOverflow) fail('清單橫向溢出（側欄 overflow 是 clip＝直接看不見，不會有捲軸）')

// ── ②b 一個字：要說「要兩個字」，不可以說「沒有」─────────────────────
await typeSearch('訂')
await sleep(5000)
const oneChar = await snapshot()
console.log(`\n②b 只打一個字：${oneChar.notices.map(n => `「${n}」`).join('　') || '（沒有說明）'}`)
if (!oneChar.notices.some(n => n.includes('兩個字'))) {
  fail('一個字的時候沒有說「要兩個字以上」＝看起來像搜不到')
}

// ── ③ 點一筆結果 → 真的跳到那一則 ──────────────────────────────────
// 回填還沒跑之前正式資料找不到命中，所以這一段用假的搜尋回應（指向真實對話與真實訊息），
// 點下去之後的每一步都是真的
let fakeRow = null
await page.setRequestInterception(true)
page.on('request', (req) => {
  if (fakeRow && req.url().includes('/api/conversations/search-messages')) {
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeRow) })
    return
  }
  req.continue()
})

for (const target of targets) {
  const doc = target.doc
  const text = String(doc.data().text ?? '').trim() || '（沒有文字）'
  fakeRow = {
    status: 'ok',
    rows: [{
      userId: convDoc.id,
      displayName: '（守門員測試）',
      pictureUrl: '',
      messageId: doc.id,
      timestamp: doc.data().timestamp,
      direction: doc.data().direction === 'outgoing' ? 'outgoing' : 'incoming',
      matchCount: 2,
      snippet: { before: text.slice(0, 6), match: text.slice(6, 10) || '命中', after: text.slice(10, 60), cutHead: true, cutTail: true },
    }],
    scanned: 1,
    truncated: false,
    oldestScannedMs: 0,
    backfill: { done: true, indexedFromMs: Date.now() - 180 * 86400_000 },
  }

  // 每一輪都先清空再打字：不清的話畫面停在上一輪選中的對話上，驗不出這一次有沒有真的跳
  await typeSearch('')
  await sleep(1200)
  await typeSearch(KEYWORD)
  await sleep(5000)
  const withRow = await snapshot()
  console.log(`\n③ ${target.kind}：假結果一筆 ${withRow.hitRows.map(r => `「${r.text}」${r.width}px`).join('　') || '（沒有列）'}`)
  /**
   * 名字那一區要跟搜尋框對得上。對不上＝清單停在上一個關鍵字（打字打太快時
   * 後來那一次載入被丟掉），畫面會同時顯示兩個不同搜尋的結果。
   */
  const stale = withRow.nameTitles.filter(t => !t.includes(withRow.searchValue))
  if (stale.length) {
    fail(`搜尋框是「${withRow.searchValue}」，名字區卻列著 ${withRow.nameTitles.length} 位對不上的（例如「${stale[0]}」）＝清單停在上一次的搜尋`)
  }
  if (!withRow.hitRows.length) { fail('有結果卻沒有渲染出任何一列＝樣板沒接上'); continue }
  for (const r of withRow.hitRows) {
    const limit = (withRow.sidebarBox?.x ?? 0) + (withRow.sidebarBox?.width ?? 0)
    if (r.x + r.width > limit + 1) fail(`結果列右緣 ${r.x + r.width} 超出側欄 ${limit}＝破版`)
    if (r.hitOverflow) fail('命中那一行沒有被省略號截斷，長訊息會把側欄撐破')
    if (!r.mark) fail('命中的字沒有被標起來＝看不出自己為什麼搜到這一列')
  }

  const callsBeforeClick = apiCalls.length
  await page.click('.conv-hit-row .split-list-item')
  await sleep(6000)
  const opened = await snapshot()
  // 點下去之後打了哪幾支端點：沒跳成功時要看得出是「沒發請求」還是「請求回了錯的東西」
  console.log(`   端點：${apiCalls.slice(callsBeforeClick).map(c => `${c.status} ${c.url.replace('/api/conversations/', '').split('?')[0]}`).join('　') || '（一支都沒有）'}`)
  const toast = await page.evaluate(() => document.querySelector('.el-message')?.innerText?.trim() ?? null)
  if (toast) console.log(`   畫面提示：「${toast}」`)
  console.log(`   標起來的：${opened.highlighted.map(h => `${h.id}「${h.text}」`).join('') || '（一則都沒有）'}`)
  if (!opened.highlighted.length) {
    fail(`${target.kind}：點了搜尋結果，對話裡沒有任何一則被標起來＝沒跳到那一則（等於點了沒反應）`)
    continue
  }
  const hit = opened.highlighted[0]
  if (hit.id !== doc.id) fail(`${target.kind}：標起來的是 ${hit.id}，不是搜尋結果那一則 ${doc.id}`)
  const mid = (opened.messagesBox?.y ?? 0) + (opened.messagesBox?.height ?? 0) / 2
  const hitMid = hit.y + hit.height / 2
  const offset = Math.abs(hitMid - mid)
  console.log(`   位置：那一則中心 y=${Math.round(hitMid)}、對話區中心 y=${Math.round(mid)}（差 ${Math.round(offset)}px）`)
  // 置中允許一點誤差（上面還有「載入更早」那一列、圖片載入後會微調）
  if (offset > (opened.messagesBox?.height ?? 0) / 2) {
    fail(`${target.kind}：那一則不在畫面中央附近＝捲動沒真的帶到位`)
  }
}
fakeRow = null
const shot = join(tmpdir(), `conv-content-search-${process.pid}.png`)
await page.screenshot({ path: shot })
console.log(`   截圖：${shot}`)

if (pageErrors.length) fail(`瀏覽器主控台有 ${pageErrors.length} 個錯誤`)

await browser.close()
console.log(process.exitCode ? '\n有項目沒過（見上面的 ❌）' : '\n全部通過')
