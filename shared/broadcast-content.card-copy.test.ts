import { describe, expect, it } from 'vitest'
import {
  parseLineMessagesToUnifiedAction,
  unifiedActionToLineMessages,
} from './broadcast-content'
import { normalizeUnifiedAction } from './action-schema'
import {
  LEGACY_AUTO_WRITTEN_CARD_BODIES,
  LINE_CARD_BODY_DEFAULT,
  LINE_CARD_BUTTON_LABEL_MODULE_DEFAULT,
  LINE_CARD_BUTTON_LABEL_URI_DEFAULT,
} from './line-card-copy'

/**
 * `C-228`：這幾條是**客人真的會收到的字**，不是內部字串。
 * 之所以要釘住，是因為它們原本沒有任何測試，而「請點擊下方按鈕以進入機器人模組。」
 * 就這樣在客人手機上活了很久也沒人發現（`D-87`）。
 */

function cardOf(messages: Record<string, unknown>[]) {
  const tpl = messages[0]?.template as { text?: string; actions?: Record<string, unknown>[] }
  return {
    altText: String(messages[0]?.altText ?? ''),
    body: String(tpl?.text ?? ''),
    label: String(tpl?.actions?.[0]?.label ?? ''),
  }
}

describe('推播卡片文案：客人眼前不可以出現後台的詞', () => {
  it('⛔ 網址卡與模組卡都不可以出現「模組」「網址」這些後台自用的詞', () => {
    const uri = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction({ type: 'uri', uri: 'https://example.com' }, 'A'),
    ))
    const mod = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction({ type: 'module', moduleId: 'm1' }, 'A'),
    ))

    for (const card of [uri, mod]) {
      for (const text of [card.altText, card.body, card.label]) {
        expect(text).not.toContain('模組')
        expect(text).not.toContain('網址')
      }
    }
  })

  it('沒填就用預設；網址與模組的本文是同一句（對客人是同一件事）', () => {
    const uri = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction({ type: 'uri', uri: 'https://example.com' }, 'A'),
    ))
    const mod = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction({ type: 'module', moduleId: 'm1' }, 'A'),
    ))

    expect(uri.body).toBe(LINE_CARD_BODY_DEFAULT)
    expect(mod.body).toBe(LINE_CARD_BODY_DEFAULT)
    expect(uri.label).toBe(LINE_CARD_BUTTON_LABEL_URI_DEFAULT)
    expect(mod.label).toBe(LINE_CARD_BUTTON_LABEL_MODULE_DEFAULT)
  })

  it('店家寫了就用店家的', () => {
    const card = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction(
        { type: 'uri', uri: 'https://example.com', cardText: '中秋禮盒開賣了', buttonLabel: '去逛逛' },
        'A',
      ),
    ))
    expect(card.body).toBe('中秋禮盒開賣了')
    expect(card.label).toBe('去逛逛')
  })

  it('⛔ 只打空白等於沒寫，不可以送出空字串（LINE 會整則退件）', () => {
    const card = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction(
        { type: 'uri', uri: 'https://example.com', cardText: '   ', buttonLabel: '  ' },
        'A',
      ),
    ))
    expect(card.body).toBe(LINE_CARD_BODY_DEFAULT)
    expect(card.label).toBe(LINE_CARD_BUTTON_LABEL_URI_DEFAULT)
  })

  it('本文照按鈕範本的 160 字上限截斷（與預覽切在同一格）', () => {
    const card = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction(
        { type: 'uri', uri: 'https://example.com', cardText: '字'.repeat(200) },
        'A',
      ),
    ))
    expect(card.body).toHaveLength(160)
  })

  it('按鈕文字照 LINE 的 20 字上限截斷（超過整則會被退件）', () => {
    const card = cardOf(unifiedActionToLineMessages(
      normalizeUnifiedAction(
        { type: 'uri', uri: 'https://example.com', buttonLabel: '字'.repeat(30) },
        'A',
      ),
    ))
    expect(card.label).toHaveLength(20)
  })
})

describe('讀回編輯器：舊草稿不可以把系統代寫的話當成店家寫的', () => {
  it.each(LEGACY_AUTO_WRITTEN_CARD_BODIES)('舊代寫句「%s」讀回來要當成沒設定', (legacy) => {
    const restored = parseLineMessagesToUnifiedAction([{
      type: 'template',
      altText: '開啟連結',
      template: {
        type: 'buttons',
        text: legacy,
        actions: [{ type: 'uri', label: '開啟網址', uri: 'https://example.com' }],
      },
    }])
    expect(restored.type).toBe('uri')
    expect(restored.cardText).toBe('')
    expect(restored.buttonLabel).toBe('')
  })

  it('⭐ 舊草稿重新送出時，客人收到的是新文案（不是被永久保存的舊術語）', () => {
    const restored = parseLineMessagesToUnifiedAction([{
      type: 'template',
      altText: '觸發機器人模組',
      template: {
        type: 'buttons',
        text: '請點擊下方按鈕以進入機器人模組。',
        actions: [{ type: 'postback', label: '開始', data: 'triggerModule=m1' }],
      },
    }])
    const card = cardOf(unifiedActionToLineMessages(restored))
    expect(card.body).toBe(LINE_CARD_BODY_DEFAULT)
    expect(card.body).not.toContain('模組')
  })

  it('店家自己寫的本文與按鈕，存檔再打開要原封不動', () => {
    const original = normalizeUnifiedAction(
      { type: 'uri', uri: 'https://example.com', cardText: '中秋禮盒開賣了', buttonLabel: '去逛逛' },
      'A',
    )
    const restored = parseLineMessagesToUnifiedAction(unifiedActionToLineMessages(original))
    expect(restored.cardText).toBe('中秋禮盒開賣了')
    expect(restored.buttonLabel).toBe('去逛逛')
  })

  it('⛔ 本文是店家寫的時候，按鈕就算剛好打「開啟網址」也不可以被吃掉', () => {
    const restored = parseLineMessagesToUnifiedAction([{
      type: 'template',
      altText: '有一則訊息',
      template: {
        type: 'buttons',
        text: '我們的新官網上線了',
        actions: [{ type: 'uri', label: '開啟網址', uri: 'https://example.com' }],
      },
    }])
    expect(restored.cardText).toBe('我們的新官網上線了')
    expect(restored.buttonLabel).toBe('開啟網址')
  })
})
