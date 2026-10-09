import { describe, expect, it } from 'vitest'
import { renderBroadcastVariablesDeep } from '~~/shared/preview-variables'
import { renderBroadcastMessagesForSend, renderWithAttributes } from './render-attributes'

/**
 * 推播的 {{變數}}：送出端與後台預覽要是**同一條規則**。
 *
 * 2026-10-10 審查抓到：預覽、發送前確認都說「每位客人看到的都是空白」，
 * 純文字／開網址推播卻是原字送出（客人收到「嗨 {{displayName}}」），試發也收到原字。
 */

const SAMPLES = [
  '嗨 {{displayName}}，今天公休',
  '{{ displayName }}您好',
  '訂單 {{orderNo}} 已出貨',
  '中文變數 {{姓名}} 送出端不換',
  '沒有變數',
  '{{displayName}}{{displayName}}',
]

describe('推播的變數：預覽跟送出同一條規則', () => {
  it('每一句預覽畫的就是送出去的', () => {
    for (const text of SAMPLES) {
      const sent = renderBroadcastMessagesForSend([{ type: 'text', text }])[0]!.text
      const preview = renderBroadcastVariablesDeep({ type: 'text', text }).value.text
      expect(preview, text).toBe(sent)
    }
  })

  it('送出端：英文變數換空白、中文變數原字、不就地改', () => {
    const input = [{ type: 'text', text: '嗨 {{displayName}}，{{姓名}}' }]
    const out = renderBroadcastMessagesForSend(input)
    expect(out[0]!.text).toBe('嗨 ，{{姓名}}')
    expect(input[0]!.text).toBe('嗨 {{displayName}}，{{姓名}}')
  })

  it('一般回覆照舊換成那位客人的值', () => {
    expect(renderWithAttributes('嗨 {{displayName}}', { displayName: '吉米' })).toBe('嗨 吉米')
  })
})
