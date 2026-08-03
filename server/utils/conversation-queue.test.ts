import { describe, expect, it } from 'vitest'
import { isOpenQueueSession, scanFilteredPage } from './conversation-queue'

describe('isOpenQueueSession(未首接佇列成員判定)', () => {
  it('活動/加好友出生、客人還沒開口 → 不佔佇列', () => {
    expect(isOpenQueueSession({ origin: 'follow', hasInbound: false })).toBe(false)
    expect(isOpenQueueSession({ origin: 'follow' })).toBe(false)
  })

  it('客人開口後 → 回歸佇列', () => {
    expect(isOpenQueueSession({ origin: 'follow', hasInbound: true })).toBe(true)
  })

  it('客人來訊出生 → 佔佇列', () => {
    expect(isOpenQueueSession({ origin: 'message', hasInbound: true })).toBe(true)
  })

  it('舊資料(沒有 origin/hasInbound 欄位)→ 保留在佇列,不被計數端的 hasInbound==false 扣除弄消失', () => {
    // 這一條是列表端與計數端等價的關鍵：兩邊都保留缺欄位的舊資料
    expect(isOpenQueueSession({})).toBe(true)
    expect(isOpenQueueSession(undefined)).toBe(true)
  })
})

// ── scanFilteredPage:用假 Query 重現「30 筆裡 27 筆被砍剩 3 筆」的情境 ──
interface FakeDoc { data: () => { keep: boolean; n: number } }

/** ratio=每幾筆有 1 筆合格(ratio=10 → 10% 合格,對應現場活動流量壓垮第一頁的比例) */
function fakeQuery(totalDocs: number, ratio: number) {
  let reads = 0
  const all: FakeDoc[] = Array.from({ length: totalDocs }, (_, i) => ({
    data: () => ({ keep: i % ratio === 0, n: i }),
  }))

  const make = (from: number) => ({
    limit(n: number) {
      const slice = all.slice(from, from + n)
      return {
        startAfter(cursor: FakeDoc) {
          const idx = all.indexOf(cursor)
          return make(idx + 1).limit(n)
        },
        get: async () => {
          reads += slice.length
          return { empty: slice.length === 0, docs: slice }
        },
      }
    },
  })

  return { query: make(0), reads: () => reads }
}

describe('scanFilteredPage(過濾放在分頁之前)', () => {
  const keep = (d: { keep: boolean }) => d.keep

  it('合格率只有 10% 時,第一頁仍給滿 30 筆(修好前只會剩 3 筆)', async () => {
    const { query } = fakeQuery(5000, 10)
    const r = await scanFilteredPage<FakeDoc>(query as any, keep, 0, 30)
    expect(r.docs).toHaveLength(30)
    expect(r.hasMore).toBe(true)
    expect(r.truncated).toBe(false)
  })

  it('回傳的是合格文件本身,且順序照原順序', async () => {
    const { query } = fakeQuery(5000, 10)
    const r = await scanFilteredPage<FakeDoc>(query as any, keep, 0, 5)
    expect(r.docs.map(d => d.data().n)).toEqual([0, 10, 20, 30, 40])
  })

  it('offset 是「跳過幾筆合格的」,不是跳過幾筆原始資料 → 分頁不重複不漏', async () => {
    const { query } = fakeQuery(5000, 10)
    const p1 = await scanFilteredPage<FakeDoc>(query as any, keep, 0, 30)
    const p2 = await scanFilteredPage<FakeDoc>(query as any, keep, 30, 30)
    const ids1 = p1.docs.map(d => d.data().n)
    const ids2 = p2.docs.map(d => d.data().n)
    expect(new Set([...ids1, ...ids2]).size).toBe(60)
    expect(Math.max(...ids1)).toBeLessThan(Math.min(...ids2))
  })

  it('掃到底且剛好取完 → hasMore=false(不會讓前端一直往下撈空頁)', async () => {
    const { query } = fakeQuery(100, 10) // 100 筆裡 10 筆合格
    const r = await scanFilteredPage<FakeDoc>(query as any, keep, 0, 30)
    expect(r.docs).toHaveLength(10)
    expect(r.hasMore).toBe(false)
  })

  it('最後一頁剛好取完 → hasMore=false', async () => {
    const { query } = fakeQuery(100, 10)
    const r = await scanFilteredPage<FakeDoc>(query as any, keep, 5, 5)
    expect(r.docs).toHaveLength(5)
    expect(r.hasMore).toBe(false)
  })

  it('完全沒有合格資料 → 空陣列且 hasMore=false', async () => {
    const { query } = fakeQuery(50, 10)
    const r = await scanFilteredPage<FakeDoc>(query as any, () => false, 0, 30)
    expect(r.docs).toHaveLength(0)
    expect(r.hasMore).toBe(false)
  })

  it('湊滿一頁就停,不會把整個 collection 撈完', async () => {
    const { query, reads } = fakeQuery(100000, 10)
    await scanFilteredPage<FakeDoc>(query as any, keep, 0, 30)
    expect(reads()).toBeLessThanOrEqual(300) // 一輪 SCAN_BATCH 就夠
  })

  it('合格率極低時掃到上限就收手,並標記 truncated', async () => {
    const { query, reads } = fakeQuery(100000, 100000) // 只有第 0 筆合格
    const r = await scanFilteredPage<FakeDoc>(query as any, keep, 0, 30)
    expect(r.docs).toHaveLength(1)
    expect(r.truncated).toBe(true)
    expect(reads()).toBeLessThanOrEqual(6000)
  })
})
