/** 可能被多包一層 URL 編碼（例：`https%3A%2F%2F…`）：解到看得出是網址或 query 為止。 */
function normalizeMaybeEncodedUrl(raw: string): string {
  let s = String(raw || '').trim()
  for (let i = 0; i < 3; i++) {
    if (s.includes('?') || s.startsWith('http://') || s.startsWith('https://')) break
    if (!s.includes('%')) break
    let next: string
    try {
      next = decodeURIComponent(s.replace(/\+/g, '%20'))
    }
    catch {
      break
    }
    if (next === s) break
    s = next
  }
  return s
}

/** 從「完整網址」或「query 字串」取出參數表；解析不出來回 null。 */
function searchParamsFromUrlOrQuery(raw: string): URLSearchParams | null {
  const s = normalizeMaybeEncodedUrl(raw)
  if (!s) return null
  try {
    if (s.startsWith('http://') || s.startsWith('https://')) {
      const search = new URL(s).search
      return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    }
    const qIndex = s.indexOf('?')
    return new URLSearchParams(qIndex >= 0 ? s.slice(qIndex + 1) : s)
  }
  catch {
    return null
  }
}

/**
 * 活動 LIFF 進入頁：從網址取得 claimToken/ct（兌換 token）、c（活動代碼）與 liffId（初始化 LIFF SDK）。
 * LINE 可能把原始 query 放在 `liff.state`，登入 callback 則放在 `liffRedirectUri`。
 */
export function parseLeadClaimFromQuery(
  query: Record<string, unknown>,
): { ct: string; campaignCode: string; liffId: string } {
  const pick = (key: string): string => {
    const v = query[key]
    if (Array.isArray(v)) return String(v[0] ?? '').trim()
    if (v == null) return ''
    return String(v).trim()
  }

  let ct = pick('claimToken') || pick('claim_token') || pick('ct')
  let campaignCode = pick('c')
  let liffId = pick('liffId') || pick('liff_id')

  const referrer = pick('liff.referrer')
  if (!liffId && referrer) {
    try {
      const u = new URL(referrer)
      const seg = u.pathname.split('/').filter(Boolean)
      if (seg.length > 0)
        liffId = String(seg[seg.length - 1] || '').trim()
    }
    catch {
      // ignore malformed referrer
    }
  }

  const stateRaw = pick('liff.state') || pick('liff_state')
  if (stateRaw) {
    try {
      let cursor = stateRaw
      for (let i = 0; i < 4; i++) {
        const decoded = decodeURIComponent(String(cursor || '').replace(/\+/g, '%20'))
        let search = ''
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
          search = new URL(decoded).search
        }
        else {
          const qIndex = decoded.indexOf('?')
          search = qIndex >= 0 ? decoded.slice(qIndex) : decoded
        }
        const normalized = search.startsWith('?') ? search.slice(1) : search
        const sp = new URLSearchParams(normalized)

        if (!ct) ct = String(sp.get('claimToken') || sp.get('claim_token') || sp.get('ct') || '').trim()
        if (!campaignCode) campaignCode = String(sp.get('c') || '').trim()
        if (!liffId) liffId = String(sp.get('liffId') || sp.get('liff_id') || '').trim()

        const nested = String(sp.get('liff.state') || sp.get('liff_state') || '').trim()
        if (!nested) break
        cursor = nested
      }
    }
    catch {
      // ignore malformed state
    }
  }

  // LINE 在外部瀏覽器完成登入後，callback 網址只剩 code/state/liffClientId，原本的
  // claimToken／liffId 會整批不見；LIFF 會另外附上 liffRedirectUri = 登入前的完整網址，
  // 是掉參數時最可靠的還原來源（比 localStorage 可靠：不受隱私模式、換瀏覽器、逾時影響）。
  const redirectUriRaw = pick('liffRedirectUri') || pick('liff_redirect_uri')
  if (redirectUriRaw && (!ct || !campaignCode || !liffId)) {
    let cursor = redirectUriRaw
    for (let i = 0; i < 4; i++) {
      const sp = searchParamsFromUrlOrQuery(cursor)
      if (!sp) break

      if (!ct) ct = String(sp.get('claimToken') || sp.get('claim_token') || sp.get('ct') || '').trim()
      if (!campaignCode) campaignCode = String(sp.get('c') || '').trim()
      if (!liffId) liffId = String(sp.get('liffId') || sp.get('liff_id') || '').trim()

      const nested = String(sp.get('liff.state') || sp.get('liff_state') || '').trim()
      if (!nested) break
      cursor = nested
    }
  }

  return { ct, campaignCode, liffId }
}

/**
 * LINE 登入 callback 的 `liffRedirectUri` 指向其他網域時（LIFF Endpoint URL 與活動連結
 * 的網域不一致，例如換網域過渡期），把它改寫成目前網域、只保留 path/query/hash。
 *
 * 為什麼必須改寫：LIFF SDK 登入後把 access token 存在「目前網域」的 localStorage，
 * 接著會跳轉到 `liffRedirectUri`。若那是別的網域，到了那邊 `liff.isLoggedIn()` 永遠是
 * false，於是再次 `liff.login()` → 又被 LINE 導回 Endpoint 網域 → 再跳回去……
 * 兩個網域之間無限循環，使用者只看到轉圈（2026-08-07 實測災情）。
 *
 * @returns 改寫後的完整網址；沒有 liffRedirectUri、已是同網域或解析失敗時回 null（不需改寫）。
 */
export function rewriteLiffRedirectUriToOrigin(href: string, origin: string): string | null {
  try {
    const url = new URL(href)
    const key = url.searchParams.has('liffRedirectUri')
      ? 'liffRedirectUri'
      : url.searchParams.has('liff_redirect_uri') ? 'liff_redirect_uri' : ''
    if (!key) return null
    const target = new URL(normalizeMaybeEncodedUrl(url.searchParams.get(key) || ''))
    const currentOrigin = new URL(origin).origin
    if (target.origin === currentOrigin) return null
    url.searchParams.set(key, new URL(target.pathname + target.search + target.hash, currentOrigin).toString())
    return url.toString()
  }
  catch {
    return null
  }
}

/**
 * 組 `liff.login()` 的 redirectUri：拿掉上一輪 OAuth callback 的參數（code/state/
 * liffClientId/liffRedirectUri），只帶活動參數回來。
 *
 * 為什麼必須清掉：code 用過即棄。跨網域登入失敗後重新 login 時若把整串 callback
 * 網址當 redirectUri，登入完成會回到一個「還掛著舊 code/state」的網址，LIFF SDK
 * 會把它誤判成另一次 callback 再處理一遍，於是又失敗又登入……參數像雪球越滾越長，
 * 使用者只看到轉圈（2026-08-07 實測災情的放大器）。
 */
export function buildLoginRedirectUri(
  href: string,
  parsed: { ct: string; campaignCode: string; liffId: string },
): string {
  try {
    const url = new URL(href)
    for (const key of ['code', 'state', 'liffClientId', 'liffRedirectUri', 'liff_redirect_uri'])
      url.searchParams.delete(key)
    if (parsed.ct) url.searchParams.set('claimToken', parsed.ct)
    if (parsed.campaignCode) url.searchParams.set('c', parsed.campaignCode)
    if (parsed.liffId) url.searchParams.set('liffId', parsed.liffId)
    return url.toString()
  }
  catch {
    return href
  }
}

/** 從後台儲存的活動進入網址（direct 或 liff.line.me）解析 claimToken 等參數。 */
export function parsePublishedCtaUrl(ctaUrl: string): { ct: string; campaignCode: string; liffId: string } {
  try {
    const u = new URL(ctaUrl)
    const query: Record<string, string> = {}
    u.searchParams.forEach((value, key) => {
      query[key] = value
    })
    return parseLeadClaimFromQuery(query)
  }
  catch {
    return { ct: '', campaignCode: '', liffId: '' }
  }
}
