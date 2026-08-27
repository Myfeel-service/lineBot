import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KPI_SESSION_FIELDS } from '~~/server/utils/conversation-stats-fields'

/**
 * KPI 卡：欄位投影（`E-22`）＋日結（`E-29`）。
 *
 * 兩件事在這裡釘死：
 * ① **投影漏欄位不會報錯，只會讓數字靜靜地算錯**——所以假 Firestore 會照 `.select()`
 *    真的把欄位裁掉，漏了哪一欄，對應的數字就會歸零／變成「沒人回」。
 * ② **走日結與走現場算必須算出一模一樣的東西**——這是日結唯一該測的事。
 *    不一樣的話，使用者會看到「同一頁的數字自己會變」，那比慢兩秒嚴重得多。
 */

const WS = 'ws1'
// 「今天」固定住：日結刻意不含今天（今天還沒過完），測試要能分得出哪幾天走哪條路
const TODAY = '2026-08-31'
const NOW = new Date('2026-08-31T05:00:00Z') // 台北 13:00

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, role: 'owner' })),
}))
vi.mock('~~/server/utils/ai-settings', () => ({
  getAiSettings: vi.fn(async () => ({ handoffNotify: { slaRemindMinutes: 30 }, serviceHours: undefined })),
}))

let currentQuery: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => currentQuery)
vi.stubGlobal('createError', (o: { statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'e'), o))

const { default: handler } = await import('./kpi.get')
const { getDb } = await import('~~/server/utils/firebase')
const rollup = await import('~~/server/utils/conversation-stats-rollup')

const ts = (iso: string) => ({ toMillis: () => new Date(iso).getTime(), toDate: () => new Date(iso) })

/** 一場「客人來了、AI 先回、後來轉真人而且等超過門檻」的場——它一個人就用到全部欄位 */
const SESSION_FULL = {
  workspaceId: WS,
  userId: 'U0001',
  openedAt: ts('2026-08-20T02:00:00Z'), // 台北 8/20
  origin: 'message',
  hasInbound: true,
  initialHandler: 'ai',
  hasHandoff: true,
  status: 'closed',
  handoffRequestedAt: ts('2026-08-20T02:05:00Z'),
  humanFirstRepliedAt: ts('2026-08-20T03:30:00Z'), // 等了 85 分鐘 > 30
  // 以下是統計不需要、但真實文件上有的肥欄位：投影正確的話它們不該被搬回來
  closingPreview: '一大段結束快照'.repeat(50),
  lastActivityAt: ts('2026-08-20T03:31:00Z'),
}

/** 沒人回的場 */
const SESSION_UNHANDLED = {
  workspaceId: WS,
  userId: 'U0002',
  openedAt: ts('2026-08-20T04:00:00Z'),
  origin: 'message',
  hasInbound: true,
  initialHandler: 'unhandled',
  hasHandoff: false,
  status: 'open',
}

/** 加好友出生、客人還沒開口 → 不進統計 */
const SESSION_PRE_INBOUND = {
  workspaceId: WS,
  userId: 'U0003',
  openedAt: ts('2026-08-21T05:00:00Z'),
  origin: 'follow',
  hasInbound: false,
  initialHandler: 'unhandled',
  hasHandoff: false,
  status: 'open',
}

/** 今天才開的場（測「今天一律現場算」） */
const SESSION_TODAY = {
  workspaceId: WS,
  userId: 'U0004',
  openedAt: ts('2026-08-31T01:00:00Z'), // 台北 8/31
  origin: 'message',
  hasInbound: true,
  initialHandler: 'bot',
  hasHandoff: false,
  status: 'bot_handling',
}

const SESSIONS = [SESSION_FULL, SESSION_UNHANDLED, SESSION_PRE_INBOUND, SESSION_TODAY]

/**
 * 假 Firestore。三件事跟正式行為對齊：
 * ①`select()` 真的裁欄位 ②`openedAt` 範圍條件真的會篩（日結只查得到它那一天）
 * ③`getAll` 回得了預先塞好的日結文件
 */
function fakeDb(opts: { rollups?: Record<string, any> } = {}) {
  const selected: string[] = []
  const users: Record<string, { displayName: string }> = {
    [`${WS}_U0001`]: { displayName: '小明' },
    [`${WS}_U0002`]: { displayName: '小華' },
  }
  const sessionQueries: { from: number, to: number }[] = []

  const collection = (name: string) => {
    const state = { from: -Infinity, to: Infinity, selected: [] as string[] }
    const q: any = {
      where: (field: string, op: string, value: any) => {
        if (field === 'openedAt' || field === 'createdAt') {
          const ms = value instanceof Date ? value.getTime() : value?.toMillis?.() ?? 0
          if (op === '>=') state.from = ms
          if (op === '<=') state.to = ms
        }
        return q
      },
      orderBy: () => q,
      select: (...fields: string[]) => {
        state.selected = fields
        if (name === 'conversationSessions') selected.push(...fields)
        return q
      },
      count: () => ({ get: async () => ({ data: () => ({ count: 7 }) }) }),
      get: async () => {
        if (name === 'users') {
          // 新朋友：這組測試不看數字，只要不炸（回空）
          return { docs: [] }
        }
        sessionQueries.push({ from: state.from, to: state.to })
        const rows = SESSIONS.filter((r) => {
          const ms = r.openedAt.toMillis()
          return ms >= state.from && ms <= state.to
        })
        return {
          docs: rows.map(row => ({
            id: row.userId,
            data: () => {
              if (!state.selected.length) return row
              const out: Record<string, unknown> = {}
              for (const f of state.selected) if (f in row) out[f] = (row as Record<string, unknown>)[f]
              return out
            },
          })),
        }
      },
      doc: (id: string) => ({
        get: async () => {
          if (name === 'users') return { exists: !!users[id], data: () => users[id] }
          return { exists: false, data: () => undefined }
        },
      }),
    }
    return q
  }

  const db: any = {
    collection,
    getAll: async (...refs: any[]) => refs.map(r => r.__doc),
  }
  // getAll 需要拿得到「這是哪個日結」→ 讓 conversationStatsDaily 的 doc() 帶上結果
  const origCollection = db.collection
  db.collection = (name: string) => {
    if (name !== rollup.STATS_DAILY_COLLECTION) return origCollection(name)
    return {
      doc: (id: string) => {
        const data = opts.rollups?.[id]
        return { __doc: { exists: !!data, data: () => data } }
      },
    }
  }
  return { db, selected, sessionQueries }
}

async function runKpi(db: any, q: Record<string, unknown> = {}) {
  vi.mocked(getDb).mockReturnValue(db)
  currentQuery = { startDate: '2026-08-19', endDate: '2026-08-31', ...q }
  return await (handler as any)({} as never)
}

/**
 * 用同一份 SESSIONS 產生「正確的日結」，好比對兩條路的結果。
 * ⚠️ **沒有對話的日子也要有一筆**（0 場也是答案）——正式的排程就是每一天都寫一筆；
 * 少了那些日子，讀取端會判定「這幾天沒有日結」而整段改走現場算，測不到日結那條路。
 */
function rollupsFromSessions(range = { from: '2026-08-19', to: '2026-08-30' }) {
  const days = rollup.buildDaysFromSessions(SESSIONS as any)
  const out: Record<string, any> = {}
  for (const date of rollup.taipeiDayKeysBetween(new Date(`${range.from}T00:00:00+08:00`), new Date(`${range.to}T00:00:00+08:00`))) {
    if (date === TODAY) continue // 今天不建日結
    const day = days.get(date) ?? rollup.emptyDayStats(date)
    out[`${WS}_${date}`] = {
      ...day,
      workspaceId: WS,
      version: rollup.ROLLUP_VERSION,
      builtAt: Date.now(),
      waitsTruncated: false,
      // 真實排程會寫當天實際的新朋友數；這組測試的假 users 查詢回空 → 0
      newFriends: 0,
    }
  }
  return out
}

describe('KPI：日結與現場算必須一致（E-29）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ now: NOW, toFake: ['Date'] }) })

  it('沒有日結（全部現場算）：每一格都算對', async () => {
    const kpi = await runKpi(fakeDb().db)

    expect(kpi.total).toBe(3) // 加好友沒開口那場不算，今天那場算
    expect(kpi.aiHandled).toBe(1)
    expect(kpi.botHandled).toBe(1) // 今天那場
    expect(kpi.unhandled).toBe(1)
    expect(kpi.handoffCount).toBe(1)
    expect(kpi.aiEscalated).toBe(1)
    expect(kpi.closedCount).toBe(1)
    expect(kpi.handoffWaitExceeded).toBe(1) // 等 85 分鐘 > 門檻 30
    expect(kpi.handoffWaitSlaMinutes).toBe(30)
    expect(kpi.unhandledSamples).toEqual([{ userId: 'U0002', displayName: '小華' }])
    expect(kpi.handoffWaitSamples).toEqual([{ userId: 'U0001', displayName: '小明' }])
  })

  it('有日結：輸出與現場算**逐格相同**（這一行紅掉＝使用者會看到數字自己變）', async () => {
    const live = await runKpi(fakeDb().db)
    const withRollup = await runKpi(fakeDb({ rollups: rollupsFromSessions() }).db)

    expect(withRollup).toEqual(live)
  })

  it('有日結時只查「今天」那一段對話（＝真的少讀了資料）', async () => {
    const f = fakeDb({ rollups: rollupsFromSessions() })
    await runKpi(f.db)

    // 只有一支對話查詢，而且範圍落在今天
    expect(f.sessionQueries).toHaveLength(1)
    const todayStart = new Date('2026-08-30T16:00:00Z').getTime() // 台北 8/31 00:00
    expect(f.sessionQueries[0]!.from).toBe(todayStart)
  })

  it('今天的日結一律不採用（今天還沒過完，數字還在動）', async () => {
    // 故意塞一筆「今天」的假日結，內容明顯錯（100 場）
    const rollups = {
      ...rollupsFromSessions(),
      [`${WS}_${TODAY}`]: {
        ...rollup.emptyDayStats(TODAY), total: 100, bot: 100,
        workspaceId: WS, version: rollup.ROLLUP_VERSION, builtAt: Date.now(), waitsTruncated: false,
      },
    }
    const kpi = await runKpi(fakeDb({ rollups }).db)
    expect(kpi.total).toBe(3) // 不是 102：今天那格是現場算的
  })

  it('日結版本不合（改過算式）→ 當作沒有，改走現場算', async () => {
    const stale = rollupsFromSessions()
    for (const k of Object.keys(stale)) stale[k]!.version = rollup.ROLLUP_VERSION - 1
    const live = await runKpi(fakeDb().db)
    const withStale = await runKpi(fakeDb({ rollups: stale }).db)
    expect(withStale).toEqual(live)
  })

  it('轉真人門檻是**讀取時**才套（老闆改門檻，歷史數字要跟著改口徑）', async () => {
    const { getAiSettings } = await import('~~/server/utils/ai-settings')
    // 門檻改成 120 分鐘 → 等 85 分鐘那場就不該再算「等太久」
    vi.mocked(getAiSettings).mockResolvedValue({ handoffNotify: { slaRemindMinutes: 120 } } as never)
    const kpi = await runKpi(fakeDb({ rollups: rollupsFromSessions() }).db)
    expect(kpi.handoffWaitExceeded).toBe(0)
    expect(kpi.handoffWaitSlaMinutes).toBe(120)
  })

  it('日結裡的新朋友是「查不到」時，整段回 -1 而不是裝 0', async () => {
    const rollups = rollupsFromSessions()
    // 模擬排程當時查不到新朋友（索引還沒好之類）
    rollups[`${WS}-nope`] = undefined as never
    for (const k of Object.keys(rollups)) if (rollups[k]) rollups[k]!.newFriends = null
    const kpi = await runKpi(fakeDb({ rollups }).db)
    // ⛔ 這一行變成 0 就是把「查不到」講成「沒有人加入」
    expect(kpi.newFriends).toBe(-1)
  })

  it('投影清單要蓋住算式讀到的每一欄（新增算式忘了加欄位就會紅）', () => {
    expect([...KPI_SESSION_FIELDS].sort()).toEqual([
      'hasHandoff',
      'hasInbound',
      'handoffRequestedAt',
      'humanFirstRepliedAt',
      'initialHandler',
      'openedAt',
      'origin',
      'status',
      'userId',
    ].sort())
  })

  it('肥欄位不會被搬回來（投影真的有生效，不是白加）', async () => {
    const f = fakeDb()
    await runKpi(f.db)
    expect(f.selected.length).toBeGreaterThan(0)
    expect(f.selected).not.toContain('closingPreview')
    expect(f.selected).not.toContain('lastActivityAt')
  })
})
