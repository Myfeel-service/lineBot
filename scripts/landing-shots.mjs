/**
 * 官網「系統實際介面」截圖產生器（2026-08-26 老闆拍板「截我們自己系統的圖」）。
 *
 *   1. node --env-file=.env --experimental-strip-types scripts/landing-demo-seed.ts   # 先種示範資料
 *   2. npm run dev                                                                    # 起本機 dev
 *   3. node --env-file=.env scripts/landing-shots.mjs                                 # 產出 public/landing/*.png
 *
 * 做法：用 .env 的 admin 憑證替 Kevin 的帳號鑄 custom token 換真 idToken，
 * 注入 headless Chrome 的 IndexedDB（Firebase Auth 的持久化位置）＝真登入，
 * 然後開 Myfeel Test 的後台頁面、裁出示範資料的區域。
 *
 * ⛔ 兩條紅線：
 *   1. 截圖必須是系統真的渲染出來的畫面，不可以自己拼假圖。
 *   2. 好友頁只能裁到示範資料那幾列（本腳本裁前 5 列＝種進去的 5 位）——
 *      測試工作區下面幾列是**真實同事**的名字與頭像，入鏡就是把個資放上官網。
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import puppeteer from 'puppeteer'

const WID = 'f2d418e2-9f5a-4123-86db-2d9d5bc6a779' // Myfeel Test
const UID = 'UuLqUQVbd5OTEzzEHVQP0s4AGaX2' // kevin.chiang@myfeel-tw.com（本人帳號，本機截圖用）
const BASE = process.env.SHOTS_BASE_URL || 'http://localhost:3000'
const OUT = new URL('../public/landing/', import.meta.url).pathname

// ── 換真 token ──
const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
})
const apiKey = process.env.FIREBASE_API_KEY
const custom = await getAuth(app).createCustomToken(UID)
const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
}).then(r => r.json())
if (!signIn.idToken) throw new Error(`token exchange failed: ${JSON.stringify(signIn)}`)
const lookup = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ idToken: signIn.idToken }),
}).then(r => r.json())
const acct = lookup.users?.[0] ?? {}

const AUTH = {
  apiKey,
  uid: UID,
  email: acct.email ?? null,
  displayName: acct.displayName ?? null,
  photoURL: acct.photoUrl ?? null,
  idToken: signIn.idToken,
  refreshToken: signIn.refreshToken,
  expiresInSec: Number(signIn.expiresIn ?? 3600),
  createdAt: acct.createdAt ?? String(Date.now()),
  lastLoginAt: String(Date.now()),
}

// ── 登入態注入＋截圖 ──
const browser = await puppeteer.launch({ headless: 'new' })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 })

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.evaluate(async (auth) => {
  const rec = {
    fbase_key: `firebase:authUser:${auth.apiKey}:[DEFAULT]`,
    value: {
      uid: auth.uid,
      email: auth.email,
      emailVerified: true,
      displayName: auth.displayName,
      isAnonymous: false,
      photoURL: auth.photoURL,
      providerData: [{ providerId: 'google.com', uid: auth.email, displayName: auth.displayName, email: auth.email, phoneNumber: null, photoURL: auth.photoURL }],
      stsTokenManager: {
        refreshToken: auth.refreshToken,
        accessToken: auth.idToken,
        expirationTime: Date.now() + (auth.expiresInSec - 60) * 1000,
      },
      createdAt: auth.createdAt,
      lastLoginAt: auth.lastLoginAt,
      apiKey: auth.apiKey,
      appName: '[DEFAULT]',
    },
  }
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('firebaseLocalStorageDb', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
    open.onsuccess = () => {
      const tx = open.result.transaction('firebaseLocalStorage', 'readwrite')
      tx.objectStore('firebaseLocalStorage').put(rec)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  })
}, AUTH)

// 圖一：對話串（AI／機器人／真人徽章＋昨天／今天分隔）。
// ⚠️ 深連結要帶 tab=all：?userId= 只在「全部」分頁會自動選人。
await page.goto(`${BASE}/admin/${WID}/conversations?tab=all&userId=demolanding-u1`, { waitUntil: 'networkidle2', timeout: 90000 })
await page.waitForFunction(() => document.body.innerText.includes('日出配方'), { timeout: 45000 })
await new Promise(r => setTimeout(r, 2000))
const convClip = await page.evaluate(() => {
  const wrap = document.querySelector('.conv-messages')
  if (!wrap) return null
  const kids = [...wrap.querySelectorAll(':scope > *, :scope > * > *')].filter(el => el.getBoundingClientRect().height > 0)
  const r = wrap.getBoundingClientRect()
  let top = Infinity
  let bottom = -Infinity
  for (const el of kids) {
    const b = el.getBoundingClientRect()
    if (b.top < top) top = b.top
    if (b.bottom > bottom) bottom = b.bottom
  }
  return { x: Math.max(0, r.left), y: Math.max(0, top - 10), width: r.width, height: Math.min(bottom + 12, r.bottom) - Math.max(0, top - 10) }
})
if (!convClip) throw new Error('找不到 .conv-messages（對話沒開起來？）')
await page.screenshot({ path: `${OUT}admin-chat.png`, clip: convClip })
console.log('admin-chat.png ok')

// 圖二：好友頁前 5 列（示範好友），只裁到「標籤」欄右緣——
// 加入時間／操作欄在卡片縮圖裡讀不到，佔寬只會把名字擠小。
await page.goto(`${BASE}/admin/${WID}/users`, { waitUntil: 'networkidle2', timeout: 90000 })
await page.waitForFunction(() => document.body.innerText.includes('曉彤'), { timeout: 45000 })
await new Promise(r => setTimeout(r, 2000))
const usersClip = await page.evaluate(() => {
  const card = document.querySelector('.users-page-card')
  const rows = [...document.querySelectorAll('.users-page-card tbody tr')]
  if (!card || rows.length < 5) return null
  const header = document.querySelector('.users-page-card thead')
  const r = card.getBoundingClientRect()
  const top = (header ?? rows[0]).getBoundingClientRect().top
  const bottom = rows[4].getBoundingClientRect().bottom
  const ths = [...document.querySelectorAll('.users-page-card thead th')]
  const tagTh = ths.find(th => th.textContent.trim() === '標籤')
  const right = tagTh ? tagTh.getBoundingClientRect().right : r.right - 1
  return { x: r.left + 1, y: top, width: right - r.left - 1, height: bottom - top }
})
if (!usersClip) throw new Error('好友頁列數不足 5（示範資料沒種？）')
await page.screenshot({ path: `${OUT}admin-friends-tags.png`, clip: usersClip })
console.log('admin-friends-tags.png ok')

// 圖三：開通引導對話（60 秒區）。用種好的「山丘咖啡」示範工作區——它**刻意沒接 LINE**，
// 開這頁就會停在「拿鑰匙」步驟，畫面有進度條＋兩句引導＋兩顆選擇鈕。
// ⚠️ 等「教我一步步拿」出現才截（訊息是逐句打出來的）；下緣裁到最後一顆按鈕＋26px。
const DEMO_WS = 'b3f1c9e2-71a4-4d2e-9c55-1a2b3c4d5e6f'
await page.goto(`${BASE}/admin/onboarding?workspaceId=${DEMO_WS}`, { waitUntil: 'networkidle2', timeout: 90000 })
await page.waitForFunction(() => document.body.innerText.includes('教我一步步拿'), { timeout: 60000 })
await new Promise(r => setTimeout(r, 1500))
const onbClip = await page.evaluate(() => {
  const shell = document.querySelector('.onbc-shell')
  if (!shell) return null
  const r = shell.getBoundingClientRect()
  const btns = [...shell.querySelectorAll('button, .el-button')].filter(b => b.getBoundingClientRect().height > 0)
  let bottom = 0
  for (const b of btns) bottom = Math.max(bottom, b.getBoundingClientRect().bottom)
  return { x: r.left, y: r.top, width: r.width, height: Math.min(bottom + 26, r.bottom) - r.top }
})
if (!onbClip) throw new Error('找不到 .onbc-shell（開通引導沒開起來？）')
await page.screenshot({ path: `${OUT}admin-onboarding.png`, clip: onbClip })
console.log('admin-onboarding.png ok')

await browser.close()
console.log('done →', OUT)
