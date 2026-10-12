<template>
  <!-- 後台外殼：側欄（可捲區 + 固定 footer）＋ 主內容區。
       default / super-admin 兩個 layout 與組織頁共用同一套骨架，避免各自手抄一份。
       樣式見 assets/scss/layout/_sidebar.scss 與 _main.scss。 -->
  <div class="layout-wrapper" :class="{ 'is-nav-open': navOpen }">
    <!-- 手機才看得到的頂列（`E-13` 的第一步，2026-10-12 `D-124`）：側欄在手機上改成從左邊滑出來，
         以前固定 240px 佔掉 390px 手機的一大半、內容只剩一條。電腦版這一列是 display:none -->
    <header class="shell-topbar">
      <button
        type="button"
        class="shell-topbar__menu"
        aria-label="打開選單"
        :aria-expanded="navOpen"
        @click="navOpen = true"
      >
        <!-- ⛔ 不用 Element Plus 的 `Menu`：那顆是四個方塊，看起來像「全部功能」不像選單 -->
        <el-icon><Expand /></el-icon>
      </button>
      <div class="shell-topbar__title">
        <slot name="topbar" />
      </div>
    </header>

    <!-- 點選單裡的連結或按鈕就收起來：點的是「現在這一頁」時路由不會變，光靠下面的 watch 收不起來 -->
    <aside class="sidebar" :class="sidebarClass" @click="closeOnAction">
      <div class="sidebar-scroll">
        <slot name="sidebar" />
      </div>
      <div v-if="$slots.footer" class="sidebar-footer">
        <slot name="footer" />
      </div>
    </aside>
    <div class="shell-backdrop" aria-hidden="true" @click="navOpen = false" />

    <main class="main-content">
      <slot />
    </main>

    <!-- 掛在 wrapper 層、與 sidebar/main 同級的東西（Toast、導覽 agent 等） -->
    <slot name="overlay" />
  </div>
</template>

<script setup lang="ts">
import { Expand } from '@element-plus/icons-vue'

defineProps<{ sidebarClass?: string }>()

/** 手機上側欄有沒有滑出來（電腦版側欄一直都在，這個值用不到） */
const navOpen = ref(false)
const route = useRoute()
watch(() => route.fullPath, () => { navOpen.value = false })

function closeOnAction(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest('a, button')) navOpen.value = false
}
</script>
