import { describe, expect, it } from 'vitest'
import { mergeIntoList, reuseUnchangedRows } from './list-merge'

type Row = { id: string, text: string, at?: { _seconds: number, _nanoseconds: number } }
const key = (r: Row) => r.id
const ts = (s: number) => ({ _seconds: s, _nanoseconds: 0 })

describe('reuseUnchangedRows', () => {
  it('沒變的列沿用原物件（identity 不變，Vue 才不會重繪整排）', () => {
    const a = { id: 'a', text: '嗨' }
    const b = { id: 'b', text: '你好' }
    const out = reuseUnchangedRows([a, b], [{ id: 'a', text: '嗨' }, { id: 'b', text: '你好' }], key)
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
  })

  it('有變的列換成新物件，其他仍沿用', () => {
    const a = { id: 'a', text: '嗨' }
    const b = { id: 'b', text: '你好' }
    const nextB = { id: 'b', text: '你好嗎' }
    const out = reuseUnchangedRows([a, b], [{ id: 'a', text: '嗨' }, nextB], key)
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(nextB)
  })

  /** 時間戳是巢狀物件，用 === 比永遠不相等；靠序列化比對才不會每次都判定「變了」 */
  it('內容相同的時間戳物件不算變更', () => {
    const a: Row = { id: 'a', text: '嗨', at: ts(100) }
    const out = reuseUnchangedRows([a], [{ id: 'a', text: '嗨', at: ts(100) }], key)
    expect(out[0]).toBe(a)
  })

  it('時間戳真的變了就換新物件', () => {
    const a: Row = { id: 'a', text: '嗨', at: ts(100) }
    const out = reuseUnchangedRows([a], [{ id: 'a', text: '嗨', at: ts(200) }], key)
    expect(out[0]).not.toBe(a)
    expect(out[0]!.at).toEqual(ts(200))
  })

  it('順序完全照 incoming（新訊息把某列頂到最前面）', () => {
    const a = { id: 'a', text: '1' }
    const b = { id: 'b', text: '2' }
    const out = reuseUnchangedRows([a, b], [{ id: 'b', text: '2' }, { id: 'a', text: '1' }], key)
    expect(out.map(key)).toEqual(['b', 'a'])
    expect(out[0]).toBe(b)
  })

  it('incoming 沒有的列不會被留下（訊息清單要照後端的完整結果）', () => {
    const out = reuseUnchangedRows([{ id: 'a', text: '1' }], [{ id: 'b', text: '2' }], key)
    expect(out.map(key)).toEqual(['b'])
  })
})

describe('mergeIntoList', () => {
  it('還有下一頁：新的列插進來，已載入但這頁沒回來的接在後面（不能讓第二頁憑空消失）', () => {
    const page2 = { id: 'old', text: '第二頁載進來的' }
    const a = { id: 'a', text: '1' }
    const out = mergeIntoList([a, page2], [{ id: 'new', text: '剛進線' }, { id: 'a', text: '1' }], key, true)
    expect(out.map(key)).toEqual(['new', 'a', 'old'])
    // 沒變的沿用原物件；被擠到後面的第二頁資料原封不動留著
    expect(out[1]).toBe(a)
    expect(out[2]).toBe(page2)
  })

  /** hasMore=false ＝這一頁就是全部，該消失的列（取消標記、被清掉）就要真的消失 */
  it('沒有下一頁：完全照 incoming，舊列不留', () => {
    const out = mergeIntoList(
      [{ id: 'a', text: '1' }, { id: 'gone', text: '被取消標記了' }],
      [{ id: 'a', text: '1' }],
      key,
      false,
    )
    expect(out.map(key)).toEqual(['a'])
  })

  it('不重複：同一列同時在 incoming 和舊清單裡只會出現一次', () => {
    const out = mergeIntoList(
      [{ id: 'a', text: '1' }, { id: 'b', text: '2' }],
      [{ id: 'b', text: '2 改過' }, { id: 'a', text: '1' }],
      key,
      true,
    )
    expect(out.map(key)).toEqual(['b', 'a'])
  })

  it('第一次載入（舊清單是空的）就是直接用 incoming', () => {
    const rows = [{ id: 'a', text: '1' }]
    expect(mergeIntoList([], rows, key, true)).toEqual(rows)
  })
})
