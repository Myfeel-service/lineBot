import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 開通就緒度端點——只釘「已接上 LINE」這一項的口徑（`D-15`(b)，2026-08-21 拍板）。
 *
 * 為什麼這條值得一支測試：這個訊號會決定**開通引導的入口還在不在**，也是小幫手
 * 講「客人的訊息進得來」的依據。舊版只看兩個欄位有沒有值，於是「憑證貼了、LINE 後台
 * 卻沒設收訊網址」的帳號會被說成已完成——講的是一件從來沒人驗過的事。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: 'ws1' })),
}))
vi.mock('~~/server/utils/workspace-alerts', () => ({ checkLineWebhook: vi.fn() }))
vi.mock('~~/server/utils/ai-settings', () => ({ getAiSettings: vi.fn(async () => ({ enabled: false })) }))
vi.mock('~~/server/utils/ai-scripts', () => ({ loadActiveScripts: vi.fn(async () => []), SCRIPTS_COLLECTION: 'scripts' }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./setup-status.get')
const { getDb } = await import('~~/server/utils/firebase')
const { checkLineWebhook } = await import('~~/server/utils/workspace-alerts')

/** 假 Firestore：workspaces 文件回指定內容，其餘集合一律空 */
function stubDb(workspace: Record<string, unknown> | null) {
  vi.mocked(getDb).mockReturnValue({
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: !!workspace, data: () => workspace }) }),
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
        orderBy: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      }),
    }),
  } as never)
}

const lineStatus = async () => {
  const res = await (handler as unknown as (e: unknown) => Promise<{ items: Array<{ id: string, status: string }> }>)({})
  return res.items.find(i => i.id === 'lineConnected')!.status
}

const CREDS = { channelAccessToken: 'a'.repeat(40), channelSecret: 'b'.repeat(32) }

beforeEach(() => {
  vi.clearAllMocks()
  stubDb(CREDS)
})

describe('開通就緒度：已接上 LINE', () => {
  it('LINE 說網址有設、開關有開 → 完成', async () => {
    vi.mocked(checkLineWebhook).mockResolvedValue({ kind: 'ok' })
    await expect(lineStatus()).resolves.toBe('done')
  })

  it('🔴 憑證貼了、但 LINE 後台沒設收訊網址 → 不可以說完成', async () => {
    vi.mocked(checkLineWebhook).mockResolvedValue({ kind: 'broken', detail: 'LINE 後台還沒設定 Webhook 網址' })
    await expect(lineStatus()).resolves.toBe('incomplete')
  })

  it('LINE 填的是別的網址（多半是舊網域）：訊息還進得來，算完成——那是另一顆警示在講的事', async () => {
    vi.mocked(checkLineWebhook).mockResolvedValue({ kind: 'mismatch', endpoint: 'https://old.example.com/webhook' })
    await expect(lineStatus()).resolves.toBe('done')
  })

  it('🔴 問不到 LINE 時回「查不到」，不可以退回舊的「有欄位就算接上」', async () => {
    vi.mocked(checkLineWebhook).mockRejectedValue(new Error('LINE webhook 查詢失敗 HTTP 503'))
    await expect(lineStatus()).resolves.toBe('unknown')
  })

  it('憑證都還沒貼：直接是「還沒做」，不必去問 LINE', async () => {
    stubDb({})
    await expect(lineStatus()).resolves.toBe('incomplete')
    expect(checkLineWebhook).not.toHaveBeenCalled()
  })

  it('只貼了一半（有 Token 沒 Secret）也算還沒做', async () => {
    stubDb({ channelAccessToken: 'a'.repeat(40) })
    await expect(lineStatus()).resolves.toBe('incomplete')
    expect(checkLineWebhook).not.toHaveBeenCalled()
  })
})
