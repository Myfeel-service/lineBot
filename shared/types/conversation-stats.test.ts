import { describe, expect, it } from 'vitest'
import { isPreInboundSession } from './conversation-stats'

describe('isPreInboundSession(客人還沒真的開口 → 不進待處理、不進首接統計)', () => {
  it('活動/加好友出生且客人未開口 → 排除', () => {
    expect(isPreInboundSession({ origin: 'follow', hasInbound: false })).toBe(true)
    expect(isPreInboundSession({ origin: 'follow' })).toBe(true)
  })
  it('客人開口後 → 正常計入', () => {
    expect(isPreInboundSession({ origin: 'follow', hasInbound: true })).toBe(false)
  })
  it('客人來訊出生的 session → 正常計入', () => {
    expect(isPreInboundSession({ origin: 'message', hasInbound: true })).toBe(false)
  })
  it('舊資料(沒有 origin 欄位)→ 不受影響照舊計入', () => {
    expect(isPreInboundSession({})).toBe(false)
    expect(isPreInboundSession(undefined)).toBe(false)
  })

  /** `D-4`：近 30 天 MYFEEL 10 場只傳貼圖，9 場被記成「沒人回」、最久在待處理掛 41 小時 */
  it('只傳貼圖出生、客人還沒講話 → 排除（不算沒人回、不佔待處理）', () => {
    expect(isPreInboundSession({ origin: 'sticker', hasInbound: false })).toBe(true)
  })
  it('只傳貼圖出生、之後有講話 → 照常計入', () => {
    expect(isPreInboundSession({ origin: 'sticker', hasInbound: true })).toBe(false)
  })
  it('⛔ 客人先講過話、後來才傳貼圖的場（origin=message）→ 照常計入，貼圖不能把他講過的話抹掉', () => {
    expect(isPreInboundSession({ origin: 'message', hasInbound: true })).toBe(false)
  })
})
