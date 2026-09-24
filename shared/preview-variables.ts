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
