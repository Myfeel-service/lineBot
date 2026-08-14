/**
 * 產生社群分享預覽圖 public/og-cover.png（1200×630）。
 *
 * 什麼時候要跑：改了品牌 logo、或想換分享圖上的標語之後。
 *   npm run build:og
 *
 * 為什麼要有這張圖：
 *   貼連結到 LINE／Facebook 時，沒有 og:image 就只出現一行純文字，點擊率差很多。
 *   LINE 是本產品的主要通路，這張圖等於是連結的門面。
 *
 * ⛔ 圖上刻意不寫價格：方案調價時沒人會記得回來重跑這支，寫了就是等著過期。
 *    要價格的話請改在 og:description（那個是從 plans.ts 動態組的，不會過期）。
 *
 * 用 headless Chrome 而不是 rsvg-convert（build:icons 那支用的）：
 *   這張圖有中文標題與漸層，rsvg 的字型後援在不同機器上會排出不一樣的結果。
 *   ⚠️ 仍然依賴系統有 PingFang TC，所以請在 macOS 上跑；換機器重跑前先比對輸出。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'public')
const require = createRequire(join(ROOT, 'package.json'))
const puppeteer = require('puppeteer')

const W = 1200
const H = 630

// logotype 直接讀檔內嵌，換 logo 重跑就會跟著更新（同 build:icons 的作法，不手抄路徑資料）
const logo = readFileSync(join(PUBLIC, 'logotype.svg'), 'utf8')
  .replace(/^[\s\S]*?<\?xml[^>]*\?>/, '')
  .trim()

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden; position: relative;
    background: linear-gradient(160deg, #f2fbf6 0%, #ffffff 58%);
    font-family: 'Inter', 'PingFang TC', 'Noto Sans TC', system-ui, sans-serif;
    color: #1f2023;
  }
  .blob { position: absolute; border-radius: 50%; filter: blur(70px); }
  .b1 { width: 520px; height: 520px; background: rgba(6,199,85,.16); top: -190px; right: -110px; }
  .b2 { width: 360px; height: 360px; background: rgba(6,199,85,.10); bottom: -170px; left: -120px; }
  .in { position: relative; height: 100%; padding: 76px 88px; display: flex; flex-direction: column; }
  .logo svg { height: 46px; width: auto; display: block; }
  h1 {
    margin-top: auto; font-size: 92px; font-weight: 800;
    letter-spacing: -.035em; line-height: 1.18;
  }
  h1 .g { color: #05b24c; }
  p { margin-top: 26px; font-size: 31px; color: #43464b; letter-spacing: -.01em; }
  .chips { margin-top: 40px; display: flex; gap: 12px; }
  .chip {
    font-size: 22px; font-weight: 700; color: #067a3a;
    background: #eafaf1; border: 1px solid rgba(6,199,85,.24);
    border-radius: 999px; padding: 10px 22px;
  }
</style>
<span class="blob b1"></span><span class="blob b2"></span>
<div class="in">
  <div class="logo">${logo}</div>
  <h1>你的顧客，<br>其實很<span class="g">值錢</span></h1>
  <p>LINE 上的 AI 客服與客戶經營</p>
  <div class="chips">
    <span class="chip">AI 客服 24 小時</span>
    <span class="chip">名單自動分眾</span>
    <span class="chip">免綁約</span>
  </div>
</div>`

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'networkidle0' })
  const buf = await page.screenshot({ type: 'png' })
  writeFileSync(join(PUBLIC, 'og-cover.png'), buf)
  console.log(`✓ public/og-cover.png (${W}×${H}, ${(buf.length / 1024).toFixed(0)} KB)`)
}
finally {
  await browser.close()
}
