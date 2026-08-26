import { describe, expect, it, vi } from 'vitest'

/**
 * AI 建議標籤送到畫面上時，**不可以把「出處」弄丟**。
 *
 * 背景（2026-08-26 老闆提的）：卡片上只有 AI 自己寫的一句 30 字理由
 * （例如「客人詢問下單後多久可以收到貨」），那是 AI 的**轉述**不是客人原話。
 * 要負責任地按下「採用」，得看得到客人實際說了什麼——而掃描器**一直都有記**
 * 產生這條建議的那場對話（sessionId），只是在這一層被丟掉了。
 *
 * ⛔ 這種「中途靜靜掉一個欄位」型別檢查抓不到（同 `G-21`：畫面傳了、composable 沒帶，
 *    整個篩選是死的而編譯器全程沉默）。所以用測試釘住。
 */

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => '')
vi.stubGlobal('createError', (opts: { statusMessage?: string }) => new Error(opts.statusMessage ?? 'error'))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireWorkspaceAccess: vi.fn() }))

const { toPendingSuggestionView } = await import('./detail.get')

describe('AI 建議送到畫面時要帶著「出處」', () => {
  it('⛔ sessionId 要原封帶出去——沒有它，卡片上就沒有任何路可以看到客人原話', () => {
    const view = toPendingSuggestionView({
      tagId: 'tag-ship',
      reason: '客人詢問下單後多久可以收到貨，屬於出貨進度詢問。',
      sessionId: 'a79a2d5d-da3d-46c3-98ce-3bf43ac82d5c',
      suggestedAtMs: 1756180000000,
    })

    expect(view.sessionId).toBe('a79a2d5d-da3d-46c3-98ce-3bf43ac82d5c')
    expect(view.tagId).toBe('tag-ship')
    expect(view.reason).toContain('出貨進度')
    expect(view.suggestedAtMs).toBe(1756180000000)
  })

  it('舊資料沒有 sessionId → 回空字串（畫面據此不給連結，而不是給一個點了會跑錯地方的路）', () => {
    const view = toPendingSuggestionView({ tagId: 'tag-x', reason: '理由', suggestedAtMs: 1 })

    expect(view.sessionId).toBe('')
  })

  it('欄位型別壞掉不要讓整張卡爆掉：一律轉成字串／數字', () => {
    const view = toPendingSuggestionView({ tagId: 123, reason: null, sessionId: undefined, suggestedAtMs: '9' })

    expect(view).toEqual({ tagId: '123', reason: '', sessionId: '', suggestedAtMs: 9 })
  })

  it('整條是 null／undefined 也不能丟例外（一位客人的爛資料不該讓整個檔案打不開）', () => {
    expect(toPendingSuggestionView(null)).toEqual({ tagId: '', reason: '', sessionId: '', suggestedAtMs: 0 })
    expect(toPendingSuggestionView(undefined).sessionId).toBe('')
  })
})
