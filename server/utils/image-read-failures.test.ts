import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

/**
 * 超管「全站異常總覽」的「客人傳的圖讀不出來」（`C-164`）：查詢長什麼樣、怎麼彙總、什麼時候算「連著壞」。
 */

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms, toMillis: () => ms }) },
}))

const {
  IMAGE_READ_FAILURE_SCAN_LIMIT,
  densestWindow,
  readImageReadFailureEvents,
  summarizeImageReadFailures,
  toImageReadFailureEvent,
} = await import('./image-read-failures')

const NOW = Date.UTC(2026, 9, 19, 6, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN

/** 假 Firestore：記下查詢怎麼下的，回指定的訊息 */
function fakeDb(rows: Array<{ conv: string, data: Record<string, unknown> }>) {
  const calls: unknown[][] = []
  const q: Record<string, (...a: unknown[]) => unknown> = {}
  for (const m of ['where', 'orderBy', 'limit', 'select']) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return q
    }
  }
  q.get = async () => ({
    docs: rows.map((r, i) => ({ id: `m${i}`, ref: { parent: { parent: { id: r.conv } } }, data: () => r.data })),
  })
  const db = {
    collectionGroup: (name: string) => {
      calls.push(['collectionGroup', name])
      return q
    },
  }
  return { db: db as any, calls }
}

const ts = (ms: number) => ({ toMillis: () => ms })

describe('readImageReadFailureEvents：查詢', () => {
  it('全站的 messages 子集合、只撈 malformed、近 7 天、新的在前', async () => {
    const { db, calls } = fakeDb([])

    await readImageReadFailureEvents(db, NOW)

    expect(calls).toContainEqual(['collectionGroup', 'messages'])
    expect(calls).toContainEqual(['where', 'mediaReadState', '==', 'malformed'])
    const range = calls.find(c => c[0] === 'where' && c[1] === 'timestamp') as [string, string, string, { __ms: number }]
    expect(range[2]).toBe('>=')
    expect(range[3].__ms).toBe(NOW - 7 * 24 * HOUR)
    expect(calls).toContainEqual(['orderBy', 'timestamp', 'desc'])
    expect(calls).toContainEqual(['limit', IMAGE_READ_FAILURE_SCAN_LIMIT + 1])
  })

  it('🔴 firestore.indexes.json 有對得上的索引（collection group、mediaReadState 升冪＋timestamp 降冪）——方向反了正式站會整區查不到', () => {
    const file = JSON.parse(readFileSync(new URL('../../firestore.indexes.json', import.meta.url), 'utf8')) as {
      indexes: Array<{ collectionGroup: string, queryScope?: string, fields: Array<{ fieldPath: string, order?: string }> }>
    }
    const hit = file.indexes.find(i =>
      i.collectionGroup === 'messages'
      && i.queryScope === 'COLLECTION_GROUP'
      && JSON.stringify(i.fields.map(f => [f.fieldPath, f.order])) === JSON.stringify([['mediaReadState', 'ASCENDING'], ['timestamp', 'DESCENDING']]))
    expect(hit).toBeTruthy()
  })

  it('撞到上限 → 標 truncated、只回上限那麼多張', async () => {
    const rows = Array.from({ length: IMAGE_READ_FAILURE_SCAN_LIMIT + 1 }, (_, i) => ({
      conv: 'ws1_Uabc', data: { workspaceId: 'ws1', timestamp: ts(NOW - i * MIN) },
    }))
    const { db } = fakeDb(rows)

    const res = await readImageReadFailureEvents(db, NOW)

    expect(res.truncated).toBe(true)
    expect(res.events).toHaveLength(IMAGE_READ_FAILURE_SCAN_LIMIT)
  })

  it('沒撞到上限 → 不標', async () => {
    const { db } = fakeDb([{ conv: 'ws1_Uabc', data: { workspaceId: 'ws1', timestamp: ts(NOW) } }])
    expect((await readImageReadFailureEvents(db, NOW)).truncated).toBe(false)
  })
})

describe('toImageReadFailureEvent', () => {
  it('帳號取訊息上的、對話取上一層文件、時間取 timestamp', () => {
    const e = toImageReadFailureEvent({ ref: { parent: { parent: { id: 'ws1_Uabc' } } }, data: () => ({ workspaceId: 'ws1', timestamp: ts(123) }) })
    expect(e).toEqual({ workspaceId: 'ws1', conversationId: 'ws1_Uabc', atMs: 123 })
  })

  it('欄位缺了不丟例外（空帳號、時間 0）', () => {
    const e = toImageReadFailureEvent({ ref: { parent: { parent: null } }, data: () => ({}) })
    expect(e).toEqual({ workspaceId: '', conversationId: '', atMs: 0 })
  })
})

describe('summarizeImageReadFailures：每個帳號一列', () => {
  const names = new Map([['ws1', 'MYFEEL'], ['ws2', '小胖商店']])

  it('各帳號幾張、最近一張的時間與那段對話；最近出事的帳號在前', () => {
    const res = summarizeImageReadFailures([
      { workspaceId: 'ws1', conversationId: 'ws1_Uold', atMs: NOW - 3 * 24 * HOUR },
      { workspaceId: 'ws2', conversationId: 'ws2_Ux', atMs: NOW - 2 * 24 * HOUR },
      { workspaceId: 'ws1', conversationId: 'ws1_Unew', atMs: NOW - 1 * 24 * HOUR },
    ], { nowMs: NOW, workspaceNames: names, truncated: false })

    expect(res.total).toBe(3)
    expect(res.windowDays).toBe(7)
    expect(res.workspaces).toEqual([
      { workspaceId: 'ws1', workspaceName: 'MYFEEL', count: 2, lastAtMs: NOW - 24 * HOUR, lastConversationId: 'ws1_Unew' },
      { workspaceId: 'ws2', workspaceName: '小胖商店', count: 1, lastAtMs: NOW - 2 * 24 * HOUR, lastConversationId: 'ws2_Ux' },
    ])
  })

  it('⛔ 訊息上沒記帳號的也列出來（一張都不丟），名字講清楚；名單上找不到的帳號顯示代號', () => {
    const res = summarizeImageReadFailures([
      { workspaceId: '', conversationId: 'x_Uabc', atMs: NOW - HOUR },
      { workspaceId: 'ws9', conversationId: 'ws9_Uabc', atMs: NOW - 2 * HOUR },
    ], { nowMs: NOW, workspaceNames: names, truncated: false })

    expect(res.total).toBe(2)
    expect(res.workspaces.map(w => w.workspaceName)).toEqual(['（訊息上沒有記帳號）', 'ws9'])
  })

  it('沒有讀不出來的圖 → 0 張、沒有列、不算連著壞', () => {
    const res = summarizeImageReadFailures([], { nowMs: NOW, workspaceNames: names, truncated: false })
    expect(res).toMatchObject({ total: 0, workspaces: [], burst: null, truncated: false })
  })

  it('truncated 照實帶出去', () => {
    expect(summarizeImageReadFailures([], { nowMs: NOW, workspaceNames: names, truncated: true }).truncated).toBe(true)
  })
})

describe('summarizeImageReadFailures：什麼時候算「連著壞」（側欄點變紅）', () => {
  const names = new Map<string, string>()
  const at = (ms: number, ws = 'ws1') => ({ workspaceId: ws, conversationId: `${ws}_U`, atMs: ms })

  it('🔴 一小時內 3 張 → 算，帶出那一段的起訖', () => {
    const res = summarizeImageReadFailures(
      [at(NOW - 2 * HOUR), at(NOW - 2 * HOUR + 20 * MIN), at(NOW - HOUR)],
      { nowMs: NOW, workspaceNames: names, truncated: false },
    )
    expect(res.burst).toEqual({ count: 3, startMs: NOW - 2 * HOUR, endMs: NOW - HOUR })
  })

  it('🔴 不分帳號：三個帳號各一張、同一個小時 → 也算（讀圖壞掉是系統的事）', () => {
    const res = summarizeImageReadFailures(
      [at(NOW - 30 * MIN, 'ws1'), at(NOW - 20 * MIN, 'ws2'), at(NOW - 10 * MIN, 'ws3')],
      { nowMs: NOW, workspaceNames: names, truncated: false },
    )
    expect(res.burst?.count).toBe(3)
  })

  it('偶發：兩張、或三張散在超過一小時 → 不算（不吵人，清單照樣列）', () => {
    expect(summarizeImageReadFailures([at(NOW - 10 * MIN), at(NOW - 5 * MIN)], { nowMs: NOW, workspaceNames: names, truncated: false }).burst).toBeNull()
    // 頭尾差一小時又 1 毫秒：任一段一小時裡最多兩張
    const spread = summarizeImageReadFailures(
      [at(NOW - 3 * HOUR), at(NOW - 2.5 * HOUR), at(NOW - 2 * HOUR + 1)],
      { nowMs: NOW, workspaceNames: names, truncated: false },
    )
    expect(spread.burst).toBeNull()
    expect(spread.total).toBe(3)
  })

  it('連著壞但已經是一天多以前 → 側欄不再紅（清單還在、張數照算）', () => {
    const res = summarizeImageReadFailures(
      [at(NOW - 30 * HOUR), at(NOW - 30 * HOUR + MIN), at(NOW - 30 * HOUR + 2 * MIN)],
      { nowMs: NOW, workspaceNames: names, truncated: false },
    )
    expect(res.burst).toBeNull()
    expect(res.total).toBe(3)
  })
})

describe('densestWindow', () => {
  it('剛好一小時整也算在同一段；一樣多時取比較晚的那段', () => {
    expect(densestWindow([0, HOUR], HOUR)).toEqual({ count: 2, startMs: 0, endMs: HOUR })
    expect(densestWindow([0, 5 * HOUR], HOUR)).toEqual({ count: 1, startMs: 5 * HOUR, endMs: 5 * HOUR })
  })

  it('沒排序也照算；空的回 null', () => {
    expect(densestWindow([3 * MIN, 0, 2 * HOUR, MIN], HOUR)?.count).toBe(3)
    expect(densestWindow([], HOUR)).toBeNull()
  })
})
