import { describe, expect, it } from 'vitest'
import { classifyLiffEndpoint } from './liff-endpoint-remote'

describe('classifyLiffEndpoint', () => {
  const canonical = 'https://lineminime.com'

  it('ok when endpoint is the canonical lead page', () => {
    expect(classifyLiffEndpoint('https://lineminime.com/liff/lead', canonical)).toBe('ok')
  })

  it('ok with trailing slash noise', () => {
    expect(classifyLiffEndpoint('https://lineminime.com/liff/lead/', canonical)).toBe('ok')
    expect(classifyLiffEndpoint('https://lineminime.com/liff/lead', `${canonical}/`)).toBe('ok')
  })

  // 2026-08-07 實測災情：換網域後 LINE 還登記舊網域，客人登入後在兩個網址間繞
  it('mismatch when the domain is not the canonical one', () => {
    expect(classifyLiffEndpoint('https://bot.myfeel-tw.com/liff/lead', canonical)).toBe('mismatch')
  })

  it('mismatch on legacy /webhook path even on the canonical domain (GET redirects, but should be fixed)', () => {
    expect(classifyLiffEndpoint('https://lineminime.com/webhook', canonical)).toBe('mismatch')
  })

  it('mismatch on legacy /webhook path on an old domain', () => {
    expect(classifyLiffEndpoint('https://bot.myfeel-tw.com/webhook', canonical)).toBe('mismatch')
  })

  // 鼴究室實例：LIFF 登記著第三方服務的頁，客人點活動連結會被帶去別人的網站
  it('broken when the endpoint points to an unrelated page', () => {
    expect(classifyLiffEndpoint('https://pages.omnichat.ai/liff-bind.html?liffId=2008600179-yV1OKXNv', canonical)).toBe('broken')
  })

  it('broken when the path is not the lead page even on the canonical domain', () => {
    expect(classifyLiffEndpoint('https://lineminime.com/admin', canonical)).toBe('broken')
  })

  it('broken on an unparseable endpoint', () => {
    expect(classifyLiffEndpoint('not-a-url', canonical)).toBe('broken')
  })

  // 寧可漏抓不誤報：沒有可信的比對基準時只驗路徑、不驗網域
  it('skips domain comparison when canonical base is empty', () => {
    expect(classifyLiffEndpoint('https://whatever.example.com/liff/lead', '')).toBe('ok')
    expect(classifyLiffEndpoint('https://whatever.example.com/other', '')).toBe('broken')
  })

  it('skips domain comparison when canonical base is localhost', () => {
    expect(classifyLiffEndpoint('https://bot.myfeel-tw.com/liff/lead', 'http://localhost:3000')).toBe('ok')
  })
})
