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

  // 0) Hero 喚醒示範（09-08 滿版劇場）：載入自動演一次 → 驗最終狀態；再按重播驗它真的會動。
  //    時間軸＝mount + 2.6s 自動按下、再 3.2s 收尾；networkidle0 + 上面 1500ms 之後再等 7 秒必定演完。
  await wait(7000)
  const heroEnd = await page.evaluate(() => ({
    chips: document.querySelectorAll('.lp-chip').length,
    lit: document.querySelectorAll('.lp-chip.is-lit').length,
    tally: document.querySelector('.lp-tally b')?.textContent ?? '',
    cta: !!document.querySelector('.lp-wakewrap a'),
    asleep: document.querySelector('.lp-hero')?.classList.contains('is-asleep') ?? true,
    boot: document.documentElement.classList.contains('lp-wake-boot'),
  }))
  heroEnd.chips > 0 && heroEnd.lit === heroEnd.chips
    ? ok(`Hero 演完＝${heroEnd.lit}/${heroEnd.chips} 顆客人全醒`)
    : bad(`Hero 沒演完：醒了 ${heroEnd.lit}/${heroEnd.chips} 顆`)
  heroEnd.tally === '580' ? ok('結算數字跑到 580') : bad(`結算不是 580：「${heroEnd.tally}」`)
  heroEnd.cta && !heroEnd.asleep && !heroEnd.boot
    ? ok('按鈕變回註冊 CTA、背景醒了、boot class 已拆')
    : bad(`收尾狀態不對：cta=${heroEnd.cta} asleep=${heroEnd.asleep} boot=${heroEnd.boot}`)
  // 演完之後底部的「往下看」箭頭要浮出（09-08 起沒有重播鍵，出口只有往下）
  const cue = await page.evaluate(() => {
    const el = document.querySelector('.lp-scrollcue')
    return el ? { op: Number(getComputedStyle(el).opacity), href: el.getAttribute('href') } : null
  })
  cue && cue.op > 0.9 && cue.href === '#why'
    ? ok('「往下看」箭頭浮出、指向 #why')
    : bad(`往下看箭頭不對：${JSON.stringify(cue)}`)
  // 大標打字（09-08）：演完後 11 顆字全亮、副標看得見
  const typing = await page.evaluate(() => ({
    chars: document.querySelectorAll('.lp-h1t').length,
    on: document.querySelectorAll('.lp-h1t.is-on').length,
    // ⚠️ 副標住在 .lp-rev 裡（09-08）：淡入掛在那一格的內層 div 上，
    //    量 .lp-hero__sub 自己永遠是 1＝斷言會永遠綠。要量它的父格。
    subOp: Number(getComputedStyle(document.querySelector('.lp-hero__sub').closest('.lp-rev > div')).opacity),
  }))
  typing.chars > 0 && typing.on === typing.chars && typing.subOp > 0.9
    ? ok(`大標打完＝${typing.on}/${typing.chars} 字全亮、副標已進場`)
    : bad(`大標打字沒收尾：${typing.on}/${typing.chars} 字、副標 opacity=${typing.subOp}`)

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
  // 2026-09-08 起輸入列最左邊那顆是「選單／鍵盤」切換鈕：兩顆圖示疊在一起用 opacity 互換，
  // 所以「現在顯示哪一顆」＝量 computed opacity（class 不會變，跟上面數泡泡同一個道理）。
  const swIcon = () => page.evaluate(() => {
    const o = s => Number(getComputedStyle(document.querySelector(s)).opacity)
    const grid = o('.lp-pbar__ico--grid')
    const kbd = o('.lp-pbar__ico--kbd')
    return grid > 0.9 && kbd < 0.1 ? 'grid' : (kbd > 0.9 && grid < 0.1 ? 'kbd' : `混在一起(格 ${grid.toFixed(2)}／鍵 ${kbd.toFixed(2)})`)
  })
  await go('.lp-band__phone', -830)
  const menuBefore = await menuY()
  const iconBefore = await swIcon()
  await go('.lp-band__phone', -300)
  await wait(2200)
  const menuAfter = await menuY()
  const iconAfter = await swIcon()
  const msgAfter = await litCount('.lp-band__phone .lp-pmsg')
  menuBefore > 40 ? ok(`圖文選單 起點＝收在槽外面 (translateY ${menuBefore}px)`) : bad(`圖文選單 起點不是收起來：translateY ${menuBefore}px`)
  menuAfter === 0
    ? ok(`圖文選單 滑到定位 (translateY 0)、歡迎訊息 ${msgAfter} 則`)
    : bad(`圖文選單 沒滑到定位：translateY ${menuBefore} → ${menuAfter}px`)
  // 三拍因果的前兩拍：選單還沒開時圖示必須是**田字格**、開了之後必須切成**鍵盤**。
  // ⛔ 這兩條分開判：只判終點的話「圖示從頭到尾都是鍵盤」也會過，那就等於沒演因果。
  iconBefore === 'grid' ? ok('切換鈕 起點＝田字格（選單還沒展開）') : bad(`切換鈕 起點不是田字格：${iconBefore}`)
  iconAfter === 'kbd' ? ok('切換鈕 演完＝鍵盤（選單展開中）') : bad(`切換鈕 演完不是鍵盤：${iconAfter}`)

  // 3) 那顆切換鈕**真的能按**（不是只有進場動畫）：按一下收起、再按一下展開，圖示跟著換。
  // ⚠️ 按完要等：收起／展開是 .78s 的過場，量太早會抓到半路的值。
  await page.click('.lp-pbar__sw')
  await wait(1100)
  const menuClosed = await menuY()
  const iconClosed = await swIcon()
  await page.click('.lp-pbar__sw')
  await wait(1100)
  const menuReopened = await menuY()
  const iconReopened = await swIcon()
  menuClosed > 40 && iconClosed === 'grid'
    ? ok(`切換鈕 按一下＝選單收起 (translateY ${menuClosed}px)、圖示回田字格`)
    : bad(`切換鈕 按了沒收起：translateY ${menuClosed}px、圖示 ${iconClosed}`)
  menuReopened === 0 && iconReopened === 'kbd'
    ? ok('切換鈕 再按一下＝選單展開、圖示回鍵盤')
    : bad(`切換鈕 按不回來：translateY ${menuReopened}px、圖示 ${iconReopened}`)

  // 3) 一條路的左軸綠線（二十三輪起線＝.lp-path__rail 自己，::after 是綠色那層；
  //    querySelector 拿到的是第一截——步驟 1 到步驟 2 那段）
  // ⚠️ 2026-09-08 兩欄化（流程在左、示意在右）之後**live 卡與第一截綠線在同一條水平線上**
  //    （右欄的卡頂量到只比左欄第 1 顆磚低 2.8px），所以「把綠線捲到看得見、能開演」的
  //    任何位置都會同時把卡片也觸發掉。⛔ 別再調 -600 那個數字想閃避——單欄時代它們相差
  //    ~210px 所以閃得掉，現在相差 ~0px，閃不掉。
  //    改成：**兩個「起點」都在同一個還沒捲下去的位置一起量**，之後再各自量終點。
  // ⚠️ 2026-09-08 起 #fast 整區可能是**藏起來的**（index.vue 的 `SHOW_FAST_SECTION`，
  //    使用者「這塊先隱藏好了」）＝這兩段的元素根本不存在。
  // ⛔ 偵測到就**明講跳過了什麼**，不可以靜靜跳過：靜靜跳過的話「這兩個動畫壞了」跟
  //    「這兩個動畫不在了」在輸出上長得一模一樣，而這兩件事下一步完全不同。
  // ⛔ 也不可以把它算成不合格：那會讓整支驗收在一個「刻意的產品決定」上永遠是紅的。
  const hasFast = await page.$('.lp-path__rail')
  if (!hasFast) {
    console.log('  ⏭  跳過「左軸綠線」與「開通引導 live 卡」兩段：#fast 整區目前是隱藏的'
      + '（index.vue 的 SHOW_FAST_SECTION = false），元素不存在＝沒有東西可驗，不是壞了。'
      + '要驗這兩段就把那個旗標打開再跑一次。')
  }
  else {
    await go('.lp-path__rail', -830)
    const lineBefore = await val('.lp-path__rail', 'transform', '::after')
    const barBefore = await val('.lp-liveob .onbc-step.is-current', 'transform', '::before')
    const beatsBefore = await page.$$eval('.lp-liveob .agm-msg', e => e.length)
    await go('.lp-path__rail', -600)
    await wait(1400)
    const lineAfter = await val('.lp-path__rail', 'transform', '::after')
    collapsed(lineBefore) ? ok(`左軸綠線 起點＝收起 (${lineBefore})`) : bad(`左軸綠線 起點不是收起：${lineBefore}`)
    grown(lineAfter) ? ok(`左軸綠線 終點＝長完 (${lineAfter})`) : bad(`左軸綠線 沒長完：${lineAfter}`)

    // 4) 開通引導 live 卡：進度條長出來＋demo 真的往下演（起點在上面就量掉了，見那段 ⚠️）
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
  }

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
    // ⚠️ 09-08 起 Hero＝滿版喚醒劇場：減少動態時 head 腳本不掛 lp-wake-boot、示範不啟動，
    //    大標／chip／結算／收尾句／小字（.lp-rev 的內容）從第一幀就要全部看得到。
    const sel = '.lp-reveal, .lp-cue, .lp-q, .lp-liveob, .lp-pane__hd, .lp-band__phone, '
      + '.lp-hero__text > *, .lp-h1t, .lp-hero__sub, .lp-chip, .lp-tally, .lp-hero__fine, .lp-hero .lp-rev > div, .lp-scrollcue, '
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
  // ⚠️ 一定要等：Hero 的進場是**純 CSS**（不等 .is-anim，見 _landing.scss 那段），
  //    .lp-hero__text 的子元素帶 lpHeroIn（0.16s 延遲＋0.6s、fill-mode backwards）＝
  //    動畫還沒跑完時 opacity 本來就是 0。在 domcontentloaded 立刻量會跟動畫賽跑，
  //    量到 `.lp-hero__sub opacity=0` 就誤報「沒 JS 卻藏著」（2026-09-08 偶發紅，
  //    逐次探測三輪確認 1.2s 後一律回到 1）。⛔ 別把這個 wait 拿掉。
  await wait(1400)
  console.log('\n④ 沒有 JS')
  const hidden = await page.evaluate(() => [...document.querySelectorAll(
    '.lp-reveal, .lp-cue, .lp-livewin--chat .conv-bubble-row, .lp-livewin--users tbody tr, .lp-band__phone .lp-pmsg, '
    + '.lp-chip, .lp-h1t, .lp-hero__sub, .lp-tally, .lp-hero .lp-rev > div, .lp-scrollcue',
  )]
    .filter(el => Number(getComputedStyle(el).opacity) < 0.99)
    .map(el => el.className.toString().slice(0, 50)))
  hidden.length ? bad('沒 JS 卻藏著：\n     ' + hidden.join('\n     ')) : ok('全部看得到（.is-anim 沒掛上＝預設就是最終狀態）')
  // 09-08：選單的收起／展開改成吃 SSR 就要印對的 class（`is-menu-up`）。沒 JS 時如果那個
  // class 沒印出來，看到的是**一支沒有選單的手機**——這塊在賣的就是選單，等於整塊失去意義。
  // ⛔ 只量 opacity 抓不到這件事（選單是被位移出去的，opacity 還是 1），所以這裡量 transform。
  const noJs = await page.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.lp-pmenu')).transform)
    return {
      y: Math.round(m.m42),
      open: document.querySelector('.lp-phone')?.classList.contains('is-menu-up') ?? false,
      kbd: Number(getComputedStyle(document.querySelector('.lp-pbar__ico--kbd')).opacity),
    }
  })
  noJs.y === 0 && noJs.open && noJs.kbd > 0.9
    ? ok('沒 JS 也看得到展開的圖文選單（SSR 就印了 is-menu-up、圖示是鍵盤）')
    : bad(`沒 JS 的選單狀態不對：translateY ${noJs.y}px、is-menu-up=${noJs.open}、鍵盤圖示 opacity=${noJs.kbd}`)
  await page.close()
}

await browser.close()
console.log(fails.length ? `\n不合格 ${fails.length} 項` : '\n全部通過')
process.exit(fails.length ? 1 : 0)
