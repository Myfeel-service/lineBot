import type { Firestore } from 'firebase-admin/firestore'
import { LEAD_PATH } from '~~/shared/liff-lead-path'
import { capMapSize } from './bounded-cache'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'
import { isUrlReachable } from './url-reachable'

/**
 * 問 LINE「這個 LIFF 登記的 Endpoint URL 是什麼」，並比對是不是這套系統的活動頁。
 *
 * 為什麼要查：LINE 登入的 callback 永遠回到 LIFF 登記的 Endpoint URL，跟客人點的
 * 連結網域無關。登記錯（換網域沒改到、指到第三方服務、LIFF 被刪）時活動連結會
 * 把客人帶去錯的地方或卡在載入中，而後台完全看不出來（2026-08-07 實測災情）。
 *
 * 怎麼查：正規做法是 LIFF Server API（GET /liff/v1/apps），但那要 LINE **Login
 * channel** 的 access token——我們只存 Messaging API 憑證，拿不到。退而求其次用
 * 公開轉址頁：https://liff.line.me/{liffId} 的 HTML 裡寫著
 * `const liffEndpointUrl = "…"`（2026-08 實測）。未文件化、LINE 改版就會失效，
 * 所以解析不出來一律回 unknown（不下結論），絕不把「查不到」講成有事或沒事。
 */

const LIFF_PAGE_TIMEOUT_MS = 8000
/** 結果快取：endpoint 不是秒級會變的設定，輪詢不該每次都打 LINE 的頁（同 webhook probe 的 5 分鐘） */
const LIFF_PROBE_TTL_MS = 5 * 60_000
const LIFF_PROBE_CACHE_MAX = 500

/** 這套系統的活動頁路徑（唯一來源在 shared/liff-lead-path，教的跟驗的必須同一串）；
 * /webhook 是老設定（GET 會 302 轉到活動頁，能用但該修正） */
const LEGACY_LEAD_PATH = '/webhook'

/** 每次檢查最多探幾個 LIFF（一個工作區通常就 1～2 個；上限擋異常資料把輪詢拖垮） */
const LIFF_CHECK_MAX_IDS = 5
const CAMPAIGN_LIFF_SCAN_LIMIT = 50

export type LiffEndpointLookup =
  | { kind: 'found'; endpointUrl: string }
  | { kind: 'not_found' } // LIFF 不存在（已刪除或 ID 貼錯）

const liffProbeCache = new Map<string, { result: LiffEndpointLookup; expires: number }>()

/** 讀 liff.line.me 轉址頁取得登記的 Endpoint URL。解析不出來 throw（呼叫端降級 unknown）。 */
export async function fetchLiffEndpointUrl(liffIdRaw: string, skipCache = false): Promise<LiffEndpointLookup> {
  const liffId = liffIdRaw.trim()
  const cached = skipCache ? null : liffProbeCache.get(liffId)
  if (cached && cached.expires > Date.now()) return cached.result

  const res = await fetch(`https://liff.line.me/${encodeURIComponent(liffId)}`, {
    // 目前是 200＋HTML；若 LINE 哪天改回 3xx，Location 本身就是答案
    redirect: 'manual',
    signal: AbortSignal.timeout(LIFF_PAGE_TIMEOUT_MS),
  })

  let result: LiffEndpointLookup
  if (res.status === 404) {
    result = { kind: 'not_found' }
  }
  else if (res.status >= 300 && res.status < 400) {
    const loc = String(res.headers.get('location') || '').trim()
    if (!/^https?:\/\//.test(loc)) throw new Error(`liff.line.me 轉址沒帶 Location（HTTP ${res.status}）`)
    result = { kind: 'found', endpointUrl: loc }
  }
  else if (res.ok) {
    const html = await res.text()
    const m = /const\s+liffEndpointUrl\s*=\s*"([^"]+)"/.exec(html)
      ?? /<a\s+href="(https?:\/\/[^"]+)"/.exec(html)
    if (!m?.[1]) throw new Error('liff.line.me 頁面裡找不到 endpoint（LINE 可能改版了）')
    result = { kind: 'found', endpointUrl: m[1] }
  }
  else {
    throw new Error(`liff.line.me 查詢失敗 HTTP ${res.status}`)
  }

  liffProbeCache.set(liffId, { result, expires: Date.now() + LIFF_PROBE_TTL_MS })
  capMapSize(liffProbeCache, LIFF_PROBE_CACHE_MAX)
  return result
}

export type LiffEndpointStatus =
  /** 就是正式網址的活動頁 */
  | 'ok'
  /** 到得了活動頁，但網域不是正式網址、或還填著舊的 /webhook——登入流程會多繞，該修正 */
  | 'mismatch'
  /** 到不了活動頁：LIFF 不存在，或指向不相干的網站／頁面 */
  | 'broken'
  /** 這次查不到（網路失敗、LINE 改版）。不等於沒問題 */
  | 'unknown'

export interface LiffEndpointCheckItem {
  liffId: string
  /** default＝工作區預設 LIFF；campaign＝活動各自指定的 LIFF */
  source: 'default' | 'campaign'
  status: LiffEndpointStatus
  /** LINE 上登記的網址（查得到才有） */
  endpoint: string | null
  /** broken 的細分（文案在前端對照）：wrong_page＝指到不相干的頁、unreachable＝登記的網址已連不上、deleted＝LIFF 不存在 */
  reason?: 'wrong_page' | 'unreachable' | 'deleted'
}

/**
 * 比對登記的網址與正式網址（PUBLIC_BASE_URL）。
 * 沒有可信的比對基準（沒設定、或設成本機網址）時只驗「是不是活動頁路徑」，
 * 不驗網域——寧可漏抓，不誤報（與 webhook mismatch 檢查同一條原則）。
 */
export function classifyLiffEndpoint(endpointUrl: string, canonicalBase: string): LiffEndpointStatus {
  let target: URL
  try {
    target = new URL(endpointUrl)
  }
  catch {
    return 'broken'
  }
  const path = target.pathname.replace(/\/+$/, '') || '/'
  if (path !== LEAD_PATH && path !== LEGACY_LEAD_PATH) return 'broken'

  const canonical = canonicalBase.trim().replace(/\/$/, '')
  const comparable = Boolean(canonical) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(canonical)
  if (comparable) {
    try {
      if (target.origin !== new URL(canonical).origin) return 'mismatch'
    }
    catch {
      return 'ok'
    }
    if (path === LEGACY_LEAD_PATH) return 'mismatch'
  }
  return 'ok'
}

/**
 * 收集一個工作區用到的所有 LIFF（預設＋活動指定）並逐一檢查登記狀態。
 * 單一 LIFF 查失敗＝該項 unknown，不會整批丟錯——一個查不到不該遮住另一個查得到的災情。
 */
export async function collectLiffEndpointChecks(
  db: Firestore,
  wid: string,
  opts: { canonicalBase: string; skipCache?: boolean },
): Promise<LiffEndpointCheckItem[]> {
  const { defaultLiffId } = await getLineWorkspaceCredentials(wid)

  // 活動可各自指定 LIFF。不濾 isActive：欄位缺省視同啟用（等值查詢會漏掉缺欄位的舊資料），
  // 而且停用活動的連結多半還在外面流通，登記錯一樣會有客人踩到。
  const snap = await db.collection('leadCampaigns')
    .where('workspaceId', '==', wid)
    .select('liffId')
    .limit(CAMPAIGN_LIFF_SCAN_LIMIT)
    .get()

  const targets = new Map<string, 'default' | 'campaign'>()
  const def = String(defaultLiffId || '').trim()
  if (def) targets.set(def, 'default')
  for (const doc of snap.docs) {
    const id = String((doc.data() as Record<string, unknown>).liffId || '').trim()
    if (id && !targets.has(id)) targets.set(id, 'campaign')
  }

  return Promise.all([...targets.entries()].slice(0, LIFF_CHECK_MAX_IDS).map(
    async ([liffId, source]): Promise<LiffEndpointCheckItem> => {
      try {
        const lookup = await fetchLiffEndpointUrl(liffId, opts.skipCache === true)
        if (lookup.kind === 'not_found')
          return { liffId, source, status: 'broken', endpoint: null, reason: 'deleted' }
        const status = classifyLiffEndpoint(lookup.endpointUrl, opts.canonicalBase)
        if (status === 'broken')
          return { liffId, source, status, endpoint: lookup.endpointUrl, reason: 'wrong_page' }
        // 「填錯但還能動」與「填錯而且已經連不上」是兩種嚴重度：舊網域一停掉，
        // 客人點活動連結就打不開了，要自動升級成 broken——不能等人記得回來看
        if (status === 'mismatch' && !(await isUrlReachable(lookup.endpointUrl)))
          return { liffId, source, status: 'broken', endpoint: lookup.endpointUrl, reason: 'unreachable' }
        return { liffId, source, status, endpoint: lookup.endpointUrl }
      }
      catch (e) {
        console.warn(`[liff-endpoint] ${liffId} 檢查失敗:`, String((e as Error)?.message ?? e).slice(0, 160))
        return { liffId, source, status: 'unknown', endpoint: null }
      }
    },
  ))
}

/**
 * 「有活動，但沒有任何 LIFF 可以用」——活動連結在外面點下去會打不開（`D-19`）。
 *
 * 這是條件式的：沒開活動的帳號完全不需要 LIFF（2026-08-07 拍板把 LIFF 從必要項拆成
 * 加分項，就是因為多數新客戶第一天用不到）。只有「已經有活動在跑、活動自己沒指定 LIFF、
 * 工作區也沒有預設 LIFF」這個組合，才是客人真的會踩到的災情。
 *
 * ⚠️ 與 collectLiffEndpointChecks 同一條原則：**不濾 isActive**。欄位缺省的舊資料會被
 * 等值查詢漏掉，而且停用活動的連結多半還在外面流通，一樣有客人會點。
 * ⚠️ 這裡只回「有沒有、幾個」，不回活動名稱——這是彙總訊號不是報表。
 */
export async function countCampaignsWithoutUsableLiff(
  db: Firestore,
  wid: string,
): Promise<{ campaignsWithoutLiff: number, hasDefaultLiff: boolean }> {
  const { defaultLiffId } = await getLineWorkspaceCredentials(wid)
  const hasDefaultLiff = Boolean(String(defaultLiffId || '').trim())
  // 有預設 LIFF 就一定有得用（活動沒填會自動 fallback），連查都不用查
  if (hasDefaultLiff) return { campaignsWithoutLiff: 0, hasDefaultLiff: true }

  const snap = await db.collection('leadCampaigns')
    .where('workspaceId', '==', wid)
    .select('liffId')
    .limit(CAMPAIGN_LIFF_SCAN_LIMIT)
    .get()

  const campaignsWithoutLiff = snap.docs
    .filter(doc => !String((doc.data() as Record<string, unknown>).liffId || '').trim())
    .length
  return { campaignsWithoutLiff, hasDefaultLiff: false }
}
