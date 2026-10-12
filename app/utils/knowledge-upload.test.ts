import { describe, expect, it } from 'vitest'
import { formatFileSize, uploadFailureMessage } from './knowledge-upload'

describe('formatFileSize', () => {
  it('KB 以下進位到 1 KB、1MB 以上一位小數；0 照呼叫端講（清單是空檔、資料頁是沒記到）', () => {
    expect(formatFileSize(200)).toBe('1 KB')
    expect(formatFileSize(1_843_200)).toBe('1.8 MB')
    expect(formatFileSize(0)).toBe('0 KB')
    expect(formatFileSize(0, { zero: '大小未知' })).toBe('大小未知')
  })
})

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
