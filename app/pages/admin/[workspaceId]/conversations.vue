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
useHead({
  title: useAdminTitle('客服對話'),
  meta: [
    /**
     * 手機打字時鍵盤不要蓋住回覆框（`D-105`）：Android Chrome 預設鍵盤是「浮在畫面上」，
     * 版面高度不變，貼在最底下的回覆框就被蓋掉；這一句讓版面跟著縮到鍵盤上面（iPhone 不認這個，它本來就會把輸入框捲上來）。
     * ⛔ 只放這一頁：官網那種整頁捲動的頁面，鍵盤一開版面跟著縮反而會跳。
     */
    { name: 'viewport', content: 'width=device-width, initial-scale=1, interactive-widget=resizes-content' },
  ],
})

const { apiFetch } = useWorkspace()
</script>
