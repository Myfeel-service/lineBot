import type { UnifiedAction } from './action-schema'
import {
  decodeTriggerModule,
  encodeTriggerModule,
  normalizeUnifiedAction,
} from './action-schema'
import {
  LINE_CARD_ALT_TEXT_MODULE,
  LINE_CARD_ALT_TEXT_URI,
  LINE_CARD_BODY_DEFAULT,
  LINE_CARD_BUTTON_LABEL_MODULE_DEFAULT,
  LINE_CARD_BUTTON_LABEL_URI_DEFAULT,
  isLegacyAutoWrittenCardBody,
  resolveCardButtonLabel,
  resolveCardCopy,
} from './line-card-copy'
import { LINE_BUTTONS_TEMPLATE_TEXT_MAX, truncateLineText } from './line-text-limits'

/**
 * 將 Firestore / 舊版推播的 messages 還原為統一動作編輯器狀態。
 * 多則訊息時只取第一則可辨識的內容。
 */
export function parseLineMessagesToUnifiedAction(raw: unknown[] | null | undefined): UnifiedAction {
  const empty = normalizeUnifiedAction({ type: 'message', text: '' }, 'A')
  if (!Array.isArray(raw) || !raw.length) return empty

  const first = raw[0] as Record<string, unknown>
  if (!first || typeof first !== 'object') return empty

  if (first.type === 'template' && (first.template as Record<string, unknown>)?.type === 'buttons') {
    const tpl = first.template as { text?: string; actions?: Record<string, unknown>[] }
    const actions = Array.isArray(tpl.actions) ? tpl.actions : []
    const bodyText = String(tpl.text || '')
    if (actions.length >= 1) {
      const a0 = actions[0]
      /*
       * `C-228`：卡片本文與按鈕文字要讀得回來，否則店家寫好、存成草稿、再打開就沒了。
       *
       * ⛔ 但**以前由系統代寫的那幾句不能認**：認了的話，09-23 以前建的草稿會把
       * 「請點擊下方按鈕以進入機器人模組。」當成店家親手寫的永久留著，改了預設也救不到。
       *
       * ⭐ 判斷「這張卡整張都還沒被碰過」只看**本文**一個訊號，按鈕文字跟著它走：
       * 本文是舊的代寫句 → 整張當沒設定過，按鈕文字一起丟；本文是別的字 → 兩個都原樣留著。
       * ⛔ 不要對按鈕文字另外列一份「舊值清單」去比對——UI 那半上線後，店家真的把按鈕
       * 寫成「開啟網址」四個字是完全合理的，比對舊值會把他寫的東西吃掉。
       */
      const legacyCard = isLegacyAutoWrittenCardBody(bodyText)
      const savedBody = legacyCard ? '' : bodyText
      if (a0?.type === 'uri' && typeof a0.uri === 'string' && a0.uri.trim()) {
        return normalizeUnifiedAction(
          {
            type: 'uri',
            uri: a0.uri.trim(),
            text: '',
            moduleId: '',
            cardText: savedBody,
            buttonLabel: legacyCard ? '' : String(a0.label || ''),
          },
          'A',
        )
      }
      if (a0?.type === 'postback' && typeof a0.data === 'string') {
        const mid = decodeTriggerModule(a0.data)
        if (mid) {
          return normalizeUnifiedAction(
            {
              type: 'module',
              moduleId: mid,
              text: '',
              uri: '',
              cardText: savedBody,
              buttonLabel: legacyCard ? '' : String(a0.label || ''),
            },
            'A',
          )
        }
      }
    }
    if (bodyText.trim()) return normalizeUnifiedAction({ type: 'message', text: bodyText }, 'A')
    return empty
  }

  if (first.type === 'text') {
    const t = String((first as { text?: string }).text || '')
    const btns = (first as { buttons?: Record<string, unknown>[] }).buttons
    if (Array.isArray(btns) && btns.length === 1) {
      const b = btns[0]
      if (b?.type === 'uri' && typeof b.uri === 'string' && b.uri.trim()) {
        return normalizeUnifiedAction({ type: 'uri', uri: b.uri.trim() }, 'A')
      }
      if (b?.type === 'module' && typeof b.moduleId === 'string' && b.moduleId.trim()) {
        return normalizeUnifiedAction({ type: 'module', moduleId: b.moduleId.trim() }, 'A')
      }
    }
    return normalizeUnifiedAction({ type: 'message', text: t }, 'A')
  }

  return empty
}

/** 將統一動作轉成 LINE Messaging API 可 multicast 的 messages（最多一則 template 或 text） */
export function unifiedActionToLineMessages(action: UnifiedAction): Record<string, unknown>[] {
  const a = normalizeUnifiedAction(action, 'A')

  if (a.type === 'message') {
    const text = a.text.trim()
    if (!text) return []
    return [{ type: 'text', text }]
  }

  if (a.type === 'uri') {
    const uri = a.uri.trim()
    if (!uri) return []
    return [{
      type: 'template',
      altText: LINE_CARD_ALT_TEXT_URI,
      template: {
        type: 'buttons',
        text: cardBody(a),
        actions: [{
          type: 'uri',
          label: resolveCardButtonLabel(a.buttonLabel, LINE_CARD_BUTTON_LABEL_URI_DEFAULT),
          uri,
        }],
      },
    }]
  }

  const mid = a.moduleId.trim()
  if (!mid) return []
  return [{
    type: 'template',
    altText: LINE_CARD_ALT_TEXT_MODULE,
    template: {
      type: 'buttons',
      text: cardBody(a),
      actions: [{
        type: 'postback',
        label: resolveCardButtonLabel(a.buttonLabel, LINE_CARD_BUTTON_LABEL_MODULE_DEFAULT),
        data: encodeTriggerModule(mid),
      }],
    },
  }]
}

/**
 * 卡片本文：店家自己寫的優先，沒寫就用預設，最後照按鈕範本的 160 字上限截斷。
 * ⛔ 截斷走 `truncateLineText`，不要自己 `.slice()`——預覽與送出必須切在同一格
 * （`H-27` 的教訓，見 `shared/line-text-limits.ts`）。
 */
function cardBody(action: UnifiedAction): string {
  return truncateLineText(
    resolveCardCopy(action.cardText, LINE_CARD_BODY_DEFAULT),
    LINE_BUTTONS_TEMPLATE_TEXT_MAX,
  )
}
