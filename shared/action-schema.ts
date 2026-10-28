export const MAX_ACTION_SLOTS = 6
export const SLOT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export type SlotLabel = typeof SLOT_LABELS[number]

export type UnifiedActionType = 'uri' | 'message' | 'module'

export interface ActionTagging {
  enabled: boolean
  addTagIds: string[]
}

export interface UnifiedAction {
  slot: string
  type: UnifiedActionType
  uri: string
  text: string
  moduleId: string
  tagging: ActionTagging
  /**
   * `C-228`：「開啟網址」／「觸發機器人模組」時，卡片上那句話與按鈕上那幾個字。
   * 空字串或未給＝店家沒寫，送出端套 `shared/line-card-copy.ts` 的預設。
   * ⛔ 預設值不要寫在這裡，也不要在送出端各寫一份——那正是「同一件事兩套文案」的成因。
   *
   * ⚠️ **刻意是選填**：這個型別有好幾處是手寫物件字面值產生的（圖文訊息區塊、模組按鈕、
   * 圖文選單、`flow-validator`），那些路徑根本沒有卡片文案可填。設成必填只會逼那幾處
   * 補兩個永遠是空字串的欄位，換不到任何保護。`normalizeUnifiedAction()` 出來的一定有值。
   */
  cardText?: string
  buttonLabel?: string
}

export const TRIGGER_MODULE_PREFIX = 'triggerModule='
const TRIGGER_MODULE_TAGS_KEY = 'tags'
export const TRIGGER_MESSAGE_PREFIX = 'triggerMessage='
export const SWITCH_MENU_PREFIX = 'switchMenu='
const SWITCH_MENU_TAGS_KEY = 'tags'

function normalizeActionTagging(input: any): ActionTagging {
  return {
    enabled: input?.enabled === true,
    addTagIds: Array.isArray(input?.addTagIds)
      ? input.addTagIds.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [],
  }
}

export function encodeTriggerModule(moduleId: string, tagIds: string[] = []): string {
  const cleanModuleId = String(moduleId || '').trim()
  if (!cleanModuleId) return TRIGGER_MODULE_PREFIX

  const cleanTagIds = Array.isArray(tagIds)
    ? tagIds.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  if (cleanTagIds.length === 0) {
    return `${TRIGGER_MODULE_PREFIX}${cleanModuleId}`
  }

  const encodedTags = encodeURIComponent(cleanTagIds.join(','))
  return `${TRIGGER_MODULE_PREFIX}${cleanModuleId}&${TRIGGER_MODULE_TAGS_KEY}=${encodedTags}`
}

export function parseTriggerModuleData(data: string): { moduleId: string; tagIds: string[] } {
  if (typeof data !== 'string') return { moduleId: '', tagIds: [] }
  if (!data.startsWith(TRIGGER_MODULE_PREFIX)) return { moduleId: '', tagIds: [] }

  const payload = data.slice(TRIGGER_MODULE_PREFIX.length).trim()
  if (!payload) return { moduleId: '', tagIds: [] }

  const [modulePart, ...rest] = payload.split('&')
  let moduleId = ''
  try {
    moduleId = decodeURIComponent(modulePart || '').trim()
  }
  catch {
    moduleId = String(modulePart || '').trim()
  }
  if (!moduleId) return { moduleId: '', tagIds: [] }

  const params = new URLSearchParams(rest.join('&'))
  const rawTags = params.get(TRIGGER_MODULE_TAGS_KEY) || ''
  const tagIds = rawTags
    .split(',')
    .map((item) => {
      try {
        return decodeURIComponent(item).trim()
      }
      catch {
        return String(item || '').trim()
      }
    })
    .filter(Boolean)

  return { moduleId, tagIds }
}

export function decodeTriggerModule(data: string): string {
  return parseTriggerModuleData(data).moduleId
}

export function encodeSwitchMenu(targetMenuId: string, tagIds: string[] = []): string {
  const cleanTargetMenuId = String(targetMenuId || '').trim()
  if (!cleanTargetMenuId) return SWITCH_MENU_PREFIX

  const cleanTagIds = Array.isArray(tagIds)
    ? tagIds.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  if (cleanTagIds.length === 0) {
    return `${SWITCH_MENU_PREFIX}${cleanTargetMenuId}`
  }

  const encodedTags = encodeURIComponent(cleanTagIds.join(','))
  return `${SWITCH_MENU_PREFIX}${cleanTargetMenuId}&${SWITCH_MENU_TAGS_KEY}=${encodedTags}`
}

export function parseSwitchMenuData(data: string): { targetMenuId: string; tagIds: string[] } {
  if (typeof data !== 'string') return { targetMenuId: '', tagIds: [] }
  if (!data.startsWith(SWITCH_MENU_PREFIX)) return { targetMenuId: '', tagIds: [] }

  const payload = data.slice(SWITCH_MENU_PREFIX.length).trim()
  if (!payload) return { targetMenuId: '', tagIds: [] }

  const [targetPart, ...rest] = payload.split('&')
  let targetMenuId = ''
  try {
    targetMenuId = decodeURIComponent(targetPart || '').trim()
  }
  catch {
    targetMenuId = String(targetPart || '').trim()
  }
  if (!targetMenuId) return { targetMenuId: '', tagIds: [] }

  const params = new URLSearchParams(rest.join('&'))
  const rawTags = params.get(SWITCH_MENU_TAGS_KEY) || ''
  const tagIds = rawTags
    .split(',')
    .map((item) => {
      try {
        return decodeURIComponent(item).trim()
      }
      catch {
        return String(item || '').trim()
      }
    })
    .filter(Boolean)

  return { targetMenuId, tagIds }
}

/** LINE postback 的 data 上限（字元數）。超過的話 LINE 把**整個請求**退回，同一次回覆的其他訊息也送不出去 */
export const LINE_POSTBACK_DATA_MAX = 300

function cleanTagIdList(tagIds: unknown): string[] {
  return Array.isArray(tagIds) ? tagIds.map((item) => String(item || '').trim()).filter(Boolean) : []
}

function rawTriggerMessage(text: string, tagIds: string[]): string {
  return `${TRIGGER_MESSAGE_PREFIX}${JSON.stringify({ text, tagIds })}`
}

/** 從尾巴切，不切斷 emoji（切一半會變亂碼） */
function cutText(text: string, length: number): string {
  if (text.length <= length) return text
  const code = text.charCodeAt(length - 1)
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? length - 1 : length)
}

/**
 * 「傳送文字」按鈕開了貼標時送出的 postback data。
 *
 * `H-43`（2026-10-28）：以前整包 `encodeURIComponent`，一個中文字變 9 個字元——掛一個標籤大約 20 個中文字
 * 就超過 LINE 的 300，LINE 把整個請求退回（`C-398` 拿 LINE 驗證端點實測抓到）。改成 JSON 原樣放，中文一個字就是一個字，
 * 掛一個標籤可以寫到兩百多字。
 * ⛔ 讀的那支（`parseTriggerMessageData`）兩種格式都要認：已經送出去的舊按鈕（聊天紀錄裡、圖文選單上）還會被點。
 * ⚠️ 還是可能放不下（字很長、標籤很多、名字變數換進去變長）：存檔時擋（`taggedPostbackError`），
 *    這裡是最後一道——把這句話切到放得下並留紀錄。寧可那句話少幾個字，也不要整則訊息送不出去。
 */
export function encodeTriggerMessage(text: string, tagIds: string[] = []): string {
  const tags = cleanTagIdList(tagIds)
  const original = String(text || '').slice(0, 300)
  let body = original
  let data = rawTriggerMessage(body, tags)
  // JSON 的跳脫（換行、引號）會讓長度不是一比一，所以邊切邊量
  while (data.length > LINE_POSTBACK_DATA_MAX && body.length > 0) {
    body = cutText(body, Math.max(0, body.length - (data.length - LINE_POSTBACK_DATA_MAX)))
    data = rawTriggerMessage(body, tags)
  }
  if (body.length < original.length) {
    console.warn(`[postback] 開貼標的「傳送文字」放不進 LINE 的 ${LINE_POSTBACK_DATA_MAX} 字：原本 ${original.length} 字、切到 ${body.length} 字（標籤 ${tags.length} 個）`)
  }
  return data
}

export function parseTriggerMessageData(data: string): { text: string; tagIds: string[] } {
  if (typeof data !== 'string' || !data.startsWith(TRIGGER_MESSAGE_PREFIX)) {
    return { text: '', tagIds: [] }
  }
  const encoded = data.slice(TRIGGER_MESSAGE_PREFIX.length).trim()
  if (!encoded) return { text: '', tagIds: [] }

  try {
    // `H-43` 起是 JSON 原樣（開頭 `{`）；以前整包 encodeURIComponent（開頭 `%7B`）。
    // ⛔ 新格式不能再過 decodeURIComponent：「打 8 折 100%」這種字會炸掉或被改掉
    const json = encoded.startsWith('{') ? encoded : decodeURIComponent(encoded)
    const raw = JSON.parse(json) as {
      text?: unknown
      tagIds?: unknown
    }
    return {
      text: String(raw?.text || '').slice(0, 300),
      tagIds: Array.isArray(raw?.tagIds)
        ? raw.tagIds.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    }
  }
  catch {
    return { text: '', tagIds: [] }
  }
}

export function normalizeUnifiedAction(input: any, fallbackSlot = 'A'): UnifiedAction {
  const rawType = input?.type
  const type: UnifiedActionType = rawType === 'message' || rawType === 'module' ? rawType : 'uri'
  return {
    slot: String(input?.slot || fallbackSlot),
    type,
    uri: String(input?.uri || ''),
    text: String(input?.text || ''),
    moduleId: String(input?.moduleId || ''),
    tagging: normalizeActionTagging(input?.tagging),
    cardText: String(input?.cardText || ''),
    buttonLabel: String(input?.buttonLabel || ''),
  }
}

export function normalizeUnifiedActions(actions: any[]): UnifiedAction[] {
  const list = Array.isArray(actions) ? actions.slice(0, MAX_ACTION_SLOTS) : []
  return list.map((action, index) => normalizeUnifiedAction(action, SLOT_LABELS[index] || `S${index + 1}`))
}

export function validateUnifiedAction(action: UnifiedAction): string | null {
  if (action.type === 'uri' && !action.uri.trim()) return '請輸入網址'
  if (action.type === 'message' && !action.text.trim()) return '請輸入傳送文字'
  if (action.type === 'module' && !action.moduleId.trim()) return '請選擇觸發模組'
  if (action.tagging.enabled && action.tagging.addTagIds.length === 0) {
    return '已啟用貼標，請至少選擇一個標籤'
  }
  return taggedPostbackError(action) || null
}

/** 模組 id 是 36 字的 uuid；還沒選的時候照最長的算 */
const MODULE_ID_PLACEHOLDER = 'x'.repeat(36)

/**
 * 開了貼標的按鈕，編成 postback 之後放不放得進 LINE 的 300 字（`H-43`）。放不下回給人看的那句話，放得下回空字串。
 * - 傳送文字：講「最多約 N 字」（N 照目前掛的標籤算；名字變數換進去的長度算不到，送出時還有最後一道切短）
 * - 叫出模組：只有標籤會讓它變長，講「最多 K 個標籤」（標籤代號 36 字，大約 7 個才會超過）
 * 只看「開了貼標」的：沒貼標的走別種 data，不會超過。
 */
export function taggedPostbackError(action: {
  type?: unknown
  text?: unknown
  label?: unknown
  moduleId?: unknown
  tagging?: { enabled?: unknown, addTagIds?: unknown } | null
} | null | undefined): string {
  if (action?.tagging?.enabled !== true) return ''
  const tags = cleanTagIdList(action.tagging.addTagIds)
  if (!tags.length) return ''

  if (action.type === 'message') {
    // 送出端是 `text || label`（handler.ts），這裡照同一個量
    const text = String(action.text || action.label || '').slice(0, 300)
    if (rawTriggerMessage(text, tags).length <= LINE_POSTBACK_DATA_MAX) return ''
    const room = LINE_POSTBACK_DATA_MAX - rawTriggerMessage('', tags).length
    if (room <= 0) return `這顆按鈕掛的標籤太多（${tags.length} 個），LINE 放不下。請少掛幾個標籤。`
    return `開了貼標的「傳送文字」最多約 ${room} 字（現在 ${text.length} 字）。請縮短這句話，或少掛幾個標籤。`
  }

  if (action.type === 'module') {
    const moduleId = String(action.moduleId || '').trim() || MODULE_ID_PLACEHOLDER
    if (encodeTriggerModule(moduleId, tags).length <= LINE_POSTBACK_DATA_MAX) return ''
    let fits = tags.length
    while (fits > 0 && encodeTriggerModule(moduleId, tags.slice(0, fits)).length > LINE_POSTBACK_DATA_MAX) fits--
    return `這顆按鈕掛的標籤太多，LINE 放不下（現在 ${tags.length} 個，最多 ${fits} 個）。請少掛幾個標籤。`
  }

  return ''
}

/**
 * 走遍一整份訊息（文字按鈕、快速回覆、各種輪播、卡片、圖文訊息的區塊都在裡面），找第一顆放不下的開貼標按鈕。
 * 模組存檔前後端都跑這支（`flow-validator.ts`／`flow.vue`）——按鈕藏在哪一層都不用各寫一份。
 */
export function firstTaggedPostbackError(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 12) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = firstTaggedPostbackError(item, depth + 1)
      if (err) return err
    }
    return ''
  }
  const node = value as Record<string, any>
  const own = taggedPostbackError(node)
  if (own) {
    const label = String(node.label || '').trim()
    return label ? `按鈕「${label}」：${own}` : own
  }
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') {
      const err = firstTaggedPostbackError(child, depth + 1)
      if (err) return err
    }
  }
  return ''
}
