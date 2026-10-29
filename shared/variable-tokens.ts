/**
 * 輸入框裡的「客人資料」變數：存起來是 `{{displayName}}`，畫面上顯示成一顆膠囊「LINE 名稱」（`D-128`，2026-10-17 老闆拍板）。
 *
 * ── 為什麼要兩種寫法 ────────────────────────────────────────
 * 存的格式不能動：送出端（`server/utils/render-attributes.ts`、`shared/types/ai-script.ts`）、已經寫好的模組、推播都認 `{{key}}`。
 * 但 `{{displayName}}` 給店家看就是一串程式碼（老闆截圖：「看起來很像程式碼」）。所以輸入框顯示「顯示用的字」，
 * 打字時再換回存的格式——**兩邊來回換一次要回到原樣**（測試釘這一條）。
 *
 * ── 顯示用的字長什麼樣 ──────────────────────────────────────
 * 前後各一個「窄的不換行空白」（U+202F）包住名稱：` LINE 名稱 `。
 *  · 這兩個字元平常不會有人打，拿來當膠囊的邊界不會跟店家自己寫的字撞到；
 *  · 它們本身是空白，剛好當膠囊左右的內距；不換行，膠囊不會被折成兩半（名稱中間的空白也用不換行的 U+00A0）。
 * 膠囊是 `VariableTextField` 在原本的輸入框上面另外畫一層畫出來的——底下還是原生輸入框，中文輸入法、字數照舊。
 *
 * ── 自己打也算 ──────────────────────────────────────────────
 * 打「［LINE 名稱］」（全形或半形括號都行）、或舊的「{{displayName}}」，都會變成膠囊。
 * ⛔ 括號只認**已知的名稱**（LINE 名稱、這一頁收集得到的欄位）：店家寫「［SALE］」是要客人看到這幾個字，
 *    當成變數的話送出去會變空白。
 */

import { replaceSheetFieldTokens, sheetFieldLabel, sheetFieldRefFromLabel, sheetFieldToken } from './sheet-field'

/** 膠囊左右的邊界（U+202F 窄的不換行空白） */
export const VAR_TOKEN_EDGE = ' '

/**
 * 膠囊裡的字最長幾個字。`C-423` 起有「試算表的一格」膠囊（「Giaretti 珈樂堤《小滑手》…・出貨時間」），
 * 商品名可以很長（知識卡標題上限 200 字）；邊界字元平常沒人打，放寬不會把兩顆膠囊連成一顆。
 */
const CAPSULE_RE_SOURCE = `${VAR_TOKEN_EDGE}([^${VAR_TOKEN_EDGE}\\n]{1,240})${VAR_TOKEN_EDGE}`

/**
 * 膠囊上的字 → 存的格式（不認得＝null）：先認客人資料變數，再認「列・欄」（只在模組這種 send 模式）。
 * 跟 `variableTokenRanges` 同一條規則：畫成膠囊的，存的時候就一定換得回來。
 */
function storedForLabel(label: string, mode: VariableKeyMode, known?: readonly string[]): string | null {
  const key = keyForLabel(label, mode, known)
  if (key) return `{{${key}}}`
  if (mode !== 'send') return null
  const ref = sheetFieldRefFromLabel(label)
  return ref ? sheetFieldToken(ref) : null
}

/** 送出端認得的變數名（`renderWithAttributes`）：英文開頭 */
const SEND_KEY = '[A-Za-z][A-Za-z0-9_]*'
/** 自動回應（腳本）收集欄位的變數名（`renderScriptTemplate`）：英數、底線、中文 */
const SCRIPT_KEY = '[\\w一-龥]+'

/**
 * send＝機器人模組、推播、客服預存回覆（`renderWithAttributes`，只認英文）；
 * script＝自動回應的回覆（`renderScriptTemplate`，收集欄位可以是中文）。
 * ⚠️ 兩邊規則不一樣，⛔ 不要統一成寬的那一條：模組裡顯示成膠囊的，送出時就一定要換得掉。
 */
export type VariableKeyMode = 'send' | 'script'

const keyPattern = (mode: VariableKeyMode) => (mode === 'script' ? SCRIPT_KEY : SEND_KEY)

/** 內建變數的名稱（膠囊上的字）。其他變數（收集到的欄位）膠囊上就寫欄位名 */
const BUILTIN_LABELS: Record<string, string> = {
  displayName: 'LINE 名稱',
}

/** 名稱比對用：不換行空白當成一般空白、去掉空白 */
const normLabel = (s: string) => s.replace(/[\s  ]+/g, '').toLowerCase()

/**
 * 自動回應「這一題問的是」常用欄位的中文名（`D-138`④）：膠囊、選單、流程圖都講「訂單編號」，不露出 order_id。
 * 存的格式不變（`{{order_id}}`），只有顯示換字。
 * ⛔ 只在 script 模式：模組／推播的變數送出端只認英文 key，那邊照舊。
 */
export const SCRIPT_PRESET_FIELD_LABELS: Readonly<Record<string, string>> = {
  order_id: '訂單編號',
  name: '姓名',
  phone: '電話',
  email: 'Email',
  address: '地址',
  note: '備註',
}

/** 這個變數在膠囊上顯示的字 */
export function variableLabel(key: string, mode: VariableKeyMode = 'send'): string {
  return BUILTIN_LABELS[key] ?? (mode === 'script' ? SCRIPT_PRESET_FIELD_LABELS[key] : undefined) ?? key
}

/** 一顆膠囊的顯示用字（插入按鈕插進輸入框的就是這一段） */
export function displayTokenFor(key: string, mode: VariableKeyMode = 'send'): string {
  return `${VAR_TOKEN_EDGE}${variableLabel(key, mode)}${VAR_TOKEN_EDGE}`
}

/**
 * 插入選單上「LINE 名稱」那一項（模組、推播、客服預存、活動共用，名稱跟膠囊上的字同一個）。
 * hint＝選單上底下那一行小字。
 */
export const DISPLAY_NAME_VARIABLE_OPTION = {
  value: 'displayName',
  label: 'LINE 名稱',
  hint: '客人在 LINE 上的名字，例如「王小明」',
  token: displayTokenFor('displayName'),
} as const

/**
 * 膠囊上的字 → 變數名（不認得＝null）。
 * known＝這一頁收集得到的欄位：店家自己把欄位取名叫「訂單編號」（中文名）時換回它自己，
 * 不要被當成常用欄位的 order_id（同一份流程兩種都有的話分不出來，實務上沒有人這樣設）。
 */
function keyForLabel(label: string, mode: VariableKeyMode, known?: readonly string[]): string | null {
  const n = normLabel(label)
  for (const [key, l] of Object.entries(BUILTIN_LABELS)) if (normLabel(l) === n) return key
  const raw = label.replace(/[  ]/g, ' ').trim()
  if (mode === 'script') {
    if (known?.includes(raw)) return raw
    // 只有這一頁真的收得到那個常用欄位才換回英文 key；不知道收得到什麼（沒給 known）就照字面
    const preset = Object.entries(SCRIPT_PRESET_FIELD_LABELS).find(([, l]) => normLabel(l) === n)?.[0]
    if (preset && known?.includes(preset)) return preset
  }
  return new RegExp(`^${keyPattern(mode)}$`).test(raw) ? raw : null
}

/** 存的格式 → 顯示用的字（`{{displayName}}` → 膠囊）。不是字串的照原樣回（表單初始值可能是 undefined） */
export function toDisplayText(stored: string, mode: VariableKeyMode = 'send'): string {
  if (typeof stored !== 'string' || !stored.includes('{{')) return stored
  const out = stored.replace(new RegExp(`\\{\\{\\s*(${keyPattern(mode)})\\s*\\}\\}`, 'g'), (_m, key: string) => displayTokenFor(key, mode))
  // `C-423`：試算表的一格 → 膠囊「列・欄」（只有模組這種 send 模式有）
  return mode === 'send'
    ? replaceSheetFieldTokens(out, ref => `${VAR_TOKEN_EDGE}${sheetFieldLabel(ref)}${VAR_TOKEN_EDGE}`)
    : out
}

/**
 * 存的格式切成「字／變數」幾段（`{{order_id}}` → 一段「訂單編號」、帶 key）：只看不改的地方用（小幫手確認卡）。
 * 規則跟 `toDisplayText` 同一條：那邊顯示成膠囊的，這裡也是。
 */
export function variableSegments(stored: string, mode: VariableKeyMode = 'send'): Array<{ text: string, key?: string }> {
  const text = typeof stored === 'string' ? stored : ''
  const out: Array<{ text: string, key?: string }> = []
  let at = 0
  // `C-423`：模組（send）裡的試算表一格也算一段，key 是整個存的格式
  const sheet = mode === 'send' ? '|\\{\\{sheet:[^{}|\\n]*\\|[^{}|\\n]*\\}\\}' : ''
  for (const m of text.matchAll(new RegExp(`\\{\\{\\s*(${keyPattern(mode)})\\s*\\}\\}${sheet}`, 'g'))) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) })
    if (m[1]) out.push({ text: variableLabel(m[1], mode), key: m[1] })
    else out.push({ text: toDisplayText(m[0], mode).replaceAll(VAR_TOKEN_EDGE, ''), key: m[0] })
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

/**
 * 存的格式 → 用括號寫的字（`{{order_id}}` → `［訂單編號］`）：給小幫手講給店家聽的那一份（純文字沒有膠囊）。
 * 括號是編輯頁本來就認的寫法：他照抄回來，`toStoredText` 會換回變數。
 */
export function toBracketText(stored: string, mode: VariableKeyMode = 'send'): string {
  return variableSegments(stored, mode).map(s => (s.key ? `［${s.text}］` : s.text)).join('')
}

/**
 * 顯示用的字 → 存的格式。
 * extraKeys：這一頁「打括號也算」的欄位（例如這個模組收集得到的 phone）；LINE 名稱永遠算。
 */
export function toStoredText(display: string, mode: VariableKeyMode = 'send', extraKeys: readonly string[] = []): string {
  if (typeof display !== 'string') return display
  let out = display
  // ① 膠囊（插入按鈕插的、或從別的框貼過來的）
  if (out.includes(VAR_TOKEN_EDGE)) {
    out = out.replace(new RegExp(CAPSULE_RE_SOURCE, 'g'), (m, label: string) => storedForLabel(label, mode, extraKeys) ?? m)
    // 刪掉一半的膠囊（選一段字剪掉）留下的邊界字元：拿掉，剩下的字當一般文字
    out = out.replace(/ /g, '')
  }
  // ② 自己打的括號：只認已知的名稱
  if (/[［\[]/.test(out)) {
    const known = new Set([...Object.keys(BUILTIN_LABELS), ...extraKeys])
    out = out.replace(/[［\[]([^［］\[\]\n]{1,60})[］\]]/g, (m, label: string) => {
      const key = keyForLabel(label, mode, extraKeys)
      return key && known.has(key) ? `{{${key}}}` : m
    })
  }
  return out
}

export interface VariableTokenRange {
  /** 膠囊第一個字元（左邊界）的位置 */
  start: number
  /** 膠囊後面那個位置（右邊界之後） */
  end: number
  key: string
}

/** 顯示用的字裡每一顆膠囊的位置（游標跳過膠囊、退格整顆刪掉用） */
export function variableTokenRanges(display: string, mode: VariableKeyMode = 'send'): VariableTokenRange[] {
  const out: VariableTokenRange[] = []
  if (typeof display !== 'string' || !display.includes(VAR_TOKEN_EDGE)) return out
  for (const m of display.matchAll(new RegExp(CAPSULE_RE_SOURCE, 'g'))) {
    const stored = storedForLabel(m[1]!, mode)
    if (!stored) continue
    // 客人資料變數給變數名；`C-423` 試算表的一格給整個存的格式（`{{sheet:…}}`）
    const key = stored.startsWith('{{sheet:') ? stored : stored.slice(2, -2)
    out.push({ start: m.index!, end: m.index! + m[0].length, key })
  }
  return out
}
