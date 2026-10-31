import { describe, expect, it } from 'vitest'
import { changedMessageNumbers, messageNumbersText } from './flow-message-changes'

const text = (t: string) => ({ type: 'text', text: t, buttons: [] })

describe('`C-411` 模組存檔改了哪幾則訊息', () => {
  it('⭐ 則數沒變、只改了第 2 則的字：講得出是第 2 則（以前四格都一樣＝一筆都不寫）', () => {
    expect(changedMessageNumbers([text('a'), text('b')], [text('a'), text('b 改了')])).toEqual([2])
  })

  it('什麼都沒改＝空的（打開看一下就存檔不記）', () => {
    expect(changedMessageNumbers([text('a'), text('b')], [text('a'), text('b')])).toEqual([])
  })

  it('欄位順序不一樣不算改（Firestore 讀回來的順序跟畫面送來的不一定一樣）', () => {
    expect(changedMessageNumbers([{ text: 'a', type: 'text', buttons: [] }], [text('a')])).toEqual([])
  })

  it('試算表格子的備份（系統自己附的）變了不算店家改', () => {
    const before = [{ ...text('{{sheet:A|出貨時間}}'), sheetSnapshots: { 'A|出貨時間': '10 月' } }]
    expect(changedMessageNumbers(before, [text('{{sheet:A|出貨時間}}')])).toEqual([])
    expect(changedMessageNumbers(before, [{ ...text('{{sheet:A|出貨時間}}'), sheetSnapshots: { 'A|出貨時間': '11 月' } }])).toEqual([])
  })

  it('則數有變：只講兩邊都有的那幾則（多出來那則「訊息則數」已經講了）', () => {
    expect(changedMessageNumbers([text('a')], [text('a'), text('新的')])).toEqual([])
    expect(changedMessageNumbers([text('a'), text('b')], [text('改')])).toEqual([1])
  })

  it('按鈕、圖片這種深一層的也算', () => {
    expect(changedMessageNumbers([{ type: 'image', originalContentUrl: 'x.png' }], [{ type: 'image', originalContentUrl: 'y.png' }])).toEqual([1])
    expect(changedMessageNumbers(
      [{ ...text('a'), buttons: [{ label: '看商品', uri: 'https://a' }] }],
      [{ ...text('a'), buttons: [{ label: '看商品', uri: 'https://b' }] }],
    )).toEqual([1])
  })

  it('講法', () => {
    expect(messageNumbersText([1, 3])).toBe('第 1、3 則')
  })
})
