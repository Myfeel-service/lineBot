import { describe, expect, it } from 'vitest'
import { FOLLOW_UP_ICON, FOLLOW_UP_LABEL, followUpMenuItems, readConversationFlags, withPinnedFirst } from './conversation-flags'

describe('readConversationFlags(人工標記讀取)', () => {
  it('有 pinnedAt＝待跟進(`H-17`:原本的釘選改名,欄位沿用)', () => {
    expect(readConversationFlags({ pinnedAt: { seconds: 1 } })).toEqual({ pinned: true })
  })

  it('取消標記是把欄位刪掉,所以缺欄位 = 沒標記', () => {
    expect(readConversationFlags({})).toEqual({ pinned: false })
    expect(readConversationFlags(undefined)).toEqual({ pinned: false })
  })

  it('⛔ 舊的 followUpAt 不再讀(下架的那個待跟進;兩個專案只剩 1 筆,而且同一筆也有 pinnedAt)', () => {
    expect(readConversationFlags({ followUpAt: { seconds: 2 } } as any)).toEqual({ pinned: false })
  })
})

// `H-17`:右鍵／⋯ 選單只剩一項「待跟進」,用字與圖示都是待跟進,不再出現「釘選」
describe('followUpMenuItems(右鍵選單)', () => {
  it('沒標的:一項「標記待跟進」,圖示是旗子', () => {
    expect(followUpMenuItems({ pinned: false })).toEqual([{ key: 'pin', icon: '🚩', label: '標記待跟進' }])
  })

  it('已標的:同一項變成「取消待跟進」', () => {
    expect(followUpMenuItems({ pinned: true })).toEqual([{ key: 'pin', icon: '🚩', label: '取消待跟進' }])
  })

  it('⛔ 選單上不再出現「釘選」或圖釘(兩個名字解決同一件事,大家都拿釘選當待跟進用)', () => {
    for (const item of [...followUpMenuItems({ pinned: false }), ...followUpMenuItems({ pinned: true })]) {
      expect(item.label).not.toMatch(/釘/)
      expect(item.icon).not.toBe('📌')
    }
    expect(FOLLOW_UP_ICON).toBe('🚩')
    expect(FOLLOW_UP_LABEL).toBe('待跟進')
  })
})

// 這一頁的重點：待跟進的對話在時間序裡本來就有自己的位置，
// 不去重的話會在第一頁的待跟進區和它原本的頁次各出現一次。
describe('withPinnedFirst(待跟進置頂)', () => {
  const row = (userId: string) => ({ userId })

  it('第一頁:待跟進排最前面,而且不在下面的時間序裡重複出現', () => {
    const pinned = [row('u3')]
    const page = [row('u1'), row('u2'), row('u3'), row('u4')]
    expect(withPinnedFirst(pinned, page, new Set(['u3'])).map(r => r.userId))
      .toEqual(['u3', 'u1', 'u2', 'u4'])
  })

  it('第二頁以後:不再重印待跟進區,但仍要把那幾筆從本頁濾掉', () => {
    const page = [row('u7'), row('u3'), row('u8')]
    expect(withPinnedFirst([], page, new Set(['u3'])).map(r => r.userId))
      .toEqual(['u7', 'u8'])
  })

  it('待跟進順序照傳進來的順序(後端已依 pinnedAt desc 排好),不重排', () => {
    const pinned = [row('b'), row('a')]
    expect(withPinnedFirst(pinned, [row('c')], new Set(['a', 'b'])).map(r => r.userId))
      .toEqual(['b', 'a', 'c'])
  })

  it('沒有任何待跟進時原樣回傳', () => {
    const page = [row('u1'), row('u2')]
    expect(withPinnedFirst([], page, new Set())).toEqual(page)
  })

  it('待跟進的對話已經不在這一頁(例如很舊)也不會漏掉:仍在最上面出現一次', () => {
    const pinned = [row('old')]
    const page = [row('u1'), row('u2')]
    expect(withPinnedFirst(pinned, page, new Set(['old'])).map(r => r.userId))
      .toEqual(['old', 'u1', 'u2'])
  })
})
