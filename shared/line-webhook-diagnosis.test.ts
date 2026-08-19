/**
 * LINE 收訊判讀測試。
 *
 * 這份存在的理由是一個真的踩過的坑：**兩個 401 是兩種病**。
 * ① 我們拿 Token 去問 LINE 被回 401 ＝ LINE 不認得我們的鑰匙（第一把）
 * ② LINE 拿測試訊息打我們、被回 401 ＝ 我們的簽章驗不過（第二把 Channel Secret）
 * 小幫手對話原本用 /HTTP 401/ 比對字串，兩種都說成「Token 貼錯」→ 把人指去重貼一把沒壞的鑰匙。
 *
 * 另一條同樣重要：**網址不一致時，測試打的是別人的網址**，它回什麼都不能拿來
 * 診斷我們這邊的設定（尤其不能因此說「你的 Channel Secret 錯了」）。
 */
import { describe, expect, it } from 'vitest'
import { diagnoseLineWebhook } from './line-webhook-diagnosis'

const base = {
  getOk: true,
  lineEndpoint: 'https://app.example.com/webhook',
  lineActive: true,
  urlMatchesCompare: true,
  endpointUnreachable: null,
  testSkipped: false,
  test: { success: true },
}

describe('diagnoseLineWebhook', () => {
  it('🔴 兩個 401 判成兩種病：問不到 LINE＝Token；測試被擋＝簽章（Channel Secret）', () => {
    const askLine401 = diagnoseLineWebhook({ ...base, getOk: false, getStatus: 401, test: null })
    expect(askLine401.cause).toBe('token')

    const testBlocked401 = diagnoseLineWebhook({ ...base, test: { success: false, statusCode: 401 } })
    expect(testBlocked401.cause).toBe('signature')
    // 講的話也要真的分開——兩邊都叫人去重貼同一把鑰匙就等於沒分
    expect(testBlocked401.hint).toContain('Channel Secret')
    expect(askLine401.hint).toContain('Channel Access Token')
  })

  it('🔴 網址不一致時，測試結果不能拿來診斷（那是別人的網址回的）', () => {
    // 舊網址剛好也回 401 的情況：不可以說成「你的 Channel Secret 錯了」
    const v = diagnoseLineWebhook({
      ...base,
      urlMatchesCompare: false,
      lineEndpoint: 'https://old.example.com/webhook',
      test: { success: false, statusCode: 401 },
    })
    expect(v.cause).toBe('mismatch')
    expect(v.hint).not.toContain('Channel Secret')
  })

  it('網址不一致：已連不上與還活著是兩種講法', () => {
    const dead = diagnoseLineWebhook({ ...base, urlMatchesCompare: false, endpointUnreachable: true, test: null })
    expect(dead.cause).toBe('mismatchDead')
    expect(dead.hint).toContain('連不上')

    const alive = diagnoseLineWebhook({ ...base, urlMatchesCompare: false, endpointUnreachable: false, test: null })
    expect(alive.cause).toBe('mismatch')
    expect(alive.hint).toContain('停用')
  })

  it('404＝還沒填網址；開關沒開排在測試結果前面', () => {
    expect(diagnoseLineWebhook({ ...base, getOk: false, getStatus: 404, test: null }).cause).toBe('nourl')
    expect(diagnoseLineWebhook({ ...base, lineActive: false, test: { success: false, statusCode: 500 } }).cause).toBe('inactive')
  })

  it('問不到（LINE 5xx / 沒帶狀態碼）一律不下結論', () => {
    expect(diagnoseLineWebhook({ ...base, getOk: false, getStatus: 500, test: null }).cause).toBe('unknown')
    expect(diagnoseLineWebhook({ ...base, getOk: false, test: null }).cause).toBe('unknown')
  })

  it('沒跑測試（testSkipped）不算失敗，也不吹成「一切正常」', () => {
    const v = diagnoseLineWebhook({ ...base, testSkipped: true, test: null })
    expect(v.cause).toBe('ok')
    expect(v.badge).toBe('✓ 看起來正常')
    expect(v.tone).toBe('success')

    // 實跑過而且過了，才敢講一切正常
    expect(diagnoseLineWebhook(base).badge).toBe('✓ 一切正常')
  })

  it('測試失敗但不是 401：講網址連不連得到，不要亂扯到鑰匙', () => {
    const v = diagnoseLineWebhook({ ...base, test: { success: false, statusCode: 502 } })
    expect(v.cause).toBe('testFailed')
    expect(v.hint).not.toContain('Secret')
  })
})
