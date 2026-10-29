import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-429`：同步時記下「哪幾個模組還寫著舊字」，提醒中心再確認一次（改掉了就自己消失）。
 */
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms, __ms: ms }) },
}))

const { recordStaleSheetModules, findStaleSheetModules, SHEET_STALE_COLLECTION } = await import('./sheet-stale-modules')

const OLD_A = '依原廠公告：商品將於 10 月底 依照訂單順序陸續出貨。'
const OLD_B = '依原廠公告：第一批 10 月底，10/7 起第二批 11 月底。'
const NEW_C = '依原廠公告：全部 12 月初出貨。'

/** 假 db：flows 跟記錄兩個集合 */
function makeDb(flows: Record<string, { workspaceId: string, name: string, messages: unknown[] }>) {
  const stale = new Map<string, Record<string, any>>()
  const docRef = (col: string, id: string) => ({
    id,
    get: async () => {
      const data = col === SHEET_STALE_COLLECTION ? stale.get(id) : flows[id]
      return { id, exists: !!data, get: (f: string) => (data as any)?.[f], data: () => data }
    },
    set: async (data: any) => { stale.set(id, data) },
    delete: async () => { stale.delete(id) },
  })
  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
      where: (_f: string, _op: string, wid: string) => ({
        get: async () => ({
          docs: (col === 'flows'
            ? Object.entries(flows).filter(([, f]) => f.workspaceId === wid).map(([id, f]) => ({ id, get: (k: string) => (f as any)[k], data: () => f }))
            : [...stale.entries()].filter(([, d]) => d.workspaceId === wid).map(([id, d]) => ({ id, get: (k: string) => d[k], data: () => d }))),
        }),
      }),
    }),
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map(r => r.get())),
  }
  return { db, stale }
}

let flows: Record<string, { workspaceId: string, name: string, messages: unknown[] }>
beforeEach(() => {
  flows = {
    ship: { workspaceId: 'ws1', name: '客服 - 出貨進度查詢 - Giaretti', messages: [{ type: 'quickReply', text: `您好，\n${OLD_A}\n謝謝` }] },
    info: { workspaceId: 'ws1', name: '客服 - 商品資訊 - Giaretti', messages: [{ type: 'text', text: '看商品頁' }] },
    other: { workspaceId: 'ws2', name: '別家', messages: [{ type: 'text', text: OLD_A }] },
  }
})

describe('記下還寫著舊字的模組', () => {
  it('⭐ 只記這個帳號、真的抄著舊字的那幾個', async () => {
    const { db, stale } = makeDb(flows)
    const n = await recordStaleSheetModules(db, 'ws1', 'src1', '客服（商品資訊）', [{ row: 'Giaretti', field: '出貨時間', oldValue: OLD_A, newValue: OLD_B }])
    expect(n).toBe(1)
    const [doc] = [...stale.values()]
    expect(doc).toMatchObject({ workspaceId: 'ws1', row: 'Giaretti', field: '出貨時間', oldValues: [OLD_A], newValue: OLD_B, moduleIds: ['ship'] })
  })

  it('同一格又改一次（A→B→C）：抄著 A 的照樣算舊的（舊字累積著記）', async () => {
    const { db, stale } = makeDb(flows)
    await recordStaleSheetModules(db, 'ws1', 'src1', 'S', [{ row: 'Giaretti', field: '出貨時間', oldValue: OLD_A, newValue: OLD_B }])
    await recordStaleSheetModules(db, 'ws1', 'src1', 'S', [{ row: 'Giaretti', field: '出貨時間', oldValue: OLD_B, newValue: NEW_C }])
    const [doc] = [...stale.values()]
    expect(doc!.oldValues).toEqual([OLD_B, OLD_A])
    expect(doc!.moduleIds).toEqual(['ship'])
  })

  it('沒有模組抄著舊字：不記（之前記的也拿掉）', async () => {
    flows.ship!.messages = [{ type: 'text', text: '別的字' }]
    const { db, stale } = makeDb(flows)
    await recordStaleSheetModules(db, 'ws1', 'src1', 'S', [{ row: 'Giaretti', field: '出貨時間', oldValue: OLD_A, newValue: OLD_B }])
    expect(stale.size).toBe(0)
  })

  it('⛔ 讀不到資料庫也不丟錯（提醒記不下來不可以讓同步算失敗）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db: any = { collection: () => { throw new Error('down') } }
    await expect(recordStaleSheetModules(db, 'ws1', 'src1', 'S', [{ row: 'G', field: 'F', oldValue: OLD_A, newValue: OLD_B }])).resolves.toBe(0)
    err.mockRestore()
  })
})

describe('提醒中心：現在還是舊的才算', () => {
  it('⭐ 記下來之後店家把字改掉了＝不再提醒（不必另外清）', async () => {
    const { db } = makeDb(flows)
    await recordStaleSheetModules(db, 'ws1', 'src1', '客服（商品資訊）', [{ row: 'Giaretti', field: '出貨時間', oldValue: OLD_A, newValue: OLD_B }])
    expect(await findStaleSheetModules(db, 'ws1')).toEqual([
      { flowId: 'ship', flowName: '客服 - 出貨進度查詢 - Giaretti', sourceName: '客服（商品資訊）', row: 'Giaretti', field: '出貨時間' },
    ])
    flows.ship!.messages = [{ type: 'quickReply', text: '您好，{{sheet:Giaretti|%E5%87%BA%E8%B2%A8%E6%99%82%E9%96%93}}' }]
    expect(await findStaleSheetModules(db, 'ws1')).toEqual([])
  })

  it('沒有任何記錄：空的', async () => {
    const { db } = makeDb(flows)
    expect(await findStaleSheetModules(db, 'ws1')).toEqual([])
  })
})
