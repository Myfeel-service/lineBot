import { describe, expect, it } from 'vitest'
import { appendBlockedKind, appendBlockedReason } from './line-reply-append'

const card = { type: 'flex', altText: '告訴我們你的生日 🎂', contents: {} }

describe('接在回覆後面的系統訊息（`C-57` 生日卡）', () => {
  it('⛔ 最後一則帶快速回覆＝不附（附了那排按鈕會消失，code review 第 1 條）', () => {
    const welcome = { type: 'text', text: '想了解什麼？', quickReply: { items: [{ type: 'action', action: { type: 'message', label: '價格', text: '價格' } }] } }
    expect(appendBlockedReason([welcome], [card])).toMatch(/快速回覆/)
  })
  it('快速回覆不在最後一則（中間那則）＝照附', () => {
    const qr = { type: 'text', text: 'A', quickReply: { items: [] } }
    expect(appendBlockedReason([qr, { type: 'text', text: 'B' }], [card])).toBe('')
  })
  it('一次最多 5 則：放不下不附', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ type: 'text', text: String(i) }))
    expect(appendBlockedReason(five, [card])).toMatch(/放不下/)
    expect(appendBlockedReason(five.slice(0, 4), [card])).toBe('')
  })
  it('沒有要附的＝空字串（不記 log）', () => {
    expect(appendBlockedReason([{ type: 'text', text: 'hi', quickReply: {} }], [])).toBe('')
  })
})

/** `C-468` 後續：後台要照他的歡迎訊息講是哪一種，所以分得出「快速回覆」與「放不下」 */
describe('appendBlockedKind（後台講是哪一種）', () => {
  const qr = { type: 'text', text: '想了解什麼？', quickReply: { items: [] } }
  it('跟 appendBlockedReason 同一套判斷', () => {
    expect(appendBlockedKind([qr], [card])).toBe('quickReply')
    expect(appendBlockedKind(Array.from({ length: 5 }, () => ({ type: 'text', text: 'x' })), [card])).toBe('full')
    expect(appendBlockedKind([{ type: 'text', text: 'hi' }], [card])).toBeNull()
    expect(appendBlockedKind([qr], [])).toBeNull()
  })
  it('兩種都中＝講快速回覆（先修那個才附得上）', () => {
    expect(appendBlockedKind([1, 2, 3, 4, qr], [card])).toBe('quickReply')
  })
})
