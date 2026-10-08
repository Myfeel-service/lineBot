/**
 * 操作稽核(auditLogs):誰(人或 AI 代辦)在哪個工作區、透過哪個動作、把什麼改成什麼。
 *
 * C-31 Phase 0 的地基:在小幫手開放「代你操作」(Phase 2)之前,系統必須先能回答
 * 「這筆設定是誰改的、改前是什麼」——之前全站只有零星 createdBy,設定類改動完全查不到人。
 *
 * 設計原則:
 * - 稽核是配菜不是閘門:寫入失敗要現形(console.error),但**絕不擋業務寫入**。
 * - before/after 只存「這次有動到的欄位」(diffChangedFields),不存整份文件。
 * - 憑證類欄位(token/secret/…)一律遮罩,長字串截斷——稽核不能變成第二個外洩面。
 * - actor 區分 'human'(人在頁面操作)與 'agent'(AI 小幫手代辦,Phase 2 起使用)。
 * - 讀取端與後台 UI 是 Phase 2 之後的事;索引 (workspaceId, createdAt DESC) 已先建。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { currentAgentOpId } from './agent-op-context'
import type { AuditActor } from '~~/shared/types/audit'

export const AUDIT_LOGS_COLLECTION = 'auditLogs'

/** 命中這些字樣的欄位,值一律遮罩(不分大小寫;涵蓋 LINE 憑證與金流金鑰的命名) */
const SECRET_FIELD_RE = /(token|secret|password|credential|api_?key|hash_?key|hash_?iv)/i
const MAX_STRING = 500
const MAX_DEPTH = 4
const MAX_ARRAY = 50

export interface AuditLogInput {
  /**
   * 這筆屬於哪個官方帳號。**平台層動作（升降超管、改名單）沒有歸屬，一律傳空字串**，
   * 並改用 `scope: 'platform'`——⛔ 不要為了讓它出現在某一頁而硬塞一個 workspaceId。
   */
  workspaceId: string
  uid: string
  /**
   * human=人在頁面/端點直接操作;agent=AI 小幫手代辦(Phase 2 起);
   * system=到了時間系統自己做的（排程推播到點送出，`D-117`）——uid 傳空字串，⛔ 不掛在任何人頭上
   */
  actor: AuditActor
  /** 動作代號,慣例用端點路徑,如 'ai/settings.put'、'richmenu/setDefault' */
  action: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  note?: string
  /**
   * 這次動到的那份文件 id（流程、選單…）。
   * 2026-09-16 補：做「還原這筆」時才發現沒有它就找不到要改回哪一份——
   * 舊紀錄沒有這個欄位，所以只還原得了「整份設定型」的動作，畫面要如實說清楚。
   */
  targetId?: string
  /**
   * 組織層動作（建官方帳號、改組織發票抬頭、停用組織）動到的組織。
   * 2026-09-24 補（`C-254`）：這類動作沒有單一 workspace，但仍要查得到是誰做的。
   */
  orgId?: string
  /**
   * `platform`＝平台自己做的事（超管調額度、作廢發票、升降超管），**不屬於任何租戶**。
   * 這種紀錄不會出現在租戶的「操作紀錄」頁，只在超管的平台稽核頁看得到。
   * ⛔ 不設這個欄位就等於宣告「這是租戶自己做的事」，不要亂標。
   */
  scope?: 'platform'
}

/**
 * 遞迴淨化稽核值:遮罩憑證欄位、截斷長字串、限制深度與陣列長度。
 *
 * `lossy` 是**選填的回報管道**:只要有任何一處被遮罩／截斷／砍掉,就會被標成 true。
 * 為什麼需要它:2026-09-16 code review 抓到——「還原這一筆」會把這份淨化過的快照
 * 寫回真實設定,於是 60 個敏感詞還原完只剩 50 個,而畫面還跟人說「已經改回原本的值」。
 * ⛔ 有被砍過的紀錄就**不可以拿來還原**,這個旗標就是那道判斷的依據。
 */
export function sanitizeAuditValue(value: unknown, keyHint = '', depth = 0, lossy?: { hit: boolean }): unknown {
  if (SECRET_FIELD_RE.test(keyHint)) { if (lossy) lossy.hit = true; return '••••' }
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING) return value
    if (lossy) lossy.hit = true
    return `${value.slice(0, MAX_STRING)}…(截斷,原 ${value.length} 字)`
  }
  if (depth >= MAX_DEPTH) { if (lossy) lossy.hit = true; return '(層級過深,省略)' }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY && lossy) lossy.hit = true
    return value.slice(0, MAX_ARRAY).map(v => sanitizeAuditValue(v, keyHint, depth + 1, lossy))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = sanitizeAuditValue(v, k, depth + 1, lossy)
    return out
  }
  return String(value)
}

/**
 * 取兩份物件「值有變」的欄位(淺層 key 比對,子物件整顆比):
 * 稽核只記有動到的部分,一來省空間,二來看紀錄的人一眼就知道這次改了什麼。
 * updatedAt 這類每次必變的欄位預設忽略。
 */
export function diffChangedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  ignore: string[] = ['updatedAt'],
): { before: Record<string, unknown>; after: Record<string, unknown>; changedKeys: string[] } {
  const skip = new Set(ignore)
  const changedBefore: Record<string, unknown> = {}
  const changedAfter: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const k of keys) {
    if (skip.has(k)) continue
    const b = before?.[k]
    const a = after?.[k]
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue
    changedBefore[k] = b ?? null
    changedAfter[k] = a ?? null
  }
  return { before: changedBefore, after: changedAfter, changedKeys: Object.keys(changedAfter) }
}

/**
 * 從一份文件挑出「紀錄裡看得懂的那幾格」（`C-254`，2026-09-24）。
 *
 * 為什麼不整份存：推播的 `messages`、模組的 `nodes` 動輒上千字，整包塞進來會被
 * `sanitizeAuditValue` 截斷 → 那筆就被標成 `lossy` → **連還原都不給按**，
 * 而畫面上還是只印得出「（一組設定）」。留幾格看得懂的反而比較有用。
 *
 * - `keep`：原樣帶走的欄位（沒有的欄位不會憑空生出來）
 * - `count`：陣列欄位只記**幾則／幾個**，欄位名加 `Count`（`messages` → `messagesCount`）。
 *   ⛔ 不是陣列就不寫，⛔ 也不要寫 0 充數——那會讓「沒有這個欄位」跟「真的是 0」分不出來。
 */
export function auditSnapshot(
  doc: Record<string, unknown> | null | undefined,
  opts: { keep?: readonly string[], count?: readonly string[] } = {},
): Record<string, unknown> | null {
  if (!doc) return null
  const out: Record<string, unknown> = {}
  for (const k of opts.keep ?? []) if (doc[k] !== undefined) out[k] = doc[k]
  for (const k of opts.count ?? []) {
    const v = doc[k]
    if (Array.isArray(v)) out[`${k}Count`] = v.length
  }
  return out
}

/**
 * 時間欄位 → 紀錄裡看得懂的一行字（`C-254`）。
 *
 * ⚠️ 同一個欄位在不同地方拿到的型別不一樣：Firestore 讀回來是 `Timestamp`、
 * 剛要寫進去的是 `Date`、從 body 來的是字串。⛔ 直接丟給 `sanitizeAuditValue` 的話，
 * `Timestamp`／`Date` 會被當成一般物件展開成 `{}`——畫面上就變成「（一組設定）」。
 */
export function auditTimeText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString()
  const ms = (v as { toMillis?: () => number })?.toMillis?.()
  if (typeof ms === 'number') return new Date(ms).toISOString()
  return String(v)
}

/**
 * 寫一筆稽核。內部吞錯(只 console.error),呼叫端可放心 await,不會拖垮業務寫入。
 *
 * ⛔ **`getDb()` 一定要在 try 裡面呼叫。** 原本寫成預設參數 `db: Firestore = getDb()`——
 * 預設參數是**在進 try 之前**求值的，所以 `getDb()` 一失敗，例外就直接往上拋，
 * 把呼叫它的那支業務端點一起打掛。那跟這支檔案開頭寫的「稽核是配菜不是閘門，
 * 絕不擋業務寫入」正好相反：推播送出去了、卻因為稽核初始化失敗而回 500，
 * 使用者會以為沒送成功、再按一次。
 * （2026-09-24 `C-254` 補稽核時被 `test-send` 的單元測試抓到——那支測試沒有 mock `getDb`。）
 */
export async function writeAuditLog(input: AuditLogInput, db?: Firestore): Promise<void> {
  // 小幫手代辦轉呼叫的端點：那支端點的「人做的」紀錄不寫，由代辦自己寫一筆 actor='agent'
  // （否則同一件事兩筆，一筆還掛在人頭上）。為什麼不能用旗標判斷見 agent-op-context.ts
  if (input.actor === 'human' && currentAgentOpId()) return
  try {
    const target = db ?? getDb()
    // 有任何一格被遮罩／截斷／砍掉就標記起來：那樣的紀錄看得懂，但**不能拿來還原**
    const lossy = { hit: false }
    await target.collection(AUDIT_LOGS_COLLECTION).add({
      workspaceId: input.workspaceId,
      uid: input.uid,
      actor: input.actor,
      action: String(input.action).slice(0, 200),
      before: sanitizeAuditValue(input.before ?? null, '', 0, lossy),
      after: sanitizeAuditValue(input.after ?? null, '', 0, lossy),
      ...(lossy.hit ? { lossy: true } : {}),
      ...(input.note ? { note: String(input.note).slice(0, 500) } : {}),
      ...(input.targetId ? { targetId: String(input.targetId).slice(0, 200) } : {}),
      ...(input.orgId ? { orgId: String(input.orgId).slice(0, 200) } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      createdAt: FieldValue.serverTimestamp(),
    })
  }
  catch (e) {
    console.error('[audit] write failed:', input.action, e)
  }
}
