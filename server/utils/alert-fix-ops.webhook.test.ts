/**
 * 一鍵修「換 LINE 收訊網址」的行為測試（`D-34` / `C-84`，2026-09-16 補）。
 *
 * 為什麼單獨挑這個 op 釘：七個修復動作裡，**只有它會伸手改 LINE 那邊的設定**，
 * 而且改的是「客人的訊息送到哪」——做錯的後果是訊息整條斷掉，不是畫面難看而已。
 *
 * 這裡用假的 LINE 回應驗證「什麼時候該動手、什麼時候一格都不能動」：
 * 1. 病因不是網址填錯（Token 失效、系統沒有正式網址）時，⛔連寫入 API 都不准打。
 * 2. 已經是正式網址了就說沒事，同樣不打。
 * 3. LINE 拒絕這次修改時，⛔不可以留下「改過了」的稽核紀錄（沒動到東西就不能記）。
 * 4. 真的換了：要帶正式網址、要戳掉探測快取（否則接下來五分鐘都驗到舊答案），
 *    並且留下一筆前後對照的稽核。
 *
 * ⚠️ 測不到、仍必須拿測試官方帳號實打一次的部分：LINE 這支寫入 API 真實的回應
 *    （會不會被權限擋、回什麼碼），以及換完之後訊息是不是真的進得來。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchEndpoint = vi.fn()
const putEndpoint = vi.fn()
const invalidateProbe = vi.fn()
const auditLogs: any[] = []

vi.mock('./line-webhook-remote', async () => {
  const actual = await vi.importActual<typeof import('./line-webhook-remote')>('./line-webhook-remote')
  return {
    ...actual,
    fetchLineWebhookEndpoint: (...a: unknown[]) => fetchEndpoint(...a),
    putLineWebhookEndpoint: (...a: unknown[]) => putEndpoint(...a),
  }
})
vi.mock('./line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: async () => ({ channelAccessToken: 'tok-123' }),
}))
vi.mock('./audit-log', () => ({
  writeAuditLog: async (input: unknown) => { auditLogs.push(input) },
}))
vi.mock('./workspace-alerts', async () => {
  const actual = await vi.importActual<typeof import('./workspace-alerts')>('./workspace-alerts')
  return { ...actual, invalidateWebhookProbe: (...a: unknown[]) => invalidateProbe(...a) }
})

const { ALERT_FIX_OPS } = await import('./alert-fix-ops')
const op = ALERT_FIX_OPS['line-webhook-set-url']

const BASE = 'https://app.example.com'
const TARGET = `${BASE}/webhook`
const ctx = { db: {} as any, workspaceId: 'w1', uid: 'u1' }

function stubBaseUrl(url: string | undefined) {
  vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: url }))
}

beforeEach(() => {
  fetchEndpoint.mockReset()
  putEndpoint.mockReset()
  invalidateProbe.mockReset()
  auditLogs.length = 0
  stubBaseUrl(BASE)
})

describe('一鍵修：換 LINE 收訊網址', () => {
  it('網址填的是別的：預告列出「現在填的 → 會換成的」並附警告，確認後才真的打 LINE', async () => {
    fetchEndpoint.mockResolvedValue({ ok: true, data: { endpoint: 'https://old.example.com/webhook', active: true } })
    putEndpoint.mockResolvedValue({ ok: true })

    const preview = await op.preview(ctx)
    expect(preview.state).toBe('fixable')
    expect(preview.items.map(i => i.label)).toEqual(['https://old.example.com/webhook', TARGET])
    // 換網址＝把客人的訊息從舊系統搬過來，這句警告不能掉
    expect(preview.warning).toContain('舊網址')
    // 預告階段一個寫入都不准發生
    expect(putEndpoint).not.toHaveBeenCalled()

    const res = await op.execute(ctx)
    expect(res.ok).toBe(true)
    expect(putEndpoint).toHaveBeenCalledWith('tok-123', TARGET)
    // 探測快取要當場戳掉，否則「修好了沒」會拿到五分鐘前的舊答案
    expect(invalidateProbe).toHaveBeenCalledWith('w1')
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]).toMatchObject({
      action: 'alert-fix/line-webhook-set-url',
      before: { endpoint: 'https://old.example.com/webhook' },
      after: { endpoint: TARGET },
    })
  })

  it('LINE 後台還沒填網址（404）：直接幫他填上，稽核記成「未設定 → 正式網址」', async () => {
    fetchEndpoint.mockResolvedValue({ ok: false, status: 404, body: {} })
    putEndpoint.mockResolvedValue({ ok: true })

    const preview = await op.preview(ctx)
    expect(preview.state).toBe('fixable')
    expect(preview.items[0]?.label).toBe('（空白）')

    await op.execute(ctx)
    expect(putEndpoint).toHaveBeenCalledWith('tok-123', TARGET)
    expect(auditLogs[0]).toMatchObject({ before: { endpoint: '(未設定)' } })
  })

  it('⛔ Token 失效（401）：說清楚修不了並指去劇本，一格都不動', async () => {
    fetchEndpoint.mockResolvedValue({ ok: false, status: 401, body: {} })

    const preview = await op.preview(ctx)
    expect(preview.state).toBe('blocked')
    expect(preview.summary).toContain('Token 失效')

    const res = await op.execute(ctx)
    expect(res.ok).toBe(false)
    expect(putEndpoint).not.toHaveBeenCalled()
    expect(auditLogs).toHaveLength(0)
  })

  it('⛔ 系統這邊沒有對外正式網址：連問都不問 LINE，更不會亂改', async () => {
    stubBaseUrl('')

    const preview = await op.preview(ctx)
    expect(preview.state).toBe('blocked')
    expect(fetchEndpoint).not.toHaveBeenCalled()

    await op.execute(ctx)
    expect(putEndpoint).not.toHaveBeenCalled()
    expect(auditLogs).toHaveLength(0)
  })

  it('已經是正式網址且開關開著：說沒事，不做任何動作', async () => {
    fetchEndpoint.mockResolvedValue({ ok: true, data: { endpoint: TARGET, active: true } })

    const preview = await op.preview(ctx)
    expect(preview.state).toBe('clear')

    const res = await op.execute(ctx)
    expect(res.ok).toBe(true)
    expect(putEndpoint).not.toHaveBeenCalled()
    expect(auditLogs).toHaveLength(0)
  })

  it('網址對了但「Use webhook」開關沒開：擋下來指去劇本（那個開關沒有 API 能代開）', async () => {
    fetchEndpoint.mockResolvedValue({ ok: true, data: { endpoint: TARGET, active: false } })

    const preview = await op.preview(ctx)
    expect(preview.state).toBe('blocked')
    expect(preview.summary).toContain('Use webhook')
    expect(putEndpoint).not.toHaveBeenCalled()
  })

  it('🔴 LINE 拒絕這次修改：如實回報，且⛔不留下「改過了」的稽核紀錄', async () => {
    fetchEndpoint.mockResolvedValue({ ok: true, data: { endpoint: 'https://old.example.com/webhook', active: true } })
    putEndpoint.mockResolvedValue({ ok: false, status: 403, body: {} })

    const res = await op.execute(ctx)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('403')
    expect(res.message).toContain('沒有動到任何設定')
    expect(auditLogs).toHaveLength(0)
    expect(invalidateProbe).not.toHaveBeenCalled()
  })

  it('這次問不到 LINE（5xx）：不下結論，也不動手', async () => {
    fetchEndpoint.mockResolvedValue({ ok: false, status: 500, body: {} })

    const preview = await op.preview(ctx)
    expect(preview.state).toBe('blocked')
    expect(preview.summary).toContain('不代表壞掉')
    expect(putEndpoint).not.toHaveBeenCalled()
  })
})
