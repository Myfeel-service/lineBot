<template>
  <div />
</template>

<script setup lang="ts">
/**
 * /admin 本身沒有內容，只是個入口 → 直接送到帳號選擇頁。
 *
 * 這個檔案原本不存在，於是 /admin 連路由都比對不到 —— middleware 根本沒機會跑，
 * 使用者拿到的是 Nuxt 裸的錯誤頁（「Page not found: /admin」）。auth middleware
 * 裡本來就寫了「沒有 workspaceId 就導去 /admin/workspaces」，缺的只是這個路由。
 */
definePageMeta({
  middleware: ['auth', () => navigateTo('/admin/workspaces', { replace: true })],
  layout: false,
})
</script>
