/**
 * 「這些標籤是不是這個帳號的」——貼標、存客服預存時共用的一道過濾（`G-98`，2026-09-29 權限盤點）。
 *
 * 為什麼要有：貼標的幾條路（單人貼、批次貼、`addTagsToUser`、客服預存上設定的貼標）原本都照收
 * 任意 tagId。知道別家標籤的 id，就能把它貼到自家客人身上，好友頁再把那顆標籤的名字、顏色讀出來。
 * 規則跟全站一樣：**知道 id 不等於碰得到別家的資料**。
 *
 * - 只看「存在、而且 workspaceId 是這一家」。⛔ 不看 status：標籤刪除是軟刪除（改成 inactive，
 *   見 `tag/[id].delete.ts`），既有的貼標路徑本來就收停用的標籤，這裡不順手改掉那個行為。
 * - 被丟掉的要說得出是哪幾顆、為什麼（見記憶 `feedback_filters_must_report_what_they_dropped`）。
 *   ⛔ 但回給前端時「不存在」與「別家的」要併成同一種說法——分開講等於告訴對方「別家有這顆」
 *   （盤點報告 §3-4 第 9 點同一個理由）。細分的原因只進伺服器 log。
 */
import type { Firestore } from 'firebase-admin/firestore'

/** invalid＝根本不是合法的文件 id；not_found＝沒有這顆；other_workspace＝是別家的 */
export type DroppedTagReason = 'invalid' | 'not_found' | 'other_workspace'

export interface DroppedTag {
  tagId: string
  reason: DroppedTagReason
}

export interface WorkspaceTagFilterResult {
  /** 這一家的標籤，照輸入順序、去重 */
  kept: string[]
  dropped: DroppedTag[]
  /**
   * kept 裡每顆的名稱（寫稽核摘要用）。
   * ⚠️ 走快取命中的那幾顆**沒有**名字（快取只記歸屬），要名字的呼叫端不要開快取。
   */
  names: Record<string, string>
}

/** 一次 getAll 幾顆：跟 users/list.get 的主鍵直讀同一個量級，不會撞到請求大小上限 */
const GETALL_CHUNK = 300

/**
 * Firestore 文件 id 的硬規則：含 `/` 會被當成路徑、`.`／`..` 與 `__x__` 是保留字。
 * ⛔ 不先擋的話 `.doc()`／`getAll` 會直接丟例外，一顆亂填的 id 就讓整支端點回 500。
 */
function isValidDocId(id: string): boolean {
  if (!id || id.length > 1500) return false
  if (id.includes('/')) return false
  if (id === '.' || id === '..') return false
  if (/^__.*__$/.test(id)) return false
  return true
}

/**
 * 標籤歸屬的快取：tagId → workspaceId。
 *
 * 為什麼可以快取：**一顆標籤屬於哪一家，建立之後就不會變**（沒有任何路徑會改 tags.workspaceId），
 * 所以快取的只是一個不會過期的事實；會變的只有「還在不在」，而標籤是軟刪除、文件一直都在。
 * 為什麼要快取：`addTagsToUser` 在熱路徑上——客人按一次圖文選單、推播完成貼標每一位收件人
 * 各呼叫一次。不快取的話，發給 5,000 人的推播就多 5,000 次讀取（08-11 讀取費暴衝的形狀）。
 * ⛔ 只記「存在」的；查不到的不記，免得標籤剛建好就被記成不存在。
 */
const OWNER_CACHE_TTL_MS = 10 * 60 * 1000
const OWNER_CACHE_MAX = 5000
const ownerCache = new Map<string, { workspaceId: string, expiresAt: number }>()

/** 測試用：清掉歸屬快取 */
export function clearTagOwnerCache(): void {
  ownerCache.clear()
}

function rememberOwner(tagId: string, workspaceId: string): void {
  // 上限到了整包清掉重來：歸屬重讀一次只是一次讀取，比無上限長大安全（盤點報告 §3-3 的同一種坑）
  if (ownerCache.size >= OWNER_CACHE_MAX) ownerCache.clear()
  ownerCache.set(tagId, { workspaceId, expiresAt: Date.now() + OWNER_CACHE_TTL_MS })
}

/**
 * 把 tagIds 過濾成「這個帳號自己的標籤」。
 *
 * @param opts.cache 熱路徑（`addTagsToUser`）才開；後台端點每次都讀最新的，順便拿名字寫稽核。
 * @param opts.context 寫進 log 的來源（哪個模組／哪支端點），查「是誰設錯了」時靠它
 */
export async function filterWorkspaceTagIds(
  db: Firestore,
  workspaceId: string,
  rawTagIds: unknown,
  opts: { cache?: boolean, context?: string } = {},
): Promise<WorkspaceTagFilterResult> {
  const kept: string[] = []
  const dropped: DroppedTag[] = []
  const names: Record<string, string> = {}
  const list = Array.isArray(rawTagIds) ? rawTagIds : []

  // 去重＋先擋掉不合法的 id（照輸入順序）
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const raw of list) {
    const id = String(raw ?? '').trim()
    if (seen.has(id)) continue
    seen.add(id)
    if (!isValidDocId(id)) {
      dropped.push({ tagId: id.slice(0, 100), reason: 'invalid' })
      continue
    }
    candidates.push(id)
  }

  const owner = new Map<string, string | null>()
  const now = Date.now()
  const toRead: string[] = []
  for (const id of candidates) {
    const hit = opts.cache ? ownerCache.get(id) : undefined
    if (hit && hit.expiresAt > now) owner.set(id, hit.workspaceId)
    else toRead.push(id)
  }

  for (let i = 0; i < toRead.length; i += GETALL_CHUNK) {
    const ids = toRead.slice(i, i + GETALL_CHUNK)
    const snaps = await db.getAll(...ids.map(id => db.collection('tags').doc(id)))
    for (const s of snaps) {
      if (!s.exists) {
        owner.set(s.id, null)
        continue
      }
      const data = s.data() as { workspaceId?: unknown, name?: unknown } | undefined
      const ws = String(data?.workspaceId ?? '')
      owner.set(s.id, ws)
      if (ws === workspaceId) names[s.id] = String(data?.name ?? '')
      if (opts.cache && ws) rememberOwner(s.id, ws)
    }
  }

  for (const id of candidates) {
    const ws = owner.get(id)
    if (ws === workspaceId) kept.push(id)
    else dropped.push({ tagId: id, reason: ws ? 'other_workspace' : 'not_found' })
  }

  if (dropped.length) {
    console.warn(
      `[tags] ${workspaceId}${opts.context ? `（${opts.context}）` : ''} 收到 ${dropped.length} 顆不是這個帳號的標籤：`,
      dropped.slice(0, 20).map(d => `${d.tagId}(${d.reason})`).join(', '),
    )
  }

  return { kept, dropped, names }
}

/**
 * 存設定（客服預存…）時用：選的標籤只要有一顆不是這個帳號的，整筆 400 擋下。
 *
 * 為什麼存的時候就擋、不是留到貼標時才過濾：貼標那一刻（客服按送出）是靜靜少貼一顆，
 * 沒有人看得到；存的當下擋，按儲存的人立刻知道要重選。
 * ⛔ 訊息不分「別家的」與「不存在」（同檔頭：分開講等於告訴對方別家有這顆）。
 * 沒選任何標籤就不讀資料庫。
 */
export async function assertWorkspaceTagIds(
  db: Firestore,
  workspaceId: string,
  tagIds: string[],
  context: string,
): Promise<void> {
  if (!tagIds.length) return
  const { dropped } = await filterWorkspaceTagIds(db, workspaceId, tagIds, { context })
  if (dropped.length) {
    throw createError({
      statusCode: 400,
      statusMessage: `選的標籤有 ${dropped.length} 個找不到（可能已被刪除，或不是這個帳號的），請重新選擇標籤後再儲存`,
    })
  }
}

/**
 * 批次貼標／拆標寫稽核時的那串標籤名（`G-107`）：「「VIP」「回購」」、太多就「……等 12 個」。
 *
 * ⛔ 只記前幾顆的名字、不整串塞：稽核值超過 500 字或 50 項會被截斷並標成 lossy
 *    （見記憶 `project_audit_log_coverage_20260924`「紀錄只存摘要」）。
 * 名字讀不到（空字串）的退回 id，⛔ 不要印成空白引號——那會讓人以為紀錄壞了。
 */
export function tagNamesForAudit(tagIds: string[], names: Record<string, string>, max = 5): string {
  const shown = tagIds.slice(0, max).map(id => `「${String(names[id] || id).slice(0, 30)}」`).join('')
  return tagIds.length > max ? `${shown}等 ${tagIds.length} 個標籤` : shown
}
