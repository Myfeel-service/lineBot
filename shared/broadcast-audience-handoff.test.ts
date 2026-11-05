import { describe, expect, it } from 'vitest'
import {
  BROADCAST_AUDIENCE_HANDOFF_TTL_MS,
  handoffNoticeText,
  isFreshHandoff,
  parseHandoff,
  recipientNamesLine,
} from './broadcast-audience-handoff'

describe('parseHandoff', () => {
  it('讀得回正常的交接單（舊格式沒有名字＝空的）', () => {
    const raw = JSON.stringify({ userIds: ['U1', 'U2'], dropped: 1, ts: 123 })
    expect(parseHandoff(raw)).toEqual({ userIds: ['U1', 'U2'], dropped: 1, ts: 123, names: {} })
  })

  it('`C-467`：名字跟著帶過來；只留名單裡的人、壞資料丟掉', () => {
    const raw = JSON.stringify({ userIds: ['U1', 'U2'], ts: 1, names: { U1: ' 王小美 ', U2: 42, U9: '不在名單裡' } })
    expect(parseHandoff(raw)?.names).toEqual({ U1: '王小美' })
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

/** `C-467`（2026-11-05 老闆「uid 對使用者是沒有意義的」）：收件人講成名字 */
describe('recipientNamesLine', () => {
  it('列名字；⛔ 不拿編號頂替', () => {
    expect(recipientNamesLine(['U1', 'U2'], { U1: '王小美', U2: '陳大文' })).toBe('王小美、陳大文')
  })
  it('有幾位查不到名字要講出來', () => {
    expect(recipientNamesLine(['U1', 'U2', 'U3'], { U1: '王小美' })).toBe('王小美；另外 2 位查不到名字')
  })
  it('太多只列前幾個＋等 N 位', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `U${i}`)
    const names = Object.fromEntries(ids.map((id, i) => [id, `客人${i}`]))
    expect(recipientNamesLine(ids, names, 3)).toBe('客人0、客人1、客人2…等 12 位')
  })
  it('一個名字都沒有＝空字串（畫面照舊顯示編號那一格：那是別人交給他的名單）', () => {
    expect(recipientNamesLine(['U1'], {})).toBe('')
  })
})
