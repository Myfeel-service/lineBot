#!/usr/bin/env node
/**
 * `C-448` 商品新功能教學圖：開 docs/onboarding-shots-src/product-help.html，每個 .frame 照 id 截一張到 public/onboarding/<id>.png。
 * 圖是畫的示意（不是後台截圖）——改字、改圖改那一頁，重跑這支就好。
 *
 *   node scripts/make-product-help-shots.mjs
 *
 * 兩倍解析度（彈窗裡 680px 寬，字才不糊）。字型用這台電腦的系統字（Mac＝蘋方）。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = resolve(ROOT, 'docs/onboarding-shots-src/product-help.html')
const OUT = resolve(ROOT, 'public/onboarding')

const browser = await puppeteer.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 760, height: 900, deviceScaleFactor: 2 })
  await page.goto(pathToFileURL(SRC).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const ids = await page.$$eval('.frame', els => els.map(e => e.id))
  for (const id of ids) {
    const el = await page.$(`#${id}`)
    await el.screenshot({ path: resolve(OUT, `${id}.png`) })
    console.log(`public/onboarding/${id}.png`)
  }
}
finally {
  await browser.close()
}
