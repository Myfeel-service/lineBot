/**
 * 開通步驟紀錄的前端那一半（`C-250`③，`D-100` C-1）。事件表在 `shared/onboarding-events.ts`。
 *
 * - `track()` 先排隊，1.5 秒湊一批送出；離開頁面（元件卸載、分頁收起）時把剩下的送掉
 * - ⛔ 送失敗不講、不重試、不擋任何事：這是紀錄，不是功能——紀錄壞掉不可以讓精靈卡住
 * ⚠️ 要在元件 setup 裡呼叫（要拿登入狀態、要掛卸載時的收尾）
 */
import type { OnboardingEventName, OnboardingEventProps } from '~~/shared/onboarding-events'

const FLUSH_MS = 1500
const MAX_BATCH = 30

export function useOnboardingEvents(ctx: { workspaceId: () => string, flow: () => 'build' | 'line' | 'other' }) {
  // 跟 `useWorkspaceApiFetch` 同一個來源（⛔ 不用 `useAuth().user`：那是 useState 包過的 reactive 代理）
  const { $auth } = useNuxtApp()
  /** 同一次打開精靈＝同一場（換頁、重新整理就是新的一場） */
  const sessionId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 36)
  let queue: Array<{ event: OnboardingEventName, props: OnboardingEventProps, at: number }> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let token = ''

  async function refreshToken() {
    try {
      token = (await $auth.currentUser?.getIdToken()) ?? ''
    }
    catch { /* 拿不到就這一批不送 */ }
  }

  function send(batch: typeof queue) {
    if (!batch.length || !token) return
    try {
      // keepalive：分頁關掉的那一刻也送得出去（⛔ 不用 sendBeacon：它帶不了登入的 header）
      void fetch('/api/onboarding/events', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ sessionId, flow: ctx.flow(), workspaceId: ctx.workspaceId() || undefined, events: batch }),
      }).catch(() => {})
    }
    catch { /* 紀錄壞掉不可以讓精靈卡住 */ }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const batch = queue.slice(0, MAX_BATCH)
    queue = queue.slice(MAX_BATCH)
    // ⚠️ 登入憑證還沒拿到（剛 track 完馬上離開）就等它一下再送——⛔ 不可以直接丟掉那一批：
    //    「最後一步停在哪」正是離開那一刻才記的
    if (token) send(batch)
    else if (batch.length) void refreshToken().then(() => send(batch))
    if (queue.length) timer = setTimeout(flush, FLUSH_MS)
  }

  function track(event: OnboardingEventName, props: OnboardingEventProps = {}) {
    queue.push({ event, props, at: Date.now() })
    void refreshToken()
    if (!timer) timer = setTimeout(flush, FLUSH_MS)
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(flush)
  }
  if (import.meta.client) {
    window.addEventListener('pagehide', flush)
    if (getCurrentInstance()) onBeforeUnmount(() => window.removeEventListener('pagehide', flush))
  }

  return { track, flush }
}
