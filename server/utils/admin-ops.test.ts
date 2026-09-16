/**
 * 小幫手代辦的操作模組表（`C-31` Phase 2）。
 *
 * 釘住的是「會出事的那幾件」：
 * 1. 🔴 **勿擾時段與服務時間是補集**——使用者說「晚上 10 點到早上 8 點不要吵我」，
 *    存進去的服務時間必須是 08:00–22:00。寫反的話上下班時間整個顛倒，
 *    而且是那種「畫面看起來有設定、行為卻相反」的錯。
 * 2. 預覽階段**一個字都不寫**：確認之前不落任何變更是這整條路的前提。
 * 3. 執行只動該動的那一格（⛔整包覆蓋會洗掉別人剛編輯的內容）。
 * 4. 找不到／撞名不猜：列清單讓它反問，⛔不要挑「最接近的那一條」。
 * 5. 已經是那個狀態就不要假裝做了事。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_OP_LABELS, ADMIN_OP_RISK, adminOpAuditAction } from '~~/shared/types/admin-ops'
import { AUDIT_ACTION_LABELS } from '~~/shared/types/audit'
import { CAPABILITIES } from '~~/shared/permissions'

const settingsStore = { serviceHours: { enabled: true, start: '09:00', end: '18:00', weekendOff: true, dndReply: 'x' } }
const setCalls: any[] = []
const auditLogs: any[] = []
const invalidated: string[] = []

vi.mock('./ai-settings', () => ({
  getAiSettings: async () => structuredClone(settingsStore),
  setAiSettings: async (_wid: string, partial: any) => { setCalls.push(partial); return {} },
}))
vi.mock('./audit-log', () => ({
  writeAuditLog: async (input: unknown) => { auditLogs.push(input) },
}))
vi.mock('./script-health', () => ({
  invalidateScriptHealthCache: (wid: string) => { invalidated.push(wid) },
}))

const { ADMIN_OPS, AdminOpUserError, getAdminOp } = await import('./admin-ops')

// ── 假的 Firestore：只夠這兩個 op 用（流程清單 + 單一文件 update）────
const scriptDocs: { id: string, data: Record<string, any> }[] = []
const updates: { id: string, patch: Record<string, unknown> }[] = []

const db = {
  collection: () => ({
    where: () => ({
      get: async () => ({ docs: scriptDocs.map(d => ({ id: d.id, data: () => d.data })) }),
    }),
    doc: (id: string) => ({
      update: async (patch: Record<string, unknown>) => { updates.push({ id, patch }) },
    }),
  }),
} as any

const ctx = { db, workspaceId: 'w1', uid: 'u1' }

beforeEach(() => {
  setCalls.length = 0
  auditLogs.length = 0
  invalidated.length = 0
  updates.length = 0
  scriptDocs.length = 0
  settingsStore.serviceHours = { enabled: true, start: '09:00', end: '18:00', weekendOff: true, dndReply: 'x' }
})

describe('操作模組表的不變量', () => {
  it('每個 op 都有白話名稱、風險級別，且⛔沒有高風險的東西混進來', () => {
    for (const id of Object.keys(ADMIN_OPS) as (keyof typeof ADMIN_OP_LABELS)[]) {
      expect(ADMIN_OP_LABELS[id], `${id} 沒有白話名稱`).toBeTruthy()
      expect(['low', 'medium'], `${id} 的風險級別不合法（高風險連掛都不該掛）`).toContain(ADMIN_OP_RISK[id])
    }
  })

  it('每個 op 的門檻都是既有 capability（⛔不自己發明一套權限）', () => {
    for (const [id, op] of Object.entries(ADMIN_OPS))
      expect(CAPABILITIES[op.capability], `${id} 用了不存在的 capability`).toBeTruthy()
  })

  it('每個 op 在操作紀錄上都有白話說明（否則畫面會秀 agent-op/xxx 給店家看）', () => {
    for (const id of Object.keys(ADMIN_OPS) as (keyof typeof ADMIN_OP_LABELS)[])
      expect(AUDIT_ACTION_LABELS[adminOpAuditAction(id)], `${id} 缺操作紀錄說明`).toBeTruthy()
  })

  it('不認得的操作代號一律擋下，並講出做得到哪些（⛔不做最接近的那個）', () => {
    expect(() => getAdminOp('delete-everything')).toThrow(AdminOpUserError)
  })
})

describe('op：服務時間／勿擾時段', () => {
  const op = ADMIN_OPS['ai-settings-service-hours']

  it('🔴 講「勿擾 22:00–08:00」要存成服務時間 08:00–22:00（補集，⛔不是照抄）', () => {
    const args = op.normalize({ mode: 'dnd', start: '22:00', end: '08:00' })
    expect(args).toMatchObject({ enabled: true, start: '08:00', end: '22:00' })
  })

  it('講「服務時間 9 點到 6 點」就照抄，並補零成 09:00', () => {
    expect(op.normalize({ mode: 'service', start: '9:00', end: '18:00' }))
      .toMatchObject({ start: '09:00', end: '18:00' })
  })

  it('沒講清楚是哪一種時間、或時間格式不對：要求反問，⛔不自己猜一個', () => {
    expect(() => op.normalize({ start: '22:00', end: '08:00' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ mode: 'service', start: '晚上', end: '早上' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ mode: 'service', start: '09:00', end: '09:00' })).toThrow(AdminOpUserError)
  })

  it('預覽會把前後與「勿擾是哪一段」都講出來，而且⛔一個字都還沒寫進去', async () => {
    const args = op.normalize({ mode: 'dnd', start: '22:00', end: '08:00' })
    const preview = await op.preview(ctx, args)

    expect(preview.items.map(i => i.label)).toEqual(['週一至週五 09:00–18:00', '週一至週五 08:00–22:00'])
    expect(preview.items[1]?.note).toContain('22:00–08:00') // 改完的勿擾時段
    expect(preview.warning).toContain('找真人')
    expect(setCalls).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })

  it('執行才寫入：只帶服務時間這一格，並留下前後對照的稽核（actor=agent）', async () => {
    const args = op.normalize({ mode: 'dnd', start: '22:00', end: '08:00' })
    const res = await op.execute(ctx, args)

    expect(res.ok).toBe(true)
    expect(setCalls).toHaveLength(1)
    // ⛔ 只有 serviceHours：整份設定覆蓋會把別的欄位一起洗掉
    expect(Object.keys(setCalls[0])).toEqual(['serviceHours'])
    expect(setCalls[0].serviceHours).toMatchObject({ enabled: true, start: '08:00', end: '22:00', weekendOff: true })
    expect(auditLogs[0]).toMatchObject({
      actor: 'agent',
      action: 'agent-op/ai-settings-service-hours',
      before: { serviceHours: { start: '09:00', end: '18:00' } },
      after: { serviceHours: { start: '08:00', end: '22:00' } },
    })
  })

  it('沒提到週末就沿用現在的設定（⛔不要順手幫人改成預設值）', async () => {
    settingsStore.serviceHours = { enabled: true, start: '09:00', end: '18:00', weekendOff: false, dndReply: 'x' }
    await op.execute(ctx, op.normalize({ mode: 'service', start: '10:00', end: '19:00' }))
    expect(setCalls[0].serviceHours.weekendOff).toBe(false)
  })

  it('本來就是關的還要關：說不用改，且不寫入', async () => {
    settingsStore.serviceHours = { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: 'x' }
    const args = op.normalize({ enabled: false })

    const preview = await op.preview(ctx, args)
    expect(preview.noop).toBe(true)

    const res = await op.execute(ctx, args)
    expect(res.ok).toBe(true)
    expect(setCalls).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })
})

describe('op：自動回應上架／下架', () => {
  const op = ADMIN_OPS['script-set-enabled']

  function seed(rows: { id: string, name: string, enabled: boolean, keywords?: string[] }[]) {
    scriptDocs.push(...rows.map(r => ({
      id: r.id,
      data: {
        name: r.name,
        enabled: r.enabled,
        rootNodeId: 'n1',
        nodes: [{ id: 'n1', type: 'trigger', keywords: r.keywords ?? ['出貨'], matchMode: 'keyword' }],
      },
    })))
  }

  it('預覽講出觸發字與影響，⛔不寫任何東西', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true, keywords: ['出貨', '到貨'] }])
    const args = op.normalize({ name: '出貨查詢', enabled: false })
    const preview = await op.preview(ctx, args)

    expect(preview.summary).toContain('下架')
    expect(preview.items[1]?.label).toContain('出貨')
    expect(preview.warning).toContain('收不到')
    expect(updates).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })

  it('執行只動「有沒有啟用」那一格（⛔不整份覆蓋），並戳掉健康狀態快取', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true }])
    const res = await op.execute(ctx, op.normalize({ name: '出貨查詢', enabled: false }))

    expect(res.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(Object.keys(updates[0]!.patch).sort()).toEqual(['enabled', 'updatedAt'])
    expect(updates[0]!.patch.enabled).toBe(false)
    expect(invalidated).toEqual(['w1'])
    expect(auditLogs[0]).toMatchObject({ actor: 'agent', before: { enabled: true }, after: { enabled: false } })
  })

  it('🔴 找不到那條流程：列出現有的讓它反問，⛔不挑最接近的那一條', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true }, { id: 'd2', name: '退貨流程', enabled: false }])
    const args = op.normalize({ name: '出貨', enabled: false }) // 少了「查詢」

    await expect(op.preview(ctx, args)).rejects.toThrow(AdminOpUserError)
    await expect(op.preview(ctx, args)).rejects.toThrow(/出貨查詢/)
    expect(updates).toHaveLength(0)
  })

  it('🔴 兩條同名：不猜，請人去改名或自己操作', async () => {
    seed([{ id: 'd1', name: '客服', enabled: true }, { id: 'd2', name: '客服', enabled: false }])
    await expect(op.preview(ctx, op.normalize({ name: '客服', enabled: false }))).rejects.toThrow(/沒辦法確定/)
  })

  it('已經是那個狀態：說不用改，且不寫入', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: false }])
    const args = op.normalize({ name: '出貨查詢', enabled: false })

    expect((await op.preview(ctx, args)).noop).toBe(true)
    await op.execute(ctx, args)
    expect(updates).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })

  it('沒說要開還是關就不提議（⛔不要自己補一個常見值）', () => {
    expect(() => op.normalize({ name: '出貨查詢' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ enabled: true })).toThrow(AdminOpUserError)
  })

  it('現況指紋含「現在是開還是關」：別人改過之後，舊提議就對不上了', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true }])
    const args = op.normalize({ name: '出貨查詢', enabled: false })
    const before = await op.fingerprint(ctx, args)

    scriptDocs[0]!.data.enabled = false // 別人剛剛在頁面上把它關掉了
    expect(await op.fingerprint(ctx, args)).not.toBe(before)
  })
})
