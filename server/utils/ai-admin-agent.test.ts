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

import { runAdminAgentChat } from './ai-admin-agent'

/** 最小假 Firestore:collection().where().get() + doc().get()(agent 工具只用這些讀法) */
function makeDb(data: { scripts?: any[]; aiUsage?: Record<string, any> } = {}) {
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

    const res = await runAdminAgentChat({ db, workspaceId: 'w1', message: '哪些腳本沒啟用?' })
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
    await runAdminAgentChat({ db, workspaceId: 'w1', message: '這個月用量?' })
    const p = generateJson.mock.calls[1]![0] as string
    expect(p).toContain('"invocations":42')

    generateJson.mockReset()
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'get_ai_usage', args: { month: '2026-01' } }))
      .mockResolvedValueOnce(step({ action: 'answer', text: 'ok' }))
    await runAdminAgentChat({ db, workspaceId: 'w1', message: '一月用量?' })
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
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', message: '昨天幾場對話?', authHeader: 'Bearer t1' })
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
    const res = await runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', message: '刪掉全部' })
    expect(res.reply).toContain('查不太到')
    expect(res.toolCalls).toEqual([])
  })

  it('步數用盡 → 收斂為引導回覆,最多執行 4 次工具', async () => {
    generateJson.mockResolvedValue(step({ action: 'tool', tool: 'list_scripts', args: {} }))
    const res = await runAdminAgentChat({ db: makeDb({ scripts: [] }), workspaceId: 'w1', message: '一直查' })
    expect(res.toolCalls.length).toBe(4)
    expect(res.reply).toContain('換個更具體的問法')
  })

  it('工具執行失敗 → 錯誤進工具結果,迴圈不中斷', async () => {
    const db = { collection() { throw new Error('boom') } } as any
    generateJson
      .mockResolvedValueOnce(step({ action: 'tool', tool: 'list_scripts', args: {} }))
      .mockResolvedValueOnce(step({ action: 'answer', text: '查詢出了點問題' }))
    const res = await runAdminAgentChat({ db, workspaceId: 'w1', message: '腳本?' })
    expect(res.reply).toBe('查詢出了點問題')
    expect(generateJson.mock.calls[1]![0] as string).toContain('查詢失敗')
  })

  it('空訊息 → 400', async () => {
    await expect(runAdminAgentChat({ db: makeDb(), workspaceId: 'w1', message: '  ' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})
