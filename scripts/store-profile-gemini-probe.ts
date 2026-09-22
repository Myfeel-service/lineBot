/**
 * 「AI 猜得準不準」的端到端實測（`D-85` / `C-220`＋`C-222`，2026-09-22）。
 *
 *   GEMINI_API_KEY=… node --env-file=.env_myfeel node_modules/.bin/vite-node \
 *     -c vitest.config.ts scripts/store-profile-gemini-probe.ts
 *   （金鑰在 `.env` 裡，`.env_myfeel` 沒有；兩個都要）
 *
 * **為什麼需要它**：`rankProfilePages`／`classifyFetchError`／prompt 組裝都有單元測試，
 * 但那些驗不到「模型看完一個真網站之後吐出什麼」。這支跑一次抓到兩個真缺陷：
 *   ① 募資頁上最大的數字被當成價格 → 抽出「NT$180–7,030,300」。
 *      「不要編造價格」那條規則擋不住它（數字真的在頁面上），改成點名哪幾種不算價格。
 *   ② PDF 網址被歸成「動態網站，請改貼商品頁」——下一步是錯的，改成獨立的 `not_html`。
 *
 * ⚠️ **會花錢**（兩次 Gemini 呼叫，約數分錢）、會**唯讀**連正式庫（myfeel）。
 * ⛔ **全程零寫入**：刻意不走 `/api/store-profile/infer` 這類會存檔的端點，
 *    只呼叫底層函式並把結果印出來——這支的用途是「看準不準」，不是「建資料」。
 * ⚠️ 兩次跑的結果不會一字不差：`temperature: 0` 只固定取樣，用字仍會微幅變動；
 *    而讀網站那條的輸入本身就會變（募資首頁的商品每天輪替）。看的是**準不準**，不是**一不一樣**。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// Nuxt 的兩個全域在純 node 環境沒有，補上最小替身
;(globalThis as any).useRuntimeConfig = () => ({ geminiApiKey: process.env.GEMINI_API_KEY ?? '' })
;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage ?? 'error'), o)

const {
  fetchOneProfilePage,
  rankProfilePages,
  extractProfileFromPages,
  MAX_PROFILE_PAGES,
} = await import('~~/server/utils/store-profile-extract')
const { collectInferSources, buildInferPrompt, describeInferSources, hasEnoughToInfer } = await import('~~/server/utils/store-profile-infer')
const { generateJson } = await import('~~/server/utils/gemini')
const { STORE_PROFILE_FIELDS } = await import('~~/shared/types/store-profile')

const WID = '212405d2-d782-443b-9670-adac3b3e1f99'
const SITE = 'https://www.myfeel-tw.com/'

function show(title: string, guesses: Record<string, string>) {
  console.log(`\n${title}`)
  for (const def of STORE_PROFILE_FIELDS) {
    const v = (guesses as any)[def.id]
    const mark = def.aiCanGuess ? (v ? '✓' : '·') : '—'
    console.log(`  ${mark} ${def.label.padEnd(12, '　')} ${v || (def.aiCanGuess ? '（沒猜到 / 來源沒提到）' : '（AI 不猜這一格）')}`)
  }
}

// ── A：讀真網站（C-220）────────────────────────────────
console.log('══ A. 讀 MYFEEL 官網（C-220）══')
console.log(`入口：${SITE}`)
const first = await fetchOneProfilePage(SITE)
if (!first.ok) {
  console.log(`❌ 首頁讀不到：${first.reason}`)
}
else {
  console.log(`✓ 首頁讀到 ${first.text.length} 字`)
  const ranked = rankProfilePages(first.text, first.finalUrl, MAX_PROFILE_PAGES - 1)
  console.log(`挑出 ${ranked.length} 個站內頁：`)
  for (const r of ranked) console.log(`   ${String(r.score).padStart(2)} 分  ${r.url}`)

  const pages = [{ url: SITE, text: first.text }]
  const failed: string[] = []
  for (const r of ranked) {
    const p = await fetchOneProfilePage(r.url)
    if (p.ok) pages.push({ url: r.url, text: p.text })
    else failed.push(`${r.url}（${p.reason}）`)
  }
  console.log(`\n共讀到 ${pages.length} 頁；讀不到 ${failed.length} 頁`)
  for (const f of failed) console.log(`   ✗ ${f}`)

  const t0 = Date.now()
  const out = await extractProfileFromPages(pages)
  console.log(`\nGemini：input ${out.inputTokens} tok / output ${out.outputTokens} tok / ${Date.now() - t0} ms`)
  show('抽出來的輪廓：', out.guesses as any)
}

// ── B：老店反推（C-222）────────────────────────────────
console.log('\n\n══ B. 從 MYFEEL 既有資料反推（C-222）══')
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID!,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
    privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  }),
})
const db = getFirestore()
const sources = await collectInferSources(WID, 'MYFEEL', db)
console.log(describeInferSources(sources))
console.log(`夠不夠猜：${hasEnoughToInfer(sources) ? '夠' : '不夠'}`)
console.log(`\n抽樣（知識卡標題前 8 筆）：`)
for (const t of sources.chunkTitles.slice(0, 8)) console.log(`   · ${t}`)
console.log(`標籤：${sources.tagNames.slice(0, 12).join('、')}`)
console.log(`活動：${sources.campaignNames.join('、') || '（沒有）'}`)

if (hasEnoughToInfer(sources)) {
  const t1 = Date.now()
  const res = await generateJson<Record<string, unknown>>(buildInferPrompt(sources), {
    temperature: 0, maxOutputTokens: 1200, thinkingBudget: 0,
  })
  console.log(`\nGemini：input ${res.inputTokens} tok / output ${res.outputTokens} tok / ${Date.now() - t1} ms`)
  show('反推出來的輪廓：', res.data as any)
}
