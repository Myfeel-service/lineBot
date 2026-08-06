import { describe, expect, it } from 'vitest'
import {
  isAiContextWithinSession,
  isKnowledgeGapContext,
  type AiContextGapInput,
} from './ai-knowledge'

function ctx(over: Partial<AiContextGapInput> = {}): AiContextGapInput {
  return {
    lastDecision: 'answered',
    lastHandoffReason: null,
    lastAnswerKind: 'kb',
    sourceCount: 1,
    hasSuggestedReply: false,
    ...over,
  }
}

/**
 * 「知識庫沒有相關資訊，AI 這題答不出來」這句話只有在真的是知識缺口時才能說。
 * 講錯的代價不只是文案：旁邊那顆「補知識」會把客人的原話當成問題建卡。
 */
describe('isKnowledgeGapContext', () => {
  it('查了知識庫但一張卡都沒命中 → 是缺口', () => {
    expect(isKnowledgeGapContext(ctx({ sourceCount: 0 }))).toBe(true)
  })

  it('有命中知識卡 → 不是缺口', () => {
    expect(isKnowledgeGapContext(ctx({ sourceCount: 2 }))).toBe(false)
  })

  it('招呼語／道謝（沒查知識庫）→ 不是缺口', () => {
    expect(isKnowledgeGapContext(ctx({ lastAnswerKind: 'social', sourceCount: 0 }))).toBe(false)
  })

  it('越界問題的禮貌拒答（沒查知識庫）→ 不是缺口', () => {
    expect(isKnowledgeGapContext(ctx({ lastAnswerKind: 'offtopic', sourceCount: 0 }))).toBe(false)
  })

  it('舊資料沒有 lastAnswerKind → 當成查過知識庫（維持原本判斷）', () => {
    expect(isKnowledgeGapContext(ctx({ lastAnswerKind: undefined, sourceCount: 0 }))).toBe(true)
  })

  it('有 AI 草稿可用 → 不是答不出來', () => {
    expect(isKnowledgeGapContext(ctx({ sourceCount: 0, hasSuggestedReply: true }))).toBe(false)
  })

  it.each(['no_grounding', 'low_confidence', 'unresolved'] as const)(
    '因「%s」轉真人 → 是缺口（補一張卡下次就會答）',
    (reason) => {
      expect(isKnowledgeGapContext(ctx({
        lastDecision: 'handoff', lastHandoffReason: reason, sourceCount: 0,
      }))).toBe(true)
    },
  )

  it.each(['user_request', 'sensitive_topic', 'commercial_inquiry', 'quota_exceeded', 'llm_error', 'manual'] as const)(
    '因「%s」轉真人 → 不是缺口（叫店家補知識是誤導）',
    (reason) => {
      expect(isKnowledgeGapContext(ctx({
        lastDecision: 'handoff', lastHandoffReason: reason, sourceCount: 0,
      }))).toBe(false)
    },
  )

  it('反問客人要不要轉接（handoff_confirm）也照原因判斷', () => {
    expect(isKnowledgeGapContext(ctx({
      lastDecision: 'handoff_confirm', lastHandoffReason: 'user_request', sourceCount: 0,
    }))).toBe(false)
    expect(isKnowledgeGapContext(ctx({
      lastDecision: 'handoff_confirm', lastHandoffReason: 'no_grounding', sourceCount: 0,
    }))).toBe(true)
  })
})

/**
 * 脈絡卡講的是「這位客人最近一次」AI 互動，不是「這場會話」的。
 * 判斷錯的代價不是少一張卡：客服會對著三天前那場，把「答錯」記到今天那次頭上。
 */
describe('isAiContextWithinSession', () => {
  const SESSION = { startMs: 1_000, endMs: 2_000 }

  it('看的是進行中的對話（沒有指定場次）→ 一律算數', () => {
    expect(isAiContextWithinSession(999_999, null)).toBe(true)
    expect(isAiContextWithinSession(999_999, undefined)).toBe(true)
  })

  it('互動落在這場的時間範圍內 → 算這場的', () => {
    expect(isAiContextWithinSession(1_500, SESSION)).toBe(true)
  })

  it('邊界（開場、結束的那一刻）算在裡面', () => {
    expect(isAiContextWithinSession(1_000, SESSION)).toBe(true)
    expect(isAiContextWithinSession(2_000, SESSION)).toBe(true)
  })

  it('這場結束之後才發生的互動 → 不是這場的（原本會誤標的就是這一種）', () => {
    expect(isAiContextWithinSession(2_001, SESSION)).toBe(false)
  })

  it('開場之前的互動（上一場留下來的）→ 不是這場的', () => {
    expect(isAiContextWithinSession(999, SESSION)).toBe(false)
  })

  it('這場還沒結束（endMs=Infinity）→ 之後的互動都算這場的', () => {
    expect(isAiContextWithinSession(9_999_999, { startMs: 1_000, endMs: Number.POSITIVE_INFINITY })).toBe(true)
  })

  it('沒有互動時間可比 → 不給操作（寧可少一張卡，也不要標到錯的場次）', () => {
    expect(isAiContextWithinSession(0, SESSION)).toBe(false)
  })
})
