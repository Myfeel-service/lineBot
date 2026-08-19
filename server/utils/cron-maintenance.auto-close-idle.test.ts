/**
 * 真人接手中的會話「閒置過久自動收尾」。
 *
 * 這支是那種會話**唯一**的收殮機制：它們刻意不吃 24 小時自動結束（客人隔天回來要接在
 * 同一場），所以沒有這一輪掃描的話，客服忘記按「結束會話」的對話會永遠掛著——
 * 真人接手期間機器人是閉嘴的，那位客人從此收不到任何自動回覆，而沒關的場還會一直被
 * 背景查詢掃到（2026-08-11 讀取費暴衝有這一份）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))

// cron-maintenance 匯入的其他工作全部擋掉：這支測試只碰 autoCloseIdleHumanSessions
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  buildSourceClearFailure: () => ({}),
  clearSourceFailure: vi.fn(),
  markSourceOutdated: vi.fn(),
}))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-knowledge-autoapply', () => ({ tryAutoApplyMinorChange: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ extractUrlText: vi.fn() }))
vi.mock('./gsheet-sync', () => ({ syncGoogleSheetSource: vi.fn() }))
vi.mock('./webhook-dedup', () => ({ WEBHOOK_EVENT_LOCKS_COLLECTION: 'webhookEventLocks' }))
vi.mock('./line', () => ({ pushMessage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(), notifyOverdueHandoffBatch: vi.fn() }))

const { closeConversationSession, handBackSessionToBot } = vi.hoisted(() => ({
  closeConversationSession: vi.fn(async (_sessionId: string, _userId: string, _opts?: unknown) => {}),
  handBackSessionToBot: vi.fn(),
}))
vi.mock('./conversation-session', () => ({ closeConversationSession, handBackSessionToBot }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

import { autoCloseIdleHumanSessions } from './cron-maintenance'

const NOW = 1_770_000_000_000
const HOUR = 3600_000

interface SessionSeed {
  id: string
  status: 'pending_human' | 'human_handling'
  idleHours: number
  workspaceId?: string
  userId?: string
}

function makeDb(seeds: SessionSeed[]) {
  return {
    collection: (col: string) => {
      if (col !== 'conversationSessions') throw new Error(`unexpected collection: ${col}`)
      let wantStatus = ''
      const q: any = {
        where: (field: string, _op: string, value: string) => {
          if (field === 'status') wantStatus = value
          return q
        },
        limit: () => q,
        get: async () => {
          const docs = seeds
            .filter(s => s.status === wantStatus)
            .map(s => ({
              id: s.id,
              data: () => ({
                workspaceId: s.workspaceId ?? 'ws1',
                userId: s.userId ?? `U-${s.id}`,
                status: s.status,
                lastActivityAt: { toMillis: () => NOW - s.idleHours * HOUR },
              }),
            }))
          return { docs, size: docs.length }
        },
      }
      return q
    },
  } as any
}

describe('真人接手中的會話：閒置過久自動收尾', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: 48 })
  })

  it('超過門檻的收掉、還在門檻內的不動（兩種真人狀態都要掃到）', async () => {
    const tally = await autoCloseIdleHumanSessions(makeDb([
      { id: 'stale-human', status: 'human_handling', idleHours: 50 },
      { id: 'stale-pending', status: 'pending_human', idleHours: 72 },
      { id: 'fresh-human', status: 'human_handling', idleHours: 30 },
    ]))

    expect(tally).toMatchObject({ scanned: 3, closed: 2, skippedFresh: 1, truncated: false })
    const closedIds = closeConversationSession.mock.calls.map(c => c[0])
    expect(closedIds.sort()).toEqual(['stale-human', 'stale-pending'])
  })

  it('收尾要標成系統自動關的（時間軸才講得出不是客服按的）', async () => {
    await autoCloseIdleHumanSessions(makeDb([
      { id: 's1', status: 'human_handling', idleHours: 50, userId: 'U123' },
    ]))
    expect(closeConversationSession).toHaveBeenCalledWith('s1', 'U123', { reason: 'idle_auto' })
  })

  it('門檻照各工作區設定走（設 72 小時 → 閒置 50 小時不收）', async () => {
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: 72 })
    const tally = await autoCloseIdleHumanSessions(makeDb([
      { id: 's1', status: 'human_handling', idleHours: 50 },
    ]))
    expect(tally.closed).toBe(0)
    expect(closeConversationSession).not.toHaveBeenCalled()
  })

  it('單筆失敗不影響其他筆（下一輪會再撿到它）', async () => {
    closeConversationSession.mockRejectedValueOnce(new Error('boom'))
    const tally = await autoCloseIdleHumanSessions(makeDb([
      { id: 'boom', status: 'human_handling', idleHours: 50 },
      { id: 'ok', status: 'human_handling', idleHours: 50 },
    ]))
    expect(tally.closed).toBe(1)
  })

  it('掃到上限要出聲說沒看完（「掃過了」與「掃完了」不能長得一樣）', async () => {
    const many: SessionSeed[] = Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`, status: 'human_handling' as const, idleHours: 1,
    }))
    const tally = await autoCloseIdleHumanSessions(makeDb(many))
    expect(tally.truncated).toBe(true)
  })
})
