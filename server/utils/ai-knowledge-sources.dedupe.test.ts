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
import { findSourceByContentHash, listSources, recycleSourceChunks } from './ai-knowledge-sources'

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

/**
 * `C-137`：清單主查詢掛掉時不可以默默少掉一批來源。
 *
 * 2026-09-04 線上事故的形狀——`isDeleted == false` ＋ `orderBy updatedAt` 需要一支
 * 複合索引，那支索引從來沒部署，主查詢在正式環境一直是 FAILED_PRECONDITION，
 * 而舊版把錯誤整個吞掉。結果：8/19 之後每一份透過匯入建立的來源（都帶 `isDeleted: false`）
 * 都不在清單上，畫面卻長得完全正常。老闆因此以為說明書沒上傳成功，連傳三次。
 */
describe('listSources：主查詢掛掉時的降級行為（C-137）', () => {
  /** 兩支查詢的假 Firestore：第一支（帶 isDeleted）可指定成拋錯 */
  function makeListDb(docs: Array<{ id: string; data: any }>, freshThrows: boolean) {
    function q(filters: Array<[string, string, unknown]>): any {
      return {
        where: (f: string, op: string, v: unknown) => q([...filters, [f, op, v]]),
        orderBy: () => q(filters),
        limit: () => q(filters),
        get: async () => {
          const hasIsDeleted = filters.some(([f]) => f === 'isDeleted')
          if (hasIsDeleted && freshThrows) {
            throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 })
          }
          const matched = docs.filter(d => filters.every(([f, , v]) => d.data[f] === v))
          return { size: matched.length, docs: matched.map(d => ({ id: d.id, data: () => d.data })) }
        },
      }
    }
    return { collection: () => q([]) } as any
  }

  const WS = 'ws1'
  const ts = (ms: number) => ({ toMillis: () => ms })
  const DOCS = [
    // 匯入建立的（帶 isDeleted: false）＝事故中整批消失的那種
    { id: 'new1', data: { workspaceId: WS, name: '說明書.pdf', isDeleted: false, updatedAt: ts(300) } },
    { id: 'new2', data: { workspaceId: WS, name: '耳機說明書.pdf', isDeleted: false, updatedAt: ts(200) } },
    // 舊資料（沒有 isDeleted 欄位）＝事故中唯一看得到的那種
    { id: 'old1', data: { workspaceId: WS, name: '客服（商品資訊）', updatedAt: ts(100) } },
    // 回收桶：兩種情況都不該出現
    { id: 'bin1', data: { workspaceId: WS, name: '刪掉的', isDeleted: true, deletedAt: ts(999), updatedAt: ts(999) } },
  ]

  it('索引正常時：新舊都在、墓碑不在、degraded 為 false', async () => {
    const r = await listSources(makeListDb(DOCS, false), WS)
    expect(r.items.map(x => x.id)).toEqual(['new1', 'new2', 'old1'])
    expect(r.degraded).toBe(false)
  })

  it('🔴 主查詢掛掉時，匯入建立的來源仍要出現（事故本身）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await listSources(makeListDb(DOCS, true), WS)
    // 舊行為：只剩 old1 → 老闆看到的就是這個
    expect(r.items.map(x => x.id)).toEqual(['new1', 'new2', 'old1'])
    expect(warn).toHaveBeenCalled() // ⛔ 唯讀路徑的 catch 一定要出聲
    warn.mockRestore()
  })

  it('🔴 降級時要回報 degraded，畫面才講得出「清單可能不完整」', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await listSources(makeListDb(DOCS, true), WS)).degraded).toBe(true)
    warn.mockRestore()
  })

  it('降級也不可以讓回收桶的東西跑出來', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await listSources(makeListDb(DOCS, true), WS)
    expect(r.items.map(x => x.id)).not.toContain('bin1')
    warn.mockRestore()
  })
})

/**
 * `C-138`：份數撞到上限也要講。
 * 搜尋、回收桶、體檢撞上限時都會回 `truncated`，只有資料清單以前是默默切掉——
 * 超過 100 份資料的帳號會有東西永遠看不到，畫面卻完全正常（同 `C-137` 的病，不同形狀）。
 */
describe('listSources：撞到份數上限要回報（C-138）', () => {
  function makeDb(n: number) {
    const docs = Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      data: { workspaceId: 'ws1', name: `來源${i}`, isDeleted: false, updatedAt: { toMillis: () => 1000 - i } },
    }))
    function q(filters: Array<[string, string, unknown]>, lim = Infinity): any {
      return {
        where: (f: string, op: string, v: unknown) => q([...filters, [f, op, v]], lim),
        orderBy: () => q(filters, lim),
        limit: (l: number) => q(filters, l),
        get: async () => {
          const matched = docs.filter(d => filters.every(([f, , v]) => (d.data as any)[f] === v)).slice(0, lim)
          return { size: matched.length, docs: matched.map(d => ({ id: d.id, data: () => d.data })) }
        },
      }
    }
    return { collection: () => q([]) } as any
  }

  it('沒撞到上限 → truncated 為 false', async () => {
    const r = await listSources(makeDb(31), 'ws1', 100)
    expect(r.items).toHaveLength(31)
    expect(r.truncated).toBe(false)
  })

  it('🔴 撞到上限 → 一定要講（以前是默默切掉）', async () => {
    const r = await listSources(makeDb(140), 'ws1', 100)
    expect(r.items).toHaveLength(100)
    expect(r.truncated).toBe(true)
  })
})
