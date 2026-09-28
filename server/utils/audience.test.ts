import { describe, expect, it, vi } from 'vitest'

/**
 * 受眾解析一定要帶帳號（`G-104`①，2026-09-29 權限盤點）。
 * 每一段查詢都是 `if (workspaceId)` 才加帳號過濾：空字串進來＝**全站**名單，
 * `/api/audience/estimate` 曾因超管沒帶帳號回全站人數。
 */

const { reads } = vi.hoisted(() => ({ reads: [] as { col: string, filters: [string, unknown][] }[] }))

vi.mock('./firebase', () => {
  const query = (col: string, filters: [string, unknown][] = []): any => ({
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    get: async () => {
      reads.push({ col, filters })
      return { docs: [] }
    },
  })
  return { getDb: () => ({ collection: (col: string) => query(col) }) }
})

const { resolveAudienceUserIds, estimateAudienceCount } = await import('./audience')

const ALL = { conditions: [], joinedAfter: null, joinedBefore: null, isBlocked: null } as never

describe('resolveAudienceUserIds', () => {
  it('🔴 沒帶帳號 → 直接擋，⛔ 一筆都不讀（不會變成讀全站好友）', async () => {
    reads.length = 0
    await expect(resolveAudienceUserIds(ALL, '')).rejects.toThrow(/workspaceId/)
    await expect(estimateAudienceCount(ALL, '  ')).rejects.toThrow(/workspaceId/)
    expect(reads).toHaveLength(0)
  })

  it('帶了帳號 → 查詢一定加上帳號過濾', async () => {
    reads.length = 0
    await resolveAudienceUserIds(ALL, 'w1')
    expect(reads).toEqual([{ col: 'users', filters: [['workspaceId', 'w1']] }])
  })
})
