/**
 * 匯入視窗新增的兩塊版面守門員（`C-134` / `C-135`）。
 *
 *   node scripts/kb-import-dedup-row-check.mjs
 *
 * 守的是什麼：
 *  ① 同名警告的每一列後面新增了「更新這一份」按鈕（`C-135`）。那一列的名字是**檔名**，
 *    MYFEEL 實際就有「AI NotePods 10S小耳記 耳機說明書_20260723.pdf」這種長度——
 *    按鈕被擠出容器右緣，等於這個修法的主要出口按不到，人只好回去改名字（＝製造重複）。
 *  ② 新增的「放進資料夾」欄位（`C-134`）與既有的「資料名稱」「所屬產品」同一排版，
 *    標籤與輸入框不可以換行錯位。
 *
 * 視窗寬度取自元件本身：`width="min(760px, 92vw)"`，內距 EP 預設左右各 16px。
 * 手機的 92vw 用 390px 螢幕換算（`landing-anim-check.mjs` 同一組尺寸）。
 *
 * ⛔ 兩個變體各自組 HTML，不要用字串 replace 造對照組（見 customer-card-chip-check.mjs
 *    的教訓：replace 沒對到會讓兩組長得一模一樣，卻以為量過了）。
 */
import { readFileSync } from 'node:fs'
import * as sass from 'sass'
import puppeteer from 'puppeteer'

const projectCss = sass.compile('app/assets/scss/main.scss', { loadPaths: ['app/assets/scss'], style: 'expanded' }).css
// 量到的必須是「真的編進 CSS 的規則」，不是我以為我寫了
for (const cls of ['kb-dedup-row', 'kb-dup-content']) {
  if (!projectCss.includes(cls)) throw new Error(`新 class ${cls} 沒編進 CSS，量到的不是真的`)
}
const epCss = readFileSync('node_modules/element-plus/dist/index.css', 'utf8')

/** MYFEEL 正式資料裡真的存在的名字（2026-09-04 唯讀盤查） */
const LONG_NAME = 'AI NotePods 10S小耳記 耳機說明書_20260723.pdf'
const SHORT_NAME = 'FAQ'
/**
 * 不含空白的長檔名——**這一組才是真正在守門的案例**。
 * 中文檔名自己會斷行，所以把 `.kb-dedup-row` 整條規則拿掉也量不出問題：
 * 這支腳本第一版就是那樣「全綠」的，等於沒量。底線串起來的檔名斷不了行，
 * 少了 `min-width: 0` 的 flex 子項會撐開整列 → 實測手機寬度溢出容器 59px。
 */
const LONG_UNBREAKABLE = 'AI_NotePods_10S_manual_20260723_final_v2_revised.pdf'

const button = label =>
  `<button class="el-button el-button--primary el-button--small is-plain"><span>${label}</span></button>`

const dedupBody = name => `
<div class="el-alert el-alert--warning is-light kb-dedup-warning">
  <div class="el-alert__content">
    <span class="el-alert__title">已存在 1 個同名資料</span>
    <div class="kb-dedup-body">
      <p class="text-xs">你是要更新原本那一份，還是另外建一份？</p>
      <ul class="kb-dedup-list">
        <li class="kb-dedup-row">
          <span>「${name}」（15 條，3 天前）</span>
          ${button('更新這一份')}
        </li>
      </ul>
      <p class="text-xs">或者在上方「資料名稱」改個名字，另外建一份新的資料（這個提醒就會消失）。</p>
    </div>
  </div>
</div>`

const folderRow = `
<div class="kb-meta-editor">
  <div class="kb-source-name-row">
    <span class="kb-source-name-label">資料名稱</span>
    <div class="el-input el-input--small kb-source-name-input"><div class="el-input__wrapper"><input class="el-input__inner" value="${LONG_NAME}"></div></div>
  </div>
  <div class="kb-source-name-row">
    <span class="kb-source-name-label">所屬產品</span>
    <div class="el-input el-input--small kb-source-name-input"><div class="el-input__wrapper"><input class="el-input__inner" value="Kieslect AI NotePods 10S"></div></div>
  </div>
  <div class="kb-source-name-row">
    <span class="kb-source-name-label">放進資料夾</span>
    <div class="el-select el-select--small kb-source-name-input"><div class="el-select__wrapper"><span class="el-select__selected-item">Kieselect 小耳記 AI NotePods 10S</span></div></div>
  </div>
  <p class="kb-section-hint">依名稱幫你選好了資料夾，不對可以直接改。</p>
</div>`

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 1000 })

/** 視窗內容區寬度：min(760, 92vw) 扣掉 EP dialog body 的左右內距 */
const widths = [
  { label: '桌機 760px 視窗', w: 760 - 32 },
  { label: '手機 390px 螢幕（92vw）', w: Math.round(390 * 0.92) - 32 },
]

async function measure(w, html) {
  await page.setContent(`<style>${epCss}\n${projectCss}
    #panel{width:${w}px;box-sizing:border-box}
    body{margin:0;font-family:system-ui,"Noto Sans TC",sans-serif;font-size:14px}
  </style><div id="panel">${html}</div>`)
  return page.evaluate(() => {
    const panel = document.getElementById('panel')
    const right = panel.getBoundingClientRect().right
    const overflow = [...panel.querySelectorAll('*')]
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.right > right + 0.5)
      .map(({ el, r }) => `${el.className || el.tagName}：超出 ${(r.right - right).toFixed(1)}px`)
    const btn = panel.querySelector('.kb-dedup-row .el-button')
    const rows = [...panel.querySelectorAll('.kb-source-name-row')].map((r) => {
      const label = r.querySelector('.kb-source-name-label').getBoundingClientRect()
      const input = r.querySelector('.el-input, .el-select').getBoundingClientRect()
      return { sameLine: Math.abs(label.top - input.top) < 12, labelText: r.textContent.trim().slice(0, 5) }
    })
    return {
      overflow,
      btn: btn ? { w: +btn.getBoundingClientRect().width.toFixed(1), inside: btn.getBoundingClientRect().right <= right + 0.5 } : null,
      rows,
      panelRight: right,
    }
  })
}

let failed = 0
for (const { label, w } of widths) {
  for (const [name, html] of [
    ['長檔名', dedupBody(LONG_NAME)],
    ['長檔名不含空白', dedupBody(LONG_UNBREAKABLE)],
    ['短名稱', dedupBody(SHORT_NAME)],
  ]) {
    const r = await measure(w, html)
    const ok = r.overflow.length === 0 && r.btn?.inside
    if (!ok) failed++
    console.log(`${ok ? '✅' : '❌'} ${label}｜同名列（${name}）：按鈕 ${r.btn?.w}px ${r.btn?.inside ? '在容器內' : '被擠出去'}${r.overflow.length ? `\n     ${r.overflow.join('\n     ')}` : ''}`)
  }
  const f = await measure(w, folderRow)
  const allSameLine = f.rows.every(x => x.sameLine)
  const ok = f.overflow.length === 0 && allSameLine && f.rows.length === 3
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${label}｜名稱／產品／資料夾三列：${f.rows.length} 列、標籤與欄位${allSameLine ? '同一行' : '有錯位'}${f.overflow.length ? `\n     ${f.overflow.join('\n     ')}` : ''}`)
}

await browser.close()
if (failed) {
  console.error(`\n${failed} 項不合格`)
  process.exit(1)
}
console.log('\n全部通過')
