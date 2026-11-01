import { sheetCardField, sheetFieldToken } from './sheet-field'
import { isHiddenCatalogCards } from './sheet-catalog'

/**
 * 試算表改了、模組還寫著改之前的原字（`C-429`，`D-165`）。
 *
 * **為什麼要有**：`C-423` 之後模組可以直接帶出試算表那一格，帶出來的就不會跟 AI 講不一樣；
 * 但已經手打的模組不會自己變——試算表一改，選單跟 AI 又講兩種話（Giaretti 就是這樣）。
 *
 * **怎麼認**：只認「改之前那一格的原字」**一字不差**出現在模組裡（空白、換行不算）。
 * ⛔ 不用相似度猜：`重新同步報假變更` 那次的教訓——相似度一定會誤報，誤報的提醒沒人會再看。
 * 做不到的：已經不一樣的（模組本來就沒照抄最新的）抓不到，那種要店家自己換或等商品表搬家。
 * 太短的字（不到 8 個字）不算：「現貨」這種到處都有，會亂報。
 *
 * 同步時找一次（`server/utils/sheet-stale-modules.ts`），提醒中心跟模組頁再用同一支確認「現在還是舊的」。
 */

export const QUOTE_MIN_CHARS = 8

/** 比對用：拿掉所有空白（換行、全形空白、膠囊邊界都算） */
export function quoteKey(s: string): string {
  return String(s ?? '').replace(/\s+/g, '')
}

export interface SheetFieldChange {
  row: string
  field: string
  oldValue: string
  newValue: string
}

/**
 * 同一列（同一張知識卡）改之前、改之後，哪幾格變了。
 * 欄名用同步時記的那一份：改之前的照上一次記的切（沒有就用這次的），改之後照這次的。
 * 改之前那格是空的、或短到不到 8 個字＝不列（沒有原字可以找）。
 */
export function diffSheetCardFields(
  row: string,
  oldContent: string,
  newContent: string,
  oldHeaders: readonly string[] | null | undefined,
  newHeaders: readonly string[] | null | undefined,
): SheetFieldChange[] {
  if (!newHeaders?.length) return []
  const before = oldHeaders?.length ? oldHeaders : newHeaders
  const out: SheetFieldChange[] = []
  for (const field of newHeaders) {
    const oldValue = sheetCardField(oldContent, before, field)
    if (!oldValue || [...quoteKey(oldValue)].length < QUOTE_MIN_CHARS) continue
    const newValue = sheetCardField(newContent, newHeaders, field) ?? ''
    if (quoteKey(oldValue) === quoteKey(newValue)) continue
    out.push({ row, field, oldValue, newValue })
  }
  return out
}

/** 模組裡每一段字（⛔ 跳過 `sheetSnapshots`：那裡面放的本來就是試算表的字，不是店家手打的） */
function eachString(value: unknown, fn: (s: string) => void, key?: string): void {
  if (key === 'sheetSnapshots') return
  if (typeof value === 'string') { fn(value); return }
  if (Array.isArray(value)) { for (const v of value) eachString(v, fn); return }
  // 照試算表排的目錄裡留著可以切回去的舊卡片不送出：寫著舊字也不用提醒（`C-453` code review 第 13 條）
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (!isHiddenCatalogCards(value, k)) eachString(v, fn, k)
}

/** 這個模組有沒有一字不差（空白不算）寫著這幾段舊字的其中一段；回傳是哪一段 */
export function quotedValueIn(messages: unknown, oldValues: readonly string[]): string | null {
  const keys = oldValues.map(v => ({ v, k: quoteKey(v) })).filter(x => [...x.k].length >= QUOTE_MIN_CHARS)
  if (!keys.length) return null
  let hit: string | null = null
  eachString(messages, (s) => {
    if (hit) return
    const hay = quoteKey(s)
    const found = keys.find(x => hay.includes(x.k))
    if (found) hit = found.v
  })
  return hit
}

/**
 * 一段字裡，把那段舊字（空白不算地比對）換成 replacement。回傳換了幾處。
 * 換的是原文裡那一段的完整範圍（含中間的換行），前後的字照舊。
 */
export function replaceQuotedText(text: string, oldValue: string, replacement: string): { text: string, count: number } {
  const needle = quoteKey(oldValue)
  if ([...needle].length < QUOTE_MIN_CHARS || typeof text !== 'string') return { text, count: 0 }
  // 拿掉空白後的每個字，記住它在原文的位置
  const chars: string[] = []
  const pos: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) continue
    chars.push(text[i]!)
    pos.push(i)
  }
  const flat = chars.join('')
  let out = ''
  let rawAt = 0
  let from = 0
  let count = 0
  for (;;) {
    const at = flat.indexOf(needle, from)
    if (at < 0) break
    const start = pos[at]!
    const end = pos[at + needle.length - 1]! + 1
    out += text.slice(rawAt, start) + replacement
    rawAt = end
    from = at + needle.length
    count++
  }
  return { text: count ? out + text.slice(rawAt) : text, count }
}

/** 整個模組裡把舊字換成試算表那一格（模組頁「換成跟試算表同步」）。⛔ 不動 `sheetSnapshots` */
export function replaceQuotedInMessages<T>(messages: T, oldValues: readonly string[], ref: { row: string, field: string }): { messages: T, count: number } {
  const token = sheetFieldToken(ref)
  let count = 0
  const walk = (value: unknown, key?: string): unknown => {
    if (key === 'sheetSnapshots') return value
    if (typeof value === 'string') {
      let s = value
      for (const v of oldValues) {
        const r = replaceQuotedText(s, v, token)
        s = r.text
        count += r.count
      }
      return s
    }
    if (Array.isArray(value)) return value.map(v => walk(v))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]))
    }
    return value
  }
  return { messages: walk(messages) as T, count }
}
