/**
 * 機器人模組帶出「試算表上某個商品的某一格」（`C-423`，`D-163` ①）。
 *
 * **為什麼要有**：MYFEEL 的出貨時間同時寫在試算表（AI 讀這份）跟選單模組（手打）兩處，Giaretti 已經兩邊講不一樣
 * （AI：10/7 起第二批 11 月底；選單：10 月底）。改成模組直接帶出那一格，改試算表＝選單跟 AI 一起變。
 *
 * ── 存起來長什麼樣 ───────────────────────────────────────────
 * `{{sheet:<列名稱>|<欄名>}}`（兩段各自 encodeURIComponent，裡面有 `|`、`}` 都不會斷錯）。
 * 輸入框顯示成一顆膠囊「<列名稱>・<欄名>」——**兩邊可以互相換回來，不用另外記對照表**
 * （跟 `{{displayName}}`↔「LINE 名稱」同一套，見 `shared/variable-tokens.ts`）。
 * ⛔ 送出端的 `renderWithAttributes` 不認這種寫法（它只認英數字），所以一定要在那之前換掉（`server/utils/sheet-field-hydrate.ts`）；
 *    換不到的話用存檔當時的內容（`sheetSnapshots`），⛔ 不可以把標記原字送給客人、也不送空白。
 *
 * ── 讀的是哪一份 ─────────────────────────────────────────────
 * 這個帳號「Google 試算表」資料來的知識卡（一列一張、標題＝第一欄），**跟 AI 讀的同一張**：
 * 卡片在後台改過的，模組也跟著改過的版本——要的就是「點選單跟直接問講一樣」。
 */

export interface SheetFieldRef {
  /** 列名稱＝試算表第一欄＝知識卡標題 */
  row: string
  /** 欄名（第一列那一格） */
  field: string
}

/** 膠囊上列名稱跟欄名中間那個字（取最後一個來切：商品名裡偶爾有「・」，欄名幾乎不會有） */
export const SHEET_FIELD_SEP = '・'

const TOKEN_RE = /\{\{sheet:([^{}|\n]*)\|([^{}|\n]*)\}\}/g

function decode(s: string): string {
  try { return decodeURIComponent(s) }
  catch { return s }
}

/** 存的格式 */
export function sheetFieldToken(ref: SheetFieldRef): string {
  return `{{sheet:${encodeURIComponent(ref.row)}|${encodeURIComponent(ref.field)}}}`
}

// ── `C-437` 商品資訊範本：「這個商品」的某一格 ─────────────────
/**
 * 列名稱寫 `@`＝客人在商品目錄點的那個商品（`{{sheet:@|出貨時間}}`）——一份範本給所有商品用。
 * 另外兩格不在試算表的欄裡：`@name` 商品名（第一欄）、`@image` 商品目錄上那張圖。
 * 填法（空白整行拿掉、網址按鈕）在 `shared/sheet-current-product.ts`。
 */
export const SHEET_CURRENT_ROW = '@'
export const SHEET_FIELD_NAME = '@name'
export const SHEET_FIELD_IMAGE = '@image'
/** 膠囊上怎麼叫（「出貨時間・這個商品」「商品名・這個商品」）；⛔ 店家真的有一個商品叫「這個商品」的話會被當成這個 */
export const SHEET_CURRENT_ROW_LABEL = '這個商品'
const NAME_FIELD_LABEL = '商品名'
const IMAGE_FIELD_LABEL = '商品圖'

export function isCurrentProductRef(ref: SheetFieldRef): boolean {
  return ref.row === SHEET_CURRENT_ROW
}

/** 這段字有沒有用到「這個商品」的格子 */
export function usesCurrentProduct(text: unknown): boolean {
  return typeof text === 'string' && sheetFieldTokensIn(text).some(t => isCurrentProductRef(t.ref))
}

/** 存的格式裡每一個標記（照出現順序，重複的也列） */
export function sheetFieldTokensIn(text: string): Array<{ token: string, ref: SheetFieldRef }> {
  if (typeof text !== 'string' || !text.includes('{{sheet:')) return []
  return [...text.matchAll(TOKEN_RE)].map(m => ({ token: m[0], ref: { row: decode(m[1]!), field: decode(m[2]!) } }))
}

/** 存的格式 → 每個標記換成 replacer 給的字 */
export function replaceSheetFieldTokens(text: string, replacer: (ref: SheetFieldRef, token: string) => string): string {
  if (typeof text !== 'string' || !text.includes('{{sheet:')) return text
  return text.replace(TOKEN_RE, (token, row: string, field: string) => replacer({ row: decode(row), field: decode(field) }, token))
}

const cleanLabelPart = (s: string) => s.replace(/[\n\r ]+/g, ' ').trim()

function labelRow(ref: SheetFieldRef): string {
  return isCurrentProductRef(ref) ? SHEET_CURRENT_ROW_LABEL : cleanLabelPart(ref.row)
}

function labelField(ref: SheetFieldRef): string {
  if (isCurrentProductRef(ref) && ref.field === SHEET_FIELD_NAME) return NAME_FIELD_LABEL
  if (isCurrentProductRef(ref) && ref.field === SHEET_FIELD_IMAGE) return IMAGE_FIELD_LABEL
  return cleanLabelPart(ref.field)
}

/**
 * 膠囊上的全名「欄・列」（`C-428`：欄名在前——「出貨時間・Giaretti…」一眼先看到是哪一項）。
 * 換行、膠囊邊界字元（U+202F）不能出現在膠囊裡，換成一般空白。
 */
export function sheetFieldLabel(ref: SheetFieldRef): string {
  return `${labelField(ref)}${SHEET_FIELD_SEP}${labelRow(ref)}`
}

/** 膠囊上的全名 → 標記（取**第一個**「・」切：欄名幾乎不會有，商品名偶爾有）。不是「欄・列」的樣子＝null */
export function sheetFieldRefFromLabel(label: string): SheetFieldRef | null {
  const i = label.indexOf(SHEET_FIELD_SEP)
  if (i <= 0 || i === label.length - 1) return null
  const field = label.slice(0, i).trim()
  const row = label.slice(i + 1).trim()
  if (!row || !field) return null
  if (row === SHEET_CURRENT_ROW_LABEL) {
    if (field === NAME_FIELD_LABEL) return { row: SHEET_CURRENT_ROW, field: SHEET_FIELD_NAME }
    if (field === IMAGE_FIELD_LABEL) return { row: SHEET_CURRENT_ROW, field: SHEET_FIELD_IMAGE }
    return { row: SHEET_CURRENT_ROW, field }
  }
  return { row, field }
}

/** 商品名超過這幾個字就截短（膠囊太長會佔兩行、被輸入框的按鈕壓到——`D-166` 實機截圖） */
export const SHEET_LABEL_ROW_MAX = 12

/**
 * 膠囊上的字跟存的格式互換的對照（`C-428`）。
 * 短名「出貨時間・Giaretti 珈樂堤《小…」換不回完整商品名，所以要一份對照：頁面把挑得到的每一格都登記進來。
 * ⛔ 兩格縮出來一樣（例：「W1 REGEN 單入組／雙入組」前段相同）＝那幾格都用全名，不猜。
 * 不在對照裡的照舊用全名（全名自己就換得回去）。
 */
export interface SheetLabelRegistry {
  labelFor: (token: string) => string | undefined
  tokenFor: (label: string) => string | undefined
}

export function sheetFieldShortLabel(ref: SheetFieldRef, rowMax = SHEET_LABEL_ROW_MAX): string {
  const row = labelRow(ref)
  const chars = [...row]
  return `${labelField(ref)}${SHEET_FIELD_SEP}${chars.length > rowMax ? `${chars.slice(0, rowMax).join('')}…` : row}`
}

export function buildSheetLabelRegistry(refs: readonly SheetFieldRef[]): SheetLabelRegistry {
  const byToken = new Map<string, string>()
  const shortOwners = new Map<string, Set<string>>()
  for (const ref of refs) {
    const token = sheetFieldToken(ref)
    const short = sheetFieldShortLabel(ref)
    if (!shortOwners.has(short)) shortOwners.set(short, new Set())
    shortOwners.get(short)!.add(token)
    byToken.set(token, short)
  }
  const tokenByLabel = new Map<string, string>()
  for (const [token, short] of byToken) {
    if (shortOwners.get(short)!.size > 1) {
      // 撞名：這幾格都用全名（全名本來就換得回去，不必登記）
      const ref = sheetFieldTokensIn(token)[0]!.ref
      byToken.set(token, sheetFieldLabel(ref))
      continue
    }
    tokenByLabel.set(short, token)
  }
  return {
    labelFor: token => byToken.get(token),
    tokenFor: label => tokenByLabel.get(label),
  }
}

/** 列名稱比對用：大小寫、全半形空白不算（跟同步配對卡片的 normTitle 同一個意思） */
export function sheetRowKey(s: string): string {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 從一張「試算表來的知識卡」切出某一欄。內文是一欄一段「欄名：值」，值可以跨好幾行。
 * - 只認 `headers` 裡的欄名（同步時記下來的），內文自己的「依原廠公告：」不會被當成新的一欄。
 * - 兩欄表（只有一個欄名）：內文就是那一欄整段。
 * - 找不到那一欄＝null（⛔ 不回空字串：呼叫端要分得出「這格是空的」跟「表上沒有這一欄」）。
 */
export function sheetCardField(content: string, headers: readonly string[], field: string): string | null {
  const text = String(content ?? '')
  const names = headers.map(h => String(h ?? '').trim()).filter(Boolean)
  if (!names.includes(field)) return null
  if (names.length === 1) return text.trim()
  // 長的先比：「額外資訊1」不可以被「額外資訊」吃掉
  const byLength = [...names].sort((a, b) => b.length - a.length)
  let current: string | null = null
  const collected = new Map<string, string[]>()
  for (const line of text.split('\n')) {
    const head = byLength.find(h => line.startsWith(`${h}：`))
    if (head) {
      current = head
      if (!collected.has(head)) collected.set(head, [])
      collected.get(head)!.push(line.slice(head.length + 1))
      continue
    }
    if (current) collected.get(current)!.push(line)
  }
  const lines = collected.get(field)
  if (!lines) return null
  return lines.join('\n').replace(/^\n+|\n+$/g, '').trim()
}
