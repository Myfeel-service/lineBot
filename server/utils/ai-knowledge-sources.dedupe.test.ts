/**
 * 匯入去重（`C-134`）與「更新既有那一份」（`C-135`）的守門測試。
 *
 * 背景：2026-09-04 在 MYFEEL 正式資料上看到同一本 Kieslect 說明書並存三份、45 張重複卡，
 * 三份的產品名還各寫各的。成因是①手動上傳從來沒有內容去重 ②同名警告唯一的建議是
 * 「改個名字」＝把人推去製造第三份。
 *
 * ⚠️ 這裡刻意連「不該做什麼」一起測：空指紋不可以打 Firestore、回收桶的來源不算重複、
 *    已在回收桶的卡不可以再蓋一次軟刪除。這三條錯了都不會有人看見——
 *    畫面照常、錯誤照常沒有，只是資料默默壞掉。
 */
import { describe, expect, it, vi } from 'vitest'
import { findSourceByContentHash, recycleSourceChunks } from './ai-knowledge-sources'

/** 假 Firestore：撐得住 collection().where()×N.limit().get() 與 batch().update()/commit() */
function makeDb(docs: Array<{ id: string; data: Record<string, any> }>) {
  const queries: Array<Array<[string, string, unknown]>> = []
  const updates: Array<{ id: string; payload: Record<string, any> }> = []
  const commits: number[] = []

  function makeQuery(filters: Array<[string, string, unknown]>): any {
    return {
      where: (f: string, op: string, v: unknown) => makeQuery([...filters, [f, op, v]]),
      limit: () => makeQuery(filters),
      get: async () => {
        queries.push(filters)
        const matched = docs.filter(d =>
          filters.every(([f, , v]) => d.data[f] === v),
        )
        return {
          empty: matched.length === 0,
          size: matched.length,
          docs: matched.map(d => ({
            id: d.id,
            data: () => d.data,
            ref: { id: d.id },
          })),
        }
      },
    }
  }

  const db: any = {
    collection: () => makeQuery([]),
    batch: () => {
      const staged: Array<{ id: string; payload: Record<string, any> }> = []
      return {
        update: (ref: { id: string }, payload: Record<string, any>) => staged.push({ id: ref.id, payload }),
        commit: async () => {
          // ⛔ 只有 commit 才算真的寫進去：假 db 沒有這一層的話，「一筆都沒寫」也會全綠
          updates.push(...staged)
          commits.push(staged.length)
        },
      }
    },
  }
  return { db, queries, updates, commits }
}

const WID = 'ws1'

describe('findSourceByContentHash：這份是不是已經匯過了', () => {
  it('同指紋、同型別、還活著 → 認得出來', async () => {
    const { db } = makeDb([
      { id: 's1', data: { workspaceId: WID, appliedContentHash: 'H', type: 'file', name: '說明書.pdf', chunkCount: 15, isDeleted: false } },
    ])
    const hit = await findSourceByContentHash(db, WID, 'H', 'file')
    expect(hit).toMatchObject({ id: 's1', name: '說明書.pdf', chunkCount: 15 })
  })

  it('⛔空指紋一律回 null，而且不可以去打 Firestore（舊資料整批存的就是空字串）', async () => {
    const { db, queries } = makeDb([
      { id: 's1', data: { workspaceId: WID, appliedContentHash: '', type: 'file' } },
      { id: 's2', data: { workspaceId: WID, appliedContentHash: '', type: 'file' } },
    ])
    expect(await findSourceByContentHash(db, WID, '', 'file')).toBeNull()
    expect(await findSourceByContentHash(db, WID, '   ', 'file')).toBeNull()
    expect(queries).toHaveLength(0) // 查了就代表會撈回一整包不相干的來源
  })

  it('已經丟進回收桶的不算重複——刪掉就是想重來一次', async () => {
    const { db } = makeDb([
      { id: 's1', data: { workspaceId: WID, appliedContentHash: 'H', type: 'file', isDeleted: true } },
    ])
    expect(await findSourceByContentHash(db, WID, 'H', 'file')).toBeNull()

    const legacy = makeDb([
      { id: 's2', data: { workspaceId: WID, appliedContentHash: 'H', type: 'file', deletedAt: 123 } },
    ])
    expect(await findSourceByContentHash(legacy.db, WID, 'H', 'file')).toBeNull()
  })

  it('型別不同不算重複（檔案算 bytes、網址算純文字，比中了也沒有意義）', async () => {
    const { db } = makeDb([
      { id: 's1', data: { workspaceId: WID, appliedContentHash: 'H', type: 'url', isDeleted: false } },
    ])
    expect(await findSourceByContentHash(db, WID, 'H', 'file')).toBeNull()
    expect(await findSourceByContentHash(db, WID, 'H', 'url')).toMatchObject({ id: 's1' })
  })

  it('查詢失敗不擋匯入，但一定要留下 log（靜靜失效沒有人會發現）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db: any = { collection: () => ({ where: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('缺索引') } }) }) }) }) }
    expect(await findSourceByContentHash(db, WID, 'H', 'file')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('recycleSourceChunks：更新既有那一份時，舊卡怎麼退場', () => {
  it('活著的卡整批進回收桶，並回報實際張數', async () => {
    const { db, updates, commits } = makeDb([
      { id: 'c1', data: { workspaceId: WID, sourceId: 's1', status: 'indexed' } },
      { id: 'c2', data: { workspaceId: WID, sourceId: 's1', status: 'indexed' } },
      { id: 'c3', data: { workspaceId: WID, sourceId: 's2', status: 'indexed' } }, // 別的來源不能被掃到
    ])
    const n = await recycleSourceChunks(db, WID, 's1')
    expect(n).toBe(2)
    // ⛔ 斷言副作用真的發生：只看回傳值的話，batch 沒 commit 也會綠
    expect(commits).toEqual([2])
    expect(updates.map(u => u.id).sort()).toEqual(['c1', 'c2'])
    for (const u of updates) {
      expect(u.payload.isDeleted).toBe(true)
      expect(u.payload.status).toBe('disabled')
      expect(u.payload.statusBeforeDelete).toBe('indexed') // 還原要回得到刪除前的狀態
    }
  })

  it('⛔已經在回收桶的不再蓋一次（會把 statusBeforeDelete 洗成 disabled，還原時回不到原狀）', async () => {
    const { db, updates } = makeDb([
      { id: 'c1', data: { workspaceId: WID, sourceId: 's1', status: 'indexed' } },
      { id: 'c2', data: { workspaceId: WID, sourceId: 's1', status: 'disabled', deletedAt: 1, statusBeforeDelete: 'indexed' } },
    ])
    expect(await recycleSourceChunks(db, WID, 's1')).toBe(1)
    expect(updates.map(u => u.id)).toEqual(['c1'])
  })

  it('沒有卡片時不開 batch（零卡的來源不該產生一次空寫入）', async () => {
    const { db, commits } = makeDb([])
    expect(await recycleSourceChunks(db, WID, 's1')).toBe(0)
    expect(commits).toEqual([])
  })

  it('超過 400 張要分批 commit（單一 batch 上限 500，超過是整批失敗不是部分成功）', async () => {
    const many = Array.from({ length: 901 }, (_, i) => ({
      id: `c${i}`,
      data: { workspaceId: WID, sourceId: 's1', status: 'indexed' },
    }))
    const { db, commits, updates } = makeDb(many)
    expect(await recycleSourceChunks(db, WID, 's1')).toBe(901)
    expect(commits).toEqual([400, 400, 101])
    expect(updates).toHaveLength(901)
  })
})
