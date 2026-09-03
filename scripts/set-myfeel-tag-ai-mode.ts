/**
 * 一次性：把 MYFEEL 的 13 顆 AI 標籤重新分成「全自動」與「先建議」兩批（`D-54` 止血）。
 *
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/set-myfeel-tag-ai-mode.ts         # 預演
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/set-myfeel-tag-ai-mode.ts --apply # 真的改
 *
 * 為什麼要改：2026-09-03 下午 17:19–17:22，13 顆標籤被一次全部切成 `auto`（AI 判到直接貼、
 * 沒有人再看一眼）。但當天的稽核數字是——底帳 76 次建議裡，人真的判斷過的 26 次有 **15 次
 * 被忽略**；逐條讀 118 條建議＋64 位客人的對話，約三分之一站不住（實例與根因見 `C-131`）。
 * `D-26` 當初拍的路線就是「先開建議式收採用率，高了再自動，沒數據之前自動化是盲飛」。
 *
 * 分批的原則（⛔ 不是按採用率高低隨手挑，那樣沒人記得住）：
 * - **留全自動**＝判斷依據是「客人自己講出來的一個動作」，AI 不需要推論意圖。
 * - **回先建議**＝要 AI 推論「客人在看什麼／在等什麼」，也就是這次錯最多的那一類。
 *   等 `C-131`（逐字稿讀錯對話）修好、跑一兩週看採用率，再逐顆放行。
 *
 * ⛔ 冪等：已經是目標值的直接跳過（不寫、不動 updatedAt）。
 * ⛔ 只動 `aiMode` 一欄：判斷條件（`aiCriteria`）是人改過的東西，這支不碰。
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

const WORKSPACE_ID = '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

/** 客人自己講出來的動作，不需要推論 → 維持「AI 判到直接貼」 */
const KEEP_AUTO = [
  'asked_shipping_status', // 問過出貨進度
  'reported_defect', // 回報過商品故障
  'complained', // 抱怨過
]

/** 要 AI 推論意圖的（這次錯最多的一類）→ 退回「先建議、人按了才貼」 */
const BACK_TO_SUGGEST = [
  'waiting_launch', // 在等開賣
  'asked_invoice', // 問過發票
  'asked_price', // 問過價格優惠
  'return_in_progress', // 退換貨處理中
  'intent_microphone', // 在看收音麥克風
  'intent_ai_earbuds', // 在看 AI 錄音耳機
  'intent_cookware', // 在看料理鍋具
  'intent_coffee_machine', // 在看咖啡機
  'intent_massager', // 在看紓壓按摩
  'intent_aroma', // 在看香氛助眠
]

const snap = await db.collection('tags').where('workspaceId', '==', WORKSPACE_ID).get()
/**
 * 代號 → 標籤。**只收 active，而且撞號要抓出來**。
 *
 * ⛔ 第一版是無腦 `map.set(code, …)`：同一個代號有兩份文件（例如封存過一份）時，
 * 查詢順序最後那份會蓋掉前一份，於是腳本改到**錯的那份**，畫面照樣印「✓ 問過發票 → suggest」
 * 而線上那顆還是 auto。這跟檔頭那句「查不到＝沒問題」是同一種病的另一面：**找到兩個、用了一個**。
 */
const byCode = new Map<string, { id: string, name: string, aiMode?: string }>()
const dupCodes: string[] = []
for (const d of snap.docs) {
  const data = d.data()
  if (data.status !== 'active') continue
  const code = String(data.code)
  if (byCode.has(code)) { dupCodes.push(code); continue }
  byCode.set(code, { id: d.id, name: String(data.name), aiMode: data.aiMode })
}
if (dupCodes.length) {
  console.error(`🔴 這些代號有兩份以上的 active 標籤，分不出要改哪一顆：${[...new Set(dupCodes)].join('、')}`)
  console.error('   先去後台把重複的處理掉再跑——改錯一份會讓線上維持原狀，而這支會回報成功。')
  process.exit(1)
}

const plan: Array<{ code: string, name: string, id: string, from: string, to: string }> = []
const missing: string[] = []

for (const [codes, target] of [[KEEP_AUTO, 'auto'], [BACK_TO_SUGGEST, 'suggest']] as const) {
  for (const code of codes) {
    const tag = byCode.get(code)
    if (!tag) { missing.push(code); continue }
    const from = tag.aiMode ?? '(無＝關閉)'
    if (from === target) continue
    plan.push({ code, name: tag.name, id: tag.id, from, to: target })
  }
}

console.log(`專案 ${projectId}｜工作區 ${WORKSPACE_ID}｜模式：${apply ? '套用' : '預演（要真的改請加 --apply）'}`)
/**
 * ⛔ 找不到代號要當**錯誤**收，不能只 warn 一行。
 * 第一版把代號全猜錯，畫面印的是「沒有要改的：13 顆都已經是目標值」——跟「真的都對了」
 * 一模一樣，而實際上一顆都沒對到。這個 repo 的老毛病就是「查不到＝沒問題」（見 CLAUDE.md）。
 */
if (missing.length) {
  console.error(`🔴 找不到這 ${missing.length} 顆代號的標籤（code 被改過？）：${missing.join('、')}`)
  console.error('   代號對不上就不要繼續——照著跑會漏掉沒對到的那幾顆，而畫面看起來像全部做完。')
  process.exit(1)
}
if (!plan.length) {
  console.log(`沒有要改的：${KEEP_AUTO.length + BACK_TO_SUGGEST.length} 顆都已經是目標值（代號全部對得上）。`)
  process.exit(0)
}
for (const p of plan) console.log(`  ${p.name}（${p.code}）：${p.from} → ${p.to}`)
console.log(`共 ${plan.length} 顆要改。`)

if (!apply) process.exit(0)

for (const p of plan) {
  await db.collection('tags').doc(p.id).set({
    aiMode: p.to,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  console.log(`✓ ${p.name} → ${p.to}`)
}
console.log('完成。')
process.exit(0)
