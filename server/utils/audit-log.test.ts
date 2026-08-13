/**
 * 稽核工具測試:遮罩/截斷/差異比對的純函式行為,加上「寫失敗不炸業務」的防護欄。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))

import { sanitizeAuditValue, diffChangedFields, writeAuditLog, AUDIT_LOGS_COLLECTION } from './audit-log'

describe('sanitizeAuditValue(淨化)', () => {
  it('憑證類欄位一律遮罩(含巢狀與常見命名)', () => {
    const out = sanitizeAuditValue({
      channelAccessToken: 'real-token-value',
      channelSecret: 'real-secret',
      nested: { apiKey: 'k', hashIv: 'iv' },
      name: '選單A',
    }) as Record<string, unknown>
    expect(out.channelAccessToken).toBe('••••')
    expect(out.channelSecret).toBe('••••')
    expect((out.nested as any).apiKey).toBe('••••')
    expect((out.nested as any).hashIv).toBe('••••')
    expect(out.name).toBe('選單A')
  })

  it('長字串截斷並標明原長度', () => {
    const out = sanitizeAuditValue('a'.repeat(600)) as string
    expect(out).toContain('截斷')
    expect(out).toContain('600')
    expect(out.length).toBeLessThan(600)
  })

  it('undefined/null 一律變 null(Firestore 不收 undefined)', () => {
    expect(sanitizeAuditValue(undefined)).toBeNull()
    expect(sanitizeAuditValue(null)).toBeNull()
  })
})

describe('diffChangedFields(差異比對)', () => {
  it('只留值有變的欄位;updatedAt 預設忽略;子物件整顆比', () => {
    const before = { enabled: false, replyMode: 'draft', serviceHours: { enabled: true, start: '09:00' }, updatedAt: 1 }
    const after = { enabled: true, replyMode: 'draft', serviceHours: { enabled: true, start: '22:00' }, updatedAt: 2 }
    const d = diffChangedFields(before, after)
    expect(d.changedKeys.sort()).toEqual(['enabled', 'serviceHours'])
    expect(d.before.enabled).toBe(false)
    expect(d.after.enabled).toBe(true)
    expect((d.after.serviceHours as any).start).toBe('22:00')
    expect(d.before.replyMode).toBeUndefined()
  })

  it('沒有變更 → changedKeys 空(呼叫端可據此跳過寫稽核)', () => {
    const same = { a: 1, b: { c: 2 } }
    expect(diffChangedFields(same, { ...same, updatedAt: 9 }).changedKeys).toEqual([])
  })
})

describe('writeAuditLog(寫入)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('寫入的 payload 有淨化、集合名正確', async () => {
    const add = vi.fn().mockResolvedValue({})
    const db = { collection: vi.fn(() => ({ add })) } as any
    await writeAuditLog({
      workspaceId: 'w1', uid: 'u1', actor: 'human', action: 'ai/settings.put',
      before: { channelSecret: 's1' }, after: { channelSecret: 's2' },
    }, db)
    expect(db.collection).toHaveBeenCalledWith(AUDIT_LOGS_COLLECTION)
    const payload = add.mock.calls[0]![0]
    expect(payload.workspaceId).toBe('w1')
    expect(payload.actor).toBe('human')
    expect((payload.before as any).channelSecret).toBe('••••')
    expect((payload.after as any).channelSecret).toBe('••••')
    expect(payload.createdAt).toEqual({ __op: 'ts' })
  })

  it('db 掛掉 → 吞錯不 throw(稽核是配菜不是閘門)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { collection: () => { throw new Error('boom') } } as any
    await expect(writeAuditLog({ workspaceId: 'w1', uid: 'u1', actor: 'agent', action: 'x' }, db))
      .resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
  })
})
