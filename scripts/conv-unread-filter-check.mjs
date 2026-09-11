/**
 * 「只看未讀」篩選的實機守門員（`H-29`）。
 *
 *   npm run dev                                         # 另一個終端先跑起來
 *   node --env-file=.env_myfeel scripts/conv-unread-filter-check.mjs
 *
 * 為什麼要有這支：這個專案吃過「typecheck 綠＋既有測試綠，但新程式根本沒被執行到」
 * （見記憶 `feedback_verify_new_code_actually_runs`），而且**上一個篩選功能就是這樣交出去的**
 * ——畫面傳了參數、composable 沒接，按下去沒反應。純函式測得到的只有留誰不留誰
 * （`shared/conversation-unread.test.ts`），「按下去清單有沒有真的變、正在看的那一列有沒有
 * 當場消失、兩顆膠囊有沒有擠出側欄」只有真的開一次瀏覽器才知道。
 *
 * ⛔ 這支**完全不寫任何資料**：只讀（清單／分頁數字），點擊只到「開一段對話」為止。
 *    已讀章寫的是瀏覽器 localStorage，而且是 puppeteer 每次開的暫時設定檔，關掉就沒了。
 * ⛔ 登入用的是真 token（Admin SDK 開 custom token → 換 idToken → 塞進 Firebase 的 IndexedDB）。
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
console.log(`登入身分：${session.email}（${admin.role}）`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))

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

await page.bringToFront() // 沒有焦點的話已讀章不會落地（見 snapshot 的 hasFocus）
await page.goto(`${BASE}/admin/${WORKSPACE_ID}/conversations`, { waitUntil: 'networkidle2', timeout: 90_000 })
await page.waitForSelector('.conv-list-row', { timeout: 60_000 })
await sleep(1500)

/** 側欄現況：幾列、幾顆紅點、篩選膠囊在哪、有沒有擠出去 */
const snapshot = () => page.evaluate(() => {
  const sidebarRow = document.querySelector('.conv-filter-row')
  const list = document.querySelector('.split-list')
  const pill = [...document.querySelectorAll('.conv-flag-filter')]
  const box = el => (el ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }))(el.getBoundingClientRect()) : null)
  return {
    rows: document.querySelectorAll('.conv-list-row').length,
    dots: document.querySelectorAll('.split-list-item__avatar-wrap.is-unread').length,
    active: document.querySelectorAll('.conv-list-row .split-list-item.is-active, .conv-list-row .split-list-item.active').length,
    unreadBtn: pill.find(b => b.innerText.includes('只看未讀'))?.innerText.trim() ?? null,
    unreadOn: pill.find(b => b.innerText.includes('只看未讀'))?.classList.contains('active') ?? null,
    followUpBtn: pill.find(b => b.innerText.includes('待跟進'))?.innerText.trim() ?? null,
    markAllBtn: document.querySelector('.conv-mark-all-read')?.innerText.trim() ?? null,
    notice: document.querySelector('.conv-unread-scan span')?.innerText.trim() ?? null,
    noticeBtn: document.querySelector('.conv-unread-scan__more')?.innerText.trim() ?? null,
    empty: document.querySelector('.split-sidebar-empty')?.innerText.replace(/\n/g, ' ｜ ') ?? null,
    /**
     * 已讀章只在「人真的在看」時才蓋（見 stampConversationRead）——headless 視窗沒有焦點的話
     * 章只會記在待辦裡不會落地，③ 就會無辜地紅。所以要把它印出來，不然這支守門員自己會說謊。
     */
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
    /** 還亮著紅點的是哪幾列（名字＋列上那個時間）——數字對不起來時要看得出是誰 */
    dotRows: [...document.querySelectorAll('.conv-list-row')]
      .filter(r => r.querySelector('.split-list-item__avatar-wrap.is-unread'))
      .map(r => r.innerText.replace(/\n/g, ' ｜ ').slice(0, 40)),
    readStamps: Object.keys(JSON.parse(localStorage.getItem(`admin-conv-lastRead:${location.pathname.split('/')[2]}`) || '{}')).length,
    // 破版量測：膠囊那一列有沒有橫向溢出、每顆膠囊有沒有超出側欄的內容框
    filterRowOverflow: sidebarRow ? sidebarRow.scrollWidth > sidebarRow.clientWidth + 1 : true,
    filterRowBox: box(sidebarRow),
    pillBoxes: pill.map(b => ({ text: b.innerText.trim(), ...box(b) })),
    listOverflow: list ? list.scrollWidth > list.clientWidth + 1 : null,
    sidebarBox: box(document.querySelector('.split-sidebar') ?? document.querySelector('.conv-search-bar')?.parentElement),
  }
})

const clickUnreadFilter = () => page.evaluate(() => {
  const btn = [...document.querySelectorAll('.conv-flag-filter')].find(b => b.innerText.includes('只看未讀'))
  if (!btn) return false
  btn.click()
  return true
})

// ── ① 篩選關著的樣子 ───────────────────────────────────────────────
const before = await snapshot()
console.log(`\n① 篩選關著：清單 ${before.rows} 列、紅點 ${before.dots} 顆`)
console.log(`   膠囊：${before.pillBoxes.map(p => `「${p.text.replace(/\n/g, '')}」${p.width}×${p.height} @x=${p.x}`).join('　')}`)
console.log(`   側欄內容框 ${before.sidebarBox?.width}px｜膠囊列 ${before.filterRowBox?.width}px`)
if (!before.unreadBtn) fail('找不到「只看未讀」那顆按鈕＝樣板根本沒渲染出來')
if (before.filterRowOverflow) fail('兩顆膠囊橫向溢出（側欄 overflow-x 是 hidden＝直接看不見，不會出現捲軸）')
for (const p of before.pillBoxes) {
  const right = p.x + p.width
  const limit = (before.sidebarBox?.x ?? 0) + (before.sidebarBox?.width ?? 0)
  if (right > limit + 1) fail(`膠囊「${p.text}」右緣 ${right} 超出側欄 ${limit}`)
}
if (before.dots === 0) console.log('   ⚠️ 這個瀏覽器設定檔一顆紅點都沒有（帳號真的全讀完了？）——下面的比對會失去意義')

// ── ② 按下去：只剩未讀 ────────────────────────────────────────────
if (!await clickUnreadFilter()) fail('按不到「只看未讀」')
await sleep(2500) // 這一頁沒有未讀時會自己往下掃幾頁（scanMoreForUnread）
const on = await snapshot()
console.log(`\n② 篩選開著：清單 ${on.rows} 列、紅點 ${on.dots} 顆｜按鈕「${on.unreadBtn?.replace(/\n/g, '')}」`)
console.log(`   掃描說明：${on.notice ?? '（沒有＝已經掃到底）'}${on.noticeBtn ? `［${on.noticeBtn}］` : ''}`)
if (on.empty) console.log(`   空清單文案：${on.empty}`)
const onShot = join(tmpdir(), `conv-unread-filter-on-${process.pid}.png`)
await page.screenshot({ path: onShot, clip: { x: 240, y: 60, width: 520, height: 700 } })
console.log(`   側欄截圖：${onShot}`)
if (on.unreadOn !== true) fail('按了之後按鈕沒有亮起來（.active 沒套上）')
if (before.dots > 0 && on.rows === before.rows && before.rows !== before.dots)
  fail('按下去清單筆數完全沒變＝篩選沒接上（就是上一個篩選功能的那種「按了沒反應」）')
if (on.rows !== on.dots) fail(`篩選開著時留下 ${on.rows} 列卻只有 ${on.dots} 顆紅點＝有已讀的列沒被篩掉`)
if (before.dots > 0 && on.rows === 0 && !on.empty) fail('一列都沒留，卻連空清單說明都沒有＝畫面是一片空白')

// ── ③ 點開一列：正在看的那一列要留著 ───────────────────────────────
if (on.rows > 0) {
  await page.click('.conv-list-row .split-list-item')
  await sleep(2500)
  const opened = await snapshot()
  console.log(`\n③ 點開第一列後：清單 ${opened.rows} 列、紅點 ${opened.dots} 顆（選中 ${opened.active} 列）`)
  console.log(`   視窗有焦點：${opened.hasFocus}｜已讀章 ${opened.readStamps} 位`)
  if (opened.rows < 1) fail('點開之後那一列自己從清單消失了＝正在看的對話在左邊找不到（keepUnreadRows 的例外沒生效）')
  if (opened.dots >= on.dots) fail('點開之後紅點沒少一顆＝已讀沒蓋上（和篩選無關，但這條路壞了篩選就會怪怪的）')
  if (opened.rows !== opened.dots + 1 && opened.rows !== opened.dots)
    fail(`點開後 ${opened.rows} 列／${opened.dots} 顆紅點——只該多留「正在看的那一列」`)
}

// ── ④「再往下找」真的有往下載 ──────────────────────────────────────
const beforeScan = await snapshot()
if (beforeScan.noticeBtn) {
  const num = s => Number(String(s).match(/(\d+)/)?.[1] ?? 0)
  await page.click('.conv-unread-scan__more')
  await sleep(4000)
  const afterScan = await snapshot()
  console.log(`\n④「再往下找」：掃過 ${num(beforeScan.notice)} → ${num(afterScan.notice) || '（已到底）'} 筆`)
  if (afterScan.notice && num(afterScan.notice) <= num(beforeScan.notice))
    fail('按了「再往下找」掃過的筆數沒增加＝那顆按鈕沒接上 loadMoreList')
}
else {
  console.log('\n④ 沒有「再往下找」＝清單已經全部載入（listHasMore=false），這輪驗不到')
}

// ── ⑤ 關掉篩選：整份清單要回來 ────────────────────────────────────
await clickUnreadFilter()
await sleep(1500)
const off = await snapshot()
console.log(`\n⑤ 篩選關掉：清單 ${off.rows} 列、紅點 ${off.dots} 顆`)
if (off.unreadOn !== false) fail('再按一次沒有關掉')
if (off.rows < before.rows) fail(`關掉之後只剩 ${off.rows} 列（原本 ${before.rows}）＝篩選把資料弄丟了，不只是遮起來`)

// ── ⑥ 換到會話分頁：篩選要跟著過去（紅點五個分頁都會亮）─────────────
await clickUnreadFilter()
await sleep(1200)
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('.conv-status-tab')].find(b => b.innerText.includes('待真人'))
  tab?.click()
})
await sleep(3500)
const tabbed = await snapshot()
console.log(`\n⑥ 切到「待真人」分頁（篩選仍開著）：清單 ${tabbed.rows} 列、紅點 ${tabbed.dots} 顆`)
console.log(`   掃描說明：${tabbed.notice ?? '（沒有＝已經掃到底）'}`)
if (tabbed.empty) console.log(`   空清單文案：${tabbed.empty}`)
if (tabbed.unreadOn !== true) fail('換分頁之後篩選自己關掉了（應該跟著走）')
if (tabbed.rows !== tabbed.dots && tabbed.active === 0)
  fail(`會話分頁上 ${tabbed.rows} 列／${tabbed.dots} 顆紅點＝會話列的篩選沒套到`)

// ── ⑦「標記全部已讀」把篩選清空之後，不可以只留一片空白 ────────────
// ⛔「全部」收在「其他 ▾」下拉裡（G-27③），要先把下拉點開才點得到那一項
await page.click('.conv-status-tab--more')
await sleep(600)
const backToAll = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.conv-status-more-item')].find(b => b.innerText.includes('全部'))
  item?.closest('.el-dropdown-menu__item')?.click() ?? item?.click()
  return !!item
})
if (!backToAll) fail('點不開「其他 ▾」下拉，回不到「全部」分頁')
// ⛔ 不能只 sleep 就去找「標記全部已讀」：正式資料載得慢一點，那顆還沒長出來就會
//    被當成「沒有未讀」而整段跳過（這支守門員就白跑了）。等清單真的有列再往下走。
await page.waitForSelector('.conv-list-row', { timeout: 30_000 }).catch(() => {})
await sleep(2500)
if (await page.$('.conv-mark-all-read')) {
  const beforeMark = await snapshot()
  console.log(`\n⑦ 回到「全部」分頁（篩選仍開著）：清單 ${beforeMark.rows} 列、紅點 ${beforeMark.dots} 顆｜「${beforeMark.markAllBtn}」｜已讀章 ${beforeMark.readStamps} 位`)
  await page.click('.conv-mark-all-read')
  await sleep(1200)
  const cleared = await snapshot()
  console.log(`   按下去之後：清單 ${cleared.rows} 列、紅點 ${cleared.dots} 顆（選中 ${cleared.active} 列）｜已讀章 ${cleared.readStamps} 位`)
  if (cleared.empty) console.log(`   空清單文案：${cleared.empty}`)
  if (cleared.dotRows.length) console.log(`   還亮著的：${cleared.dotRows.join('　／　')}`)
  // ⛔ 不可以斷言「一顆紅點都不剩」：這支跑的是**正在營業的正式帳號**，按下去到量測之間
  //    客人可能又傳了訊息（30 秒輪詢會把它併進來），那時候該亮的本來就要亮。
  //    要驗的是「按下去之前那幾顆有沒有被清掉」，所以看的是**清單有沒有變短**。
  if (cleared.rows >= beforeMark.rows) fail(`按了「標記全部已讀」清單沒變短（${beforeMark.rows}→${cleared.rows}）＝篩選沒跟著已讀更新`)
  if (cleared.rows === 0 && !cleared.empty) fail('清單被清空卻沒有任何說明＝一片空白')
  if (cleared.dots === 0 && cleared.markAllBtn) fail('已經沒有未讀了，「標記全部已讀」那顆還在')
}
else {
  console.log('\n⑦ 這輪沒有「標記全部已讀」可按（已經沒有未讀了）')
}

// ── ⑧ 窄畫面：兩顆膠囊要自己換行，不可以被裁掉 ─────────────────────
await page.setViewport({ width: 390, height: 844 })
await sleep(1500)
const narrow = await page.evaluate(() => {
  const row = document.querySelector('.conv-filter-row')
  const pill = [...document.querySelectorAll('.conv-flag-filter')]
  if (!row) return { gone: true }
  const r = row.getBoundingClientRect()
  return {
    gone: false,
    rowWidth: Math.round(r.width),
    overflow: row.scrollWidth > row.clientWidth + 1,
    // 兩顆在同一排還是各佔一排（y 不同＝有換行）
    lines: new Set(pill.map(b => Math.round(b.getBoundingClientRect().y))).size,
    pills: pill.map(b => ({ text: b.innerText.trim().replace(/\n/g, ''), w: Math.round(b.getBoundingClientRect().width), right: Math.round(b.getBoundingClientRect().right) })),
    rowRight: Math.round(r.right),
  }
})
if (narrow.gone) {
  console.log('\n⑧ 390px 寬時側欄不顯示（版面自己收起來了），這輪量不到')
}
else {
  console.log(`\n⑧ 390px 寬：膠囊列 ${narrow.rowWidth}px、排成 ${narrow.lines} 排｜${narrow.pills.map(p => `「${p.text}」${p.w}px`).join('　')}`)
  if (narrow.overflow) fail('窄畫面下膠囊列橫向溢出')
  for (const p of narrow.pills) {
    if (p.right > narrow.rowRight + 1) fail(`窄畫面下「${p.text}」右緣 ${p.right} 超出容器 ${narrow.rowRight}＝被裁掉`)
  }
}

const shotPath = join(tmpdir(), `conv-unread-filter-${process.pid}.png`)
await page.screenshot({ path: shotPath })
console.log(`\n${process.exitCode ? '有問題，見上面 ❌' : '✅ 都對'}（截圖：${shotPath}）`)
await browser.close()
