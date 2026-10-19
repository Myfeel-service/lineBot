/**
 * 「AI 回覆額度用完了沒」（`D-132`③）：跟 answerWithAi 的額度護欄同一把尺。
 * 客人只傳照片時，用完了就不叫 AI 猜按鈕、只問一句。
 * `C-8`（2026-10-20）：這個月 AI 被叫的次數到了則數額度的 10 倍也算停——照片那條要吃同一把尺。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))
vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  resolveAnsweredQuota: vi.fn(),
}))
vi.mock('./ai-usage', () => ({ getQuotaAnswered: vi.fn(), getCurrentMonthTokens: vi.fn(), getCurrentMonthAiCalls: vi.fn(async () => 0) }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))

const { isReplyQuotaExhausted, getAiCallCeilingStatus } = await import('./reply-quota')
const { resolveAnsweredQuota } = await import('./billing')
const { getQuotaAnswered, getCurrentMonthTokens, getCurrentMonthAiCalls } = await import('./ai-usage')
const { getAiSettings } = await import('./ai-settings')

function settings(monthlyTokenCap = 0, onExceed: 'handoff_all' | 'downgrade' = 'handoff_all') {
  vi.mocked(getAiSettings).mockResolvedValue({ quota: { monthlyTokenCap, onExceed } } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(0)
  settings()
})

describe('有則數上限的方案', () => {
  beforeEach(() => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ quota: 200, planId: 'lite', internal: false, periodStart: '2026-10-01' })
  })

  it('本期已用到上限 → 用完', async () => {
    vi.mocked(getQuotaAnswered).mockResolvedValue(200)
    expect(await isReplyQuotaExhausted('ws1')).toBe(true)
  })

  it('還差一則 → 沒用完', async () => {
    vi.mocked(getQuotaAnswered).mockResolvedValue(199)
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
  })

  it('`C-8` 則數沒用完、這個月 AI 被叫 9 倍 → 照常讓 AI 猜', async () => {
    vi.mocked(getQuotaAnswered).mockResolvedValue(12)
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(1_800)
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
  })

  it('🔴 `C-8` 被叫到 10 倍 → 當作用完（不叫 AI 讀圖、直接轉真人，跟文字那條同一條路）', async () => {
    vi.mocked(getQuotaAnswered).mockResolvedValue(12)
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(2_000)
    expect(await isReplyQuotaExhausted('ws1')).toBe(true)
  })

  it('次數讀不到 → 當 0（成本保險絲，讀取抖一下不該把 AI 停掉）', async () => {
    vi.mocked(getQuotaAnswered).mockResolvedValue(12)
    vi.mocked(getCurrentMonthAiCalls).mockRejectedValue(new Error('UNAVAILABLE'))
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
  })
})

describe('其他情況', () => {
  it('內部／測試方案 → 永遠沒用完，連用量都不用讀', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ quota: null, planId: 'internal', internal: true, periodStart: null } as any)
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(10_000_000)
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
    expect(vi.mocked(getQuotaAnswered)).not.toHaveBeenCalled()
    expect(vi.mocked(getCurrentMonthAiCalls)).not.toHaveBeenCalled()
  })

  it('`C-8` 不限則數（企業沒設額度）→ 被叫再多都不停，連次數都不讀（只剩 token 護欄）', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ quota: null, planId: 'enterprise', internal: false, periodStart: null })
    settings(1_000_000, 'handoff_all')
    vi.mocked(getCurrentMonthTokens).mockResolvedValue(10)
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(10_000_000)
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
    expect(vi.mocked(getCurrentMonthAiCalls)).not.toHaveBeenCalled()
  })

  it('沒則數上限、token 用量超過且設定是「全轉真人」→ 用完', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ quota: null, planId: null, internal: false, periodStart: null })
    settings(1000, 'handoff_all')
    vi.mocked(getCurrentMonthTokens).mockResolvedValue(1000)
    expect(await isReplyQuotaExhausted('ws1')).toBe(true)
  })

  it('token 超過但設定是「降級模型繼續答」→ AI 還在答，不算用完', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ quota: null, planId: null, internal: false, periodStart: null })
    settings(1000, 'downgrade')
    vi.mocked(getCurrentMonthTokens).mockResolvedValue(5000)
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
  })

  it('讀不到（Firestore 抖動）→ 當作沒用完：基礎設施出問題不該讓客人收不到按鈕', async () => {
    vi.mocked(resolveAnsweredQuota).mockRejectedValue(new Error('UNAVAILABLE'))
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
  })
})

describe('getAiCallCeilingStatus — 後台顯示用（跟護欄讀同一支）', () => {
  it('有則數上限：回次數、上限、撞到了沒', async () => {
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(512)
    expect(await getAiCallCeilingStatus('ws1', { quota: 50, internal: false })).toEqual({ calls: 512, limit: 500, hit: true })
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(499)
    expect(await getAiCallCeilingStatus('ws1', { quota: 50, internal: false })).toEqual({ calls: 499, limit: 500, hit: false })
  })

  it('不套的帳號回 null、不讀次數', async () => {
    expect(await getAiCallCeilingStatus('ws1', { quota: null, internal: false })).toBeNull()
    expect(await getAiCallCeilingStatus('ws1', { quota: 500, internal: true })).toBeNull()
    expect(vi.mocked(getCurrentMonthAiCalls)).not.toHaveBeenCalled()
  })
})
