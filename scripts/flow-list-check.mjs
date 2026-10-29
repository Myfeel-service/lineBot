/**
 * `C-422` 實機守門員：機器人模組清單那 8 條 code review 修完之後（MYFEEL 真資料、零寫入）
 *
 *   BROADCAST_CRON_ENABLED=false npx nuxi dev --port 3123              # 另一個終端先跑起來（關掉本機推播排程）
 *   CHECK_BASE_URL=http://localhost:3123 node --env-file=.env_myfeel scripts/flow-list-check.mjs
 *
 * 驗的事（編號對 `C-422`）：
 *   ④ 未分類一次全部列出（以前排在第 30 個之後的要捲到整份清單最底才補、補在最上面看不到），沒有「載入更多」
 *   ① 排在後面、資料夾裡的模組拖起來，「拖到這裡 = 移出資料夾」會出現（以前不出現＝拖不回未分類）
 *   ⑤ 篩選中點資料夾標題收得起來，⛔ 不動記住的收合狀態；回到「全部」照舊
 *   ③ 重查索引那幾秒（按刪除會先重查），篩選不閃；篩選那一格空了回到「全部」，之後冒出來 ⛔ 不自己切回篩選
 *   深連結：`?id=` 指到收著的資料夾裡的模組，資料夾打開、那一列看得到並反白
 *   ⑦ 圖片框開著還沒選圖就存＝擋下來講清楚，⛔ 沒有存檔請求
 *   ②⑥ 只報數字（規則在 `server/utils/config-references.test.ts`）：走不到幾個、哪幾個是「指過來的都關掉了」、
 *      哪幾個是靠舊版圖文訊息才走得到
 *
 * ⛔ 所有非 GET 的 /api 一律攔下；按了「刪除」會先跳確認框，一律按「取消」。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99'
const SHOT_DIR = process.env.SHOT_DIR ?? tmpdir()
/** 側欄以前一頁畫幾個（`ADMIN_SIDEBAR_PAGE_SIZE`）：拿來找「以前畫不出來」的那幾個 */
const OLD_PAGE_SIZE = 30

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()
const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
const admin = members.docs.map(d => ({ id: d.id, ...d.data() })).find(r => r.role === 'owner' || r.role === 'admin')
if (!admin) { console.error('這個工作區查不到管理員'); process.exit(1) }
const uid = String(admin.uid ?? admin.id)
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: await getAuth().createCustomToken(uid), returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }

const get = async path => (await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspaceId=${WORKSPACE_ID}`, {
  headers: { Authorization: `Bearer ${session.idToken}` },
})).json()
const allFlows = await get('/api/flow/list')
const index = await get('/api/config-references?fresh=1')
const systemCount = allFlows.filter(f => f.isSystem).length
const regular = allFlows.filter(f => !f.isSystem)
const oldVisible = Math.max(0, OLD_PAGE_SIZE - systemCount)
const uncategorized = regular.filter(f => !f.folderId)
const lateUncategorized = regular.filter((f, i) => !f.folderId && i >= oldVisible)
const lateInFolder = regular.find((f, i) => f.folderId && i >= oldVisible)
const ship = allFlows.find(f => /^客服 - 出貨進度查詢 - Giaretti/.test(String(f.name)))
console.log(`受測：${regular.length} 個自建模組（未分類 ${uncategorized.length}，其中 ${lateUncategorized.length} 個排在以前第一頁之後）`)

// ②⑥ 只報數字
const refsOf = id => index.modules?.[id] ?? []
const unreachable = regular.filter(f => !refsOf(f.id).some(r => !r.closed))
const allClosed = unreachable.filter(f => refsOf(f.id).length)
const flowById = new Map(allFlows.map(f => [f.id, f]))
const viaRichMessage = regular.filter(f => refsOf(f.id).some((r) => {
  if (r.kind !== 'flow') return false
  const src = JSON.stringify(flowById.get(r.id)?.messages ?? [])
  return src.includes('"richMessageRef"') && !src.includes(f.id)
}))
console.log(`索引：查不到的類 ${JSON.stringify(index.failedKinds)}、沒掃完 ${JSON.stringify(index.truncatedKinds ?? [])}`)
console.log(`走不到 ${unreachable.length} 個；其中「指過來的都關掉了」${allClosed.length} 個${allClosed.length ? `：${allClosed.map(f => f.name).join('、')}` : ''}`)
console.log(`靠舊版圖文訊息才算得到入口的 ${viaRichMessage.length} 個${viaRichMessage.length ? `：${viaRichMessage.map(f => f.name).join('、')}` : ''}`)

const blocked = []
/** fresh 重查索引那一支：delay＝慢幾毫秒才放行；fake＝回這一份 */
const refsControl = { delay: 0, fake: null }

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1100 })
page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 160)))
await page.setRequestInterception(true)
page.on('request', async (req) => {
  const url = new URL(req.url())
  if (url.pathname === '/api/config-references' && url.searchParams.get('fresh') === '1') {
    if (refsControl.fake) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(refsControl.fake) })
    if (refsControl.delay) await new Promise(r => setTimeout(r, refsControl.delay))
    return req.continue()
  }
  if (req.method() !== 'GET' && url.pathname.startsWith('/api/')) {
    blocked.push(`${req.method()} ${url.pathname}${url.search}`)
    return req.abort()
  }
  req.continue()
})

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 120_000 })
await page.evaluate(async (s) => {
  const user = { uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'google.com', uid: s.email, displayName: null, email: s.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
    createdAt: String(Date.now() - 86400_000), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]' }
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

const sleep = ms => new Promise(r => setTimeout(r, ms))
const closeTours = () => page.evaluate(() => { document.querySelectorAll('.el-tour__closebtn').forEach(b => b.click()) })
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
/** ⛔ 一定要接回傳值：等不到要當成失敗，不可以繼續量（不然等不到也是綠的） */
const waitFor = (fn, arg, timeout = 15_000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false)
const LS_KEY = `flow-folders-expanded:${WORKSPACE_ID}`
const openFlowPage = async (query = '') => {
  await page.goto(`${BASE}/admin/${WORKSPACE_ID}/flow${query}`, { waitUntil: 'networkidle2', timeout: 120_000 })
  const listed = await waitFor(() => document.querySelectorAll('.split-list .split-list-item').length > 3, null, 60_000)
  // 索引回來了：標題下那句不再是「正在查…」
  await waitFor(() => !document.querySelector('.flow-usage-link--loading'), null, 30_000)
  await sleep(1200)
  await closeTours()
  return listed
}
const filterState = () => page.evaluate(() => ({
  bar: !!document.querySelector('.flow-list-filter'),
  active: document.querySelector('.flow-list-filter .el-radio-button.is-active')?.innerText.trim() ?? '',
  rows: document.querySelectorAll('.split-list .flow-sidebar-row').length,
  sys: document.querySelectorAll('.split-list [data-tour^="flow-sys-"]').length,
}))
const clickFilter = startsWith => page.evaluate((t) => {
  const b = [...document.querySelectorAll('.flow-list-filter .el-radio-button')].find(x => x.innerText.trim().startsWith(t))
  b?.querySelector('input, .el-radio-button__inner')?.click()
  return !!b
}, startsWith)
/** 右上「⋯」→「刪除」：會先重查索引、再跳確認框 */
const clickDelete = async () => {
  // ⚠️ 選了模組會跳新手導覽、蓋住整頁（「看過了」的記錄被攔下不寫，所以每次都跳）：先關掉
  await closeTours()
  await sleep(300)
  await page.click('.admin-header-actions .admin-more-btn')
  await sleep(400)
  return page.evaluate(() => {
    const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find(i => i.offsetParent !== null && i.innerText.trim() === '刪除')
    item?.click()
    return !!item
  })
}
const cancelConfirm = async () => {
  const shown = await waitFor(() => [...document.querySelectorAll('.el-message-box')].some(b => b.offsetParent !== null), null, 20_000)
  await page.evaluate(() => {
    const box = [...document.querySelectorAll('.el-message-box')].find(b => b.offsetParent !== null)
    const cancel = [...(box?.querySelectorAll('.el-message-box__btns button') ?? [])].find(b => /取消|先不要/.test(b.innerText))
    cancel?.click()
  })
  await sleep(600)
  return shown
}

// ── ④ 未分類一次全部列出 ─────────────────────────────────
await openFlowPage()
const k1 = await page.evaluate(() => ({
  uncategorizedRows: [...document.querySelectorAll('.split-list .flow-sidebar-row:not(.src-row--in-folder)')].map(r => r.getAttribute('data-flow-id')),
  loadMore: !!document.querySelector('.admin-sidebar-load-more'),
}))
const missing = uncategorized.filter(f => !k1.uncategorizedRows.includes(f.id))
check('④ 未分類一打開就全部列出（以前排第 30 個之後的要捲到最底才補），沒有「載入更多」', !missing.length && k1.uncategorizedRows.length === uncategorized.length && !k1.loadMore,
  `畫出 ${k1.uncategorizedRows.length}／應有 ${uncategorized.length}（排在以前第一頁之後的 ${lateUncategorized.length} 個）${missing.length ? `；少了 ${missing.map(f => f.name).join('、')}` : ''}`)

// ── ① 排在後面、資料夾裡的模組拖得出「移出資料夾」──────────────
if (lateInFolder) {
  const zone = await page.evaluate(async (id) => {
    const handle = document.querySelector(`.split-list [data-flow-id="${id}"] .drag-handle`)
    if (!handle) return { handle: false }
    handle.scrollIntoView({ block: 'center' })
    const dt = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await new Promise(r => setTimeout(r, 300))
    const during = !!document.querySelector('.src-unfolder-zone')
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await new Promise(r => setTimeout(r, 300))
    return { handle: true, during, after: !!document.querySelector('.src-unfolder-zone') }
  }, lateInFolder.id)
  check('① 排在後面的資料夾模組一拖，「拖到這裡 = 移出資料夾」就出現（放開就收）', zone.handle && zone.during && !zone.after,
    `「${lateInFolder.name}」：把手 ${zone.handle}、拖著時 ${zone.during}、放開後 ${zone.after}`)
}
else check('① 這個帳號沒有排在以前第一頁之後的資料夾模組，量不到', false, '換一個模組多的帳號跑')

// ── ⑤ 篩選中資料夾收得起來、⛔ 不動記住的狀態 ───────────────────
const lsBefore = await page.evaluate(k => localStorage.getItem(k), LS_KEY)
const hasUnreachable = await clickFilter('客人走不到')
await sleep(600)
const k5 = await page.evaluate(async () => {
  const header = [...document.querySelectorAll('.split-list .src-folder-header')].find(h => h.offsetParent !== null)
  if (!header) return { header: false }
  const name = header.querySelector('.src-folder-label')?.innerText.trim() ?? ''
  const rows = () => document.querySelectorAll('.split-list .flow-sidebar-row').length
  const arrow = () => header.querySelector('.src-folder-arrow')?.innerText.trim()
  const before = { rows: rows(), arrow: arrow() }
  header.querySelector('.src-folder-label').click()
  await new Promise(r => setTimeout(r, 400))
  const collapsed = { rows: rows(), arrow: arrow() }
  header.querySelector('.src-folder-label').click()
  await new Promise(r => setTimeout(r, 400))
  return { header: true, name, before, collapsed, reopened: { rows: rows(), arrow: arrow() } }
})
const lsAfter = await page.evaluate(k => localStorage.getItem(k), LS_KEY)
check('⑤ 篩選中點資料夾標題：收得起來、再點打開，⛔ 記住的收合狀態沒動', hasUnreachable && k5.header && k5.before.arrow === '▾' && k5.collapsed.arrow === '▸'
  && k5.collapsed.rows < k5.before.rows && k5.reopened.rows === k5.before.rows && lsAfter === lsBefore,
  `「${k5.name}」${k5.before?.arrow}${k5.before?.rows} 列 → ${k5.collapsed?.arrow}${k5.collapsed?.rows} 列 → ${k5.reopened?.arrow}${k5.reopened?.rows} 列；記住的狀態 ${lsAfter === lsBefore ? '沒動' : `被改了（${lsBefore} → ${lsAfter}）`}`)

// ── ③ 重查索引那幾秒篩選不閃 ───────────────────────────
const filteredBefore = await filterState()
await page.evaluate(() => document.querySelector('.split-list .flow-sidebar-row .split-list-item')?.click())
await sleep(800)
refsControl.delay = 3000
const clicked = await clickDelete()
await sleep(1200) // 重查還在路上
const during = await filterState()
const loadingSeen = await page.evaluate(() => !!document.querySelector('.flow-usage-link--loading'))
const confirmShown = await cancelConfirm()
refsControl.delay = 0
check('③ 重查索引那幾秒：還停在「客人走不到」、列數不變（以前整份清空，篩選那排消失再出現）', clicked && loadingSeen && during.bar && during.active.startsWith('客人走不到') && during.rows === filteredBefore.rows && confirmShown,
  `重查中 ${loadingSeen}；之前 ${filteredBefore.active}／${filteredBefore.rows} 列 → 重查中 ${during.active || '（沒有篩選那排）'}／${during.rows} 列；確認框 ${confirmShown}`)
await page.screenshot({ path: join(SHOT_DIR, 'flow-list-refetch.png'), clip: { x: 0, y: 0, width: 900, height: 900 } })

// ── ③ 篩選那一格空了回到「全部」，之後冒出來 ⛔ 不自己切回篩選 ───────────
const allReachable = { ...index, modules: { ...index.modules } }
for (const f of regular) allReachable.modules[f.id] = [...refsOf(f.id), { kind: 'script', id: '__guard__', label: '守門員假入口' }]
refsControl.fake = allReachable
await clickDelete()
await cancelConfirm()
const emptied = await filterState()
refsControl.fake = null
await clickDelete()
await cancelConfirm()
await waitFor(() => !!document.querySelector('.flow-list-filter'))
const back = await filterState()
check('③ 走不到的都接上入口：回到全部清單；之後又冒出走不到的，停在「全部」不自己切回篩選', !emptied.active.startsWith('客人走不到') && emptied.sys > 0
  && back.bar && back.active.startsWith('全部') && back.sys > 0,
  `接上之後 ${emptied.bar ? emptied.active : '（篩選那排收起來）'}、系統模組 ${emptied.sys}；又冒出來後 ${back.active}、系統模組 ${back.sys}`)

// ── 深連結指到收著的資料夾裡的模組 ─────────────────────────
if (lateInFolder) {
  await page.evaluate(k => localStorage.setItem(k, JSON.stringify(['__all_collapsed__'])), LS_KEY)
  await openFlowPage(`?id=${lateInFolder.id}`)
  await sleep(600)
  const link = await page.evaluate((id) => {
    const row = document.querySelector(`.split-list [data-flow-id="${id}"]`)
    const list = document.querySelector('.split-list')?.getBoundingClientRect()
    const r = row?.getBoundingClientRect()
    return {
      row: !!row,
      inView: !!r && !!list && r.height > 0 && r.top >= list.top - 1 && r.bottom <= list.bottom + 1,
      active: !!row?.querySelector('.split-list-item.active'),
    }
  }, lateInFolder.id)
  check('深連結 ?id= 指到收著的資料夾裡的模組：資料夾打開、那一列捲到看得見並反白', link.row && link.inView && link.active,
    `「${lateInFolder.name}」：有畫出來 ${link.row}、看得見 ${link.inView}、反白 ${link.active}`)
  await page.evaluate(k => localStorage.removeItem(k), LS_KEY)
}

// ── ⑦ 圖片框開著還沒選圖就存＝擋下來 ──────────────────────
if (ship) {
  await openFlowPage(`?id=${ship.id}`)
  await waitFor(() => document.querySelector('.msg-type-btns'), null, 30_000)
  await page.evaluate(() => document.querySelector('[data-tour="fmt-text"]')?.click())
  await sleep(500)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-tour="text-add-image"]')].find(x => x.offsetParent !== null)
    b?.scrollIntoView({ block: 'center' })
    b?.click()
  })
  await sleep(500)
  // 文字要有字，才不會先被「內文必填」之類的擋掉
  await page.evaluate(() => {
    const box = document.querySelector('[data-tour="text-image"]')?.closest('.message-card, [class*="msg-card"], .fem-card') ?? document
    const ta = [...box.querySelectorAll('textarea')].find(t => t.offsetParent !== null && !t.value)
    if (ta) { ta.value = '守門員測試'; ta.dispatchEvent(new Event('input', { bubbles: true })) }
  })
  const blockedBefore = blocked.length
  await page.evaluate(() => [...document.querySelectorAll('.admin-header-actions .el-button--primary')].find(b => b.innerText.includes('儲存變更'))?.click())
  await sleep(800)
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast-bar .toast')].map(e => e.innerText.trim()).filter(Boolean).join('｜'))
  const saves = blocked.slice(blockedBefore).filter(b => /^(PUT|POST) \/api\/flow\//.test(b))
  check('⑦ 圖片框開著還沒選圖就按儲存：擋下來講「選一張圖，或按移除圖片」，⛔ 沒有存檔請求', toast.includes('圖片還沒選') && !saves.length,
    `提示「${toast}」；存檔請求 ${saves.join('、') || '沒有'}`)
  await page.screenshot({ path: join(SHOT_DIR, 'flow-text-image-unpicked.png') })
}

await browser.close()
console.log('\n攔下的非 GET：', blocked.length ? blocked.join('、') : '（沒有）')
console.log(`截圖在 ${SHOT_DIR}`)
let bad = 0
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `　${r.detail}` : ''}`)
  if (!r.ok) bad++
}
process.exit(bad ? 1 : 0)
