/**
 * 一次性：把 `C-75` 拍板的 13 顆標籤建進 MYFEEL。
 *
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/seed-myfeel-tags.ts        # 預演（只列出要做什麼）
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/seed-myfeel-tags.ts --apply # 真的建立
 *
 * 內容來源：2026-08-25 從 MYFEEL 兩週、102 位客人的真實對話歸納（報告見 artifact
 * 「MYFEEL 標籤建議」）。**不是猜的，每顆背後都有人數**。
 *
 * - 通用的 7 顆直接讀 `shared/tag-templates.ts`（全租戶共用的那份，同一個事實來源）。
 * - 品類的 6 顆只寫在這支腳本裡：⛔ 它們是 MYFEEL 專屬的（麥克風、咖啡機…），
 *   寫進共用範本等於把這家店的商品塞給所有商家看（feedback_saas_no_tenant_hardcoding）。
 *
 * ⛔ 冪等：同 code 已存在就跳過不覆蓋——重跑不會製造重複標籤，也不會蓋掉人改過的條件。
 * ⛔ 一律建成 aiMode='suggest'（AI 先建議、人按了才貼），不直接開自動貼。
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { v4 as uuidv4 } from 'uuid'
// ⛔ 要帶 .ts 副檔名：這支是用 `node --experimental-strip-types` 直接跑的，
//    走的是 Node 的 ESM 解析（不是 Nuxt 的別名），省略副檔名會 ERR_MODULE_NOT_FOUND。
import { TAG_TEMPLATES, type TagTemplate } from '../shared/tag-templates.ts'

const APPLY = process.argv.includes('--apply')
const WORKSPACE_ID = '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

/**
 * MYFEEL 專屬的品類意向標籤（人數＝2026-08-25 實測）。
 * ⚠️ 募資選品的商品會換，這批的壽命比行為型短，下一輪盤點要重看還在不在。
 */
const MYFEEL_CATEGORY_TAGS: Array<TagTemplate & { evidence: string }> = [
  {
    code: 'intent_microphone',
    name: '在看收音麥克風',
    category: 'interest',
    color: '#0EA5E9',
    criteria: '客人詢問、比較收音或降噪麥克風，包括接頭相容性、收音距離、顏色款式、配對方式。已購買後只問出貨進度的不算。',
    usage: '目前最大的一群意向客。麥克風類新品與周邊配件的推播名單。',
    evidence: '18 位',
  },
  {
    code: 'intent_cookware',
    name: '在看料理鍋具',
    category: 'interest',
    color: '#F59E0B',
    criteria: '客人詢問電子鍋、電鍋或料理鍋具的功能、烹煮模式、食譜、材質。只問出貨或退貨的不算。',
    usage: '鍋具類新品與食譜內容的推播名單。',
    evidence: '6 位',
  },
  {
    code: 'intent_ai_earbuds',
    name: '在看 AI 錄音耳機',
    category: 'interest',
    color: '#8B5CF6',
    criteria: '客人詢問錄音耳機、逐字稿、AI 轉文字、翻譯功能或配戴方式（入耳／耳夾）。',
    usage: '錄音耳機類產品的意向客。',
    evidence: '5 位',
  },
  {
    code: 'intent_coffee_machine',
    name: '在看咖啡機',
    category: 'interest',
    color: '#92400E',
    criteria: '客人詢問咖啡機的沖煮方式、操作、機型差異或耗材。已購買後回報故障的不算（那是售後）。',
    usage: '咖啡機與周邊耗材的推播名單。',
    evidence: '5 位',
  },
  {
    code: 'intent_massager',
    name: '在看紓壓按摩',
    category: 'interest',
    color: '#DB2777',
    criteria: '客人詢問按摩器、紓壓儀器的使用方式、耗材貼片、效果或適用部位。',
    usage: '按摩紓壓類產品與耗材回購的名單。',
    evidence: '5 位',
  },
  {
    code: 'intent_aroma',
    name: '在看香氛助眠',
    category: 'interest',
    color: '#14B8A6',
    criteria: '客人詢問香氛機、精油、助眠產品的使用方式、成分、可用時長或安全性（例如小孩能不能用）。',
    usage: '香氛機與精油耗材的推播名單。⚠️ 剛好卡在 4 位門檻，可觀察一輪再決定要不要留。',
    evidence: '4 位',
  },
]

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

const all = [
  ...TAG_TEMPLATES.map(t => ({ ...t, evidence: '', group: '行為型（全租戶通用範本）' })),
  ...MYFEEL_CATEGORY_TAGS.map(t => ({ ...t, group: '品類型（MYFEEL 專屬）' })),
]

// 先讀一次現有 code，冪等靠它（一次查詢，不是一顆一查）
const existing = await db.collection('tags').where('workspaceId', '==', WORKSPACE_ID).get()
const existingCodes = new Set(existing.docs.map(d => String(d.data()?.code ?? '')))

console.log(`專案 ${projectId}　工作區 MYFEEL　現有標籤 ${existing.size} 顆`)
console.log(APPLY ? '模式：真的建立\n' : '模式：預演（加 --apply 才會真的寫入）\n')

let created = 0
let skipped = 0
let lastGroup = ''
for (const t of all) {
  if (t.group !== lastGroup) { console.log(`── ${t.group}`); lastGroup = t.group }
  if (existingCodes.has(t.code)) {
    console.log(`   ⏭  ${t.name}（code ${t.code} 已存在，跳過不覆蓋）`)
    skipped++
    continue
  }
  if (APPLY) {
    const now = FieldValue.serverTimestamp()
    await db.collection('tags').doc(uuidv4()).set({
      workspaceId: WORKSPACE_ID,
      code: t.code,
      name: t.name,
      category: t.category,
      color: t.color,
      description: t.usage,
      aiMode: 'suggest', // ⛔ 一律先建議，不直接開自動貼
      aiCriteria: t.criteria,
      status: 'active',
      createdBy: 'script:seed-myfeel-tags',
      createdAt: now,
      updatedAt: now,
    })
  }
  console.log(`   ✅ ${t.name}${t.evidence ? `（${t.evidence}）` : ''}`)
  created++
}

console.log(`\n${APPLY ? '已建立' : '將建立'} ${created} 顆、跳過 ${skipped} 顆`)
if (!APPLY) console.log('確認無誤後加 --apply 重跑。')
process.exit(0)
