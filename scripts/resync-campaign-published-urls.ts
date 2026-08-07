/**
 * 把 leadCampaigns.publishedCtaUrl 的網域改成目前的 PUBLIC_BASE_URL。
 *
 * 為什麼需要這支：publishedCtaUrl 只在活動建立／編輯時重算，換網域
 * （bot.myfeel-tw.com → lineminime.com）後沒被編輯過的活動仍存舊網域，
 * 後台複製到的「活動進入網址」推播出去就是舊網址（2026-08-07 實測災情）。
 * 只換網域、保留原本的 claimToken／c／liffId，所以已發出的舊連結與
 * leadClaims 兌換資料完全不受影響。
 *
 * 預設 dry-run（只列出要改什麼）；加 --apply 才真的寫入。
 *   node --env-file=.env --experimental-strip-types scripts/resync-campaign-published-urls.ts
 *   node --env-file=.env --experimental-strip-types scripts/resync-campaign-published-urls.ts --apply
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')

const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
if (!baseUrl) {
  console.error('缺少環境變數：PUBLIC_BASE_URL')
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

const snap = await db.collection('leadCampaigns').get()
let changed = 0

for (const doc of snap.docs) {
  const current = String(doc.data().publishedCtaUrl || '').trim()
  if (!current) continue

  let parsed: URL
  try {
    parsed = new URL(current)
  }
  catch {
    console.warn(`⚠️ leadCampaigns/${doc.id} publishedCtaUrl 不是合法網址，略過：${current}`)
    continue
  }
  // liff.line.me 形式沒有自家網域可換
  if (parsed.hostname === 'liff.line.me') continue

  const next = `${baseUrl}${parsed.pathname}${parsed.search}`
  if (next === current) continue

  changed++
  console.log(`leadCampaigns/${doc.id}`)
  console.log(`  舊：${current}`)
  console.log(`  新：${next}`)
  if (apply) await doc.ref.update({ publishedCtaUrl: next })
}

console.log(changed === 0
  ? '沒有需要更新的活動。'
  : `${apply ? '已更新' : '需要更新（dry-run，加 --apply 才會寫入）'}：${changed} 筆`)
