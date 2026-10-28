import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))

import { findPreviousSameAudienceOpen } from './broadcast-previous-open'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 4, 4)
const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms })

/** 假 broadcasts 查詢：記下每一步條件，回固定的 docs */
function fakeDb(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  const calls: Array<[string, ...unknown[]]> = []
  const q: any = {
    where: (...a: unknown[]) => { calls.push(['where', ...a]); return q },
    orderBy: (...a: unknown[]) => { calls.push(['orderBy', ...a]); return q },
    limit: (...a: unknown[]) => { calls.push(['limit', ...a]); return q },
    select: (...a: unknown[]) => { calls.push(['select', ...a]); return q },
    get: async () => ({ docs: docs.map(d => ({ id: d.id, data: () => d.data })) }),
  }
  const db: any = { collection: vi.fn((name: string) => { calls.push(['collection', name]); return q }) }
  return { db, calls }
}

const tags = { type: 'tags', tagIds: ['t-slide'] }

describe('findPreviousSameAudienceOpen', () => {
  it('用現成索引（workspaceId＋createdAt 由新到舊）、只撈發完之前建立的、有上限、只讀要的欄位', async () => {
    const { db, calls } = fakeDb([])
    await findPreviousSameAudienceOpen(db, { id: 'cur', workspaceId: 'ws1', audienceSource: tags as any, completedMs: T0 })
    expect(calls).toContainEqual(['collection', 'broadcasts'])
    expect(calls).toContainEqual(['where', 'workspaceId', '==', 'ws1'])
    expect(calls).toContainEqual(['where', 'createdAt', '<', { __ms: T0 }])
    expect(calls).toContainEqual(['orderBy', 'createdAt', 'desc'])
    const limit = calls.find(c => c[0] === 'limit')
    expect(Number(limit?.[1])).toBeLessThanOrEqual(30)
    const select = calls.find(c => c[0] === 'select')!
    expect(select).not.toContain('audienceSource') // ⛔ 整包 audienceSource 會連匯入名單一起讀
    expect(select).toContain('audienceSource.tagIds')
  })

  it('匯入名單 → 一筆都不讀', async () => {
    const { db } = fakeDb([])
    const got = await findPreviousSameAudienceOpen(db, { id: 'cur', workspaceId: 'ws1', audienceSource: { type: 'import' } as any, completedMs: T0 })
    expect(got).toBeNull()
    expect(db.collection).not.toHaveBeenCalled()
  })

  it('從存下來的 LINE 數字算上一則的打開比例；沒帶到統計標記的當作沒有打開數', async () => {
    const prev = { name: '小滑手_開賣', status: 'completed', audienceSource: tags, sentCount: 2187, completedAt: ts(T0 - 5 * DAY) }
    const ok = fakeDb([{ id: 'p', data: { ...prev, lineStats: { opened: 786, clicked: 443, round: 3 } } }])
    expect(await findPreviousSameAudienceOpen(ok.db, { id: 'cur', workspaceId: 'ws1', audienceSource: tags as any, completedMs: T0 }))
      .toMatchObject({ name: '小滑手_開賣', openRate: 0.3594 })

    const skipped = fakeDb([{ id: 'p', data: { ...prev, lineStats: { opened: null, clicked: null, round: 0, unavailable: true } } }])
    expect(await findPreviousSameAudienceOpen(skipped.db, { id: 'cur', workspaceId: 'ws1', audienceSource: tags as any, completedMs: T0 })).toBeNull()
  })
})
