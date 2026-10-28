import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LINE_POSTBACK_DATA_MAX,
  encodeTriggerMessage,
  encodeTriggerModule,
  firstTaggedPostbackError,
  parseTriggerMessageData,
  taggedPostbackError,
  validateUnifiedAction,
} from './action-schema'

/**
 * `H-43`（2026-10-28）：開了貼標的「傳送文字」以前整包 encodeURIComponent，一個中文字變 9 個字元，
 * 掛一個標籤大約 20 個中文字就超過 LINE postback data 的 300 字，LINE 把整個請求退回。
 * 改成 JSON 原樣放；舊格式照樣讀得回來（已經送出去的舊按鈕還會被點）。
 */

/** 正式庫的標籤代號是 36 字的 uuid */
const TAG = '002555ba-3b6a-4908-a3ea-2703aa0b36c0'
const TAG2 = '02d616e1-898e-4994-bba5-0255a1262178'
/** 以前的寫法，原封不動抄過來當對照 */
const oldEncode = (text: string, tagIds: string[]) =>
  `triggerMessage=${encodeURIComponent(JSON.stringify({ text, tagIds }))}`

afterEach(() => vi.restoreAllMocks())

describe('新格式：中文一個字就是一個字', () => {
  it('JSON 原樣放（開頭是 {，不再是 %7B）', () => {
    expect(encodeTriggerMessage('我要參加', [TAG])).toBe(`triggerMessage={"text":"我要參加","tagIds":["${TAG}"]}`)
  })

  it('掛一個標籤、200 個中文字放得下而且一字不差讀回來（以前 20 幾個字就爆）', () => {
    const text = '我'.repeat(200)
    const data = encodeTriggerMessage(text, [TAG])
    expect(data.length).toBeLessThanOrEqual(LINE_POSTBACK_DATA_MAX)
    expect(parseTriggerMessageData(data)).toEqual({ text, tagIds: [TAG] })
    expect(oldEncode(text, [TAG]).length).toBeGreaterThan(LINE_POSTBACK_DATA_MAX * 5)
  })

  it('引號、換行、百分比、emoji 都讀得回來（⛔「100%」過 decodeURIComponent 會炸）', () => {
    const text = '打 8 折 100%！\n說 "我要" 就送 😍'
    expect(parseTriggerMessageData(encodeTriggerMessage(text, [TAG, TAG2]))).toEqual({ text, tagIds: [TAG, TAG2] })
  })
})

describe('舊格式照樣讀得回來（聊天紀錄裡、圖文選單上的舊按鈕還會被點）', () => {
  it('以前編出來的那串', () => {
    expect(parseTriggerMessageData(oldEncode('我要退貨', [TAG]))).toEqual({ text: '我要退貨', tagIds: [TAG] })
    expect(parseTriggerMessageData(oldEncode('打 8 折 100%', []))).toEqual({ text: '打 8 折 100%', tagIds: [] })
  })

  it('壞掉的資料不炸', () => {
    expect(parseTriggerMessageData('triggerMessage={壞掉')).toEqual({ text: '', tagIds: [] })
    expect(parseTriggerMessageData('triggerMessage=%E0%A4%A')).toEqual({ text: '', tagIds: [] })
  })
})

describe('真的放不下時（最後一道）：切短到放得下，不讓整則被退', () => {
  it('300 字＋兩個標籤 → 切到 300 以內、讀回來是原文的開頭、有留紀錄', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const text = '我'.repeat(300)
    const data = encodeTriggerMessage(text, [TAG, TAG2])
    expect(data.length).toBeLessThanOrEqual(LINE_POSTBACK_DATA_MAX)
    const back = parseTriggerMessageData(data).text
    expect(text.startsWith(back)).toBe(true)
    expect(back.length).toBeGreaterThan(150)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('放不進 LINE'))
  })

  it('換行與引號會跳脫成兩個字元，照樣切得進去；emoji 不切成一半', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const text = '"\n😍'.repeat(100)
    const data = encodeTriggerMessage(text, [TAG])
    expect(data.length).toBeLessThanOrEqual(LINE_POSTBACK_DATA_MAX)
    const back = parseTriggerMessageData(data).text
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(back)).toBe(false)
    expect(text.startsWith(back)).toBe(true)
  })
})

describe('存檔時擋：taggedPostbackError', () => {
  const msg = (text: string, tags = [TAG]) => ({ type: 'message', label: '我要', text, tagging: { enabled: true, addTagIds: tags } })

  it('放得下就沒事；沒開貼標的不管多長都不歸這支管', () => {
    expect(taggedPostbackError(msg('我'.repeat(200)))).toBe('')
    expect(taggedPostbackError({ type: 'message', text: '我'.repeat(300), tagging: { enabled: false, addTagIds: [TAG] } })).toBe('')
    expect(taggedPostbackError({ type: 'message', text: '我'.repeat(300), tagging: { enabled: true, addTagIds: [] } })).toBe('')
  })

  it('放不下：講得出最多約幾字、現在幾字、怎麼辦', () => {
    expect(taggedPostbackError(msg('我'.repeat(250)))).toMatch(/最多約 2\d\d 字（現在 250 字）.*縮短這句話，或少掛幾個標籤/)
  })

  it('標籤越多，可以寫的字越少（兩個標籤時 200 字就放不下）', () => {
    expect(taggedPostbackError(msg('我'.repeat(200), [TAG, TAG2]))).toMatch(/最多約 1\d\d 字/)
  })

  it('叫出模組：掛 6 個標籤還放得下、7 個放不下，講得出最多幾個', () => {
    const mod = (n: number) => ({ type: 'module', moduleId: TAG, tagging: { enabled: true, addTagIds: Array.from({ length: n }, (_, i) => `${TAG.slice(0, -2)}${String(i).padStart(2, '0')}`) } })
    expect(encodeTriggerModule(TAG, mod(6).tagging.addTagIds).length).toBeLessThanOrEqual(LINE_POSTBACK_DATA_MAX)
    expect(taggedPostbackError(mod(6))).toBe('')
    expect(taggedPostbackError(mod(7))).toMatch(/標籤太多.*現在 7 個，最多 6 個/)
  })

  it('圖文選單／圖文訊息的區塊走 validateUnifiedAction，同一條也會擋', () => {
    expect(validateUnifiedAction({
      slot: 'A', type: 'message', uri: '', text: '我'.repeat(250), moduleId: '',
      tagging: { enabled: true, addTagIds: [TAG] },
    })).toMatch(/最多約/)
  })
})

describe('firstTaggedPostbackError：按鈕藏在哪一層都找得到', () => {
  it('快速回覆、卡片訊息的按鈕、圖片動作', () => {
    const tooLong = { type: 'message', label: '我要參加', text: '我'.repeat(250), tagging: { enabled: true, addTagIds: [TAG] } }
    expect(firstTaggedPostbackError([{ type: 'quickReply', quickReplies: [{ action: tooLong }] }])).toMatch(/^按鈕「我要參加」：/)
    expect(firstTaggedPostbackError([{ type: 'flexImageCarousel', columns: [{ actions: [tooLong] }] }])).toMatch(/最多約/)
    expect(firstTaggedPostbackError([{ type: 'flexImageCarousel', columns: [{ action: { ...tooLong, label: '' } }] }])).toMatch(/^開了貼標/)
  })

  it('全部放得下就回空字串', () => {
    const ok = { type: 'message', label: '好', text: '我要參加', tagging: { enabled: true, addTagIds: [TAG] } }
    expect(firstTaggedPostbackError([{ type: 'text', text: '嗨', buttons: [ok] }])).toBe('')
  })
})
