/**
 * 待審抽屜「一列」的版面守門員（`D-61` code review）。
 *
 *   node scripts/tag-review-row-check.mjs
 *
 * 守的是什麼：
 *  ① 勾選框跟名字**沒有對齊**——`.tag-review__row` 只設了 `gap: 0.6rem`，
 *    但 Element Plus 的 `.el-checkbox` 預設帶 `margin-right: 30px`，這個 partial 沒覆寫，
 *    於是每一列多出約 40px 死空間，而且 32px 高的框跟 0.9rem 的名字對不齊。
 *  ② 底部動作列的底色——`--bg-base` 是灰的（#f3f4f6），抽屜本體是白的，
 *    於是白抽屜下方橫一條灰帶。註解說它要「黏在底部」，但沒有 sticky。
 *
 * ⛔ 這支不連正式資料庫（原本那支 `tag-review-drawer-check.mjs` 要真登入）：
 *    純版面用假 DOM 就量得到，量得到才守得住。
 */
import { readFileSync } from 'node:fs'
import * as sass from 'sass'
import puppeteer from 'puppeteer'

const projectCss = sass.compile('app/assets/scss/main.scss', { loadPaths: ['app/assets/scss'], style: 'expanded' }).css
if (!projectCss.includes('tag-review__row')) throw new Error('抽屜樣式沒編進 CSS，量到的不是真的')
const epCss = readFileSync('node_modules/element-plus/dist/index.css', 'utf8')

const row = (name, when, why) => `
<li class="tag-review__row">
  <label class="el-checkbox"><span class="el-checkbox__input"><span class="el-checkbox__inner"></span></span></label>
  <div class="tag-review__body">
    <div class="tag-review__who">
      <span class="tag-review__name">${name}</span>
      <span class="tag-review__when">${when}</span>
    </div>
    <p class="tag-review__why">${why}</p>
  </div>
</li>`

const html = `
<div class="tag-review">
  <ul class="tag-review__list">
    ${row('王小明', '2026/9/1 下午07:30', '客人問了出貨進度')}
    ${row('（沒有名字的好友）', '時間不明', '客人提到想送禮')}
  </ul>
  <div class="tag-review__actions">
    <button class="el-button el-button--primary"><span>採用選取的 2 位</span></button>
    <button class="el-button"><span>忽略選取的 2 位</span></button>
    <button class="el-button is-text tag-review__close"><span>關閉</span></button>
  </div>
</div>`

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 800, height: 900 })

let failed = 0
const fail = (m) => { failed++; console.log(`❌ ${m}`) }
const ok = (m) => console.log(`✅ ${m}`)

// 抽屜寬度 min(620px, 96vw)；量桌機與手機兩種
for (const [label, w] of [['桌機 620px', 620], ['手機 390px（96vw）', Math.round(390 * 0.96)]]) {
  await page.setContent(`<style>${epCss}\n${projectCss}
    #wrap{width:${w}px;box-sizing:border-box;background:var(--el-bg-color,#fff);padding:20px}
    body{margin:0;font-family:system-ui,"Noto Sans TC",sans-serif;font-size:14px}
  </style><div id="wrap">${html}</div>`)

  const m = await page.evaluate(() => {
    const r = document.querySelector('.tag-review__row')
    const cb = r.querySelector('.el-checkbox')
    const name = r.querySelector('.tag-review__name')
    const body = r.querySelector('.tag-review__body')
    const actions = document.querySelector('.tag-review__actions')
    const cbR = cb.getBoundingClientRect(); const bodyR = body.getBoundingClientRect(); const nameR = name.getBoundingClientRect()
    const cs = getComputedStyle(cb)
    return {
      marginRight: cs.marginRight,
      // 勾選框右緣到內容左緣的實際距離（該只剩 row 的 gap）
      gapPx: +(bodyR.left - cbR.right).toFixed(1),
      // 勾選框與名字的垂直中線差
      centerDiff: +Math.abs((cbR.top + cbR.height / 2) - (nameR.top + nameR.height / 2)).toFixed(1),
      actionsBg: getComputedStyle(actions).backgroundColor,
      wrapBg: getComputedStyle(document.getElementById('wrap')).backgroundColor,
      overflow: [...document.querySelectorAll('#wrap *')]
        .filter(el => el.getBoundingClientRect().right > document.getElementById('wrap').getBoundingClientRect().right + 0.5)
        .map(el => `${el.className || el.tagName}（超出 ${(el.getBoundingClientRect().right - document.getElementById('wrap').getBoundingClientRect().right).toFixed(1)}px）`),
    }
  })

  console.log(`\n── ${label}`)
  console.log(`   勾選框 margin-right=${m.marginRight}｜到內容的距離 ${m.gapPx}px｜與名字中線差 ${m.centerDiff}px`)
  console.log(`   動作列底色 ${m.actionsBg}｜抽屜底色 ${m.wrapBg}`)

  // row 的 gap 是 0.6rem = 9.6px；容 2px 誤差
  if (m.gapPx > 12) fail(`勾選框跟內容之間有 ${m.gapPx}px（該只有 9.6px）＝繼承了元件庫的 margin-right`)
  else ok('勾選框與內容的間距正確')

  if (m.centerDiff > 3) fail(`勾選框與名字的中線差 ${m.centerDiff}px＝沒對齊`)
  else ok('勾選框與名字對齊')

  if (m.actionsBg !== m.wrapBg && m.actionsBg !== 'rgba(0, 0, 0, 0)') fail(`動作列底色 ${m.actionsBg} 跟抽屜底色 ${m.wrapBg} 不同＝白抽屜上多一條色帶`)
  else ok('動作列沒有多餘的底色')

  if (m.overflow.length) fail(`超出抽屜右緣：${m.overflow.join('、')}`)
  else ok('沒有橫向溢出')
}

await browser.close()
if (failed) { console.log(`\n${failed} 項不合格`); process.exit(1) }
console.log('\n全部通過')
