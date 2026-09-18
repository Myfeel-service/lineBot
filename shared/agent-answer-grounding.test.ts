import { describe, expect, it } from 'vitest'
import { answerGroundingIssue } from './agent-answer-grounding'

const ok = (p: Parameters<typeof answerGroundingIssue>[0]) => answerGroundingIssue(p) === null

describe('answerGroundingIssue（沒查就講的回答要退回去）', () => {
  it('🔴 一個工具都沒查卻報數字 → 擋下來，訊息要講「先去查」', () => {
    const issue = answerGroundingIssue({
      text: '這個月 AI 總共回覆了 123 則訊息，其中有 45 次轉給真人客服處理。',
      sources: ['這個月 AI 花了我多少錢？'],
      calledTools: [],
    })
    expect(issue).toContain('123')
    expect(issue).toContain('先用對應的工具查')
  })

  it('數字在工具結果裡找得到 → 放行', () => {
    expect(ok({
      text: '這個月用了 110 則。',
      sources: ['get_plan_quota({}) → {"used":110,"unlimited":true}'],
      calledTools: ['get_plan_quota'],
    })).toBe(true)
  })

  it('使用者自己講過的數字 → 放行（⛔覆述他的話不算編造）', () => {
    expect(ok({
      text: '你說的是把提醒改成 30 分鐘對嗎？',
      sources: ['幫我把提醒改成 30 分鐘'],
      calledTools: [],
    })).toBe(true)
  })

  it('提示裡給過的日期 → 放行（2026-09 不是它編的）', () => {
    expect(ok({
      text: '這是 2026-09 的數字。',
      sources: ['get_ai_usage({}) → {"month":"2026-09"}', '2026-09-18', '2026-09'],
      calledTools: ['get_ai_usage'],
    })).toBe(true)
  })

  /** ⛔ 這句誤擋的代價最大：它是**每一次拒絕批次**都會講的話 */
  it('⛔ 不可以誤擋「我一次只能處理一個」這種話', () => {
    expect(ok({
      text: '我一次只能處理一件事，請問您要先做哪一個？',
      sources: [],
      calledTools: [],
    })).toBe(true)
  })

  it('🔴 沒查異常卻說「沒有要處理的」→ 擋下來', () => {
    const issue = answerGroundingIssue({
      text: '目前沒有需要處理的異常狀況。',
      sources: ['get_ai_usage({}) → {"invocations":236}'],
      calledTools: ['get_ai_usage'],
    })
    expect(issue).toContain('get_current_alerts')
  })

  it('查過異常再說「沒有異常」→ 放行', () => {
    expect(ok({
      text: '目前沒有異常。',
      sources: ['get_current_alerts({}) → []'],
      calledTools: ['get_current_alerts'],
    })).toBe(true)
  })

  it('空回答不判（那條路有自己的罐頭句）', () => {
    expect(ok({ text: '   ', sources: [], calledTools: [] })).toBe(true)
  })
})
