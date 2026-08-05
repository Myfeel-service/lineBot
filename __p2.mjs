import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new' })
const p = await b.newPage()
p.on('pageerror', e => console.log('PAGEERROR:', e.message))
await p.setViewport({ width: 1280, height: 860 })
const open = async () => {
  await p.goto('http://localhost:3124/admin/ws-probe/__panelcheck', { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 1400))
  await p.evaluate(() => {
    const el = [...document.querySelectorAll('.split-list-item, [class*="list-item"]')].find(e => e.textContent.includes('客人 A'))
    el.click()
  })
  await new Promise(r => setTimeout(r, 700))
}
const state = () => p.$eval('#probe-state', el => el.textContent.trim())

await open()

// ── P2-7 emoji 插在游標處 ────────────────────────────
await p.click('.conv-input-row textarea')
await p.keyboard.type('AAABBB')
await p.evaluate(() => {
  const ta = document.querySelector('.conv-input-row textarea')
  ta.setSelectionRange(3, 3)
})
// 開 emoji picker（第一顆有 img 的 trigger）並點第一個 emoji
await p.evaluate(() => document.querySelectorAll('.conv-picker-trigger')[1].click())
await new Promise(r => setTimeout(r, 500))
await p.evaluate(() => {
  const opt = document.querySelector('.conv-picker-option--emoji')
  opt.click()
})
await new Promise(r => setTimeout(r, 500))
console.log('P2-7 emoji 插入   ', await state())

// ── P2-8 貼圖先選再送 ────────────────────────────────
await p.keyboard.press('Escape')
await p.evaluate(() => document.body.click())
await new Promise(r => setTimeout(r, 400))
await p.evaluate(() => document.querySelectorAll('.conv-picker-trigger')[2].click())
await new Promise(r => setTimeout(r, 600))
const hasFooter = await p.evaluate(() => !!document.querySelector('.conv-picker-popover .conv-picker-footer'))
await p.evaluate(() => document.querySelector('.conv-picker-option--sticker').click())
await new Promise(r => setTimeout(r, 400))
const afterPick = await p.evaluate(() => ({
  activeCount: document.querySelectorAll('.conv-picker-option--sticker.active').length,
  btnDisabled: document.querySelector('.conv-picker-popover .conv-picker-footer button')?.disabled,
  note: document.querySelector('.conv-picker-popover .conv-picker-note')?.textContent?.trim(),
}))
console.log('P2-8 有 footer =', hasFooter, '| 點一張後:', JSON.stringify(afterPick))
console.log('     點選後（還沒按送出）', await state())
await p.evaluate(() => document.querySelector('.conv-picker-popover .conv-picker-footer button').click())
await new Promise(r => setTimeout(r, 900))
const popClosed = await p.evaluate(() => !document.querySelector('.conv-picker-popover .conv-picker-option--sticker'))
console.log('     按送出貼圖後', await state(), '| popover 收起 =', popClosed)

// ── P2-9 貼上圖片 ────────────────────────────────────
await p.evaluate(() => {
  const ta = document.querySelector('.conv-input-row textarea')
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+ZbmTAAAAAElFTkSuQmCC'), c => c.charCodeAt(0))
  const file = new File([png], 'shot.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
})
await new Promise(r => setTimeout(r, 900))
const dlg = await p.evaluate(() => {
  const t = document.querySelector('.el-dialog__title')
  return { open: !!t, title: t?.textContent?.trim() ?? '' }
})
console.log('P2-9 貼上圖片後對話框:', JSON.stringify(dlg))

// ── P2-10 草稿跨重整 ────────────────────────────────
await p.keyboard.press('Escape')
await new Promise(r => setTimeout(r, 500))
await p.evaluate(() => {
  const ta = document.querySelector('.conv-input-row textarea')
  ta.focus()
})
await p.click('.conv-input-row textarea')
await p.keyboard.type('重整前的草稿')
await new Promise(r => setTimeout(r, 900))  // 等節流存進 localStorage
const stored = await p.evaluate(() => localStorage.getItem('conv-drafts:ws-probe'))
console.log('P2-10 localStorage =', stored)
await open()   // 重新整理 + 重新選 A
console.log('P2-10 重整後       ', await state())
await b.close()
