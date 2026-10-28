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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
/**
 * 從第幾段開始跑（預設全跑）。第三十段起（`C-308`／`C-309`／`D-125`）全部用假資料、不靠前面任何一段，
 * 破壞性驗證（拿掉修正→那一關變紅→還原）時用 CHECK_FROM=30 只跑那幾段，不必每次等前面二十九段
 */
const CHECK_FROM = Number(process.env.CHECK_FROM ?? 1)
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
// ⚠️ 頁面自動導覽記的鑰匙是「這一頁教哪幾支」接起來（AdminPageHelpButton 的 tourKey：'knowledge|knowledge-manage'），
//    不是單一支的 id——只回單一支的話知識庫頁的自動導覽照樣會跳出來、擋住匯入視窗（`C-314` 跑守門員時抓到：第三十六段偶爾整個視窗不見）。
//    所以把知識庫頁問號鈕上那幾組也接起來一起回
const KB_PAGE_SRC = readFileSync('app/pages/admin/[workspaceId]/knowledge/sources/index.vue', 'utf8')
const TOUR_IDS = [
  ...[...readFileSync('app/utils/tutorial-topics.ts', 'utf8').matchAll(/\bid: '([a-z0-9-]+)'/g)].map(m => m[1]),
  ...[...KB_PAGE_SRC.matchAll(/:topics="\[([^\]]+)\]"/g)].map(m => [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map(x => x[1]).join('|')),
]

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
 * 「換新版」那幾段（第二十二、二十六段）換掉的是正式庫裡真的一份：換之前會讀那一份**他改過哪幾條**（`D-125`①），
 * 有的話會停下來問——那幾段驗的是「直接換掉」，所以這裡照實向伺服器拿（唯讀）、只把「改過」的記號拿掉，
 * 不管正式庫裡那一份今天有沒有人改過，畫面都一樣。⛔ 只動瀏覽器拿到的那一份，不寫回去。
 */
async function realDetailWithoutEdits(req, sourceId) {
  const url = req.url()
  if (req.method() !== 'GET' || !sourceId) return undefined
  const m = url.match(/\/api\/ai\/sources\/([^/?]+)\?/)
  if (!m || decodeURIComponent(m[1]) !== sourceId) return undefined
  const real = await (await fetch(url, { headers: req.headers() })).json()
  for (const c of real.chunks ?? []) c.manuallyEditedAtMs = 0
  return json(real)
}

/**
 * 開一個已登入、匯入視窗打開的頁面。
 * fake(req)：要假造的請求回傳 { status, contentType, body }；回 undefined 照原規則走
 * （GET 照常打到本機伺服器＝唯讀正式庫；不是 GET 的 /api 一律攔下、記一筆、回假的 200）。
 */
/**
 * 「這份在講什麼」（`C-316`）：打開一份還沒有摘要的資料時，頁面會自己打一次 PUT `{ generateSummary: true }`（會寫正式庫、會花 AI 的錢）。
 * 每一段都會點開資料，所以這一支在**每一段**都先攔下、回假的摘要、記在 summaryCalls（不算「不該發生的寫入」）；
 * 要驗摘要行為的那一段用 opts.summary 自己回。⚠️ 排在各段自己的 fake 前面：不然第三十段那種「這一份的 PUT 一律記下來」會把它也算進去
 */
const summaryCalls = []
const isSummaryPut = (req) => {
  if (req.method() !== 'PUT' || !/\/api\/ai\/sources\/[^/?]+$/.test(new URL(req.url()).pathname)) return null
  try {
    const b = JSON.parse(req.postData() || '{}')
    return b.generateSummary === true ? b : null
  }
  catch { return null }
}

async function openImportDialog(fake = () => undefined, opts = {}) {
  const { path = '/knowledge/sources?import=1', waitSel = '.kb-drop', width = 1440, height = 1000, summary } = opts
  const page = await browser.newPage()
  await page.setViewport({ width, height })
  await page.setRequestInterception(true)
  page.on('request', async (req) => {
    const url = req.url()
    const sumBody = isSummaryPut(req)
    if (sumBody) {
      const id = decodeURIComponent(new URL(url).pathname.split('/').pop())
      summaryCalls.push({ id, force: sumBody.force === true })
      const r = summary ? await summary(id, sumBody) : undefined
      return void req.respond(r ?? json({ summary: ['守門員假的摘要第一行', '守門員假的摘要第二行'], summaryAt: Date.now() }))
    }
    const faked = await fake(req)
    if (faked) return void req.respond(faked)
    if (url.includes('/api/admin/tour-seen') && req.method() === 'GET') return void req.respond(json({ seen: TOUR_IDS }))
    // 「這幾個網址加過了沒」（探頁端點帶 urls）是 POST 但只讀（伺服器只查資料清單）：照常送，貼好幾個網址的那幾段才是真的在問正式庫
    if (url.includes('/api/ai/knowledge/discover-pages') && Array.isArray(JSON.parse(req.postData() || '{}').urls)) return void req.continue()
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

/**
 * 等資料清單那一支被攔到（`C-314` 跑守門員時抓到的競速）：開頁時等的是 `aside`，而**左邊的 app 側欄就是 aside**，
 * 比資料清單早出現——清單那一支還沒回來就判「資料清單是空的」，整輪守門員中斷（網路慢時常常發生）。
 * got：回傳「挑到的那一份」的 id，挑到了就不等
 */
async function waitListed(got, ms = 30_000) {
  const end = Date.now() + ms
  while (!got() && Date.now() < end) await sleep(250)
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
  if (CHECK_FROM <= 29) {
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
  else fail('第一步沒講 AI 知識量', firstLine)

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
  if (resultLine.includes('還有 2 條因為 AI 知識量不夠沒收進去')) pass('結果頁講出還有 2 條沒收、怎麼補')
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
  await waitListed(() => patchedId)
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
  if (summaryText.includes('已建立 3 份資料、共 12 條知識') && summaryText.includes('另有 3 條因為 AI 知識量不夠沒收進去')) pass(`結論列講清楚收了多少、幾條沒收：「${summaryText.trim().slice(0, 80)}…」`)
  else fail('一次好幾份的結論列不對', summaryText)
  const actionLabels = await batchPage.$$eval('.kb-import-actions .el-button', els => els.map(e => e.innerText.trim()))
  if (!actionLabels.some(t => t.includes('重試'))) pass(`跑完沒東西可重試 → 不留「重試 0 份」的灰按鈕（剩：${actionLabels.join('／')}）`)
  else fail('跑完還留著重試按鈕', actionLabels.join('／'))
  await batchPage.close()

  // ── 第五段：一次好幾份裡有一份跟現有資料同名 → 等他決定、「更新原本那一份」（以前叫「換掉舊的」）──
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
      // 「更新原本那一份」會先讀舊的那一份有沒有他改過的（`D-125`①）：這一段的舊資料沒有改過的
      if (url.includes('/api/ai/sources/old-src-1') && m === 'GET') return json({ source: {}, chunks: [] })
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.csv)
    await waitFor(pg, () => document.querySelectorAll('.kb-site-row').length === 2)
    await pg.evaluate(() => document.querySelector('.kb-import-actions .el-button--primary')?.click())
    await waitFor(pg, () => document.querySelector('.kb-site-summary')?.innerText.includes('已建立'), null, 60_000)
    const before = await pg.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()))
    const dupRow = before.find(t => t.includes('退換貨政策.docx')) ?? ''
    const csvRow = before.find(t => t.includes('商品匯出.csv')) ?? ''
    // `C-319`：撞名一律講「更新原本那一份」（以前一次好幾份那一列叫「換掉舊的」）
    if (dupRow.includes('等你決定') && dupRow.includes('更新原本那一份') && !bulks.some(b => b.name === '退換貨政策.docx')) pass('同名那份先擱著等決定（沒有默默多建一份）')
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
    await pg.evaluate(() => [...document.querySelectorAll('.kb-file-batch__conflict .el-button')].find(b => b.innerText.includes('更新原本那一份'))?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.kb-site-row')].some(r => r.innerText.includes('退換貨政策.docx') && r.innerText.includes('✓')), null, 15_000)
    const replaced = bulks.find(b => b.name === '退換貨政策.docx')
    if (replaced?.replace === 'old-src-1') pass('按「更新原本那一份」→ 帶舊資料的 id 更新那一份（不用重新整理）')
    else fail('「更新原本那一份」沒有帶舊資料', JSON.stringify(bulks))
    // 只換內容：⛔ 帶了資料夾／產品名，伺服器就照收，舊資料會被默默搬到猜的資料夾、改成 AI 猜的產品名（2026-10-12 code review）
    if (replaced && !replaced.keys.includes('folderId') && !replaced.keys.includes('productName')) pass('「更新原本那一份」不帶分組與產品名（舊的那份原本的設定留著）')
    else fail('「更新原本那一份」帶了分組或產品名', JSON.stringify(replaced))
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
    if (line.includes('AI 知識量滿了') && disabled === true && !uploads.length) pass(`空間滿了 → 清單上方先講（「${line.trim().slice(0, 40)}…」）、按鈕按不下去、一份都沒上傳`)
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
    // `C-319`：那一顆叫「更新原本那一份」（以前「更新這一份」）。⚠️ 要真的按到：按到了那一顆會變「已選這一份」——
    //    以前字對不上、根本沒按到，這一關只是剛好空間本來就滿才綠（假綠燈，2026-10-15 匯入視窗那邊抓到）
    const clicked = await pg.evaluate(() => {
      const b = [...document.querySelectorAll('.kb-dedup-row .el-button')].find(x => x.innerText.includes('更新原本那一份'))
      b?.click()
      return !!b
    })
    await sleep(500)
    const picked = await pg.$$eval('.kb-dedup-row .el-button', els => els.some(e => e.innerText.includes('已選這一份')))
    const btn = await pg.$eval('.kb-preview-summary__actions .el-button--primary', el => ({ text: el.innerText.trim(), disabled: el.disabled || el.classList.contains('is-disabled') })).catch(() => null)
    if (clicked && picked && btn?.text === 'AI 知識量已經滿了' && btn.disabled && !bulkCalled) pass('選了「更新原本那一份」（變成「已選這一份」）、舊的那份全是草稿 → 換掉也空不出位置，按鈕講「AI 知識量已經滿了」、按不下去')
    else fail('「更新原本那一份」沒按到、或把草稿算成空出來的空間', JSON.stringify({ clicked, picked, btn }))
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
    // 2026-10-15 老闆：截圖不要收起來 → 一點開就是三步＋三張圖、沒有收合鈕（主按鈕因此會被推到第一屏外，只記數字不判紅）
    const sheetFold = await pg.evaluate(() => [...document.querySelectorAll('.kb-start__panel .kb-start__fold')].map(b => b.innerText.trim()))
    if (sheet.steps === 3 && sheet.shots === 3 && sheetFold.length === 0) pass(`點「Google 試算表」→ 三步＋三張截圖直接攤開、沒有收合鈕（主按鈕底邊 ${sheet.btnBottom}px／視窗 ${sheet.vh}px）`)
    else fail('「Google 試算表」那格不對', JSON.stringify({ ...sheet, sheetFold }))

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
    const folderPosts = []
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
      // 分組（`C-320`）：沒有任何分組（畫面每次一樣，不吃正式庫的 18 組）；替他建的新分組回假的
      if (new URL(url).pathname === '/api/ai/folders' && m === 'GET') return json({ items: [] })
      if (new URL(url).pathname === '/api/ai/folders' && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        folderPosts.push(b)
        return json({ id: 'auto-folder-w1', name: b.name, order: 0, createdAtMs: Date.now(), general: b.general === true })
      }
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
      ask: document.querySelector('.kb-import-dialog .kb-group-pick__q')?.innerText ?? '',
      picked: document.querySelector('.kb-import-dialog .kb-group-pick .el-radio.is-checked')?.innerText.trim() ?? '',
    }))
    // `C-320`：上傳時不選分組、不填產品名；結果頁一行「存成『X』」，AI 認出商品但比不到任何一組時問一題「這份在講哪個商品？」（預設新分組）
    const folderOk = !folderPosts.length || bulks[0]?.source?.folderId === 'auto-folder-w1'
    if (r.label.includes('第 3 步') && r.label.includes('加好了') && r.saved.includes('存成「退換貨政策.docx」') && r.ask.includes('這份在講哪個商品？') && r.picked.includes('新分組「W1 智慧手錶」') && folderOk) pass(`結果頁講存成哪一份、問「這份在講哪個商品？」、預設勾「${r.picked}」（放進那一組）`)
    else fail('結果頁沒講存成哪一份／沒問是哪個商品', JSON.stringify({ ...r, folderPosts, bulkFolder: bulks[0]?.source?.folderId }))
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
    if (r.offer.includes('要不要再做一張') && r.offer.includes('佔 1 條 AI 知識量')) {
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
      // 換掉之前讀那一份有沒有他改過的（`D-125`①）：沒有改過的＝照舊直接換
      if (url.includes('/api/ai/sources/old-1') && m === 'GET') return json({ source: {}, chunks: [] })
      return undefined
    })
    await watchPreview(pg)
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    // `C-319`：叫「重新整理，更新原本那一份」（以前「重新整理，換掉那一份」）
    const dupShown = await waitFor(pg, () => document.querySelector('.kb-dup-content')?.innerText.includes('重新整理，更新原本那一份'), null, 15_000)
    if (dupShown) pass('內容一模一樣 → 先停下來，給「看那一份」與「重新整理，更新原本那一份」')
    else fail('內容一模一樣沒有停下來')
    await pg.evaluate(() => [...document.querySelectorAll('.kb-dup-content .el-button')].find(b => b.innerText.includes('更新原本那一份'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 30_000)
    const b = bulks[0]
    const resultText = await pg.$eval('.el-dialog__body', el => el.innerText.replace(/\s+/g, ' ')).catch(() => '')
    const sawPreview = await pg.evaluate(() => window.__sawPreview)
    if (posts.length === 2 && posts[1].ignoreDuplicate === true && bulks.length === 1 && b.replaceSourceId === 'old-1' && !b.source?.productName && !sawPreview) {
      pass('按「重新整理，更新原本那一份」→ 直接換掉原本那一份（帶它的 id、不帶 AI 猜的產品名、沒停在預覽）')
    }
    else fail('「更新原本那一份」不對',JSON.stringify({ posts: posts.length, ignore: posts[1]?.ignoreDuplicate, replace: b?.replaceSourceId, product: b?.source?.productName, sawPreview }))
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
    const shots = await pg.$$eval('.kb-gsheet-share__steps .kb-shot', els => els.length)
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog')).screenshot({ path: join(process.env.SHOT_DIR, 'kb-sheet-no-access.png') })
    // 帳號：開窗時讀到的那份優先（正式的系統帳號），探測帶回來的只是備援——所以只驗「有一個帳號」
    if (s.steps === 3 && s.email.includes('@') && s.btn === '分享好了，再測一次' && !s.detail && shots === 3) pass('試算表讀不到 → 紅字下面再給一次三步＋帳號＋三張截圖直接攤開（以前貼了連結教學就收起來），不秀 Google 英文原文')
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
    if (okPick && okChips && r.toolbar.includes('AI 知識量還能放 40 條')) pass(`整個網站 → 先勾好 8 頁（說明頁在前、補商品頁，剩 40 條÷每頁約 5 條），分組用白話（${r.chips.join('｜')}），講空間`)
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
      const detail = await realDetailWithoutEdits(req, patchedId)
      if (detail) return detail
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
    await waitListed(() => patchedId)
    if (!patchedId) throw new Error('資料清單是空的，沒有可以驗「換新版」的資料')
    await waitFor(pg, name => [...document.querySelectorAll('aside *, .split-list *')].some(el => el.children.length === 0 && el.textContent?.trim() === name), patchedName)
    await pg.evaluate((name) => {
      const el = [...document.querySelectorAll('aside *, .split-list *')].find(e => e.children.length === 0 && e.textContent?.trim() === name)
      el?.click()
    }, patchedName)
    await waitFor(pg, () => [...document.querySelectorAll('.admin-header-actions .el-button')].some(b => b.innerText.includes('上傳新版')), null, 15_000)
    const [chooser] = await Promise.all([
      pg.waitForFileChooser({ timeout: 5000 }).catch(() => null),
      pg.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button')].find(b => b.innerText.includes('上傳新版'))?.click()),
    ])
    if (!chooser) throw new Error('按「上傳新版」沒有開選檔視窗')
    await chooser.accept([pathOf.docx])
    // `C-319`：資料頁那顆、加入視窗頂上那一行都叫「上傳新版」（以前「換新版」）
    const intent = await waitFor(pg, () => document.querySelector('.kb-replace-intent')?.innerText.includes('上傳新版'), null, 10_000)
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
    // `C-317`：打開的是「補一條知識」小視窗（跟其他新增入口同一個），不再是五格的編輯框
    const manual = await waitFor(pg, () => [...document.querySelectorAll('.el-dialog__title')].some(t => t.innerText.includes('補一條知識') && t.closest('.el-dialog')?.offsetParent !== null), null, 8000)
    if (manual) pass('「還沒整理好」那格按「手寫一條」→ 關掉加入視窗、打開「補一條知識」小視窗')
    else fail('「手寫一條」沒有打開「補一條知識」')
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

  /**
   * 資料清單裡挑一份、改成「檔案」型別（「換新版」只對檔案出現）。後面幾段共用：
   * 回傳一個 fake 片段（處理清單那支）跟被挑中的那一份。
   */
  const pickFileSource = () => {
    const hit = { id: '', name: '' }
    const handle = async (req) => {
      const url = req.url()
      const detail = await realDetailWithoutEdits(req, hit.id)
      if (detail) return detail
      if (!(url.includes('/api/ai/sources/list') && req.method() === 'GET')) return undefined
      const real = await (await fetch(url, { headers: req.headers() })).json()
      const items = Array.isArray(real.items) ? real.items : []
      const target = items.find(s => s.id === hit.id) ?? items.find(s => s.type === 'file') ?? items[0]
      if (target) { target.type = 'file'; hit.id = target.id; hit.name = target.name }
      return json(real)
    }
    return { hit, handle }
  }
  /** 在資料頁點那一份 → 按「換新版」→ 選檔 */
  const replaceViaDataPage = async (pg, hit, file) => {
    await waitFor(pg, name => [...document.querySelectorAll('aside *, .split-list *')].some(el => el.children.length === 0 && el.textContent?.trim() === name), hit.name)
    await pg.evaluate((name) => { [...document.querySelectorAll('aside *, .split-list *')].find(e => e.children.length === 0 && e.textContent?.trim() === name)?.click() }, hit.name)
    await waitFor(pg, () => [...document.querySelectorAll('.admin-header-actions .el-button')].some(b => b.innerText.includes('上傳新版')), null, 15_000)
    const [chooser] = await Promise.all([
      pg.waitForFileChooser({ timeout: 5000 }).catch(() => null),
      pg.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button')].find(b => b.innerText.includes('上傳新版'))?.click()),
    ])
    if (!chooser) throw new Error('按「上傳新版」沒有開選檔視窗')
    await chooser.accept([file])
  }

  // ── 第二十六段（2026-10-13 `/code-review`）：「換新版」整理到一半離開頁面、回來接著做 → 照樣換掉那一份
  //    （以前要換哪一份只記在記憶體：回來接著做時當成新的一份直接加進去，舊版沒換掉、多了一份）
  {
    const { hit, handle } = pickFileSource()
    let jobDone = false
    let posted = 0
    const bulks = []
    const pg = await openImportDialog(async (req) => {
      const listed = await handle(req)
      if (listed) return listed
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') { posted++; return json({ jobId: 'job-resume-replace', status: 'processing', phase: 'chunk' }) }
      if (url.includes('/api/ai/knowledge/preview-jobs/job-resume-replace') && m === 'GET') {
        if (!jobDone) return json({ status: 'processing', phase: 'chunk' })
        return json({ status: 'done', sourceName: '型錄_2026新版.docx', sourceType: 'file', truncated: false, ocrUsed: false, meta: {}, warnings: [], existingMatches: [], contentHash: 'h', suggestedProductName: '',
          chunks: [{ title: '新版第一條', content: '內容', tags: [], questions: [] }] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        return json({ sourceId: b.replaceSourceId ?? 'new-src', total: 1, indexed: 1, failed: 0, replacedChunks: 7, originalKept: true, items: [{ id: 'c1', title: '新版第一條', status: 'indexed' }] })
      }
      return undefined
    }, { path: '/knowledge/sources', waitSel: '.split-list, .src-list, aside' })
    await waitListed(() => hit.id)
    if (!hit.id) throw new Error('資料清單是空的，沒有可以驗「換新版」的資料')
    await replaceViaDataPage(pg, hit, pathOf.docx)
    for (let i = 0; i < 60 && !posted; i++) await sleep(250)
    await sleep(800) // 記號在建好工作那一下落地
    const marker = await pg.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kb-import-job:')).map(k => localStorage.getItem(k)).join(''))
    // 離開這一頁再回來＝整頁重新載入（接續只靠落地的記號）；這時候伺服器那份剛好整理好
    jobDone = true
    await pg.reload({ waitUntil: 'networkidle2', timeout: 180_000 })
    for (let i = 0; i < 120 && !bulks.length; i++) await sleep(250)
    const b = bulks[0]
    if (marker.includes(hit.id) && b?.replaceSourceId === hit.id && b?.source?.name === hit.name) pass(`「換新版」整理到一半離開頁面、回來接著做 → 照樣換掉「${hit.name}」，沒有多一份`)
    else fail('「換新版」離開再回來沒有換掉那一份', JSON.stringify({ markerHasTarget: marker.includes(hit.id), bulks: bulks.length, replace: b?.replaceSourceId, want: hit.id, name: b?.source?.name }))
    await pg.close()
  }

  // ── 第二十七段（2026-10-13 `/code-review`）：照片停在「加入之前先看一下」時在資料頁按「換新版」→ 擋下來、那一份還在
  //    （以前直接清掉：已經付過認字的錢、還沒人看過的結果默默不見）
  {
    const { hit, handle } = pickFileSource()
    let posted = 0
    const pg = await openImportDialog(async (req) => {
      const listed = await handle(req)
      if (listed) return listed
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 10, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return STORAGE_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') { posted++; return json({ jobId: 'job-ocr-hold', status: 'processing', phase: 'ocr' }) }
      if (url.includes('/api/ai/knowledge/preview-jobs/job-ocr-hold') && m === 'GET') {
        return json({ status: 'done', sourceName: '價目表.HEIC', sourceUrl: '', sourceType: 'file', truncated: false, ocrUsed: true, meta: { image: 1 }, existingMatches: [], warnings: [], contentHash: 'h',
          chunks: [{ title: '拿鐵', content: '中杯 60 元', tags: [], questions: [] }, { title: '美式', content: '中杯 50 元', tags: [], questions: [] }] })
      }
      return undefined
    }, { path: '/knowledge/sources?import=1', waitSel: '.kb-drop' })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.heic)
    await sleep(400)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-preview-summary'), null, 30_000)
    await pg.evaluate(() => document.querySelector('.kb-import-dialog .el-dialog__headerbtn')?.click())
    await sleep(600)
    await waitListed(() => hit.id)
    if (!hit.id) throw new Error('資料清單是空的，沒有可以驗「換新版」的資料')
    await replaceViaDataPage(pg, hit, pathOf.docx)
    await sleep(1500)
    const s = await pg.evaluate(() => ({
      // 逐條清單預設收著（innerText 看不到條目），看預覽那顆「加入 2 條」還在就是那份結果還在
      stillThere: document.querySelector('.kb-preview-summary__actions .el-button--primary')?.innerText.trim() === '加入 2 條',
      toasts: [...document.querySelectorAll('.toast')].map(t => t.innerText).join('｜'),
    }))
    if (posted === 1 && s.stillThere && s.toasts.includes('還在等你看')) pass('照片停在核對時按「換新版」→ 擋下來講原因，那份整理好的照片結果還在（沒有多開一份工作）')
    else fail('等你核對的結果被「換新版」清掉了', JSON.stringify({ posted, ...s }))
    await pg.close()
  }

  // ── 第二十八段（2026-10-13 `/code-review`）：一次貼兩個網址、其中一個以前加過 → 那一個不再加、標「加過了」
  //    （以前每一頁都當沒加過，網頁改了幾個字就多一份）
  {
    const posts = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/discover-pages') && m === 'POST' && Array.isArray(JSON.parse(req.postData() || '{}').urls)) return json({ imported: ['https://shop.example.tw/pages/faq'] })
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 0, limit: 50, planName: '免費' } })
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        posts.push(b.url)
        return json({ jobId: `job-pasted-${posts.length}`, status: 'processing', phase: 'chunk' })
      }
      const pj = url.match(/\/api\/ai\/knowledge\/preview-jobs\/job-pasted-(\d+)/)
      if (pj && m === 'GET') return json({ status: 'done', sourceName: `頁 ${pj[1]}`, chunks: [{ title: `頁 ${pj[1]} 一`, content: '內容', tags: [], questions: [] }], warnings: [], contentHash: 'h' })
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') return json({ sourceId: 's-x', total: 1, indexed: 1, failed: 0, items: [] })
      return undefined
    })
    await pg.evaluate(() => {
      const ta = document.querySelector('.kb-drop__paste textarea')
      ta.value = 'https://shop.example.tw/pages/faq\nhttps://shop.example.tw/pages/shipping'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(600)
    await pg.evaluate(() => [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.click())
    await waitFor(pg, () => document.querySelector('.kb-site-summary')?.innerText.includes('已建立'), null, 60_000)
    const rows = await pg.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')))
    const faqRow = rows.find(r => r.includes('/pages/faq')) ?? ''
    if (posts.length === 1 && posts[0] === 'https://shop.example.tw/pages/shipping' && faqRow.includes('加過了')) pass('一次貼兩個網址、其中一個加過了 → 只加沒加過的那個，加過的那列標「加過了」')
    else fail('貼好幾個網址時加過的網址又加了一次', JSON.stringify({ posts, rows }))
    await pg.close()
  }

  // ── 第二十九段（2026-10-13 `/code-review`）：網址和 Google 試算表連結混在一起貼 → 講要分開貼、開始鈕鎖住
  //    （以前整串被當成試算表：其他網址默默不見，兩個網址連在一起的字串還被存成試算表的網址）
  {
    const probes = []
    const pg = await openImportDialog((req) => {
      if (req.url().includes('/api/ai/knowledge/gsheet-probe')) { probes.push(1); return json({ status: 'ok', message: '讀得到了' }) }
      return undefined
    })
    await pg.evaluate(() => {
      const ta = document.querySelector('.kb-drop__paste textarea')
      ta.value = 'https://shop.example.tw/pages/faq https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(800)
    const r = await pg.evaluate(() => ({
      label: document.querySelector('.kb-detected__label')?.innerText ?? '',
      sync: document.querySelector('.kb-detected__sync')?.innerText ?? '',
      disabled: [...document.querySelectorAll('.el-button')].find(b => b.innerText.includes('整理並加入'))?.disabled ?? null,
    }))
    if (r.label.includes('混在一起') && r.sync.includes('單獨貼') && r.disabled === true && !probes.length) pass('網址和試算表連結混在一起 → 講「試算表連結請單獨貼」、開始鈕鎖住、不去試讀那份試算表')
    else fail('網址和試算表混在一起時畫面不對', JSON.stringify({ ...r, probes: probes.length }))
    await pg.close()
  }
  } // CHECK_FROM <= 29

  // ══ 第三十段起（2026-10-13 `C-308`／`C-309`／`D-125`）：資料頁、換新版的新規矩 ══════════════════
  // 全部假資料：資料清單、明細、伺服器的回應都在瀏覽器裡回假的——正式庫不讀這幾份、也不寫任何東西，畫面每次一樣。
  const NOW = Date.now()
  const fakeSource = o => ({
    id: 'x', type: 'gsheet', name: '', url: '', folderId: null, status: 'ready', chunkCount: 3, refreshIntervalMinutes: 60,
    onChangeBehavior: 'notify', productName: '', generateOverview: false, urlAutoApply: true, lastFetchedAtMs: NOW - 3600_000,
    outdatedAtMs: 0, updatedAtMs: NOW - 3600_000, numbersVolatile: false, detectStalledAtMs: 0, manualKeptCount: 0,
    quotaSkippedCount: 0, gsheetExcludedTitles: [], blockedPendingDeletes: 0, originalFile: null, summary: [], summaryAt: 0, ...o,
  })
  const fakeChunk = o => ({ id: 'c', title: '', content: '內容', tags: [], questions: [], status: 'indexed', isOverview: false, manuallyEditedAtMs: 0, updatedAtMs: NOW - 86400_000, activeUntilMs: 0, expiredAtMs: 0, ...o })
  /** 資料頁：清單整份換成 list、明細照 id 回 details[id]（那一份的條目）；delayMs[id] 讓那一份的明細晚一點回來 */
  const fakeSourcesPage = (list, details, delayMs = {}) => async (req) => {
    const url = req.url()
    if (req.method() !== 'GET') return undefined
    if (url.includes('/api/ai/sources/list')) return json({ items: list, orphanCount: 0 })
    const m = url.match(/\/api\/ai\/sources\/([^/?]+)\?/)
    const id = m ? decodeURIComponent(m[1]) : ''
    if (id && details[id]) {
      if (delayMs[id]) await sleep(delayMs[id])
      return json({ source: list.find(s => s.id === id), chunks: details[id] })
    }
    return undefined
  }
  const SOURCES_PAGE = { path: '/knowledge/sources', waitSel: '[data-tour="kb-sources"]' }
  const pickSource = async (pg, name) => {
    await waitFor(pg, n => [...document.querySelectorAll('.split-list *')].some(el => el.children.length === 0 && el.textContent?.trim() === n), name)
    await pg.evaluate((n) => { [...document.querySelectorAll('.split-list *')].find(e => e.children.length === 0 && e.textContent?.trim() === n)?.click() }, name)
  }
  const toastsOf = pg => pg.$$eval('.toast', els => els.map(e => e.innerText))
  /**
   * 同一頁換網址（深連結那幾關）。⚠️ dev server 在別的檔案存檔時會整頁重載，正好撞上就是「frame was detached」——
   * 那不是畫面的錯，重來一次；第二次還失敗才算
   */
  const gotoAgain = async (pg, url) => {
    try { await pg.goto(url, { waitUntil: 'networkidle2', timeout: 180_000 }) }
    catch { await sleep(2000); await pg.goto(url, { waitUntil: 'networkidle2', timeout: 180_000 }) }
  }
  const PUT_OK = { status: 200, contentType: 'text/plain', body: '', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' } }
  const errorJson = (status, statusMessage) => ({ status, contentType: 'application/json', body: JSON.stringify({ statusCode: status, statusMessage, message: statusMessage }) })
  /** 資料頁上點那一份 → 按「換新版」→ 選檔 */
  const newVersionOf = async (pg, name, file) => {
    await pickSource(pg, name)
    await waitFor(pg, () => [...document.querySelectorAll('.admin-header-actions .el-button')].some(b => b.innerText.includes('上傳新版')), null, 15_000)
    const [chooser] = await Promise.all([
      pg.waitForFileChooser({ timeout: 5000 }).catch(() => null),
      pg.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button')].find(b => b.innerText.includes('上傳新版'))?.click()),
    ])
    if (!chooser) throw new Error('按「上傳新版」沒有開選檔視窗')
    await chooser.accept([file])
  }

  // ── 第三十段（`C-308`⑫④、`D-125`②）：手機 390 寬、試算表網址很長 → 畫面不撐破；
  //    「什麼時候補」照這一份的同步頻率講（設成不自動同步＝按立即同步才補）；在後台刪掉的列講出來、收得回來 ──
  if (CHECK_FROM <= 30) {
    const LONG_URL = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcdefghijklmnopqrst/edit?usp=sharing&ouid=123456789012345678901&rtpof=true&sd=true#gid=1234567890'
    const sheet = fakeSource({ id: 'fake-sheet-long', name: '常見問答（試算表）', url: LONG_URL, refreshIntervalMinutes: 0, quotaSkippedCount: 3,
      gsheetExcludedTitles: ['W1 保固多久', 'KIESLECT 小耳記怎麼充電', '出貨要幾天', '可以刷卡嗎', '有門市嗎'] })
    const puts = []
    const pageFake = fakeSourcesPage([sheet], { 'fake-sheet-long': [fakeChunk({ id: 'c1', title: '退貨要怎麼辦' })] })
    const pg = await openImportDialog(async (req) => {
      if (req.url().includes('/api/ai/sources/fake-sheet-long') && req.method() === 'PUT') {
        puts.push(JSON.parse(req.postData() || '{}'))
        return json({})
      }
      return pageFake(req)
    }, { ...SOURCES_PAGE, width: 390, height: 844 })
    await pickSource(pg, sheet.name)
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length > 0, null, 30_000)
    await sleep(500)
    if (process.env.SHOT_DIR) await pg.screenshot({ path: join(process.env.SHOT_DIR, 'kb-phone-long-sheet-url.png'), fullPage: true })
    // 右緣超出螢幕的元素一個都不准有（以前網址把表頭撐到 640px：整頁左右滑、名稱框被切掉）
    const lay = await pg.evaluate(() => {
      const vw = window.innerWidth
      const over = [...document.querySelectorAll('.split-editor *')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > vw + 1 })
        .map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}→${Math.round(el.getBoundingClientRect().right)}`)
      const name = document.querySelector('.src-header-main .el-input')?.getBoundingClientRect()
      const link = document.querySelector('.src-header-caption a')?.getBoundingClientRect()
      return { over: over.slice(0, 6), overCount: over.length, hscroll: document.documentElement.scrollWidth > vw + 1, nameW: name ? Math.round(name.width) : -1, linkLines: link ? Math.round(link.height / 16) : 0, vw }
    })
    if (!lay.overCount && !lay.hscroll && lay.nameW >= 250 && lay.linkLines >= 2) pass(`手機 390 寬、試算表網址很長 → 沒有任何東西超出螢幕、不能左右滑，網址斷成 ${lay.linkLines} 行、名稱框 ${lay.nameW}px`)
    else fail('手機上長網址把畫面撐破了', JSON.stringify(lay))

    const t = await pg.evaluate(() => ({
      quota: [...document.querySelectorAll('.src-outdated-alert')].map(e => e.innerText).find(x => x.includes('還沒收進知識庫')) ?? '',
      // `C-314`：自動更新那一格只剩一行「自動更新：[▾]」，整頁不准有任何寫死的「每小時」
      editor: document.querySelector('.split-editor')?.innerText ?? '',
      row: document.querySelector('[data-tour="kb-sync-settings"]')?.innerText.replace(/\s+/g, '') ?? '',
      excluded: document.querySelector('.src-excluded__text')?.innerText ?? '',
    }))
    // `C-319`：按鈕叫「立即更新」，提到它的每一句跟著叫
    if (t.quota.includes('按「立即更新」就會補上') && !t.quota.includes('每小時') && !t.editor.includes('每小時') && t.row.startsWith('自動更新：') && t.row.includes('不自動更新')) pass('設成不自動更新的試算表 → 「沒收的列」講按「立即更新」才補，整頁不再寫死「每小時」；那一格是「自動更新：不自動更新」')
    else fail('同步頻率的講法不對', JSON.stringify({ ...t, editor: t.editor.slice(0, 200) }))
    if (t.excluded.includes('表格上有 5 列你在後台刪掉了，不會再收') && t.excluded.includes('「W1 保固多久」') && t.excluded.includes('等 5 列')) pass(`在後台刪掉的列講出來（太多只列前 3 個）：「${t.excluded}」`)
    else fail('沒講在後台刪掉、不再收的列', t.excluded)
    await pg.evaluate(() => [...document.querySelectorAll('.src-excluded .el-button')].find(b => b.innerText.includes('重新收這幾列'))?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('收回來')), null, 8000)
    const toasts = await toastsOf(pg)
    if (puts.length === 1 && puts[0].clearExcludedRows === true && toasts.some(x => x.includes('按「立即更新」就會把這幾列收回來'))) pass('按「重新收這幾列」→ 叫伺服器清掉名單（clearExcludedRows），講按「立即更新」就收回來')
    else fail('「重新收這幾列」不對', JSON.stringify({ puts, toasts }))
    await pg.close()
  }

  // ── 第三十一段（`C-308`⑤②⑩、`C-309`、`D-125`②）：表格一次少太多列 → 講「等你確認」不是「抓不到」；
  //    鎖頭點得開（手機也行）、照來源講改回去會怎樣；出錯講伺服器給的原因；刪除講對（回收桶、試算表那一列不再收）；文字沒有鎖頭 ──
  if (CHECK_FROM <= 31) {
    const held = fakeSource({ id: 'fake-held', name: '價目表（試算表）', status: 'failed', blockedPendingDeletes: 12, outdatedAtMs: NOW - 600_000,
      failureReason: '表格一次少了 12 列（現有 30 張卡）。為避免誤刪，自動同步已暫停套用；請到知識庫來源頁確認後手動同步。' })
    const lockSheet = fakeSource({ id: 'fake-lock', name: '保固說明（試算表）', manualKeptCount: 1 })
    const text = fakeSource({ id: 'fake-text', type: 'manual', name: '營業時間（文字）', chunkCount: 1, lastFetchedAtMs: 0 })
    let settingsCalls = 0
    const settingsBodies = []
    const pageFake = fakeSourcesPage([held, lockSheet, text], {
      'fake-held': [fakeChunk({ id: 'h1', title: 'W1 售價' })],
      'fake-lock': [fakeChunk({ id: 'lk1', title: 'W1 保固多久', manuallyEditedAtMs: NOW - 3 * 86400_000 })],
      'fake-text': [fakeChunk({ id: 'tx1', title: '營業時間', manuallyEditedAtMs: NOW - 86400_000 })],
    })
    const pg = await openImportDialog(async (req) => {
      if (req.url().includes('/api/ai/knowledge/lk1/settings') && req.method() === 'POST') {
        settingsBodies.push(JSON.parse(req.postData() || '{}'))
        // 第一次：伺服器拒絕、原因在 data.statusMessage（HTTP 那一行是英文 Forbidden）
        if (++settingsCalls === 1) return errorJson(403, '這張卡在回收桶裡，請先還原再操作')
        return json({ id: 'lk1', appliesOn: 'next_sync' })
      }
      // 什麼都沒改就按儲存：伺服器回 changed:false（沒寫、沒上鎖，`C-308`①）
      // ⚠️ PUT 的 workspaceId 放在 body、網址後面沒有 ?（只有 GET／DELETE 才接在網址上）
      if (new URL(req.url()).pathname === '/api/ai/knowledge/lk1' && req.method() === 'PUT') return json({ id: 'lk1', changed: false })
      // 立即同步途中這份被刪掉了（`C-308`③）
      if (req.url().includes('/api/ai/sources/fake-lock/gsheet-sync') && req.method() === 'POST') return json({ outcome: 'source_deleted', added: 0, updated: 0, deleted: 0, kept: 0 })
      return pageFake(req)
    }, SOURCES_PAGE)

    await pickSource(pg, held.name)
    await waitFor(pg, () => !!document.querySelector('.src-fix'), null, 30_000)
    const fix = await pg.evaluate(() => ({
      title: document.querySelector('.src-fix__title')?.innerText ?? '',
      text: document.querySelector('.src-fix')?.innerText ?? '',
      email: !!document.querySelector('.src-fix__email'),
      outdated: [...document.querySelectorAll('.src-outdated-alert')].some(e => e.innerText.includes('網頁內容變動')),
    }))
    if (fix.title.includes('表格一次少了 12 列') && fix.text.includes('立即更新') && fix.text.includes('補回去') && !fix.text.includes('抓不到內容') && !fix.email && !fix.outdated) {
      pass(`表格一次少太多列被擋下 → 「${fix.title.trim()}」、講按「立即更新」確認或把列補回去（不叫人去分享、不講網頁變動）`)
    }
    else fail('擋下大量刪除時還在講「抓不到內容／去分享」', JSON.stringify(fix))

    await pickSource(pg, lockSheet.name)
    await waitFor(pg, () => !!document.querySelector('.src-chunk-lock'), null, 30_000)
    await pg.evaluate(() => document.querySelector('.src-chunk-lock')?.click())
    const popShown = await waitFor(pg, () => { const p = document.querySelector('.src-lock-pop'); return !!p && getComputedStyle(p).display !== 'none' && p.innerText.includes('表格更新時不會蓋掉') }, null, 5000)
    const popText = await pg.$eval('.src-lock-pop', el => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => '')
    // `C-314`：一句＋一顆按鈕（以前三句：改過的時間、用哪一版、改回去之後什麼時候換——什麼時候換按了之後的提示會講）
    if (popShown && popText === '你改過這一條，表格更新時不會蓋掉。 改回跟著表格') pass(`鎖頭點一下就跳出一句＋一顆按鈕（手機點得到，不再只靠滑鼠停留）：「${popText}」`)
    else fail('鎖頭點開不是「一句＋一顆按鈕」', popText)
    const clickUnlock = () => pg.evaluate(() => [...document.querySelectorAll('.src-lock-pop .el-button')].find(b => b.innerText.includes('改回跟著表格'))?.click())
    await clickUnlock()
    await waitFor(pg, () => document.querySelectorAll('.toast').length > 0, null, 8000)
    const errToasts = await toastsOf(pg)
    if (errToasts.some(x => x.includes('這張卡在回收桶裡')) && !errToasts.some(x => x.includes('解除失敗') || x.includes('Forbidden'))) pass('伺服器拒絕時講它給的中文原因（不再只說「解除失敗」、不講英文 Forbidden）')
    else fail('出錯時沒講伺服器給的原因', errToasts.join('｜'))
    await sleep(3800)
    if (!(await pg.$('.src-lock-pop'))?.evaluate(el => getComputedStyle(el).display !== 'none')) await pg.evaluate(() => document.querySelector('.src-chunk-lock')?.click())
    await sleep(300)
    await clickUnlock()
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('已改回')), null, 8000)
    const okToasts = await toastsOf(pg)
    if (settingsBodies.at(-1)?.clearManualLock === true && okToasts.some(x => x.includes('已改回跟著表格：下一次自動更新就會換成表格上的內容'))) pass('改回跟著表格 → 照伺服器回的生效時間講（下一次自動更新就換成表格的）')
    else fail('改回跟著表格的提示不對', JSON.stringify({ settingsBodies, okToasts }))

    await pg.evaluate(() => [...document.querySelectorAll('.src-chunk-row .el-button')].find(b => b.innerText.includes('編輯'))?.click())
    await waitFor(pg, () => !!document.querySelector('.chunk-sync-note'), null, 8000)
    const note = await pg.$eval('.chunk-sync-note', el => el.innerText.replace(/\s+/g, ' ')).catch(() => '')
    if (note.includes('這一條用你改過的版本，不跟著表格') && note.includes('改回跟著表格')) pass(`編輯框講它被鎖住、給改回去的路：「${note.trim()}」`)
    else fail('編輯框沒講鎖住', note)
    await pg.evaluate(() => [...document.querySelectorAll('.chunk-footer .el-button')].find(b => b.innerText.trim() === '刪除')?.click())
    await waitFor(pg, () => !!document.querySelector('.el-message-box'), null, 5000)
    const confirmText = await pg.$eval('.el-message-box', el => el.innerText.replace(/\s+/g, ' ')).catch(() => '')
    await pg.evaluate(() => [...document.querySelectorAll('.el-message-box .el-button')].find(b => b.innerText.includes('取消'))?.click())
    await sleep(500)
    if (confirmText.includes('之後同步不會再收') && confirmText.includes('回收桶') && !confirmText.includes('無法復原')) pass('刪除試算表來的一條 → 先講那一列之後不會再收、會進回收桶 30 天（不再說「無法復原」）')
    else fail('刪除的確認框說法不對', confirmText)
    // 什麼都沒改、按「儲存」→ 安靜關掉：不跳「已儲存」（跳了他會以為有東西被改了、被鎖了）
    await sleep(3800) // 前面的提示先消失
    await pg.evaluate(() => [...document.querySelectorAll('.chunk-footer .el-button--primary')].find(b => b.innerText.trim() === '儲存')?.click())
    const closed = await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.chunk-form')), null, 8000)
    await sleep(800)
    const saveToasts = await toastsOf(pg)
    if (closed && !saveToasts.some(x => x.includes('已儲存'))) pass('什麼都沒改就按「儲存」→ 視窗關掉、不跳「已儲存」（伺服器回 changed:false＝沒上鎖）')
    else fail('沒改東西也說已儲存', JSON.stringify({ closed, saveToasts }))
    if (!closed) await pg.evaluate(() => [...document.querySelectorAll('.chunk-footer .el-button')].find(b => b.innerText.trim() === '取消')?.click())

    // 立即更新途中這份被刪掉了 → 不講「更新完成：新增…」，回到清單
    await pg.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button')].find(b => b.innerText.includes('立即更新'))?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('被刪掉了')), null, 10_000)
    const syncToasts = await toastsOf(pg)
    const backHome = await pg.evaluate(() => !document.querySelector('.src-header-main input'))
    if (syncToasts.some(x => x.includes('更新途中被刪掉了')) && !syncToasts.some(x => x.includes('完成：新增')) && backHome) pass('立即更新時那一份被刪掉了 → 講「更新途中被刪掉了」、回到清單（不講「更新完成：新增 0…」）')
    else fail('同步途中被刪掉時的說法不對', JSON.stringify({ syncToasts, backHome }))

    await pickSource(pg, text.name)
    await waitFor(pg, () => [...document.querySelectorAll('.src-chunk-title')].some(e => e.innerText.includes('營業時間')), null, 30_000)
    const manual = await pg.evaluate(() => ({
      lock: !!document.querySelector('.src-chunk-lock'),
      // `C-314`：「基本資訊」卡拿掉了，類型／條數／更新時間是名稱下面那一行
      meta: document.querySelector('.src-header-meta')?.innerText.trim() ?? '',
    }))
    if (!manual.lock && manual.meta === '一段文字・1 條・1 小時前更新' && !manual.meta.includes('同步')) pass(`一段文字不會同步 → 沒有鎖頭、名稱下面那一行講「更新」不講「同步」（${manual.meta}）`)
    else fail('一段文字還有鎖頭或寫「同步」', JSON.stringify(manual))
    await pg.close()
  }

  // ── 第三十二段（`C-308`、`C-309`）：「要處理的事」講試算表還有幾列沒收、一份就直接帶過去；
  //    選資料的那一刻同步頻率就是對的（不先閃「不自動同步」）；搜尋結果標「等你看過」；?health= 只有一份時直接帶過去 ──
  if (CHECK_FROM <= 32) {
    const hourly = fakeSource({ id: 'fake-hourly', name: '新品清單（試算表）', refreshIntervalMinutes: 60, quotaSkippedCount: 4 })
    const other = fakeSource({ id: 'fake-other', type: 'url', name: '官網常見問題', url: 'https://shop.example.tw/faq', refreshIntervalMinutes: 1440 })
    const pageFake = fakeSourcesPage([hourly, other], { 'fake-hourly': [fakeChunk({ id: 'n1', title: 'W2 上市日期' })], 'fake-other': [fakeChunk({ id: 'o1', title: '運費' })] }, { 'fake-hourly': 3000 })
    const pg = await openImportDialog(async (req) => {
      if (req.url().includes('/api/ai/knowledge/search') && req.method() === 'GET') {
        return json({ items: [{ id: 'd1', sourceId: null, title: '草稿那一條', snippet: '等你看過的內容', status: 'draft' }], truncated: false, countTruncated: false })
      }
      // 舊對話「去修這條」帶過來的那一條已經在回收桶（換新版換掉了）
      if (req.url().includes('/api/ai/knowledge/gone-1?') && req.method() === 'GET') return json({ id: 'gone-1', sourceId: 'fake-other', deleted: true })
      return pageFake(req)
    }, SOURCES_PAGE)
    await waitFor(pg, () => [...document.querySelectorAll('.src-todo__item')].some(e => e.innerText.includes('列因為 AI 知識量滿了還沒收')), null, 30_000)
    const item = await pg.$$eval('.src-todo__item', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('還沒收')) ?? '')
    if (item.includes('1 份試算表有 4 列因為 AI 知識量滿了還沒收')) pass(`「要處理的事」講試算表還有幾列沒收：「${item.slice(0, 40)}…」`)
    else fail('「要處理的事」沒講試算表沒收的列', item)
    await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('還沒收'))?.querySelector('.el-button')?.click())
    // 明細故意晚 3 秒回來：這段時間看到的同步頻率要已經是對的
    await waitFor(pg, () => !!document.querySelector('[data-tour="kb-sync-settings"] .el-select'), null, 10_000)
    await sleep(600)
    const during = await pg.evaluate(() => ({
      loading: !!document.querySelector('.src-chunk-loading'),
      sel: document.querySelector('[data-tour="kb-sync-settings"] .el-select')?.innerText.trim() ?? '',
      name: document.querySelector('.src-header-main input')?.value ?? '',
    }))
    if (during.name === '新品清單（試算表）' && during.loading && during.sel === '每小時') pass('點「查看」→ 直接打開那一份；明細還在讀的時候同步頻率就顯示「每小時」（不先閃「不自動同步」）')
    else fail('選資料那一刻同步頻率不對、或沒帶到那一份', JSON.stringify(during))

    await pg.click('.src-search input')
    await pg.type('.src-search input', '草稿')
    await waitFor(pg, () => !!document.querySelector('.src-search-row'), null, 8000)
    const badge = await pg.$eval('.src-search-row', el => el.innerText).catch(() => '')
    if (badge.includes('等你看過')) pass('搜尋找到還在「等你看過」的 → 標出來（不讓人以為 AI 已經會答）')
    else fail('搜尋結果沒標「等你看過」', badge)

    await gotoAgain(pg, `${BASE}/admin/${WORKSPACE_ID}/knowledge/sources?health=quotaSkippedSheets`)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === '新品清單（試算表）', null, 30_000)
    const deep = await pg.evaluate(() => ({
      name: document.querySelector('.src-header-main input')?.value ?? '',
      listDialog: [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.innerText.includes('試算表還有列沒收')),
    }))
    if (deep.name === '新品清單（試算表）' && !deep.listDialog) pass('從提醒帶 ?health= 進來、只有一份 → 直接打開那一份（不再先跳一張只有一列的清單）')
    else fail('?health= 只有一份時還是開清單', JSON.stringify(deep))

    await gotoAgain(pg, `${BASE}/admin/${WORKSPACE_ID}/knowledge/sources?chunkId=gone-1`)
    const goneToast = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('在回收桶裡')), null, 30_000)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === '官網常見問題', null, 10_000)
    const goneName = await pg.$eval('.src-header-main input', el => el.value).catch(() => '')
    if (goneToast && goneName === '官網常見問題') pass('舊對話「去修這條」、那一條已經換掉 → 講「在回收桶裡」，照樣打開它所在的那一份（以前點了什麼都沒發生）')
    else fail('點到回收桶裡的那一條沒交代', JSON.stringify({ goneToast, goneName }))
    await pg.close()
  }

  // ── 第三十三段（`C-308`⑪）：網址重新同步——差異畫面講剩多少空間、放不下的先不加；套用完講幾條沒加 ──
  if (CHECK_FROM <= 33) {
    const urlSrc = fakeSource({ id: 'fake-url', type: 'url', name: '官網運費說明', url: 'https://shop.example.tw/pages/shipping', refreshIntervalMinutes: 1440 })
    const pageFake = fakeSourcesPage([urlSrc], { 'fake-url': [fakeChunk({ id: 'u1', title: '運費' })] })
    const newEntry = (id, title) => ({ id, kind: 'new', defaultAction: 'add_new', newChunk: { title, content: `${title}的說明`, tags: [] } })
    const entries = [newEntry('e1', '離島運費'), newEntry('e2', '超商取貨'), newEntry('e3', '貨到付款'),
      { id: 'e4', kind: 'unchanged', defaultAction: 'keep_old', oldChunk: { id: 'u1', title: '運費', content: '內容', tags: [], manuallyEdited: false }, newChunk: { title: '運費', content: '內容', tags: [] } }]
    const applies = []
    const pg = await openImportDialog(async (req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 49, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/sources/fake-url/resync-jobs') && m === 'POST') return json({ jobId: 'job-resync-q', status: 'processing' })
      if (url.includes('/api/ai/knowledge/preview-jobs/job-resync-q') && m === 'GET') {
        return json({ status: 'done', sourceName: urlSrc.name, sourceUrl: urlSrc.url, rawLength: 900, truncated: false,
          resync: { sourceId: 'fake-url', contentHash: 'h2', diff: { entries, summary: { added: 3, modified: 0, removed: 0, unchanged: 1 } }, shrink: null, warnings: [] } })
      }
      if (url.includes('/api/ai/sources/fake-url/resync-apply') && m === 'POST') {
        applies.push(JSON.parse(req.postData() || '{}'))
        return json({ added: 1, updated: 0, deleted: 0, kept: 1, errors: [], quotaSkipped: 2 })
      }
      return pageFake(req)
    }, SOURCES_PAGE)
    await pickSource(pg, urlSrc.name)
    await waitFor(pg, () => !!document.querySelector('[data-tour="kb-resync"]'), null, 15_000)
    await pg.evaluate(() => document.querySelector('[data-tour="kb-resync"]')?.click())
    await waitFor(pg, () => document.querySelector('.diff-body .kb-quota-line')?.innerText.includes('AI 知識量'), null, 30_000)
    if (process.env.SHOT_DIR) await (await pg.$('.el-dialog:not([style*="display: none"]) .diff-body'))?.screenshot({ path: join(process.env.SHOT_DIR, 'kb-resync-quota.png') }).catch(() => {})
    const line = await pg.$eval('.diff-body .kb-quota-line', el => el.innerText).catch(() => '')
    if (line.includes('AI 知識量只剩 1 條') && line.includes('勾了新增的 3 條裡，2 條這次放不下')) pass(`差異畫面講剩多少空間、哪幾條放不下：「${line.trim().slice(0, 50)}…」`)
    else fail('差異畫面沒講空間', line)
    await pg.evaluate(() => [...document.querySelectorAll('.el-dialog__footer .el-button--primary')].find(b => b.innerText.includes('套用選取的變更'))?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('已套用')), null, 15_000)
    const toasts = await toastsOf(pg)
    if (applies.length === 1 && toasts.some(x => x.includes('還有 2 條新增因為 AI 知識量滿了沒加'))) pass('套用完講還有 2 條因為空間滿了沒加（不是整批失敗、也不是沉默少收）')
    else fail('套用完沒講沒加的條數', JSON.stringify({ applies: applies.length, toasts }))
    await pg.close()
  }

  // ── 第三十四段（`D-125`① 拍板 A）：換新版、舊的那一份有他改過的 → 停下來問帶不帶（預設全帶），
  //    每一條講新版有沒有同名的；不帶的照新版；送出去帶 keepEditedChunkIds、新版同名的不送；結果頁講帶了幾條 ──
  const editedFile = fakeSource({ id: 'fake-file-edit', type: 'file', name: '保固與退貨說明.docx', chunkCount: 5, refreshIntervalMinutes: 0 })
  const editedChunks = [
    fakeChunk({ id: 'k-a', title: '保固多久', manuallyEditedAtMs: NOW - 86400_000 }),
    fakeChunk({ id: 'k-b', title: '怎麼退貨', manuallyEditedAtMs: NOW - 86400_000 }),
    fakeChunk({ id: 'k-ov', title: '我們有賣什麼', isOverview: true, manuallyEditedAtMs: NOW - 86400_000 }),
    fakeChunk({ id: 'k-c', title: '運費' }),
    fakeChunk({ id: 'k-d', title: '保養' }),
  ]
  /** 換新版那幾段共用：上傳回假的、整理工作回 doneChunks、加入那一下記下來 */
  const replaceFlowFake = ({ jobId, doneChunks, quota, existingMatches = [], isDone = () => true, bulks }) => {
    const pageFake = fakeSourcesPage([editedFile], { 'fake-file-edit': editedChunks })
    return async (req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return PUT_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') return json({ jobId, status: 'processing', phase: 'chunk' })
      if (url.includes(`/api/ai/knowledge/preview-jobs/${jobId}`) && m === 'GET') {
        if (!isDone()) return json({ status: 'processing', phase: 'chunk' })
        return json({ status: 'done', sourceName: editedFile.name, sourceUrl: '', sourceType: 'file', truncated: false, ocrUsed: false, meta: {}, warnings: [], contentHash: 'h', suggestedProductName: '',
          existingMatches, chunks: doneChunks.map(t => ({ title: t, content: `${t}的內容`, tags: [], questions: [] })) })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        const kept = (b.source?.keepEditedChunkIds ?? []).length
        return json({ sourceId: b.replaceSourceId ?? 'x', total: b.chunks.length, indexed: b.chunks.length, failed: 0, replacedChunks: 5 - kept - 1, keptEdited: kept, skippedForKept: 0, originalKept: true,
          items: b.chunks.map((c, i) => ({ id: `n${i}`, title: c.title, status: 'indexed' })) })
      }
      return pageFake(req)
    }
  }
  const keepRows = pg => pg.$$eval('.kb-keep-edited__row', els => els.map(e => ({
    title: e.querySelector('.kb-keep-edited__title')?.innerText ?? '',
    suffix: e.querySelector('.kb-keep-edited__suffix')?.innerText ?? '',
    checked: e.classList.contains('is-checked'),
  })))
  const uncheck = (pg, title) => pg.evaluate(t => [...document.querySelectorAll('.kb-keep-edited__row')].find(e => e.querySelector('.kb-keep-edited__title')?.innerText === t)?.click(), title)

  if (CHECK_FROM <= 34) {
    const bulks = []
    const pg = await openImportDialog(replaceFlowFake({ jobId: 'job-keep', doneChunks: ['保固 多久', '新功能', '運費'], quota: { used: 0, limit: 50, planName: '免費' }, bulks }), SOURCES_PAGE)
    await newVersionOf(pg, editedFile.name, pathOf.docx)
    const stopped = await waitFor(pg, () => !!document.querySelector('.kb-keep-edited__row'), null, 30_000)
    await sleep(500)
    if (process.env.SHOT_DIR) await (await pg.$('.kb-import-dialog'))?.screenshot({ path: join(process.env.SHOT_DIR, 'kb-keep-edited.png') }).catch(() => {})
    const s = await pg.evaluate(() => ({
      stoppedLine: document.querySelector('.kb-preview-stopped')?.innerText ?? '',
      head: document.querySelector('.kb-keep-edited__head')?.innerText ?? '',
      btn: document.querySelector('.kb-preview-summary__actions .el-button--primary')?.innerText.trim() ?? '',
    }))
    const rows1 = await keepRows(pg)
    const a = rows1.find(r => r.title === '保固多久')
    const b = rows1.find(r => r.title === '怎麼退貨')
    if (stopped && !bulks.length && s.stoppedLine.includes('還沒加進去') && s.head === '你改過的 2 條，要帶到新版嗎？' && rows1.length === 2 && a?.checked && b?.checked
      && a.suffix === '新版也有這一條，會用你改過的' && b.suffix === '新版沒有這一條，會原樣留著' && s.btn === '更新原本那一份（2 條）') {
      pass('換新版、舊的有他改過的 2 條（總表不算）→ 停下來問、預設全帶，每條講新版有沒有同名；按鈕扣掉同名的那一條（2 條）')
    }
    else fail('換新版時沒問改過的那幾條', JSON.stringify({ stopped, bulks: bulks.length, ...s, rows1 }))
    await uncheck(pg, '怎麼退貨')
    await sleep(300)
    const rows2 = await keepRows(pg)
    const notice = await pg.$$eval('.kb-dedup-warning', els => els.map(e => e.innerText).join(' ')).catch(() => '')
    if (rows2.find(r => r.title === '怎麼退貨')?.suffix === '移到回收桶' && notice.includes('原本的 4 條知識會移到回收桶')) pass('不勾「怎麼退貨」→ 那一條講「移到回收桶」，上面的回收桶條數跟著變（5−1＝4）')
    else fail('取消勾選後說法沒跟著變', JSON.stringify({ rows2, notice: notice.slice(0, 120) }))
    await pg.evaluate(() => document.querySelector('.kb-preview-summary__actions .el-button--primary')?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-result-saved'), null, 20_000)
    const body = bulks[0]
    const resultText = await pg.$eval('.el-dialog__body', el => el.innerText.replace(/\s+/g, ' ')).catch(() => '')
    if (bulks.length === 1 && body.replaceSourceId === 'fake-file-edit' && JSON.stringify(body.source?.keepEditedChunkIds) === '["k-a"]'
      && body.chunks.map(c => c.title).join('、') === '新功能、運費' && resultText.includes('你改過的 1 條帶到新版了')) {
      pass('按「更新原本那一份」→ 帶 keepEditedChunkIds＝[保固多久]、新版裡同名的「保固 多久」不送；結果頁講「你改過的 1 條帶到新版了」')
    }
    else fail('帶過去的那幾條沒送對', JSON.stringify({ bulks: bulks.length, replace: body?.replaceSourceId, keep: body?.source?.keepEditedChunkIds, titles: body?.chunks?.map(c => c.title), result: resultText.slice(0, 200) }))
    await pg.close()
  }

  // ── 第三十五段（`D-125`①）：帶過去的那幾條照樣佔空間、新版同名的不用位置 → 「先收前 N 條」算得對 ──
  if (CHECK_FROM <= 35) {
    const bulks = []
    const pg = await openImportDialog(replaceFlowFake({
      jobId: 'job-keep-math',
      doneChunks: ['保固 多久', 'A 款規格', 'B 款規格', 'C 款規格', 'D 款規格', 'E 款規格', 'F 款規格'],
      quota: { used: 48, limit: 50, planName: '免費' },
      existingMatches: [{ id: 'fake-file-edit', name: editedFile.name, chunkCount: 5, quotaChunkCount: 5, updatedAtMs: 0, type: 'file' }],
      bulks,
    }), SOURCES_PAGE)
    await newVersionOf(pg, editedFile.name, pathOf.docx)
    await waitFor(pg, () => !!document.querySelector('.kb-keep-edited__row'), null, 30_000)
    await sleep(400)
    const read = () => pg.evaluate(() => ({
      btn: document.querySelector('.kb-preview-summary__actions .el-button--primary')?.innerText.trim() ?? '',
      warn: [...document.querySelectorAll('.kb-preview-summary__warn')].map(e => e.innerText).join(' '),
    }))
    // 剩 2 條空間；換掉的那一份佔 5 條、帶過去 2 條還佔著 → 空出 3 → 能放 5；新版 7 條、1 條跟帶過去的同名 → 要放 6 → 先收前 5、其餘 1
    const m1 = await read()
    await uncheck(pg, '保固多久')
    await sleep(300)
    // 不帶「保固多久」→ 帶過去 1 條 → 空出 4 → 能放 6；同名那條要收了 → 要放 7 → 先收前 6、其餘 1
    const m2 = await read()
    if (m1.btn === '更新原本那一份（先收前 5 條）' && m1.warn.includes('其餘 1 條先不收') && m2.btn === '更新原本那一份（先收前 6 條）' && m2.warn.includes('其餘 1 條先不收') && !bulks.length) {
      pass('空間：帶過去的照樣佔位、新版同名的不用位置 → 先收前 5 條；改成不帶那一條 → 先收前 6 條（數字跟著勾選走）')
    }
    else fail('帶過去的那幾條沒算進空間', JSON.stringify({ m1, m2, bulks: bulks.length }))
    await pg.close()
  }

  // ── 第三十六段（`D-125`①）：一次好幾份裡「更新原本那一份」→ 舊的那一份他改過的一律帶過去（不停下來問），那一列講帶了幾條 ──
  if (CHECK_FROM <= 36) {
    const names = {}
    let seq = 0
    const bulks = []
    const pg = await openImportDialog((req) => {
      const url = req.url()
      const m = req.method()
      if (url.includes('/api/ai/knowledge/quota')) return json({ quota: { used: 0, limit: 50, planName: '免費' } })
      if (url.includes('/api/ai/knowledge/upload-url') && m === 'POST') return json({ uploadId: 'u', storagePath: `preview-uploads/${WORKSPACE_ID}/x`, uploadUrl: 'https://storage.googleapis.com/fake-bucket/x?sig=fake' })
      if (url.startsWith('https://storage.googleapis.com/fake-bucket/')) return PUT_OK
      if (url.endsWith('/api/ai/knowledge/preview-jobs') && m === 'POST') {
        const id = `job-bkeep-${++seq}`
        names[id] = JSON.parse(req.postData() || '{}').fileName
        return json({ jobId: id, status: 'processing', phase: 'chunk' })
      }
      const pj = url.match(/\/api\/ai\/knowledge\/preview-jobs\/(job-bkeep-\d+)/)
      if (pj && m === 'GET') {
        const name = names[pj[1]]
        const docx = name === '退換貨政策.docx'
        return json({ status: 'done', sourceName: name, warnings: [], contentHash: 'h',
          existingMatches: docx ? [{ id: 'old-src-9', name, chunkCount: 3, quotaChunkCount: 3, updatedAtMs: 0, type: 'file' }] : [],
          chunks: (docx ? ['七天 鑑賞期', '運費'] : ['W1 價格']).map(t => ({ title: t, content: '內容', tags: [], questions: [] })) })
      }
      if (url.includes('/api/ai/sources/old-src-9') && m === 'GET') {
        return json({ source: {}, chunks: [fakeChunk({ id: 'e1', title: '七天鑑賞期', manuallyEditedAtMs: NOW - 86400_000 }), fakeChunk({ id: 'e2', title: '舊的一條' })] })
      }
      if (url.includes('/api/ai/knowledge/bulk-create') && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        bulks.push(b)
        const kept = (b.source?.keepEditedChunkIds ?? []).length
        return json({ sourceId: b.replaceSourceId ?? 'new', total: b.chunks.length, indexed: b.chunks.length, failed: 0, originalKept: true, items: [],
          ...(b.replaceSourceId ? { replacedChunks: 3 - kept, keptEdited: kept } : {}) })
      }
      return undefined
    })
    await (await pg.$('.kb-file-input')).uploadFile(pathOf.docx, pathOf.csv)
    await waitFor(pg, () => document.querySelectorAll('.kb-site-row').length === 2)
    await pg.evaluate(() => document.querySelector('.kb-import-actions .el-button--primary')?.click())
    await waitFor(pg, () => !!document.querySelector('.kb-file-batch__conflict'), null, 60_000)
    // `C-319`：按鈕「更新原本那一份」（以前「換掉舊的」），那一列講「已更新原本那一份」。
    // ⚠️ 等那顆按得下去才按：另一份還在整理時它是鎖著的（「這一批跑完就能選」）——以前同名那一列一出現就按，
    //    另一份慢一點就按到鎖著的那顆、什麼都沒發生（這一段「偶爾失敗」的原因，2026-10-15 查到）
    await waitFor(pg, () => [...document.querySelectorAll('.kb-file-batch__conflict .el-button')].some(b => b.innerText.includes('更新原本那一份') && !b.disabled && !b.classList.contains('is-disabled')), null, 60_000)
    await pg.evaluate(() => [...document.querySelectorAll('.kb-file-batch__conflict .el-button')].find(b => b.innerText.includes('更新原本那一份'))?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.kb-site-row')].some(r => r.innerText.includes('退換貨政策.docx') && r.innerText.includes('✓')), null, 15_000)
    const replaced = bulks.find(b => b.replaceSourceId === 'old-src-9')
    const row = await pg.$$eval('.kb-site-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('退換貨政策.docx')) ?? '')
    if (JSON.stringify(replaced?.source?.keepEditedChunkIds) === '["e1"]' && replaced?.chunks.map(c => c.title).join('、') === '運費' && row.includes('已更新原本那一份') && row.includes('舊的 2 條移到回收桶') && row.includes('你改過的 1 條帶到新版了')) {
      pass(`一次好幾份「更新原本那一份」→ 他改過的一律帶過去、新版同名的不送，那一列講：「${row.slice(row.indexOf('已更新'), row.indexOf('已更新') + 60)}…」`)
    }
    else fail('一次好幾份更新原本那一份沒帶改過的', JSON.stringify({ keep: replaced?.source?.keepEditedChunkIds, titles: replaced?.chunks?.map(c => c.title), row }))
    await pg.close()
  }

  // ── 第三十七段（`D-125`①）：換新版整理到一半離開頁面、回來接著做 → 一樣停下來問改過的那幾條（⛔ 不自動加進去、不丟掉他改的）──
  if (CHECK_FROM <= 37) {
    let jobDone = false
    let posted = 0
    const bulks = []
    const flow = replaceFlowFake({ jobId: 'job-keep-resume', doneChunks: ['保固 多久', '新功能'], quota: { used: 0, limit: 50, planName: '免費' }, isDone: () => jobDone, bulks })
    const pg = await openImportDialog(async (req) => {
      if (req.url().endsWith('/api/ai/knowledge/preview-jobs') && req.method() === 'POST') posted++
      return flow(req)
    }, SOURCES_PAGE)
    await newVersionOf(pg, editedFile.name, pathOf.docx)
    for (let i = 0; i < 60 && !posted; i++) await sleep(250)
    await sleep(800) // 記號在建好工作那一下落地
    jobDone = true
    await pg.reload({ waitUntil: 'networkidle2', timeout: 180_000 })
    const ready = await waitFor(pg, () => document.querySelector('.src-import-link')?.innerText.includes('整理好了，等你看一下'), null, 30_000)
    await sleep(1500)
    const noAuto = bulks.length === 0
    await pg.evaluate(() => document.querySelector('.src-import-link')?.click())
    const asked = await waitFor(pg, () => document.querySelector('.kb-keep-edited__head')?.innerText.includes('你改過的 2 條'), null, 10_000)
    if (ready && noAuto && asked) pass('換新版離開頁面、回來接著做 → 一樣停下來問改過的那幾條（側欄「整理好了，等你看一下」、沒有自己加進去）')
    else fail('接回換新版時沒有停下來問改過的', JSON.stringify({ ready, bulks: bulks.length, asked }))
    await pg.close()
  }

  // ── 第三十八段（`C-312`）：回收桶找得到、翻得完——換新版擠下去的那一條搜得到、挑資料、「顯示更多」、
  //    翻到上限講「更早的還沒找」；還原照舊（空間滿講伺服器的原因）；手機 390 寬不撐破。
  //    回收桶、還原全部在瀏覽器裡回假的（正式庫不讀回收桶、不還原任何東西） ──
  if (CHECK_FROM <= 38) {
    const DAY_MS = 86400_000
    const binRow = (id, title, sourceId, sourceName, ageMs) => ({ id, title, snippet: `${title}的內容`, sourceId, sourceName, deletedAtMs: NOW - ageMs, purgeAfterMs: NOW - ageMs + 30 * DAY_MS })
    const binRows = [
      ...Array.from({ length: 150 }, (_, i) => binRow(`old-${i}`, `舊版第 ${i + 1} 條`, 'fake-manual', '說明書 W1', 600_000)),
      binRow('yesterday', 'W1 保固多久', 'fake-faq', '常見問答', DAY_MS),
      binRow('gone-1', '資料整份刪掉的一條', 'deleted-src', null, 2 * DAY_MS),
      binRow('gone-2', '資料整份刪掉的另一條', null, null, 3 * DAY_MS),
    ]
    const binCalls = []
    const restores = []
    const manual = fakeSource({ id: 'fake-manual', type: 'file', name: '說明書 W1', chunkCount: 150 })
    const pageFake = fakeSourcesPage([manual], { 'fake-manual': [fakeChunk({ id: 'n1', title: '新版第 1 條' })] })
    const pg = await openImportDialog(async (req) => {
      const url = new URL(req.url())
      const restore = url.pathname.match(/^\/api\/ai\/knowledge\/([^/]+)\/restore$/)
      if (restore && req.method() === 'POST') {
        restores.push(restore[1])
        if (restore[1] === 'old-0') return errorJson(403, 'AI 知識量滿了，先刪掉用不到的再還原')
        // 跟真的伺服器一樣：還原了就不在回收桶（之後重查的總數、清單都少這一條）
        binRows.splice(binRows.findIndex(r => r.id === restore[1]), 1)
        return json({ id: restore[1], status: 'indexed' })
      }
      if (url.pathname === '/api/ai/knowledge/recycle-bin' && req.method() === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        const source = url.searchParams.get('source') ?? ''
        const cursor = url.searchParams.get('cursor') ?? ''
        const withSources = url.searchParams.get('withSources') === '1'
        binCalls.push({ q, source, cursor, withSources })
        // 「很久以前」：最近 1000 條都沒有，伺服器翻到上限先停；接著找才找到
        if (q === '很久以前') {
          if (!cursor) return json({ items: [], truncated: true, nextCursor: 'cap-1', scanned: 1000, scanCapped: true, total: binRows.length })
          return json({ items: [binRow('ancient', '很久以前刪的', 'fake-faq', '常見問答', 25 * DAY_MS)], truncated: false, nextCursor: null, scanned: 40, scanCapped: false, total: null })
        }
        const hits = binRows.filter(r => (!q || r.title.includes(q) || r.snippet.includes(q))
          && (!source || (source === '__gone__' ? !r.sourceName : r.sourceId === source)))
        const start = cursor ? Number(cursor) : 0
        const next = start + 50 < hits.length ? String(start + 50) : null
        return json({
          items: hits.slice(start, start + 50), truncated: !!next, nextCursor: next, scanned: Math.min(50, hits.length - start), scanCapped: false,
          total: cursor ? null : binRows.length,
          ...(withSources ? { sources: [{ key: 'fake-manual', name: '說明書 W1', count: 150 }, { key: 'fake-faq', name: '常見問答', count: 1 }, { key: '__gone__', name: null, count: 2 }], sourcesTruncated: false } : {}),
        })
      }
      return pageFake(req)
    }, { ...SOURCES_PAGE, width: 390, height: 844 })

    const binState = () => pg.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__header')?.innerText.includes('回收桶'))
      if (!dlg) return null
      return {
        count: dlg.querySelector('.src-bin-count')?.innerText ?? '',
        titles: [...dlg.querySelectorAll('.src-bin-row__title')].map(e => e.innerText),
        metas: [...dlg.querySelectorAll('.src-bin-row__meta')].map(e => e.innerText),
        empty: dlg.querySelector('.src-bin-empty')?.innerText ?? '',
        more: dlg.querySelector('.src-bin-more .el-button')?.innerText ?? '',
        moreNote: dlg.querySelector('.src-bin-more__note')?.innerText ?? '',
      }
    })
    const binClickMore = () => pg.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__header')?.innerText.includes('回收桶'))
      dlg?.querySelector('.src-bin-more .el-button')?.click()
    })
    /**
     * ⚠️ 不用座標點、也不用 Backspace 清：手機寬時「已還原」的提示條浮在搜尋框上（點到提示條），
     *    還原後頁面重載資料時焦點會被拿走（Backspace 打到別處、字沒清掉）。清空走 value＋input 事件，打字照樣一個個打（驗等打完才送）
     */
    const binType = async (text) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await pg.$eval('.src-bin-tools__q input', (el) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '')
          el.dispatchEvent(new Event('input', { bubbles: true }))
        })
        if (text) await pg.type('.src-bin-tools__q input', text, { delay: 60 })
        if (await pg.$eval('.src-bin-tools__q input', el => el.value) === text) return
      }
      throw new Error(`回收桶搜尋框打不進「${text}」`)
    }
    /** 上一次的選單還在淡出時，點到的會是它的選項（沒作用）：先等它真的收起來，再用 DOM 打開（同樣不靠座標） */
    const binPickSource = async (label) => {
      await waitFor(pg, () => ![...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.offsetParent !== null), null, 5000)
      await pg.$eval('.src-bin-tools__src .el-select__wrapper', el => el.click())
      await waitFor(pg, l => [...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.offsetParent !== null && e.innerText.trim().startsWith(l)), label, 8000)
      return pg.evaluate((l) => {
        const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter(e => e.offsetParent !== null)
        const labels = opts.map(e => e.innerText.trim())
        opts.find(e => e.innerText.trim().startsWith(l))?.click()
        return labels
      }, label)
    }

    // 打開：「⋯」→ 回收桶
    await waitFor(pg, () => !!document.querySelector('[data-tour="kb-more"]'), null, 30_000)
    await pg.click('[data-tour="kb-more"]')
    await waitFor(pg, () => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '回收桶'), null, 8000)
    await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].find(e => e.offsetParent !== null && e.innerText.trim() === '回收桶')?.click())
    await waitFor(pg, () => document.querySelectorAll('.src-bin-row').length > 0, null, 15_000)
    await sleep(400)
    const opened = await binState()
    if (opened?.count === '回收桶裡有 153 條' && opened.titles.length === 50 && opened.more === '顯示更多' && !opened.titles.includes('W1 保固多久')) {
      pass('打開回收桶 → 「回收桶裡有 153 條」、先列 50 條、底下「顯示更多」（換新版的 150 條排在昨天那一條前面）')
    }
    else fail('打開回收桶的樣子不對', JSON.stringify({ ...opened, titles: opened?.titles.length }))
    // `C-314`：上面那段說明只剩一句（以前兩句，另一句「還原後回到刪除前的狀態…」是邊角情況）
    const binHint = await pg.evaluate(() => [...document.querySelectorAll('.src-bin-hint')].find(e => e.offsetParent !== null)?.innerText.trim() ?? '')
    if (binHint === '刪掉的知識會在這裡放 30 天，可以還原。') pass(`回收桶上面只剩一句：「${binHint}」`)
    else fail('回收桶的說明不是一句', binHint)

    // 手機 390 寬：對話框裡沒有任何東西超出螢幕、搜尋框和選單各自夠寬
    if (process.env.SHOT_DIR) await pg.screenshot({ path: join(process.env.SHOT_DIR, 'kb-recycle-bin-phone.png') })
    const binLay = await pg.evaluate(() => {
      const vw = window.innerWidth
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__header')?.innerText.includes('回收桶'))
      const over = [...(dlg?.querySelectorAll('*') ?? [])].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 })
        .map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`)
      const qW = document.querySelector('.src-bin-tools__q .el-input')?.getBoundingClientRect().width ?? 0
      const sW = document.querySelector('.src-bin-tools__src .el-select')?.getBoundingClientRect().width ?? 0
      return { over: over.slice(0, 5), hscroll: document.documentElement.scrollWidth > vw + 1, qW: Math.round(qW), sW: Math.round(sW) }
    })
    if (!binLay.over.length && !binLay.hscroll && binLay.qW >= 250 && binLay.sW >= 250) pass(`手機 390 寬 → 回收桶沒有東西超出螢幕，搜尋框 ${binLay.qW}px、選單 ${binLay.sW}px 各佔一行`)
    else fail('手機上回收桶撐破或擠扁了', JSON.stringify(binLay))

    // 搜「保固」（一個字一個字打）→ 打完才送一發、找到昨天那一條
    const callsBefore = binCalls.length
    await binType('保固')
    await waitFor(pg, () => [...document.querySelectorAll('.src-bin-row__title')].map(e => e.innerText).join() === 'W1 保固多久', null, 10_000)
    await sleep(800)
    const searched = await binState()
    const searchCalls = binCalls.slice(callsBefore)
    if (searched?.titles.join() === 'W1 保固多久' && searched.count === '找到 1 條' && searchCalls.length === 1 && searchCalls[0].q === '保固' && !searchCalls[0].withSources) {
      pass('搜「保固」→ 打完才送一發（不是每個字一發、不重算選單），找到換新版擠下去的昨天那一條、「找到 1 條」')
    }
    else fail('回收桶搜尋不對', JSON.stringify({ searched, searchCalls }))

    // 還原：照舊打還原、那一條從清單拿掉、講「已還原」
    await pg.evaluate(() => [...document.querySelectorAll('.src-bin-row')].find(r => r.innerText.includes('W1 保固多久'))?.querySelector('.el-button')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('已還原「W1 保固多久」')), null, 8000)
    const afterRestore = await binState()
    if (restores.includes('yesterday') && !afterRestore?.titles.includes('W1 保固多久') && afterRestore?.empty === '回收桶裡沒有符合的。') pass('搜到後按「還原」→ 照舊還原、從清單拿掉，剩下沒有符合的就講「回收桶裡沒有符合的。」')
    else fail('搜到後還原不對', JSON.stringify({ restores, afterRestore }))

    // 挑「哪一份資料」：選單只列有東西的、帶條數，資料已經不在的叫「已經刪掉的資料」；挑了只列那一份、名稱不重複寫
    await binType('')
    const labels = await binPickSource('已經刪掉的資料')
    await waitFor(pg, () => [...document.querySelectorAll('.src-bin-row__title')].map(e => e.innerText).join() === '資料整份刪掉的一條,資料整份刪掉的另一條', null, 10_000)
    await sleep(300)
    const gone = await binState()
    if (labels.join('|') === '全部資料|說明書 W1（150）|已經刪掉的資料（2）') {
      pass(`選單：${labels.join('、')}（還原到 0 條的那一份拿掉了）`)
    }
    else fail('「哪一份資料」選單不對', labels.join('|'))
    if (gone?.titles.length === 2 && gone.count === '找到 2 條') pass('挑「已經刪掉的資料」→ 只列那兩條、「找到 2 條」')
    else fail('挑資料不對', JSON.stringify({ gone, lastCalls: binCalls.slice(-3) }))
    await binPickSource('說明書 W1')
    await waitFor(pg, () => document.querySelectorAll('.src-bin-row').length === 50, null, 10_000)
    await sleep(300)
    const manualPick = await binState()
    if (manualPick?.count === '找到 150 條' && manualPick.metas.every(m => !m.includes('說明書 W1'))) pass('挑「說明書 W1」→ 「找到 150 條」（選單數好的），每一列不再重複寫資料名稱')
    else fail('挑一份資料的數字或名稱不對', JSON.stringify({ count: manualPick?.count, meta: manualPick?.metas[0], lastCalls: binCalls.slice(-3) }))

    // 全部資料 →「顯示更多」一路翻到底：153−1（還原了）＝152 條、按鈕消失
    await binPickSource('全部資料')
    await waitFor(pg, () => document.querySelectorAll('.src-bin-row').length === 50, null, 10_000)
    for (let i = 0; i < 4; i++) {
      const s = await binState()
      if (!s?.more) break
      const n = s.titles.length
      await binClickMore()
      await waitFor(pg, k => document.querySelectorAll('.src-bin-row').length > k, n, 10_000)
    }
    const all = await binState()
    if (all?.titles.length === 152 && !all.more && all.count === '回收桶裡有 152 條' && all.titles.includes('資料整份刪掉的另一條')) pass('「顯示更多」一路翻到底 → 152 條一條不少、按鈕消失、總數跟著還原少一條')
    else fail('顯示更多翻不到底', JSON.stringify({ n: all?.titles.length, more: all?.more, count: all?.count }))

    // 還原失敗（空間滿）→ 講伺服器給的原因、那一條留著
    await pg.evaluate(() => [...document.querySelectorAll('.src-bin-row')].find(r => r.querySelector('.src-bin-row__title')?.innerText === '舊版第 1 條')?.querySelector('.el-button')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('AI 知識量滿了')), null, 8000)
    const full = await binState()
    if (restores.includes('old-0') && full?.titles.includes('舊版第 1 條')) pass('還原時空間滿了 → 講伺服器給的原因（「AI 知識量滿了⋯」）、那一條留在回收桶')
    else fail('還原失敗沒講原因或那一條不見了', JSON.stringify({ restores, kept: full?.titles.includes('舊版第 1 條'), toasts: await toastsOf(pg) }))

    // 翻到上限還沒找到 → 講「更早的還沒找」、按「繼續往前找」接著找
    await binType('很久以前')
    await waitFor(pg, () => !!document.querySelector('.src-bin-more__note'), null, 10_000)
    const capped = await binState()
    if (capped?.titles.length === 0 && capped.moreNote === '最近刪除的 1000 條裡沒有符合的，更早的還沒找' && capped.more === '繼續往前找' && !capped.empty) {
      pass('最近 1000 條裡沒找到 → 講「更早的還沒找」＋「繼續往前找」（不是「找不到」）')
    }
    else fail('翻到上限的講法不對', JSON.stringify(capped))
    await binClickMore()
    await waitFor(pg, () => [...document.querySelectorAll('.src-bin-row__title')].some(e => e.innerText === '很久以前刪的'), null, 10_000)
    const found = await binState()
    const capCalls = binCalls.filter(c => c.q === '很久以前')
    if (found?.titles.join() === '很久以前刪的' && found.count === '找到 1 條' && !found.more && capCalls.at(-1)?.cursor === 'cap-1') pass('按「繼續往前找」→ 帶位置記號接著找、找到了，「找到 1 條」、按鈕消失')
    else fail('繼續往前找不對', JSON.stringify({ found, capCalls }))
    await pg.close()
  }

  // ── 第三十九段（`C-314`，老闆 10-14「只呈現需要的東西、不要過度呈現資訊」）：知識庫只擺要動手的 ──
  //    工作台：有資料就不擺介紹、沒有「內容較短／過期停用」灰字、側欄不掛綠色「可用」、每列只寫「N 條」、
  //    「N 件要處理」那一行只在選著資料時出現；頁頂提醒帶在電腦上不重講「要處理的事」有列的（手機照講）；
  //    「客人問了、AI 答不出來」一行標題；資料頁一行講完是什麼、自動更新選了就存、所屬產品沒有說明段、
  //    每條只講例外、編輯框不掛「可用」不給標籤（⛔ 存檔不洗標籤）、鎖頭一句話。
  //    全部假資料（清單、明細、體檢、建議、提醒都在瀏覽器裡回假的），寫入全部在瀏覽器裡回假的
  if (CHECK_FROM <= 39) {
    // ⚠️ NOW 是第三十段開跑時記的，跑到這裡已經過了好幾分鐘：「幾分鐘前」要用這一段自己的時間
    const sheet = fakeSource({ id: 'c314-sheet', name: 'C314 價目表（試算表）', chunkCount: 3, refreshIntervalMinutes: 60, lastFetchedAtMs: Date.now() - 35 * 60_000 })
    const urlSrc = fakeSource({ id: 'c314-url', type: 'url', name: 'C314 官網問答', url: 'https://shop.example.tw/faq', refreshIntervalMinutes: 1440, outdatedAtMs: NOW - 600_000, lastFetchedAtMs: Date.now() - 3600_000 - 60_000 })
    const file = fakeSource({ id: 'c314-file', type: 'file', name: 'C314 說明書.pdf', chunkCount: 2, refreshIntervalMinutes: 0, lastFetchedAtMs: 0, updatedAtMs: NOW - 5 * 86400_000 })
    const busy = fakeSource({ id: 'c314-busy', type: 'url', name: 'C314 整理中的網址', url: 'https://shop.example.tw/new', status: 'splitting', chunkCount: 0 })
    const pageFake = fakeSourcesPage([sheet, urlSrc, file, busy], {
      'c314-sheet': [
        fakeChunk({ id: 's1', title: '拿鐵價格', content: '中杯 60 元', tags: ['價格', '飲品'] }), // 很短（以前會掛「內容較短」）
        fakeChunk({ id: 's2', title: '美式價格', content: '中杯 50 元、大杯 65 元，外帶加 5 元', status: 'failed', failureReason: 'embedding timeout' }),
        fakeChunk({ id: 's3', title: '期間限定', content: '秋季限定南瓜拿鐵，售完為止', activeUntilMs: NOW + 10 * 86400_000 }),
      ],
      'c314-url': [fakeChunk({ id: 'u1', title: '運費', content: '滿千免運', manuallyEditedAtMs: NOW - 86400_000 })],
      'c314-file': [
        fakeChunk({ id: 'f1', title: '保固', content: '一年保固', manuallyEditedAtMs: NOW - 86400_000 }),
        fakeChunk({ id: 'f2', title: '停用的一條', content: '舊活動', status: 'disabled', expiredAtMs: NOW - 86400_000 }),
      ],
      'c314-busy': [],
    })
    const health = {
      failedSources: [], outdatedSources: [{ id: 'c314-url', name: urlSrc.name }], stalledSources: [], noProductSources: [],
      shortChunks: { count: 19, items: [] }, failedChunks: { count: 1, items: [{ id: 's2', title: '美式價格', sourceId: 'c314-sheet' }] },
      expiredChunks: { count: 2, items: [] }, wrongAnswerChunks: { count: 0, items: [], scanTruncated: false },
      chunkScanTruncated: false, liveChunkCount: 0, aliasCandidateCount: 0, pendingSuggestions: 2, duplicates: { items: [], scannedAtMs: 0 },
    }
    const suggestions = {
      items: [
        { id: 'g1', topic: '咖啡機是哪一國做的', eventCount: 5, sampled: false, sampleQueries: ['請問是哪一國做的'], draft: null, blanksCount: 0, draftError: '', lastSeenAtMs: NOW },
        { id: 'g2', topic: '可以刷卡嗎', eventCount: 12, sampled: true, sampleQueries: ['可以刷卡嗎'], draft: null, blanksCount: 0, draftError: '', lastSeenAtMs: NOW },
      ],
      scan: { lastScanAtMs: NOW - 5 * 86400_000, requested: false, lastError: '', lastScanGapEvents: 9 },
    }
    // 頁頂提醒帶：「內容變了」（要處理的事有列）＋「一直沒學完」（要處理的事沒列）；知識庫其他幾顆查過沒事
    const alerts = { workspaceId: WORKSPACE_ID, checkedAt: NOW, items: [
      { id: 'knowledgeOutdated', state: 'active', count: 1 }, { id: 'knowledgeIndexStuck', state: 'active', count: 1 },
      { id: 'knowledgeSyncFailed', state: 'clear' }, { id: 'knowledgeDetectStalled', state: 'clear' },
      { id: 'knowledgeIndexFailed', state: 'clear' }, { id: 'knowledgeWrongAnswers', state: 'clear' },
    ] }
    const sheetPuts = []
    const chunkPuts = []
    let failNextSheetPut = false
    const c314Fake = async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      if (url.pathname === '/api/ai/knowledge/health' && m === 'GET') return json(health)
      if (url.pathname === '/api/ai/knowledge/suggestions' && m === 'GET') return json(suggestions)
      if (url.pathname === '/api/admin/alerts' && m === 'GET') return json(alerts)
      if (url.pathname === '/api/ai/sources/c314-sheet' && m === 'PUT') {
        const b = JSON.parse(req.postData() || '{}')
        sheetPuts.push(b)
        if (failNextSheetPut) { failNextSheetPut = false; return errorJson(403, '你沒有權限改這一份的設定') }
        if (typeof b.refreshIntervalMinutes === 'number') sheet.refreshIntervalMinutes = b.refreshIntervalMinutes // 跟真的伺服器一樣：存了，明細重讀時就是新的
        return json(sheet)
      }
      const put = url.pathname.match(/^\/api\/ai\/knowledge\/(s1|s3)$/)
      if (put && m === 'PUT') {
        chunkPuts.push({ id: put[1], body: JSON.parse(req.postData() || '{}') })
        return json({ id: put[1], changed: true, status: 'indexed' })
      }
      if (url.pathname === '/api/ai/knowledge/normalize' && m === 'POST') {
        return json({ title: '拿鐵價格', content: '重點：中杯 60 元', tags: ['價格', '飲品', '咖啡'], questions: [] })
      }
      if (url.pathname === '/api/ai/knowledge/verify' && m === 'POST') return json({ timedOut: true })
      return pageFake(req)
    }
    const visibleDialog = () => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.chunk-form'))
    const pg = await openImportDialog(c314Fake, SOURCES_PAGE)
    await waitFor(pg, () => !!document.querySelector('.kb-suggest-item') && !!document.querySelector('.src-todo__item') && !!document.querySelector('.page-alert-strip'), null, 30_000)
    await sleep(800)
    if (process.env.SHOT_DIR) await pg.screenshot({ path: join(process.env.SHOT_DIR, 'kb-c314-workbench.png') })

    // 工作台
    const wb = await pg.evaluate(() => ({
      intro: !!document.querySelector('.src-workbench__intro'),
      main: document.querySelector('main.main-content')?.innerText ?? '',
      todo: [...document.querySelectorAll('.src-todo__item-title')].map(e => e.innerText.trim()),
      chips: [...document.querySelectorAll('.split-list .split-list-chip')].map(e => e.innerText.trim()),
      metas: [...document.querySelectorAll('.split-list [data-tour="kb-source-row"] .split-list-meta')].map(e => e.innerText.trim()),
      link: !!document.querySelector('.src-workbench-link:not(.src-import-link)'),
      strip: document.querySelector('.page-alert-strip')?.innerText ?? '',
      suggestHead: document.querySelector('.kb-suggest-head')?.innerText.replace(/\s+/g, '') ?? '',
      suggest: document.querySelector('.kb-suggest')?.innerText ?? '',
      counts: [...document.querySelectorAll('.kb-suggest-item__count')].map(e => e.innerText.trim()),
    }))
    if (!wb.intro && !wb.main.includes('這裡是 AI 回答客人的依據') && !wb.main.includes('左邊點一份資料')) pass('有資料時工作台上面不再擺介紹（「這裡是 AI 回答客人的依據」那三行只給還沒放資料的人看）')
    else fail('有資料了工作台還擺介紹', JSON.stringify({ intro: wb.intro }))
    if (!wb.main.includes('內容較短') && !wb.main.includes('過期自動停用') && !(await pg.$('.src-todo__muted')) && wb.todo.some(t => t.includes('原始內容改過了')) && wb.todo.some(t => t.includes('AI 沒學起來'))) {
      pass(`「要處理的事」只列要動手的（${wb.todo.join('／')}），「另有 19 條內容較短」「2 條過期自動停用」那幾行灰字不擺`)
    }
    else fail('工作台還有「知道就好」的灰字、或待辦沒列', JSON.stringify({ todo: wb.todo, short: wb.main.includes('內容較短'), expired: wb.main.includes('過期自動停用') }))
    if (JSON.stringify(wb.chips) === '["有變動","整理中"]' && JSON.stringify(wb.metas) === '["3 條","3 條","2 條","0 條"]') pass(`側欄：正常的不掛綠色「可用」，只有「${wb.chips.join('」「')}」；每一列底下只寫「N 條」`)
    else fail('側欄小章或底下那一行不對', JSON.stringify({ chips: wb.chips, metas: wb.metas }))
    if (!wb.link) pass('沒選資料時側欄不擺「N 件要處理、N 個 AI 建議 →」（右邊就是那份清單）')
    else fail('工作台上側欄還有「N 件要處理」那一行')
    if (wb.strip.includes('有知識一直沒學完') && !wb.strip.includes('有資料內容變了還沒重新學')) pass('電腦上頁頂提醒帶不重講「要處理的事」已經列的（內容變了），清單沒列的（一直沒學完）照講')
    else fail('頁頂提醒帶在知識庫還在重講、或把不該拿掉的也拿掉了', wb.strip.replace(/\s+/g, ' ').slice(0, 200))
    if (wb.suggestHead.includes('客人問了、AI答不出來（2）') && wb.suggestHead.includes('重新掃描') && !wb.suggest.includes('審一眼') && !wb.suggest.includes('上次分析') && !wb.suggest.includes('30 天內')
      && JSON.stringify(wb.counts) === '["被問 5 次","至少被問 12 次"]') {
      pass('「客人問了、AI 答不出來（2）」一行標題＋右邊小小的「重新掃描」；不再寫「草稿已擬好，審一眼就能用」「上次分析：5 天前」「30 天內」')
    }
    else fail('AI 答不出來那一區的標題或每一列不對', JSON.stringify({ head: wb.suggestHead, counts: wb.counts, extra: ['審一眼', '上次分析', '30 天內'].filter(w => wb.suggest.includes(w)) }))

    // 試算表那一份
    await pickSource(pg, sheet.name)
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 3, null, 30_000)
    await sleep(500)
    if (process.env.SHOT_DIR) await pg.screenshot({ path: join(process.env.SHOT_DIR, 'kb-c314-sheet.png') })
    const sp = await pg.evaluate(() => ({
      meta: document.querySelector('.src-header-meta')?.innerText.trim() ?? '',
      editor: document.querySelector('.split-editor')?.innerText ?? '',
      saveBtn: [...document.querySelectorAll('.split-editor .el-button')].some(b => b.offsetParent !== null && b.innerText.trim() === '儲存設定'),
      tabs: [...document.querySelectorAll('.src-chunk-filter')].map(e => e.innerText.trim()),
      rows: [...document.querySelectorAll('.src-chunk-row')].map(r => ({ title: r.querySelector('.src-chunk-title')?.innerText ?? '', meta: r.querySelector('.src-chunk-meta')?.innerText.trim() ?? '' })),
      link: document.querySelector('.src-workbench-link:not(.src-import-link)')?.innerText ?? '',
    }))
    if (/^Google 試算表・3 條・3\d 分鐘前更新$/.test(sp.meta) && !sp.editor.includes('基本資訊') && !sp.editor.includes('最後同步')) pass(`資料頁「基本資訊」卡拿掉了，名稱下面一行講完：「${sp.meta}」（正常不寫「可用」）`)
    else fail('資料頁還有「基本資訊」卡、或名稱下面那一行不對', JSON.stringify({ meta: sp.meta, card: sp.editor.includes('基本資訊') }))
    const metaOf = t => sp.rows.find(r => r.title === t)?.meta
    // `D-129`：學失敗、還在自動再試的那一條（假資料沒有 retryCount＝還在再試）只講「系統會自己再試」，篩選叫「還沒學會」
    if (JSON.stringify(sp.tabs) === '["全部（3）","還沒學會（1）"]' && metaOf('拿鐵價格') === '' && metaOf('美式價格') === 'AI 還沒學會，系統會自己再試' && /^有效至 \d{4}-\d{2}-\d{2}$/.test(metaOf('期間限定') ?? '')
      && !sp.editor.includes('內容較短') && !/\d 字/.test(sp.editor) && !sp.rows.some(r => r.meta.includes('可用'))) {
      pass('每條只講例外（沒學起來、有效至…），正常的一條底下什麼都不寫；不寫字數、不寫「可用」、沒有「內容較短」小標與篩選')
    }
    else fail('知識清單還在講不用管的事', JSON.stringify({ tabs: sp.tabs, rows: sp.rows, short: sp.editor.includes('內容較短') }))
    if (!sp.saveBtn && !sp.editor.includes('每一列對應一條') && sp.link.includes('件要處理')) pass('自動更新只剩一行、沒有「儲存設定」也沒有說明段；選著資料時側欄出現回工作台的「N 件要處理 →」')
    else fail('自動更新那一塊還有說明段或儲存鈕、或選著資料時側欄沒有回工作台那一行', JSON.stringify({ saveBtn: sp.saveBtn, link: sp.link }))

    /** 「自動更新：」那一格選一個 */
    const chooseInterval = async (label) => {
      await waitFor(pg, () => ![...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.offsetParent !== null), null, 5000)
      await pg.$eval('.src-sync-row .el-select__wrapper', el => el.click())
      await waitFor(pg, l => [...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.offsetParent !== null && e.innerText.trim() === l), label, 8000)
      await pg.evaluate(l => [...document.querySelectorAll('.el-select-dropdown__item')].find(e => e.offsetParent !== null && e.innerText.trim() === l)?.click(), label)
    }
    const selectedInterval = () => pg.$eval('.src-sync-row .el-select', el => el.innerText.trim()).catch(() => '')
    await chooseInterval('每天')
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('自動更新')), null, 8000)
    const okToast = (await toastsOf(pg)).find(x => x.includes('自動更新')) ?? ''
    const put1 = sheetPuts[0] ?? {}
    if (sheetPuts.length === 1 && put1.refreshIntervalMinutes === 1440 && !('onChangeBehavior' in put1) && !('urlAutoApply' in put1) && okToast.includes('已改成每天自動更新') && (await selectedInterval()) === '每天') {
      pass('「自動更新：」選「每天」→ 馬上存（只送這一格）、講「已改成每天自動更新」')
    }
    else fail('自動更新選了沒有馬上存', JSON.stringify({ sheetPuts, okToast }))
    await sleep(3800) // 上一則提示先消失
    failNextSheetPut = true
    await chooseInterval('每週')
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('沒有權限')), null, 8000)
    await sleep(500)
    const errToast = (await toastsOf(pg)).find(x => x.includes('沒有權限')) ?? ''
    const afterErr = await selectedInterval()
    if (sheetPuts.length === 2 && errToast.includes('你沒有權限改這一份的設定') && afterErr === '每天') pass('存不了 → 講伺服器給的原因、那一格退回原本的「每天」（不假裝改好了）')
    else fail('自動更新存失敗時的處理不對', JSON.stringify({ puts: sheetPuts.length, errToast, afterErr }))

    // 編輯框：正常的一條不掛「可用」、不給標籤、說明收起來；存檔沒動標籤就不送 tags（⛔ 不洗掉原本的標籤）
    const openEdit = title => pg.evaluate(t => [...document.querySelectorAll('.src-chunk-row')].find(r => r.querySelector('.src-chunk-title')?.innerText === t)?.querySelector('.el-button')?.click(), title)
    await openEdit('拿鐵價格')
    await waitFor(pg, visibleDialog, null, 8000)
    await sleep(400)
    if (process.env.SHOT_DIR) await pg.screenshot({ path: join(process.env.SHOT_DIR, 'kb-c314-edit.png') })
    const dlg = await pg.evaluate(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.querySelector('.chunk-form'))
      return {
        text: d?.innerText ?? '',
        status: !!d?.querySelector('.chunk-status-row'),
        datePicker: !!d?.querySelector('.el-date-editor'),
      }
    })
    const dlgBad = ['標籤', '供 AI 使用', '自動整理成重點', '這幾句會跟著知識一起被 AI 學習', '停用後 AI 不再引用'].filter(w => dlg.text.includes(w))
    if (!dlg.status && !dlg.datePicker && !dlgBad.length && dlg.text.includes('AI 可以用這一條') && dlg.text.includes('別放電話、姓名這類個資') && dlg.text.includes('進階（有效期限）')) {
      pass('編輯框：正常的一條上面不掛「可用」、沒有標籤欄、「AI 整理一下」旁邊不再一行說明、開關叫「AI 可以用這一條」、有效期限收著')
    }
    else fail('編輯框還在講不用管的事', JSON.stringify({ status: dlg.status, datePicker: dlg.datePicker, dlgBad }))
    await pg.evaluate(() => {
      const ta = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.querySelector('.chunk-form'))?.querySelector('textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '中杯 60 元、大杯 70 元')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(300)
    await pg.evaluate(() => [...document.querySelectorAll('.chunk-footer .el-button--primary')].find(b => b.offsetParent !== null && b.innerText.trim() === '儲存')?.click())
    await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.chunk-form')), null, 8000)
    const save1 = chunkPuts.find(p => p.id === 's1')?.body ?? null
    if (save1 && save1.content === '中杯 60 元、大杯 70 元' && !('tags' in save1)) pass('改了內容按儲存 → 送出去不帶 tags（後端就不動標籤，原本的「價格、飲品」不會被洗掉）')
    else fail('存檔時送了標籤（可能洗掉原本的）或沒送出', JSON.stringify(save1))
    await openEdit('拿鐵價格')
    await waitFor(pg, visibleDialog, null, 8000)
    await sleep(300)
    await pg.evaluate(() => [...document.querySelectorAll('.chunk-normalize-row .el-button')].find(b => b.offsetParent !== null)?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(x => x.innerText.includes('記得儲存')), null, 8000)
    await pg.evaluate(() => [...document.querySelectorAll('.chunk-footer .el-button--primary')].find(b => b.offsetParent !== null && b.innerText.trim() === '儲存')?.click())
    await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.chunk-form')), null, 8000)
    const save2 = chunkPuts.filter(p => p.id === 's1').at(-1)?.body ?? null
    if (chunkPuts.filter(p => p.id === 's1').length === 2 && JSON.stringify(save2?.tags) === '["價格","飲品","咖啡"]') pass('按過「AI 整理一下」（AI 換了標籤）再儲存 → 才把新的標籤送出去（標籤由系統管，照舊存得進去）')
    else fail('AI 整理換的標籤沒存進去', JSON.stringify(save2))
    await openEdit('美式價格')
    await waitFor(pg, visibleDialog, null, 8000)
    await sleep(300)
    const failedDlg = await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && x.querySelector('.chunk-form'))?.querySelector('.chunk-status-row')?.innerText.replace(/\s+/g, ' ') ?? '')
    // `D-129`：還在自動再試的那一條講「系統會自己再試」、⛔ 不給按鈕（試完 5 次才給「再試一次」，見 shared/knowledge-relearn 的測試）
    if (failedDlg.includes('還沒學會') && failedDlg.includes('系統會自己再試') && !failedDlg.includes('再試一次') && !failedDlg.includes('重新學習')) pass(`還在自動再試的那一條照樣掛狀態、不給按鈕：「${failedDlg.trim()}」`)
    else fail('還在自動再試的那一條狀態不對', failedDlg)
    await pg.evaluate(() => [...document.querySelectorAll('.chunk-footer .el-button')].find(b => b.offsetParent !== null && b.innerText.trim() === '取消')?.click())
    await sleep(600)

    // 網址那一份：更多設定預設收著；鎖頭一句話
    await pickSource(pg, urlSrc.name)
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 1 && document.querySelector('.src-header-main input')?.value === 'C314 官網問答', null, 30_000)
    await sleep(400)
    const before = await pg.evaluate(() => ({
      meta: document.querySelector('.src-header-meta')?.innerText.trim() ?? '',
      radios: document.querySelectorAll('.split-editor .el-radio-group').length,
      editor: document.querySelector('.split-editor')?.innerText ?? '',
    }))
    await pg.evaluate(() => document.querySelector('.src-sync-more')?.click())
    await sleep(300)
    const opened = await pg.evaluate(() => ({
      radios: document.querySelectorAll('.split-editor .el-radio-group').length,
      save: [...document.querySelectorAll('.split-editor .el-button')].some(b => b.offsetParent !== null && b.innerText.trim() === '儲存設定'),
    }))
    if (before.meta === '網址・3 條・1 小時前更新' && before.radios === 0 && !before.editor.includes('排程會定期抓網頁內容') && opened.radios === 2 && opened.save) pass('網址：自動更新一行，「偵測到變動時」「網頁改了的時候」收在預設關著的「更多設定」裡（打開照樣按「儲存設定」）')
    else fail('網址的自動更新那一塊不對', JSON.stringify({ before: { ...before, editor: before.editor.includes('排程會定期抓網頁內容') }, opened }))
    const lockPop = async () => {
      await pg.evaluate(() => document.querySelector('.src-chunk-lock')?.click())
      await waitFor(pg, () => [...document.querySelectorAll('.src-lock-pop')].some(p => getComputedStyle(p).display !== 'none' && p.innerText.trim()), null, 5000)
      const t = await pg.evaluate(() => [...document.querySelectorAll('.src-lock-pop')].find(p => getComputedStyle(p).display !== 'none')?.innerText.replace(/\s+/g, ' ').trim() ?? '')
      await pg.keyboard.press('Escape')
      await pg.mouse.click(5, 500)
      await sleep(400)
      return t
    }
    const urlPop = await lockPop()
    if (urlPop === '你改過這一條，網頁更新時不會蓋掉。 改回跟著網頁') pass(`網址的鎖頭：一句＋一顆按鈕（「${urlPop}」）`)
    else fail('網址的鎖頭不是一句＋一顆按鈕', urlPop)

    // 檔案那一份：「所屬產品」那張卡不在資料頁上了（`C-320`：收進「⋯」→「AI 認的商品名」，第四十四段驗）；鎖頭講上傳新版；停用的那一條講到期日
    await pickSource(pg, file.name)
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 2, null, 30_000)
    await sleep(400)
    if (process.env.SHOT_DIR) await pg.screenshot({ path: join(process.env.SHOT_DIR, 'kb-c314-file.png') })
    const fp = await pg.evaluate(() => ({
      meta: document.querySelector('.src-header-meta')?.innerText.trim() ?? '',
      editor: document.querySelector('.split-editor')?.innerText ?? '',
      productInputs: [...document.querySelectorAll('.split-editor input')].filter(i => (i.getAttribute('placeholder') ?? '').includes('商品')).length,
      off: [...document.querySelectorAll('.src-chunk-row')].find(r => r.querySelector('.src-chunk-title')?.innerText === '停用的一條')?.querySelector('.src-chunk-meta')?.innerText.trim() ?? '',
    }))
    if (/^檔案・2 條・\d{1,2}\/\d{1,2} 更新$/.test(fp.meta) && !fp.editor.includes('所屬產品') && !fp.productInputs && /^已停用（\d{4}-\d{2}-\d{2} 到期）$/.test(fp.off)) {
      pass(`檔案：「${fp.meta}」；資料頁上沒有「所屬產品」那張卡；停用的那一條講「${fp.off}」`)
    }
    else fail('檔案那一份不對', JSON.stringify({ ...fp, editor: fp.editor.includes('所屬產品') }))
    const filePop = await lockPop()
    if (filePop === '你改過這一條，上傳新版時會先問要不要帶過去。 上傳新版時直接用新版') pass(`檔案的鎖頭：一句＋一顆按鈕（「${filePop}」）`)
    else fail('檔案的鎖頭不是一句＋一顆按鈕', filePop)

    // 還在整理的那一份：狀態接在那一行後面
    await pickSource(pg, busy.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C314 整理中的網址', null, 30_000)
    await sleep(300)
    const busyMeta = await pg.evaluate(() => ({ text: document.querySelector('.src-header-meta')?.innerText.trim() ?? '', busy: !!document.querySelector('.src-header-meta__status.is-busy') }))
    if (busyMeta.text.endsWith('・整理中') && busyMeta.busy) pass(`不正常時狀態才接在那一行後面、上色：「${busyMeta.text}」`)
    else fail('整理中的那一份沒講狀態', JSON.stringify(busyMeta))
    await pg.close()

    // 手機：工作台看不到，頁頂提醒帶照講「內容變了」（⛔ 不能跟著電腦一起拿掉）
    const phone = await openImportDialog(c314Fake, { ...SOURCES_PAGE, width: 390, height: 844 })
    await waitFor(phone, () => !!document.querySelector('.page-alert-strip'), null, 30_000)
    await sleep(800)
    const phoneStrip = await phone.evaluate(() => document.querySelector('.page-alert-strip')?.innerText ?? '')
    if (phoneStrip.includes('有資料內容變了還沒重新學')) pass('手機（工作台看不到）：頁頂提醒帶照講「有資料內容變了還沒重新學」')
    else fail('手機上提醒帶把「內容變了」也拿掉了（手機上沒有別的地方講）', phoneStrip.replace(/\s+/g, ' ').slice(0, 200))
    await phone.close()
  }

  // ══ 第四十段起（2026-10-15 `D-126` 拍板、`C-315`～`C-320`）：知識庫頁三欄、這份在講什麼、補一條、按鈕叫法、分組 ══
  // 全部假資料；「問 AI」那一支（/api/ai/playground）、補一條、分組、商品名的寫入全部在瀏覽器裡回假的
  const C315_SHOTS = process.env.SHOT_DIR ? join(process.env.SHOT_DIR, 'c315') : ''
  if (C315_SHOTS) mkdirSync(C315_SHOTS, { recursive: true })
  const shot = async (pg, name, sel) => {
    if (!C315_SHOTS) return
    if (sel) await (await pg.$(sel))?.screenshot({ path: join(C315_SHOTS, name) }).catch(() => {})
    else await pg.screenshot({ path: join(C315_SHOTS, name) })
  }
  /** 畫面上看得到、標題含 title 的那個對話框 */
  const dialogShown = (pg, title) => pg.evaluate(t => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && (d.querySelector('.el-dialog__title')?.innerText ?? '').includes(t)), title)
  /**
   * 把「畫面上看得到的那一個對話框」標成 [data-shown]，後面用 `.el-dialog[data-shown]` 指它（打字要選擇器）。
   * ⚠️ 收著的對話框還在 DOM 裡（destroy-on-close 沒開的那幾個），只用 class 會挑到收著的那一個
   */
  const SHOWN = '.el-dialog[data-shown]'
  const markShown = (pg, { inner = '', title = '' }) => pg.evaluate((s, t) => {
    document.querySelectorAll('[data-shown]').forEach(e => e.removeAttribute('data-shown'))
    const d = [...document.querySelectorAll('.el-dialog')].find(x => x.offsetParent !== null && (!s || x.querySelector(s)) && (!t || x.querySelector('.el-dialog__title')?.innerText === t))
    d?.setAttribute('data-shown', '1')
    return !!d
  }, inner, title)
  const emptyHealthFake = () => ({
    failedSources: [], outdatedSources: [], stalledSources: [], noProductSources: [],
    shortChunks: { count: 0, items: [] }, failedChunks: { count: 0, items: [] }, expiredChunks: { count: 0, items: [] },
    wrongAnswerChunks: { count: 0, items: [], scanTruncated: false }, chunkScanTruncated: false, liveChunkCount: 0,
    aliasCandidateCount: 0, pendingSuggestions: 0, duplicates: { items: [], scannedAtMs: 0 },
  })
  /** 那個元素現在有沒有在亮（flashAgentTarget 用 Web Animations 亮 2.4 秒） */
  const flashing = (pg, sel) => pg.evaluate(s => (document.querySelector(s)?.getAnimations?.().length ?? 0) > 0, sel)
  /** 清掉再打字（el-input 的 v-model 吃 input 事件） */
  const typeInto = async (pg, sel, text) => {
    await pg.$eval(sel, (el) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    if (text) await pg.type(sel, text, { delay: 20 })
  }
  /** 問 AI：在 scope（欄或抽屜）裡打一句、送出、等「用了這 N 條」出來 */
  const askOnce = async (pg, scope, text) => {
    await typeInto(pg, `${scope} .kb-ask__foot input`, text)
    await pg.evaluate(s => document.querySelector(`${s} .kb-ask__foot .el-button--primary`)?.click(), scope)
    return waitFor(pg, s => document.querySelectorAll(`${s} .kb-ask__src`).length > 0, scope, 15_000)
  }
  /** 「送出」那顆有沒有被右下角小幫手那顆蓋住（點它正中間，點到的是不是它自己那一行） */
  const sendNotCovered = (pg, scope) => pg.evaluate((s) => {
    const b = document.querySelector(`${s} .kb-ask__foot .el-button--primary`)?.getBoundingClientRect()
    const i = document.querySelector(`${s} .kb-ask__foot input`)?.getBoundingClientRect()
    if (!b || !i) return false
    const hitB = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
    const hitI = document.elementFromPoint(i.right - 4, i.top + i.height / 2)
    return !!hitB?.closest(`${s} .kb-ask__foot`) && !!hitI?.closest(`${s} .kb-ask__foot`) && i.width >= 120
  }, scope)
  const clickAskSource = (pg, scope, title) => pg.evaluate((s, t) => [...document.querySelectorAll(`${s} .kb-ask__src`)].find(b => b.querySelector('.kb-ask__src-title')?.innerText === t)?.click(), scope, title)

  // ── 第四十段（`C-315`，`D-126` 第 2 題）：三欄——電腦（內容寬 ≥ 1200）右邊常駐「問 AI」、整個高度；
  //    點「用了這幾條」→ 中間打開那一份、捲到那一條亮一下（被篩掉的也找得到、不開編輯框）；換掉的、等你看過的照實講；
  //    「答得不對？寫一句正確答案」打開補一條、帶著那一句；721～1199 收成右上「問 AI」開抽屜；手機不放 ──
  if (CHECK_FROM <= 40) {
    const a = fakeSource({ id: 'c315-a', type: 'file', name: 'C315 保固說明.pdf', chunkCount: 8, refreshIntervalMinutes: 0, summary: ['保固一年', '怎麼退貨'] })
    const b = fakeSource({ id: 'c315-b', type: 'url', name: 'C315 官網運費', url: 'https://shop.example.tw/ship', chunkCount: 2, refreshIntervalMinutes: 1440, summary: ['運費怎麼算'] })
    const aChunks = Array.from({ length: 8 }, (_, i) => fakeChunk({ id: `a${i + 1}`, title: `保固第 ${i + 1} 條`, content: `保固內容 ${i + 1}` }))
    aChunks[6] = fakeChunk({ id: 'a7', title: '等你看過的一條', content: '還沒上線', status: 'draft' })
    const pageFake = fakeSourcesPage([a, b], { 'c315-a': aChunks, 'c315-b': [fakeChunk({ id: 'b1', title: '運費' }), fakeChunk({ id: 'b2', title: '離島運費' })] })
    const asks = []
    const c315Fake = async (req) => {
      const url = new URL(req.url())
      if (url.pathname === '/api/ai/playground' && req.method() === 'POST') {
        asks.push(JSON.parse(req.postData() || '{}').query)
        return json({ decision: 'answered', answer: '保固一年，離島運費另計。', answerKind: 'kb', confidence: 0.9,
          sources: [
            { chunkId: 'a8', sourceId: 'c315-a', title: '保固第 8 條', similarity: 0.9 },
            { chunkId: 'gone-x', sourceId: 'c315-a', title: '已經換掉的那一條', similarity: 0.8 },
            { chunkId: 'a7', sourceId: 'c315-a', title: '等你看過的一條', similarity: 0.7, draft: true },
            { chunkId: 'b2', sourceId: 'c315-b', title: '離島運費', similarity: 0.6 },
          ] })
      }
      if (url.pathname === '/api/ai/knowledge/gone-x' && req.method() === 'GET') return json({ id: 'gone-x', sourceId: 'c315-a', deleted: true })
      return pageFake(req)
    }
    const COL = '.src-ask-col'
    const pg = await openImportDialog(c315Fake, SOURCES_PAGE)
    await waitFor(pg, () => !!document.querySelector('.src-ask-col [data-tour="kb-ask"]'), null, 30_000)
    await sleep(500)
    await shot(pg, 'desktop-workbench.png')
    const lay = await pg.evaluate(() => {
      const col = document.querySelector('.src-ask-col')?.getBoundingClientRect()
      const split = document.querySelector('.split-layout')?.getBoundingClientRect()
      const cols = document.querySelector('.src-cols')?.getBoundingClientRect()
      return {
        colW: col ? Math.round(col.width) : 0,
        colTop: col ? Math.round(col.top) : -1,
        colBottom: col ? Math.round(col.bottom) : -1,
        splitTop: split ? Math.round(split.top) : -2,
        vh: window.innerHeight,
        colsW: cols ? Math.round(cols.width) : 0,
        openBtn: [...document.querySelectorAll('[data-tour="kb-ask-open"]')].some(e => e.offsetParent !== null),
        hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        middle: Math.round(document.querySelector('.split-editor')?.getBoundingClientRect().width ?? 0),
      }
    })
    if (Math.abs(lay.colW - 340) <= 2 && lay.colBottom >= lay.vh - 2 && Math.abs(lay.colTop - lay.splitTop) <= 1 && !lay.openBtn && !lay.hscroll) pass(`電腦（內容寬 ${lay.colsW}px）：右邊常駐「問 AI」${lay.colW}px、從上到底（${lay.colTop}→${lay.colBottom}），中間剩 ${lay.middle}px，不擺「問 AI」鈕、沒有橫向捲動`)
    else fail('電腦上右邊那一欄不對', JSON.stringify(lay))

    // 先打開 A、用「在這份裡找」把 a8 篩掉：點「用了這幾條」那一下要清掉篩選，才捲得到
    await pickSource(pg, a.name)
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 8, null, 30_000)
    await typeInto(pg, '.src-chunk-search input', '第 1 條')
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 1, null, 5000)
    await pg.evaluate(() => document.querySelector('.split-editor-body')?.scrollTo(0, 0))
    const asked = await askOnce(pg, COL, '保固多久')
    await sleep(300)
    await shot(pg, 'desktop-answer.png')
    // 問過之後輸入那一行掉到最底下，正好在右下角小幫手那顆旁邊
    if (await sendNotCovered(pg, COL)) pass('問過之後輸入那一行在最底下：右下角小幫手那顆沒有蓋住輸入框和「送出」（那一行讓出右邊）')
    else fail('「問 AI」的送出鈕被右下角小幫手蓋住了')
    const labels = await pg.$$eval(`${COL} .kb-ask__src`, els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()))
    if (asked && asks.length === 1 && labels.length === 4 && labels[0].includes('保固第 8 條') && labels[0].includes('這一份') && labels[3].includes('C315 官網運費')) pass(`問一句 → 答案底下「用了這 4 條」，開著的那一份標「這一份」、別份標名字（${labels.map(l => l.slice(0, 16)).join('｜')}）`)
    else fail('問 AI 的答案／出處不對', JSON.stringify({ asked, asks, labels }))

    await clickAskSource(pg, COL, '保固第 8 條')
    const lit = await waitFor(pg, () => (document.querySelector('[data-agent-target="kb-chunk:a8"]')?.getAnimations?.().length ?? 0) > 0, null, 5000)
    const after8 = await pg.evaluate(() => {
      const row = document.querySelector('[data-agent-target="kb-chunk:a8"]')?.getBoundingClientRect()
      const body = document.querySelector('.split-editor-body')?.getBoundingClientRect()
      return {
        rows: document.querySelectorAll('.src-chunk-row').length,
        q: document.querySelector('.src-chunk-search input')?.value ?? '',
        inView: !!row && !!body && row.top >= body.top - 1 && row.bottom <= body.bottom + 1,
        editor: [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.chunk-form')),
      }
    })
    await sleep(1200)
    await shot(pg, 'desktop-open-chunk.png')
    if (lit && after8.rows === 8 && !after8.q && after8.inView && !after8.editor) pass('點「保固第 8 條」→ 「在這份裡找」清掉、捲到那一條、亮一下（不開編輯框）')
    else fail('點出處沒有捲到那一條亮起來', JSON.stringify({ lit, ...after8 }))

    await sleep(3800)
    await clickAskSource(pg, COL, '已經換掉的那一條')
    const goneT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('已經換掉或刪掉了')), null, 8000)
    await sleep(3800)
    await clickAskSource(pg, COL, '等你看過的一條')
    const draftT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('還在「等你看過」')), null, 8000)
    const draftLit = await flashing(pg, '[data-agent-target="kb-chunk:a7"]')
    if (goneT && draftT && draftLit) pass('點到已經換掉的 → 講「已經換掉或刪掉了（在回收桶裡）」；點到等你看過的 → 照樣亮、講「還在『等你看過』，AI 還不會用」')
    else fail('換掉的／等你看過的沒有照實講', JSON.stringify({ goneT, draftT, draftLit }))

    await clickAskSource(pg, COL, '離島運費')
    const toB = await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C315 官網運費' && (document.querySelector('[data-agent-target="kb-chunk:b2"]')?.getAnimations?.().length ?? 0) > 0, null, 15_000)
    if (toB) pass('點別份的「離島運費」→ 中間換成那一份、那一條亮起來')
    else fail('點別份的出處沒有換過去')

    await pg.evaluate(s => [...document.querySelectorAll(`${s} .kb-ask__fix`)].at(-1)?.click(), COL)
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.kb-addone')), null, 8000)
    const q = await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.kb-addone input')?.value ?? '')
    await shot(pg, 'desktop-add-one-from-ask.png')
    if (q === '保固多久') pass('「答得不對？寫一句正確答案」→ 打開「補一條知識」、客人問那一格帶著剛剛那一句')
    else fail('從問 AI 打開補一條沒有帶那一句', q)
    await pg.keyboard.press('Escape')
    await sleep(500)
    await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.el-dialog__footer .el-button:not(.el-button--primary)')?.click())
    await sleep(400)

    // 中間寬度（1100 → 內容 860）：右欄收成右上一顆「問 AI」、開抽屜；點出處 → 抽屜關掉、中間打開那一條
    await pg.setViewport({ width: 1100, height: 900 })
    await waitFor(pg, () => !document.querySelector('.src-ask-col') && [...document.querySelectorAll('.admin-header-actions [data-tour="kb-ask-open"]')].some(e => e.offsetParent !== null), null, 10_000)
    const mid = await pg.evaluate(() => ({
      col: !!document.querySelector('.src-ask-col'),
      btn: [...document.querySelectorAll('.admin-header-actions [data-tour="kb-ask-open"]')].map(e => e.innerText.trim()).join(),
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))
    await shot(pg, 'mid-header-button.png')
    await pg.evaluate(() => document.querySelector('.admin-header-actions [data-tour="kb-ask-open"]')?.click())
    const drawer = await waitFor(pg, () => { const d = document.querySelector('.src-ask-drawer'); return !!d && d.offsetParent !== null && !!d.querySelector('[data-tour="kb-ask"]') }, null, 8000)
    await sleep(500)
    const DRAWER = '.src-ask-drawer'
    const drawerTitle = await pg.evaluate(() => ({
      own: document.querySelector('.src-ask-drawer .el-drawer__title')?.innerText.trim() ?? '',
      close: !!document.querySelector('.src-ask-drawer .el-drawer__close-btn'),
    }))
    const askedMid = await askOnce(pg, DRAWER, '保固多久')
    await sleep(300)
    // 前面「等你看過」那一句提示還浮在右下角的話會擋住量測：等它消失（提示 3.5 秒就收，不是版面的問題）
    await waitFor(pg, () => !document.querySelector('.toast'), null, 8000)
    const drawerSend = await sendNotCovered(pg, DRAWER)
    const sendDbg = drawerSend ? null : await pg.evaluate((s) => {
      const r = el => { const x = el?.getBoundingClientRect(); return x ? [Math.round(x.left), Math.round(x.top), Math.round(x.right), Math.round(x.bottom)] : null }
      const b = document.querySelector(`${s} .kb-ask__foot .el-button--primary`)
      const bb = b?.getBoundingClientRect()
      const hit = bb ? document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2) : null
      return { btn: r(b), input: r(document.querySelector(`${s} .kb-ask__foot input`)), fab: r(document.querySelector('.ta-fab')), foot: r(document.querySelector(`${s} .kb-ask__foot`)), pad: getComputedStyle(document.querySelector(`${s} .kb-ask__foot`)).paddingRight, hit: hit ? `${hit.tagName}.${[...hit.classList].join('.')}` : null }
    }, DRAWER)
    await shot(pg, 'mid-drawer.png')
    await clickAskSource(pg, DRAWER, '保固第 8 條')
    const closedAndOpened = await waitFor(pg, () => {
      const d = document.querySelector('.src-ask-drawer')
      const hidden = !d || d.offsetParent === null || getComputedStyle(d).display === 'none' || d.getBoundingClientRect().left >= window.innerWidth - 1
      return hidden && document.querySelector('.src-header-main input')?.value === 'C315 保固說明.pdf' && !!document.querySelector('[data-agent-target="kb-chunk:a8"]')
    }, null, 15_000)
    if (!mid.col && mid.btn === '問 AI' && !mid.hscroll && drawer && askedMid && closedAndOpened && drawerSend && !drawerTitle.own && drawerTitle.close) pass('內容寬 860（視窗 1100）：右欄收成右上「問 AI」→ 打開抽屜（不重寫標題、留 ✕、送出沒被小幫手蓋住）；點出處 → 抽屜收起來、中間打開那一份那一條')
    else fail('中間寬度的「問 AI」不對', JSON.stringify({ ...mid, drawer, askedMid, closedAndOpened, drawerSend, drawerTitle, sendDbg }))
    await pg.close()

    // 中間寬度、沒選任何一份（工作台）：「問 AI」在工作台右上那一行
    const pgMid = await openImportDialog(c315Fake, { ...SOURCES_PAGE, width: 1100, height: 900 })
    const wbBtn = await waitFor(pgMid, () => [...document.querySelectorAll('.src-ask-bar [data-tour="kb-ask-open"]')].some(e => e.offsetParent !== null), null, 20_000)
    const wbPos = await pgMid.evaluate(() => {
      const b = document.querySelector('.src-ask-bar [data-tour="kb-ask-open"]')?.getBoundingClientRect()
      const ed = document.querySelector('.split-editor')?.getBoundingClientRect()
      return b && ed ? { rightGap: Math.round(ed.right - b.right), topGap: Math.round(b.top - ed.top) } : null
    })
    await shot(pgMid, 'mid-workbench-button.png')
    if (wbBtn && wbPos && wbPos.rightGap <= 40 && wbPos.topGap <= 40) pass(`工作台（沒選資料）：「問 AI」在中間那一欄的右上（離右邊 ${wbPos.rightGap}px、離上面 ${wbPos.topGap}px）`)
    else fail('工作台上找不到右上的「問 AI」', JSON.stringify({ wbBtn, wbPos }))
    await pgMid.close()

    // 手機：不放（手機工作台另排 `E-13`）
    const phone = await openImportDialog(c315Fake, { ...SOURCES_PAGE, width: 390, height: 844 })
    await waitFor(phone, () => document.querySelectorAll('.split-list [data-tour="kb-source-row"]').length > 0, null, 30_000)
    await sleep(500)
    const ph = await phone.evaluate(() => ({
      col: !!document.querySelector('.src-ask-col'),
      btn: [...document.querySelectorAll('[data-tour="kb-ask-open"]')].some(e => e.offsetParent !== null),
      panel: !!document.querySelector('[data-tour="kb-ask"]'),
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))
    if (!ph.col && !ph.btn && !ph.panel && !ph.hscroll) pass('手機 390 寬：沒有「問 AI」欄、也沒有那顆鈕（手機工作台另排），沒有橫向捲動')
    else fail('手機上還有問 AI', JSON.stringify(ph))
    await phone.close()
  }

  // ── 第四十一段（`C-316`）：「這份在講什麼」——沒有就請伺服器寫一次（骨架）、最多三行、每份只請一次；
  //    已經有的直接用；一段文字不請；寫不出來整塊不出現；立即更新換了內容 → force 重寫；
  //    「在這份裡找…」標題／內容／問法都找得到、找不到講一句，條數少不擺 ──
  if (CHECK_FROM <= 41) {
    const s1 = fakeSource({ id: 'c316-new', type: 'file', name: 'C316 說明書', chunkCount: 8, refreshIntervalMinutes: 0 })
    const s2 = fakeSource({ id: 'c316-has', type: 'url', name: 'C316 官網', url: 'https://shop.example.tw/faq', chunkCount: 3, summary: ['已經有的第一行', '已經有的第二行'], summaryAt: NOW - 86400_000 })
    const s3 = fakeSource({ id: 'c316-text', type: 'manual', name: 'C316 營業時間', chunkCount: 1, lastFetchedAtMs: 0 })
    const s4 = fakeSource({ id: 'c316-fail', type: 'file', name: 'C316 寫不出來', chunkCount: 4, refreshIntervalMinutes: 0 })
    const s5 = fakeSource({ id: 'c316-sheet', type: 'gsheet', name: 'C316 價目表', chunkCount: 3, summary: ['舊內容的摘要'], summaryAt: NOW - 86400_000 })
    const s1Chunks = [
      fakeChunk({ id: 'n1', title: '保固多久', content: '一年保固' }),
      fakeChunk({ id: 'n2', title: '怎麼退貨', content: '七天鑑賞期內可退' }),
      fakeChunk({ id: 'n3', title: '付款方式', content: '信用卡、轉帳', questions: ['可以刷卡嗎'] }),
      ...Array.from({ length: 5 }, (_, i) => fakeChunk({ id: `n${i + 4}`, title: `規格 ${i + 1}`, content: '尺寸' })),
    ]
    const pageFake = fakeSourcesPage([s1, s2, s3, s4, s5], {
      'c316-new': s1Chunks,
      'c316-has': [fakeChunk({ id: 'h1', title: '運費' }), fakeChunk({ id: 'h2', title: '退貨' }), fakeChunk({ id: 'h3', title: '保固' })],
      'c316-text': [fakeChunk({ id: 't1', title: '營業時間' })],
      'c316-fail': Array.from({ length: 4 }, (_, i) => fakeChunk({ id: `f${i + 1}`, title: `第 ${i + 1} 條` })),
      'c316-sheet': [fakeChunk({ id: 'g1', title: '拿鐵' }), fakeChunk({ id: 'g2', title: '美式' }), fakeChunk({ id: 'g3', title: '摩卡' })],
    })
    const pg = await openImportDialog(async (req) => {
      if (req.url().includes('/api/ai/sources/c316-sheet/gsheet-sync') && req.method() === 'POST') return json({ outcome: 'synced', added: 1, updated: 0, deleted: 0, kept: 2 })
      return pageFake(req)
    }, {
      ...SOURCES_PAGE,
      summary: async (id, body) => {
        if (id === 'c316-new') { await sleep(1500); return json({ summary: ['第一行：保固一年', '第二行：七天鑑賞期', '第三行：可以刷卡'], summaryAt: Date.now() }) }
        if (id === 'c316-fail') return json({ summary: [], summaryAt: 0, summaryFailed: true })
        if (id === 'c316-sheet' && body.force) { s5.summary = ['新內容的摘要']; return json({ summary: ['新內容的摘要'], summaryAt: Date.now() }) }
        return undefined
      },
    })
    const callsOf = id => summaryCalls.filter(c => c.id === id)
    const summaryState = () => pg.evaluate(() => ({
      card: !!document.querySelector('.src-summary'),
      skeleton: !!document.querySelector('.src-summary .el-skeleton'),
      lines: [...document.querySelectorAll('.src-summary__list li')].map(e => e.innerText.trim()),
      first: document.querySelector('.solo-editor-body')?.firstElementChild?.classList.contains('src-summary') ?? false,
      title: document.querySelector('.src-summary .section-title')?.innerText.trim() ?? '',
    }))
    await pickSource(pg, s1.name)
    await waitFor(pg, () => !!document.querySelector('.src-summary .el-skeleton'), null, 8000)
    const during = await summaryState()
    await shot(pg, 'summary-skeleton.png', '.split-editor')
    await waitFor(pg, () => document.querySelectorAll('.src-summary__list li').length > 0, null, 10_000)
    const done = await summaryState()
    await shot(pg, 'summary-and-search.png', '.split-editor')
    if (during.skeleton && done.title === '這份在講什麼' && done.lines.length === 3 && done.first && callsOf('c316-new').length === 1 && !callsOf('c316-new')[0].force) pass(`還沒有摘要 → 請伺服器寫一次（骨架等著），名稱下面第一塊「這份在講什麼」三行：${done.lines.join('／')}`)
    else fail('「這份在講什麼」沒出現或不對', JSON.stringify({ during, done, calls: callsOf('c316-new') }))

    // 在這份裡找
    const rowsNow = () => pg.$$eval('.src-chunk-row .src-chunk-title', els => els.map(e => e.innerText))
    await typeInto(pg, '.src-chunk-search input', '鑑賞')
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 1, null, 5000)
    const byContent = await rowsNow()
    await typeInto(pg, '.src-chunk-search input', '刷卡')
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 1, null, 5000)
    const byQuestion = await rowsNow()
    await typeInto(pg, '.src-chunk-search input', '保固')
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 1, null, 5000)
    const byTitle = await rowsNow()
    await typeInto(pg, '.src-chunk-search input', '沒有這種')
    await waitFor(pg, () => !!document.querySelector('.src-chunk-none'), null, 5000)
    const none = await pg.$eval('.src-chunk-none', e => e.innerText.trim()).catch(() => '')
    const placeholder = await pg.$eval('.src-chunk-search input', e => e.getAttribute('placeholder')).catch(() => '')
    if (placeholder === '在這份裡找…' && byContent.join() === '怎麼退貨' && byQuestion.join() === '付款方式' && byTitle.join() === '保固多久' && none === '沒有符合「沒有這種」的。') pass('「在這份裡找…」：內容（鑑賞→怎麼退貨）、客人問法（刷卡→付款方式）、標題都找得到；找不到講「沒有符合「沒有這種」的。」')
    else fail('在這份裡找不對', JSON.stringify({ placeholder, byContent, byQuestion, byTitle, none }))

    await pickSource(pg, s2.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C316 官網' && document.querySelectorAll('.src-chunk-row').length === 3, null, 15_000)
    await sleep(500)
    const has = await summaryState()
    const searchOnSmall = !!(await pg.$('.src-chunk-search'))
    if (has.lines.join() === '已經有的第一行,已經有的第二行' && !callsOf('c316-has').length && !searchOnSmall) pass('已經有摘要的那一份 → 直接用（不再請伺服器寫）；只有 3 條的不擺「在這份裡找」')
    else fail('已經有摘要的那一份不對、或 3 條也擺了搜尋框', JSON.stringify({ has, calls: callsOf('c316-has'), searchOnSmall }))

    await pickSource(pg, s3.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C316 營業時間', null, 15_000)
    await sleep(800)
    const text = await summaryState()
    await pickSource(pg, s4.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C316 寫不出來' && document.querySelectorAll('.src-chunk-row').length === 4, null, 15_000)
    await sleep(1200)
    const failed = await summaryState()
    const failToasts = await toastsOf(pg)
    if (!text.card && !callsOf('c316-text').length && !failed.card && callsOf('c316-fail').length === 1 && !failToasts.some(t => t.includes('摘要'))) pass('一段文字（一條）不請、不擺；寫不出來（summaryFailed）整塊不出現、也不跳「摘要失敗」')
    else fail('一段文字或寫不出來的那一份不對', JSON.stringify({ text, textCalls: callsOf('c316-text'), failed, failCalls: callsOf('c316-fail'), failToasts }))

    await pickSource(pg, s1.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C316 說明書' && document.querySelectorAll('.src-summary__list li').length === 3, null, 15_000)
    if (callsOf('c316-new').length === 1) pass('換到別份再回來 → 摘要還在、沒有再請一次（每份每次打開頁面最多一次）')
    else fail('同一份又請了一次摘要', JSON.stringify(callsOf('c316-new')))

    await pickSource(pg, s5.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C316 價目表' && document.querySelectorAll('.src-summary__list li').length === 1, null, 15_000)
    await pg.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button')].find(b => b.innerText.includes('立即更新'))?.click())
    const rewrote = await waitFor(pg, () => [...document.querySelectorAll('.src-summary__list li')].map(e => e.innerText).join() === '新內容的摘要', null, 15_000)
    if (rewrote && callsOf('c316-sheet').length === 1 && callsOf('c316-sheet')[0].force) pass('試算表按「立即更新」更新到東西 → 帶 force 請伺服器重寫，換成新內容的摘要')
    else fail('立即更新之後摘要沒有重寫', JSON.stringify({ rewrote, calls: callsOf('c316-sheet') }))
    await pg.close()
  }

  // ── 第四十二段（`C-317`，`D-126` 第 3 題）：這一頁所有「新增一條」都打開「補一條知識」——側欄那顆（樣子照舊、不叫小幫手）、
  //    （`C-323` 起「⋯」選單裡沒有「手動新增知識」了，這裡改驗選單只剩什麼）、?q= 深連結（查不到現成的直接開、帶那一句；補好銷監控頁同問題案例）、查到現成的「還是新增一條」；
  //    補好了在開著的那一份 → 重讀、那一條亮；在別份 → 左邊那一份亮（不切走）；舊的五格新增框不見了 ──
  if (CHECK_FROM <= 42) {
    const f = fakeSource({ id: 'c317-file', type: 'file', name: 'C317 說明書', chunkCount: 2, refreshIntervalMinutes: 0, summary: ['說明'] })
    const list = [f]
    const details = { 'c317-file': [fakeChunk({ id: 'k1', title: '保固' }), fakeChunk({ id: 'k2', title: '退貨' })] }
    const pageFake = fakeSourcesPage(list, details)
    const creates = []
    const resolves = []
    let nextCreate = null
    const pg = await openImportDialog(async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      if (url.pathname === '/api/ai/knowledge/create' && m === 'POST') {
        const b = JSON.parse(req.postData() || '{}')
        creates.push(b)
        const r = nextCreate ?? { id: `new-${creates.length}`, sourceId: 'c317-file' }
        if (r.sourceId === 'c317-file') { details['c317-file'].push(fakeChunk({ id: r.id, title: b.title })); f.chunkCount++ }
        else if (!list.some(s => s.id === r.sourceId)) { list.push(fakeSource({ id: r.sourceId, type: 'manual', name: b.title, chunkCount: 1 })); details[r.sourceId] = [fakeChunk({ id: r.id, title: b.title })] }
        return json({ ...r, status: 'indexed' })
      }
      if (url.pathname === '/api/ai/usage/handoffs/resolve-by-query' && m === 'POST') { resolves.push(JSON.parse(req.postData() || '{}').query); return json({ resolved: 2 }) }
      // 補好之後小視窗會用客人的話試問一次（不寫東西，但是 POST、會花 AI 的錢）：回「逾時」＝不講結果
      if (url.pathname === '/api/ai/knowledge/verify' && m === 'POST') return json({ timedOut: true })
      if (url.pathname === '/api/ai/knowledge/search' && m === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        return json({ items: q.includes('運費') ? [{ id: 'k9', sourceId: 'c317-file', title: '運費怎麼算', snippet: '滿千免運', status: 'indexed' }] : [], truncated: false, countTruncated: false })
      }
      return pageFake(req)
    }, SOURCES_PAGE)
    /** 瀏覽器裡跑的判斷（給 waitFor 用）；Node 這邊要讀就用 addOneShown() */
    const ADD_ONE_SHOWN = () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.kb-addone'))
    const addOneShown = () => pg.evaluate(ADD_ONE_SHOWN)
    const addOneQ = () => pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.kb-addone input')?.value ?? null)
    const fillAndAdd = async (q, a) => {
      await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.kb-addone')), null, 8000)
      await markShown(pg, { inner: '.kb-addone' })
      if (q !== null) await typeInto(pg, `${SHOWN} .kb-addone .admin-field-group input`, q)
      await typeInto(pg, `${SHOWN} .kb-addone textarea`, a)
      await sleep(200)
      await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.el-dialog__footer .el-button--primary')?.click())
      await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.kb-addone')), null, 8000)
    }
    const closeAddOne = async () => {
      await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.el-dialog__footer .el-button:not(.el-button--primary)')?.click())
      await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.kb-addone')), null, 5000)
    }

    // 側欄那顆：樣子跟另外三頁一樣（同兩個 class、小按鈕、自己一排），按了開補一條、⛔ 不叫小幫手
    await waitFor(pg, () => !!document.querySelector('.split-sidebar .agent-ask-row .agent-ask-btn'), null, 30_000)
    const sideBtn = await pg.evaluate(() => {
      const btn = document.querySelector('.split-sidebar .agent-ask-row .agent-ask-btn')
      return { text: btn?.innerText.trim() ?? '', small: btn?.classList.contains('el-button--small') ?? false, h: Math.round(btn?.getBoundingClientRect().height ?? 0) }
    })
    await pg.evaluate(() => document.querySelector('.split-sidebar .agent-ask-row .agent-ask-btn')?.click())
    await waitFor(pg, ADD_ONE_SHOWN, null, 8000)
    const side ={ shown: await addOneShown(), q: await addOneQ(), agent: !!(await pg.$('.ta-panel')) }
    await markShown(pg, { inner: '.kb-addone' })
    await shot(pg, 'add-one-dialog.png', SHOWN)
    if (sideBtn.text === '用一句話寫一條知識' && sideBtn.small && side.shown && side.q === '' && !side.agent) pass(`側欄「用一句話寫一條知識」（樣子照舊：小按鈕 ${sideBtn.h}px、自己一排）→ 打開「補一條知識」，不叫小幫手`)
    else fail('側欄那顆不對', JSON.stringify({ sideBtn, side }))
    await closeAddOne()

    // 「⋯」選單（`C-323`）：「手動新增知識」拿掉了（跟上面那顆打開同一個視窗＝重複的入口），「產品名稱整理」搬進編輯分組；
    // 只剩新增分組、回收桶（「重新學習全部知識」只有平台超管看得到，登入的人是不是超管不一定，不判）
    // ⚠️ 先等上一個視窗的遮罩淡出：淡出的那半秒裡點下去，點到的是遮罩、選單不會開
    await waitFor(pg, () => ![...document.querySelectorAll('.el-overlay')].some(o => getComputedStyle(o).display !== 'none'), null, 5000)
    await sleep(300)
    await pg.click('[data-tour="kb-more"]')
    await waitFor(pg, () => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '新增分組'), null, 8000)
    const moreItems = await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(e => e.offsetParent !== null).map(e => e.innerText.trim()))
    // 再按一次「⋯」收起來（⛔ 不點畫面中間：工作台那裡讀的是正式庫的待辦，可能點到某顆按鈕）
    await pg.click('[data-tour="kb-more"]')
    await waitFor(pg, () => ![...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null), null, 5000)
    const oldCreate = await dialogShown(pg, '新增知識')
    if (moreItems.slice(0, 2).join('／') === '新增分組／回收桶' && moreItems.every(t => t === '新增分組' || t === '回收桶' || t.startsWith('重新學習')) && !oldCreate) pass(`「⋯」選單只剩：${moreItems.join('／')}（「手動新增知識」「產品名稱整理」拿掉了）`)
    else fail('「⋯」選單不對', JSON.stringify({ moreItems, oldCreate }))

    // 開著「C317 說明書」補一條、伺服器說放進這一份 → 重讀、那一條亮；⛔ 不帶商品名（小視窗沒有那一格）
    await pickSource(pg, f.name)
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 2, null, 15_000)
    await pg.evaluate(() => document.querySelector('.split-sidebar .agent-ask-row .agent-ask-btn')?.click())
    await fillAndAdd('有門市嗎', '沒有門市，只在網路上賣。')
    const litNew = await waitFor(pg, () => (document.querySelector('[data-agent-target="kb-chunk:new-1"]')?.getAnimations?.().length ?? 0) > 0, null, 10_000)
    const okToast = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('加好了')), null, 5000)
    const c1 = creates[0] ?? {}
    if (litNew && okToast && c1.title === '有門市嗎' && c1.content === '沒有門市，只在網路上賣。' && !('productName' in c1) && JSON.stringify(c1.questions) === '["有門市嗎"]' && !resolves.length) pass('開著那一份補一條 → 送出去標題＝客人問、問法帶那一句、不帶商品名；放進這一份 → 重讀、那一條亮起來；沒有從 ?q= 來就不銷案')
    else fail('補一條放進開著的那一份不對', JSON.stringify({ litNew, okToast, c1, resolves }))

    // 放進另一份（新開的一段文字）→ 左邊那一份亮、不切走
    await sleep(3800)
    nextCreate = { id: 'new-x', sourceId: 'c317-new-text' }
    await pg.evaluate(() => document.querySelector('.split-sidebar .agent-ask-row .agent-ask-btn')?.click())
    await fillAndAdd('營業時間', '週一到週五 10 點到 18 點。')
    const litRow = await waitFor(pg, () => (document.querySelector('[data-agent-target="kb-source:c317-new-text"]')?.getAnimations?.().length ?? 0) > 0, null, 10_000)
    const stay = await pg.$eval('.src-header-main input', e => e.value).catch(() => '')
    if (litRow && stay === 'C317 說明書') pass('補的那一條放進新的一份 → 左邊那一份亮一下，中間照舊是他在看的那一份（不切走）')
    else fail('補到別份時沒亮、或被切走了', JSON.stringify({ litRow, stay }))
    nextCreate = null
    await pg.close()

    // ?q=（AI 表現頁「補知識」）：查不到現成的 → 直接開補一條、帶那一句；補好 → 銷監控頁同問題案例
    const pgQ = await openImportDialog(async (req) => {
      const url = new URL(req.url())
      if (url.pathname === '/api/ai/knowledge/create' && req.method() === 'POST') { creates.push(JSON.parse(req.postData() || '{}')); return json({ id: 'new-q', sourceId: 'c317-q', status: 'indexed' }) }
      if (url.pathname === '/api/ai/usage/handoffs/resolve-by-query' && req.method() === 'POST') { resolves.push(JSON.parse(req.postData() || '{}').query); return json({ resolved: 2 }) }
      if (url.pathname === '/api/ai/knowledge/verify' && req.method() === 'POST') return json({ timedOut: true })
      if (url.pathname === '/api/ai/knowledge/search' && req.method() === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        return json({ items: q.includes('運費') ? [{ id: 'k9', sourceId: 'c317-file', title: '運費怎麼算', snippet: '滿千免運', status: 'indexed' }] : [], truncated: false, countTruncated: false })
      }
      return pageFake(req)
    }, { path: `/knowledge/sources?q=${encodeURIComponent('可以寄到香港嗎')}`, waitSel: '[data-tour="kb-sources"]' })
    const qShown = await waitFor(pgQ, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.kb-addone')), null, 20_000)
    const qVal = await pgQ.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.kb-addone input')?.value ?? '')
    await markShown(pgQ, { inner: '.kb-addone' })
    await typeInto(pgQ, `${SHOWN} .kb-addone textarea`, '可以，運費另計。')
    await sleep(200)
    await pgQ.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.el-dialog__footer .el-button--primary')?.click())
    const resolved = await waitFor(pgQ, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('同問題案例標為已處理')), null, 10_000)
    if (qShown && qVal === '可以寄到香港嗎' && resolved && resolves.at(-1) === '可以寄到香港嗎') pass('?q=「可以寄到香港嗎」、查不到現成的 → 直接開「補一條知識」帶那一句；補好 → 監控頁同問題的案例標成已處理')
    else fail('?q= 補一條不對', JSON.stringify({ qShown, qVal, resolved, resolves }))

    // ?q= 查得到現成的 → 先問「這題可能已經有答案了」→「還是新增一條」→ 同一個小視窗
    await gotoAgain(pgQ, `${BASE}/admin/${WORKSPACE_ID}/knowledge/sources?q=${encodeURIComponent('運費多少')}`)
    const dupAsk = await waitFor(pgQ, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.innerText.includes('這題可能已經有答案了')), null, 20_000)
    await pgQ.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.innerText.includes('這題可能已經有答案了'))?.querySelectorAll('.el-dialog__footer .el-button')?.forEach(b => { if (b.innerText.includes('還是新增一條')) b.click() }))
    const dupThen = await waitFor(pgQ, () => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.kb-addone'))?.querySelector('.kb-addone input')?.value === '運費多少', null, 8000)
    if (dupAsk && dupThen) pass('?q=「運費多少」查到現成的「運費怎麼算」→ 先問要不要改那一條；按「還是新增一條」→ 同一個「補一條知識」、帶著那一句')
    else fail('?q= 查到現成的那條路不對', JSON.stringify({ dupAsk, dupThen }))
    await pgQ.close()
  }

  // ── 第四十三段（`C-319`，`D-126` 第 5 題）：更新類按鈕一種講法——試算表、網址「立即更新」，檔案「上傳新版」；
  //    提到它們的提醒也這樣講；整頁不再出現「換新版」「立即同步」「重新同步」 ──
  if (CHECK_FROM <= 43) {
    const sheet = fakeSource({ id: 'c319-sheet', name: 'C319 價目表', chunkCount: 2, refreshIntervalMinutes: 60, summary: ['價目'] })
    const web = fakeSource({ id: 'c319-url', type: 'url', name: 'C319 官網', url: 'https://shop.example.tw/a', chunkCount: 2, outdatedAtMs: NOW - 600_000, summary: ['官網'] })
    const file = fakeSource({ id: 'c319-file', type: 'file', name: 'C319 說明書', chunkCount: 2, refreshIntervalMinutes: 0, summary: ['說明'],
      status: 'failed', failureReason: '檔案讀不到' })
    const pageFake = fakeSourcesPage([sheet, web, file], {
      'c319-sheet': [fakeChunk({ id: 'p1', title: '拿鐵', manuallyEditedAtMs: NOW - 86400_000 }), fakeChunk({ id: 'p2', title: '美式' })],
      'c319-url': [fakeChunk({ id: 'w1', title: '運費' }), fakeChunk({ id: 'w2', title: '退貨' })],
      'c319-file': [fakeChunk({ id: 'd1', title: '保固', manuallyEditedAtMs: NOW - 86400_000 }), fakeChunk({ id: 'd2', title: '退貨' })],
    })
    const pg = await openImportDialog(async (req) => {
      if (req.url().includes('/api/ai/sources/c319-sheet') && req.method() === 'PUT') return json(sheet)
      return pageFake(req)
    }, SOURCES_PAGE)
    const OLD = ['換新版', '立即同步', '重新同步']
    const read = () => pg.evaluate(() => ({
      btns: [...document.querySelectorAll('.admin-header-actions .el-button')].map(b => b.innerText.trim()).filter(Boolean),
      editor: document.querySelector('.split-editor')?.innerText ?? '',
    }))
    await pickSource(pg, sheet.name)
    await waitFor(pg, () => document.querySelectorAll('.src-chunk-row').length === 2 && document.querySelector('.src-header-main input')?.value === 'C319 價目表', null, 15_000)
    await sleep(300)
    const r1 = await read()
    // 鎖頭點開的那一句也照新叫法
    await pg.evaluate(() => document.querySelector('.src-chunk-lock')?.click())
    await sleep(400)
    // 「自動更新：」改成不自動 → 提示講右上「立即更新」
    await pg.$eval('.src-sync-row .el-select__wrapper', el => el.click())
    await waitFor(pg, () => [...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '不自動更新'), null, 8000)
    await pg.evaluate(() => [...document.querySelectorAll('.el-select-dropdown__item')].find(e => e.offsetParent !== null && e.innerText.trim() === '不自動更新')?.click())
    const offToast = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('要更新時按右上「立即更新」')), null, 8000)
    await pickSource(pg, web.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C319 官網' && document.querySelectorAll('.src-chunk-row').length === 2, null, 15_000)
    await sleep(300)
    const r2 = await read()
    await pickSource(pg, file.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C319 說明書' && document.querySelectorAll('.src-chunk-row').length === 2, null, 15_000)
    await sleep(300)
    const r3 = await read()
    await pg.evaluate(() => document.querySelector('.src-chunk-lock')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.src-lock-pop')].some(p => getComputedStyle(p).display !== 'none' && p.innerText.includes('上傳新版')), null, 5000)
    const pops = await pg.$$eval('.src-lock-pop', els => els.map(e => e.innerText).join(' '))
    await shot(pg, 'buttons-file.png', '.split-editor')
    const oldHits = [r1.editor, r2.editor, r3.editor, pops].flatMap(t => OLD.filter(w => t.includes(w)))
    if (r1.btns.includes('立即更新') && r2.btns.includes('立即更新') && r3.btns.includes('上傳新版') && r2.editor.includes('建議點上方「立即更新」') && r3.editor.includes('按上方「上傳新版」') && offToast && !oldHits.length) {
      pass('試算表、網址右上「立即更新」、檔案「上傳新版」；網址有變動的提醒、檔案壞了的修法、鎖頭、關掉自動更新的提示都照新叫法，整頁沒有「換新版／立即同步／重新同步」')
    }
    else fail('更新類按鈕的叫法不一致', JSON.stringify({ b1: r1.btns, b2: r2.btns, b3: r3.btns, offToast, oldHits }))
    await pg.close()
  }

  // ── 第四十四段（`C-320`／`D-127` 分組就是商品）：「資料夾」改叫「分組」；通用的那幾組排最上面、標「通用」；
  //    編輯分組可以改成通用（只送那一格），商品名跟著清掉、底下那幾份一份份重新學；拖曳搬組＝換商品名、講 AI 現在當成哪一台；
  //    資料頁「⋯」是「移到哪一組／刪除」（沒有「AI 認的商品名」了；`D-129` 起「重新學習這一份」也拿掉）；
  //    「還沒放進商品分組」的待辦直接打開「移到哪一組」 ──
  if (CHECK_FROM <= 44) {
    const folders = [
      { id: 'c320-prod', name: '乾淨方MAX', order: 0, createdAtMs: NOW, general: false },
      { id: 'c320-faq', name: '客服 FAQ', order: 1, createdAtMs: NOW, general: true },
      { id: 'c320-gen', name: '通用', order: 2, createdAtMs: NOW, general: true },
      { id: 'c320-dry', name: 'C320 除濕機', order: 3, createdAtMs: NOW, general: false },
    ]
    const inProd = fakeSource({ id: 'c320-a', type: 'file', name: 'C320 乾淨方說明書', folderId: 'c320-prod', chunkCount: 2, productName: 'SHARP 乾淨方MAX', summary: ['說明'] })
    const loose = fakeSource({ id: 'c320-c', type: 'file', name: 'C320 沒分組的檔案', chunkCount: 2, refreshIntervalMinutes: 0, productName: '', summary: ['說明'] })
    const sheet = fakeSource({ id: 'c320-d', name: 'C320 價目表（試算表）', chunkCount: 2, summary: ['價目'] })
    const noName = fakeSource({ id: 'c320-e', type: 'file', name: 'C320 除濕機快速上手', chunkCount: 2, refreshIntervalMinutes: 0, productName: '', summary: ['說明'] })
    const pageFake = fakeSourcesPage([inProd, loose, sheet, noName], {
      'c320-a': [fakeChunk({ id: 'x1', title: '濾網' }), fakeChunk({ id: 'x2', title: '保固' })],
      'c320-c': [fakeChunk({ id: 'y1', title: '運費' }), fakeChunk({ id: 'y2', title: '退貨' })],
      'c320-d': [fakeChunk({ id: 'z1', title: '拿鐵' }), fakeChunk({ id: 'z2', title: '美式' })],
      'c320-e': [fakeChunk({ id: 'e1', title: '開機' }), fakeChunk({ id: 'e2', title: '水箱' })],
    })
    const health = { ...emptyHealthFake(), noProductSources: [{ id: 'c320-c', name: loose.name, chunkCount: 2 }] }
    const folderPuts = []
    const sourcePuts = []
    const reindexes = []
    const all = [inProd, loose, sheet, noName]
    /** 同伺服器 productNameForGroup（`D-127`）：商品分組＝組名；通用、未分類、試算表＝空的 */
    const productOf = (s) => {
      const f = folders.find(x => x.id === s.folderId)
      return !f || f.general || s.type === 'gsheet' || s.generateOverview ? '' : f.name
    }
    const pg = await openImportDialog(async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      if (url.pathname === '/api/ai/folders' && m === 'GET') return json({ items: folders })
      if (url.pathname === '/api/ai/knowledge/health' && m === 'GET') return json(health)
      const fp = url.pathname.match(/^\/api\/ai\/folders\/([^/]+)$/)
      if (fp && m === 'PUT') {
        const b = JSON.parse(req.postData() || '{}')
        folderPuts.push({ id: fp[1], body: b })
        const target = folders.find(x => x.id === fp[1])
        if (target && typeof b.general === 'boolean') target.general = b.general
        if (target && b.name) target.name = b.name
        // 改成通用／改名＝底下每一份換商品名（同伺服器 syncGroupSourcesProduct），回要重新學的那幾份
        const relearnSourceIds = []
        for (const s of all) {
          if (s.folderId !== fp[1] || productOf(s) === s.productName) continue
          s.productName = productOf(s)
          relearnSourceIds.push(s.id)
        }
        return json({ ...target, relearnSourceIds, aliasFrom: '' })
      }
      const sp = url.pathname.match(/^\/api\/ai\/sources\/(c320-[a-e])$/)
      if (sp && m === 'PUT') {
        const b = JSON.parse(req.postData() || '{}')
        sourcePuts.push({ id: sp[1], body: b })
        const s = all.find(x => x.id === sp[1])
        if (s && 'folderId' in b) {
          s.folderId = b.folderId
          // 換組＝換商品名（同伺服器 syncSourceProductWithGroup）：有變就重新學（快上手那份故意慢 2 秒，驗「搬移中」）、回 groupSync
          const target = productOf(s)
          if (target !== s.productName) {
            if (s.id === 'c320-e' && target) await sleep(2000)
            const previous = s.productName
            s.productName = target
            if (target) health.noProductSources = health.noProductSources.filter(x => x.id !== s.id)
            return json({ ...s, groupSync: { productName: target, previous, indexed: 2, failed: 0 } })
          }
        }
        return json(s)
      }
      const ri = url.pathname.match(/^\/api\/ai\/sources\/(c320-[a-e])\/reindex$/)
      if (ri && m === 'POST') { reindexes.push(ri[1]); return json({ indexed: 2, failed: 0 }) }
      return pageFake(req)
    }, SOURCES_PAGE)
    await waitFor(pg, () => document.querySelectorAll('.src-folder-header').length === 4, null, 30_000)
    await sleep(500)
    await shot(pg, 'groups-sidebar.png', '.split-sidebar')
    const heads = () => pg.$$eval('.src-folder-header', els => els.map((e) => {
      const label = e.querySelector('.src-folder-label')?.getBoundingClientRect()
      const count = e.querySelector('.src-folder-count')?.getBoundingClientRect()
      return {
        name: e.querySelector('.src-folder-name')?.innerText.trim() ?? '',
        general: !!e.querySelector('.src-folder-general'),
        edit: e.querySelector('.src-folder-icon-btn')?.getAttribute('aria-label') ?? '',
        // 「（N）」整個在標籤框裡（以前「通用」章把它擠到框外、只剩「（0」）
        countShown: !!label && !!count && count.right <= label.right + 0.5,
      }
    }))
    const h1 = await heads()
    if (JSON.stringify(h1.map(h => h.name)) === '["客服 FAQ","通用","乾淨方MAX","C320 除濕機"]' && JSON.stringify(h1.map(h => h.general)) === '[true,false,false,false]' && h1.every(h => h.edit === '編輯分組') && h1.every(h => h.countShown)) pass(`分組：通用的排最上面（${h1.map(h => h.name + (h.general ? '［通用］' : '')).join('、')}），名字本來就叫「通用」的不重標；每組右邊「編輯分組」`)
    else fail('分組的順序或「通用」標不對', JSON.stringify(h1))

    await pg.click('[data-tour="kb-more"]')
    await waitFor(pg, () => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '新增分組'), null, 8000)
    const menu = await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(e => e.offsetParent !== null).map(e => e.innerText.trim()))
    await pg.keyboard.press('Escape')
    await pg.mouse.click(700, 600)
    await sleep(400)
    if (menu.includes('新增分組') && !menu.some(t => t.includes('資料夾'))) pass(`「⋯」選單講「新增分組」（${menu.join('／')}）`)
    else fail('「⋯」選單還在講資料夾', menu.join('／'))

    // 編輯分組：把「乾淨方MAX」改成通用 → 只送 general；排到通用那一段（伺服器順序：乾淨方MAX 0）
    await pg.evaluate(() => [...document.querySelectorAll('.src-folder-header')].find(e => e.innerText.includes('乾淨方MAX'))?.querySelector('.src-folder-icon-btn')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
    await markShown(pg, { title: '編輯分組' })
    await shot(pg, 'groups-edit.png', SHOWN)
    const editText = await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組')?.innerText ?? '')
    await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組')?.querySelector('.src-folder-general-check')?.click())
    await sleep(200)
    await pg.evaluate(() => [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組')?.querySelector('.folder-footer-right .el-button--primary')?.click())
    await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
    await sleep(300)
    const h2 = await heads()
    const fput = folderPuts[0]?.body ?? {}
    if (folderPuts.length === 1 && folderPuts[0].id === 'c320-prod' && fput.general === true && !('name' in fput) && JSON.stringify(h2.map(h => h.name)) === '["乾淨方MAX","客服 FAQ","通用","C320 除濕機"]' && h2[0].general && editText.includes('刪除分組') && !editText.includes('資料夾')) pass('編輯分組勾「通用」→ 只送 general:true（名字沒改不送）、那一組排進最上面那一段；視窗講「分組」不講資料夾')
    else fail('編輯分組改成通用不對', JSON.stringify({ folderPuts, h2, editText: editText.replace(/\s+/g, ' ').slice(0, 160) }))
    // `D-127`：商品分組的名字那一格叫「商品名」；改成通用＝底下那一份不再是那一台 → 畫面一份份打重新學習、學完講一句
    const relearnedToast = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 照新的商品名學好了 1 份資料')), null, 10_000)
    if (/商品名/.test(editText) && reindexes.includes('c320-a') && relearnedToast) pass('`D-127` 商品分組的名字叫「商品名」；改成通用 → 伺服器回要重新學的那一份，畫面接著打重新學習、講「AI 重新學好了 1 份資料」')
    else fail('改成通用之後沒有重新學', JSON.stringify({ label: /商品名/.test(editText), reindexes, relearnedToast, toasts: await toastsOf(pg) }))

    // 拖曳搬組照舊：沒分組的那一份拖到「客服 FAQ」→ PUT folderId；拖分組裡的那份時講「拖到這裡 = 移出分組」
    const dragTo = async (srcName, folderName) => pg.evaluate(async (s, fname) => {
      const row = [...document.querySelectorAll('.flow-sidebar-row')].find(r => r.innerText.includes(s))
      const handle = row?.querySelector('.drag-handle')
      // ⚠️ 照組名比（.src-folder-name）：用 innerText.includes 的話「通用」會先比到標著「通用」的別組
      const head = [...document.querySelectorAll('.src-folder-header')].find(e => e.querySelector('.src-folder-name')?.innerText.trim() === fname)
      if (!handle || !head) return { ok: false }
      const dt = new DataTransfer()
      handle.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const zone = document.querySelector('.src-unfolder-zone')?.innerText.trim() ?? ''
      head.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      head.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      handle.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return { ok: true, zone }
    }, srcName, folderName)
    const d1 = await dragTo(loose.name, '客服 FAQ')
    await sleep(800)
    const d2 = await dragTo(inProd.name, '通用')
    await sleep(800)
    const moves = sourcePuts.filter(p => 'folderId' in p.body)
    if (d1.ok && moves[0]?.id === 'c320-c' && moves[0].body.folderId === 'c320-faq' && d2.zone === '拖到這裡 = 移出分組' && moves[1]?.id === 'c320-a' && moves[1].body.folderId === 'c320-gen') pass('拖曳搬組照舊：拖到哪一組就送那一組（folderId）；拖分組裡的那份時講「拖到這裡 = 移出分組」')
    else fail('拖曳搬組不對', JSON.stringify({ d1, d2, moves }))

    // `D-127`：拖進商品分組＝換成那一組的商品名，伺服器當場重新學（慢）→ 那一列先標「搬移中」，好了講 AI 現在當成哪一台
    await dragTo(noName.name, 'C320 除濕機')
    const busy = await waitFor(pg, n => [...document.querySelectorAll('.flow-sidebar-row')].some(r => r.innerText.includes(n) && r.innerText.includes('搬移中')), noName.name, 5000)
    const synced = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 現在把它當成「C320 除濕機」的資料')), null, 10_000)
    const busyGone = await waitFor(pg, n => ![...document.querySelectorAll('.flow-sidebar-row')].some(r => r.innerText.includes(n) && r.innerText.includes('搬移中')), noName.name, 5000)
    if (busy && synced && busyGone) pass('拖進商品分組（伺服器換商品名、重新學要幾秒）→ 那一列先標「搬移中」，好了講「AI 現在把它當成「C320 除濕機」的資料」')
    else fail('拖進商品分組的過程沒講', JSON.stringify({ busy, synced, busyGone, toasts: await toastsOf(pg) }))
    // 再拖到「通用」＝不是講單一商品：講 AI 不再把它當成那一台（⛔ 不默默留著舊商品名，`C-320` 那時是留著、要他自己去改）
    await sleep(3800)
    await dragTo(noName.name, '通用')
    const cleared = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 不再把它當成「C320 除濕機」的資料')), null, 10_000)
    if (cleared && noName.productName === '') pass('拖到「通用」→ 伺服器清掉商品名，講「AI 不再把它當成「C320 除濕機」的資料」')
    else fail('拖到通用時沒講不再當成那一台', JSON.stringify({ cleared, productName: noName.productName, toasts: await toastsOf(pg) }))
    await sleep(3800)

    // 資料頁「⋯」（`D-127`）：移到哪一組／刪除，試算表也一樣（⛔ 沒有「AI 認的商品名」了；`D-129` 起也沒有「重新學習這一份」）
    const MOVE_TITLE = '移到哪一組'
    const openMore = async (item) => {
      await pg.click('.admin-header-actions .admin-more-btn')
      await waitFor(pg, t => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === t), item, 8000)
      await pg.evaluate(t => [...document.querySelectorAll('.el-dropdown-menu__item')].find(e => e.offsetParent !== null && e.innerText.trim() === t)?.click(), item)
    }
    /** 「移到哪一組」選一組（el-select 的下拉掛在 body 上）→ 回那一行說明 */
    const pickMoveTarget = async (name) => {
      await pg.click(`${SHOWN} .src-move-select .el-select__wrapper`)
      await waitFor(pg, n => [...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.offsetParent !== null && e.innerText.trim() === n), name, 5000)
      await pg.evaluate(n => [...document.querySelectorAll('.el-select-dropdown__item')].find(e => e.offsetParent !== null && e.innerText.trim() === n)?.click(), name)
      await sleep(300)
      return pg.$eval(`${SHOWN} .src-move-hint`, e => e.innerText.trim()).catch(() => '')
    }
    await pickSource(pg, sheet.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C320 價目表（試算表）', null, 15_000)
    await pg.click('.admin-header-actions .admin-more-btn')
    await waitFor(pg, () => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '刪除'), null, 8000)
    const sheetMenu = await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(e => e.offsetParent !== null).map(e => e.innerText.trim()))
    await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].find(e => e.offsetParent !== null && e.innerText.trim() === '移到哪一組')?.click())
    await waitFor(pg, t => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === t), MOVE_TITLE, 8000)
    await markShown(pg, { title: MOVE_TITLE })
    const sheetHint = await pickMoveTarget('C320 除濕機')
    await pg.evaluate(s => document.querySelector(`${s} .el-dialog__footer .el-button:not(.el-button--primary)`)?.click(), SHOWN)
    await waitFor(pg, () => ![...document.querySelectorAll('.el-overlay')].some(o => getComputedStyle(o).display !== 'none'), null, 5000)
    await sleep(300)
    // `D-129`：「重新學習這一份」拿掉了（系統自己補）；只有那一份裡有試了 5 次都沒學會的，才多一項「沒學會的 N 條再試一次」
    if (sheetMenu.join('／') === '移到哪一組／刪除' && sheetHint.startsWith('試算表、型錄一份常講好幾台')) pass(`資料頁「⋯」＝${sheetMenu.join('／')}（沒有「AI 認的商品名」、沒有「重新學習這一份」）；試算表選商品分組時講「試算表、型錄一份常講好幾台，放在哪一組都不會整份當成那一台」`)
    else fail('資料頁「⋯」或試算表的說明不對', JSON.stringify({ sheetMenu, sheetHint }))

    // 「移到哪一組」：選商品分組 → 先講 AI 會把它當成哪一台 → 移過去＝送 folderId、講 AI 現在當成哪一台；資料頁沒有「所屬產品」卡
    await pickSource(pg, loose.name)
    await waitFor(pg, () => document.querySelector('.src-header-main input')?.value === 'C320 沒分組的檔案' && document.querySelectorAll('.src-chunk-row').length === 2, null, 15_000)
    const editorText = await pg.$eval('.split-editor', e => e.innerText).catch(() => '')
    await openMore('移到哪一組')
    await waitFor(pg, t => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === t), MOVE_TITLE, 8000)
    await markShown(pg, { title: MOVE_TITLE })
    const moveDisabledBefore = await pg.$eval(`${SHOWN} .el-dialog__footer .el-button--primary`, e => e.disabled).catch(() => null)
    const moveHint = await pickMoveTarget('C320 除濕機')
    await shot(pg, 'move-to-group.png', SHOWN)
    const putsBefore = sourcePuts.length
    await pg.evaluate(s => document.querySelector(`${s} .el-dialog__footer .el-button--primary`)?.click(), SHOWN)
    const movedT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 現在把它當成「C320 除濕機」的資料')), null, 10_000)
    const moveClosed = await waitFor(pg, t => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === t), MOVE_TITLE, 5000)
    const mPut = sourcePuts.slice(putsBefore).find(p => p.id === 'c320-c')
    if (!editorText.includes('所屬產品') && moveDisabledBefore === true && moveHint === 'AI 會把這份當成「C320 除濕機」的資料。' && mPut?.body.folderId === 'c320-dry' && !('productName' in mPut.body) && movedT && moveClosed) {
      pass('「⋯ → 移到哪一組」：沒換組按不下去；選商品分組先講「AI 會把這份當成「C320 除濕機」的資料。」→ 移過去只送 folderId（不送商品名）、講 AI 現在當成哪一台、視窗關掉；資料頁沒有「所屬產品」卡')
    }
    else fail('移到哪一組不對', JSON.stringify({ card: editorText.includes('所屬產品'), moveDisabledBefore, moveHint, mPut, movedT, moveClosed }))

    // `D-129`：「⋯ → 重新學習這一份」拿掉了（換組、改組名之後沒學成的，系統自己補完）——這一份沒有試完 5 次的，選單裡就不該有「再試一次」
    await sleep(800)
    await pg.click('.admin-header-actions .admin-more-btn')
    await waitFor(pg, () => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '刪除'), null, 8000)
    const looseMenu = await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].filter(e => e.offsetParent !== null).map(e => e.innerText.trim()))
    await pg.keyboard.press('Escape')
    await sleep(300)
    if (looseMenu.length && !looseMenu.some(t => t.includes('重新學習') || t.includes('再試一次'))) pass(`「⋯」沒有「重新學習這一份」、也沒有「再試一次」（這一份沒有試完 5 次的）：${looseMenu.join('／')}`)
    else fail('「⋯」還有重新學習／再試一次', JSON.stringify(looseMenu))

    // 待辦「還沒放進商品分組」（`D-127`）→「放進分組」直接打開那一份的「移到哪一組」（快上手那份剛被拖到通用、沒有商品名）
    health.noProductSources = [{ id: 'c320-e', name: noName.name, chunkCount: 2 }]
    await gotoAgain(pg, `${BASE}/admin/${WORKSPACE_ID}/knowledge/sources`)
    await waitFor(pg, () => [...document.querySelectorAll('.src-todo__item')].some(e => e.innerText.includes('還沒放進商品分組')), null, 30_000)
    const todo = await pg.$$eval('.src-todo__item', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('還沒放進商品分組')) ?? '')
    await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('還沒放進商品分組'))?.querySelector('.el-button')?.click())
    const todoOpened = await waitFor(pg, t => document.querySelector('.src-header-main input')?.value === 'C320 除濕機快速上手' && [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === t), MOVE_TITLE, 15_000)
    if (todo.includes('有 1 份檔案還沒放進商品分組') && todo.includes('放進分組') && todoOpened) pass('待辦「有 1 份檔案還沒放進商品分組」→「放進分組」：打開那一份、直接跳出「移到哪一組」（不用自己去「⋯」找）')
    else fail('「還沒放進商品分組」的待辦沒有直接打開小視窗', JSON.stringify({ todo, todoOpened }))
    await pg.close()

    // 觀察者（`G-107`：存不了的照樣看得到）：「⋯」整顆沒有，那一份被認成哪個商品接在名稱下面那一行；
    // 也沒有「問 AI」（測試對話是客服級）、沒有「用一句話寫一條知識」。角色在瀏覽器裡改（「我有哪些官方帳號」那一支回 viewer），不動正式庫
    const viewer = await openImportDialog(async (req) => {
      const url = new URL(req.url())
      if (url.pathname === '/api/admin/workspaces/my' && req.method() === 'GET') {
        const real = await (await fetch(req.url(), { headers: req.headers() })).json()
        for (const w of real.workspaces ?? []) if (w.workspaceId === WORKSPACE_ID) w.role = 'viewer'
        return json(real)
      }
      if (url.pathname === '/api/ai/folders' && req.method() === 'GET') return json({ items: folders })
      return pageFake(req)
    }, SOURCES_PAGE)
    await waitFor(viewer, () => !document.querySelector('.split-sidebar .agent-ask-row') && !!document.querySelector('.admin-viewer-banner'), null, 30_000)
    // 沒分組的那份上面已經移進「C320 除濕機」＝商品名就是組名
    await pickSource(viewer, loose.name)
    await waitFor(viewer, () => document.querySelectorAll('.src-chunk-row').length === 2, null, 15_000)
    await sleep(500)
    await shot(viewer, 'viewer-product-line.png', '.split-editor-header')
    const v = await viewer.evaluate(() => ({
      meta: document.querySelector('.src-header-meta')?.innerText.trim() ?? '',
      more: !!document.querySelector('.admin-header-actions .admin-more-btn'),
      ask: !!document.querySelector('[data-tour="kb-ask"]') || [...document.querySelectorAll('[data-tour="kb-ask-open"]')].some(e => e.offsetParent !== null),
      addOne: !!document.querySelector('.split-sidebar .agent-ask-row'),
    }))
    if (v.meta.endsWith('・AI 認的商品：C320 除濕機') && !v.more && !v.ask && !v.addOne) pass(`觀察者：沒有「⋯」、沒有問 AI、沒有補一條；名稱下面那一行照樣看得到「${v.meta}」`)
    else fail('觀察者看不到商品名、或看到了不能用的按鈕', JSON.stringify(v))
    await viewer.close()
  }

  // ── 第四十五段（`C-323`，`D-126` 第 4 步）：「產品名稱整理」搬進編輯分組的「客人還會怎麼叫它」——
  //    商品分組的名字那一格叫「商品名」（`D-127` 組名＝商品名）＋現有的叫法（標籤）；打字按 Enter 加、太短的當場擋、打了沒按 Enter 就按儲存也收；
  //    挑一個現有的商品名＝當成同一台，存之前先問（按「再想想」什麼都不送）；按儲存才送（先拿掉、再加）；
  //    通用那一組沒有這一塊；系統抓到的「可能是同一台」從待辦打開，視窗只剩確認那幾組；手機 390 寬不撐破 ──
  if (CHECK_FROM <= 45) {
    const REGEN = 'C323 筋牌特務 W1 REGEN'
    const folders = [
      // `D-127`：組名就是商品名（別名都指向它）
      { id: 'c323-prod', name: REGEN, order: 0, createdAtMs: NOW, general: false },
      { id: 'c323-faq', name: 'C323 客服', order: 1, createdAtMs: NOW, general: true },
    ]
    const src = fakeSource({ id: 'c323-a', type: 'file', name: 'C323 說明書', folderId: 'c323-prod', chunkCount: 1, productName: REGEN, summary: ['說明'] })
    const faq = fakeSource({ id: 'c323-b', type: 'file', name: 'C323 常見問題', folderId: 'c323-faq', chunkCount: 1, productName: '', summary: ['問答'] })
    const pageFake = fakeSourcesPage([src, faq], { 'c323-a': [fakeChunk({ id: 'a1', title: '保固' })], 'c323-b': [fakeChunk({ id: 'b1', title: '運費' })] })
    const health = { ...emptyHealthFake(), aliasCandidateCount: 1 }
    const aliasPosts = []
    const aliasesFake = {
      // aliasKey＝正規化後的別名（伺服器 normalizeProductName：去空白符號、小寫）
      pairs: [{ aliasKey: 'w1regen紅光', alias: 'W1 REGEN 紅光', canonical: REGEN }],
      candidates: [{ key: 'k1', a: 'C323 SHARP 自動調理零水鍋', b: 'C323 零水鍋', reason: '「C323 SHARP 自動調理零水鍋」包含「C323 零水鍋」，可能是同一台的全稱與簡稱', confidence: 'medium', variantRisk: false }],
      productNames: [REGEN, 'C323 SHARP 自動調理零水鍋', 'C323 零水鍋'],
    }
    const fake = async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      if (url.pathname === '/api/ai/folders' && m === 'GET') return json({ items: folders })
      if (url.pathname === '/api/ai/knowledge/health' && m === 'GET') return json(health)
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'GET') return json(aliasesFake)
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'POST') { aliasPosts.push(JSON.parse(req.postData() || '{}')); return json({ ok: true, changed: true }) }
      return pageFake(req)
    }
    const pg = await openImportDialog(fake, SOURCES_PAGE)
    await waitFor(pg, () => document.querySelectorAll('.src-folder-header').length === 2, null, 30_000)
    const openEdit = async (p, name) => {
      await p.evaluate(n => [...document.querySelectorAll('.src-folder-header')].find(e => e.querySelector('.src-folder-name')?.innerText.trim() === n)?.querySelector('.src-folder-icon-btn')?.click(), name)
      await waitFor(p, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
      await markShown(p, { title: '編輯分組' })
    }
    const aliasState = () => pg.evaluate(s => ({
      section: document.querySelector(`${s} .src-group-alias`)?.innerText ?? null,
      // `D-127`：名字那一格的標籤（商品分組＝「商品名」）和值
      label: document.querySelector(`${s} .folder-form .admin-field-group`)?.innerText.trim().split('\n')[0] ?? '',
      product: document.querySelector(`${s} .folder-form .admin-field-group input`)?.value ?? '',
      tags: [...document.querySelectorAll(`${s} .src-group-alias__tags .el-tag`)].map(t => t.innerText.trim()),
      draft: document.querySelector(`${s} .src-group-alias__input input`)?.value ?? null,
      saveDisabled: document.querySelector(`${s} .folder-footer-right .el-button--primary`)?.disabled ?? null,
    }), SHOWN)
    const clickSave = () => pg.evaluate(s => document.querySelector(`${s} .folder-footer-right .el-button--primary`)?.click(), SHOWN)
    const boxShown = () => waitFor(pg, () => [...document.querySelectorAll('.el-message-box')].some(b => b.offsetParent !== null), null, 5000)
    const boxText = () => pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.innerText.replace(/\s+/g, ' ') ?? '')

    // 打開商品分組：名字那一格叫「商品名」、現有的叫法是標籤、還沒改按不下去儲存
    await openEdit(pg, REGEN)
    await waitFor(pg, s => !!document.querySelector(`${s} .src-group-alias__input`), SHOWN, 10_000)
    const g0 = await aliasState()
    await shot(pg, 'group-alias.png', SHOWN)
    if (g0.section?.includes('客人還會怎麼叫它') && g0.label.startsWith('商品名') && g0.product === REGEN && !g0.section.includes('AI 認的商品名：') && g0.tags.join('|') === 'W1 REGEN 紅光' && g0.saveDisabled === true) pass('編輯分組：名字那一格叫「商品名」（`D-127` 組名＝商品名，不再另一行「AI 認的商品名」）、「客人還會怎麼叫它」現有的叫法是標籤；沒改按不下去儲存')
    else fail('編輯分組的「客人還會怎麼叫它」不對', JSON.stringify(g0))

    // 打一個叫法按 Enter → 變標籤；太短的（「鍋」）當場講、不收
    const input = `${SHOWN} .src-group-alias__input input`
    await typeInto(pg, input, '紅光儀')
    await pg.keyboard.press('Enter')
    await waitFor(pg, s => [...document.querySelectorAll(`${s} .src-group-alias__tags .el-tag`)].some(t => t.innerText.trim() === '紅光儀'), SHOWN, 5000)
    await typeInto(pg, input, '鍋')
    await pg.keyboard.press('Enter')
    const shortToast = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('叫法太短')), null, 5000)
    const g1 = await aliasState()
    if (g1.tags.join('|') === 'W1 REGEN 紅光|紅光儀' && shortToast && g1.saveDisabled === false) pass('打「紅光儀」按 Enter → 變標籤、儲存按得下去；打「鍋」（太短）→ 當場講「叫法太短…」、不收')
    else fail('加叫法不對', JSON.stringify({ g1, shortToast }))
    await typeInto(pg, input, '')

    // 打字時下拉列出像的現有商品名 → 挑一個＝當成同一台；拿掉舊的那個叫法；最後打一個不按 Enter
    await typeInto(pg, input, '零水')
    const sug = await waitFor(pg, () => [...document.querySelectorAll('.el-autocomplete-suggestion li')].filter(li => li.offsetParent !== null).length >= 2, null, 5000)
    const sugItems = await pg.evaluate(() => [...document.querySelectorAll('.el-autocomplete-suggestion li')].filter(li => li.offsetParent !== null).map(li => li.innerText.trim()))
    await pg.evaluate(() => [...document.querySelectorAll('.el-autocomplete-suggestion li')].find(li => li.offsetParent !== null && li.innerText.trim() === 'C323 零水鍋')?.click())
    await waitFor(pg, s => [...document.querySelectorAll(`${s} .src-group-alias__tags .el-tag`)].some(t => t.innerText.trim() === 'C323 零水鍋'), SHOWN, 5000)
    await pg.evaluate(s => [...document.querySelectorAll(`${s} .src-group-alias__tags .el-tag`)].find(t => t.innerText.trim() === 'W1 REGEN 紅光')?.querySelector('.el-tag__close')?.click(), SHOWN)
    await sleep(200)
    await typeInto(pg, input, '小紅燈')
    // 點標題收掉自動完成的下拉（⛔ 不按 Esc：會連視窗一起關掉）
    await pg.evaluate(s => document.querySelector(`${s} .el-dialog__title`)?.click(), SHOWN)
    await sleep(300)
    const g2 = await aliasState()
    if (sug && sugItems.includes('C323 零水鍋') && !sugItems.includes(REGEN) && g2.tags.join('|') === '紅光儀|C323 零水鍋' && g2.draft === '小紅燈') pass(`打「零水」→ 下拉列出像的現有商品名（${sugItems.join('、')}，不列它自己），挑一個變標籤；舊的叫法按 × 拿掉`)
    else fail('下拉或拿掉叫法不對', JSON.stringify({ sug, sugItems, g2 }))

    // 按儲存：挑了現有的商品名 → 先問「確認是同一台？」；按「再想想」→ 什麼都不送、視窗還開著，沒按 Enter 的那個也收成標籤了
    await clickSave()
    const box1 = await boxShown()
    const box1Text = await boxText()
    await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.querySelector('.el-message-box__btns .el-button:not(.el-button--primary)')?.click())
    await sleep(600)
    const g3 = await aliasState()
    if (box1 && box1Text.includes('「C323 零水鍋」現在是別的商品名') && box1Text.includes('不要這樣加') && aliasPosts.length === 0 && g3.tags.join('|') === '紅光儀|C323 零水鍋|小紅燈' && g3.draft === '') pass('挑了現有商品名按儲存 → 先問「「C323 零水鍋」現在是別的商品名…不要這樣加」；按「再想想」什麼都不送；框裡沒按 Enter 的「小紅燈」也收成標籤（不會被丟掉）')
    else fail('儲存前的確認不對', JSON.stringify({ box1, box1Text, aliasPosts, g3 }))

    // 再按儲存、這次說是同一台 → 先拿掉、再照順序加，視窗關掉
    await markShown(pg, { title: '編輯分組' })
    await clickSave()
    await boxShown()
    await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.querySelector('.el-message-box__btns .el-button--primary')?.click())
    const saved = await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
    const want = [
      { action: 'remove', alias: 'W1 REGEN 紅光' },
      { action: 'confirm', canonical: REGEN, alias: '紅光儀' },
      { action: 'confirm', canonical: REGEN, alias: 'C323 零水鍋' },
      { action: 'confirm', canonical: REGEN, alias: '小紅燈' },
    ]
    // 頁面的 apiFetch 會自己帶上 workspaceId，比對時拿掉
    const sent = aliasPosts.map(({ workspaceId, ...rest }) => rest)
    if (saved && JSON.stringify(sent) === JSON.stringify(want)) pass('說是同一台 → 送出：先拿掉「W1 REGEN 紅光」、再加「紅光儀」「C323 零水鍋」「小紅燈」（都指向那一台），視窗關掉')
    else fail('儲存送出去的不對', JSON.stringify({ saved, aliasPosts }))

    // 通用那一組沒有這一塊、名字那一格叫「名稱」；取消勾「通用」＝變成商品分組（`D-127` 組名就是商品名）→ 叫「商品名」、可以加叫法
    await sleep(500)
    await openEdit(pg, 'C323 客服')
    await sleep(500)
    const gen = await aliasState()
    await pg.evaluate(s => document.querySelector(`${s} .src-folder-general-check`)?.click(), SHOWN)
    await waitFor(pg, s => !!document.querySelector(`${s} .src-group-alias__input`), SHOWN, 8000)
    const genOff = await aliasState()
    if (gen.section === null && gen.label.startsWith('名稱') && genOff.label.startsWith('商品名') && genOff.section?.includes('客人還會怎麼叫它') && genOff.draft === '') pass('通用那一組沒有「客人還會怎麼叫它」、名字那一格叫「名稱」；取消勾通用＝商品分組 → 叫「商品名」、可以加叫法')
    else fail('通用那一組的叫法區塊不對', JSON.stringify({ gen, genOff }))
    await pg.evaluate(s => document.querySelector(`${s} .folder-footer-right .el-button:not(.el-button--primary)`)?.click(), SHOWN)
    await waitFor(pg, () => ![...document.querySelectorAll('.el-overlay')].some(o => getComputedStyle(o).display !== 'none'), null, 5000)

    // 系統抓到的「可能是同一台」：待辦那一列打開，視窗只剩確認那幾組（沒有「自己挑兩個合併」「已確認的對照」）
    await waitFor(pg, () => [...document.querySelectorAll('.src-todo__item')].some(e => e.innerText.includes('商品名可能是同一台')), null, 15_000)
    const todo = await pg.$$eval('.src-todo__item', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).find(t => t.includes('可能是同一台')) ?? '')
    await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('可能是同一台'))?.querySelector('.el-button')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '這幾個商品名是同一台嗎？' && d.querySelector('.src-alias-card')), null, 10_000)
    await markShown(pg, { title: '這幾個商品名是同一台嗎？' })
    await shot(pg, 'alias-candidates.png', SHOWN)
    const candText = await pg.$eval(SHOWN, e => e.innerText.replace(/\s+/g, ' '))
    const before = aliasPosts.length
    await pg.evaluate(s => [...document.querySelectorAll(`${s} .src-alias-actions .el-button`)].find(b => b.innerText.includes('是同一台'))?.click(), SHOWN)
    const mergedToast = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('要拿掉：那一組的「編輯分組」')), null, 5000)
    const last = aliasPosts[before] ?? {}
    if (todo.includes('有 1 組商品名可能是同一台') && candText.includes('C323 零水鍋') && !candText.includes('自己挑兩個合併') && !candText.includes('已確認的對照') && last.action === 'confirm' && last.canonical === 'C323 SHARP 自動調理零水鍋' && last.alias === 'C323 零水鍋' && mergedToast) pass('待辦「有 1 組商品名可能是同一台」→ 視窗只剩確認那幾組；按「是同一台」送出合併，講「要拿掉：那一組的「編輯分組」」')
    else fail('「可能是同一台」視窗不對', JSON.stringify({ todo, candText: candText.slice(0, 200), last, mergedToast }))
    await pg.close()

    // 手機 390 寬：叫法很長（併過來的舊商品名）也換行，不撐破視窗
    aliasesFake.pairs = [{ aliasKey: 'x', alias: 'C323 非常長的舊商品名稱多波長紅光舒緩儀專業版家用款含配件組合', canonical: REGEN }]
    const phone = await openImportDialog(fake, { ...SOURCES_PAGE, width: 390, height: 844 })
    await waitFor(phone, () => document.querySelectorAll('.src-folder-header').length === 2, null, 30_000)
    await openEdit(phone, REGEN)
    await waitFor(phone, s => !!document.querySelector(`${s} .src-group-alias__tags .el-tag`), SHOWN, 10_000)
    await sleep(300)
    if (process.env.SHOT_DIR) await (await phone.$(SHOWN))?.screenshot({ path: join(process.env.SHOT_DIR, 'c315', 'group-alias-phone.png') }).catch(() => {})
    const fit = await phone.evaluate((s) => {
      const d = document.querySelector(s)
      const body = d?.querySelector('.el-dialog__body')
      const tag = d?.querySelector('.src-group-alias__tags .el-tag')?.getBoundingClientRect()
      const box = d?.getBoundingClientRect()
      return { dw: Math.round(box?.width ?? 0), over: (body?.scrollWidth ?? 0) - (body?.clientWidth ?? 0), tagInside: !!tag && !!box && tag.right <= box.right + 0.5, vw: window.innerWidth, pageOver: document.documentElement.scrollWidth - window.innerWidth }
    }, SHOWN)
    if (fit.over <= 0 && fit.tagInside && fit.dw <= fit.vw && fit.pageOver <= 0) pass(`手機 390 寬：很長的叫法換行、不撐破編輯分組（視窗 ${fit.dw}px）`)
    else fail('手機上叫法撐破視窗', JSON.stringify(fit))
    await phone.close()
  }

  // ── 第四十六段（`D-127` 分組就是商品）：系統抓到的兩組其實是同一台 → 「是同一台」＝合成一組（資料搬過去、舊組名收成別名、刪掉空的那組）；
  //    改組名 → 伺服器回要重新學的那幾份＋舊名字收成別名，畫面一份份重新學、講一句；新增分組打了已經有的名字 → 不另建、講一句 ──
  if (CHECK_FROM <= 46) {
    const KEEP = 'C327 SHARP 自動調理零水鍋'
    const FROM = 'C327 零水鍋'
    const folders = [
      { id: 'c327-keep', name: KEEP, order: 0, createdAtMs: NOW, general: false },
      { id: 'c327-from', name: FROM, order: 1, createdAtMs: NOW, general: false },
    ]
    const s1 = fakeSource({ id: 'c327-a', type: 'file', name: 'C327 零水鍋說明書', folderId: 'c327-keep', chunkCount: 1, productName: KEEP, summary: ['說明'] })
    const s2 = fakeSource({ id: 'c327-b', type: 'file', name: 'C327 零水鍋食譜', folderId: 'c327-from', chunkCount: 1, productName: FROM, summary: ['食譜'] })
    const all = [s1, s2]
    const pageFake = fakeSourcesPage(all, { 'c327-a': [fakeChunk({ id: 'a1', title: '保固' })], 'c327-b': [fakeChunk({ id: 'b1', title: '燉牛肉' })] })
    const health = { ...emptyHealthFake(), aliasCandidateCount: 1 }
    const calls = []
    const aliasesFake = {
      pairs: [],
      candidates: [{ key: 'k1', a: KEEP, b: FROM, reason: `「${KEEP}」包含「${FROM}」，可能是同一台的全稱與簡稱`, confidence: 'medium', variantRisk: false }],
      productNames: [KEEP, FROM],
    }
    const fake = async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      const body = () => { const b = JSON.parse(req.postData() || '{}'); delete b.workspaceId; return b }
      if (url.pathname === '/api/ai/folders' && m === 'GET') return json({ items: folders })
      if (url.pathname === '/api/ai/folders' && m === 'POST') {
        const b = body()
        calls.push(`POST folders ${b.name}`)
        // 已經有同一台的那一組（只差空白大小寫）：伺服器回那一組、existed
        const same = folders.find(f => f.name.replace(/\s+/g, '').toLowerCase() === String(b.name).replace(/\s+/g, '').toLowerCase())
        return json(same ? { ...same, existed: true } : { id: 'c327-new', name: b.name, order: 9, createdAtMs: NOW, general: false })
      }
      if (url.pathname === '/api/ai/knowledge/health' && m === 'GET') return json(health)
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'GET') return json(aliasesFake)
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'POST') { const b = body(); calls.push(`alias ${b.alias}→${b.canonical}`); return json({ ok: true, changed: true }) }
      const sp = url.pathname.match(/^\/api\/ai\/sources\/(c327-[ab])$/)
      if (sp && m === 'PUT') {
        const b = body()
        const s = all.find(x => x.id === sp[1])
        calls.push(`move ${sp[1]}→${b.folderId}`)
        const previous = s.productName
        s.folderId = b.folderId
        s.productName = folders.find(f => f.id === b.folderId)?.name ?? ''
        return json({ ...s, groupSync: { productName: s.productName, previous, indexed: 1, failed: 0 } })
      }
      const ri = url.pathname.match(/^\/api\/ai\/sources\/(c327-[ab])\/reindex$/)
      if (ri && m === 'POST') { calls.push(`relearn ${ri[1]}`); return json({ indexed: 1, failed: 0 }) }
      const fp = url.pathname.match(/^\/api\/ai\/folders\/(c327-[a-z]+)$/)
      if (fp && m === 'DELETE') {
        calls.push(`delete ${fp[1]}`)
        const i = folders.findIndex(f => f.id === fp[1])
        if (i >= 0) folders.splice(i, 1)
        return json({ movedSources: 0, relearnSourceIds: [] })
      }
      if (fp && m === 'PUT') {
        const b = body()
        const f = folders.find(x => x.id === fp[1])
        // 合成一組（/code-review 第 9 條）：一個請求，伺服器照分組搬全部、舊組名收成別名、刪掉那一組，回要重新學的那幾份
        if (b.mergeInto) {
          calls.push(`merge ${fp[1]}→${b.mergeInto}`)
          const into = folders.find(x => x.id === b.mergeInto)
          const movedSrc = all.filter(s => s.folderId === f.id)
          for (const s of movedSrc) { s.folderId = into.id; s.productName = into.name }
          folders.splice(folders.indexOf(f), 1)
          return json({ merged: true, moved: movedSrc.length, relearnSourceIds: movedSrc.map(s => s.id), aliasFrom: f.name, fromName: f.name, intoName: into.name })
        }
        const old = f.name
        if (b.name) f.name = b.name
        calls.push(`rename ${old}→${f.name}`)
        // 改組名＝底下每一份換商品名、舊組名收成別名（同伺服器 folders PUT）
        const relearnSourceIds = all.filter(s => s.folderId === f.id).map((s) => { s.productName = f.name; return s.id })
        return json({ ...f, relearnSourceIds, aliasFrom: old })
      }
      return pageFake(req)
    }
    const pg = await openImportDialog(fake, SOURCES_PAGE)
    await waitFor(pg, () => document.querySelectorAll('.src-folder-header').length === 2, null, 30_000)

    // 兩組是同一台 → 合成一組
    await waitFor(pg, () => [...document.querySelectorAll('.src-todo__item')].some(e => e.innerText.includes('商品名可能是同一台')), null, 15_000)
    await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('可能是同一台'))?.querySelector('.el-button')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '這幾個商品名是同一台嗎？' && d.querySelector('.src-alias-card')), null, 10_000)
    await markShown(pg, { title: '這幾個商品名是同一台嗎？' })
    const candText = await pg.$eval(SHOWN, e => e.innerText.replace(/\s+/g, ' '))
    await pg.evaluate(s => [...document.querySelectorAll(`${s} .src-alias-actions .el-button`)].find(b => b.innerText.includes('是同一台'))?.click(), SHOWN)
    const mergedT = await waitFor(pg, ([k, f]) => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes(`已合成一組「${k}」（搬了 1 份），AI 把它們當成同一台；「${f}」留成客人的叫法`)), [KEEP, FROM], 10_000)
    const mergeRelearnT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 照新的商品名學好了 1 份資料')), null, 10_000)
    await sleep(300)
    const groupsAfter = await pg.$$eval('.src-folder-header .src-folder-name', els => els.map(e => e.innerText.trim()))
    const mergeCalls = calls.join('｜')
    if (candText.includes(`合成一組，留「${KEEP}」這一組`) && mergedT && mergeRelearnT && mergeCalls === 'merge c327-from→c327-keep｜relearn c327-b' && groupsAfter.join('|') === KEEP) pass(`兩組是同一台 →「是同一台」＝合成一組：先講「合成一組，留「${KEEP}」這一組」，一個請求搬全部（伺服器換商品名、舊組名收成別名、刪掉那一組）→ 搬過來的那份重新學（${mergeCalls}）`)
    else fail('合成一組不對', JSON.stringify({ candText: candText.slice(0, 200), mergedT, mergeRelearnT, calls, groupsAfter, toasts: await toastsOf(pg) }))
    await waitFor(pg, () => ![...document.querySelectorAll('.el-overlay')].some(o => getComputedStyle(o).display !== 'none'), null, 5000).catch(() => {})
    await pg.keyboard.press('Escape')
    await sleep(600)

    // 改組名 → 舊名字收成別名、底下兩份一份份重新學、講一句
    calls.length = 0
    await pg.evaluate(n => [...document.querySelectorAll('.src-folder-header')].find(e => e.querySelector('.src-folder-name')?.innerText.trim() === n)?.querySelector('.src-folder-icon-btn')?.click(), KEEP)
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
    await markShown(pg, { title: '編輯分組' })
    await waitFor(pg, s => !!document.querySelector(`${s} .src-group-alias__input`), SHOWN, 10_000)
    await typeInto(pg, `${SHOWN} .folder-form .admin-field-group input`, 'C327 SHARP HEALSIO 2.4L 自動調理零水鍋')
    await sleep(200)
    await pg.evaluate(s => document.querySelector(`${s} .folder-footer-right .el-button--primary`)?.click(), SHOWN)
    const savedAlias = await waitFor(pg, k => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes(`已儲存；舊名字「${k}」留成客人的叫法`)), KEEP, 8000)
    const relearnT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 照新的商品名學好了 2 份資料')), null, 10_000)
    const renameCalls = calls.join('｜')
    if (savedAlias && relearnT && renameCalls === `rename ${KEEP}→C327 SHARP HEALSIO 2.4L 自動調理零水鍋｜relearn c327-a｜relearn c327-b`) pass(`改組名 → 講「舊名字「${KEEP}」留成客人的叫法」，底下兩份一份份重新學、學完講「AI 重新學好了 2 份資料」（${renameCalls}）`)
    else fail('改組名之後沒有重新學或沒講舊名字', JSON.stringify({ savedAlias, relearnT, calls, toasts: await toastsOf(pg) }))

    // 新增分組打了已經有的名字（只差空白大小寫）→ 伺服器回那一組（existed）：講一句、⛔ 清單上不多一列
    calls.length = 0
    await sleep(600)
    await pg.click('[data-tour="kb-more"]')
    await waitFor(pg, () => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '新增分組'), null, 8000)
    await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].find(e => e.offsetParent !== null && e.innerText.trim() === '新增分組')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.el-message-box')].some(b => b.offsetParent !== null), null, 5000)
    const promptText = await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.innerText.replace(/\s+/g, ' ') ?? '')
    await typeInto(pg, '.el-message-box input', 'c327 sharp healsio 2.4l 自動調理零水鍋')
    await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.querySelector('.el-message-box__btns .el-button--primary')?.click())
    const existedT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('已經有「C327 SHARP HEALSIO 2.4L 自動調理零水鍋」這一組了')), null, 8000)
    await sleep(400)
    const rows = await pg.$$eval('.src-folder-header', els => els.length)
    if (promptText.includes('商品名就是分組的名字') && existedT && rows === 1) pass('新增分組講「商品名就是分組的名字」；打了已經有的名字 → 不另建、講「已經有「…」這一組了」，清單上不多一列')
    else fail('新增分組同名的處理不對', JSON.stringify({ promptText, existedT, rows, calls }))
    await pg.close()
  }

  // ── 第四十七段（`D-127` /code-review 第 4、10 條）：「客人還會怎麼叫它」打的是另一組的組名 → 存之前講「那一組的資料會搬進這一組」、
  //    說是同一台＝合成一組（⛔ 不是只記一條別名、左邊照樣兩組）；商品名換了 AI 還沒重新學的 →「要處理的事」列出來、一鍵補學 ──
  if (CHECK_FROM <= 47) {
    const A = 'C47 筋牌特務 W1 REGEN'
    const B = 'C47 W1 紅光槍'
    const folders = [
      { id: 'c47-a', name: A, order: 0, createdAtMs: NOW, general: false },
      { id: 'c47-b', name: B, order: 1, createdAtMs: NOW, general: false },
    ]
    const sa = fakeSource({ id: 'c47-sa', type: 'file', name: 'C47 說明書', folderId: 'c47-a', chunkCount: 1, productName: A, summary: ['說明'] })
    const sb = fakeSource({ id: 'c47-sb', type: 'file', name: 'C47 紅光槍 FAQ', folderId: 'c47-b', chunkCount: 1, productName: B, summary: ['問答'] })
    const sx = fakeSource({ id: 'c47-sx', type: 'file', name: 'C47 沒學完的那份', folderId: 'c47-a', chunkCount: 1, productName: A, summary: ['說明'] })
    const all = [sa, sb, sx]
    const pageFake = fakeSourcesPage(all, { 'c47-sa': [fakeChunk({ id: 'a1', title: '保固' })], 'c47-sb': [fakeChunk({ id: 'b1', title: '充電' })], 'c47-sx': [fakeChunk({ id: 'x1', title: '尺寸' })] })
    let pending = [{ id: 'c47-sx', name: sx.name }]
    const calls = []
    const fake = async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      const body = () => { const b = JSON.parse(req.postData() || '{}'); delete b.workspaceId; return b }
      if (url.pathname === '/api/ai/folders' && m === 'GET') return json({ items: folders })
      if (url.pathname === '/api/ai/knowledge/health' && m === 'GET') return json({ ...emptyHealthFake(), relearnPendingSources: pending })
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'GET') return json({ pairs: [], candidates: [], productNames: [A, B] })
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'POST') { const b = body(); calls.push(`alias ${b.alias}→${b.canonical}`); return json({ ok: true, changed: true }) }
      const ri = url.pathname.match(/^\/api\/ai\/sources\/(c47-s[abx])\/reindex$/)
      if (ri && m === 'POST') {
        calls.push(`relearn ${ri[1]}`)
        pending = pending.filter(p => p.id !== ri[1])
        return json({ indexed: 1, failed: 0 })
      }
      const fp = url.pathname.match(/^\/api\/ai\/folders\/(c47-[ab])$/)
      if (fp && m === 'PUT') {
        const b = body()
        const f = folders.find(x => x.id === fp[1])
        if (!b.mergeInto) { calls.push(`put ${JSON.stringify(b)}`); return json({ ...f, relearnSourceIds: [], aliasFrom: '' }) }
        calls.push(`merge ${fp[1]}→${b.mergeInto}`)
        const into = folders.find(x => x.id === b.mergeInto)
        const movedSrc = all.filter(s => s.folderId === f.id)
        for (const s of movedSrc) { s.folderId = into.id; s.productName = into.name }
        folders.splice(folders.indexOf(f), 1)
        return json({ merged: true, moved: movedSrc.length, relearnSourceIds: movedSrc.map(s => s.id), aliasFrom: f.name, fromName: f.name, intoName: into.name })
      }
      return pageFake(req)
    }
    const pg = await openImportDialog(fake, SOURCES_PAGE)
    await waitFor(pg, () => document.querySelectorAll('.src-folder-header').length === 2, null, 30_000)

    // `D-129`：商品名換了、AI 還沒重新學的（體檢就算還回 relearnPendingSources，舊伺服器）→ 排程自己補完，⛔「要處理的事」不再列、畫面不打學習
    const todosNow = await waitFor(pg, () => document.querySelectorAll('.src-todo__item').length > 0, null, 15_000)
      .then(() => pg.$$eval('.src-todo__item', els => els.map(e => e.innerText.trim())))
    await sleep(1500)
    if (!todosNow.some(t => t.includes('還沒重新學') || t.includes('重新學習')) && !calls.some(c => c.startsWith('relearn'))) pass('商品名換了 AI 還沒重新學 →「要處理的事」不再列、不叫他按（排程自己補完，`D-129`）')
    else fail('「還沒重新學」那一列還在／畫面自己打了學習', JSON.stringify({ todosNow, calls }))

    // 在 A 的「客人還會怎麼叫它」打 B 的組名 → 存之前講「那一組的資料會搬進這一組」；說是同一台 → 合成一組（⛔ 不送別名）
    calls.length = 0
    await sleep(500)
    await pg.evaluate(n => [...document.querySelectorAll('.src-folder-header')].find(e => e.querySelector('.src-folder-name')?.innerText.trim() === n)?.querySelector('.src-folder-icon-btn')?.click(), A)
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
    await markShown(pg, { title: '編輯分組' })
    await waitFor(pg, s => !!document.querySelector(`${s} .src-group-alias__input`), SHOWN, 10_000)
    await typeInto(pg, `${SHOWN} .src-group-alias__input input`, B)
    await pg.evaluate(s => document.querySelector(`${s} .el-dialog__title`)?.click(), SHOWN)
    await sleep(300)
    await pg.evaluate(s => document.querySelector(`${s} .folder-footer-right .el-button--primary`)?.click(), SHOWN)
    const box = await waitFor(pg, () => [...document.querySelectorAll('.el-message-box')].some(b => b.offsetParent !== null), null, 5000)
    const boxTxt = await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.innerText.replace(/\s+/g, ' ') ?? '')
    await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.querySelector('.el-message-box__btns .el-button--primary')?.click())
    const mergedT = await waitFor(pg, ([a, b]) => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes(`已合成一組「${a}」（搬了 1 份），AI 把它們當成同一台；「${b}」留成客人的叫法`)), [A, B], 10_000)
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 照新的商品名學好了 1 份資料')), null, 10_000)
    await sleep(300)
    const groupsAfter = await pg.$$eval('.src-folder-header .src-folder-name', els => els.map(e => e.innerText.trim()))
    const aliasCalls = calls.join('｜')
    if (box && boxTxt.includes(`「${B}」那一組的資料會搬進這一組，合成一組`) && mergedT && aliasCalls === 'merge c47-b→c47-a｜relearn c47-sb' && groupsAfter.join('|') === A) pass(`叫法打了另一組的組名 → 先講「「${B}」那一組的資料會搬進這一組」，說是同一台＝合成一組、⛔ 不只記別名（${aliasCalls}）`)
    else fail('叫法打了另一組的組名沒有合成一組', JSON.stringify({ box, boxTxt, mergedT, calls, groupsAfter, toasts: await toastsOf(pg) }))
    await pg.close()
  }

  // ── 第四十八段（`C-406` 分組三個視窗搬成元件）：前面幾段沒走到、而且是搬家後新接的那幾條線——
  //    「疑似重複 → 去合併商品名」帶過去的那一組排第一個（頁面傳給視窗）；「不是，兩台不同」送 dismiss、重算「要處理的事」（視窗通知頁面）；
  //    之後從待辦再打開不帶上一次那一組；編輯分組「刪除分組」→ 清單拿掉那一組、底下那份回到未分類、一份份重新學（視窗通知頁面） ──
  if (CHECK_FROM <= 48) {
    const G = 'C48 SHARP 乾淨方MAX'
    const LONG = 'C48 SHARP 乾淨方MAX 空氣清淨機 KC-JH70T'
    const SHORT = 'C48 乾淨方'
    const SYS = ['C48 甲型除濕機', 'C48 甲型']
    const folders = [{ id: 'c48-g', name: G, order: 0, createdAtMs: NOW, general: false }]
    const sa = fakeSource({ id: 'c48-sa', type: 'file', name: 'C48 乾淨方說明書', folderId: 'c48-g', chunkCount: 1, productName: G, summary: ['說明'] })
    const sb = fakeSource({ id: 'c48-sb', type: 'file', name: 'C48 沒分組的 FAQ', chunkCount: 1, productName: '', summary: ['問答'] })
    const all = [sa, sb]
    const pageFake = fakeSourcesPage(all, { 'c48-sa': [fakeChunk({ id: 'a1', title: '濾網' })], 'c48-sb': [fakeChunk({ id: 'b1', title: '運費' })] })
    const health = {
      ...emptyHealthFake(),
      aliasCandidateCount: 1,
      // 系統沒列成候選的一組（product_split）：只有從「疑似重複」帶過去才看得到
      duplicates: { scannedAtMs: NOW, items: [{
        key: 'd1', kind: 'product_split', similarity: 0.93, reason: '兩張卡講同一台的濾網，商品名寫法不同',
        a: { id: 'a1', title: '濾網多久換', productName: SHORT, sourceId: 'c48-sa' },
        b: { id: 'b9', title: '濾網更換', productName: LONG, sourceId: 'c48-sb' },
      }] },
    }
    const aliasesFake = {
      pairs: [],
      candidates: [{ key: 'k-sys', a: SYS[0], b: SYS[1], reason: `「${SYS[0]}」包含「${SYS[1]}」`, confidence: 'medium', variantRisk: false }],
      productNames: [G, LONG, SHORT, ...SYS],
    }
    const calls = []
    let healthGets = 0
    let aliasGets = 0
    const fake = async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      const body = () => { const b = JSON.parse(req.postData() || '{}'); delete b.workspaceId; return b }
      if (url.pathname === '/api/ai/folders' && m === 'GET') return json({ items: folders })
      if (url.pathname === '/api/ai/knowledge/health' && m === 'GET') { healthGets++; return json(health) }
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'GET') { aliasGets++; return json(aliasesFake) }
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'POST') { const b = body(); calls.push(`alias ${b.action} ${b.a}｜${b.b}`); return json({ ok: true, changed: true }) }
      const ri = url.pathname.match(/^\/api\/ai\/sources\/(c48-[a-z]+)\/reindex$/)
      // 重新學晚 1.5 秒回：學完頁面會重讀清單，太快的話「刪掉那一下有沒有馬上拿掉那一組」就被重讀蓋過去、驗不到
      if (ri && m === 'POST') { calls.push(`relearn ${ri[1]}`); await sleep(1500); return json({ indexed: 1, failed: 0 }) }
      const fp = url.pathname.match(/^\/api\/ai\/folders\/(c48-[a-z]+)$/)
      if (fp && m === 'DELETE') {
        calls.push(`delete ${fp[1]}`)
        // 同伺服器：底下的資料移到未分類、商品名清掉，回要重新學的那幾份
        const moved = all.filter(s => s.folderId === fp[1])
        for (const s of moved) { s.folderId = null; s.productName = '' }
        folders.splice(folders.findIndex(f => f.id === fp[1]), 1)
        return json({ movedSources: moved.length, relearnSourceIds: moved.map(s => s.id) })
      }
      return pageFake(req)
    }
    /** 在 node 這邊等（計數器、紀錄） */
    const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(100); return cond() }
    const shownCards = () => pg.$$eval(`${SHOWN} .src-alias-card .src-alias-pair`, els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()))
    const openAliasFromTodo = async () => {
      const before = aliasGets
      await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('可能是同一台'))?.querySelector('.el-button')?.click())
      await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '這幾個商品名是同一台嗎？'), null, 8000)
      await markShown(pg, { title: '這幾個商品名是同一台嗎？' })
      // 等這一次打開的讀取回來（⛔ 不能只看張數：上一次讀到的還留在畫面上）
      await until(() => aliasGets > before)
      await sleep(400)
    }
    const closeDialogs = async () => {
      await pg.keyboard.press('Escape')
      await waitFor(pg, () => ![...document.querySelectorAll('.el-overlay')].some(o => getComputedStyle(o).display !== 'none'), null, 5000)
      await sleep(400)
    }

    const pg = await openImportDialog(fake, SOURCES_PAGE)
    await waitFor(pg, () => document.querySelectorAll('.src-folder-header').length === 1, null, 30_000)

    // 疑似重複 → 去合併商品名：那一組排第一個（比較長的當正式名），系統列的候選排後面
    await waitFor(pg, () => [...document.querySelectorAll('.src-todo__item')].some(e => e.innerText.includes('疑似重複')), null, 15_000)
    await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('疑似重複'))?.querySelector('.el-button')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '疑似重複的知識'), null, 8000)
    const aliasBefore = aliasGets
    await pg.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '疑似重複的知識')
      ;[...(dlg?.querySelectorAll('.el-button') ?? [])].find(b => b.innerText.includes('去合併商品名'))?.click()
    })
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '這幾個商品名是同一台嗎？' && d.querySelectorAll('.src-alias-card').length === 2), null, 10_000)
    await markShown(pg, { title: '這幾個商品名是同一台嗎？' })
    await until(() => aliasGets > aliasBefore)
    await sleep(300)
    const pinnedCards = await shownCards()
    if (pinnedCards.length === 2 && pinnedCards[0] === `「${LONG}」＝「${SHORT}」？` && pinnedCards[1] === `「${SYS[0]}」＝「${SYS[1]}」？`) pass(`疑似重複 →「去合併商品名」：系統沒列的那一組帶進去排第一個（比較長的「${LONG}」當正式名），系統列的候選排後面`)
    else fail('去合併商品名帶過去的那一組不對', JSON.stringify({ pinnedCards }))

    // 「不是，兩台不同」→ 送 dismiss（兩個名字原樣）、講一句、重算「要處理的事」、重讀候選（帶過去的那一組不再出現）
    const healthBefore = healthGets
    await pg.evaluate(s => [...document.querySelector(`${s} .src-alias-card`)?.querySelectorAll('.src-alias-actions .el-button') ?? []].find(b => b.innerText.includes('不是'))?.click(), SHOWN)
    const dismissT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('好的，不再詢問這一組')), null, 8000)
    const healthRe = await until(() => healthGets > healthBefore)
    await sleep(300)
    const afterDismiss = await shownCards()
    if (dismissT && healthRe && calls.join('｜') === `alias dismiss ${LONG}｜${SHORT}` && afterDismiss.length === 1 && afterDismiss[0] === `「${SYS[0]}」＝「${SYS[1]}」？`) pass(`「不是，兩台不同」→ 只送 dismiss（${calls.join('｜')}）、講「好的，不再詢問這一組」、重算「要處理的事」，清單剩系統列的那一組`)
    else fail('「不是，兩台不同」不對', JSON.stringify({ dismissT, healthRe, calls, afterDismiss }))
    await closeDialogs()

    // 從待辦「前往確認」再打開：⛔ 不帶上一次從疑似重複帶過去的那一組
    await openAliasFromTodo()
    const fromTodo = await shownCards()
    if (fromTodo.length === 1 && fromTodo[0] === `「${SYS[0]}」＝「${SYS[1]}」？`) pass('從待辦「前往確認」再打開：只列系統的候選，不帶上一次從疑似重複帶過去的那一組')
    else fail('從待辦打開時帶到上一次那一組', JSON.stringify({ fromTodo }))
    await closeDialogs()

    // 編輯分組 →「刪除分組」：先講底下幾份會移到未分類 → 刪了清單拿掉那一組、那份回到未分類、一份份重新學
    calls.length = 0
    await pg.evaluate(n => [...document.querySelectorAll('.src-folder-header')].find(e => e.querySelector('.src-folder-name')?.innerText.trim() === n)?.querySelector('.src-folder-icon-btn')?.click(), G)
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
    await markShown(pg, { title: '編輯分組' })
    await waitFor(pg, s => !!document.querySelector(`${s} .src-group-alias__input`), SHOWN, 10_000)
    const editTxt = await pg.$eval(SHOWN, e => e.innerText.replace(/\s+/g, ' '))
    await pg.evaluate(s => document.querySelector(`${s} .folder-footer .el-button--danger`)?.click(), SHOWN)
    const box = await waitFor(pg, () => [...document.querySelectorAll('.el-message-box')].some(b => b.offsetParent !== null), null, 5000)
    const boxTxt = await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.innerText.replace(/\s+/g, ' ') ?? '')
    await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.querySelector('.el-message-box__btns .el-button--danger')?.click())
    const delT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('已刪除分組，1 份資料移到了未分類')), null, 8000)
    // 刪掉那一下（重新學還沒回來、清單還沒重讀）：那一組就要不見、那份就要在未分類
    const heads = await pg.$$eval('.src-folder-header', els => els.length)
    const loose = await pg.$$eval('.split-list > .flow-sidebar-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ')))
    // 視窗關掉有淡出動畫：等它關完（⛔ 跳出提示那一下量會量到淡出到一半）
    const editClosed = await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 3000)
    const relearnT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 照新的商品名學好了 1 份資料')), null, 10_000)
    const delCalls = calls.join('｜')
    if (editTxt.includes('目前底下 1 份資料') && box && boxTxt.includes('底下的 1 份資料會移到「未分類」') && delT && relearnT && editClosed && delCalls === 'delete c48-g｜relearn c48-sa' && heads === 0 && loose.some(t => t.includes('C48 乾淨方說明書'))) pass(`編輯分組 →「刪除分組」：先講「底下的 1 份資料會移到「未分類」」，刪了當下清單就拿掉那一組、那份回到未分類，接著重新學（${delCalls}）`)
    else fail('刪除分組不對', JSON.stringify({ editTxt: editTxt.slice(0, 160), box, boxTxt, delT, relearnT, editClosed, calls, heads, loose, toasts: await toastsOf(pg) }))
    await pg.close()
  }

  // ── 第四十九段（`C-407`，`C-406` 的 code review）：拆檔前就有的幾個小毛病——
  //    ①改名成功、加叫法失敗 → 重讀叫法照新名字（原本的叫法還在、儲存鈕不再亮）；②又改名又併組 → 重新學只跑一條、一份份學、「學好了」只講一次；
  //    ③疑似重複帶進來的那一組，先處理別組也不會消失；④讀不到候選時講「讀不到」、⛔ 不擺上一次的清單；
  //    ⑤存／搬到一半按 ESC、叉叉關不掉、「取消」鎖住（編輯分組、移到哪一組） ──
  if (CHECK_FROM <= 49) {
    const A0 = 'C49 W1 REGEN'
    const A1 = 'C49 W1 REGEN 紅光治療儀'
    const A2 = 'C49 W1 REGEN 二代'
    const C = 'C49 紅光槍組'
    const B0 = 'C49 乾淨方MAX'
    const B1 = 'C49 乾淨方MAX 二代'
    const LONG = 'C49 SHARP 乾淨方MAX 空氣清淨機 KC-JH70T'
    const SHORT = 'C49 乾淨方'
    const SYS = ['C49 甲型除濕機', 'C49 甲型']
    const folders = [
      { id: 'c49-a', name: A0, order: 0, createdAtMs: NOW, general: false },
      { id: 'c49-b', name: B0, order: 1, createdAtMs: NOW, general: false },
      { id: 'c49-c', name: C, order: 2, createdAtMs: NOW, general: false },
    ]
    const sa = fakeSource({ id: 'c49-sa', type: 'file', name: 'C49 紅光說明書', folderId: 'c49-a', chunkCount: 1, productName: A0, summary: ['說明'] })
    const sb = fakeSource({ id: 'c49-sb', type: 'file', name: 'C49 乾淨方說明書', folderId: 'c49-b', chunkCount: 1, productName: B0, summary: ['說明'] })
    const sc = fakeSource({ id: 'c49-sc', type: 'file', name: 'C49 紅光槍 FAQ', folderId: 'c49-c', chunkCount: 1, productName: C, summary: ['問答'] })
    const sx = fakeSource({ id: 'c49-sx', type: 'file', name: 'C49 沒分組的檔案', chunkCount: 1, productName: '', summary: ['說明'] })
    const all = [sa, sb, sc, sx]
    const pageFake = fakeSourcesPage(all, Object.fromEntries(all.map(s => [s.id, [fakeChunk({ id: `${s.id}-1`, title: '內容' })]])))
    const health = {
      ...emptyHealthFake(),
      aliasCandidateCount: 1,
      duplicates: { scannedAtMs: NOW, items: [{
        key: 'd49', kind: 'product_split', similarity: 0.93, reason: '兩張卡講同一台的濾網，商品名寫法不同',
        a: { id: 'x1', title: '濾網多久換', productName: SHORT, sourceId: 'c49-sb' },
        b: { id: 'x2', title: '濾網更換', productName: LONG, sourceId: 'c49-sx' },
      }] },
    }
    const aliasesFake = {
      pairs: [{ aliasKey: 'c49紅光槍', alias: 'C49 紅光槍', canonical: A0 }],
      candidates: [{ key: 'k49', a: SYS[0], b: SYS[1], reason: `「${SYS[0]}」包含「${SYS[1]}」`, confidence: 'medium', variantRisk: false }],
      productNames: [A0, B0, C, LONG, SHORT, ...SYS],
    }
    const fail500 = msg => ({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, statusMessage: msg }) })
    const calls = []
    const folderPuts = []
    let aliasGets = 0
    let aliasGetFail = false
    let failAlias = ''
    let folderPutDelay = 0
    let sourcePutDelay = 0
    let inFlight = 0
    let maxInFlight = 0
    const fake = async (req) => {
      const url = new URL(req.url())
      const m = req.method()
      const body = () => { const b = JSON.parse(req.postData() || '{}'); delete b.workspaceId; return b }
      if (url.pathname === '/api/ai/folders' && m === 'GET') return json({ items: folders })
      if (url.pathname === '/api/ai/knowledge/health' && m === 'GET') return json(health)
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'GET') { aliasGets++; return aliasGetFail ? fail500('測試：讀不到') : json(aliasesFake) }
      if (url.pathname === '/api/ai/knowledge/product-aliases' && m === 'POST') {
        const b = body()
        calls.push(`alias ${b.action} ${b.alias ?? b.a}`)
        if (failAlias && b.alias === failAlias) return fail500('測試：叫法沒存成')
        if (b.action === 'confirm') aliasesFake.pairs.push({ aliasKey: b.alias, alias: b.alias, canonical: b.canonical })
        if (b.action === 'dismiss') aliasesFake.candidates = aliasesFake.candidates.filter(c => !(c.a === b.a && c.b === b.b))
        return json({ ok: true, changed: true })
      }
      const ri = url.pathname.match(/^\/api\/ai\/sources\/(c49-[a-z]+)\/reindex$/)
      if (ri && m === 'POST') {
        // 記同時有幾份在學（一份份學＝最多 1）
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        calls.push(`relearn ${ri[1]}`)
        await sleep(800)
        inFlight--
        return json({ indexed: 1, failed: 0 })
      }
      const sp = url.pathname.match(/^\/api\/ai\/sources\/(c49-[a-z]+)$/)
      if (sp && m === 'PUT') {
        const b = body()
        await sleep(sourcePutDelay)
        const s = all.find(x => x.id === sp[1])
        const previous = s.productName
        s.folderId = b.folderId
        s.productName = folders.find(f => f.id === b.folderId)?.name ?? ''
        calls.push(`move ${sp[1]}→${b.folderId}`)
        return json({ ...s, groupSync: { productName: s.productName, previous, indexed: 1, failed: 0 } })
      }
      const fp = url.pathname.match(/^\/api\/ai\/folders\/(c49-[a-z]+)$/)
      if (fp && m === 'PUT') {
        const b = body()
        const f = folders.find(x => x.id === fp[1])
        if (b.mergeInto) {
          calls.push(`merge ${fp[1]}→${b.mergeInto}`)
          const into = folders.find(x => x.id === b.mergeInto)
          const moved = all.filter(s => s.folderId === f.id)
          for (const s of moved) { s.folderId = into.id; s.productName = into.name }
          folders.splice(folders.indexOf(f), 1)
          aliasesFake.pairs.push({ aliasKey: f.name, alias: f.name, canonical: into.name })
          return json({ merged: true, moved: moved.length, relearnSourceIds: moved.map(s => s.id), aliasFrom: f.name })
        }
        folderPuts.push(`${fp[1]}→${b.name}`)
        await sleep(folderPutDelay)
        const old = f.name
        if (b.name) f.name = b.name
        // 同伺服器：改組名＝指向舊名字的叫法改指新名字、舊組名收成叫法、底下每份換商品名要重新學
        for (const p of aliasesFake.pairs) if (p.canonical === old) p.canonical = f.name
        aliasesFake.pairs.push({ aliasKey: old, alias: old, canonical: f.name })
        const relearnSourceIds = all.filter(s => s.folderId === f.id).map((s) => { s.productName = f.name; return s.id })
        return json({ ...f, relearnSourceIds, aliasFrom: old })
      }
      return pageFake(req)
    }
    const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(100); return cond() }
    const dialogOpen = t => pg.evaluate(x => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === x), t)
    const waitDialog = t => waitFor(pg, x => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === x), t, 8000)
    const waitNoOverlay = async () => { await waitFor(pg, () => ![...document.querySelectorAll('.el-overlay')].some(o => getComputedStyle(o).display !== 'none'), null, 8000); await sleep(400) }
    const openEdit = async (name) => {
      await pg.evaluate(n => [...document.querySelectorAll('.src-folder-header')].find(e => e.querySelector('.src-folder-name')?.innerText.trim() === n)?.querySelector('.src-folder-icon-btn')?.click(), name)
      await waitDialog('編輯分組')
      await markShown(pg, { title: '編輯分組' })
      await waitFor(pg, s => !!document.querySelector(`${s} .src-group-alias__input`), SHOWN, 10_000)
    }
    const editTags = () => pg.$$eval(`${SHOWN} .src-group-alias__tags .el-tag`, els => els.map(e => e.innerText.trim()))
    const shownCards = () => pg.$$eval(`${SHOWN} .src-alias-card .src-alias-pair`, els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()))
    /** 頁面上出現過的每一則提示（提示 3.5 秒就收掉，用輪詢會數漏） */
    const toastLog = () => pg.evaluate(() => window.__c49Toasts.slice())

    const pg = await openImportDialog(fake, SOURCES_PAGE)
    await waitFor(pg, () => document.querySelectorAll('.src-folder-header').length === 3, null, 30_000)
    await pg.evaluate(() => {
      window.__c49Toasts = []
      new MutationObserver((ms) => {
        for (const mu of ms) {
          for (const n of mu.addedNodes) {
            if (n.nodeType !== 1) continue
            for (const e of (n.matches('.toast') ? [n] : [...n.querySelectorAll('.toast')])) window.__c49Toasts.push(e.innerText)
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    })

    // ① 改名成功、加叫法那一步失敗：視窗留著，叫法照新名字重讀（原本的「C49 紅光槍」＋舊組名都在），名字已經存了＝儲存鈕不亮
    await openEdit(A0)
    await typeInto(pg, `${SHOWN} .folder-form .admin-field-group input`, A1)
    await typeInto(pg, `${SHOWN} .src-group-alias__input input`, '筋牌')
    failAlias = '筋牌'
    await pg.evaluate(s => document.querySelector(`${s} .folder-footer-right .el-button--primary`)?.click(), SHOWN)
    const errT = await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('叫法沒存成') || t.innerText.includes('儲存失敗')), null, 8000)
    await waitFor(pg, s => document.querySelectorAll(`${s} .src-group-alias__tags .el-tag`).length > 0, SHOWN, 5000)
    await sleep(300)
    const stillOpen1 = await dialogOpen('編輯分組')
    const tags1 = (await editTags()).sort()
    const saveDisabled1 = await pg.$eval(`${SHOWN} .folder-footer-right .el-button--primary`, e => e.disabled).catch(() => null)
    failAlias = ''
    if (errT && stillOpen1 && tags1.join('|') === [A0, 'C49 紅光槍'].sort().join('|') && saveDisabled1 === true && folderPuts.length === 1) pass(`改名成功、加叫法失敗：視窗留著、叫法照新名字重讀（${tags1.join('、')} 都在），名字已經存了＝儲存鈕不亮、不會再送一次改名`)
    else fail('改名後加叫法失敗，叫法或儲存鈕不對', JSON.stringify({ errT, stillOpen1, tags1, saveDisabled1, folderPuts }))
    await pg.evaluate(s => [...document.querySelectorAll(`${s} .folder-footer-right .el-button`)].find(b => b.innerText.includes('取消'))?.click(), SHOWN)
    await waitNoOverlay()
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 照新的商品名學好了')), null, 10_000)
    await until(() => inFlight === 0, 10_000)
    await sleep(600)

    // ② 同一次儲存又改名又併組：重新學只跑一條、一份份學（同時最多 1 份）、「學好了」只講一次（2 份）
    await pg.evaluate(() => { window.__c49Toasts = [] })
    maxInFlight = 0
    calls.length = 0
    await openEdit(A1)
    await typeInto(pg, `${SHOWN} .folder-form .admin-field-group input`, A2)
    await typeInto(pg, `${SHOWN} .src-group-alias__input input`, C)
    await pg.evaluate(s => document.querySelector(`${s} .folder-footer-right .el-button--primary`)?.click(), SHOWN)
    const box2 = await waitFor(pg, () => [...document.querySelectorAll('.el-message-box')].some(b => b.offsetParent !== null), null, 5000)
    await pg.evaluate(() => [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)?.querySelector('.el-message-box__btns .el-button--primary')?.click())
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('AI 照新的商品名學好了')), null, 15_000)
    // 第二條（如果有）會晚一點才講：多等一下再數
    await until(() => inFlight === 0, 10_000)
    await sleep(2500)
    const learned = (await toastLog()).filter(t => t.includes('AI 照新的商品名學好了'))
    const relearns = calls.filter(c => c.startsWith('relearn')).sort()
    if (box2 && maxInFlight === 1 && learned.length === 1 && learned[0].includes('2 份資料') && calls.includes('merge c49-c→c49-a') && relearns.join('|') === 'relearn c49-sa|relearn c49-sc') pass(`又改名又併組：重新學只跑一條、一份份學（同時最多 ${maxInFlight} 份）、「${learned[0]}」只講一次`)
    else fail('又改名又併組，重新學跑了兩條或講了兩次', JSON.stringify({ box2, maxInFlight, learned, calls }))
    await waitNoOverlay()

    // ③ 疑似重複帶進來的那一組：先處理系統列的另一組（不是，兩台不同），帶進來的那一組還在
    await waitFor(pg, () => [...document.querySelectorAll('.src-todo__item')].some(e => e.innerText.includes('疑似重複')), null, 15_000)
    await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('疑似重複'))?.querySelector('.el-button')?.click())
    await waitDialog('疑似重複的知識')
    let before = aliasGets
    await pg.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '疑似重複的知識')
      ;[...(dlg?.querySelectorAll('.el-button') ?? [])].find(b => b.innerText.includes('去合併商品名'))?.click()
    })
    await waitFor(pg, () => [...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '這幾個商品名是同一台嗎？' && d.querySelectorAll('.src-alias-card').length === 2), null, 10_000)
    await markShown(pg, { title: '這幾個商品名是同一台嗎？' })
    await until(() => aliasGets > before)
    await sleep(300)
    before = aliasGets
    await pg.evaluate(s => [...[...document.querySelectorAll(`${s} .src-alias-card`)][1]?.querySelectorAll('.src-alias-actions .el-button') ?? []].find(b => b.innerText.includes('不是'))?.click(), SHOWN)
    await waitFor(pg, () => [...document.querySelectorAll('.toast')].some(t => t.innerText.includes('好的，不再詢問這一組')), null, 8000)
    await until(() => aliasGets > before)
    await sleep(400)
    const afterOther = await shownCards()
    if (afterOther.length === 1 && afterOther[0] === `「${LONG}」＝「${SHORT}」？`) pass('疑似重複帶進來的那一組：先處理系統列的另一組（不是，兩台不同），帶進來的那一組還在、還排第一個')
    else fail('先處理別組之後，疑似重複帶進來的那一組不見了', JSON.stringify({ afterOther, calls }))
    await pg.keyboard.press('Escape')
    await waitNoOverlay()

    // ④ 讀不到候選：講「讀不到」，⛔ 不擺上一次的清單（上一次還有帶進來的那一組）
    aliasGetFail = true
    before = aliasGets
    await pg.evaluate(() => [...document.querySelectorAll('.src-todo__item')].find(e => e.innerText.includes('可能是同一台'))?.querySelector('.el-button')?.click())
    await waitDialog('這幾個商品名是同一台嗎？')
    await markShown(pg, { title: '這幾個商品名是同一台嗎？' })
    await until(() => aliasGets > before)
    await sleep(500)
    const failTxt = await pg.$eval(SHOWN, e => e.innerText.replace(/\s+/g, ' '))
    const failCards = await shownCards()
    aliasGetFail = false
    if (failTxt.includes('讀不到，關掉再打開一次試試。') && failCards.length === 0) pass('「可能是同一台」讀不到：講「讀不到，關掉再打開一次試試。」，不擺上一次的清單（也沒有按鈕可按）')
    else fail('讀不到候選時擺出上一次的清單', JSON.stringify({ failCards, failTxt: failTxt.slice(0, 160) }))
    await pg.keyboard.press('Escape')
    await waitNoOverlay()

    // ⑤ 編輯分組存到一半：ESC、叉叉關不掉、「取消」鎖住；存完自己關
    await openEdit(B0)
    await typeInto(pg, `${SHOWN} .folder-form .admin-field-group input`, B1)
    folderPutDelay = 2500
    await pg.evaluate(s => document.querySelector(`${s} .folder-footer-right .el-button--primary`)?.click(), SHOWN)
    await sleep(300)
    await pg.keyboard.press('Escape')
    await sleep(300)
    await pg.evaluate(s => document.querySelector(`${s} .el-dialog__headerbtn`)?.click(), SHOWN)
    await sleep(400)
    const editStillOpen = await dialogOpen('編輯分組')
    const cancelLocked = await pg.$eval(SHOWN, d => [...d.querySelectorAll('.folder-footer-right .el-button')].find(b => b.innerText.includes('取消'))?.disabled ?? null).catch(() => null)
    const editClosedAfter = await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '編輯分組'), null, 8000)
    folderPutDelay = 0
    if (editStillOpen && cancelLocked === true && editClosedAfter) pass('編輯分組存到一半：ESC、叉叉關不掉，「取消」鎖住；存完自己關')
    else fail('編輯分組存到一半關得掉', JSON.stringify({ editStillOpen, cancelLocked, editClosedAfter }))
    await waitNoOverlay()

    // ⑤ 移到哪一組搬到一半：一樣關不掉；搬完自己關
    await pickSource(pg, sx.name)
    await waitFor(pg, n => document.querySelector('.src-header-main input')?.value === n, sx.name, 15_000)
    await pg.click('.admin-header-actions .admin-more-btn')
    await waitFor(pg, () => [...document.querySelectorAll('.el-dropdown-menu__item')].some(e => e.offsetParent !== null && e.innerText.trim() === '移到哪一組'), null, 8000)
    await pg.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')].find(e => e.offsetParent !== null && e.innerText.trim() === '移到哪一組')?.click())
    await waitDialog('移到哪一組')
    await markShown(pg, { title: '移到哪一組' })
    await pg.click(`${SHOWN} .src-move-select .el-select__wrapper`)
    await waitFor(pg, n => [...document.querySelectorAll('.el-select-dropdown__item')].some(e => e.offsetParent !== null && e.innerText.trim() === n), B1, 5000)
    await pg.evaluate(n => [...document.querySelectorAll('.el-select-dropdown__item')].find(e => e.offsetParent !== null && e.innerText.trim() === n)?.click(), B1)
    await sleep(300)
    sourcePutDelay = 2500
    await pg.evaluate(s => document.querySelector(`${s} .el-dialog__footer .el-button--primary`)?.click(), SHOWN)
    await sleep(300)
    await pg.keyboard.press('Escape')
    await sleep(300)
    await pg.evaluate(s => document.querySelector(`${s} .el-dialog__headerbtn`)?.click(), SHOWN)
    await sleep(400)
    const moveStillOpen = await dialogOpen('移到哪一組')
    const moveClosedAfter = await waitFor(pg, () => ![...document.querySelectorAll('.el-dialog')].some(d => d.offsetParent !== null && d.querySelector('.el-dialog__title')?.innerText === '移到哪一組'), null, 8000)
    sourcePutDelay = 0
    if (moveStillOpen && moveClosedAfter && calls.includes('move c49-sx→c49-b')) pass('移到哪一組搬到一半：ESC、叉叉關不掉；搬完自己關')
    else fail('移到哪一組搬到一半關得掉', JSON.stringify({ moveStillOpen, moveClosedAfter, calls }))
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
