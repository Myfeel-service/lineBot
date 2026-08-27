import { capMapSize } from './bounded-cache'
import { SCRIPTS_COLLECTION } from './ai-scripts'
import { encodeTriggerModule, TRIGGER_MODULE_PREFIX, parseTriggerModuleData } from '~~/shared/action-schema'

/**
 * 「空按鈕」靜態檢查：找出圖文選單／圖卡／關鍵字自動回覆／活動上指向
 * **已刪除或已停用**模組的按鈕或動作。
 *
 * 為什麼用靜態檢查而不是「記錄誰按到了」：
 *   - 事前發現，不用等客人踩到才知道（客人按了沒反應是不會回報的）
 *   - 零額外寫入，設定資料本來就在，只是拿去對一遍
 *   - 給的是可以直接修的答案（哪個選單／哪個模組），不是一個統計數字
 *
 * 佇列那邊刻意不動：客人按了空按鈕、真的什麼都沒收到，那筆留在「未首接」是對的
 * （需要人看一眼）。用佇列傳達「有東西壞了」才是錯的管道——所以壞掉的根因走這裡。
 */

export interface BrokenModuleRef {
  /** 被指向、但撈不到內容的模組 ID */
  moduleId: string
  /** 引用它的地方（圖文選單／模組／規則／活動名稱），給使用者直接找到要修哪裡 */
  sourceLabel: string
  sourceKind: 'richmenu' | 'flow' | 'script' | 'campaign'
  /** missing = 模組被刪了；inactive = 模組還在但停用了 */
  reason: 'missing' | 'inactive'
}

/**
 * 這份結果只在有人編輯選單／模組時才會變，但異常中心是被輪詢的端點。
 * 沒有快取的話每次輪詢都要整批讀 flows + richmenus（幾十筆），
 * 違背 alerts.get.ts 自己訂的「健康的工作區成本趨近於零」原則。
 */
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 50
const cache = new Map<string, { data: ModuleGraphScan; expires: number }>()

export interface ModuleGraphScan {
  refs: BrokenModuleRef[]
  /**
   * 這個工作區的所有模組（掃描過程本來就讀了 flows，順手回出來）。
   *
   * ⛔別再另外查一次 `flows` 拿名稱或白名單：修復端點原本那樣做，除了多一趟讀取，
   * 還因為那一趟帶了 `limit(200)` 而與這裡的全量掃描對不上——模組多的工作區會出現
   * 「異常說它壞了，但清單裡查不到它的名字、也挑不到要指過去的那個模組」。
   */
  modules: { id: string; name: string; isActive: boolean }[]
}

/**
 * 深掃任意 JSON 找出所有被引用的模組 ID。
 *
 * 刻意用通用走訪而不是照結構逐層取：訊息內容是 any[]，模組引用可能藏在輪播欄、
 * imagemap 區塊、flex、quick reply 等任何深度，寫死結構一定會漏。兩種形態都認：
 *   - 已編碼的 postback 字串：'triggerModule=<id>&tags=...'（圖文選單存這個）
 *   - 未編碼的動作物件：{ type: 'module', moduleId: '<id>' }（模組訊息存這個，送出時才編碼）
 */
export function collectModuleRefs(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (value.startsWith(TRIGGER_MODULE_PREFIX)) {
      const { moduleId } = parseTriggerModuleData(value)
      if (moduleId) out.add(moduleId)
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModuleRefs(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (obj.type === 'module') {
      const id = String(obj.moduleId ?? '').trim()
      if (id) out.add(id)
    }
    for (const key of Object.keys(obj)) collectModuleRefs(obj[key], out)
  }
  return out
}

/**
 * 深走訪把「指向模組 A」的引用全部改指到 B（`C-87` 壞按鈕代改）。
 *
 * 與 collectModuleRefs **同一套走訪、認同兩種形態**——找得到的就改得掉，兩邊分開寫
 * 遲早出現「偵測說壞在這、代改卻改不到」：
 *   - 已編碼的 postback 字串：parse 後用 encodeTriggerModule 重組，**tags 原樣保留**
 *   - 未編碼的動作物件：{ type: 'module', moduleId } 直接換 id
 *
 * 回傳新值與有沒有改到（沒改到＝原引用原樣回傳，呼叫端可跳過整筆寫入）。
 */
export function replaceModuleRefs(value: unknown, from: string, to: string): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.startsWith(TRIGGER_MODULE_PREFIX)) {
      const { moduleId, tagIds } = parseTriggerModuleData(value)
      if (moduleId === from)
        return { value: encodeTriggerModule(to, tagIds), changed: true }
    }
    return { value, changed: false }
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const r = replaceModuleRefs(item, from, to)
      if (r.changed) changed = true
      return r.value
    })
    return { value: changed ? next : value, changed }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    let changed = false
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      const r = replaceModuleRefs(obj[key], from, to)
      next[key] = r.value
      if (r.changed) changed = true
    }
    if (obj.type === 'module' && String(obj.moduleId ?? '').trim() === from) {
      next.moduleId = to
      changed = true
    }
    return { value: changed ? next : value, changed }
  }
  return { value, changed: false }
}

/** 只要壞掉的引用（異常中心用；快取共用同一份掃描結果） */
export async function findBrokenModuleRefs(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<BrokenModuleRef[]> {
  return (await scanModuleGraph(db, workspaceId)).refs
}

/**
 * 掃一次「誰指向誰、被指的還在不在」。修復端點用 `skipCache`——人剛改完回頭驗證，
 * 拿五分鐘內的舊答案會一直說「還沒好」。
 */
export async function scanModuleGraph(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  opts: { skipCache?: boolean } = {},
): Promise<ModuleGraphScan> {
  const cached = opts.skipCache ? null : cache.get(workspaceId)
  if (cached && cached.expires > Date.now()) return cached.data

  // 一次把 flows 撈回來就同時拿到「誰引用了誰」和「被引用的還在不在／停用了沒」，
  // 不需要為了查存在性再逐筆讀。客服腳本與活動也會指向模組：
  // 指到已刪模組時，客人打觸發詞／掃活動碼一樣什麼都收不到。
  const [flowsSnap, menusSnap, scriptsSnap, campaignsSnap] = await Promise.all([
    db.collection('flows').where('workspaceId', '==', workspaceId).get(),
    db.collection('richmenus').where('workspaceId', '==', workspaceId).get(),
    db.collection(SCRIPTS_COLLECTION).where('workspaceId', '==', workspaceId).get(),
    db.collection('leadCampaigns').where('workspaceId', '==', workspaceId).get(),
  ])

  const flowById = new Map<string, { name: string; isActive: boolean }>()
  for (const d of flowsSnap.docs) {
    const data = d.data() as Record<string, unknown>
    flowById.set(d.id, {
      name: String(data.name ?? '(未命名模組)'),
      // 與 getFlowByModuleId 同一把尺：isActive 為真才撈得到內容
      isActive: data.isActive === true,
    })
  }

  const broken: BrokenModuleRef[] = []
  const seen = new Set<string>()

  const check = (moduleId: string, sourceLabel: string, sourceKind: BrokenModuleRef['sourceKind']) => {
    const target = flowById.get(moduleId)
    if (target?.isActive) return
    // 同一個壞模組被多處引用時各報一筆（要修的地方不只一個）
    const key = `${sourceKind}:${sourceLabel}:${moduleId}`
    if (seen.has(key)) return
    seen.add(key)
    broken.push({
      moduleId,
      sourceLabel,
      sourceKind,
      reason: target ? 'inactive' : 'missing',
    })
  }

  for (const d of menusSnap.docs) {
    const data = d.data() as Record<string, unknown>
    const label = String(data.name ?? '(未命名選單)')
    for (const moduleId of collectModuleRefs(data.areas)) check(moduleId, label, 'richmenu')
  }

  for (const d of flowsSnap.docs) {
    const data = d.data() as Record<string, unknown>
    const label = String(data.name ?? '(未命名模組)')
    for (const moduleId of collectModuleRefs(data.messages)) {
      // 自我引用不算壞（模組指回自己在編輯中可能短暫出現）
      if (moduleId === d.id) continue
      check(moduleId, label, 'flow')
    }
  }

  // 客服腳本的「機器人模組」步驟：停用中的腳本指向壞模組無害，只掃啟用的
  for (const d of scriptsSnap.docs) {
    const data = d.data() as Record<string, unknown>
    if (data.enabled === false) continue
    const label = String(data.name ?? '(未命名流程)')
    for (const node of (Array.isArray(data.nodes) ? data.nodes : []) as Array<Record<string, unknown>>) {
      if (node?.type !== 'module') continue
      const moduleId = typeof node.moduleId === 'string' ? node.moduleId.trim() : ''
      if (moduleId) check(moduleId, label, 'script')
    }
  }

  // 活動（領取行銷模組）：moduleId 是頂層欄位，不用深掃
  for (const d of campaignsSnap.docs) {
    const data = d.data() as Record<string, unknown>
    if (data.isActive === false) continue
    const moduleId = typeof data.moduleId === 'string' ? data.moduleId.trim() : ''
    if (moduleId) check(moduleId, String(data.name ?? '(未命名活動)'), 'campaign')
  }

  const data: ModuleGraphScan = {
    refs: broken,
    modules: [...flowById.entries()].map(([id, v]) => ({ id, name: v.name, isActive: v.isActive })),
  }
  cache.set(workspaceId, { data, expires: Date.now() + CACHE_TTL_MS })
  capMapSize(cache, CACHE_MAX_ENTRIES)
  return data
}

/** 選單／模組存檔後呼叫，讓異常中心下一次輪詢就反映最新狀態（否則最多要等 5 分鐘） */
export function invalidateBrokenModuleRefsCache(workspaceId: string): void {
  cache.delete(workspaceId)
}
