import { describe, expect, it, vi } from 'vitest'
import { fetchLineAvatarDataUrl, isAllowedAvatarUrl } from './line-avatar-data-url'

function fakeRes(body: Uint8Array, init: { status?: number, type?: string, length?: number } = {}) {
  const headers = new Headers()
  if (init.type !== undefined) headers.set('content-type', init.type)
  if (init.length !== undefined) headers.set('content-length', String(init.length))
  return new Response(new Uint8Array(body).buffer as ArrayBuffer, { status: init.status ?? 200, headers })
}

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])

describe('isAllowedAvatarUrl（⛔ 只抓 LINE 的圖片網域）', () => {
  it('LINE 頭像網址放行', () => {
    expect(isAllowedAvatarUrl('https://profile.line-scdn.net/0hAbCdEf')).toBe(true)
    expect(isAllowedAvatarUrl('https://sprofile.line-scdn.net/0hAbCdEf/large')).toBe(true)
  })
  it('別的網域、http、帶帳密或埠號、長得像的網域一律擋', () => {
    expect(isAllowedAvatarUrl('http://profile.line-scdn.net/x')).toBe(false)
    expect(isAllowedAvatarUrl('https://169.254.169.254/latest/meta-data')).toBe(false)
    expect(isAllowedAvatarUrl('https://evil-line-scdn.net/x')).toBe(false)
    expect(isAllowedAvatarUrl('https://line-scdn.net.evil.com/x')).toBe(false)
    expect(isAllowedAvatarUrl('https://a:b@profile.line-scdn.net/x')).toBe(false)
    expect(isAllowedAvatarUrl('https://profile.line-scdn.net:8443/x')).toBe(false)
    expect(isAllowedAvatarUrl('not a url')).toBe(false)
  })
})

describe('fetchLineAvatarDataUrl', () => {
  it('抓到圖片 → data URL（型別照回應）', async () => {
    const fetchImpl = vi.fn(async () => fakeRes(PNG, { type: 'image/png' })) as unknown as typeof fetch
    const out = await fetchLineAvatarDataUrl('https://profile.line-scdn.net/abc', { fetchImpl })
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    // ⛔ 不跟轉址
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })
  })

  it('不在白名單的網址連打都不打', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    expect(await fetchLineAvatarDataUrl('https://example.com/a.png', { fetchImpl })).toBe('')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('不是圖片、狀態碼不對、太大、空的、丟錯 → 一律空字串（⛔ 不擋整張卡）', async () => {
    const url = 'https://profile.line-scdn.net/abc'
    const run = (res: () => Promise<Response>) => fetchLineAvatarDataUrl(url, { fetchImpl: res as unknown as typeof fetch, maxBytes: 5 })
    expect(await run(async () => fakeRes(PNG, { type: 'text/html' }))).toBe('')
    expect(await run(async () => fakeRes(PNG, { type: 'image/png', status: 302 }))).toBe('')
    expect(await run(async () => fakeRes(PNG, { type: 'image/png' }))).toBe('') // 7 bytes > 5
    expect(await run(async () => fakeRes(new Uint8Array([1]), { type: 'image/png', length: 99 }))).toBe('')
    expect(await run(async () => fakeRes(new Uint8Array([]), { type: 'image/png' }))).toBe('')
    expect(await run(async () => { throw new Error('timeout') })).toBe('')
  })

  it('有 X 的對照組：大小剛好在上限內照樣成功', async () => {
    const out = await fetchLineAvatarDataUrl('https://profile.line-scdn.net/abc', {
      fetchImpl: (async () => fakeRes(new Uint8Array([1, 2, 3, 4, 5]), { type: 'image/jpeg; charset=binary' })) as unknown as typeof fetch,
      maxBytes: 5,
    })
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true)
  })
})
