/**
 * 預覽用的變數代入（`C-255`）。
 *
 * ── 在補什麼洞 ─────────────────────────────────────────────
 * 送出端會把 `{{displayName}}` 換成那位客人的名字（`renderTextForUser`，
 * `server/utils/handler.ts`），但**所有「客人會看到什麼」的預覽都沒有換**——
 * 畫面上原封不動印著 `請問{{displayName}}想問哪些有關訂單的問題呢？`，
 * 而客人在 LINE 上看到的是「請問王小明想問…」。
 * 這就是 `H-27` 那條教訓的形狀：**預覽在說謊比沒有預覽更糟**。
 *
 * ── 兩條鐵律 ───────────────────────────────────────────────
 * ⛔ **代入了就要講**：`keys` 一定要回傳給呼叫端，讓畫面講出「這裡是範例值」。
 *    默默換掉的話，店家會以為我們真的知道那位客人叫什麼
 *    （[[feedback_filters_must_report_what_they_dropped]]）。
 * ⛔ **不要碰網址類的欄位**：`uri`／`imageUrl` 這些拿去比對或開啟時要原字，
 *    換掉會變成連不上的網址。
 *
 * ⚠️ 這裡**只管畫面**。真正送出去的字一律走 `renderTextForUser`，
 *    ⛔ 不要拿這支去組要送出的訊息。
 */

/** 範例名字。⚠️ 畫面上一定要標明這是範例，不是那位客人真的叫這個。 */
export const PREVIEW_SAMPLE_DISPLAY_NAME = '王小明'

const VAR_RE = /\{\{\s*([A-Za-z0-9_一-鿿]+)\s*\}\}/g

/** ⛔ 這些欄位的值是網址／識別碼，換掉會壞掉 */
const SKIP_KEYS = new Set(['uri', 'url', 'imageUrl', 'thumbnailUrl', 'previewUrl', 'data', 'id', 'moduleId', 'richMessageRef'])

export interface PreviewVariableResult<T> {
  value: T
  /** 這次真的換掉了哪幾個變數（去重、照出現順序）。⛔ 呼叫端要把它講出來 */
  keys: string[]
}

/** 一段文字裡的變數換成範例值 */
export function renderPreviewVariablesInText(text: string): PreviewVariableResult<string> {
  const keys: string[] = []
  const out = String(text ?? '').replace(VAR_RE, (_m, rawKey: string) => {
    const key = String(rawKey)
    if (!keys.includes(key)) keys.push(key)
    return key === 'displayName' ? PREVIEW_SAMPLE_DISPLAY_NAME : `（${key}）`
  })
  return { value: out, keys }
}

/**
 * 把一整包預覽訊息裡的文字都換過。
 *
 * ⛔ **不可以就地改**：傳進來的多半是表單或抓回來的模組內容，
 *    改到原物件等於把範例值寫進店家正在編的資料裡。這裡一律回新的。
 */
export function renderPreviewVariablesDeep<T>(input: T): PreviewVariableResult<T> {
  const keys: string[] = []

  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key && SKIP_KEYS.has(key)) return value
      const r = renderPreviewVariablesInText(value)
      for (const k of r.keys) if (!keys.includes(k)) keys.push(k)
      return r.value
    }
    if (Array.isArray(value)) return value.map(v => walk(v))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k)
      return out
    }
    return value
  }

  return { value: walk(input) as T, keys }
}

/**
 * ── 2026-10-15 以前送出的推播（`D-118`）────────────────────────────
 * 那時推播一律走 LINE 群發（一次送給所有人、每個人內容一樣），送出端組訊息時**沒有任何一位客人的資料**，
 * 變數一律換成空字串。9/29 起 7 則推播、約 8,500 人次收到「 ，還記得我們問過你…」這種開頭空一格的句子，
 * 而預覽一直畫「王小明」。
 *
 * 2026-10-15 起（`D-118` A）用了變數的推播改成一人一則送、每位換上自己的名字，
 * **還沒送的推播預覽跟其他地方一樣**（`renderPreviewVariablesDeep`＋`previewVariableNote`）。
 * 下面這幾支只給「回頭看當時送了什麼」用：⛔ 那時候客人收到的是空白，不可以畫成名字
 * （判斷看推播的 `sendMode`：沒有這一欄＝群發＝空白）。
 *
 * ⚠️ 換的規則要跟送出端**同一條**：只認英文開頭的變數名（`server/utils/render-attributes.ts` 的
 *    `renderWithAttributes`）。中文變數名送出端不換、原字送出，這裡也不換。`render-attributes.test.ts` 釘兩邊一致。
 */
const SEND_VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

function collectKeys(text: string, keys: string[]): void {
  for (const m of text.matchAll(SEND_VAR_RE)) {
    const key = String(m[1])
    if (!keys.includes(key)) keys.push(key)
  }
}

/**
 * 舊推播（群發）的預覽：變數換成**空白**（跟客人當時收到的一樣）。⛔ 不可以就地改，一律回新的。
 * `keys`＝這次真的被換掉的變數，呼叫端要用 `broadcastBlankVariableNote` 講出來。
 */
export function renderBroadcastVariablesDeep<T>(input: T): PreviewVariableResult<T> {
  const keys: string[] = []
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key && SKIP_KEYS.has(key)) return value
      collectKeys(value, keys)
      return value.replace(SEND_VAR_RE, '')
    }
    if (Array.isArray(value)) return value.map(v => walk(v))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k)
      return out
    }
    return value
  }
  return { value: walk(input) as T, keys }
}

/**
 * 推播內容用了哪些變數（`broadcast-send.ts` 靠它決定要不要一人一則送）。
 * ⚠️ 這裡**每一格都掃**，連網址也掃：送出端連按鈕網址裡的變數也會換，用到了就要一人一則。
 */
export function findSendVariables(input: unknown): string[] {
  const keys: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') collectKeys(value, keys)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(walk)
  }
  walk(input)
  return keys
}

/**
 * 變數講成店家看得懂的話。⛔ 不要把 `{{displayName}}` 原字印給店家看（2026-10-15 老闆：看不懂）；
 * 名字的叫法跟「插入變數」那顆選單同一個（`BUILTIN_SCRIPT_VARIABLES`）。
 */
function variableTokens(keys: string[]): string {
  return keys.map(k => (k === 'displayName' ? '「客人的 LINE 名稱」' : `（${k}）`)).join('、')
}

/** 回頭看 2026-10-15 以前送出的推播：那時名字是空白，照實講 */
export function broadcastBlankVariableNote(keys: string[]): string {
  if (!keys.length) return ''
  // ⚠️ 這句畫在手機**上面**（放底下會被小幫手浮鈕蓋住），所以是「下面就是」
  return `這則發送的時候，推播還不會換成每位客人的名字：內容裡的${variableTokens(keys)}，客人收到的是空白（下面就是當時的樣子）。`
}

/**
 * 畫面上那一句實話。⛔ 不要只寫「這是範例」——要講清楚客人看到的是他自己的資料，
 * 以及**取不到的時候那一格會是空白**（`BUILTIN_VARIABLE_HINT` 講的就是這件事：
 * 寫成「嗨 {{displayName}}！」的人，取不到名字的客人收到的是「嗨 ！」）。
 */
export function previewVariableNote(keys: string[]): string {
  if (!keys.length) return ''
  const hasName = keys.includes('displayName')
  const others = keys.filter(k => k !== 'displayName')
  const parts: string[] = []
  if (hasName) parts.push(`「${PREVIEW_SAMPLE_DISPLAY_NAME}」是範例——客人看到的是他自己的名字`)
  if (others.length) parts.push(`${others.map(k => `（${k}）`).join('')}會換成那位客人的資料`)
  return `${parts.join('；')}。取不到的話那一格會是空白。`
}
