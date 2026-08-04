<script setup lang="ts">
/**
 * 「上傳 / 匯入」獨立頁已整併為資料頁的彈窗(KnowledgeImportDialog)。
 * 這個檔案保留只為了舊的 bookmark / deep link 不會 404:
 * 轉到資料頁並帶 ?import=1,由它自動打開匯入彈窗。
 */
definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { workspaceId } = useWorkspace()
await navigateTo(`/admin/${workspaceId.value}/knowledge/sources?import=1`, { replace: true })
</script>

<template>
  <div />
</template>
