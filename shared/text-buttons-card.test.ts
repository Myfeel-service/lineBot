import { describe, expect, it } from 'vitest'
import { LINE_TEXT_MESSAGE_MAX } from './line-text-limits'
import { buildTextButtonsCard, parseTextButtonsCard } from './text-buttons-card'

const URI = { type: 'uri', label: '前往完成任務', uri: 'https://example.com/task' }
const POSTBACK = { type: 'postback', label: '看規則', data: 'triggerModule=m1' }

describe('組出來的卡', () => {
  const card = buildTextButtonsCard({ text: '嗨\n第二行', altText: '嗨', actions: [URI, POSTBACK] }) as any

  it('是一張卡片（Flex），不是按鈕範本（按鈕範本只收 160 字）', () => {
    expect(card.type).toBe('flex')
    expect(card.template).toBeUndefined()
    expect(card.contents.type).toBe('bubble')
  })

  it('文字原樣放進去、會換行（wrap），按鈕照順序放在底下', () => {
    expect(card.contents.body.contents).toEqual([{ type: 'text', text: '嗨\n第二行', wrap: true }])
    expect(card.contents.footer.contents.map((b: any) => b.action)).toEqual([URI, POSTBACK])
    expect(card.altText).toBe('嗨')
  })

  it('沒有按鈕就不放 footer（LINE 不收空的 box）', () => {
    const bare = buildTextButtonsCard({ text: '嗨', altText: '嗨', actions: [] }) as any
    expect(bare.contents.footer).toBeUndefined()
  })
})

/**
 * LINE 只限整張卡 30 KB（量 UTF-8 位元組）。2026-10-28 用 LINE 驗證端點實測：
 * 5000 中文字＋4 顆 1000 字網址按鈕＝19.3 KB 收、12000 字 39.9 KB 退。
 * 這裡釘住「最壞的情況也在 30 KB 以內」——有人哪天把上限調大、或往卡片裡加東西，這條會先紅。
 */
describe('最壞的情況也塞得進 LINE 的 30 KB', () => {
  const longUri = (i: number) => `https://lineminime.com/api/r/${'A'.repeat(1000 - 30)}${i}`
  const maxActions = [0, 1, 2, 3].map(i => ({ type: 'uri', label: '前往完成任務前往完成任務前往完成任務前往', uri: longUri(i) }))
  const bytesOf = (text: string) => {
    const card = buildTextButtonsCard({ text, altText: text.slice(0, 400), actions: maxActions }) as any
    return Buffer.byteLength(JSON.stringify(card.contents), 'utf8')
  }

  it('5000 個中文字＋4 顆最長網址按鈕 < 30 KB', () => {
    expect(bytesOf('奇'.repeat(LINE_TEXT_MESSAGE_MAX))).toBeLessThan(30 * 1024)
  })

  it('全是 emoji 的 5000 格也 < 30 KB', () => {
    expect(bytesOf('😍'.repeat(LINE_TEXT_MESSAGE_MAX / 2))).toBeLessThan(30 * 1024)
  })
})

describe('認得回來（對話頁用它畫回「文字＋按鈕」）', () => {
  it('組出來的卡認得回來，文字與按鈕一字不差', () => {
    const card = buildTextButtonsCard({ text: '長長的活動規則', altText: '長長', actions: [URI, POSTBACK] })
    expect(parseTextButtonsCard(card)).toEqual({ text: '長長的活動規則', actions: [URI, POSTBACK] })
  })

  it('別種卡片不可以被認成這種', () => {
    // 輪播（carousel）
    expect(parseTextButtonsCard({ type: 'flex', altText: 'x', contents: { type: 'carousel', contents: [] } })).toBeNull()
    // 有大圖（hero）的卡
    expect(parseTextButtonsCard({ type: 'flex', altText: 'x', contents: {
      type: 'bubble',
      hero: { type: 'image', url: 'https://a/b.png' },
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '標題' }] },
    } })).toBeNull()
    // 圖文訊息走 Flex 的那種：body 裡是圖
    expect(parseTextButtonsCard({ type: 'flex', altText: 'x', contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'image', url: 'https://a/b.png' }] },
    } })).toBeNull()
    // 兩段文字（標題＋內文）
    expect(parseTextButtonsCard({ type: 'flex', altText: 'x', contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    } })).toBeNull()
    // footer 裡混了不是按鈕的東西
    expect(parseTextButtonsCard({ type: 'flex', altText: 'x', contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'a' }] },
      footer: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '不是按鈕' }] },
    } })).toBeNull()
  })

  it('舊的按鈕範本、純文字、空值都回 null', () => {
    expect(parseTextButtonsCard({ type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [URI] } })).toBeNull()
    expect(parseTextButtonsCard({ type: 'text', text: 'hi' })).toBeNull()
    expect(parseTextButtonsCard(null)).toBeNull()
    expect(parseTextButtonsCard(undefined)).toBeNull()
  })
})
