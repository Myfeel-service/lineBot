import { capMapSize } from './bounded-cache'
import { SCRIPTS_COLLECTION } from './ai-scripts'
import { collectModuleRefs } from './broken-module-refs'
import {
  addConfigRef,
  collectTagRefs,
  emptyReferenceIndex,
  type ConfigRef,
  type ConfigRefKind,
  type ConfigReferenceIndex,
} from '~~/shared/config-references'

/**
 * 掃一次「誰用了誰」：模組被哪些入口叫得出來、標籤被哪些設定貼／拿去挑人（`C-209`）。
 *
 * **為什麼要有**：後台今天沒有任何地方回答得出這兩題，於是
 *   ① 建好的模組可能**永遠不會被叫出來**，畫面上零線索
 *   ② 停用一顆標籤，用到它的地方照舊存著它的 id
 *
 * ⛔ **不另刻走訪**：模組那半直接用 `broken-module-refs.ts` 的 `collectModuleRefs`
 *    （兩種形態都認），標籤那半用 `shared/config-references.ts` 的 `collectTagRefs`。
 *    兩邊分開寫遲早出現「偵測說沒人用、實際上天天在跑」。
 *
 * **讀取成本**：一趟掃六個集合（MYFEEL 實測 flows 71＋richmenus 2＋scripts＋
 * leadCampaigns 8＋broadcasts 16＋supportPresets 10 ≈ 110 筆），結果整包快取 5 分鐘。
 * ⛔ 不可以做成「每選一個模組查一次」——那會變成每點一下就掃一輪
 * （這個專案為了讀取費才剛把 `offset()` 換成游標，別在這裡自己加回來）。
 */

/**
 * 快取 60 秒（不是 5 分鐘）。
 *
 * ⛔ **刻意不去 11 支寫入端點各掛一行 invalidate**：能改到這份索引的地方有
 * 模組、圖文選單、自動回應、活動、推播、客服預存六類、十幾支端點，
 * 少掛一支就是「畫面說沒人用、其實剛剛才加上去」——**而那種漏掉沒有任何人會發現**。
 * 改成「短 TTL ＋ 存檔後由畫面帶 `fresh=1` 重算」：忘記帶頂多晚 60 秒，
 * 不會出現永遠不更新的那一格。
 */
const CACHE_TTL_MS = 60 * 1000
const CACHE_MAX_ENTRIES = 50
const cache = new Map<string, { data: ConfigReferenceIndex; expires: number }>()

/** 每一類最多掃幾筆。⛔ 撞到上限要回報（`truncated` 由 `failedKinds` 以外的旗標帶），不可以默默少算 */
const SCAN_LIMIT = 500

interface KindSource {
  kind: ConfigRefKind
  collection: string
  /** 這一類的名稱欄位 */
  nameOf: (data: Record<string, unknown>) => string
  /** 這一筆算不算「停用中」 */
  inactiveOf: (data: Record<string, unknown>) => boolean
  /**
   * 這條路是不是已經帶不了客人進來（`ConfigRef.closed`，`C-422` ⑥）。沒給＝永遠帶得到。
   * ⛔ 只給「關掉就真的不會再觸發」的：已經送到客人聊天室的東西（模組、推播、客服預存），上面的按鈕照樣按得到。
   */
  closedOf?: (data: Record<string, unknown>) => boolean
  /** 要拿去走訪的那一塊（給 undefined 代表整份文件都掃） */
  scope?: (data: Record<string, unknown>) => unknown
}

const SOURCES: KindSource[] = [
  {
    kind: 'flow',
    collection: 'flows',
    nameOf: d => String(d.name ?? '(未命名模組)'),
    inactiveOf: d => d.isActive === false,
    scope: d => d.messages,
  },
  {
    kind: 'richmenu',
    collection: 'richmenus',
    nameOf: d => String(d.name ?? '(未命名選單)'),
    // 圖文選單沒有啟用欄位，是否為預設由 LINE 那邊決定，這裡一律當作在用
    inactiveOf: () => false,
    scope: d => d.areas,
  },
  {
    kind: 'script',
    collection: SCRIPTS_COLLECTION,
    nameOf: d => String(d.name ?? '(未命名流程)'),
    inactiveOf: d => d.enabled === false,
    // 關掉＝關鍵字不會再觸發；它帶出的快速回覆在下一則訊息後就消失，留在聊天室也按不到
    closedOf: d => d.enabled === false,
    scope: d => d.nodes,
  },
  {
    kind: 'campaign',
    collection: 'leadCampaigns',
    nameOf: d => String(d.name ?? '(未命名活動)'),
    inactiveOf: d => d.isActive === false,
    // 關掉＝活動連結失效
    closedOf: d => d.isActive === false,
  },
  {
    kind: 'broadcast',
    collection: 'broadcasts',
    nameOf: d => String(d.name ?? '(未命名推播)'),
    // 已發送／失敗／取消的推播不會再送出去，但它仍然「用到」那顆標籤（回頭看成效時要對得上）
    inactiveOf: d => d.status !== 'draft' && d.status !== 'scheduled',
    // ⛔ 只有取消的算：發完、發送中、失敗（可能送出一部分）的已經在客人聊天室，上面的按鈕照樣按得到
    closedOf: d => d.status === 'cancelled',
  },
  {
    kind: 'supportPreset',
    collection: 'supportPresets',
    nameOf: d => String(d.name ?? '(未命名預存)'),
    inactiveOf: d => d.enabled === false,
  },
]

/** 這一塊裡用到了哪幾份舊版圖文訊息（`{ type: 'richMessageRef', richMessageId }`） */
function collectRichMessageRefIds(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectRichMessageRefIds(item, out)
  }
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (obj.type === 'richMessageRef') {
      const id = String(obj.richMessageId ?? '').trim()
      if (id) out.add(id)
    }
    for (const key of Object.keys(obj)) collectRichMessageRefIds(obj[key], out)
  }
  return out
}

/**
 * 舊版圖文訊息：模組裡只存 id，上面的按鈕在 `richMessages` 那一份（`C-422` ②）。
 * 不展開的話，只被這種圖文訊息上的按鈕叫的模組會被標成「客人走不到」——店家可能就刪掉還在用的。
 * 回傳「哪一份圖文訊息的按鈕指向哪幾個模組」；查不到回 null（呼叫端要照三態處理，⛔ 不可以當成沒有按鈕）。
 */
async function loadRichMessageModuleRefs(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<{ map: Map<string, Set<string>>, truncated: boolean } | null> {
  try {
    const snap = await db.collection('richMessages').where('workspaceId', '==', workspaceId).limit(SCAN_LIMIT).get()
    const map = new Map<string, Set<string>>()
    for (const doc of snap.docs) map.set(doc.id, collectModuleRefs(doc.data()))
    return { map, truncated: snap.docs.length >= SCAN_LIMIT }
  }
  catch (e) {
    console.error('[config-references] 掃 richMessages 失敗：', e)
    return null
  }
}

export async function scanConfigReferences(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  opts: { skipCache?: boolean } = {},
): Promise<ConfigReferenceIndex> {
  const cached = opts.skipCache ? null : cache.get(workspaceId)
  if (cached && cached.expires > Date.now()) return cached.data

  const index = emptyReferenceIndex()
  const richMessagesPromise = loadRichMessageModuleRefs(db, workspaceId)

  const results = await Promise.all(SOURCES.map(async (source) => {
    try {
      const snap = await db
        .collection(source.collection)
        .where('workspaceId', '==', workspaceId)
        .limit(SCAN_LIMIT)
        .get()
      return { source, snap, ok: true as const }
    }
    catch (e) {
      /**
       * ⛔ **三態鐵律**：查不到不等於沒有。
       * 這裡如果 catch 完回空陣列，畫面就會理直氣壯地說「還沒有任何地方會叫出這個模組」，
       * 而那句話會讓人把一個正在服務客人的模組刪掉。
       */
      console.error(`[config-references] 掃 ${source.collection} 失敗：`, e)
      return { source, snap: null, ok: false as const }
    }
  }))

  const richMessages = await richMessagesPromise

  for (const { source, snap, ok } of results) {
    if (!ok || !snap) {
      index.failedKinds.push(source.kind)
      continue
    }
    if (snap.size >= SCAN_LIMIT) (index.truncatedKinds ??= []).push(source.kind)
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>
      const ref: ConfigRef = {
        kind: source.kind,
        id: doc.id,
        label: source.nameOf(data),
        ...(source.inactiveOf(data) ? { inactive: true } : {}),
        ...(source.closedOf?.(data) ? { closed: true } : {}),
      }
      const scope = source.scope ? source.scope(data) : data

      const moduleIds = collectModuleRefs(scope)
      const richIds = collectRichMessageRefIds(scope)
      if (richIds.size) {
        // ⛔ 圖文訊息那份查不到／沒掃完：這一類的「走不到」講不準，照三態標起來，不可以當成那幾份沒有按鈕
        if (!richMessages) {
          if (!index.failedKinds.includes(source.kind)) index.failedKinds.push(source.kind)
        }
        else {
          if (richMessages.truncated && !index.truncatedKinds?.includes(source.kind)) (index.truncatedKinds ??= []).push(source.kind)
          for (const rid of richIds) for (const moduleId of richMessages.map.get(rid) ?? []) moduleIds.add(moduleId)
        }
      }

      for (const moduleId of moduleIds) {
        // 模組指回自己不算「有人會叫出它」——它自己並不是一條入口
        if (source.kind === 'flow' && moduleId === doc.id) continue
        addConfigRef(index.modules, moduleId, ref)
      }
      for (const tagId of collectTagRefs(scope)) {
        addConfigRef(index.tags, tagId, ref)
      }
    }
  }

  cache.set(workspaceId, { data: index, expires: Date.now() + CACHE_TTL_MS })
  capMapSize(cache, CACHE_MAX_ENTRIES)
  return index
}
