/**
 * 客人卡的標籤 chip 版面守門員（`D-55`）。
 *
 *   node scripts/customer-card-chip-check.mjs
 *
 * 守的是什麼：`D-55` 在每顆標籤後面加了一截「最近 9/3・3 次」，而這張卡會出現在
 * **對話頁右側約 320px 的面板**裡，MYFEEL 又有「客服 - SHARP 頂級A咖｜iBarista 智慧咖啡機」
 * 這種長標籤名。實測（2026-09-03）：
 *   容器 320px｜加小字前 最寬 chip 294px ✅ → 加小字後 407px、**超出容器右緣 95px** ❌
 * 修法是在 `.cust-card__tags .tag-chip` 作用域內放行換行（不動共用的 `.tag-chip`），
 * 修完 320px 最寬 304px、不再超出。
 *
 * ⛔ 兩個變體各自組 HTML，不要用字串 replace 造對照組：第一版用 replace 而且沒對到，
 *   兩組都含小字、數字一模一樣，害我一度以為「加了不影響版面」。
 */
import * as sass from 'sass'
import puppeteer from 'puppeteer'

const css = sass.compile('app/assets/scss/main.scss', { loadPaths: ['app/assets/scss'], style: 'expanded' }).css
if (!css.includes('cust-card__tag-hit')) throw new Error('新 class 沒編進 CSS，量到的不是真的')

const TAGS = [
  { name: '在看收音麥克風', src: 'AI', hit: '最近 9/3・12 次' },
  { name: '客服 - SHARP 頂級A咖｜iBarista 智慧咖啡機', src: '系統', hit: '最近 2025/12/3・3 次' },
  { name: '問過出貨進度', src: 'AI', hit: '最近 9/3' },
  { name: '問卷 - 乾淨方MAX', src: '手動', hit: '' }, // 手動貼的沒有小字
]
const build = withHit => `<div id="panel"><div class="cust-card__tags">${TAGS.map(t => `
  <span class="tag-chip tag-chip--tinted" style="--tag-accent:#0EA5E9">${t.name}<small class="cust-card__tag-src">${t.src}</small>${withHit && t.hit ? `<small class="cust-card__tag-hit">${t.hit}</small>` : ''}<button type="button" class="tag-chip-remove">✕</button></span>`).join('')}</div></div>`

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 800, height: 900 })

async function measure(w, withHit) {
  await page.setContent(`<style>${css}
    #panel{width:${w}px;padding:8px;box-sizing:border-box}
    body{margin:0;font-family:system-ui,"Noto Sans TC",sans-serif;font-size:14px}
  </style>${build(withHit)}`)
  return page.evaluate(() => {
    const panel = document.getElementById('panel')
    const pr = panel.getBoundingClientRect()
    const chips = [...document.querySelectorAll('.tag-chip')]
    return {
      clientW: panel.clientWidth,
      scrollW: panel.scrollWidth,
      blockH: Math.round(document.querySelector('.cust-card__tags').getBoundingClientRect().height),
      widest: Math.max(...chips.map(c => Math.round(c.getBoundingClientRect().width))),
      overflow: Math.max(...chips.map(c => Math.round(c.getBoundingClientRect().right - pr.right))),
    }
  })
}

for (const w of [320, 420, 640]) {
  const a = await measure(w, false)
  const b = await measure(w, true)
  const bad = x => (x.scrollW > x.clientW + 1 || x.overflow > 0 ? '❌破版' : '✅')
  console.log(`容器 ${w}px｜原本 最寬${a.widest} 高${a.blockH} 超出${a.overflow} ${bad(a)}`
    + `｜加小字 最寬${b.widest} 高${b.blockH} 超出${b.overflow} ${bad(b)}`)
}
await browser.close()
