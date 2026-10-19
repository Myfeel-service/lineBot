/**
 * 「AI 回覆額度用完了沒」（`D-132`③）：跟 answerWithAi 的額度護欄同一把尺。
 * 客人只傳照片時，用完了就不叫 AI 猜按鈕、只問一句。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))
vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  resolveAnsweredQuota: vi.fn(),
}))
vi.mock('./ai-usage', () => ({ getQuotaAnswered: vi.fn(), getCurrentMonthTokens: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))

const { isReplyQuotaExhausted } = await import('./reply-quota')
const { resolveAnsweredQuota } = await import('./billing')
const { getQuotaAnswered, getCurrentMonthTokens } = await import('./ai-usage')
const { getAiSettings } = await import('./ai-settings')

function settings(monthlyTokenCap = 0, onExceed: 'handoff_all' | 'downgrade' = 'handoff_all') {
  vi.mocked(getAiSettings).mockResolvedValue({ quota: { monthlyTokenCap, onExceed } } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
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
})

describe('其他情況', () => {
  it('內部／測試方案 → 永遠沒用完，連用量都不用讀', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ quota: null, planId: 'internal', internal: true, periodStart: null } as any)
    expect(await isReplyQuotaExhausted('ws1')).toBe(false)
    expect(vi.mocked(getQuotaAnswered)).not.toHaveBeenCalled()
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
