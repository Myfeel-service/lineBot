/**
 * 唯讀：列出所有自動回覆規則（matchType / isActive / 回覆內容 / cooldown），
 * 用來找出「請問有什麼可以幫助您的地方呢？」是哪一條規則送出的。
 *   node --env-file=.env_myfeel --experimental-strip-types <this>
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const projectId = process.env.FIREBASE_PROJECT_ID!
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!
const privateKey = process.env.FIREBASE_PRIVATE_KEY!

initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

const db = getFirestore()

function brief(v: any, n = 90): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (!s) return ''
  return s.replace(/\s+/g, ' ').slice(0, n)
}

async function main() {
  console.log(`project=${projectId}`)

  const snap = await db.collection('autoReplies').get()
  console.log(`\n=== autoReplies (${snap.size}) ===`)
  const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
  rows.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
  for (const r of rows) {
    const action = r.action ?? { type: r.actionType, text: r.text, moduleId: r.moduleId }
    console.log([
      `wid=${r.workspaceId}`,
      `active=${r.isActive}`,
      `match=${r.matchType}`,
      `kw=${brief(r.keyword, 30)}`,
      `name=${brief(r.name, 24)}`,
      `action=${action?.type}`,
      `text=${brief(action?.text ?? action?.moduleId, 60)}`,
      `cooldown=${JSON.stringify(r.cooldown ?? null)}`,
      `id=${r.id}`,
    ].join(' | '))
  }

  // 圖文選單 / flows 裡是否也有同一句
  const flows = await db.collection('flows').get()
  console.log(`\n=== flows containing 「請問有什麼可以幫助您」 (of ${flows.size}) ===`)
  for (const d of flows.docs) {
    const raw = JSON.stringify(d.data())
    if (raw.includes('請問有什麼可以幫助您')) {
      const f = d.data() as any
      console.log(`flow=${d.id} wid=${f.workspaceId} name=${f.name} moduleType=${f.moduleType} active=${f.isActive} moduleId=${f.moduleId}`)
    }
  }

  // 腳本
  const scripts = await db.collection('scripts').get().catch(() => null)
  if (scripts) {
    console.log(`\n=== scripts containing the phrase (of ${scripts.size}) ===`)
    for (const d of scripts.docs) {
      if (JSON.stringify(d.data()).includes('請問有什麼可以幫助您')) {
        const s = d.data() as any
        console.log(`script=${d.id} wid=${s.workspaceId} name=${s.name} active=${s.isActive}`)
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
