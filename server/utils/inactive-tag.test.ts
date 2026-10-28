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

/** tags 集合的迷你假 db：where 鏈固定回 docs，doc() 支援 set/update 記錄呼叫 */
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
    expect(id).toBeTruthy()
    expect(setCalls).toHaveLength(1)
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

/**
 * 每日掃描的假 db：記下對 conversations 下的每一個條件；修復掃描的 getAll 回 seed 的對話。
 * 只做到 scanInactiveTag 會走到的那幾條路。
 */
function fakeScanDb(seed: {
  windowDocs?: string[]
  taggedUserIds?: string[]
  convs?: Record<string, Record<string, unknown>>
}) {
  const convCalls: Array<[string, ...unknown[]]> = []
  const chain = (onGet: () => any, record?: Array<[string, ...unknown[]]>) => {
    const q: any = {}
    for (const m of ['where', 'orderBy', 'limit', 'select', 'startAfter']) {
      q[m] = (...a: unknown[]) => { record?.push([m, ...a]); return q }
    }
    q.get = async () => onGet()
    return q
  }
  const docsOf = (ids: string[], data: (id: string) => Record<string, unknown>) =>
    ({ docs: ids.map(id => ({ id, data: () => data(id) })), size: ids.length, empty: ids.length === 0 })

  const db: any = {
    collection: (name: string) => {
      if (name === 'workspaces') return chain(() => docsOf([WS], () => ({})))
      if (name === 'tags') return { ...chain(() => docsOf(['tag9'], () => ({ name: '60 天沒互動' }))), doc: () => ({ update: async () => {} }) }
      if (name === 'cronState') return { doc: () => ({ get: async () => ({ data: () => undefined }), set: async () => {} }) }
      if (name === 'userTags') {
        return { ...chain(() => docsOf((seed.taggedUserIds ?? []).map(u => `ut_${u}`), id => ({ userId: id.slice(3) }))), doc: (id: string) => ({ id }) }
      }
      if (name === 'conversations') {
        return { ...chain(() => docsOf(seed.windowDocs ?? [], () => ({})), convCalls), doc: (id: string) => ({ id }) }
      }
      throw new Error(`unexpected collection ${name}`)
    },
    getAll: async (...refs: Array<{ id: string }>) => refs.map(r => ({ id: r.id, data: () => seed.convs?.[r.id] })),
  }
  return { db, convCalls }
}

const at = (ms: number) => ({ toMillis: () => ms })

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
