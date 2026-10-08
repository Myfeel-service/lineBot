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

  // `D-116`（2026-10-08 實測）：數字那道擋不到文字——它沒查就說「AI 的語氣目前設定為『專業簡潔』」（其實是自己寫的指示），
  // 「晚上不要吵我」沒查就問「勿擾要幾點到幾點」（其實本來就設好了）
  it('🔴 沒查設定就講 AI 設定的現況 → 擋下來，叫它先查', () => {
    const issue = answerGroundingIssue({ text: 'AI 的語氣目前設定為「專業簡潔」，要換嗎？', sources: [], calledTools: [] })
    expect(issue).toContain('get_ai_settings')
  })

  it('🔴 沒查設定就反問「勿擾要幾點到幾點」→ 也要擋（先講現在是多少）', () => {
    expect(answerGroundingIssue({ text: '請問您希望勿擾時段從幾點到幾點呢？', sources: [], calledTools: [] })).toContain('get_ai_settings')
  })

  it('查過設定再講 → 放行', () => {
    expect(ok({ text: '已經是這樣了：服務時間以外就是勿擾時段，你不會被吵。', sources: [], calledTools: ['get_ai_settings'] })).toBe(true)
  })

  it('🔴 把服務時間講成 AI 的上班時間 → 擋（兩輪實測都中：「目前 AI 自動回覆的服務時間設定為…」）', () => {
    const say = (text: string) => answerGroundingIssue({ text, sources: [], calledTools: ['get_ai_settings'] })
    expect(say('目前 AI 自動回覆的服務時間設定為平日白天，週末是勿擾時段')).toContain('不是 AI 的上班時間')
    expect(say('勿擾時段 AI 不會回客人')).toContain('不是 AI 的上班時間')
    // 對的講法不擋
    expect(say('服務時間以外是勿擾時段，AI 在服務時間以外照常回答。')).toBeNull()
  })

  it('⛔ 講對話統計的「等太久」不算設定話題（收了會一直白查一次）', () => {
    expect(ok({ text: '昨天有客人等太久才有人回，要不要去看看？', sources: [], calledTools: ['get_conversation_stats'] })).toBe(true)
  })
})
