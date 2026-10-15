import { describe, expect, it } from 'vitest'
import {
  addOneButton,
  addOneDoneToast,
  addOneNormalizeInput,
  addOnePayload,
  previewFromDraft,
  previewStillFits,
  type AddOnePreview,
  type AddOneState,
} from './kb-add-one'

/**
 * 「補一條知識」小視窗（`C-317`）送出去的那一條。
 * 釘住：AI 沒整理成也加得進去（標題＝客人問、內容＝答案）；客人問的那句一定進問法；答案改了舊的整理作廢；
 * 一題以上照 `C-311` 只帶勾的題目；草稿的「請填寫」擋下；加好之後⛔不一律說「AI 會用這一條」。
 */

const ORIGIN = '請問一下小滑手咖啡機是哪一國做的？'
const ESPRESSO = '小滑手只能沖義式咖啡嗎？'
const SIZE = '小滑手咖啡機 寬/深/高各多少'

const st = (p: Partial<AddOneState> = {}): AddOneState => ({ question: '', answer: '', preview: null, queries: [], ticked: [], ...p })
const tidied = (p: Partial<AddOnePreview> = {}): AddOnePreview => ({
  title: '小滑手的產地',
  content: '小滑手咖啡機是中國製造的。',
  questions: ['小滑手哪裡做的'],
  tags: ['小滑手'],
  basis: '中國製造。',
  fromDraft: false,
  ...p,
})

describe('送出去的那一條', () => {
  it('沒按「AI 幫我整理」：標題＝客人問的那句、內容＝打的答案、問法＝那句、沒有標籤', () => {
    expect(addOnePayload(st({ question: ` ${ORIGIN} `, answer: ' 中國製造。 ' }))).toEqual({
      title: ORIGIN,
      content: '中國製造。',
      tags: [],
      questions: [ORIGIN],
    })
  })

  it('整理過：用整理好的標題／內容／標籤，問法＝AI 擬的＋客人問的那句（⛔ 一定放進去）', () => {
    const p = addOnePayload(st({ question: ORIGIN, answer: '中國製造。', preview: tidied() }))
    expect(p).toEqual({
      title: '小滑手的產地',
      content: '小滑手咖啡機是中國製造的。',
      tags: ['小滑手'],
      questions: ['小滑手哪裡做的', ORIGIN],
    })
  })

  it('問法最多 3 個：滿了換掉 AI 擬的最後一個，客人問的那句留著', () => {
    const p = addOnePayload(st({ question: ORIGIN, answer: '中國製造。', preview: tidied({ questions: ['a', 'b', 'c'] }) }))
    expect(p.questions).toEqual(['a', 'b', ORIGIN])
  })

  it('⛔ 答案改過了：整理那一份不算數，改回照打的字（不然存進去的是改之前那一版）', () => {
    const s = st({ question: ORIGIN, answer: '台灣製造。', preview: tidied() })
    expect(previewStillFits(s.preview, s.answer)).toBe(false)
    expect(addOnePayload(s)).toMatchObject({ title: ORIGIN, content: '台灣製造。', tags: [] })
  })

  it('一題以上（C-311）：標題退路＝勾的第一題（照清單順序）、問法帶勾的、answeredQueries 照清單順序', () => {
    const s = st({ queries: [ORIGIN, ESPRESSO, SIZE], ticked: [SIZE, ORIGIN], answer: '中國製造。' })
    expect(addOnePayload(s)).toEqual({
      title: ORIGIN,
      content: '中國製造。',
      tags: [],
      questions: [ORIGIN, SIZE],
      answeredQueries: [ORIGIN, SIZE],
    })
  })

  it('只有一題的組＝不帶 answeredQueries（整組採用，跟以前一樣）', () => {
    expect(addOnePayload(st({ queries: [ORIGIN], question: ORIGIN, answer: 'x' }))).not.toHaveProperty('answeredQueries')
  })

  it('標題退路超過 100 字會切掉（跟編輯視窗同一個上限）', () => {
    expect(addOnePayload(st({ question: 'q'.repeat(150), answer: 'x' })).title).toHaveLength(100)
  })
})

describe('AI 先擬好的草稿', () => {
  it('有內容才擺出來；沒有標題用退路；草稿是空的＝沒有', () => {
    expect(previewFromDraft({ title: '', content: ' 中國製造 ', tags: ['t'], questions: ['q'] }, ORIGIN))
      .toEqual({ title: ORIGIN, content: '中國製造', tags: ['t'], questions: ['q'], basis: '', fromDraft: true })
    expect(previewFromDraft({ title: 't', content: '  ', tags: [], questions: [] }, ORIGIN)).toBeNull()
    expect(previewFromDraft(null, ORIGIN)).toBeNull()
  })

  it('他開始自己打答案＝不用草稿那一份', () => {
    const d = previewFromDraft({ title: 't', content: 'c', tags: [], questions: [] }, ORIGIN)
    expect(previewStillFits(d, '')).toBe(true)
    expect(previewStillFits(d, '我自己寫')).toBe(false)
  })
})

describe('按鈕', () => {
  it('一題以上一題都沒勾＝至少勾一題', () => {
    expect(addOneButton(st({ queries: [ORIGIN, ESPRESSO], ticked: [], answer: 'x' }))).toEqual({ ok: false, label: '至少勾一題' })
  })

  it('草稿還有「請填寫」＝擋下、按鈕上寫還有幾個', () => {
    const preview = previewFromDraft({ title: 't', content: '產地：【請填寫：產地】、保固：【請填寫：保固】', tags: [], questions: [] }, ORIGIN)
    expect(addOneButton(st({ question: ORIGIN, preview }))).toEqual({ ok: false, label: '還有 2 個空格要補' })
  })

  it('沒有答案按不下去；有客人問＋答案就能加', () => {
    expect(addOneButton(st({ question: ORIGIN }))).toEqual({ ok: false, label: '加入' })
    expect(addOneButton(st({ answer: 'x' }))).toEqual({ ok: false, label: '加入' })
    expect(addOneButton(st({ question: ORIGIN, answer: 'x' }))).toEqual({ ok: true, label: '加入' })
  })

  it('「AI 幫我整理」送標題＝客人問的那句（一題以上＝勾的第一題）、內容＝答案；缺一樣就不能按', () => {
    expect(addOneNormalizeInput(st({ question: ORIGIN, answer: ' 中國製造。 ' }))).toEqual({ title: ORIGIN, content: '中國製造。' })
    expect(addOneNormalizeInput(st({ queries: [ORIGIN, SIZE], ticked: [SIZE], answer: 'x' }))).toEqual({ title: SIZE, content: 'x' })
    expect(addOneNormalizeInput(st({ question: ORIGIN }))).toBeNull()
  })
})

describe('加好之後那一句', () => {
  it('學成了、試問也答得出來（或反問、或試問逾時）＝「AI 回客人會用這一條」', () => {
    expect(addOneDoneToast({ status: 'indexed' })).toEqual({ text: '加好了，AI 回客人會用這一條', tone: 'success' })
    expect(addOneDoneToast({ status: 'indexed', verifyDecision: 'answered' }).tone).toBe('success')
    expect(addOneDoneToast({ status: 'indexed', verifyDecision: 'disambiguate' }).tone).toBe('success')
    expect(addOneDoneToast({ status: 'indexed', verifyDecision: null }).tone).toBe('success')
    // /code-review 第 5 條：沒真的試問成（失敗、逾時）就不講「AI 回客人會用這一條」
    expect(addOneDoneToast({ status: 'indexed', verifyDecision: null, verified: false })).toEqual({ text: '加好了', tone: 'success' })
    expect(addOneDoneToast({ status: 'indexed', verifyDecision: 'answered', verified: true }).text).toBe('加好了，AI 回客人會用這一條')
  })

  it('⛔ 沒學成、或試問還答不出來：不說「會用這一條」', () => {
    expect(addOneDoneToast({ status: 'failed' })).toMatchObject({ tone: 'error' })
    expect(addOneDoneToast({ status: 'failed' }).text).not.toContain('會用這一條')
    const w = addOneDoneToast({ status: 'indexed', verifyDecision: 'handoff' })
    expect(w.tone).toBe('warning')
    expect(w.text).not.toContain('會用這一條')
  })

  it('只回答其中幾題：講沒勾的還在清單上', () => {
    expect(addOneDoneToast({ status: 'indexed', verifyDecision: 'answered', remainingQuestions: 3 }).text)
      .toBe('加好了，AI 回客人會用這一條。沒勾的 3 題還在清單上')
  })
})
