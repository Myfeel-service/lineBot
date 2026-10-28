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
 * 打開的是**正式資料裡真的存在**的那則（鼴究室「飛利浦AC0510｜預熱」，276 字＋一顆按鈕）。
 * `H-27` 時它超過按鈕範本的 160 字、被切掉；`C-397` 起「文字＋按鈕」改送卡片、上限 5000，所以現在應該：
 *   ① 字數顯示 276 / 5000，不是紅的
 *   ② 沒有紅色警告
 *   ③ 右側預覽一字不缺（停在最後一句「3 年一換」）、沒有「送不出去」那段
 * 對照組（⛔ 只有「沒有警告」的話，警告整個壞掉也是綠的）：在畫面上把文字改成 5001 字（不存檔），
 *   ④ 警告、紅字、預覽「這張卡 LINE 只收 5000 字」都要出現
 *
 * ⛔ 不按「儲存變更」：以前這則存不進去所以按了安全，現在存得過＝會真的寫進正式資料。
 *    保險起見所有非 GET 的 /api 請求一律攔下來（開頁自己打的也攔），最後列出攔了哪些。
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

// 先確認那則模組還在、而且超過 160（不然「現在不紅了」證明不了什麼——它本來就不會紅）
const flowDoc = await db.collection('flows').doc(FLOW_ID).get()
if (!flowDoc.exists) { console.error(`查無模組 ${FLOW_ID}`); process.exit(1) }
const target = (flowDoc.data().messages ?? []).find(m => m?.type === 'text' && Array.isArray(m.buttons) && m.buttons.length > 0)
if (!target) { console.error('這則模組裡沒有「文字＋按鈕」的訊息，換一則來驗'); process.exit(1) }
const fullText = String(target.text || '')
console.log(`受測模組：${flowDoc.data().name}｜文字 ${fullText.length} 字、按鈕 ${target.buttons.length} 顆`)
if (fullText.length <= 160) { console.error('這則已經不超過 160 了（有人改短？）——換一則超過 160 的來驗'); process.exit(1) }

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
// 零寫入：所有非 GET 的 /api 一律攔下（開頁會自己打的 POST 也算在內，被攔不影響這裡要看的東西）
const blockedWrites = []
await page.setRequestInterception(true)
page.on('request', (req) => {
  if (req.method() !== 'GET' && req.url().includes('/api/')) {
    blockedWrites.push(`${req.method()} ${new URL(req.url()).pathname}`)
    req.abort()
    return
  }
  req.continue()
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

const read = () => page.evaluate(() => {
  // ⛔ `.is-exceed` 掛在 `.el-textarea` 外層不是在字數元素上（EP 的 textarea 就是這樣），
  //    所以要問外層有沒有那個 class，別問字數元素自己。
  const textarea = document.querySelector('.flow-textarea-wrapper--var-inset .el-textarea')
  const count = document.querySelector('.flow-textarea-wrapper--var-inset .el-input__count')
  const warn = document.querySelector('.flow-text-overflow')
  const cut = document.querySelector('.fmp-card-cut')
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
    cardTail: cardText?.innerText?.trim().slice(-16) ?? '',
  }
})
// ⛔ 不能只判 `.is-exceed` 在不在：我們自己的樣式專一度較高，class 在、顏色照樣是灰的
//    （`H-27` 第一次跑就是這樣紅的）。所以要連「真的變紅了」一起量。
const isRed = (color) => {
  const rgb = String(color).match(/\d+/g)?.map(Number) ?? []
  return rgb.length >= 3 && rgb[0] > 180 && rgb[0] > rgb[1] + 60 && rgb[0] > rgb[2] + 60
}

const seen = await read()
check(`① 字數顯示 ${fullText.length} / 5000，不是紅的`,
  seen.countText.includes(`${fullText.length} / 5000`) && !seen.countExceed && !isRed(seen.countColor),
  `「${seen.countText}」is-exceed=${seen.countExceed} 顏色=${seen.countColor}`)
check('② 沒有紅色警告', !seen.warnVisible, seen.warnVisible ? `「${seen.warnText.slice(0, 60)}」` : '沒有')
check('③ 預覽一字不缺（停在最後一句）、沒有「送不出去」那段',
  fullText.trim().endsWith(seen.cardTail) && !seen.cutVisible,
  `結尾「…${seen.cardTail}」送不出去那段=${seen.cutVisible}`)

// ── ④ 對照組：在畫面上改成 5001 字（不存檔），紅字、警告、預覽要全部出現 ──────────
await page.evaluate(() => {
  const el = document.querySelector('.flow-textarea-wrapper--var-inset textarea')
  // ⛔ 不能用 el.value=：maxlength 只擋打字不擋程式設值，但 Vue 要收到 input 事件才會更新資料
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, '飛'.repeat(5001))
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await new Promise(r => setTimeout(r, 800))
const over = await read()
check('④ 對照組 5001 字：字數紅、警告說超過 1 字、預覽說這張卡只收 5000 字',
  over.countExceed && isRed(over.countColor) && over.warnVisible && over.warnText.includes('超過 1 字')
    && over.cutVisible && over.cutLabel.includes('只收 5000 字'),
  `「${over.countText}」紅=${isRed(over.countColor)}｜「${over.warnText.slice(0, 40)}」｜「${over.cutLabel}」`)
check('⑤ 全程沒有寫入（非 GET 的 /api 全部攔下，沒有任何一筆是存模組）',
  !blockedWrites.some(w => w.includes('/api/flow')),
  blockedWrites.length ? `攔下 ${blockedWrites.length} 筆：${blockedWrites.join('、').slice(0, 160)}` : '一筆都沒有')

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
