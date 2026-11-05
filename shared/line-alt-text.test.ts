import { describe, expect, it } from 'vitest'
import { altTextFallbackFor, flowMessageHasAltText } from './line-alt-text'

/**
 * `C-469`：「提醒文字」這一格該不該出現。
 * ⛔ LINE 沒有給每種訊息這一行字——純文字、圖片、影片那幾種給了格子也是假的（填了也送不出去）。
 */
describe('哪幾種模組有「提醒文字」可以設', () => {
  it('卡片類都有', () => {
    expect(flowMessageHasAltText({ type: 'richMessage' })).toBe(true)
    expect(flowMessageHasAltText({ type: 'carousel' })).toBe(true)
    expect(flowMessageHasAltText({ type: 'imageCarousel' })).toBe(true)
    expect(flowMessageHasAltText({ type: 'flexImageCarousel' })).toBe(true)
  })

  it('文字要看狀態：加了圖或加了按鈕才會送成一張卡，卡片才有這一行字', () => {
    expect(flowMessageHasAltText({ type: 'text' })).toBe(false)
    expect(flowMessageHasAltText({ type: 'text', imageUrl: 'https://example.com/a.jpg' })).toBe(true)
    expect(flowMessageHasAltText({ type: 'text', buttons: [{ type: 'uri', uri: 'https://example.com' }] })).toBe(true)
  })

  it('⛔ 空白的圖片網址、空的按鈕陣列不算（純文字送出去沒有這一行字）', () => {
    expect(flowMessageHasAltText({ type: 'text', imageUrl: '   ' })).toBe(false)
    expect(flowMessageHasAltText({ type: 'text', buttons: [] })).toBe(false)
  })

  it('LINE 沒給這一行字的那幾種：圖片、影片、快速回覆、用戶輸入卡片', () => {
    expect(flowMessageHasAltText({ type: 'image' })).toBe(false)
    expect(flowMessageHasAltText({ type: 'video' })).toBe(false)
    expect(flowMessageHasAltText({ type: 'quickReply' })).toBe(false)
    expect(flowMessageHasAltText({ type: 'userInput' })).toBe(false)
    expect(flowMessageHasAltText(null)).toBe(false)
  })
})

/**
 * 沒填時客人會看到的字：後台 placeholder 寫「沒填的話，客人會看到◯◯」讀的是這份，
 * 送出端補的也是這份——⛔ 改了值等於同時改掉兩邊，刻意的。
 */
describe('沒填時補的字', () => {
  it('每一種卡片各自的字（改這裡＝改客人手機上看到的字）', () => {
    expect(altTextFallbackFor('richMessage')).toBe('圖文訊息')
    expect(altTextFallbackFor('carousel')).toBe('輪播訊息')
    expect(altTextFallbackFor('imageCarousel')).toBe('圖片輪播')
    expect(altTextFallbackFor('flexImageCarousel')).toBe('卡片訊息')
    expect(altTextFallbackFor('text')).toBe('卡片訊息')
  })

  it('認不得的型別不會變成 undefined 送出去（LINE 不收沒有這行字的卡）', () => {
    expect(altTextFallbackFor('somethingNew')).toBe('訊息')
    expect(altTextFallbackFor(undefined)).toBe('訊息')
  })
})
