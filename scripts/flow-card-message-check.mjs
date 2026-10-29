/**
 * `C-398` 實機守門員：「卡片訊息」（以前叫輪播訊息）的編輯畫面與預覽，看新程式有沒有真的被執行到。
 *
 *   npm run dev                                          # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3000 node --env-file=.env_myfeel scripts/flow-card-message-check.mjs
 *
 * 驗兩件事：
 *   A. 已經做好的卡片（MYFEEL「乾淨方MAX＿超早鳥倒數」，3 顆沒存樣式的按鈕）：按鈕樣式顯示「文字連結」、
 *      預覽沒有綠色按鈕、內文整段顯示不截兩行——舊卡片的按鈕不會因為改版被換成綠色
 *   B. 新加一則：工具列叫「卡片訊息」、內文上限 1000、「再加一張」、新按鈕預設「綠色按鈕」且預覽是綠色實心；
 *      對照組：切成「文字連結」預覽的綠色就要消失、加第二張卡後預覽不再畫成單張寬卡
 *
 * ⛔ 不按「儲存」，而且所有非 GET 的 /api 一律攔下（開頁自己打的也攔），最後列出攔了哪些。
 * ⚠️ 攔下的副作用：關掉的自動導覽存不進去、每次載入都會再跳——每次要點之前先關一次（點用 el.click()，不吃黑幕）。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
/** MYFEEL */
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99'
/** 乾淨方MAX＿超早鳥倒數：卡片訊息、3 顆 `C-398` 以前做的按鈕（沒存樣式） */
const LEGACY_FLOW_ID = process.env.CHECK_FLOW_ID ?? 'c322a210-28ba-47e7-8cc8-195be2535a53'

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

// 先確認受測的舊卡片還是「有按鈕、都沒存樣式」——不然 A 那幾關證明不了什麼
const flowDoc = await db.collection('flows').doc(LEGACY_FLOW_ID).get()
const legacyMsg = (flowDoc.data()?.messages ?? []).find(m => m?.type === 'flexImageCarousel')
const legacyButtons = (legacyMsg?.columns ?? []).flatMap(c => c.actions ?? [])
if (!legacyButtons.length || legacyButtons.some(b => b.style)) {
  console.error(`受測模組 ${LEGACY_FLOW_ID} 已經沒有「沒存樣式的按鈕」了，換一則來驗`)
  process.exit(1)
}
console.log(`受測舊卡片：${flowDoc.data().name}｜${legacyMsg.columns.length} 張、按鈕 ${legacyButtons.length} 顆（都沒存樣式）`)

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
await page.setViewport({ width: 1600, height: 1100 })
page.on('dialog', d => d.accept())
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 160)))
const blockedWrites = []
await page.setRequestInterception(true)
page.on('request', (req) => {
  if (req.method() !== 'GET' && req.url().includes('/api/')) {
    blockedWrites.push(`${req.method()} ${new URL(req.url()).pathname}`)
    return req.abort()
  }
  req.continue()
})

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
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
const closeTours = () => page.evaluate(() => {
  document.querySelectorAll('.el-tour__closebtn').forEach(b => b.click())
})
/** 照按鈕上的字找（可限定在某個區塊裡），用 el.click()——自動導覽的黑幕不會吃掉 */
const clickByText = (text, scopeSel = 'body', pick = 'first') => page.evaluate((t, sel, p) => {
  const scopes = [...document.querySelectorAll(sel)]
  const scope = p === 'last' ? scopes.at(-1) : scopes[0]
  const btn = [...(scope?.querySelectorAll('button, label') ?? [])].find(b => b.innerText.trim() === t)
  if (!btn) return false
  btn.click()
  return true
}, text, scopeSel, pick)
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

// ── A. 已經做好的卡片 ────────────────────────────────────────
await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow?id=${LEGACY_FLOW_ID}`, { waitUntil: 'networkidle2', timeout: 120_000 })
const openedLegacy = await page.waitForFunction(() => document.querySelectorAll('.carousel-sub-card').length > 0, { timeout: 60_000 }).then(() => true, () => false)
await sleep(800)
await closeTours()
const legacy = await page.evaluate(() => ({
  styles: [...document.querySelectorAll('.carousel-sub-card .el-radio-group')]
    .map(g => g.querySelector('.el-radio-button.is-active')?.innerText.trim() ?? '(沒選)'),
  previewCards: document.querySelectorAll('.fmp-cc--card').length,
  previewPrimary: document.querySelectorAll('.fmp-btn--primary').length,
  previewButtons: document.querySelectorAll('.fmp-cc--card .fmp-btn').length,
  textClamp: (() => {
    const el = document.querySelector('.fmp-cc--card .fmp-cc-text')
    return el ? `${getComputedStyle(el).display}／${getComputedStyle(el).whiteSpace}` : '(沒有內文)'
  })(),
}))
const legacyShot = join(tmpdir(), `flow-card-message-legacy-${process.pid}.png`)
await page.screenshot({ path: legacyShot })
console.log(`舊卡片截圖：${legacyShot}`)
check('A0 打開舊卡片模組', openedLegacy, openedLegacy ? '' : '60 秒內沒出現卡片編輯區——這次 A 沒驗到')
check(`A1 舊按鈕的樣式顯示「文字連結」（${legacyButtons.length} 顆都是）`,
  legacy.styles.length === legacyButtons.length && legacy.styles.every(s => s === '文字連結'), legacy.styles.join('、'))
check('A2 預覽：舊按鈕沒有變綠色、按鈕都還在',
  legacy.previewPrimary === 0 && legacy.previewButtons === legacyButtons.length,
  `綠色 ${legacy.previewPrimary}、按鈕 ${legacy.previewButtons}、卡 ${legacy.previewCards}`)
check('A3 預覽：內文整段換行顯示，不再截兩行', legacy.textClamp === 'block／pre-wrap' || legacy.textClamp === '(沒有內文)', legacy.textClamp)

// ── B. 新加一則卡片訊息 ──────────────────────────────────────
await closeTours()
await page.evaluate(() => document.querySelector('[data-tour="flow-new"]')?.click())
await sleep(1000)
await closeTours()
const addedType = await clickByText('＋ 卡片訊息')
await page.waitForFunction(() => document.querySelectorAll('.carousel-sub-card').length > 0, { timeout: 15_000 }).catch(() => {})
await sleep(600)
await closeTours()
const fresh = await page.evaluate(() => {
  const subs = [...document.querySelectorAll('.carousel-sub-card')]
  const last = subs.at(-1)
  return {
    toolbarOld: [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '＋ 輪播訊息'),
    badge: [...document.querySelectorAll('.badge-purple, [class*="badge"]')].map(e => e.innerText.trim()).filter(Boolean),
    hint: document.body.innerText.includes('放兩張以上，客人會左右滑'),
    bodyLabel: [...(last?.querySelectorAll('label, .admin-field-label, [class*="field-label"]') ?? [])].map(e => e.innerText.trim()).find(t => t.startsWith('內文')) ?? '',
    addLabel: document.querySelector('.carousel-add-card .add-card-label')?.innerText.trim() ?? '',
    single: document.querySelectorAll('.fmp-cc--single').length,
    // ⛔ 要量真的寬度，不能只看 class 在不在：第一版寫 width: 88%，class 在、實際縮成 55px（截圖才看到）
    singleWidth: Math.round(document.querySelector('.fmp-cc--single')?.getBoundingClientRect().width ?? 0),
  }
})
check('B1 工具列叫「＋ 卡片訊息」，舊名字不見了', addedType && !fresh.toolbarOld, `點到=${addedType}、舊名還在=${fresh.toolbarOld}`)
check('B2 這則的標籤叫「卡片訊息」', fresh.badge.includes('卡片訊息'), fresh.badge.join('、').slice(0, 80))
check('B3 「放兩張以上，客人會左右滑」「再加一張」都在', fresh.hint && fresh.addLabel === '再加一張', `提示=${fresh.hint}、加卡=「${fresh.addLabel}」`)
check('B4 內文上限 1000', fresh.bodyLabel.includes('最多 1000 字'), `「${fresh.bodyLabel}」`)
check('B5 只有一張時預覽畫成單張寬卡（真的有 240px 以上，還是空的卡也一樣）', fresh.single === 1 && fresh.singleWidth >= 240,
  `單張寬卡 ${fresh.single}、寬 ${fresh.singleWidth}px`)

const addedBtn = await clickByText('⊕ 新增按鈕（選填）', '.carousel-sub-card', 'last')
await sleep(600)
const withBtn = await page.evaluate(() => ({
  style: [...document.querySelectorAll('.carousel-sub-card')].at(-1)?.querySelector('.el-radio-button.is-active')?.innerText.trim() ?? '(沒選)',
  primary: document.querySelectorAll('.fmp-cc--single .fmp-btn--primary').length,
  primaryBg: (() => { const el = document.querySelector('.fmp-btn--primary'); return el ? getComputedStyle(el).backgroundColor : '' })(),
}))
const shotPath = join(tmpdir(), `flow-card-message-${process.pid}.png`)
await page.screenshot({ path: shotPath })
check('B6 新按鈕預設「綠色按鈕」，預覽是綠色實心',
  addedBtn && withBtn.style === '綠色按鈕' && withBtn.primary === 1 && withBtn.primaryBg === 'rgb(6, 199, 85)',
  `樣式=${withBtn.style}、預覽綠色 ${withBtn.primary}、底色 ${withBtn.primaryBg}`)

// 對照組①：切成文字連結，預覽的綠色就要消失
await clickByText('文字連結', '.carousel-sub-card', 'last')
await sleep(500)
const switched = await page.evaluate(() => document.querySelectorAll('.fmp-btn--primary').length)
check('B7 對照組：切成「文字連結」→ 預覽不再是綠色', switched === 0, `綠色 ${switched}`)

// 對照組②：加第二張，預覽不再是單張寬卡
await page.evaluate(() => [...document.querySelectorAll('.carousel-add-card')].find(b => b.innerText.includes('再加一張'))?.click())
await sleep(600)
const two = await page.evaluate(() => ({
  cards: document.querySelectorAll('.fmp-cc--card').length,
  single: document.querySelectorAll('.fmp-cc--single').length,
}))
check('B8 對照組：加第二張 → 預覽兩張、不再畫成單張寬卡', two.cards === 2 && two.single === 0, `卡 ${two.cards}、單張寬卡 ${two.single}`)

check('C 全程沒有存模組（非 GET 的 /api 全部攔下）', !blockedWrites.some(w => w.includes('/api/flow')),
  blockedWrites.length ? `攔下 ${blockedWrites.length} 筆：${blockedWrites.join('、').slice(0, 160)}` : '一筆都沒有')

await browser.close()
let red = 0
for (const r of results) {
  if (!r.ok) red++
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}　${r.detail}`)
}
console.log(`\n${results.length - red} 綠 / ${red} 紅（截圖：${shotPath}）`)
process.exit(red ? 1 : 0)
