/**
 * 「有沒有收過客人訊息」的判定。
 *
 * 這個訊號決定兩件使用者看得見的事：開通引導會不會把人整頁攔下來、小幫手敢不敢說
 * 「客人的訊息進得來」。2026-08-23 老闆回報 MYFEEL 一開頁就被拉去開通引導（引導自己
 * 重查卻顯示都完成），連帶挖出舊寫法「抓前 20 筆對話在記憶體找」根本靠運氣——
 * 實測 320 場的鼴究室前 20 筆只有 1 筆有值。這裡把新舊兩條路都釘住。
 */
import { describe, expect, it, vi } from 'vitest'
import { findLatestPeerActiveConversation, hasReceivedPeerMessage } from './conversation-peer-activity'

const ts = (ms: number) => ({ toMillis: () => ms })

/**
 * 假 Firestore：indexed=false 時 orderBy 會丟出 Firestore 缺索引的那顆錯，
 * 用來驗證退路（fallback 掃描）。
 */
function stubDb(docs: Array<{ id: string, lastPeerActivityAt?: { toMillis: () => number } }>, opts: { indexed?: boolean, failWith?: Error } = {}) {
  const { indexed = true, failWith } = opts
  const scan = vi.fn(async () => ({ docs: docs.map(d => ({ id: d.id, data: () => d })) }))
  const orderBy = vi.fn(() => ({
    limit: () => ({
      get: async () => {
        if (failWith)
          throw failWith
        if (!indexed)
          throw new Error('9 FAILED_PRECONDITION: The query requires an index.')
        const sorted = docs
          .filter(d => d.lastPeerActivityAt != null)
          .sort((a, b) => b.lastPeerActivityAt!.toMillis() - a.lastPeerActivityAt!.toMillis())
        return { docs: sorted.slice(0, 1).map(d => ({ id: d.id, data: () => d })) }
      },
    }),
  }))
  const db = {
    collection: () => ({
      where: () => ({ orderBy, limit: () => ({ get: scan }) }),
    }),
  } as never
  return { db, orderBy, scan }
}

describe('findLatestPeerActiveConversation', () => {
  it('有索引：直接拿到「最近一次有客人講話」的那場，不掃整批對話', async () => {
    const { db, scan } = stubDb([
      { id: 'a', lastPeerActivityAt: ts(1000) },
      { id: 'b', lastPeerActivityAt: ts(3000) },
      { id: 'c' },
    ])
    const doc = await findLatestPeerActiveConversation(db, 'ws1')
    expect(doc?.id).toBe('b')
    expect(scan).not.toHaveBeenCalled() // 舊的 20 筆掃描不該再跑（讀取費＋答案不準）
  })

  it('🔴 一場都沒有人講過話 → null（開通引導才會留在「還沒收到訊息」）', async () => {
    const { db } = stubDb([{ id: 'a' }, { id: 'b' }])
    expect(await findLatestPeerActiveConversation(db, 'ws1')).toBeNull()
    expect(await hasReceivedPeerMessage(db, 'ws1')).toBe(false)
  })

  it('🔴 索引還沒部署（FAILED_PRECONDITION）→ 退回掃描，仍答得出「收過」', async () => {
    const { db, scan } = stubDb([
      { id: 'a' },
      { id: 'b', lastPeerActivityAt: ts(500) },
    ], { indexed: false })
    const doc = await findLatestPeerActiveConversation(db, 'ws1')
    expect(doc?.id).toBe('b')
    expect(scan).toHaveBeenCalled()
    expect(await hasReceivedPeerMessage(db, 'ws1')).toBe(true)
  })

  it('🔴 其他查詢失敗（權限、連線）照丟出去——查不到不可以被當成「沒收過訊息」', async () => {
    const { db, scan } = stubDb([{ id: 'a', lastPeerActivityAt: ts(1) }], {
      failWith: new Error('7 PERMISSION_DENIED: missing permissions'),
    })
    await expect(findLatestPeerActiveConversation(db, 'ws1')).rejects.toThrow('PERMISSION_DENIED')
    expect(scan).not.toHaveBeenCalled()
  })
})
