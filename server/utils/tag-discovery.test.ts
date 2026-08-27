import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./gemini', () => ({ generateJson: vi.fn(), runWithLlmBudget: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
// ⛔ 要回 promise：呼叫端是 `recordAiUsage(...).catch(...)`，回 undefined 會讓整輪掃描報錯
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./scanner-health', () => ({ recordScannerFailure: vi.fn() }))
vi.mock('./user-display-names', () => ({ fetchUserDisplayNames: vi.fn(async () => ({})) }))

import { generateJson, runWithLlmBudget } from './gemini'
import { getAiSettings } from './ai-settings'
import { buildDiscoveryPrompt, scanTagDiscovery } from './tag-discovery'

describe('AI 發現新標籤：prompt', () => {
  const digests = [
    { userDocId: 'ws_u1', text: '請問除濕機保固多久 / 6L 跟 12L 差在哪' },
    { userDocId: 'ws_u2', text: '想買來送爸爸 可以包裝嗎' },
  ]

  it('對話摘要逐行帶場次編號（模型靠編號指回名單）', () => {
    const p = buildDiscoveryPrompt(digests, [])
    expect(p).toContain('S0: 請問除濕機保固多久')
    expect(p).toContain('S1: 想買來送爸爸')
  })

  it('排除名單要整串進 prompt——既有標籤與否決過的主題不准再提', () => {
    const p = buildDiscoveryPrompt(digests, ['在看除濕機', '想送禮'])
    expect(p).toContain('在看除濕機、想送禮')
    expect(p).toContain('不要再提')
  })

  it('沒有排除名單時明講（無），不留空白讓模型自由發揮', () => {
    expect(buildDiscoveryPrompt(digests, [])).toContain('（無）')
  })

  it('粒度紅線寫死在 prompt：品類不是型號', () => {
    const p = buildDiscoveryPrompt(digests, [])
    expect(p).toContain('品類')
    expect(p).toContain('不要提「在看某品牌 6L 除濕機」')
  })
})

/**
 * 掃描結果真的有寫進資料嗎（`C-94`）。
 *
 * ⛔ **這組存在的理由**：純函式測綠 ＋ typecheck 綠 ≠ 新欄位真的被寫出去。
 * 這條路徑要跨掃描器 → Firestore 寫入，只測 `discoveryScanOutcomeText` 的話，
 * 「掃描器根本沒把 outcome 放進 set()」這種漏接完全測不到——畫面照樣印那句泛用的，
 * 而老闆的問題（按了幾次都沒有新的）一個字都沒被回答。
 *
 * 迷你假 Firestore：只實作這條路徑真的用到的鏈（workspaces / tagDiscovery /
 * conversationSessions / conversations.messages / tags），寫入全部記下來供斷言。
 */
function fakeDb(opts: {
  /** 每場對話：這位客人說了哪些話 */
  sessions: Array<{ userId: string; texts: string[] }>
  /** 既有標籤名 */
  tagNames?: string[]
  /** tagDiscovery 現況 */
  discoveryDoc?: Record<string, unknown> | null
}) {
  const writes: Array<Record<string, any>> = []
  const emptySnap = { size: 0, docs: [], empty: true }

  const sessionDocs = opts.sessions.map(s => ({ data: () => ({ userId: s.userId, hasInbound: true }) }))
  const tagDocs = (opts.tagNames ?? []).map(name => ({ data: () => ({ name }) }))
  // 逐場抽訊息時是用 users 主鍵（lineUserFirestoreDocId）撈的 → 先以 userId 建索引，撈時比對後綴
  const textsByUserId = new Map(opts.sessions.map(s => [s.userId, s.texts]))

  const chain = (result: any) => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      select: () => q,
      get: async () => result,
    }
    return q
  }

  const db: any = {
    collection(name: string) {
      if (name === 'workspaces') return chain({ docs: [{ id: 'ws1' }] })
      if (name === 'conversationSessions') return chain({ size: sessionDocs.length, docs: sessionDocs })
      if (name === 'tags') return chain({ size: tagDocs.length, docs: tagDocs })
      if (name === 'tagDiscovery') {
        return {
          doc: () => ({
            get: async () => ({ exists: !!opts.discoveryDoc, data: () => opts.discoveryDoc ?? undefined }),
            set: async (d: Record<string, any>) => { writes.push(d) },
          }),
        }
      }
      if (name === 'conversations') {
        return {
          doc: (userDocId: string) => ({
            collection: () => {
              const hit = [...textsByUserId.entries()].find(([uid]) => userDocId.includes(uid))
              const msgDocs = (hit?.[1] ?? []).map(text => ({
                data: () => ({ direction: 'incoming', text, messageType: 'text' }),
              }))
              return chain({ docs: msgDocs })
            },
          }),
        }
      }
      return chain(emptySnap)
    },
  }
  return { db, writes }
}

/** 湊出 n 場「不同客人、有講話」的對話 */
const manySessions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ userId: `U${i}`, texts: [`我想問除濕機的事情 第 ${i} 位`] }))

describe('掃描結果要寫進資料（沒提出東西時，這是唯一講得出「為什麼」的地方）', () => {
  beforeEach(() => {
    vi.mocked(getAiSettings).mockResolvedValue({ autoTagSuggest: { enabled: true } } as any)
    // runWithLlmBudget 是「包一層額度控管」→ 直接執行內層，讓 generateJson 的假回應生效
    vi.mocked(runWithLlmBudget).mockImplementation(async (_wid: any, fn: any) => {
      const data = await fn()
      return { data, inputTokens: 10, outputTokens: 5 } as any
    })
    vi.mocked(generateJson).mockResolvedValue({ topics: [] } as any)
  })

  /** 掃描器每輪只花 1 次讀取就走人（間隔閘門），要真的跑得先讓上次掃描夠久以前 */
  const NEVER_SCANNED = { workspaceId: 'ws1', pending: [], dismissedNames: [], lastScanMs: 0 }

  it('⛔ 樣本太少 → 寫 too_few_sessions（連 LLM 都沒呼叫，不可以記成「AI 沒找到主題」）', async () => {
    const { db, writes } = fakeDb({ sessions: manySessions(2), discoveryDoc: NEVER_SCANNED })
    await scanTagDiscovery(db)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.lastScan).toMatchObject({ kind: 'too_few_sessions', sessionCount: 2, userCount: 2 })
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('AI 讀完覺得沒主題 → 寫 no_topics，並記下讀了幾段、幾位客人', async () => {
    const { db, writes } = fakeDb({ sessions: manySessions(6), discoveryDoc: NEVER_SCANNED })
    await scanTagDiscovery(db)

    expect(writes[0]!.lastScan).toMatchObject({ kind: 'no_topics', sessionCount: 6, userCount: 6, rawCount: 0 })
  })

  /** 這條就是 08-26 線上那次「提 0 個」的真實情境：模型有提，全被守門員刷掉 */
  it('⛔ AI 有提但全被擋掉 → 寫 all_filtered 並留下是哪幾條、為什麼（先前只有一行 log，畫面查不到）', async () => {
    vi.mocked(generateJson).mockResolvedValue({
      topics: [
        { name: '在看除濕機', code: 'a', category: 'interest', criteria: '問過除濕機', sessions: [0, 1, 2, 3] },
        { name: '想送禮', code: 'b', category: 'interest', criteria: '說要送人', sessions: [0, 1] },
      ],
    } as any)
    const { db, writes } = fakeDb({
      sessions: manySessions(6),
      tagNames: ['在看除濕機'], // 第一條撞既有標籤
      discoveryDoc: NEVER_SCANNED,
    })
    await scanTagDiscovery(db)

    expect(writes[0]!.lastScan).toMatchObject({ kind: 'all_filtered', rawCount: 2, keptCount: 0 })
    expect(writes[0]!.lastScan.dropped).toEqual([
      { name: '在看除濕機', reason: 'duplicate' },
      { name: '想送禮', reason: 'too_few_users' },
    ])
    expect(writes[0]!.pending).toEqual([])
  })

  it('真的提出東西 → 寫 proposed，提案照樣進收件匣（沒有為了記結果而改掉原本的行為）', async () => {
    vi.mocked(generateJson).mockResolvedValue({
      topics: [{ name: '在看除濕機', code: 'a', category: 'interest', criteria: '問過除濕機', sessions: [0, 1, 2, 3] }],
    } as any)
    const { db, writes } = fakeDb({ sessions: manySessions(6), discoveryDoc: NEVER_SCANNED })
    await scanTagDiscovery(db)

    expect(writes[0]!.lastScan).toMatchObject({ kind: 'proposed', rawCount: 1, keptCount: 1 })
    expect(writes[0]!.pending).toHaveLength(1)
    expect(writes[0]!.pending[0]).toMatchObject({ name: '在看除濕機' })
    expect(writes[0]!.pending[0].id).toBeTruthy() // ⛔ id 是伺服器產的，模型只產內容
  })
})
