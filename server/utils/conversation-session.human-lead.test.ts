/**
 * 真人講過話之後，客人回的下一句留給真人——**直到真人自己按結束／交還**。
 *
 * 現場問題（2026-08-20，STATUS `H-13`）：以前「現在誰在處理這位客人」只存在進行中的那一場
 * 會話上，會話一結束就整個歸零。但真人常常在沒有進行中會話時講話——
 *   · 客服回完順手按「結束會話」（8/17 14:52 真人回、14:53 按結束、14:53:20 客人追問
 *     「你們不是在台灣嗎？」→ AI 亂答委製進口商資訊）
 *   · 客服主動發訊問候（8/20 17:40 問「補寄商品收到了嗎」→ 18:04 客人回「有收到」
 *     → AI 接手連回三則）
 * 那則真人訊息掛不到任何一場，客人一回話就開新的一場、從「沒人接手」起算 → AI 搶答。
 * 正式資料近 7 天 593 場新會話中 35 場（約 6%）是這樣開始的。
 *
 * 老闆拍板：「真人沒有切就不要轉，等真人按下結束才結束。」所以這組測試守住兩件事：
 *   ① 記號只看「真人有沒有放手」，**不看隔了多久**（先前寫過一版 48 小時窗口，拍板後移除）
 *   ② 放手只有真人自己按的兩顆按鈕算：「結束會話」與「交還機器人」；
 *      系統排程自動收尾**不算**（不然就是時間到自動把客人交回 AI）
 * 另外只動「誰在處理」不動統計欄位，否則「沒人回的對話」會憑空少一批。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    delete: () => '__del__',
    increment: (n: number) => `__inc:${n}__`,
  },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

import {
  ensureConversationSession,
  onHumanOutgoingMessage,
  closeConversationSession,
  handBackSessionToBot,
  shouldSuppressInboundBotAutomationForSession,
  _invalidateUserSessionCache,
} from './conversation-session'
import { getDb } from './firebase'
import { DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS } from '~~/shared/types/ai-knowledge'

const WS = 'ws-lead'
const LINE_UID = 'U0000000000000000000000000000002'
const HOUR = 3600_000
const MINUTE = 60_000

interface Harness {
  db: any
  state: {
    sessions: Record<string, Record<string, any>>
    conv: Record<string, any>
    events: { sessionId: string; eventType: string; reason?: string }[]
  }
}

/**
 * 上一場已經結束（客服按過「結束會話」→ currentSessionId 被清成 null），
 * 對話上留著「這位客人是真人的」記號。`humanAgoMs` = 真人那次動作距現在多久。
 */
function makeDb(opts: { humanAgoMs?: number | null; currentSessionId?: string | null } = {}): Harness {
  const state: Harness['state'] = {
    sessions: {},
    conv: {
      currentSessionId: opts.currentSessionId ?? null,
      ...(opts.humanAgoMs == null
        ? {}
        : { lastHumanActionAt: { toMillis: () => Date.now() - opts.humanAgoMs! } }),
    },
    events: [],
  }

  const snap = (col: string, id: string) => {
    if (col === 'conversationSessions') {
      const doc = state.sessions[id]
      return { exists: !!doc, data: () => doc }
    }
    if (col === 'conversations') return { exists: true, data: () => state.conv }
    return { exists: true, data: () => ({}) }
  }

  /** Firestore 的 merge set：`FieldValue.delete()` 要真的把欄位拿掉，否則測不出「清記號」 */
  const applyMerge = (target: Record<string, any>, patch: Record<string, any>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === '__del__') delete target[k]
      else target[k] = v
    }
  }

  const docFor = (col: string, id: string) => ({
    __col: col,
    __id: id,
    get: vi.fn(async () => snap(col, id)),
    set: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions') state.sessions[id] = { ...state.sessions[id], ...patch }
      if (col === 'conversations') applyMerge(state.conv, patch)
      if (col === 'conversationEvents') {
        state.events.push({
          sessionId: String(patch.sessionId),
          eventType: String(patch.eventType),
          reason: patch.reason,
        })
      }
    }),
    update: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions') Object.assign(state.sessions[id]!, patch)
    }),
  })

  let autoId = 0
  const db = {
    collection: (col: string) => ({
      doc: (id?: string) => docFor(col, id ?? `auto-${++autoId}`),
      where: function () { return this },
      get: async () => ({ docs: [], size: 0 }),
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => snap(ref.__col, ref.__id),
      set: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') state.sessions[ref.__id] = patch
        if (ref.__col === 'conversations') applyMerge(state.conv, patch)
      },
      update: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') Object.assign(state.sessions[ref.__id]!, patch)
      },
    })),
    batch: () => ({ update: () => {}, commit: async () => {} }),
  }
  return { db, state }
}

/** 客人在「真人動作之後 humanAgoMs」回了一句話 → 回傳新開那場的文件 */
async function inboundAfterHumanReply(
  humanAgoMs: number | null,
  opts: { origin?: 'follow' } = {},
): Promise<{ sessionId: string; session: Record<string, any>; harness: Harness }> {
  const harness = makeDb({ humanAgoMs })
  vi.mocked(getDb).mockReturnValue(harness.db as any)
  const sessionId = await ensureConversationSession(LINE_UID, WS, opts)
  // 事件是 fire-and-forget，讓那些 promise 有機會跑完
  await Promise.resolve()
  await Promise.resolve()
  return { sessionId, session: harness.state.sessions[sessionId]!, harness }
}

/** 在既有的 harness 上再收一則客人訊息（測「按了結束之後換誰接手」） */
async function inboundAgain(harness: Harness): Promise<Record<string, any>> {
  _invalidateUserSessionCache(LINE_UID)
  vi.mocked(getDb).mockReturnValue(harness.db as any)
  const sessionId = await ensureConversationSession(LINE_UID, WS)
  return harness.state.sessions[sessionId]!
}

describe('真人講過話：客人回的下一句不給 AI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T10:04:00Z'))
    _invalidateUserSessionCache(LINE_UID)
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS })
  })
  afterEach(() => { vi.useRealTimers() })

  it('真人 24 分鐘前主動發訊（螢幕截圖那場）：新會話開成真人處理中', async () => {
    const { session } = await inboundAfterHumanReply(24 * MINUTE)
    expect(session.status).toBe('human_handling')
    expect(session.currentHandler).toBe('human')
    expect(session.currentModuleType).toBe('live_agent')
  })

  it('客人那一句話自己就不會被 AI 接走（同一次 webhook 內就查得到抑制）', async () => {
    const { sessionId } = await inboundAfterHumanReply(20 * MINUTE)
    expect(await shouldSuppressInboundBotAutomationForSession(sessionId)).toBe(true)
  })

  it('真人回完 12 秒客人就追問（按結束會話那種）：照樣留給真人', async () => {
    const { session } = await inboundAfterHumanReply(12_000)
    expect(session.status).toBe('human_handling')
  })

  /**
   * 老闆拍板的核心：**沒有時限**。先前那版 48 小時窗口等於「時間到自動把客人交回 AI」，
   * 而客服要的是「我沒切就不要轉」。
   */
  it('隔了 5 天客人才回來：還是真人的（真人沒按結束就不會自動轉回 AI）', async () => {
    const { session } = await inboundAfterHumanReply(5 * 24 * HOUR)
    expect(session.status).toBe('human_handling')
  })

  it('隔了三個月也一樣，而且完全不用讀工作區設定（沒有時限可比）', async () => {
    const { session } = await inboundAfterHumanReply(90 * 24 * HOUR)
    expect(session.status).toBe('human_handling')
    expect(getAiSettings).not.toHaveBeenCalled()
  })

  it('舊對話沒有這個記號：行為完全不變（AI 照常接手）', async () => {
    const { sessionId, session } = await inboundAfterHumanReply(null)
    expect(session.status).toBe('open')
    expect(session.currentHandler).toBe('unhandled')
    expect(await shouldSuppressInboundBotAutomationForSession(sessionId)).toBe(false)
  })

  it('加好友／活動入口出生的會話不標真人（客人還沒開口，標了會擋掉迎賓流程）', async () => {
    const { session } = await inboundAfterHumanReply(10 * MINUTE, { origin: 'follow' })
    expect(session.status).toBe('open')
  })

  it('時間軸要講出為什麼（不然客服只看到 AI 忽然不回話）', async () => {
    const { harness } = await inboundAfterHumanReply(10 * MINUTE)
    expect(harness.state.events.map(e => e.eventType)).toContain('human_lead_continued')
  })

  it('沒有延續真人時不寫那筆事件（時間軸不該多一行沒發生的事）', async () => {
    const { harness } = await inboundAfterHumanReply(null)
    expect(harness.state.events.map(e => e.eventType)).not.toContain('human_lead_continued')
  })

  it('帶上真人最後回覆時間：開了「閒置自動交還機器人」的工作區才收得掉這種場', async () => {
    const { session } = await inboundAfterHumanReply(10 * MINUTE)
    expect(session.humanLastRepliedAt?.toMillis?.()).toBe(Date.now() - 10 * MINUTE)
  })

  /**
   * 這條是這次改動最容易犯的錯：把新會話直接記成「真人首接」很省事，但真人在**這一場**
   * 還沒回過話——客人回一句「好，謝謝」而沒人理，帳面上會變成有人接了，
   * 「沒人回的對話」就會憑空少一批（老闆看的正是那個數字）。
   */
  it('統計欄位一律留白：真人在這場還沒回過話，不可以先記成真人首接', async () => {
    const { session } = await inboundAfterHumanReply(10 * MINUTE)
    expect(session.initialHandler).toBe('unhandled')
    expect(session.initialModuleType).toBeNull()
    expect(session.humanFirstRepliedAt).toBeNull()
    // 也不是「轉真人」：客人沒有要求轉接，這場本來就是真人的
    expect(session.hasHandoff).toBe(false)
    expect(session.handoffRequestedAt).toBeNull()
  })
})

describe('放手只有真人自己按的算', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T10:04:00Z'))
    _invalidateUserSessionCache(LINE_UID)
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS })
  })
  afterEach(() => { vi.useRealTimers() })

  it('真人按「結束會話」→ 記號清掉，客人下次來訊由 AI 正常接手', async () => {
    const { sessionId, harness } = await inboundAfterHumanReply(10 * MINUTE)
    harness.state.conv.currentSessionId = sessionId

    await closeConversationSession(sessionId, LINE_UID)

    expect(harness.state.conv).not.toHaveProperty('lastHumanActionAt')
    expect((await inboundAgain(harness)).status).toBe('open')
  })

  it('真人按「交還機器人」→ 記號也要清掉（否則那顆按鈕只生效一次）', async () => {
    const { sessionId, harness } = await inboundAfterHumanReply(10 * MINUTE)
    harness.state.conv.currentSessionId = sessionId

    expect(await handBackSessionToBot(sessionId, LINE_UID)).toBe(true)

    expect(harness.state.conv).not.toHaveProperty('lastHumanActionAt')
    expect((await inboundAgain(harness)).status).toBe('open')
  })

  /**
   * 排程把太久沒動靜的場收起來（`H-9` 的保底）只是整理紀錄，**不是真人放手**。
   * 清掉記號就等於「時間到自動把客人交回 AI」，正是這次拍板要防的行為。
   */
  it('系統排程自動結束（idle_auto）不清記號：客人回來還是真人的', async () => {
    const { sessionId, harness } = await inboundAfterHumanReply(10 * MINUTE)
    harness.state.conv.currentSessionId = sessionId

    await closeConversationSession(sessionId, LINE_UID, { reason: 'idle_auto' })

    expect(harness.state.conv).toHaveProperty('lastHumanActionAt')
    expect((await inboundAgain(harness)).status).toBe('human_handling')
  })
})

describe('延續真人開場的會話：真人真的回了要補記首接', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T10:04:00Z'))
    _invalidateUserSessionCache(LINE_UID)
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS })
  })
  afterEach(() => { vi.useRealTimers() })

  it('客服在這場回話 → 記真人首接（否則統計永遠說這場沒人回）', async () => {
    const { sessionId, harness } = await inboundAfterHumanReply(10 * MINUTE)
    harness.state.conv.currentSessionId = sessionId

    await onHumanOutgoingMessage(LINE_UID, WS)

    const session = harness.state.sessions[sessionId]!
    expect(session.humanFirstRepliedAt).toBe('__ts__')
    expect(session.initialHandler).toBe('human')
    expect(session.initialModuleType).toBe('live_agent')
    expect(harness.state.events.map(e => e.eventType)).toContain('human_first_reply')
    // 不是轉真人：沒有人先接過再交出去
    expect(session.hasHandoff).toBe(false)
  })

  it('正式轉真人來的場不會被改寫首接（那場的首接是進 live_agent 時記的）', async () => {
    const harness = makeDb({ currentSessionId: 'sess-handoff' })
    harness.state.sessions['sess-handoff'] = {
      workspaceId: WS,
      userId: LINE_UID,
      status: 'pending_human',
      initialHandler: 'ai',
      initialModuleType: 'ai',
      hasHandoff: true,
      humanFirstRepliedAt: null,
    }
    vi.mocked(getDb).mockReturnValue(harness.db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    const session = harness.state.sessions['sess-handoff']!
    expect(session.humanFirstRepliedAt).toBe('__ts__')
    expect(session.initialHandler).toBe('ai')
    expect(session.initialModuleType).toBe('ai')
  })
})
