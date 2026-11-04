/**
 * 「N 天沒互動」自動標籤（inactive-tag.ts）。
 * 釘的是三類會變業務問題的行為：
 *   1. 掃描窗口必須**有界**（[cutoff-7天, cutoff)）——敞開到 epoch 就是 08-11 讀取費暴衝的同款。
 *   2. 回訊摘標的門檻判斷——沒超過 N 天的常態訊息必須在讀任何 Firestore 之前就返回。
 *   3. 系統標籤的名稱含天數（「60 天沒互動」），天數改了名稱要跟上，否則標籤在騙人。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn(), removeTagsFromUser: vi.fn() }))

import { getAiSettings } from './ai-settings'
import { addTagsToUser, removeTagsFromUser } from './tagging'
import { taipeiDate } from '~~/shared/time'
import {
  inactiveWindow,
  inactiveTagName,
  resolveInactiveTagId,
  clearInactiveTagOnReturn,
  scanInactiveTag,
  INACTIVE_TAG_DESCRIPTION,
  _clearInactiveTagCacheForTest,
} from './inactive-tag'

const DAY = 86_400_000
const WS = 'ws1'

/**
 * tags 集合的迷你假 db：where 鏈固定回 docs，doc() 支援 set/create/update 記錄呼叫。
 * 2026-11-04 起建立走 `system-tag.ts` 的 create（固定 id），記在 setCalls 裡一起數（「建了幾顆」是同一件事）。
 */
function fakeTagsDb(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  const setCalls: Array<{ id: string; data: any }> = []
  const updateCalls: Array<{ id: string; data: any }> = []
  const q: any = {
    where: vi.fn(() => q),
    limit: vi.fn(() => q),
    get: vi.fn(async () => ({ docs: docs.map(d => ({ id: d.id, data: () => d.data })) })),
  }
  const db: any = {
    collection: vi.fn(() => ({
      ...q,
      doc: (id: string) => ({
        set: async (data: any) => { setCalls.push({ id, data }) },
        create: async (data: any) => { setCalls.push({ id, data }) },
        update: async (data: any) => { updateCalls.push({ id, data }) },
      }),
      where: q.where,
    })),
  }
  return { db, setCalls, updateCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
  _clearInactiveTagCacheForTest()
})

describe('inactiveWindow：掃描窗口有界', () => {
  it('窗口＝[cutoff-7天, cutoff)，不是敞開到 epoch', () => {
    const now = 1_000_000 * DAY
    const { startMs, endMs } = inactiveWindow(now, 60)
    expect(endMs).toBe(now - 60 * DAY)
    expect(endMs - startMs).toBe(7 * DAY) // 有界：最多回補 7 天，讀取費不隨資料變老而暴衝
    expect(startMs).toBeGreaterThan(0)
  })
})

describe('clearInactiveTagOnReturn：回訊摘標', () => {
  it('沒超過門檻（59 天）→ 讀完設定就返回，不查標籤也不摘', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ inactiveTag: { enabled: true, days: 60 } } as any)
    const { db } = fakeTagsDb([])
    const now = 1_000_000 * DAY
    const ok = await clearInactiveTagOnReturn(db, WS, 'ws1_U1', now - 59 * DAY, now)
    expect(ok).toBe(false)
    expect(db.collection).not.toHaveBeenCalled() // 常態路徑零 Firestore 讀取
    expect(removeTagsFromUser).not.toHaveBeenCalled()
  })

  it('超過門檻且標籤存在 → 摘掉並回 true', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ inactiveTag: { enabled: true, days: 60 } } as any)
    vi.mocked(removeTagsFromUser).mockResolvedValue({ removed: ['tag9'], skipped: [] })
    const { db } = fakeTagsDb([{ id: 'tag9', data: { name: '60 天沒互動' } }])
    const now = 1_000_000 * DAY
    const ok = await clearInactiveTagOnReturn(db, WS, 'ws1_U1', now - 61 * DAY, now)
    expect(ok).toBe(true)
    expect(removeTagsFromUser).toHaveBeenCalledWith('ws1_U1', ['tag9'], 'system', 'inactive-tag:return', WS)
  })

  it('功能關閉 → 不動作（摘標尊重工作區開關）', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ inactiveTag: { enabled: false, days: 60 } } as any)
    const { db } = fakeTagsDb([{ id: 'tag9', data: {} }])
    const now = 1_000_000 * DAY
    expect(await clearInactiveTagOnReturn(db, WS, 'ws1_U1', now - 90 * DAY, now)).toBe(false)
    expect(removeTagsFromUser).not.toHaveBeenCalled()
  })

  it('工作區還沒有這個標籤 → 不建立（熱路徑不做多餘寫入）', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ inactiveTag: { enabled: true, days: 60 } } as any)
    const { db, setCalls } = fakeTagsDb([]) // 查無標籤
    const now = 1_000_000 * DAY
    expect(await clearInactiveTagOnReturn(db, WS, 'ws1_U1', now - 90 * DAY, now)).toBe(false)
    expect(setCalls).toHaveLength(0)
    expect(removeTagsFromUser).not.toHaveBeenCalled()
  })

  it('內部出錯只吞不丟——收訊熱路徑不准被摘標弄掛', async () => {
    vi.mocked(getAiSettings).mockRejectedValue(new Error('firestore down'))
    const { db } = fakeTagsDb([])
    const now = 1_000_000 * DAY
    await expect(clearInactiveTagOnReturn(db, WS, 'ws1_U1', now - 90 * DAY, now)).resolves.toBe(false)
  })
})

describe('resolveInactiveTagId：系統標籤的建立與改名', () => {
  it('不存在＋createWithDays → 建立，名稱含天數', async () => {
    const { db, setCalls } = fakeTagsDb([])
    const id = await resolveInactiveTagId(db, WS, { createWithDays: 60 })
    // 固定 id（`system-tag.ts`）：同時建也只會有一顆
    expect(id).toBe(`${WS}__sys_inactive`)
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]!.id).toBe(`${WS}__sys_inactive`)
    expect(setCalls[0]!.data.name).toBe('60 天沒互動')
    expect(setCalls[0]!.data.code).toBe('sys_inactive')
    expect(setCalls[0]!.data.workspaceId).toBe(WS)
  })

  it('已存在但天數改了 → 改名跟上（名稱是「60 天沒互動」這種會騙人的字）', async () => {
    const { db, updateCalls } = fakeTagsDb([{ id: 'tag9', data: { name: '60 天沒互動' } }])
    const id = await resolveInactiveTagId(db, WS, { createWithDays: 90 })
    expect(id).toBe('tag9')
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.data.name).toBe('90 天沒互動')
  })

  it('名稱一致 → 不寫入（每日掃描不該天天白寫一筆）', async () => {
    const { db, updateCalls, setCalls } = fakeTagsDb([{ id: 'tag9', data: { name: '60 天沒互動' } }])
    await resolveInactiveTagId(db, WS, { createWithDays: 60 })
    expect(updateCalls).toHaveLength(0)
    expect(setCalls).toHaveLength(0)
  })

  it('inactiveTagName：單一事實來源', () => {
    expect(inactiveTagName(60)).toBe('60 天沒互動')
  })

  it('`D-154`：說明還是「沒來訊」那句舊字 → 換成「沒傳訊息、也沒按選單或按鈕」', async () => {
    const { db, updateCalls } = fakeTagsDb([{ id: 'tag9', data: {
      name: '60 天沒互動',
      description: '系統自動維護：超過設定天數沒來訊的客人會被貼上，一回來就自動摘掉。天數在 AI 設定頁調整。',
    } }])
    await resolveInactiveTagId(db, WS, { createWithDays: 60 })
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.data.description).toBe(INACTIVE_TAG_DESCRIPTION)
    expect(updateCalls[0]!.data.name).toBeUndefined() // 名稱沒變就不碰
  })

  it('⛔ 店家自己改過的說明不動', async () => {
    const { db, updateCalls } = fakeTagsDb([{ id: 'tag9', data: { name: '60 天沒互動', description: '很久沒買的客人' } }])
    await resolveInactiveTagId(db, WS, { createWithDays: 60 })
    expect(updateCalls).toHaveLength(0)
  })
})

const at = (ms: number) => ({ toMillis: () => ms })
/** 落在 60 天門檻窗口 [67 天前, 60 天前) 裡的時間 */
const IN_WINDOW_MS = Date.now() - 62 * DAY

/**
 * 每日掃描的假 db：記下對 conversations 下的每一個條件；修復掃描的 getAll 回 seed 的對話。
 * 只做到 scanInactiveTag 會走到的那幾條路。
 * - windowDocs：窗口查詢的候選（字串＝時間不重要）；查詢會照 `<`／`>=`／limit 真的篩，
 *   「下一輪接著做」才驗得到游標有沒有接對
 * - taggedUserIds：已經貼過的人（userTags `{uid}_tag9` 存在；修復掃描也拿這批）
 * - state：cronState 那份；寫入會 merge 回來，同一個 db 連跑兩輪＝真的下一輪
 */
function fakeScanDb(seed: {
  windowDocs?: Array<string | { id: string, ms: number }>
  taggedUserIds?: string[]
  convs?: Record<string, Record<string, unknown>>
  state?: Record<string, unknown>
  /** 有哪些帳號（預設只有 WS）；只拿來測「帳號之間同時做」，cronState 等其他部分不分帳號 */
  workspaces?: string[]
}) {
  const convCalls: Array<[string, ...unknown[]]> = []
  const stateWrites: Array<Record<string, unknown>> = []
  const state: Record<string, unknown> = { ...seed.state }
  let transactions = 0
  const chain = (onGet: (calls: Array<[string, ...unknown[]]>) => any, record?: Array<[string, ...unknown[]]>) => {
    const own: Array<[string, ...unknown[]]> = []
    const q: any = {}
    for (const m of ['where', 'orderBy', 'limit', 'select', 'startAfter']) {
      q[m] = (...a: unknown[]) => { record?.push([m, ...a]); own.push([m, ...a]); return q }
    }
    q.get = async () => onGet(own)
    return q
  }
  const docsOf = (ids: string[], data: (id: string) => Record<string, unknown>) =>
    ({ docs: ids.map(id => ({ id, data: () => data(id) })), size: ids.length, empty: ids.length === 0 })
  const tagged = new Set((seed.taggedUserIds ?? []).map(u => `${u}_tag9`))
  const window = (seed.windowDocs ?? []).map((d, i) => typeof d === 'string' ? { id: d, ms: IN_WINDOW_MS - i } : d)

  const stateRef = {
    get: async () => ({ data: () => (Object.keys(state).length ? { ...state } : undefined) }),
    set: async (data: Record<string, unknown>) => { stateWrites.push(data); Object.assign(state, data) },
  }
  const db: any = {
    collection: (name: string) => {
      if (name === 'workspaces') return chain(() => docsOf(seed.workspaces ?? [WS], () => ({})))
      if (name === 'tags') return { ...chain(() => docsOf(['tag9'], () => ({ name: '60 天沒互動' }))), doc: () => ({ update: async () => {} }) }
      if (name === 'cronState') return { doc: () => stateRef }
      if (name === 'userTags') {
        return {
          ...chain(() => docsOf((seed.taggedUserIds ?? []).map(u => `ut_${u}`), id => ({ userId: id.slice(3) }))),
          doc: (id: string) => ({ col: 'userTags', id }),
        }
      }
      if (name === 'conversations') {
        return {
          ...chain((calls) => {
            let rows = [...window].sort((a, b) => b.ms - a.ms)
            for (const [m, f, op, v] of calls) {
              if (m === 'where' && f === 'lastPeerActivityAt' && op === '<') rows = rows.filter(r => r.ms < (v as any).__ms)
              if (m === 'where' && f === 'lastPeerActivityAt' && op === '>=') rows = rows.filter(r => r.ms >= (v as any).__ms)
              if (m === 'limit') rows = rows.slice(0, f as number)
            }
            return {
              docs: rows.map(r => ({ id: r.id, get: (k: string) => (k === 'lastPeerActivityAt' ? at(r.ms) : undefined), data: () => ({}) })),
              size: rows.length,
              empty: rows.length === 0,
            }
          }, convCalls),
          doc: (id: string) => ({ col: 'conversations', id }),
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
    getAll: async (...refs: Array<{ col: string, id: string }>) => refs.map(r => (r.col === 'userTags'
      ? { id: r.id, exists: tagged.has(r.id), data: (): Record<string, unknown> | undefined => undefined }
      : { id: r.id, data: (): Record<string, unknown> | undefined => seed.convs?.[r.id] })),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      transactions += 1
      return fn({ get: (ref: typeof stateRef) => ref.get(), set: (ref: typeof stateRef, data: Record<string, unknown>) => ref.set(data) })
    },
  }
  return { db, convCalls, state, stateWrites, transactions: () => transactions }
}

describe('scanInactiveTag：看「最後一次有動作」（`D-154`）', () => {
  beforeEach(() => {
    vi.mocked(getAiSettings).mockResolvedValue({ inactiveTag: { enabled: true, days: 60 } } as any)
    vi.mocked(addTagsToUser).mockResolvedValue({ added: ['tag9'], skipped: [] } as any)
    vi.mocked(removeTagsFromUser).mockResolvedValue({ removed: ['tag9'], skipped: [] })
  })

  it('貼標窗口查的是 lastPeerActivityAt（傳訊息或按選單／按鈕），⛔ 不是只算傳訊息的 lastInboundMessageAt', async () => {
    const { db, convCalls } = fakeScanDb({ windowDocs: ['ws1_U1'] })
    const stats = await scanInactiveTag(db)
    const fields = convCalls.filter(c => c[0] === 'where' || c[0] === 'orderBy').map(c => c[1])
    expect(fields).toContain('lastPeerActivityAt')
    expect(fields).not.toContain('lastInboundMessageAt')
    // 照新到舊＝吃現成的 (workspaceId, lastPeerActivityAt DESC) 索引；改方向要另開索引
    expect(convCalls).toContainEqual(['orderBy', 'lastPeerActivityAt', 'desc'])
    expect(stats.tagged).toBe(1)
    expect(addTagsToUser).toHaveBeenCalledWith('ws1_U1', ['tag9'], 'system', 'inactive-tag:scan', WS)
  })

  it('修復掃描：兩個多月沒打字、但前天還在按選單的客人 → 摘掉；真的沒動靜的 → 留著', async () => {
    const now = Date.now()
    const { db } = fakeScanDb({
      taggedUserIds: ['ws1_menu', 'ws1_quiet'],
      convs: {
        ws1_menu: { lastInboundMessageAt: at(now - 70 * DAY), lastPeerActivityAt: at(now - 2 * DAY) },
        ws1_quiet: { lastInboundMessageAt: at(now - 70 * DAY), lastPeerActivityAt: at(now - 70 * DAY) },
      },
    })
    const stats = await scanInactiveTag(db)
    expect(stats.repaired).toBe(1)
    expect(removeTagsFromUser).toHaveBeenCalledTimes(1)
    expect(removeTagsFromUser).toHaveBeenCalledWith('ws1_menu', ['tag9'], 'system', 'inactive-tag:repair', WS)
  })
})

/**
 * `E-49`（2026-11-04）：MYFEEL 半夜這件從 5 分鐘拖到 35 分鐘，還沒做完之前每 10 分鐘那輪又從頭跑一份。
 * 釘三件事：插「我在做」的牌子、先批讀誰貼過再一次多位同時貼、時間到記下做到哪下一輪接著做。
 */
describe('scanInactiveTag：不重複跑、不一位一位、做不完接著做（`E-49`）', () => {
  const today = taipeiDate()
  const added = { added: ['tag9'], skipped: [], hits: [] } as any

  beforeEach(() => {
    vi.mocked(getAiSettings).mockResolvedValue({ inactiveTag: { enabled: true, days: 60 } } as any)
    vi.mocked(addTagsToUser).mockResolvedValue(added)
    vi.mocked(removeTagsFromUser).mockResolvedValue({ removed: ['tag9'], skipped: [] })
  })

  it('已經貼過的人不再丟進 addTagsToUser（以前每晚重掃就把「被判到幾次」+1、每位多一次寫入）', async () => {
    const { db } = fakeScanDb({ windowDocs: ['ws1_U1', 'ws1_U2', 'ws1_U3'], taggedUserIds: ['ws1_U1', 'ws1_U3'] })
    const stats = await scanInactiveTag(db)
    expect(addTagsToUser).toHaveBeenCalledTimes(1)
    expect(addTagsToUser).toHaveBeenCalledWith('ws1_U2', ['tag9'], 'system', 'inactive-tag:scan', WS)
    expect(stats.tagged).toBe(1)
  })

  it('一次多位同時貼（最多 20 位），不是一位一位等', async () => {
    let inFlight = 0
    let maxInFlight = 0
    vi.mocked(addTagsToUser).mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 0))
      inFlight -= 1
      return added
    })
    const ids = Array.from({ length: 25 }, (_, i) => `ws1_U${i}`)
    const { db } = fakeScanDb({ windowDocs: ids })
    const stats = await scanInactiveTag(db)
    expect(stats.tagged).toBe(25)
    expect(maxInFlight).toBe(20)
  })

  it('帳號之間也同時做（最多 10 個）——一個一個做，10 個帳號就超過一輪的時間', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const seen: string[] = []
    vi.mocked(getAiSettings).mockImplementation(async (wid: string) => {
      seen.push(wid)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 0))
      inFlight -= 1
      return { inactiveTag: { enabled: false, days: 60 } } as any
    })
    const ids = Array.from({ length: 13 }, (_, i) => `w${String(i).padStart(2, '0')}`)
    const { db } = fakeScanDb({ workspaces: ids })
    await scanInactiveTag(db)
    expect(maxInFlight).toBe(10)
    expect(seen.sort()).toEqual(ids) // 每個帳號剛好一次
  })

  it('別輪正在做（牌子還沒過期）→ 這個帳號跳過，一個客人都不碰', async () => {
    const { db, convCalls, stateWrites } = fakeScanDb({ windowDocs: ['ws1_U1'], state: { leaseUntil: Date.now() + 60_000 } })
    const stats = await scanInactiveTag(db)
    expect(stats.busy).toBe(1)
    expect(convCalls).toHaveLength(0)
    expect(addTagsToUser).not.toHaveBeenCalled()
    expect(stateWrites).toHaveLength(0)
  })

  it('牌子過期了（那輪死掉了）→ 接手做完，收回牌子、記今天做完、用了 1 輪', async () => {
    const { db, state } = fakeScanDb({ windowDocs: ['ws1_U1'], state: { leaseUntil: Date.now() - 1 } })
    const stats = await scanInactiveTag(db)
    expect(stats.busy).toBe(0)
    expect(stats.tagged).toBe(1)
    expect(state).toMatchObject({ lastRunDay: today, leaseUntil: 0, progress: null, lastRunTicks: 1 })
  })

  it('今天做完了 → 只讀一次狀態，不開交易、不查客人', async () => {
    const { db, convCalls, transactions } = fakeScanDb({ windowDocs: ['ws1_U1'], state: { lastRunDay: today } })
    await scanInactiveTag(db)
    expect(transactions()).toBe(0)
    expect(convCalls).toHaveLength(0)
  })

  it('時間到 → 記下做到哪、收回牌子、不記今天做完；下一輪從那裡接著做，每位剛好貼一次', async () => {
    // 45 位都還沒貼；每貼一位時鐘走 1 秒 → 第一批 20 位貼完就超過 15 秒，停在第 21 位
    const docs = Array.from({ length: 45 }, (_, i) => ({ id: `ws1_U${i}`, ms: IN_WINDOW_MS - i * 1000 }))
    let now = Date.now()
    let step = 1000
    vi.mocked(addTagsToUser).mockImplementation(async () => {
      now += step
      return added
    })
    const { db, state, convCalls } = fakeScanDb({ windowDocs: docs })

    const first = await scanInactiveTag(db, { clock: () => now })
    expect(first).toMatchObject({ tagged: 20, paused: 1 })
    expect(state.lastRunDay).toBeUndefined()
    expect(state.leaseUntil).toBe(0)
    // 游標＝第 21 位的時間 +1ms、用「<」：跟他同一毫秒的人下一輪也看得到
    expect(state.progress).toEqual({ day: today, phase: 'scan', cursorMs: docs[20]!.ms + 1, left: 300 - 20, ticks: 1 })

    now += 10 * 60_000 // 10 分鐘後下一輪（這輪不卡，一次做完）
    step = 0
    convCalls.length = 0
    const second = await scanInactiveTag(db, { clock: () => now })
    expect(second).toMatchObject({ tagged: 25, paused: 0 })
    expect(convCalls).toContainEqual(['limit', 280])
    const taggedIds = vi.mocked(addTagsToUser).mock.calls.map(c => c[0])
    expect(taggedIds).toHaveLength(45)
    expect(new Set(taggedIds).size).toBe(45)
    expect(state).toMatchObject({ lastRunDay: today, leaseUntil: 0, progress: null, lastRunTicks: 2 })
  })

  it('做到一半的紀錄是昨天的 → 當沒有，從窗口最新的開始', async () => {
    const { db, convCalls } = fakeScanDb({
      windowDocs: ['ws1_U1'],
      state: { progress: { day: '2000-01-01', phase: 'repair', cursorMs: 5, left: 3, ticks: 4 } },
    })
    const stats = await scanInactiveTag(db)
    expect(stats.tagged).toBe(1)
    expect(convCalls).toContainEqual(['limit', 300])
  })

  it('上一輪貼完、停在修復掃描 → 這輪不再查窗口，直接做修復', async () => {
    const now = Date.now()
    const { db, convCalls, state } = fakeScanDb({
      windowDocs: ['ws1_U1'],
      taggedUserIds: ['ws1_menu'],
      convs: { ws1_menu: { lastPeerActivityAt: at(now - 2 * DAY) } },
      state: { progress: { day: today, phase: 'repair', cursorMs: null, left: 0, ticks: 1 } },
    })
    const stats = await scanInactiveTag(db)
    expect(convCalls).toHaveLength(0)
    expect(addTagsToUser).not.toHaveBeenCalled()
    expect(stats.repaired).toBe(1)
    expect(state).toMatchObject({ lastRunDay: today, lastRunTicks: 2 })
  })
})
