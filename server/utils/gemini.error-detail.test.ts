/**
 * 失敗原因要存得下來、而且存下來的東西不能夾帶金鑰。
 *
 * 背景：2026-09-01 有一場真的 llm_error，事後想查是額度、過載還是逾時，
 * 發現錯誤訊息只進過主機的即時日誌、資料庫只留「失敗」兩個字，只能靠排除法猜。
 * 現在會寫進 aiMeta／aiTurns 給超管看——所以「寫下去之前先洗過」是這支測試的重點。
 *
 * 順帶驗轉向量那一步的重試次數：它沒有備用模型可切（生成那步有 flash → flash-lite），
 * 只重試一次等於整條答題路徑最薄的一道防線在最前面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).useRuntimeConfig ??= () => ({ geminiApiKey: 'test-key' })
;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

vi.mock('./ai-usage', () => ({ assertMaintenanceBudget: vi.fn() }))

import { describeGeminiError, embedQuery } from './gemini'

describe('describeGeminiError：可以存進資料庫的失敗原因', () => {
  it('留得住狀態碼與訊息——這正是事後要拿來分辨失敗種類的東西', () => {
    const err = Object.assign(new Error('x'), {
      statusCode: 502,
      statusMessage: 'Gemini error (503): The model is overloaded. Please try again later.',
    })
    const out = describeGeminiError(err)
    expect(out).toContain('503')
    expect(out).toContain('overloaded')
  })

  it('⛔ 金鑰一定要抹掉（錯誤訊息會把請求內容整包回貼）', () => {
    const err = { statusMessage: 'Gemini error: bad request to ?key=AIzaSyC0ffee0123456789abcdefGHIJKLMNOP' }
    const out = describeGeminiError(err)
    expect(out).not.toContain('AIzaSyC0ffee0123456789abcdefGHIJKLMNOP')
    expect(out).toContain('AIza***')
  })

  it('過長要截短（別把整段 prompt 灌進 Firestore）', () => {
    const out = describeGeminiError({ statusMessage: 'x'.repeat(1000) })
    expect(out.length).toBeLessThanOrEqual(301)
    expect(out.endsWith('…')).toBe(true)
  })

  it('連訊息都沒有時給一句話，不要回空字串（空字串在畫面上等於沒發生過）', () => {
    expect(describeGeminiError(undefined)).toBe('未知錯誤（沒有訊息）')
    expect(describeGeminiError({})).toBe('未知錯誤（沒有訊息）')
  })
})

describe('轉向量沒有備用模型，所以重試次數要比生成多', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('連續 503 會試滿 4 次（1 次 + 3 次重試）才放棄', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'The model is overloaded.' } }),
    }))
    ;(globalThis as any).fetch = fetchMock

    await expect(embedQuery('乾淨方max 晚上開賣，什麼時候可以拿到呢')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  }, 20_000)

  it('中途成功就不再重試（重試是保險，不是每次都要付的成本）', async () => {
    let n = 0
    ;(globalThis as any).fetch = vi.fn(async () => {
      n++
      return n === 1
        ? { ok: false, status: 503, json: async () => ({ error: { message: 'overloaded' } }) }
        : { ok: true, status: 200, json: async () => ({ embedding: { values: Array.from({ length: 768 }, () => 0.1) } }) }
    })

    const vec = await embedQuery('測試')
    expect(vec).toHaveLength(768)
    expect(n).toBe(2)
  }, 20_000)
})
