/**
 * 從外部 body 收斂出乾淨的腳本 input。
 * 任何不合法欄位都會被預設值取代；不確定的 type 直接丟掉。
 */
import {
  DEFAULT_COLLECT_EXPIRE_MS,
  DEFAULT_SCRIPT_PRIORITY,
  MAX_QUICK_REPLY_OPTIONS,
  MAX_TRIGGER_EXAMPLES,
  type BranchOp,
  type CollectFormat,
  type ScriptBranchCase,
  type ScriptBranchNode,
  type ScriptCollectNode,
  type ScriptDoc,
  type ScriptNode,
  type ScriptQuickReplyNode,
  type ScriptQuickReplyOption,
  type ScriptReplyNode,
  type ScriptSaveLeadField,
  type ScriptSaveLeadNode,
  type ScriptTagNode,
  type ScriptTriggerNode,
} from '~~/shared/types/ai-script'

const COLLECT_FORMATS: CollectFormat[] = ['any', 'phone', 'email', 'number', 'alphanumeric', 'alphanumericSymbol', 'custom']
const BRANCH_OPS: BranchOp[] = ['exists', 'equals', 'contains']
/** 單一分支節點最多幾條 case（避免前端塞爆） */
const MAX_BRANCH_CASES = 10
/** 單一寫名單節點最多幾組欄位對應 */
const MAX_SAVE_LEAD_FIELDS = 20

export interface ScriptInput {
  name: string
  enabled: boolean
  priority: number
  nodes: ScriptNode[]
  rootNodeId: string
}

export function normalizeScriptInput(raw: any): ScriptInput {
  const name = String(raw?.name ?? '').trim().slice(0, 100)
  const enabled = raw?.enabled !== false
  const priority = clampInt(raw?.priority, 1, 100, DEFAULT_SCRIPT_PRIORITY)
  const rootNodeId = String(raw?.rootNodeId ?? '').trim()
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes.map(normalizeNode).filter(Boolean) as ScriptNode[] : []
  return { name, enabled, priority, nodes, rootNodeId }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeNode(raw: any): ScriptNode | null {
  const id = String(raw?.id ?? '').trim()
  const type = String(raw?.type ?? '').trim()
  if (!id || !type) return null

  if (type === 'trigger') {
    const matchMode = raw?.matchMode === 'semantic' ? 'semantic' : 'keyword'
    const node: ScriptTriggerNode = {
      id,
      type: 'trigger',
      matchMode,
      keywords: Array.isArray(raw?.keywords)
        ? raw.keywords.map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 20)
        : [],
      priority: clampInt(raw?.priority, 1, 100, DEFAULT_SCRIPT_PRIORITY),
      next: String(raw?.next ?? '').trim(),
    }
    // semantic 模式才收範例；exampleEmbeddings 一律由 server 算，絕不採信前端傳入
    if (matchMode === 'semantic') {
      node.examples = Array.isArray(raw?.examples)
        ? raw.examples.map((e: unknown) => String(e).trim().slice(0, 200)).filter(Boolean).slice(0, MAX_TRIGGER_EXAMPLES)
        : []
    }
    return node
  }

  if (type === 'collect') {
    const format: CollectFormat = COLLECT_FORMATS.includes(raw?.format) ? raw.format : 'any'
    const node: ScriptCollectNode = {
      id,
      type: 'collect',
      question: String(raw?.question ?? '').trim().slice(0, 500),
      fieldName: String(raw?.fieldName ?? '').trim().replace(/[^\w一-龥]/g, '').slice(0, 32),
      expireMs: clampInt(raw?.expireMs, 30_000, 24 * 60 * 60 * 1000, DEFAULT_COLLECT_EXPIRE_MS),
      format,
      next: String(raw?.next ?? '').trim(),
    }
    // 只有有意義時才帶欄位，避免 'any' 節點塞一堆空字串
    if (format === 'custom') node.pattern = String(raw?.pattern ?? '').trim().slice(0, 200)
    if (format !== 'any') {
      const reask = String(raw?.reaskText ?? '').trim().slice(0, 500)
      if (reask) node.reaskText = reask
    }
    return node
  }

  if (type === 'reply') {
    const node: ScriptReplyNode = {
      id,
      type: 'reply',
      text: String(raw?.text ?? '').trim().slice(0, 2000),
      thenHandoff: raw?.thenHandoff === true,
    }
    return node
  }

  if (type === 'tag') {
    const node: ScriptTagNode = {
      id,
      type: 'tag',
      addTagIds: Array.isArray(raw?.addTagIds)
        ? raw.addTagIds.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 30)
        : [],
      next: String(raw?.next ?? '').trim(),
    }
    return node
  }

  if (type === 'saveLead') {
    const fieldMap: ScriptSaveLeadField[] = Array.isArray(raw?.fieldMap)
      ? raw.fieldMap.slice(0, MAX_SAVE_LEAD_FIELDS).map((m: any): ScriptSaveLeadField => ({
          fromField: String(m?.fromField ?? '').trim().replace(/[^\w一-龥]/g, '').slice(0, 32),
          attrKey: String(m?.attrKey ?? '').trim().replace(/[^\w一-龥]/g, '').slice(0, 32),
        }))
      : []
    const node: ScriptSaveLeadNode = {
      id,
      type: 'saveLead',
      fieldMap,
      next: String(raw?.next ?? '').trim(),
    }
    return node
  }

  if (type === 'quickReply') {
    const options: ScriptQuickReplyOption[] = Array.isArray(raw?.options)
      ? raw.options.slice(0, MAX_QUICK_REPLY_OPTIONS).map((o: any): ScriptQuickReplyOption => ({
          label: String(o?.label ?? '').trim().slice(0, 20),
          next: String(o?.next ?? '').trim(),
        }))
      : []
    const node: ScriptQuickReplyNode = {
      id,
      type: 'quickReply',
      question: String(raw?.question ?? '').trim().slice(0, 500),
      expireMs: clampInt(raw?.expireMs, 30_000, 24 * 60 * 60 * 1000, DEFAULT_COLLECT_EXPIRE_MS),
      options,
    }
    return node
  }

  if (type === 'branch') {
    const cases: ScriptBranchCase[] = Array.isArray(raw?.cases)
      ? raw.cases.slice(0, MAX_BRANCH_CASES).map((c: any): ScriptBranchCase => {
          const op: BranchOp = BRANCH_OPS.includes(c?.op) ? c.op : 'exists'
          return {
            op,
            field: String(c?.field ?? '').trim().replace(/[^\w一-龥]/g, '').slice(0, 32),
            ...(op === 'exists' ? {} : { value: String(c?.value ?? '').trim().slice(0, 200) }),
            next: String(c?.next ?? '').trim(),
          }
        })
      : []
    const node: ScriptBranchNode = {
      id,
      type: 'branch',
      cases,
      defaultNext: String(raw?.defaultNext ?? '').trim(),
    }
    return node
  }

  return null
}

/**
 * 移除 trigger 節點的 exampleEmbeddings（768 維 × N，肥大且前端用不到）。
 * list / create / put 回傳給編輯器前都過一次，避免把向量塞進 client payload。
 */
export function stripTriggerEmbeddings(nodes: ScriptNode[]): ScriptNode[] {
  return nodes.map((node) => {
    if (node.type !== 'trigger' || !(node as ScriptTriggerNode).exampleEmbeddings) return node
    const { exampleEmbeddings: _drop, ...rest } = node as ScriptTriggerNode
    return rest as ScriptNode
  })
}

/** 提供呼叫端取得 ScriptDoc 的工具型別（不含 timestamp） */
export type ScriptDocWritePayload = Omit<ScriptDoc, 'createdAt' | 'updatedAt'>
