/**
 * 客群分析報告的端到端實測（`D-28`＋`D-63`，2026-09-23）。
 *
 *   GEMINI_API_KEY=… node --env-file=.env_myfeel node_modules/.bin/vite-node \
 *     -c vitest.config.ts scripts/tag-report-gemini-probe.ts
 *   （金鑰在 `.env` 裡，`.env_myfeel` 沒有；兩個都要）
 *
 * **為什麼需要它**：聚合有 23 條測試、報告層有 24 條，但那些驗不到
 * **「模型看完真的事實表之後會吐出什麼」**——而這一輪最危險的失效方式正是
 * 「`rejectTagSummary` 太嚴，每次都退掉 → 白話總結永遠不出現」，
 * 那是一種沉默死亡：畫面上只會寫「這次沒通過檢查」，沒有人會發現它每次都這樣。
 * 所以要真的跑幾次，看**通過率**。
 *
 * ⚠️ **會花錢**（每輪一次 Gemini 呼叫）、會**唯讀**連正式庫（myfeel）。
 * ⛔ **全程零寫入**：刻意不走 `generateTagReport`（那支會存 `tagReports`），
 *    只呼叫 `computeTagInsights` ＋ 直接打模型 ＋ 過關卡，結果印出來。
 */
const {
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_CLIENT_EMAIL: clientEmail,
  FIREBASE_PRIVATE_KEY: privateKey,
  FIREBASE_STORAGE_BUCKET: storageBucket,
} = process.env
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）')
  process.exit(1)
}

// Nuxt 的兩個全域在純 node 環境沒有，補上最小替身。
// ⛔ **不要自己 initializeApp**：`getFirebaseAdmin()` 會做這件事，
//    兩邊都做的話 firebase-admin 會因為 default app 已存在而爆掉。
;(globalThis as any).useRuntimeConfig = () => ({
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  firebaseProjectId: projectId,
  firebaseClientEmail: clientEmail,
  firebasePrivateKey: privateKey,
  firebaseStorageBucket: storageBucket ?? '',
})
;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage ?? 'error'), o)

const { getDb } = await import('~~/server/utils/firebase')
const db = getDb()
const { computeTagInsights } = await import('~~/server/utils/tag-insights-compute')
const { generateText } = await import('~~/server/utils/gemini')
const {
  buildTagSummaryPrompt,
  buildTagSummaryFacts,
  isTooThinForSummary,
  rejectTagSummary,
  allowedSummaryNumbers,
} = await import('~~/shared/tag-report')

const WID = '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3)

console.log('══ 一、算數字（唯讀掃正式庫）══')
const t0 = Date.now()
const payload = await computeTagInsights(db, WID)
console.log(`掃完花了 ${Math.round((Date.now() - t0) / 100) / 10} 秒`)
console.log(`  掃到貼標 ${payload.integrity.scannedUserTags} 筆；截斷＝${payload.integrity.userTagsTruncated}`)
console.log(`  算不出來的塊：${payload.integrity.failed.length ? payload.integrity.failed.join('、') : '（沒有）'}`)
console.log(`  意圖 ${payload.eventVsIntent.intent.tags} 顆／${payload.eventVsIntent.intent.taggings} 筆`
  + `　事件 ${payload.eventVsIntent.event.tags} 顆／${payload.eventVsIntent.event.taggings} 筆`)
console.log(`  排行 ${payload.customerExpressed.length} 顆、交集 ${payload.intersections.length} 組`)
console.log(`  覆蓋率 ${payload.coverage.pct === null ? '（算不出來）' : `${payload.coverage.pct}%`}`)
console.log(`  待審 ${payload.pendingReview.users} 位；同意率 ${payload.suggestions.acceptanceRate ?? '（還沒有人決定過）'}`)
console.log(`  健康：零人 ${payload.health.zeroMember.length} 顆、AI 開著沒判出人 ${payload.health.aiOnButNeverProduced.length} 顆`)
console.log(`  標籤說明帶進 prompt 的有 ${payload.tagNotes.length} 顆`)

console.log('\n══ 二、事實表（餵給模型的全部內容）══')
console.log(buildTagSummaryFacts(payload))
console.log(`\n允許出現的數字共 ${allowedSummaryNumbers(payload).size} 個`)

if (isTooThinForSummary(payload)) {
  console.log('\n⚠️ 這個帳號的資料被判為「太薄」，照設計不生總結。探針到此為止。')
  process.exit(0)
}

console.log(`\n══ 三、真的打 Gemini ${ROUNDS} 輪，看關卡的通過率 ══`)
const prompt = buildTagSummaryPrompt(payload)
let ok = 0
for (let i = 1; i <= ROUNDS; i++) {
  try {
    const res = await generateText(prompt, { temperature: 0.2, maxOutputTokens: 900, thinkingBudget: 0 })
    const text = String(res.text ?? '').trim()
    const bad = rejectTagSummary(text, payload)
    console.log(`\n── 第 ${i} 輪（${text.length} 字，${bad ? `❌ 退掉：${bad}` : '✅ 通過'}）──`)
    console.log(text)
    if (!bad) ok++
  }
  catch (e) {
    console.log(`\n── 第 ${i} 輪：呼叫失敗 ${String(e).slice(0, 200)}`)
  }
}

console.log(`\n══ 結果：${ok}/${ROUNDS} 通過 ══`)
if (ok === 0) {
  console.log('⛔ 一輪都沒過＝這段總結在線上會永遠不出現（沉默死亡）。關卡或 prompt 要調。')
  process.exit(1)
}
if (ok < ROUNDS) {
  console.log('⚠️ 有輪被退掉。被退掉不是壞事（那正是關卡在工作），但退太多就等於大半時間沒有總結。')
}
