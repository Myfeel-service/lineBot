<template>
  <!-- 側欄狀態點：這一頁現在有沒有事。沒事就什麼都不畫（⛔不畫綠燈——見 utils 的規則 2） -->
  <el-tooltip v-if="dot" :content="dot.tip" placement="right" :show-after="120">
    <span
      class="nav-alert-dot"
      :class="`is-${dot.severity}`"
      role="img"
      :aria-label="dot.tip"
    />
  </el-tooltip>
</template>

<script setup lang="ts">
/**
 * 側欄那一顆點（2026-08-26 `D-33` P0-1；08-27 老闆問「開通異常側欄要不要也亮」→ 加開通那一顆）。
 *
 * 判斷規則整份住在 `app/utils/nav-alert-dot.ts`（純函式、有測試），這裡只負責把現成的狀態
 * 餵進去 —— ⛔不要在這個檔裡長出第四個條件，規則分兩處就是下一個「各說各話」的起點。
 * 動畫也只有一次（出現的那一下），理由寫在 `layout/_sidebar.scss` 的 `.nav-alert-dot`。
 */
import { navAlertDot } from '~/utils/nav-alert-dot'

const props = defineProps<{
  /** 這個側欄項的路徑（就是 NuxtLink 的 to，不帶查詢字串） */
  path: string
}>()

const { navAlerts } = useWorkspaceAlerts()
const { onboardingIncomplete, onboardingBand, onboardingNavPath, loaded: setupLoaded } = useSetupStatus()

const dot = computed(() => navAlertDot({
  path: props.path,
  setupLoaded: setupLoaded.value,
  onboardingIncomplete: onboardingIncomplete.value,
  onboardingNavPath: onboardingNavPath.value,
  onboardingTip: onboardingBand.value.navTip,
  navAlerts: navAlerts.value,
}))
</script>

<!-- 樣式在 app/assets/scss/layout/_sidebar.scss（跟 .nav-item 住在一起） -->
