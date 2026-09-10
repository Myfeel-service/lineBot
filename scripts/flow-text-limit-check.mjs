/**
 * 「文字＋按鈕超過 160 字」的版面守門員（`H-27`）。
 *
 *   node scripts/flow-text-limit-check.mjs
 *
 * 守的是什麼：`H-27` 在兩個地方加了新的紅色區塊——
 *   ①「機器人模組」編輯器：超出上限時輸入框下方的警告（`.flow-text-overflow`）
 *   ② 右側即時預覽：按鈕範本卡下方「以下 N 字送不出去」的刪除線區（`.fmp-card-cut`）
 * 兩個都塞在**窄容器**裡（預覽面板固定 372px，扣掉內距與卡片 max-width 88% 只剩約 300px），
 * 而被丟掉的內容是一整段行銷文案，很容易把卡片撐爆或整段溢出看不見。
 *
 * ⛔ 為什麼要量盒模型不是看截圖：`overflow: clip` 之類的設定會讓溢出「連捲軸都不出現」，
 *   畫面看起來好好的，實際上右邊那截永遠讀不到（踩過，見記憶 `feedback_verify_new_code_actually_runs`）。
 *
 * 綠＝新樣式有編進 CSS、被丟掉的字看得到、且沒有任何一塊超出容器右緣。
 */
import * as sass from 'sass'
import puppeteer from 'puppeteer'

const css = sass.compile('app/assets/scss/main.scss', { loadPaths: ['app/assets/scss'], style: 'expanded' }).css

// 先確認量到的是真的（新 class 沒編進 CSS 的話，下面量出來的「沒溢出」毫無意義）
for (const cls of ['fmp-card-cut', 'fmp-card-cut-text', 'flow-text-overflow']) {
  if (!css.includes(cls)) throw new Error(`新 class .${cls} 沒編進 CSS，量到的不是真的`)
}

/** 正式資料那則（鼴究室「飛利浦AC0510｜預熱」，276 字、掛一顆按鈕） */
const KEPT = `感謝大家的熱情敲碗與等待 🩵
飛利浦個人空氣清淨機（AC0510）
將於明晚 9 點在嘖嘖正式上市啦 🎊

提前公布問卷專屬 VIP 的折扣碼 ⚠️
AC200（大小寫都可以）
AC200（大小寫都可以）
AC200（大小寫都可以）
輸入「AC200」即可再折 $200 元

這台是飛利浦史上最小的空氣清淨機
體積`
const DROPPED = `很小，但規格一點也不簡單！

■ 最適合桌面使用的清淨範圍
■ 迷你體積，放在桌上不佔位
■ 三層 NanoProtect HEPA 奈米級濾淨
■ 搭載活性碳濾網除去異味
■ 最低僅 12dB 的專注模式
■ 長效濾網，3 年一換`

const previewHtml = `
<div class="fmp">
  <div class="fmp-frame">
    <div class="fmp-body">
      <div class="fmp-row">
        <div class="fmp-card">
          <p class="fmp-card-text">${KEPT}</p>
          <div class="fmp-card-cut">
            <span class="fmp-card-cut-label">↓ 以下 ${DROPPED.length} 字送不出去（有按鈕時 LINE 只收 160 字）</span>
            <p class="fmp-card-cut-text">${DROPPED}</p>
          </div>
          <div class="fmp-btns"><span class="fmp-btn">點我搶先看更多</span></div>
        </div>
      </div>
    </div>
  </div>
</div>`

const editorHtml = `
<div id="editor">
  <div class="admin-field-group">
    <div class="flow-textarea-wrapper flow-textarea-wrapper--var-inset">
      <div class="el-textarea"><textarea class="el-textarea__inner" rows="3">${KEPT}${DROPPED}</textarea></div>
    </div>
    <p class="flow-text-overflow">超過 116 字，這些字客人收不到。文字底下掛了按鈕時 LINE 只收 160 字——請刪到 160 字以內，或把按鈕移除改用純文字（可到 5000 字）。</p>
  </div>
</div>`

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 1400 })

const results = []
const check = (name, ok, detail) => results.push({ name, ok, detail })

// ── ① 預覽：被丟掉的那段要「看得見」且不溢出 ──────────────────
await page.setContent(`<style>${css}
  body{margin:0;font-family:system-ui,"Noto Sans TC",sans-serif;font-size:14px}
</style>${previewHtml}`)

const preview = await page.evaluate(() => {
  const q = s => document.querySelector(s)
  const box = el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: r.right } }
  const card = q('.fmp-card')
  const cut = q('.fmp-card-cut')
  const cutText = q('.fmp-card-cut-text')
  const panel = q('.fmp')
  const cs = getComputedStyle(cutText)
  return {
    panel: box(panel),
    card: box(card),
    cut: box(cut),
    cutText: box(cutText),
    cardScrollW: card.scrollWidth,
    cardClientW: card.clientWidth,
    cutVisible: cut.offsetHeight > 0 && getComputedStyle(cut).display !== 'none',
    lineThrough: cs.textDecorationLine,
    keptColor: getComputedStyle(q('.fmp-card-text')).color,
    cutColor: cs.color,
  }
})

check('預覽：被丟掉的那段真的畫出來了（不是被藏起來）', preview.cutVisible && preview.cutText.h > 0,
  `高度 ${preview.cutText.h.toFixed(0)}px`)
check('預覽：被丟掉的那段有刪除線，跟送得出去的部分看得出差別',
  preview.lineThrough.includes('line-through') && preview.cutColor !== preview.keptColor,
  `${preview.lineThrough} / 送出=${preview.keptColor} 丟掉=${preview.cutColor}`)
check('預覽：卡片沒有橫向溢出（scrollWidth 不大於 clientWidth）',
  preview.cardScrollW <= preview.cardClientW + 1,
  `scroll ${preview.cardScrollW} vs client ${preview.cardClientW}`)
check('預覽：整張卡沒有超出面板右緣',
  preview.card.right <= preview.panel.right + 1,
  `卡右緣 ${preview.card.right.toFixed(0)} vs 面板右緣 ${preview.panel.right.toFixed(0)}`)
check('預覽：被丟掉的區塊沒有超出卡片右緣',
  preview.cut.right <= preview.card.right + 1,
  `區塊右緣 ${preview.cut.right.toFixed(0)} vs 卡右緣 ${preview.card.right.toFixed(0)}`)

// ── ② 編輯器警告：窄欄位下也要完整讀得到 ────────────────────
for (const width of [640, 420, 320]) {
  await page.setContent(`<style>${css}
    body{margin:0;font-family:system-ui,"Noto Sans TC",sans-serif;font-size:14px}
    #editor{width:${width}px;box-sizing:border-box;padding:8px}
  </style>${editorHtml}`)
  const warn = await page.evaluate(() => {
    const el = document.querySelector('.flow-text-overflow')
    const host = document.getElementById('editor')
    const r = el.getBoundingClientRect()
    const hr = host.getBoundingClientRect()
    return {
      h: r.height, right: r.right, hostRight: hr.right,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      color: getComputedStyle(el).color,
    }
  })
  check(`編輯器警告 @${width}px：讀得到且沒溢出`,
    warn.h > 0 && warn.right <= warn.hostRight + 1 && warn.scrollW <= warn.clientW + 1,
    `高 ${warn.h.toFixed(0)}px、右緣 ${warn.right.toFixed(0)}/${warn.hostRight.toFixed(0)}、scroll ${warn.scrollW}/${warn.clientW}`)
}

await browser.close()

let red = 0
for (const r of results) {
  if (!r.ok) red++
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}　${r.detail}`)
}
console.log(`\n${results.length - red} 綠 / ${red} 紅`)
process.exit(red ? 1 : 0)
