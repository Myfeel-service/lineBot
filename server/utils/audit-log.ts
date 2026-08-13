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
}

/** 遞迴淨化稽核值:遮罩憑證欄位、截斷長字串、限制深度與陣列長度 */
export function sanitizeAuditValue(value: unknown, keyHint = '', depth = 0): unknown {
  if (SECRET_FIELD_RE.test(keyHint)) return '••••'
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(截斷,原 ${value.length} 字)` : value
  if (depth >= MAX_DEPTH) return '(層級過深,省略)'
  if (Array.isArray(value))
    return value.slice(0, MAX_ARRAY).map(v => sanitizeAuditValue(v, keyHint, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = sanitizeAuditValue(v, k, depth + 1)
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
    await db.collection(AUDIT_LOGS_COLLECTION).add({
      workspaceId: input.workspaceId,
      uid: input.uid,
      actor: input.actor,
      action: String(input.action).slice(0, 200),
      before: sanitizeAuditValue(input.before ?? null),
      after: sanitizeAuditValue(input.after ?? null),
      ...(input.note ? { note: String(input.note).slice(0, 500) } : {}),
      createdAt: FieldValue.serverTimestamp(),
    })
  }
  catch (e) {
    console.error('[audit] write failed:', input.action, e)
  }
}
