/**
 * 「AI 發現的新標籤」那一列的版面守門員（`C-178`）。
 *
 *   node scripts/tag-discovery-row-check.mjs
 *
 * 守的是什麼：`C-178` 在這一列多加了「改貼到「在看收音麥克風」」按鈕，
 * 撞到重複時這一排從**兩顆變四顆**，而那顆鈕的字本身就很長。
 *
 * ⛔ 這正是 `feedback_verify_new_code_actually_runs` 的第五種（破版看不見）：
 *    `.tags-discovery-row__actions` 原本是 `flex-shrink: 0`，光加 `flex-wrap: wrap`
 *    **換行永遠不會觸發**——不准縮的盒子會一路長到 max-content，直接把右邊撐出去，
 *    而外層卡片沒有水平捲軸，所以按鈕是「看不見」不是「擠在一起」。
 *
 * 判準：每個寬度下，這一列的內容都不可以超出卡片右緣。
 */
import * as sass from 'sass'
import puppeteer from 'puppeteer'

const css = sass.compile('app/assets/scss/main.scss', { loadPaths: ['app/assets/scss'], style: 'expanded' }).css
// ⛔ 先證明量到的是真的：class 沒編進 CSS 的話，下面量出來的「沒有溢出」毫無意義
for (const cls of ['tags-discovery-row__similar', 'tags-similar-hint', 'tags-dupcheck']) {
  if (!css.includes(cls)) throw new Error(`新 class ${cls} 沒編進 CSS，量到的不是真的`)
}

/** 撞到重複時的最壞情況：四顆鈕，而且併入目標的名字很長 */
const ROW = `
<div class="message-card tags-discovery-card"><div class="card-section-stack">
  <div class="tags-discovery-row">
    <div class="tags-discovery-row__main">
      <div class="tags-discovery-row__title">
        <span class="tags-discovery-row__name">在看無線麥克風</span>
        <span class="badge badge-gray">興趣偏好</span>
        <span class="tags-discovery-row__when">6 天前提議</span>
      </div>
      <p class="tags-discovery-row__count"><strong>8 位客人</strong>聊過，包括 Yaway雅維、暮憂 等</p>
      <p class="tags-discovery-row__reason">多位客人詢問無線麥克風的購買、功能、出貨等。</p>
      <p class="tags-discovery-row__criteria">AI 判斷條件：客人明確表示想購買或詢問無線麥克風產品。</p>
      <p class="tags-discovery-row__similar">⚠️ 跟你現有的「<strong>在看收音麥克風</strong>」是同一件事（兩顆都是在看麥克風的客人）</p>
    </div>
    <div class="tags-discovery-row__actions">
      <button class="el-button el-button--small"><span>建立並幫 8 位貼上</span></button>
      <button class="el-button el-button--small el-button--primary"><span>改貼到「在看收音麥克風」</span></button>
      <!-- 最壞情況：標籤名字有多長是使用者決定的（這個名字來自 MYFEEL 正式帳號） -->
      <button class="el-button el-button--small"><span>改貼到「客服 - SHARP 頂級A咖｜iBarista 智慧咖啡機」</span></button>
      <button class="el-button el-button--small"><span>忽略</span></button>
    </div>
  </div>
</div></div>`

/**
 * 「先前的建議與決定」那一列（`C-181` 之後多一顆「解除合併」）。
 * 同一個陷阱要量兩次：這一列本來也是 `flex-shrink: 0`，而它現在也會有兩顆鈕。
 */
const HISTORY_ROW = `
<div class="message-card tags-discovery-card"><div class="card-section-stack">
  <div class="tags-history"><div class="tags-history__body">
    <div class="tags-history-row">
      <div class="tags-history-row__main">
        <div class="tags-history-row__title">
          <span class="badge badge-blue">已併入</span>
          <span class="tags-history-row__name">在看無線麥克風</span>
          <span class="badge badge-gray">興趣偏好</span>
        </div>
        <p class="tags-history-row__meta">2 天前由 kevin.chiang@myfeel-tw.com 決定．提議時有 <strong>8 位客人</strong>聊過．實際幫 <strong>8 位</strong>貼上</p>
        <p class="tags-history-row__criteria">AI 判斷條件：客人明確表示想購買或詢問無線麥克風產品。</p>
      </div>
      <div class="tags-history-row__actions">
        <button class="el-button el-button--small"><span>看這批客人</span></button>
        <button class="el-button el-button--small"><span>解除合併</span></button>
      </div>
    </div>
  </div></div>
</div></div>`

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()

/** 後台內容區實測寬度：桌機、筆電、平板直、手機 */
const WIDTHS = [1100, 820, 600, 390]

async function measure(html, rowSel, actionsSel) {
  const out = []
  for (const w of WIDTHS) {
    await page.setViewport({ width: w, height: 900 })
    await page.setContent(`<style>${css}
      body{margin:0;font-family:system-ui,"Noto Sans TC",sans-serif;font-size:14px}
      /* el-button 的真樣式不在 main.scss 裡 → 給一個保守的近似值（真的按鈕只會更寬不會更窄） */
      .el-button{display:inline-flex;align-items:center;padding:5px 11px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;font-size:12px;white-space:nowrap}
    </style>${html}`)

    out.push(await page.evaluate(([rs, as]) => {
      const card = document.querySelector('.tags-discovery-card')
      const row = document.querySelector(rs)
      const actions = document.querySelector(as)
      return {
        cardRight: Math.round(card.getBoundingClientRect().right),
        actionsRight: Math.round(actions.getBoundingClientRect().right),
        actionsW: Math.round(actions.getBoundingClientRect().width),
        rowScrollW: row.scrollWidth,
        rowClientW: row.clientWidth,
        // 按鈕有沒有真的換行＝不只一個 top（⛔ 只量溢出不夠：`flex-wrap` 有沒有生效看這個）
        buttonRows: new Set([...actions.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top))).size,
      }
    }, [rowSel, actionsSel]))
  }
  return out
}

let bad = 0
function report(title, rows) {
  console.log(`\n── ${title} ──`)
  console.log('寬度   卡片右緣  按鈕右緣  按鈕區寬  橫向溢出  按鈕排數')
  WIDTHS.forEach((w, i) => {
    const r = rows[i]
    const overflow = Math.max(0, r.actionsRight - r.cardRight, r.rowScrollW - r.rowClientW)
    if (overflow > 1) bad++
    console.log(
      `${String(w).padEnd(6)} ${String(r.cardRight).padEnd(9)} ${String(r.actionsRight).padEnd(9)} `
      + `${String(r.actionsW).padEnd(9)} ${overflow > 1 ? `❌ ${overflow}px` : '✅ 0'}      ${r.buttonRows}`,
    )
  })
}

report('AI 發現的新標籤（撞到重複＝四顆鈕）', await measure(ROW, '.tags-discovery-row', '.tags-discovery-row__actions'))
report('先前的建議與決定（已併入＝兩顆鈕）', await measure(HISTORY_ROW, '.tags-history-row', '.tags-history-row__actions'))

await browser.close()
if (bad) {
  console.error(`\n❌ ${bad} 個寬度下按鈕被推出卡片外（而且沒有捲軸＝直接看不見）`)
  process.exit(1)
}
console.log('\n✅ 兩種列 × 四個寬度都沒有溢出')
