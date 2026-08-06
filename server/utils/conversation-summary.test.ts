import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('createError', (o: any) => Object.assign(new Error(o?.statusMessage ?? 'error'), o))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}))
vi.mock('./ai-answer', () => ({ summarizeHandoffContext: vi.fn() }))

import { ensureTakeoverSummary } from './conversation-summary'
import { summarizeHandoffContext } from './ai-answer'

const WS = 'ws1'
const DOC = 'ws1__U1'

interface MsgSeed { direction: 'incoming' | 'outgoing'; text: string; atMs: number; messageType?: string }

/** 訊息以「新到舊」回（正式的查詢是 orderBy timestamp desc），函式內部自己反轉 */
function makeDb(conv: Record<string, unknown> | null, messages: MsgSeed[]) {
  const written: Record<string, any>[] = []
  const docs = [...messages]
    .sort((a, b) => b.atMs - a.atMs)
    .map(m => ({
      data: () => ({
        direction: m.direction,
        text: m.text,
        messageType: m.messageType,
        timestamp: { toMillis: () => m.atMs },
      }),
    }))
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: conv !== null, data: () => conv ?? undefined }),
        set: async (d: Record<string, any>) => { written.push(d) },
        collection: () => ({
          orderBy: () => ({ limit: () => ({ get: async () => ({ empty: !docs.length, docs }) }) }),
        }),
      }),
    }),
  }
  return { db: db as any, written }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(summarizeHandoffContext).mockResolvedValue('客人問保固，已告知兩年。')
})

describe('接手摘要', () => {
  it('第一次會產生並寫回，之後沒有新訊息就直接沿用（同一場點兩次不該付兩次錢）', async () => {
    const seed = { workspaceId: WS } as Record<string, unknown>
    const msgs: MsgSeed[] = [
      { direction: 'incoming', text: '保固多久', atMs: 1_000 },
      { direction: 'outgoing', text: '兩年', atMs: 2_000 },
    ]

    const first = await ensureTakeoverSummary(makeDb(seed, msgs).db, DOC, WS)
    expect(first.cached).toBe(false)
    expect(first.text).toBe('客人問保固，已告知兩年。')
    expect(vi.mocked(summarizeHandoffContext)).toHaveBeenCalledTimes(1)

    // 把剛才寫回的摘要當成現況再叫一次
    const cachedConv = {
      workspaceId: WS,
      takeoverSummary: { text: first.text, uptoMessageAtMs: 2_000, generatedAtMs: first.generatedAtMs },
    }
    const second = await ensureTakeoverSummary(makeDb(cachedConv, msgs).db, DOC, WS)
    expect(second.cached).toBe(true)
    expect(vi.mocked(summarizeHandoffContext)).toHaveBeenCalledTimes(1) // 沒有再打一次
  })

  it('有新訊息就重新產生（摘要要跟得上對話，不然接手的人看到的是舊劇情）', async () => {
    const conv = {
      workspaceId: WS,
      takeoverSummary: { text: '舊摘要', uptoMessageAtMs: 2_000, generatedAtMs: 1 },
    }
    const msgs: MsgSeed[] = [
      { direction: 'incoming', text: '保固多久', atMs: 1_000 },
      { direction: 'outgoing', text: '兩年', atMs: 2_000 },
      { direction: 'incoming', text: '那可以延長嗎', atMs: 3_000 },
    ]
    const res = await ensureTakeoverSummary(makeDb(conv, msgs).db, DOC, WS)
    expect(res.cached).toBe(false)
    expect(vi.mocked(summarizeHandoffContext)).toHaveBeenCalledTimes(1)
  })

  it('force：使用者自己按「重新整理摘要」時，即使沒有新訊息也要重生', async () => {
    const conv = {
      workspaceId: WS,
      takeoverSummary: { text: '舊摘要', uptoMessageAtMs: 2_000, generatedAtMs: 1 },
    }
    const msgs: MsgSeed[] = [{ direction: 'outgoing', text: '兩年', atMs: 2_000 }]
    const res = await ensureTakeoverSummary(makeDb(conv, msgs).db, DOC, WS, { force: true })
    expect(res.cached).toBe(false)
    expect(vi.mocked(summarizeHandoffContext)).toHaveBeenCalledTimes(1)
  })

  it('照時間由舊到新餵給模型（倒過來餵，摘要會把結論當起因）', async () => {
    const msgs: MsgSeed[] = [
      { direction: 'incoming', text: '第一句', atMs: 1_000 },
      { direction: 'outgoing', text: '第二句', atMs: 2_000 },
      { direction: 'incoming', text: '第三句', atMs: 3_000 },
    ]
    await ensureTakeoverSummary(makeDb({ workspaceId: WS }, msgs).db, DOC, WS)
    const history = vi.mocked(summarizeHandoffContext).mock.calls[0]![0]!
    expect(history.map(t => t.text)).toEqual(['第一句', '第二句', '第三句'])
    expect(history.map(t => t.role)).toEqual(['user', 'bot', 'user'])
  })

  it('跨租戶保護：對話不屬於這個工作區就不給讀', async () => {
    const conv = { workspaceId: 'other-ws' }
    await expect(ensureTakeoverSummary(makeDb(conv, []).db, DOC, WS)).rejects.toThrow()
  })

  it('沒有訊息可摘要 → 回空字串，不打 LLM', async () => {
    const res = await ensureTakeoverSummary(makeDb({ workspaceId: WS }, []).db, DOC, WS)
    expect(res.text).toBe('')
    expect(vi.mocked(summarizeHandoffContext)).not.toHaveBeenCalled()
  })

  it('模型回空字串時不要寫回一筆空摘要（否則之後永遠沿用那個空的）', async () => {
    vi.mocked(summarizeHandoffContext).mockResolvedValue('')
    const msgs: MsgSeed[] = [{ direction: 'incoming', text: '在嗎', atMs: 1_000 }]
    const ctx = makeDb({ workspaceId: WS }, msgs)
    const res = await ensureTakeoverSummary(ctx.db, DOC, WS)
    expect(res.text).toBe('')
    expect(ctx.written).toHaveLength(0)
  })
})
