/**
 * C-41 到期排程：failed 卡也要一併 disabled。
 *
 * 為什麼：到期當天剛好 embedding 失敗的卡（status=failed），若只搬 activeUntil→expiredAt
 * 不改狀態，十分鐘後 retry 排程把它重試成功就寫回 indexed——而 activeUntil 已被搬走、
 * 這支不會再撈到它第二次 → 過期卡永久復活。這批測試驗「failed 到期＝跟 indexed 一樣下架」。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  buildSourceClearFailure: () => ({}),
  clearSourceFailure: vi.fn(),
  markSourceOutdated: vi.fn(),
}))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-knowledge-autoapply', () => ({ tryAutoApplyMinorChange: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ extractUrlText: vi.fn() }))
vi.mock('./gsheet-sync', () => ({ syncGoogleSheetSource: vi.fn() }))
vi.mock('./webhook-dedup', () => ({ WEBHOOK_EVENT_LOCKS_COLLECTION: 'webhookEventLocks' }))
vi.mock('./line', () => ({ pushMessage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(), notifyOverdueHandoffBatch: vi.fn() }))
vi.mock('./conversation-session', () => ({ closeConversationSession: vi.fn(), handBackSessionToBot: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))

import { expireKnowledgeCards } from './cron-maintenance'

function makeDb(cards: Array<{ id: string; status: string }>) {
  const patches: Array<{ id: string; patch: Record<string, any> }> = []
  const db: any = {
    collection: (col: string) => {
      if (col !== 'knowledgeChunks') throw new Error(`unexpected collection: ${col}`)
      const q: any = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          empty: cards.length === 0,
          docs: cards.map(c => ({
            id: c.id,
            data: () => ({ status: c.status, activeUntil: { __ts: 'past' } }),
            ref: { update: async (patch: Record<string, any>) => { patches.push({ id: c.id, patch }) } },
          })),
        }),
      }
      return q
    },
  }
  return { db, patches }
}

describe('expireKnowledgeCards', () => {
  it('indexed 到期 → disabled（原行為）', async () => {
    const { db, patches } = makeDb([{ id: 'a', status: 'indexed' }])
    const res = await expireKnowledgeCards(db)
    expect(res.expired).toBe(1)
    expect(patches[0]!.patch.status).toBe('disabled')
    expect(patches[0]!.patch.expiredAt).toEqual({ __ts: 'past' })
  })

  it('failed 到期 → 也要 disabled（否則 retry 成功即永久復活）', async () => {
    const { db, patches } = makeDb([{ id: 'b', status: 'failed' }])
    const res = await expireKnowledgeCards(db)
    expect(res.expired).toBe(1)
    expect(patches[0]!.patch.status).toBe('disabled')
  })

  it('pending 放過（幾秒後就 indexed，下輪處理）；disabled 只搬欄位不重複計數', async () => {
    const { db, patches } = makeDb([
      { id: 'p', status: 'pending' },
      { id: 'd', status: 'disabled' },
    ])
    const res = await expireKnowledgeCards(db)
    expect(res.expired).toBe(0)
    // pending 完全不動
    expect(patches.find(x => x.id === 'p')).toBeUndefined()
    // disabled 搬 activeUntil→expiredAt 去重，但不改 status
    const d = patches.find(x => x.id === 'd')!
    expect(d.patch.status).toBeUndefined()
    expect(d.patch.activeUntil).toEqual({ __op: 'del' })
  })
})

describe('purgeRecycledKnowledge（回收桶到期清運）', () => {
  it('兩個 collection 都掃；刪除失敗照實計 failed，不虛報 purged', async () => {
    const { purgeRecycledKnowledge } = await import('./cron-maintenance')
    const deleted: string[] = []
    const makeCol = (col: string, ids: string[], failIds: Set<string>) => {
      const q: any = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          docs: ids.map(id => ({
            ref: {
              delete: async () => {
                if (failIds.has(id)) throw new Error('permission denied')
                deleted.push(`${col}/${id}`)
              },
            },
          })),
        }),
      }
      return q
    }
    const db: any = {
      collection: (col: string) =>
        col === 'knowledgeChunks'
          ? makeCol(col, ['a', 'b'], new Set(['b']))
          : makeCol(col, ['s1'], new Set()),
    }
    const r = await purgeRecycledKnowledge(db)
    expect(r.purged).toBe(2) // a + s1；b 失敗不計
    expect(r.failed).toBe(1)
    expect(deleted).toEqual(['knowledgeChunks/a', 'knowledgeSources/s1'])
  })
})
