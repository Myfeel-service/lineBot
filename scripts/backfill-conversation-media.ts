/**
 * 一次性回填：把客人過去傳來的圖／影／音／檔存進 Storage。
 *
 * 為什麼要回填：LINE webhook 只給 messageId，原始檔要另外向 Get content API 拿，而 LINE
 * 只暫存一小段時間就永久刪除。收訊即存檔是這次才加的（server/utils/handler.ts），在那之前
 * 收到的檔案都還沒存檔——沒人趁還在的時候打開那則對話，那張照片就永遠看不到了。
 * 這支就是趁 LINE 還留著，把「還救得回來的」先存下來。
 *
 * 只需要跑一次（每個租戶各一次）；之後新收到的圖片在 webhook 當下就會存檔，
 * 影／音／檔則在後台開啟對話時補存（server/utils/conversation-media.ts）。
 *
 * 刻意不 import server/utils/conversation-media.ts：那支依賴 Nitro 的 useRuntimeConfig，
 * 在 node 腳本裡跑不起來。存檔路徑必須與它一致：conversation-media/{workspaceId}/{messageId}
 *
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-conversation-media.ts            # dry-run
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-conversation-media.ts --apply
 *   node --env-file=.env_splash --experimental-strip-types scripts/backfill-conversation-media.ts --apply --days=30
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const apply = process.argv.includes('--apply')
const daysArg = process.argv.find(a => a.startsWith('--days='))
const days = Math.max(1, Number(daysArg?.split('=')[1] || 30))

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET

if (!projectId || !clientEmail || !privateKey || !storageBucket) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY、FIREBASE_STORAGE_BUCKET')
  process.exit(1)
}

initializeApp({
  credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }),
  storageBucket,
})

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file'])
/** 與 conversation-media.ts 的上限一致（image 15MB，其餘 30MB） */
const MAX_BYTES: Record<string, number> = {
  image: 15 * 1024 * 1024,
  video: 30 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
  file: 30 * 1024 * 1024,
}

function workspaceIdFromConversationDocId(convDocId: string): string {
  const idx = convDocId.lastIndexOf('_')
  return idx > 0 ? convDocId.slice(0, idx) : ''
}

async function main() {
  const db = getFirestore()
  const bucket = getStorage().bucket()
  console.log(`[backfill-media] project=${projectId} bucket=${storageBucket} 近 ${days} 天 mode=${apply ? 'APPLY' : 'DRY-RUN'}`)

  const tokenByWorkspace = new Map<string, string>()
  async function channelAccessToken(workspaceId: string): Promise<string> {
    const cached = tokenByWorkspace.get(workspaceId)
    if (cached !== undefined) return cached
    const snap = await db.collection('workspaces').doc(workspaceId).get()
    const token = String(snap.data()?.channelAccessToken || '').trim()
    tokenByWorkspace.set(workspaceId, token)
    return token
  }

  const since = Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000)
  const convs = await db.collection('conversations').where('lastMessageAt', '>=', since).get()
  console.log(`[backfill-media] 掃 ${convs.size} 個對話`)

  const stats = { found: 0, already: 0, archived: 0, expired: 0, tooLarge: 0, failed: 0, noToken: 0 }

  for (const conv of convs.docs) {
    const workspaceId = String(conv.data()?.workspaceId || '').trim() || workspaceIdFromConversationDocId(conv.id)
    if (!workspaceId) continue

    const msgs = await conv.ref
      .collection('messages')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'asc')
      .get()

    for (const msg of msgs.docs) {
      const data = msg.data()
      if (data.direction !== 'incoming') continue
      const payload = (data.payload ?? {}) as Record<string, unknown>
      const type = String(payload.type || data.messageType || '')
      const lineMessageId = String(payload.id || '').trim()
      if (!MEDIA_TYPES.has(type) || !/^[A-Za-z0-9_-]{1,64}$/.test(lineMessageId)) continue
      // 客服自己送的（有現成網址）不需要回填
      if (String(payload.originalContentUrl || '').trim()) continue

      stats.found += 1
      const path = `conversation-media/${workspaceId}/${lineMessageId}`
      const file = bucket.file(path)

      try {
        await file.getMetadata()
        stats.already += 1
        continue
      }
      catch (e: any) {
        if (Number(e?.code) !== 404) {
          console.warn('  getMetadata 失敗：', path, e?.message)
          stats.failed += 1
          continue
        }
      }

      const token = await channelAccessToken(workspaceId)
      if (!token) {
        stats.noToken += 1
        continue
      }

      if (!apply) {
        console.log(`  [dry-run] 待存檔 ${type} ${lineMessageId}（${conv.id}）`)
        continue
      }

      try {
        const res = await fetch(`https://api-data.line.me/v2/bot/message/${lineMessageId}/content`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.status === 404 || res.status === 410) {
          stats.expired += 1
          continue
        }
        if (res.status === 202) {
          console.log(`  ${lineMessageId} LINE 還在轉檔，略過`)
          stats.failed += 1
          continue
        }
        if (!res.ok) {
          console.warn(`  ${lineMessageId} 下載失敗 ${res.status}`)
          stats.failed += 1
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > (MAX_BYTES[type] ?? MAX_BYTES.file!)) {
          stats.tooLarge += 1
          continue
        }
        const contentType = String(res.headers.get('content-type') || '').split(';')[0]!.trim() || 'application/octet-stream'
        await file.save(buf, { contentType, resumable: false, metadata: { cacheControl: 'private, max-age=3600' } })
        stats.archived += 1
        console.log(`  ✓ ${type} ${lineMessageId} ${(buf.length / 1024).toFixed(0)}KB → ${path}`)
      }
      catch (e: any) {
        console.warn(`  ${lineMessageId} 例外：`, e?.message)
        stats.failed += 1
      }
    }
  }

  console.log('[backfill-media] 結果：', stats)
  if (!apply && stats.found > stats.already) {
    console.log('[backfill-media] 以上為 dry-run，加 --apply 才會實際存檔')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
