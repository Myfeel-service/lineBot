import { describe, it, expect } from 'vitest'
import { aggregatePendingByTag } from './tag-suggestion-stats'

describe('aggregatePendingByTag', () => {
  it('數的是客人數不是建議數', () => {
    const counts = aggregatePendingByTag([
      { pending: [{ tagId: 'coffee' }, { tagId: 'gift' }] },
      { pending: [{ tagId: 'coffee' }] },
    ])
    expect(counts).toEqual({ coffee: 2, gift: 1 })
  })

  it('同一位客人重複掛同一顆只算一位（不靠上游保證去重）', () => {
    const counts = aggregatePendingByTag([
      { pending: [{ tagId: 'coffee' }, { tagId: 'coffee' }] },
    ])
    expect(counts).toEqual({ coffee: 1 })
  })

  it('沒有待審的文件不會生出 0 的欄位（畫面靠「有沒有這個 key」決定顯不顯示）', () => {
    expect(aggregatePendingByTag([{ pending: [] }, { pending: null }, {}])).toEqual({})
  })

  it('壞資料不炸也不算進去', () => {
    const counts = aggregatePendingByTag([
      { pending: [{ tagId: '' }, { tagId: '  ' }, { tagId: 'ok' }] },
    ])
    expect(counts).toEqual({ ok: 1 })
  })
})
