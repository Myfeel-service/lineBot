/**
 * 推播預覽 ＋ 卡片文案兩格的實機守門員（2026-09-23，`C-228`②／`C-229`）。
 *
 *   npm run dev -- --port 3318                                       # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3318 node --env-file=.env_myfeel scripts/broadcast-preview-check.mjs
 *
 * **為什麼一定要真的開瀏覽器**：這一輪改的東西，單元測試只驗得到「資料轉換對不對」
 * （`shared/broadcast-content.card-copy.test.ts`），驗不到「那塊預覽有沒有真的被畫出來」
 * 「打字之後它有沒有跟著動」「那兩格有沒有出現在該出現的地方、沒出現在不該出現的地方」。
 * 這個專案吃過九次「typecheck 綠＋測試綠，但新程式根本沒被執行到」
 * （記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * ⚠️ **連的是正式資料庫（myfeel），但全程不寫任何東西**：
 *    - 讀 `workspaceMembers` 找一個管理員登入（唯讀）
 *    - 瀏覽器只開「新增」表單並打字，⛔ **絕不按「儲存草稿」「驗證並發送」**
 *      （所以正式庫不會多出任何一則測試推播，也不會有任何客人收到訊息）
 *    - 唯一可能被寫到的是 `adminUserPrefs/{uid}`（自動導覽的「看過了」），跑前抄下來、跑完原封還原
 *
 * ⛔ **內建對照組**：光斷言「有看到預覽」是假綠燈——選擇器寫成一個到處都在的東西也會綠。
 *    所以每一關都成對量：切成「傳送文字」時那兩格**必須消失**、圖文選單頁**必須沒有**那兩格、
 *    按「隱藏預覽」之後預覽**必須不見**。
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

/** ⛔ 先把導覽標成看過：它會用 `clickBefore` 幫使用者按「新增」，對照組會忽紅忽綠（見 tag-picker-check 檔頭） */
const SILENCE_TOURS = ['broadcasts', 'richmenu']
await prefsRef.set({
  ...(prefsData ?? {}),
  seenTours: {
    ...(prefsData?.seenTours ?? {}),
    ...Object.fromEntries(SILENCE_TOURS.map(id => [id, new Date()])),
  },
}, { merge: true })
console.log(`adminUserPrefs/${uid}：${prefsBefore.exists ? '原本有資料，已抄下來' : '原本不存在'}，已暫時把 ${SILENCE_TOURS.join('／')} 導覽標成看過，跑完還原`)

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
const fail = (msg, detail = '') => { failed = true; console.error(`❌ ${msg}${detail ? `\n     ${detail}` : ''}`) }
const pass = msg => console.log(`✅ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

async function openLoggedInPage(path) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1600, height: 1100 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  /** ⛔ 一定要接原生對話框：這幾頁掛了「還沒存喔」，沒人回答會卡死整個 JS 執行緒直到 protocolTimeout */
  page.on('dialog', async d => { await d.accept().catch(() => {}) })

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 120_000 })
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

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 120_000 })
  return page
}

/** 這一頁畫面上「有沒有那兩格」「預覽長什麼樣」一次量完 */
const probe = () => ({
  labels: [...document.querySelectorAll('.admin-field-label, .admin-field-label__text')]
    .map(el => el.innerText.trim()),
  previewVisible: !!document.querySelector('.fmp') && document.querySelector('.fmp').offsetHeight > 0,
  cardText: document.querySelector('.fmp-card-text')?.innerText?.trim() ?? '',
  bubbleText: document.querySelector('.fmp-bubble')?.innerText?.trim() ?? '',
  buttons: [...document.querySelectorAll('.fmp-btn')].map(el => el.innerText.trim()),
  previewRaw: document.querySelector('.fmp')?.innerText ?? '',
})

const hasCardCopyFields = seen =>
  seen.labels.some(t => t.includes('卡片上要寫什麼')) && seen.labels.some(t => t.includes('按鈕上要寫什麼'))

/** 換動作類型：el-select 不是原生 select，要點開再點選項 */
async function pickActionType(page, label) {
  await page.evaluate(() => {
    const group = [...document.querySelectorAll('.admin-field-group')]
      .find(g => g.innerText.includes('動作類型'))
    group.querySelector('.el-select').click()
  })
  await sleep(400)
  const ok = await page.evaluate((want) => {
    const opt = [...document.querySelectorAll('.el-select-dropdown__item')]
      .find(el => el.innerText.trim() === want)
    if (!opt) return false
    opt.click()
    return true
  }, label)
  await sleep(500)
  return ok
}

/**
 * ⛔ **要照「欄位標題」找，不可以用整個 `.admin-field-group` 的 innerText 比對**：
 * 「動作類型」那一格的下拉**顯示的值就是「開啟網址」**，拿 innerText 找「網址」會先撞到它，
 * 於是字被打進下拉的搜尋框、真正的網址欄一個字都沒有——畫面看起來就像「預覽沒反應」。
 * 第一次跑就是這樣紅三關，而程式其實是好的。
 *
 * ⛔ 也**不可以用 `childNodes[0]`** 取標題文字：Vue 會在標題前面插一個空的錨點文字節點，
 * 拿第一個子節點永遠是空字串（第二次跑就是這樣紅的，一樣不是程式的問題）。
 * 用整顆的 `textContent`、扣掉說明用的 hint 才穩。
 */
async function typeInto(page, labelText, value) {
  const ok = await page.evaluate((lt) => {
    const titleOf = (el) => {
      const clone = el.cloneNode(true)
      clone.querySelectorAll('.admin-field-label__hint').forEach(n => n.remove())
      return clone.textContent.trim()
    }
    const label = [...document.querySelectorAll('.admin-field-label')]
      .find(el => titleOf(el).startsWith(lt))
    const input = label?.closest('.admin-field-group')?.querySelector('textarea, input:not(.el-select__input)')
    if (!input) return false
    input.focus()
    return true
  }, labelText)
  if (!ok) return false
  await page.keyboard.type(value, { delay: 8 })
  await sleep(400)
  return true
}

try {
  // ══ 推播頁 ══════════════════════════════════════════════════════
  console.log('── 推播：新增一則（不會儲存、不會發送）────────')
  const page = await openLoggedInPage(`/admin/${WORKSPACE_ID}/broadcasts`)
  await page.waitForSelector('[data-tour="bc-new"]', { timeout: 60_000 })

  /** 對照組：還沒開編輯器之前，畫面上不該有預覽面板 */
  const before = await page.evaluate(probe)
  if (before.previewVisible) fail('對照組失敗：還沒開編輯器就看得到預覽面板（選擇器可能抓錯東西）')
  else pass('對照組：還沒開編輯器時沒有預覽面板')

  await page.click('[data-tour="bc-new"]')
  await page.waitForSelector('[data-tour="bc-content"]', { timeout: 30_000 })
  await sleep(800)

  // ── ① 預設就打開 ─────────────────────────────────
  const opened = await page.evaluate(probe)
  if (opened.previewVisible) pass('① 開啟編輯器後，預覽面板預設就是打開的')
  else fail('① 預覽面板沒有出現', 'C-229 的預覽沒有被渲染出來')

  // ── ② 選「開啟網址」→ 兩格出現、預覽畫出預設卡片文案 ──
  if (!await pickActionType(page, '開啟網址')) fail('找不到「開啟網址」這個選項')
  if (!await typeInto(page, '網址', 'https://example.com/moon')) fail('找不到「網址」欄位')
  const uriSeen = await page.evaluate(probe)

  if (hasCardCopyFields(uriSeen)) pass('② 「卡片上要寫什麼」「按鈕上要寫什麼」兩格有出現')
  else fail('② 那兩格沒有出現', `量到的欄位：${uriSeen.labels.join('／')}`)

  if (uriSeen.cardText === '點下面的按鈕看看' && uriSeen.buttons.includes('看詳情')) {
    pass('② 預覽畫出了系統套進去的預設文案（「點下面的按鈕看看」＋按鈕「看詳情」）')
  }
  else {
    fail('② 預覽沒有畫出預設文案', `卡片本文＝「${uriSeen.cardText}」、按鈕＝${JSON.stringify(uriSeen.buttons)}`)
  }

  // ── ③ 打字，預覽要跟著動 ───────────────────────────
  if (!await typeInto(page, '卡片上要寫什麼', '中秋禮盒開賣了')) fail('找不到「卡片上要寫什麼」欄位')
  if (!await typeInto(page, '按鈕上要寫什麼', '去逛逛')) fail('找不到「按鈕上要寫什麼」欄位')
  const typed = await page.evaluate(probe)
  if (typed.cardText === '中秋禮盒開賣了' && typed.buttons.includes('去逛逛')) {
    pass('③ 店家打的字即時反映到預覽上')
  }
  else {
    fail('③ 打了字但預覽沒跟著動', `卡片本文＝「${typed.cardText}」、按鈕＝${JSON.stringify(typed.buttons)}`)
  }

  // ── ④ 換成「觸發機器人模組」：客人眼前不可以有「機器人模組」 ──
  if (!await pickActionType(page, '觸發機器人模組')) fail('找不到「觸發機器人模組」這個選項')
  await sleep(600)
  /**
   * ⛔ **一定要真的選一個模組**：沒選的話 `unifiedActionToLineMessages` 回空陣列、
   * 預覽本來就該是空的——那是正確行為，不是壞掉。第三次跑就是漏了這一步紅在這裡。
   */
  const pickedModule = await page.evaluate(() => {
    const sel = document.querySelector('.flow-picker .el-select')
    if (!sel) return false
    sel.click()
    return true
  })
  if (!pickedModule) fail('④ 找不到選模組的欄位（`AdminFlowPicker` 沒渲染出來？）')
  await sleep(500)
  const gotModule = await page.evaluate(() => {
    const opt = document.querySelector('.el-select-dropdown__item .flow-picker__option')
    if (!opt) return ''
    const name = opt.querySelector('.flow-picker__option-name')?.innerText?.trim() ?? ''
    opt.closest('.el-select-dropdown__item').click()
    return name
  })
  if (!gotModule) fail('④ 模組清單是空的，這一關驗不到')
  else console.log(`   （選到的模組：${gotModule}）`)
  await sleep(600)
  const modSeen = await page.evaluate(probe)
  if (modSeen.buttons.includes('開始') && modSeen.cardText === '點下面的按鈕看看') {
    pass('④ 模組卡的預設文案正確（本文同一句、按鈕「開始」）')
  }
  else {
    fail('④ 模組卡預設文案不對', `卡片本文＝「${modSeen.cardText}」、按鈕＝${JSON.stringify(modSeen.buttons)}`)
  }
  /** ⭐ 這一關是整份的重點：`D-87` 挖出來的事就是這四個字跑到客人手機上 */
  if (modSeen.previewRaw.includes('機器人模組')) {
    fail('④ 預覽裡出現「機器人模組」四個字', '那是後台自用的詞，不可以送到客人眼前')
  }
  else {
    pass('④ 預覽裡沒有「機器人模組」四個字')
  }
  /** 換類型要把上一輪打的字清掉，否則會留下一個看不到也刪不掉的殘值 */
  if (modSeen.cardText === '中秋禮盒開賣了') fail('④ 換動作類型後，上一輪的卡片文案沒有被清掉')
  else pass('④ 換動作類型後，上一輪打的卡片文案有被清掉')

  // ── ⑤ 對照組：「傳送文字」沒有卡片，那兩格必須消失 ──
  if (!await pickActionType(page, '傳送文字')) fail('找不到「傳送文字」這個選項')
  if (!await typeInto(page, '回覆文字', '今天公休')) fail('找不到「回覆文字」欄位')
  const msgSeen = await page.evaluate(probe)
  if (hasCardCopyFields(msgSeen)) {
    fail('⑤ 對照組失敗：「傳送文字」不會產生卡片，卻還看得到那兩格', '會讓人填一個永遠不會出現的東西')
  }
  else {
    pass('⑤ 對照組：「傳送文字」時那兩格消失了')
  }
  if (msgSeen.bubbleText === '今天公休' && msgSeen.buttons.length === 0) {
    pass('⑤ 純文字預覽是一顆氣泡，⛔ 沒有冒出客人不會看到的按鈕')
  }
  else {
    fail('⑤ 純文字預覽不對', `氣泡＝「${msgSeen.bubbleText}」、按鈕＝${JSON.stringify(msgSeen.buttons)}`)
  }

  // ── ⑥ 「只會送出一則訊息」那行提示 ───────────────
  const oneMsgHint = await page.evaluate(() =>
    document.querySelector('[data-tour="bc-content"]')?.innerText?.includes('只會送出一則訊息') ?? false)
  if (oneMsgHint) pass('⑥ 畫面上講了「一則推播只會送出一則訊息」（F-9）')
  else fail('⑥ 沒有講「只會送出一則訊息」', '想發圖＋文字的人會在這頁一直找加第二則的地方')

  // ── ⑨ 超過 5000 字：被丟掉的那一段一定要講出來 ─────
  /**
   * ⛔ 這一關驗的是「沉默死亡」：原本純文字氣泡只畫得下的部分，**超出的直接不見**，
   * 畫面上看起來一切正常、客人卻收到半截（跟 `H-27` 同一個病躲在另一個分支）。
   * 推播的「回覆文字」沒有字數上限，所以這條路是真的走得到的。
   * ⚠️ 用 JS 灌值＋手動派 input 事件（打 5001 個字太慢），派事件才會進 Vue 的 v-model。
   */
  const longSet = await page.evaluate((n) => {
    const titleOf = (el) => {
      const c = el.cloneNode(true)
      c.querySelectorAll('.admin-field-label__hint').forEach(x => x.remove())
      return c.textContent.trim()
    }
    const label = [...document.querySelectorAll('.admin-field-label')].find(el => titleOf(el).startsWith('回覆文字'))
    const input = label?.closest('.admin-field-group')?.querySelector('textarea, input:not(.el-select__input)')
    if (!input) return false
    input.value = '字'.repeat(n)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, 5050)
  if (!longSet) fail('⑨ 找不到「回覆文字」欄位，這一關驗不到')
  await sleep(700)
  const longSeen = await page.evaluate(() => ({
    cutVisible: !!document.querySelector('.fmp-bubble-cut') && document.querySelector('.fmp-bubble-cut').offsetHeight > 0,
    cutLabel: document.querySelector('.fmp-bubble-cut .fmp-card-cut-label')?.innerText?.trim() ?? '',
    keptLen: (document.querySelector('.fmp-bubble')?.innerText ?? '').length,
  }))
  if (longSeen.cutVisible && longSeen.cutLabel.includes('50 字送不出去')) {
    pass('⑨ 超過上限時，被丟掉的那 50 字有被標出來（⛔ 不再無聲消失）')
  }
  else {
    fail('⑨ 超過上限但畫面沒講被丟掉幾字', `看到的標籤＝「${longSeen.cutLabel}」、氣泡長度＝${longSeen.keptLen}`)
  }
  /** 對照組：把字改短，那一塊必須消失（不然它只是永遠掛在那裡） */
  await page.evaluate(() => {
    const titleOf = (el) => {
      const c = el.cloneNode(true)
      c.querySelectorAll('.admin-field-label__hint').forEach(x => x.remove())
      return c.textContent.trim()
    }
    const label = [...document.querySelectorAll('.admin-field-label')].find(el => titleOf(el).startsWith('回覆文字'))
    const input = label?.closest('.admin-field-group')?.querySelector('textarea, input:not(.el-select__input)')
    input.value = '今天公休'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(600)
  const shortAgain = await page.evaluate(() => !!document.querySelector('.fmp-bubble-cut'))
  if (shortAgain) fail('⑨ 對照組失敗：字改短了，「送不出去」那一塊還在')
  else pass('⑨ 對照組：字改短之後那一塊消失了')

  // ── ⑦ 對照組：按「隱藏預覽」要真的不見 ─────────────
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.admin-header-actions .el-button')]
      .find(b => b.innerText.trim() === '隱藏預覽')
    btn?.click()
  })
  await sleep(500)
  const hidden = await page.evaluate(probe)
  if (hidden.previewVisible) fail('⑦ 對照組失敗：按了「隱藏預覽」但預覽還在')
  else pass('⑦ 對照組：按「隱藏預覽」之後預覽真的不見了')

  await page.close()

  // ══ 圖文選單頁：同一支元件，但那兩格不該出現 ══════════════════
  console.log('\n── 圖文選單：同一支動作編輯器，但不該有那兩格 ────────')
  const rmPage = await openLoggedInPage(`/admin/${WORKSPACE_ID}/richmenu`)
  await rmPage.waitForSelector('[data-tour="rm-list"], .split-sidebar-empty', { timeout: 60_000 })
  const rmOpened = await rmPage.evaluate(() => {
    const row = document.querySelector('[data-tour="rm-list"] .split-list-item, [data-tour="rm-list"] button')
    if (!row) return false
    row.click()
    return true
  })
  if (!rmOpened) {
    console.log('⚠️ 這個工作區沒有圖文選單可以點開，⑧ 跳過（不算過也不算不過）')
  }
  else {
    await sleep(2500)
    const rmSeen = await rmPage.evaluate(probe)
    if (hasCardCopyFields(rmSeen)) {
      fail('⑧ 圖文選單出現了卡片文案那兩格', '客人是直接點圖上的格子，沒有卡片也沒有按鈕文字')
    }
    else {
      pass('⑧ 圖文選單沒有那兩格（`enableCardCopy` 的隔離有效）')
    }
    /** 對照組：確定真的開到了編輯器，否則「沒看到那兩格」只是因為什麼都沒開 */
    if (rmSeen.labels.some(t => t.includes('動作類型'))) pass('⑧ 對照組：圖文選單的動作編輯器確實開著')
    else fail('⑧ 對照組失敗：圖文選單的編輯器沒開起來，上面那關等於沒驗到')
  }
  await rmPage.close()
}
finally {
  await browser.close()
  if (prefsData) await prefsRef.set(prefsData)
  else if ((await prefsRef.get()).exists) await prefsRef.delete()
  console.log(`\nadminUserPrefs/${uid} 已${prefsData ? '還原成原本的內容' : '刪回原本的「不存在」'}`)
}

console.log(failed ? '\n❌ 有關卡沒過' : '\n✅ 全部通過')
process.exit(failed ? 1 : 0)
