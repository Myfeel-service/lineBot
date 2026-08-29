import { describe, expect, it } from 'vitest'
import { kbVerifyOutcome, pickKbVerifyQuery } from './kb-verify-outcome'

describe('kbVerifyOutcome', () => {
  it('答得出來才給綠燈，並帶上問的那句話', () => {
    const out = kbVerifyOutcome({ query: '你們幾點營業', decision: 'answered' })
    expect(out.tone).toBe('ok')
    expect(out.text).toContain('你們幾點營業')
  })

  it('反問澄清也算學會了', () => {
    expect(kbVerifyOutcome({ query: '多少錢', decision: 'disambiguate' }).tone).toBe('ok')
  })

  it('⛔答不出來要照實說，不能給綠燈', () => {
    const out = kbVerifyOutcome({ query: '有停車位嗎', decision: 'handoff' })
    expect(out.tone).toBe('warn')
    // 要講「知識有進庫」（別讓人以為匯入失敗）也要給下一步
    expect(out.text).toContain('進庫')
    expect(out.text).toContain('客人可能怎麼問')
  })

  it('三種「沒有」講的不是同一件事', () => {
    const timeout = kbVerifyOutcome({ query: 'x', timedOut: true })
    const noAnswer = kbVerifyOutcome({ query: 'x', decision: 'handoff' })
    const errored = kbVerifyOutcome({ query: 'x', errored: true })

    // 逾時＝不知道學會沒有，⛔不可以說成「沒學會」
    expect(timeout.text).toContain('不代表沒學會')
    // 試問本身壞掉＝跟知識無關，要明說不影響已匯入的東西
    expect(errored.text).toContain('不影響已匯入的知識')
    // 三句話彼此不同（各自的下一步不同）
    expect(new Set([timeout.text, noAnswer.text, errored.text]).size).toBe(3)
  })

  it('errored 優先於其他訊號（API 壞了就別解讀它的回傳值）', () => {
    const out = kbVerifyOutcome({ query: 'x', decision: 'answered', errored: true })
    expect(out.tone).toBe('warn')
  })
})

describe('pickKbVerifyQuery', () => {
  it('優先用客人問法，不用標題', () => {
    const q = pickKbVerifyQuery([
      { included: true, title: '營業時間', questions: ['你們幾點開門'] },
    ])
    expect(q).toBe('你們幾點開門')
  })

  it('沒有問法就退回標題', () => {
    expect(pickKbVerifyQuery([{ included: true, title: '營業時間' }])).toBe('營業時間')
  })

  it('跳過沒被勾選的條目', () => {
    const q = pickKbVerifyQuery([
      { included: false, title: '不要這條', questions: ['不該被選到'] },
      { included: true, title: '要這條', questions: ['該選這句'] },
    ])
    expect(q).toBe('該選這句')
  })

  it('空白問法不算數（會退到下一條有問法的）', () => {
    const q = pickKbVerifyQuery([
      { included: true, title: '第一條', questions: ['   '] },
      { included: true, title: '第二條', questions: ['真的問法'] },
    ])
    expect(q).toBe('真的問法')
  })

  it('什麼都沒有就回空字串（呼叫端據此不畫試問鈕）', () => {
    expect(pickKbVerifyQuery([])).toBe('')
    expect(pickKbVerifyQuery([{ included: true, title: '   ' }])).toBe('')
  })
})
