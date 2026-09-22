/**
 * 「就地建標籤」的實機守門員（2026-09-21，`C-208`）。
 *
 *   npm run dev -- --port 3317                                      # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3317 node --env-file=.env_myfeel scripts/tag-picker-check.mjs
 *
 * **為什麼一定要真的開瀏覽器**：這次改的東西，`typecheck` 與單元測試**一條都驗不到**——
 * 代號產生器有純函式測試（`shared/tag-code-suggest.test.ts`），但「那顆元件有沒有真的被渲染
 * 出來」「＋ 新標籤按下去有沒有東西打開」「推播那一格有沒有照規矩**不給**建立鈕」全部是畫面行為。
 * 這個專案吃過九次「typecheck 綠＋測試綠，但新程式根本沒被執行到」
 * （記憶 `feedback_verify_new_code_actually_runs`），其中一次就是「按了沒反應」交到老闆手上。
 *
 * ⚠️ **連的是正式資料庫（myfeel），但全程不寫任何東西**：
 *    - 讀 `workspaceMembers` 找一個管理員登入（唯讀）
 *    - 瀏覽器只點開編輯器與對話框，⛔ **絕不按「建立」「儲存」「建立並選用」「發送」**
 *      （所以正式庫不會多出任何一顆測試標籤）
 *    - 唯一可能被寫到的是 `adminUserPrefs/{uid}`（自動導覽的「看過了」），跑前抄下來、跑完原封還原
 *
 * ⛔ **內建對照組**：每一關都先斷言「還沒打開之前畫面上沒有 .tag-picker」再斷言「打開之後有」。
 *    沒有這一半的話，選擇器只要寫錯成一個到處都在的東西，整份就是假綠燈。
 */
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

const prefsRef = db.collection('adminUserPrefs').doc(uid)
const prefsBefore = await prefsRef.get()
const prefsData = prefsBefore.exists ? prefsBefore.data() : null
console.log(`adminUserPrefs/${uid}：${prefsBefore.exists ? '原本有資料，已抄下來，跑完會還原' : '原本不存在，跑完會刪掉'}`)

/**
 * ⛔ **先把這幾頁的導覽標成「看過了」**，否則量出來的東西會忽紅忽綠。
 *
 * 2026-09-16 起每個帳號第一次進某一頁會**自動跑那一頁的導覽**，而那些導覽會用
 * `clickBefore` **幫使用者按下「新增」把編輯器打開**——於是「還沒打開編輯器」這個對照組
 * 有時候量到 0、有時候量到 1，取決於導覽跑得多快。實測同一份程式碼連跑三次，兩紅一綠。
 * 這裡先蓋章讓導覽不要自己跑，跑完 `finally` 會把整份 prefs 原封還原。
 */
const SILENCE_TOURS = ['campaigns', 'support-presets', 'broadcasts', 'tags', 'users', 'flow|msg-basic|msg-rich|msg-carousel|msg-quick|msg-userinput']
await prefsRef.set({
  ...(prefsData ?? {}),
  seenTours: {
    ...(prefsData?.seenTours ?? {}),
    ...Object.fromEntries(SILENCE_TOURS.map(id => [id, new Date()])),
  },
}, { merge: true })
console.log(`已暫時把 ${SILENCE_TOURS.join('／')} 標成看過（避免自動導覽把編輯器搶先打開），跑完還原`)

const custom = await getAuth().createCustomToken(uid)
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }
console.log(`登入身分：${session.email}（${admin.role}）\n`)

let failed = false
const fail = (msg) => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

/** @param {{emptyTagList?: boolean}} [opts] emptyTagList＝把 /api/tag/list 攔成空陣列，用來逼出空狀態 */
async function openLoggedInPage(opts = {}) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  /**
   * ⛔ **一定要接原生對話框**：這幾頁掛了「還沒存喔」的離開確認（`useUnsavedChanges`）。
   * native 的 confirm／beforeunload 會**把整個 JS 執行緒卡住**，於是 `page.evaluate` 不是回
   * 錯誤而是**一路卡到 puppeteer 的 protocolTimeout 才拋 ProtocolError**——看起來像頁面壞了，
   * 其實只是沒有人回答那個框。這一輪實測連續兩次都死在這裡。
   */
  page.on('dialog', async (d) => { await d.accept().catch(() => {}) })

  /**
   * 攔截：兩種用途都走這一個 handler（⛔ 掛兩個 `request` 監聽會互搶，第二個會拿到
   * 「已經處理過」的請求而丟錯）。
   * - `emptyTagList`：正式庫有 39 顆標籤，空狀態那條路平常永遠走不到，但它正是新帳號
   *   第一天唯一會看到的東西。
   * - `fakeWrites`：精靈會**真的建標籤／模組／活動／推播**。⛔ 絕不可以在正式庫建測試資料，
   *   所以把那四支 POST 攔下來回假的成功／失敗——這樣才驗得到「建到一半失敗」那條路，
   *   而那正是整個精靈最重要的一段。
   */
  if (opts.emptyTagList || opts.fakeWrites || opts.flowPickerList) {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const url = req.url()
      if (opts.emptyTagList && url.includes('/api/tag/list')) {
        req.respond({ status: 200, contentType: 'application/json', body: '[]' })
        return
      }
      /**
       * `D-86`：把**選單用的**模組清單換成指定的一份。
       *
       * 為什麼要假造：要驗的三種狀況（還沒有內容／已停用／已經被刪掉）在正式庫幾乎踩不到
       * ——空模組只剩那顆已經被藏起來的舊「歡迎模組」，而「已刪除」得先真的刪掉一個。
       * ⛔ **只攔 `fields=picker`**：機器人模組那一頁吃的是不帶參數的完整清單，
       *    連它一起攔會把整頁的資料換掉，量到的東西就跟真的沒關係了。
       */
      if (opts.flowPickerList && url.includes('/api/flow/list') && url.includes('fields=picker')) {
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.flowPickerList) })
        return
      }
      if (opts.fakeWrites && req.method() === 'POST') {
        const fake = opts.fakeWrites(url)
        if (fake) {
          req.respond({
            status: fake.status ?? 200,
            contentType: 'application/json',
            body: JSON.stringify(fake.body ?? {}),
          })
          return
        }
        // ⛔ 沒被指名的 POST 一律擋掉：漏一支就是在正式庫寫了東西
        if (/\/api\/(tag|flow|campaigns|broadcast)\//.test(url)) {
          req.respond({ status: 500, contentType: 'application/json', body: '{"statusMessage":"測試攔截：這支沒被指名"}' })
          return
        }
      }
      req.continue()
    })
  }

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
    const open = await page.evaluate(() => [...document.querySelectorAll('.ta-tour-title')]
      .some(el => el.getBoundingClientRect().width > 0))
    if (!open) break
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.el-tour__footer .el-button')]
      b[b.length - 1]?.click()
    })
    await sleep(500)
  }
  await sleep(400)
}

const countPickers = page => page.evaluate(() =>
  [...document.querySelectorAll('.tag-picker')].filter(el => el.getBoundingClientRect().width > 0).length)

const countCreateButtons = page => page.evaluate(() =>
  [...document.querySelectorAll('.tag-picker .el-button')]
    .filter(el => el.textContent.includes('新標籤') && el.getBoundingClientRect().width > 0).length)

/** 點畫面上第一個文字符合的元素 */
async function clickByText(page, selector, text) {
  return page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)]
      .find(e => e.textContent.trim().includes(t) && e.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  }, selector, text)
}

/**
 * ⛔ **先暖機**：dev server 第一次編譯某一頁可能要幾十秒，而那段時間 `page.goto` 會回一個
 *    **完全空白**的 body——量起來跟「元件沒被渲染出來」一模一樣，會害人去查一個不存在的 bug
 *    （這一輪實際踩過：campaigns／support-presets 兩頁第一次全空，第二次全好）。
 *    所以先用 fetch 把每一頁打一次，讓編譯在量測之前發生。
 */
async function warmup(paths) {
  for (const path of paths) {
    const url = `${BASE}/admin/${WORKSPACE_ID}/${path}`
    const started = Date.now()
    try {
      await fetch(url, { signal: AbortSignal.timeout(180_000) })
      console.log(`   暖機 ${path}：${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
    catch (e) {
      console.log(`   暖機 ${path} 失敗（${String(e).slice(0, 60)}）——下面那一關量到的空白可能是編譯還沒好，不是元件壞了`)
    }
  }
}

async function gotoPage(page, path, waitForSelector) {
  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/${path}`, { waitUntil: 'networkidle2', timeout: 120_000 })
  // 等畫面真的長出東西再往下量；⛔ 逾時就明講「這次沒量到」，不要當成綠燈
  try {
    await page.waitForFunction(() => document.body.innerText.trim().length > 50, { timeout: 60_000 })
  }
  catch {
    fail(`${path}：等了 60 秒畫面還是空的（dev server 可能還在編譯）＝這一頁這次沒驗到`)
  }
  /**
   * ⛔ **側欄先渲染、主要內容後到**：只等「body 有字」會在表格出現之前就放行，
   * 於是「表格沒有這一欄」這種結論其實只是量得太早（本輪實際誤報過一次）。
   * 需要量表格／清單的關卡一定要多等一個自己的錨點。
   */
  if (waitForSelector) {
    try {
      await page.waitForSelector(waitForSelector, { timeout: 60_000, visible: true })
    }
    catch {
      fail(`${path}：等了 60 秒還是沒看到 ${waitForSelector}＝這一頁這次沒驗到`)
    }
  }
  await sleep(2000)
  await dismissOverlays(page)
  await closeOpenEditor(page)
}

/**
 * 把右半邊可能已經開著的編輯器收起來，讓「還沒打開編輯器」這個對照組是**確定的**。
 *
 * ⛔ 不做這一步就會忽紅忽綠：自動導覽（2026-09-16 起每頁第一次進來會自己跑）會用
 * `clickBefore` 幫使用者按下「新增」，所以量到 0 還是 1 取決於導覽跑得多快——
 * 同一份程式碼實測連跑三次、兩紅一綠。⛔ 忽紅忽綠的守門員比沒有守門員更糟：
 * 真的壞掉的那天，沒有人會相信它。
 */
async function closeOpenEditor(page) {
  for (let i = 0; i < 3; i++) {
    const closed = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button, .el-button')]
        .find(e => e.textContent.trim() === '取消' && e.getBoundingClientRect().width > 0)
      if (!btn) return false
      btn.click()
      return true
    })
    if (!closed) break
    await sleep(900)
  }
  await sleep(300)
}

// ── 關卡 1：活動標籤——貼標欄一進編輯器就在，是最直接的對照組 ─────────────────
async function checkCampaigns() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'campaigns')

    const before = await countPickers(page)
    if (before !== 0) fail(`活動標籤：還沒打開編輯器就已經有 ${before} 個 .tag-picker＝選擇器抓到了不該抓的東西（這一關是對照組，不通過的話整份都是假綠燈）`)
    else pass('活動標籤：沒打開編輯器時畫面上沒有 .tag-picker（對照組成立）')

    if (!await clickByText(page, 'button, .el-button', '新增')) {
      fail('活動標籤：找不到「新增」鈕')
      return
    }
    await sleep(2500)

    const after = await countPickers(page)
    if (after < 1) fail('活動標籤：打開編輯器之後還是看不到 .tag-picker＝共用選標籤欄位沒有被渲染出來')
    else pass(`活動標籤：編輯器裡出現 ${after} 個共用選標籤欄位`)

    const createBtns = await countCreateButtons(page)
    if (createBtns < 1) fail('活動標籤：沒有「＋ 新標籤」＝這一頁還是要人跑去標籤頁才建得出來')
    else pass('活動標籤：有「＋ 新標籤」')

    // ── 對話框：打開、預填代號，⛔ 不送出 ──────────────────────────────
    const opened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.tag-picker .el-button')]
        .find(e => e.textContent.includes('新標籤') && e.getBoundingClientRect().width > 0)
      if (!btn) return false
      btn.click()
      return true
    })
    if (!opened) { fail('活動標籤：「＋ 新標籤」點不到'); return }
    await sleep(1200)

    const dialogShown = await page.evaluate(() => [...document.querySelectorAll('.el-dialog')]
      .some(el => el.getBoundingClientRect().width > 0 && el.textContent.includes('新增標籤')))
    if (!dialogShown) { fail('活動標籤：按了「＋ 新標籤」沒有任何東西打開（這正是 H-37 那顆問號的死法）'); return }
    pass('活動標籤：「＋ 新標籤」真的打開了小視窗')

    /**
     * `D-83`③ 拍板後：小視窗裡**不可以再出現英文代號那一格**（系統自己生）。
     * ⛔ 這一關要驗「看不到」而不是「填對了」——留著那一格正是老闆說要拿掉的東西。
     */
    const inputs = await page.$$('.el-dialog .el-input__inner')
    if (!inputs.length) { fail('活動標籤：小視窗裡沒有任何輸入格'); return }
    await inputs[0].click()
    await inputs[0].type('Zz Check Only')
    await sleep(700)

    const codeFieldShown = await page.evaluate(() => {
      const box = [...document.querySelectorAll('.el-dialog')].find(el => el.getBoundingClientRect().width > 0)
      return [...box.querySelectorAll('.admin-field-group')].some(g => g.textContent.includes('英文代號'))
    })
    if (codeFieldShown) {
      fail('活動標籤：小視窗還在要人填「英文代號」——`D-83`③ 已拍板由系統自己生、不顯示')
    }
    else {
      pass('活動標籤：小視窗只問名稱與分類，代號由系統自己生（D-83③）')
    }

    await page.keyboard.press('Escape')
    await sleep(500)
    pass('活動標籤：⛔ 全程沒有按「建立並選用」，正式庫沒有多出任何標籤')
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 2：客服預存——貼標藏在開關後面 ───────────────────────────────────
async function checkSupportPresets() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'support-presets')
    if (!await clickByText(page, 'button, .el-button', '新增')) { fail('客服預存：找不到「新增」鈕'); return }
    await sleep(2000)

    const before = await countPickers(page)
    if (before !== 0) fail(`客服預存：貼標開關還沒開就有 ${before} 個 .tag-picker（對照組不成立）`)
    else pass('客服預存：貼標開關沒開時看不到選標籤欄位（對照組成立）')

    const toggled = await page.evaluate(() => {
      const group = [...document.querySelectorAll('[data-tour="sp-tagging"]')][0]
      const sw = group?.querySelector('.el-switch')
      if (!sw) return false
      sw.click()
      return true
    })
    if (!toggled) { fail('客服預存：找不到「啟用貼標」開關'); return }
    await sleep(1500)

    const after = await countPickers(page)
    if (after < 1) fail('客服預存：開了貼標之後看不到選標籤欄位')
    else pass('客服預存：開了貼標就出現共用選標籤欄位')

    if (await countCreateButtons(page) < 1) fail('客服預存：沒有「＋ 新標籤」')
    else pass('客服預存：有「＋ 新標籤」')
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 3：推播受眾——這一格**故意不給**建立鈕 ──────────────────────────
async function checkBroadcastAudience() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'broadcasts')
    if (!await clickByText(page, 'button, .el-button', '新增')) { fail('推播：找不到「新增」鈕'); return }
    await sleep(2000)

    const picked = await page.evaluate(() => {
      const radio = [...document.querySelectorAll('.el-radio')]
        .find(el => el.textContent.includes('依標籤篩選'))
      if (!radio) return false
      radio.click()
      return true
    })
    if (!picked) { fail('推播：找不到「依標籤篩選」'); return }
    await sleep(1500)

    const pickers = await countPickers(page)
    if (pickers < 1) { fail('推播：選了依標籤篩選卻沒有選標籤欄位'); return }
    pass('推播：受眾那一格用的是共用選標籤欄位')

    /**
     * ⛔ **只數「發送對象」那一格裡面的**，不要全頁數。
     * `C-213` 之後這一頁有兩個選標籤欄位（受眾＝不給建、發完貼記號＝給建），
     * 全頁數會把貼記號那顆算進來 → 這一關會永遠誤報。本輪實際紅過一次。
     */
    const createBtns = await page.evaluate(() => {
      const group = [...document.querySelectorAll('.admin-field-group')]
        .find(g => g.textContent.includes('選擇標籤（符合任一即納入）'))
      if (!group) return -1
      return [...group.querySelectorAll('.el-button')]
        .filter(b => b.textContent.includes('新標籤') && b.getBoundingClientRect().width > 0).length
    })
    if (createBtns < 0) { fail('推播：找不到「發送對象」那一格'); return }
    if (createBtns !== 0) {
      fail(`推播受眾出現了 ${createBtns} 顆「＋ 新標籤」＝⛔ 這一格是「拿標籤篩人」，當場建一顆新標籤身上沒有客人，等於挑到 0 個人`)
    }
    else {
      pass('推播受眾：⛔ 照規矩沒有「＋ 新標籤」（那一格是篩人不是貼標）')
    }
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 4：一顆標籤都沒有的新帳號，看到的是一句人話還是一個空下拉 ──────────
async function checkEmptyState() {
  const { page, ctx } = await openLoggedInPage({ emptyTagList: true })
  try {
    await gotoPage(page, 'campaigns')
    if (!await clickByText(page, 'button, .el-button', '新增')) { fail('空狀態：找不到「新增」鈕'); return }
    await sleep(2500)

    const empty = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.tag-picker__empty')].find(e => e.getBoundingClientRect().width > 0)
      if (!el) return null
      return {
        text: el.querySelector('.tag-picker__empty-text')?.textContent?.trim() ?? '',
        hasCreate: [...el.querySelectorAll('.el-button')].some(b => b.textContent.includes('新標籤')),
        hasLink: [...el.querySelectorAll('a')].some(a => a.getAttribute('href')?.includes('/tags')),
      }
    })
    if (!empty) { fail('空狀態：一顆標籤都沒有時，畫面上沒有任何說明＝又回到那個什麼都不講的空下拉'); return }
    if (!empty.text) fail('空狀態：有框卻沒有說明文字')
    else pass(`空狀態說明：「${empty.text.slice(0, 40)}…」`)
    if (!empty.hasCreate) fail('空狀態：沒有「＋ 新標籤」＝新帳號還是被卡在這裡')
    else pass('空狀態：給了「＋ 新標籤」')
    if (!empty.hasLink) fail('空狀態：沒有去標籤管理的連結')
    else pass('空狀態：也給了「去標籤管理」的出口')
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 5：模組編輯器要講得出「這個模組會在這些時候發出」（`C-209`）────────
async function checkModuleUsage() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'flow', '.split-list-item, .admin-split-list button')

    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.flow-usage-link')].filter(e => e.getBoundingClientRect().width > 0).length)
    if (before !== 0) fail(`機器人模組：還沒選任何模組就有 ${before} 句「客人會從哪裡走到這裡」（對照組不成立）`)
    else pass('機器人模組：沒選模組時不會出現使用情形（對照組成立）')

    // 左邊清單點第一個模組
    const picked = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.split-list-item, [class*="split-list"] li, .admin-split-list button')]
        .find(e => e.getBoundingClientRect().width > 0 && e.textContent.trim())
      if (!item) return null
      item.click()
      return item.textContent.replace(/\s+/g, ' ').trim().slice(0, 20)
    })
    if (!picked) { fail('機器人模組：左邊清單點不到任何模組'); return }
    await sleep(1500)

    /**
     * ⛔ **等引用查完再量**：載入中那句話會被當成「對不上三態」而誤報。
     * ⛔ 等待條件要綁**狀態 class 不是文案**——第一版綁「正在查有哪些地方用到它」那句，
     *    文案一改（`C-227` 改成「客人會從哪裡走到這裡」）守門就又量在載入中了。
     *    同一種時序漏洞已經中過兩次。
     */
    try {
      await page.waitForFunction(
        () => !document.querySelector('.flow-usage-link--loading'),
        { timeout: 30_000 },
      )
    }
    catch {
      fail('機器人模組：等了 30 秒引用還沒查完＝這一關這次沒驗到')
      return
    }
    await sleep(500)

    /**
     * `C-227` 第二輪：它**不再是一塊面板**，而是接在「共 N 則回覆訊息」那行灰字後面的一句話，
     * 細節走浮層。⛔ 這一關要順便釘住「工具列裡不可以再長出面板」。
     */
    const strip = await page.evaluate(() => {
      const link = [...document.querySelectorAll('.flow-usage-link')].find(e => e.getBoundingClientRect().width > 0)
      if (!link) return null
      const caption = link.closest('.admin-subtext')
      return {
        text: link.textContent.replace(/\s+/g, ' ').trim(),
        none: link.className.includes('flow-usage-link--none'),
        // ⛔ 必須長在 caption 那行灰字裡，不是自己一塊
        inCaption: !!caption,
        captionText: caption ? caption.innerText.replace(/\s+/g, ' ').trim() : '',
        panels: [...document.querySelectorAll('.flow-usage-strip')].length,
        /**
         * ⛔ 要數「看得見的」：el-popover 的內容會先渲染進 DOM 只是藏著，
         * 直接數 `.config-refs__group` 會把浮層裡那份算進來而誤報（本輪實際紅過一次）。
         */
        groupsBefore: [...document.querySelectorAll('.config-refs__group')]
          .filter(e => e.getBoundingClientRect().width > 0).length,
      }
    })
    if (!strip) { fail(`機器人模組：選了「${picked}」之後看不到「客人會從哪裡走到這裡」`); return }
    pass(`機器人模組：選了「${picked}」，caption 後面出現「${strip.text}」`)

    if (strip.panels) fail('機器人模組：工具列裡又長出面板了（`.flow-usage-strip`）——那正是老闆兩次說「醜」的東西')
    else pass('機器人模組：⛔ 工具列裡沒有面板，只是一句話')
    if (!strip.inCaption) fail('機器人模組：那句話沒有接在「共 N 則回覆訊息」那行灰字裡')
    else pass(`機器人模組：接在灰字那行（${strip.captionText.slice(0, 40)}）`)
    if (strip.groupsBefore) fail('機器人模組：還沒點就把名字攤開了——那是上一版的字牆')
    else pass('機器人模組：⛔ 沒點之前不攤開任何名字')

    /**
     * ⛔ 三態：有入口／真的沒有／這次查不到，三句話必須長得不一樣。
     * 沒有入口那一種還要**變色**（琥珀）——它是唯一需要人動手的狀態。
     */
    if (strip.text.includes('查不到')) {
      pass('機器人模組：這次查不到時照實說（沒有假裝成「沒有人用」）')
    }
    else if (strip.none) {
      if (!strip.text.includes('客人走不到這裡')) {
        fail(`機器人模組：沒有入口時那句話沒講後果（拿到「${strip.text}」）`)
      }
      else {
        pass(`機器人模組：沒有入口時講後果且變色（「${strip.text}」）`)
      }
    }
    else if (/\d+\s*個地方/.test(strip.text)) {
      pass(`機器人模組：有入口時一句話講完（「${strip.text}」）`)
    }
    else {
      fail(`機器人模組：那句話對不上三態（拿到「${strip.text}」）`)
    }

    /**
     * `C-227` 第三輪：工具列右邊那一叢要跟**名稱輸入框**同一條中線。
     * 老闆第三次回報「還是有點沒對齊」，實機量出來是動作鈕比輸入框中線高 19px
     * （header 是 `align-items: flex-start`，右叢貼著上面那行小灰 label），
     * 而且狀態標籤(22px)與動作鈕(32px)自己也差 5px。
     * ⛔ 這一關量的是**中線差**不是看截圖：差多少是可以算的，不要用「感覺」驗收。
     */
    const align = await page.evaluate(() => {
      const cy = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return b.width > 0 ? b.y + b.height / 2 : null
      }
      return {
        input: cy('.admin-title-input .el-input__wrapper'),
        actions: cy('.admin-header-actions'),
        meta: cy('.flow-module-meta'),
      }
    })
    if (align.input == null || align.actions == null) {
      fail('機器人模組：量不到工具列的名稱輸入框或動作鈕（選擇器失效？）')
    }
    else {
      const d = Math.abs(align.actions - align.input)
      if (d > 1.5) fail(`機器人模組：動作鈕沒跟名稱輸入框對齊，中線差 ${d.toFixed(1)}px`)
      else pass(`機器人模組：動作鈕與名稱輸入框同一條中線（差 ${d.toFixed(1)}px）`)
      if (align.meta != null) {
        const dm = Math.abs(align.meta - align.actions)
        if (dm > 1.5) fail(`機器人模組：狀態標籤沒跟動作鈕對齊，中線差 ${dm.toFixed(1)}px`)
        else pass(`機器人模組：狀態標籤與動作鈕同一條中線（差 ${dm.toFixed(1)}px）`)
      }
    }

    // 點下去要開浮層，而且**不可以把版面推開**（那是老闆說醜的主因之一）
    const heightBefore = await page.evaluate(() =>
      Math.round(document.querySelector('.split-editor-header')?.getBoundingClientRect().height ?? 0))
    await page.evaluate(() => {
      const link = [...document.querySelectorAll('.flow-usage-link')].find(e => e.getBoundingClientRect().width > 0)
      link?.click()
    })
    await sleep(900)
    const after = await page.evaluate(() => ({
      groups: [...document.querySelectorAll('.el-popper .config-refs__group')].filter(e => e.getBoundingClientRect().width > 0).length,
      popperVisible: [...document.querySelectorAll('.flow-usage-popper')].some(e => e.getBoundingClientRect().width > 0),
      headerHeight: Math.round(document.querySelector('.split-editor-header')?.getBoundingClientRect().height ?? 0),
    }))
    if (!after.popperVisible) fail('機器人模組：點了那句話沒有開出浮層')
    else pass(`機器人模組：點了開出浮層（${after.groups} 類入口）`)
    if (heightBefore && after.headerHeight > heightBefore + 2) {
      fail(`機器人模組：展開把工具列推高了（${heightBefore}px → ${after.headerHeight}px）——那正是老闆說醜的原因`)
    }
    else {
      pass(`機器人模組：展開不動版面（工具列仍是 ${after.headerHeight}px）`)
    }

    /**
     * `C-227` 第三輪：「還有 N 個」要**按得開**（老闆回報）。
     * 只說不給看，等於告訴他有 41 個他管不到的東西——他要找的那一個很可能就在裡面。
     * ⛔ 有對照組：先確認按之前真的有被截斷（名字數 < 該類總數），按了之後才算數。
     */
    const moreBefore = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.config-refs__more')]
        .find(e => e.getBoundingClientRect().width > 0 && /還有/.test(e.textContent))
      return el
        ? { tag: el.tagName, text: el.textContent.trim(), names: [...document.querySelectorAll('.el-popper .config-refs__name')].filter(e => e.getBoundingClientRect().width > 0).length }
        : null
    })
    if (!moreBefore) {
      // 這個工作區這一類沒有超過 8 個就跳過——⛔ 不可以當成「通過」
      console.log('  ⓘ 這次沒有任何一類超過 8 個，「還有 N 個」那一關跳過（不是綠燈）')
    }
    else if (moreBefore.tag !== 'BUTTON') {
      fail(`機器人模組：「${moreBefore.text}」不是按鈕（是 ${moreBefore.tag}）——按不開等於白講`)
    }
    else {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('.config-refs__more')]
          .find(e => e.getBoundingClientRect().width > 0 && /還有/.test(e.textContent))
        el?.click()
      })
      await sleep(600)
      const moreAfter = await page.evaluate(() => ({
        names: [...document.querySelectorAll('.el-popper .config-refs__name')].filter(e => e.getBoundingClientRect().width > 0).length,
        toggles: [...document.querySelectorAll('.config-refs__more')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim()),
        headerHeight: Math.round(document.querySelector('.split-editor-header')?.getBoundingClientRect().height ?? 0),
      }))
      if (moreAfter.names <= moreBefore.names) {
        fail(`機器人模組：按了「${moreBefore.text}」名字沒有變多（${moreBefore.names} → ${moreAfter.names}）`)
      }
      else {
        pass(`機器人模組：「${moreBefore.text}」按得開（${moreBefore.names} → ${moreAfter.names} 個名字）`)
      }
      if (!moreAfter.toggles.some(t => t.includes('收起來'))) {
        fail('機器人模組：攤開之後沒有「收起來」——只進不出')
      }
      else {
        pass('機器人模組：攤開之後收得回去')
      }
      if (heightBefore && moreAfter.headerHeight > heightBefore + 2) {
        fail(`機器人模組：攤開「還有 N 個」把工具列推高了（${heightBefore}px → ${moreAfter.headerHeight}px）`)
      }
      else {
        pass('機器人模組：攤開「還有 N 個」也不動版面')
      }
    }

    await page.keyboard.press('Escape')
    await sleep(300)
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 6：標籤頁要講得出「用在哪」，而且停用前會問（`C-209`）─────────────
async function checkTagUsage() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'tags', 'tbody tr')

    const header = await page.evaluate(() =>
      [...document.querySelectorAll('th')].some(e => e.textContent.trim() === '用在哪'))
    if (!header) { fail('標籤管理：表格沒有「用在哪」這一欄'); return }
    pass('標籤管理：表格有「用在哪」欄')

    // 等那一欄查完（載入中會顯示 …）
    for (let i = 0; i < 20; i++) {
      const loading = await page.evaluate(() =>
        [...document.querySelectorAll('tbody td')].some(e => e.textContent.trim() === '…'))
      if (!loading) break
      await sleep(700)
    }

    const cells = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tbody tr')]
      return rows.slice(0, 40).map((tr) => {
        const tds = [...tr.querySelectorAll('td')]
        return {
          name: tds[1]?.textContent?.trim() ?? '',
          usage: tds[7]?.textContent?.trim() ?? '',
        }
      })
    })
    if (!cells.length) { fail('標籤管理：表格沒有任何列'); return }

    const used = cells.filter(c => /\d+\s*處/.test(c.usage))
    const unknown = cells.filter(c => c.usage === '查不到')
    const none = cells.filter(c => c.usage === '—')
    if (unknown.length) {
      pass(`標籤管理：有 ${unknown.length} 顆標示「查不到」（⛔ 沒有假裝成「沒有人用」）`)
    }
    if (!used.length && !unknown.length) {
      fail('標籤管理：40 顆標籤沒有任何一顆查得到用在哪——正式庫的活動與推播都在用標籤，這不合理')
    }
    else if (used.length) {
      pass(`標籤管理：${used.length} 顆查得到用在哪（例如「${used[0].name}」＝${used[0].usage}）、${none.length} 顆真的沒人用`)
    }

    // 點開「N 處」要看得到名字
    if (used.length) {
      const opened = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('tbody .tags-count-link')]
          .find(e => /\d+\s*處/.test(e.textContent.trim()))
        if (!btn) return false
        btn.click()
        return true
      })
      if (!opened) { fail('標籤管理：「N 處」點不到'); return }
      await sleep(1200)
      const dialog = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.el-dialog')].find(e => e.getBoundingClientRect().width > 0)
        if (!el) return null
        return {
          title: el.querySelector('.el-dialog__title')?.textContent?.trim() ?? '',
          groups: [...el.querySelectorAll('.config-refs__group')].length,
          names: [...el.querySelectorAll('.config-refs__name')].map(e => e.textContent.trim()).slice(0, 3),
        }
      })
      if (!dialog || !dialog.groups) {
        fail('標籤管理：點開「N 處」之後沒有列出是哪些設定在用')
      }
      else {
        pass(`標籤管理：點開看得到名字（${dialog.names.join('、')}）`)
      }
      await page.keyboard.press('Escape')
      await sleep(500)
    }

    /**
     * ⛔ **多一欄就要量一次窄螢幕**：這張表 2026-09-10（`G-66`）在 ≤440px
     * 每一級都被裁過，根因是欄位的 `min-width` 把 `table-layout: auto` 的 min-content 撐開，
     * 而省略號**不會**讓 min-content 變小。後台窄視窗的正解是**橫向捲動**不是裁掉，
     * 所以這裡量的是「捲得到」而不是「沒有溢出」。
     */
    await page.setViewport({ width: 390, height: 900 })
    await sleep(1200)
    const narrow = await page.evaluate(() => {
      const table = document.querySelector('tbody')?.closest('table')
      if (!table) return null
      // 往上找第一個真的會捲的祖先
      let el = table.parentElement
      while (el && el !== document.body) {
        const style = getComputedStyle(el)
        if (/(auto|scroll)/.test(style.overflowX)) {
          return {
            tableWidth: Math.round(table.getBoundingClientRect().width),
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
            scrollable: el.scrollWidth > el.clientWidth + 1,
            overflowX: style.overflowX,
          }
        }
        el = el.parentElement
      }
      return { noScroller: true, tableWidth: Math.round(table.getBoundingClientRect().width) }
    })
    if (!narrow) {
      fail('標籤管理：390px 下找不到表格')
    }
    else if (narrow.noScroller) {
      fail(`標籤管理：390px 下表格寬 ${narrow.tableWidth}px，但沒有任何可以橫捲的祖先＝多出來的那一欄會被裁掉（G-66 同款）`)
    }
    else if (!narrow.scrollable) {
      pass(`標籤管理：390px 下表格塞得進去（${narrow.tableWidth}px ≤ ${narrow.clientWidth}px）`)
    }
    else {
      pass(`標籤管理：390px 下表格 ${narrow.scrollWidth}px 超出 ${narrow.clientWidth}px，但**捲得到**（overflow-x: ${narrow.overflowX}）＝沒有被裁掉`)
    }
    await page.setViewport({ width: 1440, height: 1000 })
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 7：好友頁「推播給這 N 位」要真的把名單帶過去（`C-210`）────────────
async function checkBroadcastHandoff() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'users', 'tbody tr')

    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.users-batch-bar')].filter(e => e.getBoundingClientRect().width > 0).length)
    if (before !== 0) fail('好友頁：還沒勾選就出現批次列（對照組不成立）')
    else pass('好友頁：沒勾人時沒有批次列（對照組成立）')

    // 勾兩位
    const checked = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('tbody input[type="checkbox"]')]
        .filter(e => e.getBoundingClientRect().width > 0)
      boxes.slice(0, 2).forEach(b => b.click())
      return Math.min(boxes.length, 2)
    })
    if (checked < 2) { fail('好友頁：勾不到兩位好友'); return }
    await sleep(900)

    const btn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.users-batch-bar .el-button')]
        .find(e => e.textContent.includes('推播給這'))
      return b ? b.textContent.replace(/\s+/g, ' ').trim() : null
    })
    if (!btn) {
      fail('好友頁：勾了人之後沒有「推播給這 N 位」＝推播頁那句「先到好友頁篩出那批人」仍然是死路')
      return
    }
    pass(`好友頁：出現「${btn}」`)

    await page.evaluate(() => {
      [...document.querySelectorAll('.users-batch-bar .el-button')]
        .find(e => e.textContent.includes('推播給這'))?.click()
    })
    /**
     * ⛔ **不要用固定秒數等推播頁**（2026-09-22 這一關紅過三次，查證是守門太急不是程式壞了：
     *    手動走同一條路，受眾確實自動選成「匯入名單」、兩筆編號也確實填進去了，
     *    只是推播頁冷啟動要六秒多，而這裡只睡四秒）。
     *    改成等「名單真的填進去」這個錨點，最多等 25 秒。
     * ⚠️ 等的東西就是等一下要驗的東西，看起來像自我實現，其實不是：
     *    等不到照樣往下驗、照樣會紅，差別只是**壞掉時多花 25 秒**、**好的時候不再假紅**。
     */
    await page.waitForFunction(
      () => location.pathname.includes('/broadcasts')
        && (document.querySelector('textarea')?.value ?? '').includes('U'),
      { timeout: 25_000 },
    ).catch(() => {})
    await sleep(600)

    const landed = await page.evaluate(() => ({
      path: location.pathname + location.search,
      // 受眾有沒有自動選到「匯入名單」，名單有沒有填進去
      importChecked: [...document.querySelectorAll('.el-radio')]
        .some(e => e.textContent.includes('匯入名單') && e.className.includes('is-checked')),
      textarea: document.querySelector('textarea')?.value ?? '',
      toast: [...document.querySelectorAll('.admin-toast, [class*="toast"]')]
        .map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '),
    }))

    if (!landed.path.includes('/broadcasts')) {
      fail(`好友頁：按了之後沒有跳到推播頁（現在在 ${landed.path}）`)
      return
    }
    pass('好友頁：按了之後跳到推播頁')

    if (!landed.importChecked) fail('推播頁：受眾沒有自動選成「匯入名單」')
    else pass('推播頁：受眾自動選成「匯入名單」')

    const ids = landed.textarea.split('\n').map(s => s.trim()).filter(Boolean)
    if (ids.length !== 2) {
      fail(`推播頁：名單帶過來 ${ids.length} 筆，預期 2 筆`)
    }
    else if (!ids.every(id => id.startsWith('U'))) {
      fail(`推播頁：帶過來的不是 LINE 編號（拿到 ${ids[0]}）＝送出去一定失敗`)
    }
    else {
      pass(`推播頁：帶入 2 筆 LINE 編號（${ids[0].slice(0, 6)}…）`)
    }
    if (landed.toast) pass(`推播頁提示：「${landed.toast.slice(0, 40)}」`)
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 8：「一檔活動」精靈（`C-212`）⛔ 全程攔截寫入，正式庫不留任何東西 ──────
async function runWizard(page, { failCampaign }) {
  await gotoPage(page, 'campaigns')

  const opened = await clickByText(page, 'button, .el-button', '用精靈建立')
  if (!opened) { fail('活動標籤：找不到「用精靈建立」'); return null }
  await sleep(1500)

  const dialogOk = await page.evaluate(() => [...document.querySelectorAll('.el-dialog')]
    .some(el => el.getBoundingClientRect().width > 0 && el.textContent.includes('用精靈建立一檔活動')))
  if (!dialogOk) { fail('活動標籤：「用精靈建立」按了沒有東西打開'); return null }

  // 填「這一檔叫什麼」；標籤名字應該自己跟著長出來
  const nameInput = await page.$('.el-dialog .el-input__inner')
  await nameInput.click()
  await nameInput.type('ZZ 測試檔期')
  await sleep(600)

  const tagName = await page.evaluate(() => {
    const box = [...document.querySelectorAll('.el-dialog')].find(e => e.getBoundingClientRect().width > 0)
    return [...box.querySelectorAll('input')].map(i => i.value).find(v => v.includes('問卷')) ?? ''
  })
  if (tagName !== '問卷 - ZZ 測試檔期') fail(`精靈：標籤名字沒有跟著活動名字長出來（拿到「${tagName}」）`)
  else pass(`精靈：標籤名字自己填成「${tagName}」（跟正式庫既有的命名習慣一致）`)

  // 填第一則訊息
  const textarea = await page.$('.el-dialog textarea')
  if (textarea) { await textarea.click(); await textarea.type('謝謝報名！') }
  await sleep(400)

  await page.evaluate(() => {
    const box = [...document.querySelectorAll('.el-dialog')].find(e => e.getBoundingClientRect().width > 0)
    const btn = [...box.querySelectorAll('.el-button')].find(b => b.textContent.includes('建立這一檔'))
    btn?.click()
  })
  await sleep(3500)

  return await page.evaluate(() => {
    const box = [...document.querySelectorAll('.el-dialog')].find(e => e.getBoundingClientRect().width > 0)
    if (!box) return null
    return {
      headline: box.querySelector('.cwz__headline')?.textContent?.trim() ?? '',
      headlineOk: !!box.querySelector('.cwz__headline--ok'),
      lines: [...box.querySelectorAll('.cwz__lines li')].map(e => e.textContent.trim()),
      leftovers: [...box.querySelectorAll('.cwz__leftovers li')].map(e => e.textContent.trim()),
      url: box.querySelector('.cwz__url code')?.textContent?.trim() ?? '',
    }
  })
}

async function checkCampaignWizardHappyPath() {
  const { page, ctx } = await openLoggedInPage({
    fakeWrites: (url) => {
      if (url.includes('/api/tag/create')) return { body: { id: 'fake-tag', name: '問卷 - ZZ 測試檔期', code: 'zz' } }
      if (url.includes('/api/flow/create')) return { body: { id: 'fake-flow' } }
      if (url.includes('/api/campaigns/create')) return { body: { id: 'fake-campaign', publishedCtaUrl: 'https://example.test/c/zz' } }
      if (url.includes('/api/broadcast/create')) return { body: { id: 'fake-bc' } }
      return null
    },
  })
  try {
    const res = await runWizard(page, { failCampaign: false })
    if (!res) return
    if (!res.headlineOk) fail(`精靈（全部成功）：標題不是成功樣（「${res.headline}」）`)
    else pass(`精靈（全部成功）：「${res.headline}」`)

    const done = res.lines.filter(l => l.startsWith('✅')).length
    if (done !== 4) fail(`精靈（全部成功）：只有 ${done} 步成功，預期 4 步（標籤／模組／活動／推播草稿）`)
    else pass('精靈（全部成功）：四步都建好了（標籤、模組、活動、推播草稿）')

    if (!res.url.includes('example.test')) fail('精靈（全部成功）：沒有把活動連結秀出來')
    else pass('精靈（全部成功）：結果頁給了活動連結')
    if (res.leftovers.length) fail('精靈（全部成功）：不應該出現「已經建好還留著」那一段')
  }
  finally {
    await ctx.close()
  }
}

async function checkCampaignWizardPartialFailure() {
  const { page, ctx } = await openLoggedInPage({
    fakeWrites: (url) => {
      if (url.includes('/api/tag/create')) return { body: { id: 'fake-tag', name: '問卷 - ZZ 測試檔期', code: 'zz' } }
      if (url.includes('/api/flow/create')) return { body: { id: 'fake-flow' } }
      // 活動這一步失敗＝前面兩樣已經真的建好了，這正是最危險的情況
      if (url.includes('/api/campaigns/create')) return { status: 409, body: { statusMessage: '活動代碼已存在' } }
      if (url.includes('/api/broadcast/create')) return { body: { id: 'fake-bc' } }
      return null
    },
  })
  try {
    const res = await runWizard(page, { failCampaign: true })
    if (!res) return
    if (res.headlineOk) { fail('精靈（活動失敗）：標題還是成功樣'); return }

    if (!res.headline.includes('不要整個重來')) {
      fail(`精靈（活動失敗）：標題沒有叫人別重來（「${res.headline}」）——重跑一次會多出重複的標籤與模組`)
    }
    else {
      pass(`精靈（活動失敗）：「${res.headline}」`)
    }

    if (res.leftovers.length !== 2) {
      fail(`精靈（活動失敗）：只點名了 ${res.leftovers.length} 樣已經建好的東西，預期 2 樣（標籤＋模組）`)
    }
    else {
      pass(`精靈（活動失敗）：點名了已經建好的 2 樣（${res.leftovers.join('／').slice(0, 40)}…）`)
    }

    if (!res.lines.join().includes('活動代碼已存在')) {
      fail('精靈（活動失敗）：沒有把後端給的原因講出來')
    }
    else {
      pass('精靈（活動失敗）：把後端的原因原話講出來了')
    }
    if (!res.lines.some(l => l.startsWith('⏭️'))) {
      fail('精靈（活動失敗）：後面的推播草稿沒有標成「沒有執行」')
    }
    else {
      pass('精靈（活動失敗）：後面那步標成「沒有執行」，沒有硬著頭皮往下做')
    }
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 9：「客人加好友時」那一列（`D-23`）⛔ 全程不存檔 ──────────────────
async function checkFollowWelcomeRow() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'ai-scripts', '.split-list')

    const row = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.split-list > *')]
        .filter(e => e.getBoundingClientRect().width > 0)
      const first = items[0]
      if (!first) return null
      return {
        isFirst: first.textContent.includes('客人加好友時'),
        text: first.innerText.replace(/\s+/g, ' ').trim(),
        unsetStyle: first.className.includes('scripts-follow-row--unset'),
        total: items.length,
      }
    })
    if (!row) { fail('自動回應：清單是空的，量不到那一列'); return }
    if (!row.isFirst) {
      fail(`自動回應：「客人加好友時」不在清單第一列（第一列是「${row.text.slice(0, 20)}」）＝它還是沒有家`)
      return
    }
    pass(`自動回應：第一列固定是「客人加好友時」（${row.text.slice(0, 46)}）`)

    /**
     * MYFEEL 正式資料現在是「一條加好友流程都沒有」，所以這一列應該是「還沒設定」，
     * 而且要講出後果。⛔ 這一關是有真實資料當基準的，不是憑空斷言。
     */
    if (row.unsetStyle) {
      if (!row.text.includes('不會收到任何訊息')) {
        fail('自動回應：沒設定的時候只說「還沒設定」，沒有講後果——那正是最該講清楚的一句')
      }
      else {
        pass('自動回應：沒設定時有講後果（加好友的人不會收到任何訊息）')
      }

      // 點它應該開出淺層設定小視窗（⛔ 不是丟他去空白的新增畫面）
      await page.evaluate(() => {
        const first = [...document.querySelectorAll('.split-list > *')].find(e => e.getBoundingClientRect().width > 0)
        first?.click()
      })
      await sleep(1500)
      const dialog = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.el-dialog')].find(e => e.getBoundingClientRect().width > 0)
        if (!el) return null
        return {
          title: el.querySelector('.el-dialog__title')?.textContent?.trim() ?? '',
          hasModulePick: el.textContent.includes('送一個機器人模組'),
          hasText: el.textContent.includes('直接打一段文字'),
          hasLineNote: el.textContent.includes('LINE 官方帳號後台'),
        }
      })
      if (!dialog) { fail('自動回應：點了那一列沒有任何東西打開'); return }
      pass(`自動回應：點了開出「${dialog.title}」`)
      if (!dialog.hasModulePick || !dialog.hasText) fail('自動回應：小視窗沒有給「選模組／打文字」兩種做法')
      else pass('自動回應：小視窗給了兩種做法（選模組／打文字）')
      if (!dialog.hasLineNote) fail('⛔ 小視窗沒有提醒去 LINE 後台關掉內建歡迎＝客人會連收兩則，而我們偵測不到')
      else pass('自動回應：有提醒去 LINE 後台關掉內建的那則')
      await page.keyboard.press('Escape')
      await sleep(400)
      pass('自動回應：⛔ 全程沒有按「存起來並啟用」，正式庫沒有多出流程')
    }
    else {
      pass(`自動回應：這個帳號已經設過了（${row.text.slice(0, 30)}）——沒設定那條路這次沒驗到`)
    }
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 10：空的「歡迎模組」不該再出現在模組清單（`D-23`）──────────────────
async function checkWelcomeModuleGone() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'flow', '.split-list-item, .admin-split-list button')
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('.split-list > *')]
        .filter(e => e.getBoundingClientRect().width > 0)
        .map(e => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 16)))
    const hasWelcome = names.some(n => n.includes('歡迎模組'))
    if (hasWelcome) {
      fail('機器人模組：清單裡還看得到「歡迎模組」——它沒有執行路徑，留著只會讓人白編內容')
    }
    else {
      pass('機器人模組：空的「歡迎模組」已經不在清單裡')
    }
    if (!names.some(n => n.includes('真人客服'))) {
      fail('機器人模組：連「真人客服」也不見了＝藏過頭（那顆是真的有在用的）')
    }
    else {
      pass('機器人模組：「真人客服」還在（只藏該藏的那一顆）')
    }
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 11：推播「發完幫收到的人貼記號」那一格（`C-213`）⛔ 不存檔不發送 ────
async function checkBroadcastCompletionTag() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'broadcasts')
    if (!await clickByText(page, 'button, .el-button', '新增')) { fail('推播：找不到「新增」鈕'); return }
    await sleep(2000)

    const found = await page.evaluate(() => {
      const group = [...document.querySelectorAll('.admin-field-group')]
        .find(g => g.textContent.includes('發完之後，幫收到的人貼一個記號'))
      if (!group) return null
      return {
        hasPicker: !!group.querySelector('.tag-picker'),
        hasCreate: [...group.querySelectorAll('.el-button')].some(b => b.textContent.includes('新標籤')),
        saysOnlySuccess: group.textContent.includes('只會貼給真的收到的人'),
      }
    })
    if (!found) { fail('推播：發送設定裡沒有「發完之後貼記號」那一格'); return }
    pass('推播：有「發完之後，幫收到的人貼一個記號」那一格')

    if (!found.hasPicker) fail('推播：那一格不是共用的選標籤欄位')
    else pass('推播：那一格用的是共用選標籤欄位')

    // ⛔ 跟「發送對象」刻意相反：這一格是貼上去，所以給得起「＋ 新標籤」
    if (!found.hasCreate) fail('推播：貼記號那一格沒有「＋ 新標籤」——這格是貼標不是篩人，應該給')
    else pass('推播：貼記號那一格有「＋ 新標籤」（與「發送對象」刻意相反）')

    if (!found.saysOnlySuccess) fail('推播：沒有講「只會貼給真的收到的人」——不講的話會被當成全部都貼')
    else pass('推播：有講「只會貼給真的收到的人」')
    pass('推播：⛔ 全程沒有存檔、沒有發送')
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 12：回覆文字插得到「客人的 LINE 名稱」（`D-23`D）──────────────────
async function checkBuiltinVariable() {
  const { page, ctx } = await openLoggedInPage()
  try {
    await gotoPage(page, 'ai-scripts', '.split-list')
    // 挑一條既有流程（它們都有 reply 步驟），不新增、不存檔
    const picked = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.split-list > *')].filter(e => e.getBoundingClientRect().width > 0)
      const target = items.find(e => !e.textContent.includes('客人加好友時'))
      if (!target) return false
      target.click()
      return true
    })
    if (!picked) { fail('自動回應：沒有既有流程可以點開'); return }
    await sleep(2500)

    const menu = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.el-button')]
        .find(b => b.textContent.includes('插入變數') && b.getBoundingClientRect().width > 0)
      if (!btn) return null
      btn.click()
      return true
    })
    if (!menu) {
      fail('自動回應：回覆步驟旁沒有「插入變數」——沒有收集步驟的流程（例如加好友歡迎）就永遠教不到客人名字')
      return
    }
    await sleep(900)
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('.el-dropdown-menu__item')]
        .filter(e => e.getBoundingClientRect().width > 0)
        .map(e => e.textContent.replace(/\s+/g, ' ').trim()))
    if (!items.some(t => t.includes('displayName'))) {
      fail(`自動回應：插入變數選單裡沒有客人名字（看到：${items.join('／').slice(0, 60)}）`)
    }
    else {
      pass(`自動回應：插入變數選單有客人的 LINE 名稱（${items.find(t => t.includes('displayName'))}）`)
    }
    await page.keyboard.press('Escape')
    await sleep(300)
  }
  finally {
    await ctx.close()
  }
}

// ── 關卡 13：選模組那一格（`D-86`）⛔ 全程不存檔、不按建立 ──────────────────
/**
 * 三件事：
 *   ① 網址 `?id=` 直接開那一個模組（沒有它，任何「去看那個模組」的連結都只是把人丟在 71 筆的清單上）
 *   ② 選模組的欄位換成共用的 AdminFlowPicker：打得出字、給得出「編輯這個模組 ↗」
 *   ③ 三種「選了會出事」的狀況要講出來：還沒有內容／已停用／已經被刪掉
 *
 * ⚠️ ③ 用**假造的清單**驗（`flowPickerList`）：正式庫幾乎踩不到這三種，
 *    而要踩到「已刪除」得先真的刪掉一個模組——⛔ 不可以為了驗守門去動正式資料。
 */
async function checkFlowPicker() {
  // ── ① 深連結：先量對照組（不帶 id ＝ 停在空狀態），再量帶 id ──
  {
    const { page, ctx } = await openLoggedInPage()
    try {
      await gotoPage(page, 'flow', '.split-list-name')
      const before = await page.evaluate(() => ({
        editorOpen: !!document.querySelector('.admin-title-input .el-input__wrapper'),
        firstName: document.querySelector('.split-list-name')?.textContent.trim() ?? '',
        firstId: null,
      }))
      if (before.editorOpen) fail('模組頁：還沒點任何模組就已經開著編輯器（對照組不成立）')
      else pass('模組頁：不帶 ?id= 時停在空狀態（對照組成立）')

      /**
       * 拿一個真的模組 id。
       * ⚠️ **不要在頁面裡 `fetch('/api/flow/list')`**：那支要帶 idToken，
       *    瀏覽器裸 fetch 會 401，量出來就變成「拿不到任何模組」——本輪實際紅過一次。
       *    直接跟 Firestore 要（這支腳本本來就有唯讀連線）。
       */
      const target = await (async () => {
        /**
         * ⭐ 刻意挑**最舊的**那一個：側欄是 `createdAt` 新→舊、而且**分頁**載入，
         *    所以最舊的幾乎一定不在第一頁。
         *    這樣這一關才驗得到真正的坑——第一版在 `flows`（分頁後看得見的那一段）裡找，
         *    排在後面的模組一律找不到，還會**誤報成「這個模組被刪掉了」**。
         */
        /**
         * ⚠️ 用 `desc` 再從尾巴取，**不要寫 `asc`**：那是另一個方向、要另一個複合索引，
         *    正式庫沒有（會直接 FAILED_PRECONDITION）。⛔ 不可以為了跑守門去加索引。
         *    `desc` 這個方向 `/api/flow/list` 本來就在用，索引一定在。
         */
        const snap = await db.collection('flows')
          .where('workspaceId', '==', WORKSPACE_ID)
          .orderBy('createdAt', 'desc')
          .get()
        const usable = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(f => f.name && !f.isSystem && Array.isArray(f.messages) && f.messages.length > 0)
        const hit = usable[usable.length - 1]
        return hit ? { id: hit.id, name: String(hit.name) } : null
      })()
      if (!target) { fail('模組頁：拿不到任何模組（?id= 這一關這次沒驗到）'); return }

      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow?id=${encodeURIComponent(target.id)}`, { waitUntil: 'networkidle2', timeout: 120_000 })
      await page.waitForFunction(
        () => !!document.querySelector('.admin-title-input .el-input__wrapper input'),
        { timeout: 40_000 },
      ).catch(() => {})
      await sleep(1200)
      const after = await page.evaluate(() => ({
        name: document.querySelector('.admin-title-input input')?.value ?? '',
        url: location.search,
      }))
      if (after.name !== target.name) {
        fail(`模組頁：?id= 沒有打開那一個（預期「${target.name}」，畫面上是「${after.name}」）`)
      }
      else {
        pass(`模組頁：?id= 直接打開「${after.name}」`)
      }
      // ⛔ 開完要把參數收掉，否則之後手動點別的模組、一重新整理又跳回這一個
      if (after.url.includes('id=')) fail(`模組頁：?id= 開完沒有從網址收掉（還是 ${after.url}）`)
      else pass('模組頁：?id= 開完就從網址收掉了')

      /**
       * ⛔ **左邊也要看得到那一列**（`ensureFlowVisible`）。
       * 側欄是分頁的，排在第一頁之後的模組根本沒有渲染出來——只驗「右邊開了」的話，
       * 會放過「右邊開著某個東西、左邊完全找不到它」這種看起來像開錯的狀態。
       * ⚠️ 這一關就是 `ensureFlowVisible` 的守門：拿掉它這裡會紅，
       *    但上面那一關（標題對不對）不會紅——因為 `selectedFlow` 讀的是 `allFlows`。
       */
      const row = await page.evaluate((name) => {
        const el = [...document.querySelectorAll('.split-list-name')]
          .find(e => e.textContent.trim() === name && e.getBoundingClientRect().width > 0)
        if (!el) return { visible: false, active: false }
        return { visible: true, active: !!el.closest('.split-list-item')?.classList.contains('active') }
      }, target.name)
      if (!row.visible) fail(`模組頁：?id= 開了右邊，左邊側欄卻看不到「${target.name}」那一列`)
      else if (!row.active) fail(`模組頁：側欄上的「${target.name}」沒有反白＝看不出現在在編哪一個`)
      else pass(`模組頁：側欄也捲出「${target.name}」並反白`)
    }
    finally { await ctx.close() }
  }

  // ── ②③ 用假造的清單驗那顆共用元件 ──
  const FAKE = [
    { id: 'fake-ok', name: 'ZZ 測試-正常模組', isActive: true, messageCount: 2 },
    { id: 'fake-empty', name: 'ZZ 測試-空模組', isActive: true, messageCount: 0 },
    { id: 'fake-off', name: 'ZZ 測試-停用模組', isActive: false, messageCount: 1 },
  ]
  const { page, ctx } = await openLoggedInPage({ flowPickerList: FAKE })
  try {
    await gotoPage(page, 'support-presets', '.split-list-name')

    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.flow-picker')].filter(e => e.getBoundingClientRect().width > 0).length)
    if (before !== 0) fail('客服預存：還沒打開編輯器就看得到選模組欄位（對照組不成立）')
    else pass('客服預存：還沒打開編輯器時沒有選模組欄位（對照組成立）')

    // 打開一則預存 → 把動作切成「機器人模組」
    const opened = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.split-list-name')].find(e => e.getBoundingClientRect().width > 0)
      if (!el) return false
      ;(el.closest('.split-list-item') ?? el).click()
      return true
    })
    if (!opened) { fail('客服預存：清單上沒有東西可以點開'); return }
    await sleep(2500)

    // 動作類型下拉：選「機器人模組」
    const switched = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('.admin-field-label')]
      const field = labels.find(l => l.textContent.includes('動作類型'))?.parentElement
      const input = field?.querySelector('.el-select input')
      if (!input) return false
      input.click()
      return true
    })
    if (!switched) { fail('客服預存：找不到「動作類型」下拉'); return }
    await sleep(700)
    await page.evaluate(() => {
      const opt = [...document.querySelectorAll('.el-select-dropdown__item')]
        .find(e => e.textContent.trim().includes('機器人模組') && e.getBoundingClientRect().width > 0)
      opt?.click()
    })
    await sleep(1200)

    const picker = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.flow-picker')].find(e => e.getBoundingClientRect().width > 0)
      if (!el) return null
      return {
        filterable: !!el.querySelector('.el-select input:not([readonly])'),
        createBtn: [...el.querySelectorAll('.el-button')].some(b => b.textContent.includes('新模組')),
      }
    })
    if (!picker) { fail('客服預存：切成「機器人模組」之後看不到共用的選模組欄位（.flow-picker）'); return }
    pass('客服預存：切成「機器人模組」出現共用的選模組欄位')
    if (!picker.filterable) fail('客服預存：選模組的下拉不能打字搜尋（71 個模組用捲的找不到）')
    else pass('客服預存：選模組的下拉打得出字')
    if (!picker.createBtn) fail('客服預存：選模組欄位沒有「＋ 新模組」＝模組不存在時還是死路')
    else pass('客服預存：選模組欄位有「＋ 新模組」')

    // 選「空模組」→ 要標「還沒有內容」且底下講後果
    const pickFake = async (name) => {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('.flow-picker .el-select input')].find(e => e.getBoundingClientRect().width > 0)
        el?.click()
      })
      await sleep(600)
      const ok = await page.evaluate((n) => {
        const opt = [...document.querySelectorAll('.el-select-dropdown__item')]
          .find(e => e.textContent.includes(n) && e.getBoundingClientRect().width > 0)
        if (!opt) return false
        opt.click()
        return true
      }, name)
      await sleep(900)
      return ok
    }

    if (!await pickFake('ZZ 測試-空模組')) {
      fail('客服預存：下拉裡找不到假造的空模組（攔截沒生效？這三關這次沒驗到）')
    }
    else {
      const empty = await page.evaluate(() => {
        const el = document.querySelector('.flow-picker')
        return {
          warn: el?.querySelector('.flow-picker__warn')?.textContent.trim() ?? '',
          selected: el?.querySelector('.el-select input')?.value ?? '',
        }
      })
      if (!empty.warn.includes('還沒有任何內容')) {
        fail(`客服預存：選到空模組沒有講後果（拿到「${empty.warn}」）`)
      }
      else {
        pass(`客服預存：選到空模組會講後果（「${empty.warn.slice(0, 26)}…」）`)
      }
    }

    if (!await pickFake('ZZ 測試-停用模組')) {
      fail('客服預存：下拉裡找不到假造的停用模組')
    }
    else {
      const off = await page.evaluate(() =>
        document.querySelector('.flow-picker__warn')?.textContent.trim() ?? '')
      if (!off.includes('停用')) fail(`客服預存：選到停用的模組沒有講（拿到「${off}」）`)
      else pass('客服預存：選到停用的模組會講')
    }

    // 「編輯這個模組 ↗」：要在、要開新分頁、要帶 ?id=
    if (!await pickFake('ZZ 測試-正常模組')) {
      fail('客服預存：下拉裡找不到假造的正常模組')
    }
    else {
      const link = await page.evaluate(() => {
        const a = document.querySelector('.flow-picker__edit')
        return a ? { href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent.trim() } : null
      })
      if (!link) fail('客服預存：選了模組之後沒有「編輯這個模組 ↗」＝還是跳不過去')
      else if (!link.href?.includes('id=fake-ok')) fail(`客服預存：「編輯這個模組」沒帶到那一筆（${link.href}）`)
      // ⛔ 同分頁跳走＝把他填到一半的表單丟掉（這幾頁都掛了「還沒存喔」攔截）
      else if (link.target !== '_blank') fail('客服預存：「編輯這個模組」不是開新分頁＝會丟掉他還沒存的東西')
      else pass(`客服預存：「編輯這個模組 ↗」開新分頁且帶到那一筆（${link.href}）`)

      const warn = await page.evaluate(() =>
        document.querySelector('.flow-picker__warn')?.textContent.trim() ?? '')
      if (warn) fail(`客服預存：選到正常模組卻還在警告（「${warn}」）——那樣警告就沒人看了`)
      else pass('客服預存：選到正常模組時沒有多餘的警告')
    }

    // 「＋ 新模組」打得開，⛔ 只看不按建立（不在正式庫留東西）
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.flow-picker .el-button')].find(e => e.textContent.includes('新模組'))
      b?.click()
    })
    await sleep(900)
    const dialog = await page.evaluate(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find(e => e.getBoundingClientRect().width > 0)
      if (!d) return null
      return {
        title: d.querySelector('.el-dialog__title')?.textContent.trim() ?? '',
        fields: [...d.querySelectorAll('.admin-field-label')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
      }
    })
    if (!dialog) fail('客服預存：「＋ 新模組」按了沒有東西打開')
    else {
      pass(`客服預存：「＋ 新模組」打得開（${dialog.title}）`)
      /**
       * ⛔ 一定要有「先回這段話」那一格：只問名字建出來的是**空模組**，
       *    而空模組＝客人走到這裡什麼都收不到（`D-23` 那幾百位就是這樣沒收到的）。
       *    後端 `assertValidFlowMessages` 也擋著，但錯誤要在他還看得到表單時就講。
       */
      if (!dialog.fields.some(f => f.includes('先回這段話'))) {
        fail(`客服預存：新模組視窗沒有「先回這段話」那一格＝會生出空模組（欄位：${dialog.fields.join('／')}）`)
      }
      else {
        pass('客服預存：新模組視窗要求先寫一句回覆＝生不出空模組')
      }
    }
    await page.keyboard.press('Escape')
    await sleep(400)
  }
  finally {
    await ctx.close()
  }
}

try {
  console.log('── 暖機（避免把「還在編譯」量成「元件壞了」）──')
  await warmup(['campaigns', 'support-presets', 'broadcasts', 'flow', 'tags', 'users', 'ai-scripts'])
  console.log('\n── 活動標籤 ──────────────────────────────')
  await checkCampaigns()
  console.log('\n── 客服預存 ──────────────────────────────')
  await checkSupportPresets()
  console.log('\n── 推播受眾（刻意不給建立鈕）──────────────')
  await checkBroadcastAudience()
  console.log('\n── 一顆標籤都沒有的新帳號 ──────────────────')
  await checkEmptyState()
  console.log('\n── 模組「會在這些時候發出」（C-209）────────')
  await checkModuleUsage()
  console.log('\n── 標籤「用在哪」（C-209）──────────────────')
  await checkTagUsage()
  console.log('\n── 好友頁「推播給這 N 位」（C-210）─────────')
  await checkBroadcastHandoff()
  console.log('\n── 「一檔活動」精靈：全部成功（C-212）──────')
  await checkCampaignWizardHappyPath()
  console.log('\n── 「一檔活動」精靈：活動那步失敗（C-212）──')
  await checkCampaignWizardPartialFailure()
  console.log('\n── 「客人加好友時」那一列（D-23）──────────')
  await checkFollowWelcomeRow()
  console.log('\n── 選模組那一格＋?id= 深連結（D-86）────────')
  await checkFlowPicker()
  console.log('\n── 空的「歡迎模組」已經拿掉（D-23）────────')
  await checkWelcomeModuleGone()
  console.log('\n── 推播「發完貼記號」那一格（C-213）────────')
  await checkBroadcastCompletionTag()
  console.log('\n── 回覆文字插得到客人名字（D-23 D）────────')
  await checkBuiltinVariable()
}
finally {
  await browser.close()
  if (prefsData) await prefsRef.set(prefsData)
  else if ((await prefsRef.get()).exists) await prefsRef.delete()
  console.log(`\nadminUserPrefs/${uid} 已${prefsData ? '還原成原本的內容' : '刪回原本的「不存在」'}`)
}

console.log(failed ? '\n❌ 有關卡沒過' : '\n✅ 全部通過')
process.exit(failed ? 1 : 0)
