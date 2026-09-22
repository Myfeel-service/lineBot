/**
 * 「好友統計」頁的實機守門員（2026-09-23，`D-28`＋`D-63` Phase 1）。
 *
 *   npm run dev -- --port 3318                                         # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3318 node --env-file=.env_myfeel scripts/friend-stats-check.mjs
 *
 * **為什麼一定要真的開瀏覽器**：這一輪的東西 typecheck 與單元測試一條都驗不到——
 * 純函式有 24 條測試，但「那六張卡有沒有真的被渲染出來」「冷卻中按鈕是不是真的按不動」
 * 「發推播給這群點下去會不會落到推播頁而且受眾選好了」全部沒有人驗過。
 * 這個專案吃過九次「typecheck 綠＋測試綠，但新程式根本沒被執行到」
 * （記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * ⚠️ **連正式資料庫（myfeel），但全程零寫入**：
 *    - 只讀 `workspaceMembers` 找一個管理員換 token（唯讀）
 *    - 瀏覽器端**所有非 GET 一律攔截擋掉**——⛔ `POST /api/tag/report` 真的送出去
 *      會在正式庫寫一份 `tagReports` 並燒一次 LLM，還會掃三四千筆
 *    - `GET /api/tag/report` 一律**假造**：這頁的六張卡要用各種極端資料驗，
 *      靠正式庫那一份驗不到「算不出覆蓋率」「沒有總結」這些分支
 *
 * ⛔ **內建對照組**：每一關都先斷言「這個東西本來不在」再斷言「做完之後在」。
 *    少了前半，選擇器只要寫成一個到處都在的東西，整份就是假綠燈。
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

/**
 * 關 7 要一顆**真的存在**的標籤 id（唯讀撈一顆）。
 * ⛔ 用假 id 的話只驗得到「對不上時有沒有講出來」那條分支，
 *    「受眾真的被選好」那條主線——也就是使用者九成會走的那條——完全沒被跑到。
 */
const tagSnap = await db.collection('tags').where('workspaceId', '==', WORKSPACE_ID).limit(1).get()
const realTag = tagSnap.empty
  ? null
  : { id: tagSnap.docs[0].id, name: String(tagSnap.docs[0].data().name ?? '') }
console.log(realTag ? `關 7 會用真標籤：${realTag.name}` : '⚠️ 這個工作區沒有標籤，關 7 只驗得到「對不上」那條分支')

let failed = false
const fail = msg => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const blocked = []

async function openLoggedInPage({ fakeReads } = {}) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  // ⛔ 原生 confirm 會把 JS 執行緒卡死到 puppeteer 逾時（看起來像頁面壞了）
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
    // ⛔ 沒被指名的寫入一律擋成 500，而且記下來跑完印出證據
    blocked.push(`${method} ${url}`)
    req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusMessage: '守門員擋下了這個寫入' }) })
  })

  // 假造 Firebase 登入：把 SDK 會讀的那份 IndexedDB 記錄先塞好
  await page.evaluateOnNewDocument((s) => {
    const key = `firebase:authUser:${s.apiKey}:[DEFAULT]`
    const val = JSON.stringify({
      uid: s.uid, email: s.email, emailVerified: true, isAnonymous: false,
      providerData: [{ providerId: 'password', uid: s.email, email: s.email }],
      stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
      createdAt: String(Date.now()), lastLoginAt: String(Date.now()), apiKey: s.apiKey, appName: '[DEFAULT]',
    })
    try { window.localStorage.setItem(key, val) } catch { /* 無痕視窗 */ }
    // ⛔ 導覽會自動彈出來蓋住畫面、還會自己點按鈕（`reference_headless_admin_harness_traps`）
    try { window.localStorage.setItem('minime:tour-disabled', '1') } catch { /* noop */ }
  }, session)

  return { ctx, page }
}

/** 等到頁面上出現任一條件；⛔ 不要「睡固定秒數再量一次」——那是假綠燈的標準形狀 */
async function waitForText(page, needles, timeout = 25_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await page.evaluate(() => document.body?.innerText ?? '')
    const hit = needles.find(n => body.includes(n))
    if (hit) return { hit, body }
    await new Promise(r => setTimeout(r, 400))
  }
  const body = await page.evaluate(() => document.body?.innerText ?? '')
  return { hit: null, body }
}

// ═══════════════════════════════════════════════════════════════════
//  假報告：六張卡都有料的那一份
// ═══════════════════════════════════════════════════════════════════
function payload(over = {}) {
  return {
    integrity: {
      failed: [], userTagsTruncated: false, suggestionLogsTruncated: false, pendingTruncated: false,
      scannedUserTags: 2433, suggestionLedgerSince: '2026-08-30',
    },
    pendingReview: { users: 45, byTag: [{ tagId: 't1', name: '在看咖啡機', category: null, color: null, users: 12 }] },
    customerExpressed: [
      { tagId: 't1', name: '問卷 - 乾淨方MAX', category: null, color: null, users: 850, isIntent: false },
      { tagId: 't2', name: '客服 - BOYA mini2', category: null, color: null, users: 106, isIntent: false },
      { tagId: 't3', name: '在看咖啡機', category: null, color: null, users: 12, isIntent: true },
    ],
    intersections: [{
      a: { tagId: 't1', name: '問卷 - 乾淨方MAX', category: null, color: null },
      b: { tagId: 't2', name: '客服 - BOYA mini2', category: null, color: null },
      users: 10,
    }],
    eventVsIntent: { intent: { tags: 4, taggings: 63 }, event: { tags: 33, taggings: 2369 } },
    sourceMix: { counts: { ai: 63, rule: 0, system: 2369, manual: 1, import: 0 }, total: 2433, customerExpressed: 2432, ourOwn: 1 },
    coverage: { taggedUsers: 2235, untaggedUsers: 2776, totalUsers: 5011, pct: 44.6 },
    health: {
      zeroMember: [{ tagId: 'z1', name: '舊檔期' }],
      aiOnButNeverProduced: [{ tagId: 'a1', name: '在看紓壓按摩' }],
    },
    suggestions: { suggested: 77, autoApplied: 6, applied: 55, dismissed: 17, superseded: 0, decided: 72, agreed: 55, acceptanceRate: 76.4 },
    tagNotes: [],
    ...over,
  }
}

function reportReply(body) {
  return url => (url.includes('/api/tag/report') ? { body } : null)
}

const WS = `${BASE}/admin/${WORKSPACE_ID}`

// ═══════════════════════════════════════════════════════════════════
//  關 1：側欄有這一項，而且點得進去
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({ report: null, canRegenerate: true, cooldownRemainingMs: 0 }),
  })
  // ⛔ 別用 `/users` 當起點：那頁在 dev 首次編譯要跑很久，量到的會是「還沒編譯完」
  //    而不是「側欄沒這一項」（記憶 `reference_headless_admin_harness_traps` 第一坑）。
  //    改用這一輪本來就要編譯的 friend-stats 自己當起點，側欄是同一份 layout。
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const nav = await waitForText(page, ['好友統計'], 60_000)
  if (!nav.hit) fail('關 1：側欄「好友經營」段找不到「好友統計」')
  else {
    // ⛔ 對照組：側欄同一段還有「對話統計」，兩個都叫統計——確認點到的是新那一頁
    const clicked = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => x.textContent?.trim() === '好友統計')
      if (!a) return ''
      a.click()
      return a.getAttribute('href') ?? ''
    })
    if (!clicked.endsWith('/friend-stats')) fail(`關 1：那一項指到 ${clicked || '(找不到連結)'}，不是 /friend-stats`)
    else pass(`關 1：側欄有「好友統計」，連到 ${clicked}`)
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 2：還沒產生過 → 空狀態；⛔ 對照組＝此時六張卡一張都不該在
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({ report: null, canRegenerate: true, cooldownRemainingMs: 0 }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['還沒有產生過報告'])
  if (!r.hit) fail(`關 2：沒看到空狀態。畫面上是：${r.body.slice(0, 200)}`)
  else {
    // ⛔ 對照組**不可以比對文字**：空狀態那段說明裡本來就寫著「客人自己表現出來的興趣、
    //    …AI 判得準不準」（第一版守門員就是這樣誤判成紅燈的）。改成數真的卡片元素。
    const cards = await page.evaluate(() => document.querySelectorAll('.friend-stats .message-card').length)
    if (cards !== 0) fail(`關 2 對照組：還沒有報告卻畫出了 ${cards} 張卡`)
    else pass('關 2：還沒產生過只給空狀態，卡片數＝0（對照組成立）')
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 3：有報告 → 六張卡都渲染得出來，而且口徑那幾句在
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({
      report: {
        generatedAtMs: Date.now() - 2 * 60 * 60 * 1000,
        generatedBy: '守門員',
        payload: payload(),
        summary: '- 意圖型標籤只有 4 顆、貼出 63 筆\n- 有 45 位客人的建議還沒決定',
        summarySkip: null,
      },
      canRegenerate: true,
      cooldownRemainingMs: 0,
    }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['客人自己表現出來的'])
  if (!r.hit) fail(`關 3：報告畫不出來。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const want = [
      ['卡 1 待審', '45 位客人'],
      ['卡 2 排行', '問卷 - 乾淨方MAX'],
      ['卡 2 交集', '「問卷 - 乾淨方MAX」＋「客服 - BOYA mini2」'],
      ['卡 3 事件 vs 意圖', '事件紀錄（這個人做過什麼）'],
      ['卡 4 覆蓋率', '2776'],
      ['卡 5 健康檢查', '在看紓壓按摩'],
      ['卡 6 成績', '76.4%'],
      ['總結', '意圖型標籤只有 4 顆'],
      // ⭐ 誠信紅線：分母一定要寫「有互動的客人」，⛔ 不可以寫「好友」
      ['分母口徑', '有互動的客人'],
      // ⭐ 底帳起算日一定要標
      ['底帳起算日', '2026-08-30'],
      // ⭐ 「AI 直接貼」不算進同意率要明講
      ['直接貼不算', '沒有算進上面的同意率'],
      // ⭐ 兩本帳不可以相加
      ['兩本帳', '不要相加'],
      // ⭐ 排行要分得出「做過什麼 vs 想要什麼」（實測連 AI 都會把名冊讀成興趣）
      ['做過什麼徽章', '做過什麼'],
      ['想要什麼徽章', '想要什麼'],
      ['事件不等於想買', '不代表他想買'],
    ]
    const missing = want.filter(([, t]) => !r.body.includes(t))
    // 關 2 對照組的正面版：那邊是 0 張，這邊要是 7 張（總結＋六張卡）
    const cards = await page.evaluate(() => document.querySelectorAll('.friend-stats .message-card').length)
    if (missing.length) fail(`關 3：少了 ${missing.map(([k]) => k).join('、')}`)
    else if (cards !== 7) fail(`關 3：卡片數是 ${cards}，應該是 7（總結＋六張卡）`)
    else pass(`關 3：七張卡都在，四句口徑紅線也都在（共 ${want.length} 項）`)
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 4：冷卻中按鈕真的按不動（⛔ 不是只有灰色，要真的 disabled）
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({
      report: { generatedAtMs: Date.now() - 5 * 60_000, generatedBy: '', payload: payload(), summary: 'x', summarySkip: null },
      canRegenerate: false,
      cooldownRemainingMs: 55 * 60_000,
    }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  await waitForText(page, ['客人自己表現出來的'])
  const state = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('重新產生'))
    return b ? { found: true, disabled: b.disabled } : { found: false }
  })
  if (!state.found) fail('關 4：找不到「重新產生」按鈕')
  else if (!state.disabled) fail('關 4：冷卻中按鈕竟然按得動——⛔ 那就沒有成本閘門')
  else pass('關 4：冷卻中「重新產生」是 disabled')
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 5：沒有總結一定要講為什麼（三種理由三句不同的話）
// ═══════════════════════════════════════════════════════════════════
for (const [skip, needle] of [['too_thin', '貼標資料還太少'], ['llm_failed', 'AI 服務沒回應'], ['rejected', '沒通過檢查']]) {
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({
      report: { generatedAtMs: Date.now(), generatedBy: '', payload: payload(), summary: '', summarySkip: skip },
      canRegenerate: false,
      cooldownRemainingMs: 60 * 60_000,
    }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, [needle])
  if (!r.hit) fail(`關 5（${skip}）：沒有總結卻沒講為什麼，⛔ 它就這樣靜靜消失了`)
  else pass(`關 5（${skip}）：講出了「${needle}」`)
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 6：算不完整要出聲（截斷／查不到）
// ═══════════════════════════════════════════════════════════════════
{
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({
      report: {
        generatedAtMs: Date.now(),
        generatedBy: '',
        payload: payload({
          integrity: { failed: ['userCount'], userTagsTruncated: true, suggestionLogsTruncated: false, pendingTruncated: true, scannedUserTags: 10000, suggestionLedgerSince: '2026-08-30' },
          coverage: { taggedUsers: 2235, untaggedUsers: null, totalUsers: null, pct: null },
        }),
        summary: '',
        summarySkip: 'too_thin',
      },
      canRegenerate: false,
      cooldownRemainingMs: 60 * 60_000,
    }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  const r = await waitForText(page, ['這份報告有幾塊不完整'])
  if (!r.hit) fail(`關 6：掃描截斷卻一聲不吭。畫面上是：${r.body.slice(0, 200)}`)
  else {
    const want = [
      ['截斷講出來', '貼標紀錄掃到上限'],
      ['查不到講出來', '這次查不到'],
      // ⭐ 撞上限時「45 位」一定要變成「掃到的那些裡有 45 位」，⛔ 不可以當精確值
      ['待審不當精確值', '掃到的那些裡有 45 位客人'],
      // ⭐ 覆蓋率算不出來要講「算不出來」，⛔ 不可以畫一個錯的百分比
      ['覆蓋率算不出來', '這次算不出覆蓋率'],
    ]
    const missing = want.filter(([, t]) => !r.body.includes(t))
    if (missing.length) fail(`關 6：少了 ${missing.map(([k]) => k).join('、')}`)
    else pass('關 6：截斷／查不到／覆蓋率算不出來，三件事都出聲了')
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
//  關 7：「發推播給這群」真的落到推播頁，而且受眾選好了那顆標籤
//        （這條驗的是 broadcasts.vue 新加的 applyTagHandoff）
// ═══════════════════════════════════════════════════════════════════
{
  // 排行第一列換成真標籤，才走得到「受眾真的被選好」那條主線
  const ranked = payload().customerExpressed
  if (realTag) ranked[0] = { ...ranked[0], tagId: realTag.id, name: realTag.name }
  const { ctx, page } = await openLoggedInPage({
    fakeReads: reportReply({
      report: {
        generatedAtMs: Date.now() - 2 * 3600_000,
        generatedBy: '',
        payload: payload({ customerExpressed: ranked }),
        summary: 'x',
        summarySkip: null,
      },
      canRegenerate: true,
      cooldownRemainingMs: 0,
    }),
  })
  await page.goto(`${WS}/friend-stats`, { waitUntil: 'domcontentloaded' })
  await waitForText(page, ['客人自己表現出來的'])

  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('發推播給這群'))
    if (!b) return false
    b.click()
    return true
  })
  if (!clicked) fail('關 7：排行那一列沒有「發推播給這群」按鈕')
  else {
    const r = await waitForText(page, ['那顆標籤現在選不到了', '發送對象已選好'])
    const url = page.url()
    if (!url.includes('/broadcasts')) fail(`關 7：按了沒有落到推播頁，現在在 ${url}`)
    else if (!url.includes('from=friend-stats') || !url.includes('tagId=')) fail(`關 7：網址沒帶參數過去：${url}`)
    else if (!r.hit) fail('關 7：落到推播頁了，但交接一聲不吭——⛔ 安靜開一張空白推播會讓人以為受眾選好了')
    else if (realTag && r.hit !== '發送對象已選好') {
      fail(`關 7：用的是真標籤「${realTag.name}」，卻走到「${r.hit}」——受眾沒被選好`)
    }
    else {
      // 受眾真的被選好時，還要確認「依標籤篩選」那顆 radio 真的被選中
      const picked = await page.evaluate(() => {
        const r = [...document.querySelectorAll('.el-radio')].find(x => x.textContent?.includes('依標籤篩選'))
        return r ? r.classList.contains('is-checked') : null
      })
      if (realTag && picked !== true) fail(`關 7：說選好了，但「依標籤篩選」沒被選中（picked=${picked}）`)
      else pass(`關 7：落到推播頁（${url.split('?')[1]}），受眾切到「依標籤篩選」並帶入標籤`)
    }
  }
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════════
console.log('')
console.log(`被擋下的寫入請求：${blocked.length} 筆${blocked.length ? `（${[...new Set(blocked)].join('、')}）` : '＝全程沒有任何寫入送出去'}`)
await browser.close()
if (failed) { console.error('\n有關卡沒過'); process.exit(1) }
console.log('\n全部通過')
