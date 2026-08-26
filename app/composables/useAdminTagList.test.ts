import { describe, expect, it } from 'vitest'
import { buildTagListParams } from './useAdminTagList'

/**
 * 2026-08-26 抓到的 bug：標籤頁的「AI 判斷」下拉有傳 aiMode，但 composable 沒帶進網址，
 * 也沒算進 in-flight 快取鍵 → **選了完全沒反應**。TypeScript 對變數組出來的物件不做
 * 多餘屬性檢查，所以編譯器全程沉默。這組測試把「每個條件都要真的送出去」釘住。
 */
describe('標籤列表的網址參數', () => {
  it('⛔ aiMode 要真的帶進網址（這正是那個靜默被丟掉的參數）', () => {
    expect(buildTagListParams({ aiMode: 'ai' }).get('aiMode')).toBe('ai')
    expect(buildTagListParams({ aiMode: 'off' }).get('aiMode')).toBe('off')
  })

  it('每個條件都送得出去', () => {
    const p = buildTagListParams({
      status: 'active', category: 'interest', aiMode: 'ai',
      search: '除濕', includeMemberCount: true, page: 2, limit: 50,
    })
    expect(Object.fromEntries(p)).toEqual({
      status: 'active', category: 'interest', aiMode: 'ai',
      search: '除濕', includeMemberCount: '1', page: '2', limit: '50',
    })
  })

  it('空值不送（避免 ?status=&category= 這種噪音網址）', () => {
    expect([...buildTagListParams({}).keys()]).toEqual([])
    expect([...buildTagListParams({ status: '', aiMode: '', search: '   ' }).keys()]).toEqual([])
  })

  it('搜尋字前後空白會修掉', () => {
    expect(buildTagListParams({ search: '  除濕機  ' }).get('search')).toBe('除濕機')
  })

  it('沒帶 page 就不送分頁參數（列表有兩種模式）', () => {
    const p = buildTagListParams({ status: 'active' })
    expect(p.has('page')).toBe(false)
    expect(p.has('limit')).toBe(false)
  })
})
