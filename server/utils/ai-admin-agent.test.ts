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

import { MAX_MESSAGE_CHARS, runAdminAgentChat, summarizeToolResult, TOOLS } from './ai-admin-agent'

/** 每個測試都用 viewer:現有 8 個工具的門檻最高就是 ai.read(=viewer),行為與改版前一致 */
// uid 是 C-31 Phase 2 加的(代辦提議的憑證要綁死是給誰的);查詢路徑用不到,給個固定值即可
const asViewer = { role: 'viewer' as const, uid: 'u1' }

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

  it('🔴 提示裡要有「今天是幾號」：沒有的話它會自己編一個日期，然後很有自信地回一整排 0', async () => {
    generateJson.mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '上禮拜對話幾場?' })

    const prompt = generateJson.mock.calls[0]![0] as string
    const instruction = (generateJson.mock.calls[0]![1] as any).systemInstruction as string
    // 台北日期（伺服器跑 UTC，午夜前後差一天）
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    expect(instruction).toContain(today)
    expect(instruction).toContain('今天的日期')
    // ⛔ 相對時間要照提示裡的日期算，不可以用模型自己記得的
    expect(instruction).toContain('絕不用你自己記得的日期')
    expect(prompt).toContain('上禮拜對話幾場')
  })

  it('模型輸出不合規(未知工具)→ 優雅收斂,不 throw', async () => {
    generateJson.mockResolvedValueOnce(step({ action: 'tool', tool: 'delete_everything', args: {} }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '刪掉全部' })
    // ⛔ 措辭要講「沒整理出答案」不是「查不到」：後者是錯的歸因，實測讓合理需求看起來像功能壞了
    expect(res.reply).toContain('沒整理出答案')
    expect(res.reply).not.toContain('查不到資料」')
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
    await runAdminAgentChat({ db, workspaceId: 'wq1', role: 'admin', uid: 'u1', message: '額度還剩多少?' })
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
    await runAdminAgentChat({ db, workspaceId: 'wq2', role: 'admin', uid: 'u1', message: '我是什麼方案?' })
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
      const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', role: 'viewer', uid: 'u1', message: '查設定' })
      expect(run).not.toHaveBeenCalled()
      expect(res.toolCalls).toEqual([]) // 沒真的執行就不記 toolCalls
      expect(generateJson.mock.calls[1]![0] as string).toContain('沒有權限')

      generateJson.mockReset()
      generateJson
        .mockResolvedValueOnce(step({ action: 'tool', tool: '__test_admin_tool', args: {} }))
        .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
      await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', role: 'admin', uid: 'u1', message: '查設定' })
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
      await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', role: 'admin', uid: 'u1', message: '幫我改設定' })
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

  // ── 2026-09-18 壓測抓到的三件事 ────────────────────────────────

  /**
   * 問「splash 那個帳號這個月用量」,它查了**這一家**,然後回「splash 帳號這個月的用量如下…」。
   * 資料沒外洩(工具鎖死在 session 的 workspaceId),但那張帳貼到別人頭上,
   * 而使用者會拿它去做決定。模型要有辦法講「我只看得到這一家」,就得先知道這一家叫什麼。
   */
  it('提示要講出「你現在看的是哪一個帳號」,並禁止把這家的數字冠上別家的名字', async () => {
    const db = makeDb({ workspaces: { w1: { name: 'MYFEEL' } } })
    generateJson.mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: 'splash 那家用量多少?' })
    const instruction = (generateJson.mock.calls[0]![1] as any).systemInstruction as string
    expect(instruction).toContain('MYFEEL')
    expect(instruction).toContain('冠上別家的名字')
  })

  it('查不到帳號名字(或資料庫壞掉)→ 退回中性稱呼,⛔不讓整輪失敗', async () => {
    const boom = { collection() { throw new Error('boom') } } as any
    generateJson.mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    const res = await runAdminAgentChat({ db: boom, workspaceId: 'w1', ...asViewer, message: '嗨' })
    expect(res.reply).toBe('ok')
    expect((generateJson.mock.calls[0]![1] as any).systemInstruction).toContain('目前這個官方帳號')
  })

  /**
   * 使用者貼一大段進來,超過的部分本來是**靜靜**被丟掉的:模型照著半句話回答,
   * 畫面上一個字都沒提到後面那段沒進來。被切掉的是他自己剛打的字,他有權知道。
   */
  it('訊息太長:回覆要**當面講出**只看到前 1000 字,提示裡也要標註', async () => {
    const long = `${'把查詢訂單這條下架。'.repeat(120)}但是先不要動，我只是問問。`
    expect(long.length).toBeGreaterThan(MAX_MESSAGE_CHARS)
    generateJson.mockResolvedValueOnce(step({ action: 'answer', text: '好的' }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: long })

    expect(res.reply).toContain(`只看得到前 ${MAX_MESSAGE_CHARS} 個字`)
    expect(res.reply).toContain(String(long.length))
    expect(res.reply).toContain('好的') // ⛔ 原本的回答不可以被蓋掉
    expect(generateJson.mock.calls[0]![0] as string).toContain('後面被系統切掉了')
  })

  it('訊息沒超長 → 一個字都不加', async () => {
    generateJson.mockResolvedValueOnce(step({ action: 'answer', text: '好的' }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '嗨' })
    expect(res.reply).toBe('好的')
    expect(generateJson.mock.calls[0]![0] as string).not.toContain('後面被系統切掉了')
  })

  /**
   * 2026-09-18 壓測:問「這個月 AI 花了我多少錢」,它**一個工具都沒呼叫**,
   * 直接回「總共回覆了 123 則、45 次轉真人」——兩個數字都是編的（真值 110）。
   * 純函式綠不代表有被接上去，這幾條釘的是「迴圈真的會退回去重查」。
   */
  it('🔴 沒查就報數字 → 退回去查一次,最後給的是查到的真數字', async () => {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '')
    const db = makeDb({ aiUsage: { [`w1_${ym}`]: { invocations: 236, answered: 98 } } })
    generateJson
      .mockResolvedValueOnce(step({ action: 'answer', text: '這個月回了 123 則、轉真人 45 次。' }))
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_ai_usage', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: '這個月 AI 被呼叫 236 次。' }))

    const res = await runAdminAgentChat({ db, workspaceId: 'w1', ...asViewer, message: '這個月花多少錢?' })

    expect(res.reply).toBe('這個月 AI 被呼叫 236 次。')
    expect(res.toolCalls.map(t => t.tool)).toEqual(['get_ai_usage'])
    // 退回去的原因要讓模型看得到，它才知道要去查
    expect(generateJson.mock.calls[1]![0] as string).toContain('回答被擋下')
  })

  it('🔴 沒查異常卻說「沒有要處理的」→ 同一道檢查擋下來', async () => {
    generateJson
      .mockResolvedValueOnce(step({ action: 'answer', text: '目前沒有需要處理的事。' }))
      .mockResolvedValueOnce(step({ action: 'answer', text: '異常我還沒查，要不要我查一下？' }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '有什麼要處理的嗎?' })
    expect(res.reply).toContain('還沒查')
    expect(generateJson.mock.calls[1]![0] as string).toContain('get_current_alerts')
  })

  it('⛔ 只退一次:模型硬要講同一句話時,不可以無限重來', async () => {
    generateJson.mockResolvedValue(step({ action: 'answer', text: '這個月回了 123 則。' }))
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '幾則?' })
    expect(res.reply).toBe('這個月回了 123 則。')
    expect(generateJson).toHaveBeenCalledTimes(2)
  })

  it('數字有出處就不要多跑一輪（⛔這道檢查不可以變成每次都退回）', async () => {
    generateJson.mockResolvedValueOnce(step({ action: 'answer', text: '你說的 30 分鐘我記下了。' }))
    await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', ...asViewer, message: '提醒改成 30 分鐘好不好' })
    expect(generateJson).toHaveBeenCalledTimes(1)
  })
})

/**
 * 工具結果太長時的截斷。
 * ⛔ 原本是 `JSON.stringify(x).slice(0, 4000)`：切出來是半截 JSON、**而且沒有任何記號**——
 *    模型看到 17 條裡的前 12 條,會很自然地回答「你總共有 12 條」。
 */
describe('summarizeToolResult(清單太長時要說得出丟了什麼)', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
    name: `流程${i}`, keywords: '關鍵字'.repeat(20), note: '一段很長的說明'.repeat(10),
  }))

  it('放得下 → 原封不動', () => {
    expect(summarizeToolResult([{ a: 1 }])).toBe('[{"a":1}]')
  })

  it('放不下 → 切在整筆的邊界,並講出還有幾筆沒給', () => {
    const out = summarizeToolResult(rows(60))
    const kept = (out.match(/"name":/g) ?? []).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(60)
    // 切點必須是完整的一筆:前半段仍然 parse 得動
    expect(() => JSON.parse(out.split('\n')[0]!)).not.toThrow()
    expect(JSON.parse(out.split('\n')[0]!)).toHaveLength(kept)
    expect(out).toContain(`還有 ${60 - kept} 筆沒有給你`)
    expect(out).toContain('總共 60 筆')
    expect(out).toContain('不可以說這就是全部')
  })

  it('不是清單的大東西 → 也要講出被切掉了', () => {
    const out = summarizeToolResult({ text: 'x'.repeat(9000) })
    expect(out).toContain('後面被切掉了一段')
  })
})
