import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-425`：模組近 30 天幾位客人收到。
 * 釘三件事：①記帳失敗不丟錯（不可以擋住客人收回覆）②同一位客人好幾天、好幾次只算一位 ③還沒記滿 30 天要說得出從哪天起。
 */

const docs = new Map<string, Record<string, any>>()
const setCalls: Array<{ id: string, data: any, opts: any }> = []
let failSet = false

vi.mock('./firebase', () => ({
  getDb: () => ({
    collection: () => ({
      doc: (id: string) => ({
        id,
        set: async (data: any, opts: any) => {
          if (failSet) throw new Error('contention')
          setCalls.push({ id, data, opts })
        },
      }),
    }),
    getAll: async (...refs: Array<{ id: string }>) => refs.map(r => ({
      exists: docs.has(r.id),
      get: (field: string) => docs.get(r.id)?.[field],
    })),
  }),
}))

const { recordModuleSent, readFlowUsage } = await import('./flow-usage')

/** 台北 10/29 08:00（UTC 10/29 00:00） */
const NOW = new Date('2026-10-29T00:00:00Z')

beforeEach(() => {
  docs.clear()
  setCalls.length = 0
  failSet = false
})

describe('記一筆', () => {
  it('記在「這個帳號、台北的這一天」那份，模組底下送幾次、送給誰', async () => {
    // UTC 10/28 17:00＝台北 10/29 01:00：日期要算成 10/29，不是 10/28
    await recordModuleSent('ws1', 'mod-a', 'Uaaa', new Date('2026-10-28T17:00:00Z'))
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]!.id).toBe('ws1_2026-10-29')
    expect(setCalls[0]!.opts).toEqual({ merge: true })
    expect(setCalls[0]!.data.workspaceId).toBe('ws1')
    expect(Object.keys(setCalls[0]!.data.modules)).toEqual(['mod-a'])
    expect(setCalls[0]!.data.modules['mod-a']).toHaveProperty('sends')
    expect(setCalls[0]!.data.modules['mod-a']).toHaveProperty('users')
  })

  it('⛔ 寫不進去也不丟錯（記帳失敗不可以影響客人收到回覆）', async () => {
    failSet = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordModuleSent('ws1', 'mod-a', 'Uaaa', NOW)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('少了帳號、模組或客人就不記', async () => {
    await recordModuleSent('', 'mod-a', 'Uaaa', NOW)
    await recordModuleSent('ws1', '', 'Uaaa', NOW)
    await recordModuleSent('ws1', 'mod-a', '', NOW)
    expect(setCalls).toHaveLength(0)
  })
})

describe('讀近 30 天', () => {
  it('⭐ 同一位客人好幾天、好幾次只算一位；次數照加', async () => {
    docs.set('ws1_2026-10-20', { modules: { 'mod-a': { sends: 3, users: ['Uaaa', 'Ubbb'] } } })
    docs.set('ws1_2026-10-28', { modules: { 'mod-a': { sends: 2, users: ['Uaaa'] }, 'mod-b': { sends: 1, users: ['Uccc'] } } })

    const res = await readFlowUsage('ws1', NOW)

    expect(res.modules['mod-a']).toEqual({ users: 2, sends: 5 })
    expect(res.modules['mod-b']).toEqual({ users: 1, sends: 1 })
    expect(res.modules['mod-c']).toBeUndefined()
  })

  it('算的是今天往回 30 個台北日期（含今天）', async () => {
    const res = await readFlowUsage('ws1', NOW)
    expect(res.from).toBe('2026-09-30')
    expect(res.to).toBe('2026-10-29')
  })

  it('⭐ 還沒記滿 30 天：說得出從哪天起（最早有紀錄的那天）', async () => {
    docs.set('ws1_2026-10-25', { modules: { 'mod-a': { sends: 1, users: ['Uaaa'] } } })
    docs.set('ws1_2026-10-27', { modules: { 'mod-a': { sends: 1, users: ['Uaaa'] } } })
    expect((await readFlowUsage('ws1', NOW)).trackedSince).toBe('2026-10-25')
  })

  it('對照組：一筆都沒有＝trackedSince 是 null（畫面不可以說成「0 位」）', async () => {
    const res = await readFlowUsage('ws1', NOW)
    expect(res.trackedSince).toBeNull()
    expect(res.modules).toEqual({})
  })

  it('30 天以前的不算（第 31 天那份不會被讀）', async () => {
    docs.set('ws1_2026-09-29', { modules: { 'mod-a': { sends: 9, users: ['Uold'] } } })
    const res = await readFlowUsage('ws1', NOW)
    expect(res.modules['mod-a']).toBeUndefined()
  })

  it('別的帳號的不算', async () => {
    docs.set('ws2_2026-10-28', { modules: { 'mod-a': { sends: 1, users: ['Uaaa'] } } })
    expect((await readFlowUsage('ws1', NOW)).modules).toEqual({})
  })
})
