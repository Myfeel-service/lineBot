<template>
  <AdminShell>
    <template #sidebar>
        <!-- --brand：logotype 自己就含品牌名，所以圖／字改成上下排（超管、組織側欄仍是圖示＋字，共用同一個 .sidebar-logo 底） -->
        <div class="sidebar-logo sidebar-logo--brand">
          <BrandLogo />
          <span class="logo-sub">管理後台</span>
        </div>

        <!-- Workspace switcher -->
        <div v-if="workspaceId" class="sidebar-workspace">
          <div class="sidebar-workspace-label">目前官方帳號</div>
          <div class="sidebar-workspace-name">{{ currentWorkspaceName }}</div>
          <div v-if="showWorkspaceSwitcher" class="sidebar-workspace-actions">
            <NuxtLink to="/admin/workspaces" class="ws-sidebar-switch">
              <span class="ws-sidebar-switch__icon"><el-icon><ChatDotRound /></el-icon></span>
              <span class="ws-sidebar-switch__main">
                <span class="ws-sidebar-switch__title">{{ workspaceSwitchLabel }}</span>
                <span class="ws-sidebar-switch__sub">選擇要管理的官方帳號</span>
              </span>
              <span class="ws-sidebar-switch__arrow">→</span>
            </NuxtLink>
          </div>
        </div>

        <nav class="sidebar-nav">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="nav-item"
            :class="{ active: route.path === item.to }"
          >
            <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </NuxtLink>

          <!-- AI 客服 section -->
          <template v-if="aiNavItems.length">
            <div class="nav-section-label">AI 客服</div>
            <NuxtLink
              v-for="item in aiNavItems"
              :key="item.to"
              :to="item.to"
              class="nav-item"
              :data-tour="item.tour"
              :class="{ active: route.path.startsWith(item.to) }"
            >
              <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
            </NuxtLink>
          </template>

          <!-- Settings section (owner/admin only) -->
          <template v-if="canManageSettings">
            <div class="nav-section-label">設定</div>
            <NuxtLink :to="`/admin/${workspaceId}/settings/members`" class="nav-item" :class="{ active: route.path.includes('/settings/members') }">
              <el-icon class="nav-icon"><UserFilled /></el-icon>
              <span>成員管理</span>
            </NuxtLink>
            <NuxtLink
              :to="`/admin/${workspaceId}/settings/organization`"
              class="nav-item"
              data-tour="nav-organization"
              :class="{
                active:
                  route.path.includes('/settings/organization')
                  || route.path === `/admin/${workspaceId}/line-settings`,
              }"
            >
              <el-icon class="nav-icon"><OfficeBuilding /></el-icon>
              <span>組織與 LINE</span>
            </NuxtLink>
            <NuxtLink :to="`/admin/${workspaceId}/settings/billing`" class="nav-item" :class="{ active: route.path.includes('/settings/billing') }">
              <el-icon class="nav-icon"><CreditCard /></el-icon>
              <span>訂閱與付款</span>
            </NuxtLink>
          </template>
        </nav>
      </template>

      <template #footer>
        <div class="sidebar-footer-user">
          <div class="sidebar-footer-avatar"><el-icon><User /></el-icon></div>
          <div class="sidebar-footer-user-meta">
            <div class="sidebar-footer-email truncate text-sm font-bold">
              {{ user?.email ?? '管理員' }}
            </div>
            <div class="text-xs text-muted">{{ currentRoleLabel }}</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm w-full" @click="logout">
          <el-icon><SwitchButton /></el-icon> 登出
        </button>
      </template>

      <div v-if="isViewer" class="admin-viewer-banner" role="status">
        觀察者模式：僅能檢視資料，無法新增、儲存或發送。
      </div>
      <!-- 額度快用完 / 已用完的升級提示。掛在 layout 而不是某一頁：
           「快沒額度了」不管他人在哪一頁都該知道，而額度用完更是服務中斷。 -->
      <AdminQuotaBanner v-if="workspaceId" />
      <slot />

      <template #overlay>
        <AdminToastHost />
        <TutorialAgent v-if="workspaceId" />
      </template>
  </AdminShell>
</template>

<script setup lang="ts">
import {
  Box, ChatDotRound, Connection, CreditCard, DataLine, Grid, Lightning,
  Monitor, OfficeBuilding, Operation, PriceTag, Promotion, Reading,
  Setting, SwitchButton, Tickets, TrendCharts, User, UserFilled,
} from '@element-plus/icons-vue'

const route = useRoute()
const { user, logout } = useAuth()
const { workspaceId, currentRole, currentWorkspaceName, canManageSettings, isViewer, can, workspaceList, loadWorkspaceList } = useWorkspace()
const { checkIsSuperAdmin, isSuperAdmin } = useSuperAdmin()

const canSwitchWorkspace = computed(() => workspaceList.value.length > 1)

const showWorkspaceSwitcher = computed(() => canSwitchWorkspace.value || isSuperAdmin.value)

const workspaceSwitchLabel = computed(() =>
  isSuperAdmin.value ? '切換官方帳號' : '切換帳號',
)

onMounted(async () => {
  await checkIsSuperAdmin().catch(() => {})
  if (!user.value || workspaceList.value.length > 0)
    return
  await loadWorkspaceList().catch(() => {})
})

const ROLE_LABELS: Record<string, string> = {
  owner: '擁有者',
  admin: '管理員',
  agent: '客服',
  viewer: '觀察者',
}
const currentRoleLabel = computed(() => currentRole.value ? (ROLE_LABELS[currentRole.value] ?? currentRole.value) : 'Admin')

const navItems = computed(() => {
  const wid = workspaceId.value
  if (!wid) return []
  return [
    { to: `/admin/${wid}/conversation-stats`, icon: DataLine, label: '對話統計' },
    { to: `/admin/${wid}/conversations`, icon: ChatDotRound, label: '對話' },
    { to: `/admin/${wid}/flow`, icon: Connection, label: '機器人模組' },
    { to: `/admin/${wid}/richmenu`, icon: Grid, label: '圖文選單' },
    { to: `/admin/${wid}/auto-reply`, icon: Lightning, label: '自動回覆' },
    { to: `/admin/${wid}/support-presets`, icon: Box, label: '客服預存' },
    { to: `/admin/${wid}/tags`, icon: PriceTag, label: '標籤管理' },
    { to: `/admin/${wid}/campaigns`, icon: Tickets, label: '活動標籤' },
    { to: `/admin/${wid}/broadcasts`, icon: Promotion, label: '推播' },
    { to: `/admin/${wid}/users`, icon: User, label: '會員' },
  ]
})

// 依 capability 逐項顯示（單一事實來源 ~~/shared/permissions.ts，與 ai-feature
// middleware、後端 requireCapability 同一張表）：知識庫/腳本/設定 viewer 可讀
// （頁內寫入鈕另依 can() 隱藏）；測試對話會花 token → agent+；用量監控含計費 → admin。
const aiNavItems = computed(() => {
  const wid = workspaceId.value
  if (!wid) return []
  const items = [
    { cap: 'ai.read' as const, to: `/admin/${wid}/knowledge/sources`, icon: Reading, label: '知識庫', tour: 'nav-knowledge' },
    { cap: 'ai.read' as const, to: `/admin/${wid}/ai-scripts`, icon: Operation, label: '客服腳本', tour: 'nav-ai-scripts' },
    { cap: 'playground.use' as const, to: `/admin/${wid}/ai-playground`, icon: Monitor, label: '測試對話' },
    { cap: 'usage.read' as const, to: `/admin/${wid}/ai-usage`, icon: TrendCharts, label: '用量監控' },
    { cap: 'ai.read' as const, to: `/admin/${wid}/ai-settings`, icon: Setting, label: 'AI 設定', tour: 'nav-ai-settings' },
  ]
  return items.filter(item => can(item.cap)).map(({ cap: _cap, ...rest }) => rest)
})
</script>

<style scoped>
/* 側欄等見 assets/scss/layout/_sidebar.scss；此區塊保留給 Vite 合法 scoped CSS，避免 HMR 殘留的 ?type=style 誤解析 */
</style>
