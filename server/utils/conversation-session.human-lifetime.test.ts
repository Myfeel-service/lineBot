/**
 * 真人接手中的會話不吃「24 小時自動結束」。
 *
 * 現場問題：客服今天下午跟客人談到一半，客人隔天下午才回一句「好，那就這樣訂」——
 * 24 小時規則把它判成新的一場，真人接手的狀態整個蒸發，AI 搶著回答那句話，
 * 而客服看到自己那場被標成「會話已結束」。
 *
 * 這組測試守住：真人接手中（待真人／真人處理中）續命到保底時限，其餘狀態照舊 24 小時。
 *
 * 2026-08-21 拍板把「太久沒動靜自動結束」改成開關且**預設關**（`humanSessionMaxIdleHours=0`）：
 * 關著就永不換場——真人接手的對話只有真人自己按「結束會話」／「交還機器人」才結束。
 * 這樣做的前提是 `H-13`：AI 要不要閉嘴看的是對話上的 `lastHumanActionAt` 記號，
 * 不再靠這場會話有沒有開著，所以不自動結束**不會**再造成「那位客人從此收不到自動回覆」。
 * 開了開關（>0）就照設定的時數收，且下界仍鎖 24 小時（不然真人的場比機器人更早換場）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

import {
  ensureConversationSession,
  humanSessionMaxIdleMs,
  _invalidateUserSessionCache,
} from './conversation-session'
import { getDb } from './firebase'
import { DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS } from '~~/shared/types/ai-knowledge'
import { SESSION_24H_MS } from '~~/shared/types/conversation-stats'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const SESSION_ID = 'sess-1'
const HOUR = 3600_000

function makeDb(status: string, lastActivityMs: number) {
  const state = {
    sessions: {
      [SESSION_ID]: {
        workspaceId: WS,
        userId: LINE_UID,
        status,
        lastActivityAt: { toMillis: () => lastActivityMs },
        hasInbound: true,
      } as Record<string, any>,
    } as Record<string, Record<string, any>>,
    conv: { currentSessionId: SESSION_ID } as Record<string, any>,
  }

  const snap = (col: string, id: string) => {
    if (col === 'conversationSessions') {
      const doc = state.sessions[id]
      return { exists: !!doc, data: () => doc }
    }
    if (col === 'conversations') return { exists: true, data: () => state.conv }
    return { exists: true, data: () => ({}) }
  }

  const docFor = (col: string, id: string) => ({
    __col: col,
    __id: id,
    get: vi.fn(async () => snap(col, id)),
    set: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions') state.sessions[id] = { ...state.sessions[id], ...patch }
      if (col === 'conversations') Object.assign(state.conv, patch)
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
        if (ref.__col === 'conversations') Object.assign(state.conv, patch)
      },
      update: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') Object.assign(state.sessions[ref.__id]!, patch)
      },
    })),
    batch: () => ({ update: () => {}, commit: async () => {} }),
  }
  return { db, state }
}

/** 客人在 `idleHours` 小時沒動靜之後回了一句話 → 回傳這句話落在哪一場 */
async function inboundAfterIdle(status: string, idleHours: number): Promise<string> {
  const { db } = makeDb(status, Date.now() - idleHours * HOUR)
  vi.mocked(getDb).mockReturnValue(db as any)
  return ensureConversationSession(LINE_UID, WS)
}

describe('真人接手中的會話：客人隔天回來要接在同一場', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T01:00:00Z'))
    _invalidateUserSessionCache(LINE_UID)
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS })
  })
  afterEach(() => { vi.useRealTimers() })

  it('真人處理中閒置 30 小時：客人回話仍接在同一場（不換場、AI 不會搶答）', async () => {
    expect(await inboundAfterIdle('human_handling', 30)).toBe(SESSION_ID)
  })

  it('待真人閒置 30 小時：同樣接在同一場（已跟客人說要安排專員，不能默默換場）', async () => {
    expect(await inboundAfterIdle('pending_human', 30)).toBe(SESSION_ID)
  })

  it('機器人處理中閒置 30 小時：照舊算新的一段對話', async () => {
    expect(await inboundAfterIdle('bot_handling', 30)).toBe('new-session-id')
  })

  it('自動結束關著（預設）：閒置 50 小時也不換場，等真人自己按結束', async () => {
    expect(await inboundAfterIdle('human_handling', 50)).toBe(SESSION_ID)
  })

  it('自動結束關著：連閒置一個月都還接在同一場', async () => {
    expect(await inboundAfterIdle('human_handling', 30 * 24)).toBe(SESSION_ID)
  })

  it('開了自動結束（48 小時）且超過：換場，不能無限期掛著', async () => {
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: 48 })
    expect(await inboundAfterIdle('human_handling', 50)).toBe('new-session-id')
  })

  it('保底時限照工作區設定走（設 72 小時 → 閒置 50 小時仍同一場）', async () => {
    getAiSettings.mockResolvedValue({ humanSessionMaxIdleHours: 72 })
    expect(await inboundAfterIdle('human_handling', 50)).toBe(SESSION_ID)
  })

  it('24 小時內完全不去讀工作區設定（一般訊息不該多付一次讀取）', async () => {
    await inboundAfterIdle('human_handling', 2)
    expect(getAiSettings).not.toHaveBeenCalled()
  })

  it('保底時限設得比 24 小時短也不會讓真人接手比機器人更早換場', () => {
    expect(humanSessionMaxIdleMs(6)).toBe(SESSION_24H_MS)
    expect(humanSessionMaxIdleMs(48)).toBe(48 * HOUR)
  })

  /**
   * 0 ＝ 開關關閉（預設）→ 永不換場。⛔ 不可以讓 0 掉進「下界 24 小時」那條路：
   * 那會讓「關掉自動結束」變成「24 小時就換場」，跟畫面上寫的完全相反。
   * 髒值（設定讀取失敗、舊 doc 缺欄位）也走這條：寧可讓那場掛著，也不要在真人還沒放手時
   * 把客人交回 AI。
   */
  it('0 或髒值＝關閉自動結束，永不換場', () => {
    expect(humanSessionMaxIdleMs(0)).toBe(Number.POSITIVE_INFINITY)
    expect(humanSessionMaxIdleMs(undefined)).toBe(Number.POSITIVE_INFINITY)
    expect(humanSessionMaxIdleMs(-5)).toBe(Number.POSITIVE_INFINITY)
  })
})
