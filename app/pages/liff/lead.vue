<template>
  <div class="liff-lead" :class="{ 'liff-lead--loading': phase === 'loading' }" role="status" :aria-live="phase === 'error' ? 'assertive' : 'polite'">
    <div v-if="phase === 'loading'" class="liff-lead-loading">
      <span class="liff-lead-spinner" aria-hidden="true" />
      <p class="liff-lead-loading-text">載入中…</p>
    </div>
    <p v-else-if="phase === 'need-login'" class="liff-lead-msg">正在前往 LINE 登入…</p>
    <template v-else-if="phase === 'done'">
      <p class="liff-lead-title">綁定完成</p>
      <p class="liff-lead-msg">{{ doneMessage }}</p>
      <template v-if="needAddFriend">
        <p class="liff-lead-hint">請加入官方帳號為好友，加好友後系統會自動完成活動貼標。</p>
        <a
          v-if="addFriendUrl"
          :href="addFriendUrl"
          class="liff-lead-btn"
          target="_blank"
          rel="noopener noreferrer"
        >加入官方帳號好友</a>
      </template>
      <p v-else class="liff-lead-hint">貼標與活動訊息已即時套用，請至 LINE 查收。</p>
    </template>
    <template v-else-if="phase === 'error'">
      <p class="liff-lead-title">無法完成綁定</p>
      <p class="liff-lead-msg liff-lead-err">{{ errorText }}</p>
      <p class="liff-lead-hint">請重新整理再試一次；若仍無法完成，請直接聯繫這個官方帳號的商家。</p>
      <button type="button" class="liff-lead-btn" @click="reloadPage">重新整理再試</button>
      <div v-if="debugInfo && showDebug" class="liff-lead-debug">
        <p class="liff-lead-debug-title">診斷資訊（請截圖提供給工程）</p>
        <pre class="liff-lead-debug-body">{{ debugInfo }}</pre>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { $fetch } from 'ofetch'
import { parseLeadClaimFromQuery } from '~~/shared/liff-lead-query'

definePageMeta({ layout: false, ssr: false })

// 提前建立 TCP+TLS 連線到 LINE，縮短 liff.init() 的等待時間
useHead({
  link: [
    { rel: 'preconnect', href: 'https://api.line.me' },
    { rel: 'preconnect', href: 'https://access.line.me' },
    { rel: 'dns-prefetch', href: 'https://api.line.me' },
    { rel: 'dns-prefetch', href: 'https://access.line.me' },
  ],
})

const route = useRoute()
const phase = ref<'loading' | 'need-login' | 'done' | 'error'>('loading')
const errorText = ref('')
const doneMessage = ref('')
const debugInfo = ref('')
// 診斷資訊預設隱藏（消費者不該看到內部 JSON）；工程要看時在網址加 ?debug=1
const showDebug = computed(() => route.query.debug === '1' || route.query.debug === 'true')
function reloadPage() {
  if (typeof window !== 'undefined') window.location.reload()
}
const needAddFriend = ref(false)
const addFriendUrl = ref('')
/**  Official Account `basicId`（例：@abc），用於對話 deeplink／加好友連結 */
const oaBasicId = ref('')

// ── localStorage: claim params (survives LINE OAuth redirect) ────────────
const LEAD_KEY = 'liff_lead_params'
const LEAD_TTL = 10 * 60 * 1000 // 10 min

function saveLeadParams(p: { ct: string; campaignCode: string; liffId: string }) {
  if (typeof localStorage === 'undefined' || (!p.ct && !p.liffId)) return
  try { localStorage.setItem(LEAD_KEY, JSON.stringify({ ...p, savedAt: Date.now() })) } catch {}
}
function loadLeadParams(): { ct: string; campaignCode: string; liffId: string } | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(LEAD_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (Date.now() - (d.savedAt || 0) > LEAD_TTL) { localStorage.removeItem(LEAD_KEY); return null }
    return { ct: String(d.ct || ''), campaignCode: String(d.campaignCode || ''), liffId: String(d.liffId || '') }
  } catch { return null }
}
function clearLeadParams() {
  if (typeof localStorage !== 'undefined') try { localStorage.removeItem(LEAD_KEY) } catch {}
}

// ── localStorage: config cache (avoids API round-trip on repeat visits) ─
const CFG_KEY_PREFIX = 'liff_config_cache:'
const CFG_TTL = 60 * 60 * 1000 // 1 hour

/** LIFF ID 格式 `{loginChannelId}-{suffix}`；前半段可反查租戶，也是設定快取的鍵。 */
function loginChannelIdFromLiffId(liffIdRaw: string): string {
  const m = /^(\d+)-/.exec(String(liffIdRaw || '').trim())
  return m?.[1] ?? ''
}

/**
 * 設定快取一律按 Login channel 分開存。
 * ⛔ 不可共用單一鍵：同一支瀏覽器可能先後開兩個不同租戶的活動，共用會把 A 租戶的
 * liffId／OA basicId 餵給 B 租戶的客人。
 */
function loadConfigCache(channelId: string): { liffId: string; lineOaBasicId: string } | null {
  if (typeof localStorage === 'undefined' || !channelId) return null
  try {
    const key = CFG_KEY_PREFIX + channelId
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (Date.now() - (d.cachedAt || 0) > CFG_TTL) { localStorage.removeItem(key); return null }
    return { liffId: String(d.liffId || ''), lineOaBasicId: String(d.lineOaBasicId || '') }
  } catch { return null }
}
function saveConfigCache(channelId: string, cfg: { liffId: string; lineOaBasicId: string }) {
  if (typeof localStorage === 'undefined' || !channelId) return
  // API 認不出租戶時會回空值——寫入會蓋掉原本有效的快取，一律略過
  if (!cfg.liffId && !cfg.lineOaBasicId) return
  try { localStorage.setItem(CFG_KEY_PREFIX + channelId, JSON.stringify({ ...cfg, cachedAt: Date.now() })) } catch {}
}

/** 以 Login channel ID 反查這個租戶的 LIFF 設定（見 server/api/liff/config.get.ts）。 */
function fetchLiffConfig(loginChannelId: string) {
  return $fetch<{ liffId: string; lineOaBasicId: string }>('/api/liff/config', {
    params: { liffClientId: loginChannelId },
  })
}

function applyKnownOaBasicId(basicIdRaw: string) {
  const id = String(basicIdRaw || '').trim()
  if (!id) return
  oaBasicId.value = id
  if (!addFriendUrl.value)
    addFriendUrl.value = `https://line.me/R/ti/p/${encodeURIComponent(id)}`
}

/** LINE 對話視窗 deeplink（與 OA 開聊／未加好友時亦會引導加好友） — 見 Messaging API URL scheme「oaMessage」 */
function buildOaChatDeepLink(basicIdRaw: string) {
  const id = String(basicIdRaw || '').trim()
  if (!id) return ''
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/`
}

/**
 * 未設定完成後轉址時：在 LINE App（in-app LIFF）內優先開啟與官方帳號的對話，再關閉 LIFF。
 * external browser 或非 LINE 環境不可用 closeWindow／openWindow。
 */
function finishInLineClientWithoutCampaignRedirect(liff: {
  isInClient: () => boolean
  openWindow: (p: { url: string; external?: boolean }) => unknown
  closeWindow: () => void
}) {
  if (!liff.isInClient())
    return
  const chat = buildOaChatDeepLink(oaBasicId.value)
  try {
    if (chat)
      liff.openWindow({ url: chat, external: false })
    else if (addFriendUrl.value)
      liff.openWindow({ url: addFriendUrl.value, external: false })
  }
  catch { /* LINE 環境異常時仍嘗試關閉 */ }

  window.setTimeout(() => {
    try {
      liff.closeWindow()
    }
    catch { /* noop */ }
  }, chat || addFriendUrl.value ? 650 : 200)
}

function goToChatOrAddFriendByLocation() {
  if (typeof window === 'undefined') return
  const chat = buildOaChatDeepLink(oaBasicId.value)
  const target = chat || addFriendUrl.value
  if (!target) return
  window.location.href = target
}

// ── URL parsing helpers ──────────────────────────────────────────────────

function mergeParsedLead(
  base: { ct: string; campaignCode: string; liffId: string },
  next: { ct: string; campaignCode: string; liffId: string },
) {
  return {
    ct: base.ct || next.ct,
    campaignCode: base.campaignCode || next.campaignCode,
    liffId: base.liffId || next.liffId,
  }
}

function parseLeadFromBrowserLocation() {
  if (typeof window === 'undefined') return { ct: '', campaignCode: '', liffId: '' }
  let result = { ct: '', campaignCode: '', liffId: '' }
  const url = new URL(window.location.href)
  result = mergeParsedLead(result, parseLeadClaimFromQuery(Object.fromEntries(url.searchParams.entries())))
  const hashRaw = String(url.hash || '').replace(/^#/, '')
  if (hashRaw) {
    const qs = hashRaw.includes('?') ? hashRaw.slice(hashRaw.indexOf('?') + 1) : hashRaw
    result = mergeParsedLead(result, parseLeadClaimFromQuery(Object.fromEntries(new URLSearchParams(qs).entries())))
  }
  result = mergeParsedLead(result, parseLeadClaimFromQuery({ 'liff.state': encodeURIComponent(window.location.href) }))
  return result
}

/** 讀 LINE 登入 callback 的參數（route.query 先，退回直接讀 location）。 */
function readCallbackParam(key: string): string {
  const fromRoute = (route.query as Record<string, unknown>)[key]
  const v = Array.isArray(fromRoute) ? fromRoute[0] : fromRoute
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof window === 'undefined') return ''
  try { return String(new URL(window.location.href).searchParams.get(key) || '').trim() }
  catch { return '' }
}

function buildDebugInfo(extra: Record<string, unknown>) {
  try {
    const routeQuery = route.query as Record<string, unknown>
    const loc = typeof window === 'undefined' ? {} : { href: window.location.href, search: window.location.search, hash: window.location.hash }
    return JSON.stringify({ routeQuery, parsedFromRoute: parseLeadClaimFromQuery(routeQuery), parsedFromLocation: parseLeadFromBrowserLocation(), ...loc, ...extra }, null, 2)
  } catch (e) { return `buildDebugInfo failed: ${String(e)}` }
}

function isLikelyLineClientUserAgent() {
  if (typeof navigator === 'undefined') return false
  return /Line\//i.test(navigator.userAgent)
}

function buildLineAppOpenUrl(liffId: string) {
  if (!liffId || typeof window === 'undefined') return ''
  const currentUrl = new URL(window.location.href)
  const deepLink = new URL(`line://app/${liffId}`)
  currentUrl.searchParams.forEach((value, key) => deepLink.searchParams.set(key, value))
  return deepLink.toString()
}

async function tryOpenInLineAppBeforeInit(liffId: string) {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return
  if (!liffId) return
  if (isLikelyLineClientUserAgent()) return

  // Avoid repeated deep-link attempts in the same browser tab/session.
  const markerKey = `line_app_open_attempted:${liffId}`
  if (sessionStorage.getItem(markerKey) === '1') return
  sessionStorage.setItem(markerKey, '1')

  const deepLinkUrl = buildLineAppOpenUrl(liffId)
  if (!deepLinkUrl) return

  window.location.href = deepLinkUrl

  // LINE app 有裝：頁面會轉背景（visibilitychange），立即放行不用等滿。
  // 沒裝：等 450ms 後照常走 web LIFF 流程（等太久只是拖慢沒有 LINE app 的使用者）。
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, 450)
    function done() {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', done)
      resolve()
    }
    document.addEventListener('visibilitychange', done)
  })
}

onMounted(async () => {
  const ctx: Record<string, unknown> = { v: 7 }

  // ── 最先啟動：LIFF SDK 動態載入（與其他步驟並行執行）──────────────────
  // @line/liff 是最重的資源，越早開始載入越好。
  const liffImportPromise = import('@line/liff')

  // --- Step 1: Parse URL params ---
  let parsed = parseLeadClaimFromQuery(route.query as Record<string, unknown>)
  if (!parsed.ct || !parsed.liffId) parsed = mergeParsedLead(parsed, parseLeadFromBrowserLocation())
  ctx.step1Parsed = { ...parsed }

  // --- Step 1b: Restore params from localStorage after LINE OAuth redirect ---
  // callback 的固定參數要獨立判斷（不管 claimToken 有沒有從 liffRedirectUri 救回來），
  // 因為下面的「跳去 LINE App」守門要靠它。liffClientId 同時是租戶線索。
  const callbackLiffClientId = readCallbackParam('liffClientId')
  const hasOAuthCallbackParams = Boolean(readCallbackParam('code') && callbackLiffClientId)
  const isOAuthCallback = hasOAuthCallbackParams && !parsed.ct && !parsed.liffId
  ctx.hasOAuthCallbackParams = hasOAuthCallbackParams

  if (parsed.ct || parsed.liffId) {
    saveLeadParams(parsed)
    ctx.storageSaved = true
  }
  else if (isOAuthCallback) {
    const stored = loadLeadParams()
    if (stored) { parsed = mergeParsedLead(parsed, stored); ctx.storedParams = { ...stored }; ctx.restoredFromStorage = true }
  }
  ctx.step1bParsed = { ...parsed }

  // --- Step 2: Resolve liffId — localStorage cache → URL params → API ---
  // API fetch runs in parallel with liffImportPromise when liffId already known.
  let liffId = parsed.liffId

  // 租戶線索：網址上的 liffId 前綴，或登入 callback 帶回來的 liffClientId。
  // 兩個都沒有就無從得知是哪個租戶——此時不打 API（只會回空），也絕不猜。
  const channelIdHint = loginChannelIdFromLiffId(liffId) || callbackLiffClientId
  ctx.channelIdHint = channelIdHint

  // Try config cache first (instant, no network)
  const cachedCfg = loadConfigCache(channelIdHint)
  if (cachedCfg) {
    if (!liffId) liffId = cachedCfg.liffId
    if (cachedCfg.lineOaBasicId) applyKnownOaBasicId(cachedCfg.lineOaBasicId)
    ctx.liffIdSource = liffId === cachedCfg.liffId ? 'cache' : 'url_or_params'
  }

  if (!liffId) {
    if (channelIdHint) {
      // Must fetch API before proceeding — but liffImportPromise is already loading in parallel
      try {
        const cfg = await fetchLiffConfig(channelIdHint)
        liffId = cfg?.liffId || ''
        if (cfg) saveConfigCache(channelIdHint, cfg)
        if (cfg?.lineOaBasicId) applyKnownOaBasicId(cfg.lineOaBasicId)
        ctx.liffIdSource = 'api'
      }
      catch (e) {
        ctx.liffIdSource = 'api_failed'
        ctx.liffIdApiError = String(e)
      }
    }
    else {
      ctx.liffIdSource = 'no_tenant_hint'
    }
  }
  else if (!cachedCfg && channelIdHint) {
    // Have liffId — refresh config cache in background without blocking
    fetchLiffConfig(channelIdHint).then((cfg) => {
      if (cfg) saveConfigCache(channelIdHint, cfg)
      if (cfg?.lineOaBasicId && !oaBasicId.value) applyKnownOaBasicId(cfg.lineOaBasicId)
    }).catch(() => {})
    ctx.liffIdSource = ctx.liffIdSource || 'url_or_params'
  }
  ctx.liffId = liffId

  if (!liffId) {
    phase.value = 'error'
    errorText.value = '這個連結不完整、沒辦法辨識活動。請聯繫這個官方帳號的商家，重新提供正確的連結。'
    debugInfo.value = buildDebugInfo({ reason: 'missing_liff_id', mergedParsed: parsed, ...ctx })
    return
  }

  // ⛔ 登入 callback 上不可跳去 LINE App：深連結會把網址上的 code 一起複製過去，
  // 而那個 code 用過即棄；客人會在 App 裡拿著已消耗的 code 開 LIFF 而失敗，
  // 同時持有這次登入的瀏覽器也回不去了。這裡直接讓 liff.init() 收掉 callback。
  if (hasOAuthCallbackParams)
    ctx.skippedLineAppDeepLink = true
  else
    await tryOpenInLineAppBeforeInit(liffId)

  // --- Step 3: Await LIFF SDK (已與 Step 2 並行載入) ---
  const liffMod = await liffImportPromise
  const liff = liffMod.default

  ctx.preInitUrl = typeof window !== 'undefined' ? window.location.href : ''
  try {
    await liff.init({ liffId, withLoginOnExternalBrowser: true })
    ctx.initOk = true
  }
  catch (e: unknown) {
    const err = e as { message?: string }
    ctx.initOk = false; ctx.initError = err?.message || String(e)
    phase.value = 'error'
    errorText.value = `LIFF 初始化失敗：${err?.message || '未知錯誤'}`
    debugInfo.value = buildDebugInfo({ reason: 'liff_init_failed', mergedParsed: parsed, ...ctx })
    return
  }
  ctx.postInitUrl = typeof window !== 'undefined' ? window.location.href : ''
  ctx.isLoggedIn = liff.isLoggedIn()

  // --- Step 4: Re-read params after init (history.replaceState may have changed URL) ---
  if (!parsed.ct) {
    parsed = mergeParsedLead(parsed, parseLeadFromBrowserLocation())
    ctx.step4Parsed = { ...parsed }
  }
  const ct = parsed.ct

  // --- Step 5: Handle login ---
  if (!liff.isLoggedIn()) {
    saveLeadParams(parsed)
    phase.value = 'need-login'
    liff.login({ redirectUri: window.location.href })
    return
  }

  // --- Step 6: Validate ct ---
  if (!ct) {
    phase.value = 'error'
    const malformedCtOnly = typeof window !== 'undefined' && window.location.search === '?ct'
    errorText.value = malformedCtOnly
      ? '這個連結少了活動資料，可能是複製到錯的網址、或轉傳時被截斷了。請聯繫這個官方帳號的商家，重新提供正確的活動連結。'
      : '這個連結不完整、少了必要資料。請聯繫這個官方帳號的商家，重新提供最新的連結。'
    debugInfo.value = buildDebugInfo({ reason: 'missing_ct', mergedParsed: parsed, ...ctx })
    return
  }

  // --- Step 7: Claim ---
  try {
    // userId 由後端向 LINE 驗證 access token 取得，前端不再自報
    const accessToken = liff.getAccessToken()
    if (!accessToken) {
      throw new Error('無法取得 LINE 授權（access token），請重新開啟連結')
    }
    const res = await $fetch<{
      ok?: boolean
      immediatelyApplied?: boolean
      campaignCode?: string
      redirectUrl?: string
      lineOaBasicId?: string
      workspaceId?: string
    }>(
      '/api/liff/claim',
      { method: 'POST', body: { rawToken: ct, accessToken } },
    )
    clearLeadParams()

    // 使用者已加好友：在背景發出 apply 請求完成貼標與推播，不阻塞 UI
    // keepalive: true 確保頁面跳轉或 LIFF 關閉後請求仍能在背景完成
    if (res.immediatelyApplied && res.workspaceId) {
      fetch('/api/liff/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, workspaceId: res.workspaceId }),
        keepalive: true,
      }).catch(() => {})
    }

    if (res.redirectUrl) {
      window.location.href = res.redirectUrl
      return
    }

    if (String(res.lineOaBasicId || '').trim())
      applyKnownOaBasicId(String(res.lineOaBasicId))

    // LINE app 內但非 LIFF in-client 容器時，isInClient() 可能是 false；
    // 這時改用 location 跳轉對話，避免使用者卡在完成頁。
    if (liff.isInClient()) {
      finishInLineClientWithoutCampaignRedirect(liff)
      return
    }
    if (isLikelyLineClientUserAgent()) {
      goToChatOrAddFriendByLocation()
      return
    }

    phase.value = 'done'
    if (res.immediatelyApplied) {
      doneMessage.value = '已將你的 LINE 與活動綁定。'
      needAddFriend.value = false
    }
    else {
      doneMessage.value = '已將你的 LINE 與活動綁定。'
      needAddFriend.value = true
    }
  }
  catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }; message?: string }
    phase.value = 'error'
    errorText.value = err?.data?.statusMessage || err?.message || '發生錯誤，請稍後再試。'
    debugInfo.value = buildDebugInfo({ reason: 'run_claim_failed', mergedParsed: parsed, errorMessage: err?.data?.statusMessage || err?.message || 'unknown', ...ctx })
  }
})
</script>
