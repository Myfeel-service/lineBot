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
/* ⚠️ 2026-09-09 第七輪把 'lp-vs' 從這裡**拿掉**：對照舞台已經拆成三個各自越線的單位
   （左窗／右窗／對照表，走 50% 的 lp-cue--mid 線），開演時它們本來就大半在畫面裡——
   所以要吃回嚴格的「露出 ≥35%」那條規則。⛔ 別因為某段紅了又把它加回豁免名單：
   紅了代表「戲又開始在畫面外演」，那正是這一輪要修掉的病。 */
const STAGGERED = new Set(['lp-livewin.lp-livewin--chat', 'lp-livewin.lp-livewin--users'])
/* ⚠️ 2026-09-10 第十輪起**沒有任何豁免**：對照表改由兩扇窗演完接上、不再是 .lp-cue，
   所以根本不會被 part ① 掃到（它的節奏由 ②¾ 驗）；兩扇窗自己越線就演，吃嚴格的
   「開演時露出 ≥35%」那條。⛔ 別為了讓某段變綠又開豁免名單——紅了代表戲在畫面外演。 */

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
        .filter(x => x.startsWith('lp-') && !x.startsWith('lp-reveal') && !x.startsWith('lp-cue'))
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
  // 09-09 拍板：「位」要在大字行裡（原本數字獨行、「位」掉到下一行小字，讀不出「580 位」）
  //             ——所以這裡驗整串「580 位」不是只驗數字：位掉出去這條就會紅。
  heroEnd.tally === '580 位' ? ok('結算數字跑到「580 位」（位在大字行內）') : bad(`結算不是「580 位」：「${heroEnd.tally}」`)
  heroEnd.cta && !heroEnd.asleep && !heroEnd.boot
    ? ok('按鈕變回註冊 CTA、背景醒了、boot class 已拆')
    : bad(`收尾狀態不對：cta=${heroEnd.cta} asleep=${heroEnd.asleep} boot=${heroEnd.boot}`)
  // 演完之後底部的「往下看」箭頭要浮出（09-08 起沒有重播鍵，出口只有往下）
  const cue = await page.evaluate(() => {
    const el = document.querySelector('.lp-scrollcue')
    return el ? { op: Number(getComputedStyle(el).opacity), href: el.getAttribute('href') } : null
  })
  // 目的地跟著留客橋段在不在走（index.vue 的 SHOW_KEEP_SECTION）：在＝#keep、不在＝#why。
  // ⛔ 不可寫死其中一個：寫死 #keep 而那區被藏起來，驗收會綠、實際卻是個死錨點。
  const hasKeep = await page.$('#keep') !== null
  const cueWant = hasKeep ? '#keep' : '#why'
  cue && cue.op > 0.9 && cue.href === cueWant
    ? ok(`「往下看」箭頭浮出、指向 ${cueWant}${hasKeep ? '（留客橋段）' : '（留客橋段已隱藏，指回四關）'}`)
    : bad(`往下看箭頭不對（該指 ${cueWant}）：${JSON.stringify(cue)}`)
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

  // 0.5) 留客橋段（09-09 D-73④）：印章慢一拍蓋下去、名單加總＝第一卡結算的 580、
  //      印章不可蓋到人數（舊機會卡的紅線——@container 縮級表就是為它存在的，
  //      改印章字級／內距／膠囊 min-width 全靠這條抓）。
  // ⚠️ 這區 09-10 起用旗標藏著（SHOW_KEEP_SECTION）：不在就**明講跳過**——⛔不靜靜跳過，
  //    那會讓「動畫壞了」跟「動畫不在了」在輸出上長得一樣；也不算不合格（那是產品決定）。
  if (!hasKeep) {
    console.log('  ⏭️  留客橋段整區不在（index.vue 的 SHOW_KEEP_SECTION=false）→ 跳過 4 條：'
      + '印章起點／印章蓋下去／名單加總 580／印章不蓋人數')
  } else {
  await go('.lp-ops', -830)
  const stampBefore = await page.$eval('.lp-stamp', el => Number(getComputedStyle(el).opacity))
  await go('.lp-ops', -300)
  await wait(1800) // 0.9s 延遲 ＋ 0.4s 戲 ＋ 呼吸
  const keep = await page.evaluate(() => {
    const stamp = document.querySelector('.lp-stamp')
    const nums = [...document.querySelectorAll('.lp-op__tag--num')]
    const sum = nums.reduce((a, el) => a + Number.parseInt(el.textContent, 10), 0)
    const s = stamp.getBoundingClientRect()
    const overlapped = nums.some((el) => {
      const r = el.getBoundingClientRect()
      return Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top) > 2
        && Math.min(s.right, r.right) - Math.max(s.left, r.left) > 2
    })
    return { op: Number(getComputedStyle(stamp).opacity), sum, overlapped }
  })
  stampBefore < 0.1 ? ok('橋段印章 起點＝還沒蓋') : bad(`橋段印章 起點不是藏起來：opacity ${stampBefore}`)
  keep.op > 0.9 ? ok('橋段印章 演完＝蓋下去了') : bad(`橋段印章沒蓋下去：opacity ${keep.op}`)
  keep.sum === 580 ? ok('名單四份加總＝580（跟第一卡結算同一批人）') : bad(`名單加總不是 580：${keep.sum}`)
  keep.overlapped ? bad('印章蓋到人數了（紅線）') : ok('印章沒蓋到人數')
  }

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
  // ⛔ 按完一定要把滑鼠挪開：click 會把游標留在那個位置，之後捲到證言牆時游標可能正好
  //    落在跑馬燈上＝那一列 hover 暫停，下面「證言牆有在飄」會誤報壞掉（2026-09-09 踩過）。
  await page.mouse.move(0, 0)

  // 2.5) 「能做什麼」的捲動呈現（2026-09-09）：同一時間只有一塊是主角、而且主角＝佔畫面
  //      最多的那一塊、軌上亮的也是它。⚠️ 淡出有 .45s 過場，量之前一定要等（不等會量到
  //      半路的值，`filter` 會是 opacity(0.83) 這種中間值＝看起來「沒有一塊是亮的」）。
  const capState = async (sel) => {
    await go(sel, -100)
    await wait(700)
    return page.evaluate(() => {
      const panes = [...document.querySelectorAll('#value .lp-pane')]
      const rails = [...document.querySelectorAll('.lp-rail__item')]
      const vh = window.innerHeight
      // ⚠️ 09-09 淡出從 filter 換成蓋一層紙色的紗（`::after` 的 opacity）＝量法也要跟著換。
      //    紗越透明表示那塊越亮，所以「亮度」＝ 1 − 紗的 opacity。
      const val = el => 1 - Number(getComputedStyle(el, '::after').opacity || 0)
      const lit = panes.map(val)
      const seen = panes.map((el) => {
        const b = el.getBoundingClientRect()
        return Math.max(0, Math.min(b.bottom, vh) - Math.max(b.top, 0))
      })
      return {
        litCount: lit.filter(v => v > 0.95).length,
        主角: lit.indexOf(Math.max(...lit)),
        佔最多: seen.indexOf(Math.max(...seen)),
        軌: rails.findIndex(a => a.classList.contains('is-on')),
        暗的: lit.filter(v => v < 0.95).map(v => v.toFixed(2)).join('/'),
      }
    })
  }
  for (const [sel, name] of [['#cap-marketing', 'AI 行銷'], ['#cap-tagging', '自動貼標']]) {
    const s = await capState(sel)
    s.litCount === 1 && s.主角 === s.佔最多 && s.軌 === s.主角
      ? ok(`捲到「${name}」：只有它是亮的（其他三塊 ${s.暗的}）、軌也亮在它身上`)
      : bad(`捲到「${name}」主角判定不對：亮的有 ${s.litCount} 塊、主角#${s.主角 + 1}、佔最多#${s.佔最多 + 1}、軌#${s.軌 + 1}`)
  }

  // 2.6) 捲動視差（2026-09-09）：三層要**跟著捲動連續變化**，而且層與層的速度不一樣。
  //      ⚠️ 這是 `animation-timeline: view()`（原生捲動時間軸）做的，所以量法是
  //      「同一個元素在兩個捲動位置的 translate 不一樣」＝真的綁在捲動上，不是播一次就結束。
  //      ⛔ 不能只量「有沒有 translate」：fill-mode: both 會讓沒開始的動畫也留著 from 的值，
  //         那樣寫出來的斷言在動畫壞掉（例如時間軸沒生效）時照樣會綠。
  const driftAt = offset => page.evaluate(async (off) => {
    const el = document.querySelector('#cap-tagging')
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + off, behavior: 'instant' })
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))
    const y = (node) => {
      const t = getComputedStyle(node).translate
      if (!t || t === 'none') return 0
      return Math.round(Number.parseFloat(t.split(' ')[1] ?? '0'))
    }
    // 井本體（±12）＋裡面的系統畫面（單向 0→+8）；標頭與成效帶刻意沒有自己的幅度
    return { pane: y(el), win: y(el.querySelector('.lp-pane__win')) }
  }, offset)
  const supported = await page.evaluate(() => CSS.supports('animation-timeline', 'view()'))
  if (!supported) {
    console.log('  ⏭  跳過捲動視差：這個瀏覽器不支援 animation-timeline: view()（頁面設計成完全不動＝正常退化，不是壞了）')
  }
  else {
    // ⚠️ 取樣點要讓**三層都在自己的 view() 範圍內**：成效帶在塊的最底部，
    //    塊頂還在畫面下半的時候它根本還沒進範圍（量到的會是 from 的固定值）。
    //    -250／+250 是回推出來的：778px 的塊在 900px 畫面裡，這兩點三層都在範圍內。
    const a = await driftAt(-250)
    const b = await driftAt(250)
    // ⛔ 兩件事都要驗，缺一個斷言就會漏掉一種壞法：
    //    ①井跟著捲動在動＝時間軸真的接上了（沒接上的話 fill-mode 會留著固定值，看起來也「有位移」）
    //    ②畫面的位移量跟井**不一樣**＝有層差；一樣的話就只是整塊平移，沒有視差可言。
    const paneMoved = Math.abs(b.pane - a.pane)
    const winMoved = Math.abs(b.win - a.win)
    paneMoved >= 4
      ? ok(`捲動視差：井跟著捲動在動（${a.pane} → ${b.pane} px，兩個取樣點差 ${paneMoved}px）`)
      : bad(`捲動視差沒綁到捲動：井的位移只有 ${paneMoved}px（${JSON.stringify(a)} → ${JSON.stringify(b)}）`)
    paneMoved !== winMoved
      ? ok(`系統畫面跟井不同速＝有層差（井 ${paneMoved}px vs 畫面 ${winMoved}px）`)
      : bad(`系統畫面跟井同速（都 ${paneMoved}px）＝只是整塊平移，沒有視差`)

    // ⛔ **視差最容易出事的地方＝把東西推到疊在一起**，而且只有量才看得出來
    //    （2026-09-09 第一版三層視差實測到標頭↔畫面 −6px、成效帶↔圖說 −8px）。
    //    這裡整區掃一遍，記每一組相鄰元素的最小間距。門檻是「名目間距」回推的：
    //    標頭↔畫面名目 **0px**（設計上就貼齊）→ 只要不變負；畫面↔成效帶名目 14px → 留 4px；
    //    成效帶↔圖說名目 14px → 留 4px；井↔井名目 32px（手機 20px）→ 留 16px。
    const gaps = await page.evaluate(async () => {
      const sec = document.querySelector('#value')
      const top = sec.getBoundingClientRect().top + window.scrollY
      const H = sec.getBoundingClientRect().height
      const panes = [...document.querySelectorAll('#value .lp-pane')]
      const min = { pane: 1e9, hdWin: 1e9, winOut: 1e9, outCap: 1e9 }
      const gap = (a, z) => (a && z ? z.getBoundingClientRect().top - a.getBoundingClientRect().bottom : null)
      for (let y = top - window.innerHeight; y < top + H + 200; y += 60) {
        window.scrollTo({ top: y, behavior: 'instant' })
        await new Promise(r => requestAnimationFrame(r))
        for (let i = 0; i < panes.length - 1; i++) min.pane = Math.min(min.pane, gap(panes[i], panes[i + 1]))
        for (const p of panes) {
          const hd = p.querySelector('.lp-pane__hd')
          const win = p.querySelector('.lp-pane__win')
          const out = p.querySelector('.lp-outcome')
          const cap = p.querySelector('.lp-figcap')
          if (hd && win) min.hdWin = Math.min(min.hdWin, gap(hd, win))
          if (win && out) min.winOut = Math.min(min.winOut, gap(win, out))
          if (out && cap) min.outCap = Math.min(min.outCap, gap(out, cap))
        }
      }
      return Object.fromEntries(Object.entries(min).map(([k, v]) => [k, v > 1e8 ? null : Math.round(v)]))
    })
    const gapBad = []
    if (gaps.hdWin !== null && gaps.hdWin < 0) gapBad.push(`標頭↔畫面 ${gaps.hdWin}px（疊到了）`)
    if (gaps.winOut !== null && gaps.winOut < 4) gapBad.push(`畫面↔成效帶 ${gaps.winOut}px`)
    if (gaps.outCap !== null && gaps.outCap < 4) gapBad.push(`成效帶↔圖說 ${gaps.outCap}px`)
    if (gaps.pane !== null && gaps.pane < 16) gapBad.push(`井↔井 ${gaps.pane}px`)
    gapBad.length
      ? bad(`視差把東西推到太近：${gapBad.join('、')}——幅度要收，見 _landing.scss 視差那段`)
      : ok(`視差全程沒把東西推到疊在一起（最小間距：井↔井 ${gaps.pane}、標頭↔畫面 ${gaps.hdWin}、畫面↔成效帶 ${gaps.winOut}、成效帶↔圖說 ${gaps.outCap} px）`)
  }

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
  // 2026-09-09：進場位移從純垂直改成 `translate(-26px, 18px)`（往右上落定）之後，
  // ⛔ 只驗 opacity 不夠——位移卡住的話東西會**永遠停在左邊 26px**，而 opacity 已經是 1
  //    ＝看起來「有出現」但整排左緣對不齊，這種歪掉最難用眼睛抓。所以加驗「有沒有歸零」。
  const notSettled = await page.evaluate(() => [...document.querySelectorAll('.lp-reveal.in')]
    .map((el) => {
      const t = getComputedStyle(el).transform
      if (t === 'none') return null
      const m = new DOMMatrixReadOnly(t)
      return (Math.abs(m.m41) > 1 || Math.abs(m.m42) > 1)
        ? `${el.className.toString().slice(0, 40)} 停在 (${Math.round(m.m41)}, ${Math.round(m.m42)})`
        : null
    })
    .filter(Boolean))
  notSettled.length
    ? bad('進場位移沒歸零（會整排左緣對不齊）：\n     ' + notSettled.join('\n     '))
    : ok('進場位移全部歸零（沒有東西停在左邊或下面）')
  await page.close()
}

// ── ②½ 四關的對照舞台：同一晚、兩個結局——上面同步跑、跑完下面一起跑（2026-09-09 第八輪）──
// ⛔ 底案＝演完的完整對照，所以一定要用**新的分頁**在「還沒開演」時抓到藏起來的狀態——
//    part ① 已經把整頁捲過一輪，那個分頁裡戲早就演完了，量到的永遠是結局。
// ⚠️ 三個觸發單位（左窗／右窗／對照表，都走 50% 的 lp-cue--mid 線）：桌機兩窗並排＝同一刻
//    越線＝同一條時間軸（老闆：「不用分左右」）；表捲到才演、且不早於上面收完（2.1s）。
//    手機單欄＝左窗先、右窗捲到才演，所以有幾條檢查分桌機／手機兩種口徑（見 desk）。
{
  const desk = VW > 960
  const page = await browser.newPage()
  await page.setViewport({ width: VW, height: VH })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
  await wait(2000)
  console.log('\n②½ 四關的對照舞台')
  const op = sel => page.evaluate(s => Number(getComputedStyle(document.querySelector(s)).opacity), sel)
  /** 把某個單位的上緣停在畫面 50% 線再上 8px＝剛剛好越線開演（8px 是避開「上緣正好等於線」
      那個零重疊的邊界，IO 在那裡不會觸發） */
  const park = sel => page.evaluate((s) => {
    const el = document.querySelector(s)
    const top = el.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: Math.max(0, top - window.innerHeight * 0.5 + 8), behavior: 'instant' })
  }, sel)

  // 停在舞台整個還在畫面下方（連 50% 線都沒碰到）：這裡必須什麼都還沒演
  const before = await page.evaluate(async () => {
    const vs = document.querySelector('#why .lp-vs')
    const top = vs.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: Math.max(0, top - window.innerHeight + 40), behavior: 'instant' })
    await new Promise(r => setTimeout(r, 250))
    const o = s => Number(getComputedStyle(document.querySelector(s)).opacity)
    const units = [...document.querySelectorAll('#why .lp-cue--mid')]
    return {
      units: units.length,
      cued: units.some(el => el.classList.contains('is-cued')),
      m1: o('#why .vb-1'), m11: o('#why .vb-11'),
      x1: o('#why .lp-vs__pair:nth-child(1) .lp-vs__item > div'),
      stamp: o('#why .lp-vs__stamp'),
      relief: o('#why .lp-bubble__relief'),
    }
  })
  // 第十輪：越線的單位只剩**兩扇窗**（對照表改由上面演完接上，見 ②¾）
  before.units === 2
    ? ok('越線的單位是兩扇窗（對照表改由上面接上，不自己越線）')
    : bad(`舞台單位數不對：${before.units} 個 .lp-cue--mid（第十輪起應為 2＝左窗／右窗）`)
  !before.cued && before.m1 < 0.05 && before.m11 < 0.05 && before.x1 < 0.05 && before.stamp < 0.05 && before.relief < 0.05
    ? ok('開演前整場藏著（兩窗的訊息、✕、章、「還好」都還沒出現）')
    : bad(`開演前就穿幫：cued=${before.cued} 左第一句 ${before.m1} 右第一句 ${before.m11} ✕ ${before.x1} 章 ${before.stamp} 還好 ${before.relief}`)

  // 一張卡：兩扇窗與四行表要在同一個容器裡（老闆：「為什麼現在有四個區塊」）
  const card = await page.evaluate(() => {
    const vs = document.querySelector('#why .lp-vs')
    const cs = getComputedStyle(vs)
    const r = vs.getBoundingClientRect()
    const sx = document.querySelector('#why .lp-vs__side--x').getBoundingClientRect()
    const so = document.querySelector('#why .lp-vs__side--o').getBoundingClientRect()
    const g = document.querySelector('#why .lp-vs__grid').getBoundingClientRect()
    return { gap: cs.columnGap + '/' + cs.rowGap, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
      // 窗那半與表之間不可以有縫（零間距＝一張卡）。⚠️ 手機單欄時表接在**右窗**底下，所以拿兩窗較低的那個下緣
      seam: Math.round(g.top - Math.max(sx.bottom, so.bottom)),
      stampR: [...document.querySelectorAll('#why .lp-vs__stamp')].map(el => getComputedStyle(el).rotate),
      stampO: document.querySelector('#why .lp-vs__stamp--o').textContent.trim() }
  })
  card.gap === '0px/0px' && card.seam === 0 && Number.parseFloat(card.border) >= 1
    ? ok(`兩窗＋四行表是同一張卡（卡內零間距、窗與表之間 ${card.seam}px 縫、外框 ${card.border}）`)
    : bad(`不是一張卡：gap=${card.gap} 窗與表縫=${card.seam}px 外框=${card.border}`)
  card.stampR.length === 2 && card.stampR[0] === card.stampR[1] && card.stampO === '成交'
    ? ok(`兩顆章同一個角度（${card.stampR[0]}）、右邊寫「成交」`)
    : bad(`章不對：角度 ${card.stampR.join(' / ')}、右邊寫「${card.stampO}」`)

  // ── 第一段：兩扇窗。⛔ 停下來之後**不再捲動**＝驗「觸發後自己播完」（09-09 拍板「不要用滑鼠控制」）
  await park('#why .lp-vs__side--x')
  // ⚠️ 取樣一律用**絕對時間**（從 park 這一刻起算），⛔ 別再用一串相對 wait 累加：
  //    每次 evaluate 有 20~40ms 開銷，第十輪把拍點壓到 0.06~0.25 秒之後，累加誤差會吃掉整個餘裕。
  const t0 = Date.now()
  const until = async (ms) => { const left = t0 + ms - Date.now(); if (left > 0) await wait(left) }
  await until(120)
  // ⭐ 開演那一刻整扇窗要看得到（在畫面內、且在黏性行動條上方）——第七輪的病根，改壞這條會紅
  const geo = await page.evaluate(() => {
    const f = document.querySelector('#why .lp-scene--x .lp-scene__frame').getBoundingClientRect()
    const bar = document.querySelector('.lp-stickybar')
    const barTop = bar ? bar.getBoundingClientRect().top : window.innerHeight
    return { top: Math.round(f.top), bottom: Math.round(f.bottom), barTop: Math.round(barTop), vh: window.innerHeight,
      cuedO: document.querySelector('#why .lp-vs__side--o').classList.contains('is-cued') }
  })
  geo.top >= 0 && geo.bottom <= geo.barTop
    ? ok(`開演時整扇窗都看得到（窗 ${geo.top}~${geo.bottom}px、黏性行動條在 ${geo.barTop}px）`)
    : bad(`開演時窗沒有完整露出：窗 ${geo.top}~${geo.bottom}px、黏性條 ${geo.barTop}px、畫面高 ${geo.vh}px`)
  desk === geo.cuedO
    ? ok(desk ? '桌機兩窗並排＝同一刻越線（右窗也已開演）' : '手機右窗還沒越線（各自捲到才演）')
    : bad(`右窗觸發不對：桌機=${desk} 右窗已開演=${geo.cuedO}`)

  await until(420) // 兩邊的第一句（0.10＋0.24 動作＝0.34 收）都到了；「隔天」桌機 0.95／手機 0.55 還沒
  const t1 = await page.evaluate(() => {
    const o = s => Number(getComputedStyle(document.querySelector(s)).opacity)
    return { m1: o('#why .vb-1'), m11: o('#why .vb-11'), day: o('#why .vb-2') }
  })
  t1.m1 > 0.85 && (!desk || t1.m11 > 0.85) && t1.day < 0.05
    ? ok(desk ? '同一句話兩邊同時出現（0.42s）、「隔天」還沒' : '左窗第一句到了（0.42s）、「隔天」還沒')
    : bad(`開場不對（0.42s）：左第一句 ${t1.m1}、右第一句 ${t1.m11}、隔天 ${t1.day}`)

  // 桌機：右邊正在回（秒回 0.45 起）、左邊還空著（隔天 0.95）＝這一區的主張本體
  // 手機：右窗不在場，左窗自己的「隔天」（0.55＋0.24＝0.79 收）要到
  await until(desk ? 580 : 900)
  const t2 = await page.evaluate(() => {
    const o = s => Number(getComputedStyle(document.querySelector(s)).opacity)
    return { reply: o('#why .vb-13'), day: o('#why .vb-2') }
  })
  ;(desk ? (t2.reply > 0.2 && t2.day < 0.05) : (t2.day > 0.9))
    ? ok(desk ? '右邊在回、左邊還空著（0.58s：秒回正在出、「隔天」還沒）' : '左窗自己的節奏：「隔天」0.9s 已到（手機不用等右邊）')
    : bad(`中段不對（${desk ? '0.58' : '0.9'}s）：秒回 ${t2.reply}、隔天 ${t2.day}`)

  await until(1750) // 兩顆章 1.40s 同時蓋下、1.66 收（手機左章 1.10）
  const t3 = await page.evaluate(() => {
    const o = s => Number(getComputedStyle(document.querySelector(s)).opacity)
    return { x: o('#why .vb-4'), o: o('#why .vb-15'), m3: o('#why .vb-3') }
  })
  t3.m3 > 0.9 && t3.x > 0.9 && (!desk || t3.o > 0.9)
    ? ok(desk ? '兩顆章同時蓋下：沒了／成交（1.75s）' : '左窗演完：買別家＋紅章（1.75s）')
    : bad(`收尾不對（1.75s）：買別家 ${t3.m3}、紅章 ${t3.x}、成交章 ${t3.o}`)

  await until(2200) // 「還好——」1.6s 起、0.45s 過場＝2.05 收
  const relief = await op('#why .lp-bubble__relief')
  relief > 0.9
    ? ok('「還好，每一關都有解法——」在兩顆章落地之後浮出（2.2s）')
    : bad(`「還好——」沒有浮出：opacity ${relief}（應 >0.9）`)
  await page.close()
}
// ── ②¾ 對照表：上面演完**自動接上**，不必再往下捲（2026-09-10 第十輪）─────────────
// ⚠️ 要另開分頁：上一段在窗前停了 2.2 秒、表早就接上演完了，測不到「接」。
// ⚠️ 這一段刻意**park 右窗之後就不再捲動**：表在畫面外也要自己演完——那正是老闆要的
//    「上半部跑完就直接跑下半部」。⛔ 別改成「捲到表再驗」，那會把這條拍板測掉。
{
  const desk = VW > 960
  const page = await browser.newPage()
  await page.setViewport({ width: VW, height: VH })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
  await wait(2000)
  console.log('\n②¾ 上面演完直接接下面')
  const park = sel => page.evaluate((s) => {
    const el = document.querySelector(s)
    const top = el.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: Math.max(0, top - window.innerHeight * 0.5 + 8), behavior: 'instant' })
  }, sel)
  const rows = () => page.evaluate(() => {
    const o = el => Number(getComputedStyle(el).opacity)
    const x = [...document.querySelectorAll('#why .lp-vs__item > div')].map(o)
    const a = [...document.querySelectorAll('#why .lp-vs__ans > div')].map(o)
    // 等待期間格子本身要看得到（地色在）：藏的是格子裡的東西、不是格子（第九輪老闆的要求）
    const cell = document.querySelector('#why .lp-vs__item')
    const cellOn = o(cell) > 0.95 && getComputedStyle(cell).backgroundColor !== 'rgba(0, 0, 0, 0)'
    return { x, a, cellOn, cued: document.querySelector('#why .lp-vs__grid').classList.contains('is-cued') }
  })
  // 表不可以是 .lp-cue：它不等自己被捲到（第十輪拍板）
  const notCue = await page.evaluate(() => !document.querySelector('#why .lp-vs__grid').classList.contains('lp-cue'))
  notCue ? ok('對照表不是自己越線的單位（改由上面接上）') : bad('對照表還掛著 lp-cue＝變回「要捲到才演」，違反第十輪拍板')

  // park 右窗＝上半部開演（桌機兩窗同一刻；手機右窗自己這一刻）。之後**不再捲動**。
  await park('#why .lp-vs__side--o')
  const t0 = Date.now()
  const until = async (ms) => { const left = t0 + ms - Date.now(); if (left > 0) await wait(left) }
  await until(1300) // 上半部還在演（章 1.40 還沒蓋）：表要還沒動、但格子的底色要在
  const early = await rows()
  !early.cued && early.x.every(v => v < 0.05) && early.a.every(v => v < 0.05) && early.cellOn
    ? ok('上面還在演的時候表還沒動、但格子的底色在（1.3s）')
    : bad(`表提早動或等的時候底色不見：cued=${early.cued} 格子底色=${early.cellOn} ✕=${early.x.map(v => v.toFixed(2)).join('/')} ✓=${early.a.map(v => v.toFixed(2)).join('/')}`)

  await until(1850) // 上半部 1.66 收 → 表 1.70 接上；這裡是接上後 ~0.15s：第一行半亮、後面幾行還沒
  const mid = await rows()
  const paired = mid.x.every((v, i) => Math.abs(v - mid.a[i]) < 0.15)
  mid.cued && paired && mid.x[0] > 0.2 && mid.x[3] < 0.9
    ? ok('上面一演完表就自己接上（沒有再捲動），一行一行、同一行的 ✕✓ 同時：' + mid.x.map((v, i) => `${v.toFixed(2)}/${mid.a[i].toFixed(2)}`).join(' '))
    : bad(`表沒有自己接上或節奏不對（1.85s）：cued=${mid.cued} ✕/✓＝${mid.x.map((v, i) => `${v.toFixed(2)}/${mid.a[i].toFixed(2)}`).join(' ')}`)

  await until(2600) // 2.12 全收
  const fin = await page.evaluate(() => {
    const o = el => Number(getComputedStyle(el).opacity)
    return {
      all: [...document.querySelectorAll('#why .lp-scene__msg, #why .lp-scene__day, #why .lp-vs__item > *, #why .lp-vs__ans > *, #why .lp-vs__stamp')].every(el => o(el) > 0.95),
      relief: o(document.querySelector('#why .lp-bubble__relief')),
    }
  })
  fin.all && fin.relief > 0.9
    ? ok('整段 2.6 秒內演完定格（兩窗、✕✓、兩顆章、「還好——」都在）')
    : bad(`2.6 秒還沒演完：全到=${fin.all} 還好=${fin.relief}`)
  // 演完就定格：捲走再回來不重播、不倒退（is-cued 是一次性的 class）
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await wait(300)
  await park('#why .lp-vs__side--x')
  await wait(300)
  const again = await page.evaluate(() => {
    const o = s => Number(getComputedStyle(document.querySelector(s)).opacity)
    return { m1: o('#why .vb-1'), a4: o('#why .lp-vs__pair:nth-child(4) .lp-vs__ans > div') }
  })
  again.m1 > 0.95 && again.a4 > 0.95
    ? ok('捲走再回來：定格在演完的樣子（不重播、不倒退）')
    : bad(`捲走再回來卻倒退：第一句 ${again.m1}、第四個 ✓ ${again.a4}`)
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
  // 09-09 四關的對照舞台：減少動態＝直接是「演完的完整對照」（兩窗、✕✓、紅章、
  // 「還好——」全都在）。⛔ 這裡驗的是 CSS 保險——「藏」只准發生在 .is-anim 底下開演前，
  // 誰把藏的狀態搬進底案，勾了減少動態的人就會永遠停在「沒人來解」的畫面。
  const stage = await page.evaluate(() => ({
    all: [...document.querySelectorAll('#why .lp-scene__msg, #why .lp-scene__day, #why .lp-vs__item > *, #why .lp-vs__ans > *, #why .lp-vs__stamp, #why .lp-vs__side--o')]
      .every(el => Number(getComputedStyle(el).opacity) > 0.99),
    relief: Number(getComputedStyle(document.querySelector('#why .lp-bubble__relief')).opacity),
  }))
  ;(stage.all && stage.relief > 0.99)
    ? ok('四關直接是演完的完整對照（兩窗、✕✓、紅章、「還好」都在）')
    : bad(`四關在減少動態下不完整：全到=${stage.all}、還好 ${stage.relief}`)
  // 09-09 留客橋段：減少動態＝名單四列與印章直接是「蓋好」的完整狀態
  //（藏與戲都只在 .is-anim 底下，跟對照舞台同一條房規）
  // ⚠️ 09-10 起這區用旗標藏著：不在就明講跳過（理由同 ② 那段）
  const keepReduced = await page.evaluate(() => {
    const sec = document.querySelector('#keep')
    if (!sec) return null
    return { rows: sec.querySelectorAll('.lp-op').length, stamp: Number(getComputedStyle(sec.querySelector('.lp-stamp')).opacity) }
  })
  if (!keepReduced) console.log('  ⏭️  留客橋段整區不在 → 跳過 1 條：減少動態下名單與印章是否完整')
  else if (keepReduced.rows === 4 && keepReduced.stamp > 0.99) ok('留客橋段完整（名單 4 列、印章蓋好）')
  else bad(`留客橋段不完整：列 ${keepReduced.rows}、印章 opacity ${keepReduced.stamp}`)
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
    + '.lp-chip, .lp-h1t, .lp-hero__sub, .lp-tally, .lp-hero .lp-rev > div, .lp-scrollcue, .lp-bubble__relief',
  )]
    .filter(el => Number(getComputedStyle(el).opacity) < 0.99)
    .map(el => el.className.toString().slice(0, 50)))
  hidden.length ? bad('沒 JS 卻藏著：\n     ' + hidden.join('\n     ')) : ok('全部看得到（.is-anim 沒掛上＝預設就是最終狀態）')
  // 09-09 四關的對照舞台綁在 .is-anim 底下：沒 JS＝沒有 .is-anim＝直接是演完的完整對照
  const stageNoJs = await page.evaluate(() => ({
    all: [...document.querySelectorAll('#why .lp-scene__msg, #why .lp-vs__item > *, #why .lp-vs__ans > *, #why .lp-vs__stamp, #why .lp-vs__side--o')]
      .every(el => Number(getComputedStyle(el).opacity) > 0.99),
  }))
  stageNoJs.all
    ? ok('四關沒 JS 也直接是演完的完整對照（兩窗、✕✓、紅章都在）')
    : bad(`四關沒 JS 卻不完整：全到=${stageNoJs.all}`)
  // 09-09 留客橋段：沒 JS＝沒有 .is-anim＝印章直接是蓋好的（09-10 起可能整區藏著＝明講跳過）
  const keepNoJs = await page.evaluate(() => {
    const el = document.querySelector('#keep .lp-stamp')
    return el ? Number(getComputedStyle(el).opacity) : null
  })
  if (keepNoJs === null) console.log('  ⏭️  留客橋段整區不在 → 跳過 1 條：沒 JS 下印章是否蓋好')
  else if (keepNoJs > 0.99) ok('留客橋段沒 JS 也是蓋好的印章')
  else bad(`留客橋段沒 JS 卻藏著印章：opacity ${keepNoJs}`)
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

// ── ⑤ 手機的「你在哪」吸頂分頁列（2026-09-09）─────────────────────
// 手機沒有左軌（≤960px 整條 display:none），這條列是唯一的定位線索——所以它要
// ①真的顯示 ②吸在導覽列下面 ③四格都放得下不被切字 ④亮的那格跟主角一致。
// ⛔ 這一關固定用手機寬度自己開一頁：上面②③④都是 1440，量不到它。
{
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844 })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
  await wait(2200)
  console.log('\n⑤ 手機分頁列（390 寬）')
  const railHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.lp-rails__rail')).display === 'none')
  railHidden ? ok('左軌在手機上收掉了（所以下面這條列是唯一的定位線索）') : bad('手機上左軌沒收掉')
  for (const [sel, name, idx] of [['#cap-marketing', 'AI 行銷', 1], ['#cap-richmenu', '圖文選單', 3]]) {
    await page.evaluate((s) => {
      const el = document.querySelector(s)
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: 'instant' })
    }, sel)
    await wait(800)
    const st = await page.evaluate(() => {
      const nav = document.querySelector('.lp-caps')
      const items = [...nav.querySelectorAll('.lp-caps__i')]
      return {
        shown: getComputedStyle(nav).display !== 'none',
        top: Math.round(nav.getBoundingClientRect().top),
        on: items.findIndex(a => a.classList.contains('is-on')),
        cut: items.filter(a => a.scrollWidth > a.clientWidth + 1).map(a => a.textContent.trim()),
        w: items.map(a => Math.round(a.getBoundingClientRect().width)).join('/'),
      }
    })
    st.shown && Math.abs(st.top - 68) <= 1 && st.on === idx && !st.cut.length
      ? ok(`捲到「${name}」：分頁列吸在 ${st.top}px、亮第 ${st.on + 1} 格、四格 ${st.w} 都沒被切字`)
      : bad(`分頁列不對（${name}）：顯示=${st.shown} 吸頂=${st.top}px 亮第 ${st.on + 1} 格（該是 ${idx + 1}）被切字=${st.cut.join('、') || '無'}`)
  }
  await page.close()
}

await browser.close()
console.log(fails.length ? `\n不合格 ${fails.length} 項` : '\n全部通過')
process.exit(fails.length ? 1 : 0)
