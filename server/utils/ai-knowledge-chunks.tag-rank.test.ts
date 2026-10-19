/**
 * `C-307`①：問題裡有型號時，標了那個型號的卡要**照跟問題的相似度**挑，不是照存放順序拿前 3 條。
 *
 * 考卷 Q63「飛利浦HD7000 煮飯但是底部整個黏鍋」：說明書幾十條都標了 HD7000，以前拿到的是排最前面的
 * 「限用物質」那幾條（直接給 0.95 高信心），黏鍋、焦掉那兩條反而沒進來 → 轉真人。
 * 假資料庫照 Firestore 的形狀回：tag 索引那一次查詢（where/select/limit/get）＋ getAll 讀整張卡（含向量）。
 */
import { describe, expect, it } from 'vitest'
import { cosineSimilarity, searchChunksByIdentifierTag, TAG_MATCH_SIMILARITY, TAG_RANK_MAX_CANDIDATES } from './ai-knowledge-chunks'

interface FakeCard { id: string; title: string; tags: string[]; embedding: number[] | null; status?: string }

/** 存放順序＝陣列順序（tag 索引照這個順序回） */
function fakeDb(cards: FakeCard[]) {
  const reads: string[] = []
  const query = {
    where: () => query,
    select: () => query,
    limit: () => query,
    get: async () => ({ docs: cards.map(c => ({ id: c.id, data: () => ({ tags: c.tags }) })) }),
  }
  const db = {
    collection: () => ({ ...query, doc: (id: string) => ({ id }) }),
    getAll: async (...refs: Array<{ id: string }>) => refs.map((r) => {
      reads.push(r.id)
      const c = cards.find(x => x.id === r.id)!
      return {
        id: c.id,
        exists: true,
        data: () => ({
          title: c.title, content: `${c.title} 的內容`, tags: c.tags, status: c.status ?? 'indexed',
          sourceId: 'p_manual', embedding: c.embedding ? { toArray: () => c.embedding } : null,
        }),
      }
    }),
  }
  return { db: db as any, reads }
}

/** 問題的向量＝[1,0,0]；跟它越像的卡第一維越大 */
const Q = [1, 0, 0]
const MANUAL: FakeCard[] = [
  { id: 'material', title: '限用物質含有情況', tags: ['HD7000'], embedding: [0, 1, 0] },
  { id: 'package', title: '包裝內容', tags: ['HD7000'], embedding: [0.1, 1, 0] },
  { id: 'spec', title: '產品規格', tags: ['HD7000'], embedding: [0.2, 1, 0] },
  { id: 'stick', title: '煮飯底部黏鍋', tags: ['HD7000'], embedding: [1, 0.1, 0] },
  { id: 'burn', title: '飯焦掉', tags: ['HD7000'], embedding: [0.9, 0.3, 0] },
  { id: 'nofit', title: '別台型號', tags: ['GL5680'], embedding: [1, 0, 0] },
]
let ws = 0
const nextWs = () => `ws-tag-${++ws}` // tag 索引有 60 秒快取，每題換一個工作區

describe('searchChunksByIdentifierTag 照相似度挑（C-307①）', () => {
  it('🔴 帶這句的向量 → 挑跟問題最像的那幾條（黏鍋、焦掉），不是排最前面的「限用物質」', async () => {
    const { db } = fakeDb(MANUAL)
    const hits = await searchChunksByIdentifierTag(db, nextWs(), '飛利浦HD7000 煮飯但是底部整個黏鍋', 3, Q)

    expect(hits.map(h => h.id)).toEqual(['stick', 'burn', 'spec'])
    // 仍是高信心（型號對上了），照相似度遞減，排序才看得出哪條最相關
    expect(hits[0]!.similarity).toBe(TAG_MATCH_SIMILARITY)
    expect(hits[1]!.similarity).toBeLessThan(hits[0]!.similarity)
    expect(hits[2]!.similarity).toBeLessThan(hits[1]!.similarity)
    expect(hits.every(h => h.similarity > 0.9)).toBe(true)
    // 沒標這個型號的卡不會混進來
    expect(hits.some(h => h.id === 'nofit')).toBe(false)
  })

  it('沒帶向量＝舊行為（照存放順序、全部 0.95），留給不需要排序的呼叫端', async () => {
    const { db, reads } = fakeDb(MANUAL)
    const hits = await searchChunksByIdentifierTag(db, nextWs(), 'HD7000 黏鍋', 3)
    expect(hits.map(h => h.id)).toEqual(['material', 'package', 'spec'])
    expect(hits.every(h => h.similarity === TAG_MATCH_SIMILARITY)).toBe(true)
    expect(reads).toHaveLength(3)
  })

  it('卡上沒有向量的排到最後（不會因為沒向量就被挑中）', async () => {
    const { db } = fakeDb([
      { id: 'novec', title: '沒有向量', tags: ['HD7000'], embedding: null },
      { id: 'weak', title: '不太像', tags: ['HD7000'], embedding: [0.1, 1, 0] },
    ])
    const hits = await searchChunksByIdentifierTag(db, nextWs(), 'HD7000', 1, Q)
    expect(hits.map(h => h.id)).toEqual(['weak'])
  })

  it('候選有上限：一個很常見的型號不會一題讀上百張', async () => {
    const many: FakeCard[] = Array.from({ length: TAG_RANK_MAX_CANDIDATES + 20 }, (_, i) => (
      { id: `c${i}`, title: `第 ${i} 條`, tags: ['HD7000'], embedding: [0, 1, 0] }
    ))
    const { db, reads } = fakeDb(many)
    await searchChunksByIdentifierTag(db, nextWs(), 'HD7000', 3, Q)
    expect(reads).toHaveLength(TAG_RANK_MAX_CANDIDATES)
  })

  it('cosineSimilarity：長度不同、零向量回 -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(-1)
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(-1)
  })
})
