<template>
  <!-- 選項鈕長在對話流的最新訊息下面（LINE 快速按鈕的位置，2026-08-19 老闆拍板）。
       靠右＝使用者這一側：按鈕就是「你可以說的話」，點了會變成右側的使用者泡泡。
       ⛔ 別搬回底部 dock——面板高、對話短的時候，釘在底部等於離最新訊息半個螢幕遠 -->
  <div v-if="ask.kind === 'choices'" class="agm-choices">
    <el-button
      v-for="opt in ask.options"
      :key="opt.value"
      :type="opt.primary ? 'primary' : 'default'"
      round
      :disabled="busy"
      @click="$emit('choice', opt.value)"
    >{{ opt.label }}</el-button>
  </div>
</template>

<script setup lang="ts">
import type { AgentAsk } from '~~/shared/types/agent-messages'

defineProps<{ ask: AgentAsk, busy?: boolean }>()
defineEmits<{ choice: [value: string] }>()
</script>

<!-- 樣式在 app/assets/scss/components/_agent-chat.scss（.agm-choices） -->
