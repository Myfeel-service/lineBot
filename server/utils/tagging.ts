import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import type { UserTagDoc, TagLogDoc, UserTagSourceType } from '~~/shared/types/tag-broadcast'

export interface TaggingResult {
  added: string[]
  skipped: string[]
}

/**
 * 冪等貼標：對單一使用者批次加標籤。
 * - 已存在的 userTag doc（userId_tagId）自動略過，不重複寫入。
 * - 同時寫 tagLogs 供稽核。
 * - 使用 Firestore batch，保證原子性。
 */
export async function addTagsToUser(
  /** Firestore users 主鍵：`${workspaceId}_${lineUserId}` */
  userFirestoreDocId: string,
  tagIds: string[],
  sourceType: UserTagSourceType,
  sourceRefId: string | null,
  workspaceId: string,
): Promise<TaggingResult> {
  if (!userFirestoreDocId || !tagIds.length) return { added: [], skipped: [] }

  const db = getDb()
  const now = FieldValue.serverTimestamp()
  const added: string[] = []
  const skipped: string[] = []
  const batch = db.batch()

  const entries = await Promise.all(
    tagIds.map(async (tagId) => {
      const docId = `${userFirestoreDocId}_${tagId}`
      const ref = db.collection('userTags').doc(docId)
      const snap = await ref.get()
      return { tagId, ref, exists: snap.exists }
    }),
  )

  for (const { tagId, ref, exists } of entries) {
    if (exists) {
      skipped.push(tagId)
      continue
    }

    const userTagDoc: UserTagDoc = {
      workspaceId,
      userId: userFirestoreDocId,
      tagId,
      sourceType,
      sourceRefId,
      createdBy: null,
      createdAt: now,
    }
    batch.set(ref, userTagDoc)

    const logDoc: TagLogDoc = {
      workspaceId,
      action: 'add',
      userId: userFirestoreDocId,
      tagId,
      sourceType,
      sourceRefId,
      operatorId: null,
      createdAt: now,
    }
    batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)

    added.push(tagId)
  }

  if (added.length > 0) {
    await batch.commit()
  }

  return { added, skipped }
}

/**
 * 冪等摘標：對單一使用者批次移除標籤（與 addTagsToUser 成對）。
 * - 本來就沒有的 userTag doc 自動略過。
 * - 同樣寫 tagLogs（action: 'remove'）供稽核——系統自動摘的標要查得到是誰摘的。
 */
export async function removeTagsFromUser(
  /** Firestore users 主鍵：`${workspaceId}_${lineUserId}` */
  userFirestoreDocId: string,
  tagIds: string[],
  sourceType: UserTagSourceType,
  sourceRefId: string | null,
  workspaceId: string,
): Promise<{ removed: string[]; skipped: string[] }> {
  if (!userFirestoreDocId || !tagIds.length) return { removed: [], skipped: [] }

  const db = getDb()
  const now = FieldValue.serverTimestamp()
  const removed: string[] = []
  const skipped: string[] = []
  const batch = db.batch()

  const entries = await Promise.all(
    tagIds.map(async (tagId) => {
      const ref = db.collection('userTags').doc(`${userFirestoreDocId}_${tagId}`)
      const snap = await ref.get()
      return { tagId, ref, exists: snap.exists }
    }),
  )

  for (const { tagId, ref, exists } of entries) {
    if (!exists) {
      skipped.push(tagId)
      continue
    }
    batch.delete(ref)
    const logDoc: TagLogDoc = {
      workspaceId,
      action: 'remove',
      userId: userFirestoreDocId,
      tagId,
      sourceType,
      sourceRefId,
      operatorId: null,
      createdAt: now,
    }
    batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)
    removed.push(tagId)
  }

  if (removed.length > 0) {
    await batch.commit()
  }

  return { removed, skipped }
}
