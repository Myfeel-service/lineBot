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
import { removeTagsFromUser } from './tagging'
import {
  inactiveWindow,
  inactiveTagName,
  resolveInactiveTagId,
  clearInactiveTagOnReturn,
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
})
