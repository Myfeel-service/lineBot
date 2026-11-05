/**
 * `C-469` 實機守門員（老闆 2026-11-05「提醒文字是否可以單獨拉出來」）：機器人模組
 *
 *   BROADCAST_CRON_ENABLED=false npm run dev -- --port 3123     # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3123 node --env-file=.env_myfeel scripts/flow-alt-text-check.mjs
 *
 * 驗四件事（都是「新程式真的被執行到」，不是只有 typecheck 綠）：
 *   A. 「＋ 文字」：什麼都沒加時**沒有**提醒文字那一格（LINE 文字訊息沒有這行字，給了也是假的）；
 *      加了按鈕＝會送成卡片，那一格才出現，而且寫「選填」、說得出沒填會怎樣
 *   B. 「＋ 圖文訊息」：提醒文字旁邊有「＋ 插入」（以前只有這一格不能插客人資料），且寫「必填」
 *   C. 透明開關：打開 + 有區塊設「觸發機器人模組」→ 當場說「這一則透明不會生效」並點名是哪一塊；
 *      對照組：關掉開關，那句話要消失
 *   D. 「＋ 卡片訊息」：同一格、同一套說法（placeholder 說得出沒填客人會看到「卡片訊息」）
 *
 * ⛔ 全程唯讀：不按「儲存」，所有非 GET 的 /api 一律攔下（上傳回一張假圖），最後列出攔了哪些。
 * ⚠️ 攔下的副作用：關掉的自動導覽存不進去、每次載入都會再跳——要點之前先關一次。
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3123'
/** MYFEEL */
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99'
const SHOT_DIR = process.env.SHOT_DIR ?? tmpdir()

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

// A～D 都在「一則自建模組」上做（⛔ 不挑系統模組：那幾則有自己的限制，驗不到一般店家的畫面）
const flowsSnap = await db.collection('flows').where('workspaceId', '==', WORKSPACE_ID).get()
const canvasFlow = flowsSnap.docs.map(d => ({ id: d.id, ...d.data() })).find(f => !f.isSystem && f.name)
if (!canvasFlow) { console.error('這個帳號沒有自建模組可以當畫布'); process.exit(1) }
console.log(`當畫布的模組：${canvasFlow.name}（${canvasFlow.id}，不會儲存）`)

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

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1200 })
page.on('dialog', d => d.accept())
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
// 上傳攔下來回這張 400×300（C 要有底圖，區塊設定才會出現；不真的上傳）
const FAKE_IMAGE = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#06c755"/></svg>',
).toString('base64')}`
// 選檔用的檔案（真的 PNG，過得了前端的類型檢查）
const PICK_FILE = join(tmpdir(), `flow-alt-text-${process.pid}.png`)
writeFileSync(PICK_FILE, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
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

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 180_000 })
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
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `｜${detail}` : ''}`)
}
/** ⛔ 一定要接回傳值：等不到就回 false，沒接的話等不到也會往下跑、整關假綠 */
const waitFor = (fn, arg = null, timeout = 20_000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false)
const clickText = (text, scope = 'body') => page.evaluate((t, sel) => {
  const el = [...(document.querySelector(sel)?.querySelectorAll('button, label, li, .el-dropdown-item') ?? [])]
    .find(b => b.innerText.trim() === t || b.innerText.trim().startsWith(t))
  if (!el) return false
  el.click()
  return true
}, text, scope)
/**
 * 「剛加的那一張卡」＝加之前先把現有的都蓋個章，之後沒有章的就是新的。
 *
 * ⛔ 別用「最後一張」：快速回覆一定排在最後一則（`C-424`），新加的訊息是插在它**前面**的，
 *    拿最後一張就會一直在量快速回覆那張（第一版 7 關全紅）。
 * ⛔ 也別用 `.message-card:last-of-type` 當 scope：每張卡各有外層 div，每一張都是它父層的
 *    last-of-type，`querySelector` 會挑到第一張。
 */
const markCards = () => page.evaluate(() => document.querySelectorAll('.message-card').forEach(c => { c.dataset.seen = '1' }))
const newCard = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
  return el ? el.innerText : ''
})
/** 在新加的那張卡裡點一顆字裡有 text 的按鈕 */
const clickInNewCard = text => page.evaluate((t) => {
  const el = [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
  const btn = [...(el?.querySelectorAll('button') ?? [])].find(b => b.innerText.includes(t))
  if (!btn) return false
  btn.click()
  return true
}, text)
/** 在新加的那張卡裡讀 placeholder */
const newCardPlaceholder = keyword => page.evaluate((k) => {
  const el = [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
  return [...(el?.querySelectorAll('input') ?? [])].map(i => i.placeholder).find(p => p?.includes(k)) ?? ''
}, keyword)
/**
 * 圖文訊息的「區塊要做什麼」那幾張卡在設定卡**外面**（`.carousel-block` 裡、`.message-card` 外），
 * 所以動作類型要從整塊找，不能從設定卡找（C0 第一版就是這樣紅的）。
 */
const markBlocks = () => page.evaluate(() => document.querySelectorAll('.carousel-block').forEach(b => { b.dataset.seen = '1' }))
const newBlock = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('.carousel-block')].find(b => !b.dataset.seen)
  return el ? el.innerText : ''
})
/** 在新加的那一整塊裡把某個欄位的下拉選成某一項（el-select 的選單 teleport 到 body） */
const pickInNewCard = async (fieldLabel, optionText) => {
  const opened = await page.evaluate((label) => {
    const el = [...document.querySelectorAll('.carousel-block')].find(b => !b.dataset.seen)
      ?? [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
    const group = [...(el?.querySelectorAll('.admin-field-group') ?? [])].find(g => g.innerText.includes(label))
    // ⛔ 點 `.el-select` 根元素展不開（Element Plus 的事件掛在裡面那層 wrapper 上）
    const trigger = group?.querySelector('.el-select__wrapper') ?? group?.querySelector('.el-select')
    if (!trigger) return false
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  }, fieldLabel)
  if (!opened) return false
  const listed = await waitFor(opt => [...document.querySelectorAll('.el-select-dropdown__item')]
    .some(i => i.offsetParent !== null && i.innerText.trim() === opt), optionText, 8_000)
  if (!listed) return false
  return page.evaluate((opt) => {
    const item = [...document.querySelectorAll('.el-select-dropdown__item')]
      .filter(i => i.offsetParent !== null)
      .find(i => i.innerText.trim() === opt)
    if (!item) return false
    item.click()
    return true
  }, optionText)
}
const shot = async (name) => {
  await sleep(600) // ⚠️ 截圖前要等，不然抓到的是上一個畫面
  await page.screenshot({ path: join(SHOT_DIR, `alt-text-${name}.png`), fullPage: false })
}

// 直接開那一則自建模組（側欄點第一列會選到系統模組）
await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow?id=${canvasFlow.id}`, { waitUntil: 'networkidle2', timeout: 180_000 })
const listed = await waitFor(() => document.querySelectorAll('.split-list .split-list-item').length > 3, null, 90_000)
if (!listed) { console.error('模組清單沒載出來'); await browser.close(); process.exit(1) }
// ⛔ 等的是「這一則真的打開了」＝工具列出現，不是側欄載好：`?id=` 選中那一列還要再一下子，
//    太早動手整批關卡會因為「畫面上根本還沒有卡片」假紅（第一版就是這樣）
const canvasReady = await waitFor(() => {
  const bar = document.body.innerText
  return bar.includes('＋ 文字') && bar.includes('＋ 圖文訊息')
}, null, 90_000)
if (!canvasReady) { console.error('模組沒打開（工具列沒出現）'); await browser.close(); process.exit(1) }
await sleep(1000)
await closeTours()

// ── A. 「＋ 文字」：沒按鈕沒有這一格、加了按鈕才有 ───────────────
await markCards()
await clickText('＋ 文字')
await sleep(500)
const textPlain = await newCard()
check('A1 純文字（沒圖沒按鈕）沒有「提醒文字」那一格', Boolean(textPlain) && !textPlain.includes('提醒文字'),
  textPlain ? (textPlain.includes('提醒文字') ? '不該出現卻出現了' : '沒出現，正確') : '⚠️ 根本沒抓到新加的卡片，這關不算數')

const clickedAddButton = await clickInNewCard('新增按鈕')
const gotAltField = await waitFor(() => {
  const el = [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
  return (el?.innerText ?? '').includes('提醒文字')
}, null, 10_000)
const textWithButton = await newCard()
check('A2 加了按鈕（＝會送成一張卡）才出現「提醒文字」，而且是選填',
  clickedAddButton && gotAltField && textWithButton.includes('提醒文字 (選填，最多 400 字)'),
  clickedAddButton ? (textWithButton.match(/提醒文字[^\n]*/) ?? ['（沒找到）'])[0] : '⚠️ 沒點到「新增按鈕」')
const textPlaceholder = await newCardPlaceholder('沒填的話')
check('A3 說得出沒填會怎樣（不是空白的輸入框）', textPlaceholder.includes('你寫的回覆文字'), `placeholder：「${textPlaceholder}」`)
await shot('a-text')

// ── B. 「＋ 圖文訊息」：必填、而且插得了客人資料 ─────────────────
await markCards()
await markBlocks()
await clickText('＋ 圖文訊息')
await sleep(600)
const rich = await newCard()
check('B1 圖文訊息的「提醒文字」寫必填（整則只有一張圖，沒有文字可以自動拿來用）',
  rich.includes('提醒文字 (必填，最多 400 字)'), (rich.match(/提醒文字[^\n]*/) ?? ['（沒找到）'])[0])
const richInsetOk = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
  const wrap = [...(el?.querySelectorAll('.flow-input-inset-wrap') ?? [])]
    .find(w => w.closest('.admin-field-group')?.innerText.includes('提醒文字'))
  return Boolean(wrap?.querySelector('.flow-var-inset__btn'))
})
check('B2 提醒文字旁邊有「＋ 插入」（以前全站只有這一格不能插客人資料）', richInsetOk)
check('B3 說明講客人看得到的東西，⛔ 不留「Alt Text」這種英文', rich.includes('客人手機跳出的通知') && !rich.includes('Alt Text'))
await shot('b-rich')

// ── C. 透明開關：說得出這一則為什麼不會透明 ─────────────────────
// 就用剛加的這則圖文訊息：上傳假圖 → 區塊出現 → 把 A 區塊改成「觸發機器人模組」→ 開透明
const chooserPromise = page.waitForFileChooser({ timeout: 10_000 }).catch(() => null)
await clickInNewCard('選擇圖片')
const chooser = await chooserPromise
if (chooser) await chooser.accept([PICK_FILE])
const gotAreas = await waitFor(() => {
  const el = [...document.querySelectorAll('.carousel-block')].find(b => !b.dataset.seen)
  return (el?.innerText ?? '').includes('動作類型')
}, null, 20_000)
check('C0 上傳底圖後出現區塊的動作設定（接下來才設得了觸發模組）', gotAreas, (await newBlock()).slice(0, 60).replace(/\n/g, ' '))

if (gotAreas) {
  const picked = await pickInNewCard('動作類型', '觸發機器人模組')
  await sleep(500)
  const warnBefore = await page.evaluate(() => document.body.innerText.includes('透明不會生效'))
  check('C1 還沒開透明時不出警示（⛔ 不是永遠掛在那裡的一句話）', picked && !warnBefore,
    picked ? '' : '⚠️ 沒把區塊改成「觸發機器人模組」')

  const toggled = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
    const group = [...(el?.querySelectorAll('.admin-field-group') ?? [])].find(g => g.innerText.includes('保留 PNG 透明區域'))
    const sw = group?.querySelector('.el-switch')
    if (!sw) return false
    sw.click()
    return true
  })
  const warned = await waitFor(() => document.body.innerText.includes('透明不會生效'), null, 10_000)
  const warnText = await page.evaluate(() => [...document.querySelectorAll('.ui-warning-text')]
    .map(e => e.innerText).find(t => t.includes('透明不會生效')) ?? '')
  check('C2 打開透明＋有區塊設了觸發模組：當場說這一則透明不會生效', toggled && warned, warnText.slice(0, 90))
  check('C3 說得出是哪一塊、怎麼辦（不是含糊的「可能會失效」）',
    /區塊 [A-F]/.test(warnText) && warnText.includes('開啟網址'), warnText.slice(90, 200))
  await shot('c-transparent-on')

  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.message-card')].find(c => !c.dataset.seen)
    const group = [...(el?.querySelectorAll('.admin-field-group') ?? [])].find(g => g.innerText.includes('保留 PNG 透明區域'))
    group?.querySelector('.el-switch')?.click()
  })
  const warnGone = await waitFor(() => !document.body.innerText.includes('透明不會生效'), null, 10_000)
  check('C4 對照組：關掉開關，那句話要消失', warnGone)
}

// ── D. 「＋ 卡片訊息」：同一格同一套說法 ───────────────────────
await markCards()
await clickText('＋ 卡片訊息')
await sleep(600)
const cardText = await newCard()
const cardPlaceholder = await newCardPlaceholder('沒填的話')
check('D1 卡片訊息：同一格、選填、說得出沒填客人會看到「卡片訊息」',
  cardText.includes('提醒文字 (選填，最多 400 字)') && cardPlaceholder.includes('「卡片訊息」'), `placeholder：「${cardPlaceholder}」`)
await shot('d-card')

console.log('\n攔下的寫入請求（應該全是開頁自己打的，沒有儲存）：')
console.log(blocked.length ? [...new Set(blocked)].map(b => `  ${b}`).join('\n') : '  （沒有）')
const failed = results.filter(r => !r.ok)
console.log(`\n${failed.length ? `❌ ${failed.length} 關紅` : `✅ 全部 ${results.length} 關綠`}｜截圖在 ${SHOT_DIR}/alt-text-*.png`)
await browser.close()
process.exit(failed.length ? 1 : 0)
