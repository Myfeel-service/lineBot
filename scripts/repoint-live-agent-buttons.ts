/**
 * 把「假的轉真人模組」按鈕改指到工作區真正的「真人客服」系統模組。
 *
 * 為什麼需要這支：客服流程裡的「真人客服」快速回覆按鈕若指到一般機器人流程（bot_flow），
 * 客人按下去只會收到一句「客服人員會很快聯絡您」——**不會轉真人、不會通知任何客服**，
 * 客人就一直在那邊重複要求轉接（2026-08-05 實測災情）。指到系統模組
 * （{workspaceId}_live_agent，moduleType='live_agent'）才會真的排進待真人佇列並通知值班客服。
 *
 * 預設 dry-run（只列出要改什麼）；加 --apply 才真的寫入。
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/repoint-live-agent-buttons.ts --from=<假模組id>
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/repoint-live-agent-buttons.ts --from=<假模組id> --apply
 *
 * ⚠️ 圖文選單（richmenus）刻意**不改**：postback 內容存在 LINE 那一份選單定義裡，
 *    只改 Firestore 不會生效，必須到後台重新儲存／重新發布那個選單。腳本會把要手動處理的列出來。
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')
const fromArg = process.argv.find(a => a.startsWith('--from='))
const FROM = fromArg ? fromArg.slice('--from='.length).trim() : ''

if (!FROM) {
  console.error('用法：--from=<要被取代的模組 doc id> [--apply]')
  process.exit(1)
}

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY')
  process.exit(1)
}

initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

const fromSnap = await db.collection('flows').doc(FROM).get()
if (!fromSnap.exists) { console.error(`找不到 flows/${FROM}`); process.exit(1) }
const fromData = fromSnap.data()!
const workspaceId = String(fromData.workspaceId ?? '')
if (!workspaceId) { console.error('這筆流程沒有 workspaceId，不處理'); process.exit(1) }

const TO = `${workspaceId}_live_agent`
const toSnap = await db.collection('flows').doc(TO).get()
if (!toSnap.exists) { console.error(`找不到系統模組 flows/${TO}（先在後台開一次「真人客服」模組）`); process.exit(1) }

console.log(`專案 ${projectId}`)
console.log(`工作區 ${workspaceId}`)
console.log(`  來源（假的）：${FROM}  name=${fromData.name} moduleType=${fromData.moduleType}`)
console.log(`  目標（真的）：${TO}  name=${toSnap.data()!.name} moduleType=${toSnap.data()!.moduleType}`)
console.log(apply ? '\n模式：實際寫入\n' : '\n模式：dry-run（不寫入，加 --apply 才會改）\n')

/** 深層取代字串（moduleId 欄位與 postback data 兩種寫法都換掉） */
function repoint(node: unknown): { value: unknown; hits: number } {
  if (typeof node === 'string') {
    if (node === FROM) return { value: TO, hits: 1 }
    if (node.includes(FROM)) return { value: node.split(FROM).join(TO), hits: 1 }
    return { value: node, hits: 0 }
  }
  if (Array.isArray(node)) {
    let hits = 0
    const out = node.map((v) => { const r = repoint(v); hits += r.hits; return r.value })
    return { value: out, hits }
  }
  if (node && typeof node === 'object') {
    let hits = 0
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) { const r = repoint(v); hits += r.hits; out[k] = r.value }
    return { value: out, hits }
  }
  return { value: node, hits: 0 }
}

// ── flows：quickReplies / buttons 裡的 moduleId ──────────────────────
const flows = await db.collection('flows').where('workspaceId', '==', workspaceId).get()
let changedFlows = 0
let totalHits = 0
for (const d of flows.docs) {
  if (d.id === FROM) continue // 假模組本身不動（改完就沒人指它了，要不要刪由後台決定）
  const data = d.data()
  if (!JSON.stringify(data.messages ?? null).includes(FROM)) continue
  const { value, hits } = repoint(data.messages)
  changedFlows++
  totalHits += hits
  console.log(`  [flow ${d.id}] ${data.name ?? '-'}　${hits} 個按鈕`)
  if (apply) await d.ref.update({ messages: value })
}

// ── richmenus：只列出，不改（見檔頭說明）──────────────────────────
const menus = await db.collection('richmenus').where('workspaceId', '==', workspaceId).get()
const menuHits = menus.docs.filter(d => JSON.stringify(d.data()).includes(FROM))

console.log(`\n流程：${changedFlows} 條、共 ${totalHits} 個按鈕${apply ? ' → 已改' : '（dry-run）'}`)
if (menuHits.length) {
  console.log(`\n⚠️ 圖文選單有 ${menuHits.length} 個也指到假模組，腳本不動它（LINE 端存了一份選單定義）：`)
  for (const d of menuHits) console.log(`   [${d.id}] ${d.data().name ?? '-'} → 請到後台重新設定該按鈕並重新發布選單`)
}
if (!apply) console.log('\n以上是試算。確認沒問題後加 --apply 再跑一次。')
