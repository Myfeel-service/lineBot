/**
 * 「一次審一顆標籤」抽屜的實機守門員（`D-61`）。
 *
 *   npm run dev                                     # 另一個終端先跑起來（本機 dev 打的是正式 myfeel 資料）
 *   node --env-file=.env_myfeel scripts/tag-review-drawer-check.mjs
 *
 * 為什麼要有這支：這個專案吃過太多次「typecheck 綠＋既有測試綠，但新程式根本沒被執行到」
 * （見記憶 `feedback_verify_new_code_actually_runs`）。純函式測得到的只有挑選與文案，
 * 「點下去有沒有真的開、有沒有真的列出人、勾選有沒有接上」只有真的開一次瀏覽器才知道。
 *
 * ⛔ 這支**只跑到按下去之前**：不按採用／忽略（那會動正式資料）。
 * ⛔ 登入用的是**真的 token**（Admin SDK 開 custom token → 換 idToken → 塞進 Firebase 用的
 *    IndexedDB），不是假 JWT：不用攔 identitytoolkit，token 過期也會自己續。
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

// ── 拿一位這個工作區的管理者，換成瀏覽器用得了的登入狀態 ──────────────
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

// 先開同一個 origin 的頁面，才寫得進它的 IndexedDB
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

await page.goto(`${BASE}/admin/${WORKSPACE_ID}/tags`, { waitUntil: 'networkidle2', timeout: 90_000 })
await page.waitForSelector('.tags-table tbody tr', { timeout: 60_000 })
await new Promise(r => setTimeout(r, 3000)) // 「待審 N 位」是第二支請求，晚一步才會長出來

const fail = msg => { console.error(`❌ ${msg}`); process.exitCode = 1 }
const pending = await page.$$('.tags-pending-link')
console.log(`「待審 N 位」按鈕：${pending.length} 顆`)
if (!pending.length) {
  fail('一顆都沒有——收件匣真的清空了，還是這一頁又壞了？（兩者長得一樣，所以要人看一眼）')
  await browser.close()
  process.exit()
}

await pending[0].click()
await page.waitForSelector('.tag-review__row', { timeout: 20_000 })
const info = await page.evaluate(() => {
  const drawer = document.querySelector('.tag-review')
  const rows = [...document.querySelectorAll('.tag-review__row')]
  return {
    title: document.querySelector('.tag-review__hd')?.innerText.replace(/\n/g, ' '),
    rows: rows.length,
    first: rows[0]?.innerText.replace(/\n/g, ' | '),
    /**
     * ⛔ 不可以只判「有沒有 .tag-review__why 這個元素」（2026-09-04 code review 抓到）：
     *    沒有依據時樣板照樣渲染一個同 class 的元素（寫著「這條沒有留下判斷依據（舊資料）」），
     *    所以那樣寫**永遠不會紅**＝一盞裝成守門員的綠燈。
     *    要數的是真的沒有依據的那幾列（帶 --none 的），並且把數字講出來。
     */
    noReason: rows.filter(r => r.querySelector('.tag-review__why--none')).length,
    actions: [...document.querySelectorAll('.tag-review__actions button')].map(b => b.innerText.trim()),
    overflowX: drawer ? drawer.scrollWidth > drawer.clientWidth + 1 : true,
  }
})
console.log(`抽屜：${info.title}｜列出 ${info.rows} 位`)
console.log(`第一列：${info.first}`)
console.log(`按鈕：${info.actions.join(' / ')}`)
if (info.overflowX) fail('抽屜橫向破版')
// 舊資料本來就可能沒有依據，所以這不是「失敗」而是「要講出來的事實」——
// 全部都沒有依據才是真的壞掉（表示 reason 根本沒被寫進去或沒被回傳）
console.log(`判斷依據：${info.rows - info.noReason}/${info.rows} 列有；${info.noReason} 列是舊資料沒有`)
if (info.rows > 0 && info.noReason === info.rows) fail('每一列都沒有判斷依據＝reason 沒寫進去或沒回傳，那兩顆鈕就按不下去了')
if (!info.actions.includes('關閉')) fail('沒有「關閉」＝這個抽屜沒有出口（它沒有標題列上的 ✕）')

await page.click('.tag-review__row .el-checkbox')
await new Promise(r => setTimeout(r, 300))
const after = await page.evaluate(() => [...document.querySelectorAll('.tag-review__actions button')].map(b => b.innerText.trim()))
console.log(`勾一位後：${after.join(' / ')}`)
if (!after.some(t => t.includes('採用選取的 1 位'))) fail('勾了人，按鈕上的數字沒跟著動＝選取沒接上')

/**
 * ⛔ 截圖**不可以**寫進專案根目錄（2026-09-04 code review 抓到）：這支跑的是
 * 正式 myfeel 資料，圖裡有真實客戶的顯示名稱與 AI 的判斷理由。`.gitignore` 沒有
 * `*.png` 規則，一張未追蹤的 PII 圖躺在根目錄，離「不小心被 add 進 commit」只差一步
 * （這個 repo 已經有過 `git add -A` 掃進別人檔案的前例）。
 * 寫到系統暫存目錄，並把完整路徑印出來讓人找得到。
 */
const shotPath = join(tmpdir(), `tag-review-drawer-${process.pid}.png`)
await page.screenshot({ path: shotPath })
console.log(process.exitCode ? '有問題，見上面 ❌' : `✅ 都對（截圖：${shotPath}）`)
await browser.close()
