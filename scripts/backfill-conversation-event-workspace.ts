/**
 * 把舊的 conversationEvents 補上 workspaceId。
 *
 * 為什麼需要：這個集合原本沒有存 workspaceId，所以時間軸只能「先查出這位客人的每一場會話，
 * 再用 sessionId 分批 in 回來湊」——因為用 userId 直接查會跨 workspace（同一個 LINE Provider
 * 下的兩個 OA，同一位客人的 userId 是同一組）。寫入端已經補上了，這支負責把歷史資料補齊，
 * 補齊之後讀取端才有辦法改成直接查（見檔尾說明）。
 *
 * 作法：每筆事件用它的 sessionId 去 conversationSessions 拿 workspaceId。
 * 對不到會話的（會話已被刪、或殘留的舊資料）**跳過並計數**，不猜。
 *
 * 安全性：只加欄位，不改任何既有欄位、不刪文件；重跑只會處理還沒補到的那些（冪等）。
 *
 * 用法：
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-conversation-event-workspace.ts          # dry-run
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-conversation-event-workspace.ts --apply
 *   （每個 Firebase 專案各跑一次：.env_myfeel 與 .env_splash 是不同專案）
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

/** 一次讀幾筆事件（照文件 id 分頁，不需要索引） */
const PAGE = 500
/** 一次寫幾筆（Firestore 批次上限 500） */
const WRITE_BATCH = 400

async function main() {
  const db: Firestore = getFirestore()
  const sessionWorkspace = new Map<string, string>() // sessionId → workspaceId（'' = 查過但沒有）

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
  let scanned = 0
  let already = 0
  let noSession = 0
  const pending: Array<{ ref: FirebaseFirestore.DocumentReference, workspaceId: string }> = []
  let written = 0

  const flush = async (force = false) => {
    while (pending.length >= (force ? 1 : WRITE_BATCH)) {
      const slice = pending.splice(0, WRITE_BATCH)
      if (apply) {
        const batch = db.batch()
        for (const p of slice) batch.update(p.ref, { workspaceId: p.workspaceId })
        await batch.commit()
      }
      written += slice.length
      console.log(`[backfill] ${apply ? '已寫入' : '(dry-run) 待寫入'} ${written} 筆`)
    }
  }

  for (;;) {
    let q = db.collection('conversationEvents').orderBy('__name__').limit(PAGE)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break
    cursor = snap.docs[snap.docs.length - 1]!
    scanned += snap.size

    // 這一批需要查的會話（去重後一次拿回來，避免逐筆讀）
    const needed = new Set<string>()
    for (const d of snap.docs) {
      if (String(d.data()?.workspaceId ?? '')) continue
      const sid = String(d.data()?.sessionId ?? '')
      if (sid && !sessionWorkspace.has(sid)) needed.add(sid)
    }
    const ids = [...needed]
    for (let i = 0; i < ids.length; i += 100) {
      const refs = ids.slice(i, i + 100).map(id => db.collection('conversationSessions').doc(id))
      const docs = await db.getAll(...refs)
      for (const s of docs) {
        sessionWorkspace.set(s.id, s.exists ? String(s.data()?.workspaceId ?? '') : '')
      }
    }

    for (const d of snap.docs) {
      if (String(d.data()?.workspaceId ?? '')) { already++; continue }
      const wid = sessionWorkspace.get(String(d.data()?.sessionId ?? '')) ?? ''
      if (!wid) { noSession++; continue }
      pending.push({ ref: d.ref, workspaceId: wid })
    }
    await flush()
    if (snap.size < PAGE) break
  }
  await flush(true)

  console.log(
    `[backfill] 專案 ${projectId} 完成：掃描 ${scanned} 筆、`
    + `本來就有 ${already} 筆、${apply ? '補上' : '可補上'} ${written} 筆、`
    + `對不到會話而跳過 ${noSession} 筆`,
  )
  if (!apply) console.log('[backfill] 這是 dry-run，確認數字後加 --apply')
}

main().catch((e) => { console.error('[backfill] 失敗：', e); process.exit(1) })

/**
 * 補完之後，讀取端要改成直接查還需要兩件事（刻意留給部署後再做）：
 *   1. 新版寫入端要先部署上線，否則部署前產生的新事件仍然沒有 workspaceId
 *   2. 建立 conversationEvents 的 (workspaceId, userId, timestamp) 複合索引
 * 兩件都完成後，messages.get.ts 的 loadEventItems 就能用一條時間範圍查詢取代
 * 「先撈會話再分批 in」的 join。
 */
