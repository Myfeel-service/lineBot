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
 *      **錯開式**的（見下面的 STAGGERED）只判上緣在不在畫面內，理由寫在那裡。
 *      淡入（.lp-reveal → .in）只印不判：它本來就該在元素剛露出一條邊時開始。
 *   ② 功能實測：每段動畫的「前 → 後」數值真的有動（不是只有 class 掛上去而已），
 *      再加「減少動態效果」與「沒有 JS」兩種情況下內容必須完整看得到。
 *
 * ⛔ 兩個會量到假數字的坑（都實際踩過）：
 *   1. 捲動一定要 behavior:'instant'——頁面自己把 documentElement 設成 scroll-behavior:smooth，
 *      用預設捲會邊捲邊量到半路的值。
 *   2. 一定要照**頁面順序**由上而下測：動畫只演一次，跳著測的話回頭量到的是「演完的樣子」，
 *      看起來就像動畫沒跑（左軸清單收緊後第一截綠線與 live 卡只差 ~210px，
 *      捲過頭會順手把下一個也觸發掉）。
 */
import process from 'node:process'
import puppeteer from 'puppeteer'

const VH = Number(process.argv[2] || 900)
const VW = Number(process.argv[3] || 1440)
const URL = process.env.LANDING_URL || 'http://localhost:3000/'
const STEP = 90 // 每次捲 90px，約一次滑鼠滾輪
const MIN_VISIBLE_PCT = 35 // 有時間軸的動畫開演時，元素至少要露出這麼多
/**
 * 「露出 35%」這條只適用**整塊一起演**的動畫（畫線、長條生長）。
 * 下面這幾個是**一個一個小孩錯開**演的（對話一句句到、名單一列列進來）：動畫從元素的
 * 最上面開始、跟著你往下捲一路演下去，本來就不需要整塊先露出來——而它們又比一個畫面
 * 還高（手機上的聊天窗 800px+），套 35% 只會逼人把動畫改成「捲過頭才開演」。
 * 這幾個改判「開演時**上緣**要在畫面內」＝第一個小孩看得到就算數。
 */
const STAGGERED = new Set(['lp-livewin.lp-livewin--chat', 'lp-livewin.lp-livewin--users'])

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
    const stag = STAGGERED.has(e.what)
    const pass = !isTimed || (stag ? (e.topInView >= 0 && e.topInView < VH) : (e.topInView < VH && e.visiblePct >= MIN_VISIBLE_PCT))
    if (!pass) {
      fails.push(stag
        ? `${e.what} 錯開動畫開演時上緣不在畫面內（上緣 ${e.topInView}）`
        : `${e.what} 的動畫在畫面外／露太少就開演（露出 ${e.visiblePct}%）`)
    }
    console.log(
      `  ${e.trigger.padEnd(8)} | ${e.what.padEnd(35)} | ${String(e.scrollY).padStart(7)} `
      + `| ${String(e.topInView).padStart(4)} | ${String(e.h).padStart(4)} | ${String(e.visiblePct).padStart(3)}%`
      + (stag && isTimed ? '  （錯開式：判上緣）' : '')
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

  // 2) #value 三扇畫面（09-03 十八輪）。⚠️ 一定要照頁面順序排在打字之後、一條路之前。
  //    量的是「看得到的東西真的從無到有」，不是只有 class 掛上去——所以數的是
  //    computed opacity > 0.9 的顆數（動畫是 CSS 的，class 不會變）。
  const litCount = sel => page.$$eval(sel, els => els.filter(e => Number(getComputedStyle(e).opacity) > 0.9).length)

  await go('.lp-livewin--chat', -830)
  const bubBefore = await litCount('.lp-livewin--chat .conv-bubble-row')
  const readBefore = await litCount('.lp-livewin--chat .conv-bubble-read')
  await go('.lp-livewin--chat', -300)
  await wait(3200) // 4 句 × 460ms ＋ 已讀那一拍
  const bubAfter = await litCount('.lp-livewin--chat .conv-bubble-row')
  const readAfter = await litCount('.lp-livewin--chat .conv-bubble-read')
  bubBefore === 0 ? ok('對話 起點＝一句都沒出現') : bad(`對話 起點不是空的：已亮 ${bubBefore} 句`)
  bubAfter === 4 ? ok(`對話 演完＝4 句全到（已讀 ${readBefore} → ${readAfter}）`) : bad(`對話 沒演完：${bubBefore} → ${bubAfter} 句`)

  await go('.lp-livewin--users', -830)
  const rowBefore = await litCount('.lp-livewin--users tbody tr')
  await go('.lp-livewin--users', -300)
  await wait(2400) // 6 列 × 100ms ＋ 標籤那一拍
  const rowAfter = await litCount('.lp-livewin--users tbody tr')
  const tagAfter = await litCount('.lp-livewin--users .tag-chip')
  rowBefore === 0 ? ok('好友名單 起點＝一列都沒出現') : bad(`好友名單 起點不是空的：已亮 ${rowBefore} 列`)
  rowAfter === 6 && tagAfter > 0
    ? ok(`好友名單 演完＝6 列全到、標籤貼上 ${tagAfter} 顆`)
    : bad(`好友名單 沒演完：列 ${rowBefore} → ${rowAfter}、標籤 ${tagAfter} 顆`)

  // ⚠️ 20 輪起選單是「圖自己往上滑進槽裡」，量的是 transform 的 Y 位移（舊版量 clip-path）
  const menuY = () => page.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.lp-pmenu')).transform)
    return Math.round(m.m42)
  })
  await go('.lp-band__phone', -830)
  const menuBefore = await menuY()
  await go('.lp-band__phone', -300)
  await wait(2200)
  const menuAfter = await menuY()
  const msgAfter = await litCount('.lp-band__phone .lp-pmsg')
  menuBefore > 40 ? ok(`圖文選單 起點＝收在槽外面 (translateY ${menuBefore}px)`) : bad(`圖文選單 起點不是收起來：translateY ${menuBefore}px`)
  menuAfter === 0
    ? ok(`圖文選單 滑到定位 (translateY 0)、歡迎訊息 ${msgAfter} 則`)
    : bad(`圖文選單 沒滑到定位：translateY ${menuBefore} → ${menuAfter}px`)

  // 3) 一條路的左軸綠線（二十三輪起線＝.lp-path__rail 自己，::after 是綠色那層；
  //    querySelector 拿到的是第一截——步驟 1 到步驟 2 那段）
  await go('.lp-path__rail', -830)
  const lineBefore = await val('.lp-path__rail', 'transform', '::after')
  // ⚠️ -600 不是 -450：左軸清單收緊後第一截線到 live 卡只剩 ~210px，
  //    捲太多會順手把 live 卡也觸發掉（cue 線在視窗 76%，900 高＝684px）
  await go('.lp-path__rail', -600)
  await wait(1400)
  const lineAfter = await val('.lp-path__rail', 'transform', '::after')
  collapsed(lineBefore) ? ok(`左軸綠線 起點＝收起 (${lineBefore})`) : bad(`左軸綠線 起點不是收起：${lineBefore}`)
  grown(lineAfter) ? ok(`左軸綠線 終點＝長完 (${lineAfter})`) : bad(`左軸綠線 沒長完：${lineAfter}`)

  // 4) 開通引導 live 卡：進度條長出來＋demo 真的往下演
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

  // 5) 成長曲線
  await go('.lp-chartwrap', -830)
  const chartBefore = await val('.lp-chart__me', 'stroke-dashoffset')
  await go('.lp-chartwrap', -300)
  await wait(2000)
  const chartAfter = await val('.lp-chart__me', 'stroke-dashoffset')
  const lblAfter = await val('.lp-chart__lbls', 'opacity')
  num(chartBefore) > 0.9 ? ok(`成長曲線 起點＝沒畫 (${chartBefore})`) : bad(`成長曲線 起點不對：${chartBefore}`)
  num(chartAfter) < 0.01 ? ok(`成長曲線 終點＝畫完 (${chartAfter})`) : bad(`成長曲線 沒畫完：${chartAfter}`)
  num(lblAfter) > 0.99 ? ok(`曲線標籤 浮出來了 (${lblAfter})`) : bad(`曲線標籤 沒浮出：${lblAfter}`)

  // 6) 證言牆跑馬燈（環境動態，無關 .is-cued）：真的在飄、滑鼠移上去那一列會停
  const trackX = () => page.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.lp-voices__track')).transform)
    return Math.round(m.m41)
  })
  await go('.lp-voices', -300)
  const vx1 = await trackX()
  await wait(1000)
  const vx2 = await trackX()
  Math.abs(vx2 - vx1) > 5 ? ok(`證言牆有在飄 (1 秒位移 ${Math.abs(vx2 - vx1)}px)`) : bad(`證言牆沒在飄：${vx1} → ${vx2}`)
  await page.hover('.lp-voices__row')
  await wait(250)
  const vx3 = await trackX()
  await wait(800)
  const vx4 = await trackX()
  Math.abs(vx4 - vx3) <= 1 ? ok('滑鼠移上去那一列停下來了') : bad(`hover 沒停：0.8 秒還位移 ${Math.abs(vx4 - vx3)}px`)
  await page.mouse.move(0, 0) // 把滑鼠挪開，別讓暫停影響後面的檢查

  // 7) 整頁捲完不能留下還藏著的東西
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
    // ⚠️ 09-03 十八輪加進來的三扇畫面：它們的宣告值是 opacity 0／clip-path 裁掉，
    //    「減少動態效果」時要靠 CSS 保險還原——漏掉就是空對話窗／空名單／沒有選單的手機
    // （.lp-pf 拿掉了：定價區那三張特點卡 2026-09-04 整組移除，見 index.vue 方案圖說註解）
    const sel = '.lp-reveal, .lp-cue, .lp-q, .lp-liveob, .lp-pane__hd, .lp-band__phone, '
      + '.lp-hero__text > *, .lp-ops, .lp-ops__group, .lp-stamp, '
      + '.lp-livewin--chat .conv-bubble-row, .lp-livewin--chat .conv-bubble-read, '
      + '.lp-livewin--users tbody tr, .lp-livewin--users .tag-chip, .lp-band__phone .lp-pmsg'
    for (const el of document.querySelectorAll(sel)) {
      const o = Number(getComputedStyle(el).opacity)
      if (o < 0.99) out.push(el.className.toString().slice(0, 60) + ' opacity=' + o)
    }
    if (Number.parseFloat(getComputedStyle(document.querySelector('.lp-chart__me')).strokeDashoffset) > 0.01) out.push('成長曲線沒畫')
    if (Number(getComputedStyle(document.querySelector('.lp-chart__lbls')).opacity) < 0.99) out.push('曲線標籤沒出現')
    const mt = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.lp-pmenu')).transform)
    if (Math.abs(mt.m42) > 1) out.push('圖文選單還滑在槽外面 translateY=' + Math.round(mt.m42))
    return out
  })
  const hasAnim = await page.evaluate(() => document.querySelector('.is-anim') !== null)
  hidden.length ? bad('這些被藏起來了：\n     ' + hidden.join('\n     ')) : ok('沒有任何區塊是藏起來的')
  ok(hasAnim ? '.is-anim 在場，CSS 保險有把東西還原' : '沒掛 .is-anim（JS 早退，符合設計）')
  // 證言牆要從跑馬燈攤成靜態網格：動畫關掉、重複的兩份卡組收掉、10 張卡全部攤在版面裡
  const voices = await page.evaluate(() => ({
    animName: getComputedStyle(document.querySelector('.lp-voices__track')).animationName,
    dupHidden: [...document.querySelectorAll('.lp-voices__set[aria-hidden]')]
      .every(el => getComputedStyle(el).display === 'none'),
    visible: [...document.querySelectorAll('.lp-voice')].filter(el => el.getClientRects().length).length,
  }))
  voices.animName === 'none' ? ok('證言牆跑馬燈已停') : bad(`證言牆還在飄：animation-name=${voices.animName}`)
  voices.dupHidden ? ok('重複的卡組已收掉') : bad('aria-hidden 的重複卡組還看得到')
  voices.visible === 10 ? ok('10 張證言卡全部攤開') : bad(`攤開的證言卡只有 ${voices.visible} 張（該是 10）`)
  await page.close()
}

// ── ④ 沒有 JS：SSR 出來的內容必須完整 ───────────────────────
{
  const page = await browser.newPage()
  await page.setJavaScriptEnabled(false)
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
  console.log('\n④ 沒有 JS')
  const hidden = await page.evaluate(() => [...document.querySelectorAll(
    '.lp-reveal, .lp-cue, .lp-livewin--chat .conv-bubble-row, .lp-livewin--users tbody tr, .lp-band__phone .lp-pmsg',
  )]
    .filter(el => Number(getComputedStyle(el).opacity) < 0.99)
    .map(el => el.className.toString().slice(0, 50)))
  hidden.length ? bad('沒 JS 卻藏著：\n     ' + hidden.join('\n     ')) : ok('全部看得到（.is-anim 沒掛上＝預設就是最終狀態）')
  await page.close()
}

await browser.close()
console.log(fails.length ? `\n不合格 ${fails.length} 項` : '\n全部通過')
process.exit(fails.length ? 1 : 0)
