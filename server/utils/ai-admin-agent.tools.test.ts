/**
 * 三個新的唯讀查詢（2026-09-16）：最近改了什麼、標籤人數、推播成效。
 *
 * 為什麼補這三個：小幫手可以代人動手之後，「它到底改了什麼」卻只能自己去開操作紀錄頁看；
 * 「貼了某標籤的有幾個人」「上次推播發給幾個人」也一直問不到。
 * 唯讀查詢是這整套裡最安全的東西——不用確認流、不寫任何資料。
 *
 * 釘住的是**講出來的話對不對**：白話、量詞、以及「查不到就說查不到」。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), increment: (n: number) => ({ __op: 'inc', n }) },
}))
vi.mock('./firebase', () => ({
  getDb: vi.fn(),
  // Email 查不到時紀錄照給（只講 uid 也好過整個查詢失敗）
  getFirebaseAuth: () => ({ getUsers: async () => ({ users: [{ uid: 'u1', email: 'kevin@example.com' }] }) }),
}))
vi.mock('./gemini', () => ({ generateJson: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn() }))
// get_ai_settings 用：一份「平台欄位、token 上限、通知名單」都有值的設定
vi.mock('./ai-settings', () => ({
  getAiSettings: async () => ({
    enabled: true,
    replyMode: 'draft',
    answerModel: 'gemini-2.5-flash-lite',
    embeddingModel: 'gemini-embedding-001',
    replyMaxLen: 420,
    systemPrompt: '你是客服',
    sensitiveTopics: [],
    quota: { monthlyTokenCap: 3000000, onExceed: 'handoff_all' },
    handoffNotify: { enabled: true, lineUserIds: ['Uaaa', 'Ubbb'], displayNames: { Uaaa: '小美' }, slaRemindMinutes: 15 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true },
    disambiguation: { enabled: true },
  }),
}))

;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)

const { TOOLS } = await import('./ai-admin-agent')

/** 假 Firestore：認得 collection 名稱，支援 where/orderBy/limit 鏈 */
function makeDb(data: Record<string, any[]>) {
  const chain = (name: string) => {
    const api: any = {
      where: () => api,
      orderBy: () => api,
      limit: () => api,
      get: async () => ({ docs: (data[name] ?? []).map((d: any, i: number) => ({ id: d.id ?? `d${i}`, data: () => d })) }),
    }
    return api
  }
  return { collection: (name: string) => chain(name) } as any
}

const ts = (ms: number) => ({ toMillis: () => ms })

describe('查詢：最近改了什麼', () => {
  const tool = TOOLS.get_recent_changes

  it('講白話不講代號，而且看得出是人改的還是小幫手代的、誰改的', async () => {
    const db = makeDb({
      auditLogs: [{
        action: 'agent-op/ai-settings-service-hours',
        actor: 'agent',
        uid: 'u1',
        before: { serviceHours: { enabled: true } },
        after: { serviceHours: { enabled: false } },
        createdAt: ts(Date.UTC(2026, 8, 15, 2, 30)),
      }],
    })

    const rows = await tool.run(db, 'w1', {}, {}) as any[]

    expect(rows[0].what).toBe('改了服務時間／勿擾時段')
    expect(rows[0].who).toContain('小幫手代辦')
    expect(rows[0].who).toContain('kevin@example.com')
    expect(rows[0].changes[0]).toContain('勿擾時段')
    // 時間要換成台灣時間再講（伺服器跑 UTC，直接講會差 8 小時）
    expect(rows[0].when).toBe('2026-09-15 10:30')
  })

  it('這道查詢的門檻是「看得到操作紀錄」，⛔不是誰都能問', () => {
    expect(tool.requires).toBe('audit.read')
    expect(tool.mutates).toBe(false)
  })

  it('說明裡要講清楚「這裡只記設定類操作」——查不到不等於沒發生過', () => {
    expect(tool.description).toContain('查不到不等於沒發生過')
  })
})

describe('查詢：標籤人數', () => {
  const tool = TOOLS.get_tag_audience

  it('🔴 標籤名對不到：回現有清單讓它反問，⛔不挑最接近的那個', async () => {
    const db = makeDb({ tags: [{ id: 't1', name: 'VIP' }, { id: 't2', name: '新客' }] })
    const res = await tool.run(db, 'w1', { tagName: '黃金會員' }, {}) as any

    expect(res.found).toBe(false)
    expect(res.availableTags).toEqual(['VIP', '新客'])
  })

  it('對到就回人數，並講明「發送時會重新計算」（⛔不要講成保證發得到）', async () => {
    const db = makeDb({ tags: [{ id: 't1', name: 'VIP' }] })
    ;(globalThis as any).$fetch = async () => ({ estimatedCount: 128 })

    const res = await tool.run(db, 'w1', { tagName: 'VIP' }, {}) as any
    expect(res).toMatchObject({ found: true, count: 128 })
    expect(res.note).toContain('重新計算')
  })
})

/**
 * `G-103`：這支原本對觀察者回回覆長度與 token 上限，跟 get_ai_usage「token 看不到」互相打架。
 */
describe('查詢：AI 設定摘要（看角色給欄位）', () => {
  const tool = TOOLS.get_ai_settings

  it('🔴 任何角色都拿不到回覆長度與模型（平台管的，超管在設定頁看）', async () => {
    for (const role of ['viewer', 'agent', 'admin', 'owner'] as const) {
      const res = await tool.run(makeDb({}), 'w1', {}, { role }) as any
      const json = JSON.stringify(res)
      expect(json, role).not.toContain('replyMaxLen')
      expect(json, role).not.toContain('gemini')
    }
  })

  it('🔴 觀察者／客服拿不到 token 上限，⛔而且不是回 null（null 會被講成「沒設上限」）', async () => {
    for (const role of ['viewer', 'agent'] as const) {
      const res = await tool.run(makeDb({}), 'w1', {}, { role }) as any
      expect('monthlyTokenCap' in JSON.parse(JSON.stringify(res)), role).toBe(false)
    }
  })

  it('管理員看得到自己設的 token 上限', async () => {
    const res = await tool.run(makeDb({}), 'w1', {}, { role: 'admin' }) as any
    expect(res.monthlyTokenCap).toBe(3000000)
  })

  it('🔴 觀察者拿不到名單，但「幾位會收到」照樣對（⛔不可以因為看不到名單就講成 0）', async () => {
    const res = await tool.run(makeDb({}), 'w1', {}, { role: 'viewer' }) as any
    expect(res.handoffNotify).toEqual({ enabled: true, recipientCount: 2, slaRemindMinutes: 15 })
    expect(JSON.stringify(res)).not.toMatch(/Uaaa|小美/)
  })

  it('沒帶角色就當觀察者（寧可少給）', async () => {
    const res = await tool.run(makeDb({}), 'w1', {}, {}) as any
    expect('monthlyTokenCap' in JSON.parse(JSON.stringify(res))).toBe(false)
  })

  it('⛔ 說明不可以再說它有 token 上限可查，要講明模型／回覆長度／token 看不到', () => {
    expect(tool.description).not.toContain('每月 token 上限')
    expect(tool.description).toContain('token 用量')
    expect(tool.description).toContain('看不到')
  })
})

describe('查詢：推播成效', () => {
  const tool = TOOLS.get_broadcast_results

  it('狀態講白話，數字照實；沒完成的不要編一個完成時間', async () => {
    const db = makeDb({
      broadcasts: [
        { name: '中秋通知', status: 'completed', totalCount: 100, sentCount: 98, failedCount: 2, skippedCount: 0, completedAt: ts(Date.UTC(2026, 8, 14, 1, 0)) },
        { name: '下週活動', status: 'draft', totalCount: 0, sentCount: 0, failedCount: 0, skippedCount: 0 },
      ],
    })

    const rows = await tool.run(db, 'w1', {}, {}) as any[]

    expect(rows[0]).toMatchObject({ name: '中秋通知', status: '已完成', sent: 98, failed: 2 })
    expect(rows[0].completedAt).toBe('2026-09-14 09:00')
    expect(rows[1].status).toBe('草稿（還沒發）')
    expect(rows[1].completedAt).toBeNull()
  })

  it('⛔ 說明要講明這裡沒有開封率點擊率（不然它會憑空講一個）', () => {
    expect(tool.description).toContain('沒有開封率與點擊率')
  })
})

// ── `D-116`（2026-10-08）：沒受過訓練的店家實測問不到的三種 ＋ 語氣現況 ──────────

describe('查詢：AI 設定摘要（D-116 補的現況）', () => {
  it('🔴 語氣：自己寫的指示要講成「自己寫的」，⛔ 不可以像以前那樣被講成某個範本', async () => {
    const res = await TOOLS.get_ai_settings.run(makeDb({}), 'w1', {}, { role: 'admin' }) as any
    expect(res.tone).toContain('自己寫的指示')
    expect(res.tone).toContain('你是客服')
  })

  it('自動交還／自動結束的現值查得到（先講現在是多少才能問要改成多少）', async () => {
    const res = await TOOLS.get_ai_settings.run(makeDb({}), 'w1', {}, { role: 'admin' }) as any
    expect(res).toHaveProperty('handbackIdleMinutes')
    expect(res).toHaveProperty('autoCloseHours')
  })

  it('🔴 說明要講清楚服務時間只管找真人，AI 全天照回（實測它講成「AI 自動回覆的服務時間」）', () => {
    expect(TOOLS.get_ai_settings.description).toContain('AI 全天照常回答')
  })
})

describe('查詢：目前異常（D-116 補的兩格）', () => {
  it('🔴 每一件標「會不會讓客人沒人回」與面板分組；有發生就附「展開目前狀況」', async () => {
    ;(globalThis as any).$fetch = async () => ({
      items: [
        { id: 'humanStale', state: 'active', count: 95 },
        { id: 'humanBacklog', state: 'active', count: 1 },
        { id: 'followWelcomeMissing', state: 'active' },
        { id: 'lineWebhookBroken', state: 'clear' },
      ],
    })
    const cards: any[] = []
    const rows = await TOOLS.get_current_alerts.run(makeDb({}), 'w1', {}, { cards }) as any[]
    const by = (label: string) => rows.find(r => r.item === label)

    // 實測：它把「95 場接手沒結束」講成「客人可能還在等」→ 資料上直接標不會
    expect(by('有對話接手後沒按結束')).toMatchObject({ group: '建議處理', causesNoReply: '不會(客人照樣收得到回覆)' })
    expect(by('有客人在等真人回覆')?.causesNoReply).toBe('會')
    expect(by('新加好友的人不會收到任何訊息')).toMatchObject({ group: '可以更好', causesNoReply: '不會(客人照樣收得到回覆)' })
    // 沒發生的不標（標了等於多講一件不存在的事）
    expect(by('機器人收不到客人訊息')).not.toHaveProperty('causesNoReply')
    expect(cards).toEqual([{ kind: 'teach', teach: 'status', ref: 'setup' }])
  })
})

describe('查詢：照名字找客人的對話', () => {
  const tool = TOOLS.find_customer_conversations
  const conv = (userId: string, displayName: string, lastDirection: string) =>
    ({ userId, displayName, lastDirection, lastMessageAt: { _seconds: Date.UTC(2026, 9, 7, 7, 20) / 1000 }, customerLastAt: null })

  it('「王小姐」只用「王」去找；找到 1～3 位就附「打開他的對話」，網址由工具組（⛔ 模型不生 ID）', async () => {
    let query: any
    ;(globalThis as any).$fetch = async (_url: string, opts: any) => {
      query = opts.query
      return { conversations: [conv('U1', '王○○', 'incoming')] }
    }
    const cards: any[] = []
    const res = await tool.run(makeDb({}), 'w1', { name: '王小姐' }, { cards }) as any

    expect(query.search).toBe('王')
    expect(res.found).toBe(1)
    expect(res.customers[0]).toMatchObject({ name: '王○○', lastMessageAt: '2026-10-07 15:20' })
    expect(res.customers[0].lastFrom).toContain('還沒有人回')
    expect(cards).toEqual([{ kind: 'link', internal: true, label: '打開「王○○」的對話', href: '/admin/w1/conversations?userId=U1' }])
    // 對話內容不給模型（客人個資、也容易被對話裡的字帶著走）
    expect(JSON.stringify(res)).not.toContain('lastMessage"')
  })

  it('找到太多位就不附卡片，名單列出來讓它問是哪一位', async () => {
    ;(globalThis as any).$fetch = async () => ({ conversations: ['A', 'B', 'C', 'D', 'E', 'F'].map(n => conv(`U${n}`, `王${n}`, 'outgoing')) })
    const cards: any[] = []
    const res = await tool.run(makeDb({}), 'w1', { name: '王' }, { cards }) as any

    expect(cards).toEqual([])
    expect(res.customers).toHaveLength(5)
    expect(res.more).toContain('另外還有 1 位')
  })

  it('沒給名字 → 不去查，叫它先問是哪一位', async () => {
    const res = await tool.run(makeDb({}), 'w1', { name: '小姐' }, {}) as any
    expect(res.found).toBe(0)
    expect(res.reason).toContain('先問')
  })
})

describe('查詢：轉真人的原因', () => {
  it('🔴 實測 10 月那份：原因照次數排、標籤跟 AI 表現頁同一份，並補一句白話', async () => {
    let query: any
    ;(globalThis as any).$fetch = async (_url: string, opts: any) => {
      query = opts.query
      return { handoffs: 78, handoffReasonCounts: { user_request: 8, no_grounding: 39, order_status: 12, product_mismatch: 17, llm_error: 1, sensitive_topic: 1 } }
    }
    const res = await TOOLS.get_handoff_reasons.run(makeDb({}), 'w1', { month: '2026-10' }, {}) as any

    expect(query.period).toBe('202610')
    expect(res.handoffs).toBe(78)
    expect(res.reasons.map((r: any) => r.times)).toEqual([39, 17, 12, 8, 1, 1])
    expect(res.reasons[0]).toMatchObject({ reason: '知識庫無依據', meaning: '知識庫裡找不到可以回答的資料' })
  })

  it('這個月沒有原因 → 照實講，⛔ 不回一個空清單就算了', async () => {
    ;(globalThis as any).$fetch = async () => ({ handoffs: 0, handoffReasonCounts: {} })
    const res = await TOOLS.get_handoff_reasons.run(makeDb({}), 'w1', {}, {}) as any
    expect(res.note).toContain('沒有記到')
  })
})

describe('查詢：AI 答錯與沒答好', () => {
  it('標過答錯還沒修的筆數＋客人問過 AI 沒答好的主題（照被問的次數排）', async () => {
    ;(globalThis as any).$fetch = async () => ({ items: [{ id: 'knowledgeWrongAnswers', state: 'active', count: 2, detail: '例如「運費」' }] })
    const db = makeDb({ knowledgeSuggestions: [{ topic: '可以寄國外嗎', eventCount: 3 }, { topic: '有停車位嗎', eventCount: 9 }] })
    const res = await TOOLS.get_ai_mistakes.run(db, 'w1', {}, {}) as any

    expect(res.markedWrongUnfixed).toEqual({ count: 2, example: '例如「運費」' })
    expect(res.unansweredTopics.map((t: any) => t.topic)).toEqual(['有停車位嗎', '可以寄國外嗎'])
  })

  it('⛔ 查不到不可以講成「沒有」：異常那支失敗＝說查不到', async () => {
    ;(globalThis as any).$fetch = async () => { throw new Error('boom') }
    const res = await TOOLS.get_ai_mistakes.run(makeDb({}), 'w1', {}, {}) as any
    expect(res.markedWrongUnfixed).toContain('查不到')
  })
})
