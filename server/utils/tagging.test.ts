/**
 * 貼標（tagging.ts）——`D-55`「最近一次被判到／被判到幾次」。
 *
 * ⛔ **為什麼要有整合那一組**：純函式 `nextTagHit` 測綠不代表它被接上。先前
 * `addTagsToUser` 對「已經在身上」的標籤是直接 `continue`，而且 commit 的條件是
 * `added.length > 0`——只改純函式的話，全部略過的那一次**依然一個字都不會寫出去**，
 * 而單元測試照樣全綠（見記憶 `feedback_verify_new_code_actually_runs`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))

import { getDb } from './firebase'
import { addTagsToUser, countsAsCustomerHit, nextTagHit, TAG_HIT_COOLDOWN_MS } from './tagging'

const WS = 'ws1'
const USER = 'ws1_U1'

describe('nextTagHit：冷卻窗內只更新時間、不加次數', () => {
  const NOW = 1_700_000_000_000

  it('從來沒被判到過（後台手動貼的）→ 這次算第 1 次，不要猜成第 2 次', () => {
    expect(nextTagHit(undefined, NOW)).toEqual({ lastHitAtMs: NOW, hitCount: 1, counted: true })
    expect(nextTagHit({}, NOW)).toEqual({ lastHitAtMs: NOW, hitCount: 1, counted: true })
  })

  /**
   * 🔴 這條是整個功能的意義所在：線上 56 對重複貼標間隔中位數 8.8 秒
   * ——不擋掉就是把客人連點按鈕當成「他很想要」。
   */
  it('🔴 幾秒內重複判到（客人連點）→ 次數不動，只更新最近一次', () => {
    const r = nextTagHit({ lastHitAtMs: NOW - 9_000, hitCount: 3 }, NOW)
    expect(r).toEqual({ lastHitAtMs: NOW, hitCount: 3, counted: false })
  })

  it('剛好在冷卻窗邊界上 → 算一次（窗是「小於」才算重複）', () => {
    expect(nextTagHit({ lastHitAtMs: NOW - TAG_HIT_COOLDOWN_MS, hitCount: 2 }, NOW).hitCount).toBe(3)
    expect(nextTagHit({ lastHitAtMs: NOW - TAG_HIT_COOLDOWN_MS + 1, hitCount: 2 }, NOW).hitCount).toBe(2)
  })

  it('隔幾天又來問一次 → 次數 +1（這才是要留的訊號）', () => {
    const r = nextTagHit({ lastHitAtMs: NOW - 3 * 86400_000, hitCount: 1 }, NOW)
    expect(r).toEqual({ lastHitAtMs: NOW, hitCount: 2, counted: true })
  })

  /** ⛔ 時鐘歪掉時寧可少算一次，不要因為一次抖動把次數灌上去 */
  it('⛔ 記錄的時間比現在還新（時鐘歪掉）→ 當成冷卻窗內，不加次數', () => {
    expect(nextTagHit({ lastHitAtMs: NOW + 60_000, hitCount: 5 }, NOW).counted).toBe(false)
  })

  it('壞掉的值（字串／負數／NaN）不會污染次數', () => {
    expect(nextTagHit({ lastHitAtMs: 'x', hitCount: 'y' }, NOW)).toEqual({ lastHitAtMs: NOW, hitCount: 1, counted: true })
    expect(nextTagHit({ lastHitAtMs: -5, hitCount: -3 }, NOW).hitCount).toBe(1)
  })
})

/**
 * 迷你假 Firestore：userTags 的 get／batch.set，把寫入全部記下來供斷言。
 */
function fakeDb(existing: Record<string, Record<string, unknown> | undefined>) {
  const writes: Array<{ col: string, id: string, data: any, merge: boolean }> = []
  let committed = 0
  const db: any = {
    collection: (col: string) => ({
      doc: (id: string = 'auto') => ({
        __col: col,
        __id: id,
        get: async () => ({
          exists: existing[id] != null,
          data: () => existing[id],
        }),
      }),
    }),
    batch: () => ({
      set: (ref: { __col: string, __id: string }, data: any, opts?: { merge?: boolean }) => {
        writes.push({ col: ref.__col, id: ref.__id, data, merge: opts?.merge === true })
      },
      delete: () => {},
      commit: async () => { committed += 1 },
    }),
  }
  return { db, writes, commits: () => committed }
}

describe('addTagsToUser：重複判到真的有寫出去（不是只算對）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('新標籤 → 建 userTags，第一次就帶 hitCount 1', async () => {
    const { db, writes } = fakeDb({})
    vi.mocked(getDb).mockReturnValue(db)

    const r = await addTagsToUser(USER, ['t1'], 'system', 'postback:m1', WS)
    expect(r).toEqual({ added: ['t1'], skipped: [], hits: [] })
    const ut = writes.find(w => w.col === 'userTags')!
    expect(ut.data).toMatchObject({ tagId: 't1', hitCount: 1, sourceType: 'system' })
    expect(typeof ut.data.lastHitAtMs).toBe('number')
    // 稽核流水照舊要寫
    expect(writes.some(w => w.col === 'tagLogs' && w.data.action === 'add')).toBe(true)
  })

  /**
   * 🔴 這條就是「先前第二次之後一個字都不留」那個洞。
   * ⛔ 連 commit 都要斷言：舊版 commit 的條件是 `added.length > 0`，
   *    全部略過時 batch 根本不會送出去——只斷言 writes 會漏掉這種假綠。
   */
  it('🔴 標籤已經在身上 → 不重建，但要更新次數，而且 batch 真的 commit 了', async () => {
    const { db, writes, commits } = fakeDb({
      [`${USER}_t1`]: { tagId: 't1', hitCount: 2, lastHitAtMs: Date.now() - 5 * 86400_000 },
    })
    vi.mocked(getDb).mockReturnValue(db)

    const r = await addTagsToUser(USER, ['t1'], 'ai', 'ai-tag-suggest:auto', WS)
    expect(r).toEqual({ added: [], skipped: ['t1'], hits: ['t1'] })
    expect(commits()).toBe(1)

    const ut = writes.filter(w => w.col === 'userTags')
    expect(ut).toHaveLength(1)
    expect(ut[0]!.data).toEqual({ hitCount: 3, lastHitAtMs: expect.any(Number) })
    // ⛔ 必須 merge：整包覆蓋會把第一次貼上的 sourceType／createdAt 清掉
    expect(ut[0]!.merge).toBe(true)
    // 略過不是新事件 → 不寫稽核流水（那本記的是「貼上／拿掉」）
    expect(writes.some(w => w.col === 'tagLogs')).toBe(false)
  })

  it('冷卻窗內重複（連點）→ 有寫、但次數不動、也不算一次 hit', async () => {
    const { db, writes } = fakeDb({
      [`${USER}_t1`]: { tagId: 't1', hitCount: 4, lastHitAtMs: Date.now() - 3_000 },
    })
    vi.mocked(getDb).mockReturnValue(db)

    const r = await addTagsToUser(USER, ['t1'], 'system', 'postback:m1', WS)
    expect(r.hits).toEqual([])
    expect(r.skipped).toEqual(['t1'])
    expect(writes.find(w => w.col === 'userTags')!.data.hitCount).toBe(4)
  })

  it('一次多顆：新的建、舊的更新，各自分流', async () => {
    const { db, writes } = fakeDb({
      [`${USER}_t2`]: { tagId: 't2', hitCount: 1, lastHitAtMs: Date.now() - 2 * 86400_000 },
    })
    vi.mocked(getDb).mockReturnValue(db)

    const r = await addTagsToUser(USER, ['t1', 't2'], 'system', 'script:s1', WS)
    expect(r.added).toEqual(['t1'])
    expect(r.skipped).toEqual(['t2'])
    expect(r.hits).toEqual(['t2'])
    expect(writes.filter(w => w.col === 'userTags')).toHaveLength(2)
  })

  /**
   * 🔴 `pushSupportPresetActionToUser`（真人客服按預存回覆順帶貼標）走的就是這條路，
   * 傳 `manual`。把它算進次數，「這個月追了四次出貨」會混進「客服幫他貼了四次標」，
   * 而那兩件事的下一步完全不同。⛔ 這條是我自己寫錯註解後、去核對呼叫者才發現的。
   */
  it('🔴 真人客服貼的（manual）不計次：既有標籤完全不動，也不白 commit', async () => {
    const { db, writes, commits } = fakeDb({
      [`${USER}_t1`]: { tagId: 't1', hitCount: 2, lastHitAtMs: Date.now() - 5 * 86400_000 },
    })
    vi.mocked(getDb).mockReturnValue(db)

    const r = await addTagsToUser(USER, ['t1'], 'manual', 'preset:p1', WS)
    expect(r).toEqual({ added: [], skipped: ['t1'], hits: [] })
    expect(writes).toHaveLength(0)
    expect(commits()).toBe(0)
  })

  it('🔴 manual 新貼上的標籤不帶次數欄位（＝「從來沒被自動判到過」，分析讀成 0）', async () => {
    const { db, writes } = fakeDb({})
    vi.mocked(getDb).mockReturnValue(db)

    await addTagsToUser(USER, ['t1'], 'manual', 'preset:p1', WS)
    const ut = writes.find(w => w.col === 'userTags')!
    expect(ut.data.hitCount).toBeUndefined()
    expect(ut.data.lastHitAtMs).toBeUndefined()
    expect(ut.data.sourceType).toBe('manual') // 標籤本身照樣要貼上
  })

  it('空輸入不打 db（沿用原本行為）', async () => {
    const { db, writes } = fakeDb({})
    vi.mocked(getDb).mockReturnValue(db)
    expect(await addTagsToUser(USER, [], 'system', null, WS)).toEqual({ added: [], skipped: [], hits: [] })
    expect(await addTagsToUser('', ['t1'], 'system', null, WS)).toEqual({ added: [], skipped: [], hits: [] })
    expect(writes).toHaveLength(0)
  })
})

describe('countsAsCustomerHit：哪些來源算「客人又表現了一次意圖」', () => {
  it('客人觸發與 AI 判到算', () => {
    expect(countsAsCustomerHit('system')).toBe(true)
    expect(countsAsCustomerHit('ai')).toBe(true)
    expect(countsAsCustomerHit('rule')).toBe(true)
  })

  it('⛔ 我們自己的動作不算（真人客服預存回覆、名單匯入）', () => {
    expect(countsAsCustomerHit('manual')).toBe(false)
    expect(countsAsCustomerHit('import')).toBe(false)
  })
})
