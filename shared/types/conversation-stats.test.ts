import { describe, expect, it } from 'vitest'
import { isPreInboundFollowSession } from './conversation-stats'

describe('isPreInboundFollowSession(首接統計排除條件)', () => {
  it('活動/加好友出生且客人未開口 → 排除', () => {
    expect(isPreInboundFollowSession({ origin: 'follow', hasInbound: false })).toBe(true)
    expect(isPreInboundFollowSession({ origin: 'follow' })).toBe(true)
  })
  it('客人開口後 → 正常計入', () => {
    expect(isPreInboundFollowSession({ origin: 'follow', hasInbound: true })).toBe(false)
  })
  it('客人來訊出生的 session → 正常計入', () => {
    expect(isPreInboundFollowSession({ origin: 'message', hasInbound: true })).toBe(false)
  })
  it('舊資料(沒有 origin 欄位)→ 不受影響照舊計入', () => {
    expect(isPreInboundFollowSession({})).toBe(false)
    expect(isPreInboundFollowSession(undefined)).toBe(false)
  })
})
