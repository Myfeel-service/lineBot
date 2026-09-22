import { describe, expect, it } from 'vitest'
import {
  aiGuessableFields,
  buildExtractPrompt,
  classifyFetchError,
  MAX_PROFILE_PROMPT_CHARS,
  rankProfilePages,
} from './store-profile-extract'

/** `stripHtml` 產出的樣子：站內連結寫成「錨文字（絕對網址）」 */
function linkText(pairs: [string, string][]): string {
  return pairs.map(([label, url]) => `${label}（${url}）`).join('\n')
}

describe('rankProfilePages', () => {
  const base = 'https://shop.example.tw/'

  it('商品頁排在文章前面', () => {
    const text = linkText([
      ['最新消息', 'https://shop.example.tw/blog/2026-summer'],
      ['全部商品', 'https://shop.example.tw/products'],
    ])
    const r = rankProfilePages(text, base)
    expect(r[0]?.url).toContain('/products')
  })

  it('⛔ 隱私權、購物車、登入頁一律不挑（讀了也幫不上輪廓，還很佔字數）', () => {
    const text = linkText([
      ['隱私權政策', 'https://shop.example.tw/privacy'],
      ['購物車', 'https://shop.example.tw/cart'],
      ['會員登入', 'https://shop.example.tw/member/login'],
      ['服務條款', 'https://shop.example.tw/terms'],
    ])
    expect(rankProfilePages(text, base)).toEqual([])
  })

  it('跨網域連結一律丟掉（只讀商家自己的站）', () => {
    const text = linkText([
      ['我們的 FB', 'https://facebook.com/shop/products'],
      ['商品', 'https://shop.example.tw/products'],
    ])
    const r = rankProfilePages(text, base)
    expect(r).toHaveLength(1)
    expect(r[0]?.url).toContain('shop.example.tw')
  })

  it('同一頁的不同網址只算一次（尾斜線／查詢字串）', () => {
    const text = linkText([
      ['商品', 'https://shop.example.tw/products'],
      ['商品2', 'https://shop.example.tw/products/'],
      ['商品3', 'https://shop.example.tw/products?page=2'],
    ])
    expect(rankProfilePages(text, base)).toHaveLength(1)
  })

  it('首頁自己不會被挑進來', () => {
    const text = linkText([
      ['回首頁', 'https://shop.example.tw/'],
      ['關於我們', 'https://shop.example.tw/about'],
    ])
    const r = rankProfilePages(text, base)
    expect(r).toHaveLength(1)
    expect(r[0]?.url).toContain('/about')
  })

  it('最多挑指定的頁數', () => {
    const text = linkText([
      ['商品', 'https://shop.example.tw/products'],
      ['關於', 'https://shop.example.tw/about'],
      ['常見問題', 'https://shop.example.tw/faq'],
      ['價格', 'https://shop.example.tw/pricing'],
      ['課程', 'https://shop.example.tw/service'],
      ['配送', 'https://shop.example.tw/shipping'],
    ])
    expect(rankProfilePages(text, base, 4)).toHaveLength(4)
  })

  it('沒有任何連結時回空陣列，不炸', () => {
    expect(rankProfilePages('這頁只有文字沒有連結', base)).toEqual([])
    expect(rankProfilePages('', base)).toEqual([])
  })

  it('base 是壞網址時回空陣列', () => {
    expect(rankProfilePages(linkText([['商品', 'https://a.tw/products']]), '不是網址')).toEqual([])
  })

  it('中文路徑也認得（decode 之後比對）', () => {
    const text = linkText([['商品', `https://shop.example.tw/${encodeURIComponent('商品列表')}`]])
    const r = rankProfilePages(text, base)
    expect(r).toHaveLength(1)
  })
})

describe('classifyFetchError', () => {
  it('403 當成被擋，不當成不存在', () => {
    expect(classifyFetchError({ statusMessage: '網址回應 403：請確認連結公開可訪問' })).toBe('blocked')
  })
  it('404 當成網址打不開', () => {
    expect(classifyFetchError({ statusMessage: '網址回應 404：請確認連結公開可訪問' })).toBe('not_found')
  })
  it('⛔ PDF 之類的非網頁要跟「動態網站」分開（兩者的下一步不同）', () => {
    // 踩到會怎樣：貼了 PDF 網址的人被告知「多半是要跑程式才長得出內容的網站，請改貼商品頁」，
    // 但正解是「PDF 直接上傳知識庫」。2026-09-22 端到端實測當場抓到。
    expect(classifyFetchError({ statusMessage: '不支援的內容類型：application/pdf（請改用上傳檔案）' })).toBe('not_html')
  })
  it('抓取失敗當成連不上', () => {
    expect(classifyFetchError({ statusCode: 502, statusMessage: '網址抓取失敗：fetch failed' })).toBe('network')
  })
  it('認不出來的回 unknown，不硬塞一個像樣的原因', () => {
    expect(classifyFetchError(new Error('???'))).toBe('unknown')
    expect(classifyFetchError(undefined)).toBe('unknown')
  })
})

describe('buildExtractPrompt', () => {
  const pages = [
    { url: 'https://shop.example.tw/', text: '我們賣黑豆水與養生茶包，價格 NT$180 起。' },
    { url: 'https://shop.example.tw/about', text: '創立於 2015 年，堅持天然無添加。' },
  ]

  it('每一頁都標得出網址（模型才知道哪句話來自哪一頁）', () => {
    const p = buildExtractPrompt(pages)
    expect(p).toContain('https://shop.example.tw/about')
    expect(p).toContain('養生茶包')
  })

  it('要填的欄位就是欄位表裡標了可猜的那幾格', () => {
    const p = buildExtractPrompt(pages)
    for (const f of aiGuessableFields()) expect(p, f.id).toContain(`"${f.id}"`)
    // 旺季與最想解決是商家自己答的，不可以讓模型猜
    expect(p).not.toContain('"season"')
    expect(p).not.toContain('"pain"')
  })

  it('⛔ prompt 一定要寫「沒提到就回空字串」（不然競爭對手那格會長出假名字）', () => {
    expect(buildExtractPrompt(pages)).toContain('沒提到的就回空字串')
  })

  it('內容超長時整體截到上限（不會把 token 燒爆）', () => {
    const huge = [{ url: 'https://a.tw/', text: 'あ'.repeat(200_000) }]
    expect(buildExtractPrompt(huge).length).toBeLessThan(MAX_PROFILE_PROMPT_CHARS + 2000)
  })

  it('後面的頁被字數上限擠掉時，不會留下半截標題', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ url: `https://a.tw/p${i}`, text: 'x'.repeat(8000) }))
    const p = buildExtractPrompt(many)
    // 每個出現的頁面標題後面一定接得到內容
    const headers = p.match(/--- 頁面：\S+ ---/g) ?? []
    for (const h of headers) {
      const idx = p.indexOf(h) + h.length
      expect(p.slice(idx, idx + 5).trim().length).toBeGreaterThan(0)
    }
  })

  it('沒有頁面時 prompt 仍然是合法的字串（呼叫端會先擋，但不該炸）', () => {
    expect(typeof buildExtractPrompt([])).toBe('string')
  })
})
