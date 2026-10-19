<script setup lang="ts">
/**
 * 進帳號的預設落點（`G-13`）：轉址在 `workspace-home` middleware 做完，這一頁永遠不會畫出來。
 * ⛔ 別改回在這裡 `await navigateTo`：那樣直接打 `/admin/{wid}` 會整頁空白（原因見 middleware 檔頭）。
 */
definePageMeta({ middleware: ['auth', 'workspace-home'], layout: 'default' })
</script>

<template>
  <div />
</template>
