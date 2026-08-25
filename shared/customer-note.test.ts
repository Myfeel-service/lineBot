import { describe, expect, it } from 'vitest'
import { CUSTOMER_NOTE_MAX_CHARS, isEmptyCustomerNote, normalizeCustomerNote } from './customer-note'

describe('客人備註的存檔前正規化（G-27 功能缺口①）', () => {
  it('不是字串一律當空的（body 亂帶東西不能寫進資料庫）', () => {
    expect(normalizeCustomerNote(undefined)).toBe('')
    expect(normalizeCustomerNote(null)).toBe('')
    expect(normalizeCustomerNote(123)).toBe('')
    expect(normalizeCustomerNote({ text: 'x' })).toBe('')
  })

  it('換行統一成 \\n（Windows 貼過來的 CRLF 會讓字數與顯示對不上）', () => {
    expect(normalizeCustomerNote('第一行\r\n第二行\r第三行')).toBe('第一行\n第二行\n第三行')
  })

  it('砍掉每一行尾端的空白與整段尾端的空行', () => {
    expect(normalizeCustomerNote('已回報廠商   \n等回覆\t\n\n\n')).toBe('已回報廠商\n等回覆')
  })

  it('⛔ 開頭的空白要留著——那是客服自己排的縮排，不該幫他改掉', () => {
    expect(normalizeCustomerNote('  · 已回報廠商')).toBe('  · 已回報廠商')
  })

  it('超過上限就截斷（和 LINE 記事本同一個 1000 字）', () => {
    const long = 'ㄅ'.repeat(CUSTOMER_NOTE_MAX_CHARS + 50)
    expect(normalizeCustomerNote(long)).toHaveLength(CUSTOMER_NOTE_MAX_CHARS)
  })

  it('只有空白的備註＝沒有備註（端點要據此把欄位整組刪掉）', () => {
    expect(isEmptyCustomerNote(normalizeCustomerNote('   \n\n  '))).toBe(true)
    expect(isEmptyCustomerNote(normalizeCustomerNote('等廠商回覆'))).toBe(false)
  })
})
