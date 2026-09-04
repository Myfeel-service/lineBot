import { describe, expect, it } from 'vitest'
import { canReplaceSource, detectImportKind, storedSourceType } from './knowledge-import-detect'

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

describe('storedSourceType', () => {
  it('只有「貼上文字」會換名字（存成 manual）', () => {
    expect(storedSourceType('text')).toBe('manual')
    expect(storedSourceType('file')).toBe('file')
    expect(storedSourceType('url')).toBe('url')
    expect(storedSourceType('gsheet')).toBe('gsheet')
  })
})

describe('canReplaceSource（C-139：不准跨型別覆蓋）', () => {
  it('同型別才給覆蓋', () => {
    expect(canReplaceSource('file', 'file')).toBe(true)
    expect(canReplaceSource('gsheet', 'gsheet')).toBe(true)
    expect(canReplaceSource('text', 'manual')).toBe(true) // 貼上文字存成 manual
  })

  it('🔴 用檔案覆蓋 Google 試算表要擋掉（覆蓋後它會從此不再自動同步）', () => {
    expect(canReplaceSource('file', 'gsheet')).toBe(false)
    expect(canReplaceSource('url', 'file')).toBe(false)
    expect(canReplaceSource('text', 'url')).toBe(false)
  })

  it('舊資料沒存型別 → 不在前端擋，交給後端判', () => {
    expect(canReplaceSource('file', '')).toBe(true)
  })
})
