import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ASK_FIRST_REASONS,
  askSourceLabel,
  askView,
  keepRecentTurns,
  type AskResult,
} from './kb-ask-result'

/**
 * 「問 AI 一題」（`C-315`）怎麼講一題試答的結果。
 * 最要緊的是照實講客人會拿到什麼：信心不足／知識庫沒有那幾種，正式 LINE 上是先問「需要幫您轉接專員嗎？」，
 * ⛔ 不可以說成「直接轉真人」；招呼語 ⛔ 不可以給「寫一句正確答案」（會把「謝謝」建成一條）。
 */

const base: AskResult = { decision: 'answered', answer: '', confidence: 0.9, sources: [], handoffReason: null }

describe('askView', () => {
  it('答得出來：編號照順序、標出還沒上線的、全部都還沒上線時講客人現在問不會這樣答', () => {
    const v = askView({
      ...base,
      answer: '每 2 週清一次',
      sources: [
        { chunkId: 'c1', title: '後進氣面板清潔', similarity: 0.9, sourceId: 's1' },
        { chunkId: 'c2', title: '過濾網安裝順序', similarity: 0.8, sourceId: 's1', draft: true },
      ],
    })
    expect(v).toEqual({
      kind: 'answer',
      answer: '每 2 週清一次',
      sources: [
        { n: 1, chunkId: 'c1', sourceId: 's1', title: '後進氣面板清潔', draft: false },
        { n: 2, chunkId: 'c2', sourceId: 's1', title: '過濾網安裝順序', draft: true },
      ],
      draftOnly: false,
      canAddOne: true,
    })
    const all = askView({ ...base, answer: 'x', sources: [{ chunkId: 'c2', title: 't', similarity: 1, draft: true }] })
    expect(all).toMatchObject({ kind: 'answer', draftOnly: true })
  })

  it('⛔ 招呼語／跟店無關（沒查知識庫）不給「寫一句正確答案」', () => {
    expect(askView({ ...base, answer: '不客氣', answerKind: 'social' })).toMatchObject({ kind: 'answer', canAddOne: false, sources: [] })
    expect(askView({ ...base, answer: '我只能回答本店的問題', answerKind: 'offtopic' })).toMatchObject({ canAddOne: false })
  })

  it('⛔ 信心不足／知識庫沒有：客人會收到「先問要不要轉」，不是直接轉；給補一條的主要按鈕', () => {
    for (const reason of ['no_grounding', 'low_confidence', 'product_mismatch', 'unresolved'] as const) {
      const v = askView({ ...base, decision: 'handoff', handoffReason: reason })
      expect(v).toMatchObject({ kind: 'handoff', customerGets: '客人會收到：AI 說不確定，問要不要轉給真人', canAddOne: true })
    }
    expect(askView({ ...base, decision: 'handoff', handoffReason: 'no_grounding' })).toMatchObject({ why: '知識庫裡沒有這題的答案' })
  })

  it('客人要真人、敏感、額度、查訂單這類：直接轉真人，補知識沒有用（不給主要按鈕）', () => {
    for (const reason of ['user_request', 'sensitive_topic', 'quota_exceeded', 'order_status', 'commercial_inquiry'] as const) {
      const v = askView({ ...base, decision: 'handoff', handoffReason: reason })
      expect(v).toMatchObject({ kind: 'handoff', customerGets: '客人會直接轉給真人', canAddOne: false })
      expect((v as { why: string }).why).toBeTruthy()
    }
    // 沒有特別寫的沿用全站同一份說法
    expect(askView({ ...base, decision: 'handoff', handoffReason: 'order_status' })).toMatchObject({ why: '要查客人的訂單' })
  })

  it('反問：選項優先用短名稱、沒有才用標題，空的不列', () => {
    const v = askView({
      ...base,
      decision: 'disambiguate',
      disambiguation: {
        clarification: '請問是哪一台？',
        options: [
          { chunkId: 'a', title: 'SHARP 乾淨方MAX 濾網', label: '乾淨方MAX' },
          { chunkId: 'b', title: '小滑手濾網' },
          { chunkId: 'c', title: '' },
        ],
      },
    })
    expect(v).toEqual({
      kind: 'ask',
      clarification: '請問是哪一台？',
      options: [{ chunkId: 'a', text: '乾淨方MAX' }, { chunkId: 'b', text: '小滑手濾網' }],
      canAddOne: true,
    })
  })

  it('自動回應接手／AI 服務失敗／跳過：各講各的，不混成「轉真人」', () => {
    expect(askView({ ...base, decision: 'skipped', scriptTrigger: { name: '查訂單', mode: 'keyword' } })).toEqual({ kind: 'script', name: '查訂單' })
    expect(askView({ ...base, decision: 'handoff', handoffReason: 'llm_error' })).toEqual({ kind: 'retry', why: 'AI 服務暫時失敗' })
    expect(askView({ ...base, decision: 'handoff', handoffReason: 'manual' })).toEqual({ kind: 'silent' })
    expect(askView({ ...base, decision: 'skipped' })).toEqual({ kind: 'silent' })
  })

  it('來源沒有 chunkId 的不列（點了也打不開）', () => {
    const v = askView({ ...base, answer: 'x', sources: [{ chunkId: '', title: 'x', similarity: 1 }, { chunkId: 'c', title: '  ', similarity: 1 }] })
    expect(v).toMatchObject({ sources: [{ n: 1, chunkId: 'c', title: '（沒有標題）', sourceId: null }] })
  })
})

describe('「· 哪一份資料」', () => {
  const names = { s1: 'SHARP 乾淨方MAX 說明書.pdf', s2: '運費怎麼算' }
  it('現在打開的那一份＝「這一份」；手寫那種名字＝標題不重講；查不到不講', () => {
    expect(askSourceLabel({ sourceId: 's1', title: '後進氣面板清潔' }, names, 's1')).toBe('這一份')
    expect(askSourceLabel({ sourceId: 's1', title: '後進氣面板清潔' }, names, 'other')).toBe('SHARP 乾淨方MAX 說明書.pdf')
    expect(askSourceLabel({ sourceId: 's2', title: '運費怎麼算' }, names)).toBe('')
    expect(askSourceLabel({ sourceId: 'gone', title: 'x' }, names)).toBe('')
    expect(askSourceLabel({ sourceId: null, title: 'x' }, names)).toBe('')
    expect(askSourceLabel({ sourceId: 's1', title: 'x' }, null)).toBe('')
  })
})

describe('面板只留最近幾題', () => {
  it('超過 5 題丟最舊的，最新的在最後', () => {
    expect(keepRecentTurns([1, 2, 3, 4, 5, 6, 7])).toEqual([3, 4, 5, 6, 7])
    expect(keepRecentTurns([1, 2])).toEqual([1, 2])
  })
})

describe('跟正式 LINE 同一份「先問要不要轉」名單', () => {
  it('server/utils/handler.ts 的 HANDOFF_CONFIRM_REASONS 加減一種，這裡要跟著改（不然「客人會收到什麼」就講錯了）', () => {
    const src = readFileSync(fileURLToPath(new URL('../../server/utils/handler.ts', import.meta.url)), 'utf8')
    const m = src.match(/const HANDOFF_CONFIRM_REASONS = new Set<HandoffReason>\(\[([^\]]*)\]\)/)
    expect(m).toBeTruthy()
    const server = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    expect([...ASK_FIRST_REASONS].sort()).toEqual(server)
  })
})
