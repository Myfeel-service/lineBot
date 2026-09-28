import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import type { TagLogDoc } from '~~/shared/types/tag-broadcast'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { recordManualRemovalAsDismissed } from '~~/server/utils/ai-tag-suggest'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { filterWorkspaceTagIds, tagNamesForAudit } from '~~/server/utils/workspace-tag-ids'
import { writeAuditLog } from '~~/server/utils/audit-log'

const FIRESTORE_BATCH_LIMIT = 400

/**
 * POST /api/user-tags/batch-remove
 * 批次移除多位用戶的一或多個標籤
 *
 * Body:
 * {
 *   userIds: string[]
 *   tagIds: string[]
 * }
 *
 * Response:
 * {
 *   total: number
 *   removed: number
 *   notFound: number
 * }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const userIds: string[] = body?.userIds ?? []
  const tagIds: string[] = body?.tagIds ?? []

  if (!userIds.length || !tagIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'userIds and tagIds are required' })
  }

  if (userIds.length > 5000) {
    throw createError({ statusCode: 400, statusMessage: 'userIds must not exceed 5000 per request' })
  }

  const db = getDb()
  const now = FieldValue.serverTimestamp()
  let removed = 0
  let notFound = 0

  let batch = db.batch()
  let opsInBatch = 0

  const flushBatch = async () => {
    if (opsInBatch > 0) {
      await batch.commit()
      batch = db.batch()
      opsInBatch = 0
    }
  }

  for (const userId of userIds) {
    const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
    for (const tagId of tagIds) {
      const docId = `${fsUserDocId}_${tagId}`
      const ref = db.collection('userTags').doc(docId)
      const snap = await ref.get()

      if (!snap.exists || snap.data()?.workspaceId !== workspaceId) {
        notFound++
        continue
      }

      batch.delete(ref)
      opsInBatch++

      // G-107：記下是誰拆的——拆標會直接改變推播對象
      const logDoc: TagLogDoc = {
        workspaceId,
        action: 'remove',
        userId: fsUserDocId,
        tagId,
        sourceType: 'manual',
        sourceRefId: null,
        operatorId: uid,
        createdAt: now,
      }
      batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)
      opsInBatch++
      removed++

      if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
        await flushBatch()
      }
    }
  }

  await flushBatch()

  // 同單筆移除：手動拆掉＝否決票，AI 有在判的標籤記進「永不再提」（防 auto 拉鋸戰）
  if (removed > 0) {
    const fsUserDocIds = userIds.map(id =>
      lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(id, workspaceId), workspaceId))
    await recordManualRemovalAsDismissed(db, workspaceId, fsUserDocIds, tagIds)

    /*
     * 稽核（`G-107`）：同 batch-add——拆標會直接改變推播對象，一次最多 5,000 人。
     * ⚠️ 拆標**不過濾**標籤歸屬：要拆的是自家客人身上的貼標（文件 id 本身就帶帳號前綴、
     *    上面也比對過 workspaceId），修 G-98 之前被貼上的別家標籤也要拆得掉。
     *    這裡查標籤主檔只是為了在紀錄裡寫出名字；查不到就退回 id，⛔ 不讓查名字失敗擋掉回應。
     */
    let names: Record<string, string> = {}
    try {
      names = (await filterWorkspaceTagIds(db, workspaceId, tagIds, { context: 'user-tags/batch-remove 查標籤名' })).names
    }
    catch (e) {
      console.warn('[batch-remove] 查標籤名失敗，紀錄改用 id:', String((e as Error)?.message ?? e).slice(0, 200))
    }
    const tagText = tagNamesForAudit(tagIds, names)
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'userTags.batchRemove',
      after: {
        name: tagText,
        tagIdsCount: tagIds.length,
        usersCount: userIds.length,
        removedCount: removed,
        notFoundCount: notFound,
      },
      note: `幫 ${userIds.length} 位好友拿掉${tagText}：拿掉 ${removed} 筆`
        + `${notFound ? `，本來就沒有的 ${notFound} 筆略過` : ''}`,
    }, db)
  }

  return { total: userIds.length * tagIds.length, removed, notFound }
})
