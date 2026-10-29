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
  AI_BUDGET_CAPS,
  aiBudgetMessage,
  aiBudgetResumeLabel,
  aiBudgetUsed,
  assertMaintenanceBudget,
  DEFAULT_MAINTENANCE_TOKEN_CAP,
  getMaintenanceBudgetStatus,
  invalidateMaintenanceBudgetCache,
} from './ai-usage'
import { isAiBudgetError } from './ai-usage-calls'

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
    // 三本帳共用同一次讀（快取存原始數字）：換一本查也不再讀
    await getMaintenanceBudgetStatus('ws1', db, 'assist')
    await getMaintenanceBudgetStatus('ws1', db, 'background')
    expect(reads).toBe(1)
  })
})

describe('`C-413` 三本帳各自只數自己、只擋自己', () => {
  const usage = {
    importInputTokens: 3_000_000,
    importOutputTokens: 1_000_000,
    buildEmbeddingTokens: 1_000_000,
    backgroundTokens: 2_000_000, // 上面那 5M 裡有 2M 是 AI 貼標建議、知識缺口掃描
    testInputTokens: 400_000,
    testOutputTokens: 100_000,
    testEmbeddingTokens: 0,
    assistTokens: 300_000, // 上面那 500k 裡有 300k 是小幫手、擬文案（其餘是測試對話、AI 產生腳本）
    inputTokens: 99_000_000, // 回答客人：哪一本都不算
  }

  it('店家加資料＝整理桶扣掉背景那份；背景＝backgroundTokens；後台自用＝assistTokens', () => {
    expect(aiBudgetUsed(usage, 'knowledge')).toBe(3_000_000)
    expect(aiBudgetUsed(usage, 'background')).toBe(2_000_000)
    expect(aiBudgetUsed(usage, 'assist')).toBe(300_000)
  })

  it('⛔ `C-414` 後台自用那本不數整個 test 桶：測試對話、AI 產生腳本沒被這本擋，數進來就是拿它們擋小幫手', async () => {
    const db = makeDb({ testInputTokens: AI_BUDGET_CAPS.assist * 2 })
    expect(aiBudgetUsed({ testInputTokens: AI_BUDGET_CAPS.assist * 2 }, 'assist')).toBe(0)
    await expect(assertMaintenanceBudget('ws1', db, 'assist')).resolves.toBeUndefined()
  })

  it('上線前的舊資料沒有 backgroundTokens：整桶都算店家那本（寧可多算）', () => {
    expect(aiBudgetUsed({ importInputTokens: 10, importOutputTokens: 5, buildEmbeddingTokens: 1 }, 'knowledge')).toBe(16)
    expect(aiBudgetUsed({ importInputTokens: 10 }, 'background')).toBe(0)
  })

  it('記帳壞掉（背景比整桶還多）：店家那本夾到 0，不出現負數', () => {
    expect(aiBudgetUsed({ importInputTokens: 1, backgroundTokens: 5 }, 'knowledge')).toBe(0)
  })

  it('⛔ 客人聊得多（背景那本滿了）不擋店家加資料、也不擋小幫手', async () => {
    const db = makeDb({ importInputTokens: AI_BUDGET_CAPS.background, backgroundTokens: AI_BUDGET_CAPS.background })
    expect((await getMaintenanceBudgetStatus('ws1', db, 'background')).blocked).toBe(true)
    expect((await getMaintenanceBudgetStatus('ws1', db, 'knowledge')).blocked).toBe(false)
    expect((await getMaintenanceBudgetStatus('ws1', db, 'assist')).blocked).toBe(false)
    await expect(assertMaintenanceBudget('ws1', db)).resolves.toBeUndefined()
  })

  it('⛔ 店家加資料到上限，不連帶停小幫手、擬推播文案（後台自用那本）', async () => {
    const db = makeDb({ importInputTokens: DEFAULT_MAINTENANCE_TOKEN_CAP })
    await expect(assertMaintenanceBudget('ws1', db)).rejects.toMatchObject({ statusCode: 429 })
    await expect(assertMaintenanceBudget('ws1', db, 'assist')).resolves.toBeUndefined()
    await expect(assertMaintenanceBudget('ws1', db, 'background')).resolves.toBeUndefined()
  })

  it('後台自用那本到上限只擋後台自用', async () => {
    const db = makeDb({ testInputTokens: AI_BUDGET_CAPS.assist, assistTokens: AI_BUDGET_CAPS.assist })
    await expect(assertMaintenanceBudget('ws1', db, 'assist')).rejects.toMatchObject({ statusCode: 429 })
    await expect(assertMaintenanceBudget('ws1', db)).resolves.toBeUndefined()
  })
})

describe('`C-413` 擋下來時講白話', () => {
  it('⛔ 不講 token、不講 M；講幾號恢復、已經放進去的照常回答', async () => {
    const db = makeDb({ importInputTokens: DEFAULT_MAINTENANCE_TOKEN_CAP })
    const err = await assertMaintenanceBudget('ws1', db).catch(e => e)
    expect(err.statusMessage).not.toMatch(/token|\d+(\.\d+)?M/i)
    expect(err.statusMessage).toContain('這個月加入資料到上限了')
    expect(err.statusMessage).toMatch(/\d+ 月 1 日恢復/)
    expect(err.statusMessage).toContain('已經放進去的照常回答客人')
    // 認「是不是上限擋的」看記號，不靠比對文字
    expect(err.data).toMatchObject({ reason: 'ai_budget', kind: 'knowledge' })
    expect(isAiBudgetError(err)).toBe(true)
  })

  it('恢復日是台灣時間的下個月 1 號（12 月接 1 月）', () => {
    expect(aiBudgetResumeLabel(new Date('2026-10-29T12:00:00+08:00'))).toBe('11 月 1 日')
    expect(aiBudgetResumeLabel(new Date('2026-12-31T23:30:00+08:00'))).toBe('1 月 1 日')
    // 月底最後 8 小時：UTC 還在上個月、台灣已經是下個月
    expect(aiBudgetResumeLabel(new Date('2026-10-31T17:00:00Z'))).toBe('12 月 1 日')
  })

  it('三本帳的話各講各的；背景與後台自用都講「回答客人不受影響」', () => {
    const d = new Date('2026-10-29T12:00:00+08:00')
    expect(aiBudgetMessage('knowledge', d).title).toBe('這個月加入資料到上限了，11 月 1 日恢復')
    // 背景那本講出停了哪三件（`C-414`）：三件在不同頁，只講「讀對話」他對不上是哪個功能
    expect(aiBudgetMessage('background', d).title).toBe('這個月 AI 讀對話到上限了，11 月 1 日恢復')
    expect(aiBudgetMessage('background', d).body).toBe('貼標建議、找新標籤、整理答不出來的問題先停；回答客人不受影響。')
    expect(aiBudgetMessage('assist', d).title).toContain('小幫手')
    expect(aiBudgetMessage('assist', d).body).toBe('回答客人不受影響。')
  })
})
