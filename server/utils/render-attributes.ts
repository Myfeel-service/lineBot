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

/**
 * 推播（群發）送出前把每一格文字裡的 {{變數}} 換掉——一次送給所有人、拿不到每位客人的資料，
 * 所以一律換成空白，跟「發模組」那條路（`renderModuleToLineMessages` 帶空的 attributes）同一條規則。
 *
 * ⛔ 為什麼要有：純文字／開網址推播以前是**原字送出**，客人收到「嗨 {{displayName}}，今天公休」，
 *    而預覽與發送前確認都說是空白、試發也收到原字（`D-118` 之後的審查抓到）。正式發送與試發都走這支。
 * 不就地改，回新的。
 */
export function renderBroadcastMessagesForSend<T>(messages: T[]): T[] {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return renderWithAttributes(value, {})
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v)
      return out
    }
    return value
  }
  return (messages ?? []).map(m => walk(m) as T)
}
