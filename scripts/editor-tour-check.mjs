/**
 * 「導覽不可以停在門口」的實機守門員（2026-09-18，`D-82`／`C-201`）。
 *
 *   npm run dev -- --port 3311                                      # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3311 node --env-file=.env_myfeel scripts/editor-tour-check.mjs
 *
 * 為什麼一定要真的開瀏覽器：`tutorial-topics.test.ts` 只驗得到「錨點字串在某個 .vue 裡面」，
 * 驗不到這次真正會壞的兩件事——
 *   ① `clickBefore` 有沒有真的把右半邊的編輯器打開（打不開的話，後面每一步都會退化成
 *      「這一步要指的位置目前不在畫面上」，而那正是這輪要消滅的東西）
 *   ② 那些**有渲染條件**的欄位（「怎麼比對」只在關鍵字模式、「發送設定」只在可編輯時）
 *      在導覽跑到它的那一刻在不在畫面上。
 * 這個專案吃過「typecheck 綠＋測試綠，但新程式根本沒被執行到」（記憶
 * `feedback_verify_new_code_actually_runs`），所以這裡逐步斷言，不看總結。
 *
 * ⚠️ 連的是**正式資料庫（myfeel）**：讀 `workspaceMembers` 找一個管理員來登入（唯讀），
 *    瀏覽器操作全程只在畫面上點，**不送出任何存檔**（不按「建立」「儲存」「發送」）。
 *    唯一可能被寫到的是 `adminUserPrefs/{uid}`（只存「這個人看過哪幾頁的導覽」）——
 *    ⛔ 跑之前先把原本的內容抄下來，跑完**原封還原**（不像舊的 auto-tour-check 直接刪掉，
 *       那會把這位管理員真實的「看過了」記錄一起清掉、害他下次每頁又被跳一次）。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

/**
 * 這一輪擴寫的兩支導覽。`opensEditor` ＝ 跑到第幾步時，右半邊的編輯器應該已經被打開
 * （1 起算），`editorAnchor` ＝ 那時候畫面上一定要有的東西。
 */
const CASES = [
  {
    tourId: 'ai-scripts',
    path: 'ai-scripts',
    label: '自動回應',
    // 2026-09-29（`D-109`）：8→9，第 4 步多了「最上面這一列：客人加好友時」
    // （排第 2 步時清單常常還沒載完就指不到——那一列要等清單載完才畫）
    expectSteps: 9,
    opensEditor: 5,
    editorAnchor: '[data-tour="scr-trigger-mode"]',
    checkAt: [{ step: 4, sel: '[data-tour="scr-follow-row"]' }],
    // 有渲染條件、最可能在跑到時不在畫面上的那幾格
    conditional: ['[data-tour="scr-match"]', '[data-tour="scr-test"]', '[data-tour="scr-reply"]', '[data-tour="scr-save"]'],
  },
  {
    tourId: 'broadcasts',
    path: 'broadcasts',
    label: '推播',
    // 2026-09-29（`D-109`）：7→8，多了「先發一則給自己看」
    expectSteps: 8,
    opensEditor: 3,
    editorAnchor: '[data-tour="bc-audience"]',
    checkAt: [{ step: 5, sel: '[data-tour="bc-testsend"]' }],
    conditional: ['[data-tour="bc-content"]', '[data-tour="bc-testsend"]', '[data-tour="bc-schedule"]', '[data-tour="bc-send"]'],
  },
  // ── 第二批（2026-09-18）──────────────────────────────────────────────
  {
    tourId: 'support-presets',
    path: 'support-presets',
    label: '客服預存',
    expectSteps: 5,
    opensEditor: 3,
    editorAnchor: '[data-tour="sp-action"]',
    conditional: ['[data-tour="sp-tagging"]', '[data-tour="sp-save"]'],
  },
  {
    tourId: 'members',
    path: 'settings/members',
    label: '成員管理',
    expectSteps: 3,
    // 這一支不用開編輯器（整頁就是一張表）
    opensEditor: 0,
    editorAnchor: '',
    conditional: ['[data-tour="mem-line"]'],
  },
  // ── 第三批（2026-09-18）──────────────────────────────────────────────
  {
    tourId: 'tags',
    path: 'tags',
    label: '標籤管理',
    expectSteps: 5,
    opensEditor: 4,
    editorAnchor: '[data-tour="tag-code"]',
    conditional: ['[data-tour="tag-templates"]', '[data-tour="tag-name"]'],
  },
  {
    tourId: 'activity',
    path: 'settings/activity',
    label: '操作紀錄',
    expectSteps: 2,
    opensEditor: 0,
    editorAnchor: '',
    conditional: ['[data-tour="act-list"]', '[data-tour="act-filter"]'],
  },
  // ── 第四批（2026-09-21，`H-35`）────────────────────────────────────────
  {
    /**
     * 這一支的重點：導覽要指的東西**有兩種不同的出現條件**，而且是這輪才變的。
     *   ① `flow-sys-badge`（第 2、3 步）只有選到**系統模組**才在；選到自建模組時整塊不渲染。
     *      2026-09-21 把「模組類型」下拉拿掉之前，這個錨點是每個模組都在的，
     *      所以這兩步**從來沒被驗過「換成只有系統模組才在」之後還指不指得到**。
     *   ② `flow-name`（第 4 步）是這輪新加的錨點，而且要 `clickBefore` 按了「新增」
     *      把右半邊切成建立模式之後才有意義。
     * 兩者都是「條件成立才在畫面上」，正是 `tutorial-topics.test.ts` 驗不到的那一類。
     */
    tourId: 'flow',
    path: 'flow',
    label: '機器人模組',
    // 2026-09-29（`D-109`）：`D-23` 拿掉歡迎模組後其實是 5 步（這裡一直寫 6 沒人發現），
    // 再加「這個模組會從哪裡被叫出來」＝6 步；它只在打開一個已存在的模組時才畫，所以排第 3 步
    expectSteps: 6,
    opensEditor: 4,
    editorAnchor: '[data-tour="flow-name"]',
    checkAt: [{ step: 3, sel: '[data-tour="flow-usage"]' }],
    conditional: ['[data-tour="flow-messages"]', '[data-tour="flow-new"]'],
  },
  {
    // 這一支的重點：最後一塊住在**預設收合**的「進階調校」裡，
    // 導覽要先幫他展開；沒展開的話那一步就是「位置不在畫面上」。
    tourId: 'ai-settings',
    path: 'ai-settings',
    label: 'AI 設定',
    // 2026-09-29（`D-109`）：`C-270` 搬走通知那一步之後是 5 步，加「AI 講話的口吻與禁則」＝6 步
    expectSteps: 6,
    opensEditor: 5,
    editorAnchor: '[data-tour="ais-handback"]',
    checkAt: [{ step: 3, sel: '[data-tour="ais-tone"]' }],
    titlesAt: { 2: 'AI 多有把握才開口', 3: 'AI 講話的口吻與禁則' },
    conditional: ['[data-tour="ais-hours"]', '[data-tour="ais-handback"]'],
  },
  // ── 第五批（2026-09-29，`D-109`：全站教學盤點）─────────────────────────
  {
    // 新的一支：兩個 clickBefore（打開積木選單、打開試跑）都要真的打開東西
    tourId: 'ai-scripts-flow',
    path: 'ai-scripts',
    label: '自動回應：多步驟接待',
    expectSteps: 5,
    opensEditor: 0,
    editorAnchor: '',
    checkAt: [{ step: 2, sel: '[data-tour="scr-palette"]' }, { step: 4, sel: '[data-tour="scr-sim-panel"]' }],
    conditional: ['[data-tour="scr-save"]'],
  },
  {
    // 順序是這一輪改的：以前先教「測試」再教「儲存」，沒存時測試鈕是鎖的
    tourId: 'organization',
    path: 'settings/organization',
    label: '組織與 LINE',
    expectSteps: 9,
    opensEditor: 0,
    editorAnchor: '',
    checkAt: [{ step: 7, sel: '[data-tour="org-oam-autoreply"]' }],
    titlesAt: { 8: '先儲存', 9: '再測試有沒有通' },
    conditional: [],
  },
  {
    // 工作台那三塊都是「有東西才出現」，步數跟這個帳號的資料有關 → 只給範圍
    // ⛔「原始資料改了」那步指的同步設定，只有清單第一份是網址／試算表才有（既有的限制，這輪沒改）
    tourId: 'knowledge-manage',
    path: 'knowledge/sources',
    label: '知識庫：整理與更新',
    minSteps: 4,
    maxSteps: 7,
    opensEditor: 0,
    editorAnchor: '',
    allowMissing: ['原始資料改了，知識會自動跟上'],
    conditional: ['[data-tour="kb-more"]'],
  },
  {
    // 「指派給一位同事」是這輪加的，只有客服以上畫得出來（登入的是管理員）
    tourId: 'conversations',
    path: 'conversations',
    label: '客服對話',
    expectSteps: 8,
    opensEditor: 3,
    editorAnchor: '[data-tour="conv-header"]',
    checkAt: [{ step: 4, sel: '[data-tour="conv-assignee"]' }],
    conditional: [],
  },
  {
    tourId: 'ai-playground',
    path: 'ai-playground',
    label: '測試對話',
    expectSteps: 3,
    opensEditor: 0,
    editorAnchor: '',
    titlesAt: { 3: '怎麼看它答得穩不穩' },
    conditional: [],
  },
  {
    // 以前整頁沒有導覽也沒有問號；還沒產生過報告只有 1 步，有報告的是 3 步
    tourId: 'friend-stats',
    path: 'friend-stats',
    label: '好友統計',
    minSteps: 1,
    maxSteps: 3,
    opensEditor: 0,
    editorAnchor: '',
    conditional: [],
  },
  {
    // 「傳連結給他」只在有同事還沒加進來時才畫
    tourId: 'line-notify',
    path: 'settings/line-notify',
    label: 'LINE 通知',
    minSteps: 2,
    maxSteps: 3,
    opensEditor: 0,
    editorAnchor: '',
    conditional: [],
  },
  {
    tourId: 'conversation-stats',
    path: 'conversation-stats',
    label: '對話統計',
    expectSteps: 2,
    opensEditor: 0,
    editorAnchor: '',
    conditional: [],
  },
  {
    tourId: 'campaigns',
    path: 'campaigns',
    label: '活動標籤',
    expectSteps: 4,
    opensEditor: 2,
    editorAnchor: '[data-tour="cmp-tagsection"]',
    conditional: [],
  },
  {
    tourId: 'richmenu',
    path: 'richmenu',
    label: '圖文選單',
    expectSteps: 7,
    opensEditor: 2,
    editorAnchor: '[data-tour="rm-chatbar"]',
    conditional: [],
  },
]

/**
 * `CHECK_ONLY=friend-stats,flow`：只跑這幾支（除錯用；有設就跳過後面那幾段加驗）。
 * `CHECK_SHOT_DIR=/某個資料夾`：按問號沒反應時存一張截圖，看得到當下畫面上到底是什麼。
 */
const ONLY = (process.env.CHECK_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean)
const SHOT_DIR = process.env.CHECK_SHOT_DIR ?? ''

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

// ── 先把這位管理員原本的「看過了」抄一份，最後原封還原 ───────────────────────
const prefsRef = db.collection('adminUserPrefs').doc(uid)
const prefsBefore = await prefsRef.get()
const prefsData = prefsBefore.exists ? prefsBefore.data() : null
console.log(`adminUserPrefs/${uid}：${prefsBefore.exists ? '原本有資料，已抄下來，跑完會還原' : '原本不存在，跑完會刪掉'}`)

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

async function openLoggedInPage() {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
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

/** 這一步的卡片現況：第幾步／共幾步、標題、有沒有那句「位置不在畫面上」 */
async function readStep(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.el-tour')
    if (!card) return null
    const count = card.querySelector('.ta-tour-count')?.textContent?.trim() ?? ''
    return {
      count,
      title: card.querySelector('.ta-tour-title')?.textContent?.trim() ?? '',
      missing: !!card.querySelector('.ta-tour-missing'),
    }
  })
}

/**
 * 真的用滑鼠按一下頁首那顆問號，確認**有東西打開**。
 *
 * 兩條路都算過關：一支教學的頁面直接開跑導覽（畫面上出現導覽卡片的標題），
 * 多支教學的頁面先出一張選單（`.el-dropdown-menu` 量得到寬高）。
 * 兩個都沒有＝使用者按了沒反應。
 */
async function pressHelpButton(page, label) {
  // ① 導覽的黑幕還在的話，量到的「沒反應」會是黑幕擋的，不是按鈕壞的
  for (let i = 0; i < 15; i++) {
    const open = await page.evaluate(() => [...document.querySelectorAll('.ta-tour-title')]
      .some(el => el.getBoundingClientRect().width > 0))
    if (!open) break
    await page.evaluate(() => { const b = [...document.querySelectorAll('.el-tour__footer .el-button')]; b[b.length - 1]?.click() })
    await sleep(600)
  }
  // ② 導覽可能把一個**對話框**留著開（標籤管理的最後一步就是開標籤編輯器），
  //    它的遮罩蓋住整個頁首。不先關掉的話會量成「按了沒反應」——那是遮罩擋的，不是按鈕壞的。
  for (let i = 0; i < 3; i++) {
    const dialog = await page.evaluate(() => [...document.querySelectorAll('.el-dialog, .el-drawer')]
      .some(el => el.getBoundingClientRect().width > 0))
    if (!dialog) break
    await page.keyboard.press('Escape')
    await sleep(700)
  }
  await sleep(600)

  const box = await page.evaluate(() => {
    const el = document.querySelector('.page-help-btn')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      // ⛔ 沒有這一格的話，「被別的東西蓋住」會被誤報成「按鈕壞了」——
      //    兩者下一步完全不同，不可以混成同一句話
      reachable: top ? (top === el || el.contains(top)) : false,
      covering: top ? `${top.tagName.toLowerCase()}.${String(top.className).split(' ').slice(0, 2).join('.')}` : 'null',
    }
  })
  if (!box) {
    fail(`${label}：頁首沒有那顆問號＝使用者自己想再看一遍時找不到入口`)
    return
  }
  if (!box.reachable) {
    console.log(`   ⏭️ ${label}：問號被「${box.covering}」蓋住（導覽收尾留著的浮層關不掉）＝這次沒驗到，不是綠燈`)
    return
  }
  await page.mouse.move(box.x, box.y)
  await sleep(250)
  const clickedAt = Date.now()
  await page.mouse.click(box.x, box.y)

  // ⛔ 不用固定 sleep：以前固定等 1.8 秒，好友統計那支要 4.5 秒才出來，被報成「完全沒反應」——
  //    其實是**慢**（兩件事下一步不一樣）。改成輪詢到 5 秒，出來了再看花了多久。
  const read = () => page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const menu = [...document.querySelectorAll('.el-dropdown-menu')].filter(vis)
    const tour = [...document.querySelectorAll('.ta-tour-title')].filter(vis)
    return {
      menu: menu.length > 0,
      menuItems: menu[0] ? menu[0].querySelectorAll('.el-dropdown-menu__item').length : 0,
      tour: tour.length > 0,
      tourTitle: tour[0]?.textContent?.trim() ?? '',
    }
  })
  let opened = await read()
  while (!opened.menu && !opened.tour && Date.now() - clickedAt < 5000) {
    await sleep(200)
    opened = await read()
  }
  const took = Date.now() - clickedAt
  // 按了超過 2 秒才有東西＝使用者已經覺得壞掉、再按一次了
  const slow = took > 2000 ? `（⚠️ 花了 ${(took / 1000).toFixed(1)} 秒才出來）` : ''
  if ((opened.menu || opened.tour) && slow)
    fail(`${label}：按下問號要等太久才有反應${slow}`)
  // `D-114`（2026-10-05）起一律先出選單，最下面一行「看全部教學」（小幫手的「教學」分頁拿掉了）
  const hasAll = opened.menu && await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu')]
    .filter(m => m.getBoundingClientRect().width > 0)
    .some(m => [...m.querySelectorAll('.el-dropdown-menu__item')].at(-1)?.textContent?.includes('看全部教學')))
  if (opened.menu && hasAll)
    pass(`${label}：按下問號 → 跳出教學選單（${opened.menuItems} 項，最後一行「看全部教學」）`)
  else if (opened.menu)
    fail(`${label}：選單最後一行不是「看全部教學」＝這一頁找不到全部教學`)
  else if (opened.tour)
    pass(`${label}：按下問號 → 直接開跑導覽「${opened.tourTitle}」`)
  else
    fail(`${label}：按下問號**完全沒反應**（等了 5 秒，選單沒開、導覽也沒起來）＝使用者點了以為壞掉`)
  if (!opened.menu && !opened.tour && SHOT_DIR)
    await page.screenshot({ path: `${SHOT_DIR}/help-no-reaction-${label.replace(/[^\w一-龥]+/g, '_')}.png` })
}

/**
 * 按頁首問號開這一頁的第一支導覽。`D-114`（2026-10-05）起問號一律先出選單（最後一行是「看全部教學」），
 * 所以要再點選單第一項——以前只有一支教學的頁面是按了直接開跑。
 */
async function openFirstHelpTopic(page) {
  await page.click('.page-help-btn')
  await page.waitForFunction(() => [...document.querySelectorAll('.el-dropdown-menu__item')].some(i => i.getBoundingClientRect().width > 0), { timeout: 8000 })
  await page.evaluate(() => [...document.querySelectorAll('.el-dropdown-menu__item')]
    .find(i => i.getBoundingClientRect().width > 0 && !i.textContent?.includes('看全部教學'))?.click())
}

/** 按卡片右下角那顆（「下一步」／最後一步的「結束」） */
async function clickNext(page) {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.el-tour__footer .el-button')]
    btns[btns.length - 1]?.click()
  })
  await sleep(900)
}

try {
  for (const c of CASES.filter(x => !ONLY.length || ONLY.includes(x.tourId))) {
    console.log(`── ${c.label}（${c.tourId}）──────────────────`)
    const { page, ctx } = await openLoggedInPage()
    try {
      // 用 ?tour= 指名開這一支，不必等自動導覽（自動導覽只跑「這個帳號沒看過」的）
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/${c.path}?tour=${c.tourId}`, { waitUntil: 'networkidle2', timeout: 90_000 })
      if (!page.url().includes(`/admin/${WORKSPACE_ID}/${c.path}`))
        throw new Error(`沒有停在這一頁，現在在 ${page.url()}`)
      await page.waitForSelector('.ta-tour-title', { visible: true, timeout: 30_000 })

      const seen = []
      // 步數跟資料有關的（`minSteps`/`maxSteps`）照卡片上寫的「共幾步」走到底
      const cap = c.expectSteps ?? c.maxSteps
      for (let i = 1; i <= cap + 2; i++) {
        const step = await readStep(page)
        if (!step) break
        seen.push(step)
        const where = step.count || `${i}`
        if (SHOT_DIR && ONLY.length)
          await page.screenshot({ path: `${SHOT_DIR}/${c.tourId}-step${i}.png` })
        // 只有一步的導覽卡片不顯示「1 / 1」（TutorialAgent：activeSteps.length > 1 才畫）＝總數就是 1
        const shown = step.count ? Number(String(step.count).split('/')[1]?.trim() || 0) : 1
        if (step.missing && (c.allowMissing ?? []).includes(step.title))
          console.log(`   ⏭️ ${where}　${step.title}（這個帳號的資料讓它指不到東西，已知限制，這次沒驗到）`)
        else if (step.missing)
          fail(`${c.label} 第 ${where} 步「${step.title}」→ 指不到東西（畫面上跳出「位置不在畫面上」）`)
        else
          console.log(`   ${where}　${step.title}`)

        // 標題照預期（順序是這一輪改的那幾支：例如組織與 LINE 要先儲存再測試）
        const wantTitle = c.titlesAt?.[i]
        if (wantTitle && step.title !== wantTitle)
          fail(`${c.label} 第 ${i} 步應該是「${wantTitle}」，實際是「${step.title}」`)

        // 這一步要指的東西真的在畫面上、有實際大小（clickBefore 有沒有真的打開它）
        for (const chk of (c.checkAt ?? []).filter(x => x.step === i)) {
          const box = await page.evaluate((sel) => {
            const el = document.querySelector(sel)
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { w: Math.round(r.width), h: Math.round(r.height) }
          }, chk.sel)
          if (box && box.w > 0 && box.h > 0) pass(`${c.label}：第 ${i} 步 ${chk.sel} 在畫面上（${box.w}×${box.h}）`)
          else fail(`${c.label}：第 ${i} 步 ${chk.sel} 不在畫面上`)
        }

        // clickBefore 該把編輯器（或收合區）打開的那一步：查那個錨點在不在、有沒有實際大小
        if (c.opensEditor && i === c.opensEditor) {
          const box = await page.evaluate((sel) => {
            const el = document.querySelector(sel)
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { w: Math.round(r.width), h: Math.round(r.height) }
          }, c.editorAnchor)
          if (box && box.w > 0 && box.h > 0)
            pass(`${c.label}：第 ${where} 步真的把編輯器打開了（${c.editorAnchor} ${box.w}×${box.h}）`)
          else
            fail(`${c.label}：第 ${where} 步沒把編輯器打開（${c.editorAnchor} 不在畫面上）＝導覽還是停在門口`)
        }
        // ⛔ 用 ||：讀不到總數時 shown 是 0，用 ?? 會變成「走一步就停」
        if (i >= (c.expectSteps || shown || cap)) break
        await clickNext(page)
      }

      /**
       * 頁首那顆問號＝使用者自己想再看一遍的唯一入口（沒掛教學的頁是整顆不畫的，
       * 操作紀錄這一輪之前正是那樣）。⛔ 用 ?tour= 開得起來不等於使用者找得到。
       *
       * ⛔ 這裡**一定要真的按下去**，不可以只查「這顆在不在」。
       *    2026-09-21：多支教學的那條路（機器人模組、知識庫）按了完全沒反應——
       *    氣泡夾在 el-dropdown 和按鈕中間，選單的浮層從 2026-08-27 上線起就一直
       *    停在 `display: none`。而這支守門員當時只查了「在不在」，所以三週半都是綠的。
       */
      await pressHelpButton(page, c.label)

      const total = seen[0]?.count ? seen[0].count.split('/')[1]?.trim() : (seen.length ? '1' : undefined)
      if (c.expectSteps) {
        if (String(total) === String(c.expectSteps))
          pass(`${c.label}：導覽共 ${total} 步（跟預期一樣）`)
        else
          fail(`${c.label}：導覽共 ${total} 步，預期 ${c.expectSteps} 步`)
      }
      else if (Number(total) >= c.minSteps && Number(total) <= c.maxSteps) {
        pass(`${c.label}：導覽共 ${total} 步（這一支跟資料有關，在 ${c.minSteps}～${c.maxSteps} 步之間）`)
      }
      else {
        fail(`${c.label}：導覽共 ${total} 步，應該在 ${c.minSteps}～${c.maxSteps} 步之間`)
      }
      // 走完的步數要等於卡片上寫的總數（沒走完＝中途卡住）
      if (total && seen.length !== Number(total))
        fail(`${c.label}：卡片說共 ${total} 步，實際只走到 ${seen.length} 步`)

      // 有渲染條件的那幾格，跑完整支之後逐一確認真的在畫面上
      for (const sel of c.conditional) {
        const there = await page.$(sel)
        if (there) pass(`${c.label}：${sel} 在畫面上`)
        else fail(`${c.label}：${sel} 不在畫面上（導覽指到它的那一步會變成空話）`)
      }
    }
    catch (e) {
      fail(`${c.label}：${String(e).split('\n')[0]}`)
    }
    finally {
      await ctx.close()
    }
    console.log('')
  }

  // ── 加驗：這一輪補的就地說明，真的出現在畫面上了嗎 ─────────────────────────
  // 導覽是「帶你看一遍」，就地說明是「你自己看的時候讀得到」——後者沒出現的話，
  // 沒跑導覽的人（＝絕大多數回訪的人）等於什麼都沒補到。
  if (!ONLY.length) {
    console.log('── 加驗：就地說明 ──────────────────')
    const { page, ctx } = await openLoggedInPage()
    try {
      // ① 訂閱與付款：額度用完會怎樣（這一頁拍板不做導覽，只補一句）
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/settings/billing`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await sleep(2500)
      const billing = await page.evaluate(() => ({
        quota: document.querySelector('[data-tour="bill-quota"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        body: document.body.innerText,
      }))
      if (!billing.quota) {
        // 沒有則數上限的帳號（客製額度、或根本還沒開通付費方案）本來就沒有這一區，
        // 這句話也就不該出現。⛔ 這種情況要講出來是「這次沒驗到」，不可以混成綠燈。
        const why = billing.body.includes('客製額度')
          ? '客製額度、沒有則數上限'
          : billing.body.includes('尚未開通付費方案')
            ? '這個帳號還沒開通付費方案'
            : ''
        if (why) console.log(`   ⏭️ 用量那一區不存在（${why}）＝這一句本來就不適用，這次沒驗到`)
        else fail(`訂閱與付款：找不到用量那一區，也看不出原因。畫面上是：「${billing.body.replace(/\s+/g, ' ').slice(0, 160)}」`)
      }
      else if (billing.quota.includes('用完之後') && billing.quota.includes('轉給真人客服')) {
        pass('訂閱與付款：「用完之後會怎樣」看得到了')
      }
      else {
        fail(`訂閱與付款：那句「用完之後會怎樣」沒出現。實際讀到的是：「${billing.quota.slice(0, 120)}」`)
      }

      // ② 推播：匯入名單那串 U 開頭的編號要去哪拿
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/broadcasts`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await page.waitForSelector('[data-tour="bc-new"]', { timeout: 60_000 })
      await page.keyboard.press('Escape') // 自動導覽可能蓋住畫面
      await sleep(800)
      await page.click('[data-tour="bc-new"]')
      await page.waitForSelector('[data-tour="bc-audience"]', { timeout: 30_000 })
      // 點「匯入名單」那顆 radio
      await page.evaluate(() => {
        const labels = [...document.querySelectorAll('[data-tour="bc-audience"] .el-radio')]
        labels.find(l => l.textContent?.includes('匯入名單'))?.click()
      })
      await sleep(800)
      // ⛔ 不要只看 [data-tour="bc-audience"]：那一格裡面只有「發送對象」那排選項，
      //    「匯入名單」的輸入框與說明是**它的兄弟節點**（第一次寫錯就是錯在這，看起來像程式沒改到）
      const audience = await page.evaluate(() => {
        const card = document.querySelector('[data-tour="bc-audience"]')?.closest('.message-card')
        return {
          picked: !!document.querySelector('[data-tour="bc-audience"] .el-radio.is-checked'),
          text: card?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        }
      })
      if (!audience.text.includes('LINE User IDs'))
        fail(`推播：沒有切到「匯入名單」那個選項（有選中的選項嗎：${audience.picked}），這一條沒驗到`)
      else if (audience.text.includes('複製 ID') && audience.text.includes('多數情況用不到'))
        pass('推播：「匯入名單」講得出那串編號去哪拿了')
      else
        fail(`推播：「匯入名單」的說明沒出現。實際讀到：「${audience.text.slice(0, 160)}」`)

      // ③ 推播成效說明不可以再把機器設定名攤給店家看
      const jargon = await page.evaluate(() => {
        const el = document.querySelector('.bc-click-hint')
        return el ? el.textContent ?? '' : ''
      })
      const leaked = ['PUBLIC_BASE_URL', 'LINE_IMAGEMAP_BASE_URL', 'CLICK_TRACKING_BASE_URL', '/api/r'].filter(t => jargon.includes(t))
      if (!jargon) fail('推播：找不到成效說明那段（.bc-click-hint）')
      else if (leaked.length) fail(`推播：成效說明還把這些攤給店家看－－${leaked.join('、')}`)
      else pass('推播：成效說明已經沒有機器設定名了')

      /**
       * ④ 知識庫「你的資料」的問號。
       * 這一頁沒有進上面的 CASES（它的導覽另外驗），但它跟機器人模組一樣掛了**多支**教學，
       * 走的是同一條「先出選單讓人挑」的路——2026-09-21 那個「按了沒反應」的洞兩頁都中，
       * 所以兩頁都要有人看著。
       */
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/knowledge/sources`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await page.waitForSelector('.page-help-btn', { timeout: 60_000 })
      await sleep(2500)
      await pressHelpButton(page, '知識庫「你的資料」')
    }
    catch (e) {
      fail(`就地說明加驗：${String(e).split('\n')[0]}`)
    }
    finally {
      await ctx.close()
    }
    console.log('')
  }

  // ── 加驗：已經展開「進階調校」的人，導覽不可以反手把它收起來 ──────────────
  // `clickBefore` 是無條件點的，而這個目標是**開關**不是按鈕：使用者自己先展開過的話，
  // 再點一次就等於當著他的面收起來，然後那一步指向一個剛被自己藏掉的東西。
  // 這正是 `clickBeforeUnless` 要擋的事，但它只有在「先展開」的情況下才會被執行到——
  // 上面那輪（預設收合）跑得再綠也驗不到這一條。
  if (!ONLY.length) {
    console.log('── 加驗：使用者自己先展開過「進階調校」──────────────────')
    const { page, ctx } = await openLoggedInPage()
    try {
      // ⛔ 不可以「展開之後再 goto ?tour=」：整頁重新載入會把展開狀態沖掉，
      //    這一關就變成跟上面那輪一模一樣的情境＝**假綠燈**（2026-09-18 破壞性驗證當場抓到：
      //    把 clickBeforeUnless 拆掉，這一關照樣綠）。所以改成不換頁，直接按頁首那顆問號開導覽。
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/ai-settings`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await page.waitForSelector('[data-tour="ais-advanced"]', { timeout: 60_000 })
      // 自動導覽可能先跳出來蓋住畫面，先關掉再操作
      await page.keyboard.press('Escape')
      await sleep(800)
      await page.click('[data-tour="ais-advanced"]')
      await sleep(800)
      if (!(await page.$('[data-tour="ais-handback"]')))
        throw new Error('手動展開沒生效，這一關的前提不成立')

      await openFirstHelpTopic(page)
      await page.waitForSelector('.ta-tour-title', { visible: true, timeout: 30_000 })
      // 走到第 5 步（那一步才會碰 clickBefore）
      for (let i = 1; i < 5; i++) await clickNext(page)
      const step = await readStep(page)
      const stillThere = !!(await page.$('[data-tour="ais-handback"]'))
      if (stillThere && step && !step.missing)
        pass(`已經展開的人：導覽沒有把「進階調校」收起來（第 ${step.count}「${step.title}」照樣指得到）`)
      else
        fail('已經展開的人：導覽反手把「進階調校」收起來了＝那一步指向一個剛被自己藏掉的東西')
    }
    catch (e) {
      fail(`加驗：${String(e).split('\n')[0]}`)
    }
    finally {
      await ctx.close()
    }
    console.log('')
  }

  // ── 加驗：圖文選單「設為預設（上線）」（2026-09-29 `D-109` 第 3 題）───────────
  // 建立時沒設預設的選單，確認框叫人「之後再設為預設」，以前卻沒有任何一顆按鈕做得到。
  // ⛔ 只看按鈕在不在、按了會不會先跳確認框——**不按確定**（那會換掉正式帳號所有好友的選單）
  if (!ONLY.length || ONLY.includes('richmenu')) {
    console.log('── 加驗：圖文選單「設為預設（上線）」──────────────────')
    const { page, ctx } = await openLoggedInPage()
    page.on('dialog', d => d.dismiss())
    try {
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/richmenu`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await page.waitForSelector('[data-tour="rm-list"]', { timeout: 60_000 })
      await sleep(1200)
      // 自動導覽可能蓋著：收掉
      for (let i = 0; i < 10 && await page.$('.ta-tour-title'); i++) await clickNext(page)
      const rowsInfo = await page.evaluate(() => [...document.querySelectorAll('[data-tour="rm-list"] .split-list-item')]
        .map((el, i) => ({ i, text: el.textContent?.replace(/\s+/g, ' ').trim() ?? '' })))
      const notDefault = rowsInfo.find(r => r.text.includes('客人看不到'))
      const isDefault = rowsInfo.find(r => r.text.includes('預設'))
      if (!notDefault) {
        console.log('   ⏭️ 這個帳號沒有「客人看不到」的選單＝那顆按鈕本來就不該出現，這次沒驗到')
      }
      else {
        await page.evaluate((i) => document.querySelectorAll('[data-tour="rm-list"] .split-list-item')[i]?.click(), notDefault.i)
        await sleep(1500)
        const btn = await page.$('[data-tour="rm-set-default"]')
        if (!btn) {
          fail('圖文選單：打開一張「客人看不到」的選單，上面沒有「設為預設（上線）」')
        }
        else {
          pass('圖文選單：打開「客人看不到」的選單，上面有「設為預設（上線）」')
          await btn.click()
          await sleep(900)
          const box = await page.evaluate(() => {
            const m = document.querySelector('.el-message-box')
            return m ? m.textContent?.replace(/\s+/g, ' ').trim() ?? '' : ''
          })
          if (box.includes('所有好友') && box.includes('設為預設並上線'))
            pass('圖文選單：按下去先跳確認框，講清楚所有好友會立刻換（這裡不按確定）')
          else
            fail(`圖文選單：按下去沒有先講後果。讀到的是：「${box.slice(0, 120)}」`)
          // 取消，不上線
          await page.evaluate(() => {
            const btns = [...document.querySelectorAll('.el-message-box__btns .el-button')]
            btns.find(b => b.textContent?.includes('再檢查一下'))?.click()
          })
          await sleep(600)
        }
      }
      if (isDefault) {
        await page.evaluate((i) => document.querySelectorAll('[data-tour="rm-list"] .split-list-item')[i]?.click(), isDefault.i)
        await sleep(1500)
        if (await page.$('[data-tour="rm-set-default"]'))
          fail('圖文選單：已經是預設的那張也出現「設為預設（上線）」')
        else
          pass('圖文選單：已經是預設的那張不出現那顆按鈕')
      }
    }
    catch (e) {
      fail(`圖文選單加驗：${String(e).split('\n')[0]}`)
    }
    finally {
      await ctx.close()
    }
    console.log('')
  }
}
finally {
  // 原封還原，不留痕跡（⛔不是刪掉：那會清掉這位管理員真實的「看過了」）
  if (prefsData) await prefsRef.set(prefsData)
  else await prefsRef.delete().catch(() => {})
  console.log(`adminUserPrefs/${uid} 已${prefsData ? '還原成原本的內容' : '刪回原本的「不存在」'}`)
  await browser.close()
}

if (failed) process.exitCode = 1
else console.log('\n全部通過')
