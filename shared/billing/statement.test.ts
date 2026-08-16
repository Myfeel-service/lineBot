import { describe, expect, it } from 'vitest'
import { cardStatementNotice, cardStatementNoticeShort } from './statement'

const parts = {
  statementName: 'myfeel',
  legalCompanyName: '麥菲爾股份有限公司',
  brandName: 'MiniMe',
}

describe('cardStatementNotice', () => {
  it('三個名字都講到：帳單名、公司全名、品牌', () => {
    const s = cardStatementNotice(parts)
    expect(s).toContain('myfeel')
    expect(s).toContain('麥菲爾股份有限公司')
    expect(s).toContain('MiniMe')
  })

  // 客人是拿帳單上那一行字來比對的，大小寫不同就對不起來 → 名字必須原樣輸出、不做任何美化
  it('帳單名原樣輸出，不改大小寫', () => {
    expect(cardStatementNotice(parts)).not.toContain('Myfeel')
    expect(cardStatementNotice({ ...parts, statementName: 'MINIME*MYFEEL' })).toContain('MINIME*MYFEEL')
  })

  it('短版只講帳單名與公司，塞得進既有句子', () => {
    const s = cardStatementNoticeShort(parts)
    expect(s).toContain('myfeel')
    expect(s).toContain('麥菲爾股份有限公司')
    expect(s.length).toBeLessThan(40)
  })
})
