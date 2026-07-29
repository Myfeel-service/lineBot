/**
 * 一次性遷移：把「Myfeel Test」OA 的知識庫 + AI 設定複製到正式「MYFEEL」OA。
 * 同一個 Firebase 專案 (linebot-e8dda) 內的跨 workspace 複製，不跨租戶。
 *
 * 複製內容：
 *   - knowledgeFolders   （資料夾）
 *   - knowledgeSources    （知識來源，folderId 一併重映射）
 *   - knowledgeChunks     （知識卡，含 embedding 向量原封複製、sourceId 重映射）
 *   - knowledgeProductIndex/{workspaceId}（產品名清單）
 *   - aiSettings/{workspaceId}           （AI 設定；**強制 enabled=false**，遷移不會打開 AI）
 *
 * 不複製：scripts / autoReplies（腳本與自動回覆規則屬「機器人」層，正式 OA 已有自己的 49 個 flows，
 *         另行決定；本腳本只搬「知識庫 + AI 設定」）；source 的 cache/extracted 子集合（只給變動偵測用）。
 *
 * 冪等：目標 doc id 用 `p_` 前綴由來源 id 決定，重跑會覆蓋同一批而非重複產生。
 *
 * 預設 dry-run（只印不寫）；加 --apply 才實際寫入。
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/migrate-ai-test-to-prod.ts          # dry-run
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/migrate-ai-test-to-prod.ts --apply  # 實寫
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
if (projectId !== 'linebot-e8dda') {
  console.error(`此腳本只在 myfeel 專案 (linebot-e8dda) 執行；目前 project=${projectId}。請用 --env-file=.env_myfeel`)
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

const SRC = 'f2d418e2-9f5a-4123-86db-2d9d5bc6a779' // Myfeel Test
const DST = '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL 正式
const pid = (id: string) => `p_${id}`

/** 把 admin SDK 讀回來的 embedding 值轉成 number[]（VectorValue / array / {values} 皆可） */
function toVecArray(v: any): number[] | null {
  if (!v) return null
  if (typeof v.toArray === 'function') return v.toArray()
  if (Array.isArray(v)) return v
  if (Array.isArray(v._values)) return v._values
  if (Array.isArray(v.values)) return v.values
  return null
}

async function main() {
  const db = getFirestore()
  console.log(`\n[migrate] project=${projectId}  ${SRC} → ${DST}  mode=${apply ? 'APPLY' : 'DRY-RUN'}\n`)

  const bw = apply ? db.bulkWriter() : null
  const set = (path: string, id: string, data: Record<string, unknown>) => {
    if (bw) bw.set(db.collection(path).doc(id), data)
  }

  // ── 1) 資料夾 ────────────────────────────────────────────────
  const foldersSnap = await db.collection('knowledgeFolders').where('workspaceId', '==', SRC).get()
  for (const d of foldersSnap.docs) {
    set('knowledgeFolders', pid(d.id), { ...d.data(), workspaceId: DST })
  }
  console.log(`資料夾 knowledgeFolders：${foldersSnap.size} 筆`)

  // ── 2) 知識來源 ──────────────────────────────────────────────
  const sourcesSnap = await db.collection('knowledgeSources').where('workspaceId', '==', SRC).get()
  let fileTypeCount = 0
  for (const d of sourcesSnap.docs) {
    const raw = d.data() as any
    if (raw.type === 'file') fileTypeCount++
    set('knowledgeSources', pid(d.id), {
      ...raw,
      workspaceId: DST,
      folderId: raw.folderId ? pid(String(raw.folderId)) : null,
    })
  }
  console.log(`知識來源 knowledgeSources：${sourcesSnap.size} 筆（其中 file 型 ${fileTypeCount} 筆，filePath 指向共用 Storage，答題不受影響；重新抓取才需注意）`)

  // ── 3) 知識卡（含向量）──────────────────────────────────────
  const chunksSnap = await db.collection('knowledgeChunks').where('workspaceId', '==', SRC).get()
  const byStatus: Record<string, number> = {}
  let vecOk = 0
  let vecMissing = 0
  for (const d of chunksSnap.docs) {
    const raw = d.data() as any
    byStatus[raw.status ?? '?'] = (byStatus[raw.status ?? '?'] ?? 0) + 1
    const arr = toVecArray(raw.embedding)
    if (arr && arr.length > 0) vecOk++
    else vecMissing++
    set('knowledgeChunks', pid(d.id), {
      ...raw,
      workspaceId: DST,
      sourceId: raw.sourceId ? pid(String(raw.sourceId)) : null,
      embedding: arr && arr.length > 0 ? FieldValue.vector(arr) : null,
    })
  }
  console.log(`知識卡 knowledgeChunks：${chunksSnap.size} 筆  status=${JSON.stringify(byStatus)}`)
  console.log(`  向量可複製=${vecOk}  向量缺失=${vecMissing}${vecMissing ? '（這些卡搬過去會搜不到，需重新索引）' : ''}`)

  // ── 4) 產品名清單 ────────────────────────────────────────────
  const piSnap = await db.collection('knowledgeProductIndex').doc(SRC).get()
  if (piSnap.exists) {
    const raw = piSnap.data() as any
    const names = Array.isArray(raw?.names) ? raw.names : []
    set('knowledgeProductIndex', DST, { ...raw, workspaceId: DST })
    console.log(`產品名清單 knowledgeProductIndex：${names.length} 個名稱`)
  }
  else {
    console.log('產品名清單 knowledgeProductIndex：來源無此文件，略過')
  }

  // ── 5) AI 設定（強制 enabled=false）──────────────────────────
  const aiSnap = await db.collection('aiSettings').doc(SRC).get()
  if (aiSnap.exists) {
    const raw = aiSnap.data() as any
    const dst = { ...raw, enabled: false, updatedAt: FieldValue.serverTimestamp() }
    set('aiSettings', DST, dst)
    console.log(`AI 設定 aiSettings：已複製（replyMode=${raw.replyMode}, model=${raw.answerModel}, confidence=${raw.confidenceThreshold}, grounding=${raw.groundingThreshold}）`)
    console.log(`  ⚠ 已強制 enabled=false —— 遷移後 AI 仍為「關閉」，不會影響現有客人，需你手動開啟。`)
  }
  else {
    console.log('AI 設定 aiSettings：來源無此文件，略過')
  }

  if (bw) {
    await bw.close()
    console.log('\n[migrate] ✅ 已寫入完成。')
    // ── 驗證：正式 OA 已索引卡數 + 向量搜尋自我測試 ──
    const dstCount = await db.collection('knowledgeChunks')
      .where('workspaceId', '==', DST).where('status', '==', 'indexed').count().get()
    console.log(`[verify] 正式 OA 已索引知識卡 = ${dstCount.data().count}`)
    // 拿一張剛搬過去、有向量的卡，用它的向量對正式 OA 做 findNearest，應該找回自己（距離~0）→ 證明向量索引在正式 OA 可用
    const oneWithVec = chunksSnap.docs.map(d => d.data() as any).find(r => toVecArray(r.embedding))
    const vec = oneWithVec ? toVecArray(oneWithVec.embedding) : null
    if (vec) {
      const near = await db.collection('knowledgeChunks')
        .where('workspaceId', '==', DST).where('status', '==', 'indexed')
        .findNearest({ vectorField: 'embedding', queryVector: FieldValue.vector(vec), limit: 1, distanceMeasure: 'COSINE', distanceResultField: '_distance' } as any)
        .get()
      const top = near.docs[0]?.data() as any
      console.log(`[verify] 向量搜尋自我測試：命中「${top?.title ?? '(無)'}」distance=${top?._distance?.toFixed?.(4) ?? '?'} → ${near.size ? '向量索引在正式 OA 可用 ✅' : '無結果 ❌（檢查向量索引是否已部署）'}`)
    }
  }
  else {
    console.log('\n[migrate] 這是 dry-run；確認無誤後加 --apply 實際寫入。')
    console.log('[migrate] 目標 doc id 一律用 `p_` 前綴（來源 id 決定），重跑會覆蓋、不會重複。')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
