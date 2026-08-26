<template>
  <div v-if="rows.length" class="page-alert-strip" role="alert">
    <AdminBlockStatus
      v-for="r in rows"
      :key="r.alert.id"
      :tone="r.alert.severity === 'critical' ? 'critical' : 'warning'"
      :title="rowTitle(r.alert)"
      :detail="rowDetail(r.alert)"
      :action-label="rowActionLabel(r)"
      @action="go(r)"
    />
  </div>
</template>

<script setup lang="ts">
import type { ResolvedAlert } from '~/composables/useWorkspaceAlerts'

/**
 * 頁面級提醒條（2026-08-27，D-33 二輪——老闆實看後的回饋）。
 *
 * 一輪做完側欄的點之後老闆點進頁面，反應是「我不知道我要做什麼、也不知道異常在哪邊」：
 * 點只回答「去哪一頁」，人到了頁面沒有東西接手。這條掛在 layout（AdminQuotaBanner 旁），
 * 所以**每一頁的提醒都在同一個位置、同一個長相**——列出這一頁現在有的事＋一顆下一步按鈕。
 *
 * 三條紀律（跟側欄的點同一套，改之前先讀 useWorkspaceAlerts 的註解）：
 * 1. 資料吃 `alertsForPath`＝與側欄的點**同一個展開**。點亮在哪頁、這條就在哪頁列出同一批事，
 *    ⛔不要自己再過濾一輪。
 * 2. 沒事就整條不出現。不畫綠燈、不寫「一切正常」——沒檢查的事說正常是說謊。
 * 3. 開通沒做完的帳號不顯示（滿版開通引導＋小幫手英雄卡在帶那段路）。
 *
 * 按鈕的兩種走法：
 * - 深連結指到**別的狀態**（?tab=／?health=／?verify=）→ 這些頁的 deep-link 都在 onMounted
 *   讀 query（實查過 conversations／knowledge／organization 三頁），同頁 SPA 推 query 不會有反應，
 *   所以**同頁帶 query 一律走整頁重載**（external），讓 onMounted 重跑。跨頁照常 SPA 導航。
 * - 深連結就是本頁本身（無 query，例：壞模組落在圖文選單）→ 不給按鈕，「在哪一格」由
 *   頁內的區塊狀態列／標紅接手（AdminBlockStatus 的那一層）。
 */
const route = useRoute()
const { alertsForPath, refresh } = useWorkspaceAlerts()
const { onboardingIncomplete, loaded: setupLoaded } = useSetupStatus()

const rows = computed(() => {
  if (!setupLoaded.value || onboardingIncomplete.value)
    return []
  return alertsForPath(route.path)
})

/** 標題＝跟小幫手同一句（ALERT_LABELS）＋件數。⛔別在這裡改寫標題，兩處講不同話會漂 */
function rowTitle(a: ResolvedAlert): string {
  return a.count ? `${a.title}（${a.count}）` : a.title
}

function rowDetail(a: ResolvedAlert): string {
  const parts = [a.impact]
  if (a.detail)
    parts.push(a.detail)
  // 系統端的狀況要明講「不用你操作」，否則使用者會反覆找能按的東西（D-8③ 拍板）
  if (a.owner === 'system')
    parts.push('這是系統端的狀況，不用你操作。')
  return parts.join(' ')
}

function rowActionLabel(r: { alert: ResolvedAlert, to: string }): string {
  // 深連結就是本頁自己（沒有帶任何狀態）→ 按了等於原地不動，不給按鈕
  if (r.to === route.path)
    return ''
  return r.alert.cta
}

function go(r: { alert: ResolvedAlert, to: string }) {
  const [path] = r.to.split('?')
  // 同一頁、帶 query：deep-link 處理都在 onMounted，SPA 推 query 不會有反應 → 整頁重載
  if (path === route.path) {
    void navigateTo(r.to, { external: true })
    return
  }
  void navigateTo(r.to)
}

// TTL 節流（60 秒內不重打）＋與小幫手共用 inflight，直接進頁也有資料可畫
onMounted(() => { void refresh() })
</script>

<!-- 樣式在 app/assets/scss/components/_block-status.scss（同批 D-33 元件） -->
