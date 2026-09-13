import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { readConversationFlags } from '~~/shared/conversation-flags'
import {
  CONVERSATION_BATCH_LIMIT,
  type ConversationBatchResult,
  type ConversationBatchSkip,
} from '~~/shared/conversation-batch'

/**
 * POST /api/conversations/batch-flags
 * Body: { userIds: string[], followUp: boolean }
 *
 * 對話列表勾選之後「一次標記／取消待跟進」。單筆版是 `[userId]/flags.post.ts`。
 *
 * ⛔ 刻意**只有待跟進**：
 *  · 釘選有 50 筆上限（`MAX_PINNED_CONVERSATIONS`），批次一次灌進來就等於把第一頁蓋滿
 *    ——釘選的意思是「這幾筆最重要」，能批次釘就不重要了。
 *  · 會話狀態（待處理／結束…）不走這支，那是系統判定的欄位，改它要走 batch-close。
 *    為什麼兩件事不能混見 shared/conversation-flags.ts 與 docs/CONVERSATION-STATS-DEFINITIONS.md。
 */

/** Firestore 單批 500 筆上限，留餘裕 */
const FIRESTORE_BATCH_LIMIT = 400

export default defineEventHandler(async (event): Promise<ConversationBatchResult> => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const raw: unknown[] = Array.isArray(body?.userIds) ? body.userIds : []
  if (typeof body?.followUp !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'followUp 必須是 true 或 false' })
  }
  const nextFollowUp = body.followUp as boolean

  // 去重是照「正規化之後的主鍵」做的：同一位客人用 LINE userId 與對話主鍵各送一次也只算一筆
  const docIds = [...new Set(
    raw
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
      .map(v => lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(v, workspaceId), workspaceId)),
  )]

  if (!docIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'userIds required' })
  }
  if (docIds.length > CONVERSATION_BATCH_LIMIT) {
    throw createError({
      statusCode: 400,
      statusMessage: `一次最多 ${CONVERSATION_BATCH_LIMIT} 筆，請分批處理`,
    })
  }

  const db = getDb()
  // 一趟讀回來：要驗歸屬，也要分得出「本來就是這個標記」（那不是失敗，是不用做）
  const snaps = await db.getAll(...docIds.map(id => db.collection('conversations').doc(id)))

  const skipped: ConversationBatchSkip[] = []
  const doneIds: string[] = []
  const updates: string[] = []

  for (const snap of snaps) {
    const data = snap.data() as { workspaceId?: string, followUpAt?: unknown } | undefined
    // ⛔ 逐筆驗歸屬：userIds 是前端送來的，不驗就等於「知道 id 就能標到別家的對話」
    if (!snap.exists || data?.workspaceId !== workspaceId) {
      skipped.push({ id: snap.id, reason: 'not_found' })
      continue
    }
    if (readConversationFlags(data).followUp === nextFollowUp) {
      skipped.push({ id: snap.id, reason: 'already_set' })
      continue
    }
    updates.push(snap.id)
  }

  // 分批寫（同 user-tags/batch-add 的寫法）。一筆文件一個操作，所以 400 筆一批
  for (let i = 0; i < updates.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = updates.slice(i, i + FIRESTORE_BATCH_LIMIT)
    const batch = db.batch()
    for (const id of chunk) {
      batch.update(db.collection('conversations').doc(id), {
        followUpAt: nextFollowUp ? FieldValue.serverTimestamp() : FieldValue.delete(),
        followUpBy: nextFollowUp ? uid : FieldValue.delete(),
      })
    }
    await batch.commit()
    doneIds.push(...chunk)
  }

  return {
    requested: docIds.length,
    done: doneIds.length,
    skipped,
    // 這支是一批一起 commit：整批成功或整批拋錯（拋錯就是 500，不會回到這裡），
    // 所以沒有「單筆失敗」這一堆。型別共用，留空陣列。
    failed: [],
    doneIds,
  }
})
