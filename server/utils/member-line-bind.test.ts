import { describe, expect, it } from 'vitest'
import { buildBindCodeMessage, buildBindDeepLink, parseMemberBindCode } from './member-line-bind'

describe('parseMemberBindCode — 綁定碼辨識', () => {
  it('後台產的整串訊息照抄就認得', () => {
    expect(parseMemberBindCode(buildBindCodeMessage('A3F9K2'))).toBe('A3F9K2')
  })

  it('小寫、全形冒號、沒空格、前後空白都認', () => {
    expect(parseMemberBindCode('綁定a3f9k2')).toBe('A3F9K2')
    expect(parseMemberBindCode('綁定：A3F9K2')).toBe('A3F9K2')
    expect(parseMemberBindCode('  bind A3F9K2  ')).toBe('A3F9K2')
    expect(parseMemberBindCode('BIND-a3f9k2')).toBe('A3F9K2')
  })

  it('客人的日常訊息不會被誤判成綁定嘗試', () => {
    // 誤判的代價是客人收到「綁定碼不正確」而不是正常回覆——寧可漏認也不能亂認
    for (const text of [
      '請問有現貨嗎',
      'A3F9K2',
      '我要綁定',
      '綁定 A3F9K',
      '綁定 A3F9K23',
      '幫我綁定 A3F9K2 謝謝',
      '',
    ]) {
      expect(parseMemberBindCode(text), text).toBeNull()
    }
  })
})

describe('buildBindDeepLink — 一鍵綁定連結', () => {
  it('@basicId 與內文都 percent-encode', () => {
    expect(buildBindDeepLink('@abc1234', 'A3F9K2'))
      .toBe('https://line.me/R/oaMessage/%40abc1234/?%E7%B6%81%E5%AE%9A%20A3F9K2')
  })

  it('連結預填的內容,解析回來就是同一組碼', () => {
    const url = buildBindDeepLink('@abc1234', 'A3F9K2')
    const prefilled = decodeURIComponent(url.split('/?')[1] ?? '')
    expect(parseMemberBindCode(prefilled)).toBe('A3F9K2')
  })

  it('拿不到官方帳號 ID 時回空字串,讓 UI 退回手動輸入', () => {
    expect(buildBindDeepLink('', 'A3F9K2')).toBe('')
    expect(buildBindDeepLink('   ', 'A3F9K2')).toBe('')
  })
})
