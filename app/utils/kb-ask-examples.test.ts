import { describe, expect, it } from 'vitest'
import {
  ASK_EXAMPLE_MAX_CHARS,
  exampleQuestionsFromChunks,
  exampleQuestionsFromSuggestions,
} from './kb-ask-examples'

/**
 * 「問 AI 一題」還沒問過時列的那幾句（`D-168`）。
 * 要守的是：只拿 AI 真的會用的那幾條、不拿標題湊、太長的不列、三句不擠在同一段。
 */

const chunk = (q: string[], o: Partial<{ status: string, isOverview: boolean }> = {}) => ({ status: 'indexed', isOverview: false, questions: q, ...o })

describe('打開一份資料時：那一份的客人問法', () => {
  it('只挑 AI 會用的（indexed、不是總覽）；停用／處理中／等你看過／學失敗都不算', () => {
    const qs = exampleQuestionsFromChunks([
      chunk(['停用的？'], { status: 'disabled' }),
      chunk(['處理中的？'], { status: 'pending' }),
      chunk(['等你看過的？'], { status: 'draft' }),
      chunk(['學失敗的？'], { status: 'failed' }),
      chunk(['總覽的？'], { isOverview: true }),
      chunk(['濾網多久要清一次？', '濾網怎麼清']),
    ])
    expect(qs).toEqual(['濾網多久要清一次？'])
  })

  it('沒有問法的那條跳過，⛔ 不拿標題湊；太長的換下一句', () => {
    const long = '請'.repeat(ASK_EXAMPLE_MAX_CHARS + 1)
    expect(exampleQuestionsFromChunks([chunk([]), { status: 'indexed' }, chunk([long, '  過濾網要怎麼裝回去？ ']), chunk([long])]))
      .toEqual(['過濾網要怎麼裝回去？'])
  })

  it('超過三條時平均分散在整份裡挑（不是前三條）', () => {
    const qs = exampleQuestionsFromChunks(Array.from({ length: 9 }, (_, i) => chunk([`第 ${i + 1} 題？`])))
    expect(qs).toEqual(['第 1 題？', '第 4 題？', '第 7 題？'])
  })

  it('同一句不重複（大小寫、空白不同也算同一句）', () => {
    expect(exampleQuestionsFromChunks([chunk(['BOYA 怎麼充電？']), chunk(['boya  怎麼充電？']), chunk(['可以接 iPhone 嗎？'])]))
      .toEqual(['BOYA 怎麼充電？', '可以接 iPhone 嗎？'])
  })

  it('一條都沒有＝空的（面板就不列）', () => {
    expect(exampleQuestionsFromChunks([])).toEqual([])
  })
})

describe('沒打開資料時：AI 建議補的那幾組客人原句', () => {
  it('每一組拿第一句、照清單順序、最多三句', () => {
    const qs = exampleQuestionsFromSuggestions([
      { sampleQueries: ['小滑手咖啡機是哪一國做的？', '小滑手哪裡製造'] },
      { sampleQueries: ['乾淨方MAX 可以放在浴室嗎？'] },
      { sampleQueries: [], queries: ['BOYA mini2 可以接 iPhone 嗎？'] },
      { sampleQueries: ['第四組？'] },
    ])
    expect(qs).toEqual(['小滑手咖啡機是哪一國做的？', '乾淨方MAX 可以放在浴室嗎？', 'BOYA mini2 可以接 iPhone 嗎？'])
  })

  it('太長的換那一組的下一句；整組都不能用就跳過', () => {
    const long = '我'.repeat(ASK_EXAMPLE_MAX_CHARS + 1)
    expect(exampleQuestionsFromSuggestions([{ sampleQueries: [long] }, { sampleQueries: [long, '保固多久？'] }])).toEqual(['保固多久？'])
  })

  it('沒有建議＝空的', () => {
    expect(exampleQuestionsFromSuggestions([])).toEqual([])
  })
})
