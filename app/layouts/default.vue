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

        <!-- 四段各自包一層 .nav-group：「認識後台」總覽導覽要能一次高亮整段
             （每天在用的／好友經營／AI 客服／設定），指單一列講不出這一段是幹什麼的。
             ⛔ 不能用 display:contents 包——那樣元素沒有盒子，el-tour 量不到位置＝按了沒高亮。
             .nav-group 自己也是 flex 直欄、gap 跟 .sidebar-nav 同值，所以列距與縮排跟包之前一樣。 -->
        <nav class="sidebar-nav">
          <!-- ⛔ 第一段的小標是 2026-09-04 補的，不要再拿掉：拉出「好友經營」之後，
               沒有小標的那一段會變成四段裡唯一沒標題的一段，看起來像漏做的。
               這一段的標題刻意講「多久用一次」不講主題——它裝的就是天天要開的那幾頁。 -->
          <div class="nav-group" data-tour="nav-group-daily">
            <div class="nav-section-label">每天在用的</div>
            <NuxtLink
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              class="nav-item"
              :data-tour="item.tour"
              :class="{ active: route.path === item.to || (item.alsoActiveOn ?? []).includes(route.path) }"
            >
              <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
              <AdminNavAlertDot :path="item.to" />
            </NuxtLink>
          </div>

          <!-- 好友經營 section（G-44）：名單 → 貼標分群 → 只發給其中一群，見 crmNavItems 註解 -->
          <div class="nav-group" data-tour="nav-group-crm">
            <div class="nav-section-label">好友經營</div>
            <NuxtLink
              v-for="item in crmNavItems"
              :key="item.to"
              :to="item.to"
              class="nav-item"
              :data-tour="item.tour"
              :class="{ active: route.path === item.to || (item.alsoActiveOn ?? []).includes(route.path) }"
            >
              <el-icon class="nav-icon"><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
              <AdminNavAlertDot :path="item.to" />
            </NuxtLink>
          </div>

          <!-- AI 客服 section -->
          <div v-if="aiNavItems.length" class="nav-group" data-tour="nav-group-ai">
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
              <AdminNavAlertDot :path="item.to" />
            </NuxtLink>
          </div>

          <!-- Settings section (owner/admin only) -->
          <div v-if="canManageSettings" class="nav-group" data-tour="nav-group-settings">
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
              <AdminNavAlertDot :path="`/admin/${workspaceId}/settings/organization`" />
            </NuxtLink>
            <NuxtLink :to="`/admin/${workspaceId}/settings/billing`" class="nav-item" :class="{ active: route.path.includes('/settings/billing') }">
              <el-icon class="nav-icon"><CreditCard /></el-icon>
              <span>訂閱與付款</span>
              <AdminNavAlertDot :path="`/admin/${workspaceId}/settings/billing`" />
            </NuxtLink>
          </div>
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
      <!-- 頁面級提醒條（D-33 二輪）：這一頁現在有的事＋下一步按鈕。
           掛在 layout＝每一頁同位置同長相；哪頁有事由側欄的點的同一份資料決定。 -->
      <AdminPageAlertStrip v-if="workspaceId" />
      <slot />

      <template #overlay>
        <AdminToastHost />
        <TutorialAgent v-if="workspaceId" />
        <!-- 一鍵修確認 popup（D-34）：只掛這一份，提醒帶與小幫手兩個入口共用（useAlertFix） -->
        <AdminAlertFixDialog v-if="workspaceId" />
      </template>
  </AdminShell>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import {
  Box, ChatDotRound, Connection, CreditCard, DataLine, Grid, Lightning,
  Monitor, OfficeBuilding, PriceTag, Promotion, Reading,
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
  if (user.value && workspaceList.value.length === 0)
    await loadWorkspaceList().catch(() => {})
  void maybePopOnboarding()
})

// ── 開通沒做完就每次進後台都拉回開通對話（2026-08-19 拍板） ────
// 「每次進入」＝每次整頁載入（重新整理、新分頁、隔天回來都會再跳）；
// 同一次載入內只跳一次——按「之後再說」出來落在對話頁，不能又被抓回去無限循環。
// 判定吃 useSetupStatus.onboardingIncomplete（接 LINE＋第一則訊息，admin 才會 true），
// 做完就永遠安靜。⛔用 useState 不用 sessionStorage：F5 重整要重新提醒。
const setup = useSetupStatus()
const onboardingPopped = useState<Record<string, boolean>>('onb-auto-popped', () => ({}))

async function maybePopOnboarding() {
  const wid = workspaceId.value
  if (!wid || onboardingPopped.value[wid])
    return
  await setup.refresh().catch(() => {})
  if (!setup.onboardingIncomplete.value)
    return
  onboardingPopped.value = { ...onboardingPopped.value, [wid]: true }
  await navigateTo(`/admin/onboarding?workspaceId=${wid}`)
}

// 同一次載入內切換到另一個沒做完的帳號，也要各提醒一次（各帳號各自記）
watch(workspaceId, () => { void maybePopOnboarding() })

const ROLE_LABELS: Record<string, string> = {
  owner: '擁有者',
  admin: '管理員',
  agent: '客服',
  viewer: '觀察者',
}
const currentRoleLabel = computed(() => currentRole.value ? (ROLE_LABELS[currentRole.value] ?? currentRole.value) : 'Admin')

interface NavItem {
  to: string
  icon: Component
  label: string
  tour?: string
  /** 這一項底下還有別的路由（同一個入口的其他分頁）時，停在那些路徑也要亮起來 */
  alsoActiveOn?: string[]
}

const navItems = computed<NavItem[]>(() => {
  const wid = workspaceId.value
  if (!wid) return []
  return [
    { to: `/admin/${wid}/conversation-stats`, icon: DataLine, label: '對話統計' },
    // 「客服對話」＝讓它跟「好友」的分工自我解釋（G-26③）：這頁是收件匣（有人在等回話），
    // 「好友」那頁是名單（要找出一群人）。老闆問「兩者要不要併」，答案是不併但要講清楚各自幹什麼。
    // ⛔ 只加限定詞給這一項，**不動「好友」**：08-23 拍板這群人一律叫「好友」（LINE 後台的用詞），
    //    改成「客戶名單」會又生出第三個名字，等於重演「同一頁三個名稱」那個坑。
    { to: `/admin/${wid}/conversations`, icon: ChatDotRound, label: '客服對話' },
    { to: `/admin/${wid}/flow`, icon: Connection, label: '機器人模組' },
    { to: `/admin/${wid}/richmenu`, icon: Grid, label: '圖文選單' },
    { to: `/admin/${wid}/support-presets`, icon: Box, label: '客服預存' },
    // 「自動回應」＝客人講話、系統自動回。一句話回一件事與多步驟流程是同一種設定的不同深度
    // （見腳本頁的簡單模式），所以只有一個入口。舊的「自動回覆規則」已於 2026-08-09 下架。
    {
      to: `/admin/${wid}/ai-scripts`,
      icon: Lightning,
      label: '自動回應',
      tour: 'nav-auto-response',
    },
  ]
})

/**
 * 「好友經營」段（`G-44`，2026-09-04 老闆拍板拉出來）。
 *
 * 為什麼拆：原本這四項混在第一段裡，那段長到 10 項、是整個側欄最長的一段，而且
 * 「標籤管理」與「活動標籤」相鄰卻看不出跟誰是一夥的。這四項合起來有一條**故事線**——
 * 名單（好友）→ 貼標分群（標籤管理／活動標籤）→ 只發給其中一群（推播），
 * 第一次看就知道「經營名單的事都在這」。
 *
 * ⛔ 不要只把兩顆標籤頁拉出來：那會把標籤跟**用標籤的地方**（好友篩選、推播分眾）切開，
 *   兩顆自成一段也講不出這段是幹什麼的。
 * ⛔ 這一段沒有 capability 閘門（跟第一段同級，viewer 也看得到），所以模板不加 v-if——
 *   加了會讓導覽第二步在某些角色下指向不存在的元素。
 */
const crmNavItems = computed<NavItem[]>(() => {
  const wid = workspaceId.value
  if (!wid) return []
  return [
    // ⛔ 叫「好友」不叫「會員」（2026-08-23 拍板）：LINE 後台自己就這樣叫，而「會員」
    // 會讓店家以為有註冊／等級。**側欄名＝指路用的名字**，週報等訊息都照它寫。
    { to: `/admin/${wid}/users`, icon: User, label: '好友' },
    { to: `/admin/${wid}/tags`, icon: PriceTag, label: '標籤管理' },
    { to: `/admin/${wid}/campaigns`, icon: Tickets, label: '活動標籤' },
    { to: `/admin/${wid}/broadcasts`, icon: Promotion, label: '推播' },
  ]
})

// 依 capability 逐項顯示（單一事實來源 ~~/shared/permissions.ts，與 ai-feature
// middleware、後端 requireCapability 同一張表）：知識庫/設定/AI 表現 viewer 可讀
// （頁內寫入鈕另依 can() 隱藏）；測試對話會花 token → agent+。
// AI 表現頁 2026-08-10 從 usage.read 降到 ai.read：第一線客服要看得到自己照顧的 AI
// 做得好不好，計費相關（方案額度）改由 API 逐欄位擋。
const aiNavItems = computed(() => {
  const wid = workspaceId.value
  if (!wid) return []
  const items = [
    // ⛔ 客服腳本不在這裡：它就是上一組的「自動回應」。
    // 這裡再放一個入口＝同一件事兩個進入點，會讓「該用哪一邊」的問題重新長回來。
    // 順序照**日常動線**排（看 → 補 → 驗 → 調），不是照第一次設定的動線：
    // 設定只做一次，看表現天天做。表現頁說「這幾題答不出來」→ 去知識庫補 → 回測試對話驗。
    // 新帳號落在空頁也不成問題——AI 未啟用時這頁的狀態列本身就是「去啟用」的入口。
    { cap: 'ai.read' as const, to: `/admin/${wid}/ai-usage`, icon: TrendCharts, label: 'AI 表現' },
    { cap: 'ai.read' as const, to: `/admin/${wid}/knowledge/sources`, icon: Reading, label: '知識庫', tour: 'nav-knowledge' },
    { cap: 'playground.use' as const, to: `/admin/${wid}/ai-playground`, icon: Monitor, label: '測試對話' },
    { cap: 'ai.read' as const, to: `/admin/${wid}/ai-settings`, icon: Setting, label: 'AI 設定', tour: 'nav-ai-settings' },
  ]
  return items.filter(item => can(item.cap)).map(({ cap: _cap, ...rest }) => rest)
})
</script>

<style scoped>
/* 側欄等見 assets/scss/layout/_sidebar.scss；此區塊保留給 Vite 合法 scoped CSS，避免 HMR 殘留的 ?type=style 誤解析 */
</style>
