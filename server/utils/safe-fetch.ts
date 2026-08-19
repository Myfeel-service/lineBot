/**
 * 對「使用者提供的網址」做安全抓取（C-49A）。
 *
 * 兩個洞（健檢 P1-7）：
 * 1. SSRF：有權限的使用者貼 http://169.254.169.254/…（雲端中繼資料）或內網位址，
 *    內容會被切成知識卡回顯——等於拿知識庫功能當內網探測器。
 * 2. 無大小上限：res.text() 把整包吃進記憶體，一個超大回應直接把 Lambda 打到 OOM
 *    （無訊息 502）。AbortSignal 只擋慢、不擋大。
 *
 * 做法：每一跳 redirect 都先解析 DNS、擋私有/回環/link-local 網段，再手動跟轉址（≤5 跳）；
 * 回應用 streaming reader 邊讀邊數，超過上限就中止。
 * 已知限制：DNS 解析與實際連線之間理論上可被 rebinding 繞過（要釘 IP 進 agent 才能全堵）；
 * 對這套後台的威脅模型（需登入的商家帳號）先堵到這一層，rebinding 級攻擊不在此範圍。
 */
import { lookup } from 'node:dns/promises'

export const FETCH_MAX_BYTES = 5 * 1024 * 1024
export const FETCH_MAX_REDIRECTS = 5

/** 私有 / 回環 / link-local / 中繼資料網段（v4 + v6 常見形）。純函式好測。 */
export function isPrivateAddress(ip: string): boolean {
  const s = String(ip || '').trim().toLowerCase()
  if (!s) return true
  // IPv6（含 v4-mapped）
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true
    if (s.startsWith('fc') || s.startsWith('fd')) return true // fc00::/7 ULA
    if (/^fe[89ab]/.test(s)) return true // fe80::/10 link-local
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1]!)
    return false
  }
  const parts = s.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local（AWS/GCP 中繼資料都在這）
  if (a === 172 && b! >= 16 && b! <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b! >= 64 && b! <= 127) return true // CGNAT
  return false
}

/** 主機名先擋一輪（不用等 DNS）：localhost 家族與純 IP 直接判 */
export function isBlockedHostname(hostname: string): boolean {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') return true
  // 純 IP（v4 或 [v6]）直接用位址判
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateAddress(h)
  if (h.includes(':')) return isPrivateAddress(h)
  return false
}

async function assertPublicHost(hostname: string): Promise<void> {
  const deny = () => {
    throw createError({
      statusCode: 400,
      statusMessage: '這個網址指向內部或私有網路，無法作為資料來源；請改用公開網站的網址。',
    })
  }
  if (isBlockedHostname(hostname)) deny()
  let addrs: Array<{ address: string }>
  try {
    addrs = await lookup(hostname, { all: true })
  }
  catch {
    throw createError({ statusCode: 502, statusMessage: `網址解析失敗：${hostname}（請確認網址正確且公開可訪問）` })
  }
  // 任一解析結果落在私有網段就整個擋（保守：多 A 記錄混私有位址是典型繞法）
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) deny()
}

export interface SafeFetchResult {
  status: number
  ok: boolean
  contentType: string
  text: string
  /** 跟完轉址後的最終網址（解相對連結用） */
  finalUrl: string
  /** 因超過大小上限被截斷 */
  truncatedBySize: boolean
}

/**
 * 抓公開網頁文字：逐跳驗證主機、streaming 讀取設上限。
 * 只支援 http(s)；非 2xx 不 throw（由呼叫端決定訊息，與原 extractUrlText 行為一致）。
 */
export async function fetchPublicText(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES
  let url = String(rawUrl || '').trim()

  let res: Response | null = null
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    let u: URL
    try {
      u = new URL(url)
    }
    catch {
      throw createError({ statusCode: 400, statusMessage: '網址格式不正確' })
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw createError({ statusCode: 400, statusMessage: 'URL 必須為 http:// 或 https:// 開頭' })
    }
    await assertPublicHost(u.hostname)

    try {
      res = await fetch(u, {
        headers: opts.headers,
        redirect: 'manual', // ⛔不能交給 fetch 自動跟：轉址到內網是最典型的 SSRF 繞法
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    catch (err: any) {
      throw createError({ statusCode: 502, statusMessage: `網址抓取失敗：${err?.message ?? 'unknown'}` })
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) break
      url = new URL(loc, u).href
      // 把上一跳的 body 放掉（避免連線佔用）
      await res.body?.cancel().catch(() => {})
      res = null
      continue
    }
    break
  }
  if (!res) {
    throw createError({ statusCode: 502, statusMessage: '網址轉址次數過多，請確認連結' })
  }

  // streaming 讀取＋位元組上限：超過就截斷（抽取層本來就會再截到 MAX_RAW_TEXT_LEN，
  // 這裡的上限是防 OOM 的保險，不是內容策略）
  let truncatedBySize = false
  let text = ''
  if (res.body) {
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        truncatedBySize = true
        chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - maxBytes))))
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(Buffer.from(value))
    }
    text = Buffer.concat(chunks).toString('utf8')
  }

  return {
    status: res.status,
    ok: res.ok,
    contentType: String(res.headers.get('content-type') ?? ''),
    text,
    finalUrl: res.url || url,
    truncatedBySize,
  }
}
