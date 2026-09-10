/**
 * 註冊入口（`D-74` A 案）的實機守門員：門面按鈕 → 登入頁 → 落點，整條走一次。
 *
 *   npm run dev                                  # 另一個終端先跑起來
 *   node scripts/signup-entry-check.mjs
 *
 * 為什麼要有這支：這個專案吃過太多次「typecheck 綠＋既有測試綠，但新程式根本沒被執行到」
 * （見記憶 `feedback_verify_new_code_actually_runs`）。純函式測得到的只有「該去哪」的判斷，
 * 「按鈕真的帶了參數嗎、登入頁真的換了字嗎、零帳號的人真的被送進開通引導嗎」
 * 只有真的開一次瀏覽器才知道。
 *
 * ⛔ 這支**不碰任何正式服務**（跟 tag-review-drawer-check 不同，那支用真 token）：
 *    登入狀態是**假 JWT**（自己組的、exp 在未來，Firebase JS SDK 在還沒過期時不會連
 *    identitytoolkit，另外再把那個網域整個攔掉當保險），帳號清單是**瀏覽器端攔截**
 *    `/api/admin/workspaces/my` 回的假資料——我們自己的伺服器連那支請求都收不到，
 *    Firestore 一筆都不會被讀。所以這支可以隨便跑，不需要正式金鑰。
 */
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'

let failed = 0
const ok = msg => console.log(`  ✅ ${msg}`)
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++ }
const check = (cond, msg, detail = '') => cond ? ok(msg) : fail(`${msg}${detail ? `　→ 實際：${detail}` : ''}`)

/** 組一個「格式對、簽章假」的 idToken：SDK 只在過期時才會拿去續，claims 是前端自己解的 */
function fakeJwt(claims) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: 'https://securetoken.google.com/fake', aud: 'fake', sub: 'uid-check',
    user_id: 'uid-check', email: 'check@example.com', email_verified: true,
    auth_time: now, iat: now, exp: now + 3600, firebase: { sign_in_provider: 'google.com' },
    ...claims,
  })}.fake-signature`
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

/**
 * 開一個「已登入」的頁面：假登入狀態 ＋ 攔截帳號清單 API。
 * @param opts.claims    塞進 idToken 的額外 claims（例如 `{ superAdmin: true }`）
 * @param opts.list      `/api/admin/workspaces/my` 要回什麼；`'fail'` ＝回 500（模擬斷網／token 過期）
 */
async function signedInPage({ claims = {}, list }) {
  // ⛔ 每個情境一個獨立 context：同一個 browser 的 newPage() 共用 IndexedDB／localStorage，
  //    上一個情境的登入狀態與帳號清單快取會漏到下一個（2026-08-07 LIFF 那輪踩過同一個坑）
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  page.on('pageerror', e => console.log('    [page error]', String(e).slice(0, 160)))

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    // 保險：假 token 若真被拿去續，一律擋掉（回 400 ＝ SDK 當作續不到，不會清掉登入狀態）
    if (url.includes('identitytoolkit.googleapis.com') || url.includes('securetoken.googleapis.com'))
      return req.respond({ status: 400, contentType: 'application/json', body: '{"error":{"message":"BLOCKED_BY_CHECK"}}' })
    if (url.includes('/api/admin/workspaces/my')) {
      if (list === 'fail')
        return req.respond({ status: 500, contentType: 'application/json', body: '{"statusMessage":"boom"}' })
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(list) })
    }
    return req.continue()
  })

  // 先開同一個 origin 的頁面，才寫得進它的 IndexedDB
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
  // ⚠️ 儲存鍵裡的 apiKey 必須是**這個 app 自己**在用的那一把（`firebase:authUser:<apiKey>:[DEFAULT]`），
  //    自己編一把假的等於把使用者寫到 SDK 永遠不會去看的抽屜裡（第一版就是這樣，五項全紅）。
  //    ⚠️ Nuxt 4 的 dev 頁面沒有 `window.__NUXT__`，所以從送到瀏覽器的 HTML 裡撈
  //    （firebaseApiKey 是 public config，本來就會出現在頁面上）。
  const apiKey = (await page.content()).match(/AIza[\w-]{20,}/)?.[0]
  if (!apiKey) { console.error('讀不到 app 的 firebaseApiKey，無法組登入狀態'); process.exit(1) }
  await page.evaluate(async ({ apiKey, idToken }) => {
    const user = {
      uid: 'uid-check', email: 'check@example.com', emailVerified: true, isAnonymous: false,
      providerData: [{ providerId: 'google.com', uid: 'check@example.com', email: 'check@example.com', displayName: null, phoneNumber: null, photoURL: null }],
      stsTokenManager: { refreshToken: 'fake-refresh', accessToken: idToken, expirationTime: Date.now() + 3600_000 },
      createdAt: String(Date.now() - 86400_000), lastLoginAt: String(Date.now()), apiKey, appName: '[DEFAULT]',
    }
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('firebaseLocalStorageDb', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
      req.onsuccess = () => {
        const tx = req.result.transaction('firebaseLocalStorage', 'readwrite')
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: `firebase:authUser:${apiKey}:[DEFAULT]`, value: user })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
    // 帳號清單有 localStorage 快取（middleware 會先拿它放行），每種情境都要從乾淨開始
    for (const k of Object.keys(localStorage)) if (k.includes('workspace')) localStorage.removeItem(k)
  }, { apiKey, idToken: fakeJwt(claims) })

  return page
}

/** 走到 `to`，等路由停下來，回最後停在哪一頁 */
async function landOn(page, to) {
  await page.goto(`${BASE}${to}`, { waitUntil: 'networkidle2', timeout: 90_000 })
  await new Promise(r => setTimeout(r, 2500)) // 清單回來 → 判斷 → navigateTo，都在 onMounted 之後
  return new URL(page.url()).pathname + new URL(page.url()).search
}

const WS = {
  workspaces: [{ workspaceId: 'ws-1', name: '測試帳號', role: 'owner', organizationId: 'org-1', organizationName: '測試組織', plan: { id: 'free', name: '免費' } }],
  orgAdminOf: [],
}
const EMPTY = { workspaces: [], orgAdminOf: [] }

// ══ ① 門面按鈕真的帶了參數嗎 ═══════════════════════════════════════════
console.log('\n① 門面的註冊按鈕（首頁六顆＋法務頁＋頁尾）')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  for (const path of ['/', '/terms']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0', timeout: 60_000 })
    const links = await page.$$eval('a[href*="/login"]', as => as.map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') })))
    const signup = links.filter(l => /免費/.test(l.text))
    const signin = links.filter(l => l.text === '登入')
    check(signup.length > 0 && signup.every(l => l.href === '/login?intent=start'),
      `${path}：註冊按鈕 ${signup.length} 顆全部帶 ?intent=start`,
      JSON.stringify(signup))
    check(signin.length > 0 && signin.every(l => l.href === '/login'),
      `${path}：「登入」${signin.length} 顆維持裸 /login（⛔ 不可帶參數）`,
      JSON.stringify(signin))
  }
  await page.close()
}

// ══ ② 登入頁兩種招呼語 ════════════════════════════════════════════════
console.log('\n② 登入頁：註冊口吻 vs 中性文案')
for (const [tag, path, want, unwanted] of [
  ['intent=start', '/login?intent=start', ['免費打造我的', '第一步：用 Google 帳號登入，不用另外設密碼', '取個名字', '免費方案不用綁卡', '回首頁'], ['管理後台 · 使用 Google 帳號登入', '第一次使用？']],
  ['裸 /login', '/login', ['管理後台 · 使用 Google 帳號登入', '第一次使用？', '回首頁'], ['免費打造我的', '第一步：']],
]) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0', timeout: 60_000 })
  const text = await page.$eval('.login-card', el => el.innerText)
  for (const w of want) check(text.includes(w), `${tag}：看得到「${w}」`)
  for (const u of unwanted) check(!text.includes(u), `${tag}：⛔ 不該出現「${u}」`)
  // 版面：卡片不溢出、退路的手指目標夠大
  const box = await page.evaluate(() => {
    const card = document.querySelector('.login-card')
    // ⚠️ 2026-09-10 `D-75` 把頁尾重排成一行（「聯繫我們 · 回首頁」），
    //    「回首頁」的 class 從 `.login-back` 換成共用的 `.entry-link--quiet`。
    //    這條檢查的**用意沒變**：回門面的路要在、而且手指點得到。
    const back = [...document.querySelectorAll('.entry-foot a')].find(a => a.getAttribute('href') === '/')
    const logoLink = document.querySelector('.login-brand a')
    return {
      cardW: Math.round(card.getBoundingClientRect().width),
      cardH: Math.round(card.getBoundingClientRect().height),
      backH: back ? Math.round(back.getBoundingClientRect().height) : 0,
      logoHref: logoLink?.getAttribute('href') ?? null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  check(box.overflowX <= 0, `${tag}：橫向溢出 0`, `${box.overflowX}px`)
  check(box.backH >= 28, `${tag}：「回首頁」可點高度 ${box.backH}px（≥28）`)
  check(box.logoHref === '/', `${tag}：logotype 連回首頁`, String(box.logoHref))
  console.log(`     卡片 ${box.cardW}×${box.cardH}px`)
  await page.close()
}
// 手機寬度也量一次（版面要 headless 渲染並量盒模型才算驗過）
{
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 })
  await page.goto(`${BASE}/login?intent=start`, { waitUntil: 'networkidle0', timeout: 60_000 })
  const m = await page.evaluate(() => {
    const card = document.querySelector('.login-card').getBoundingClientRect()
    // ⚠️ 2026-09-10 `G-75`：招呼語改成頭像＋淡綠泡泡，標題的 class 從 `.login-title`
    //    換成 `.entry-say__t`。這條檢查的**用意沒變**：標題在 390px 不可以折行。
    const title = document.querySelector('.entry-say__t')
    return {
      cardW: Math.round(card.width), cardH: Math.round(card.height),
      titleLines: title ? Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)) : 0,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  check(m.overflowX <= 0, `390px：橫向溢出 0`, `${m.overflowX}px`)
  check(m.titleLines === 1, `390px：標題「免費打造我的 MiniMe」不折行`, `${m.titleLines} 行`)
  console.log(`     390px 卡片 ${m.cardW}×${m.cardH}px`)
  await page.close()
}

// ══ ③ 登入後落點（新程式真的跑到了嗎）═══════════════════════════════════
console.log('\n③ 登入後落點：四種人 × 有沒有帶意圖')
for (const [tag, opts, to, want] of [
  ['來註冊、零帳號 → 直接進開通引導（跳過三選一）', { list: EMPTY }, '/admin/workspaces?intent=start', '/admin/onboarding'],
  ['⛔ 裸 /login 的零帳號人 → 維持迎賓頁三選一', { list: EMPTY }, '/admin/workspaces', '/admin/workspaces'],
  ['⛔ 清單查不到（500）時不可送走——那時的「零帳號」是假的', { list: 'fail' }, '/admin/workspaces?intent=start', '/admin/workspaces?intent=start'],
  ['⛔ 超管不送（他的空狀態畫面上有超管後台入口）', { list: EMPTY, claims: { superAdmin: true } }, '/admin/workspaces?intent=start', '/admin/workspaces?intent=start'],
]) {
  const page = await signedInPage(opts)
  const landed = await landOn(page, to)
  check(landed === want, tag, landed)
  await page.close()
}
// 已經有帳號的人：帶了意圖也不可以被劫走（單一帳號會自動進那個帳號）
{
  const page = await signedInPage({ list: WS })
  const landed = await landOn(page, '/admin/workspaces?intent=start')
  check(landed.startsWith('/admin/ws-1/'), '已經有帳號的人：帶意圖也照原本規則進帳號，不進開通引導', landed)
  await page.close()
}

// ══ ④ 迎賓頁不再說「選擇要管理的官方帳號」═══════════════════════════════
console.log('\n④ 迎賓頁（零帳號、裸進來）')
{
  const page = await signedInPage({ list: EMPTY })
  await landOn(page, '/admin/workspaces')
  const t = await page.evaluate(() => ({
    card: document.querySelector('.ws-select-card')?.innerText ?? '',
    sub: document.querySelector('.ws-select-sub') ? 'present' : 'absent',
  }))
  check(t.sub === 'absent', '⛔ 沒有東西可選時不出「選擇要管理的官方帳號」', t.sub)
  check(t.card.includes('我想開始使用'), '三選一的歡迎卡照常出現')
  await page.close()
}

await browser.close()
console.log(failed ? `\n${failed} 項不通過\n` : '\n全部通過\n')
process.exit(failed ? 1 : 0)
