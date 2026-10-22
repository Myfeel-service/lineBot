import { describe, expect, it } from 'vitest'
import { SCRIPT_RUN_SUMMARY_MEMO_MS, isRunSummaryMemoFresh, summarizeScriptRuns } from './script-runs'
import type { ScriptRun } from './types/ai-script'

const NOW = 1_800_000_000_000

function run(over: Partial<ScriptRun>): ScriptRun {
  return {
    userDocId: 'u1',
    displayName: '王小明',
    startedAtMs: NOW - 3_600_000,
    updatedAtMs: NOW - 3_000_000,
    nodeId: 'c_id',
    status: 'active',
    reasks: 0,
    imageAnswers: 0,
    expiresAtMs: NOW - 2_400_000,
    ...over,
  }
}

describe('summarizeScriptRuns（成效卡：停在哪一題、為什麼）', () => {
  it('走完、還在回答、沒走完分開算；人數不重複', () => {
    const s = summarizeScriptRuns([
      run({ userDocId: 'a', status: 'completed', nodeId: '' }),
      run({ userDocId: 'a', status: 'completed', nodeId: '' }),
      run({ userDocId: 'b', expiresAtMs: NOW + 60_000 }), // 還沒逾時＝回答中
      run({ userDocId: 'c' }), // 逾時＝沒回這一題
    ], NOW)
    expect(s).toMatchObject({ runs: 4, people: 3, completed: 2, inProgress: 1 })
    expect(s.stops).toHaveLength(1)
    expect(s.stops[0]).toMatchObject({ nodeId: 'c_id', people: 1, reasons: { noReply: 1 } })
  })

  it('原因：找真人／重問後沒再回／沒回／中途停用', () => {
    const s = summarizeScriptRuns([
      run({ userDocId: 'a', status: 'escaped' }),
      run({ userDocId: 'b', reasks: 2 }),
      run({ userDocId: 'c', status: 'expired' }),
      run({ userDocId: 'd', status: 'stopped' }),
    ], NOW)
    expect(s.stops[0]!.reasons).toEqual({ escaped: 1, reasked: 1, noReply: 1, stopped: 1 })
    expect(s.stops[0]!.people).toBe(4)
  })

  it('同一位停在同一題兩次只算一位，名單留最近那次', () => {
    const s = summarizeScriptRuns([
      run({ userDocId: 'a', updatedAtMs: NOW - 9_000_000 }),
      run({ userDocId: 'a', updatedAtMs: NOW - 1_000_000, reasks: 1 }),
    ], NOW)
    expect(s.stops[0]!.people).toBe(1)
    expect(s.stops[0]!.who[0]).toMatchObject({ userDocId: 'a', reason: 'reasked' })
  })

  it('從什麼時候開始記＝最早那筆；截圖數加總', () => {
    const s = summarizeScriptRuns([
      run({ startedAtMs: NOW - 100, imageAnswers: 1, status: 'completed' }),
      run({ startedAtMs: NOW - 900, imageAnswers: 2, status: 'completed' }),
    ], NOW)
    expect(s.sinceMs).toBe(NOW - 900)
    expect(s.imageAnswers).toBe(3)
  })

  it('沒有紀錄：全部是 0、sinceMs 是 null', () => {
    expect(summarizeScriptRuns([], NOW)).toMatchObject({ runs: 0, people: 0, sinceMs: null, stops: [] })
  })
})

describe('成效卡記著的那份能不能直接用（切來切去不重讀 501 筆，`C-379`）', () => {
  const memo = { starts: 40, completions: 30, atMs: NOW - 60_000, summary: summarizeScriptRuns([], NOW) }

  it('次數沒變、剛讀過 → 直接用', () => {
    expect(isRunSummaryMemoFresh(memo, 40, 30, NOW)).toBe(true)
  })

  it('有人走進來或走完（次數變了）→ 重讀', () => {
    expect(isRunSummaryMemoFresh(memo, 41, 30, NOW)).toBe(false)
    expect(isRunSummaryMemoFresh(memo, 40, 31, NOW)).toBe(false)
  })

  it('記太久（重問、按找真人不動次數）→ 重讀；沒讀過 → 讀', () => {
    expect(isRunSummaryMemoFresh(memo, 40, 30, memo.atMs + SCRIPT_RUN_SUMMARY_MEMO_MS)).toBe(false)
    expect(isRunSummaryMemoFresh(undefined, 40, 30, NOW)).toBe(false)
  })
})
