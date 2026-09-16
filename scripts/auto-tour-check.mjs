/**
 * 「每個帳號第一次進某一頁自動跑導覽」的實機守門員（2026-09-16）。
 *
 *   npm run dev -- --port 3311                                   # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3311 node --env-file=.env_myfeel scripts/auto-tour-check.mjs
 *
 * 為什麼一定要真的開瀏覽器：純函式只測得到「條件到齊要不要跑」（`app/utils/auto-tour-gate.test.ts`），
 * 但這個功能真正會壞的地方全在時序上——角色什麼時候載進來、後端記憶什麼時候回來、
 * 開通導覽會不會跟它搶。這個專案吃過「typecheck 綠＋測試綠，但新程式根本沒被執行到」
 * （記憶 `feedback_verify_new_code_actually_runs`），這裡不重蹈。
 *
 * ⚠️ 寫入範圍：只碰 `adminUserPrefs/{uid}` 這一份文件（這次新開的集合，只存
 *    「這個人看過哪幾頁的導覽」）。開跑前先刪、跑完再刪，不留東西；其他 collection 一律沒碰。
 *
 * 第 3 關是重點：換一個全新的瀏覽器設定檔（localStorage 全空）再進同一頁。
 * 記憶若還是記在瀏覽器上，這一關一定會再跳一次導覽——這關綠了，「每個帳號一次」才算數。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL
/** 拿推播頁當樣本：只掛一支教學（不會跳出「先讓人挑」的下拉），而且不需要先選任何資料 */
const PAGE_PATH = 'broadcasts'
const TOUR_KEY = 'broadcasts'

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

const prefsRef = db.collection('adminUserPrefs').doc(uid)
const resetSeen = () => prefsRef.delete()

let failed = false
const fail = (msg) => { failed = true; console.error(`❌ ${msg}`) }
const pass = (msg) => console.log(`✅ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

/** 開一個帶登入狀態的分頁。`freshProfile` ＝ 全新設定檔，等於換一台裝置 */
async function openLoggedInPage(freshProfile) {
  const ctx = freshProfile ? await browser.createBrowserContext() : browser.defaultBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
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
  return { page, ctx }
}

/**
 * 進那一頁，等最多 waitMs 看導覽有沒有自己跳出來；回傳跳出來的標題（沒跳回 null）。
 *
 * ⛔ 「沒跳」這個結果一定要先證明**人真的站在那一頁上**才算數：沒登入成功被踢回登入頁、
 *    或整頁掛掉，一樣是「沒跳導覽」。不驗這一步的話，第 2、3 關會是假綠燈——
 *    而第 3 關（換裝置）正是這次唯一能證明「記憶在帳號上」的那一關。
 */
async function visitAndWatchTour(page, waitMs = 7000) {
  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/${PAGE_PATH}`, { waitUntil: 'networkidle2', timeout: 90_000 })
  if (!page.url().includes(`/admin/${WORKSPACE_ID}/${PAGE_PATH}`))
    throw new Error(`沒有停在推播頁，現在在 ${page.url()}（多半是沒登入成功）`)
  // 問號按鈕出現 ＝ 教學清單已依角色算完，這時候「沒跳導覽」才是真的沒跳
  await page.waitForSelector('.page-help-btn', { timeout: 60_000 })
  try {
    await page.waitForSelector('.ta-tour-title', { visible: true, timeout: waitMs })
    return await page.$eval('.ta-tour-title', el => el.textContent?.trim() ?? '')
  }
  catch {
    return null
  }
}

async function readSeenViaApi(page) {
  return page.evaluate(async (token) => {
    const res = await fetch('/api/admin/tour-seen', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return { error: res.status }
    return res.json()
  }, session.idToken)
}

try {
  // ── 第 1 關：第一次進這一頁，導覽要自己跳出來 ───────────────────────────
  await resetSeen()
  const first = await openLoggedInPage(false)
  const title = await visitAndWatchTour(first.page)
  if (title) pass(`第一次進推播頁：導覽自己跳出來了（第一步標題「${title}」）`)
  else fail('第一次進推播頁：等了 7 秒導覽沒跳出來')

  // 記帳是導覽開起來之後才送出的，給它落地的時間再查
  await sleep(2500)
  const seen = await readSeenViaApi(first.page)
  if (Array.isArray(seen?.seen) && seen.seen.includes(TOUR_KEY)) pass(`後端記住了這個帳號看過「${TOUR_KEY}」`)
  else fail(`後端沒記住：${JSON.stringify(seen)}`)

  const snap = await prefsRef.get()
  if (snap.exists && snap.data()?.seenTours?.[TOUR_KEY]) pass('Firestore 文件 adminUserPrefs/{uid} 真的寫進去了')
  else fail('Firestore 文件沒寫進去（前端以為記了，其實沒有）')

  // ── 第 2 關：同一台再進一次，不可以再跳 ─────────────────────────────────
  const again = await visitAndWatchTour(first.page, 6000)
  if (again) fail(`第二次進同一頁又跳了一次導覽（「${again}」）——這就是當初被否決的騷擾`)
  else pass('第二次進同一頁：沒有再跳')

  // ── 第 3 關：換一台裝置（全新設定檔、localStorage 全空），也不可以再跳 ──
  const fresh = await openLoggedInPage(true)
  const onFresh = await visitAndWatchTour(fresh.page, 6000)
  if (onFresh) fail(`換一台裝置又跳了一次（「${onFresh}」）——記憶還是黏在瀏覽器上，不是黏在帳號上`)
  else pass('換一台裝置：沒有再跳（「每個帳號一次」成立）')
  await fresh.ctx.close()

  // ── 第 4 關：問號還在，而且按了照樣跑得起來（自動跑不可以取代手動入口）──
  await fresh.page?.close?.().catch(() => {})
  const hasBtn = await first.page.$('.page-help-btn')
  if (hasBtn) pass('頁首的問號還在（想再看一遍按得到）')
  else fail('頁首的問號不見了')
  await first.page.click('.page-help-btn')
  try {
    await first.page.waitForSelector('.ta-tour-title', { visible: true, timeout: 8000 })
    pass('按問號照樣開得起來')
  }
  catch {
    fail('按問號開不起來')
  }

  // ── 第 5 關：其他版型的頁面也要跳得起來 ────────────────────────────────
  // 問號掛在三種不同的地方（`AdminSoloPageHeading`、側欄標題、對話頁的 `AdminPanel`），
  // 而導覽的第一步各指各的錨點。只驗一頁的話，某一頁的錨點失效會安靜地不跑，沒人會發現。
  console.log('\n其他頁面：')
  for (const path of ['conversations', 'tags', 'flow', 'knowledge/sources', 'settings/organization']) {
    await resetSeen()
    const { page, ctx } = await openLoggedInPage(true)
    try {
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/${path}`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await page.waitForSelector('.page-help-btn', { timeout: 60_000 })
      await page.waitForSelector('.ta-tour-title', { visible: true, timeout: 9000 })
      pass(`${path}：導覽自己跳出來了（「${await page.$eval('.ta-tour-title', el => el.textContent?.trim() ?? '')}」）`)
    }
    catch (e) {
      fail(`${path}：導覽沒跳出來（${String(e).split('\n')[0]}）`)
    }
    finally {
      await ctx.close()
    }
  }
}
finally {
  await resetSeen().catch(() => {})
  console.log('已清掉這次寫進去的 adminUserPrefs 文件')
  await browser.close()
}

if (failed) process.exitCode = 1
else console.log('\n全部通過')
