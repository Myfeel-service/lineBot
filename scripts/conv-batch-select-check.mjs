/**
 * 對話列表「勾選批次處理」的實機守門員。
 *
 *   PORT=3117 npm run dev                                  # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3117 node --env-file=.env_myfeel scripts/conv-batch-select-check.mjs
 *
 * 為什麼要有這支：typecheck 綠＋既有測試綠**不代表新程式被執行過**（見記憶
 * `feedback_verify_new_code_actually_runs`）。這次新加的東西剛好全中那幾種盲區：
 *   · 勾選框是有條件渲染的 → 「按了沒反應」只有真的點一次才知道。
 *   · 列變成 flex 多一欄 → 破版可能**看不見**（側欄 overflow 被裁掉，連捲軸都不出現），
 *     所以要**量盒模型**，不是看截圖順不順眼。
 *   · 批次動作的回報 UI（略過／失敗逐筆列名字）在成功路徑上看不到 → 要故意餵失敗才驗得到。
 *
 * ⛔ **這支不寫任何正式資料**：登入與清單是唯讀，兩支批次端點（batch-close／batch-flags）
 *    在瀏覽器層被攔下來改用假回應，所以「按下去」只驗到請求有不有送出、畫面有沒有照回報長出來，
 *    沒有任何一場真的客人對話被結束、也沒有任何標記被寫進去。
 *    ⚠️ 真的要驗寫入路徑，請自己拿一場測試會話手動按一次（那才是會動到正式資料的動作）。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

const members = await getFirestore().collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
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
console.log(`登入身分：${session.email}（${admin.role}）｜站台 ${BASE}`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))

/**
 * ⛔ 攔下兩支批次端點：這支守門員跑的是**正在營業的正式帳號**，真的送出去就會關掉
 *    客人的對話。攔下來改回假答案，才能同時驗到「請求有送出」與「回報 UI 長得對」。
 */
const sent = []
/** `sent` 每個情境會被清空重數，所以總數要另外記——最後那句「攔到幾筆」不可以只印最後一段的 */
let interceptedTotal = 0
let fakeResponder = null
await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()
  const isBatch = url.includes('/api/conversations/sessions/batch-close')
    || url.includes('/api/conversations/batch-flags')
  if (!isBatch) { void req.continue(); return }
  const body = req.postData() ?? ''
  sent.push({ url: url.replace(BASE, ''), body })
  interceptedTotal++
  const payload = fakeResponder ? fakeResponder(JSON.parse(body || '{}')) : { requested: 0, done: 0, skipped: [], failed: [], doneIds: [] }
  void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
})

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

const fail = msg => { console.error(`❌ ${msg}`); process.exitCode = 1 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 開對話頁。
 *
 * ⚠️ dev server 第一次編譯這一頁時 Vite 會「新依賴最佳化完成 → 整頁重載」，
 * 正在等選擇器的那個 frame 會被抽掉（`frame got detached`）。所以重試兩次，
 * 而且失敗時把當下網址與畫面上的字印出來——不然只會看到一段看不懂的 puppeteer stack。
 */
async function openConversations() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/conversations`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await page.waitForSelector('.conv-list-row', { timeout: 60_000 })
      await sleep(1500)
      return
    }
    catch (e) {
      const where = await page.url().catch(() => '(取不到網址)')
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? '').catch(() => '(取不到內容)')
      console.log(`  第 ${attempt} 次開頁失敗（${String(e.message).slice(0, 60)}）｜網址 ${where}｜畫面「${text.replace(/\n+/g, ' ｜ ')}」`)
      if (attempt === 3) throw e
      await sleep(4000)
    }
  }
}
await openConversations()

/** 側欄現況＋盒模型（破版看不見，所以每一項都要量） */
const snapshot = () => page.evaluate(() => {
  const box = el => (el ? (({ x, y, width, height, right }) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), right: Math.round(right) }))(el.getBoundingClientRect()) : null)
  const list = document.querySelector('.split-list')
  const bar = document.querySelector('.conv-batch-bar')
  const btn = [...document.querySelectorAll('.conv-sidebar-actions button')]
  const firstRow = document.querySelector('.conv-list-row')
  const name = firstRow?.querySelector('.split-list-name')
  return {
    rows: document.querySelectorAll('.conv-list-row').length,
    checks: document.querySelectorAll('.conv-row-check').length,
    selecting: document.querySelectorAll('.conv-list-row.is-selecting').length,
    checked: document.querySelectorAll('.conv-row-check.is-checked').length,
    toggleBtn: btn.map(b => b.innerText.trim()).find(t => t.includes('勾選')) ?? null,
    barText: bar ? bar.innerText.replace(/\n+/g, ' ｜ ').trim() : null,
    actions: [...document.querySelectorAll('.conv-batch-bar__actions button')].map(b => b.innerText.trim()),
    links: [...document.querySelectorAll('.conv-batch-bar__link')].map(b => b.innerText.trim()),
    report: document.querySelector('.conv-batch-report')?.innerText.replace(/\n+/g, ' ｜ ').trim() ?? null,
    /** ── 破版量測 ── */
    listOverflow: list ? list.scrollWidth > list.clientWidth + 1 : null,
    barOverflow: bar ? bar.scrollWidth > bar.clientWidth + 1 : null,
    sidebarBox: box(document.querySelector('.split-sidebar')),
    barBox: box(bar),
    rowBox: box(firstRow),
    /** 名字那行還有沒有在做省略號（多一欄勾選框最容易把它撐爆） */
    nameBox: box(name),
    nameEllipsis: name ? getComputedStyle(name).textOverflow : null,
    nameOverflowing: name ? name.scrollWidth > name.clientWidth + 1 : null,
    /** 列本身有沒有超出側欄（overflow 被裁掉時只有量得到） */
    rowOverflowsSidebar: (() => {
      const s = document.querySelector('.split-sidebar')?.getBoundingClientRect()
      const r = firstRow?.getBoundingClientRect()
      return s && r ? r.right > s.right + 1 : null
    })(),
  }
})

const clickToggle = () => page.evaluate(() => {
  const btn = [...document.querySelectorAll('.conv-sidebar-actions button')].find(b => b.innerText.includes('勾選'))
  if (!btn) return false
  btn.click()
  return true
})

const clickAction = label => page.evaluate((text) => {
  const btn = [...document.querySelectorAll('.conv-batch-bar__actions button')].find(b => b.innerText.includes(text))
  if (!btn) return false
  btn.click()
  return true
}, label)

// ── ① 平常不該有勾選框 ─────────────────────────────────────────────
const before = await snapshot()
console.log(`\n① 平常：清單 ${before.rows} 列、勾選框 ${before.checks} 個｜按鈕「${before.toggleBtn}」`)
console.log(`   側欄 ${before.sidebarBox?.width}px｜第一列 ${before.rowBox?.width}px｜名字欄 ${before.nameBox?.width}px（${before.nameEllipsis}）`)
if (!before.toggleBtn) fail('側欄 header 找不到「勾選」按鈕＝樣板沒渲染（canOperate？）')
if (before.checks !== 0) fail('沒進勾選模式就有勾選框＝那一欄平常就在吃名字的寬度')
if (before.barText) fail('沒進勾選模式就出現批次列')
const nameWidthBefore = before.nameBox?.width ?? 0

// ── ② 進勾選模式：框要出現、版面不可破 ────────────────────────────
if (!await clickToggle()) fail('按不到「勾選」')
await sleep(800)
const on = await snapshot()
console.log(`\n② 勾選模式：勾選框 ${on.checks} 個／${on.rows} 列（is-selecting ${on.selecting} 列）｜按鈕「${on.toggleBtn}」`)
console.log(`   批次列：${on.barText}`)
console.log(`   連結：${on.links.join('　')}`)
console.log(`   量測：批次列 ${on.barBox?.width}px（溢出 ${on.barOverflow}）｜名字欄 ${nameWidthBefore}→${on.nameBox?.width}px｜清單溢出 ${on.listOverflow}｜列超出側欄 ${on.rowOverflowsSidebar}`)
if (on.checks !== on.rows) fail(`勾選框 ${on.checks} 個對不上 ${on.rows} 列＝有些列沒長出勾選框`)
if (on.selecting !== on.rows) fail('列沒套上 is-selecting＝那一欄不是 flex，勾選框會疊在名字上')
if (!on.barText) fail('批次列沒出現＝按了沒反應（selectionMode 沒接上）')
if (on.barOverflow) fail('批次列橫向溢出（側欄是裁切的，溢出只有量得到、看不到捲軸）')
if (on.listOverflow) fail('清單橫向溢出＝多那一欄把列撐爆了')
if (on.rowOverflowsSidebar) fail('列的右緣超出側欄＝被靜靜裁掉')
if (on.nameEllipsis !== 'ellipsis') fail('名字那行的省略號不見了＝長名字會把列撐寬')
if ((on.nameBox?.width ?? 0) >= nameWidthBefore) fail('多了一欄勾選框，名字欄卻沒變窄＝這一欄的寬度是憑空長出來的（列一定溢出了）')
if (on.actions.length) fail('還沒勾任何東西就出現動作按鈕（「結束會話」不該一直亮著）')

// ── ③ 勾兩列：計數與動作按鈕 ──────────────────────────────────────
await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.conv-row-check')]
  boxes[0]?.querySelector('input')?.click()
  boxes[1]?.querySelector('input')?.click()
})
await sleep(600)
const picked = await snapshot()
console.log(`\n③ 勾了兩列：勾起來 ${picked.checked} 個`)
console.log(`   批次列：${picked.barText}`)
console.log(`   動作：${picked.actions.join('　')}`)
const pickedShot = join(tmpdir(), `conv-batch-select-desktop-${process.pid}.png`)
await page.screenshot({ path: pickedShot, clip: { x: 240, y: 60, width: 520, height: 640 } })
console.log(`   側欄截圖：${pickedShot}`)
if (picked.checked !== 2) fail(`勾了兩列只有 ${picked.checked} 個是勾起來的＝勾選狀態沒回寫到畫面`)
if (!/已選 2/.test(picked.barText ?? '')) fail(`批次列沒寫「已選 2」（實際：${picked.barText}）`)
if (!picked.actions.some(t => t.includes('待跟進'))) fail('勾了東西卻沒有「標記待跟進」可按')
if (!/暫停自動更新/.test(picked.barText ?? '')) fail('沒有講「清單暫停自動更新」＝人不知道畫面凍住了')

// ── ④ 點開一列還是要能看內容（勾選不該把點擊吃掉）──────────────────
await page.click('.conv-list-row .split-list-item')
await sleep(2000)
const opened = await snapshot()
console.log(`\n④ 勾選模式下點開第一列：勾起來 ${opened.checked} 個（勾選不該被點開這件事清掉）`)
if (opened.checked !== 2) fail('點開對話之後勾選被清掉了＝沒辦法邊看邊決定')

// ── ⑤ 批次結束會話：請求真的送出、回報逐筆列名字 ────────────────────
// ⛔ 回應是假的（見檔頭）：這裡驗的是「有沒有送出」與「三堆回報畫面長不長得出來」
/**
 * 挑一個**真的有列**的會話分頁。
 * 寫死「待真人」的話，那個分頁剛好是 0 筆時這一段會整段跳過——最重要的動作就沒驗到
 * （而 log 上只會留一行「這輪驗不到」，很容易被當成通過）。
 */
let tabName = null
// ⛔「結束」分頁刻意不列：那裡本來就不該出現「結束會話」（canBatchCloseHere 排除），
//    拿它來驗會驗出相反的結論
for (const wanted of ['待真人', '真人處理', '待處理', '機器人']) {
  const clicked = await page.evaluate((label) => {
    const tab = [...document.querySelectorAll('.conv-status-tab')].find(b => b.innerText.includes(label))
    if (tab) { tab.click(); return tab.innerText.trim() }
    // 收在「其他 ▾」下拉裡的那幾個（G-27③）
    const more = document.querySelector('.conv-status-tab--more')
    if (!more) return null
    more.click()
    return label
  }, wanted)
  if (!clicked) continue
  // 下拉裡的項目要等選單長出來再點
  await sleep(600)
  await page.evaluate((label) => {
    const item = [...document.querySelectorAll('.conv-status-more-item')].find(b => b.innerText.includes(label))
    if (item) (item.closest('.el-dropdown-menu__item') ?? item).click()
  }, wanted)
  await sleep(3500)
  const rowCount = await page.evaluate(() => document.querySelectorAll('.conv-row-check').length)
  console.log(`   試「${wanted}」分頁：${rowCount} 列`)
  if (rowCount > 0) { tabName = wanted; break }
}
await sleep(500)
await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.conv-row-check')]
  boxes.slice(0, 3).forEach(b => b.querySelector('input')?.click())
})
await sleep(500)
const onSessionTab = await snapshot()
console.log(`\n⑤ 切到「${tabName}」分頁並勾 ${onSessionTab.checked} 列`)
console.log(`   動作：${onSessionTab.actions.join('　')}`)
if (onSessionTab.checked === 0) {
  // ⛔ 不可以只印一行「這輪驗不到」就當通過：最重要的那個動作沒被驗到，這支守門員就是綠的謊
  fail(`四個會話分頁都勾不到列（tabName=${tabName}）＝批次結束會話這條路這輪完全沒驗到`)
}
else {
  if (!onSessionTab.actions.some(t => t.includes('結束會話'))) fail('會話分頁上勾了東西卻沒有「結束會話」可按')
  // 假回應：一筆成功、一筆已被同事關掉、一筆炸掉 → 三堆都要現形
  fakeResponder = (body) => {
    const ids = body.sessionIds ?? []
    return {
      requested: ids.length,
      done: ids.length > 0 ? 1 : 0,
      doneIds: ids.slice(0, 1),
      skipped: ids.slice(1, 2).map(id => ({ id, reason: 'already_closed' })),
      failed: ids.slice(2, 3).map(id => ({ id, message: 'DEADLINE_EXCEEDED' })),
    }
  }
  sent.length = 0
  if (!await clickAction('結束會話')) fail('按不到「結束會話」')
  await sleep(800)
  // 確認框：批次一定要先問過（而且要講出影響）
  const confirmText = await page.evaluate(() => document.querySelector('.el-message-box__message')?.innerText?.trim() ?? null)
  console.log(`   確認框：${confirmText}`)
  if (!confirmText) fail('批次結束會話沒有確認框＝一按就關掉一整批')
  if (confirmText && !/恢復自動回覆/.test(confirmText)) fail('確認框沒講出後果（客人下次來訊會由機器人／AI 接手）')
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.el-message-box__btns button')].find(b => b.innerText.includes('結束這'))
    btn?.click()
  })
  await sleep(2500)
  const done = await snapshot()
  console.log(`   送出的請求：${sent.map(s => `${s.url} ${s.body}`).join(' ／ ') || '（一個都沒有）'}`)
  console.log(`   回報：${done.report}`)
  if (!sent.length) fail('按了確認卻沒有任何請求送出＝按鈕沒接上端點（就是「按了沒反應」那種）')
  if (sent.length && !sent[0].url.includes('batch-close')) fail(`送到錯的端點：${sent[0].url}`)
  if (sent.length && !/sessionIds/.test(sent[0].body)) fail(`request body 沒帶 sessionIds：${sent[0].body}`)
  if (!done.report) fail('批次做完沒有任何回報＝略過與失敗的那幾筆靜靜消失（這個專案付過三次帳的病）')
  if (done.report && !/略過/.test(done.report)) fail('回報裡沒有「略過」那一筆')
  if (done.report && !/失敗/.test(done.report)) fail('回報裡沒有「失敗」那一筆')
  if (done.report && /（不明）/.test(done.report)) fail('回報列不出名字（只印出「（不明）」）＝勾的時候沒把名字留下來')
}

// ── ⑥「全部」分頁不可以有「結束會話」（一列是一位客人不是一場對話）──
await page.click('.conv-status-tab--more')
await sleep(600)
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.conv-status-more-item')].find(b => b.innerText.includes('全部'))
  item?.closest('.el-dropdown-menu__item')?.click() ?? item?.click()
})
await page.waitForSelector('.conv-list-row', { timeout: 30_000 }).catch(() => {})
await sleep(2500)
await page.evaluate(() => {
  document.querySelector('.conv-row-check')?.querySelector('input')?.click()
})
await sleep(500)
const allTab = await snapshot()
console.log(`\n⑥ 回到「全部」分頁勾 ${allTab.checked} 列｜動作：${allTab.actions.join('　')}`)
console.log(`   批次列：${allTab.barText}`)
if (allTab.checked === 0) {
  console.log('   ⚠️ 切分頁後勾選被清掉是對的，但這輪就驗不到「全部」分頁的動作按鈕')
}
else {
  if (allTab.actions.some(t => t.includes('結束會話'))) fail('「全部」分頁出現「結束會話」＝那裡的列沒有會話 id，會關到猜出來的東西')
  if (!/每一列是/.test(allTab.barText ?? '')) fail('「全部」分頁沒說明為什麼不能批次結束會話')
}

// ── ⑦ 批次標記待跟進：請求送出、旗子回寫 ───────────────────────────
if (allTab.checked > 0) {
  fakeResponder = (body) => {
    const ids = body.userIds ?? []
    return { requested: ids.length, done: ids.length, doneIds: ids, skipped: [], failed: [] }
  }
  sent.length = 0
  if (!await clickAction('標記待跟進')) fail('按不到「標記待跟進」')
  await sleep(2000)
  const flagged = await page.evaluate(() => ({
    report: document.querySelector('.conv-batch-report')?.innerText.replace(/\n+/g, ' ｜ ').trim() ?? null,
    tags: [...document.querySelectorAll('.conv-list-row .split-list-chip--inline')].map(t => t.innerText.trim()),
  }))
  console.log(`\n⑦ 批次標記待跟進：${sent.map(s => `${s.url} ${s.body}`).join(' ／ ') || '（沒送出）'}`)
  console.log(`   回報：${flagged.report}｜清單上的「待跟進」膠囊 ${flagged.tags.filter(t => t.includes('待跟進')).length} 顆`)
  if (!sent.length) fail('按了「標記待跟進」沒有請求送出')
  if (sent.length && !/userIds/.test(sent[0].body)) fail(`body 沒帶 userIds：${sent[0].body}`)
  if (sent.length && !/"followUp":true/.test(sent[0].body)) fail(`body 沒帶 followUp:true：${sent[0].body}`)
  if (!flagged.tags.some(t => t.includes('待跟進'))) fail('標記完清單上沒有出現「待跟進」膠囊＝畫面沒回寫（applyLocalFlags 沒吃到 id）')
}

// ── ⑧ 結束勾選：框要收掉、名字寬度要還回來 ─────────────────────────
await clickToggle()
await sleep(1000)
const off = await snapshot()
console.log(`\n⑧ 結束勾選：勾選框 ${off.checks} 個｜批次列 ${off.barText ?? '（已收掉）'}｜名字欄 ${off.nameBox?.width}px`)
if (off.checks !== 0) fail('結束勾選後勾選框還在')
if (off.barText) fail('結束勾選後批次列還在')

// ── ⑨ 390px 手機：批次列不可以破版 ────────────────────────────────
await clickToggle()
await sleep(600)
await page.evaluate(() => { document.querySelector('.conv-row-check')?.querySelector('input')?.click() })
await sleep(600)
await page.setViewport({ width: 390, height: 844 })
await sleep(1500)
const narrow = await page.evaluate(() => {
  const bar = document.querySelector('.conv-batch-bar')
  const actions = document.querySelector('.conv-batch-bar__actions')
  const sidebar = document.querySelector('.split-sidebar')
  if (!bar) return { gone: true }
  const b = bar.getBoundingClientRect()
  const s = sidebar?.getBoundingClientRect()
  return {
    gone: false,
    barWidth: Math.round(b.width),
    barRight: Math.round(b.right),
    sidebarRight: s ? Math.round(s.right) : null,
    barOverflow: bar.scrollWidth > bar.clientWidth + 1,
    actionsOverflow: actions ? actions.scrollWidth > actions.clientWidth + 1 : null,
    actionLines: actions ? new Set([...actions.querySelectorAll('button')].map(b2 => Math.round(b2.getBoundingClientRect().y))).size : 0,
    rowOverflow: (() => {
      const r = document.querySelector('.conv-list-row')?.getBoundingClientRect()
      return r && s ? r.right > s.right + 1 : null
    })(),
    /**
     * 整頁在手機寬度下本來就會橫向溢出（後台外殼的 RWD 是既有待辦 `E-13`）。
     * 印出來是為了**分得清楚**：這條是舊帳，不是這次多那一欄造成的——
     * 所以下面只對「批次列有沒有超出側欄」下判斷，不對這個數字下判斷。
     */
    docOverflow: Math.round(document.documentElement.scrollWidth - window.innerWidth),
  }
})
if (narrow.gone) {
  console.log('\n⑨ 390px 寬時側欄不顯示，這輪量不到')
}
else {
  console.log(`\n⑨ 390px：批次列 ${narrow.barWidth}px（右緣 ${narrow.barRight} vs 側欄 ${narrow.sidebarRight}）｜動作排成 ${narrow.actionLines} 排`)
  console.log(`   （整頁橫向溢出 ${narrow.docOverflow}px＝後台外殼既有的手機版問題 \`E-13\`，不是這一欄造成的）`)
  if (narrow.barOverflow) fail('窄畫面下批次列橫向溢出')
  if (narrow.actionsOverflow) fail('窄畫面下動作按鈕橫向溢出（要能換行）')
  if (narrow.sidebarRight !== null && narrow.barRight > narrow.sidebarRight + 1) fail(`批次列右緣 ${narrow.barRight} 超出側欄 ${narrow.sidebarRight}＝被裁掉`)
  if (narrow.rowOverflow) fail('窄畫面下清單列超出側欄')
}

const shotPath = join(tmpdir(), `conv-batch-select-${process.pid}.png`)
await page.screenshot({ path: shotPath })
console.log(`\n${process.exitCode ? '有問題，見上面 ❌' : '✅ 都對'}（截圖：${shotPath}）`)
console.log(`（這一輪送出的批次請求全部被攔下改成假回應，正式資料沒有被寫入：共攔到 ${interceptedTotal} 筆）`)
await browser.close()
