/**
 * 讀商家給的網址、猜出店家輪廓（`D-85` / `C-220`）。
 *
 * ── 這支存在的理由 ─────────────────────────────────────────────
 * 精靈只問五題，剩下四項（語氣、常見問題、競爭對手、以及五題的補強）要靠讀網站。
 * 沒有這支，揭曉時那句「順便，我讀完你的網站了」就是一句假話。
 *
 * ── 三條紅線 ───────────────────────────────────────────────────
 * ① **讀不到要講得出來**：回傳的 `siteRead` 分 ok／partial／failed 三態，
 *    失敗的頁要點名網址與原因。⛔ 不可以回一個「成功但內容是空的」
 *    （[[feedback_filters_must_report_what_they_dropped]]：沉默死亡已六發）。
 * ② **不做網頁渲染、不破解反爬**：沿用 `extractUrlText`（safe-fetch）。
 *    動態網站抓不到內容是**預期內的結果**，要回 `empty` 讓人改貼商品頁，不是想辦法繞過去。
 * ③ **沒提到就回空字串**：prompt 明寫不准用產業常識腦補。競爭對手這種欄位
 *    一旦讓模型自由發揮，會長出商家從來沒聽過的名字，而畫面上標的是「AI 推測」——
 *    人會以為我們真的查到了。
 */

import { extractUrlText, resolveInternalUrl } from '~~/server/utils/ai-source-extractors'
import { generateJson } from '~~/server/utils/gemini'
import {
  STORE_PROFILE_FIELDS,
  type SiteReadFailReason,
  type StoreProfileFieldId,
} from '~~/shared/types/store-profile'

/** 一次最多讀幾頁。首頁 1 頁＋站內挑 4 頁——再多就是花錢買雜訊。 */
export const MAX_PROFILE_PAGES = 5
/** 送進 LLM 的總字數上限（約 3 萬 token 以內，flash 綽綽有餘） */
export const MAX_PROFILE_PROMPT_CHARS = 24_000
/** 每頁最多取幾字（免得首頁一頁就把配額吃光，其他頁等於沒讀） */
const MAX_CHARS_PER_PAGE = 8_000
/** 少於這個字數視為「這頁沒有內容」（多半是要跑 JS 才長得出來的網站） */
const MIN_USEFUL_CHARS = 120

// ── 挑頁（純函式，可測）────────────────────────────────────────

/**
 * 站內連結的評分規則。**跨產業通用**，⛔ 不可以寫任何特定客戶的字眼
 * （[[feedback_saas_no_tenant_hardcoding]]）。
 */
const PAGE_SCORE_RULES: readonly { re: RegExp, score: number }[] = [
  { re: /product|goods|item|shop|store|collection|商品|產品|購物|商城/i, score: 4 },
  { re: /about|story|brand|profile|關於|品牌|理念|簡介/i, score: 3 },
  { re: /faq|question|qa|常見問題|問與答|問答/i, score: 3 },
  { re: /price|pricing|plan|方案|價格|收費/i, score: 2 },
  { re: /menu|課程|服務|service|course|treatment/i, score: 2 },
  { re: /shipping|delivery|return|exchange|運送|配送|退換|退貨/i, score: 1 },
  // 扣分：這些頁面就算讀到也幫不上輪廓，而且很佔字數
  { re: /privacy|terms|policy|隱私|條款|法律/i, score: -5 },
  { re: /cart|checkout|login|signin|register|member|account|會員|登入|購物車|結帳/i, score: -5 },
  { re: /search|tag=|\?s=|sitemap/i, score: -4 },
  { re: /news|blog|article|post|最新消息|部落格/i, score: -1 },
]

export interface RankedPage {
  url: string
  score: number
}

/**
 * 從首頁抽到的站內連結裡，挑出「最可能講得出這家店在賣什麼」的幾頁。
 *
 * 輸入是 `extractUrlText` 產出的純文字——它已經把站內連結寫成「錨文字（絕對網址）」，
 * 所以這裡不用再抓一次 HTML。⛔ 刻意不用 `discoverSitePages`：那支要另外抓
 * sitemap／robots，為了 4 個連結多跑兩趟網路不划算，而且沒有 sitemap 的站它也會退回爬連結。
 */
export function rankProfilePages(pageText: string, baseUrl: string, limit = MAX_PROFILE_PAGES - 1): RankedPage[] {
  const seen = new Map<string, number>()
  let base: URL
  try {
    base = new URL(baseUrl)
  }
  catch {
    return []
  }

  // stripHtml 把站內連結寫成「錨文字（https://…）」
  const re = /（(https?:\/\/[^）\s]+)）/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pageText)) !== null) {
    const abs = resolveInternalUrl(m[1] ?? '', baseUrl)
    if (!abs) continue
    let u: URL
    try {
      u = new URL(abs)
    }
    catch {
      continue
    }
    // 錨點與查詢字串不同、內容其實同一頁 → 用 pathname 當去重鍵
    const key = u.origin + u.pathname.replace(/\/+$/, '')
    if (key === base.origin + base.pathname.replace(/\/+$/, '')) continue // 首頁自己
    if (seen.has(key)) continue

    let score = 0
    const hay = decodeURIComponent(u.pathname + u.search)
    for (const rule of PAGE_SCORE_RULES) {
      if (rule.re.test(hay)) score += rule.score
    }
    // 路徑越深越可能是單一商品；但太深（>4 段）多半是文章
    const depth = u.pathname.split('/').filter(Boolean).length
    if (depth >= 1 && depth <= 3) score += 1
    seen.set(key, score)
  }

  return [...seen.entries()]
    .map(([url, score]) => ({ url, score }))
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, Math.max(0, limit))
}

/** 把抓取時丟出來的錯分類成使用者看得懂的原因。 */
export function classifyFetchError(err: unknown): SiteReadFailReason {
  const e = err as { statusCode?: number, statusMessage?: string, message?: string }
  const msg = String(e?.statusMessage || e?.message || '')
  // ⛔ 404 要先判：寫成 `40[34]` 會讓「網址打錯」被講成「對方擋住我們」，
  //    而這兩句話對使用者的下一步完全不同（改網址 vs 放棄這個來源）。單元測試抓到過一次。
  if (/回應 404/.test(msg) || /找不到/.test(msg)) return 'not_found'
  if (/回應 40[13]/.test(msg) || /robots/i.test(msg)) return 'blocked'
  if (/timeout|逾時|TimeoutError|太久/i.test(msg)) return 'timeout'
  if (/不支援的內容類型/.test(msg)) return 'empty'
  if (/網址格式不正確|必須為 http/.test(msg)) return 'not_found'
  if (/抓取失敗|轉址次數/.test(msg)) return 'network'
  if (e?.statusCode === 502) return 'network'
  return 'unknown'
}

// ── 讀頁 ───────────────────────────────────────────────────────

export interface FetchedPage {
  url: string
  text: string
}

export type FetchOnePageResult =
  | { ok: true, text: string, finalUrl: string }
  | { ok: false, reason: SiteReadFailReason }

/**
 * 抓一頁。**一次只抓一頁**是刻意的：整份工作由 `store-profile-jobs` 一步一步推，
 * 每次輪詢只花一頁的時間，所以永遠不會撞閘道逾時。
 *
 * ⛔ 抓得到但幾乎沒有文字 → 回 `empty` 而不是回一頁空的：那多半是要跑程式才長得出
 *    內容的網站，使用者要的下一步是「改貼商品頁」，不是看到一份空輪廓。
 */
export async function fetchOneProfilePage(url: string): Promise<FetchOnePageResult> {
  try {
    const r = await extractUrlText(url)
    if (r.text.trim().length < MIN_USEFUL_CHARS) return { ok: false, reason: 'empty' }
    return { ok: true, text: r.text.slice(0, MAX_CHARS_PER_PAGE), finalUrl: url }
  }
  catch (err) {
    return { ok: false, reason: classifyFetchError(err) }
  }
}

// ── 交給模型 ───────────────────────────────────────────────────

/** 模型要填的欄位＝欄位表裡標了 `aiCanGuess` 的那幾個。 */
export function aiGuessableFields() {
  return STORE_PROFILE_FIELDS.filter(f => f.aiCanGuess)
}

export function buildExtractPrompt(pages: FetchedPage[]): string {
  const fields = aiGuessableFields()
  const schema = fields.map(f => `  "${f.id}": "${f.aiHint}"`).join(',\n')

  let budget = MAX_PROFILE_PROMPT_CHARS
  const body: string[] = []
  for (const p of pages) {
    if (budget <= 0) break
    const chunk = p.text.slice(0, Math.min(budget, MAX_CHARS_PER_PAGE))
    budget -= chunk.length
    body.push(`--- 頁面：${p.url} ---\n${chunk}`)
  }

  return [
    '你是一位資深行銷企劃，正在看一家店的官方網站，要整理出「這家店是誰」的基本輪廓。',
    '',
    '規則（違反任何一條這次就算失敗）：',
    '1. 只根據下面的網頁內容回答。**網頁沒提到的就回空字串**，不要用產業常識補。',
    '2. 不要編造價格、品牌名稱或競爭對手。價格只能寫網頁上真的出現的數字。',
    '3. 每一格都用**繁體中文**，一句話以內，不要條列符號。',
    '4. 回傳純 JSON，不要加說明文字。',
    '',
    '要填的欄位（值的意思寫在後面）：',
    '{',
    schema,
    '}',
    '',
    body.join('\n\n'),
  ].join('\n')
}

export interface ExtractOutcome {
  guesses: Partial<Record<StoreProfileFieldId, string>>
  inputTokens: number
  outputTokens: number
}

/**
 * 把讀到的頁丟給模型抽輪廓。
 * ⛔ 模型回了不認得的 key 一律丟掉；回了非字串一律轉字串再 trim——
 *    讓沒被驗過的東西直接落地是 `C-190` 那批事故的共同起點。
 */
export async function extractProfileFromPages(pages: FetchedPage[]): Promise<ExtractOutcome> {
  if (pages.length === 0) return { guesses: {}, inputTokens: 0, outputTokens: 0 }

  const prompt = buildExtractPrompt(pages)
  const { data, inputTokens, outputTokens } = await generateJson<Record<string, unknown>>(prompt, {
    // 抽事實不需要創意；溫度 0 讓同一個網站每次讀出來一樣（重讀時才不會看起來像改過）
    temperature: 0,
    maxOutputTokens: 1200,
    thinkingBudget: 0,
  })

  const allowed = new Set(aiGuessableFields().map(f => f.id))
  const guesses: Partial<Record<StoreProfileFieldId, string>> = {}
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!allowed.has(k as StoreProfileFieldId)) continue
    const s = String(v ?? '').trim()
    if (!s || s === '無' || s === '沒有' || s === 'N/A' || s === 'null') continue
    guesses[k as StoreProfileFieldId] = s
  }
  return { guesses, inputTokens, outputTokens }
}
