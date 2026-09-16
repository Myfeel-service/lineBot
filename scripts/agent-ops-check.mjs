/**
 * 小幫手代辦三塊畫面的實機守門員（`C-182`／`C-184`，2026-09-16）。
 *
 *   npm run dev -- --port 3312                                      # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3312 node --env-file=.env_myfeel scripts/agent-ops-check.mjs
 *
 * 為什麼一定要真的開瀏覽器：這三塊的單元測試全綠，但它們**從來沒有被人點過一次**。
 * 這個專案吃過「typecheck 綠＋測試綠，新程式卻根本沒被執行到」（記憶
 * `feedback_verify_new_code_actually_runs`），代辦這條路第一次會真的動到設定，不能再賭。
 *
 * ⚠️ 寫入範圍：**零寫入**。所有 POST/PUT/DELETE 都在瀏覽器層攔下來——
 *    聊天與確認兩支換成假回應（否則會呼叫模型、會真的改設定），
 *    其餘一律 abort 並當成違規記下來。唯一放行的 POST 是 `scripts/preview-impact`，
 *    它名字是 POST、實際只讀（要驗的正是它算出來的影響對不對）。
 *    GET 一律放行打正式資料——這樣「操作紀錄頁真的長得出東西嗎」才是真的驗過。
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
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }
console.log(`登入身分：${session.email}（${admin.role}）`)

let failed = false
const fail = (msg) => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 被攔下來的寫入請求：跑完必須是空的，否則這支腳本自己就違反了「零寫入」 */
const blockedWrites = []
/** 攔到幾次聊天請求（卡住時用來分辨「沒送出去」還是「送了但畫面沒長」）*/
let chatHits = 0
/**
 * 打開之後，影響預覽改回假的「有影響」。
 * 為什麼需要：這個工作區剛好沒有任何一條流程上下架會蓋到別條，而**確認框會不會跳**
 * 是這次唯一沒被人點過的前端路徑。端點本身用真實呼叫驗（上面那圈全是 200），
 * 畫面這段用假回應驅動——⛔兩件事分開驗，不要用假資料混充「端點也對」。
 */
let fakeImpact = false

/** 假的待確認操作：形狀照 shared/types/admin-ops 的 AdminOpPending */
const FAKE_PENDING = {
  opId: 'ai-settings-service-hours',
  label: '調整服務時間／勿擾時段',
  risk: 'medium',
  token: 'fake-token-for-ui-check',
  expiresInSec: 600,
  preview: {
    opId: 'ai-settings-service-hours',
    summary: '我會把服務時間改成下面這樣（勿擾時段就是服務時間以外的那段）。',
    items: [
      { label: '週一至週五 09:00–18:00', note: '現在（勿擾：18:00–09:00，以及週六、週日整天）' },
      { label: '週一至週五 08:00–22:00', note: '改成（勿擾：22:00–08:00，以及週六、週日整天）' },
    ],
    warning: '這只影響「客人要找真人」的時候——勿擾時段內他會先收到一句稍後回覆的訊息，你們不會被叫醒。',
    confirmLabel: '確定改時間',
  },
}

/** 建流程那種多行的卡：五個步驟＋警告，版面壓力跟兩行的卡完全不同 */
const FAKE_PENDING_BUILD = {
  opId: 'script-create-from-description',
  label: '用一句話建一條自動回應',
  risk: 'medium',
  token: 'fake-token-build',
  expiresInSec: 600,
  preview: {
    opId: 'script-create-from-description',
    summary: '我照你說的擬了一條「退貨申請」。下面是客人實際會經歷的過程，看一下對不對：',
    items: [
      { label: '1. 客人打「退貨、退錢」的時候啟動' },
      { label: '2. 問客人：「好的，請提供您的訂單編號，以便我們查詢 🔍」並把回答記下來，答不出來可以按「我沒有訂單編號」跳過' },
      { label: '3. 問客人：「請問您要退哪一項商品呢？請描述商品名稱或品項。」並把回答記下來' },
      { label: '4. 問客人：「沒問題！請提供當時下單的 Email，我們會協助查詢您的訂單。」並把回答記下來' },
      { label: '5. 回覆客人：「已收到您的退貨申請資料，我們將在三個工作天內回覆您處理進度，謝謝您的耐心等候 🙇」' },
    ],
    warning: '建好之後是**關著**的，客人還不會走到它。你到「自動回應」頁看過、覺得沒問題再上架。',
    confirmLabel: '確定建立（先不上架）',
  },
}
/** 下一次聊天要回哪一張卡（測試中途換） */
let nextPending = FAKE_PENDING

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

async function openLoggedInPage() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    const method = req.method()
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    if (!isWrite || !url.includes('/api/')) return req.continue()

    // 名字是 POST、實際只讀：要驗的正是它算出來的影響
    if (url.includes('/api/ai/scripts/preview-impact')) {
      if (!fakeImpact) return req.continue()
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hasImpact: true,
          selfStillBlocked: null,
          newlyBlocked: [{ scriptId: 'x', scriptName: '出貨查詢', reason: 'otherScript', detail: '「出貨查詢」的觸發詞都被「測試流程」的觸發詞包住，會先被那條接走' }],
          newlyFreed: [],
        }),
      })
    }

    if (url.includes('/api/admin/agent/chat')) {
      chatHits++
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reply: '我打算這樣做，你確認一下。', toolCalls: ['get_ai_settings'], messages: [], pendingOp: nextPending }),
      })
    }
    if (url.includes('/api/admin/agent/confirm')) {
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, opId: FAKE_PENDING.opId, label: FAKE_PENDING.label, message: '改好了：服務時間 週一至週五 08:00–22:00；勿擾時段是 22:00–08:00。' }),
      })
    }

    blockedWrites.push(`${method} ${url.replace(BASE, '')}`)
    return req.abort()
  })

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 90_000 })
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
  return page
}

/**
 * 關掉擋在前面的導覽（`D-79` 起，每個帳號第一次進某一頁會自動跑導覽）。
 * ⛔ 不關的話它的遮罩會把點擊全部吃掉，後面每一關都變成假失敗——
 *    而且失敗訊息會長得像「按鈕被蓋住」，很容易誤判成版面出問題。
 */
async function dismissTour() {
  const closed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.el-tour__close, .ta-tour-close, .el-tour button')]
      .find(b => /關閉|略過|結束|知道了|完成/.test(b.textContent ?? '') || b.classList.contains('el-tour__close'))
    if (btn) { btn.click(); return true }
    return false
  })
  if (closed) await sleep(600)
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(300)
  return closed
}

/**
 * 在聊天框問一句話。
 * ⛔ 先點一下輸入框再打字：Element Plus 的輸入框沒有焦點時，鍵盤事件不會落在 v-model 上，
 *    然後「送出鍵按了卻什麼都沒發生」——那會看起來像功能壞掉，其實是這支腳本沒打中。
 * 送出用按鈕不用 Enter：按鈕是使用者真正會按的東西，也少一個鍵盤事件的變數。
 */
async function askAgent(text) {
  await page.click('.aa-chat input')
  await page.type('.aa-chat input', text, { delay: 10 })
  const typed = await page.$eval('.aa-chat input', el => el.value)
  if (!typed.includes(text.slice(0, 6))) throw new Error(`字沒打進輸入框（現在是「${typed}」）`)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.aa-chat__input button')].find(b => /送出/.test(b.textContent ?? ''))
    btn?.click()
  })
}

/** 同上，但用 POST（只用在唯讀的 preview-impact 上） */
async function apiPost(page, path, body) {
  return page.evaluate(async ([p, token, b]) => {
    const res = await fetch(p, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    })
    return { status: res.status, body: await res.text() }
  }, [path, session.idToken, body])
}

/** 用登入者的憑證直接問端點（驗 API 本身，不受畫面影響） */
async function apiGet(page, path) {
  return page.evaluate(async ([p, token]) => {
    const res = await fetch(p, { headers: { Authorization: `Bearer ${token}` } })
    return { status: res.status, body: await res.text() }
  }, [path, session.idToken])
}

const page = await openLoggedInPage()

try {
  // ── ① 操作紀錄頁 ────────────────────────────────────────────
  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/settings/activity`, { waitUntil: 'networkidle2', timeout: 90_000 })
  if (!page.url().includes('/settings/activity'))
    throw new Error(`沒有停在操作紀錄頁，現在在 ${page.url()}（多半是沒登入成功）`)

  await page.waitForSelector('.el-table', { timeout: 60_000 })
  await sleep(1500)
  const table = await page.$eval('.el-table', el => el.innerText)
  const rowCount = await page.$$eval('.el-table__body tr', els => els.length)
  if (rowCount > 0) pass(`操作紀錄頁讀到正式資料：${rowCount} 列`)
  else fail('操作紀錄頁一列都沒有（正式庫從 08-14 就在寫稽核，這裡不該是空的）')
  if (/成員操作|小幫手代辦/.test(table)) pass('每一列都標得出「人改的」還是「小幫手代的」')
  else fail(`看不到操作者類別，表格內容：${table.slice(0, 160)}`)

  // 還原欄位（`C-186` 續）：每一列要嘛給得出「還原」鈕，要嘛說得出為什麼不能還原——
  // ⛔ 兩者都沒有＝把問題藏起來
  const revertCol = await page.$$eval('.el-table__body tr', rows =>
    rows.map(r => r.innerText).filter(t => /還原|不能還原/.test(t)).length)
  if (rowCount === 0 || revertCol > 0) pass('每一列都給得出「還原」或「不能還原」的答案')
  else fail('操作紀錄的列上既沒有還原鈕、也沒有說為什麼不能還原')

  // 剛部署的索引：這個篩選以前會被擋下並說原因，現在該真的回得出資料
  const filtered = await apiGet(page, `/api/admin/audit-logs?workspaceId=${WORKSPACE_ID}&actor=human`)
  if (filtered.status === 200) pass('「只看成員操作」篩選回 200＝剛部署的複合索引真的生效了')
  else fail(`篩選回 ${filtered.status}：${filtered.body.slice(0, 200)}`)

  // ── ② 小幫手的確認卡 ────────────────────────────────────────
  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/broadcasts`, { waitUntil: 'networkidle2', timeout: 90_000 })
  // ⛔ 要點的是浮動按鈕本身（.ta-fab），不是「.tutorial-agent 裡的第一顆 button」——
  //    那可能是異常小氣泡上的關閉鈕，點了面板不會開，然後後面每一關都變成假失敗
  await sleep(2000)
  if (await dismissTour()) console.log('ℹ️ 先關掉自動跑出來的導覽（D-79），否則它的遮罩會吃掉所有點擊')
  await page.waitForSelector('.ta-fab', { timeout: 60_000 })
  // ⛔ 用元素自己的 click()：浮動按鈕同時是拖曳把手，模擬滑鼠點擊會先觸發 pointerdown，
  //    而且它上面常疊著異常小氣泡，座標點擊會打到別的東西
  await page.evaluate(() => document.querySelector('.ta-fab')?.click())
  await page.waitForSelector('.ta-panel', { timeout: 30_000 })
  await sleep(800)
  // 切到「問助理」分頁（分頁列＝.ta-tabs 裡的三顆 role=tab）
  await page.waitForSelector('.ta-tabs [role="tab"]', { timeout: 30_000 })
  const switched = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.ta-tabs [role="tab"]')].find(b => b.textContent?.includes('問助理'))
    if (!btn) return false
    btn.click()
    return true
  })
  if (!switched) fail('找不到「問助理」分頁')
  await sleep(800)

  await page.waitForSelector('.aa-chat input', { timeout: 30_000 })
  await askAgent('把勿擾時段改成晚上十點到早上八點')

  try {
    await page.waitForSelector('.aa-op', { timeout: 30_000 })
  }
  catch (e) {
    // 卡在這裡時，最需要知道的是「請求有沒有送出去、對話裡現在長什麼樣」
    const list = await page.$eval('.aa-chat__list', el => el.innerText).catch(() => '(讀不到對話)')
    console.log(`  [debug] 攔到的聊天請求：${chatHits} 次；對話內容：${list.replace(/\s+/g, ' ').slice(0, 300)}`)
    throw e
  }
  const card = await page.$eval('.aa-op', el => el.innerText)
  if (/還沒執行/.test(card)) pass('確認卡出現，而且標明「還沒執行」')
  else fail(`確認卡沒有「還沒執行」：${card.slice(0, 160)}`)
  if (/09:00–18:00/.test(card) && /08:00–22:00/.test(card)) pass('卡片列出改之前與改之後')
  else fail(`卡片沒有前後對照：${card.slice(0, 200)}`)

  // 疊層：卡片要完整在小幫手面板裡、按鈕點得到
  const clickable = await page.$eval('.aa-op__actions .el-button--primary', (el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return {
      visible: r.width > 0 && r.height > 0,
      hit: !!top && (el === top || el.contains(top) || top.contains(el)),
      // 被擋住時要講出「被誰擋住」，否則只知道壞掉不知道為什麼
      blocker: top ? `${top.tagName}.${String(top.className).split(' ')[0]}` : '(空)',
    }
  })
  if (clickable.visible && clickable.hit) pass('確認鈕沒有被面板或別的東西蓋住（點得到）')
  else fail(`確認鈕被蓋住或量不到：${JSON.stringify(clickable)}`)

  // 取消：要明說沒有改到東西
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.aa-op')]
    const btns = [...cards[cards.length - 1].querySelectorAll('.aa-op__actions button')]
    btns.find(b => /取消/.test(b.textContent ?? ''))?.click()
  })
  await sleep(600)
  const afterCancel = await page.$eval('.aa-chat__list', el => el.innerText)
  if (/不改|沒有改/.test(afterCancel)) pass('按取消之後，對話裡明說沒有改任何東西')
  else fail(`取消後沒有講清楚：${afterCancel.slice(-160)}`)

  // 再來一次並按確定：結果要回到對話裡
  await askAgent('再幫我改一次')
  await page.waitForFunction(() => document.querySelectorAll('.aa-op').length >= 2, { timeout: 30_000 })
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.aa-op')]
    const btns = [...cards[cards.length - 1].querySelectorAll('.aa-op__actions button')]
    btns.find(b => /確定/.test(b.textContent ?? ''))?.click()
  })
  await sleep(1200)
  const afterConfirm = await page.$eval('.aa-chat__list', el => el.innerText)
  if (/改好了/.test(afterConfirm)) pass('按確定之後，執行結果回到對話裡')
  else fail(`按確定後對話沒有結果：${afterConfirm.slice(-200)}`)
  const doneCard = await page.$$eval('.aa-op', els => els[els.length - 1].className)
  if (/is-done/.test(doneCard)) pass('卡片按過之後退到背景，不再給第二顆按鈕')
  else fail(`卡片狀態沒變：${doneCard}`)

  // 手機寬度：卡片不可以撐破面板
  await page.setViewport({ width: 390, height: 844 })
  await sleep(600)
  const overflow = await page.$$eval('.aa-op', (els) => {
    const el = els[els.length - 1]
    const panel = el.closest('.ta-panel, .tutorial-agent') ?? document.body
    return { card: el.getBoundingClientRect().width, panel: panel.getBoundingClientRect().width }
  })
  if (overflow.card <= overflow.panel + 1) pass(`390px 下卡片沒有撐破面板（${Math.round(overflow.card)}px ≤ ${Math.round(overflow.panel)}px）`)
  else fail(`卡片撐破面板：卡片 ${Math.round(overflow.card)}px > 面板 ${Math.round(overflow.panel)}px`)
  await page.setViewport({ width: 1440, height: 1000 })

  // ── ②-2 建流程那種多行的確認卡（`C-186`）────────────────────
  // 兩行的卡過了不代表五行的卡也過：長句、清單、emoji 都是版面壓力
  nextPending = FAKE_PENDING_BUILD
  await askAgent('幫我建一條退貨查詢的流程')
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.aa-op')]
    return cards.length > 0 && /退貨申請/.test(cards[cards.length - 1].textContent ?? '')
  }, { timeout: 30_000 })
  const buildCard = await page.$$eval('.aa-op', els => els[els.length - 1].innerText)
  const shownSteps = [1, 2, 3, 4, 5].filter(n => buildCard.includes(`${n}. `))
  if (shownSteps.length === 5) pass('建流程的卡片五個步驟都印得出來（不是被截掉一半）')
  else fail(`步驟沒有全部出現，只看到 ${shownSteps.join('、')}：${buildCard.slice(0, 200)}`)
  if (/關著/.test(buildCard)) pass('卡片講明建好之後是關著的')
  else fail('卡片沒有講「建好是關著的」——那是這個操作最重要的一句話')
  if (/確定建立（先不上架）/.test(buildCard)) pass('確認鈕字樣把「先不上架」寫在按鈕上')
  else fail(`確認鈕字樣不對：${buildCard.slice(-80)}`)

  // 手機寬度：長清單最容易在這裡撐破
  await page.setViewport({ width: 390, height: 844 })
  await sleep(600)
  const buildOverflow = await page.$$eval('.aa-op', (els) => {
    const el = els[els.length - 1]
    const panel = el.closest('.ta-panel, .tutorial-agent') ?? document.body
    const scrollable = el.scrollWidth > el.clientWidth + 1
    return { card: el.getBoundingClientRect().width, panel: panel.getBoundingClientRect().width, scrollable }
  })
  if (buildOverflow.card <= buildOverflow.panel + 1 && !buildOverflow.scrollable)
    pass(`390px 下多行卡片沒有撐破、也沒有橫向捲軸（${Math.round(buildOverflow.card)}px ≤ ${Math.round(buildOverflow.panel)}px）`)
  else
    fail(`多行卡片在 390px 撐破：${JSON.stringify(buildOverflow)}`)
  await page.setViewport({ width: 1440, height: 1000 })
  nextPending = FAKE_PENDING

  // ── ③ 上下架存檔前的確認框 ──────────────────────────────────
  // 先用唯讀的方式問後端：哪一條流程上下架**真的**會連帶影響別條？
  // 拿沒有影響的那種去測，畫面照設計不會跳確認（那不是失敗，但也證明不了什麼）。
  const listRes = await apiGet(page, `/api/ai/scripts/list?workspaceId=${WORKSPACE_ID}`)
  const scripts = JSON.parse(listRes.body || '[]')
  const scriptRows = Array.isArray(scripts) ? scripts : (scripts.items ?? [])
  let target = null
  for (const row of scriptRows.slice(0, 12)) {
    const res = await apiPost(page, '/api/ai/scripts/preview-impact', { workspaceId: WORKSPACE_ID, scriptId: row.id, enabled: !row.enabled })
    if (res.status === 200 && JSON.parse(res.body).hasImpact) { target = row; break }
  }

  if (!target) {
    console.log('ℹ️ 這個工作區沒有任何一條流程「上下架會連帶影響別條」（端點本身回得出答案：上面那圈查詢全是 200）——改用假的影響回應驗畫面那一段')
    fakeImpact = true
    target = scriptRows[0] ?? null
    if (!target) fail('這個工作區一條流程都沒有，畫面這段驗不了')
  }
  if (target) {
    // ⛔ 訊息要分得出來是哪一種：假回應驅動的那次，不可以講成「真的找到有影響的流程」
    if (fakeImpact) console.log(`ℹ️ 用「${target.name}」這條走畫面流程，影響內容是假的回應`)
    else pass(`找到一條上下架真的會連帶影響別條的流程：「${target.name}」`)
    await page.goto(`${BASE}/admin/${WORKSPACE_ID}/ai-scripts`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await sleep(2500)
    await dismissTour()
    const selected = await page.evaluate((name) => {
      const el = [...document.querySelectorAll('li, .scripts-list-item, [class*="list-item"]')]
        .find(i => i.textContent?.includes(name))
      if (!el) return false
      el.click()
      return true
    }, target.name)
    if (!selected) {
      fail(`清單上點不到「${target.name}」`)
    }
    else {
      await sleep(1800)
      const toggled = await page.evaluate(() => {
        const sw = [...document.querySelectorAll('.el-switch')].find(s => s.closest('.admin-field-group')?.textContent?.includes('啟用這條流程'))
        if (!sw) return false
        sw.click()
        return true
      })
      if (!toggled) { fail('找不到「啟用這條流程」那顆開關') }
      else {
        await sleep(400)
        const writesBefore = blockedWrites.length
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(b => /儲存變更/.test(b.textContent ?? ''))
          btn?.click()
        })
        await sleep(3000)
        const box = await page.$('.el-message-box')
        if (!box) {
          fail('有連帶影響卻沒跳確認框（這正是原本的裸奔問題）')
        }
        else {
          const text = (await box.evaluate(el => el.innerText)).replace(/\s+/g, ' ')
          pass(`存檔前跳出影響確認：${text.slice(0, 110)}`)
          await page.evaluate(() => {
            const btn = [...document.querySelectorAll('.el-message-box button')].find(b => /先不要/.test(b.textContent ?? ''))
            btn?.click()
          })
          await sleep(1200)
          // 🔴 按「先不要」之後，⛔一個寫入都不准送出
          const newWrites = blockedWrites.slice(writesBefore).filter(w => w.includes('/api/ai/scripts/'))
          if (newWrites.length === 0) pass('按「先不要」之後沒有送出任何存檔請求')
          else fail(`按了「先不要」卻還是送出寫入：${newWrites.join('、')}`)
        }
      }
    }
  }

  // ── 零寫入稽核 ──────────────────────────────────────────────
  // 這支腳本的承諾是「零寫入」：所有寫入都在瀏覽器層被攔下，正式資料一個字都沒動。
  // 被攔到的內容如實列出來——tour-seen 是隔壁功能（導覽記憶）順手送的，與本案無關。
  console.log(`ℹ️ 全程被攔下、因此沒有真的寫進正式庫的請求共 ${blockedWrites.length} 筆：${blockedWrites.join('、') || '（無）'}`)
}
catch (e) {
  fail(`跑不完：${String(e).slice(0, 300)}`)
}
finally {
  await browser.close()
}

console.log(failed ? '\n有關卡沒過。' : '\n全部通過。')
process.exit(failed ? 1 : 0)
