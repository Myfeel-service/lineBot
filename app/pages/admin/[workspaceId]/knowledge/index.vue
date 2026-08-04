<script setup lang="ts">
/**
 * 舊版「知識庫總覽」已下線；點知識庫直接進資料管理。
 * 這個檔案保留只為了舊的 bookmark / deep link 不會 404，會立刻 redirect 到 /sources。
 */
definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { workspaceId } = useWorkspace()
await navigateTo(`/admin/${workspaceId.value}/knowledge/sources`, { replace: true })
</script>

<template>
  <div />
</template>
