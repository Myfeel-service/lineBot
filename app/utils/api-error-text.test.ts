import { describe, expect, it } from 'vitest'
import { apiErrorStatus, apiErrorText, isRetryableError } from './api-error-text'

/** 長得像 $fetch 丟出來的錯（ofetch 的 FetchError） */
function fetchError(status: number, data: unknown, statusMessage = '') {
  return Object.assign(new Error(`[POST] "/api/ai/knowledge/x/restore": ${status} ${statusMessage}`), {
    name: 'FetchError',
    status,
    statusCode: status,
    statusMessage,
    data,
    response: { status },
  })
}

describe('apiErrorText', () => {
  it('伺服器的中文原因在 data.statusMessage：講它', () => {
    const err = fetchError(403, { statusCode: 403, statusMessage: 'AI 知識量滿了，先刪掉用不到的知識或升級方案' }, 'Forbidden')
    expect(apiErrorText(err, '還原失敗')).toBe('AI 知識量滿了，先刪掉用不到的知識或升級方案')
  })

  it('⛔ 不講 HTTP 狀態那一行（正式站只拿得到英文 Not Found）', () => {
    const err = fetchError(404, undefined, 'Not Found')
    const text = apiErrorText(err, '還原失敗')
    expect(text).toBe('還原失敗')
    expect(text).not.toContain('Not Found')
  })

  it('⛔ HTTP 錯誤的 message 是網址＋狀態碼，不能給人看', () => {
    const err = fetchError(500, null, '')
    expect(apiErrorText(err, '儲存失敗')).toBe('儲存失敗')
  })

  it('data.statusMessage 沒有就看 data.message', () => {
    const err = fetchError(400, { message: '這張卡在回收桶裡，請先還原再操作' })
    expect(apiErrorText(err, '解除失敗')).toBe('這張卡在回收桶裡，請先還原再操作')
  })

  it('英文的開發用訊息（chunk not found）不丟給店家：退回呼叫端那句', () => {
    const err = fetchError(404, { statusCode: 404, statusMessage: 'chunk not found', message: 'chunk not found' }, 'Not Found')
    expect(apiErrorText(err, '找不到這一條')).toBe('找不到這一條')
  })

  it('自己丟的錯（輪詢、流程中）有中文就講', () => {
    expect(apiErrorText(new Error('比對結果不完整，請再試一次'), '重新整理沒有完成')).toBe('比對結果不完整，請再試一次')
  })

  it('程式本身的英文錯（TypeError、取消記號）不講', () => {
    expect(apiErrorText(new TypeError('Cannot read properties of undefined'), '載入失敗')).toBe('載入失敗')
    expect(apiErrorText(new Error('__cancelled__'), '已取消')).toBe('已取消')
  })

  it('什麼都沒有（null、字串、空物件）也不會炸', () => {
    expect(apiErrorText(null, 'A')).toBe('A')
    expect(apiErrorText(undefined, 'A')).toBe('A')
    expect(apiErrorText('壞了', 'A')).toBe('A')
    expect(apiErrorText({}, 'A')).toBe('A')
  })

  it('前後空白去掉、太長截斷', () => {
    expect(apiErrorText(fetchError(400, { statusMessage: '  空間不夠  ' }), 'x')).toBe('空間不夠')
    expect(apiErrorText(fetchError(400, { statusMessage: '長'.repeat(500) }), 'x')).toHaveLength(300)
  })
})

describe('isRetryableError', () => {
  it('⛔ 4xx 是伺服器看過、拒絕了：再按一次沒用', () => {
    for (const s of [400, 403, 404, 409, 413, 422]) expect(isRetryableError(fetchError(s, {}))).toBe(false)
  })

  it('逾時、太頻繁、5xx、斷線值得重試', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryableError(fetchError(s, {}))).toBe(true)
    expect(isRetryableError(Object.assign(new Error('fetch failed'), { name: 'FetchError' }))).toBe(true)
  })

  it('不是 HTTP 的錯當成值得重試（呼叫端原本的講法）', () => {
    expect(isRetryableError(new Error('比對結果不完整'))).toBe(true)
  })

  it('狀態碼從哪一格都讀得到', () => {
    expect(apiErrorStatus({ response: { status: 504 } })).toBe(504)
    expect(apiErrorStatus({ data: { statusCode: 403 } })).toBe(403)
    expect(apiErrorStatus(null)).toBe(0)
  })
})
