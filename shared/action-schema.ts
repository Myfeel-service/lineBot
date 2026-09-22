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

export function encodeTriggerMessage(text: string, tagIds: string[] = []): string {
  const payload = {
    text: String(text || '').slice(0, 300),
    tagIds: Array.isArray(tagIds)
      ? tagIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  }
  const body = encodeURIComponent(JSON.stringify(payload))
  return `${TRIGGER_MESSAGE_PREFIX}${body}`
}

export function parseTriggerMessageData(data: string): { text: string; tagIds: string[] } {
  if (typeof data !== 'string' || !data.startsWith(TRIGGER_MESSAGE_PREFIX)) {
    return { text: '', tagIds: [] }
  }
  const encoded = data.slice(TRIGGER_MESSAGE_PREFIX.length).trim()
  if (!encoded) return { text: '', tagIds: [] }

  try {
    const raw = JSON.parse(decodeURIComponent(encoded)) as {
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
  return null
}
