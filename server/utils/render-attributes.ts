import { LINE_BUTTONS_TEMPLATE_TEXT_MAX, truncateLineText } from '~~/shared/line-text-limits'

/**
 * {{變數}} 換成值——送出端唯一的一條規則（客服回覆、模組、推播都走這裡）。
 *
 * ⚠️ 只認英文開頭的變數名；中文變數名原字送出。後台推播預覽（`shared/preview-variables.ts`
 *    的 `SEND_VAR_RE`）要跟這條**一模一樣**，否則預覽又會跟客人收到的對不起來。
 */
export function renderWithAttributes(value: string, attributes: Record<string, string>): string {
  if (!value || !value.includes('{{')) return value
  return value.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => {
    return attributes[key] ?? ''
  })
}

/** LINE 的 userId 一律是 U ＋ 32 位十六進位 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i

/**
 * 一位客人拿來換 {{變數}} 的資料（客服回覆、模組、推播共用這一份）。
 *
 * ⛔ **名字是一串 LINE 代號的不算名字**：建客人資料當下抓不到 LINE 個人資料時，`ensureUser`
 *    會先把 userId 塞進名字欄。照用的話客人收到的是「U4af…您好」——當作沒有名字，那一格留空
 *    （跟取不到名字同一個結果，句子本來就要寫成少了名字也讀得通）。
 */
export function attributeContextForUser(
  user: Record<string, unknown> | { displayName?: unknown, lineUserId?: unknown, attributes?: unknown } | null | undefined,
): Record<string, string> {
  const attrs = user?.attributes
  const context: Record<string, string> = attrs && typeof attrs === 'object' ? { ...(attrs as Record<string, string>) } : {}
  const name = typeof user?.displayName === 'string' ? user.displayName.trim() : ''
  if (name && name !== String(user?.lineUserId ?? '') && !LINE_USER_ID_RE.test(name)) {
    context.displayName = name
  }
  return context
}

/** LINE 對這幾格的上限：名字換進去之後才變長的，送出前再切一次（⛔ 超過的話 LINE 會整則退回） */
const LINE_ALT_TEXT_MAX = 400
const LINE_ACTION_LABEL_MAX = 20
/** 按鈕範本帶了標題或縮圖時，文字上限從 160 降到 60（LINE 規格） */
const LINE_BUTTONS_TEMPLATE_TEXT_MAX_WITH_HEADER = 60

function clampToLineLimits(message: Record<string, unknown>): Record<string, unknown> {
  if (typeof message.altText === 'string') message.altText = truncateLineText(message.altText, LINE_ALT_TEXT_MAX)
  const template = message.template as Record<string, unknown> | undefined
  if (template?.type === 'buttons') {
    if (typeof template.text === 'string') {
      const max = template.title || template.thumbnailImageUrl
        ? LINE_BUTTONS_TEMPLATE_TEXT_MAX_WITH_HEADER
        : LINE_BUTTONS_TEMPLATE_TEXT_MAX
      template.text = truncateLineText(template.text, max)
    }
    if (Array.isArray(template.actions)) {
      for (const a of template.actions as Array<Record<string, unknown>>) {
        if (typeof a?.label === 'string') a.label = truncateLineText(a.label, LINE_ACTION_LABEL_MAX)
      }
    }
  }
  return message
}

/**
 * 推播（純文字／開網址那兩種，模組型走 `renderModuleToLineMessages`）送出前把每一格文字裡的 {{變數}} 換掉。
 *
 * `D-118` A（2026-10-15）：用了變數的推播改成**一人一則**送，每一位帶自己的 `attributes`
 * （`attributeContextForUser`）；正式發送與試發都走這支。沒帶 `attributes` 時一律換成空白。
 *
 * ⛔ 為什麼一定要換：以前純文字推播是**原字送出**，客人收到「嗨 {{displayName}}，今天公休」。
 * ⚠️ 名字換進去可能讓按鈕範本的文字超過 LINE 的上限，所以換完照上限再切一次。
 * 不就地改，回新的。
 */
export function renderBroadcastMessagesForSend<T>(messages: T[], attributes: Record<string, string> = {}): T[] {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return renderWithAttributes(value, attributes)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v)
      return out
    }
    return value
  }
  return (messages ?? []).map((m) => {
    const out = walk(m)
    return (out && typeof out === 'object' ? clampToLineLimits(out as Record<string, unknown>) : out) as T
  })
}
