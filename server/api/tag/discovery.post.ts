import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { addTagsToUser } from '~~/server/utils/tagging'
import { TAG_DISCOVERY_COLLECTION } from '~~/server/utils/tag-discovery'
import {
  DISCOVERY_CATEGORY_COLORS,
  MAX_DISMISSED_NAMES,
  sanitizeTagCode,
  type TagDiscoveryDoc,
  type TagDiscoveryProposal,
} from '~~/shared/tag-discovery'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

/**
 * POST /api/tag/discovery — 對一條「AI 發現的新標籤」提案做決定
 *
 * Body: { action: 'adopt' | 'dismiss', proposalId: string }
 *
 * adopt＝建立標籤（aiMode 一律 'suggest'＝先建議，同範本原則：跑準了再自行升 auto）
 *        ＋直接幫「聊過這個主題的那批客人」貼上（sourceType 'ai'，tagLogs 有紀錄、可撤）。
 *        貼這批人不再逐一問過：他們就是提案的證據本身（真的聊過才進名單）。
 * dismiss＝從收件匣移除並記進 dismissedNames——之後的掃描永不再提（含同義）。
 *
 * ⛔ 提案的認領走 transaction：兩個管理員同時按「建立」，只有一個成功，
 *    否則同一個主題會長出兩顆同名標籤。
 */
export default defineEventHandler(async (event) => {
  const { uid, workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const action = String(body?.action ?? '')
  const proposalId = String(body?.proposalId ?? '').trim()
  if ((action !== 'adopt' && action !== 'dismiss') || !proposalId) {
    throw createError({ statusCode: 400, statusMessage: 'action(adopt|dismiss) 與 proposalId 必填' })
  }

  const db = getDb()
  const docRef = db.collection(TAG_DISCOVERY_COLLECTION).doc(workspaceId)

  // ── 認領：transaction 內把提案從 pending 摘走 ──────────────────
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef)
    const doc = (snap.data() ?? null) as TagDiscoveryDoc | null
    const pending = Array.isArray(doc?.pending) ? doc!.pending : []
    const target = pending.find(p => p.id === proposalId)
    if (!target) return null

    const patch: Record<string, unknown> = {
      pending: pending.filter(p => p.id !== proposalId),
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (action === 'dismiss') {
      // 否決名單 FIFO 上限：塞爆文件比漏擋一個舊主題更糟
      const dismissed = Array.isArray(doc?.dismissedNames) ? doc!.dismissedNames : []
      patch.dismissedNames = [...dismissed, target.name].slice(-MAX_DISMISSED_NAMES)
    }
    tx.set(docRef, patch, { merge: true })
    return target
  })

  if (!claimed) {
    throw createError({ statusCode: 404, statusMessage: '這條建議已被處理過（可能是同事剛按掉了）' })
  }
  if (action === 'dismiss') return { dismissed: true }

  // ── adopt：建標籤 ────────────────────────────────────────────
  const tag = await createTagFromProposal(db, workspaceId, uid, claimed)

  // 幫聊過的那批客人貼上。⛔ 單人失敗不整批放棄：貼標是冪等的（addTagsToUser 會略過已存在），
  // 剩下沒貼到的頂多少幾位，比「標籤建了卻回 500」好收拾
  let tagged = 0
  const userDocIds = Array.isArray(claimed.userDocIds) ? claimed.userDocIds : []
  for (let i = 0; i < userDocIds.length; i += 10) {
    const chunk = userDocIds.slice(i, i + 10)
    const results = await Promise.all(chunk.map(userDocId =>
      addTagsToUser(userDocId, [tag.id], 'ai', 'tag-discovery', workspaceId)
        .then(r => r.added.length)
        .catch((e) => { console.warn('[tag-discovery] apply failed:', userDocId, e); return 0 }),
    ))
    tagged += results.reduce((a, b) => a + b, 0)
  }

  return { created: { id: tag.id, name: tag.name }, tagged, proposed: userDocIds.length }
})

/** 建立標籤（code 唯一性在這裡守：提案的 code 撞號就加序號，再不行退回隨機尾碼） */
async function createTagFromProposal(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  uid: string,
  proposal: TagDiscoveryProposal,
) {
  const base = sanitizeTagCode(proposal.code) || `ai_found_${uuidv4().slice(0, 8)}`
  let code = base
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.collection('tags')
      .where('workspaceId', '==', workspaceId)
      .where('code', '==', code)
      .limit(1)
      .get()
    if (existing.empty) break
    code = attempt < 1 ? `${base}_2` : `${base}_${uuidv4().slice(0, 6)}`
  }

  const id = uuidv4()
  const now = FieldValue.serverTimestamp()
  const doc: TagDoc = {
    workspaceId,
    code,
    name: proposal.name,
    category: proposal.category,
    color: DISCOVERY_CATEGORY_COLORS[proposal.category] ?? '#6B7280',
    description: proposal.usage || proposal.reason || '',
    aiMode: 'suggest', // 先建議、人工把關；跑準了老闆自己升 auto（同範本原則）
    aiCriteria: proposal.criteria,
    status: 'active',
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  }
  await db.collection('tags').doc(id).set(doc)
  return { id, name: proposal.name }
}
