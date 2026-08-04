import { describe, expect, it } from 'vitest'
import { detectImportKind } from './knowledge-import-detect'

describe('detectImportKind', () => {
  it('選了檔案就一律是檔案（檔案優先，避免同時有檔案又有貼上內容而判不出來）', () => {
    expect(detectImportKind('', true)).toBe('file')
    expect(detectImportKind('https://example.com/faq', true)).toBe('file')
  })

  it('什麼都沒給時回 file（呼叫端的「可以開始」仍為 false，按鈕是停用的）', () => {
    expect(detectImportKind('')).toBe('file')
    expect(detectImportKind('   \n ')).toBe('file')
  })

  it('Google 試算表網址 → gsheet', () => {
    expect(detectImportKind('https://docs.google.com/spreadsheets/d/abc123/edit#gid=0')).toBe('gsheet')
    expect(detectImportKind('  https://docs.google.com/spreadsheets/d/abc/edit  ')).toBe('gsheet')
  })

  it('裸的試算表 ID → gsheet（舊分頁介面允許直接貼 ID，不收會被當純文字匯進去）', () => {
    expect(detectImportKind('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms')).toBe('gsheet')
  })

  it('一般網址 → url', () => {
    expect(detectImportKind('https://example.com/faq')).toBe('url')
    expect(detectImportKind('http://shop.example.com/products/1')).toBe('url')
  })

  it('中文段落、含空白的文字 → text（不會被 20 字規則誤判成試算表 ID）', () => {
    expect(detectImportKind('全館滿千免運，未滿收 80 元。海外運費另計。')).toBe('text')
    expect(detectImportKind('abcdefghijklmnopqrstuvwxyz with spaces')).toBe('text')
  })

  it('缺協定的網址視為文字（抓不到的東西不要假裝可以抓）', () => {
    expect(detectImportKind('www.example.com/faq')).toBe('text')
  })
})
