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

  /**
   * `C-241`③：深度上限原本是 12，而**物件算一層、陣列也算一層**——
   * 一層巢狀 Flex box 就吃掉 2，`messages[] → message → contents → bubble → body`
   * 開場又先吃掉一批，於是只走得進大約 4 層 box。
   * 真的長成這樣的卡片會被**數成 0 ＝ 該提醒的時候沒提醒**，比多提醒糟。
   */
  describe('巢狀很深的 Flex 版面（深度上限）', () => {
    /** 照 LINE Flex 的真實形狀包：`{ type: 'box', contents: [ … ] }` 一層一層往裡塞 */
    function nestBoxes(levels: number, innermost: unknown) {
      let node: unknown = innermost
      for (let i = 0; i < levels; i++) node = { type: 'box', layout: 'vertical', contents: [node] }
      return [{ type: 'flex', contents: { type: 'bubble', body: node } }]
    }

    it('⛔ 包了 8 層 box 的按鈕還是要數到（修之前這裡會是 0）', () => {
      expect(countTaggedUriButtons(nestBoxes(8, { type: 'button', action: taggedUri }))).toBe(1)
    })

    it('輪播裡再包 6 層也要數到', () => {
      const messages = [{
        type: 'flex',
        contents: {
          type: 'carousel',
          contents: [
            { type: 'bubble', body: nestBoxes(6, { type: 'button', action: taggedUri })[0] },
            { type: 'bubble', body: nestBoxes(6, { type: 'button', action: taggedUri })[0] },
          ],
        },
      }]
      expect(countTaggedUriButtons(messages)).toBe(2)
    })
  })

  /**
   * `C-241`⑥：`enabled` 要跟**執行時**同一套判斷（`handler.ts` 是 `if (!action?.tagging?.enabled)`）。
   * 嚴格 `=== true` 的話，這些值執行時會貼標、這裡卻數成 0 ＝ 真的受影響卻不提醒。
   */
  it('⛔ `enabled` 不是布林值時要跟執行時同一套判斷（真假值）', () => {
    for (const enabled of [1, 'true', 'yes', {}]) {
      expect(
        countTaggedUriButtons([{ actions: [{ ...taggedUri, tagging: { enabled, addTagIds: ['t1'] } }] }]),
        `enabled=${JSON.stringify(enabled)} 在執行時會貼標，這裡不可以數成 0`,
      ).toBe(1)
    }
    // 反面：執行時不會貼標的那些，這裡也要是 0
    for (const enabled of [0, '', null, undefined, false]) {
      expect(countTaggedUriButtons([{ actions: [{ ...taggedUri, tagging: { enabled, addTagIds: ['t1'] } }] }])).toBe(0)
    }
  })
})
