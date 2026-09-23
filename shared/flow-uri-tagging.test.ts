import { describe, expect, it } from 'vitest'
import { countTaggedUriButtons } from './flow-uri-tagging'

/**
 * `C-238`：推播編輯器要靠這個數字才講得出「這顆按鈕的貼標在推播裡不會生效」。
 *
 * ⛔ 這一組真正在守的是**別數成 0**：數成 0 ＝該提醒的時候沒提醒，
 *    而那正是這件事最糟的形狀（開關是開的、標籤就是沒貼、畫面上看不出來）。
 */
describe('countTaggedUriButtons', () => {
  const taggedUri = { type: 'uri', uri: 'https://a.com', tagging: { enabled: true, addTagIds: ['t1'] } }

  it('最單純的一顆', () => {
    expect(countTaggedUriButtons([{ type: 'text', actions: [taggedUri] }])).toBe(1)
  })

  it('⛔ 藏在輪播每一張卡裡的也要數到（只看第一層會數成 0）', () => {
    const messages = [{
      type: 'carousel',
      columns: [
        { actions: [taggedUri, { type: 'uri', uri: 'https://b.com' }] },
        { actions: [taggedUri] },
      ],
    }]
    expect(countTaggedUriButtons(messages)).toBe(2)
  })

  it('⛔ 藏在圖文訊息格子與快速回覆裡的也要數到', () => {
    const messages = [
      { type: 'richMessage', areas: [{ action: taggedUri }] },
      { type: 'quickReply', items: [{ action: taggedUri }] },
    ]
    expect(countTaggedUriButtons(messages)).toBe(2)
  })

  it('沒開貼標的網址按鈕不算', () => {
    expect(countTaggedUriButtons([{ actions: [{ type: 'uri', uri: 'https://a.com' }] }])).toBe(0)
    expect(countTaggedUriButtons([{ actions: [{ ...taggedUri, tagging: { enabled: false, addTagIds: ['t1'] } }] }])).toBe(0)
  })

  it('開了貼標但一顆標籤都沒選的不算（那本來就不會貼任何東西）', () => {
    expect(countTaggedUriButtons([{ actions: [{ ...taggedUri, tagging: { enabled: true, addTagIds: [] } }] }])).toBe(0)
    expect(countTaggedUriButtons([{ actions: [{ ...taggedUri, tagging: { enabled: true, addTagIds: ['  '] } }] }])).toBe(0)
  })

  it('⛔ 其他型別開了貼標不算——模組／文字按鈕在推播裡是**有效**的，不可以一起警告', () => {
    const messages = [
      { actions: [{ type: 'module', moduleId: 'm1', tagging: { enabled: true, addTagIds: ['t1'] } }] },
      { actions: [{ type: 'message', text: '嗨', tagging: { enabled: true, addTagIds: ['t1'] } }] },
    ]
    expect(countTaggedUriButtons(messages)).toBe(0)
  })

  it('壞掉或缺漏的輸入不會炸', () => {
    expect(countTaggedUriButtons(null)).toBe(0)
    expect(countTaggedUriButtons(undefined)).toBe(0)
    expect(countTaggedUriButtons('不是東西')).toBe(0)
    expect(countTaggedUriButtons([{ actions: null }])).toBe(0)
    expect(countTaggedUriButtons([{ actions: [{ type: 'uri', tagging: 'nope' }] }])).toBe(0)
  })

  it('自我參照的資料不會無限迴圈', () => {
    const loop: Record<string, unknown> = { type: 'text' }
    loop.self = loop
    expect(() => countTaggedUriButtons([loop])).not.toThrow()
  })
})
