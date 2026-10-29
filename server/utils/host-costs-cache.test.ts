import { describe, expect, it, vi } from 'vitest'
import { HOST_COSTS_CACHE_COLLECTION, readHostCostsCache, writeHostCostsCache } from './host-costs-cache'

/** 只認 `hostCostsCache/{key}` 的假資料庫 */
function makeDb(docs: Record<string, Record<string, unknown>> = {}, opts: { failRead?: boolean, failWrite?: boolean } = {}) {
  const writes: Array<{ key: string, value: Record<string, unknown> }> = []
  const db = {
    collection: (name: string) => {
      expect(name).toBe(HOST_COSTS_CACHE_COLLECTION)
      return {
        doc: (key: string) => ({
          key,
          set: async (value: Record<string, unknown>) => {
            if (opts.failWrite) throw new Error('permission denied')
            writes.push({ key, value })
          },
        }),
      }
    },
    getAll: async (...refs: Array<{ key: string }>) => {
      if (opts.failRead) throw new Error('unavailable')
      return refs.map(r => ({ exists: r.key in docs, get: (f: string) => docs[r.key]?.[f] }))
    },
  }
  return { db: db as any, writes }
}

const DAY = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 9, 29, 12)

describe('成本頁主機費的共用暫存（`D-164`③）', () => {
  it('還沒過期 → 拿得回存進去的那份（大家共用，不用每台主機各查一次帳單）', async () => {
    const { db } = makeDb({ 202610: { at: NOW - 3 * 60 * 60_000, json: JSON.stringify({ totalCost: 15.56 }) } })
    expect(await readHostCostsCache(db, ['202610'], DAY, NOW)).toEqual({ key: '202610', at: NOW - 3 * 60 * 60_000, data: { totalCost: 15.56 } })
  })

  it('過期了 → 當沒有（去查新的）', async () => {
    const { db } = makeDb({ 202610: { at: NOW - DAY, json: '{}' } })
    expect(await readHostCostsCache(db, ['202610'], DAY, NOW)).toBeNull()
  })

  it('照順序挑：完整版還新鮮就用它，不新鮮才看只有總額的那份', async () => {
    const { db } = makeDb({
      '202609': { at: NOW - 2 * DAY, json: JSON.stringify({ full: true }) },
      '202609:summary': { at: NOW - 60_000, json: JSON.stringify({ full: false }) },
    })
    expect((await readHostCostsCache(db, ['202609', '202609:summary'], DAY, NOW))?.key).toBe('202609:summary')
  })

  it('格式壞掉的那份當沒有', async () => {
    const { db } = makeDb({ 202610: { at: NOW, json: { not: 'a string' } } })
    expect(await readHostCostsCache(db, ['202610'], DAY, NOW)).toBeNull()
  })

  it('⛔ 讀不到資料庫 → 當沒有暫存，不丟錯（成本頁照常去查帳單）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db } = makeDb({}, { failRead: true })
    expect(await readHostCostsCache(db, ['202610'], DAY, NOW)).toBeNull()
    warn.mockRestore()
  })

  it('存成一段文字：undefined 的欄位拿掉（Firestore 不收 undefined）', async () => {
    const { db, writes } = makeDb()
    await writeHostCostsCache(db, '202610', { totalCost: 1, amplifyUsage: undefined, days: [{ date: '2026-10-01', cost: 0.5 }] }, NOW)
    expect(writes).toEqual([{ key: '202610', value: { at: NOW, json: '{"totalCost":1,"days":[{"date":"2026-10-01","cost":0.5}]}' } }])
  })

  it('⛔ 寫不進去 → 不丟錯（下次打開頁面再查一次而已）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db } = makeDb({}, { failWrite: true })
    await expect(writeHostCostsCache(db, '202610', {}, NOW)).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
