import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 回收桶找得到、翻得完（`C-312`，2026-10-14）。
 *
 * 🔴 以前只給最近 100 條、不能搜：一份 150 條的說明書「換新版」，舊的 150 條一起進回收桶，
 *    昨天刪的那一條就被擠出畫面——畫面說「30 天內可以還原」，其實找不到、救不回來。
 * 釘住：
 *  · 「顯示更多」一路翻得完、一條不漏不重複——⚠️ 同一批刪的刪除時間一模一樣而且精確到微秒，
 *    游標只記毫秒的話整批會被跳過
 *  · 搜標題、內容（大小寫、全形半形不分，空白隔開的每個詞都要有）、挑「哪一份資料」、資料已經不在的那一組
 *  · 翻到上限還沒湊滿就先停，講出來（scanCapped）＋給游標接著找——⛔ 不可以讓「還沒找」看起來像「找不到」
 *  · 只用 workspaceId＋deletedAt 的查詢形狀（既有索引），⛔ 不用 offset
 * 正式庫零讀零寫：Firestore 是記憶體裡的假物件。
 */

const { FakeTs } = vi.hoisted(() => {
  class FakeTs {
    constructor(public seconds: number, public nanoseconds: number) {}
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6) }
  }
  return { FakeTs }
})
vi.mock('firebase-admin/firestore', () => ({ Timestamp: FakeTs, FieldPath: { documentId: () => '__name__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: WS })) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))

const WS = 'ws1'
let CHUNKS: Record<string, Record<string, any>> = {}
let SOURCES: Record<string, Record<string, any>> = {}
/** 每一發 get() 讀了幾條、用什麼形狀查（驗索引形狀與讀取量） */
let GETS: Array<{ filters: Array<[string, unknown]>, orders: Array<[string, string]>, limit: number, returned: number }> = []
let COUNT_CALLS = 0
let GETALL_FAIL = false

interface QState { filters: Array<[string, unknown]>, orders: Array<[string, string]>, after: unknown[] | null, lim: number, fields: string[] | null }
const cmpTs = (a: InstanceType<typeof FakeTs>, b: InstanceType<typeof FakeTs>) => a.seconds - b.seconds || a.nanoseconds - b.nanoseconds

function runQuery(st: QState) {
  let rows = Object.entries(CHUNKS).filter(([, d]) => st.filters.every(([f, v]) => d[f] === v))
  if (st.orders.some(([f]) => f === 'deletedAt')) {
    rows = rows.filter(([, d]) => d.deletedAt != null)
    // 最新刪的在前；同一刻刪的照文件編號（desc），同 Firestore 索引自帶的 __name__ 排序
    rows.sort(([ia, a], [ib, b]) => cmpTs(b.deletedAt, a.deletedAt) || (ia < ib ? 1 : ia > ib ? -1 : 0))
  }
  if (st.after) {
    const [ts, id] = st.after as [InstanceType<typeof FakeTs>, string]
    if (!(ts instanceof FakeTs) || typeof id !== 'string') throw new Error('游標要帶完整的 Timestamp＋文件編號')
    rows = rows.filter(([rid, d]) => cmpTs(d.deletedAt, ts) < 0 || (cmpTs(d.deletedAt, ts) === 0 && rid < id))
  }
  return rows.slice(0, st.lim)
}

function makeQuery(st: QState): any {
  const next = (patch: Partial<QState>) => makeQuery({ ...st, ...patch })
  return {
    where: (f: string, op: string, v: unknown) => {
      if (op !== '==') throw new Error(`沒預期的條件 ${op}`)
      return next({ filters: [...st.filters, [f, v]] })
    },
    orderBy: (f: string, dir: string) => next({ orders: [...st.orders, [f, dir]] }),
    select: (...fields: string[]) => next({ fields }),
    startAfter: (...vals: unknown[]) => next({ after: vals }),
    limit: (n: number) => next({ lim: n }),
    offset: () => { throw new Error('⛔ offset 跳過的每一條都照算讀取費') },
    count: () => ({
      get: async () => {
        COUNT_CALLS++
        return { data: () => ({ count: runQuery({ ...st, lim: Infinity }).length }) }
      },
    }),
    get: async () => {
      const rows = runQuery(st)
      GETS.push({ filters: st.filters, orders: st.orders, limit: st.lim, returned: rows.length })
      return {
        size: rows.length,
        docs: rows.map(([id, d]) => ({
          id,
          data: () => (st.fields ? Object.fromEntries(st.fields.filter(f => f in d).map(f => [f, d[f]])) : d),
        })),
      }
    },
  }
}

const db: any = {
  collection: (col: string) => ({
    ...makeQuery({ filters: [], orders: [], after: null, lim: Infinity, fields: null }),
    doc: (id: string) => ({ col, id }),
  }),
  getAll: async (...refs: Array<{ col: string, id: string }>) => {
    if (GETALL_FAIL) throw new Error('UNAVAILABLE')
    return refs.map(r => ({ id: r.id, exists: !!SOURCES[r.id], data: () => SOURCES[r.id] }))
  },
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let QUERY: Record<string, string> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => QUERY)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler, RECYCLE_GONE_SOURCE } = await import('./recycle-bin.get')
type Res = Awaited<ReturnType<typeof handler>>
const call = (q: Record<string, string> = {}) => {
  QUERY = q
  return (handler as unknown as (e: unknown) => Promise<Res>)({})
}
/** 一路按「顯示更多」到底，回傳每一頁 */
async function allPages(q: Record<string, string> = {}) {
  const pages: Res[] = []
  let cursor = ''
  for (let i = 0; i < 100; i++) {
    const res = await call({ ...q, ...(cursor ? { cursor } : {}) })
    pages.push(res)
    if (!res.nextCursor) return pages
    cursor = res.nextCursor
  }
  throw new Error('翻不完')
}

const DAY = 86_400
const NOW_S = 1_791_000_000
/** 一條回收桶裡的：del＝[秒, 奈秒] */
function binChunk(id: string, o: { title?: string, content?: string, sourceId?: string | null, del: [number, number], ws?: string }) {
  CHUNKS[id] = {
    workspaceId: o.ws ?? WS,
    title: o.title ?? id,
    content: o.content ?? '',
    ...(o.sourceId === undefined ? { sourceId: 'manual-src' } : o.sourceId === null ? {} : { sourceId: o.sourceId }),
    deletedAt: new FakeTs(...o.del),
    purgeAfter: new FakeTs(o.del[0] + 30 * DAY, 0),
    isDeleted: true,
    status: 'disabled',
  }
}

beforeEach(() => {
  CHUNKS = {}
  SOURCES = {
    'manual-src': { workspaceId: WS, name: '說明書 W1' },
    'sheet-src': { workspaceId: WS, name: '常見問答（試算表）' },
    'other-ws-src': { workspaceId: 'ws2', name: '別家的機密資料' },
  }
  GETS = []
  COUNT_CALLS = 0
  GETALL_FAIL = false
})

/** 情境：昨天刪了一條，今天把 150 條的說明書換新版（150 條同一批、同一個微秒刪的） */
function replacedManualScenario() {
  binChunk('yesterday', { title: 'W1 保固多久', content: '保固一年，電池半年。', sourceId: 'sheet-src', del: [NOW_S - DAY, 512_345_000] })
  for (let i = 0; i < 150; i++) {
    binChunk(`old-${String(i).padStart(3, '0')}`, { title: `舊版第 ${i} 條`, content: '舊內容', sourceId: 'manual-src', del: [NOW_S, 123_456_000] })
  }
  // 別家的回收桶：一條都不能出現
  binChunk('ws2-secret', { title: 'W1 保固多久（別家）', ws: 'ws2', sourceId: 'other-ws-src', del: [NOW_S + 10, 0] })
  // 正常的卡（沒有 deletedAt）不在回收桶
  CHUNKS.live = { workspaceId: WS, title: 'W1 保固多久（上線中）', content: '', sourceId: 'sheet-src', status: 'indexed' }
}

describe('回收桶：換新版之後，昨天刪的那一條找得到', () => {
  it('打開：第一頁 50 條＋游標、總數 151；「顯示更多」一路翻完一條不漏不重複（同一批刪的、精確到微秒也不跳過）', async () => {
    replacedManualScenario()
    const pages = await allPages()
    expect(pages[0]!.items).toHaveLength(50)
    expect(pages[0]!.total).toBe(151)
    expect(pages[0]!.truncated).toBe(true) // 舊欄位：後面還有
    const ids = pages.flatMap(p => p.items.map(i => i.id))
    expect(ids).toHaveLength(151)
    expect(new Set(ids).size).toBe(151)
    expect(ids.at(-1)).toBe('yesterday') // 最舊的在最後
    expect(ids).not.toContain('ws2-secret')
    expect(ids).not.toContain('live')
    expect(pages.at(-1)!.nextCursor).toBeNull()
    expect(pages.at(-1)!.truncated).toBe(false)
    // 沒篩選時一頁只讀一頁＋1 條，不多讀
    expect(Math.max(...GETS.map(g => g.returned))).toBeLessThanOrEqual(51)
  })

  it('搜「保固」→ 一次就找到昨天那一條（舊版 150 條擋不住），帶資料名稱、刪除時間、清除時間', async () => {
    replacedManualScenario()
    const res = await call({ q: '保固' })
    expect(res.items.map(i => i.id)).toEqual(['yesterday'])
    expect(res.nextCursor).toBeNull()
    expect(res.scanCapped).toBe(false)
    expect(res.items[0]).toMatchObject({
      title: 'W1 保固多久',
      sourceId: 'sheet-src',
      sourceName: '常見問答（試算表）',
      deletedAtMs: (NOW_S - DAY) * 1000 + 512,
      purgeAfterMs: (NOW_S - DAY + 30 * DAY) * 1000,
    })
  })

  it('只用既有索引的查詢形狀：workspaceId ＝ ＋ deletedAt desc（＋索引自帶的文件編號 desc）；不用 offset', async () => {
    replacedManualScenario()
    await allPages({ q: '舊版', source: 'manual-src' })
    await call({ withSources: '1' })
    for (const g of GETS) {
      expect(g.filters).toEqual([['workspaceId', WS]])
      expect(g.orders).toEqual([['deletedAt', 'desc'], ['__name__', 'desc']])
    }
  })
})

describe('回收桶搜尋', () => {
  beforeEach(() => {
    binChunk('a', { title: 'KIESLECT 小耳記怎麼充電', content: '用附的線充兩小時。', del: [NOW_S, 3] })
    binChunk('b', { title: '出貨要幾天', content: `${'一般說明。'.repeat(20)}遇到颱風停班，出貨會延後一到兩天。`, del: [NOW_S, 2] })
    binChunk('c', { title: '可以刷卡嗎', content: '可以，VISA 與 Master。', del: [NOW_S, 1] })
  })

  it('不分大小寫、全形半形', async () => {
    expect((await call({ q: 'kieslect' })).items.map(i => i.id)).toEqual(['a'])
    expect((await call({ q: 'ＫＩＥＳＬＥＣＴ' })).items.map(i => i.id)).toEqual(['a'])
    expect((await call({ q: 'visa' })).items.map(i => i.id)).toEqual(['c'])
  })

  it('中文片段比對標題與內容；空白隔開的每個詞都要有', async () => {
    expect((await call({ q: '充電' })).items.map(i => i.id)).toEqual(['a'])
    expect((await call({ q: '颱風' })).items.map(i => i.id)).toEqual(['b'])
    expect((await call({ q: '小耳記 兩小時' })).items.map(i => i.id)).toEqual(['a'])
    expect((await call({ q: '小耳記 颱風' })).items).toEqual([])
  })

  it('命中在內容後段 → 摘要擷取命中前後文（看得出為什麼算找到）；沒搜尋時拿開頭', async () => {
    const hit = (await call({ q: '颱風' })).items[0]!
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet).toContain('颱風停班')
    const plain = (await call()).items.find(i => i.id === 'b')!
    expect(plain.snippet.startsWith('一般說明。')).toBe(true)
  })

  it('找不到 → 空的、沒有游標（不是「還沒找完」）', async () => {
    const res = await call({ q: '退貨' })
    expect(res.items).toEqual([])
    expect(res.nextCursor).toBeNull()
    expect(res.scanCapped).toBe(false)
  })
})

describe('挑「哪一份資料」', () => {
  beforeEach(() => {
    binChunk('m1', { title: '說明書一', sourceId: 'manual-src', del: [NOW_S, 6] })
    binChunk('s1', { title: '試算表一', sourceId: 'sheet-src', del: [NOW_S, 5] })
    binChunk('g-other', { title: '別家資料底下的', sourceId: 'other-ws-src', del: [NOW_S, 4] })
    binChunk('m2', { title: '說明書二', sourceId: 'manual-src', del: [NOW_S, 3] })
    binChunk('g-gone', { title: '資料整份刪掉了', sourceId: 'deleted-src', del: [NOW_S, 2] })
    binChunk('g-none', { title: '沒掛資料', sourceId: null, del: [NOW_S, 1] })
  })

  it('選一份 → 只列那一份的', async () => {
    expect((await call({ source: 'manual-src' })).items.map(i => i.id)).toEqual(['m1', 'm2'])
    expect((await call({ source: 'manual-src', q: '二' })).items.map(i => i.id)).toEqual(['m2'])
  })

  it('「已經刪掉的資料」→ 資料不在、別家的、沒掛資料的；別家的名稱不讀出去', async () => {
    const res = await call({ source: RECYCLE_GONE_SOURCE })
    expect(res.items.map(i => i.id)).toEqual(['g-other', 'g-gone', 'g-none'])
    expect(res.items.every(i => i.sourceName === null)).toBe(true)
    expect(JSON.stringify(await call())).not.toContain('別家的機密資料')
  })

  it('withSources=1 → 選單只列回收桶裡有東西的：最近刪的在前、數字對、「已經刪掉的資料」最後；總數＝全部', async () => {
    const res = await call({ withSources: '1' })
    expect(res.sources).toEqual([
      { key: 'manual-src', name: '說明書 W1', count: 2 },
      { key: 'sheet-src', name: '常見問答（試算表）', count: 1 },
      { key: RECYCLE_GONE_SOURCE, name: null, count: 3 },
    ])
    expect(res.sourcesTruncated).toBe(false)
    expect(res.total).toBe(6)
    // 沒帶 withSources 就不算選單（搜尋時不重讀整個回收桶）
    expect((await call({ q: '說明書' })).sources).toBeUndefined()
  })

  it('資料清單讀不到時：挑「已經刪掉的資料」直接報錯（⛔ 不把讀不到當成不在）；選單講讀失敗、清單照給', async () => {
    GETALL_FAIL = true
    await expect(call({ source: RECYCLE_GONE_SOURCE })).rejects.toMatchObject({ statusCode: 503 })
    const res = await call({ withSources: '1' })
    expect(res.items).toHaveLength(6)
    expect(res.items.every(i => i.sourceName === null)).toBe(true)
    expect(res.sourcesFailed).toBe(true)
    expect(res.total).toBe(6) // 選單沒數成，總數改用聚合
  })
})

describe('翻頁與上限', () => {
  it('有篩選時一頁在一批中間湊滿 → 游標停在湊滿的那一條，下一頁從它後面接（一批剩下的不會被跳過）', async () => {
    // 300 條裡 120 條命中、交錯排：一批 250 條裡就有 100 條命中，第 50 條命中落在一批中間
    for (let i = 0; i < 300; i++) {
      binChunk(`x${String(i).padStart(3, '0')}`, { title: i % 5 < 2 ? `電池 ${i}` : `其他 ${i}`, del: [NOW_S - i, 0] })
    }
    const pages = await allPages({ q: '電池' })
    expect(pages.map(p => p.items.length)).toEqual([50, 50, 20])
    const ids = pages.flatMap(p => p.items.map(i => i.id))
    expect(new Set(ids).size).toBe(120)
    expect(pages.every(p => !p.scanCapped)).toBe(true)
  })

  it('翻到上限還沒湊滿 → 先停、講出來（scanCapped＋翻了幾條）、給游標；接著找就找到最舊的那一條', async () => {
    for (let i = 0; i < 1200; i++) binChunk(`n${String(i).padStart(4, '0')}`, { title: `舊版 ${i}`, del: [NOW_S - i, 0] })
    binChunk('oldest', { title: '要找的保固', del: [NOW_S - 5000, 0] })
    const first = await call({ q: '保固' })
    expect(first.items).toEqual([])
    expect(first.scanCapped).toBe(true)
    expect(first.scanned).toBe(1000)
    expect(first.nextCursor).toBeTruthy()
    // 一次請求的讀取量有上限（每一批多讀 1 條確認後面還有沒有）
    expect(GETS.reduce((n, g) => n + g.returned, 0)).toBeLessThanOrEqual(1000 + 4)
    const second = await call({ q: '保固', cursor: first.nextCursor! })
    expect(second.items.map(i => i.id)).toEqual(['oldest'])
    expect(second.nextCursor).toBeNull()
    expect(second.scanCapped).toBe(false)
    expect(second.total).toBeNull() // 接著翻的那幾發不重算總數
  })

  it('剛好翻到最後一條就到上限 → 不算「還沒找完」（多讀的那 1 條確認後面沒了）', async () => {
    for (let i = 0; i < 1000; i++) binChunk(`e${String(i).padStart(4, '0')}`, { title: `舊版 ${i}`, del: [NOW_S - i, 0] })
    const res = await call({ q: '保固' })
    expect(res.scanned).toBe(1000)
    expect(res.scanCapped).toBe(false)
    expect(res.nextCursor).toBeNull()
  })

  it('位置記號看不懂 → 400，講白話', async () => {
    await expect(call({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('選單數到上限 → sourcesTruncated、總數改用聚合', async () => {
    for (let i = 0; i < 3005; i++) binChunk(`f${String(i).padStart(4, '0')}`, { title: `t${i}`, del: [NOW_S - i, 0] })
    const res = await call({ withSources: '1' })
    expect(res.sourcesTruncated).toBe(true)
    expect(res.sources).toEqual([{ key: 'manual-src', name: '說明書 W1', count: 3000 }])
    expect(res.total).toBe(3005)
    expect(COUNT_CALLS).toBe(1)
  })
})
