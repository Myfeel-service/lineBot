<template>
  <slot v-if="can(capability)" />
</template>

<script setup lang="ts">
import type { Capability } from '~~/shared/permissions'

// `G-109`：要講「包在裡面的那顆按鈕打哪一項能力」——跟它背後端點的 requireCapability 同一項，
// 不再用一顆「客服以上」的大開關猜。
defineProps<{ capability: Capability }>()

const { can } = useWorkspace()
</script>
