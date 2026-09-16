<template>
  <div class="toast-bar">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">
      <span class="toast__icon"><el-icon><component :is="t.type === 'success' ? CircleCheckFilled : t.type === 'warning' ? WarningFilled : t.type === 'info' ? InfoFilled : CircleCloseFilled" /></el-icon></span>
      <span>{{ t.msg }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { CircleCheckFilled, CircleCloseFilled, InfoFilled, WarningFilled } from '@element-plus/icons-vue'
// ⛔ 型別取 composable 那一份（2026-09-16）：這裡原本自己抄了一份，
// 而 'info' 早就有人在用——兩份表漂移之後 typecheck 才紅出來。
import type { AdminToast } from '~/composables/useAdminToast'

defineProps<{
  toasts: AdminToast[]
}>()
</script>
