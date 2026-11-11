/**
 * 付款那一段的埋點（`D-180`，2026-11-11）。
 *
 * ⭐ **為什麼要有**：帳務資料（`orders`／訂閱）答得出「誰付了」，答不出
 *    **「誰看了沒付、停在哪一格」**——而開賣之後要調任何東西（文案、時機、價格），
 *    靠的就是後者。第一批客人只會走一次，沒記到就永遠補不回來。
 * ⛔ **不是第二本帳**：付款成功與否一律以帳務為準。這裡記的是「他在畫面上看到什麼、
 *    按了什麼」——`billing_gateway_back` 的 `shown` 是**畫面狀態**，不是入帳狀態。
 *
 * 走既有的管線（`useOnboardingEvents` → `/api/onboarding/events`），只把 `flow` 標成
 * `billing`，⛔ 不另開一支端點（多開路由會讓不相干的 `$fetch` 報 TS2589，見
 * 記憶 `reference_nuxt_typecheck_traps`）。
 *
 * **`fid`（這一次付款嘗試的識別碼）**：中間會**整頁離開**去 PAYUNi 再回來，
 * 元件全部重新掛載，各自的 `sessionId` 接不起來。所以另存一個 id 在 sessionStorage，
 * 每一筆都帶著；回來那一刻用掉就清掉，下一次嘗試是新的一場。
 *
 * ⚠️ sessionStorage 讀不到是正常的（無痕視窗、擋了網站資料），一律 try/catch 並退回
 * 記憶體那一份：⛔ **記不到可以，壞掉不行**——這是紀錄，不是功能。
 */
import type { OnboardingEventName, OnboardingEventProps } from '~~/shared/onboarding-events'

/** 從哪個畫面進付款這一段（⛔ 只收這幾個字，不讓呼叫端自由造字） */
export type BillingFunnelSource
  = | 'quota_banner' /** 外殼上那條額度橫幅（快用完／已停止回覆） */
    | 'broadcast_lock' /** 推播被方案鎖住那一行的「查看方案」 */
    | 'billing_page' /** 方案與帳單頁自己的「升級 / 續訂」「查看方案」 */
    | 'ai_usage' /** AI 表現頁 */
    | 'organization' /** 組織設定頁 */
    | 'other'

const FUNNEL_KEY = 'minime:billing-funnel'
const GATEWAY_KEY = 'minime:billing-gateway'

/** sessionStorage 不能用時的退路（同一個分頁內仍然串得起來） */
let memoryFunnelId = ''
let memoryGateway = ''

function readStore(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? ''
  }
  catch {
    return ''
  }
}
function writeStore(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  }
  catch { /* 無痕／擋了網站資料：記不到就算了 */ }
}
function clearStore(key: string) {
  try {
    sessionStorage.removeItem(key)
  }
  catch { /* 同上 */ }
}

/** 這一次付款嘗試的識別碼；沒有就現開一個。⛔ 每次都重讀，不要在 setup 當下鎖死一份。 */
function funnelId(): string {
  if (!import.meta.client) return ''
  const existing = readStore(FUNNEL_KEY) || memoryFunnelId
  if (existing) return existing
  const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 36)
  memoryFunnelId = id
  writeStore(FUNNEL_KEY, id)
  return id
}

/** 這一場結束（從金流回來、或放棄）→ 下一次是新的一場 */
function resetFunnelId() {
  memoryFunnelId = ''
  clearStore(FUNNEL_KEY)
}

/**
 * ⚠️ 要在元件 setup 裡呼叫（底層的 `useOnboardingEvents` 要拿登入狀態、要掛卸載時的收尾）。
 * @param source 這個元件屬於哪個畫面；每一筆都會帶著，才知道哪個入口帶得動人。
 */
export function useBillingFunnel(source: BillingFunnelSource) {
  const { workspaceId } = useWorkspace()
  const { track: rawTrack, flush } = useOnboardingEvents({
    workspaceId: () => workspaceId.value,
    flow: () => 'billing',
  })

  /** `props` 裡可以自己帶 `fid` 蓋掉現在這一場（回來那一筆要用走之前那一場的 id）。 */
  function track(event: OnboardingEventName, props: OnboardingEventProps = {}) {
    rawTrack(event, { fid: funnelId(), from: source, ...props })
  }

  /**
   * 要離開本站去 PAYUNi 了：留一個記號，回來才知道「這個人是從金流回來的」，
   * 而不是自己走到帳單頁。⛔ 三條結帳路徑（方案表、繼續付款、換一張卡）都要叫。
   *
   * ⚠️ 叫完**馬上** `flush()`：`submitToGateway` 下一行就整頁導走，
   * 排隊中的那批（1.5 秒才送）會來不及（送出用的是 keepalive，送得出去就送得完）。
   */
  function markLeftForGateway(planId: string) {
    memoryGateway = planId || '1'
    writeStore(GATEWAY_KEY, memoryGateway)
    flush()
  }

  /**
   * 回到帳單頁時問一次「他是不是剛從金流回來的」。**讀完就清掉**——
   * 不清的話，之後每次打開帳單頁都會再記一筆假的「從金流回來」。
   *
   * ⛔ **回傳的 `fid` 一定要帶進那一筆事件**：這裡已經把這一場收掉了，
   * 不帶的話 `track` 會現開一個新的 id，整條漏斗就在最後一格斷掉。
   *
   * @returns `planId` 去結帳的那個方案（空字串＝不是從金流回來的，正常逛到帳單頁）；
   *          `fid` 離開前那一場的識別碼
   */
  function takeGatewayReturn(): { planId: string, fid: string } {
    const planId = readStore(GATEWAY_KEY) || memoryGateway
    const fid = funnelId()
    memoryGateway = ''
    clearStore(GATEWAY_KEY)
    if (planId) resetFunnelId() // 這一場走完了，下一次重新開一場
    return { planId, fid }
  }

  return { track, flush, markLeftForGateway, takeGatewayReturn }
}
