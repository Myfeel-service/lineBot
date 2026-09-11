/**
 * Admin 查詢副駕(P1)迴圈測試:mock 掉 gemini,用記憶體假 Firestore 驗證
 * 「模型要查工具 → 執行 → 把結果回饋 → 收斂成回答」的機械行為與防護欄。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => ({ __op: 'delete' }),
    increment: (n: number) => ({ __op: 'increment', n }),
    serverTimestamp: () => ({ __op: 'ts' }),
    vector: (v: number[]) => ({ __op: 'vector', v }),
  },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn() }))

// gemini:用佇列控制每一步模型「說什麼」
const { generateJson } = vi.hoisted(() => ({ generateJson: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson }))

// Nitro 全域(測試環境沒有 Nuxt runtime)
;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)

import { runAdminAgentChat, TOOLS } from './ai-admin-agent'

/** 每個測試都用 viewer:現有 8 個工具的門檻最高就是 ai.read(=viewer),行為與改版前一致 */
const asViewer = { role: 'viewer' as const }

/** 最小假 Firestore:collection().where().get() + doc().get()(agent 工具只用這些讀法) */
function makeDb(data: {
  scripts?: any[]
  aiUsage?: Record<string, any>
  /** get_plan_quota 要讀:訂閱掛在 workspaces doc 上、本期已用在額度桶 */
  workspaces?: Record<string, any>
  quotaUsage?: Record<string, any>
} = {}) {
  return {
    collection(name: string) {
      return {
        where: (_f: string, _op: string, _v: unknown) => ({
          async get() {
            const rows = (data as any)[name] ?? []
            return { docs: rows.map((r: any, i: number) => ({ id: `d${i}`, data: () => r })) }
          },
          count: () => ({ async get() { return { data: () => ({ count: ((data as any)[name] ?? []).length }) } } }),
        }),
        doc: (id: string) => ({
          async get() {
            const d = (data as any)[name]?.[id]
            return { exists: !!d, data: () => d }
          },
        }),
      }
    },
  } as any
}

const step = (obj: unknown, tokens = 10) => ({ data: obj, inputTokens: tokens, outputTokens: tokens })

beforeEach(() => generateJson.mockReset())

describe('runAdminAgentChat(查詢迴圈)', () => {
  it('查工具→回答:工具結果回饋給模型、toolCalls 有紀錄、token 累加', async () => {
    const db = makeDb({ scripts: [
      { name: '退換貨查詢', enabled: false, nodes: [{ type: 'trigger', matchMode: 'semantic', keywords: ['退貨'] }] },
      { name: '預約報名', enabled: true, nodes: [{ type: 'trigger', keywords: ['預約'] }], stats: { starts: 3, completions: 2 } },
    ] })
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'list_scripts', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: '「退換貨查詢」還沒啟用' }))

    const res = await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: '哪些腳本沒啟用?' })
    expect(res.reply).toBe('「退換貨查詢」還沒啟用')
    expect(res.toolCalls).toEqual([{ tool: 'list_scripts', args: {} }])
    expect(res.inputTokens).toBe(20)

    // 第二步的 prompt 必須帶著第一步的工具結果(模型才有數字可答)
    const secondPrompt = generateJson.mock.calls[1]![0] as string
    expect(secondPrompt).toContain('退換貨查詢')
    expect(secondPrompt).toContain('工具結果')
  })

  it('get_ai_usage:預設查本月、可指定月份', async () => {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '')
    const db = makeDb({ aiUsage: { [`w1_${ym}`]: { invocations: 42, answered: 30, handoffs: 5 }, w1_202601: { answered: 1 } } })
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_ai_usage', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: '這個月用量?' })
    const p = generateJson.mock.calls[1]![0] as string
    expect(p).toContain('"invocations":42')

    generateJson.mockReset()
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_ai_usage', args: { month: '2026-01' } }))
      .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: '一月用量?' })
    expect(generateJson.mock.calls[1]![0] as string).toContain('"answered":1')
  })

  it('get_conversation_stats:預設查昨天(起訖同日)、轉發呼叫者 Authorization、結果進下一步 prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      total: 5, aiHandled: 2, botHandled: 1, humanHandled: 1, unhandled: 1, handoffCount: 3,
    })
    ;(globalThis as any).$fetch = fetchMock
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_conversation_stats', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: '昨天 5 場' }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '昨天幾場對話?', authHeader: 'Bearer t1' })
    expect(res.reply).toBe('昨天 5 場')

    const [url, opts] = fetchMock.mock.calls[0]! as [string, any]
    expect(url).toBe('/api/conversation-stats/kpi')
    expect(opts.query.workspaceId).toBe('w1')
    // 沒帶日期=昨天:起訖同一天,格式正確(不驗確切日期,避免測試在午夜附近變成賭時區)
    expect(opts.query.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(opts.query.endDate).toBe(opts.query.startDate)
    // 權限口徑不另立:轉發呼叫者的憑證讓 KPI 端點自己把關
    expect(opts.headers.authorization).toBe('Bearer t1')
    // 數字要真的回饋給模型,答案才有依據
    expect(generateJson.mock.calls[1]![0] as string).toContain('"total":5')
  })

  it('模型輸出不合規(未知工具)→ 優雅收斂,不 throw', async () => {
    generateJson.mockResolvedValueOnce(step({ action: 'tool', tool: 'delete_everything', args: {} }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '刪掉全部' })
    expect(res.reply).toContain('查不太到')
    expect(res.toolCalls).toEqual([])
  })

  it('步數用盡 → 收斂為引導回覆,最多執行 4 次工具', async () => {
    generateJson.mockResolvedValue(step({ action: 'tool', tool: 'list_scripts', args: {} }))
    const res = await runAdminAgentChat({ db: makeDb({ scripts: [] }), workspaceId: 'w1', ...asViewer, message: '一直查' })
    expect(res.toolCalls.length).toBe(4)
    expect(res.reply).toContain('換個更具體的問法')
  })

  it('工具執行失敗 → 錯誤進工具結果,迴圈不中斷', async () => {
    const db = { collection() { throw new Error('boom') } } as any
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'list_scripts', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: '查詢出了點問題' }))
    const res = await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: '腳本?' })
    expect(res.reply).toBe('查詢出了點問題')
    expect(generateJson.mock.calls[1]![0] as string).toContain('查詢失敗')
  })

  it('空訊息 → 400', async () => {
    await expect(runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '  ' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  // ── C-31 Phase 0:權限與寫入閘門 ──────────────────────────────
  it('E-17:get_ai_usage 不回 token 細目(F-5:token 只給超管,聊天不能繞過)', async () => {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '')
    const db = makeDb({ aiUsage: { [`w1_${ym}`]: { invocations: 42, answered: 30, inputTokens: 99999, outputTokens: 88888 } } })
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_ai_usage', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: '用量?' })
    const p = generateJson.mock.calls[1]![0] as string
    expect(p).toContain('"answered":30')
    expect(p).not.toContain('inputTokens')
    expect(p).not.toContain('99999')
  })

  /**
   * `D-69`(2026-09-07)之後「一則」＝答出 ＋ 反問。小幫手原本被教成「answered 才是計費單位」,
   * 於是問它「這個月用了幾則」會少報反問那幾則(myfeel 2026-09 會回 52,正確是 62)——
   * 跟方案卡當時的 bug 同源。這條盯的是「模型拿到的數字」裡有沒有計費則數。
   */
  it('get_ai_usage:「幾則」回的是計費則數(含反問),不是 answered', async () => {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '')
    // 形狀取自 myfeel 2026-09 的真實紀錄:答出 52、反問 9、反問後答出 1 → 計費 62 則
    const db = makeDb({ aiUsage: { [`w1_${ym}`]: {
      period: ym, invocations: 126, answered: 52, disambiguations: 9, followupAnswered: 1, handoffs: 65,
    } } })
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_ai_usage', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: '這個月用了幾則?' })
    const p = generateJson.mock.calls[1]![0] as string
    expect(p).toContain('"billableReplies":62')
    // answered 照樣給(品質指標),但 description 已綁死它不是「則」
    expect(p).toContain('"answered":52')
  })

  /**
   * 2026-09-11 新增(老闆問「小幫手是否也可以即時看到目前額度」)。在此之前它只看得到
   * 「這個月做了多少事」,方案/上限/剩餘/重置日一概不知。⛔ 額度的窗口是訂閱週期不是日曆月,
   * 所以這支讀的是額度桶(與攔截同一顆計數器),不是月結桶。
   */
  it('get_plan_quota:回得出方案、本期上限與剩餘(額度桶,不是月結桶)', async () => {
    const day = 86400_000
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const start = iso(Date.now() - 5 * day)
    const end = iso(Date.now() + 25 * day)
    const db = makeDb({
      workspaces: { wq1: { subscription: { planId: 'lite', status: 'active', currentPeriodStart: start, currentPeriodEnd: end } } },
      quotaUsage: { [`wq1_${start}`]: { answered: 180 } },
    })
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_plan_quota', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    // usage.read 是 admin 級能力,viewer 會被閘門擋下 → 這裡用 admin
    await runAdminAgentChat({ db, workspaceId: 'wq1', role: 'admin', message: '額度還剩多少?' })
    const p = generateJson.mock.calls[1]![0] as string
    expect(p).toContain('"quotaLimit":200')
    expect(p).toContain('"used":180')
    expect(p).toContain('"quotaRemaining":20')
    expect(p).toContain('"quotaState":"near"') // 90% → 近上限,講得出「快用完了」
    // 窗口要講明是續約日制那一期,否則跟畫面上的月數字對不起來
    expect(p).toContain('按續約日算一期')
  })

  /**
   * ⛔ 無上限帳號**不可以**回訂閱週期的數字:那顆是 198,而方案卡寫的是日曆月的 62——
   * 小幫手與畫面各講一個數,就是 2026-08-10「94 則哪來的」重演。兩邊必須同一個窗口。
   */
  it('get_plan_quota:無上限方案回「這個月」的計費則數,跟方案卡同一個數字', async () => {
    const day = 86400_000
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const start = iso(Date.now() - 5 * day)
    const ym = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7).replace('-', '')
    const db = makeDb({
      workspaces: { wq2: { subscription: { planId: 'internal', status: 'active', currentPeriodStart: start, currentPeriodEnd: iso(Date.now() + 25 * day) } } },
      // 額度桶(訂閱週期)是 198,月結桶(日曆月)照 myfeel 真實形狀＝62：回錯窗口這條就會紅
      quotaUsage: { [`wq2_${start}`]: { answered: 198 } },
      aiUsage: { [`wq2_${ym}`]: { period: ym, invocations: 126, answered: 52, disambiguations: 9, followupAnswered: 1 } },
    })
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_plan_quota', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db, workspaceId: 'wq2', role: 'admin', message: '我是什麼方案?' })
    const p = generateJson.mock.calls[1]![0] as string
    expect(p).toContain('"unlimited":true')
    expect(p).toContain('"used":62')
    expect(p).not.toContain('198')
    expect(p).toContain('"quotaLimit":null')
    expect(p).toContain('"quotaRemaining":null')
    expect(p).toContain('"usedPercent":null')
  })

  it('權限閘門:requires 不足 → 工具不執行,模型收到如實訊息;權限夠 → 照常執行', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true })
    ;(TOOLS as any).__test_admin_tool = { description: 'test', requires: 'ai.settings.write', mutates: false, run }
    try {
      generateJson
        .mockResolvedValueOnce(step({ action: 'tool', tool: '__test_admin_tool', args: {} }))
        .mockResolvedValueOnce(step({ action: 'answer', text: '你的權限看不到' }))
      const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', role: 'viewer', message: '查設定' })
      expect(run).not.toHaveBeenCalled()
      expect(res.toolCalls).toEqual([]) // 沒真的執行就不記 toolCalls
      expect(generateJson.mock.calls[1]![0] as string).toContain('沒有權限')

      generateJson.mockReset()
      generateJson
        .mockResolvedValueOnce(step({ action: 'tool', tool: '__test_admin_tool', args: {} }))
        .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
      await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', role: 'admin', message: '查設定' })
      expect(run).toHaveBeenCalledTimes(1)
    }
    finally {
      delete (TOOLS as any).__test_admin_tool
    }
  })

  it('寫入閘門:mutates=true 一律擋下,連 admin 也一樣(Phase 2 確認流上場前的鐵律)', async () => {
    const run = vi.fn()
    ;(TOOLS as any).__test_write_tool = { description: 'test', mutates: true, run }
    try {
      generateJson
        .mockResolvedValueOnce(step({ action: 'tool', tool: '__test_write_tool', args: {} }))
        .mockResolvedValueOnce(step({ action: 'answer', text: '目前只能查詢' }))
      await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', role: 'admin', message: '幫我改設定' })
      expect(run).not.toHaveBeenCalled()
      expect(generateJson.mock.calls[1]![0] as string).toContain('已擋下')
    }
    finally {
      delete (TOOLS as any).__test_write_tool
    }
  })

  it('註冊表不變量:P1 工具全部唯讀(mutates=false)', () => {
    for (const [name, t] of Object.entries(TOOLS))
      expect({ name, mutates: (t as any).mutates }).toEqual({ name, mutates: false })
  })

  it('帶路(goto):白名單過濾＋去重＋最多 2 張,模型編的 id 一律丟棄', async () => {
    generateJson.mockResolvedValueOnce(step({
      action: 'answer',
      text: '去 AI 設定開通知',
      goto: ['ai-settings', 'made-up-page', 'ai-settings', 'conversations', 'broadcasts'],
    }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '通知怎麼設?' })
    expect(res.messages).toEqual([
      { kind: 'link', internal: true, label: '前往「AI 設定」', href: '/admin/w1/ai-settings' },
      { kind: 'link', internal: true, label: '前往「對話」', href: '/admin/w1/conversations' },
    ])
  })

  it('帶路(goto):沒帶或帶垃圾 → messages 空陣列,不 throw', async () => {
    generateJson.mockResolvedValueOnce(step({ action: 'answer', text: 'ok', goto: 'not-an-array' }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '嗨' })
    expect(res.messages).toEqual([])
  })
})
