import { describe, it, expect } from 'vitest'
import { parseRobots, isDisallowed } from './ai-site-discovery'

describe('parseRobots', () => {
  it('收集 Sitemap 宣告與 User-agent:* 的 Disallow', () => {
    const txt = [
      'User-agent: Googlebot',
      'Disallow: /google-only/',
      '',
      'User-agent: *',
      'Disallow: /admin/',
      'Disallow: /cart',
      'Allow: /admin/public', // Allow 不支援(簡化實作),忽略
      '',
      'Sitemap: https://example.com/sitemap.xml',
      'Sitemap: https://example.com/sitemap-products.xml',
    ].join('\n')
    const r = parseRobots(txt)
    expect(r.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap-products.xml',
    ])
    // 只收 * 區段的規則,Googlebot 專屬的不算
    expect(r.disallows).toEqual(['/admin/', '/cart'])
  })

  it('空 Disallow(允許全部)與註解行忽略', () => {
    const r = parseRobots('User-agent: *\nDisallow:\n# comment\nDisallow: /x # inline comment')
    expect(r.disallows).toEqual(['/x'])
  })

  it('大小寫不敏感的欄位名', () => {
    const r = parseRobots('user-AGENT: *\nDISALLOW: /a\nsitemap: https://e.com/s.xml')
    expect(r.disallows).toEqual(['/a'])
    expect(r.sitemaps).toEqual(['https://e.com/s.xml'])
  })
})

describe('isDisallowed', () => {
  it('前綴比對', () => {
    expect(isDisallowed('/admin/settings', ['/admin/'])).toBe(true)
    expect(isDisallowed('/administrator', ['/admin/'])).toBe(false)
    expect(isDisallowed('/products/a', ['/admin/'])).toBe(false)
  })

  it('支援 * 萬用字元與 $ 結尾', () => {
    expect(isDisallowed('/a/x/checkout', ['/a/*/checkout'])).toBe(true)
    expect(isDisallowed('/a/checkout/more', ['/a/*/checkout$'])).toBe(false)
    expect(isDisallowed('/page.pdf', ['/*.pdf$'])).toBe(true)
  })

  it('空規則清單一律允許', () => {
    expect(isDisallowed('/anything', [])).toBe(false)
  })
})
