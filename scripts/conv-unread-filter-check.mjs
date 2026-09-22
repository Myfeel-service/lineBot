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

/**
 * 等到條件成立（或逾時）再往下量。
 *
 * ⛔ 跟正式站要資料的段落不可以用固定 sleep：同一支腳本連跑三次，清單有時 2 秒回來、
 *    有時 6 秒，量太早就會喊「按鈕沒接上 loadMoreList」——可是下一段自己又看到資料到齊了。
 *    一支會亂喊的守門員比沒有守門員更糟：真的紅的那次沒有人會停下來看。
 *    （2026-09-22 就是這樣連紅兩次，程式其實是對的。）
 */
async function waitUntil(check, ms = 15_000, step = 500) {
  const until = Date.now() + ms
  for (;;) {
    if (await check()) return true
    if (Date.now() > until) return false
    await sleep(step)
  }
}

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
    /**
     * ⛔ 2026-09-22 起釘在上面那行**只剩警告文字、沒有按鈕**（動作全搬到清單盡頭）：
     * 「還有沒載完的頁」一律看 `notice` 這行字在不在，不可以再拿按鈕的存在當判斷——
     * 那樣一改版就會變成「找不到按鈕＝以為載完了」的假綠燈。
     */
    noticeHasMore: !!document.querySelector('.conv-unread-scan'),
    scanBtnStillThere: !!document.querySelector('.conv-unread-scan__more'),
    /** 清單盡頭那一區（人往下捲會先撞到的地方）——⛔ 它必須長在捲動區裡面才跟得到底 */
    endText: document.querySelector('.conv-unread-end')?.innerText.replace(/\n/g, ' ｜ ').trim() ?? null,
    endBtn: document.querySelector('.conv-unread-end__more')?.innerText.trim() ?? null,
    endInsideList: !!document.querySelector('.split-list .conv-unread-end'),
    /** 「又往下翻了 N 筆，都是看過的」——沒有這句時，翻完清單沒變就像按了沒反應 */
    scanReport: document.querySelector('.conv-unread-end__report')?.innerText.trim() ?? null,
    empty: document.querySelector('.split-sidebar-empty')?.innerText.replace(/\n/g, ' ｜ ') ?? null,
    /**
     * 已讀章只在「人真的在看」時才蓋（見 stampConversationRead）——headless 視窗沒有焦點的話
     * 章只會記在待辦裡不會落地，③ 就會無辜地紅。所以要把它印出來，不然這支守門員自己會說謊。
     */
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
    /** 同一個判斷還看 visibilityState（見 pageIsVisible）：headless 常常是 hidden，只印 hasFocus 會誤判 */
    visibility: document.visibilityState,
    /** 還亮著紅點的是哪幾列（名字＋列上那個時間）——數字對不起來時要看得出是誰 */
    dotRows: [...document.querySelectorAll('.conv-list-row')]
      .filter(r => r.querySelector('.split-list-item__avatar-wrap.is-unread'))
      .map(r => r.innerText.replace(/\n/g, ' ｜ ').slice(0, 40)),
    readStamps: Object.keys(JSON.parse(localStorage.getItem(`admin-conv-lastRead:${location.pathname.split('/')[2]}`) || '{}')).length,
    /** 載入失敗會走 toast（不是 pageerror），不印出來的話 ③ 會紅得莫名其妙 */
    toast: [...document.querySelectorAll('.el-message')].map(e => e.innerText.trim()).filter(Boolean).join(' ｜ ') || null,
    /** 正在看的是哪一列：③ 對不起來時要知道點開的是誰 */
    activeRow: document.querySelector('.conv-list-row .split-list-item.is-active, .conv-list-row .split-list-item.active')?.innerText.replace(/\n/g, ' ｜ ').slice(0, 50) ?? null,
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
console.log(`   掃描說明：${on.notice ?? '（沒有＝已經掃到底）'}`)
if (on.empty) console.log(`   空清單文案：${on.empty}`)
const onShot = join(tmpdir(), `conv-unread-filter-on-${process.pid}.png`)
await page.screenshot({ path: onShot, clip: { x: 240, y: 60, width: 520, height: 700 } })
console.log(`   側欄截圖：${onShot}`)
if (on.unreadOn !== true) fail('按了之後按鈕沒有亮起來（.active 沒套上）')
if (before.dots > 0 && on.rows === before.rows && before.rows !== before.dots)
  fail('按下去清單筆數完全沒變＝篩選沒接上（就是上一個篩選功能的那種「按了沒反應」）')
if (on.rows !== on.dots) fail(`篩選開著時留下 ${on.rows} 列卻只有 ${on.dots} 顆紅點＝有已讀的列沒被篩掉`)
if (before.dots > 0 && on.rows === 0 && !on.empty) fail('一列都沒留，卻連空清單說明都沒有＝畫面是一片空白')

// ── ②-b 括號裡的數字：沒載完要帶「＋」（2026-09-22 老闆回報）──────────
// 這個數字只掃得到已載入的那幾頁：往下捲會變大、按重整又縮回去。寫成裸數字時它在
// 按鈕上長得像「我總共有幾筆沒看」，看兩次就沒人再相信它（見 unreadCountLabel）。
{
  const hasMore = on.noticeHasMore // 那行警告還在＝下面還有沒載進來的頁（它只在 listHasMore 時出現）
  const btnText = (on.unreadBtn ?? '').replace(/\n/g, '')
  const hasNumber = /（\d/.test(btnText)
  const plus = btnText.includes('＋')
  console.log(`\n②-b 數字寫法：按鈕「${btnText}」｜下面還有沒載完的頁：${hasMore}`)
  if (!hasNumber) {
    console.log('   （這輪按鈕上沒有數字＝一筆未讀都沒有，＋的規則這次驗不到）')
  }
  else {
    if (hasMore && !plus) fail('清單還沒載到底，數字卻沒有「＋」＝又變回一個看起來像總數、卻會自己長大的裸數字')
    if (!hasMore && plus) fail('清單已經載到底了還掛著「＋」＝這時它就是總數，＋只會讓人不敢相信它')
  }
  // ⛔「標記全部已讀」刻意不帶＋：它回答的是「按下去會清掉幾顆」，範圍是確定的
  if ((on.markAllBtn ?? '').includes('＋'))
    fail('「標記全部已讀」不該有＋：加了等於說「按下去不知道會清掉多少」，比沒加還可怕')
}

// ── ③ 點開一列：正在看的那一列要留著 ───────────────────────────────
if (on.rows > 0) {
  await page.click('.conv-list-row .split-list-item')
  // 已讀章要等時間軸真的載回來才蓋得下去（見 loadTimeline → stampConversationRead）。
  // ⛔ 逾時要**講出來**：正式站偶爾特別慢，靜靜地往下量就會得到一個看起來像「功能壞了」的紅燈
  const stamped = await waitUntil(async () => (await snapshot()).readStamps > 0, 25_000)
  if (!stamped) console.log('   ⚠️ 等了 25 秒還沒看到已讀章落地——下面那關若紅，先確認是不是正式站這次特別慢')
  await sleep(800) // 章落地到清單重繪還有一拍
  const opened = await snapshot()
  console.log(`\n③ 點開第一列後：清單 ${opened.rows} 列、紅點 ${opened.dots} 顆（選中 ${opened.active} 列）`)
  console.log(`   視窗有焦點：${opened.hasFocus}｜分頁狀態：${opened.visibility}｜已讀章 ${opened.readStamps} 位`)
  console.log(`   點開的是：${opened.activeRow ?? '（沒有選中任何一列）'}${opened.toast ? `｜⚠️ 畫面上的提示：${opened.toast}` : ''}`)
  if (opened.rows < 1) fail('點開之後那一列自己從清單消失了＝正在看的對話在左邊找不到（keepUnreadRows 的例外沒生效）')
  if (opened.dots >= on.dots) fail('點開之後紅點沒少一顆＝已讀沒蓋上（和篩選無關，但這條路壞了篩選就會怪怪的）')
  if (opened.rows !== opened.dots + 1 && opened.rows !== opened.dots)
    fail(`點開後 ${opened.rows} 列／${opened.dots} 顆紅點——只該多留「正在看的那一列」`)
}

// ── ④ 釘在上面那行只講「你看到的不是全部」，不再有按鈕（2026-09-22）──
/**
 * 原本這一關按的是那行字裡的「再往下找」。那顆按鈕已經**刻意拿掉**：
 * 「只看未讀」篩完常常只剩幾列，上面那行和清單盡頭之間只隔著那幾列，
 * 兩邊各放一顆按鈕、各印一次同樣的回報，同一段話在同一個畫面上講兩次。
 * 現在上面只留警告＋指路，動作全在清單盡頭（下一關驗）。
 */
const beforeScan = await snapshot()
console.log(`\n④ 上面那行：${beforeScan.notice ?? '（沒有＝已經掃到底）'}`)
if (beforeScan.scanBtnStillThere) fail('上面那行又長出按鈕了＝和清單盡頭那顆重複，兩邊會各講一次同樣的話')
if (beforeScan.notice && !beforeScan.notice.includes('捲到清單最底下'))
  fail('那行字沒有指路（「捲到清單最底下可以繼續找」）＝它就只是個沒有出口的壞消息')

// ── ④-c 清單的盡頭也要說得出「還沒找完」（2026-09-22）───────────────
/**
 * 老闆回報「切成只看未讀時會不知道還可以往下 load 出來」。
 * 釘在清單**上方**那行救不了：人是往下捲找東西的，而篩完通常只剩零星幾列、
 * 撐不出捲軸，捲到底什麼都沒有＝看起來就是「只有這幾筆」。
 * ⛔ 所以這一區必須長在**捲動區裡面**（跟著捲到底才撞得到），而且要可以按。
 */
// ⛔ 先等上一段那次掃描整個跑完：`scanMoreForUnread` 一次最多翻 5 頁，④ 只等到
//    「筆數變大」就往下走，那時它可能還在翻——量到的是載入中的樣子（第一版就這樣誤報）
await waitUntil(async () => {
  const s = await snapshot()
  return !s.endBtn || s.endBtn === '繼續往下找'
})
const end = await snapshot()
console.log(`\n④-c 清單盡頭：${end.endText ?? '（沒有這一區）'}｜按鈕「${end.endBtn ?? '無'}」`)
if (end.noticeHasMore) {
  if (!end.endBtn) fail('清單還沒載到底，捲到盡頭卻沒有「繼續往下找」＝人只會以為未讀就這幾筆')
  if (!end.endInsideList) fail('盡頭那一區不在捲動清單裡面＝捲到底看不到它，等於沒做')
  const num = s => Number(String(s).match(/(\d+)/)?.[1] ?? 0)
  const scannedBefore = num(end.notice)
  await page.click('.conv-unread-end__more')
  // 等它翻完（按鈕從「往下找…」變回來），不是只等筆數變大——中間那一刻量到的是載入中
  await waitUntil(async () => {
    const s = await snapshot()
    return (!s.notice || num(s.notice) > scannedBefore) && s.endBtn !== '往下找…'
  })
  const afterEnd = await snapshot()
  // ⛔ 載入中不可以讓這一區消失：一按就不見、找完再冒出來＝「按了那顆按鈕就沒了」
  if (afterEnd.notice && !afterEnd.endText) fail('翻完之後盡頭那一區不見了（還沒載到底就不該消失）')
  console.log(`   按下去：找過 ${scannedBefore} → ${num(afterEnd.notice) || '（已到底）'} 筆｜回報「${afterEnd.scanReport ?? '無'}」`)
  if (afterEnd.notice && num(afterEnd.notice) <= scannedBefore)
    fail('按了盡頭那顆「繼續往下找」，找過的筆數沒增加＝它沒接上 scanMoreForUnread')
  if (!afterEnd.scanReport)
    fail('按完沒有任何回報＝翻到的全是看過的那次，清單一列都不會變，跟「按了沒反應」長得一模一樣')
  /**
   * 截一張給人目檢。⛔ 不要用 `scrollTop = scrollHeight`：捲到底會觸發無限捲動再載一頁，
   * 清單當場變長、位置被重算，拍到的還是清單頂端（第一版就這樣拍了張沒有盡頭的圖）。
   * 直接把那一區捲進畫面最穩。
   */
  await page.evaluate(() => {
    document.querySelector('.conv-unread-end')?.scrollIntoView({ block: 'center' })
  })
  await sleep(900)
  const endShot = join(tmpdir(), `conv-unread-end-${process.pid}.png`)
  await page.screenshot({ path: endShot, clip: { x: 240, y: 0, width: 300, height: 1000 } })
  const endGeom = await page.evaluate(() => {
    const el = document.querySelector('.conv-unread-end')
    const list = document.querySelector('.split-list')
    if (!el || !list) return null
    const b = el.getBoundingClientRect()
    const l = list.getBoundingClientRect()
    return { width: Math.round(b.width), right: Math.round(b.right), listRight: Math.round(l.right), overflow: el.scrollWidth > el.clientWidth + 1 }
  })
  console.log(`   盡頭截圖：${endShot}｜寬 ${endGeom?.width}px（清單右緣 ${endGeom?.listRight}）`)
  if (endGeom?.overflow) fail('盡頭那一區橫向溢出（側欄 overflow-x 是 hidden＝直接被裁掉，不會有捲軸）')
  if (endGeom && endGeom.right > endGeom.listRight + 1) fail(`盡頭那一區右緣 ${endGeom.right} 超出清單 ${endGeom.listRight}`)
}
else {
  console.log('   （清單已經全部載入，盡頭這一關這輪驗不到）')
}

// ── ④-b 切到背景時，分頁標題上的未讀數（2026-09-22）────────────────
/**
 * 那是最容易被當成待辦總數的位置：人在別的網頁上瞄到「（18）MiniMe」，畫面上那行
 * 「更早的還沒載入」他根本看不到，所以那裡也得帶＋，而且要跟按鈕講同一個數字。
 *
 * ⛔ 位置有兩個限制，都踩過才知道：
 *    · 要在 ③（點開一列蓋已讀）**之後**——這段會假造一次 blur，而已讀章只在
 *      「人真的在看」時才落地（見 stampConversationRead），夾在前面會讓 ③ 無辜地紅。
 *    · 要在 ⑦（標記全部已讀）**之前**——⑦ 會把未讀清光，擺在後面十次有八次
 *      只會印一句「這輪沒有未讀，驗不到」，等於沒有這道關卡。
 * ⛔ 這一頁先前根本沒有標題（沒有 useHead），整段掛未讀數的程式碼形同死碼，
 *    所以這裡也驗「標題本身存不存在」，不要再讓它悄悄沒作用。
 */
const titleCheck = await page.evaluate(() => {
  const foreground = document.title
  window.dispatchEvent(new Event('blur'))
  const background = document.title
  window.dispatchEvent(new Event('focus')) // ⛔ 一定要還原，不然後面每一段跟已讀有關的都會紅
  return {
    foreground,
    background,
    unreadBtn: [...document.querySelectorAll('.conv-flag-filter')].find(b => b.innerText.includes('只看未讀'))?.innerText.trim().replace(/\n/g, '') ?? null,
  }
})
console.log(`\n④-b 分頁標題：前景「${titleCheck.foreground}」→ 背景「${titleCheck.background}」｜按鈕「${titleCheck.unreadBtn}」`)
if (!titleCheck.foreground) fail('這一頁的瀏覽器分頁標題是空的＝未讀數掛不上去（頁面少了 useHead，那段程式碼等於死碼）')
const btnNum = String(titleCheck.unreadBtn ?? '').match(/（(\d+)(＋?)）/)
if (!btnNum) {
  console.log('   （按鈕上沒有數字＝這輪沒有未讀，標題的數字驗不到）')
}
else {
  if (!titleCheck.background.includes(`（${btnNum[1]}${btnNum[2]}）`))
    fail(`分頁標題「${titleCheck.background}」和按鈕的「（${btnNum[1]}${btnNum[2]}）」對不起來＝兩個地方各講一套`)
  if (titleCheck.background === titleCheck.foreground)
    fail('切到背景之後標題沒有變＝未讀數根本沒掛上分頁標題')
}

// ── ⑤ 關掉篩選：整份清單要回來 ────────────────────────────────────
await clickUnreadFilter()
await sleep(1500)
const off = await snapshot()
console.log(`\n⑤ 篩選關掉：清單 ${off.rows} 列、紅點 ${off.dots} 顆`)
if (off.unreadOn !== false) fail('再按一次沒有關掉')
if (off.rows < before.rows) fail(`關掉之後只剩 ${off.rows} 列（原本 ${before.rows}）＝篩選把資料弄丟了，不只是遮起來`)

// ── ⑤-b 收起釘選區：「標記全部已讀」的數字不可以跟著少（2026-09-22）──
/**
 * 「標記全部已讀」蓋的是**所有已載入的列**（見 markAllConversationsRead），不管釘選區
 * 是開是收。所以按鈕上那個數字也必須數同一份——先前數的是套過釘選區的那份，
 * 釘選區一收起來就變成「按鈕寫（3）、按下去清掉 5 顆」，而多清掉的那 2 顆
 * 正好是特地釘起來的人，清掉的過程完全看不到。
 */
if (await page.$('.conv-list-group')) {
  const openPinned = await snapshot()
  await page.click('.conv-list-group')
  await sleep(800)
  const collapsed = await snapshot()
  console.log(`\n⑤-b 收起釘選區：清單 ${openPinned.rows}→${collapsed.rows} 列｜「${openPinned.markAllBtn}」→「${collapsed.markAllBtn}」`)
  if (openPinned.markAllBtn !== collapsed.markAllBtn)
    fail(`收起釘選區之後「標記全部已讀」的數字變了（${openPinned.markAllBtn} → ${collapsed.markAllBtn}）＝按鈕寫的和它實際會清掉的對不起來，收在裡面那幾位會被靜靜清掉`)
  await page.click('.conv-list-group') // 還原，後面幾段要看到完整清單
  await sleep(600)
}
else {
  console.log('\n⑤-b 這個帳號沒有釘選中的對話，「收起釘選區數字會不會少」這條驗不到')
}

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
/**
 * 載到底時盡頭要**改口**說「找完了」。沒這句的話，人永遠不知道現在看到的是不是全部
 * ——那也正是篩選按鈕上的「＋」為什麼會消失（兩處是同一個判斷 listHasMore）。
 */
if (!tabbed.noticeHasMore && tabbed.rows > 0) {
  console.log(`   清單盡頭：${tabbed.endText ?? '（沒有這一區）'}`)
  if (!String(tabbed.endText ?? '').includes('全部對話都找過了'))
    fail('已經載到底了，清單盡頭卻沒說「全部對話都找過了」＝人不知道現在這個數字就是全部')
}
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
