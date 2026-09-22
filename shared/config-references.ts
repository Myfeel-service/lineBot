/**
 * 「這個東西被誰用了」——後台設定之間的反查（`C-209`）。
 *
 * **它解的問題**：叫出一個模組的路有七條，全設在別的頁面；一顆標籤可能被模組按鈕、
 * 圖文選單、活動、客服預存、自動回應貼上，又被推播拿去挑名單。今天後台**沒有任何地方**
 * 看得出這些關係，所以會發生兩件事：
 *   ① 建好一個模組、按了儲存，它可能**永遠不會被叫出來**，而畫面上完全看不出來
 *   ② 停用一顆標籤，用到它的地方仍然存著它的 id，下拉只載入啟用中的標籤 → 畫面印出一串 UUID
 *
 * ⛔ **不要另外刻一份走訪**：模組那半直接用 `broken-module-refs.ts` 的 `collectModuleRefs`
 *    （它已經認得「已編碼的 postback 字串」與「未編碼的動作物件」兩種形態）。
 *    這裡補的是標籤那半，⛔ 同樣兩種形態都要認，否則會出現
 *    「畫面說沒人用，實際上圖文選單天天在貼」。
 */
import {
  SWITCH_MENU_PREFIX,
  TRIGGER_MESSAGE_PREFIX,
  TRIGGER_MODULE_PREFIX,
  parseSwitchMenuData,
  parseTriggerMessageData,
  parseTriggerModuleData,
} from './action-schema'

/** 引用來源的種類。⛔ 與 `broken-module-refs.ts` 的 `sourceKind` 相容（多了推播與客服預存） */
export type ConfigRefKind
  = | 'flow' // 另一個模組的按鈕
    | 'richmenu' // 圖文選單的格子
    | 'script' // 自動回應
    | 'campaign' // 活動貼標
    | 'broadcast' // 推播
    | 'supportPreset' // 客服預存

export interface ConfigRef {
  kind: ConfigRefKind
  /** 引用它的那筆設定的 id（目前沒有任何一頁吃得下深連結，先留著給之後用） */
  id: string
  /** 給人看的名字，例如「查詢訂單」 */
  label: string
  /**
   * 這一筆是不是停用中的設定。
   * ⛔ 停用的不能直接濾掉：停用的推播草稿還是會有人回頭按發送，
   *    但它跟「現在正在服務客人」的意義不同，要分開講。
   */
  inactive?: boolean
}

/** 側欄名字＝指路用的名字（⛔ 跟 `app/layouts/default.vue` 對齊，別自己另取） */
export const CONFIG_REF_KIND_LABEL: Record<ConfigRefKind, string> = {
  flow: '機器人模組',
  richmenu: '圖文選單',
  script: '自動回應',
  campaign: '活動標籤',
  broadcast: '推播',
  supportPreset: '客服預存',
}

/** 這一類引用「是怎麼用到它的」，講給第一次看的人聽 */
export const CONFIG_REF_KIND_HINT: Record<ConfigRefKind, string> = {
  flow: '別的模組上有按鈕指到這裡',
  richmenu: '聊天室下方選單的某一格',
  script: '客人講到某些話就會走到這裡',
  campaign: '客人點活動連結、加好友之後',
  broadcast: '主動群發時用到',
  supportPreset: '客服送出預存回覆時',
}

/**
 * 哪幾種頁面吃得到 `?id=`（＝連結按下去會**直接打開那一筆**，不是只把人丟在清單上）。
 *
 * ⛔ **沒做的頁面絕對不要先加進來**：帶一個那頁根本不看的參數，人點過去還是落在清單上，
 *    卻會以為自己按錯了。`D-86` 先做了機器人模組那一頁（`openFlowFromQuery`），
 *    其餘五頁維持只連到頁面——要加的時候，先讓那一頁真的吃 `?id=`，再改這裡。
 */
const KINDS_WITH_DEEP_LINK: ReadonlySet<ConfigRefKind> = new Set<ConfigRefKind>(['flow'])

export function configRefPath(workspaceId: string, kind: ConfigRefKind, id?: string): string {
  const page: Record<ConfigRefKind, string> = {
    flow: 'flow',
    richmenu: 'richmenu',
    script: 'ai-scripts',
    campaign: 'campaigns',
    broadcast: 'broadcasts',
    supportPreset: 'support-presets',
  }
  const base = `/admin/${workspaceId}/${page[kind]}`
  return id && KINDS_WITH_DEEP_LINK.has(kind)
    ? `${base}?id=${encodeURIComponent(id)}`
    : base
}

/** 這一類的名字點得進去嗎（＝連到那一筆，不只是那一頁） */
export function configRefKindIsDeepLinkable(kind: ConfigRefKind): boolean {
  return KINDS_WITH_DEEP_LINK.has(kind)
}

/**
 * 深走訪找出所有被引用的**標籤** id。
 *
 * 認四種形態（⛔ 少認一種就會少報一批）：
 *   1. 已編碼的 postback 字串（圖文選單存這個）：`triggerModule=...&tags=`、`switchMenu=...&tags=`、`triggerMessage=<json>`
 *   2. `tagging: { enabled, addTagIds }`（模組按鈕、圖文選單格子、客服預存）
 *   3. `{ type: 'tag', addTagIds }`（自動回應的貼標步驟）
 *   4. 任何 `tagIds` 陣列（活動的 `tagIds`、推播的 `audienceSource.tagIds`）
 *
 * ⚠️ **`tagging.enabled === false` 不算「用到」**：那是「存著但不會執行」，
 *    把它算進去的話，停用前的警告會講出一堆其實不會發生的事，人就不會再看那個警告了。
 *    （但它仍然會讓編輯器印出一串 UUID——那件事由畫面端處理，不是這裡。）
 */
export function collectTagRefs(value: unknown, out: Set<string> = new Set()): Set<string> {
  const add = (ids: Iterable<string>) => {
    for (const raw of ids) {
      const id = String(raw ?? '').trim()
      if (id) out.add(id)
    }
  }

  if (typeof value === 'string') {
    if (value.startsWith(TRIGGER_MODULE_PREFIX)) add(parseTriggerModuleData(value).tagIds)
    else if (value.startsWith(SWITCH_MENU_PREFIX)) add(parseSwitchMenuData(value).tagIds)
    else if (value.startsWith(TRIGGER_MESSAGE_PREFIX)) add(parseTriggerMessageData(value).tagIds)
    return out
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTagRefs(item, out)
    return out
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>

    // ⛔ tagging 這一格要先自己處理（要看 enabled），處理完就不再往下走同一個鍵，
    //    否則下面那條通用的 addTagIds 規則會把「存著但關掉」的也算進來。
    const tagging = obj.tagging as Record<string, unknown> | undefined
    if (tagging && typeof tagging === 'object') {
      if (tagging.enabled === true && Array.isArray(tagging.addTagIds)) {
        add(tagging.addTagIds as string[])
      }
    }

    for (const key of Object.keys(obj)) {
      if (key === 'tagging') continue
      if ((key === 'tagIds' || key === 'addTagIds') && Array.isArray(obj[key])) {
        add(obj[key] as string[])
        continue
      }
      collectTagRefs(obj[key], out)
    }
  }

  return out
}

export interface ConfigReferenceIndex {
  /** moduleId → 有誰會叫出它 */
  modules: Record<string, ConfigRef[]>
  /** tagId → 有誰會貼它／用它挑人 */
  tags: Record<string, ConfigRef[]>
  /**
   * ⛔ **三態鐵律**：哪幾類這次**查不到**（不是「沒有」）。
   * 唯讀路徑把錯誤 catch 掉再回空值，會讓整類東西從畫面靜靜消失
   * （這個 repo 已經發生過好幾次）。畫面看到這個陣列非空時要講「有幾類查不到」。
   */
  failedKinds: ConfigRefKind[]
}

export function emptyReferenceIndex(): ConfigReferenceIndex {
  return { modules: {}, tags: {}, failedKinds: [] }
}

/** 把一筆引用記進索引（同一個來源對同一個目標只記一次） */
export function addConfigRef(
  index: Record<string, ConfigRef[]>,
  targetId: string,
  ref: ConfigRef,
): void {
  const id = String(targetId ?? '').trim()
  if (!id) return
  const list = index[id] ?? (index[id] = [])
  if (list.some(r => r.kind === ref.kind && r.id === ref.id)) return
  list.push(ref)
}

/**
 * 把一份引用清單講成一句人話，例如
 * 「自動回應 2 條、圖文選單 1 格」。
 *
 * ⛔ 空清單回空字串，由呼叫端決定要說「還沒有任何地方會用到它」還是別的——
 *    在這裡硬寫一句話，兩個呼叫端就會被迫共用同一種語氣。
 */
export function summarizeConfigRefs(refs: ConfigRef[]): string {
  if (!refs.length) return ''
  const order: ConfigRefKind[] = ['script', 'richmenu', 'flow', 'campaign', 'broadcast', 'supportPreset']
  const counts = new Map<ConfigRefKind, number>()
  for (const ref of refs) counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1)
  return order
    .filter(kind => counts.has(kind))
    .map(kind => `${CONFIG_REF_KIND_LABEL[kind]} ${counts.get(kind)}`)
    .join('、')
}
