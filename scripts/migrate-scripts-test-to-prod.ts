/**
 * 一次性遷移:把 Myfeel Test 的客服腳本(scripts collection)複製到正式 MYFEEL workspace。
 *
 * 設計(沿用 migrate-ai-test-to-prod.ts 的慣例):
 * - 目標 doc id = `p_<來源id>` → 冪等(重跑=覆蓋同一批)、好回滾(刪掉 p_ 前綴那幾筆即可)
 * - **enabled 一律寫 false**:正式 OA 還沒切換,搬過去先停用,對客人零影響;
 *   上線時再逐條啟用。
 * - stats(啟動/完成次數)不搬,正式環境從零起算。
 * - nodes 原封複製(semantic trigger 的 exampleEmbeddings 是對「範例句」算的向量,
 *   與 workspace 無關,可直接沿用,不用重算)。
 *
 * 預設 dry-run(只印不寫);加 --apply 才實際寫入。
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/migrate-scripts-test-to-prod.ts
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/migrate-scripts-test-to-prod.ts --apply
 * 回滾:
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/migrate-scripts-test-to-prod.ts --rollback
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

const SOURCE_WORKSPACE = 'f2d418e2-9f5a-4123-86db-2d9d5bc6a779' // Myfeel Test
const TARGET_WORKSPACE = '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL(正式)
const ID_PREFIX = 'p_'

const apply = process.argv.includes('--apply')
const rollback = process.argv.includes('--rollback')

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數:FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

async function main() {
  const db = getFirestore()
  console.log(`[migrate-scripts] project=${projectId} mode=${rollback ? 'ROLLBACK' : apply ? 'APPLY' : 'DRY-RUN'}`)

  if (rollback) {
    const snap = await db.collection('scripts').where('workspaceId', '==', TARGET_WORKSPACE).get()
    let removed = 0
    for (const doc of snap.docs) {
      if (!doc.id.startsWith(ID_PREFIX)) continue
      console.log(`  刪除 ${doc.id}(${(doc.data() as any).name})`)
      await doc.ref.delete()
      removed++
    }
    console.log(`[migrate-scripts] 回滾完成,刪除 ${removed} 筆`)
    return
  }

  const snap = await db.collection('scripts').where('workspaceId', '==', SOURCE_WORKSPACE).get()
  console.log(`[migrate-scripts] 來源(Test)共 ${snap.size} 條腳本`)
  let written = 0

  for (const doc of snap.docs) {
    const s = doc.data() as any
    const targetId = `${ID_PREFIX}${doc.id}`
    const trigger = (s.nodes ?? []).find((n: any) => n.type === 'trigger')
    const kw = (trigger?.keywords ?? []).join('、')
    console.log(`  「${s.name}」 → ${targetId}`)
    console.log(`     觸發=${trigger?.matchMode ?? 'keyword'} 關鍵字=[${kw}] 節點=${(s.nodes ?? []).length} 個`)
    console.log(`     來源 enabled=${s.enabled} → 目標一律 false(上線時再啟用)`)

    if (!apply) continue
    await db.collection('scripts').doc(targetId).set({
      workspaceId: TARGET_WORKSPACE,
      name: s.name,
      enabled: false,
      priority: s.priority ?? 50,
      nodes: s.nodes,
      rootNodeId: s.rootNodeId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    written++
  }

  console.log(`[migrate-scripts] ${apply ? `完成,寫入 ${written} 筆(全部停用狀態)` : 'dry-run 結束;確認無誤後加 --apply 實際寫入'}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
