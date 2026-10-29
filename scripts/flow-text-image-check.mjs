/**
 * `C-416`／`C-418` 實機守門員（`D-160` ②④）：機器人模組
 *
 *   npm run dev                                          # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3000 node --env-file=.env_myfeel scripts/flow-text-image-check.mjs
 *
 * 驗三件事：
 *   A. 工具列照「客人會看到什麼」排；影片、圖片輪播、用戶輸入收進「更多」（打開才看得到）；
 *      間距一樣寬、預覽開關靠右跟那排分開（`C-424`）
 *   B. 「＋ 文字」加圖片：上傳（攔下 `/api/upload` 回一張 400×300 的圖，不真的上傳）→ 預覽畫成一張卡、比例 4:3 不裁、
 *      按鈕預設綠色、出現「點圖片＝第 1 顆按鈕」與標題欄；「更換圖片」標題還在（對照組：以前會被一起清掉）；
 *      「移除圖片」→ 標題消失、預覽回到文字＋按鈕
 *   C. 清單：客人走不到的數字跟自己用 API 算的一致、資料夾標幾個走不到、「只看走不到的」只列那幾個且不畫點、系統模組不見；
 *      切回「全部」系統模組回來（對照組）
 *
 * ⛔ 不按「建立／儲存」，所有非 GET 的 /api 一律攔下（上傳那支回假的圖），最後列出攔了哪些。
 * ⚠️ 攔下的副作用：關掉的自動導覽存不進去、每次載入都會再跳——要點之前先關一次（點用 el.click()，不吃黑幕）。
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
/** MYFEEL：有資料夾、有客人走不到的模組 */
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99'
const SHOT_DIR = process.env.SHOT_DIR ?? tmpdir()

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
const admin = members.docs.map(d => ({ id: d.id, ...d.data() })).find(r => r.role === 'owner' || r.role === 'admin')
if (!admin) { console.error('這個工作區查不到管理員'); process.exit(1) }
const uid = String(admin.uid ?? admin.id)
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: await getAuth().createCustomToken(uid), returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }

// C 的答案：自己打兩支 GET 算（不吃畫面上的計算），規則＝自建模組、索引裡沒有任何地方指到它
const get = async path => (await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspaceId=${WORKSPACE_ID}`, {
  headers: { Authorization: `Bearer ${session.idToken}` },
})).json()
const [allFlows, refs] = await Promise.all([get('/api/flow/list'), get('/api/config-references')])
const regular = allFlows.filter(f => !f.isSystem)
const refsKnown = !refs.failedKinds?.length && !refs.truncatedKinds?.length
const expectUnreachable = regular.filter(f => !(refs.modules?.[f.id]?.length)).length
console.log(`受測帳號：自建模組 ${regular.length}、客人走不到 ${expectUnreachable}（索引${refsKnown ? '完整' : '不完整，C 不驗'}）`)

// 上傳攔下來回這張：400×300，用來驗「照原比例」（不是正方形，才分得出來）
const FAKE_IMAGE = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#06c755"/></svg>',
).toString('base64')}`
// 選檔用的檔案（真的 PNG，過得了前端的類型檢查）
const PICK_FILE = join(tmpdir(), `flow-text-image-${process.pid}.png`)
writeFileSync(PICK_FILE, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1100 })
page.on('dialog', d => d.accept())
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 160)))
const blocked = []
await page.setRequestInterception(true)
page.on('request', (req) => {
  if (req.method() !== 'GET' && req.url().includes('/api/')) {
    const path = new URL(req.url()).pathname
    if (path === '/api/upload') {
      blocked.push(`${req.method()} ${path}（回假的圖）`)
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ imageUrl: FAKE_IMAGE, url: FAKE_IMAGE }) })
    }
    blocked.push(`${req.method()} ${path}`)
    return req.abort()
  }
  req.continue()
})

// 開發模式第一次開頁要編譯，預設 30 秒會逾時
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 120_000 })
await page.evaluate(async (s) => {
  const user = { uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'google.com', uid: s.email, displayName: null, email: s.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
    createdAt: String(Date.now() - 86400_000), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]' }
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

const sleep = ms => new Promise(r => setTimeout(r, ms))
const closeTours = () => page.evaluate(() => { document.querySelectorAll('.el-tour__closebtn').forEach(b => b.click()) })
const clickText = (text, scope = 'body') => page.evaluate((t, sel) => {
  const btn = [...(document.querySelector(sel)?.querySelectorAll('button, label, li') ?? [])].find(b => b.innerText.trim() === t)
  if (!btn) return false
  btn.click()
  return true
}, text, scope)
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const waitFor = (fn, arg, timeout = 15_000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false)

await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow`, { waitUntil: 'networkidle2', timeout: 120_000 })
await waitFor(() => document.querySelectorAll('.split-list .split-list-item').length > 3, null, 60_000)
await sleep(800)
await closeTours()

// ── C. 清單（先驗：畫面還沒被 B 動過） ─────────────────────────
if (refsKnown && expectUnreachable > 0) {
  await waitFor(() => document.querySelector('.flow-list-filter'), null, 20_000)
  const filter = await page.evaluate(() => [...document.querySelectorAll('.flow-list-filter .el-radio-button')].map(b => b.innerText.trim()))
  check('C1 篩選兩格的數字＝自己用 API 算的', filter[0] === `全部 ${regular.length}` && filter[1] === `客人走不到 ${expectUnreachable}`,
    `畫面「${filter.join('」「')}」／算的 全部 ${regular.length}、走不到 ${expectUnreachable}`)
  const folderMarks = await page.evaluate(() => [...document.querySelectorAll('.src-folder-unreachable')].map(e => Number(e.innerText.match(/\d+/)?.[0] ?? 0)))
  // ⚠️ 資料夾裡的列跟未分類的列在 DOM 上是同一層（template 攤平），要用 src-row--in-folder 分開
  const uncatMarks = await page.evaluate(() => document.querySelectorAll('.split-list > .flow-sidebar-row--unreachable:not(.src-row--in-folder)').length)
  const sum = folderMarks.reduce((a, b) => a + b, 0) + uncatMarks
  check('C2 資料夾標的「● N」加未分類的橘點＝總數', sum === expectUnreachable, `資料夾 ${folderMarks.join('+') || 0}＋未分類 ${uncatMarks}＝${sum}`)
  // ⛔ 側欄窄：資料夾標題加了走不到的數字之後，名字後面的「（總數）」不可以被擠掉（第一版寫「28 個走不到」就擠掉了）
  const folderCountVisible = await page.evaluate(() => [...document.querySelectorAll('.src-folder-header')]
    .filter(h => h.querySelector('.src-folder-unreachable'))
    .map((h) => {
      const label = h.querySelector('.src-folder-label')
      const count = h.querySelector('.src-folder-count')
      return { name: label?.innerText.trim(), fits: !!label && !!count && count.getBoundingClientRect().right <= label.getBoundingClientRect().right + 0.5 }
    }))
  check('C2b 標了走不到的資料夾，名字後面的總數沒被擠掉', folderCountVisible.length > 0 && folderCountVisible.every(f => f.fits),
    folderCountVisible.map(f => `${f.name}:${f.fits ? '看得到' : '被擠掉'}`).join('、'))
  const shotList = join(SHOT_DIR, 'flow-list-all.png')
  await page.screenshot({ path: shotList, clip: { x: 0, y: 0, width: 520, height: 1100 } })

  await clickText(`客人走不到 ${expectUnreachable}`, '.flow-list-filter')
  await sleep(500)
  const only = await page.evaluate(() => ({
    rows: document.querySelectorAll('.split-list .flow-sidebar-row').length,
    dots: document.querySelectorAll('.split-list .flow-sidebar-row--unreachable').length,
    sys: document.querySelectorAll('.split-list [data-tour^="flow-sys-"]').length,
    hint: document.querySelector('.flow-list-filter__hint')?.innerText.trim() ?? '',
    handles: document.querySelectorAll('.split-list .drag-handle').length,
  }))
  check('C3 只看走不到的：列數＝總數、每列都是所以不畫點、不給拖', only.rows === expectUnreachable && only.dots === 0 && only.handles === 0,
    `列 ${only.rows}、點 ${only.dots}、拖曳把手 ${only.handles}`)
  check('C4 只看走不到的：系統模組不見、有一句說明', only.sys === 0 && only.hint.includes('沒有任何'), `系統 ${only.sys}、說明「${only.hint}」`)
  await page.screenshot({ path: join(SHOT_DIR, 'flow-list-unreachable.png'), clip: { x: 0, y: 0, width: 520, height: 1100 } })

  await clickText(`全部 ${regular.length}`, '.flow-list-filter')
  await sleep(500)
  const back = await page.evaluate(() => document.querySelectorAll('.split-list [data-tour^="flow-sys-"]').length)
  check('C5 對照組：切回「全部」系統模組回來', back > 0, `系統 ${back}`)
  console.log(`清單截圖：${shotList}`)
}
else {
  check('C0 這個帳號的索引不完整或沒有走不到的，C 這次沒驗', false, `索引完整 ${refsKnown}、走不到 ${expectUnreachable}`)
}

// ── A. 工具列 ─────────────────────────────────────────────
await page.evaluate(() => document.querySelector('[data-tour="flow-new"]')?.click())
await waitFor(() => document.querySelector('.msg-type-btns'))
await sleep(500)
await closeTours()
const toolbar = await page.evaluate(() => [...document.querySelectorAll('.msg-type-btns > button, .msg-type-btns > .el-dropdown > button')].map(b => b.innerText.trim()))
// `C-424`：用戶輸入也收進「更多」（全站 2 則）；預覽開關不在這一排
const want = ['＋ 文字', '＋ 圖片', '＋ 圖文訊息', '＋ 卡片訊息', '＋ 快速回覆', '更多 ▾']
check('A1 工具列順序；影片、圖片輪播、用戶輸入不在外面', toolbar.length === want.length && want.every((t, i) => toolbar[i] === t),
  toolbar.join('｜'))
// `C-424`：間距一樣寬（以前 Element 的相鄰按鈕左邊距疊在 gap 上：前六顆約 18px、「更多」前後約 6px）；預覽開關靠右、跟加訊息那排分開
const layout = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.msg-type-btns > button, .msg-type-btns > .el-dropdown')]
  const rects = items.map(el => el.getBoundingClientRect())
  const gaps = rects.slice(1).map((r, i) => Math.round(r.left - rects[i].right))
  const toggle = document.querySelector('.fem-preview-toggle')
  const header = document.querySelector('.fem-header')
  const tr = toggle?.getBoundingClientRect()
  const hr = header?.getBoundingClientRect()
  return {
    gaps,
    toggleInRow: !!toggle?.closest('.msg-type-btns'),
    toggleRightGap: tr && hr ? Math.round(hr.right - tr.right) : -1,
    toggleFromRow: tr && rects.length ? Math.round(tr.left - rects[rects.length - 1].right) : -1,
  }
})
check('A3 加訊息那排間距一樣寬', layout.gaps.length > 0 && new Set(layout.gaps).size === 1, `間距 ${layout.gaps.join('/')}px`)
check('A4 預覽開關不在加訊息那排、靠右、跟那排拉開', !layout.toggleInRow && layout.toggleRightGap >= 0 && layout.toggleRightGap <= 24 && layout.toggleFromRow > 24,
  `在那排裡 ${layout.toggleInRow}、離右邊 ${layout.toggleRightGap}px、離那排 ${layout.toggleFromRow}px`)
await page.screenshot({ path: join(SHOT_DIR, 'flow-toolbar.png'), clip: await page.evaluate(() => {
  const r = document.querySelector('.fem-header').getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}) })
await page.evaluate(() => document.querySelector('[data-tour="fmt-more"]')?.click())
await sleep(500)
const more = await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(i => i.offsetParent !== null).map(i => i.innerText.trim()))
check('A2 打開「更多」看得到影片、圖片輪播、用戶輸入', more.some(t => t.startsWith('＋ 影片')) && more.some(t => t.startsWith('＋ 圖片輪播')) && more.some(t => t.startsWith('＋ 用戶輸入')), more.join('｜'))
await page.keyboard.press('Escape')
await sleep(300)

// ── B. 文字加圖 ───────────────────────────────────────────
await clickText('＋ 文字', '.msg-type-btns')
await waitFor(() => document.querySelector('.message-bubble-wrap textarea'))
await page.type('.message-bubble-wrap textarea', '完成任務就有機會抽中贈品！')
await clickText('⊕ 新增按鈕（選填）', '.message-bubble-wrap')
await sleep(400)
await page.evaluate(() => document.querySelector('[data-tour="text-add-image"]')?.click())
const zoneOpen = await waitFor(() => document.querySelector('[data-tour="text-image"] input[type="file"]'))
const input = await page.$('[data-tour="text-image"] input[type="file"]')
await input?.uploadFile(PICK_FILE)
const cardShown = await waitFor(() => document.querySelector('.fmp-cc-img--fit img')?.complete)
await sleep(600)
const withImage = await page.evaluate(() => ({
  aspect: document.querySelector('.fmp-cc-img--fit')?.style.aspectRatio ?? '',
  titleField: !![...document.querySelectorAll('.message-bubble-wrap .admin-field-group')].find(g => g.innerText.trim().startsWith('標題')),
  style: document.querySelector('.message-bubble-wrap .el-radio-button.is-active')?.innerText.trim() ?? '(沒有樣式)',
  primary: document.querySelectorAll('.fmp-cc--single .fmp-btn--primary').length,
  hint: document.querySelector('[data-tour="text-image"]')?.innerText.includes('客人點圖片＝按第 1 顆按鈕') ?? false,
}))
check('B1 加圖片：框打開、上傳完預覽畫成一張卡', zoneOpen && cardShown, `框 ${zoneOpen}、卡 ${cardShown}`)
check('B2 圖照原比例（400×300 → 4 / 3，不是預設的正方形）', withImage.aspect === '4 / 3', `aspect-ratio=${withImage.aspect}`)
check('B3 有圖才出現標題欄；按鈕預設綠色、預覽綠色實心；點圖提示', withImage.titleField && withImage.style === '綠色按鈕' && withImage.primary === 1 && withImage.hint,
  `標題欄 ${withImage.titleField}、樣式 ${withImage.style}、預覽綠色 ${withImage.primary}、提示 ${withImage.hint}`)

// 填標題 → 按「更換圖片」：標題要還在、框還開著（以前清空＝連標題一起刪）
const titleInput = await page.evaluateHandle(() => [...document.querySelectorAll('.message-bubble-wrap .admin-field-group')]
  .find(g => g.innerText.trim().startsWith('標題'))?.querySelector('input'))
await titleInput.asElement()?.type('【新品】即將開賣')
await sleep(300)
const shotEditor = join(SHOT_DIR, 'flow-text-image.png')
await page.screenshot({ path: shotEditor })
console.log(`編輯截圖：${shotEditor}`)
await clickText('更換圖片', '[data-tour="text-image"]')
await sleep(400)
const afterReplace = await page.evaluate(() => ({
  zone: !!document.querySelector('[data-tour="text-image"] input[type="file"]'),
}))
const inputAgain = await page.$('[data-tour="text-image"] input[type="file"]')
await inputAgain?.uploadFile(PICK_FILE)
await waitFor(() => document.querySelector('.fmp-cc-img--fit img')?.complete)
await sleep(400)
const titleKept = await page.evaluate(() => document.querySelector('.fmp-cc--single .fmp-cc-title')?.innerText.trim() ?? '')
check('B4 按「更換圖片」：框還開著、重新上傳後標題還在', afterReplace.zone && titleKept === '【新品】即將開賣', `框 ${afterReplace.zone}、預覽標題「${titleKept}」`)

// 移除圖片 → 回到文字＋按鈕
await clickText('移除圖片', '.message-bubble-wrap')
await sleep(500)
const removed = await page.evaluate(() => ({
  addBtn: !!document.querySelector('[data-tour="text-add-image"]'),
  titleField: [...document.querySelectorAll('.message-bubble-wrap .admin-field-group')].some(g => g.innerText.trim().startsWith('標題')),
  card: !!document.querySelector('.fmp-cc-img--fit'),
  textCard: !!document.querySelector('.fmp-card'),
}))
check('B5 移除圖片：回到「⊕ 加圖片」、標題欄不見、預覽回到文字＋按鈕', removed.addBtn && !removed.titleField && !removed.card && removed.textCard,
  JSON.stringify(removed))

check('Z 全程沒有存模組（非 GET 的 /api 全攔，上傳回假的圖）', blocked.every(b => b.includes('/api/upload') || b.includes('/api/admin/tour-seen')),
  `攔下 ${blocked.length} 筆：${[...new Set(blocked)].join('、')}`)

await browser.close()
let red = 0
for (const r of results) {
  if (!r.ok) red++
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}　${r.detail}`)
}
console.log(`\n${results.length - red} 綠 / ${red} 紅`)
process.exit(red ? 1 : 0)
