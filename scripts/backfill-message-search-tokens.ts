/**
 * 一次性回填：把既有訊息補上「可搜尋片段」，讓對話內容搜尋找得到舊訊息。
 *
 * 片段（`messages.searchTokens`）與 `messages.workspaceId` 是 2026-09-11 才開始在寫入時
 * 產生的（server/utils/handler.ts）。在那之前的訊息兩個欄位都沒有，而搜尋是一支
 * 「workspaceId + array-contains 片段」的精準查詢——沒有欄位就等於那些訊息不存在。
 * 這支就是把它們補上，補完才是「保留期內（180 天）的每一則都找得到」。
 *
 * ## 影響範圍（跑之前一定要知道）
 *
 * · 讀：掃過 `conversations` 底下所有 `messages`（每則 1 次讀取）。
 * · 寫：只寫**還沒有片段**的那些訊息，每則 1 次寫入，而且只 merge 三個欄位
 *       （searchTokens / workspaceId / searchTextCut）——不動 text、timestamp、payload。
 * · 另外寫一份進度到 `messageSearchIndex/{workspaceId}`（見 shared/message-search-state.ts），
 *   後台畫面靠它決定要不要跟客服說「舊訊息還沒補完」。
 * · 可以中斷、可以重跑：已經有片段的會跳過，不會重複付寫入。
 *
 * ## 用法
 *
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-message-search-tokens.ts            # dry-run（只數，不寫）
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-message-search-tokens.ts --apply
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-message-search-tokens.ts --apply --days=30      # 只補最近 30 天
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-message-search-tokens.ts --apply --workspace=default
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-message-search-tokens.ts --apply --rebuild      # 片段規則改過時重算全部
 *
 * ⚠️ 索引要先部署好（firestore.indexes.json 的 messages COLLECTION_GROUP 那支），
 *    否則補完了畫面上的搜尋還是回「暫時不能用」。
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { messageSearchTokens } from '../shared/message-search.ts'
import { MESSAGE_SEARCH_STATE_COLLECTION, MESSAGE_SEARCH_TOKEN_VERSION } from '../shared/message-search-state.ts'

const apply = process.argv.includes('--apply')
const rebuild = process.argv.includes('--rebuild')
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]?.trim() || ''
const onlyWorkspace = arg('workspace')
const daysArg = Number(arg('days') || 0)
const days = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 0

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY

if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID、FIREBASE_CLIENT_EMAIL、FIREBASE_PRIVATE_KEY')
  process.exit(1)
}

initializeApp({
  credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }),
})

/** 一次讀幾則訊息（Firestore 單次查詢上限之下，兼顧記憶體） */
const MESSAGE_PAGE = 500
/** 一批寫幾筆（Firestore batch 上限 500，留一點餘裕） */
const WRITE_BATCH = 400

function workspaceIdFromConversationDocId(convDocId: string): string {
  const idx = convDocId.lastIndexOf('_')
  return idx > 0 ? convDocId.slice(0, idx) : ''
}

function toMillis(v: unknown): number {
  const ts = v as { toMillis?: () => number } | null
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0
}

async function main() {
  const db = getFirestore()
  const since = days ? Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000) : null
  console.log(
    `[backfill-search-tokens] project=${projectId} mode=${apply ? 'APPLY' : 'DRY-RUN'}`
    + ` 範圍=${days ? `最近 ${days} 天` : '全部'}${onlyWorkspace ? ` workspace=${onlyWorkspace}` : ''}`
    + `${rebuild ? ' 重算=是' : ''}`,
  )

  let convQuery = db.collection('conversations') as FirebaseFirestore.Query
  if (onlyWorkspace) convQuery = convQuery.where('workspaceId', '==', onlyWorkspace)
  const convs = await convQuery.get()
  console.log(`[backfill-search-tokens] 掃 ${convs.size} 個對話`)

  const stats = { messages: 0, already: 0, written: 0, empty: 0, cut: 0, noWorkspace: 0 }
  /** 每個 workspace 各自涵蓋到的最舊訊息時間（進度文件是一個 workspace 一份） */
  const oldestByWorkspace = new Map<string, number>()

  let batch = db.batch()
  let pending = 0
  const flush = async () => {
    if (!pending) return
    if (apply) await batch.commit()
    batch = db.batch()
    pending = 0
  }

  for (const conv of convs.docs) {
    const workspaceId = String(conv.data()?.workspaceId || '').trim()
      || workspaceIdFromConversationDocId(conv.id)
    if (!workspaceId) {
      // 對不出租戶的對話不能亂補：補錯 workspaceId 就是把這段對話送進別家的搜尋結果
      stats.noWorkspace += 1
      console.warn(`  ⚠️ ${conv.id} 判不出 workspaceId，跳過`)
      continue
    }

    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
    for (;;) {
      // ⚠️ 條件要在 orderBy 之前接上：同一個欄位 orderBy 兩次 Firestore 會直接丟錯
      let q: FirebaseFirestore.Query = conv.ref.collection('messages')
      if (since) q = q.where('timestamp', '>=', since)
      q = q.orderBy('timestamp', 'desc').limit(MESSAGE_PAGE)
      if (cursor) q = q.startAfter(cursor)
      const page = await q.get()
      if (page.empty) break

      for (const doc of page.docs) {
        const data = doc.data()
        stats.messages += 1
        const ms = toMillis(data.timestamp)
        if (ms > 0) {
          const prev = oldestByWorkspace.get(workspaceId) ?? Number.POSITIVE_INFINITY
          if (ms < prev) oldestByWorkspace.set(workspaceId, ms)
        }

        const { tokens, cut } = messageSearchTokens([data.text, data.mediaDescription])
        const hasWorkspace = String(data.workspaceId || '') === workspaceId
        const hasTokens = Array.isArray(data.searchTokens)
        // 已經補過就跳過（可重跑、不重複付寫入）。純表情／空字串的訊息切不出片段，
        // 只要 workspaceId 補上了就算處理完，不要每次重跑都當成待補
        if (!rebuild && hasWorkspace && (hasTokens || !tokens.length)) {
          stats.already += 1
          continue
        }
        if (!tokens.length) stats.empty += 1
        if (cut) stats.cut += 1

        batch.set(doc.ref, {
          workspaceId,
          ...(tokens.length ? { searchTokens: tokens } : {}),
          // 之前被標過、這次沒超長（例如規則放寬）就要把旗標清掉，不要留一個過期的警告
          ...(cut ? { searchTextCut: true } : { searchTextCut: FieldValue.delete() }),
        }, { merge: true })
        pending += 1
        stats.written += 1
        if (pending >= WRITE_BATCH) await flush()
      }

      cursor = page.docs[page.docs.length - 1] ?? null
      if (page.size < MESSAGE_PAGE) break
    }

    if (stats.messages > 0 && stats.messages % 5000 < MESSAGE_PAGE) {
      console.log(`  …已掃 ${stats.messages} 則，待補 ${stats.written} 則`)
    }
  }
  await flush()

  /**
   * 進度文件：後台靠它決定要不要跟客服說「舊訊息還沒補完」。
   *
   * `oldestIndexedMs` 取「這一輪」與「先前紀錄」的較舊者——用 --days 補一小段之後
   * 直接覆蓋的話，涵蓋範圍會憑空縮短，畫面就會開始說謊（說找不到其實找得到的東西）。
   */
  for (const [workspaceId, oldestMs] of oldestByWorkspace) {
    const ref = db.collection(MESSAGE_SEARCH_STATE_COLLECTION).doc(workspaceId)
    const prev = Number((await ref.get()).data()?.oldestIndexedMs ?? 0) || 0
    const merged = prev > 0 ? Math.min(prev, oldestMs) : oldestMs
    console.log(
      `[backfill-search-tokens] ${workspaceId} 涵蓋到 ${new Date(merged).toISOString().slice(0, 10)}`
      + `${apply ? '' : '（dry-run 不寫入進度）'}`,
    )
    if (!apply) continue
    await ref.set({
      startedAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.serverTimestamp(),
      oldestIndexedMs: merged,
      indexedMessages: stats.written,
      tokenVersion: MESSAGE_SEARCH_TOKEN_VERSION,
    }, { merge: true })
  }

  console.log('[backfill-search-tokens] 結果：', stats)
  if (!apply) {
    console.log('[backfill-search-tokens] 以上為 dry-run，加 --apply 才會實際寫入')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
