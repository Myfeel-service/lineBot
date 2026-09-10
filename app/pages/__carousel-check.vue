<template>
  <div style="max-width: 720px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; background: #f3f4f6; min-height: 100vh;">
    <div v-for="(steps, name) in ONBOARDING_CAROUSELS" :key="name" :data-carousel="name" style="display: flex; flex-direction: column;">
      <div style="font: 600 12px system-ui; color: #606266; margin-bottom: 4px;">{{ name }}</div>
      <AgentStepCarousel :steps="steps" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 步驟輪播的驗收台（`scripts/onboarding-carousel-check.mjs` 開這一頁量版面、驗行為）。
 *
 * 為什麼需要一個獨立的頁：開通引導那條路要走完整個狀態機、還要真的貼連線資訊才看得到
 * 這些輪播，而它是**純呈現層**——單獨掛起來就驗得完，不用碰任何正式資料。
 *
 * ⛔ **只在 dev 開**：這頁不是產品的一部分，正式站上出現一個列出全部教學圖的裸頁沒有意義。
 * ⛔ 加新輪播時不用改這頁：它直接跑 `ONBOARDING_CAROUSELS` 的每一支。
 */
import { ONBOARDING_CAROUSELS } from '~/utils/onboarding-shots'

definePageMeta({ layout: false })

if (!import.meta.dev)
  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
</script>
