<template>
  <div class="block-status" :class="`is-${props.tone}`" role="status">
    <el-icon class="block-status__icon"><component :is="icon" /></el-icon>
    <div class="block-status__main">
      <p class="block-status__title">{{ props.title }}</p>
      <p v-if="props.detail" class="block-status__detail">{{ props.detail }}</p>
      <slot />
    </div>
    <el-button
      v-if="props.actionLabel"
      class="block-status__action"
      size="small"
      text
      type="primary"
      @click="emit('action')"
    >
      {{ props.actionLabel }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { CircleCheckFilled, CircleCloseFilled, QuestionFilled, WarningFilled } from '@element-plus/icons-vue'

/**
 * 區塊狀態列（2026-08-26 `D-33` P0-3）——「這一格出了什麼事、為什麼、怎麼修」。
 *
 * 為什麼要有這個共用元件：小幫手的異常卡只講到「哪一頁」，進到那一頁之後沒有東西
 * 接手說「就是這一格」。使用者按了「去檢查設定」，然後在頁面上迷路。
 *
 * 視覺與語意都照腳本編輯器那條健康狀態列（`.scripts-flow-status`）——那一套是全站最好的
 * 範例（紅／黃／綠三態＋有問題的步驟標點＋就地給修法），⛔別在各頁重刻一份，會漂掉。
 *
 * 四種語氣：
 * - `critical`：客人正在受影響（客人按了收不到、流程走不出去）
 * - `warning`：該處理，但客人還沒被影響
 * - `ok`：檢查過沒問題。⚠️**只有真的查成功才准用**——「查不到就當沒問題」這個坑踩過
 *   （`2026-08-09`：背景載入失敗被 catch 吞掉→回空陣列→綠燈照亮）
 * - `unknown`：這次查不到。要現形，不能靜靜當成沒事
 */
const props = defineProps<{
  tone: 'critical' | 'warning' | 'ok' | 'unknown'
  /** 一句話講後果，不是講原理（例：客人按這裡收不到任何訊息） */
  title: string
  /** 補充：是哪一個、為什麼 */
  detail?: string
  /** 有動作才給按鈕（例：去看這一格） */
  actionLabel?: string
}>()

const emit = defineEmits<{ action: [] }>()

const ICONS = {
  critical: CircleCloseFilled,
  warning: WarningFilled,
  ok: CircleCheckFilled,
  unknown: QuestionFilled,
}
const icon = computed(() => ICONS[props.tone])
</script>

<!-- 樣式在 app/assets/scss/components/_block-status.scss -->
