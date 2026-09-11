import { describe, expect, it } from 'vitest'
import {
  MESSAGE_SEARCH_TEXT_LIMIT,
  messageSearchMatches,
  messageSearchSnippet,
  messageSearchTokens,
  normalizeMessageSearchText,
  pickMessageSearchToken,
} from './message-search'

/**
 * 對話內容搜尋的片段切法。這裡鎖的是「搜得到 / 搜不到」的分界，
 * 每一條都對應一種客服真的會打進搜尋框的字。
 */
describe('可搜尋片段（messageSearchTokens）', () => {
  it('詞的中間也切得到：搜「好ㄟ」要能命中「上好ㄟ洗衣機」', () => {
    const { tokens } = messageSearchTokens(['上好ㄟ洗衣機多少錢'])
    expect(tokens).toContain(pickMessageSearchToken('好ㄟ'))
    expect(messageSearchMatches('好ㄟ', ['上好ㄟ洗衣機多少錢'])).toBe(true)
  })

  it('大小寫與全形半形壓平：全形數字打的訂單編號，用半形也搜得到', () => {
    const { tokens } = messageSearchTokens(['訂單ＡＢ１２３ 已付款'])
    expect(tokens).toContain('ab')
    expect(tokens).toContain('12')
    expect(messageSearchMatches('ab123', ['訂單ＡＢ１２３ 已付款'])).toBe(true)
    expect(messageSearchMatches('ORDER', ['my Order number'])).toBe(true)
  })

  it('英文詞的中間也搜得到（bigram 對英數同樣有效）', () => {
    expect(messageSearchMatches('rde', ['where is my order'])).toBe(true)
    expect(tokensOf('order')).toContain('rd')
  })

  it('⛔ 不同段落之間不可以長出跨段的假片段', () => {
    // 訊息本文「你好」＋圖片描述「世界」：沒有人講過「好世」
    const { tokens } = messageSearchTokens(['你好', '世界'])
    expect(tokens).toContain('你好')
    expect(tokens).toContain('世界')
    expect(tokens).not.toContain('好世')
  })

  it('換行與連續空白不影響命中（正規化會壓成一格）', () => {
    expect(normalizeMessageSearchText('退貨\n\n流程')).toBe('退貨 流程')
    expect(messageSearchMatches('貨 流', ['退貨\n\n流程'])).toBe(true)
  })

  it('超長訊息要回報被切掉（尾巴搜不到這件事不能靜靜發生）', () => {
    const long = '客'.repeat(MESSAGE_SEARCH_TEXT_LIMIT + 50)
    expect(messageSearchTokens([long]).cut).toBe(true)
    expect(messageSearchTokens(['短短一句話']).cut).toBe(false)
  })

  it('空字串／null 不產生片段', () => {
    expect(messageSearchTokens([null, undefined, '']).tokens).toEqual([])
    expect(messageSearchTokens(['一']).tokens).toEqual([])
  })
})

function tokensOf(text: string): string[] {
  return messageSearchTokens([text]).tokens
}

describe('挑查詢片段（pickMessageSearchToken）', () => {
  it('挑最少見的那一組，避免用「我的」這種掃到一大堆的片段', () => {
    expect(pickMessageSearchToken('我的訂單')).toBe('訂單')
    expect(pickMessageSearchToken('請問退貨')).toBe('退貨')
  })

  it('挑出來的片段一定存在於訊息的片段裡（否則精準查詢會漏掉命中）', () => {
    for (const kw of ['我的訂單', '請問退貨', 'order', '１２３', '威技冷氣']) {
      const text = `前面隨便幾個字 ${kw} 後面隨便幾個字`
      expect(tokensOf(text)).toContain(pickMessageSearchToken(kw))
    }
  })

  it('一個字（或只有空白）挑不出片段＝呼叫端要明講不是回空清單', () => {
    expect(pickMessageSearchToken('退')).toBe('')
    expect(pickMessageSearchToken('  ')).toBe('')
    expect(pickMessageSearchToken('a b')).toBe('')
  })
})

describe('結果那一行的摘要（messageSearchSnippet）', () => {
  it('以命中的字為中心，不是訊息開頭', () => {
    const text = '你好 想請問一下我上週訂的那台洗衣機什麼時候會到貨呢謝謝'
    const s = messageSearchSnippet(text, '洗衣機')
    expect(s.match).toBe('洗衣機')
    expect(s.before.endsWith('那台')).toBe(true)
    expect(s.cutHead).toBe(true)
  })

  it('原文的大小寫／全形照原樣顯示（顯示用原文，比對用折疊）', () => {
    const s = messageSearchSnippet('My ORDER is late', 'order')
    expect(s.match).toBe('ORDER')
  })

  it('emoji 不會讓命中位置偏移', () => {
    const s = messageSearchSnippet('🎉🎉 恭喜 退貨完成', '退貨')
    expect(s.match).toBe('退貨')
  })

  it('尾巴太長要標出來被切掉（畫面才知道要補「…」）', () => {
    const s = messageSearchSnippet(`退貨${'啦'.repeat(200)}`, '退貨')
    expect(s.cutTail).toBe(true)
    expect(s.cutHead).toBe(false)
  })

  it('對不上時退回開頭一段，不是不顯示摘要', () => {
    const s = messageSearchSnippet('完全無關的一句話', '退貨')
    expect(s.match).toBe('')
    expect(s.before.startsWith('完全無關')).toBe(true)
  })
})
