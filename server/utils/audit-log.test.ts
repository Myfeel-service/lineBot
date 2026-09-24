/**
 * 稽核工具測試:遮罩/截斷/差異比對的純函式行為,加上「寫失敗不炸業務」的防護欄。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))

import { getDb } from './firebase'
import {
  sanitizeAuditValue,
  diffChangedFields,
  writeAuditLog,
  auditSnapshot,
  auditTimeText,
  AUDIT_LOGS_COLLECTION,
} from './audit-log'

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

  /**
   * ⛔ 這一條釘的是 `C-254` 當天被 `test-send` 的單元測試抓到的真 bug：
   * 原本簽章是 `db: Firestore = getDb()`，而**預設參數是在進 try 之前求值的**——
   * `getDb()` 一失敗，例外就直接往上拋，把呼叫它的業務端點一起打掛。
   * 推播已經送到客人手機了，API 卻回 500，使用者會以為沒送成功再按一次。
   * 改回預設參數寫法的話這一條會紅。
   */
  it('⛔ 沒帶 db 而 getDb() 自己爆炸時，也不可以往上拋', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getDb).mockImplementation(() => { throw new Error('firebase not initialised') })
    await expect(writeAuditLog({ workspaceId: 'w1', uid: 'u1', actor: 'human', action: 'broadcast.send' }))
      .resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
  })

  it('組織／平台層的歸屬欄位有寫進去，沒帶的就不要無中生有', async () => {
    const add = vi.fn().mockResolvedValue({})
    const db = { collection: vi.fn(() => ({ add })) } as any

    await writeAuditLog({
      workspaceId: '', uid: 'u1', actor: 'human', action: 'super.voidInvoice',
      orgId: 'org1', scope: 'platform', targetId: 'ORD-1',
    }, db)
    const platform = add.mock.calls[0]![0]
    expect(platform.workspaceId).toBe('')
    expect(platform.orgId).toBe('org1')
    expect(platform.scope).toBe('platform')
    expect(platform.targetId).toBe('ORD-1')

    // ⛔ 一般租戶的紀錄不可以憑空長出 orgId／scope——那會讓「平台做的」與
    //    「客戶自己做的」在資料上分不出來，畫面上的「平台」標籤就失去意義
    await writeAuditLog({ workspaceId: 'w1', uid: 'u1', actor: 'human', action: 'flow.put' }, db)
    const tenant = add.mock.calls[1]![0]
    expect('orgId' in tenant).toBe(false)
    expect('scope' in tenant).toBe(false)
  })
})

describe('auditSnapshot(只留看得懂的那幾格)', () => {
  it('陣列只記數量,⛔ 不把整包內容塞進紀錄(會被截斷、整筆變 lossy)', () => {
    const out = auditSnapshot(
      { name: '週年慶', messages: [1, 2, 3], status: 'draft', secretStuff: 'x' },
      { keep: ['name', 'status'], count: ['messages'] },
    )
    expect(out).toEqual({ name: '週年慶', status: 'draft', messagesCount: 3 })
  })

  it('⛔ 不是陣列就不要寫 0 充數(「沒有這個欄位」跟「真的是 0」要分得出來)', () => {
    const out = auditSnapshot({ name: 'x' }, { keep: ['name'], count: ['messages'] })
    expect(out).toEqual({ name: 'x' })
  })

  it('文件是 null 就回 null(沒有東西可以摘要)', () => {
    expect(auditSnapshot(null, { keep: ['name'] })).toBeNull()
  })
})

describe('auditTimeText(時間欄位)', () => {
  it('Timestamp / Date / 字串三種來源都講得出時間', () => {
    expect(auditTimeText(new Date('2026-09-24T00:00:00.000Z'))).toBe('2026-09-24T00:00:00.000Z')
    expect(auditTimeText({ toMillis: () => Date.UTC(2026, 8, 24) })).toBe('2026-09-24T00:00:00.000Z')
    expect(auditTimeText('2026-09-24')).toBe('2026-09-24')
  })

  it('⛔ 空值回 null,不要回「（一組設定）」那種看不懂的東西', () => {
    expect(auditTimeText(null)).toBeNull()
    expect(auditTimeText(undefined)).toBeNull()
    expect(auditTimeText('')).toBeNull()
  })
})
