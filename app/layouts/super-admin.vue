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
import { Avatar, ChatDotRound, Coin, Message, OfficeBuilding, Setting, SwitchButton, Wallet } from '@element-plus/icons-vue'

const route = useRoute()
const { user, logout } = useAuth()
</script>
