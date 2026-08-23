/**
 * 會員列表查詢的組裝與去重。
 *
 * 存在的理由是一個真實事故：2026-08-23 加「只看有 AI 建議的」篩選時，畫面把 `suggested`
 * 傳進 `loadUsers`，但 composable 的參數組裝與去重鑰匙都沒帶它 → **整個篩選是死的，
 * 而且 typecheck 是綠的**（呼叫端不是字面物件，不吃 excess property check）、
 * 1507 條測試也是綠的（沒有一條跑到這段）。
 *
 * 所以這裡逐條釘住「條件有沒有真的送出去」——以後新增條件照這個表加一條。
 */
import { describe, it, expect } from 'vitest'
import { buildUserListParams, userListRequestKey, ADMIN_USER_PAGE_SIZE } from './useAdminUserList'

describe('buildUserListParams：每個條件都要真的進到查詢字串', () => {
  it('suggested=true → 帶 suggested=1（漏掉這條就是「按了沒反應」）', () => {
    expect(buildUserListParams({ suggested: true }).get('suggested')).toBe('1')
  })

  it('suggested=false／未給 → 完全不帶這個參數（不是帶 0）', () => {
    expect(buildUserListParams({ suggested: false }).has('suggested')).toBe(false)
    expect(buildUserListParams({}).has('suggested')).toBe(false)
    expect(buildUserListParams().has('suggested')).toBe(false)
  })

  it('標籤／搜尋字／分頁照樣帶，且搜尋字前後空白會修掉', () => {
    const p = buildUserListParams({ tagIds: ['t1', 't2'], search: '  小江 ', page: 3, limit: 20 })
    expect(p.get('tagIds')).toBe('t1,t2')
    expect(p.get('search')).toBe('小江')
    expect(p.get('page')).toBe('3')
    expect(p.get('limit')).toBe('20')
  })

  it('空白搜尋字不帶（否則後端會走搜尋掃描路徑，白付讀取）', () => {
    expect(buildUserListParams({ search: '   ' }).has('search')).toBe(false)
  })

  it('沒給 limit 用預設頁大小', () => {
    expect(buildUserListParams({}).get('limit')).toBe(String(ADMIN_USER_PAGE_SIZE))
  })

  it('多條件同時成立 → 全部都在（篩選是交集，缺一個就是結果錯）', () => {
    const p = buildUserListParams({ tagIds: ['t1'], search: '江', suggested: true })
    expect([p.get('tagIds'), p.get('search'), p.get('suggested')]).toEqual(['t1', '江', '1'])
  })
})

describe('userListRequestKey：去重鑰匙要蓋住所有條件', () => {
  it('只有 suggested 不同 → 鑰匙必須不同（否則切換時會拿到飛行中那支的舊結果）', () => {
    expect(userListRequestKey({ page: 1 })).not.toBe(userListRequestKey({ page: 1, suggested: true }))
  })

  it('條件完全一樣 → 鑰匙相同（同一輪重複呼叫要能共用）', () => {
    expect(userListRequestKey({ tagIds: ['t1'], search: 'a', suggested: true, page: 2 }))
      .toBe(userListRequestKey({ tagIds: ['t1'], search: 'a', suggested: true, page: 2 }))
  })

  it('標籤／搜尋／頁碼任一不同 → 鑰匙不同', () => {
    const base = { tagIds: ['t1'], search: 'a', page: 1 }
    expect(userListRequestKey(base)).not.toBe(userListRequestKey({ ...base, tagIds: ['t2'] }))
    expect(userListRequestKey(base)).not.toBe(userListRequestKey({ ...base, search: 'b' }))
    expect(userListRequestKey(base)).not.toBe(userListRequestKey({ ...base, page: 2 }))
  })

  it('鑰匙與參數組裝吃同一組條件——兩邊都要看得到 suggested', () => {
    const q = { suggested: true }
    expect(userListRequestKey(q)).toContain('"suggested":true')
    expect(buildUserListParams(q).has('suggested')).toBe(true)
  })
})
