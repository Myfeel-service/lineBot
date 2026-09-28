/**
 * 刪除確認框要講的話（`D-110` ④，2026-09-29 拍板）。
 *
 * **拍板內容**：正在被用的模組／活動／圖文選單，客服照樣可以刪，但確認框要先講清楚
 * **是誰在用它、刪掉之後什麼會壞**。例：「這個模組被 2 個圖文選單、1 條自動回應用到。
 * 刪掉之後，客人按那些按鈕會沒反應。」沒有人用的就維持原本那句簡單的確認。
 *
 * **為什麼抽成純函式**：三個頁面（模組、活動、圖文選單）要講同一種話。各頁自己拼字串，
 * 遲早一頁講「2 顆」、一頁講「2 個」，一頁有截斷、一頁把 30 個名字全塞進確認框。
 *
 * ⛔ **只講會壞的事**：停用中的設定、已經送出的推播都不算「在用」——
 *    把它們也列進來，確認框每次都會講一堆其實不會發生的事，人就不會再讀它了。
 *    （它們在模組頁「客人會從 N 個地方走到這裡」的浮層裡照樣看得到，標「停用中」；
 *    之後有人把那條自動回應／那個活動重新啟用，異常中心的壞按鈕檢查會接手。）
 * ⛔ **三態**：查不到不等於沒有人用。查不到的時候也要走「仍要刪除」那一種，
 *    措辭講「沒辦法確定」，不可以退回簡單確認——那等於默認沒有人用。
 * ⛔ 純文字：ElMessageBox 不解析 HTML，名字是使用者自己打的，**不要**改用
 *    `dangerouslyUseHTMLString` 來排版；`\n` 在確認框裡也會被收成空白，所以整段是一段話。
 */
import {
  CONFIG_REF_KIND_LABEL,
  CONFIG_REF_KIND_ORDER,
  type ConfigRef,
  type ConfigRefKind,
} from './config-references'
import { parseSwitchMenuData } from './action-schema'

/** 同一種「用到它的地方」，合併成一組講 */
export interface DeleteImpactGroup {
  /** 「被 ___ 用到」中間那一段，例如「2 個圖文選單」 */
  countText: string
  /** 這一組的名字，給人認得是哪幾個（只列前幾個，其餘講「等 N 個」） */
  names: string[]
  /** 刪掉之後這一組會怎樣，例如「客人按那些按鈕會沒反應」。好幾組同一句只講一次 */
  effect: string
}

export interface DeleteImpactInput {
  /** 要刪的那一個的名字 */
  name: string
  /** 沒有任何影響時用的那句簡單確認（各頁原本那句，原樣保留） */
  plainMessage: string
  groups?: DeleteImpactGroup[]
  /**
   * 不是「被誰用到」、但要先講的事實，一句一句（不含句號），接在「被誰用到」那句後面。
   * 例：圖文選單「「主選單」是所有好友現在看到的選單」。
   * ⚠️ 沒有 `groups` 時這幾句就是開場，所以要自己帶名字；有了事實，後面「刪掉之後」不再重複名字。
   */
  facts?: string[]
  /** 不屬於任何一組、但刪掉之後會發生的事（不含句號），接在各組的後果後面 */
  effects?: string[]
  /**
   * 這次**查不到**的類別名稱（例如「自動回應」）。
   * 有值就一定走「仍要刪除」那一種：查不到不等於沒有人用。
   */
  unknownKinds?: string[]
  /** 比較安全的做法，一句話（含句號）。只在確實存在那條路時才給 */
  saferAlternative?: string
}

export interface DeleteConfirmCopy {
  /** true＝有東西會壞、或查不到——按鈕換成「仍要刪除／先不要」 */
  hasImpact: boolean
  message: string
  confirmButtonText: string
  cancelButtonText: string
}

/** 名字最多列幾個。⛔ 超過的講「等 N 個」，不可以安靜少列 */
export const DELETE_IMPACT_MAX_NAMES = 3

function quote(name: string): string {
  const trimmed = String(name ?? '').trim()
  return trimmed ? `「${trimmed}」` : '「（未命名）」'
}

/** 「「主選單」、「會員選單」、「查詢訂單」等 7 個」——「等 N 個」的 N 是總數（中文的讀法） */
function namesText(names: string[]): string {
  const shown = names.slice(0, DELETE_IMPACT_MAX_NAMES).map(quote).join('、')
  return names.length > DELETE_IMPACT_MAX_NAMES ? `${shown}等 ${names.length} 個` : shown
}

export function buildDeleteConfirmCopy(input: DeleteImpactInput): DeleteConfirmCopy {
  const groups = (input.groups ?? []).filter(g => g.names.length > 0)
  const facts = (input.facts ?? []).map(s => s.trim()).filter(Boolean)
  const unknownKinds = (input.unknownKinds ?? []).filter(Boolean)
  const effects: string[] = []
  for (const effect of [...groups.map(g => g.effect), ...(input.effects ?? [])]) {
    const e = effect.trim()
    if (e && !effects.includes(e)) effects.push(e)
  }

  const hasImpact = groups.length > 0 || facts.length > 0 || effects.length > 0 || unknownKinds.length > 0
  if (!hasImpact) {
    return { hasImpact: false, message: input.plainMessage, confirmButtonText: '刪除', cancelButtonText: '取消' }
  }

  const name = quote(input.name)
  const parts: string[] = []
  /** 名字講過了沒——講過了，後面的「刪掉之後」就不用再重複一次名字 */
  let named = false

  if (groups.length) {
    const names = groups.flatMap(g => g.names)
    const counts = groups.map(g => g.countText).join('、')
    // 數字前後留半形空白（全站寫法：「有 3 個」）；開頭不是數字就不留
    const gap = /^\d/.test(counts) ? ' ' : ''
    parts.push(`${name}被${gap}${counts}用到（${namesText(names)}）。`)
    named = true
  }
  else if (unknownKinds.length) {
    parts.push(`這次查不到有哪些地方用到${name}，沒辦法確定刪掉會不會影響客人。`)
    named = true
  }

  for (const fact of facts) parts.push(`${fact}。`)
  // 事實那幾句本來就在講「它」（呼叫端自己帶名字），後面不用再點一次名
  if (facts.length) named = true

  if (effects.length) {
    parts.push(`${named ? '刪掉之後' : `刪掉${name}之後`}，${effects.join('，')}。`)
  }

  // 找到了一部分、另一部分沒查到：已經講的是真的，但不是全部
  if (groups.length && unknownKinds.length) {
    parts.push(`另外，${unknownKinds.join('、')}這次沒查到，可能還有別的地方用到它。`)
  }

  if (input.saferAlternative?.trim()) parts.push(input.saferAlternative.trim())

  return { hasImpact: true, message: parts.join(''), confirmButtonText: '仍要刪除', cancelButtonText: '先不要' }
}

// ── 機器人模組 ────────────────────────────────────────────────────────────

/**
 * 模組被刪之後，每一類引用會怎樣。
 *
 * ⚠️ 量詞跟著「一筆設定」走，不是跟著按鈕：引用索引（`server/utils/config-references.ts`）
 *    同一個來源對同一個模組只記一次，一張圖文選單有三格指過來也只算 1 個圖文選單。
 *    講成「3 顆按鈕」會跟浮層裡的數字對不上。
 * ⚠️ 後果是照執行端實際的行為寫的（別憑印象改）：
 *    - 圖文選單／模組按鈕：postback 找不到模組，客人什麼都收不到（`broken-module-refs.ts` 開頭）
 *    - 自動回應：「機器人模組」那一步送不出東西就結束（`ai-scripts.ts` 的 module 節點）
 *    - 活動：加好友後照樣貼標，但那則訊息送不出去（`handler.ts` 的 applyPendingClaims）
 *    - 推播：送出時找不到模組直接失敗（`broadcast-send.ts`）
 *    - 客服預存：按送出會跳「找不到或已停用的機器人模組」（`pushSupportPresetActionToUser`）
 */
const MODULE_REF_WORDING: Record<ConfigRefKind, { count: (n: number) => string, effect: string }> = {
  script: { count: n => `${n} 條自動回應`, effect: '自動回應走到這一步會沒有回覆' },
  richmenu: { count: n => `${n} 個圖文選單`, effect: '客人按那些按鈕會沒反應' },
  flow: { count: n => `${n} 個模組的按鈕`, effect: '客人按那些按鈕會沒反應' },
  campaign: { count: n => `${n} 個活動`, effect: '客人從活動加好友後收不到這則' },
  broadcast: { count: n => `${n} 則推播`, effect: '推播會送不出去' },
  supportPreset: { count: n => `${n} 則客服預存`, effect: '客服按那則預存會送不出去' },
}

/**
 * 模組的刪除確認。
 *
 * @param refs 引用索引裡指到這個模組的那幾筆（`ConfigReferenceIndex.modules[id]`）
 * @param failedKinds 這次查不到的類別（`ConfigReferenceIndex.failedKinds`）
 */
export function moduleDeleteConfirmCopy(input: {
  name: string
  refs: ConfigRef[]
  failedKinds: ConfigRefKind[]
}): DeleteConfirmCopy {
  // ⛔ 停用中的不算（見檔頭）：它們現在沒有在服務客人，刪掉也不會有人撲空
  const live = input.refs.filter(ref => !ref.inactive)
  const groups: DeleteImpactGroup[] = CONFIG_REF_KIND_ORDER
    .map((kind) => {
      const items = live.filter(ref => ref.kind === kind)
      return {
        countText: MODULE_REF_WORDING[kind].count(items.length),
        names: items.map(ref => ref.label),
        effect: MODULE_REF_WORDING[kind].effect,
      }
    })
    .filter(group => group.names.length > 0)

  return buildDeleteConfirmCopy({
    name: input.name,
    plainMessage: `確定刪除${quote(input.name)}？`,
    groups,
    // 查不到時講類別名，⛔ 跟側欄同名（`CONFIG_REF_KIND_LABEL`），別自己另取
    unknownKinds: input.failedKinds.map(kind => CONFIG_REF_KIND_LABEL[kind] ?? String(kind)),
  })
}

// ── 活動 ──────────────────────────────────────────────────────────────────

/**
 * 活動的刪除確認。
 *
 * 刪掉活動＝已經發出去的連結失效：客人點連結時的「活動停用了沒」檢查
 * （`server/utils/lead-campaign-active.ts`）遇到**查不到活動**一律當成已結束（`G-108`，2026-09-29）。
 * ⚠️ 在那之前是放行的——刪掉停用中的活動，本來點不開的連結會重新點得開；這支的文案曾經照實講那件事。
 *    兩邊要一起改：哪天那支又改回放行，這裡的「會失效」就變成假話。
 * 還要講的是**救不回來**：連結跟成效數字都不會回來，想暫停的人該用「停用」。
 *
 * @param hasPublishedLink 這個活動產過連結沒（`publishedCtaUrl`；停用中也會保留）
 * @param isActive **存起來的**啟用狀態，⛔ 不是畫面上還沒存的開關
 * @param boundCount 從這個活動綁定過的人數（成效區那兩格相加）；`null`＝還沒載入／查不到，這時不講數字
 */
export function campaignDeleteConfirmCopy(input: {
  name: string
  hasPublishedLink: boolean
  isActive: boolean
  boundCount: number | null
}): DeleteConfirmCopy {
  const effects: string[] = []
  // 停用中的活動，連結本來就點不開了——只有啟用中的才有「會失效」這件新鮮事可講
  if (input.hasPublishedLink && input.isActive) {
    effects.push('已經發出去的連結會失效，客人點進去會看到活動已結束')
  }
  if (input.boundCount != null && input.boundCount > 0) {
    effects.push(`已綁定 ${input.boundCount} 人的成效數字也看不到了`)
  }

  // 只是想先暫停的人，停用就好：連結一樣點不開，但活動與數字都留著、隨時開得回來
  const saferAlternative = input.hasPublishedLink && input.isActive
    ? '只是想先暫停的話，把「啟用狀態」關掉再儲存就好，之後還開得回來。'
    : undefined

  return buildDeleteConfirmCopy({
    name: input.name,
    plainMessage: `確定刪除${quote(input.name)}？此操作無法復原。`,
    effects,
    saferAlternative,
  })
}

// ── 圖文選單 ──────────────────────────────────────────────────────────────

interface RichMenuLike {
  id: string
  name?: string
  aliasId?: string | null
  areas?: Array<{ action?: { type?: string, data?: unknown, richMenuAliasId?: unknown } }>
}

/**
 * 別的圖文選單裡，有哪幾張有「切換到 target」的按鈕（回那幾張的名字）。
 *
 * 兩種存法都要認：舊的 `postback` + `switchMenu=<目標選單 id>`，以及發佈後的
 * `richmenuswitch` + 別名（`richMenuAliasId`，data 裡通常也帶著 `switchMenu=<id>`）。
 * ⛔ 只認一種會漏：同一個帳號裡兩種都有（看存檔時走哪條路）。
 */
export function richMenusSwitchingTo(target: RichMenuLike, menus: RichMenuLike[]): string[] {
  const alias = String(target.aliasId ?? '').trim()
  const names: string[] = []
  for (const m of menus) {
    if (m.id === target.id) continue
    const hit = (m.areas ?? []).some((a) => {
      const action = a?.action
      if (!action) return false
      if (alias && action.type === 'richmenuswitch' && String(action.richMenuAliasId ?? '').trim() === alias) return true
      return parseSwitchMenuData(String(action.data ?? '')).targetMenuId === target.id
    })
    if (hit) names.push(String(m.name ?? '').trim() || '未命名選單')
  }
  return names
}

/**
 * 圖文選單的刪除確認。
 *
 * @param isDefault 是不是所有好友現在看到的那一張（刪掉＝聊天室下方的選單消失）
 * @param switchedFrom 有按鈕會切到它的其他選單名字（`richMenusSwitchingTo`）
 * @param listIncomplete 選單清單沒載完（分頁）→ 別張可能還有切到它的按鈕，⛔ 不可以當成沒有
 */
export function richMenuDeleteConfirmCopy(input: {
  name: string
  isDefault: boolean
  switchedFrom: string[]
  listIncomplete: boolean
}): DeleteConfirmCopy {
  const groups: DeleteImpactGroup[] = input.switchedFrom.length
    ? [{
        countText: `${input.switchedFrom.length} 個圖文選單的切換按鈕`,
        names: input.switchedFrom,
        effect: '客人按那些切換按鈕會沒反應',
      }]
    : []
  return buildDeleteConfirmCopy({
    name: input.name,
    plainMessage: `確定刪除${quote(input.name)}？此動作無法復原。`,
    groups,
    facts: input.isDefault ? [`${quote(input.name)}是所有好友現在看到的選單`] : [],
    effects: input.isDefault ? ['好友聊天室下方的選單會消失'] : [],
    unknownKinds: input.listIncomplete ? ['還沒載入的圖文選單'] : [],
  })
}
