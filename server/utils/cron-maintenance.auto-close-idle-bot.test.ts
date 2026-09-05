/**
 * 機器人那半的會話「客人問完就沒再回來」自動收尾（`D-64`）。
 *
 * 這支守的最重要一條**不是**「有沒有收掉」，而是**收掉的時候不可以蓋掉最後活動時間**：
 * AI 讀對話貼標籤撈的是「已結束 ＋ 最後活動時間在游標之後」，蓋成現在的話，
 * 那 2,978 場躺了幾個月的舊對話會整批被當成「剛剛結束」拿去跑 AI＝約三千次 LLM。
 * 那正是 `ai-tag-suggest.ts` 檔頭「不追歷史」那條決定要避免的事。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))

// cron-maintenance 匯入的其他工作全部擋掉：這支只碰 autoCloseIdleBotSessions
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

import { autoCloseIdleBotSessions } from './cron-maintenance'
import { BOT_SESSION_MAX_IDLE_DAYS } from '~~/shared/types/conversation-stats'

const NOW = 1_770_000_000_000
const DAY = 86_400_000

interface Seed {
  id: string
  status: 'open' | 'bot_handling'
  idleDays?: number
  /** 沒有 lastActivityAt 的舊資料，只有 openedAt */
  openedDaysAgo?: number
  /** 兩個時間都沒有 */
  noTime?: boolean
  userId?: string
}

function makeDb(seeds: Seed[]) {
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
                workspaceId: 'ws1',
                userId: s.userId ?? `U-${s.id}`,
                status: s.status,
                ...(s.noTime
                  ? {}
                  : s.openedDaysAgo !== undefined
                    ? { openedAt: { toMillis: () => NOW - s.openedDaysAgo! * DAY } }
                    : { lastActivityAt: { toMillis: () => NOW - (s.idleDays ?? 0) * DAY } }),
              }),
            }))
          return { docs, size: docs.length }
        },
      }
      return q
    },
  } as any
}

describe('機器人那半的會話：客人沒再回來就自動收尾', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  it('⛔ 收尾**不可以**蓋掉最後活動時間——蓋了就是約三千次 LLM', async () => {
    await autoCloseIdleBotSessions(makeDb([
      { id: 's1', status: 'bot_handling', idleDays: 90, userId: 'U123' },
    ]))
    expect(closeConversationSession).toHaveBeenCalledWith('s1', 'U123', {
      reason: 'idle_bot_auto',
      preserveLastActivityAt: true,
    })
  })

  it('原因跟真人那半分開記（一個是客服忘了按，一個是客人不回了）', async () => {
    await autoCloseIdleBotSessions(makeDb([
      { id: 's1', status: 'open', idleDays: 30 },
    ]))
    const opts = closeConversationSession.mock.calls[0]![2] as { reason: string }
    expect(opts.reason).toBe('idle_bot_auto')
    expect(opts.reason).not.toBe('idle_auto')
  })

  it('超過門檻的收掉、還在門檻內的不動（兩種機器人狀態都要掃到）', async () => {
    const tally = await autoCloseIdleBotSessions(makeDb([
      { id: 'stale-open', status: 'open', idleDays: BOT_SESSION_MAX_IDLE_DAYS + 1 },
      { id: 'stale-bot', status: 'bot_handling', idleDays: 90 },
      { id: 'fresh-open', status: 'open', idleDays: 1 },
      { id: 'fresh-bot', status: 'bot_handling', idleDays: BOT_SESSION_MAX_IDLE_DAYS - 1 },
    ]))

    expect(tally).toMatchObject({ scanned: 4, closed: 2, skippedFresh: 2, truncated: false })
    expect(closeConversationSession.mock.calls.map(c => c[0]).sort())
      .toEqual(['stale-bot', 'stale-open'])
  })

  it('剛好卡在門檻上不收（隔一週整回來問後續，仍算同一場）', async () => {
    const tally = await autoCloseIdleBotSessions(makeDb([
      { id: 'exactly', status: 'bot_handling', idleDays: BOT_SESSION_MAX_IDLE_DAYS - 0.001 },
    ]))
    expect(tally.closed).toBe(0)
    expect(tally.skippedFresh).toBe(1)
  })

  it('沒有最後活動時間的舊資料，退回用「開場時間」判斷', async () => {
    const tally = await autoCloseIdleBotSessions(makeDb([
      { id: 'old-schema', status: 'open', openedDaysAgo: 60 },
    ]))
    expect(tally.closed).toBe(1)
  })

  it('⛔ 兩個時間都讀不到就跳過，不猜——猜錯會把剛開的場收掉', async () => {
    const tally = await autoCloseIdleBotSessions(makeDb([
      { id: 'no-time', status: 'bot_handling', noTime: true },
    ]))
    expect(tally).toMatchObject({ closed: 0, skippedNoTime: 1 })
    expect(closeConversationSession).not.toHaveBeenCalled()
  })

  it('⛔ 不去讀 workspace 設定：這支沒有「關掉」這個選項，也不該為此多花查詢', async () => {
    await autoCloseIdleBotSessions(makeDb([
      { id: 's1', status: 'open', idleDays: 90 },
    ]))
    expect(getAiSettings).not.toHaveBeenCalled()
  })

  it('單筆關閉失敗不影響整批（下一輪會再撿到它）', async () => {
    closeConversationSession.mockRejectedValueOnce(new Error('boom'))
    const tally = await autoCloseIdleBotSessions(makeDb([
      { id: 'bad', status: 'open', idleDays: 90 },
      { id: 'good', status: 'open', idleDays: 90 },
    ]))
    expect(tally.closed).toBe(1)
  })
})
