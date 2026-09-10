/**
 * 入口頁（登入頁＋帳號選擇頁）的實機守門員（`D-75`）。
 *
 *   npm run dev                                  # 另一個終端先跑起來
 *   node scripts/entry-pages-check.mjs
 *
 * 為什麼要有這支：`D-75` 修的東西**全部都是「看 CSS 看不出來」的**——
 * 對比度要算、字級要量、兩頁一致要並排比、EP 的權重會靜靜蓋掉自訂色
 * （「內部／測試」標籤本來就是這樣變成藍色的，而 SCSS 上看起來是灰的）。
 * 這支把那些數字釘住，下次有人動樣式會當場紅。
 *
 * ⛔ 不碰任何正式服務：登入狀態是假 JWT（exp 在未來，SDK 不會連 identitytoolkit，
 *    另外把那個網域整個攔掉當保險），帳號清單是瀏覽器端攔截 `/api/admin/workspaces/my`
 *    回的假資料——我們自己的伺服器連那支請求都收不到，Firestore 一筆都不會被讀。
 */
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'

let failed = 0
const ok = msg => console.log(`  ✅ ${msg}`)
const fail = (msg, detail = '') => { console.error(`  ❌ ${msg}${detail ? `　→ ${detail}` : ''}`); failed++ }
const check = (cond, msg, detail = '') => cond ? ok(msg) : fail(msg, detail)

/** 中文可讀的字級地板（`G-33` 訂的）。低於這個值一律紅。 */
const MIN_FONT_PX = 12
/** 不該再出現在這兩頁的「太淡」色（`--text-muted`，白底 2.54:1） */
const MUTED = 'rgb(156, 163, 175)'
/** 不該再出現在這兩頁的「太亮」綠（`--brand-green-deep` 當文字，白底 2.81:1） */
const GREEN_DEEP = 'rgb(5, 178, 76)'

function fakeJwt(claims = {}) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: 'https://securetoken.google.com/fake', aud: 'fake', sub: 'uid-check', user_id: 'uid-check',
    email: 'check@example.com', email_verified: true, auth_time: now, iat: now, exp: now + 3600,
    firebase: { sign_in_provider: 'google.com' }, ...claims,
  })}.fake-signature`
}

const WS_LIST = {
  workspaces: [
    { workspaceId: 'w1', name: 'MYFEEL 官方帳號', role: 'owner', organizationId: 'o1', organizationName: '麥菲爾股份有限公司', plan: { id: 'internal', name: '內部／測試' } },
    { workspaceId: 'w2', name: 'Kevin 小店', role: 'admin', organizationId: 'o1', organizationName: '麥菲爾股份有限公司', plan: { id: 'lite', name: '輕量' } },
    { workspaceId: 'w4', name: '日出咖啡 Sunrise Coffee Roasters 官方帳號', role: 'owner', organizationId: 'o3', organizationName: '日出咖啡', plan: { id: 'free', name: '免費' } },
  ],
  orgAdminOf: [{ id: 'o1', name: '麥菲爾股份有限公司' }, { id: 'o3', name: '日出咖啡' }],
}
const WS_EMPTY = { workspaces: [], orgAdminOf: [] }

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

/** 開一頁；`list` 有值就順便假造登入狀態（⛔ 每個情境獨立 context，別讓上一個的登入漏過來） */
async function open(path, vp, list) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport(vp)
  page.on('pageerror', e => console.log('    [page error]', String(e).slice(0, 160)))

  if (list) {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('identitytoolkit.googleapis.com') || url.includes('securetoken.googleapis.com'))
        return req.respond({ status: 400, contentType: 'application/json', body: '{}' })
      if (url.includes('/api/admin/workspaces/my'))
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(list) })
      return req.continue()
    })
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
    // ⚠️ 儲存鍵裡的 apiKey 必須是這個 app 自己在用的那一把，自己編一把假的等於寫到 SDK 不會看的抽屜
    const apiKey = (await page.content()).match(/AIza[\w-]{20,}/)?.[0]
    if (!apiKey) { console.error('讀不到 firebaseApiKey'); process.exit(1) }
    await page.evaluate(async ({ apiKey, idToken }) => {
      const user = {
        uid: 'uid-check', email: 'check@example.com', emailVerified: true, isAnonymous: false, providerData: [],
        stsTokenManager: { refreshToken: 'r', accessToken: idToken, expirationTime: Date.now() + 3600_000 },
        createdAt: '0', lastLoginAt: '0', apiKey, appName: '[DEFAULT]',
      }
      await new Promise((res, rej) => {
        const r = indexedDB.open('firebaseLocalStorageDb', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
        r.onsuccess = () => {
          const tx = r.result.transaction('firebaseLocalStorage', 'readwrite')
          tx.objectStore('firebaseLocalStorage').put({ fbase_key: `firebase:authUser:${apiKey}:[DEFAULT]`, value: user })
          tx.oncomplete = res
          tx.onerror = () => rej(tx.error)
        }
        r.onerror = () => rej(r.error)
      })
      for (const k of Object.keys(localStorage)) if (k.includes('workspace')) localStorage.removeItem(k)
    }, { apiKey, idToken: fakeJwt() })
  }

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 90_000 })
  await new Promise(r => setTimeout(r, list ? 2500 : 600))
  return page
}

/** 卡片內每一段文字的字級／顏色／有效底色／對比度，以及卡片本身的幾何 */
const PROBE = `(() => {
  const parseRgb = s => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
  const lum = ([r, g, b]) => {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const contrast = (fg, bg) => {
    const [a, b] = [lum(parseRgb(fg)), lum(parseRgb(bg))]
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
  }
  // 有效底色：往上找到第一個不透明的祖先（文字自己通常是 transparent）
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor
      const a = (c.match(/[\\d.]+/g) || [])[3]
      if (c && c !== 'transparent' && a !== '0') return c
    }
    return 'rgb(255, 255, 255)'
  }
  const card = document.querySelector('.login-card, .ws-select-card')
  if (!card) return { card: null }
  const cs = getComputedStyle(card)
  const cr = card.getBoundingClientRect()
  const logo = document.querySelector('.login-brand img, .ws-select-logo img')
  const texts = []
  for (const el of card.querySelectorAll('*')) {
    // 只看「自己就帶文字」的節點（避免把容器的字重複算）
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    if (!own) continue
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const bg = bgOf(el)
    texts.push({
      sel: el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName.toLowerCase(),
      text: el.textContent.trim().slice(0, 18),
      px: Math.round(parseFloat(s.fontSize) * 100) / 100,
      weight: s.fontWeight,
      color: s.color,
      bg,
      contrast: contrast(s.color, bg),
    })
  }
  const btn = document.querySelector('.entry-btn')
  const foot = document.querySelector('.entry-foot')
  const stackBtn = document.querySelector('.ws-welcome-opt__btn')
  const optBody = document.querySelector('.ws-welcome-opt__body')
  const tags = [...document.querySelectorAll('.ws-item-plan-tag')].map(t => ({
    text: t.textContent.trim(), color: getComputedStyle(t).color, internal: t.classList.contains('plan-tag--internal'),
  }))
  const avatars = [...document.querySelectorAll('.ws-item-avatar')].map(a => ({
    ch: a.textContent.trim(), w: Math.round(a.getBoundingClientRect().width), h: Math.round(a.getBoundingClientRect().height),
  }))
  return {
    card: {
      x: Math.round(cr.x), w: Math.round(cr.width), h: Math.round(cr.height),
      padding: cs.padding, gap: cs.gap, radius: cs.borderRadius, shadow: cs.boxShadow.slice(0, 40),
    },
    logoH: logo ? Math.round(logo.getBoundingClientRect().height) : null,
    btn: btn ? { radius: getComputedStyle(btn).borderRadius, shadow: getComputedStyle(btn).boxShadow !== 'none', h: Math.round(btn.getBoundingClientRect().height), px: parseFloat(getComputedStyle(btn).fontSize) } : null,
    footRows: foot ? new Set([...foot.querySelectorAll('*')].filter(e => e.getBoundingClientRect().height).map(e => Math.round(e.getBoundingClientRect().top))).size : null,
    footH: foot ? Math.round(foot.getBoundingClientRect().height) : null,
    stacked: stackBtn && optBody ? Math.round(stackBtn.getBoundingClientRect().width) >= Math.round(optBody.getBoundingClientRect().width) - 2 : null,
    tags, avatars, texts,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})()`

const DESK = { width: 1440, height: 1000 }
const MOB = { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 }

// ══ ① 可讀性：字級地板與對比度（`D-75` A 組）══════════════════════════
console.log('\n① 可讀性（字級 ≥12px、對比度 ≥4.5，兩頁所有文字逐一算）')
const geo = {}
for (const [tag, path, vp, list] of [
  ['登入頁 註冊口吻', '/login?intent=start', DESK, null],
  ['登入頁 裸 /login', '/login', DESK, null],
  ['選帳頁 有帳號', '/admin/workspaces', DESK, WS_LIST],
  ['選帳頁 空狀態', '/admin/workspaces', DESK, WS_EMPTY],
]) {
  const page = await open(path, vp, list)
  const r = await page.evaluate(PROBE)
  if (!r.card) { fail(`${tag}：卡片沒渲染出來`); await page.browserContext().close(); continue }
  geo[tag] = r

  const tooSmall = r.texts.filter(t => t.px < MIN_FONT_PX)
  check(tooSmall.length === 0, `${tag}：所有文字 ≥${MIN_FONT_PX}px`, tooSmall.map(t => `${t.sel} ${t.px}px「${t.text}」`).join('；'))

  const muted = r.texts.filter(t => t.color === MUTED)
  check(muted.length === 0, `${tag}：⛔ 沒有 --text-muted 當內文（2.54:1）`, muted.map(t => `${t.sel}「${t.text}」`).join('；'))

  const brightGreen = r.texts.filter(t => t.color === GREEN_DEEP)
  check(brightGreen.length === 0, `${tag}：⛔ 沒有 --brand-green-deep 當文字（2.81:1）`, brightGreen.map(t => `${t.sel}「${t.text}」`).join('；'))

  // 對比度：白底上的深綠／深灰都該過 AA。
  // ⚠️ 兩類**站上既有的品牌／語意色**豁免（不是這輪的範圍、改了會動到全站，要老闆拍板）：
  //    ①白字印在品牌綠填色上（`--brand-green` #06c755 ＝ 2.26:1）——首頁所有主按鈕都是這個色
  //    ②Element Plus 語意標籤的 plain 文字（success #16a34a ＝ 3.3:1）——R1 拍板「狀態保留彩色」
  // ⛔ 但豁免的東西一定要印出來（「過濾掉東西要說得出丟了什麼」），別讓它靜靜消失。
  const low = r.texts.filter(t => t.contrast < 4.5)
  const exemptWhiteOnBrand = t => /^rgb\(255, 255, 255\)$/.test(t.color)
  const exemptSemanticTag = t => /el-tag/.test(t.sel)
  const exempted = low.filter(t => exemptWhiteOnBrand(t) || exemptSemanticTag(t))
  const lowContrast = low.filter(t => !exemptWhiteOnBrand(t) && !exemptSemanticTag(t))
  check(lowContrast.length === 0, `${tag}：文字對比度都 ≥4.5:1`, lowContrast.map(t => `${t.sel} ${t.contrast}:1「${t.text}」`).join('；'))
  for (const t of exempted)
    console.log(`     ⚠️ 豁免（站上既有品牌／語意色，等拍板）：${t.sel} ${t.contrast}:1「${t.text}」`)

  check(r.overflowX <= 0, `${tag}：橫向溢出 0`, `${r.overflowX}px`)
  await page.browserContext().close()
}

// ══ ② 兩頁幾何一致（`D-75` B 組）════════════════════════════════════
console.log('\n② 登入頁與選帳頁是連續兩頁，外殼必須是同一套')
{
  const a = geo['登入頁 註冊口吻']?.card
  const b = geo['選帳頁 有帳號']?.card
  if (!a || !b) { fail('兩頁的幾何沒量到') }
  else {
    for (const k of ['w', 'padding', 'gap', 'radius']) check(String(a[k]) === String(b[k]), `卡片 ${k} 兩頁相同`, `${a[k]} vs ${b[k]}`)
    check(geo['登入頁 註冊口吻'].logoH === geo['選帳頁 有帳號'].logoH, 'logo 高度兩頁相同', `${geo['登入頁 註冊口吻'].logoH} vs ${geo['選帳頁 有帳號'].logoH}`)
    check(a.shadow === b.shadow, '卡片陰影兩頁相同', `${a.shadow} vs ${b.shadow}`)
  }
  const btn = geo['登入頁 註冊口吻']?.btn
  check(btn && btn.radius.startsWith('999'), '主要按鈕是膠囊（跟首頁同一套按鈕語言）', btn?.radius)
  check(btn && btn.shadow, '主要按鈕有陰影＝全卡最重的元素就是唯一該按的那顆', String(btn?.shadow))
  check(btn && btn.h >= 44, `主要按鈕高度 ${btn?.h}px ≥44（手指目標）`)
}

// ══ ③ 手機（`D-75`⑤⑬ 與頁尾一行）══════════════════════════════════
console.log('\n③ 手機 390px')
for (const [tag, path, list] of [
  ['登入頁', '/login?intent=start', null],
  ['選帳頁 空狀態', '/admin/workspaces', WS_EMPTY],
  ['選帳頁 有帳號', '/admin/workspaces', WS_LIST],
]) {
  const page = await open(path, MOB, list)
  const r = await page.evaluate(PROBE)
  if (!r.card) { fail(`${tag}：卡片沒渲染出來`); await page.browserContext().close(); continue }
  check(r.card.x >= 16, `${tag}：卡片左邊有留白 ${r.card.x}px（≥16，圓角與陰影才不會被切）`)
  check(r.overflowX <= 0, `${tag}：橫向溢出 0`, `${r.overflowX}px`)
  check(r.footRows === null || r.footH <= 48, `${tag}：頁尾收在一行內（${r.footH}px）`)
  if (r.stacked !== null) check(r.stacked, `${tag}：主要選項卡在窄螢幕改上下堆疊、按鈕整寬`)
  await page.browserContext().close()
}

// ══ ④ 選帳頁自己的兩件事（`D-75`⑩⑮）═══════════════════════════════
console.log('\n④ 選帳頁：頭像與方案標籤')
{
  const r = geo['選帳頁 有帳號']
  check(r.avatars.length === 3, `每個帳號都有頭像（${r.avatars.length} 顆）`)
  check(new Set(r.avatars.map(a => a.ch)).size === r.avatars.length, '頭像上的字各不相同＝清單掃過去認得出誰是誰', r.avatars.map(a => a.ch).join(''))
  check(r.avatars.every(a => a.ch.length === 1 && a.w === a.h), '頭像是正圓、字只取一個（⛔ 不可切半個字變成 �）', JSON.stringify(r.avatars))
  const internal = r.tags.find(t => t.internal)
  const others = r.tags.filter(t => !t.internal)
  check(internal && internal.color !== 'rgb(37, 99, 235)', '「內部／測試」標籤不是 EP 的 info 藍', internal?.color)
  check(internal && others.every(o => o.color !== internal.color), '「內部／測試」與「免費／付費」不是同一個顏色（兩種意思要分得出來）', JSON.stringify(r.tags))
}

await browser.close()
console.log(failed ? `\n${failed} 項不通過\n` : '\n全部通過\n')
process.exit(failed ? 1 : 0)
