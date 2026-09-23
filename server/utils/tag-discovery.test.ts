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
import { MAX_PENDING_DISCOVERIES, MIN_DISTINCT_USERS, discoveryScanOutcomeText } from '~~/shared/tag-discovery'

describe('AI 發現新標籤：prompt', () => {
  const digests = [
    { userDocId: 'ws_u1', text: '請問除濕機保固多久 / 6L 跟 12L 差在哪' },
    { userDocId: 'ws_u2', text: '想買來送爸爸 可以包裝嗎' },
  ]

  it('對話摘要逐行帶場次編號（模型靠編號指回名單）', () => {
    const p = buildDiscoveryPrompt(digests, [])
    expect(p).toContain('S0（客人#1）: 請問除濕機保固多久')
    expect(p).toContain('S1（客人#2）: 想買來送爸爸')
  })

  it('排除名單要整串進 prompt——既有標籤與否決過的主題不准再提', () => {
    const p = buildDiscoveryPrompt(digests, ['在看除濕機', '想送禮'])
    expect(p).toContain('在看除濕機、想送禮')
    expect(p).toContain('不要再提')
  })

  it('沒有排除名單時明講（無），不留空白讓模型自由發揮', () => {
    expect(buildDiscoveryPrompt(digests, [])).toContain('（無）')
  })

  /** `C-239`：排除名單只有名字時，模型看不出「在看料理鍋具」涵蓋電子鍋（它就提了「在看電子鍋」） */
  it('有判斷條件的既有標籤，條件一起附在排除名單裡', () => {
    const p = buildDiscoveryPrompt(digests, ['在看料理鍋具'], [
      { name: '在看料理鍋具', criteria: '客人詢問電子鍋、電鍋或料理鍋具的功能。' },
    ])
    expect(p).toContain('「在看料理鍋具」＝客人詢問電子鍋、電鍋或料理鍋具的功能。')
    expect(p).toContain('也算已存在、不要再提')
  })

  it('沒有帶條件的標籤就不多印那一行', () => {
    expect(buildDiscoveryPrompt(digests, ['在看除濕機'])).not.toContain('也算已存在')
  })

  it('粒度紅線寫死在 prompt：品類不是型號', () => {
    const p = buildDiscoveryPrompt(digests, [])
    expect(p).toContain('品類')
    expect(p).toContain('不要提「在看某品牌 6L 除濕機」')
  })

  /**
   * 🔴 線上「一直沒有新標籤」的根因（2026-09-03，`C-130`）。
   *
   * 規則說「至少 4 位不同客人」，但輸出範例只列 3 個場次編號＝模型照範例回 3 個，
   * 每次都被守門員判 `too_few_users` 整條丟掉（9/2 那次「提 3 個、留 0 個」全是這個死法）。
   * **範例與規則自相矛盾時，模型跟的是範例**，所以這條釘的是範例本身。
   * ⛔ 有人把範例改短、或把 MIN_DISTINCT_USERS 調高到超過範例長度，這條就會紅。
   */
  it('🔴 輸出範例的 sessions 必須多於「至少幾位客人」的門檻（否則照範例回答一定被刷掉）', () => {
    const p = buildDiscoveryPrompt(digests, [])
    const example = p.match(/"sessions":\[([0-9,\s]*)\]/)
    expect(example).not.toBeNull()
    const count = example![1]!.split(',').filter(s => s.trim()).length
    expect(count).toBeGreaterThan(MIN_DISTINCT_USERS)
  })

  it('明講 sessions 要列出全部支持的場次、不是舉例（列少了整條會被丟掉）', () => {
    const p = buildDiscoveryPrompt(digests, [])
    expect(p).toContain('不是舉幾個例子')
    expect(p).toContain('人數不足')
  })

  /**
   * 🔴 門檻是「4 位不同客人」，所以模型必須看得出哪幾場是同一個人（自我複審抓到）。
   * 先前每行只有 `S0:`，模型列了 7 場以為過關，守門員按客人去重只剩 3 位＝照樣被丟掉。
   */
  it('🔴 每行要標「客人#」，同一位客人的多場要看得出來是同一個人', () => {
    const p = buildDiscoveryPrompt([
      { userDocId: 'ws_u1', text: '第一場' },
      { userDocId: 'ws_u2', text: '別人的一場' },
      { userDocId: 'ws_u1', text: '同一個人的第二場' },
    ], [])
    expect(p).toContain('S0（客人#1）: 第一場')
    expect(p).toContain('S1（客人#2）: 別人的一場')
    expect(p).toContain('S2（客人#1）: 同一個人的第二場') // ⛔ 同一位客人＝同一個編號
    expect(p).toContain('同一位客人的多場只算一位')
  })

  it('🔴 明講編號範圍（範例的量級會被模仿，超出範圍的編號會被默默丟掉）', () => {
    const p = buildDiscoveryPrompt(digests, []) // 2 段 → S0 到 S1
    expect(p).toContain('S0 到 S1')
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
  /** 既有標籤（要帶 aiMode／aiCriteria 時用這個；`C-239` 起相似檢查會看這兩欄） */
  tags?: Array<{ id?: string; name: string; aiMode?: string; aiCriteria?: string }>
  /** tagDiscovery 現況 */
  discoveryDoc?: Record<string, unknown> | null
}) {
  const writes: Array<Record<string, any>> = []
  const emptySnap = { size: 0, docs: [], empty: true }

  /** 假會話：openedAt/closedAt 給固定範圍，訊息時間戳落在裡面（見 shared/tag-transcript） */
  const OPEN_MS = 1_700_000_000_000
  const CLOSE_MS = OPEN_MS + 3600_000
  const sessionDocs = opts.sessions.map(s => ({
    data: () => ({
      userId: s.userId,
      hasInbound: true,
      openedAt: { toMillis: () => OPEN_MS },
      closedAt: { toMillis: () => CLOSE_MS },
      lastActivityAt: { toMillis: () => CLOSE_MS },
    }),
  }))
  const tagDocs = [
    ...(opts.tagNames ?? []).map((name, i) => ({ id: `tag-${i}`, data: () => ({ name }) })),
    ...(opts.tags ?? []).map((t, i) => ({
      id: t.id ?? `tagx-${i}`,
      data: () => ({ name: t.name, aiMode: t.aiMode, aiCriteria: t.aiCriteria }),
    })),
  ]
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
              const msgDocs = (hit?.[1] ?? []).map((text, i) => ({
                data: () => ({
                  direction: 'incoming',
                  text,
                  messageType: 'text',
                  timestamp: { toMillis: () => OPEN_MS + 10 + i },
                }),
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

  /**
   * 🔴 撞上限要進資料，不能只 log（`C-132`）：畫面只有場數的話，
   * 「只看了最新那批」跟「窗口裡就這麼多」長得一模一樣。
   */
  it('🔴 對話超過一次能讀的上限 → outcome 要帶 truncated，畫面文案也要講', async () => {
    const { db, writes } = fakeDb({ sessions: manySessions(240), discoveryDoc: NEVER_SCANNED })
    await scanTagDiscovery(db)

    expect(writes[0]!.lastScan.truncated).toBe(true)
    expect(discoveryScanOutcomeText(writes[0]!.lastScan)).toContain('只看了最近的那批')
  })

  it('沒撞上限 → 不要寫 truncated（沒發生的事不要留欄位）', async () => {
    const { db, writes } = fakeDb({ sessions: manySessions(6), discoveryDoc: NEVER_SCANNED })
    await scanTagDiscovery(db)

    expect(writes[0]!.lastScan.truncated).toBeUndefined()
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

/**
 * 舊提案補判（`C-239`）。
 *
 * ⛔ 畫面那行「下次自動掃描之後就會補上」先前是假話：掃描只把新提案接在舊的後面，
 * `C-178` 之前提的那幾條永遠沒有 `similarChecked`。這組釘的是：掃描時真的補判、
 * 補判靠判斷條件也抓得到、只拿有開 AI 判斷的標籤來比、判官沒跑成不能標成「查過了」、
 * 收件匣滿了也要補並寫回去。
 */
describe('還沒做過重複檢查的舊提案，掃描時補判（C-239）', () => {
  const OLD_PENDING = {
    id: 'p-pot',
    name: '在看電子鍋',
    code: 'x',
    category: 'interest',
    criteria: '詢問電子鍋',
    usage: '',
    reason: '',
    userDocIds: ['a', 'b', 'c', 'd'],
    sampleNames: [],
    proposedAtMs: 1,
  }
  /** 判官的 prompt 一定有這句任務描述；掃描主 prompt 沒有 */
  const isJudgePrompt = (prompt: string) => prompt.includes('會不會貼到同一群客人')
  const discoveryDoc = (pending: unknown[]) => ({ workspaceId: 'ws1', pending, dismissedNames: [], lastScanMs: 0 })

  beforeEach(() => {
    vi.mocked(getAiSettings).mockResolvedValue({ autoTagSuggest: { enabled: true } } as any)
    vi.mocked(runWithLlmBudget).mockImplementation(async (_wid: any, fn: any) => ({
      data: await fn(), inputTokens: 1, outputTokens: 1,
    } as any))
  })

  it('靠判斷條件抓到重複、判官說 same → 舊提案補上 similarTo、看過的 id 與 similarChecked', async () => {
    vi.mocked(generateJson).mockImplementation(async (prompt: string) => (
      isJudgePrompt(prompt)
        ? { results: [{ index: 0, verdict: 'same', reason: '料理鍋具本來就包含電子鍋' }] }
        : { topics: [] }
    ) as any)
    const { db, writes } = fakeDb({
      sessions: manySessions(6),
      tags: [{ id: 't-pot', name: '在看料理鍋具', aiMode: 'auto', aiCriteria: '客人詢問電子鍋、電鍋或料理鍋具的功能。' }],
      discoveryDoc: discoveryDoc([OLD_PENDING]),
    })
    await scanTagDiscovery(db)

    const written = writes.find(w => Array.isArray(w.pending))!
    expect(written.pending[0]).toMatchObject({
      id: 'p-pot',
      similarChecked: true,
      similarJudgedTagIds: ['t-pot'],
      similarTo: [{ tagId: 't-pot', name: '在看料理鍋具', confirmed: true, reason: '料理鍋具本來就包含電子鍋' }],
    })
  })

  /** 「客服 - 品名」是買了之後點選單貼的售後紀錄，跟「在看」不是同一群人——連判官都不用問 */
  it('沒開 AI 判斷的標籤不當候選：名字再像也不送判官，直接標成「查過了、沒有」', async () => {
    const prompts: string[] = []
    vi.mocked(generateJson).mockImplementation(async (prompt: string) => {
      prompts.push(prompt)
      return { topics: [] } as any
    })
    const { db, writes } = fakeDb({
      sessions: manySessions(6),
      tags: [
        { id: 't-svc', name: '客服 - 威技 16L 抽取式除濕機', aiMode: 'off' },
        { id: 't-svc2', name: '客服 - 海爾 18L 除濕機' }, // 缺欄位＝off
      ],
      discoveryDoc: discoveryDoc([{ ...OLD_PENDING, id: 'p-dh', name: '在看除濕機' }]),
    })
    await scanTagDiscovery(db)

    expect(prompts.some(isJudgePrompt)).toBe(false)
    const written = writes.find(w => Array.isArray(w.pending))!
    expect(written.pending[0]).toMatchObject({ id: 'p-dh', similarChecked: true, similarTo: [], similarJudgedTagIds: [] })
  })

  /** ⛔ 判官爆掉不是「查過沒有」：不可以把 similarChecked 標成 true，下一輪要再試 */
  it('判官這輪沒跑成 → 舊提案維持「沒查過」，不假裝查過', async () => {
    vi.mocked(generateJson).mockImplementation(async (prompt: string) => {
      if (isJudgePrompt(prompt)) throw new Error('quota')
      return { topics: [] } as any
    })
    const { db, writes } = fakeDb({
      sessions: manySessions(6),
      tags: [{ id: 't-mic', name: '在看收音麥克風', aiMode: 'auto' }],
      discoveryDoc: discoveryDoc([{ ...OLD_PENDING, id: 'p-mic', name: '在看無線麥克風' }]),
    })
    await scanTagDiscovery(db)

    const written = writes.find(w => Array.isArray(w.pending))!
    expect(written.pending[0].similarChecked).toBeUndefined()
    expect(written.pending[0].similarTo).toBeUndefined()
  })

  it('已經查過的不再花一次判官', async () => {
    const prompts: string[] = []
    vi.mocked(generateJson).mockImplementation(async (prompt: string) => {
      prompts.push(prompt)
      return { topics: [] } as any
    })
    const { db } = fakeDb({
      sessions: manySessions(6),
      tags: [{ id: 't-mic', name: '在看收音麥克風', aiMode: 'auto' }],
      discoveryDoc: discoveryDoc([{ ...OLD_PENDING, id: 'p-mic', name: '在看無線麥克風', similarChecked: true }]),
    })
    await scanTagDiscovery(db)
    expect(prompts.some(isJudgePrompt)).toBe(false)
  })

  /** 收件匣滿了照樣要補判並寫回去——滿了更需要（六顆可能重複的「建立」按鈕） */
  it('收件匣滿了也補判，結果要寫回去，而且不會真的掃', async () => {
    vi.mocked(generateJson).mockImplementation(async (prompt: string) => (
      isJudgePrompt(prompt)
        ? { results: [{ index: 0, verdict: 'same', reason: '都是麥克風' }] }
        : { topics: [] }
    ) as any)
    const full = Array.from({ length: MAX_PENDING_DISCOVERIES }, (_, i) => ({
      ...OLD_PENDING,
      id: `p${i}`,
      name: i ? `主題${i}` : '在看無線麥克風',
      similarChecked: i > 0,
    }))
    const { db, writes } = fakeDb({
      sessions: manySessions(6),
      tags: [{ id: 't-mic', name: '在看收音麥克風', aiMode: 'auto' }],
      discoveryDoc: discoveryDoc(full),
    })
    await scanTagDiscovery(db)

    const written = writes.find(w => Array.isArray(w.pending))!
    expect(written.pending).toHaveLength(MAX_PENDING_DISCOVERIES)
    expect(written.pending[0]).toMatchObject({ similarChecked: true, similarTo: [{ tagId: 't-mic', confirmed: true }] })
    expect(written.lastScan).toBeUndefined() // 滿了就沒有真的掃
  })
})
