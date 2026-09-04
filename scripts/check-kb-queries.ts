/**
 * 知識庫查詢體檢：每一支需要索引的查詢，**在正式資料庫上真的跑得動嗎**。
 *
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/check-kb-queries.ts
 *
 * 為什麼要有這支（`C-140`）：`C-137` 潛伏了 16 天——`firestore.indexes.json` 少了一支索引，
 * 於是「你的資料」清單的主查詢在正式環境每次都失敗、錯誤被吞掉，
 * **8/19 之後每一份匯入建立的來源都不出現在清單上**，而畫面完全正常。
 * 全站沒有任何東西會發現這件事，是老闆自己反映「上傳了卻找不到」才查出來的。
 *
 * ⛔ **「宣告檔裡有寫」不等於「正式庫跑得動」**：索引要 deploy、要 build 完，
 *    而 typecheck 與單元測試都碰不到真的資料庫。所以**部署索引之後一定要跑這支**。
 *
 * ⛔ 兩種失敗都要抓，第二種更陰險：
 *    ① 查詢丟 FAILED_PRECONDITION（缺索引）——會炸，至少看得見。
 *    ② 查詢**沒報錯但回 0**——例如拿 `where('isDeleted','==',false)` 去數舊資料：
 *       舊文件根本沒有那個欄位，等值條件把它們整批濾掉，回一個**假數字**。
 *       2026-09-04 加「產品名幾張卡在用」時就當場踩到（實際 100 張、查出來 0 張）。
 *       所以下面凡是「照理說應該有東西」的查詢，回 0 也要標出來讓人看一眼。
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db: Firestore = getFirestore()

/** 拿哪個 workspace 來試：預設挑卡片最多的那個（空帳號查什麼都回 0，測不出東西） */
async function pickWorkspace(): Promise<{ id: string; name: string }> {
  const arg = process.argv.find(a => a.startsWith('--workspace='))?.slice(12)
  const wsSnap = await db.collection('workspaces').get()
  if (arg) {
    const hit = wsSnap.docs.find(d => d.id === arg)
    return { id: arg, name: String((hit?.data() as any)?.name ?? arg) }
  }
  let best = { id: '', name: '', n: -1 }
  for (const w of wsSnap.docs) {
    const n = (await db.collection('knowledgeChunks').where('workspaceId', '==', w.id).count().get()).data().count
    if (n > best.n) best = { id: w.id, name: String((w.data() as any)?.name ?? w.id), n }
  }
  return best
}

interface Probe {
  name: string
  where: string
  /** 這支查詢照理說應該撈得到東西 → 回 0 要當成可疑（見檔頭②） */
  expectNonEmpty?: boolean
  run: (wid: string) => Promise<number>
}

const cutoff = Timestamp.fromMillis(Date.now() - 14 * 86400_000)

const PROBES: Probe[] = [
  { name: '你的資料：清單主查詢', where: 'ai-knowledge-sources.ts listSources', run: async w => (await db.collection('knowledgeSources').where('workspaceId', '==', w).where('isDeleted', '==', false).orderBy('updatedAt', 'desc').limit(100).get()).size },
  { name: '你的資料：相容查詢', where: 'ai-knowledge-sources.ts listSources', expectNonEmpty: true, run: async w => (await db.collection('knowledgeSources').where('workspaceId', '==', w).orderBy('updatedAt', 'desc').limit(100).get()).size },
  { name: '資料夾清單', where: 'ai-knowledge-folders.ts listFolders', run: async w => (await db.collection('knowledgeFolders').where('workspaceId', '==', w).orderBy('order', 'asc').get()).size },
  { name: '資料夾底下的來源', where: 'ai-knowledge-folders.ts', run: async w => (await db.collection('knowledgeSources').where('workspaceId', '==', w).where('folderId', '==', '__none__').limit(5).get()).size },
  { name: '回收桶', where: 'knowledge/recycle-bin.get.ts', run: async w => (await db.collection('knowledgeChunks').where('workspaceId', '==', w).orderBy('deletedAt', 'desc').select('title').limit(100).get()).size },
  { name: '重新學習全部（游標分批）', where: 'knowledge/reindex-all.post.ts', expectNonEmpty: true, run: async w => (await db.collection('knowledgeChunks').where('workspaceId', '==', w).orderBy('__name__').select('title').limit(50).get()).size },
  { name: '答題檢索（向量＋狀態）', where: 'ai-knowledge-chunks.ts findSimilarChunks', expectNonEmpty: true, run: async (w) => {
    const q = db.collection('knowledgeChunks').where('workspaceId', '==', w).where('status', '==', 'indexed')
      .findNearest({ vectorField: 'embedding', queryVector: new Array(768).fill(0.01), limit: 3, distanceMeasure: 'COSINE' } as any)
    return (await q.get()).size
  } },
  { name: '標籤索引（答題用）', where: 'ai-knowledge-chunks.ts loadTagIndex', expectNonEmpty: true, run: async w => (await db.collection('knowledgeChunks').where('workspaceId', '==', w).where('status', '==', 'indexed').select('tags').limit(2000).get()).size },
  { name: '某來源的卡片', where: 'ai-knowledge-sources.ts listChunksBySource', run: async w => (await db.collection('knowledgeChunks').where('workspaceId', '==', w).where('sourceId', '==', '__none__').limit(5).get()).size },
  { name: '孤兒卡計數', where: 'sources/list.get.ts', run: async w => (await db.collection('knowledgeChunks').where('workspaceId', '==', w).where('sourceId', '==', null).count().get()).data().count },
  { name: '重複偵測（內容指紋）', where: 'ai-knowledge-sources.ts findSourceByContentHash', run: async w => (await db.collection('knowledgeSources').where('workspaceId', '==', w).where('appliedContentHash', '==', '__none__').limit(10).get()).size },
  { name: '同名偵測', where: 'ai-preview-jobs.ts findExistingSources', run: async w => (await db.collection('knowledgeSources').where('workspaceId', '==', w).where('name', '==', '__none__').limit(5).get()).size },
  { name: '產品名「幾張卡在用」', where: 'knowledge/product-names.get.ts', run: async w => (await db.collection('knowledgeChunks').where('workspaceId', '==', w).where('productName', '==', '__none__').where('isDeleted', '==', true).count().get()).data().count },
  { name: '重試學失敗的卡（排程）', where: 'ai-knowledge-chunks.ts', run: async () => (await db.collection('knowledgeChunks').where('status', '==', 'failed').where('retryCount', '<', 3).limit(20).get()).size },
  { name: '撿回卡住的卡（排程）', where: 'ai-knowledge-chunks.ts', run: async () => (await db.collection('knowledgeChunks').where('status', '==', 'pending').where('updatedAt', '<', cutoff).limit(20).get()).size },
  { name: '體檢：全庫掃描', where: 'knowledge/health.get.ts', expectNonEmpty: true, run: async w => (await db.collection('knowledgeChunks').where('workspaceId', '==', w).select('title', 'status').limit(1500).get()).size },
  { name: '體檢：答錯回報', where: 'knowledge/health.get.ts', run: async w => (await db.collection('aiFeedbackEvents').where('workspaceId', '==', w).where('createdAt', '>=', cutoff).orderBy('createdAt', 'desc').limit(100).get()).size },
  { name: '體檢：建議收件匣', where: 'knowledge/health.get.ts', run: async w => (await db.collection('knowledgeSuggestions').where('workspaceId', '==', w).where('status', '==', 'pending').get()).size },
  { name: '缺口掃描：轉真人事件', where: 'ai-knowledge-suggest.ts', run: async w => (await db.collection('aiHandoffEvents').where('workspaceId', '==', w).where('createdAt', '>=', cutoff).orderBy('createdAt', 'desc').limit(400).get()).size },
  { name: '缺口掃描：自動銷案', where: 'ai-knowledge-suggest.ts', run: async w => (await db.collection('conversations').where('workspaceId', '==', w).where('aiMeta.lastDecision', '==', 'handoff').orderBy('aiMeta.updatedAt', 'desc').limit(150).get()).size },
]

const ws = await pickWorkspace()
console.log(`[check-kb-queries] 專案 ${projectId}｜拿「${ws.name}」試（${ws.id}）\n`)

let broken = 0
let suspicious = 0
for (const p of PROBES) {
  try {
    const n = await p.run(ws.id)
    if (p.expectNonEmpty && n === 0) {
      suspicious++
      console.log(`⚠️  ${p.name.padEnd(24)} 回 0 筆（照理說應該有東西——可能被某個過濾條件整批濾掉了）  ${p.where}`)
    }
    else {
      console.log(`✅ ${p.name.padEnd(24)} 回 ${String(n).padStart(5)} 筆  ${p.where}`)
    }
  }
  catch (e) {
    broken++
    const msg = String((e as Error)?.message ?? e)
    const link = msg.match(/https:\/\/console\.firebase[^\s]+/)?.[0] ?? ''
    console.log(`🔴 ${p.name.padEnd(24)} ${/requires an index/i.test(msg) ? '缺索引' : msg.slice(0, 70)}  ${p.where}`)
    if (link) console.log(`      建索引：${link}`)
  }
}

console.log(`\n共 ${PROBES.length} 支：掛掉 ${broken} 支、可疑 ${suspicious} 支`)
if (broken) {
  console.log('⛔ 掛掉的要補進 firestore.indexes.json 再 `npx firebase-tools deploy --only firestore:indexes`，等它 build 完再跑一次這支')
}
process.exit(broken ? 1 : 0)
