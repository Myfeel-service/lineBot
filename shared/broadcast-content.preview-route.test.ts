import { describe, expect, it } from 'vitest'
import {
  broadcastPreviewRoute,
  broadcastSentWithBlankVariables,
  unifiedActionToLineMessages,
} from './broadcast-content'
import { normalizeUnifiedAction } from './action-schema'

/**
 * `D-48`：客服對話頁點「已發送群發」滑出的抽屜，跟推播頁右欄吃同一支預覽（AdminBroadcastPreview）。
 * 這兩支判斷是那支預覽「畫哪一份、名字畫成什麼」的唯一來源——兩頁各判各的就會再漂開（`H-27`）。
 */

const textMessages = [{ type: 'text', text: '{{displayName}} 您好！雙11 早鳥優惠開跑' }]
const moduleMessages = unifiedActionToLineMessages(normalizeUnifiedAction({ type: 'module', moduleId: 'm1' }, 'A') as any)

describe('broadcastPreviewRoute(回頭看一則推播要畫哪一份)', () => {
  it('有留存「當時真的送出去」的那一份 → 一律畫那一份（模組之後可能被改過）', () => {
    expect(broadcastPreviewRoute({ messages: moduleMessages, sentContent: { messages: [{ type: 'text', text: '當時的' }] } })).toBe('sent')
    expect(broadcastPreviewRoute({ messages: textMessages, sentContent: { messages: [{ type: 'text', text: '當時的' }] } })).toBe('sent')
  })

  it('沒有留存、是觸發模組型 → 把模組抓回來畫（判斷用送出端同一支）', () => {
    expect(broadcastPreviewRoute({ messages: moduleMessages, sentContent: null })).toBe('module')
    // 留存是空陣列＝沒有留存
    expect(broadcastPreviewRoute({ messages: moduleMessages, sentContent: { messages: [] } })).toBe('module')
  })

  it('純文字 → 照訊息本身畫', () => {
    expect(broadcastPreviewRoute({ messages: textMessages })).toBe('text')
    expect(broadcastPreviewRoute({ messages: undefined as any })).toBe('text')
  })
})

describe('broadcastSentWithBlankVariables(名字那一格客人當時收到的是不是空白)', () => {
  it('2026-10-15 以前送完的（沒有 sendMode）＝空白', () => {
    expect(broadcastSentWithBlankVariables({ status: 'completed', sentCount: 846 })).toBe(true)
  })

  it('有 sendMode（之後送的，一人一則或沒用變數）＝不是空白', () => {
    expect(broadcastSentWithBlankVariables({ status: 'completed', sentCount: 846, sendMode: 'perRecipient' })).toBe(false)
    expect(broadcastSentWithBlankVariables({ status: 'completed', sentCount: 846, sendMode: 'multicast' })).toBe(false)
  })

  it('失敗／發送中要真的送到過人才算（沒送出去就沒有人收到空白）', () => {
    expect(broadcastSentWithBlankVariables({ status: 'failed', sentCount: 3 })).toBe(true)
    expect(broadcastSentWithBlankVariables({ status: 'failed', sentCount: 0 })).toBe(false)
    expect(broadcastSentWithBlankVariables({ status: 'processing', sentCount: 1 })).toBe(true)
  })

  it('草稿／排程中／取消的沒有送給任何人 → 不是空白（照範例名字畫）', () => {
    expect(broadcastSentWithBlankVariables({ status: 'draft' })).toBe(false)
    expect(broadcastSentWithBlankVariables({ status: 'scheduled' })).toBe(false)
    expect(broadcastSentWithBlankVariables({ status: 'cancelled', sentCount: 0 })).toBe(false)
  })
})
