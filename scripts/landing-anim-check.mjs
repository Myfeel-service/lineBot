/**
 * 導購頁進場動畫的驗收工具（2026-09-03 老闆反映「動畫常常還沒滑到就已經觸發完了」之後加的）。
 *
 *   npm run dev
 *   node scripts/landing-anim-check.mjs            # 桌機 1440x900
 *   node scripts/landing-anim-check.mjs 844 390    # 手機（視窗高 寬）
 *
 * 兩關，任一關不合格就以非 0 結束：
 *   ① 捲動實測：一步 90px 往下捲，記下每個動畫「開始跑的那一刻，元素在畫面裡露出幾成」。
 *      判準＝**有時間軸的動畫**（畫線／長條／打字／live demo，掛 .lp-cue → .is-cued）
 *      開演時元素上緣必須已在畫面內、且露出 ≥35%。
 *      淡入（.lp-reveal → .in）只印不判：它本來就該在元素剛露出一條邊時開始。
 *   ② 功能實測：每段動畫的「前 → 後」數值真的有動（不是只有 class 掛上去而已），
 *      再加「減少動態效果」與「沒有 JS」兩種情況下內容必須完整看得到。
 *
 * ⛔ 兩個會量到假數字的坑（都實際踩過）：
 *   1. 捲動一定要 behavior:'instant'——頁面自己把 documentElement 設成 scroll-behavior:smooth，
 *      用預設捲會邊捲邊量到半路的值。
 *   2. 一定要照**頁面順序**由上而下測：動畫只演一次，跳著測的話回頭量到的是「演完的樣子」，
 *      看起來就像動畫沒跑（第 2 站與 live 卡只差 357px，捲過頭會順手把下一個也觸發掉）。
 */
import process from 'node:process'
import puppeteer from 'puppeteer'

const VH = Number(process.argv[2] || 900)
const VW = Number(process.argv[3] || 1440)
const URL = process.env.LANDING_URL || 'http://localhost:3000/'
const STEP = 90 // 每次捲 90px，約一次滑鼠滾輪
const MIN_VISIBLE_PCT = 35 // 有時間軸的動畫開演時，元素至少要露出這麼多

const fails = []
const ok = msg => console.log('  ✅ ' + msg)
const bad = (msg) => { console.log('  ❌ ' + msg); fails.push(msg) }
const num = v => Number.parseFloat(v)
const wait = ms => new Promise(r => setTimeout(r, ms))
/** scaleY(0)／scaleX(0)＝收起來 */
const collapsed = t => /^matrix\(1, 0, 0, 0[,)]/.test(t) || /^matrix\(0[,)]/.test(t)
const grown = t => t === 'none' || /^matrix\(1, 0, 0, 1[,)]/.test(t)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

// ── ① 捲動實測：每個動畫是在畫面的哪個位置開始跑的 ─────────────
{
  const page = await browser.newPage()
  await page.setViewport({ width: VW, height: VH })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
  await wait(2000)

  await page.evaluate(() => {
    window.__log = []
    window.__seen = new Set()
    const all = () => document.querySelectorAll('.lp-reveal, .lp-cue, .lp-turn')
    const label = (el) => {
      const c = el.className.toString().split(/\s+/)
        .filter(x => x.startsWith('lp-') && !x.startsWith('lp-reveal') && x !== 'lp-cue')
      return (c[0] || el.tagName.toLowerCase()) + (c[1] ? '.' + c[1] : '')
    }
    window.__probe = () => {
      const vh = window.innerHeight
      const list = [...all()]
      for (const el of list) {
        for (const cls of ['in', 'is-cued']) {
          if (!el.classList.contains(cls)) continue
          const key = `${label(el)}|${cls}|${list.indexOf(el)}`
          if (window.__seen.has(key)) continue
          window.__seen.add(key)
          const r = el.getBoundingClientRect()
          const vis = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
          window.__log.push({
            what: label(el),
            trigger: cls,
            scrollY: Math.round(window.scrollY),
            visiblePct: Math.round((vis / r.height) * 100),
            topInView: Math.round(r.top),
            h: Math.round(r.height),
          })
        }
      }
    }
  })

  const docH = await page.evaluate(() => document.documentElement.scrollHeight)
  for (let y = 0; y < docH; y += STEP) {
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), y)
    await wait(60)
    await page.evaluate(() => window.__probe())
  }

  const log = await page.evaluate(() => window.__log)
  console.log(`① 捲動實測 ${VW}x${VH}（每步 ${STEP}px）\n`)
  console.log('  觸發     | 元素                                | scrollY | 上緣 | 高   | 開演時露出')
  let timed = 0
  for (const e of log) {
    const isTimed = e.trigger === 'is-cued'
    if (isTimed) timed++
    const pass = !isTimed || (e.topInView < VH && e.visiblePct >= MIN_VISIBLE_PCT)
    if (!pass) fails.push(`${e.what} 的動畫在畫面外／露太少就開演（露出 ${e.visiblePct}%）`)
    console.log(
      `  ${e.trigger.padEnd(8)} | ${e.what.padEnd(35)} | ${String(e.scrollY).padStart(7)} `
      + `| ${String(e.topInView).padStart(4)} | ${String(e.h).padStart(4)} | ${String(e.visiblePct).padStart(3)}%`
      + (pass ? '' : '  ❌ 在畫面外／露太少就開演'),
    )
  }
  console.log(`\n  有時間軸的動畫 ${timed} 個，不合格 ${fails.length} 個`)
  await page.close()
}

// ── ② 功能實測：數值真的有動（由上而下，照頁面順序）───────────
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
  await wait(1500)
  console.log('\n② 功能實測（正常模式，由上而下）')

  const go = async (sel, offset) => {
    await page.evaluate((sel, offset) => {
      const el = document.querySelector(sel)
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + offset, behavior: 'instant' })
    }, sel, offset)
    await wait(120)
  }
  const val = (sel, prop, pseudo = null) => page.evaluate(
    (sel, prop, pseudo) => getComputedStyle(document.querySelector(sel), pseudo).getPropertyValue(prop),
    sel, prop, pseudo,
  )

  // 1) 泡泡打字
  await go('#why .lp-turn', -830)
  const onBefore = await page.$$eval('#why .lp-turn .lp-tw__u.is-on', e => e.length)
  await go('#why .lp-turn', -300)
  await wait(3000)
  const onAfter = await page.$$eval('#why .lp-turn .lp-tw__u.is-on', e => e.length)
  const stillTyping = await page.$eval('#why .lp-turn', el => el.classList.contains('is-typing'))
  onAfter > onBefore ? ok(`打字有跑：亮起的字 ${onBefore} → ${onAfter}`) : bad(`打字沒跑：${onBefore} → ${onAfter}`)
  stillTyping ? bad('打字沒收尾，is-typing 還在') : ok('打字有收尾（is-typing 拿掉、螢光筆刷回來）')

  // 2) 一條路的中軸綠線
  await go('.lp-path__step--linked', -830)
  const lineBefore = await val('.lp-path__step--linked', 'transform', '::after')
  // ⚠️ -450 不是 -300：第 2 站與 live 卡只差 357px，捲太多會順手把 live 卡也觸發掉
  await go('.lp-path__step--linked', -450)
  await wait(1400)
  const lineAfter = await val('.lp-path__step--linked', 'transform', '::after')
  collapsed(lineBefore) ? ok(`中軸綠線 起點＝收起 (${lineBefore})`) : bad(`中軸綠線 起點不是收起：${lineBefore}`)
  grown(lineAfter) ? ok(`中軸綠線 終點＝長完 (${lineAfter})`) : bad(`中軸綠線 沒長完：${lineAfter}`)

  // 3) 開通引導 live 卡：進度條長出來＋demo 真的往下演
  await go('.lp-liveob', -830)
  const barBefore = await val('.lp-liveob .onbc-step.is-current', 'transform', '::before')
  const beatsBefore = await page.$$eval('.lp-liveob .agm-msg', e => e.length)
  await go('.lp-liveob', -250)
  await wait(1800)
  const barAfter = await val('.lp-liveob .onbc-step.is-current', 'transform', '::before')
  await wait(6000)
  const beatsAfter = await page.$$eval('.lp-liveob .agm-msg', e => e.length)
  const progDone = await page.$$eval('.lp-liveob .onbc-step.is-done', e => e.length)
  collapsed(barBefore) ? ok(`進度條 起點＝收起 (${barBefore})`) : bad(`進度條 起點不是收起：${barBefore}`)
  grown(barAfter) ? ok(`進度條 終點＝長完 (${barAfter})`) : bad(`進度條 沒長完：${barAfter}`)
  beatsAfter > beatsBefore
    ? ok(`demo 有在演：泡泡 ${beatsBefore} → ${beatsAfter} 則、進度已完成 ${progDone} 格`)
    : bad(`demo 沒演，泡泡停在 ${beatsAfter}`)

  // 4) 成長曲線
  await go('.lp-chartwrap', -830)
  const chartBefore = await val('.lp-chart__me', 'stroke-dashoffset')
  await go('.lp-chartwrap', -300)
  await wait(2000)
  const chartAfter = await val('.lp-chart__me', 'stroke-dashoffset')
  const lblAfter = await val('.lp-chart__lbls', 'opacity')
  num(chartBefore) > 0.9 ? ok(`成長曲線 起點＝沒畫 (${chartBefore})`) : bad(`成長曲線 起點不對：${chartBefore}`)
  num(chartAfter) < 0.01 ? ok(`成長曲線 終點＝畫完 (${chartAfter})`) : bad(`成長曲線 沒畫完：${chartAfter}`)
  num(lblAfter) > 0.99 ? ok(`曲線標籤 浮出來了 (${lblAfter})`) : bad(`曲線標籤 沒浮出：${lblAfter}`)

  // 5) 整頁捲完不能留下還藏著的東西
  await page.evaluate(async () => {
    const h = document.documentElement.scrollHeight
    for (let y = 0; y < h; y += 300) {
      window.scrollTo({ top: y, behavior: 'instant' })
      await new Promise(r => requestAnimationFrame(r))
    }
  })
  await wait(1500)
  const leftHidden = await page.evaluate(() => [...document.querySelectorAll('.lp-reveal')]
    .filter(el => Number(getComputedStyle(el).opacity) < 0.99)
    .map(el => el.className.toString().slice(0, 50)))
  leftHidden.length ? bad('捲完還藏著：\n     ' + leftHidden.join('\n     ')) : ok('整頁捲完，沒有任何區塊還藏著')
  await page.close()
}

// ── ③ 減少動態效果：內容必須完整 ────────────────────────────
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
  await wait(1200)
  console.log('\n③ 減少動態效果')
  const hidden = await page.evaluate(() => {
    const out = []
    const sel = '.lp-reveal, .lp-cue, .lp-pf, .lp-q, .lp-liveob, .lp-duo__text, .lp-band__phone, '
      + '.lp-hero__text > *, .lp-ops, .lp-ops__group, .lp-stamp'
    for (const el of document.querySelectorAll(sel)) {
      const o = Number(getComputedStyle(el).opacity)
      if (o < 0.99) out.push(el.className.toString().slice(0, 60) + ' opacity=' + o)
    }
    if (Number.parseFloat(getComputedStyle(document.querySelector('.lp-chart__me')).strokeDashoffset) > 0.01) out.push('成長曲線沒畫')
    if (Number(getComputedStyle(document.querySelector('.lp-chart__lbls')).opacity) < 0.99) out.push('曲線標籤沒出現')
    return out
  })
  const hasAnim = await page.evaluate(() => document.querySelector('.is-anim') !== null)
  hidden.length ? bad('這些被藏起來了：\n     ' + hidden.join('\n     ')) : ok('沒有任何區塊是藏起來的')
  ok(hasAnim ? '.is-anim 在場，CSS 保險有把東西還原' : '沒掛 .is-anim（JS 早退，符合設計）')
  await page.close()
}

// ── ④ 沒有 JS：SSR 出來的內容必須完整 ───────────────────────
{
  const page = await browser.newPage()
  await page.setJavaScriptEnabled(false)
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
  console.log('\n④ 沒有 JS')
  const hidden = await page.evaluate(() => [...document.querySelectorAll('.lp-reveal, .lp-cue')]
    .filter(el => Number(getComputedStyle(el).opacity) < 0.99)
    .map(el => el.className.toString().slice(0, 50)))
  hidden.length ? bad('沒 JS 卻藏著：\n     ' + hidden.join('\n     ')) : ok('全部看得到（.is-anim 沒掛上＝預設就是最終狀態）')
  await page.close()
}

await browser.close()
console.log(fails.length ? `\n不合格 ${fails.length} 項` : '\n全部通過')
process.exit(fails.length ? 1 : 0)
