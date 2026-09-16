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

export const AUDIT_LOGS_COLLECTION = 'auditLogs'

/** 命中這些字樣的欄位,值一律遮罩(不分大小寫;涵蓋 LINE 憑證與金流金鑰的命名) */
const SECRET_FIELD_RE = /(token|secret|password|credential|api_?key|hash_?key|hash_?iv)/i
const MAX_STRING = 500
const MAX_DEPTH = 4
const MAX_ARRAY = 50

export interface AuditLogInput {
  workspaceId: string
  uid: string
  /** human=人在頁面/端點直接操作;agent=AI 小幫手代辦(Phase 2 起) */
  actor: 'human' | 'agent'
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

/** 寫一筆稽核。內部吞錯(只 console.error),呼叫端可放心 await,不會拖垮業務寫入。 */
export async function writeAuditLog(input: AuditLogInput, db: Firestore = getDb()): Promise<void> {
  try {
    // 有任何一格被遮罩／截斷／砍掉就標記起來：那樣的紀錄看得懂，但**不能拿來還原**
    const lossy = { hit: false }
    await db.collection(AUDIT_LOGS_COLLECTION).add({
      workspaceId: input.workspaceId,
      uid: input.uid,
      actor: input.actor,
      action: String(input.action).slice(0, 200),
      before: sanitizeAuditValue(input.before ?? null, '', 0, lossy),
      after: sanitizeAuditValue(input.after ?? null, '', 0, lossy),
      ...(lossy.hit ? { lossy: true } : {}),
      ...(input.note ? { note: String(input.note).slice(0, 500) } : {}),
      ...(input.targetId ? { targetId: String(input.targetId).slice(0, 200) } : {}),
      createdAt: FieldValue.serverTimestamp(),
    })
  }
  catch (e) {
    console.error('[audit] write failed:', input.action, e)
  }
}
