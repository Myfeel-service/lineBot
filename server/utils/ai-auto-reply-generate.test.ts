/** 自動回覆草稿生成器:mock gemini 驗「防線 + normalize/validate + 重試」機械行為。 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { generateJson } = vi.hoisted(() => ({ generateJson: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson }))
;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)

import { generateAutoReplyDraft } from './ai-auto-reply-generate'

const step = (obj: unknown) => ({ data: obj, inputTokens: 10, outputTokens: 10 })

beforeEach(() => generateJson.mockReset())

describe('generateAutoReplyDraft', () => {
  it('合法輸出 → 通過與存檔同一套 normalize+validate', async () => {
    generateJson.mockResolvedValueOnce(step({
      name: '運費說明', matchType: 'containsAny', keyword: '運費,運送', actionType: 'message', text: '滿千免運 🙏',
    }))
    const d = await generateAutoReplyDraft('客人問運費就回滿千免運')
    expect(d.name).toBe('運費說明')
    expect(d.matchType).toBe('containsAny')
    expect(d.action.type).toBe('message')
    expect(d.action.text).toBe('滿千免運 🙏')
    expect(d.isActive).toBe(true)
  })

  it('模型硬要生 anyText → 防線降級成 containsAny(絕不放萬用規則回來)', async () => {
    generateJson.mockResolvedValueOnce(step({
      name: '萬用', matchType: 'anyText', keyword: '你好', actionType: 'message', text: '哈囉',
    }))
    const d = await generateAutoReplyDraft('隨便什麼都回哈囉')
    expect(d.matchType).toBe('containsAny')
  })

  it('module 動作 → 防線改成 message(不讓模型捏 moduleId)', async () => {
    generateJson.mockResolvedValueOnce(step({
      name: 'x', matchType: 'exact', keyword: '選單', actionType: 'module', text: '好的', uri: '',
    }))
    const d = await generateAutoReplyDraft('選單')
    expect(d.action.type).toBe('message')
  })

  it('第一次沒過驗證 → 把錯誤餵回重試一次;兩次都掛 → 422', async () => {
    generateJson
      .mockResolvedValueOnce(step({ name: '運費', matchType: 'containsAny', keyword: '運費', actionType: 'message', text: '' })) // 缺回覆文字
      .mockResolvedValueOnce(step({ name: '運費', matchType: 'containsAny', keyword: '運費', actionType: 'message', text: '滿千免運' }))
    const d = await generateAutoReplyDraft('運費')
    expect(d.action.text).toBe('滿千免運')
    expect(generateJson).toHaveBeenCalledTimes(2)
    expect(String(generateJson.mock.calls[1]![0])).toContain('沒通過驗證')

    generateJson.mockReset()
    generateJson.mockResolvedValue(step({ name: '', matchType: 'containsAny', keyword: '', actionType: 'message', text: '' }))
    await expect(generateAutoReplyDraft('???')).rejects.toMatchObject({ statusCode: 422 })
  })

  it('空描述 → 400', async () => {
    await expect(generateAutoReplyDraft('  ')).rejects.toMatchObject({ statusCode: 400 })
  })
})
