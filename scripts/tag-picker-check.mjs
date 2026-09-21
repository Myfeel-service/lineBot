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
const SILENCE_TOURS = ['campaigns', 'support-presets', 'broadcasts']
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

  if (opts.emptyTagList) {
    // ⛔ 用攔截而不是真的去刪標籤：正式庫有 39 顆標籤，空狀態這條路平常永遠走不到，
    //    但它正是新帳號第一天唯一會看到的東西。
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().includes('/api/tag/list')) {
        req.respond({ status: 200, contentType: 'application/json', body: '[]' })
        return
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

async function gotoPage(page, path) {
  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/${path}`, { waitUntil: 'networkidle2', timeout: 120_000 })
  // 等畫面真的長出東西再往下量；⛔ 逾時就明講「這次沒量到」，不要當成綠燈
  try {
    await page.waitForFunction(() => document.body.innerText.trim().length > 50, { timeout: 60_000 })
  }
  catch {
    fail(`${path}：等了 60 秒畫面還是空的（dev server 可能還在編譯）＝這一頁這次沒驗到`)
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

    // 打字 → 代號要自己長出來，而且必須是後端收得下的格式
    const inputs = await page.$$('.el-dialog .el-input__inner')
    if (inputs.length < 2) { fail('活動標籤：小視窗裡的欄位數不對'); return }
    await inputs[0].click()
    await inputs[0].type('Zz Check Only')
    await sleep(700)

    const code = await page.evaluate(() => {
      const box = [...document.querySelectorAll('.el-dialog')].find(el => el.getBoundingClientRect().width > 0)
      const labels = [...box.querySelectorAll('.admin-field-group')]
      const codeGroup = labels.find(g => g.textContent.includes('英文代號'))
      return codeGroup?.querySelector('input')?.value ?? ''
    })
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      fail(`活動標籤：代號沒有自動填成合法的值（拿到「${code}」）＝人還是要自己想一個，而且填錯會被後端退件`)
    }
    else if (code !== 'zz_check_only') {
      fail(`活動標籤：代號預填成「${code}」，預期 zz_check_only`)
    }
    else {
      pass(`活動標籤：打完名字，代號自己填成「${code}」（合法、可改）`)
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

    const createBtns = await countCreateButtons(page)
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

try {
  console.log('── 暖機（避免把「還在編譯」量成「元件壞了」）──')
  await warmup(['campaigns', 'support-presets', 'broadcasts'])
  console.log('\n── 活動標籤 ──────────────────────────────')
  await checkCampaigns()
  console.log('\n── 客服預存 ──────────────────────────────')
  await checkSupportPresets()
  console.log('\n── 推播受眾（刻意不給建立鈕）──────────────')
  await checkBroadcastAudience()
  console.log('\n── 一顆標籤都沒有的新帳號 ──────────────────')
  await checkEmptyState()
}
finally {
  await browser.close()
  if (prefsData) await prefsRef.set(prefsData)
  else if ((await prefsRef.get()).exists) await prefsRef.delete()
  console.log(`\nadminUserPrefs/${uid} 已${prefsData ? '還原成原本的內容' : '刪回原本的「不存在」'}`)
}

console.log(failed ? '\n❌ 有關卡沒過' : '\n✅ 全部通過')
process.exit(failed ? 1 : 0)
