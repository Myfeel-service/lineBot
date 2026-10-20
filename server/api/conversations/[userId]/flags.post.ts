import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { countPinnedConversations } from '~~/server/utils/conversation-follow-up'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { MAX_PINNED_CONVERSATIONS, readConversationFlags } from '~~/shared/conversation-flags'

/**
 * POST /api/conversations/:userId/flags
 * Body: { pinned: boolean }
 *
 * 對話列表右鍵的「待跟進」（`H-17`：原本叫釘選，欄位沿用 `pinnedAt`）。全 workspace 共用
 * （誰標記的同事都看得到），只影響列表排序與顯示，**不動會話狀態、不進統計** —— 原因見
 * ~~/shared/conversation-flags.ts。舊的 `followUp` 參數已下架。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'conversations.reply')

  const userId = String(getRouterParam(event, 'userId') ?? '').trim()
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const body = await readBody(event)
  if (typeof body?.pinned !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'pinned 必須是 true 或 false' })
  }
  const nextPinned = body.pinned as boolean

  const db = getDb()
  // 與 ai-feedback 同一個正規化：算不出同一個 doc id 就會標到別筆（或標了讀不回來）
  const convDocId = lineUserFirestoreDocId(userId, workspaceId)
  const ref = db.collection('conversations').doc(convDocId)
  const snap = await ref.get()
  const data = snap.data() as { workspaceId?: string; pinnedAt?: unknown } | undefined
  if (!snap.exists || data?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  const current = readConversationFlags(data)

  // 上限只在「從沒標變成標」時檢查：已經標著的重複送出不該被自己擋下來
  if (nextPinned && !current.pinned) {
    const pinnedCount = await countPinnedConversations(db, workspaceId)
    if (pinnedCount !== null && pinnedCount >= MAX_PINNED_CONVERSATIONS) {
      throw createError({
        statusCode: 409,
        statusMessage: `待跟進最多 ${MAX_PINNED_CONVERSATIONS} 筆，請先取消一些再標`,
      })
    }
  }

  await ref.update({
    pinnedAt: nextPinned ? FieldValue.serverTimestamp() : FieldValue.delete(),
    pinnedBy: nextPinned ? uid : FieldValue.delete(),
  })

  // 回傳結果狀態，前端不用自己推算（樂觀更新猜錯時能以這個為準修正）
  return { ok: true, userId: convDocId, pinned: nextPinned }
})
