/**
 * 「還原這一筆」的判斷與執行（`C-31` Phase 2 收尾）。
 *
 * 還原是出事後的第一個動作，所以它自己不能製造新的事故。釘住：
 * 1. 🔴 **這段期間又被改過就不准還原**——否則就是拿舊世界的判斷蓋掉別人後來的修改。
 * 2. 還原不了的要**說得出原因**，⛔不可以只是把按鈕藏起來（藏起來等於沒回答）。
 * 3. 還原本身也要留一筆稽核，原本那一筆不動（能被改寫的紀錄就不叫紀錄）。
 * 4. 白名單：沒想過的設定欄位一律不還原。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings: Record<string, any> = { serviceHours: { enabled: true, start: '08:00', end: '22:00' }, replyMode: 'auto' }
const setCalls: any[] = []
const auditLogs: any[] = []

vi.mock('./ai-settings', () => ({
  getAiSettings: async () => structuredClone(settings),
  setAiSettings: async (_w: string, partial: any) => { setCalls.push(partial); return {} },
}))
vi.mock('./audit-log', () => ({
  AUDIT_LOGS_COLLECTION: 'auditLogs',
  writeAuditLog: async (i: unknown) => { auditLogs.push(i) },
}))
vi.mock('./script-health', () => ({ invalidateScriptHealthCache: vi.fn() }))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) } }))

;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)

const { planRevert, applyRevert } = await import('./audit-revert')

const scriptDoc: Record<string, any> = { workspaceId: 'w1', enabled: false, name: '出貨查詢' }
const updates: any[] = []
const db = {
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: true, get: (k: string) => scriptDoc[k] }),
      update: async (p: any) => { updates.push(p) },
    }),
  }),
} as any
const ctx = { db, workspaceId: 'w1', uid: 'u1' }

beforeEach(() => {
  setCalls.length = 0
  auditLogs.length = 0
  updates.length = 0
  settings.serviceHours = { enabled: true, start: '08:00', end: '22:00' }
  settings.replyMode = 'auto'
  scriptDoc.enabled = false
})

describe('能不能還原', () => {
  it('AI 設定類：可以，並說得出要做什麼', () => {
    const plan = planRevert({ id: 'a1', action: 'agent-op/ai-settings-service-hours', before: { serviceHours: {} }, after: { serviceHours: {} } })
    expect(plan).toMatchObject({ ok: true, capability: 'ai.settings.write' })
  })

  it('🔴 不能還原的要講原因：舊紀錄沒記動到哪一條流程', () => {
    const plan = planRevert({ id: 'a2', action: 'agent-op/script-set-enabled', before: { enabled: true }, after: { enabled: false } })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('舊紀錄')
  })

  it('🔴 本質上不可逆的動作（重試學習之類）直接說做不到', () => {
    const plan = planRevert({ id: 'a3', action: 'alert-fix/knowledge-retry-index', before: null, after: null })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('沒有辦法還原')
  })

  it('🔴 紀錄被截斷過就不准還原（寫回去會少東西，人卻以為完整還原了）', () => {
    const byFlag = planRevert({ id: 'a5', action: 'ai/settings.put', before: { sensitiveTopics: ['a'] }, after: {}, lossy: true })
    expect(byFlag.ok).toBe(false)
    if (!byFlag.ok) expect(byFlag.reason).toContain('截斷')

    // 舊紀錄沒有旗標，只能認淨化留下的痕跡
    const byMarker = planRevert({
      id: 'a6',
      action: 'ai/settings.put',
      before: { shopUrl: 'https://…(截斷,原 900 字)' },
      after: {},
    })
    expect(byMarker.ok).toBe(false)
  })

  it('🔴 子物件只比紀錄裡有寫到的那幾格（否則永遠說「被改過」、永遠不能還原）', async () => {
    settings.handoffNotify = { enabled: true, lineUserIds: ['U1', 'U2'], slaRemindMinutes: 45 }
    const msg = await applyRevert(
      {
        id: 'a7',
        action: 'agent-op/ai-settings-handoff-sla',
        before: { handoffNotify: { slaRemindMinutes: 30 } },
        after: { handoffNotify: { slaRemindMinutes: 45 } },
      },
      ctx,
    )
    // 收件人名單沒被寫進去（setAiSettings 是深合併，只帶要改的那一格）
    expect(setCalls[0]).toEqual({ handoffNotify: { slaRemindMinutes: 30 } })
    expect(msg).toContain('改回')
  })

  it('⛔ 白名單以外的設定欄位不還原（設定會長新欄位，漏擋一個就寫回沒想過的東西）', () => {
    const plan = planRevert({ id: 'a4', action: 'ai/settings.put', before: { systemPrompt: '舊的' }, after: { systemPrompt: '新的' } })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('systemPrompt')
  })
})

describe('真的還原', () => {
  it('把設定改回原本的值，並另外記一筆稽核（原紀錄不動）', async () => {
    const msg = await applyRevert(
      { id: 'a1', action: 'agent-op/ai-settings-reply-mode', before: { replyMode: 'draft' }, after: { replyMode: 'auto' } },
      ctx,
    )

    expect(setCalls[0]).toEqual({ replyMode: 'draft' })
    expect(auditLogs[0]).toMatchObject({ action: 'audit/revert', actor: 'human', after: { replyMode: 'draft' } })
    expect(auditLogs[0].note).toContain('a1')
    expect(msg).toContain('改回')
  })

  it('🔴 這段期間又被改過：不還原，並講清楚為什麼', async () => {
    settings.replyMode = 'draft' // 有人已經自己改回去了，現值不等於當時的「改之後」
    await expect(applyRevert(
      { id: 'a1', action: 'agent-op/ai-settings-reply-mode', before: { replyMode: 'draft' }, after: { replyMode: 'auto' } },
      ctx,
    )).rejects.toThrow(/又被改過/)

    expect(setCalls).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })

  it('流程上下架：改回原本的開關狀態並留稽核', async () => {
    const msg = await applyRevert(
      { id: 'a5', action: 'agent-op/script-set-enabled', targetId: 'd1', before: { enabled: true }, after: { enabled: false } },
      ctx,
    )

    expect(updates[0]).toMatchObject({ enabled: true })
    expect(auditLogs[0]).toMatchObject({ action: 'audit/revert', targetId: 'd1' })
    expect(msg).toContain('啟用')
  })

  it('🔴 流程這段期間被改過：不還原', async () => {
    scriptDoc.enabled = true // 已經有人打開了，跟當時的「改之後（關）」對不上
    await expect(applyRevert(
      { id: 'a5', action: 'agent-op/script-set-enabled', targetId: 'd1', before: { enabled: true }, after: { enabled: false } },
      ctx,
    )).rejects.toThrow(/又被改過/)

    expect(updates).toHaveLength(0)
  })
})
