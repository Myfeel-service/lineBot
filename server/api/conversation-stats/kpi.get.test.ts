import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KPI_SESSION_FIELDS } from '~~/server/utils/conversation-stats-fields'

/**
 * KPI 卡的欄位投影測試（`E-22`）。
 *
 * 這裡專測一件事：**投影漏欄位不會報錯，只會讓數字靜靜地算錯**。
 * 所以下面的假 Firestore 會照 `.select()` 真的把欄位裁掉——漏了哪一欄，
 * 對應的數字就會歸零／變成「沒人回」，測試當場紅掉。
 * 這是加投影唯一值得測的地方：算式本身沒動，動的是「資料到不到得了算式手上」。
 */

const WS = 'ws1'

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

const ts = (iso: string) => ({ toMillis: () => new Date(iso).getTime(), toDate: () => new Date(iso) })

/** 一場「客人來了、AI 先回、後來轉真人而且等超過 SLA」的場——它一個人就用到全部欄位 */
const SESSION_FULL = {
  workspaceId: WS,
  userId: 'U0001',
  openedAt: ts('2026-08-20T02:00:00Z'),
  origin: 'message',
  hasInbound: true,
  initialHandler: 'ai',
  hasHandoff: true,
  status: 'closed',
  handoffRequestedAt: ts('2026-08-20T02:05:00Z'),
  humanFirstRepliedAt: ts('2026-08-20T03:30:00Z'), // 等了 85 分鐘 > 30
  // 以下這些是統計不需要、但真實文件上有的肥欄位：投影正確的話它們不該被搬回來
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
  openedAt: ts('2026-08-20T05:00:00Z'),
  origin: 'follow',
  hasInbound: false,
  initialHandler: 'unhandled',
  hasHandoff: false,
  status: 'open',
}

const SESSIONS = [SESSION_FULL, SESSION_UNHANDLED, SESSION_PRE_INBOUND]

/**
 * 假 Firestore。關鍵在 `select()`：它會記下投影清單，`get()` 只回那些欄位——
 * 跟正式 Firestore 的行為一致，所以「漏投影」在這裡會現形。
 */
function fakeDb() {
  const selected: string[] = []
  const users: Record<string, { displayName: string }> = {
    [`${WS}_U0001`]: { displayName: '小明' },
    [`${WS}_U0002`]: { displayName: '小華' },
  }

  const collection = (name: string) => {
    if (name === 'users') {
      const q: any = {
        where: () => q,
        select: () => q,
        count: () => ({ get: async () => ({ data: () => ({ count: 7 }) }) }),
        get: async () => ({ docs: [] }),
        doc: (id: string) => ({
          get: async () => ({ exists: !!users[id], data: () => users[id] }),
        }),
      }
      return q
    }
    const q: any = {
      where: () => q,
      orderBy: () => q,
      select: (...fields: string[]) => { selected.push(...fields); return q },
      get: async () => ({
        docs: SESSIONS.map(row => ({
          id: row.userId,
          data: () => {
            // 沒呼叫 select 就回整份；有的話只回投影到的欄位（＝正式 Firestore 的行為）
            if (!selected.length) return row
            const out: Record<string, unknown> = {}
            for (const f of selected) {
              if (f in row) out[f] = (row as Record<string, unknown>)[f]
            }
            return out
          },
        })),
      }),
    }
    return q
  }
  return { db: { collection } as any, selected }
}

async function runKpi() {
  const { db } = fakeDb()
  vi.mocked(getDb).mockReturnValue(db)
  currentQuery = { startDate: '2026-08-01', endDate: '2026-08-31' }
  return await (handler as any)({} as never)
}

describe('KPI 欄位投影（E-22）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('投影過的資料算出來的每一格都要跟整份文件一樣（漏欄位就會紅）', async () => {
    const kpi = await runKpi()

    expect(kpi.total).toBe(2) // 加好友沒開口那場不算
    expect(kpi.aiHandled).toBe(1) // 讀 initialHandler
    expect(kpi.unhandled).toBe(1)
    expect(kpi.handoffCount).toBe(1) // 讀 hasHandoff
    expect(kpi.aiEscalated).toBe(1) // initialHandler × hasHandoff 交叉
    expect(kpi.closedCount).toBe(1) // 讀 status
    // 讀 handoffRequestedAt + humanFirstRepliedAt：等 85 分鐘 > 門檻 30
    expect(kpi.handoffWaitExceeded).toBe(1)
    expect(kpi.handoffWaitSlaMinutes).toBe(30)
    // 讀 userId → 才補得到名字（沒投影 userId 的話這裡會變 'LINE 用戶'）
    expect(kpi.unhandledSamples).toEqual([{ userId: 'U0002', displayName: '小華' }])
    expect(kpi.handoffWaitSamples).toEqual([{ userId: 'U0001', displayName: '小明' }])
  })

  it('投影清單本身要蓋住算式讀到的每一欄（新增算式忘了加欄位就會紅）', async () => {
    // 這條是白箱檢查：把清單釘死，改動時逼人回來看一眼上面那條測試
    expect(KPI_SESSION_FIELDS.sort()).toEqual([
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
    const { db, selected } = fakeDb()
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { startDate: '2026-08-01', endDate: '2026-08-31' }
    await (handler as any)({} as never)

    expect(selected.length).toBeGreaterThan(0) // 有呼叫 select
    expect(selected).not.toContain('closingPreview') // 那段肥快照留在資料庫就好
    expect(selected).not.toContain('lastActivityAt')
  })
})
