/**
 * 「插入變數要插在游標位置」的實機守門員。
 *
 *   npm run dev                                           # 另一個終端先跑起來
 *   node --env-file=.env_myfeel scripts/flow-variable-caret-check.mjs
 *   （dev server 不在 3000 時：CHECK_BASE_URL=http://localhost:3199 node --env-file=... ）
 *
 * 為什麼要有這支：`app/utils/insert-token-at-caret.test.ts` 證明得了「算出來的字串對」，
 * 證明不了「按鈕按下去時真的有把游標位置記下來」——而這整件事的成敗就在那個時機點
 * （按鈕一被按下輸入框就失焦了）。這個專案吃過太多次「typecheck 綠＋測試綠，但新程式
 * 根本沒被執行到」（記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * ⛔ 一定要用 puppeteer 的**真滑鼠點擊**（`ElementHandle.click()`）：`el.click()` 只會
 *   發 click，不會發 pointerdown，這支守的那個 handler 就整個不會跑——會得到一個
 *   「看起來像舊行為」的假紅燈。
 *
 * 量四件事：
 *   ① 游標在中間 → 插在中間（不是接在最後面）
 *   ② 插完游標停在變數後面、焦點回到輸入框（否則使用者得再點一次才能接著打字）
 *   ③ 選取一段 → 取代掉那段
 *   ④ 焦點不在輸入框時 → 維持舊行為接在最後面（不可以插到第 0 個字）
 *   ⑤ 單行輸入框（按鈕文字）也要同樣會動——那條走的是 input[type=text]，跟 textarea 不同分支
 *
 * ⛔ 這支只改畫面上的暫存狀態，不按「儲存變更」，並且全程攔截 PUT 斷言沒有寫入。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
/** 鼴究室 */
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '7dfc1033-f069-4a28-8d22-a72cb590a34f'
/** 飛利浦AC0510｜預熱（有一則「文字＋按鈕」的訊息，textarea 與單行輸入框都看得到） */
const FLOW_ID = process.env.CHECK_FLOW_ID ?? '58d6846d-7d76-4991-9c60-c4491a756e9c'

const TOKEN = '{{displayName}}'
const SAMPLE = '您好，請問要寄到哪'

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

const db = getFirestore()

const flowDoc = await db.collection('flows').doc(FLOW_ID).get()
if (!flowDoc.exists) { console.error(`查無模組 ${FLOW_ID}`); process.exit(1) }
const flowName = flowDoc.data().name
console.log(`受測模組：${flowName}`)

const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
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
await page.setViewport({ width: 1600, height: 1100 })
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))

// ⛔ 全程監看寫入：這支不該送出任何一筆
let sawWrite = false
page.on('request', (req) => {
  if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(req.method()) && req.url().includes('/api/flow')) sawWrite = true
})

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

await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow`, { waitUntil: 'networkidle2', timeout: 120_000 })
await page.waitForSelector('.flow-sidebar-row', { timeout: 60_000 })

const opened = await page.evaluate((name) => {
  const row = [...document.querySelectorAll('.flow-sidebar-row')].find(el => el.innerText?.includes(name))
  if (!row) return false
  ;(row.querySelector('.flow-sidebar-row__item') ?? row).click()
  return true
}, flowName)
if (!opened) { console.error(`左側清單找不到「${flowName}」`); await browser.close(); process.exit(1) }
await page.waitForSelector('.flow-textarea-wrapper--var-inset textarea', { timeout: 30_000 })
await new Promise(r => setTimeout(r, 1500))

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 把文字塞回 v-model（走原生 setter＋input 事件，等同使用者自己打的） */
async function resetField(wrapSelector, fieldSelector, value) {
  await page.evaluate((wrapSel, fieldSel, v) => {
    const el = document.querySelector(wrapSel)?.querySelector(fieldSel)
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, wrapSelector, fieldSelector, value)
  await sleep(150)
}

/**
 * 真的用滑鼠按下去（捲到畫面中間 → 量座標 → CDP 滑鼠點）。
 * ⛔ 一定要真滑鼠：`el.click()` 只發 click 不發 pointerdown，這功能的關鍵 handler
 *   就整個不會跑，會得到一個「看起來像舊行為」的假紅燈。
 * ⛔ 點之前先問 `elementFromPoint`：座標沒對準的話點到的是別人，量出來的東西沒有意義。
 */
async function mouseClick(selector, matchText = '', scroll = true) {
  const point = await page.evaluate((sel, text, doScroll) => {
    // ⛔ 只認「看得見」的：每個插入鈕都有自己的下拉，關掉的那些會留在 DOM 裡
    //   （Element Plus 的 popper 是 persistent），照 querySelector 抓第一個會抓到
    //   躲在角落的隱形選單，座標落在側欄上（實測踩到）。
    const visible = el => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0)
    const targets = [...document.querySelectorAll(sel)]
      .filter(el => (!text || el.innerText?.includes(text)) && visible(el))
    const el = targets[0]
    if (!el) return null
    // ⛔ 下拉選單不可以捲：它是 teleport 出去、靠 popper 貼著按鈕定位的，
    //   捲動後 popper 要下一幀才跟上，當下量到的座標會落在別的地方（實測點到側欄）。
    if (doScroll) el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, hit: hit ? `${hit.tagName}.${hit.className}`.slice(0, 60) : null, inside: !!hit && (hit === el || el.contains(hit)) }
  }, selector, matchText, scroll)
  if (!point) throw new Error(`找不到 ${selector}${matchText ? `（文字含「${matchText}」）` : ''}`)
  if (!point.inside) throw new Error(`${selector} 的座標被別的元素蓋住：點到 ${point.hit}`)
  await page.mouse.click(point.x, point.y)
}

/**
 * 真的用滑鼠按 `{{...}}`、再按下拉裡的「聯絡人名稱」。
 */
async function pickVariable(wrapSelector) {
  await mouseClick(`${wrapSelector} .flow-var-inset__btn`)
  await sleep(400)
  await mouseClick('.el-dropdown-menu__item', '聯絡人名稱', false)
  await sleep(400)
}

/** 讀輸入框現況：值、游標、焦點在不在自己身上 */
function readField(wrapSelector, fieldSelector) {
  return page.evaluate((wrapSel, fieldSel) => {
    const el = document.querySelector(wrapSel)?.querySelector(fieldSel)
    return { value: el.value, caret: el.selectionStart, focused: document.activeElement === el }
  }, wrapSelector, fieldSelector)
}

const TA = '.flow-textarea-wrapper--var-inset'

// ── ① 游標在中間 ────────────────────────────────────────────
await resetField(TA, 'textarea', SAMPLE)
await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  el.focus()
  el.setSelectionRange(3, 3)
}, TA)
await pickVariable(TA)
let seen = await readField(TA, 'textarea')
check('① 游標在「您好，」後面 → 插在那裡（不是接到最後面）',
  seen.value === `您好，${TOKEN}請問要寄到哪`, `「${seen.value}」`)
check('② 插完游標停在變數後面、焦點回到輸入框',
  seen.caret === 3 + TOKEN.length && seen.focused,
  `caret=${seen.caret}（應為 ${3 + TOKEN.length}）focused=${seen.focused}`)

// ── ③ 選取一段 → 取代 ───────────────────────────────────────
await resetField(TA, 'textarea', '您好王小明先生')
await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  el.focus()
  el.setSelectionRange(2, 5)
}, TA)
await pickVariable(TA)
seen = await readField(TA, 'textarea')
check('③ 選起來的「王小明」被變數取代掉', seen.value === `您好${TOKEN}先生`, `「${seen.value}」`)

// ── ④ 焦點不在輸入框 → 接在最後面（舊行為） ────────────────────
// ⛔ 這關是整組的對照組：沒有它，①③ 綠了也分不出是「真的看游標」還是「剛好都插在最前面」。
await resetField(TA, 'textarea', SAMPLE)
await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  el.focus()
  el.setSelectionRange(3, 3)   // 故意把游標留在中間，再把焦點移走
  el.blur()
}, TA)
await pickVariable(TA)
seen = await readField(TA, 'textarea')
check('④ 人不在輸入框裡時 → 接在最後面（舊行為，⛔ 不可以因為 selectionStart 還在就插到中間）',
  seen.value === `${SAMPLE}${TOKEN}`, `「${seen.value}」`)

// ── ⑦⑧ 長文案：插完畫面要停在游標那裡，而且這一筆要能復原 ──────────
// 為什麼要長文案：輸入框只有 3 行高，文案短的時候整段都看得見，捲不捲根本量不出來。
// ⛔ 但**不能超過欄位上限**：這一格文字底下掛了按鈕＝LINE 只收 160 字，`maxlength` 就是 160，
//   超過的話瀏覽器會拒絕插入、程式退回自己改資料那條路，量到的就不是要驗的東西
//   （第一版寫了 710 字的文案，⑧ 一直紅，真因就是這個）。用短行＋多換行撐出捲軸。
const LONG = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join('\n')
await resetField(TA, 'textarea', LONG)
await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  el.scrollTop = 0
  el.focus()
  el.setSelectionRange(3, 3)   // 游標在第 1 行
}, TA)
const before = await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  return { scrollable: el.scrollHeight > el.clientHeight + 4, maxScroll: el.scrollHeight - el.clientHeight }
}, TA)
await pickVariable(TA)
const scrolled = await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, value: el.value }
}, TA)
// ⛔ 先確認這個框真的捲得動，否則「沒有捲到底」是假綠燈（框根本沒有捲軸）
check('⑦ 插完畫面停在游標那一行，沒有自己跳到最底',
  before.scrollable && scrolled.top < 12,
  `捲到 ${Math.round(scrolled.top)}px（可捲範圍 0～${Math.round(scrolled.max)}px，框捲得動＝${before.scrollable}）`)

// ⌘Z／Ctrl+Z：⛔ 不能用 `page.keyboard` 直接按——puppeteer 送出的按鍵**不帶編輯指令**，
// 真實的 ⌘Z 是由瀏覽器翻譯成 `undo` 這個編輯指令才送進網頁的。實測用 `page.keyboard`
// 按 Meta+Z／Control+Z 兩種都毫無反應，但同一個時間點 `queryCommandEnabled('undo')` 是 true、
// 程式呼叫 undo 收得回來＝**那是守門員自己的假紅燈，不是功能壞掉**。所以照瀏覽器的做法送。
const undoEnabled = await page.evaluate(() => document.queryCommandEnabled('undo'))
// 復原是送到「焦點所在的那個框」，所以焦點不在 → 紅燈的意思完全不同，要分得出來
const focusBeforeUndo = await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  const active = document.activeElement
  return { onField: active === el, active: active ? `${active.tagName}.${String(active.className).slice(0, 30)}` : '(none)' }
}, TA)
const cdp = await page.createCDPSession()
const undoKey = { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: process.platform === 'darwin' ? 4 : 2 }
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...undoKey, commands: ['undo'] })
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...undoKey })
await sleep(400)
const undone = await readField(TA, 'textarea')
await sleep(400)
const stillUndone = await readField(TA, 'textarea')   // 等 Vue 有機會把值寫回來，確認不是曇花一現
check(`⑧ ${process.platform === 'darwin' ? '⌘Z' : 'Ctrl+Z'} 收得回剛插進去的變數，而且沒有被畫面重新寫回去`,
  undoEnabled && !undone.value.includes(TOKEN) && undone.value === LONG && stillUndone.value === LONG,
  `復原鍵可用＝${undoEnabled}；焦點在輸入框＝${focusBeforeUndo.onField}（${focusBeforeUndo.active}）；復原後長度 ${undone.value.length}（原文 ${LONG.length}）、0.4 秒後 ${stillUndone.value.length}`)

// ── ⑨ 欄位已經頂到字數上限：不可以變成「按了沒反應」 ──────────────
// 這時瀏覽器會拒絕插入（`maxlength`），程式要退回自己改資料那條路把整串插進去
// ——維持舊行為，超出的部分由紅字警告與存檔閘門擋（`H-27`），而不是默默什麼都沒發生。
const FULL = '滿'.repeat(160)
await resetField(TA, 'textarea', FULL)
await page.evaluate((sel) => {
  const el = document.querySelector(sel).querySelector('textarea')
  el.focus()
  el.setSelectionRange(3, 3)
}, TA)
await pickVariable(TA)
seen = await readField(TA, 'textarea')
check('⑨ 欄位已經滿 160 字時，按下去仍然插得進去（⛔ 不可以變成按了沒反應）',
  seen.value.includes(TOKEN) && seen.value.startsWith(`滿滿滿${TOKEN}`),
  `長度 ${seen.value.length}、開頭「${seen.value.slice(0, 20)}」`)

// ── ⑤ 單行輸入框（按鈕文字）走的是另一個分支 ─────────────────────
const INPUT_WRAP = '.flow-input-inset-wrap'
const hasInput = await page.$(`${INPUT_WRAP} input`)
if (!hasInput) check('⑤ 單行輸入框（按鈕文字）也插得到游標位置', false, '這則模組裡沒有單行的插入框，換一則有按鈕的來驗')
else {
  await resetField(INPUT_WRAP, 'input', '點我看更多')
  await page.evaluate((sel) => {
    const el = document.querySelector(sel).querySelector('input')
    el.focus()
    el.setSelectionRange(2, 2)
  }, INPUT_WRAP)
  await pickVariable(INPUT_WRAP)
  seen = await readField(INPUT_WRAP, 'input')
  check('⑤ 單行輸入框（按鈕文字）也插得到游標位置',
    seen.value === `點我${TOKEN}看更多`, `「${seen.value}」`)
}

check('⑥ 全程沒有送出任何寫入請求（沒動到這則模組的資料）', !sawWrite, sawWrite ? '有發出寫入！' : '沒有任何寫入')

const shotPath = join(tmpdir(), `flow-variable-caret-${process.pid}.png`)
await page.screenshot({ path: shotPath, fullPage: false })

let red = 0
for (const r of results) {
  if (!r.ok) red++
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}　${r.detail}`)
}
console.log(`\n${results.length - red} 綠 / ${red} 紅（截圖：${shotPath}）`)
await browser.close()
process.exit(red ? 1 : 0)
