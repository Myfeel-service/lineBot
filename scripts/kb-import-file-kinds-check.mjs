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
 *    - 第一段不按「先看 AI 整理的結果」：只驗選檔、判別、錯誤訊息
 *    - 第二段（空間不夠時收到滿為止，`C-296`②）會按到底，但上傳、建整理工作、輪詢、匯入
 *      **全部在瀏覽器裡回假的**——沒有一支送到伺服器，也不花 AI 的錢
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
const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

/**
 * 開一個已登入、匯入視窗打開的頁面。
 * fake(req)：要假造的請求回傳 { status, contentType, body }；回 undefined 照原規則走
 * （GET 照常打到本機伺服器＝唯讀正式庫；不是 GET 的 /api 一律攔下、記一筆、回假的 200）。
 */
async function openImportDialog(fake = () => undefined, opts = {}) {
  const { path = '/knowledge/sources?import=1', waitSel = '.kb-drop' } = opts
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  await page.setRequestInterception(true)
  page.on('request', async (req) => {
    const url = req.url()
    const faked = await fake(req)
    if (faked) return void req.respond(faked)
    if (url.includes('/api/admin/tour-seen') && req.method() === 'GET') return void req.respond(json({ seen: TOUR_IDS }))
    // ⛔ 正式庫零寫入：/api 底下不是 GET 的一律不送出
    if (url.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      blockedWrites.push(`${req.method()} ${new URL(url).pathname}`)
      return void req.respond(json({}))
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

  await page.goto(`${BASE}/admin/${WORKSPACE_ID}${path}`, { waitUntil: 'networkidle2', timeout: 180_000 })
  // dev 首次編譯慢：輪詢等畫面出現，⛔ 不用固定 sleep
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !(await page.$(waitSel))) await sleep(500)
  if (!(await page.$(waitSel))) throw new Error(`畫面沒有出現（找不到 ${waitSel}）`)
  return page
}

/** 等某個條件成立（輪詢，⛔ 不用固定 sleep 等資料） */
async function waitFor(page, fn, arg, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true
    await sleep(300)
  }
  return false
}

try {
  // ── 第一段：收哪些檔、選了之後講對是什麼 ─────────────────────────────
  const page = await openImportDialog()
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
  await page.close()

  // ── 第二段：空間不夠時收到滿為止（`C-296`②）──────────────────────────
  // 上傳、建整理工作、輪詢、匯入全部在瀏覽器裡回假的：正式庫零寫入，也不花 AI 的錢。
  // 情境：免費方案已用 38／50 條，這份整理出 14 條 → 應該先收前 12 條、講 2 條沒收。
  const JOB = 'job-fake-quota'
  const fourteen = Array.from({ length: 14 }, (_, i) => ({ title: `第 ${i + 1} 條`, content: `內容 ${i + 1}`, tags: [], questions: [] }))
  let bulkBody = null
  const quotaPage = await openImportDialog((req) => {
    const url = req.url()
    const m = req.method()
    if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 38, limit: 50, planName: '免費' } })
    if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u1', storagePath: `preview-uploads/${WORKSPACE_ID}/u1.docx`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/u1.docx?sig=fake' })
    // 跨網域上傳：瀏覽器會先問一次（OPTIONS），回應沒帶 CORS 標頭的話 PUT 會被瀏覽器自己擋掉
    if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) {
      return { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
    }
    if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId: JOB, status: 'processing', phase: 'chunk' })
    if (url.includes(`/api/ai/knowledge/preview-jobs/${JOB}`) && m === 'GET') {
      return json({ status: 'done', sourceName: '退換貨政策.docx', sourceUrl: '', sourceType: 'file', rawLength: 900, truncated: false, meta: {}, ocrUsed: false, chunks: fourteen, overviewCard: null, existingMatches: [], warnings: [], suggestedProductName: '', contentHash: 'fake' })
    }
    if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
      bulkBody = JSON.parse(req.postData() || '{}')
      const n = bulkBody.chunks?.length ?? 0
      return json({ sourceId: 'fake-src', total: n, indexed: n, failed: 0, items: [] })
    }
    return undefined
  })
  const firstLine = await quotaPage.$eval('.kb-quota-line', el => el.innerText).catch(() => '')
  if (firstLine.includes('已用 38／50 條，還能放 12 條')) pass(`第一步就看得到空間：「${firstLine.trim()}」`)
  else fail('第一步沒講知識空間', firstLine)

  await (await quotaPage.$('.kb-file-input')).uploadFile(pathOf.docx)
  await sleep(500)
  await quotaPage.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('先看 AI 整理的結果'))?.click())
  const previewShown = await waitFor(quotaPage, () => document.querySelector('.kb-preview-summary')?.innerText.includes('14'))
  if (!previewShown) {
    const onScreen = await quotaPage.$eval('.el-dialog__body', el => el.innerText.slice(0, 400)).catch(() => '（讀不到視窗）')
    throw new Error(`假的整理結果沒有出現在預覽頁；畫面上是：${onScreen.replace(/\n/g, ' ／ ')}`)
  }
  // SHOT_DIR=… 會存畫面（文字對了但破版，斷言看不出來）
  if (process.env.SHOT_DIR) await (await quotaPage.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-quota-preview.png') })
  const summary = await quotaPage.$eval('.kb-preview-summary', el => el.innerText)
  const btn = await quotaPage.$eval('.kb-preview-summary__actions .el-button--primary', el => el.innerText.trim())
  if (summary.includes('先收前 12 條，其餘 2 條先不收') && btn === '先收前 12 條') pass(`放不下時按之前就講：按鈕「${btn}」、說明「…先收前 12 條，其餘 2 條先不收…」`)
  else fail('預覽頁沒講放不下／按鈕沒改口', `btn=${btn}\n     ${summary.replace(/\n/g, ' ／ ')}`)

  await quotaPage.evaluate(() => document.querySelector('.kb-preview-summary__actions .el-button--primary')?.click())
  await waitFor(quotaPage, () => !!document.querySelector('.kb-result-summary'))
  const sent = bulkBody?.chunks?.length
  if (sent === 12) pass('真的只送出 12 條（收到滿為止，不再整批被擋）')
  else fail('送出的條數不對', `送了 ${sent}`)
  if (process.env.SHOT_DIR) await (await quotaPage.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-quota-result.png') })
  const resultLine = await quotaPage.$$eval('.kb-quota-line', els => els.map(e => e.innerText).join(' ／ '))
  if (resultLine.includes('還有 2 條因為知識空間不夠沒收進去')) pass('結果頁講出還有 2 條沒收、怎麼補')
  else fail('結果頁沒講沒收進去的條數', resultLine)
  await quotaPage.close()

  // ── 第三段：資料頁的「下載原檔」（`C-296`③）──────────────────────────
  // 正式庫裡還沒有任何一份留了原檔（這次才開始留），所以資料清單照實向伺服器拿（唯讀），
  // 只在瀏覽器裡替第一份資料補上「有原檔」；下載網址與下載本身也回假的。
  let patchedId = ''
  let patchedName = ''
  const fileUrlCalls = []
  const listPage = await openImportDialog(async (req) => {
    const url = req.url()
    if (url.includes('/api/ai/sources/list') && req.method() === 'GET') {
      const real = await (await fetch(url, { headers: req.headers() })).json()
      const items = Array.isArray(real.items) ? real.items : []
      const target = items.find(s => s.type === 'file') ?? items[0]
      if (target) {
        target.type = 'file'
        target.originalFile = { name: 'W1 使用說明書.pdf', size: 1_843_200 }
        patchedId = target.id
        patchedName = target.name
      }
      return json(real)
    }
    const m = url.match(/\/api\/ai\/sources\/([^/]+)\/file-url/)
    if (m) {
      fileUrlCalls.push(decodeURIComponent(m[1]))
      return json({ url: 'https://storage.googleapis.com/fake-download/original.pdf', fileName: 'W1 使用說明書.pdf' })
    }
    if (url.startsWith('https://storage.googleapis.com/fake-download/')) {
      return { status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake', headers: { 'Content-Disposition': 'attachment; filename="original.pdf"' } }
    }
    return undefined
  }, { path: '/knowledge/sources', waitSel: '.split-list, .src-list, aside' })
  if (!patchedId) throw new Error('資料清單是空的，沒有可以驗「下載原檔」的資料')
  await waitFor(listPage, name => [...document.querySelectorAll('aside *, .split-list *')].some(el => el.children.length === 0 && el.textContent?.trim() === name), patchedName)
  await listPage.evaluate((name) => {
    const el = [...document.querySelectorAll('aside *, .split-list *')].find(e => e.children.length === 0 && e.textContent?.trim() === name)
    el?.click()
  }, patchedName)
  const shown = await waitFor(listPage, () => [...document.querySelectorAll('.src-header-caption .el-button')].some(b => b.innerText.includes('下載原檔')))
  const caption = await listPage.$eval('.src-header-caption', el => el.innerText).catch(() => '')
  if (shown && caption.includes('W1 使用說明書.pdf（1.8 MB）')) pass(`資料頁標出原檔與大小並給「下載原檔」：「${caption.replace(/\s+/g, ' ').trim()}」`)
  else fail('資料頁沒出現原檔／下載鈕', caption)
  await listPage.evaluate(() => [...document.querySelectorAll('.src-header-caption .el-button')].find(b => b.innerText.includes('下載原檔'))?.click())
  await waitFor(listPage, () => true, null, 1500)
  await sleep(1200)
  if (fileUrlCalls.length === 1 && fileUrlCalls[0] === patchedId) pass('按「下載原檔」→ 跟伺服器要這一份的下載網址（一次、對的那一份）')
  else fail('下載原檔沒有要到對的網址', JSON.stringify(fileUrlCalls))
  await listPage.close()
}
catch (e) {
  fail('守門員中斷', String(e?.stack ?? e).slice(0, 400))
}
finally {
  await browser.close()
}

if (pageErrors.length) fail(`頁面有 ${pageErrors.length} 個執行期錯誤`, pageErrors.join('\n     '))
else pass('全程零執行期錯誤')
// 第一段只選檔不按整理、第二段的上傳／整理／匯入全部回假的：知識庫那邊不該有任何一支走到預設攔截；
// 有攔到就代表某處自己觸發了沒假造到的寫入。「導覽看過了」那支是頁面自己會送的（跟匯入無關），只列出來不算失敗。
const kbWrites = blockedWrites.filter(w => w.includes('/api/ai/'))
const otherWrites = blockedWrites.filter(w => !w.includes('/api/ai/'))
if (kbWrites.length) fail('知識庫有不該發生的寫入請求（已攔下、沒有送到伺服器）', kbWrites.join('\n     '))
else pass('知識庫零寫入請求（沒有上傳、沒有建整理工作）')
if (otherWrites.length) console.log(`ℹ️  另外攔下 ${otherWrites.length} 支頁面自己送的寫入（沒有送到伺服器）：${[...new Set(otherWrites)].join('、')}`)

if (failed) { console.error('\n有關卡沒過'); process.exit(1) }
console.log('\n全部通過')
