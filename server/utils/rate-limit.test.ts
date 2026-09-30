/**
 * 公開端點共用節流（`G-105`）。
 *
 * 釘住四件容易寫反的事：
 * 1. 名額是**按 key 分開算**的——一個來源猛送不該擋到別人。
 * 2. 視窗過了就恢復：被擋一次不是被鎖住。
 * 3. 一次要好幾個名額（一批 30 個事件）時，只給得出剩下的那幾個，⛔ 不是整批放行或整批拒絕。
 * 4. 取 IP 取的是 `X-Forwarded-For` **最右邊**那格——最左邊是客人自己能填的。
 */
import { describe, expect, it } from 'vitest'
import { clientIpFromForwardedFor, createRateLimiter, forwardedForHops, rateLimitClientIp } from './rate-limit'

describe('createRateLimiter', () => {
  it('上限以內都給，超過才擋，並說出還要等多久', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 3 })
    const now = 1_000_000
    for (let i = 0; i < 3; i++) expect(rl.take('a', 1, now).limited, `第 ${i + 1} 次不該被擋`).toBe(false)
    const over = rl.take('a', 1, now + 10_000)
    expect(over).toMatchObject({ granted: 0, limited: true, firstRejection: true })
    // ⛔ 不可以回 0：那等於叫人馬上重試
    expect(over.retryAfterMs).toBe(50_000)
    // 同一個視窗裡的第二次拒絕不再算「第一次」（呼叫端靠這個只記一行 log）
    expect(rl.take('a', 1, now + 10_000).firstRejection).toBe(false)
  })

  it('⛔ 不同 key 各算各的', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 })
    rl.take('a', 1, 0)
    expect(rl.take('a', 1, 0).limited).toBe(true)
    expect(rl.take('b', 1, 0).limited).toBe(false)
  })

  it('視窗過了就恢復', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 })
    rl.take('a', 1, 0)
    expect(rl.take('a', 1, 59_999).limited).toBe(true)
    expect(rl.take('a', 1, 60_000)).toMatchObject({ granted: 1, limited: false })
  })

  it('一次要好幾個：只給剩下的那幾個', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 10 })
    expect(rl.take('u', 7, 0)).toMatchObject({ granted: 7, limited: false })
    expect(rl.take('u', 7, 0)).toMatchObject({ granted: 3, limited: true })
    expect(rl.take('u', 7, 0)).toMatchObject({ granted: 0, limited: true })
  })

  it('要 0 個不算被擋（空批次不該觸發「被擋了」的 log）', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 0 })
    expect(rl.take('u', 0, 0)).toMatchObject({ granted: 0, limited: false })
  })

  it('⛔ key 的數量有上限：換 key 猛打不會讓記憶體一直長（被擠掉的最舊那個重新拿到新視窗）', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 2 })
    rl.take('old', 1, 0)
    expect(rl.take('old', 1, 0).limited).toBe(true)
    rl.take('k1', 1, 1)
    rl.take('k2', 1, 2) // 第三個 key 進來，最舊的 'old' 被擠掉
    expect(rl.take('old', 1, 3).limited).toBe(false)
  })
})

describe('clientIpFromForwardedFor', () => {
  it('⛔ 取最右邊：最左邊是客人自己帶的，換一個值就能繞過節流', () => {
    expect(clientIpFromForwardedFor('6.6.6.6, 203.0.113.9')).toBe('203.0.113.9')
    expect(clientIpFromForwardedFor('1.1.1.1,2.2.2.2 , 203.0.113.9 ')).toBe('203.0.113.9')
  })

  it('只有一格就是那一格；沒有標頭回空字串', () => {
    expect(clientIpFromForwardedFor('203.0.113.9')).toBe('203.0.113.9')
    expect(clientIpFromForwardedFor('')).toBe('')
    expect(clientIpFromForwardedFor(undefined)).toBe('')
    expect(clientIpFromForwardedFor(' , ')).toBe('')
  })

  it('格數（給 /api/warmup 驗「CloudFront 之後有沒有再多一跳」）：空格不算', () => {
    expect(forwardedForHops('203.0.113.9')).toHaveLength(1)
    expect(forwardedForHops('1.1.1.1, 203.0.113.9')).toHaveLength(2)
    expect(forwardedForHops(' , ')).toHaveLength(0)
    expect(forwardedForHops(undefined)).toHaveLength(0)
  })
})

describe('rateLimitClientIp', () => {
  const ev = (headers: Record<string, string>, remoteAddress?: string) =>
    ({ node: { req: { headers, socket: { remoteAddress } } } }) as never

  it('有標頭用標頭最右邊；沒有就用連線位址；都沒有回 unknown（⛔ 不回空字串）', () => {
    expect(rateLimitClientIp(ev({ 'x-forwarded-for': 'spoof, 203.0.113.9' }, '10.0.0.1'))).toBe('203.0.113.9')
    expect(rateLimitClientIp(ev({}, '127.0.0.1'))).toBe('127.0.0.1')
    expect(rateLimitClientIp(ev({}))).toBe('unknown')
  })
})
