/**
 * 店家自己的檔期的讀寫（`D-122`②）。釘住的是「設成檔期」那幾道檢查與多租戶：
 * - 只收這個帳號、已排程、還沒綁任何一檔的推播；而且綁推播跟加檔期在同一個交易裡
 * - 一個帳號一份文件（doc id＝workspaceId），⛔ 寫不到別家的
 * - 日期改了要清掉那一檔「提醒到第幾天」的紀錄（延期之後新的日子要重新提醒）
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
}))

import {
  MarketingEventError,
  createMarketingEvent,
  deleteMarketingEvent,
  getMarketingEvents,
  updateMarketingEvent,
} from './marketing-events'
import { MARKETING_EVENTS_MAX } from '~~/shared/marketing-events'

const WS = 'ws-a'
const TODAY = '2026-10-19'

/** 最小的假 Firestore：`collection/doc` 存在記憶體裡，交易照真的順序（先讀後寫） */
function makeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed))
  const writes: { path: string, op: string, data: unknown }[] = []
  const ref = (col: string, id: string) => ({
    path: `${col}/${id}`,
    get: async () => {
      const v = store.get(`${col}/${id}`)
      return { exists: v !== undefined, data: () => v }
    },
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      writes.push({ path: `${col}/${id}`, op: opts?.merge ? 'merge' : 'set', data })
    },
  })
  const db = {
    collection: (col: string) => ({ doc: (id: string) => ref(col, id) }),
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const pending: (() => void)[] = []
      const result = await fn({
        get: (r: ReturnType<typeof ref>) => r.get(),
        set: (r: ReturnType<typeof ref>, data: Record<string, unknown>) => pending.push(() => {
          store.set(r.path, data)
          writes.push({ path: r.path, op: 'set', data })
        }),
        update: (r: ReturnType<typeof ref>, data: Record<string, unknown>) => pending.push(() => {
          store.set(r.path, { ...(store.get(r.path) ?? {}), ...data })
          writes.push({ path: r.path, op: 'update', data })
        }),
      })
      for (const w of pending) w() // 交易成功才真的寫
      return result
    },
  } as any
  return { db, store, writes }
}

const scheduled = (over: Record<string, unknown> = {}) => ({ workspaceId: WS, status: 'scheduled', name: '小滑手_開賣', ...over })

describe('加一檔', () => {
  it('寫進這個帳號自己那一份（doc id＝workspaceId），id 是 own- 開頭', async () => {
    const { db, store } = makeDb()
    const e = await createMarketingEvent(db, WS, { name: '週年慶', date: '2026-10-24' }, TODAY)
    expect(e.id).toMatch(/^own-/)
    expect(e).toMatchObject({ name: '週年慶', date: '2026-10-24' })
    expect(Object.keys((store.get(`marketingCalendarEvents/${WS}`) as any).events)).toEqual([e.id])
    expect(await getMarketingEvents(db, WS)).toHaveLength(1)
    expect(await getMarketingEvents(db, 'ws-b')).toEqual([]) // ⛔ 別家讀不到
  })

  it('滿了就擋，講得出要怎麼辦', async () => {
    const events = Object.fromEntries(Array.from({ length: MARKETING_EVENTS_MAX }, (_, i) =>
      [`own-full${String(i).padStart(4, '0')}`, { name: `第${i}檔`, date: '2026-11-01', createdAt: 1 }]))
    const { db } = makeDb({ [`marketingCalendarEvents/${WS}`]: { events } })
    await expect(createMarketingEvent(db, WS, { name: '再一檔', date: '2026-11-02' }, TODAY))
      .rejects.toThrow('先刪掉用不到的再加')
  })
})

describe('設成檔期（從推播頁）', () => {
  it('已排程的推播：加檔期＋把推播綁到這一檔，同一個交易', async () => {
    const { db, store } = makeDb({ 'broadcasts/bc1': scheduled() })
    const e = await createMarketingEvent(db, WS, { name: '小滑手開賣', date: '2026-10-20', broadcastId: 'bc1' }, TODAY)
    expect((store.get('broadcasts/bc1') as any).festivalId).toBe(e.id)
    expect(e.broadcastId).toBe('bc1')
  })

  it('⛔ 別家的推播：跟不存在一樣回 404，而且什麼都沒寫', async () => {
    const { db, store, writes } = makeDb({ 'broadcasts/bc1': scheduled({ workspaceId: 'ws-b' }) })
    const err = await createMarketingEvent(db, WS, { name: '偷綁', date: '2026-10-20', broadcastId: 'bc1' }, TODAY).catch(e => e)
    expect(err).toBeInstanceOf(MarketingEventError)
    expect(err.statusCode).toBe(404)
    expect(writes).toEqual([])
    expect(store.has(`marketingCalendarEvents/${WS}`)).toBe(false)
  })

  it('⛔ 不是已排程（草稿、發完的）不收', async () => {
    const { db, writes } = makeDb({ 'broadcasts/bc1': scheduled({ status: 'draft' }) })
    const err = await createMarketingEvent(db, WS, { name: '小滑手開賣', date: '2026-10-20', broadcastId: 'bc1' }, TODAY).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect(writes).toEqual([])
  })

  it('⛔ 已經綁在某一檔的（從「為這一檔擬推播」來的）不搶', async () => {
    const { db, store } = makeDb({ 'broadcasts/bc1': scheduled({ festivalId: 'doubleninth-2026' }) })
    const err = await createMarketingEvent(db, WS, { name: '小滑手開賣', date: '2026-10-20', broadcastId: 'bc1' }, TODAY).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect((store.get('broadcasts/bc1') as any).festivalId).toBe('doubleninth-2026')
  })
})

describe('改、刪', () => {
  const seed = () => ({ [`marketingCalendarEvents/${WS}`]: { events: { 'own-anniv0001': { name: '週年慶', date: '2026-10-24', createdAt: 1 } } } })

  it('日期改了：清掉那一檔「提醒到第幾天」的紀錄（延期之後新的日子要重新提醒）', async () => {
    const { db, writes } = makeDb(seed())
    const { before, after } = await updateMarketingEvent(db, WS, 'own-anniv0001', { name: '週年慶', date: '2026-11-07' }, TODAY)
    expect(before.date).toBe('2026-10-24')
    expect(after.date).toBe('2026-11-07')
    const reset = writes.find(w => w.path === 'cronState/festival-digest')
    expect(reset).toEqual({ path: 'cronState/festival-digest', op: 'merge', data: { [WS]: { 'own-anniv0001': { __op: 'del' } } } })
  })

  it('只改名稱：提醒紀錄不動（對照組）', async () => {
    const { db, writes } = makeDb(seed())
    await updateMarketingEvent(db, WS, 'own-anniv0001', { name: '十週年慶', date: '2026-10-24' }, TODAY)
    expect(writes.some(w => w.path === 'cronState/festival-digest')).toBe(false)
  })

  it('⛔ 改／刪別家的（或不存在的）一律 404', async () => {
    const { db } = makeDb(seed())
    expect((await updateMarketingEvent(db, 'ws-b', 'own-anniv0001', { name: 'x', date: '2026-10-24' }, TODAY).catch(e => e)).statusCode).toBe(404)
    expect((await deleteMarketingEvent(db, 'ws-b', 'own-anniv0001', TODAY).catch(e => e)).statusCode).toBe(404)
  })

  it('刪掉那一檔：真的從 map 拿掉（不是留一個空殼）', async () => {
    const { db, store } = makeDb(seed())
    await deleteMarketingEvent(db, WS, 'own-anniv0001', TODAY)
    expect((store.get(`marketingCalendarEvents/${WS}`) as any).events).toEqual({})
  })
})
