/**
 * 知識庫匯入視窗收新檔案種類的實機守門員（`C-296`，`D-120` 第 1 步）。
 *
 *   BROADCAST_CRON_ENABLED=false npx nuxt dev --port 3331                     # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3331 node --env-file=.env_myfeel scripts/kb-import-file-kinds-check.mjs
 *
 * 守的是什麼：選檔框真的收 Word／PPT／CSV／文字檔／照片（`accept` 清單）、選了之後畫面講對是什麼、
 * 收不了的（舊版 .doc、Pages）當場講怎麼辦、而且整個視窗打得開沒有執行期錯誤。
 * 單元測試驗得到「副檔名 → 哪一個抽取函式」，驗不到「元件 setup 有沒有炸」——
 * 這個視窗吃過兩次 TDZ（衍生值排在來源前面），typecheck 全綠、按下「加入知識」一片空白。
 *
 * ⚠️ **連的是正式資料庫（myfeel），但正式庫零寫入**：
 *    - 讀 `workspaceMembers` 找一個管理員登入（唯讀；登入會更新那位的「最後登入時間」）
 *    - 瀏覽器裡**所有不是 GET 的 /api 請求一律攔下回假的 200**，⛔ 一個都不會送到伺服器
 *      （所以就算哪裡自己觸發了上傳／整理，也不會建出任何東西）；跑完列出攔了哪些
 *    - 導覽「看過了」也攔下來回假的（不寫 `adminUserPrefs`，不必還原）
 *    - ⛔ 不按「先看 AI 整理的結果」：只驗選檔、判別、錯誤訊息
 */
import { deflateRawSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

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
console.log(`登入身分：${session.email}（${admin.role}）\n`)

// 所有導覽 id：攔下「看過哪些導覽」那支，回「全都看過」——自動導覽不會跳出來擋畫面，也不寫正式庫
const TOUR_IDS = [...readFileSync('app/utils/tutorial-topics.ts', 'utf8').matchAll(/\bid: '([a-z0-9-]+)'/g)].map(m => m[1])

// ── 測試檔案（在暫存資料夾現做，不碰任何真的文件）──────────────────────
function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8'); const data = deflateRawSync(raw); const nameBuf = Buffer.from(name)
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034B50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8)
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(nameBuf.length, 26)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014B50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10)
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42)
    locals.push(l, nameBuf, data); centrals.push(c, nameBuf); offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054B50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10)
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, e])
}
const dir = mkdtempSync(join(tmpdir(), 'kb-kinds-'))
const files = {
  docx: ['退換貨政策.docx', makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>七天鑑賞期</w:t></w:r></w:p></w:body></w:document>' })],
  pptx: ['新品簡報.pptx', makeZip({ 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>W1</a:t></a:r></a:p></p:sld>' })],
  csv: ['商品匯出.csv', Buffer.from('品名,價格\nW1,"12,900"\n', 'utf8')],
  heic: ['價目表.HEIC', Buffer.from('not-really-heic')],
  doc: ['舊說明書.doc', Buffer.from('old binary')],
  pages: ['報價單.pages', Buffer.from('apple')],
}
const pathOf = {}
for (const [k, [name, buf]] of Object.entries(files)) {
  pathOf[k] = join(dir, name)
  writeFileSync(pathOf[k], buf)
}

let failed = false
const fail = (msg, detail = '') => { failed = true; console.error(`❌ ${msg}${detail ? `\n     ${detail}` : ''}`) }
const pass = msg => console.log(`✅ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const blockedWrites = []
const pageErrors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/api/admin/tour-seen') && req.method() === 'GET') {
      return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ seen: TOUR_IDS }) })
    }
    // ⛔ 正式庫零寫入：/api 底下不是 GET 的一律不送出
    if (url.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      blockedWrites.push(`${req.method()} ${new URL(url).pathname}`)
      return void req.respond({ status: 200, contentType: 'application/json', body: '{}' })
    }
    req.continue()
  })
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 300)))
  page.on('dialog', async d => { await d.dismiss().catch(() => {}) })

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 180_000 })
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

  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/knowledge/sources?import=1`, { waitUntil: 'networkidle2', timeout: 180_000 })
  // dev 首次編譯慢：輪詢等視窗出現，⛔ 不用固定 sleep
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !(await page.$('.kb-drop'))) await sleep(500)
  if (!(await page.$('.kb-drop'))) throw new Error('匯入視窗沒有打開（找不到 .kb-drop）')
  pass('匯入視窗打得開')

  const accept = await page.$eval('.kb-file-input', el => el.getAttribute('accept') ?? '')
  for (const ext of ['.pdf', '.xlsx', '.csv', '.docx', '.pptx', '.txt', '.md', '.jpg', '.png', '.heic']) {
    if (!accept.split(',').includes(ext)) fail(`選檔框沒收 ${ext}`, accept)
  }
  if (!failed) pass(`選檔框收 ${accept.split(',').length} 種副檔名（含 Word／PPT／CSV／照片）`)

  const hintLine = await page.$eval('.kb-drop__or', el => el.innerText)
  if (hintLine.includes('PDF、Word、PPT、Excel、CSV、文字檔、照片')) pass('投放框底下那行講新的收法')
  else fail('投放框底下那行還是舊的', hintLine)

  /** 選一個檔，回畫面上的判別結果；每次先清掉上一個 */
  async function choose(key) {
    if (await page.$('.kb-drop__file')) {
      await page.evaluate(() => [...document.querySelectorAll('.kb-drop__file button')].find(b => b.innerText.includes('換一個'))?.click())
      await sleep(300)
    }
    const input = await page.$('.kb-file-input')
    await input.uploadFile(pathOf[key])
    await sleep(600)
    const label = await page.$eval('.kb-detected__label', el => el.innerText).catch(() => '')
    if (label) {
      await page.evaluate(() => document.querySelector('.kb-detected__more')?.click())
      await sleep(200)
    }
    const hint = await page.$eval('.kb-detected__hint', el => el.innerText).catch(() => '')
    const toasts = await page.$$eval('.toast', els => els.map(e => e.innerText))
    return { label, hint, toasts }
  }

  const expectations = [
    ['docx', 'Word 文件', '表格會照欄位讀'],
    ['pptx', '簡報', '圖片上的字讀不到'],
    ['csv', 'CSV 表格', 'Big5'],
    ['heic', '照片', '認照片上的字'],
  ]
  for (const [key, wantLabel, wantHint] of expectations) {
    const r = await choose(key)
    if (r.label === wantLabel && r.hint.includes(wantHint)) pass(`選「${files[key][0]}」→ 認成「${r.label}」，說明有講「${wantHint}」`)
    else fail(`選「${files[key][0]}」判別不對`, `label=${r.label} hint=${r.hint.slice(0, 80)} toasts=${r.toasts.join('｜')}`)
  }

  for (const [key, wantToast] of [['doc', '另存新檔'], ['pages', '輸出']]) {
    await page.evaluate(() => [...document.querySelectorAll('.kb-drop__file button')].find(b => b.innerText.includes('換一個'))?.click())
    await sleep(300)
    const input = await page.$('.kb-file-input')
    await input.uploadFile(pathOf[key])
    await sleep(500)
    const toasts = await page.$$eval('.toast', els => els.map(e => e.innerText))
    const stillEmpty = !(await page.$('.kb-drop__file'))
    if (toasts.some(t => t.includes(wantToast)) && stillEmpty) pass(`選「${files[key][0]}」→ 不收，當場講怎麼辦（「${toasts.find(t => t.includes(wantToast))}」）`)
    else fail(`選「${files[key][0]}」沒有講怎麼辦，或被收進去了`, `toasts=${toasts.join('｜')} empty=${stillEmpty}`)
    await sleep(3800) // toast 3.5 秒消失，下一關才不會讀到上一則
  }
}
catch (e) {
  fail('守門員中斷', String(e?.stack ?? e).slice(0, 400))
}
finally {
  await browser.close()
}

if (pageErrors.length) fail(`頁面有 ${pageErrors.length} 個執行期錯誤`, pageErrors.join('\n     '))
else pass('全程零執行期錯誤')
// 只選檔不按整理：知識庫那邊連「拿上傳網址」都不該發生；有攔到就代表某處自己觸發了上傳／整理。
// 「導覽看過了」那支是頁面自己會送的（跟匯入無關），一樣攔下、只列出來不算失敗。
const kbWrites = blockedWrites.filter(w => w.includes('/api/ai/'))
const otherWrites = blockedWrites.filter(w => !w.includes('/api/ai/'))
if (kbWrites.length) fail('知識庫有不該發生的寫入請求（已攔下、沒有送到伺服器）', kbWrites.join('\n     '))
else pass('知識庫零寫入請求（沒有上傳、沒有建整理工作）')
if (otherWrites.length) console.log(`ℹ️  另外攔下 ${otherWrites.length} 支頁面自己送的寫入（沒有送到伺服器）：${[...new Set(otherWrites)].join('、')}`)

if (failed) { console.error('\n有關卡沒過'); process.exit(1) }
console.log('\n全部通過')
