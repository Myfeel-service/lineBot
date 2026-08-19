/**
 * C-45 維運額度桶：import LLM + 建索引 embedding 的月度防失控上限。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({}), increment: (n: number) => ({ n }) },
}))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
vi.mock('./billing', () => ({ getWorkspaceSubscription: vi.fn() }))

import {
  assertMaintenanceBudget,
  DEFAULT_MAINTENANCE_TOKEN_CAP,
  getMaintenanceBudgetStatus,
  invalidateMaintenanceBudgetCache,
} from './ai-usage'

function makeDb(fields: Record<string, number> | null) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: fields != null, data: () => fields }),
      }),
    }),
  } as any
}

beforeEach(() => invalidateMaintenanceBudgetCache())

describe('getMaintenanceBudgetStatus', () => {
  it('加總 import in/out + 建索引 embedding 三個桶；answered 對話桶不算', async () => {
    const db = makeDb({
      importInputTokens: 1_000_000,
      importOutputTokens: 2_000_000,
      buildEmbeddingTokens: 500_000,
      inputTokens: 99_000_000, // 對話桶：不在維運上限內
    })
    const s = await getMaintenanceBudgetStatus('ws1', db)
    expect(s.used).toBe(3_500_000)
    expect(s.blocked).toBe(false)
  })

  it('沒有用量文件 → 0 / 不擋', async () => {
    const s = await getMaintenanceBudgetStatus('ws1', makeDb(null))
    expect(s.used).toBe(0)
    expect(s.blocked).toBe(false)
  })

  it('達上限 → blocked；assertMaintenanceBudget 丟 429', async () => {
    const db = makeDb({ importInputTokens: DEFAULT_MAINTENANCE_TOKEN_CAP })
    expect((await getMaintenanceBudgetStatus('ws1', db)).blocked).toBe(true)
    invalidateMaintenanceBudgetCache()
    await expect(assertMaintenanceBudget('ws1', db)).rejects.toMatchObject({ statusCode: 429 })
  })

  it('60 秒快取：同 workspace 第二次不再讀 Firestore', async () => {
    let reads = 0
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            reads++
            return { exists: true, data: () => ({ importInputTokens: 1 }) }
          },
        }),
      }),
    } as any
    await getMaintenanceBudgetStatus('ws1', db)
    await getMaintenanceBudgetStatus('ws1', db)
    expect(reads).toBe(1)
  })
})
