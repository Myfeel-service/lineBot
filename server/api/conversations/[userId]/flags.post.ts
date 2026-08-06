import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { MAX_PINNED_CONVERSATIONS, readConversationFlags } from '~~/shared/conversation-flags'

/**
 * POST /api/conversations/:userId/flags
 * Body: { pinned?: boolean, followUp?: boolean }（兩個都選填，至少要有一個）
 *
 * 對話列表右鍵的兩個人工標記。全 workspace 共用（誰標記的同事都看得到），
 * 只影響列表排序與顯示，**不動會話狀態、不進統計** —— 原因見 ~~/shared/conversation-flags.ts。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')

  const userId = String(getRouterParam(event, 'userId') ?? '').trim()
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const body = await readBody(event)
  const nextPinned = typeof body?.pinned === 'boolean' ? body.pinned as boolean : null
  const nextFollowUp = typeof body?.followUp === 'boolean' ? body.followUp as boolean : null
  if (nextPinned === null && nextFollowUp === null) {
    throw createError({ statusCode: 400, statusMessage: 'pinned 或 followUp 至少要帶一個' })
  }

  const db = getDb()
  // 與 ai-feedback 同一個正規化：算不出同一個 doc id 就會標到別筆（或標了讀不回來）
  const convDocId = lineUserFirestoreDocId(userId, workspaceId)
  const ref = db.collection('conversations').doc(convDocId)
  const snap = await ref.get()
  const data = snap.data() as { workspaceId?: string; pinnedAt?: unknown; followUpAt?: unknown } | undefined
  if (!snap.exists || data?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  const current = readConversationFlags(data)

  // 釘選上限只在「從沒釘變成釘」時檢查：已經釘著的重複送出不該被自己擋下來
  if (nextPinned === true && !current.pinned) {
    const pinnedCount = await countPinned(db, workspaceId)
    if (pinnedCount !== null && pinnedCount >= MAX_PINNED_CONVERSATIONS) {
      throw createError({
        statusCode: 409,
        statusMessage: `釘選最多 ${MAX_PINNED_CONVERSATIONS} 筆，請先取消一些再釘`,
      })
    }
  }

  const updates: Record<string, unknown> = {}
  if (nextPinned !== null) {
    updates.pinnedAt = nextPinned ? FieldValue.serverTimestamp() : FieldValue.delete()
    updates.pinnedBy = nextPinned ? uid : FieldValue.delete()
  }
  if (nextFollowUp !== null) {
    updates.followUpAt = nextFollowUp ? FieldValue.serverTimestamp() : FieldValue.delete()
    updates.followUpBy = nextFollowUp ? uid : FieldValue.delete()
  }
  await ref.update(updates)

  // 回傳結果狀態，前端不用自己推算（樂觀更新猜錯時能以這個為準修正）
  return {
    ok: true,
    userId: convDocId,
    pinned: nextPinned ?? current.pinned,
    followUp: nextFollowUp ?? current.followUp,
  }
})

/** 目前釘選幾筆；缺複合索引時回 null（＝這次不檢查上限，不要因此擋住釘選） */
async function countPinned(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<number | null> {
  try {
    const snap = await db.collection('conversations')
      .where('workspaceId', '==', workspaceId)
      .orderBy('pinnedAt', 'desc')
      .count()
      .get()
    return snap.data().count
  }
  catch (e: any) {
    console.warn('[conversations/flags] 釘選數量查詢失敗，略過上限檢查:', String(e?.message || '').slice(0, 200))
    return null
  }
}
