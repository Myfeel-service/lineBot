import { describe, expect, it } from 'vitest'
import { uploadFailureMessage } from './knowledge-upload'

describe('uploadFailureMessage（直傳雲端失敗講給店家聽的那一句）', () => {
  it('沒有回應（網路斷、或雲端儲存不收這個網址）只說連不上，不猜是哪一種', () => {
    const msg = uploadFailureMessage(new TypeError('Failed to fetch'))
    expect(msg).toContain('連不上雲端儲存')
    expect(msg).not.toContain('網路中斷')
  })

  it('有回應的 403 講「被拒絕」，不再說是網路問題', () => {
    const msg = uploadFailureMessage({ statusCode: 403 })
    expect(msg).toContain('被拒絕')
    expect(msg).not.toContain('連不上')
  })

  it('其他狀態碼照實講出數字（給我們查），畫面上不出現網址', () => {
    const msg = uploadFailureMessage({ response: { status: 500 } })
    expect(msg).toContain('500')
    expect(msg).not.toMatch(/https?:/)
  })
})
