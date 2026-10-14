import { describe, expect, it, vi } from 'vitest'

/**
 * 知識庫搜尋（`C-308`⑦，2026-10-13）：「等你看過」的條目搜得到，但以前沒標它還沒上線——
 * 他搜到了以為 AI 會答。釘住：每一筆帶 status（畫面靠它標「等你看過」）、上線的排前面、回收桶的不出現。
 */

let docs: Array<{ id: string, data: Record<string, unknown> }> = []

vi.mock('~~/server/utils/firebase', () => ({
  getDb: () => {
    const chain: Record<string, unknown> = {}
    chain.where = () => chain
    chain.select = () => chain
    chain.limit = () => chain
    chain.get = async () => ({ size: docs.length, docs: docs.map(d => ({ id: d.id, data: () => d.data })) })
    return { collection: () => chain }
  },
}))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: 'ws1' })) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))

let q = ''
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => ({ q }))

const { default: handler } = await import('./search.get')
type Res = { items: Array<{ id: string, status: string }> }
const search = (text: string) => {
  q = text
  return (handler as unknown as (e: unknown) => Promise<Res>)({})
}

describe('知識庫搜尋', () => {
  it('「等你看過」的照樣搜得到，但帶著 status=draft，而且排在上線的後面（就算它標題命中、上線的只命中內容）', async () => {
    docs = [
      { id: 'd1', data: { title: '運費多少', content: '滿千免運', status: 'draft' } },
      { id: 'l1', data: { title: '出貨說明', content: '運費一律 80 元', status: 'indexed' } },
    ]
    const res = await search('運費')
    expect(res.items.map(i => i.id)).toEqual(['l1', 'd1'])
    expect(res.items.find(i => i.id === 'd1')!.status).toBe('draft')
    expect(res.items.find(i => i.id === 'l1')!.status).toBe('indexed')
  })

  it('同一組裡照命中位置排（標題 > 客人問法 > 內容）', async () => {
    docs = [
      { id: 'c', data: { title: 'A', content: '運費', status: 'indexed' } },
      { id: 't', data: { title: '運費', content: 'x', status: 'indexed' } },
    ]
    expect((await search('運費')).items.map(i => i.id)).toEqual(['t', 'c'])
  })

  it('回收桶的不出現：舊資料只有 deletedAt、新資料有 isDeleted，兩種都認', async () => {
    docs = [
      { id: 'old', data: { title: '運費', content: '', status: 'disabled', deletedAt: { seconds: 1 } } },
      { id: 'new', data: { title: '運費', content: '', status: 'disabled', isDeleted: true } },
      { id: 'ok', data: { title: '運費', content: '', status: 'indexed' } },
    ]
    expect((await search('運費')).items.map(i => i.id)).toEqual(['ok'])
  })
})
