<template>
  <!-- 側欄狀態點：這一頁現在有沒有事。沒事就什麼都不畫（⛔不畫綠燈——見 script 註解） -->
  <el-tooltip v-if="hit" :content="tip" placement="right" :show-after="120">
    <span
      class="nav-alert-dot"
      :class="`is-${hit.severity}`"
      role="img"
      :aria-label="tip"
    />
  </el-tooltip>
</template>

<script setup lang="ts">
/**
 * 側欄那一顆點（2026-08-26 `D-33` P0-1）。
 *
 * 訊號來源＝`useWorkspaceAlerts().navAlerts`，跟右下角小幫手**同一份資料**、不打新查詢。
 * 三條規則寫在這裡，別在呼叫端各自加條件：
 *
 * 1. **只畫壞掉的**：紅＝客人正在受影響、琥珀＝該處理但客人還沒被影響。
 *    建議類（「AI 可以幫你更好」）不上側欄——老闆 2026-08-26 拍板，理由是建議常年都有，
 *    掛上去一個月後那顆點永遠亮著，整排會被當成裝飾。
 * 2. **沒事、查不到、沒權限＝什麼都不畫**，也不寫「正常」。系統沒在檢查的頁面畫綠燈
 *    就是說謊（`2026-08-09` 踩過：背景載入失敗被吞掉→回空陣列→綠燈照亮）。
 * 3. **開通還沒做完的帳號整排不畫**（老闆 2026-08-26 拍板）：那段路已經有滿版開通引導
 *    ＋小幫手英雄卡在帶，側欄只負責講「本來會動的東西壞了」。⛔ 也要求 setup 狀態
 *    `loaded` 才畫——不然新帳號會先閃一排點再消失。
 *
 * ⛔ 不顯示數字（同日拍板）：點只回答「去哪一頁」，數量進到頁面才有意義；掛在側欄
 *    等於逼使用者記住一個他當下無法核對的數。
 */
const props = defineProps<{
  /** 這個側欄項的路徑（就是 NuxtLink 的 to，不帶查詢字串） */
  path: string
}>()

const { navAlerts } = useWorkspaceAlerts()
const { onboardingIncomplete, loaded: setupLoaded } = useSetupStatus()

const hit = computed(() => {
  if (!setupLoaded.value || onboardingIncomplete.value)
    return undefined
  return navAlerts.value[props.path]
})

/** 滑過去講一句白話：幾件事、分別是什麼。標題來自 shared 的 ALERT_LABELS，與小幫手同一句 */
const tip = computed(() => {
  const h = hit.value
  if (!h)
    return ''
  const lead = h.severity === 'critical' ? '客人正在受影響' : '有事情要處理'
  return `${lead}：${h.titles.join('、')}`
})
</script>

<!-- 樣式在 app/assets/scss/layout/_sidebar.scss（跟 .nav-item 住在一起） -->
