import { v4 as uuidv4 } from 'uuid'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { newBroadcastDraftDoc } from '~~/server/utils/broadcast-draft'

/**
 * POST /api/broadcast/:id/duplicate
 * 把一則推播（任何狀態，已發送的也可以）複製成一則新草稿。
 *
 * ⭐ **照存好的那一份原樣複製，不經過編輯器**：編輯器只認得「一則文字／一張按鈕卡」，
 *    舊推播若存了好幾則或圖片，從畫面重組會只剩第一則、其餘默默掉了。
 *    （所以畫面上有沒存的修改時，前端會先叫他存。）
 *
 * 帶過去的：名稱加「(複製)」、發送對象、訊息內容、發完貼的記號。
 * ⛔ 不帶的：
 *   - 排程時間、受眾快照、發送結果、當時送出去的那一份（`sentContent`）——那是原本那則的歷史。
 *   - 節慶記號（`festivalId`）：那是「原本那則為哪一檔發的」來歷。檔期回顧只要看到一則有記號
 *     就只算有記號的，複製品拿去發明年的同一檔或別的用途，帶著它就會算進錯的那一檔。
 *
 * Response: BroadcastDoc & { id: string }
 */
export default defineEventHandler(async (event) => {
  const { uid, workspaceId } = await requireCapability(event, 'broadcast.write')

  const sourceId = getRouterParam(event, 'id')
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const snap = await db.collection('broadcasts').doc(sourceId).get()
  const src = snap.exists ? snap.data()! : null
  // ⛔ 別家的跟不存在的一樣回 404，不告訴對方「別家有這一則」
  if (!src || src.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到這則推播，可能已經被刪掉了' })
  }

  const messages = Array.isArray(src.messages) ? src.messages : []
  if (!messages.length || !src.audienceSource?.type) {
    throw createError({ statusCode: 400, statusMessage: '這則推播沒有內容或發送對象，沒辦法複製' })
  }

  const id = uuidv4()
  const doc = newBroadcastDraftDoc({
    workspaceId,
    uid,
    name: `${String(src.name ?? '').trim() || '(未命名)'} (複製)`,
    audienceSource: src.audienceSource,
    messages,
    completionTagIds: Array.isArray(src.completionTagIds) ? src.completionTagIds : [],
  })
  await db.collection('broadcasts').doc(id).set(doc)

  // 稽核：記下從哪一則複製來的（「怎麼多了一則一模一樣的推播」要查得到）
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'broadcast.duplicate',
    targetId: id,
    after: { name: doc.name, copiedFromId: sourceId, audienceSource: src.audienceSource.type },
    note: String(src.name ?? ''),
  }, db)

  return { id, ...doc }
})
