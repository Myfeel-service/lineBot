import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

import { sessionClosingPreview } from './conversation-session'

const ts = (ms: number) => ({ toMillis: () => ms })
const T = 1_700_000_000_000

/**
 * 關閉會話時蓋在 session 文件上的「這場最後一則訊息」快照。
 *
 * 存在的理由：對話列表五個分頁的第二行都要顯示訊息摘要，但 conversations 上的
 * lastMessage 是**對話層級**的最新一則。已結束的那場如果直接借用，就會被標上後來
 * 新會話的訊息——列表說一套、點進去時間軸另一套。
 */
describe('sessionClosingPreview', () => {
  it('訊息時間對得上這場的最後活動 → 蓋快照', () => {
    expect(sessionClosingPreview(
      { lastMessage: '請問什麼時候出貨', lastDirection: 'incoming', lastMessageAt: ts(T) },
      ts(T),
    )).toEqual({ lastMessage: '請問什麼時候出貨', lastDirection: 'incoming' })
  })

  it('保留 outgoing 方向（列表要靠它決定掛不掛「我們：」）', () => {
    expect(sessionClosingPreview(
      { lastMessage: '已為您安排出貨', lastDirection: 'outgoing', lastMessageAt: ts(T) },
      ts(T + 5_000),
    )).toEqual({ lastMessage: '已為您安排出貨', lastDirection: 'outgoing' })
  })

  /**
   * 非文字訊息那條路徑（handler.ts）是先送存檔、後 await 開會話，存檔可能先落地。
   * 24h 過期關閉如果照抄，舊那場會被蓋上「新會話第一句」——正是要防的張冠李戴。
   */
  it('訊息比這場的最後活動晚太多（存檔搶跑）→ 不猜，回空物件', () => {
    expect(sessionClosingPreview(
      { lastMessage: '[圖片]', lastDirection: 'incoming', lastMessageAt: ts(T) },
      ts(T - 25 * 3600_000),
    )).toEqual({})
  })

  it('容差內的先後（正常情況兩個寫入幾乎同時）→ 照蓋', () => {
    expect(sessionClosingPreview(
      { lastMessage: '好的謝謝', lastDirection: 'incoming', lastMessageAt: ts(T + 3_000) },
      ts(T),
    )).toEqual({ lastMessage: '好的謝謝', lastDirection: 'incoming' })
  })

  it('沒有訊息內容 → 空物件（不要寫一個空字串上去）', () => {
    expect(sessionClosingPreview({ lastMessage: '', lastMessageAt: ts(T) }, ts(T))).toEqual({})
    expect(sessionClosingPreview(undefined, ts(T))).toEqual({})
  })

  it('任一邊沒有時間戳 → 分不清先後就不猜', () => {
    expect(sessionClosingPreview({ lastMessage: '嗨', lastMessageAt: null }, ts(T))).toEqual({})
    expect(sessionClosingPreview({ lastMessage: '嗨', lastMessageAt: ts(T) }, null)).toEqual({})
  })

  it('方向欄位是髒的／缺的 → 當成 incoming（不會誤掛「我們：」把客人的話說成我們講的）', () => {
    expect(sessionClosingPreview(
      { lastMessage: '嗨', lastDirection: 'weird', lastMessageAt: ts(T) },
      ts(T),
    )).toEqual({ lastMessage: '嗨', lastDirection: 'incoming' })
  })
})
