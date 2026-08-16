import { FieldPath, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { deleteConversationMediaObjects, isMediaMessageType } from '~~/server/utils/conversation-media'
import { effectivePlanOf, getWorkspaceSubscription } from '~~/server/utils/billing'
import { DEFAULT_BILLING_PLAN_ID } from '~~/shared/billing/plans'

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

/**
 * 生效方案是免費層的工作區 id。
 *
 * ⚠️ 已解約（canceled）算免費層——這是 `effectivePlanOf` 的既有語意，解約後本來就回到
 * 免費層的權益，保留天數跟著回到免費層才一致。
 */
async function freeWorkspaceIds(db: Firestore): Promise<string[]> {
  const snap = await db.collection('workspaces').get()
  const ids: string[] = []
  for (const doc of snap.docs) {
    const sub = await getWorkspaceSubscription(doc.id, db)
    // 讀不到訂閱（Firestore 故障）→ 當成付費保護，不刪。刪錯救不回來，少刪只是晚一天
    if (!sub) continue
    if (effectivePlanOf(sub).plan.id === DEFAULT_BILLING_PLAN_ID) ids.push(doc.id)
  }
  return ids
}

/**
 * 某個工作區底下的對話文件。
 *
 * 對話文件 id 是 `{workspaceId}_{lineUserId}`，而 LINE userId 不含底線，所以用
 * documentId 的範圍查詢就能只拿這個工作區的。
 * ⛔ 上界要用 \uf8ff（Unicode 私用區最後一個字元，排序上大於一般字元）——兩個邊界寫成
 *    同一個值會查出零筆，而「零筆」看起來就像「這個帳號沒有舊訊息」，會靜默什麼都不清。
 */
function conversationsOfWorkspace(db: Firestore, workspaceId: string): Query {
  return db.collection('conversations')
    .where(FieldPath.documentId(), '>=', `${workspaceId}_`)
    .where(FieldPath.documentId(), '<', `${workspaceId}_\uf8ff`)
}

/**
 * POST /api/conversations/cleanup
 *
 * 由 Cloud Scheduler 每日呼叫一次。刪掉**免費方案帳號**超過保留天數的對話訊息，
 * 並同步修正對話摘要；訊息附帶的圖／影／音檔一併從 Storage 刪除。
 *
 * ── 為什麼只清免費帳號（2026-08-16 老闆拍板）──────────────────────────────
 * 保留天數是全站一個值，直接照它清會把**付費客戶**的對話一起刪掉，而且刪了沒有
 * TTL 可以挽回。付費客戶的對話保留多久是另一個商業決定，不該由這支排程順手決定。
 *
 * ── ⛔ 為什麼不是「照舊掃全部、跳過付費的」────────────────────────────────
 * 那樣寫的話，付費客戶的舊訊息每天都會被撈出來再跳過一次：查詢照樣計費、過濾率
 * 隨資料變老趨近於零，就是 2026-08-11 讀取費暴衝那次踩過的同一個坑（記憶體過濾
 * 分頁）。所以改成**從免費工作區出發**往下找，付費帳號的資料一筆都不會被讀到。
 *
 * 保護機制：Header 必須帶 X-Cron-Secret，值需等於 CRON_SECRET。
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const cronSecret = String(config.cronSecret || '').trim()
  const headerSecret = String(getHeader(event, 'x-cron-secret') || '').trim()
  if (!cronSecret || headerSecret !== cronSecret) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const retentionDays = parsePositiveInt(config.conversationRetentionDays, 180)
  const batchSize = Math.min(parsePositiveInt(config.conversationCleanupBatchSize, 400), 500)
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const cutoffTimestamp = Timestamp.fromDate(cutoffDate)
  // dry-run：只回報「會刪幾筆」，一個字都不動。第一次掛排程前先用它確認範圍。
  const dryRun = String(getQuery(event).dryRun ?? '') === '1'

  const db = getDb()
  const freeIds = await freeWorkspaceIds(db)

  const toDelete: FirebaseFirestore.QueryDocumentSnapshot[] = []
  const touchedConversationIds = new Set<string>()
  const mediaToDelete: Array<{ workspaceId: string, lineMessageId: string }> = []

  outer: for (const workspaceId of freeIds) {
    const convSnap = await conversationsOfWorkspace(db, workspaceId).get()
    for (const conv of convSnap.docs) {
      if (toDelete.length >= batchSize) break outer
      const old = await conv.ref.collection('messages')
        .where('timestamp', '<=', cutoffTimestamp)
        .orderBy('timestamp', 'asc')
        .limit(batchSize - toDelete.length)
        .get()
      if (old.empty) continue

      touchedConversationIds.add(conv.id)
      for (const doc of old.docs) {
        toDelete.push(doc)
        const data = doc.data()
        const payload = (data.payload ?? {}) as Record<string, unknown>
        const messageType = String(payload.type || data.messageType || '')
        const lineMessageId = String(payload.id || '').trim()
        if (isMediaMessageType(messageType) && lineMessageId) {
          mediaToDelete.push({ workspaceId, lineMessageId })
        }
      }
    }
  }

  const base = {
    ok: true as const,
    freePlanWorkspaces: freeIds.length,
    retentionDays,
    batchSize,
    cutoffAt: cutoffDate.toISOString(),
    dryRun,
  }

  if (dryRun || toDelete.length === 0) {
    return {
      ...base,
      deletedMessages: 0,
      wouldDeleteMessages: toDelete.length,
      touchedConversations: touchedConversationIds.size,
      refreshedConversations: 0,
      deletedConversations: 0,
      deletedMediaFiles: 0,
      hasMore: toDelete.length >= batchSize,
    }
  }

  const batch = db.batch()
  for (const doc of toDelete) batch.delete(doc.ref)
  await batch.commit()

  const deletedMediaFiles = await deleteConversationMediaObjects(mediaToDelete)
    .catch((e) => {
      console.warn('[cleanup] delete media objects failed:', e)
      return 0
    })

  let refreshedConversations = 0
  let deletedConversations = 0

  for (const convId of touchedConversationIds) {
    const conversationRef = db.collection('conversations').doc(convId)
    const latestSnap = await conversationRef.collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get()

    if (latestSnap.empty) {
      await conversationRef.delete()
      deletedConversations += 1
      continue
    }

    const latest = latestSnap.docs[0]?.data() ?? {}
    await conversationRef.set(
      {
        lastMessage: latest.text ?? '',
        lastDirection: latest.direction ?? 'incoming',
        lastMessageAt: latest.timestamp ?? null,
      },
      { merge: true },
    )
    refreshedConversations += 1
  }

  return {
    ...base,
    deletedMessages: toDelete.length,
    wouldDeleteMessages: toDelete.length,
    touchedConversations: touchedConversationIds.size,
    refreshedConversations,
    deletedConversations,
    deletedMediaFiles,
    hasMore: toDelete.length >= batchSize,
  }
})
