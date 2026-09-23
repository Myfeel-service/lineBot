import { describe, expect, it } from 'vitest'
import { autoReplyActionToLineMessages } from './auto-reply-content'
import {
  LINE_CARD_BODY_DEFAULT,
  LINE_CARD_BUTTON_LABEL_URI_DEFAULT,
} from './line-card-copy'

/**
 * `C-230`：這支是**送出端與後台預覽共用的那一份**。
 * 釘住它等於同時釘住「客服預存／活動／自動回應送出去的東西」與「那三頁畫出來的東西」——
 * 兩邊只要有一邊自己拼一份，這裡的斷言就守不住了（`H-27` 的形狀）。
 */
describe('自動回應／客服預存／活動：動作 → 客人收到的訊息', () => {
  it('傳送文字＝一則純文字', () => {
    expect(autoReplyActionToLineMessages({ type: 'message', text: '今天公休', uri: '' }))
      .toEqual([{ type: 'text', text: '今天公休' }])
  })

  it('開啟網址＝一張按鈕卡，而且文案來自共用來源', () => {
    const [msg] = autoReplyActionToLineMessages({ type: 'uri', text: '', uri: 'https://example.com' })
    const tpl = (msg as any).template
    expect(tpl.text).toBe(LINE_CARD_BODY_DEFAULT)
    expect(tpl.actions[0].label).toBe(LINE_CARD_BUTTON_LABEL_URI_DEFAULT)
    expect(tpl.actions[0].uri).toBe('https://example.com')
  })

  it('⛔ 客人眼前不可以出現後台的詞', () => {
    const [msg] = autoReplyActionToLineMessages({ type: 'uri', text: '', uri: 'https://example.com' })
    const tpl = (msg as any).template
    for (const text of [String((msg as any).altText), tpl.text, tpl.actions[0].label]) {
      expect(text).not.toContain('模組')
      expect(text).not.toContain('網址')
    }
  })

  it('沒填完就沒有訊息（⛔ 不要送一則空的出去）', () => {
    expect(autoReplyActionToLineMessages({ type: 'message', text: '   ', uri: '' })).toEqual([])
    expect(autoReplyActionToLineMessages({ type: 'uri', text: '', uri: '' })).toEqual([])
  })

  it('⭐ module 回空陣列代表「內容在那個模組裡」，不是「沒有訊息」', () => {
    // 呼叫端要自己去把模組抓回來；把這個空陣列畫成「這則是空的」就是空歡迎模組那場災情
    expect(autoReplyActionToLineMessages({ type: 'module', text: '', uri: '' })).toEqual([])
  })

  it('文字照 LINE 單則 5000 字上限截斷（⛔ 不要讓整則被 LINE 退件）', () => {
    const [msg] = autoReplyActionToLineMessages({ type: 'message', text: '字'.repeat(5200), uri: '' })
    expect(String((msg as any).text)).toHaveLength(5000)
  })

  it('變數由呼叫端帶進來（送出端填客人名字，預覽端原樣顯示）', () => {
    const [msg] = autoReplyActionToLineMessages(
      { type: 'message', text: '{{name}} 你好', uri: '' },
      { renderText: raw => raw.replace('{{name}}', '小美') },
    )
    expect((msg as any).text).toBe('小美 你好')
  })
})
