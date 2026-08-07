import { describe, expect, it } from 'vitest'
import { parseLeadClaimFromQuery, parsePublishedCtaUrl } from './liff-lead-query'

describe('parseLeadClaimFromQuery', () => {
  it('reads claimToken and c from top-level query', () => {
    const q = { claimToken: 'tok-1', c: 'c_abc', liffId: '2009-abc' }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok-1', campaignCode: 'c_abc', liffId: '2009-abc' })
  })

  it('parses ct and c from liff.state when top-level missing', () => {
    const encoded = encodeURIComponent('?claimToken=tok-2&c=c_def&liffId=2009-def')
    const q = { 'liff.state': encoded }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok-2', campaignCode: 'c_def', liffId: '2009-def' })
  })

  it('parses ct and c from liff.state full path format', () => {
    const encoded = encodeURIComponent('/liff/lead?ct=tok-path&c=c_path&liffId=2009-path')
    const q = { 'liff.state': encoded }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok-path', campaignCode: 'c_path', liffId: '2009-path' })
  })

  it('parses ct and c from liff.state full URL format', () => {
    const encoded = encodeURIComponent('https://main.example.com/liff/lead?ct=tok-url&c=c_url&liffId=2009-url')
    const q = { 'liff.state': encoded }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok-url', campaignCode: 'c_url', liffId: '2009-url' })
  })

  it('top-level wins over liff.state when both present', () => {
    const q = { claimToken: 'a', c: 'b', liffId: 'top-id', 'liff.state': encodeURIComponent('?claimToken=x&c=y&liffId=state-id') }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'a', campaignCode: 'b', liffId: 'top-id' })
  })

  it('reads liffId from liff.referrer when missing in query', () => {
    const q = { claimToken: 'tok', c: 'code', 'liff.referrer': 'https://liff.line.me/2009545365-qwUyrRb6' }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok', campaignCode: 'code', liffId: '2009545365-qwUyrRb6' })
  })

  it('supports legacy ct key for backward compatibility', () => {
    const q = { ct: 'legacy', c: 'legacy_code', liffId: 'legacy-id' }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'legacy', campaignCode: 'legacy_code', liffId: 'legacy-id' })
  })

  // LINE 外部瀏覽器登入後的 callback：原本的 claimToken/liffId 都不在網址上了，
  // 只剩 code/state/liffClientId 與 liffRedirectUri（登入前的完整網址）。
  it('recovers params from liffRedirectUri on a LINE login callback', () => {
    const q = {
      code: 'oauth-code',
      state: 'oauth-state',
      liffClientId: '2009545365',
      liffRedirectUri: 'https://app.example.com/liff/lead?claimToken=tok-r&c=c_r&liffId=2009545365-qwUyrRb6',
      liffIsEnabledTrustedDomain: 'true',
    }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok-r', campaignCode: 'c_r', liffId: '2009545365-qwUyrRb6' })
  })

  it('decodes a still-encoded liffRedirectUri', () => {
    const q = { liffRedirectUri: 'https%3A%2F%2Fapp.example.com%2Fliff%2Flead%3FclaimToken%3Dtok-e%26c%3Dc_e%26liffId%3D2009-e' }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok-e', campaignCode: 'c_e', liffId: '2009-e' })
  })

  it('follows liff.state nested inside liffRedirectUri', () => {
    const inner = encodeURIComponent('?claimToken=tok-rn&c=c_rn&liffId=2009-rn')
    const q = { liffRedirectUri: `https://liff.line.me/2009-rn?liff.state=${inner}` }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'tok-rn', campaignCode: 'c_rn', liffId: '2009-rn' })
  })

  it('top-level wins over liffRedirectUri', () => {
    const q = {
      claimToken: 'top-tok',
      c: 'top_code',
      liffId: 'top-id',
      liffRedirectUri: 'https://app.example.com/liff/lead?claimToken=other&c=other_code&liffId=other-id',
    }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'top-tok', campaignCode: 'top_code', liffId: 'top-id' })
  })

  it('ignores a malformed liffRedirectUri without losing other params', () => {
    const q = { liffId: '2009-keep', liffRedirectUri: 'not a url at all %%%' }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: '', campaignCode: '', liffId: '2009-keep' })
  })

  it('parses nested liff.state wrapping another liff.state', () => {
    const inner = encodeURIComponent('/liff/lead?claimToken=nested-token&c=c_nested&liffId=2009-nested')
    const outer = `?liff.state=${inner}`
    const q = { 'liff.state': outer }
    expect(parseLeadClaimFromQuery(q)).toEqual({ ct: 'nested-token', campaignCode: 'c_nested', liffId: '2009-nested' })
  })
})

describe('parsePublishedCtaUrl', () => {
  it('reads claimToken from direct app base URL', () => {
    const url = 'https://app.example.com/liff/lead?claimToken=stable-tok&c=launch_q1&liffId=2009-abc'
    expect(parsePublishedCtaUrl(url)).toEqual({
      ct: 'stable-tok',
      campaignCode: 'launch_q1',
      liffId: '2009-abc',
    })
  })

  it('reads claimToken from liff.line.me URL via liff.state', () => {
    const stateParams = encodeURIComponent('?claimToken=stable-tok-2&c=launch_q2&liffId=2009-def')
    const url = `https://liff.line.me/2009-def?liff.state=${stateParams}`
    expect(parsePublishedCtaUrl(url)).toEqual({
      ct: 'stable-tok-2',
      campaignCode: 'launch_q2',
      liffId: '2009-def',
    })
  })
})
