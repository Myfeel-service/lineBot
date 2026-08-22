import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「同一個 LINE 官方帳號只能接在一個工作區」的把關（`D-18`，2026-08-21 老闆拍板「要擋」）。
 *
 * 為什麼這幾條要釘住：兩個工作區綁同一個頻道時，客人的訊息會整批進到 webhook 簽章
 * 先對上的那一邊，另一邊一則都收不到，而且**兩邊的檢查都是綠的**——這是最難自己發現
 * 的一種壞法（2026-08-19 老闆實測才挖出來）。所以：
 *   ① 認「同一個頻道」只能靠 LINE 的 bot userId，比 token 字串沒用（同一頻道可以發很多把）
 *   ② 問不到身分時**一律放行**——我方連不出去不可以變成客戶不能存自己的憑證
 *   ③ 自己重存自己的鑰匙不算撞號（否則改個名字都存不回去）
 */

vi.mock('~~/server/utils/line-webhook-remote', () => ({ fetchLineBotInfo: vi.fn() }))

const { fetchLineBotInfo } = await import('~~/server/utils/line-webhook-remote')
const {
  resolveChannelIdentity,
  findOtherWorkspacesOnChannel,
  checkChannelBindingConflict,
  channelConflictMessage,
} = await import('./line-channel-binding')

const mockBotInfo = vi.mocked(fetchLineBotInfo)

/** 每個 case 都用不同的 token 字串：模組內有 5 分鐘 token→身分快取，共用同一把會互相污染 */
let tokenSeq = 0
const freshToken = () => `token-${++tokenSeq}-${'x'.repeat(40)}`

/** 假 Firestore：只支援 workspaces.where(lineBotUserId==).limit().get() */
function fakeDb(rows: Array<{ id: string, lineBotUserId: string, name?: string }>) {
  return {
    collection: (name: string) => {
      if (name !== 'workspaces') throw new Error(`未預期的集合 ${name}`)
      return {
        where: (field: string, op: string, value: string) => {
          if (field !== 'lineBotUserId' || op !== '==') throw new Error('未預期的查詢')
          const hits = rows.filter(r => r.lineBotUserId === value)
          return {
            limit: (n: number) => ({
              get: async () => ({ docs: hits.slice(0, n).map(r => ({ id: r.id, data: () => ({ name: r.name }) })) }),
            }),
          }
        },
      }
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('問 LINE：這把鑰匙是哪個官方帳號的', () => {
  it('問得到就回頻道身分', async () => {
    mockBotInfo.mockResolvedValue({ ok: true, data: { displayName: '品感覺', basicId: '@efn', userId: 'Ubot1' } })
    await expect(resolveChannelIdentity(freshToken())).resolves.toEqual({
      kind: 'ok', botUserId: 'Ubot1', displayName: '品感覺', basicId: '@efn',
    })
  })

  it('🔴 只有 LINE 明說不認得（401／403）才判定鑰匙是假的', async () => {
    for (const status of [401, 403]) {
      mockBotInfo.mockResolvedValue({ ok: false, status, body: {} })
      await expect(resolveChannelIdentity(freshToken())).resolves.toEqual({ kind: 'invalid' })
    }
  })

  it('🔴 LINE 忙、我方連不出去 → 「這次問不到」，不可以當成假鑰匙', async () => {
    for (const status of [429, 500, 503]) {
      mockBotInfo.mockResolvedValue({ ok: false, status, body: {} })
      await expect(resolveChannelIdentity(freshToken())).resolves.toEqual({ kind: 'unknown' })
    }
    mockBotInfo.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(resolveChannelIdentity(freshToken())).resolves.toEqual({ kind: 'unknown' })
  })

  it('LINE 回 200 卻沒給 userId：沒有身分就無從比對，當成問不到', async () => {
    mockBotInfo.mockResolvedValue({ ok: true, data: { displayName: 'x', basicId: '@x', userId: '' } })
    await expect(resolveChannelIdentity(freshToken())).resolves.toEqual({ kind: 'unknown' })
  })

  it('沒帶鑰匙不會去打 LINE', async () => {
    await expect(resolveChannelIdentity('  ')).resolves.toEqual({ kind: 'unknown' })
    expect(mockBotInfo).not.toHaveBeenCalled()
  })
})

describe('誰綁著同一個官方帳號', () => {
  const db = fakeDb([
    { id: 'wsA', lineBotUserId: 'Ubot1', name: 'Myfeel Test' },
    { id: 'wsB', lineBotUserId: 'Ubot1', name: 'Kevin Test' },
    { id: 'wsC', lineBotUserId: 'Ubot2', name: '鼴究室' },
  ])

  it('🔴 自己不算撞號（否則自己重存自己的鑰匙會被擋掉）', async () => {
    await expect(findOtherWorkspacesOnChannel(db, 'Ubot1', 'wsA')).resolves.toEqual([
      { workspaceId: 'wsB', name: 'Kevin Test' },
    ])
  })

  it('只有自己綁著就沒有撞號', async () => {
    await expect(findOtherWorkspacesOnChannel(db, 'Ubot2', 'wsC')).resolves.toEqual([])
  })

  it('沒有身分就不查（空字串不會撈出一整批）', async () => {
    await expect(findOtherWorkspacesOnChannel(db, '', 'wsA')).resolves.toEqual([])
  })
})

describe('存檔前的把關', () => {
  const db = fakeDb([{ id: 'wsA', lineBotUserId: 'Ubot1', name: 'Myfeel Test' }])

  it('撞到別人的頻道 → 回報撞號，呼叫端據此擋下來', async () => {
    mockBotInfo.mockResolvedValue({ ok: true, data: { displayName: 'x', basicId: '@x', userId: 'Ubot1' } })
    const r = await checkChannelBindingConflict(db, 'wsB', freshToken())
    expect(r.conflicts).toEqual([{ workspaceId: 'wsA', name: 'Myfeel Test' }])
  })

  it('🔴 問不到身分時放行：我方查不出來不該變成客戶不能上線', async () => {
    mockBotInfo.mockResolvedValue({ ok: false, status: 500, body: {} })
    const r = await checkChannelBindingConflict(db, 'wsB', freshToken())
    expect(r.identity.kind).toBe('unknown')
    expect(r.conflicts).toEqual([])
  })

  it('擋下來的話講的是後果與怎麼辦，不是欄位名', () => {
    const msg = channelConflictMessage([{ workspaceId: 'wsA', name: 'Myfeel Test' }])
    expect(msg).toContain('Myfeel Test')
    expect(msg).toContain('一則都收不到')
    expect(msg).not.toMatch(/botUserId|channelAccessToken|workspaceId/)
  })
})
