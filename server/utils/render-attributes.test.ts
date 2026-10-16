import { describe, expect, it } from 'vitest'
import { renderBroadcastVariablesDeep, renderPreviewVariablesDeep } from '~~/shared/preview-variables'
import { attributeContextForUser, renderBroadcastMessagesForSend, renderWithAttributes } from './render-attributes'

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

  it('還沒送的預覽（範例值）換的跟送出端是同一批變數：中文變數名兩邊都原字（`C-321` 審查第 3 條）', () => {
    for (const text of SAMPLES) {
      const sentKeys = text !== renderWithAttributes(text, {}) ? 'changed' : 'same'
      const previewKeys = renderPreviewVariablesDeep({ type: 'text', text }).keys.length ? 'changed' : 'same'
      expect(previewKeys, text).toBe(sentKeys)
    }
    expect(renderPreviewVariablesDeep({ type: 'text', text: '{{姓名}} 你好' }).value.text).toBe('{{姓名}} 你好')
  })
})

/**
 * `D-118` A（2026-10-15）：用了變數的推播一人一則送，每一位帶自己的資料。
 */
describe('推播一人一則：每一位換上自己的資料', () => {
  it('帶了 attributes 就換成那位客人的值（不帶＝空白，跟群發一樣）', () => {
    const input = [{ type: 'text', text: '{{displayName}} 快快快！今晚結束' }]
    expect(renderBroadcastMessagesForSend(input, { displayName: '王小明' })[0]!.text).toBe('王小明 快快快！今晚結束')
    expect(renderBroadcastMessagesForSend(input)[0]!.text).toBe(' 快快快！今晚結束')
  })

  /** ⛔ 名字換進去之後變長，超過 LINE 的上限會整則退回——那一位就收不到 */
  it('按鈕範本：名字換進去後照 LINE 上限再切一次（文字 160、標籤 20、替代文字 400）', () => {
    const longName = '一二三四五六七八九十一二三四五六七八九十'
    const out = renderBroadcastMessagesForSend([{
      type: 'template',
      altText: `{{displayName}}${'字'.repeat(395)}`,
      template: {
        type: 'buttons',
        text: `{{displayName}}${'字'.repeat(150)}`,
        actions: [{ type: 'uri', label: '{{displayName}}看', uri: 'https://x.tw' }],
      },
    }], { displayName: longName })[0] as any
    expect(out.template.text.length).toBe(160)
    expect(out.template.actions[0].label.length).toBe(20)
    expect(out.altText.length).toBe(400)
  })
})

describe('attributeContextForUser：一位客人拿來換變數的資料', () => {
  const uid = 'U4af4980629b8c1d2e3f4a5b6c7d8e9f0'

  it('名字＋收集到的欄位', () => {
    expect(attributeContextForUser({ displayName: '吉米', lineUserId: uid, attributes: { city: '台北' } }))
      .toEqual({ city: '台北', displayName: '吉米' })
  })

  /** ⛔ 抓不到 LINE 個人資料時名字欄被塞了 userId：客人會收到「U4af…您好」 */
  it('名字是 LINE 代號的不算名字', () => {
    expect(attributeContextForUser({ displayName: uid, lineUserId: uid })).toEqual({})
    expect(attributeContextForUser({ displayName: uid })).toEqual({})
  })

  it('沒有資料、名字空白都不會炸', () => {
    expect(attributeContextForUser(null)).toEqual({})
    expect(attributeContextForUser({ displayName: '  ' })).toEqual({})
  })
})
