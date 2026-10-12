/**
 * 「整個網站一起加入」那份清單的兩件事（`D-124` 新手走查，2026-10-12）：
 *
 * ① 分組用白話：以前分組寫成網址第一段（「/products 64 頁｜/blogs 48 頁」），新手看不懂那是什麼。
 *    常見的幾種照意思歸成「商品／分類／文章／說明頁」，認不出來的照舊用那一段（去掉斜線）。
 * ② 先幫他勾好最常被問的頁：以前上百頁一頁都沒勾，他不知道該勾哪些。
 *    先勾「說明頁」（運送、退換貨、常見問題、聯絡、關於、保固、付款、門市）、再補商品頁，
 *    總數照空間算——每頁大約會整理成 5 條（正式庫 2026-10-12 網頁中位數），勾到放得下為止。
 *    ⛔ 不勾隱私權、服務條款、購物車、登入這類：客人不會問、只是把空間用掉。
 *
 * 判斷抽成純函式是為了測得到：規則錯了的後果是「幫他勾了一堆沒用的頁、空間被吃光」，畫面上看不出來。
 */

export interface SitePageLike {
  url: string
  title: string
}

/** 網址第一段 → 白話分組名 */
const GROUP_LABEL: Array<[RegExp, string]> = [
  [/^(?:products?|items?|goods|shop|store-products|p)$/i, '商品'],
  [/^(?:collections?|categor(?:y|ies)|catalog|tags?)$/i, '分類'],
  [/^(?:blogs?|news|posts?|articles?|journal|stories|magazine)$/i, '文章'],
  [/^(?:pages?|policies|policy|help|faq|support|about|contact|info|service)$/i, '說明頁'],
]

export function sitePageGroup(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[0] ?? ''
    if (!seg) return '首頁'
    const hit = GROUP_LABEL.find(([re]) => re.test(seg))
    return hit ? hit[1] : decodeURIComponent(seg)
  }
  catch {
    return '其他'
  }
}

/** 客人最常問的說明頁：網址或標題有這些字 */
const INFO_RE = /shipping|delivery|return|refund|exchange|faq|contact|about|warranty|payment|store-?locat|運送|運費|配送|物流|退換|退貨|退款|換貨|常見問題|問與答|Q&A|聯絡|客服|關於|保固|維修|付款|門市|營業時間/i
/** 客人不會問、只會用掉空間的頁 */
const SKIP_RE = /privacy|terms|cookie|cart|checkout|account|login|signin|register|search|隱私|條款|購物車|結帳|會員登入/i

/** 一頁大約整理成幾條（正式庫 2026-10-12 網頁來源中位數 5，24 份） */
export const CARDS_PER_PAGE_ESTIMATE = 5

/**
 * 先幫他勾哪幾頁（回網址）。
 * @param room 知識空間還能放幾條；null＝不限或讀不到（只照 maxPages）
 * @param maxPages 一次最多幾頁（整站一次上限）
 */
export function recommendSitePages(pages: Array<SitePageLike & { imported?: boolean }>, opts: { room: number | null, maxPages: number }): string[] {
  const candidates = pages.filter(p => !p.imported && !SKIP_RE.test(`${p.url} ${p.title}`))
  const info = candidates.filter(p => INFO_RE.test(`${p.url} ${p.title}`) || sitePageGroup(p.url) === '說明頁')
  const products = candidates.filter(p => !info.includes(p) && sitePageGroup(p.url) === '商品')
  const byRoom = opts.room == null ? Number.POSITIVE_INFINITY : Math.floor(opts.room / CARDS_PER_PAGE_ESTIMATE)
  // 預設最多勾 20 頁：每頁都要花一次 AI 整理，全勾 50 頁對第一次用的人太多（要更多他可以自己再勾）
  const cap = Math.max(0, Math.min(opts.maxPages, 20, byRoom))
  return [...info, ...products].slice(0, cap).map(p => p.url)
}
