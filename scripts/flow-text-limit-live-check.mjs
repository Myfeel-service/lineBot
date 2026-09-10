/**
 * `H-27` 實機守門員：開真的「機器人模組」編輯器，看新程式有沒有真的被執行到。
 *
 *   npm run dev                                          # 另一個終端先跑起來
 *   node --env-file=.env_myfeel scripts/flow-text-limit-live-check.mjs
 *
 * 為什麼要有這支：`scripts/flow-text-limit-check.mjs` 量的是版面（自己組 HTML＋真 CSS），
 * 證明得了「樣式沒破版」，證明不了「Vue 那邊真的接上了」。這個專案吃過太多次
 * 「typecheck 綠＋測試綠，但新程式根本沒被執行到」（記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * 打開的是**正式資料裡真的存在**的那則（鼴究室「飛利浦AC0510｜預熱」，276 字＋一顆按鈕），
 * 它現在就是超標狀態，所以三個新東西應該同時現身：
 *   ① 輸入框右下角字數 276/160 且標成超出
 *   ② 輸入框下方紅色警告「超過 116 字」
 *   ③ 右側預覽的按鈕範本卡下方「以下 116 字送不出去」＋刪除線的那段
 *   ④ 按「儲存變更」被擋下來，跳出說得出要刪幾字的錯誤
 *
 * ⛔ ④ 是安全的：前端擋住就不會送出；萬一前端沒擋住，後端 `assertValidFlowMessages`
 *    也會回 400，兩道都擋在寫入之前，不會動到這則模組的內容。
 * ⛔ 這支不改任何資料，也不按其他按鈕。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
/** 鼴究室 */
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '7dfc1033-f069-4a28-8d22-a72cb590a34f'
/** 飛利浦AC0510｜預熱 */
const FLOW_ID = process.env.CHECK_FLOW_ID ?? '58d6846d-7d76-4991-9c60-c4491a756e9c'

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

const db = getFirestore()

// 先確認那則模組還在、而且真的超標——不然下面「沒看到警告」會被誤讀成程式壞掉
const flowDoc = await db.collection('flows').doc(FLOW_ID).get()
if (!flowDoc.exists) { console.error(`查無模組 ${FLOW_ID}`); process.exit(1) }
const target = (flowDoc.data().messages ?? []).find(m => m?.type === 'text' && Array.isArray(m.buttons) && m.buttons.length > 0)
if (!target) { console.error('這則模組裡沒有「文字＋按鈕」的訊息，換一則來驗'); process.exit(1) }
const overflow = String(target.text || '').length - 160
console.log(`受測模組：${flowDoc.data().name}｜文字 ${String(target.text).length} 字、按鈕 ${target.buttons.length} 顆 → 應超出 ${overflow} 字`)
if (overflow <= 0) { console.error('這則已經不超標了（有人修過？）——換一則超標的來驗'); process.exit(1) }

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

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1100 })
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

await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow`, { waitUntil: 'networkidle2', timeout: 120_000 })
await page.waitForSelector('.flow-sidebar-row', { timeout: 60_000 })

// 點開那則模組（用清單列的文字比對找到它）
const opened = await page.evaluate((name) => {
  const row = [...document.querySelectorAll('.flow-sidebar-row')]
    .find(el => el.innerText?.includes(name))
  if (!row) return false
  ;(row.querySelector('.flow-sidebar-row__item') ?? row).click()
  return true
}, flowDoc.data().name)
if (!opened) { console.error(`左側清單找不到「${flowDoc.data().name}」`); await browser.close(); process.exit(1) }
await page.waitForSelector('.flow-textarea-wrapper textarea', { timeout: 30_000 })
await new Promise(r => setTimeout(r, 1500))

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const seen = await page.evaluate(() => {
  // ⛔ `.is-exceed` 掛在 `.el-textarea` 外層不是在字數元素上（EP 的 textarea 就是這樣），
  //    所以要問外層有沒有那個 class，別問字數元素自己。
  const textarea = document.querySelector('.flow-textarea-wrapper--var-inset .el-textarea')
  const count = document.querySelector('.flow-textarea-wrapper--var-inset .el-input__count')
  const warn = document.querySelector('.flow-text-overflow')
  const cut = document.querySelector('.fmp-card-cut')
  const cutText = document.querySelector('.fmp-card-cut-text')
  const cardText = document.querySelector('.fmp-card-text')
  const vis = el => !!el && el.offsetHeight > 0
  return {
    countText: count?.innerText?.trim() ?? '(沒有字數)',
    countExceed: !!textarea && textarea.className.includes('is-exceed'),
    countColor: count ? getComputedStyle(count).color : '',
    warnVisible: vis(warn),
    warnText: warn?.innerText?.trim().replace(/\s+/g, ' ') ?? '',
    cutVisible: vis(cut),
    cutLabel: document.querySelector('.fmp-card-cut-label')?.innerText?.trim() ?? '',
    cutTail: cutText?.innerText?.trim().slice(-14) ?? '',
    cardTail: cardText?.innerText?.trim().slice(-16) ?? '',
    lineThrough: cutText ? getComputedStyle(cutText).textDecorationLine : '',
  }
})

// ⛔ 不能只判 `.is-exceed` 在不在：我們自己的樣式專一度較高，class 在、顏色照樣是灰的
//    （第一次跑就是這樣紅的）。所以要連「真的變紅了」一起量。
const rgb = String(seen.countColor).match(/\d+/g)?.map(Number) ?? []
const isRed = rgb.length >= 3 && rgb[0] > 180 && rgb[0] > rgb[1] + 60 && rgb[0] > rgb[2] + 60
check('① 字數顯示 276/160、標成超出，而且真的是紅的',
  seen.countExceed && seen.countText.includes('/ 160') && isRed,
  `「${seen.countText}」is-exceed=${seen.countExceed} 顏色=${seen.countColor}`)
check('② 輸入框下方紅色警告有出現，而且說得出要刪幾字',
  seen.warnVisible && seen.warnText.includes(`超過 ${overflow} 字`),
  `「${seen.warnText.slice(0, 60)}…」`)
check('③ 預覽的文字停在客人真的看得到的位置', seen.cardTail.endsWith('體積'), `結尾「…${seen.cardTail}」`)
check('④ 預覽標出「送不出去」那段，且有刪除線',
  seen.cutVisible && seen.cutLabel.includes(`${overflow} 字送不出去`) && seen.lineThrough.includes('line-through'),
  `「${seen.cutLabel}」結尾「…${seen.cutTail}」${seen.lineThrough}`)

// ── ⑤ 按儲存要被擋下來 ────────────────────────────────────────
// 兩道守門（前端 validateMessages／後端 assertValidFlowMessages）都在寫入之前，
// 所以按下去不會動到這則模組的內容。
let sawWrite = false
page.on('request', (req) => {
  if (req.method() === 'PUT' && req.url().includes('/api/flow/')) sawWrite = true
})
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '儲存變更')
  if (!btn) return false
  btn.click()
  return true
})
if (!clicked) check('⑤ 按「儲存變更」被擋下來', false, '找不到儲存按鈕')
else {
  await new Promise(r => setTimeout(r, 2500))
  // ⛔ 這一頁的提示不是 Element Plus 的 `.el-message`，是自家的 `.toast-bar .toast`
  //    （`app/components/AdminToastStack.vue`）。第一次抓錯選擇器，看起來像「沒有提示」。
  const msg = await page.evaluate(() =>
    [...document.querySelectorAll('.toast-bar .toast')].map(el => el.innerText.trim()).join(' | '))
  check('⑤ 按「儲存變更」被擋下來，訊息說得出要刪幾字',
    msg.includes('160') && msg.includes(`刪掉 ${overflow} 字`), `「${msg.slice(0, 90)}」`)
  check('⑤b 真的沒有送出寫入請求（擋在寫入之前，沒動到資料）', !sawWrite, sawWrite ? '有發出 PUT！' : '沒有任何 PUT')
}

const shotPath = join(tmpdir(), `flow-text-limit-live-${process.pid}.png`)
await page.screenshot({ path: shotPath, fullPage: false })

let red = 0
for (const r of results) {
  if (!r.ok) red++
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}　${r.detail}`)
}
console.log(`\n${results.length - red} 綠 / ${red} 紅（截圖：${shotPath}）`)
await browser.close()
process.exit(red ? 1 : 0)
