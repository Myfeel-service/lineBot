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
 *    - 第一段不按「整理並加入」：只驗選檔、判別、錯誤訊息
 *    - 第二段（空間不夠時收到滿為止，`C-296`②）會按到底，但上傳、建整理工作、輪詢、匯入
 *      **全部在瀏覽器裡回假的**——沒有一支送到伺服器，也不花 AI 的錢
 *    - 之後各段（一次好幾份、同名、空間滿、重試、504、取消後重來）同一套：全部回假的
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
  pdf: ['保固說明.pdf', Buffer.from('%PDF-1.4 fake')],
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
  const { path = '/knowledge/sources?import=1', waitSel = '.kb-drop', width = 1440, height = 1000 } = opts
  const page = await browser.newPage()
  await page.setViewport({ width, height })
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
  await quotaPage.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
  const previewShown = await waitFor(quotaPage, () => document.querySelector('.kb-preview-summary')?.innerText.includes('14'))
  if (!previewShown) {
    const onScreen = await quotaPage.$eval('.el-dialog__body', el => el.innerText.slice(0, 400)).catch(() => '（讀不到視窗）')
    throw new Error(`假的整理結果沒有出現在預覽頁；畫面上是：${onScreen.replace(/\n/g, ' ／ ')}`)
  }
  // `D-123`②：一份本來直接加入，放不下就要停在這裡給他看，而且沒有先送出任何一條
  const stoppedLine = await quotaPage.$eval('.kb-preview-stopped', el => el.innerText).catch(() => '')
  if (stoppedLine.includes('還沒加進去') && bulkBody === null) pass('空間放不下 → 停在預覽、講「還沒加進去」，一條都沒先送')
  else fail('放不下卻沒有停下來', `stopped=${stoppedLine} bulk=${JSON.stringify(bulkBody)?.slice(0, 80)}`)
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

  // ── 第四段：一次好幾份（`C-296`④）────────────────────────────────────
  // 已用 38／50（剩 12）；Word 整理出 5 條、CSV 4 條、PDF 6 條＝15 條 → 總共只能收 12、3 條沒收；
  // 舊版 .doc 要列在清單上講原因（⛔ 以前多拖的檔默默只取第一份）。上傳到匯入全部回假的。
  const chunksFor = { '退換貨政策.docx': 5, '商品匯出.csv': 4, '保固說明.pdf': 6 }
  const jobName = {}
  let jobSeq = 0
  const bulkCalls = []
  const batchPage = await openImportDialog((req) => {
    const url = req.url()
    const m = req.method()
    if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 38, limit: 50, planName: '免費' } })
    if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') {
      const name = JSON.parse(req.postData() || '{}').fileName
      return json({ uploadId: `u-${name}`, storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: `https://storage.googleapis.com/fake-bucket/${encodeURIComponent(name)}?sig=fake` })
    }
    if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) {
      return { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
    }
    if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
      const id = `job-batch-${++jobSeq}`
      jobName[id] = JSON.parse(req.postData() || '{}').fileName
      return json({ jobId: id, status: 'processing', phase: 'chunk' })
    }
    const pj = url.match(/\/api\/ai\/knowledge\/preview-jobs\/(job-batch-\d+)/)
    if (pj && m === 'GET') {
      const n = chunksFor[jobName[pj[1]]] ?? 1
      return json({ status: 'done', sourceName: jobName[pj[1]], chunks: Array.from({ length: n }, (_, i) => ({ title: `${jobName[pj[1]]} 第 ${i + 1} 條`, content: '內容', tags: [], questions: [] })), warnings: [], suggestedProductName: '', contentHash: 'h' })
    }
    if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
      const b = JSON.parse(req.postData() || '{}')
      bulkCalls.push({ name: b.source?.name, fileName: b.source?.fileName, n: b.chunks?.length ?? 0, importId: b.importId })
      return json({ sourceId: `src-${bulkCalls.length}`, total: b.chunks.length, indexed: b.chunks.length, failed: 0, items: [] })
    }
    return undefined
  })
  await (await batchPage.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.csv, pathOf.doc, pathOf.pdf)
  const listed = await waitFor(batchPage, () => document.querySelectorAll('.kb-site-row').length === 4)
  const rowsText = await batchPage.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()))
  const docRow = rowsText.find(t => t.includes('舊說明書.doc')) ?? ''
  if (listed && docRow.includes('不收') && docRow.includes('另存新檔')) pass(`選 4 份 → 換到逐份清單；收不了的那份留在清單上講原因：「${docRow}」`)
  else fail('一次好幾份的清單不對', rowsText.join('\n     '))
  const startLabel = await batchPage.$eval('.kb-import-actions .el-button--primary', el => el.innerText.trim())
  if (startLabel === '整理並加入這 3 份') pass(`主按鈕只算收得下的：「${startLabel}」`)
  else fail('主按鈕的份數不對', startLabel)

  await batchPage.evaluate(() => document.querySelector('.kb-import-actions .el-button--primary')?.click())
  const batchDone = await waitFor(batchPage, () => document.querySelector('.kb-site-summary')?.innerText.includes('已建立'), null, 60_000)
  if (!batchDone) throw new Error('一次好幾份沒有跑完（找不到結論列）')
  if (process.env.SHOT_DIR) await (await batchPage.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-file-batch.png') })
  const sentTotal = bulkCalls.reduce((s, c) => s + c.n, 0)
  const summaryText = await batchPage.$eval('.kb-site-summary', el => el.innerText.replace(/\s+/g, ' '))
  if (bulkCalls.length === 3 && sentTotal === 12) pass(`三份各自匯入、合計只送 12 條（剛好填滿空間）：${bulkCalls.map(c => `${c.name} ${c.n} 條`).join('、')}`)
  else fail('一次好幾份送出的條數不對', JSON.stringify(bulkCalls))
  if (bulkCalls.every(c => c.fileName === c.name && c.importId?.startsWith('job-batch-'))) pass('每一份都帶原檔名與自己的整理工作（原檔留存、逾時重按不重複建）')
  else fail('一次好幾份的匯入參數不對', JSON.stringify(bulkCalls))
  if (summaryText.includes('已建立 3 份資料、共 12 條知識') && summaryText.includes('另有 3 條因為知識空間不夠沒收進去')) pass(`結論列講清楚收了多少、幾條沒收：「${summaryText.trim().slice(0, 80)}…」`)
  else fail('一次好幾份的結論列不對', summaryText)
  const actionLabels = await batchPage.$$eval('.kb-import-actions .el-button', els => els.map(e => e.innerText.trim()))
  if (!actionLabels.some(t => t.includes('重試'))) pass(`跑完沒東西可重試 → 不留「重試 0 份」的灰按鈕（剩：${actionLabels.join('／')}）`)
  else fail('跑完還留著重試按鈕', actionLabels.join('／'))
  await batchPage.close()

  // ── 第五段：一次好幾份裡有一份跟現有資料同名 → 等他決定、「換掉舊的」走更新那一份 ──
  // ⛔ 以前一次好幾份會默默多建一份同名的（2026-10-10 審查）；單份那條路會問，這裡也要問
  {
    const names = {}
    let seq = 0
    const bulks = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 0, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const id = `job-dup-${++seq}`
        names[id] = JSON.parse(req.postData() || '{}').fileName
        return json({ jobId: id, status: 'processing', phase: 'chunk' })
      }
      const pj = url.match(/\/api\/ai\/knowledge\/preview-jobs\/(job-dup-\d+)/)
      if (pj && m === 'GET') {
        const name = names[pj[1]]
        const existingMatches = name === '退換貨政策.docx' ? [{ id: 'old-src-1', name, chunkCount: 3, updatedAtMs: 0, type: 'file' }] : []
        return json({ status: 'done', sourceName: name, chunks: [{ title: `${name} 一`, content: '內容', tags: [], questions: [] }], warnings: [], existingMatches, truncated: name === '商品匯出.csv', contentHash: 'h' })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push({ name: b.source?.name, replace: b.replaceSourceId ?? null, keys: Object.keys(b.source ?? {}) })
        return json({ sourceId: 's', total: b.chunks.length, indexed: b.chunks.length, failed: 0, originalKept: true, items: [] })
      }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.csv)
    await waitFor(pg, () => document.querySelectorAll('.kb-site-row').length === 2)
    await pg.evaluate(() => document.querySelector('.kb-import-actions .el-button--primary')?.click())
    await waitFor(pg, () => document.querySelector('.kb-site-summary')?.innerText.includes('已建立'), null, 60_000)
    const before = await pg.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()))
    const dupRow = before.find(t => t.includes('退換貨政策.docx')) ?? ''
    const csvRow = before.find(t => t.includes('商品匯出.csv')) ?? ''
    if (dupRow.includes('等你決定') && dupRow.includes('換掉舊的') && !bulks.some(b => b.name === '退換貨政策.docx')) pass('同名那份先擱著等決定（沒有默默多建一份）')
    else fail('同名那份沒有停下來問', dupRow)
    if (csvRow.includes('原文超過 10 萬字已截斷')) pass('單份路會講的「原文被截斷」一次好幾份也講')
    else fail('一次好幾份沒講截斷', csvRow)
    // `D-124`：一次好幾份不停下來（清單上看不到內容），改成結論列點名要核對哪一份、那一列標「要核對」
    const mustCheck = await pg.evaluate(() => ({
      summary: document.querySelector('.kb-site-summary')?.innerText.replace(/\s+/g, ' ') ?? '',
      row: [...document.querySelectorAll('.kb-site-row')].map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('商品匯出.csv')) ?? '',
    }))
    if (mustCheck.summary.includes('要先核對') && mustCheck.summary.includes('「商品匯出.csv」後面沒讀完') && mustCheck.row.includes('要核對')) pass('一次好幾份裡沒讀完的那份 → 結論列點名「要先核對」、那一列標「要核對」')
    else fail('一次好幾份沒點名要核對的那份', JSON.stringify(mustCheck))
    // 還有沒決定的就按「上一步」／✕：⛔ 不可以默默丟掉付過錢的整理結果（2026-10-11 審查）
    for (const [label, click] of [
      ['上一步', () => [...document.querySelectorAll('.kb-import-actions .el-button')].find(b => b.innerText.includes('上一步'))?.click()],
      ['✕', () => document.querySelector('.kb-import-dialog .el-dialog__headerbtn')?.click()],
    ]) {
      await pg.evaluate(click)
      const asked = await waitFor(pg, () => document.querySelector('.el-message-box')?.innerText.includes('等你決定'), null, 5000)
      await pg.evaluate(() => [...document.querySelectorAll('.el-message-box .el-button')].find(b => b.innerText.includes('回去決定'))?.click())
      await waitFor(pg, () => !document.querySelector('.el-message-box') || getComputedStyle(document.querySelector('.el-overlay-message-box') ?? document.body).display === 'none', null, 3000)
      await sleep(400)
      const stillThere = await pg.$$eval('.kb-site-row', els => els.some(e => e.innerText.includes('退換貨政策.docx') && e.innerText.includes('等你決定')))
      if (asked && stillThere) pass(`還有同名沒決定就按「${label}」→ 先問一聲，選「回去決定」清單原封不動`)
      else fail(`按「${label}」沒有先問、或清單不見了`, `asked=${asked} stillThere=${stillThere}`)
    }
    await pg.evaluate(() => [...document.querySelectorAll('.kb-file-batch__conflict .el-button')].find(b => b.innerText.includes('換掉舊的'))?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.kb-site-row')].some(r => r.innerText.includes('退換貨政策.docx') && r.innerText.includes('✓')), null, 15_000)
    const replaced = bulks.find(b => b.name === '退換貨政策.docx')
    if (replaced?.replace === 'old-src-1') pass('按「換掉舊的」→ 走「更新這一份」（帶舊資料的 id，不用重新整理）')
    else fail('換掉舊的沒有帶舊資料', JSON.stringify(bulks))
    // 只換內容：⛔ 帶了資料夾／產品名，伺服器就照收，舊資料會被默默搬到猜的資料夾、改成 AI 猜的產品名（2026-10-12 code review）
    if (replaced && !replaced.keys.includes('folderId') && !replaced.keys.includes('productName')) pass('「換掉舊的」不帶資料夾與產品名（舊的那份原本的設定留著）')
    else fail('「換掉舊的」帶了資料夾或產品名', JSON.stringify(replaced))
    await pg.close()
  }

  // ── 第六段：空間已經滿了 → ⛔ 一份都不上傳、不整理（不花 AI 的錢）；按之前就講、按鈕按不下去 ──
  // （2026-10-11 前是「按下去每一份各自失敗」——結果一樣沒花錢，但按了才知道、重試也是馬上又失敗）
  {
    const uploads = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 50, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url')) { uploads.push(url); return json({ uploadId: 'u', storagePath: 'x', uploadUrl: 'https://storage.googleapis.com/fake-bucket/x' }) }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.csv)
    await waitFor(pg, () => document.querySelectorAll('.kb-site-row').length === 2)
    const line = await pg.$eval('.kb-quota-line', el => el.innerText).catch(() => '')
    const disabled = await pg.$eval('.kb-import-actions .el-button--primary', el => el.disabled || el.classList.contains('is-disabled')).catch(() => null)
    await pg.evaluate(() => document.querySelector('.kb-import-actions .el-button--primary')?.click())
    await sleep(800)
    if (line.includes('知識空間滿了') && disabled === true && !uploads.length) pass(`空間滿了 → 清單上方先講（「${line.trim().slice(0, 40)}…」）、按鈕按不下去、一份都沒上傳`)
    else fail('空間滿了沒有先講／還能按／還在上傳', `line=${line} disabled=${disabled} uploads=${uploads.length}`)
    await pg.close()
  }

  // ── 第七段：匯入那一下出錯 → 重試直接拿整理好的結果匯（⛔ 不再上傳、不再付一次 AI 的錢）；
  //            閘道逾時（504）不等於沒做 → 同一個 importId 自動再送一次；清單上亂丟檔案不會整頁跳走 ──
  {
    const uploadsBy = {}
    const jobsBy = {}
    const bulks = []
    const names = {}
    let seq = 0
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 0, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') {
        const name = JSON.parse(req.postData() || '{}').fileName
        uploadsBy[name] = (uploadsBy[name] ?? 0) + 1
        return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: `https://storage.googleapis.com/fake-bucket/${encodeURIComponent(name)}?sig=fake` })
      }
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const name = JSON.parse(req.postData() || '{}').fileName
        const id = `job-retry-${++seq}`
        names[id] = name
        jobsBy[name] = (jobsBy[name] ?? 0) + 1
        return json({ jobId: id, status: 'processing', phase: 'chunk' })
      }
      const pj = url.match(/\/api\/ai\/knowledge\/preview-jobs\/(job-retry-\d+)/)
      if (pj && m === 'GET') return json({ status: 'done', sourceName: names[pj[1]], chunks: [{ title: `${names[pj[1]]} 一`, content: '內容', tags: [], questions: [] }], warnings: [], existingMatches: [], contentHash: 'h' })
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push({ name: b.source?.name, importId: b.importId })
        const tries = bulks.filter(x => x.name === b.source?.name).length
        if (b.source?.name === '退換貨政策.docx' && tries === 1) return { status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, statusMessage: '資料庫暫時忙碌，請再試一次' }) }
        if (b.source?.name === '商品匯出.csv' && tries === 1) return { status: 504, contentType: 'text/plain', body: 'gateway timeout' }
        return json({ sourceId: 's', total: b.chunks.length, indexed: b.chunks.length, failed: 0, originalKept: true, items: [] })
      }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.csv)
    await waitFor(pg, () => document.querySelectorAll('.kb-site-row').length === 2)

    // 檔案掉在清單上：瀏覽器的預設動作（整頁打開那個檔）要被擋下，而且講該怎麼加
    const stray = await pg.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], '再一份.pdf', { type: 'application/pdf' }))
      const target = document.querySelector('.kb-site-list')
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
      target.dispatchEvent(over)
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      target.dispatchEvent(drop)
      return { over: over.defaultPrevented, drop: drop.defaultPrevented }
    })
    const strayToast = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('上一步')), null, 3000)
    if (stray.over && stray.drop && strayToast) pass('一次好幾份的清單上再丟檔案 → 不會整頁打開那個檔，並講「按上一步回去再放」')
    else fail('清單上丟檔案沒有擋下來', JSON.stringify({ ...stray, strayToast }))

    await pg.evaluate(() => document.querySelector('.kb-import-actions .el-button--primary')?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-site-summary'), null, 60_000)
    const csvBulks = bulks.filter(b => b.name === '商品匯出.csv')
    if (csvBulks.length === 2 && csvBulks[0].importId === csvBulks[1].importId) pass('匯入遇到 504 → 用同一個 importId 自動再送一次（伺服器認得是同一批，不會多建一份）')
    else fail('504 沒有自動重送／重送換了 importId', JSON.stringify(csvBulks))
    const docRow1 = await pg.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('退換貨政策.docx')) ?? '')
    if (docRow1.includes('資料庫暫時忙碌')) pass('匯入失敗講伺服器給的原因（不是一串「[POST] …: 500」）')
    else fail('匯入失敗的原因不對', docRow1)

    await pg.evaluate(() => [...document.querySelectorAll('.kb-import-actions .el-button--primary')].find(b => b.innerText.includes('重試'))?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.kb-site-row')].some(r => r.innerText.includes('退換貨政策.docx') && r.innerText.includes('✓')), null, 15_000)
    const docBulks = bulks.filter(b => b.name === '退換貨政策.docx')
    if (uploadsBy['退換貨政策.docx'] === 1 && jobsBy['退換貨政策.docx'] === 1 && docBulks.length === 2 && docBulks[0].importId === docBulks[1].importId) {
      pass('整理好才失敗的那份按「重試」→ 直接拿整理好的結果匯（上傳 1 次、整理 1 次、匯入 2 次同一個 importId）')
    }
    else fail('重試又重新上傳／重新整理了', JSON.stringify({ uploads: uploadsBy, jobs: jobsBy, docBulks }))
    await pg.close()
  }

  // ── 第八段：放了兩份、收得了的只有一份 → 那一份走有預覽的單份路，收不了的那份當場講 ──
  {
    const pg = await openImportDialog()
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.doc)
    await sleep(800)
    const fileShown = await pg.$eval('.kb-drop__filename', el => el.innerText).catch(() => '')
    const listShown = !!(await pg.$('.kb-site-row'))
    const toasts = await pg.$$eval('.toast', els => els.map(e => e.innerText))
    if (fileShown === '退換貨政策.docx' && !listShown && toasts.some(t => t.includes('另外 1 份收不了') && t.includes('舊說明書.doc'))) {
      pass(`兩份裡只有一份收得了 → 走單份路，收不了的那份當場講：「${toasts.find(t => t.includes('收不了'))}」`)
    }
    else fail('一份收得了、一份收不了的情況不對', `file=${fileShown} list=${listShown} toasts=${toasts.join('｜')}`)
    // 第一步的投放區照樣收檔（視窗層的「別讓瀏覽器打開檔案」不可以把它也擋掉）
    await pg.evaluate(() => [...document.querySelectorAll('.kb-drop__file button')].find(b => b.innerText.includes('換一個'))?.click())
    await sleep(300)
    await pg.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['品名,價格\nW1,100\n'], '拖進來的.csv', { type: 'text/csv' }))
      document.querySelector('.kb-drop')?.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    const dropped = await waitFor(pg, () => document.querySelector('.kb-drop__filename')?.innerText === '拖進來的.csv', null, 3000)
    if (dropped) pass('第一步的投放區照樣收拖進來的檔')
    else fail('第一步的投放區收不到拖進來的檔了')
    await pg.close()
  }

  // ── 第九段：上傳中按取消、換一份馬上再按 → 舊那一輪不可以復活（不多建工作、不把舊的那份加進去）──
  {
    const jobsFor = []
    const bulkNames = []
    let slowPut = true
    const pg = await openImportDialog(async (req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 0, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') {
        const name = JSON.parse(req.postData() || '{}').fileName
        return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: `https://storage.googleapis.com/fake-bucket/${encodeURIComponent(name)}?sig=fake` })
      }
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) {
        // 第一份（舊的那一輪）的上傳故意拖 2.5 秒：取消按在上傳途中
        if (m === 'PUT' && slowPut && url.includes(encodeURIComponent('退換貨政策.docx'))) { slowPut = false; await sleep(2500) }
        return { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
      }
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const name = JSON.parse(req.postData() || '{}').fileName
        jobsFor.push(name)
        return json({ jobId: `job-race-${jobsFor.length}`, status: 'processing', phase: 'chunk' })
      }
      const pj = url.match(/\/api\/ai\/knowledge\/preview-jobs\/job-race-(\d+)/)
      if (pj && m === 'GET') {
        const name = jobsFor[Number(pj[1]) - 1]
        return json({ status: 'done', sourceName: name, sourceType: 'file', chunks: [{ title: `${name} 的內容`, content: '內容', tags: [], questions: [] }], warnings: [], existingMatches: [], contentHash: 'h' })
      }
      // 一份直接加入（`D-123`②）：加入那一下也回假的，記下加的是哪一份
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulkNames.push(b.source?.name)
        return json({ sourceId: 'race-src', total: 1, indexed: 1, failed: 0, originalKept: true, items: [] })
      }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-waiting'), null, 5000)
    await pg.evaluate(() => document.querySelector('.kb-waiting .el-button')?.click())
    await sleep(300)
    await pg.evaluate(() => [...document.querySelectorAll('.kb-drop__file button')].find(b => b.innerText.includes('換一個'))?.click())
    await sleep(300)
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.csv)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 20_000)
    await sleep(3500) // 等舊那一輪的慢上傳回來：它要是復活，會在這段時間多建一份工作、把舊的那份也加進去
    const savedNow = await pg.$eval('.kb-result-saved', el => el.innerText).catch(() => '')
    if (jobsFor.length === 1 && jobsFor[0] === '商品匯出.csv' && bulkNames.join() === '商品匯出.csv' && savedNow.includes('商品匯出.csv')) {
      pass('上傳中取消、換一份馬上再按 → 舊那一輪沒有復活（只建了新那一份的工作、只加了新那一份）')
    }
    else fail('取消後舊那一輪復活了', `jobs=${JSON.stringify(jobsFor)} bulks=${JSON.stringify(bulkNames)} saved=${savedNow.replace(/\s+/g, ' ').slice(0, 160)}`)
    await pg.close()
  }

  // ── 第十段：匯入兩次都逾時、其實伺服器做完了 → 重試要把同一包再送給伺服器認
  //    ⛔ 不可以先在畫面上算空間就說「滿了沒收進去」——其實全都在（2026-10-12 code review）──
  {
    const bulks = []
    let used = 49
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const name = JSON.parse(req.postData() || '{}').fileName
        // 第二份一模一樣、直接跳過：讓這一批只有一份真的要匯
        if (name === '商品匯出.csv') return json({ duplicate: { id: 'd', name: '舊的豆單' } })
        return json({ jobId: 'job-unsure-1', status: 'processing', phase: 'chunk' })
      }
      if (url.includes('/api/ai/knowledge/preview-jobs/job-unsure-1') && m === 'GET') return json({ status: 'done', sourceName: '退換貨政策.docx', chunks: [{ title: '七天鑑賞期', content: '收到後七天內可退', tags: [], questions: [] }], warnings: [], existingMatches: [], contentHash: 'h' })
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const raw = req.postData() || ''
        bulks.push(raw)
        // 前兩次：伺服器其實收進去了（空間變滿），只是閘道先逾時
        if (bulks.length <= 2) { used = 50; return { status: 504, contentType: 'text/plain', body: 'gateway timeout' } }
        return json({ sourceId: 's', total: 1, indexed: 1, failed: 0, originalKept: true, items: [], alreadyImported: true })
      }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.csv)
    await waitFor(pg, () => document.querySelectorAll('.kb-site-row').length === 2)
    await pg.evaluate(() => document.querySelector('.kb-import-actions .el-button--primary')?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-site-summary'), null, 60_000)
    // 重試之前：⛔ 不可以寫「沒有加入」（很可能其實已經在了），而且空間顯示滿了也要按得下去
    const before = await pg.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('退換貨政策.docx')) ?? '')
    const retryEnabled = await pg.$$eval('.kb-import-actions .el-button--primary', els => els.some(b => b.innerText.includes('重試') && !b.disabled && !b.classList.contains('is-disabled')))
    if (before.includes('待確認') && before.includes('不確定') && !before.includes('沒有加入') && retryEnabled) pass('兩次都逾時那份標「待確認」、講不確定進去了沒，空間滿了也按得了重試')
    else fail('兩次逾時那份的說法或重試鈕不對', `row=${before} retryEnabled=${retryEnabled}`)
    await pg.evaluate(() => [...document.querySelectorAll('.kb-import-actions .el-button--primary')].find(b => b.innerText.includes('重試'))?.click())
    const ok = await waitFor(pg, () => [...document.querySelectorAll('.kb-site-row')].some(r => r.innerText.includes('退換貨政策.docx') && r.innerText.includes('✓')), null, 20_000)
    const row = await pg.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('退換貨政策.docx')) ?? '')
    if (ok && bulks.length === 3 && bulks[2] === bulks[0]) pass('兩次都逾時、其實已經收進去 → 空間顯示滿了也照樣把同一包送給伺服器認，回來是 ✓（不是「空間滿了沒收進去」）')
    else fail('兩次逾時後重試的結果不對', `bulks=${bulks.length} same=${bulks[2] === bulks[0]} row=${row}`)
    await pg.close()
  }

  // ── 第十一段：單份「更新這一份」，舊的那份全是草稿 → 空出來的空間是 0（草稿本來就不算），按鈕不可以承諾收得下 ──
  {
    const JOB = 'job-replace-drafts'
    let bulkCalled = false
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 50, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId: JOB, status: 'processing', phase: 'chunk' })
      if (url.includes(`/api/ai/knowledge/preview-jobs/${JOB}`) && m === 'GET') {
        return json({ status: 'done', sourceName: '退換貨政策.docx', sourceType: 'file', chunks: Array.from({ length: 5 }, (_, i) => ({ title: `第 ${i + 1} 條`, content: '內容', tags: [], questions: [] })), warnings: [], contentHash: 'h',
          existingMatches: [{ id: 'old-drafts', name: '退換貨政策.docx', chunkCount: 30, quotaChunkCount: 0, updatedAtMs: 0, type: 'file' }] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create')) { bulkCalled = true; return json({}) }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    // 同名＋空間滿：兩個理由都要停在預覽（`D-123`②）
    await waitFor(pg, () => !!document.querySelector('.kb-preview-summary'), null, 20_000)
    await pg.evaluate(() => [...document.querySelectorAll('.kb-dedup-row .el-button')].find(b => b.innerText.includes('更新這一份'))?.click())
    await sleep(500)
    const btn = await pg.$eval('.kb-preview-summary__actions .el-button--primary', el => ({ text: el.innerText.trim(), disabled: el.disabled || el.classList.contains('is-disabled') })).catch(() => null)
    if (btn?.text === '空間已經滿了' && btn.disabled && !bulkCalled) pass('舊的那份全是草稿 → 換掉也空不出位置，按鈕講「空間已經滿了」、按不下去（不再承諾收 5 條、按下去整批被擋）')
    else fail('「更新這一份」把草稿算成空出來的空間', JSON.stringify(btn))
    await pg.close()
  }

  // ── 第十二段：試算表讀得到、只是還有分頁沒看 → 打勾，⛔ 不畫紅叉、不叫人回頭重新分享 ──
  {
    const pg = await openImportDialog((req) => {
      const url = req.url()
      if (url.includes('/api/ai/knowledge/gsheet-probe')) {
        return json({ status: 'partial', message: '讀得到這份試算表。先看了「說明」這 1 個分頁，前 20 列都沒有資料；另外 6 個分頁還沒看，資料在那幾頁的話，直接按「整理並加入」就會一起讀。' })
      }
      return undefined
    })
    await pg.evaluate(() => {
      const ta = document.querySelector('.kb-drop__paste textarea')
      ta.value = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const probed = await waitFor(pg, () => !!document.querySelector('.kb-gsheet-share__state:not(:empty)') && !document.querySelector('.kb-gsheet-share__state')?.innerText.includes('正在確認'), null, 15_000)
    const state = await pg.$eval('.kb-gsheet-share__state', el => ({ cls: el.className, text: el.innerText.trim() })).catch(() => null)
    const shareRow = !!(await pg.$('.kb-gsheet-share__row'))
    if (probed && state?.cls.includes('is-ok') && state.text.startsWith('✓') && !shareRow) pass('試算表讀得到、只是還有分頁沒看 → 打勾，不出「請共用給這個帳號」那一塊')
    else fail('讀得到的試算表被畫成失敗', JSON.stringify({ state, shareRow }))
    await pg.close()
  }

  // ── 第十三段（`D-123`①）：「手上有什麼？」四格；試算表那格三步、圖收著、主按鈕在第一屏 ──
  {
    const pg = await openImportDialog()
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-start-tiles.png') })
    const tiles = await pg.$$eval('.kb-start__tile-name', els => els.map(e => e.innerText.trim()))
    if (tiles.join('／') === '檔案／官網／Google 試算表／還沒整理好') pass(`起步是四格：${tiles.join('／')}`)
    else fail('起步格子不對', tiles.join('／'))
    const clickTile = name => pg.evaluate(n => [...document.querySelectorAll('.kb-start__tile')].find(b => b.innerText.includes(n))?.click(), name)

    await clickTile('官網')
    await sleep(300)
    const web = await pg.evaluate(() => ({
      panel: document.querySelector('.kb-start__panel')?.innerText ?? '',
      focused: document.activeElement?.closest?.('.kb-drop__paste') != null,
    }))
    if (web.panel.includes('要登入') && web.focused) pass('點「官網」→ 一行說明＋游標已經在框裡（直接貼）')
    else fail('「官網」那格不對', JSON.stringify(web))

    await clickTile('Google 試算表')
    await sleep(300)
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-start-sheet.png') })
    const sheet = await pg.evaluate(() => {
      const btn = document.querySelector('[data-tour="kb-preview"]')
      return {
        steps: document.querySelectorAll('.kb-start__steps > li').length,
        shots: document.querySelectorAll('.kb-start__shots .kb-shot').length,
        btnBottom: btn ? Math.round(btn.getBoundingClientRect().bottom) : -1,
        vh: window.innerHeight,
      }
    })
    if (sheet.steps === 3 && sheet.shots === 0 && sheet.btnBottom > 0 && sheet.btnBottom <= sheet.vh) pass(`點「Google 試算表」→ 三步、圖先收著，主按鈕在第一屏（底邊 ${sheet.btnBottom}px／視窗 ${sheet.vh}px）`)
    else fail('「Google 試算表」那格不對', JSON.stringify(sheet))
    await pg.evaluate(() => document.querySelector('.kb-start__fold')?.click())
    await sleep(300)
    const shotsOpen = await pg.$$eval('.kb-start__shots .kb-shot', els => els.length)
    if (shotsOpen === 3) pass('按「看圖怎麼按」→ 三張真截圖才出來')
    else fail('「看圖怎麼按」沒有展開三張圖', String(shotsOpen))

    const [chooser] = await Promise.all([
      pg.waitForFileChooser({ timeout: 5000 }).catch(() => null),
      clickTile('檔案'),
    ])
    if (chooser) pass('點「檔案」→ 直接開選檔視窗（不展開一段說明）')
    else fail('點「檔案」沒有開選檔視窗')
    if (chooser) await chooser.cancel().catch(() => {})
    await pg.close()
  }

  /** 在頁面上裝一個「預覽頁出現過沒有」的記號（直接加入那條路一次都不該經過預覽） */
  const watchPreview = pg => pg.evaluate(() => {
    window.__sawPreview = false
    new MutationObserver(() => { if (document.querySelector('.kb-preview-summary')) window.__sawPreview = true })
      .observe(document.body, { childList: true, subtree: true })
  })
  const STORAGE_OK = { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }

  // ── 第十四段（`D-123`②）：一份、沒有要核對的 → 不停在預覽、直接加入；結果頁講存成哪一份、整理時的提醒、問要不要做總表 ──
  {
    const JOB = 'job-direct'
    const bulks = []
    const overviewCalls = []
    const nine = Array.from({ length: 9 }, (_, i) => ({ title: `型號 ${i + 1}`, content: `規格 ${i + 1}`, tags: [], questions: [] }))
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId: JOB, status: 'processing', phase: 'chunk' })
      if (url.includes(`/api/ai/knowledge/preview-jobs/${JOB}`) && m === 'GET') {
        return json({ status: 'done', sourceName: '退換貨政策.docx', sourceUrl: '', sourceType: 'file', truncated: false, incomplete: false, ocrUsed: false, meta: {}, chunks: nine, overviewCard: null, existingMatches: [],
          warnings: ['有 2 條含時效性內容（募資／折扣／檔期）——建議點開那幾條設定「有效期限」，活動結束會自動下架，不會過期還照答。'], suggestedProductName: 'W1 智慧手錶', contentHash: 'h' })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        return json({ sourceId: 'auto-src', total: b.chunks.length, indexed: b.chunks.length, failed: 0, originalKept: true, items: [] })
      }
      if (url.includes('/api/ai/sources/auto-src/overview') && m === 'POST') { overviewCalls.push(url); return json({ outcome: 'created', made: true }) }
      return undefined
    })
    await watchPreview(pg)
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    const done = await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 30_000)
    const sawPreview = await pg.evaluate(() => window.__sawPreview)
    if (done && !sawPreview && bulks.length === 1 && bulks[0].chunks.length === 9 && bulks[0].importId === JOB) pass('一份、沒有要核對的 → 沒經過預覽頁、直接加入 9 條（帶整理工作編號，逾時重送不重複）')
    else fail('一份沒有直接加入', JSON.stringify({ done, sawPreview, bulks: bulks.map(b => b.chunks?.length) }))
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-direct-result.png') })
    const r = await pg.evaluate(() => ({
      label: document.querySelector('.kb-step-label')?.innerText ?? '',
      saved: document.querySelector('.kb-result-saved')?.innerText ?? '',
      warn: document.querySelector('.kb-health-warnings')?.innerText ?? '',
      offer: document.querySelector('.kb-overview-suggest')?.innerText ?? '',
      primary: [...document.querySelectorAll('.kb-import-actions .el-button--primary')].map(b => b.innerText.trim()).join('／'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.innerText),
    }))
    if (r.label.includes('第 3 步') && r.label.includes('加好了') && r.saved.includes('存成「退換貨政策.docx」') && r.saved.includes('產品：W1 智慧手錶') && r.saved.includes('AI 猜的')) pass(`結果頁講存成哪一份、AI 猜的產品：「${r.saved.replace(/\s+/g, ' ').trim()}」`)
    else fail('結果頁沒講存成哪一份', JSON.stringify(r))
    if (r.warn.includes('整理時注意到 1 件事') && r.warn.includes('有效期限')) pass('沒經過預覽 → 整理時的提醒改在結果頁講')
    else fail('結果頁沒講整理時的提醒', r.warn)
    if (!r.toasts.some(t => t.includes('已加進知識庫') || t.includes('成功匯入'))) pass('視窗開著 → 不另跳「已加入」提示（結果頁就是交代，不講兩次）')
    else fail('結果頁之外又跳了一次提示', r.toasts.join('｜'))
    if (r.primary === '打開這一份') pass('右下主按鈕直接講會發生什麼：「打開這一份」')
    else fail('結果頁主按鈕不對', r.primary)
    // `D-124`：加好了就看得到 AI 整理成哪幾條；問一題講清楚不算額度、給去測試對話的路；數字格不用「可用／失敗」
    const extra = await pg.evaluate(() => ({
      titles: [...document.querySelectorAll('.kb-result-titles__list li')].map(li => li.innerText),
      more: document.querySelector('.kb-result-titles__more')?.innerText ?? '',
      verify: document.querySelector('.kb-handoff-verify')?.innerText.replace(/\s+/g, ' ') ?? '',
      labels: [...document.querySelectorAll('.kb-result-label')].map(e => e.innerText).join('／'),
    }))
    if (extra.titles.length === 5 && extra.titles[0] === '型號 1' && extra.more.includes('還有 4 條')) pass('加好了那頁直接列出前 5 條標題＋「還有 4 條」（不用再點進去才知道 AI 做了什麼）')
    else fail('加好了那頁沒列出整理成哪幾條', JSON.stringify(extra))
    if (extra.verify.includes('問 AI 一題試試') && extra.verify.includes('不算額度') && extra.verify.includes('到測試對話') && extra.labels === '整理出／AI 學會了／還沒學起來') pass(`問一題講清楚不算額度、給去測試對話的路；數字格改白話（${extra.labels}）`)
    else fail('問一題或數字格的說法不對', JSON.stringify(extra))
    if (r.offer.includes('要不要再做一張') && r.offer.includes('佔 1 條空間')) {
      await pg.evaluate(() => [...document.querySelectorAll('.kb-overview-suggest .el-button')].find(b => b.innerText.includes('做一張'))?.click())
      const made = await waitFor(pg, () => document.querySelector('.kb-overview-suggest')?.innerText.includes('做好了'), null, 10_000)
      if (made && overviewCalls.length === 1) pass('9 條的檔案 → 結果頁問要不要做「我們有賣什麼」，按「做一張」打對的那一份、講做好了')
      else fail('做總表沒有成功', JSON.stringify({ made, overviewCalls }))
    }
    else fail('結果頁沒問要不要做總表', r.offer)
    await pg.close()
  }

  // ── 第十五段（`D-123`②）：照片的字是 AI 認的 → 停在預覽給他核對，一條都不先送；按了才加 ──
  {
    const JOB = 'job-ocr'
    const bulks = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId: JOB, status: 'processing', phase: 'ocr' })
      if (url.includes(`/api/ai/knowledge/preview-jobs/${JOB}`) && m === 'GET') {
        return json({ status: 'done', sourceName: '價目表.HEIC', sourceUrl: '', sourceType: 'file', truncated: false, ocrUsed: true, meta: { image: 1 }, existingMatches: [], warnings: [], contentHash: 'h',
          chunks: [{ title: '拿鐵', content: '中杯 60 元', tags: [], questions: [] }, { title: '美式', content: '中杯 50 元', tags: [], questions: [] }] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        return json({ sourceId: 'ocr-src', total: b.chunks.length, indexed: b.chunks.length, failed: 0, originalKept: true, items: [] })
      }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.heic)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-preview-summary'), null, 30_000)
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-ocr-stop.png') })
    const s = await pg.evaluate(() => ({
      label: document.querySelector('.kb-step-label')?.innerText ?? '',
      stopped: document.querySelector('.kb-preview-stopped')?.innerText ?? '',
      ocr: document.querySelector('.kb-ocr-alert')?.innerText ?? '',
      btn: document.querySelector('.kb-preview-summary__actions .el-button--primary')?.innerText.trim() ?? '',
    }))
    if (s.label.includes('加入之前先看一下') && s.stopped.includes('還沒加進去') && s.ocr.includes('這張照片') && s.btn === '加入 2 條' && !bulks.length) pass(`照片 → 停在「加入之前先看一下」、講字是 AI 認的，一條都沒先送（按鈕「${s.btn}」）`)
    else fail('照片沒有停下來給人核對', JSON.stringify({ ...s, bulks: bulks.length }))
    await pg.evaluate(() => document.querySelector('.kb-preview-summary__actions .el-button--primary')?.click())
    const added = await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 15_000)
    if (added && bulks.length === 1) pass('看完按「加入」→ 才加進去')
    else fail('看完按加入沒有加進去', JSON.stringify({ added, bulks: bulks.length }))
    await pg.close()
  }

  // ── 第十六段：同一份再放一次（內容一模一樣）→「重新整理，換掉那一份」→ 直接換掉原本那一份，不多一份、不改它的產品名 ──
  {
    const posts = []
    const bulks = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        posts.push(b)
        if (!b.ignoreDuplicate) return json({ duplicate: { id: 'old-1', name: '退換貨政策.docx', type: 'file', chunkCount: 3, updatedAtMs: Date.now() - 86400_000 } })
        return json({ jobId: 'job-redo', status: 'processing', phase: 'chunk' })
      }
      if (url.includes('/api/ai/knowledge/preview-jobs/job-redo') && m === 'GET') {
        return json({ status: 'done', sourceName: '退換貨政策.docx', sourceUrl: '', sourceType: 'file', truncated: false, ocrUsed: false, meta: {}, warnings: [], contentHash: 'h', suggestedProductName: 'AI 猜的別台',
          chunks: [{ title: '七天鑑賞期', content: '收到後七天內可退', tags: [], questions: [] }],
          existingMatches: [{ id: 'old-1', name: '退換貨政策.docx', chunkCount: 3, quotaChunkCount: 3, updatedAtMs: 0, type: 'file' }] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        return json({ sourceId: 'old-1', total: 1, indexed: 1, failed: 0, replacedChunks: 3, originalKept: true, items: [] })
      }
      return undefined
    })
    await watchPreview(pg)
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    const dupShown = await waitFor(pg, () => document.querySelector('.kb-dup-content')?.innerText.includes('重新整理，換掉那一份'), null, 15_000)
    if (dupShown) pass('內容一模一樣 → 先停下來，給「看那一份」與「重新整理，換掉那一份」')
    else fail('內容一模一樣沒有停下來')
    await pg.evaluate(() => [...document.querySelectorAll('.kb-dup-content .el-button')].find(b => b.innerText.includes('換掉那一份'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 30_000)
    const b = bulks[0]
    const resultText = await pg.$eval('.el-dialog__body', el => el.innerText.replace(/\s+/g, ' ')).catch(() => '')
    const sawPreview = await pg.evaluate(() => window.__sawPreview)
    if (posts.length === 2 && posts[1].ignoreDuplicate === true && bulks.length === 1 && b.replaceSourceId === 'old-1' && !b.source?.productName && !sawPreview) {
      pass('按「重新整理，換掉那一份」→ 直接換掉原本那一份（帶它的 id、不帶 AI 猜的產品名、沒停在預覽）')
    }
    else fail('「換掉那一份」不對', JSON.stringify({ posts: posts.length, ignore: posts[1]?.ignoreDuplicate, replace: b?.replaceSourceId, product: b?.source?.productName, sawPreview }))
    if (resultText.includes('原本的 3 條知識已換成上面這批') && !resultText.includes('AI 猜的別台')) pass('結果頁講舊的 3 條去哪了、不把沒帶過去的產品名講成存進去的')
    else fail('結果頁說法不對', resultText.slice(0, 300))
    await pg.close()
  }

  // ── 第十七段（`D-123`②）：整理中關掉視窗 → 好了自己加進去、講一句、側欄留「加好了，看結果」──
  {
    let polls = 0
    const bulks = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId: 'job-bg', status: 'processing', phase: 'chunk' })
      if (url.includes('/api/ai/knowledge/preview-jobs/job-bg') && m === 'GET') {
        if (++polls <= 3) return json({ status: 'processing', phase: 'chunk', progress: { done: polls, total: 4, label: '整理' } })
        return json({ status: 'done', sourceName: '商品匯出.csv', sourceUrl: '', sourceType: 'file', truncated: false, ocrUsed: false, meta: {}, warnings: [], existingMatches: [], contentHash: 'h',
          chunks: [{ title: 'W1', content: '12,900 元', tags: [], questions: [] }] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        bulks.push(1)
        return json({ sourceId: 'bg-src', total: 1, indexed: 1, failed: 0, originalKept: true, items: [] })
      }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.csv)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-waiting'), null, 5000)
    const note = await pg.$eval('.kb-waiting__note', el => el.innerText).catch(() => '')
    await pg.evaluate(() => document.querySelector('.kb-import-dialog .el-dialog__headerbtn')?.click())
    const toasted = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('「商品匯出.csv」已加進知識庫')), null, 30_000)
    const link = await pg.$eval('.src-import-link', el => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '')
    if (note.includes('整理好會自己加進知識庫') && toasted && bulks.length === 1 && link.includes('加好了，看結果')) pass(`整理中關掉視窗 → 好了自己加進去、跳一句「已加進知識庫」，側欄留「${link}」`)
    else fail('關掉視窗後沒有自己加進去／沒交代', JSON.stringify({ note, toasted, bulks: bulks.length, link }))
    await pg.evaluate(() => document.querySelector('.src-import-link')?.click())
    const reopened = await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 5000)
    if (reopened) pass('點側欄那一行 → 回到結果頁（AI 開了沒、要不要做總表都還看得到）')
    else fail('點側欄沒有回到結果頁')
    await pg.close()
  }

  // ── 第十八段：試算表讀得到但沒資料 → ⛔ 不叫人去分享（不出帳號、按鈕不寫「分享好了」）──
  {
    const pg = await openImportDialog((req) => {
      if (req.url().includes('/api/ai/knowledge/gsheet-probe')) return json({ status: 'no_data', message: '讀得到這份試算表，但「封面」分頁的前 20 列都沒有資料（要有一列欄位名稱＋至少一列資料）。' })
      return undefined
    })
    await pg.evaluate(() => {
      const ta = document.querySelector('.kb-drop__paste textarea')
      ta.value = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitFor(pg, () => document.querySelector('.kb-gsheet-share__state')?.innerText.includes('沒有資料'), null, 15_000)
    const share = await pg.evaluate(() => ({
      email: !!document.querySelector('.kb-gsheet-share .kb-gsheet-email'),
      btn: [...document.querySelectorAll('.kb-gsheet-share__row .el-button')].map(b => b.innerText.trim()).join('／'),
    }))
    if (!share.email && share.btn === '再測一次') pass('沒資料的試算表 → 不出帳號、按鈕叫「再測一次」（不叫人回頭去分享）')
    else fail('沒資料的試算表還是叫人去分享', JSON.stringify(share))
    await pg.close()
  }

  // ── 第十九段（`D-124`）：試算表讀不到（沒共用）→ 三步教學在紅字下面再出現一次，截圖點得開 ──
  {
    const pg = await openImportDialog((req) => {
      if (req.url().includes('/api/ai/knowledge/gsheet-probe')) return json({ status: 'no_access', message: '還讀不到：照下面三步把試算表共用給系統帳號（權限選「檢視者」就夠）。', detail: '讀不到這份 Google 試算表（403）。Google 原始訊息：The caller does not have permission', serviceAccountEmail: 'bot@x.iam.gserviceaccount.com' })
      return undefined
    })
    await pg.evaluate(() => {
      const ta = document.querySelector('.kb-drop__paste textarea')
      ta.value = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitFor(pg, () => document.querySelector('.kb-gsheet-share__state')?.innerText.includes('還讀不到'), null, 15_000)
    const s = await pg.evaluate(() => ({
      steps: document.querySelectorAll('.kb-gsheet-share__steps > li').length,
      email: document.querySelector('.kb-gsheet-share__steps .kb-gsheet-email')?.innerText ?? '',
      btn: [...document.querySelectorAll('.kb-gsheet-share__row .el-button')].map(b => b.innerText.trim()).join('／'),
      detail: !!document.querySelector('.kb-gsheet-share__detail'),
    }))
    await pg.evaluate(() => document.querySelector('.kb-gsheet-share__steps .kb-start__fold')?.click())
    await sleep(300)
    const shots = await pg.$$eval('.kb-gsheet-share__steps .kb-shot', els => els.length)
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-sheet-no-access.png') })
    // 帳號：開窗時讀到的那份優先（正式的系統帳號），探測帶回來的只是備援——所以只驗「有一個帳號」
    if (s.steps === 3 && s.email.includes('@') && s.btn === '分享好了，再測一次' && !s.detail && shots === 3) pass('試算表讀不到 → 紅字下面再給一次三步＋帳號＋看圖（以前貼了連結教學就收起來），不秀 Google 英文原文')
    else fail('試算表讀不到時沒有教學', JSON.stringify({ ...s, shots }))
    await pg.close()
  }

  // ── 第二十段（`D-124`）：一次貼好幾個網址 → 每個各自整理、各自加入（以前被當成一段文字，AI 整理的是網址字串）──
  {
    const posts = []
    const bulks = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 0, limit: 50, planName: '免費' } })
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        posts.push({ type: b.type, url: b.url })
        return json({ jobId: `job-multi-${posts.length}`, status: 'processing', phase: 'chunk' })
      }
      const pj = url.match(/\/api\/ai\/knowledge\/preview-jobs\/job-multi-(\d+)/)
      if (pj && m === 'GET') return json({ status: 'done', sourceName: `頁 ${pj[1]}`, chunks: [{ title: `頁 ${pj[1]} 一`, content: '內容', tags: [], questions: [] }], warnings: [], contentHash: 'h' })
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b.source?.url)
        return json({ sourceId: `s-${bulks.length}`, total: 1, indexed: 1, failed: 0, items: [] })
      }
      return undefined
    })
    await pg.evaluate(() => {
      const ta = document.querySelector('.kb-drop__paste textarea')
      ta.value = 'https://shop.example.tw/pages/faq\nhttps://shop.example.tw/pages/shipping'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(600)
    const label = await pg.$eval('.kb-detected__label', el => el.innerText).catch(() => '')
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => document.querySelector('.kb-site-summary')?.innerText.includes('已建立'), null, 60_000)
    const hint = await pg.$eval('.kb-section-hint', el => el.innerText).catch(() => '')
    if (label === '2 個網址' && posts.length === 2 && posts.every(p => p.type === 'url') && bulks.length === 2 && hint.includes('你貼了 2 個網址')) pass('一次貼兩個網址 → 認成「2 個網址」、各自當網頁整理、各自加入')
    else fail('一次貼好幾個網址不對', JSON.stringify({ label, posts, bulks, hint: hint.slice(0, 60) }))
    await pg.close()
  }

  // ── 第二十一段（`D-124`）：整個網站 → 先幫他勾好常被問的頁（照空間）、分組用白話、講空間 ──
  {
    const pages = [
      { url: 'https://shop.example.tw/', title: '首頁' },
      ...Array.from({ length: 30 }, (_, i) => ({ url: `https://shop.example.tw/products/${i}`, title: `商品 ${i}` })),
      ...Array.from({ length: 12 }, (_, i) => ({ url: `https://shop.example.tw/blogs/news/${i}`, title: `文章 ${i}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ url: `https://shop.example.tw/collections/c${i}`, title: `分類 ${i}` })),
      { url: 'https://shop.example.tw/pages/shipping', title: '運送與退換貨' },
      { url: 'https://shop.example.tw/pages/faq', title: '常見問題' },
      { url: 'https://shop.example.tw/policies/privacy-policy', title: '隱私權政策' },
    ]
    const pg = await openImportDialog((req) => {
      const url = req.url()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/discover-pages')) return json({ pages, from: 'sitemap', truncated: false })
      return undefined
    })
    await pg.evaluate(() => {
      const ta = document.querySelector('.kb-drop__paste textarea')
      ta.value = 'https://shop.example.tw/'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitFor(pg, () => !!document.querySelector('.kb-site-peek:not(.kb-site-peek--loading) .el-button'), null, 15_000)
    await pg.evaluate(() => document.querySelector('.kb-site-peek .el-button')?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-site-list'), null, 5000)
    await sleep(400)
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-site-precheck.png') })
    const r = await pg.evaluate(() => ({
      checked: [...document.querySelectorAll('.kb-site-row')].filter(row => row.querySelector('.el-checkbox.is-checked')).map(row => row.querySelector('.kb-site-url')?.innerText ?? ''),
      firstRows: [...document.querySelectorAll('.kb-site-row')].map(row => !!row.querySelector('.el-checkbox.is-checked')),
      chips: [...document.querySelectorAll('.kb-site-group-chip')].map(c => c.innerText.trim()),
      toolbar: document.querySelector('.kb-site-toolbar')?.innerText ?? '',
    }))
    // 勾好的排最上面、說明頁在前（網站清單裡它們常在最後面，不排上來得捲到底才看得到）；隱私權與文章一定不在
    const okPick = r.checked.length === 8 && r.checked[0].includes('/pages/shipping') && r.checked[1].includes('/pages/faq') && !r.checked.some(u => u.includes('privacy') || u.includes('/blogs/'))
      && r.firstRows.slice(0, 8).every(Boolean)
    const okChips = r.chips.some(c => c.startsWith('商品')) && r.chips.some(c => c.startsWith('文章')) && !r.chips.some(c => c.includes('/'))
    if (okPick && okChips && r.toolbar.includes('空間還能放 40 條')) pass(`整個網站 → 先勾好 8 頁（說明頁在前、補商品頁，剩 40 條÷每頁約 5 條），分組用白話（${r.chips.join('｜')}），講空間`)
    else fail('整個網站的預先勾選／分組／空間不對', JSON.stringify(r))
    await pg.close()
  }

  // ── 第二十二段（`D-124`）：資料頁「換新版」→ 選檔就直接整理、換掉那一份（不靠名字一樣）──
  {
    let patchedId = ''
    let patchedName = ''
    let polls = 0
    const bulks = []
    const pg = await openImportDialog(async (req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/sources/list') && m === 'GET') {
        const real = await (await fetch(url, { headers: req.headers() })).json()
        const items = Array.isArray(real.items) ? real.items : []
        const target = items.find(s => s.type === 'file') ?? items[0]
        if (target) { target.type = 'file'; patchedId = target.id; patchedName = target.name }
        return json(real)
      }
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId: 'job-newver', status: 'processing', phase: 'chunk' })
      if (url.includes('/api/ai/knowledge/preview-jobs/job-newver') && m === 'GET') {
        if (++polls <= 2) return json({ status: 'processing', phase: 'chunk' })
        return json({ status: 'done', sourceName: '退換貨政策.docx', sourceType: 'file', truncated: false, ocrUsed: false, meta: {}, warnings: [], existingMatches: [], contentHash: 'h', suggestedProductName: 'AI 猜的',
          chunks: [{ title: '新版第一條', content: '內容', tags: [], questions: [] }] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        return json({ sourceId: b.replaceSourceId ?? 'x', total: 1, indexed: 1, failed: 0, replacedChunks: 7, originalKept: true, items: [{ id: 'c1', title: '新版第一條', status: 'indexed' }] })
      }
      return undefined
    }, { path: '/knowledge/sources', waitSel: '.split-list, .src-list, aside' })
    if (!patchedId) throw new Error('資料清單是空的，沒有可以驗「換新版」的資料')
    await waitFor(pg, name => [...document.querySelectorAll('aside *, .split-list *')].some(el => el.children.length === 0 && el.textContent?.trim() === name), patchedName)
    await pg.evaluate((name) => {
      const el = [...document.querySelectorAll('aside *, .split-list *')].find(e => e.children.length === 0 && e.textContent?.trim() === name)
      el?.click()
    }, patchedName)
    await waitFor(pg, () => [...document.querySelectorAll('.admin-header-actions .el-button')].some(b => b.innerText.includes('換新版')), null, 15_000)
    const [chooser] = await Promise.all([
      pg.waitForFileChooser({ timeout: 5000 }).catch(() => null),
      pg.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button')].find(b => b.innerText.includes('換新版'))?.click()),
    ])
    if (!chooser) throw new Error('按「換新版」沒有開選檔視窗')
    await chooser.accept([pathOf.docx])
    const intent = await waitFor(pg, () => document.querySelector('.kb-replace-intent')?.innerText.includes('換新版'), null, 10_000)
    await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 30_000)
    const body = await pg.$eval('.el-dialog__body', el => el.innerText.replace(/\s+/g, ' ')).catch(() => '')
    const b = bulks[0]
    if (intent && bulks.length === 1 && b.replaceSourceId === patchedId && b.source?.name === patchedName && !b.source?.productName && body.includes('原本的 7 條知識已換成上面這批')) {
      pass(`資料頁「換新版」→ 選檔就整理、直接換掉「${patchedName}」（帶它的 id、名字照舊、不帶 AI 猜的產品名），結果頁講舊的 7 條去哪了`)
    }
    else fail('換新版不對', JSON.stringify({ intent, bulks: bulks.length, replace: b?.replaceSourceId, want: patchedId, name: b?.source?.name, product: b?.source?.productName, body: body.slice(0, 200) }))
    await pg.close()
  }

  // ── 第二十三段（`D-124`）：沒有資料時入口只剩常駐那顆＋右邊大的；「還沒整理好」那格的「手寫一條」打開手寫編輯 ──
  {
    const pg = await openImportDialog((req) => {
      if (req.url().includes('/api/ai/sources/list') && req.method() === 'GET') return json({ items: [], orphanCount: 0 })
      return undefined
    }, { path: '/knowledge/sources', waitSel: '.split-sidebar-empty' })
    const emptyBtns = await pg.$$eval('.split-sidebar-empty .el-button', els => els.length)
    if (emptyBtns === 0) pass('沒有資料時，左邊空白處不再多一顆「加入知識」（上方常駐一顆、右邊大的一顆）')
    else fail('左邊空白處還有重複的加入按鈕', String(emptyBtns))
    await pg.evaluate(() => document.querySelector('[data-tour="kb-import"]')?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-start'), null, 10_000)
    await pg.evaluate(() => [...document.querySelectorAll('.kb-start__tile')].find(b => b.innerText.includes('還沒整理好'))?.click())
    await sleep(300)
    await pg.evaluate(() => [...document.querySelectorAll('.kb-start__panel .kb-start__fold')].find(b => b.innerText.includes('手寫一條'))?.click())
    const manual = await waitFor(pg, () => [...document.querySelectorAll('.el-dialog__title')].some(t => t.innerText.includes('手寫一條知識') && t.closest('.el-dialog')?.offsetParent !== null), null, 8000)
    if (manual) pass('「還沒整理好」那格按「手寫一條」→ 關掉加入視窗、打開手寫一條的編輯框')
    else fail('「手寫一條」沒有打開手寫編輯框')
    await pg.close()
  }

  // ── 第二十四段（`D-124`）：LINE 還沒測試完、但沒有要被拉回開通對話的帳號 → 第一次進知識庫照樣自動帶導覽 ──
  //    （以前只要開通沒做完，每一頁的自動導覽都不跳；09-26 之後大部分沒接 LINE 的人根本不會被拉回去）
  {
    const pg = await openImportDialog(async (req) => {
      const url = req.url()
      if (url.includes('/api/admin/tour-seen') && req.method() === 'GET') return json({ seen: [] })
      if (url.includes('/api/admin/setup-status') && req.method() === 'GET') {
        const real = await (await fetch(url, { headers: req.headers() })).json()
        real.items = (real.items ?? []).map(i => (i.id === 'firstMessageReceived' ? { ...i, status: 'incomplete' } : i))
        return json(real)
      }
      return undefined
    }, { path: '/knowledge/sources', waitSel: '[data-tour="kb-sources"]' })
    // ⚠️ 前面幾段打開知識庫時導覽可能已經自動跑過一次，瀏覽器本機記了「看過」（後端或本機任一邊說看過就算看過）。
    //    清掉本機那份再重新載入，才是「第一次進來」
    await pg.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tour-auto-seen:')) localStorage.removeItem(k) })
    await pg.reload({ waitUntil: 'networkidle2', timeout: 180_000 })
    await waitFor(pg, () => !!document.querySelector('[data-tour="kb-sources"]'), null, 60_000)
    // ⚠️ 導覽框是固定定位（offsetParent 永遠是 null），用它的字判斷：第一步的標題只會出現在導覽裡
    const toured = await waitFor(pg, () => document.body.innerText.includes('從「加入知識」開始'), null, 20_000)
    if (toured) pass('開通還沒做完（還沒用手機測試）、但沒有要被拉回去 → 第一次進知識庫照樣自動跳導覽')
    else fail('開通沒做完的帳號第一次進知識庫沒有跳導覽')
    await pg.close()
  }

  // ── 第二十五段（`D-124` 拍板做 `E-13` 的一小塊）：手機 390 寬 → 側欄收成左上角選單、清單佔滿、點一份看內容、回清單；
  //    拍照加入照樣停下來核對、加好了看得到整理出哪幾條。以前側欄固定 240px，內容只剩 150px 一條
  {
    const JOB = 'job-phone'
    const bulks = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId: JOB, status: 'processing', phase: 'ocr' })
      if (url.includes(`/api/ai/knowledge/preview-jobs/${JOB}`) && m === 'GET') {
        return json({ status: 'done', sourceName: 'IMG_0412.HEIC', sourceUrl: '', sourceType: 'file', truncated: false, ocrUsed: true, meta: { image: 1 }, existingMatches: [], warnings: [], contentHash: 'h',
          chunks: [{ title: '拿鐵', content: '中杯 60 元、大杯 75 元', tags: [], questions: [] }, { title: '美式', content: '中杯 50 元、大杯 65 元', tags: [], questions: [] }] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        return json({ sourceId: 'phone-src', total: b.chunks.length, indexed: b.chunks.length, failed: 0, originalKept: true, items: [] })
      }
      return undefined
    }, { path: '/knowledge/sources', waitSel: '[data-tour="kb-sources"]', width: 390, height: 844 })
    await waitFor(pg, () => document.querySelectorAll('.split-list [data-tour="kb-source-row"]').length > 0, null, 30_000)
    const shotPhone = async name => { if (process.env.SHOT_DIR) await pg.screenshot({ path: join(process.env.SHOT_DIR, name) }) }
    const navEdge = () => pg.evaluate(() => {
      const r = document.querySelector('.layout-wrapper > .sidebar').getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right) }
    })

    const list = await pg.evaluate(() => ({
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      listW: Math.round(document.querySelector('.split-sidebar').getBoundingClientRect().width),
      topbar: getComputedStyle(document.querySelector('.shell-topbar')).display !== 'none',
      workbench: getComputedStyle(document.querySelector('.split-editor')).display !== 'none',
    }))
    const nav0 = await navEdge()
    await shotPhone('kb-phone-list.png')
    if (!list.hscroll && list.listW >= 380 && list.topbar && !list.workbench && nav0.right <= 0) pass(`手機：側欄收起來、清單佔滿 ${list.listW}px、沒有橫向捲動`)
    else fail('手機上清單沒有佔滿（或側欄還擋著）', JSON.stringify({ ...list, nav0 }))

    await pg.click('.shell-topbar__menu')
    await sleep(400)
    const navOpen = await navEdge()
    await shotPhone('kb-phone-nav.png')
    await pg.mouse.click(370, 500) // 選單旁邊的暗處
    await sleep(400)
    const navClosed = await navEdge()
    if (navOpen.left === 0 && navOpen.right > 200 && navClosed.right <= 0) pass('手機選單：點左上角滑出來、點旁邊暗處收回去')
    else fail('手機選單開關不對', JSON.stringify({ navOpen, navClosed }))

    const picked = await pg.evaluate(() => {
      const row = document.querySelector('.split-list [data-tour="kb-source-row"]')
      row.click()
      return row.innerText.split('\n')[0]
    })
    const opened = await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length > 0, null, 30_000)
    const detail = await pg.evaluate(() => ({
      back: document.querySelector('.split-mobile-back')?.innerText.trim() ?? '',
      listShown: getComputedStyle(document.querySelector('.split-sidebar')).display !== 'none',
      editorW: Math.round(document.querySelector('.split-editor').getBoundingClientRect().width),
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))
    await shotPhone('kb-phone-detail.png')
    if (opened && detail.back.includes('你的資料') && !detail.listShown && detail.editorW >= 380 && !detail.hscroll) pass(`手機：點「${picked}」→ 內容佔滿、上面有「← 你的資料」`)
    else fail('手機上點一份資料之後看不到內容', JSON.stringify({ opened, ...detail }))
    await pg.click('.split-mobile-back')
    const backToList = await waitFor(pg, () => getComputedStyle(document.querySelector('.split-sidebar')).display !== 'none' && !document.querySelector('.split-mobile-back'), null, 5_000)
    if (backToList) pass('手機：按「← 你的資料」回到清單')
    else fail('手機上回不到清單')

    // 拍照加入：選檔框收照片（手機上就是「拍照或選照片」）→ 字是 AI 認的，停下來給他核對 → 按了才加 → 看得到整理出哪幾條
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('加入知識'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-file-input'), null, 10_000)
    const accept = await pg.$eval('.kb-file-input', e => e.getAttribute('accept') ?? '')
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.heic)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-preview-summary'), null, 30_000)
    const review = await pg.evaluate(() => {
      const d = document.querySelector('.el-dialog').getBoundingClientRect()
      return {
        ocr: document.querySelector('.kb-ocr-alert')?.innerText ?? '',
        btn: document.querySelector('.kb-preview-summary__actions .el-button--primary')?.innerText.trim() ?? '',
        left: Math.round(d.left), right: Math.round(d.right),
        hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    })
    await shotPhone('kb-phone-photo-review.png')
    if (/image|\.heic/i.test(accept) && review.ocr.includes('這張照片') && review.btn === '加入 2 條' && !bulks.length && review.left >= 0 && review.right <= 390 && !review.hscroll) pass('手機拍照加入：停下來核對、視窗沒有超出螢幕')
    else fail('手機拍照加入的核對畫面不對', JSON.stringify({ accept: accept.slice(0, 80), ...review, bulks: bulks.length }))
    await pg.evaluate(() => document.querySelector('.kb-preview-summary__actions .el-button--primary')?.click())
    const added = await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 15_000)
    const result = await pg.evaluate(() => document.querySelector('.el-dialog__body')?.innerText ?? '')
    await shotPhone('kb-phone-photo-result.png')
    if (added && bulks.length === 1 && result.includes('拿鐵') && result.includes('美式')) pass('手機：按加入之後看得到整理出哪幾條（拿鐵、美式）')
    else fail('手機上加好了看不到結果', JSON.stringify({ added, bulks: bulks.length, result: result.slice(0, 200) }))
    await pg.close()
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
// 第一段只選檔不按整理、第二段的上傳／整理／匯入全部回假的：知識庫那邊不該有任何一支走到預設攔截；
// 有攔到就代表某處自己觸發了沒假造到的寫入。「導覽看過了」那支是頁面自己會送的（跟匯入無關），只列出來不算失敗。
const kbWrites = blockedWrites.filter(w => w.includes('/api/ai/'))
const otherWrites = blockedWrites.filter(w => !w.includes('/api/ai/'))
if (kbWrites.length) fail('知識庫有不該發生的寫入請求（已攔下、沒有送到伺服器）', kbWrites.join('\n     '))
else pass('知識庫零寫入請求（沒有上傳、沒有建整理工作）')
if (otherWrites.length) console.log(`ℹ️  另外攔下 ${otherWrites.length} 支頁面自己送的寫入（沒有送到伺服器）：${[...new Set(otherWrites)].join('、')}`)

if (failed) { console.error('\n有關卡沒過'); process.exit(1) }
console.log('\n全部通過')
