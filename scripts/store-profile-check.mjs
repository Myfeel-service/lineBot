/**
 * 「認識你的店」的實機守門員（2026-09-22，`D-85` / `C-217`＋`C-219`）。
 *
 *   npm run dev -- --port 3307                                        # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://127.0.0.1:3307 node --env-file=.env_myfeel scripts/store-profile-check.mjs
 *
 * **為什麼一定要真的開瀏覽器**：這一輪加的東西，typecheck 與單元測試一條都驗不到——
 * 純函式有 42 條測試、守門測試釘住了字串，但「那張卡有沒有真的被渲染出來」「精靈走到
 * 第二格會不會真的問出五題」全部沒有人驗過。這個專案吃過九次「typecheck 綠＋測試綠，
 * 但新程式根本沒被執行到」（記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * ⚠️ **連正式資料庫（myfeel），但全程零寫入**：
 *    - 只讀 `workspaceMembers` 找一個管理員換 token（唯讀）
 *    - 瀏覽器端**所有非 GET 請求一律攔截**，沒被指名的直接擋成 500——
 *      ⛔ 精靈的第一步會呼叫 `/api/onboarding/self-serve`（真的會建組織＋工作區），
 *      漏攔一支就是在正式庫多出一個測試帳號。
 *    - ⛔ 也不碰 `adminUserPrefs`（既有守門員會寫再還原；這支改成在瀏覽器裡把導覽關掉，
 *      少一種「還原失敗就留下髒資料」的可能）。
 *
 * ⛔ **內建對照組**：每一關都先斷言「這個東西本來不在」再斷言「做完之後在」。
 *    少了前半，選擇器只要寫成一個到處都在的東西，整份就是假綠燈。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://127.0.0.1:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

const {
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_CLIENT_EMAIL: clientEmail,
  FIREBASE_PRIVATE_KEY: privateKey,
  FIREBASE_API_KEY: apiKey,
} = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）')
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

let failed = false
const fail = msg => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

/** 被攔下來的寫入請求（跑完印出來，證明真的一個都沒送出去） */
const blocked = []

/**
 * @param {{fakeWrites?: (url:string)=>any, fakeReads?: (url:string)=>any}} [opts]
 *   `fakeReads` 只在**需要假造既有資料**時用（例如正式庫刻意沒有輪廓，
 *   但要驗「有輪廓的人看到什麼」）。⛔ 別拿它來蓋掉本來就該量到的東西。
 */
async function openLoggedInPage({ fakeWrites, fakeReads } = {}) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  // ⛔ 原生 confirm 會把 JS 執行緒整個卡死到 puppeteer 逾時（看起來像頁面壞了）
  page.on('dialog', async d => { await d.accept().catch(() => {}) })

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    const method = req.method()
    if (method === 'GET' || method === 'OPTIONS' || !url.includes('/api/')) {
      const fake = method === 'GET' ? fakeReads?.(url) : null
      if (fake) {
        req.respond({ status: fake.status ?? 200, contentType: 'application/json', body: JSON.stringify(fake.body ?? {}) })
        return
      }
      req.continue()
      return
    }
    // 到這裡的都是會寫東西的請求
    blocked.push(`${method} ${url.replace(BASE, '')}`)
    const fake = fakeWrites?.(url)
    if (fake) {
      req.respond({ status: fake.status ?? 200, contentType: 'application/json', body: JSON.stringify(fake.body ?? {}) })
      return
    }
    // ⛔ 沒被指名的寫入一律擋掉：漏一支就是在正式庫寫了東西
    req.respond({ status: 500, contentType: 'application/json', body: '{"statusMessage":"測試攔截：這支沒被指名"}' })
  })

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

/** 自動導覽會蓋住整個畫面，先關掉再量，否則「點不到」會被誤報成「元件沒出來」 */
async function dismissOverlays(page) {
  for (let i = 0; i < 12; i++) {
    const open = await page.evaluate(() => [...document.querySelectorAll('.el-tour')]
      .some(el => el.getBoundingClientRect().width > 0))
    if (!open) break
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.el-tour__footer .el-button')]
      b[b.length - 1]?.click()
    })
    await sleep(400)
  }
  await sleep(300)
}

const visible = (page, sel) => page.evaluate(s =>
  [...document.querySelectorAll(s)].filter(el => el.getBoundingClientRect().width > 0).length, sel)

const textOf = (page, sel) => page.evaluate(s =>
  [...document.querySelectorAll(s)].map(el => el.textContent.replace(/\s+/g, ' ').trim()).join(' | '), sel)

/**
 * 點畫面上第一個文字符合的可見元素。
 * ⚠️ **一定要重試**：泡泡出現 ≠ 選項出現——`say()` 有打字動畫，選項是那之後才渲染的。
 * 不重試的話，同一份程式碼會忽紅忽綠，取決於這台機器那一刻多快
 * （`reference_headless_admin_harness_traps` 記的就是這一型）。
 */
async function clickByText(page, selector, text, timeoutMs = 12_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate((sel, t) => {
      const el = [...document.querySelectorAll(sel)]
        .find(e => e.textContent.replace(/\s+/g, ' ').includes(t) && e.getBoundingClientRect().width > 0)
      if (!el) return false
      el.click()
      return true
    }, selector, text)
    if (ok) {
      await sleep(700)
      return true
    }
    await sleep(350)
  }
  return false
}

/** 等聊天畫面出現含這段字的泡泡 */
async function waitForBubble(page, text, timeoutMs = 20_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = await page.evaluate(t => [...document.querySelectorAll('.agm-bubble')]
      .some(el => el.textContent.replace(/\s+/g, ' ').includes(t)), text)
    if (hit) return true
    await sleep(400)
  }
  return false
}

// ── 關卡 ─────────────────────────────────────────────────────────

/** 組織與 LINE 頁：輪廓卡有沒有真的長出來 */
async function checkProfileCardOnOrgPage() {
  const { page, ctx } = await openLoggedInPage()
  try {
    // ⚠️ **暖機**：dev server 第一次編譯這一頁會先回一個空的 body（documented trap），
    //    直接量會得到 0 張卡而誤報成「頁面壞了」。先走一趟讓它編譯完再重來。
    await page.goto(`${BASE}/admin/${WORKSPACE_ID}/settings/organization`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await sleep(3000)
    await page.reload({ waitUntil: 'networkidle2', timeout: 90_000 })
    await sleep(3000)
    await dismissOverlays(page)

    // 對照組：頁面真的載入了（既有的卡片在）——沒有這一半，下面量到 0 分不出
    // 是「輪廓卡沒出來」還是「整頁沒載入」
    let baseCards = 0
    for (let i = 0; i < 15 && baseCards < 2; i++) {
      baseCards = await visible(page, '.ar-section-card')
      if (baseCards < 2) await sleep(700)
    }
    if (baseCards < 2) return fail(`組織頁看起來沒載入（只有 ${baseCards} 張卡）`)
    pass(`組織頁載入了（${baseCards} 張卡）`)

    const card = await visible(page, '.store-profile')
    if (card !== 1) return fail(`輪廓卡沒有出現（量到 ${card} 個 .store-profile）`)
    pass('輪廓卡出現在組織與 LINE 頁')

    const title = await textOf(page, '.store-profile .section-title')
    if (!title.includes('MiniMe 認識的你')) return fail(`卡片標題不對：${title}`)
    pass(`卡片標題：${title}`)

    // ⚠️ 卡片會先畫「正在讀你的輪廓…」：等它落到某一個終局分支再量，
    //    不等的話量到的是載入中，而那會被誤報成「兩個分支都沒出來」
    let settled = false
    for (let i = 0; i < 20 && !settled; i++) {
      settled = await page.evaluate(() =>
        document.querySelectorAll('.store-profile__empty, .store-profile__rows dt, .store-profile .el-alert').length > 0)
      if (!settled) await sleep(700)
    }
    if (!settled) return fail(`輪廓卡停在載入中：${(await textOf(page, '.store-profile')).slice(0, 160)}`)

    const alerted = await visible(page, '.store-profile .el-alert')
    if (alerted) return fail(`輪廓卡讀不到資料：${(await textOf(page, '.store-profile .el-alert')).slice(0, 160)}`)

    // MYFEEL 還沒有輪廓 → 應該是空狀態，而且要講後果、給出口
    const empty = await visible(page, '.store-profile__empty')
    if (empty === 1) {
      const body = await textOf(page, '.store-profile__empty')
      if (!body.includes('通用')) return fail('空狀態沒有講「不做會怎樣」（只說沒設定等於沒講後果）')
      pass('空狀態講得出後果（節慶提醒只會是通用句）')
      const cta = await clickByText(page, '.store-profile__empty button', '認識你的店')
      if (!cta) return fail('空狀態沒有可以按的出口')
      await sleep(1500)
      if (!page.url().includes('/admin/onboarding')) return fail(`出口帶去了錯的地方：${page.url()}`)
      pass('空狀態的出口真的把人帶去精靈')
    }
    else {
      // 已經有輪廓：那就要看得到九列與來源徽章
      const rows = await visible(page, '.store-profile__rows dt')
      if (rows !== 9) return fail(`輪廓列數不對：${rows}`)
      const badges = await visible(page, '.store-profile__src')
      if (badges !== 9) return fail(`來源徽章數不對：${badges}`)
      pass('九列與九個來源徽章都在')
    }
  }
  finally { await ctx.close() }
}

/** 開通精靈：走到「認識你的店」，五題問得出來 */
async function checkWizardProfileStep() {
  const { page, ctx } = await openLoggedInPage({
    fakeWrites: (url) => {
      // ⛔ 這一支真的會建組織＋工作區，一定要攔
      if (url.includes('/api/onboarding/self-serve')) {
        return { body: { workspaceId: WORKSPACE_ID, organizationId: 'fake-org' } }
      }
      if (url.includes('/api/store-profile/read-site')) {
        return { body: { jobId: 'fake-job', status: 'running', percent: 20, phaseText: '正在讀你的網站（第 1 頁）' } }
      }
      if (url.endsWith('/api/store-profile') || url.includes('/api/store-profile?')) {
        return { body: { ok: true, profile: { fields: {}, siteUrl: '' }, ready: true } }
      }
      return null
    },
  })
  try {
    await page.goto(`${BASE}/admin/onboarding`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await sleep(2500)

    // 進度條：六格，而且第二格是「認識你的店」
    const steps = await page.evaluate(() =>
      [...document.querySelectorAll('.onbc-progress .onbc-step, .obc-step, [class*="progress"] [class*="step"]')]
        .map(el => el.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean))
    if (steps.length >= 6 && steps[1]?.includes('認識你的店')) pass(`進度條六格，第二格＝${steps[1]}`)
    else console.log(`  ⚠️ 進度條選擇器量到：${JSON.stringify(steps)}（版面若改過要更新這個選擇器）`)

    if (!await waitForBubble(page, '我是小幫手')) return fail('精靈沒有開場')
    // 對照組：這一刻還沒有人問過五題
    const early = await page.evaluate(() => document.body.textContent.includes('主要賣什麼'))
    if (early) return fail('還沒走到就已經出現五題的字（對照組失敗）')
    pass('對照組：開場時畫面上沒有五題的字')

    if (!await clickByText(page, '.agm-choices .el-button', '開始吧')) return fail('找不到「開始吧」')

    // 取名字
    await sleep(800)
    const nameInput = await page.$('.agd__input input, .agd__input')
    if (!nameInput) return fail('取名字那一格沒出現')
    await page.type('.agd__input input', '守門員測試店', { delay: 10 }).catch(async () => {
      await page.type('.agd__input', '守門員測試店', { delay: 10 })
    })
    await page.keyboard.press('Enter')
    await sleep(2500)

    // ⚠️ **不可以只比對「認識你的店」四個字**：開場白與進度條上都有那幾個字，
    //    拿掉整段劇本這一關照樣會綠（破壞性驗證當場抓到）。改成比對只有這一段才講的話。
    if (!await waitForBubble(page, '我給的建議才會是你的店用得上的')) return fail('建完帳號沒有接到「認識你的店」那一段')
    pass('建完帳號直接接到「認識你的店」那一段')

    if (!await clickByText(page, '.agm-choices .el-button', '好，開始')) return fail('找不到「好，開始」')

    // 第一題：產業。選項不可以有 primary（沒有建議答案）
    if (!await waitForBubble(page, '你的店主要是哪一種')) return fail('第一題沒有問出來')
    pass('第 1 題：你的店主要是哪一種')
    const primaryCount = await visible(page, '.agm-choices .el-button--primary')
    if (primaryCount > 0) return fail(`選項有 ${primaryCount} 顆 primary——這幾題沒有建議答案，不該染色`)
    pass('對照組：選項一顆 primary 都沒有')

    if (!await clickByText(page, '.agm-choices .el-button', '零售')) return fail('選不到產業')

    // 第二題：打字題
    if (!await waitForBubble(page, '主要賣什麼')) return fail('第二題沒有問出來')
    pass('第 2 題：主要賣什麼（打字題）')
    await page.type('.agd__input input', '黑豆水、養生茶包', { delay: 5 }).catch(() => {})
    await page.keyboard.press('Enter')
    await sleep(1500)

    // 第三、四、五題
    for (const [q, answer] of [['主要賣給誰', '一般消費者'], ['客人通常怎麼買', '網購為主'], ['生意最好的時候', '夏天']]) {
      if (!await waitForBubble(page, q)) return fail(`「${q}」沒有問出來`)
      if (!await clickByText(page, '.agm-choices .el-button', answer)) return fail(`「${q}」選不到答案`)
      pass(`問到並答完：${q}`)
    }
    if (!await waitForBubble(page, '現在最想解決')) return fail('「最想解決」沒有問出來')
    if (!await clickByText(page, '.agm-choices .el-button', '加好友後沒人理')) return fail('選不到最想解決')
    pass('問到並答完：現在最想解決的是哪一件')

    // 網址題：一定要跳得掉
    if (!await waitForBubble(page, '網址')) return fail('網址那題沒有問出來')
    const skip = await clickByText(page, '.agd__skip', '沒有網站')
    if (!skip) return fail('網址那題沒有「沒有網站」可以跳過')
    pass('網址那題跳得掉（沒有網站的人不會被卡住）')

    // 閘門：主要動作是接 LINE，次要出口要講後果
    if (!await waitForBubble(page, '接上 LINE')) return fail('沒有接到「要不要接 LINE」的閘門')
    const gateBtns = await textOf(page, '.agm-choices .el-button')
    if (!gateBtns.includes('接上 LINE')) return fail(`閘門的主要動作不見了：${gateBtns}`)
    if (!gateBtns.includes('先進後台')) return fail(`閘門沒有給「還沒有連線資訊」的出口：${gateBtns}`)
    pass(`閘門兩顆鈕：${gateBtns}`)

    if (!await clickByText(page, '.agm-choices .el-button', '先進後台')) return fail('按不到「先進後台」')
    if (!await waitForBubble(page, '客人傳訊息我收不到')) return fail('「先進後台」沒有講後果')
    pass('「先進後台」講得出後果（客人傳訊息收不到）')
  }
  finally { await ctx.close() }
}

/**
 * 只做輪廓那一趟（`?focus=profile`）＋老店反推＋五樣草稿（`C-221`／`C-222`）。
 *
 * ⛔ 這一關同時是 `C-219` 那條**死路**的守門：組織頁的按鈕會帶著 `focus=profile` 過來，
 *    少了它就會落進續走模式——已經接好 LINE 的帳號（MYFEEL 就是）會直接跳到成績單、
 *    五題一句都沒問。
 */
async function checkProfileOnlyRun() {
  /**
   * ⚠️ 假資料要**有狀態**，不然驗不到真實順序：
   * 存檔之前這個帳號是「還不認識」（才會提出反推），存檔之後才是「認識了」
   * （揭曉與草稿那兩段才跑得到）。回一份固定的假資料會讓其中一段永遠跑不到。
   */
  let savedProfile = false
  const filledProfile = {
    siteUrl: 'https://example-shop.tw',
    siteRead: { status: 'ok', pagesRead: 5, pagesFailed: [], at: 1 },
    fields: {
      industry: { value: '零售／電商（養生飲品）', source: 'owner', ownerEdited: true, updatedAt: 2 },
      products: { value: '黑豆水、養生茶包、節慶禮盒', source: 'owner', ownerEdited: true, updatedAt: 2 },
      customers: { value: '30–45 歲女性為主', source: 'owner', ownerEdited: true, updatedAt: 2 },
      channel: { value: '網購為主', source: 'owner', ownerEdited: true, updatedAt: 2 },
      season: { value: '年節送禮（春節、中秋）', source: 'owner', ownerEdited: true, updatedAt: 3 },
      pain: { value: '不知道推播要推什麼', source: 'owner', ownerEdited: true, updatedAt: 3 },
      tone: { value: '親切、講健康但不誇大', source: 'ai', updatedAt: 1 },
    },
  }
  const { page, ctx } = await openLoggedInPage({
    fakeWrites: (url) => {
      if (url.includes('/api/store-profile/infer')) {
        // ⛔ 真的打會花錢（LLM）而且會寫正式庫的 storeProfiles：攔成一份假的猜測
        return {
          body: {
            ok: true,
            note: '我看了知識庫 38 筆、12 顆標籤、8 個活動',
            filled: ['industry', 'products', 'customers', 'channel'],
            profile: {
              siteUrl: 'https://example-shop.tw',
              fields: {
                industry: { value: '零售／電商（養生飲品）', source: 'ai', updatedAt: 1 },
                products: { value: '黑豆水、養生茶包、節慶禮盒｜NT$180–1,280', source: 'ai', updatedAt: 1 },
                customers: { value: '30–45 歲女性為主', source: 'ai', updatedAt: 1 },
                channel: { value: '網購為主', source: 'ai', updatedAt: 1 },
              },
            },
            ready: false,
          },
        }
      }
      if (url.endsWith('/api/store-profile') || url.includes('/api/store-profile?')) {
        // 「按了都對」之後的存檔：要回**確認過的**輪廓（四格轉成 owner），
        // ⛔ 回一份空的會讓下一步把五題全問一遍——那是假失敗，不是產品的問題。
        //    第一版就是回空的，當場被「沒有問到旺季」抓出來。
        savedProfile = true
        return {
          body: {
            ok: true,
            ready: false,
            profile: {
              siteUrl: filledProfile.siteUrl,
              fields: {
                industry: filledProfile.fields.industry,
                products: filledProfile.fields.products,
                customers: filledProfile.fields.customers,
                channel: filledProfile.fields.channel,
              },
            },
          },
        }
      }
      if (url.includes('/api/ai/scripts/create')) return { body: { id: 'fake-script' } }
      if (url.includes('/api/tag/create')) return { body: { id: 'fake-tag' } }
      if (url.includes('/api/ai/settings')) return { body: { ok: true } }
      return null
    },
    // 正式庫刻意沒有輪廓（全程零寫入），但揭曉與草稿那兩段要有輪廓才會跑——
    // ⛔ 只假造這一支 GET，其他照樣打真的
    fakeReads: (url) => {
      if (url.endsWith('/api/store-profile') || url.includes('/api/store-profile?')) {
        return savedProfile
          ? { body: { ready: true, profile: filledProfile } }
          : { body: { ready: false, profile: { fields: {}, siteUrl: '' } } }
      }
      return null
    },
  })
  try {
    await page.goto(`${BASE}/admin/onboarding?workspaceId=${WORKSPACE_ID}&focus=profile`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await sleep(2500)

    /**
     * 對照組：這條路**不可以**變成「歡迎回來 → 成績單」（那正是要修的死路）。
     * ⚠️ **一定要等到有東西出現再判斷**：第一版是固定 sleep 之後量一次，
     * 於是拿掉 `focus=profile` 做破壞性驗證時，對照組照樣綠（那時泡泡還沒畫出來）——
     * 一個會在真的壞掉時說沒事的對照組，比沒有對照組還糟。
     */
    let sawProfileIntro = false
    let sawResumeIntro = false
    for (let i = 0; i < 40 && !sawProfileIntro && !sawResumeIntro; i++) {
      const seen = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.agm-bubble')].map(e => e.textContent).join(' ')
        return { profile: t.includes('只做一件事'), resume: t.includes('我們接著把剩下的設定做完') }
      })
      sawProfileIntro = seen.profile
      sawResumeIntro = seen.resume
      if (!sawProfileIntro && !sawResumeIntro) await sleep(400)
    }
    if (sawResumeIntro) return fail('focus=profile 落進了續走模式（死路沒修好）')
    if (!sawProfileIntro) return fail('只做輪廓那一趟沒有開場')
    pass('只做輪廓那一趟開場了（而且沒有落進續走模式）')

    // 老店反推
    if (!await waitForBubble(page, '我先從你帳號裡')) return fail('沒有提出「我先自己猜一份」')
    if (!await clickByText(page, '.agm-choices .el-button', '好，你先猜')) return fail('按不到「好，你先猜」')
    if (!await waitForBubble(page, '猜到')) return fail('反推沒有回報猜到幾項')
    pass('老店反推：猜完並回報了看過哪些東西')

    const rows = await visible(page, '.agm-profile__rows dt')
    if (rows !== 9) return fail(`反推的輪廓卡列數不對：${rows}`)
    const aiBadges = await visible(page, '.agm-profile__src.is-ai')
    if (aiBadges < 4) return fail(`AI 推測的徽章只有 ${aiBadges} 個——猜的一定要看得出是猜的`)
    pass(`反推的輪廓卡九列、其中 ${aiBadges} 格標成 AI 推測`)

    if (!await clickByText(page, '.agm-choices .el-button', '都對，就是這樣')) return fail('按不到「都對」')

    // 只補猜不到的兩題，而且編號要重排成 1/2、2/2
    if (!await waitForBubble(page, '剩下這幾題我猜不到')) return fail('沒有接到「只補猜不到的那幾題」')
    pass('確認之後只補猜不到的題目')
    if (!await clickByText(page, '.agm-choices .el-button', '好，開始')) return fail('按不到「好，開始」')
    if (!await waitForBubble(page, '生意最好的時候')) return fail('沒有問到旺季')
    // 反推之後只剩「旺季＋最想解決」，兩題同屬一步 → 只有一步。
    // ⛔ 這時不可以標「1 / 1」（雜訊，而且看起來像算錯），更不可以留著原本的「5 / 5」（會讓人以為漏問了）。
    const stepNo = await textOf(page, '.agm-stepno')
    if (stepNo.includes('5 / 5')) return fail('題號沒有重排，留著原本的 5 / 5')
    if (stepNo.includes('1 / 1')) return fail('只剩一步還標「1 / 1」')
    pass(`只剩一步時不標題號（量到「${stepNo || '（沒有題號）'}」）`)
    if (!await clickByText(page, '.agm-choices .el-button', '年節送禮')) return fail('選不到旺季')
    if (!await waitForBubble(page, '現在最想解決')) return fail('沒有問到最想解決')
    if (!await clickByText(page, '.agm-choices .el-button', '不知道推播要推什麼')) return fail('選不到最想解決')

    // 網址那題
    if (!await waitForBubble(page, '網址')) return fail('沒有問到網址')
    if (!await clickByText(page, '.agd__skip', '沒有網站')) return fail('網址那題跳不掉')

    // 五樣草稿
    if (!await waitForBubble(page, '按「採用」才會生效')) return fail('沒有接到草稿那一段')
    pass('接到五樣草稿那一段')

    const firstDraft = await textOf(page, '.agm-draft__title')
    if (!firstDraft.includes('加好友歡迎訊息')) return fail(`第一樣不是歡迎訊息：${firstDraft}`)
    const where = await textOf(page, '.agm-draft__where')
    if (!where.includes('自動回應')) return fail(`草稿沒有講「東西會跑到哪裡」：${where}`)
    pass(`第一樣草稿：${firstDraft}（→ ${where}）`)

    // ⛔ 對照組：還沒按採用之前，卡片上不可以先畫出結果
    const preState = await visible(page, '.agm-draft__state')
    if (preState > 0) return fail('還沒決定就先畫了結果（等於替他做了決定）')
    pass('對照組：還沒按採用之前卡片上沒有結果')

    if (!await clickByText(page, '.agm-choices .el-button', '採用')) return fail('按不到「採用」')
    await sleep(1200)
    const adopted = await textOf(page, '.agm-draft__state')
    if (!adopted.includes('已採用')) return fail(`採用之後沒有回報結果：${adopted}`)
    pass('採用之後卡片上寫出了結果')

    // 其餘幾樣：一路採用到底
    for (let i = 0; i < 4; i++) {
      const more = await clickByText(page, '.agm-choices .el-button', '採用', 6000)
      if (!more) break
      await sleep(900)
    }

    if (!await waitForBubble(page, '都幫你準備好了', 15_000)) {
      const tail = await textOf(page, '.agm-bubble')
      return fail(`草稿跑完沒有收尾：${tail.slice(-160)}`)
    }
    pass('草稿全部採用完，有收尾')

    const endBtns = await textOf(page, '.agm-choices .el-button')
    if (!endBtns.includes('回後台')) return fail(`收尾沒有給出路：${endBtns}`)
    pass(`收尾給得出出路：${endBtns}`)
  }
  finally { await ctx.close() }
}

try {
  console.log('\n── 組織與 LINE 頁的輪廓卡（C-217）─────────')
  await checkProfileCardOnOrgPage()
  console.log('\n── 精靈的「認識你的店」（C-219）───────────')
  await checkWizardProfileStep()
  console.log('\n── 只做輪廓＋老店反推＋五樣草稿（C-221／C-222）──')
  await checkProfileOnlyRun()
}
finally {
  await browser.close()
  console.log(`\n被攔下來、沒有送出去的寫入請求共 ${blocked.length} 筆：`)
  for (const b of [...new Set(blocked)]) console.log(`  · ${b}`)
}

console.log(failed ? '\n❌ 有關卡沒過' : '\n✅ 全部通過')
process.exit(failed ? 1 : 0)
