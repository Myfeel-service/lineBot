import { describe, expect, it } from 'vitest'
import { LEAD_PATH, leadEndpointUrl } from './liff-lead-path'

// 這組口徑同時是「精靈教的」與「健康檢查驗的」：改任何一邊都會讓剛開通的人被亮紅，
// 所以用測試釘住，不再只靠註解對齊
describe('liff-lead-path', () => {
  it('組出 base + LEAD_PATH', () => {
    expect(leadEndpointUrl('https://example.com')).toBe(`https://example.com${LEAD_PATH}`)
  })

  it('尾斜線與前後空白都剝掉（LINE 後台比對是整串比對）', () => {
    expect(leadEndpointUrl(' https://example.com/ ')).toBe('https://example.com/liff/lead')
  })

  it('base 空回空字串，呼叫端自己決定兜底或不顯示', () => {
    expect(leadEndpointUrl('')).toBe('')
    expect(leadEndpointUrl('   ')).toBe('')
  })
})
