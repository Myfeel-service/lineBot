import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_DUP_SCANS_COLLECTION } from '~~/server/utils/ai-duplicate-scan'

/**
 * POST /api/ai/knowledge/dup-scan/dismiss  Body: { key }
 * 忽略一組「疑似重複」建議（例：真的是兩台不同機器）。
 * 忽略是永久的（存進 ignoredKeys），之後的掃描不會再報同一組——
 * 不存的話每次重掃都跳同一張臉，狼來了幾次使用者就不看這區了。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'sources.write')
  const body = await readBody(event).catch(() => ({}))
  const key = String(body?.key ?? '').trim()
  if (!key || key.length > 120) throw createError({ statusCode: 400, statusMessage: 'key required' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_DUP_SCANS_COLLECTION).doc(workspaceId)
  const snap = await ref.get()
  const suggestions = Array.isArray((snap.data() as any)?.suggestions) ? (snap.data() as any).suggestions : []
  await ref.set({
    ignoredKeys: FieldValue.arrayUnion(key),
    suggestions: suggestions.filter((s: any) => String(s?.key) !== key),
  }, { merge: true })
  return { ok: true }
})
