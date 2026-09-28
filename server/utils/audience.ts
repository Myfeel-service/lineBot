import { getDb } from './firebase'
import type { AudienceFilter } from '~~/shared/types/tag-broadcast'

/**
 * 依 AudienceFilter 條件解析出符合的 LINE userIds。
 *
 * 目前支援的條件：
 *  - conditions: includeAny / includeAll / excludeAny（基於 userTags 集合）
 *  - joinedAfter / joinedBefore（基於 users.createdAt）
 *
 * Phase 2 可擴充：isBlocked、最近互動時間、行為事件等。
 *
 * ⛔ 一定要帶 workspaceId（`G-104`①）：下面每一段都是 `if (workspaceId)` 才加帳號過濾，
 *    空字串進來就是**全站**名單（`/api/audience/estimate` 曾因超管沒帶帳號回全站人數）。
 *    守門那邊已經改成沒帶就 400，這裡再擋一次，⛔ 不要靠呼叫端記得。
 */
export async function resolveAudienceUserIds(filter: AudienceFilter, workspaceId: string): Promise<string[]> {
  if (!String(workspaceId ?? '').trim()) {
    throw new Error('resolveAudienceUserIds: workspaceId is required（不帶帳號會變成全站名單）')
  }
  const db = getDb()

  // ── Step 1: 從 includeAny / includeAll 條件取候選 userIds ──────────
  const includeAny = filter.conditions.filter((c) => c.type === 'includeAny')
  const includeAll = filter.conditions.filter((c) => c.type === 'includeAll')
  const excludeAny = filter.conditions.filter((c) => c.type === 'excludeAny')

  let candidateIds: Set<string> | null = null

  // includeAny：有任一標籤即納入
  for (const cond of includeAny) {
    if (!cond.tagIds.length) continue
    let query = db.collection('userTags').where('tagId', 'in', cond.tagIds.slice(0, 30))
    if (workspaceId) query = query.where('workspaceId', '==', workspaceId) as any
    const snap = await query.get()
    const ids = new Set(snap.docs.map((d) => d.data().userId as string))

    if (candidateIds === null) {
      candidateIds = ids
    }
    else {
      for (const id of ids) candidateIds.add(id)
    }
  }

  // includeAll：需要擁有所有指定標籤
  for (const cond of includeAll) {
    if (!cond.tagIds.length) continue

    // 每個 tagId 查一次，取交集
    const snaps = await Promise.all(
      cond.tagIds.map((tagId) => {
        let query = db.collection('userTags').where('tagId', '==', tagId)
        if (workspaceId) query = query.where('workspaceId', '==', workspaceId) as any
        return query.get()
      }),
    )

    const sets = snaps.map((s) => new Set(s.docs.map((d) => d.data().userId as string)))
    const intersection = sets.reduce<Set<string> | null>((acc, set) => {
      if (acc === null) return set
      return new Set([...acc].filter((id) => set.has(id)))
    }, null) ?? new Set()

    if (candidateIds === null) {
      candidateIds = intersection
    }
    else {
      for (const id of [...candidateIds]) {
        if (!intersection.has(id)) candidateIds.delete(id)
      }
    }
  }

  // 若沒有 include 條件，預設取全部用戶（type === 'all' 情況）
  if (candidateIds === null) {
    let query = db.collection('users') as FirebaseFirestore.Query
    if (workspaceId) query = query.where('workspaceId', '==', workspaceId)
    const snap = await query.get()
    candidateIds = new Set(
      snap.docs.filter((d) => d.data().isBlocked !== true).map((d) => d.id),
    )
  }

  // ── Step 2: 排除 excludeAny ────────────────────────────────────────
  for (const cond of excludeAny) {
    if (!cond.tagIds.length) continue
    let query = db.collection('userTags').where('tagId', 'in', cond.tagIds.slice(0, 30))
    if (workspaceId) query = query.where('workspaceId', '==', workspaceId) as any
    const snap = await query.get()
    for (const d of snap.docs) {
      candidateIds.delete(d.data().userId as string)
    }
  }

  // ── Step 3: 依加入時間 / 封鎖狀態過濾 ─────────────────────────────
  const needUserFetch = filter.joinedAfter || filter.joinedBefore || filter.isBlocked !== null
  if (needUserFetch) {
    const userIds = [...candidateIds]
    const CHUNK = 30
    const filtered: string[] = []

    for (let i = 0; i < userIds.length; i += CHUNK) {
      const chunk = userIds.slice(i, i + CHUNK)
      const snap = await db.collection('users')
        .where('__name__', 'in', chunk)
        .get()

      for (const doc of snap.docs) {
        const d = doc.data()
        // isBlocked 過濾（null = 不限制）
        if (filter.isBlocked === false && d.isBlocked === true) continue
        if (filter.isBlocked === true && d.isBlocked !== true) continue
        const createdAt = d.createdAt?.toDate?.()
        if (filter.joinedAfter || filter.joinedBefore) {
          if (!createdAt) continue
          if (filter.joinedAfter && createdAt < new Date(filter.joinedAfter)) continue
          if (filter.joinedBefore && createdAt > new Date(filter.joinedBefore)) continue
        }
        filtered.push(doc.id)
      }
    }

    candidateIds = new Set(filtered)
  }

  return [...candidateIds]
}

/**
 * 估算受眾人數（不回傳完整名單，效能較快）
 * 目前直接呼叫 resolveAudienceUserIds，Phase 2 可改用 count() 優化。
 */
export async function estimateAudienceCount(filter: AudienceFilter, workspaceId: string): Promise<number> {
  const ids = await resolveAudienceUserIds(filter, workspaceId)
  return ids.length
}
