/**
 * 整站匯入的「頁面探索」：輸入一個網址 → 找出同網域可匯入的頁面清單,
 * 讓使用者勾選後逐頁匯入(每頁一來源,走既有 preview-job 流程)。
 *
 * 探索策略(業界做法:給首頁就能爬整站):
 *   1. robots.txt:收集 Sitemap: 宣告 + User-agent:* 的 Disallow 規則(尊重,前綴比對)。
 *   2. sitemap.xml(robots 宣告的 + /sitemap.xml 慣例位置):抽 <loc>;
 *      sitemap index 往下走一層(取前幾個子 sitemap)。
 *   3. sitemap 沒有 → 備援:抓輸入頁本身,收集同網域 <a href>(錨文字當頁面標題)。
 *
 * 只探索、不渲染 JS(沿用紅線)——動態首頁抓不到商品,但 sitemap 與商品內頁多半是靜態的,
 * 這正是整站匯入能繞開動態首頁問題的原因。通用實作,不綁任何站台。
 */
import { resolveInternalUrl } from './ai-source-extractors'
import { fetchPublicText } from './safe-fetch'

export interface DiscoveredPage {
  url: string
  /** sitemap 來源沒有標題(空字串);連結備援用錨文字 */
  title: string
}

export interface SiteDiscoveryResult {
  pages: DiscoveredPage[]
  from: 'sitemap' | 'links'
  /** 頁數超過上限被截斷 */
  truncated: boolean
}

/** 單次探索最多回傳幾頁(勾選清單的可用性上限;要更多請分次) */
export const MAX_DISCOVERED_PAGES = 100
/** sitemap index 最多往下抓幾個子 sitemap */
const MAX_CHILD_SITEMAPS = 5
const FETCH_TIMEOUT_MS = 10_000
/** 明顯非 HTML 頁面的副檔名(抓了也會被 extractUrlText 拒絕) */
const BINARY_EXT_RE = /\.(?:jpe?g|png|gif|webp|svg|ico|css|js|json|xml|pdf|zip|mp4|mp3|woff2?)(?:$|\?)/i

async function fetchPage(url: string): Promise<{ text: string; finalUrl: string } | null> {
  try {
    // safe-fetch（C-49A）：整站探索是「把一個站的連結圖攤開」的功能，
    // 不擋私有網段的話正好變成內網掃描器；大小上限防超大回應打爆記憶體。
    const res = await fetchPublicText(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'LineBotKnowledgeFetcher/1.0' },
    })
    if (!res.ok) return null
    return { text: res.text, finalUrl: res.finalUrl }
  }
  catch {
    return null
  }
}

async function fetchText(url: string): Promise<string | null> {
  return (await fetchPage(url))?.text ?? null
}

/**
 * 剝掉導覽 / 頁首 / 頁尾 / 側欄再找連結。不剝的話,有大型選單與頁尾網站地圖的站
 * 會在讀到 <main> 的商品連結之前就把 100 頁配額用光,使用者只看到一堆導覽頁。
 * (同 stripHtml 的處理,這裡只需要剝區塊、不需要轉純文字。)
 */
function stripBoilerplateBlocks(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

/** robots.txt 解析:User-agent:* 區段的 Disallow 前綴 + Sitemap 宣告。抓不到 = 全允許。 */
export function parseRobots(robotsTxt: string): { disallows: string[]; sitemaps: string[] } {
  const disallows: string[] = []
  const sitemaps: string[] = []
  let inStarGroup = false
  for (const rawLine of robotsTxt.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim()
    if (key === 'sitemap' && value) {
      sitemaps.push(value)
    }
    else if (key === 'user-agent') {
      inStarGroup = value === '*'
    }
    else if (key === 'disallow' && inStarGroup && value) {
      disallows.push(value)
    }
  }
  return { disallows, sitemaps }
}

/** 是否被 robots Disallow(前綴比對,支援結尾 $ 與中間 * 的簡化萬用字元) */
export function isDisallowed(pathname: string, disallows: string[]): boolean {
  return disallows.some((rule) => {
    if (!rule) return false
    if (!rule.includes('*') && !rule.endsWith('$')) return pathname.startsWith(rule)
    const pattern = rule
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$')
    try {
      return new RegExp(`^${pattern}`).test(pathname)
    }
    catch {
      return pathname.startsWith(rule.replace(/[*$]/g, ''))
    }
  })
}

/** 從 sitemap XML 抽 <loc>;回傳 { pageUrls, childSitemaps }(sitemap index 的 loc 指向子 sitemap) */
function parseSitemapLocs(xml: string): { pageUrls: string[]; childSitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1]!.trim())
  const isIndex = /<sitemapindex[\s>]/i.test(xml)
  return isIndex ? { pageUrls: [], childSitemaps: locs } : { pageUrls: locs, childSitemaps: [] }
}

/** 頁面 URL 正規化:去 fragment、去尾斜線差異(dedupe 用 key,保留原始 href 匯入) */
function pageKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href.replace(/\/$/, '')
  }
  catch {
    return url
  }
}

export async function discoverSitePages(inputUrl: string): Promise<SiteDiscoveryResult> {
  // 先抓輸入頁,用**跟完轉址後**的網址當基準:apex → www 這種再普通不過的 301,
  // 若拿原始網址當 origin,sitemap 裡的 www 連結會被 resolveInternalUrl 全數判為跨域丟掉
  // (使用者在 500 頁的站上只會看到 1 頁)。順便把 HTML 留著給連結備援用,不必再抓一次。
  const seed = await fetchPage(inputUrl)
  const start = new URL(seed?.finalUrl || inputUrl)
  const origin = start.origin

  // 1. robots.txt(抓不到 = 沒限制、沒 sitemap 宣告)
  const robotsTxt = await fetchText(`${origin}/robots.txt`)
  const robots = robotsTxt ? parseRobots(robotsTxt) : { disallows: [], sitemaps: [] }

  const seen = new Set<string>()
  const pages: DiscoveredPage[] = []
  const push = (url: string, title = ''): boolean => {
    const resolved = resolveInternalUrl(url, origin)
    if (!resolved || BINARY_EXT_RE.test(resolved)) return true
    let pathname = '/'
    try {
      pathname = new URL(resolved).pathname
    }
    catch { /* resolveInternalUrl 已驗證過,不會到這 */ }
    if (isDisallowed(pathname, robots.disallows)) return true
    const key = pageKey(resolved)
    if (seen.has(key)) return true
    seen.add(key)
    pages.push({ url: resolved, title: title.slice(0, 120) })
    return pages.length < MAX_DISCOVERED_PAGES
  }

  // 輸入的網址永遠排第一(使用者明確要的那頁)
  push(start.href)

  // 2. sitemap:robots 宣告的優先,再試慣例位置 /sitemap.xml
  const sitemapUrls = [...new Set([...robots.sitemaps, `${origin}/sitemap.xml`])]
    .map(u => resolveInternalUrl(u, origin))
    .filter((u): u is string => !!u)
  let usedSitemap = false
  for (const sitemapUrl of sitemapUrls) {
    const xml = await fetchText(sitemapUrl)
    if (!xml || !/<(urlset|sitemapindex)[\s>]/i.test(xml)) continue
    const { pageUrls, childSitemaps } = parseSitemapLocs(xml)
    let locs = pageUrls
    if (!locs.length && childSitemaps.length) {
      // sitemap index:往下一層,取前幾個子 sitemap(通常按重要性排)
      const children = await Promise.all(
        childSitemaps.slice(0, MAX_CHILD_SITEMAPS).map(u => fetchText(u)),
      )
      locs = children.filter((x): x is string => !!x).flatMap(x => parseSitemapLocs(x).pageUrls)
    }
    if (locs.length) {
      usedSitemap = true
      for (const loc of locs) {
        if (!push(loc)) break
      }
    }
    if (usedSitemap) break // 第一個有效 sitemap 就夠;多個 sitemap 內容通常重疊
  }
  if (usedSitemap) {
    return { pages, from: 'sitemap', truncated: pages.length >= MAX_DISCOVERED_PAGES }
  }

  // 3. 備援:用輸入頁的 HTML(建 origin 時已抓過)收集同網域連結,錨文字當標題
  if (seed?.text) {
    const body = stripBoilerplateBlocks(seed.text)
    for (const m of body.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = m[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!push(m[1]!, label)) break
    }
  }
  return { pages, from: 'links', truncated: pages.length >= MAX_DISCOVERED_PAGES }
}
