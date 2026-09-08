#!/usr/bin/env node
/**
 * 驗程式裡寫死的外部連結還活著沒有。
 *
 * 為什麼要有這支：2026-09-08 老闆點了開通引導的「前往申請 LINE 官方帳號」，
 * 落在 **404**——`tw.linebiz.com/entry/` 已經失效（08-07 從日本入口改台灣時它還活著）。
 * 外部網址會自己腐爛，而我們沒有任何機制會發現，只能等使用者踩到。
 *
 * ⛔ 只驗**寫死在程式裡**的外部連結（`app/`、`server/`、`shared/`）：
 *    使用者輸入的網址、範例網址、文件裡的連結不在範圍內——
 *    文件連結壞掉不會讓人卡住，混進來只會讓這支變成沒人理的雜訊。
 * ⚠️ 非 2xx 一律當失敗並列出來，但**「連不上」與「404」要分開講**：
 *    前者可能只是網路或對方擋 CI，後者是真的沒了（照「三種『沒有』下一步完全不同」那條）。
 *
 * 用法：node scripts/check-external-links.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['app', 'server', 'shared']
const EXTS = ['.ts', '.vue', '.js', '.mjs']
/** 不驗這些：範例網址、佔位、我們自己的網域（環境變數決定，不是寫死的常數） */
const SKIP = [/example\./, /localhost/, /127\.0\.0\.1/, /\{\{/, /\$\{/, /lineminime\.com/, /myfeel-tw\.com/]

/**
 * ⛔ **只撈「會變成使用者可以點的連結」**，不是所有 https 字串。
 *
 * 第一版就是撈全部，結果 57 個裡有 11 個報 404 **全是誤報**——API 端點基底
 * （`api.line.me/v2`、`generativelanguage.googleapis.com/v1beta`）、OAuth scope
 * （`googleapis.com/auth/...` 根本不是網頁）、測試用假網址（`a.com`、`app.test`）。
 * 一支天天誤報的檢查最後一定沒人看，比沒有還糟，所以判準收成兩條：
 *   ① TS/JS 物件的 `href:` 欄位（教學卡、指引、設定頁的連結都走這個）
 *   ② 模板裡的 `<a href="https://...">`
 * 並跳過 `*.test.ts`（測試裡的網址是假資料，不是要給人點的）。
 */
const LINK_PATTERNS = [
  /\bhref:\s*'(https:\/\/[^']+)'/g,
  /\bhref:\s*"(https:\/\/[^"]+)"/g,
  /<a[^>]+href="(https:\/\/[^"]+)"/g,
]

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (EXTS.some(e => name.endsWith(e))) out.push(p)
  }
  return out
}

const found = new Map()   // url → [檔案:行]
for (const root of ROOTS) {
  let files = []
  try { files = walk(root) }
  catch { continue }
  for (const file of files) {
    if (file.includes('.test.')) continue      // 測試裡的網址是假資料
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const re of LINK_PATTERNS) {
        for (const m of line.matchAll(re)) {
          const url = m[1]
          if (SKIP.some(s => s.test(url))) continue
          if (!found.has(url)) found.set(url, [])
          found.get(url).push(`${file}:${i + 1}`)
        }
      }
    })
  }
}

if (!found.size) {
  console.log('沒有找到寫死的外部連結。')
  process.exit(0)
}

console.log(`要驗 ${found.size} 個外部連結：\n`)
const dead = []
const unreachable = []

for (const [url, where] of found) {
  let status = null
  let err = null
  try {
    // 先 HEAD（省流量）；有些站不吃 HEAD 就退 GET
    for (const method of ['HEAD', 'GET']) {
      const r = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (link-check; +MiniMe)' },
        signal: AbortSignal.timeout(15000),
      })
      status = r.status
      if (r.status !== 405 && r.status !== 403) break
    }
  }
  catch (e) {
    err = e?.message || String(e)
  }
  const ok = status !== null && status >= 200 && status < 400
  const mark = ok ? '✅' : (status === 404 ? '❌' : '⚠️ ')
  console.log(`${mark} ${status ?? '連不上'}  ${url}`)
  for (const w of where) console.log(`      ${w}`)
  if (!ok) {
    if (status === 404) dead.push({ url, where, status })
    else unreachable.push({ url, where, status, err })
  }
}

console.log()
if (dead.length) {
  console.log(`❌ ${dead.length} 個連結是 404（真的沒了，要換網址）：`)
  for (const d of dead) console.log(`   ${d.url}  ← ${d.where.join(', ')}`)
}
if (unreachable.length) {
  console.log(`⚠️  ${unreachable.length} 個問不到結果（可能是對方擋自動請求，不等於壞掉——手動開一次確認）：`)
  for (const u of unreachable) console.log(`   ${u.url}  ${u.status ?? u.err}`)
}
if (!dead.length && !unreachable.length) console.log('全部正常。')

// 只有 404 才讓它紅：問不到結果不是答案，不能拿來擋 CI（查不到 ≠ 沒有）
process.exit(dead.length ? 1 : 0)
