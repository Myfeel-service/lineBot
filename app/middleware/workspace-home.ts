import { can } from '~~/shared/permissions'

/**
 * `/admin/{wid}` 的預設落點（`G-13`，2026-10-20 老闆照建議）：帳號選擇頁、組織頁的「進入」都先到這裡。
 * 沒接上 LINE 的帳號落測試對話（跟打造那一趟的出口同一頁），其他照舊落對話統計——判斷在 `workspaceHomePath`。
 *
 * ⛔ 為什麼是 middleware、不是在頁面 setup 裡 `await navigateTo`：2026-10-20 實測舊的頁面寫法
 *    （改之前就是這樣）直接打 `/admin/{wid}` 會落到**整頁空白**（網址對了、什麼都沒畫），
 *    從帳號選擇頁點進去也會丟兩個 Vue 例外、主內容區空白。在 middleware 轉址＝那一頁根本不渲染，兩個都沒了。
 * ⚠️ 這時 `useRoute()` 還是**上一頁**，所以帳號要自己帶（`refresh({ workspaceId })`／`statusOf`／`roleFor`）。
 * ⚠️ 體檢查不到或太慢（`WORKSPACE_HOME_STATUS_WAIT_MS`）就照舊落對話統計：查不到≠沒接。
 *    查到的那份記在共用狀態裡，落地後版型、小幫手的 `refresh()` 吃 60 秒 TTL，不會再打一次。
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const wid = String(to.params.workspaceId || '').trim()
  if (!wid)
    return
  const setup = useSetupStatus()
  const { roleFor } = useWorkspace()
  await Promise.race([
    setup.refresh({ workspaceId: wid }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, WORKSPACE_HOME_STATUS_WAIT_MS)),
  ])
  return navigateTo(
    workspaceHomePath(wid, setup.statusOf(wid, 'lineConnected'), can(roleFor(wid), 'playground.use')),
    { replace: true },
  )
})
