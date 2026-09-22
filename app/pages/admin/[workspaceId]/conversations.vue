<template>
  <ConversationsAdminPanel :api-fetch="apiFetch" />
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth', layout: 'default' })

/**
 * 這一頁先前**沒有**標題（整個後台就漏了這頁），所以瀏覽器分頁上是一片空白，
 * 而 AdminPanel 那支「把未讀數掛到分頁標題」的程式碼拿不到底稿就整段不動作
 * ——寫了也等於沒有，2026-09-22 實機驗證才發現。名字跟側欄選單同一個（G-27⑤）。
 */
useHead({ title: useAdminTitle('客服對話') })

const { apiFetch } = useWorkspace()
</script>
