/**
 * 自動回應「走進來的每一次」→ 成效卡要講的數字（`D-138`）：幾位走進來、幾位走完、沒走完的停在哪一題、為什麼。
 * 純函式：後端讀 `scripts/{id}/runs` 後在這裡算，測試直接餵假資料。
 */
import type { ScriptRun } from './types/ai-script'

/** 沒走完的原因（只講系統確定知道的事） */
export type ScriptStopReason = 'escaped' | 'reasked' | 'noReply' | 'stopped'

export const SCRIPT_STOP_REASON_LABELS: Record<ScriptStopReason, string> = {
  escaped: '按了找真人',
  reasked: '答不出來，被重問後沒再回',
  // ⛔ 不寫成「客人不理」：多半是按了選單、改找真人，系統只知道他沒回這一題（看對話才知道去哪了）
  noReply: '沒有回這一題',
  stopped: '中途被停用',
}

export interface ScriptStopPerson {
  userDocId: string
  displayName: string
  atMs: number
  reason: ScriptStopReason
}

export interface ScriptStopRow {
  nodeId: string
  /** 停在這一題的人數（同一位停兩次算一位） */
  people: number
  reasons: Partial<Record<ScriptStopReason, number>>
  /** 新到舊，同一位只留最近那次 */
  who: ScriptStopPerson[]
}

export interface ScriptRunSummary {
  /** 最早那筆紀錄的時間＝從什麼時候開始記（`D-138` 上線前的沒有紀錄） */
  sinceMs: number | null
  runs: number
  /** 走進來的人數（不重複） */
  people: number
  completed: number
  /** 還在回答中（還沒逾時） */
  inProgress: number
  /** 用截圖回答的題數 */
  imageAnswers: number
  stops: ScriptStopRow[]
  /** 只讀了最近 N 筆（超過就是不完整，畫面要講） */
  truncated: boolean
}

function stopReasonOf(run: ScriptRun, nowMs: number): ScriptStopReason | null {
  if (run.status === 'completed') return null
  if (run.status === 'escaped') return 'escaped'
  if (run.status === 'stopped') return 'stopped'
  // active 但已逾時＝沒再回（逾時是下一則訊息進來才清，客人不再傳訊息就一直停在 active）
  if (run.status === 'active' && run.expiresAtMs > nowMs) return null
  return run.reasks > 0 ? 'reasked' : 'noReply'
}

export function summarizeScriptRuns(runs: ScriptRun[], nowMs: number, truncated = false): ScriptRunSummary {
  const people = new Set<string>()
  type NodeRow = { reasons: Partial<Record<ScriptStopReason, number>>; who: Map<string, ScriptStopPerson> }
  const byNode = new Map<string, NodeRow>()
  let completed = 0
  let inProgress = 0
  let imageAnswers = 0
  let sinceMs: number | null = null

  for (const run of runs) {
    people.add(run.userDocId)
    imageAnswers += Number(run.imageAnswers || 0)
    if (sinceMs === null || run.startedAtMs < sinceMs) sinceMs = run.startedAtMs
    if (run.status === 'completed') {
      completed++
      continue
    }
    const reason = stopReasonOf(run, nowMs)
    if (!reason) {
      inProgress++
      continue
    }
    const row: NodeRow = byNode.get(run.nodeId) ?? { reasons: {}, who: new Map() }
    row.reasons[reason] = (row.reasons[reason] ?? 0) + 1
    const prev = row.who.get(run.userDocId)
    if (!prev || prev.atMs < run.updatedAtMs) {
      row.who.set(run.userDocId, { userDocId: run.userDocId, displayName: run.displayName, atMs: run.updatedAtMs, reason })
    }
    byNode.set(run.nodeId, row)
  }

  const stops: ScriptStopRow[] = [...byNode.entries()].map(([nodeId, row]) => ({
    nodeId,
    people: row.who.size,
    reasons: row.reasons,
    who: [...row.who.values()].sort((a, b) => b.atMs - a.atMs),
  }))

  return { sinceMs, runs: runs.length, people: people.size, completed, inProgress, imageAnswers, stops, truncated }
}
