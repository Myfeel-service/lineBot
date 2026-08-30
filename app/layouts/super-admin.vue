<template>
  <AdminShell sidebar-class="sa-sidebar">
    <template #sidebar>
      <div class="sidebar-logo">
        <span class="logo-icon"><el-icon color="#fff"><Setting /></el-icon></span>
        <div>
          <span class="logo-text">超級管理員</span>
          <span class="logo-sub">系統管理後台</span>
        </div>
      </div>

      <div class="sidebar-workspace">
        <div class="sidebar-workspace-label">目前官方帳號</div>
        <div class="sidebar-workspace-name">超級管理員</div>
        <div class="sidebar-workspace-actions">
          <NuxtLink to="/admin/workspaces" class="ws-sidebar-switch">
            <span class="ws-sidebar-switch__icon"><el-icon><ChatDotRound /></el-icon></span>
            <span class="ws-sidebar-switch__main">
              <span class="ws-sidebar-switch__title">回到官方帳號</span>
              <span class="ws-sidebar-switch__sub">選擇要管理的官方帳號</span>
            </span>
            <span class="ws-sidebar-switch__arrow">→</span>
          </NuxtLink>
        </div>
      </div>

      <nav class="sidebar-nav">
        <NuxtLink to="/admin/super/organizations" class="nav-item" :class="{ active: route.path.startsWith('/admin/super/organizations') }">
          <el-icon class="nav-icon"><OfficeBuilding /></el-icon>
          <span>組織管理</span>
        </NuxtLink>
        <NuxtLink to="/admin/super/workspaces" class="nav-item" :class="{ active: route.path.startsWith('/admin/super/workspaces') }">
          <el-icon class="nav-icon"><ChatDotRound /></el-icon>
          <span>官方帳號管理</span>
        </NuxtLink>
        <NuxtLink to="/admin/super/alerts" class="nav-item" :class="{ active: route.path.startsWith('/admin/super/alerts') }">
          <el-icon class="nav-icon"><Warning /></el-icon>
          <span>異常總覽</span>
          <!-- 紅＝排程停擺或有租戶紅色異常;琥珀＝黃級/高成本;沒事不畫（同工作區側欄點的三規則） -->
          <el-tooltip v-if="alertsDotSeverity" :content="alertsDotTip" placement="right" :show-after="120">
            <span class="nav-alert-dot" :class="`is-${alertsDotSeverity}`" role="img" :aria-label="alertsDotTip" />
          </el-tooltip>
        </NuxtLink>
        <NuxtLink to="/admin/super/payments" class="nav-item" :class="{ active: route.path.startsWith('/admin/super/payments') }">
          <el-icon class="nav-icon"><Wallet /></el-icon>
          <span>金流總覽</span>
        </NuxtLink>
        <NuxtLink to="/admin/super/costs" class="nav-item" :class="{ active: route.path.startsWith('/admin/super/costs') }">
          <el-icon class="nav-icon"><Coin /></el-icon>
          <span>成本總覽</span>
        </NuxtLink>
        <NuxtLink to="/admin/super/leads" class="nav-item" :class="{ active: route.path.startsWith('/admin/super/leads') }">
          <el-icon class="nav-icon"><Message /></el-icon>
          <span>潛在客戶名單</span>
          <!-- 有還沒回覆的新名單就亮琥珀（D-43②）:官網留資料的是真實客戶,原本零提醒 -->
          <el-tooltip v-if="leadsDotCount" :content="`有 ${leadsDotCount} 位新的潛在客戶還沒有人回覆`" placement="right" :show-after="120">
            <span class="nav-alert-dot is-warning" role="img" :aria-label="`有 ${leadsDotCount} 位新的潛在客戶還沒有人回覆`" />
          </el-tooltip>
        </NuxtLink>
        <NuxtLink to="/admin/super/users" class="nav-item" :class="{ active: route.path.startsWith('/admin/super/users') }">
          <el-icon class="nav-icon"><Avatar /></el-icon>
          <span>超級管理員</span>
        </NuxtLink>
      </nav>
    </template>

    <template #footer>
      <div class="sidebar-footer-user">
        <div class="sidebar-footer-avatar"><el-icon><Avatar /></el-icon></div>
        <div class="sidebar-footer-user-meta">
          <div class="sidebar-footer-email truncate text-sm font-bold">{{ user?.email ?? '管理員' }}</div>
          <div class="text-xs sa-role-badge">超級管理員</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm w-full" @click="logout">
        <el-icon><SwitchButton /></el-icon> 登出
      </button>
    </template>

    <slot />

    <template #overlay>
      <AdminToastHost />
    </template>
  </AdminShell>
</template>

<script setup lang="ts">
import { Avatar, ChatDotRound, Coin, Message, OfficeBuilding, Setting, SwitchButton, Wallet, Warning } from '@element-plus/icons-vue'

const route = useRoute()
const { user, logout } = useAuth()

// 全站異常的側欄點（C-91）:layout 掛載抓一次,之後靠 composable 的 TTL＋端點 5 分鐘快取,
// 換頁不會重掃全租戶
const { navSeverity: alertsDotSeverity, leadsDotCount, refresh: refreshSuperAlerts } = useSuperAlerts()
const alertsDotTip = computed(() =>
  alertsDotSeverity.value === 'critical' ? '有帳號的客人正在受影響，或背景排程停擺' : '有事情建議處理')
onMounted(() => { refreshSuperAlerts() })
</script>
