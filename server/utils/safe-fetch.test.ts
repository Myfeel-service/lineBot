/**
 * C-49A SSRF 守門的網段判定。挑「錯了會出事」的案例釘住:
 * 雲端中繼資料(169.254.169.254)、內網段、v4-mapped v6 繞法、CGNAT。
 */
import { describe, expect, it } from 'vitest'

;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

import { isBlockedHostname, isPrivateAddress } from './safe-fetch'

describe('isPrivateAddress', () => {
  it('雲端中繼資料與內網段全擋', () => {
    for (const ip of ['169.254.169.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '0.0.0.0', '100.64.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })
  it('公網位址放行', () => {
    for (const ip of ['104.18.32.7', '172.15.0.1', '172.32.0.1', '8.8.8.8', '100.63.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
  it('IPv6:回環/ULA/link-local/v4-mapped 繞法全擋', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd12:3456::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true) // v4-mapped 是典型繞法
    expect(isPrivateAddress('2404:6800:4004::1')).toBe(false)
  })
  it('壞輸入一律當私有(寧可誤擋)', () => {
    expect(isPrivateAddress('')).toBe(true)
    expect(isPrivateAddress('999.1.1.1')).toBe(true)
  })
})

describe('isBlockedHostname', () => {
  it('localhost 家族與 GCP 中繼資料主機名', () => {
    expect(isBlockedHostname('localhost')).toBe(true)
    expect(isBlockedHostname('foo.localhost')).toBe(true)
    expect(isBlockedHostname('metadata.google.internal')).toBe(true)
    expect(isBlockedHostname('127.0.0.1')).toBe(true)
    expect(isBlockedHostname('www.myfeel-tw.com')).toBe(false)
  })
})
