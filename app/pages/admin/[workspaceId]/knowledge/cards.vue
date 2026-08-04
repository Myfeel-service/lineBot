<script setup lang="ts">
/**
 * 「知識管理」頁已整併進「資料管理」(知識編輯 / AI 整理 / 重新索引都在資料頁的編輯視窗)。
 * 這個檔案保留只為了舊的 bookmark / deep link 不會 404:
 * 帶 ?chunkId= 的連結(例:舊版測試對話的「編輯」)會轉到資料頁,由它反查資料並開啟編輯視窗。
 */
definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { workspaceId } = useWorkspace()
const chunkId = String(useRoute().query.chunkId ?? '').trim()
const suffix = chunkId ? `?chunkId=${encodeURIComponent(chunkId)}` : ''
await navigateTo(`/admin/${workspaceId.value}/knowledge/sources${suffix}`, { replace: true })
</script>

<template>
  <div />
</template>
