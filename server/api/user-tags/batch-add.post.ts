import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import type { UserTagDoc, TagLogDoc } from '~~/shared/types/tag-broadcast'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { prunePendingForAppliedTags } from '~~/server/utils/ai-tag-suggest'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { filterWorkspaceTagIds, tagNamesForAudit } from '~~/server/utils/workspace-tag-ids'
import { writeAuditLog } from '~~/server/utils/audit-log'

const FIRESTORE_BATCH_LIMIT = 400

/**
 * POST /api/user-tags/batch-add
 * 批次對多位用戶加上一或多個標籤
 *
 * Body:
 * {
 *   userIds: string[]   // LINE userIds
 *   tagIds: string[]
 * }
 *
 * Response:
 * {
 *   total: number       // 嘗試寫入筆數（userIds × 這個帳號的 tagIds）
 *   added: number       // 實際新增
 *   skipped: number     // 已存在略過
 *   dropped?: string[]  // 不是這個帳號的標籤（或已不存在），沒貼（G-98）
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

  // G-98：只貼這個帳號自己的標籤（同 users/[id]/tags.post；一顆都不剩就 404，不回「成功 0 筆」）
  const owned = await filterWorkspaceTagIds(db, workspaceId, tagIds, { context: 'user-tags/batch-add' })
  if (!owned.kept.length) {
    throw createError({ statusCode: 404, statusMessage: '找不到這些標籤（可能已被刪除），請重新整理後再選' })
  }

  const now = FieldValue.serverTimestamp()
  let added = 0
  let skipped = 0

  // 分批寫入，避免超過 Firestore 單批 500 筆限制
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
    for (const tagId of owned.kept) {
      const docId = `${fsUserDocId}_${tagId}`
      const ref = db.collection('userTags').doc(docId)
      const snap = await ref.get()

      if (snap.exists) {
        skipped++
        continue
      }

      const userTagDoc: UserTagDoc = {
        userId: fsUserDocId,
        tagId,
        workspaceId,
        sourceType: 'manual',
        sourceRefId: null,
        createdBy: uid,
        createdAt: now,
      }
      batch.set(ref, userTagDoc)
      opsInBatch++

      // G-107：記下是誰貼的（一次最多 5,000 人，推播對象整批跟著變）
      const logDoc: TagLogDoc = {
        workspaceId,
        action: 'add',
        userId: fsUserDocId,
        tagId,
        sourceType: 'manual',
        sourceRefId: null,
        operatorId: uid,
        createdAt: now,
      }
      batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)
      opsInBatch++
      added++

      if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
        await flushBatch()
      }
    }
  }

  await flushBatch()

  // 同 users/[id]/tags.post：貼上去的標籤要從 AI 建議收件匣剪掉，
  // 否則列表那顆「AI 建議」章會為已經做完的決定一直亮著
  if (added > 0) {
    const fsUserDocIds = userIds.map(id =>
      lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(id, workspaceId), workspaceId))
    await prunePendingForAppliedTags(db, workspaceId, fsUserDocIds, owned.kept)

    /*
     * 稽核（`G-107`）：單人貼標是日常、刻意不記；批次一次最多 5,000 人，推播對象整批跟著變，
     * 事後一定會有人問「這批是誰貼的」。
     * ⛔ 摘要式：只記標籤名＋人數，不塞整份名單——名單一長就被截斷、整筆標成 lossy
     *    （見記憶 `project_audit_log_coverage_20260924`）。逐人的明細在 tagLogs（上面已寫 operatorId）。
     * ⛔ 只在真的貼上東西時寫（全部都已經有了就不留噪音，同 batchClose 的規矩）。
     * writeAuditLog 自己吞錯，稽核寫不進去不會讓已經貼好的標籤回 500。
     */
    const tagText = tagNamesForAudit(owned.kept, owned.names)
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'userTags.batchAdd',
      after: {
        name: tagText,
        tagIdsCount: owned.kept.length,
        usersCount: userIds.length,
        addedCount: added,
        skippedCount: skipped,
      },
      note: `幫 ${userIds.length} 位好友貼上${tagText}：新增 ${added} 筆`
        + `${skipped ? `，本來就有的 ${skipped} 筆略過` : ''}`
        + `${owned.dropped.length ? `，${owned.dropped.length} 個標籤不是這個帳號的、沒貼` : ''}`,
    }, db)
  }

  return {
    total: userIds.length * owned.kept.length,
    added,
    skipped,
    ...(owned.dropped.length ? { dropped: owned.dropped.map(d => d.tagId) } : {}),
  }
})
