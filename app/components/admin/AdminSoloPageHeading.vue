<template>
  <div class="admin-flex-1">
    <AdminFieldLabel :text="props.fieldLabel" tight />
    <div class="admin-title-row">
      <span class="split-editor-title">{{ props.title }}</span>
    </div>
    <!-- caption 之後可再接一段（例：連到姊妹頁的連結）。純文字說明用 prop 就好，
         需要連結／標記時才用 slot——字串 prop 塞不進 <a>。 -->
    <p v-if="props.caption || $slots.caption" class="text-sm text-muted admin-subtext">
      {{ props.caption }}<slot name="caption" />
    </p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  fieldLabel: string
  title: string
  caption?: string
}>()
</script>
