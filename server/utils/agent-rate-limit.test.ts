/**
 * 小幫手節流的行為（`C-31` Phase 2 地基）。
 *
 * 釘住兩件容易寫反的事：
 * 1. 節流是**按人按工作區**分開算的——A 家的人猛按不該讓 B 家的人問不了話。
 * 2. 視窗會滑動：上限不是「這輩子 12 次」，過了一分鐘要自己恢復。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { AGENT_CHAT_MAX, AGENT_CHAT_WINDOW_MS, hitAgentRateLimit, resetAgentRateLimit } from './agent-rate-limit'

beforeEach(resetAgentRateLimit)

describe('小幫手節流', () => {
  it('一分鐘內超過上限才擋，並說出還要等幾秒', () => {
    const now = 1_000_000
    for (let i = 0; i < AGENT_CHAT_MAX; i++)
      expect(hitAgentRateLimit('w1:u1', { now }).limited, `第 ${i + 1} 次不該被擋`).toBe(false)

    const over = hitAgentRateLimit('w1:u1', { now })
    expect(over.limited).toBe(true)
    // 還要等多久＝最舊那筆滾出視窗的時間；⛔不要回 0（那等於叫人馬上重試，只會再被擋一次）
    expect(over.retryAfterMs).toBe(AGENT_CHAT_WINDOW_MS)
  })

  it('⛔ 不同人、不同工作區各算各的：別人猛按不會害我問不了', () => {
    const now = 2_000_000
    for (let i = 0; i <= AGENT_CHAT_MAX; i++) hitAgentRateLimit('w1:u1', { now })

    expect(hitAgentRateLimit('w1:u1', { now }).limited).toBe(true)
    expect(hitAgentRateLimit('w1:u2', { now }).limited).toBe(false) // 同工作區的另一個人
    expect(hitAgentRateLimit('w2:u1', { now }).limited).toBe(false) // 同一個人的另一個工作區
  })

  it('視窗滑過去就恢復：被擋一次不是被鎖住', () => {
    const now = 3_000_000
    for (let i = 0; i <= AGENT_CHAT_MAX; i++) hitAgentRateLimit('w1:u1', { now })
    expect(hitAgentRateLimit('w1:u1', { now }).limited).toBe(true)

    expect(hitAgentRateLimit('w1:u1', { now: now + AGENT_CHAT_WINDOW_MS + 1 }).limited).toBe(false)
  })
})
