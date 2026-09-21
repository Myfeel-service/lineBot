import { describe, expect, it } from 'vitest'
import {
  BROADCAST_AUDIENCE_HANDOFF_TTL_MS,
  handoffNoticeText,
  isFreshHandoff,
  parseHandoff,
} from './broadcast-audience-handoff'

describe('parseHandoff', () => {
  it('讀得回正常的交接單', () => {
    const raw = JSON.stringify({ userIds: ['U1', 'U2'], dropped: 1, ts: 123 })
    expect(parseHandoff(raw)).toEqual({ userIds: ['U1', 'U2'], dropped: 1, ts: 123 })
  })

  it('⛔ 壞掉的內容一律當成「沒有」，不可以炸掉整個推播頁', () => {
    expect(parseHandoff(null)).toBeNull()
    expect(parseHandoff('')).toBeNull()
    expect(parseHandoff('{ 這不是 json')).toBeNull()
    expect(parseHandoff('{}')).toBeNull()
    expect(parseHandoff(JSON.stringify({ userIds: [] }))).toBeNull()
    expect(parseHandoff(JSON.stringify({ userIds: 'U1' }))).toBeNull()
  })

  it('去空白、丟掉空字串', () => {
    const raw = JSON.stringify({ userIds: [' U1 ', '', null, 'U2'], ts: 1 })
    expect(parseHandoff(raw)?.userIds).toEqual(['U1', 'U2'])
  })

  it('沒帶 dropped 就當 0（舊格式也讀得回來）', () => {
    expect(parseHandoff(JSON.stringify({ userIds: ['U1'], ts: 1 }))?.dropped).toBe(0)
  })
})

describe('isFreshHandoff', () => {
  const now = 1_000_000_000

  it('剛建立的算數', () => {
    expect(isFreshHandoff({ userIds: ['U1'], dropped: 0, ts: now }, now)).toBe(true)
  })

  it('⛔ 過期的一律不套用（隔天回來還套昨天選的名單是最難察覺的錯）', () => {
    const stale = { userIds: ['U1'], dropped: 0, ts: now - BROADCAST_AUDIENCE_HANDOFF_TTL_MS - 1 }
    expect(isFreshHandoff(stale, now)).toBe(false)
  })

  it('剛好在期限上還算數', () => {
    const edge = { userIds: ['U1'], dropped: 0, ts: now - BROADCAST_AUDIENCE_HANDOFF_TTL_MS }
    expect(isFreshHandoff(edge, now)).toBe(true)
  })

  it('空名單與 null 都不算', () => {
    expect(isFreshHandoff(null, now)).toBe(false)
    expect(isFreshHandoff({ userIds: [], dropped: 0, ts: now }, now)).toBe(false)
  })
})

describe('handoffNoticeText', () => {
  it('全部帶過來就只講數字', () => {
    const text = handoffNoticeText({ userIds: ['U1', 'U2'], dropped: 0, ts: 0 })
    expect(text).toBe('已帶入 2 位好友當發送對象。')
  })

  it('⛔ 有人被丟掉就一定要講，還要講怎麼補', () => {
    const text = handoffNoticeText({ userIds: ['U1'], dropped: 3, ts: 0 })
    expect(text).toContain('1 位')
    expect(text).toContain('3 位沒有帶過來')
    expect(text).toContain('重新勾選')
  })
})
