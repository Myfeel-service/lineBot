import { describe, expect, it } from 'vitest'
import { readConversationFlags, withPinnedFirst } from './conversation-flags'

describe('readConversationFlags(人工標記讀取)', () => {
  it('有時間戳 = 有標記', () => {
    expect(readConversationFlags({ pinnedAt: { seconds: 1 }, followUpAt: { seconds: 2 } }))
      .toEqual({ pinned: true, followUp: true })
  })

  it('取消標記是把欄位刪掉,所以缺欄位 = 沒標記', () => {
    expect(readConversationFlags({})).toEqual({ pinned: false, followUp: false })
    expect(readConversationFlags(undefined)).toEqual({ pinned: false, followUp: false })
  })

  it('兩個標記各自獨立,不會互相帶到', () => {
    expect(readConversationFlags({ followUpAt: { seconds: 2 } }))
      .toEqual({ pinned: false, followUp: true })
  })
})

// 這一頁的重點：釘選的對話在時間序裡本來就有自己的位置，
// 不去重的話會在第一頁的釘選區和它原本的頁次各出現一次。
describe('withPinnedFirst(釘選置頂)', () => {
  const row = (userId: string) => ({ userId })

  it('第一頁:釘選排最前面,而且不在下面的時間序裡重複出現', () => {
    const pinned = [row('u3')]
    const page = [row('u1'), row('u2'), row('u3'), row('u4')]
    expect(withPinnedFirst(pinned, page, new Set(['u3'])).map(r => r.userId))
      .toEqual(['u3', 'u1', 'u2', 'u4'])
  })

  it('第二頁以後:不再重印釘選區,但仍要把釘選那幾筆從本頁濾掉', () => {
    const page = [row('u7'), row('u3'), row('u8')]
    expect(withPinnedFirst([], page, new Set(['u3'])).map(r => r.userId))
      .toEqual(['u7', 'u8'])
  })

  it('釘選順序照傳進來的順序(後端已依 pinnedAt desc 排好),不重排', () => {
    const pinned = [row('b'), row('a')]
    expect(withPinnedFirst(pinned, [row('c')], new Set(['a', 'b'])).map(r => r.userId))
      .toEqual(['b', 'a', 'c'])
  })

  it('沒有任何釘選時原樣回傳', () => {
    const page = [row('u1'), row('u2')]
    expect(withPinnedFirst([], page, new Set())).toEqual(page)
  })

  it('釘選的對話已經不在這一頁(例如很舊)也不會漏掉:仍在最上面出現一次', () => {
    const pinned = [row('old')]
    const page = [row('u1'), row('u2')]
    expect(withPinnedFirst(pinned, page, new Set(['old'])).map(r => r.userId))
      .toEqual(['old', 'u1', 'u2'])
  })
})
