/**
 * 步驟輪播（`AgentStepCarousel`）的實機守門員。
 *
 *   npm run dev                                  # 另一個終端先跑起來
 *   node scripts/onboarding-carousel-check.mjs   # 桌機寬
 *   W=430 node scripts/onboarding-carousel-check.mjs   # 手機寬（驗 @container 那條）
 *   OUT=<資料夾> node scripts/onboarding-carousel-check.mjs   # 截圖丟去別的地方（預設 /tmp）
 *
 * 為什麼要有這支：這個元件的規則幾乎**全部是行為與版面**——自動播一輪就停、動過手就
 * 不再自己跳、畫面外不累計、「再看一次」只在最後一步現身、實心綠靠最左、
 * 計數器兩端各自對齊步驟軌的兩端。這些東西 typecheck 全綠、單元測試也全綠，
 * 但只要一條 CSS 權重寫錯就整條靜默失效。
 *
 * 2026-09-10 第一次跑就抓到兩個：
 *   ① `IntersectionObserver` 根本沒被建立（掛載時根節點還不存在，我把兩件事寫成同一個
 *      條件）→ 畫面外的八支輪播全都在跑，人捲到的時候早就演完了。
 *   ② `.agm-carousel__nav button` 的權重壓過 `.agm-carousel__replay`，
 *      老闆指定的「實心綠」被畫成白底導航鈕。
 *
 * ⛔ 它開的是 `/__carousel-check`（只在 dev 存在的驗收台），不是開通引導本人——
 *    走完整個狀態機才看得到輪播，而且要真的貼連線資訊。
 */
import puppeteer from 'puppeteer'

const BASE = process.env.BASE ?? 'http://localhost:3000'
// ⚠️ 預設不可以寫成某一輪的 scratchpad 絕對路徑（換一台機器、換一個 session 就是不存在的
//    資料夾，截圖那兩行直接拋錯，而前面的檢查明明都跑完了）——要另存就用 OUT= 帶。
const OUT = process.env.OUT ?? '/tmp'
const W = Number(process.env.W ?? 900)

const browser = await puppeteer.launch({ headless: 'new', args: [`--window-size=${W},1000`] })
const page = await browser.newPage()
await page.setViewport({ width: W, height: 1000, deviceScaleFactor: 2 })
const errs = []
page.on('pageerror', e => errs.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })

await page.goto(`${BASE}/__carousel-check`, { waitUntil: 'networkidle0', timeout: 60000 })
await page.waitForSelector('.agm-carousel__img', { timeout: 20000 })
await new Promise(r => setTimeout(r, 800))

const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass, detail })

// 幾支輪播都畫出來了嗎
const cards = await page.$$('.agm-carousel')
ok('八支輪播都畫出來', cards.length === 8, `實得 ${cards.length}`)

const first = await page.$('[data-carousel="webhookUrl"] .agm-carousel')
const geom = await page.evaluate(() => {
  const c = document.querySelector('[data-carousel="webhookUrl"] .agm-carousel')
  const r = el => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } }
  const segs = [...c.querySelectorAll('.agm-carousel__track i')]
  return {
    img: r(c.querySelector('.agm-carousel__img')),
    no: r(c.querySelector('.agm-carousel__no')),
    total: r(c.querySelector('.agm-carousel__total')),
    track: r(c.querySelector('.agm-carousel__track')),
    seg0: r(segs[0]), segLast: r(segs.at(-1)), segCount: segs.length,
    cap: r(c.querySelector('.agm-carousel__cap')),
    prev: r(c.querySelector('.agm-carousel__prev')),
    next: r(c.querySelector('.agm-carousel__next')),
    card: r(c),
    noText: c.querySelector('.agm-carousel__no').textContent.trim(),
    totalText: c.querySelector('.agm-carousel__total').textContent.trim(),
    capText: c.querySelector('.agm-carousel__cap').textContent.trim(),
    alt: c.querySelector('.agm-carousel__img').alt,
    baseline: getComputedStyle(c.querySelector('.agm-carousel__bar')).alignItems,
    replay: !!c.querySelector('.agm-carousel__replay'),
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
  }
})

ok('圖在最上面（貼卡片上緣）', Math.abs(geom.img.t - geom.card.t) <= 1, `圖 ${geom.img.t} / 卡 ${geom.card.t}`)
ok('「第 N 步」在圖下面', geom.no.t >= geom.img.b, `no.t=${geom.no.t} img.b=${geom.img.b}`)
ok('「第 N 步」靠左、「共 N 步」靠右', geom.no.l < geom.total.l && geom.total.r > geom.no.r, `no ${geom.no.l}-${geom.no.r} / total ${geom.total.l}-${geom.total.r}`)
ok('兩者同一行', Math.abs(geom.no.t - geom.total.t) < 20, `${geom.no.t} vs ${geom.total.t}`)
ok('用 baseline 對齊不是 center', geom.baseline === 'baseline', geom.baseline)
ok('步驟軌在計數器下一排', geom.track.t >= geom.no.b - 2, `track.t=${geom.track.t} no.b=${geom.no.b}`)
ok('軌的格數＝總步數（4）', geom.segCount === 4, `${geom.segCount}`)
ok('「第 N 步」左緣對齊第一格左端', Math.abs(geom.no.l - geom.seg0.l) <= 1, `${geom.no.l} vs ${geom.seg0.l}`)
ok('「共 N 步」右緣對齊最後一格右端', Math.abs(geom.total.r - geom.segLast.r) <= 1, `${geom.total.r} vs ${geom.segLast.r}`)
ok('圖說在軌下面', geom.cap.t >= geom.track.b - 2, `${geom.cap.t} vs ${geom.track.b}`)
ok('上一步／下一步靠右', geom.next.r > geom.card.r - 30 && geom.prev.l > geom.card.l + geom.card.w / 2, `prev.l=${geom.prev.l} next.r=${geom.next.r} card=${geom.card.l}-${geom.card.r}`)
ok('alt 是完整句子（含「第 N 步（共 N 步）」）', /^第 \d+ 步（共 \d+ 步）：/.test(geom.alt), geom.alt.slice(0, 40))
ok('圖說不含圈號', !/[①②③④⑤⑥⑦⑧⑨]/.test(geom.capText), geom.capText.slice(0, 30))
ok('沒有橫向溢出', geom.docW <= geom.winW + 1, `${geom.docW} vs ${geom.winW}`)

// ── 行為：自動播一輪 → 停在最後一步 → 才給「再看一次」 ─────────────
const step = async () => page.evaluate(() => {
  const c = document.querySelector('[data-carousel="webhookUrl"] .agm-carousel')
  return {
    no: c.querySelector('.agm-carousel__no').textContent.trim(),
    state: c.querySelector('.agm-carousel__state').textContent.trim(),
    replay: !!c.querySelector('.agm-carousel__replay'),
    nextDisabled: c.querySelector('.agm-carousel__next').disabled,
    prevDisabled: c.querySelector('.agm-carousel__prev').disabled,
    done: [...c.querySelectorAll('.agm-carousel__track i')].map(i => i.classList.contains('is-done')),
  }
})
// ⭐ 規則⑥：這支在畫面外（第 7 支），**不可以**自己跑掉。
//    2026-09-10 就是這一條抓到 IntersectionObserver 根本沒被建立。
const s0 = await step()
ok('畫面外的輪播不累計（還停在第 1 步）', s0.no === '第 1 步', JSON.stringify(s0))
ok('畫面外時狀態說「捲到畫面上就開始播」', s0.state === '捲到畫面上就開始播', s0.state)

// 捲進畫面 → 才開始自動播
await page.evaluate(() => document.querySelector('[data-carousel="webhookUrl"]').scrollIntoView({ block: 'center' }))
await new Promise(r => setTimeout(r, 300))
const s1 = await step()
ok('剛捲到時在第 1 步、上一步是灰的', s1.no === '第 1 步' && s1.prevDisabled, JSON.stringify(s1))
ok('捲到之後就說「自動播放中」', s1.state === '自動播放中', s1.state)
ok('第 1 步不給「再看一次」', !s1.replay)

// 一格 4 秒：等 4.6 秒應該自己走到第 2 步
await new Promise(r => setTimeout(r, 4600))
ok('捲到畫面上會自動前進', (await step()).no === '第 2 步', (await step()).no)

// 回到第 1 步再驗手動（用重播鈕做不到，這時還沒有；直接點軌第一格）
await page.evaluate(() => document.querySelectorAll('[data-carousel="webhookUrl"] .agm-carousel__track i')[0].click())
ok('點軌回到第 1 步、並停掉自動播', (await step()).no === '第 1 步' && (await step()).state === '也可以用左右鍵切換')

await page.click('[data-carousel="webhookUrl"] .agm-carousel__next')
const s2 = await step()
ok('按下一步 → 第 2 步', s2.no === '第 2 步', s2.no)
ok('動過手就不再自動播（狀態改口）', s2.state === '也可以用左右鍵切換', s2.state)
ok('第 2 步不給「再看一次」（v46 修的那個 bug）', !s2.replay)
ok('走過的格子標成 is-done', s2.done[0] === true && s2.done[1] === false, JSON.stringify(s2.done))

await page.click('[data-carousel="webhookUrl"] .agm-carousel__next')
await page.click('[data-carousel="webhookUrl"] .agm-carousel__next')
const s4 = await step()
ok('走到第 4 步 → 下一步變灰', s4.no === '第 4 步' && s4.nextDisabled, JSON.stringify(s4))
ok('「再看一次」與「下一步變灰」同時發生', s4.replay === s4.nextDisabled, `replay=${s4.replay} nextDisabled=${s4.nextDisabled}`)

await page.click('[data-carousel="webhookUrl"] .agm-carousel__prev')
const s3 = await step()
ok('從最後一步退回去 → 鈕收掉', s3.no === '第 3 步' && !s3.replay, JSON.stringify(s3))

// 鍵盤
await page.focus('[data-carousel="webhookUrl"] .agm-carousel')
await page.keyboard.press('ArrowLeft')
ok('左鍵退一步', (await step()).no === '第 2 步')

// 點步驟軌跳步
await page.evaluate(() => document.querySelectorAll('[data-carousel="webhookUrl"] .agm-carousel__track i')[3].click())
ok('點軌上最後一格 → 跳到第 4 步並給重播鈕', (await step()).no === '第 4 步' && (await step()).replay)

// ⭐「再看一次」是**實心綠**（老闆指定的視覺）。2026-09-10 踩到：`.agm-carousel__nav button`
//    的權重比單寫 `.agm-carousel__replay` 高，實心綠被壓成白底，肉眼近拍才看得出來。
const replayStyle = await page.evaluate(() => {
  const b = document.querySelector('[data-carousel="webhookUrl"] .agm-carousel__replay')
  const s = getComputedStyle(b)
  const nav = getComputedStyle(document.querySelector('[data-carousel="webhookUrl"] .agm-carousel__prev'))
  return { bg: s.backgroundColor, color: s.color, navBg: nav.backgroundColor, left: b.getBoundingClientRect().left }
})
ok('「再看一次」是實心綠、不是白底導航鈕', replayStyle.bg !== replayStyle.navBg && replayStyle.color === 'rgb(255, 255, 255)', JSON.stringify(replayStyle))
const navGeom = await page.evaluate(() => {
  const q = s => document.querySelector(`[data-carousel="webhookUrl"] ${s}`).getBoundingClientRect()
  const card = q('.agm-carousel')
  return {
    replay: Math.round(q('.agm-carousel__replay').left),
    replayRight: Math.round(q('.agm-carousel__replay').right),
    prev: Math.round(q('.agm-carousel__prev').left),
    card: Math.round(card.left), mid: Math.round(card.left + card.width / 2),
    stateTop: Math.round(q('.agm-carousel__state').top), navTop: Math.round(q('.agm-carousel__prev').top),
  }
})
// ⛔ 門檻不能寫死成像素（手機卡只有 ~350px 寬）：要驗的是**分站兩端**這個關係——
//    重播貼左緣、導航整組在中線右邊。窄卡也必須維持，不可以因為變窄就併回一起。
ok('「再看一次」靠最左、與導航鈕分站兩端',
  Math.abs(navGeom.replay - navGeom.card) < 20 && navGeom.prev > navGeom.mid && navGeom.prev > navGeom.replayRight + 24,
  JSON.stringify(navGeom))
if (W < 460) {
  // 窄卡：狀態文字自己占一行（排到鈕的上面）
  ok('窄卡時狀態文字自己占一行', navGeom.stateTop < navGeom.navTop - 8, `state ${navGeom.stateTop} / nav ${navGeom.navTop}`)
}

// 兩步版：按一次就到底，給鈕本來就對
await page.evaluate(() => document.querySelector('[data-carousel="accountList"]').scrollIntoView({ block: 'center' }))
await page.evaluate(() => document.querySelectorAll('[data-carousel="accountList"] .agm-carousel__track i')[0].click())
await page.click('[data-carousel="accountList"] .agm-carousel__next')
const two = await page.evaluate(() => {
  const c = document.querySelector('[data-carousel="accountList"] .agm-carousel')
  return { no: c.querySelector('.agm-carousel__no').textContent.trim(), replay: !!c.querySelector('.agm-carousel__replay') }
})
ok('2 步版按一次就給鈕（本來就對）', two.no === '第 2 步' && two.replay, JSON.stringify(two))

ok('沒有 JS 例外', errs.length === 0, errs.slice(0, 3).join(' | '))

await page.screenshot({ path: `${OUT}/carousel-${W}.png`, fullPage: true })
const card1 = await page.$('[data-carousel="webhookUrl"] .agm-carousel')
await card1.screenshot({ path: `${OUT}/carousel-close-${W}.png` })

console.log(`\n寬度 ${W}px：`)
let bad = 0
for (const r of results) {
  if (!r.pass) bad++
  console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
}
console.log(`\n${results.length - bad}/${results.length} 通過`)
await browser.close()
process.exit(bad ? 1 : 0)
