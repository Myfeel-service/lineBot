/**
 * `D-129`：學失敗的知識，系統還會自己再試的時候不給按鈕；自動重試用完（5 次）才給「再試一次」。
 */
import { describe, expect, it } from 'vitest'
import {
  chunkLearnState,
  chunkRetryButtonShown,
  isAutoRetryExhausted,
  isAutoRetrying,
  isKeptPreviousExhausted,
  isKeptPreviousRelearning,
  KB_AUTO_RETRY_TEXT,
  KB_KEPT_EXHAUSTED_LINE,
  KB_KEPT_PREVIOUS_TEXT,
  KB_RETRY_BUTTON,
  KB_RETRY_EXHAUSTED_ADVICE,
  KB_RETRY_EXHAUSTED_TEXT,
  KNOWLEDGE_MAX_AUTO_RETRIES,
  needsManualRetry,
  plainIndexFailure,
  relearnStateAfterFailure,
} from './knowledge-relearn'

describe('還在自動再試 vs 試完了（按鈕只在用完才出現）', () => {
  it('上限是 5 次（含第一次失敗）', () => {
    expect(KNOWLEDGE_MAX_AUTO_RETRIES).toBe(5)
  })

  it('失敗 1～4 次：系統還會再試 → 不給按鈕', () => {
    for (const n of [0, 1, 2, 3, 4]) {
      const c = { status: 'failed', retryCount: n }
      expect(isAutoRetrying(c)).toBe(true)
      expect(isAutoRetryExhausted(c)).toBe(false)
      expect(chunkLearnState(c)).toBe('retrying')
      expect(chunkRetryButtonShown(chunkLearnState(c))).toBe(false)
    }
  })

  it('失敗滿 5 次（含手動又失敗、超過 5）：試完了 → 這時才給「再試一次」', () => {
    for (const n of [5, 6, 9]) {
      const c = { status: 'failed', retryCount: n }
      expect(isAutoRetrying(c)).toBe(false)
      expect(isAutoRetryExhausted(c)).toBe(true)
      expect(chunkLearnState(c)).toBe('exhausted')
      expect(chunkRetryButtonShown(chunkLearnState(c))).toBe(true)
    }
  })

  it('舊資料沒有 retryCount／亂寫的＝當成還在再試（⛔ 寧可少一顆，也不要叫他做系統會做的事）', () => {
    expect(chunkLearnState({ status: 'failed' })).toBe('retrying')
    expect(chunkLearnState({ status: 'failed', retryCount: 'x' })).toBe('retrying')
    expect(chunkLearnState({ status: 'failed', retryCount: -3 })).toBe('retrying')
  })

  it('不是失敗的不算：可用、處理中、等你看過、停用（沒原因）＝none；停用中又沒學成的＝一開始就給（排程不碰停用的）', () => {
    for (const status of ['indexed', 'pending', 'draft', 'disabled']) {
      expect(chunkLearnState({ status, retryCount: 9 })).toBe('none')
      expect(isAutoRetryExhausted({ status, retryCount: 9 })).toBe(false)
    }
    expect(chunkLearnState({ status: 'disabled', failureReason: 'Gemini 502' })).toBe('disabledNoVector')
    expect(chunkRetryButtonShown('disabledNoVector')).toBe(true)
    expect(chunkRetryButtonShown('none')).toBe(false)
  })
})

describe('重學沒成、AI 先用原本學好的（`C-351`）', () => {
  it('還會自己再學（retrying）：什麼都不講、不給按鈕；試完（exhausted）：給「再試一次」', () => {
    expect(chunkLearnState({ status: 'indexed', relearnState: 'retrying', retryCount: 2, failureReason: 'Gemini 503' })).toBe('keptRetrying')
    expect(chunkRetryButtonShown('keptRetrying')).toBe(false)
    expect(chunkLearnState({ status: 'indexed', relearnState: 'exhausted', retryCount: 5, failureReason: 'Gemini 503' })).toBe('keptExhausted')
    expect(chunkRetryButtonShown('keptExhausted')).toBe(true)
    expect(isKeptPreviousRelearning({ status: 'indexed', relearnState: 'retrying' })).toBe(true)
    expect(isKeptPreviousExhausted({ status: 'indexed', relearnState: 'exhausted' })).toBe(true)
  })

  it('⛔ 不算「學失敗、客人問到找不到」：體檢、小幫手紅燈、LINE 推播（isAutoRetryExhausted）不為它亮；「再試一次」的清單（needsManualRetry）有它', () => {
    const c = { status: 'indexed', relearnState: 'exhausted', retryCount: 5 }
    expect(isAutoRetryExhausted(c)).toBe(false)
    expect(isAutoRetrying(c)).toBe(false)
    expect(needsManualRetry(c)).toBe(true)
    expect(needsManualRetry({ status: 'failed', retryCount: 5 })).toBe(true)
    expect(needsManualRetry({ status: 'indexed', relearnState: 'retrying', retryCount: 2 })).toBe(false)
  })

  it('記號只認 indexed 的：被改成失敗、停用的那一條照它自己的狀態講', () => {
    expect(chunkLearnState({ status: 'failed', relearnState: 'exhausted', retryCount: 1 })).toBe('retrying')
    expect(chunkLearnState({ status: 'disabled', relearnState: 'retrying' })).toBe('none')
  })

  it('又沒成之後：次數 +1、第 5 次起 exhausted；額度擋下（429）不耗次數', () => {
    expect(relearnStateAfterFailure(undefined, true)).toEqual({ retryCount: 1, relearnState: 'retrying' })
    expect(relearnStateAfterFailure(3, true)).toEqual({ retryCount: 4, relearnState: 'retrying' })
    expect(relearnStateAfterFailure(4, true)).toEqual({ retryCount: 5, relearnState: 'exhausted' })
    expect(relearnStateAfterFailure(7, true)).toEqual({ retryCount: 8, relearnState: 'exhausted' })
    expect(relearnStateAfterFailure(2, false)).toEqual({ retryCount: 2, relearnState: 'retrying' })
    expect(relearnStateAfterFailure('亂寫', true)).toEqual({ retryCount: 1, relearnState: 'retrying' })
  })

  it('那一行字：接在「系統試了 5 次都沒學會」後面（同 `D-129`），⛔ 不出現「重新學習」', () => {
    expect(KB_KEPT_EXHAUSTED_LINE).toBe('系統試了 5 次都沒學會，AI 先用原本學好的')
    expect(KB_KEPT_PREVIOUS_TEXT).not.toContain('重新學習')
  })
})

describe('給店家看的字', () => {
  it('⛔ 不出現「重新學習」', () => {
    for (const t of [KB_AUTO_RETRY_TEXT, KB_RETRY_BUTTON, KB_RETRY_EXHAUSTED_TEXT, KB_RETRY_EXHAUSTED_ADVICE]) {
      expect(t).not.toContain('重新學習')
    }
    expect(KB_AUTO_RETRY_TEXT).toBe('AI 還沒學會，系統會自己再試')
    expect(KB_RETRY_EXHAUSTED_TEXT).toBe('系統試了 5 次都沒學會')
  })

  it('失敗原因翻成白話：暫時性的、內容的、金鑰的分得出來', () => {
    expect(plainIndexFailure('Gemini embed: 503 UNAVAILABLE')).toEqual({ text: 'AI 服務暫時故障（暫時性問題）', retryable: true })
    expect(plainIndexFailure('ETIMEDOUT')).toMatchObject({ retryable: true })
    expect(plainIndexFailure('內容為空，無法建立索引')).toEqual({ text: '這一條內容有問題（可能是空的或只有符號）', retryable: false })
    expect(plainIndexFailure('API key not valid')).toMatchObject({ retryable: false })
    expect(plainIndexFailure('')).toEqual({ text: '原因不明', retryable: true })
  })
})
