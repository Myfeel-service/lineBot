/**
 * 待確認操作的憑證（`C-31` Phase 2）。
 *
 * 這三條是確認流的地基——任何一條破了，「按確定才執行」就只是裝飾：
 * 1. 參數被改過的憑證一律拒絕（不然「停用 A」可以在送回來的路上變成「停用 B」）。
 * 2. 綁死是給誰、給哪個工作區的（不然 A 家的憑證能在 B 家執行＝跨租戶寫入）。
 * 3. 會過期（提議看一眼就走開，一小時後那張卡不該還能按）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_OP_TOKEN_TTL_MS, issueAdminOpToken, verifyAdminOpToken } from './admin-op-token'

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ cronSecret: 'test-secret', firebasePrivateKey: '' }))
})

const base = {
  w: 'w1',
  u: 'u1',
  op: 'script-set-enabled' as const,
  a: { name: '訂單查詢', enabled: false },
  g: 'doc1:true',
}
const who = { workspaceId: 'w1', uid: 'u1' }

describe('代辦確認憑證', () => {
  it('原樣送回來驗得過，參數一字不差地還原', () => {
    const token = issueAdminOpToken(base)
    const res = verifyAdminOpToken(token, who)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.payload.op).toBe('script-set-enabled')
    expect(res.payload.a).toEqual({ name: '訂單查詢', enabled: false })
    expect(res.payload.g).toBe('doc1:true')
  })

  it('🔴 參數被動過手腳：拒絕（改的是內容，簽章就對不上）', () => {
    const token = issueAdminOpToken(base)
    const [body, sig] = token.split('.')
    const tampered = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))
    tampered.a.name = '別條流程'
    const forged = `${Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url')}.${sig}`

    const res = verifyAdminOpToken(forged, who)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('bad-signature')
  })

  it('🔴 別人的憑證用不了：換人、換工作區都擋', () => {
    const token = issueAdminOpToken(base)

    expect(verifyAdminOpToken(token, { workspaceId: 'w1', uid: 'u2' })).toMatchObject({ ok: false, reason: 'wrong-user' })
    expect(verifyAdminOpToken(token, { workspaceId: 'w2', uid: 'u1' })).toMatchObject({ ok: false, reason: 'wrong-user' })
  })

  it('過期就失效，而且「過期」要跟「被竄改」分得開（下一步完全不同）', () => {
    const now = 1_000_000
    const token = issueAdminOpToken(base, now)

    expect(verifyAdminOpToken(token, who, now + ADMIN_OP_TOKEN_TTL_MS - 1).ok).toBe(true)
    expect(verifyAdminOpToken(token, who, now + ADMIN_OP_TOKEN_TTL_MS + 1)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('亂七八糟的字串不會讓驗證爆掉，也不會放行', () => {
    for (const bad of ['', 'abc', 'a.b', '....'])
      expect(verifyAdminOpToken(bad, who).ok, `「${bad}」不該通過`).toBe(false)
  })
})
