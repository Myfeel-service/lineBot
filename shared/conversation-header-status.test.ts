import { describe, expect, it } from 'vitest'
import { sessionHeaderStatus } from './conversation-header-status'
import { isPreInboundSession, preInboundKind } from './types/conversation-stats'

// `D-4` 交過來的：頂部狀態跟「待處理」分頁要是同一條規則
describe('sessionHeaderStatus(對話頁頂部那顆狀態)', () => {
  it('⛔ 只傳貼圖的 open 場不寫「待處理」（它不在待處理分頁）：寫「只傳了貼圖」、灰色', () => {
    const s = sessionHeaderStatus({ status: 'open', statusLabel: '待處理', preInbound: 'sticker' })
    expect(s.label).toBe('只傳了貼圖')
    expect(s.muted).toBe(true)
    expect(s.type).not.toBe('warning')
    expect(s.hint).toMatch(/不在「待處理」裡/)
  })

  it('⛔ 加好友還沒開口的 open 場：寫「還沒開口」、灰色', () => {
    const s = sessionHeaderStatus({ status: 'open', statusLabel: '待處理', preInbound: 'follow' })
    expect(s.label).toBe('還沒開口')
    expect(s.muted).toBe(true)
  })

  it('客人開口過的 open 場照舊是「待處理」、橘色', () => {
    expect(sessionHeaderStatus({ status: 'open', statusLabel: '待處理' })).toMatchObject({ label: '待處理', type: 'warning', muted: false })
    expect(sessionHeaderStatus({ status: 'open', statusLabel: '待處理', preInbound: '' })).toMatchObject({ label: '待處理', type: 'warning' })
  })

  it('不是 open 的場就算帶了 preInbound 也照狀態講（機器人處理中分頁本來就收它）', () => {
    expect(sessionHeaderStatus({ status: 'bot_handling', statusLabel: '機器人處理中', preInbound: 'follow' }))
      .toMatchObject({ label: '機器人處理中', muted: true })
  })

  it('其他狀態的顏色照急迫度：待真人紅、真人處理中藍、機器人灰', () => {
    expect(sessionHeaderStatus({ status: 'pending_human' }).type).toBe('danger')
    expect(sessionHeaderStatus({ status: 'human_handling' })).toMatchObject({ type: 'info', muted: false })
    expect(sessionHeaderStatus({ status: 'bot_handling' })).toMatchObject({ type: 'info', muted: true })
  })

  it('`D-31`：真人處理中的說明講對的——不回客人打的字，客人自己按的查詢按鈕照樣會回', () => {
    const hint = sessionHeaderStatus({ status: 'human_handling' }).hint
    expect(hint).toMatch(/不再回客人打的字/)
    expect(hint).toMatch(/查詢按鈕照樣會回/)
    expect(hint).not.toMatch(/暫停自動回覆|不會再自動回覆/)
  })
})

describe('preInboundKind(跟待處理佇列同一條規則)', () => {
  it('是哪一種：只傳貼圖／加好友沒講話；開口過或舊資料＝空', () => {
    expect(preInboundKind({ origin: 'sticker', hasInbound: false })).toBe('sticker')
    expect(preInboundKind({ origin: 'follow' })).toBe('follow')
    expect(preInboundKind({ origin: 'sticker', hasInbound: true })).toBe('')
    expect(preInboundKind({ origin: 'message', hasInbound: true })).toBe('')
    expect(preInboundKind({})).toBe('')
    expect(preInboundKind(undefined)).toBe('')
  })

  it('有值 ⇔ isPreInboundSession（⛔ 不可以各判各的）', () => {
    const cases = [
      { origin: 'sticker', hasInbound: false }, { origin: 'follow' }, { origin: 'sticker', hasInbound: true },
      { origin: 'message' }, {}, { origin: 'follow', hasInbound: true },
    ]
    for (const c of cases) expect(preInboundKind(c) !== '').toBe(isPreInboundSession(c))
  })
})
