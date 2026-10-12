import { describe, expect, it } from 'vitest'
import { recommendSitePages, sitePageGroup } from './kb-site-pages'

const page = (path: string, title = '') => ({ url: `https://shop.example.tw${path}`, title })

describe('sitePageGroup（分組用白話，D-124）', () => {
  it('常見的網址第一段照意思歸類', () => {
    expect(sitePageGroup('https://a.tw/products/1')).toBe('商品')
    expect(sitePageGroup('https://a.tw/collections/new')).toBe('分類')
    expect(sitePageGroup('https://a.tw/blogs/news/1')).toBe('文章')
    expect(sitePageGroup('https://a.tw/pages/shipping')).toBe('說明頁')
    expect(sitePageGroup('https://a.tw/policies/refund-policy')).toBe('說明頁')
    expect(sitePageGroup('https://a.tw/')).toBe('首頁')
  })

  it('認不出來的照舊用那一段（不亂猜）', () => {
    expect(sitePageGroup('https://a.tw/media/123')).toBe('media')
  })
})

describe('recommendSitePages（先幫他勾好常被問的頁，D-124）', () => {
  const pages = [
    page('/', '首頁'),
    page('/pages/shipping', '運送與退換貨'),
    page('/pages/faq', '常見問題'),
    page('/policies/privacy-policy', '隱私權政策'),
    page('/cart', '購物車'),
    ...Array.from({ length: 30 }, (_, i) => page(`/products/${i}`, `商品 ${i}`)),
    ...Array.from({ length: 10 }, (_, i) => page(`/blogs/news/${i}`, `文章 ${i}`)),
  ]

  it('說明頁排最前、再補商品頁；不勾隱私權、購物車、文章', () => {
    const picked = recommendSitePages(pages, { room: null, maxPages: 50 })
    expect(picked.slice(0, 2)).toEqual([page('/pages/shipping').url, page('/pages/faq').url])
    expect(picked.some(u => u.includes('privacy') || u.includes('/cart') || u.includes('/blogs/'))).toBe(false)
    expect(picked.filter(u => u.includes('/products/')).length).toBe(18) // 預設最多 20 頁
  })

  it('照空間勾到放得下為止（一頁約 5 條）：免費方案剩 50 條 → 最多 10 頁', () => {
    expect(recommendSitePages(pages, { room: 50, maxPages: 50 })).toHaveLength(10)
    expect(recommendSitePages(pages, { room: 4, maxPages: 50 })).toHaveLength(0)
  })

  it('⛔ 商品名剛好含 cookie／cart／contact 這種字 → 照樣是商品、照樣勾（2026-10-13 /code-review：以前是子字串比對）', () => {
    const shop = [
      page('/products/chocolate-chip-cookie', '巧克力豆餅乾'),
      page('/products/filter-cartridge', '濾心'),
      page('/products/contact-lens-case', '隱形眼鏡盒'),
      page('/products/cart-organizer', '購物車收納架'),
      page('/policies/cookie-policy', 'Cookie 政策'),
      page('/research/2026', '研究報告'),
    ]
    const picked = recommendSitePages(shop, { room: null, maxPages: 50 })
    expect(picked).toEqual([
      page('/products/chocolate-chip-cookie').url,
      page('/products/filter-cartridge').url,
      page('/products/contact-lens-case').url,
      page('/products/cart-organizer').url,
    ])
  })

  it('不是商品的頁：網址裡整個字是 contact／shipping 才算說明頁（about-time 這種不算）', () => {
    const misc = [page('/contact', '聯絡我們'), page('/blogs/news/about-time-management', '時間管理')]
    expect(recommendSitePages(misc, { room: null, maxPages: 50 })).toEqual([page('/contact').url])
  })

  it('以前加過的頁不勾', () => {
    const withImported = [{ ...page('/pages/shipping', '運送'), imported: true }, page('/pages/faq', '常見問題')]
    expect(recommendSitePages(withImported, { room: null, maxPages: 50 })).toEqual([page('/pages/faq').url])
  })
})
