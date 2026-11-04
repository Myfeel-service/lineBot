/**
 * 客人生日（`C-57`，birthday-tag.ts）。釘的是會變成業務問題的行為：
 *   1. ⛔ 只存月日、不存年；workspaceId 一起寫（舊客人文件沒有這欄，每月查詢會漏掉他）
 *   2. 這個月就是生日月＝馬上貼「本月壽星」；改到別的月份＝摘掉
 *   3. 每月對齊：只跑開了功能的工作區、一個月一次、做不完不記「做完了」
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn(), removeTagsFromUser: vi.fn() }))

import { getAiSettings } from './ai-settings'
import { addTagsToUser, removeTagsFromUser } from './tagging'
import { _clearBirthdayTagCacheForTest, birthdayPeopleOn, birthdayStats, loadBirthdayDigest, saveCustomerBirthday, syncBirthdayMonthTag } from './birthday-tag'

const WS = 'ws1'
const NOV = new Date('2026-11-04T04:00:00Z') // 台北 11 月

/**
 * 迷你假 db：每個集合一份 docs；where 只認等號，照條件篩；doc(id) 讀寫記錄下來。
 */
function fakeDb(init: Record<string, Array<{ id: string, data: Record<string, any> }>>) {
  const store: Record<string, Map<string, Record<string, any>>> = {}
  for (const [name, docs] of Object.entries(init)) store[name] = new Map(docs.map(d => [d.id, { ...d.data }]))
  const writes: Array<{ col: string, id: string, data: any }> = []
  const reads: string[] = []
  const col = (name: string) => {
    store[name] ??= new Map()
    const filters: Array<[string, unknown]> = []
    const rows = () => [...store[name]!.entries()].filter(([, d]) => filters.every(([f, v]) => d[f] === v))
    const q: any = {
      where: (f: string, _op: string, v: unknown) => { filters.push([f, v]); return q },
      select: () => q,
      limit: () => q,
      get: async () => { reads.push(name); return { docs: rows().map(([id, d]) => ({ id, data: () => d })) } },
      count: () => ({ get: async () => ({ data: () => ({ count: rows().length }) }) }),
      doc: (id: string) => ({
        get: async () => { reads.push(`${name}/${id}`); return { data: () => store[name]!.get(id) } },
        set: async (data: any) => {
          writes.push({ col: name, id, data })
          store[name]!.set(id, { ...(store[name]!.get(id) ?? {}), ...data })
        },
      }),
    }
    return q
  }
  return { db: { collection: vi.fn((n: string) => col(n)) } as any, writes, reads, store }
}

beforeEach(() => {
  vi.clearAllMocks()
  _clearBirthdayTagCacheForTest()
  vi.mocked(addTagsToUser).mockResolvedValue({ added: ['t-bday'], skipped: [], hits: [] } as any)
  vi.mocked(removeTagsFromUser).mockResolvedValue({ removed: ['t-bday'], skipped: [] })
})

const tag = { id: 't-bday', data: { workspaceId: WS, code: 'sys_birthday_month' } }

describe('saveCustomerBirthday', () => {
  it('⛔ 只寫月、日（沒有年），workspaceId 一起寫', async () => {
    const { db, writes } = fakeDb({ tags: [tag] })
    await saveCustomerBirthday(db, WS, 'U1', { month: 3, day: 12 }, NOV)
    const w = writes.find(x => x.col === 'users')!
    expect(w.id).toBe('ws1_U1')
    expect(w.data).toMatchObject({ workspaceId: WS, birthdayMonth: 3, birthdayDay: 12 })
    // birthdaySetDay 是「哪一天留的」（台北今天），⛔ 不是出生年；其餘欄位裡不可以有年份
    const { birthdaySetDay, ...rest } = w.data
    expect(birthdaySetDay).toBe('2026-11-04')
    expect(JSON.stringify(rest)).not.toMatch(/year|19\d\d|20\d\d/i)
  })

  it('這個月生日＝馬上貼「本月壽星」（沒有標籤就建）', async () => {
    const { db, writes } = fakeDb({})
    const r = await saveCustomerBirthday(db, WS, 'U1', { month: 11, day: 20 }, NOV)
    expect(r.changed).toBe(false)
    const created = writes.find(x => x.col === 'tags')!
    expect(created.data).toMatchObject({ code: 'sys_birthday_month', name: '本月壽星', createdBy: 'system' })
    expect(addTagsToUser).toHaveBeenCalledWith('ws1_U1', [created.id], 'system', 'birthday:set', WS)
  })

  it('從這個月改到別的月＝摘掉；回報 changed', async () => {
    const { db } = fakeDb({ tags: [tag], users: [{ id: 'ws1_U1', data: { birthdayMonth: 11, birthdayDay: 20 } }] })
    const r = await saveCustomerBirthday(db, WS, 'U1', { month: 5, day: 1 }, NOV)
    expect(r.changed).toBe(true)
    expect(removeTagsFromUser).toHaveBeenCalledWith('ws1_U1', ['t-bday'], 'system', 'birthday:changed', WS)
    expect(addTagsToUser).not.toHaveBeenCalled()
  })

  it('`D-170`：第一次留才記那一天（台北日期），改生日不動它', async () => {
    const first = fakeDb({ tags: [tag] })
    await saveCustomerBirthday(first.db, WS, 'U1', { month: 5, day: 1 }, NOV)
    expect(first.writes.find(x => x.col === 'users')!.data.birthdaySetDay).toBe('2026-11-04')
    const again = fakeDb({ tags: [tag], users: [{ id: 'ws1_U1', data: { birthdayMonth: 3, birthdayDay: 1, birthdaySetDay: '2026-10-01' } }] })
    await saveCustomerBirthday(again.db, WS, 'U1', { month: 5, day: 1 }, NOV)
    expect(again.writes.find(x => x.col === 'users')!.data.birthdaySetDay).toBeUndefined()
  })

  it('有 X 的對照組：別的月份、之前也不是這個月＝不貼不摘', async () => {
    const { db } = fakeDb({ tags: [tag] })
    await saveCustomerBirthday(db, WS, 'U1', { month: 5, day: 1 }, NOV)
    expect(addTagsToUser).not.toHaveBeenCalled()
    expect(removeTagsFromUser).not.toHaveBeenCalled()
  })
})

describe('syncBirthdayMonthTag（每月對齊）', () => {
  const base = () => ({
    workspaces: [{ id: WS, data: {} }],
    tags: [tag],
    users: [
      { id: 'ws1_A', data: { workspaceId: WS, birthdayMonth: 11 } },
      { id: 'ws1_B', data: { workspaceId: WS, birthdayMonth: 11 } },
      { id: 'ws1_C', data: { workspaceId: WS, birthdayMonth: 10 } },
      { id: 'ws2_D', data: { workspaceId: 'ws2', birthdayMonth: 11 } },
    ],
    userTags: [
      { id: 'x1', data: { workspaceId: WS, tagId: 't-bday', userId: 'ws1_C' } }, // 上個月的
      { id: 'x2', data: { workspaceId: WS, tagId: 't-bday', userId: 'ws1_A' } }, // 已經貼了
    ],
  })

  it('沒開功能的工作區連狀態都不讀', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ birthday: { enabled: false, gift: '' } } as any)
    const { db, reads } = fakeDb(base())
    const s = await syncBirthdayMonthTag(db, NOV)
    expect(s.workspaces).toBe(0)
    expect(reads.some(r => r.startsWith('cronState'))).toBe(false)
  })

  it('貼這個月的（已貼的不重貼）、摘上個月的、別的工作區不碰，做完記這個月', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ birthday: { enabled: true, gift: '' } } as any)
    const { db, writes } = fakeDb(base())
    const s = await syncBirthdayMonthTag(db, NOV)
    expect(vi.mocked(addTagsToUser).mock.calls.map(c => c[0])).toEqual(['ws1_B'])
    expect(vi.mocked(removeTagsFromUser).mock.calls.map(c => c[0])).toEqual(['ws1_C'])
    expect(s).toMatchObject({ workspaces: 1, tagged: 1, untagged: 1 })
    expect(writes.find(w => w.col === 'cronState')?.data).toMatchObject({ doneMonth: '2026-11' })
  })

  it('這個月做過了＝跳過', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ birthday: { enabled: true, gift: '' } } as any)
    const { db } = fakeDb({ ...base(), cronState: [{ id: `birthday-tag-${WS}`, data: { doneMonth: '2026-11' } }] })
    const s = await syncBirthdayMonthTag(db, NOV)
    expect(s.workspaces).toBe(0)
    expect(addTagsToUser).not.toHaveBeenCalled()
  })
})

describe('早上報告（`D-170`）', () => {
  const people = () => fakeDb({
    users: [
      { id: 'ws1_UA', data: { workspaceId: WS, birthdayMonth: 2, birthdayDay: 28, displayName: '阿明', lineUserId: 'UA' } },
      { id: 'ws1_UB', data: { workspaceId: WS, birthdayMonth: 2, birthdayDay: 29, displayName: '小美' } }, // 舊文件沒有 lineUserId
      { id: 'ws1_UC', data: { workspaceId: WS, birthdayMonth: 2, birthdayDay: 28, displayName: '封鎖的', isBlocked: true } },
      { id: 'ws2_UD', data: { workspaceId: 'ws2', birthdayMonth: 2, birthdayDay: 28, displayName: '別家' } },
      { id: 'ws1_UE', data: { workspaceId: WS, birthdaySetDay: '2027-02-27' } },
      { id: 'ws1_UF', data: { workspaceId: WS, birthdaySetDay: '2027-02-27' } },
      { id: 'ws1_UG', data: { workspaceId: WS, birthdaySetDay: '2027-02-26' } },
    ],
  })

  it('今天的壽星：平年 2/28 連 2/29 一起；已封鎖、別家的不算；LINE 編號沒存就從文件 id 還原', async () => {
    const { db } = people()
    expect(await birthdayPeopleOn(db, WS, '2027-02-28')).toEqual([
      { lineUserId: 'UA', displayName: '阿明' },
      { lineUserId: 'UB', displayName: '小美' },
    ])
  })

  it('幾位留了生日＝那幾天加起來；今天的壽星點名最多 3 位', async () => {
    const { db } = people()
    const f = await loadBirthdayDigest(db, WS, ['2027-02-26', '2027-02-27'], '2027-02-28')
    expect(f).toEqual({ newlySet: 3, today: { count: 2, names: ['阿明', '小美'] } })
  })

  it('⛔ 查不到不當成 0：哪一半壞了哪一半回 null', async () => {
    const broken: any = { collection: () => { throw new Error('boom') } }
    expect(await loadBirthdayDigest(broken, WS, ['2027-02-27'], '2027-02-28')).toEqual({ newlySet: null, today: null })
  })
})

describe('birthdayStats', () => {
  it('十二個月各幾位、合計、這個月（只算這個工作區）', async () => {
    const { db } = fakeDb({
      users: [
        { id: 'ws1_A', data: { workspaceId: WS, birthdayMonth: 11 } },
        { id: 'ws1_B', data: { workspaceId: WS, birthdayMonth: 3 } },
        { id: 'ws2_D', data: { workspaceId: 'ws2', birthdayMonth: 11 } },
      ],
    })
    const s = await birthdayStats(db, WS, NOV)
    expect(s.total).toBe(2)
    expect(s.month).toBe(11)
    expect(s.thisMonth).toBe(1)
    expect(s.byMonth[2]).toBe(1)
  })
})
