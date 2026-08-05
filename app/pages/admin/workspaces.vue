<template>
  <div class="ws-select-page">
    <div class="ws-select-card">
      <div class="ws-select-logo">
        <!-- logotype 已含品牌名，h1 只補「管理後台」；讀出來仍是「MiniMe 管理後台」 -->
        <h1><BrandLogo /><span>管理後台</span></h1>
      </div>
      <p class="ws-select-sub">選擇要管理的官方帳號</p>

      <div v-if="loading" class="ws-select-loading">
        <div class="spinner" />
        <span>載入中…</span>
      </div>

      <!--
        沒有任何存取權限時的迎賓頁（三岔路，不是死路）。

        會走到這裡的人分三種，過去只服務到第二種：
          ① 想開始使用的新客 —— 走進登入卻無處可去。給他一個「開始使用」的主要出口，
             一鍵用登入信箱加入候補（自助開通精靈上線前的過渡；上線後改導精靈）。
          ② 被團隊邀請、但管理員還沒加到他的成員 —— 顯示登入信箱＋複製，交給管理員邀請。
          ③ 想先了解 / 企業需求 —— 導到聯繫我們 / 預約 Demo。

        刻意**不放購買按鈕**：他還沒有官方帳號、沒接 LINE，而我們賣「每月 AI 回覆則數」，
        等於叫還沒有車的人先買油。導購靠「先免費把車開回家」，不靠在這裡塞結帳。
      -->
      <template v-else-if="groupedWorkspaces.length === 0">
        <div class="ws-select-empty">
          <p class="ws-empty-title">歡迎使用{{ brandName }}</p>
          <p class="text-xs text-muted ws-empty-lead">選一個最符合你狀況的方式繼續：</p>

          <!-- ① 想開始使用 → 自助開通精靈（建立自己的組織＋第一個帳號＋免費方案） -->
          <div class="ws-welcome-opt ws-welcome-opt--primary">
            <div class="ws-welcome-opt__body">
              <div class="ws-welcome-opt__title">我想開始使用</div>
              <div class="ws-welcome-opt__desc">建立你自己的官方帳號空間，免費方案不需綁卡。</div>
            </div>
            <el-button type="primary" @click="startOnboarding">開始使用</el-button>
          </div>

          <!-- ② 受邀成員 → 提供信箱給管理員邀請 -->
          <div class="ws-welcome-opt">
            <div class="ws-welcome-opt__body">
              <div class="ws-welcome-opt__title">我是被邀請加入團隊的</div>
              <div class="ws-welcome-opt__desc">把下面這個信箱給你的管理員，請他邀請你加入。</div>
              <div class="ws-empty-email">
                <span class="ws-empty-email-value">{{ userEmail || '（讀取中…）' }}</span>
                <el-button v-if="userEmail" size="small" text @click="copyEmail">
                  {{ emailCopied ? '已複製' : '複製' }}
                </el-button>
              </div>
            </div>
          </div>

          <!-- ③ 想先了解 / 企業需求 -->
          <p v-if="contactHref" class="text-xs text-muted">
            想先了解或有企業需求？
            <a :href="contactHref" target="_blank" rel="noopener" class="ws-empty-contact">聯繫我們 / 預約 Demo →</a>
          </p>
        </div>

        <NuxtLink v-if="isSuperAdmin" to="/admin/super" class="ws-super-admin-link">
          <el-icon><Setting /></el-icon>
          <span>超級管理員後台</span>
          <span class="ws-item-arrow">→</span>
        </NuxtLink>
        <div class="ws-select-footer">
          <el-button @click="logout">登出</el-button>
        </div>
      </template>

      <template v-else>
        <div class="ws-groups">
          <div v-for="group in groupedWorkspaces" :key="group.key">
            <div class="ws-group-header">
              <el-icon><OfficeBuilding /></el-icon>
              <span class="ws-group-name">{{ group.orgName }}</span>
              <!-- 組織管理員才看得到組織後台入口（canCreate 就是 org admin 的判斷） -->
              <NuxtLink
                v-if="group.canCreate && group.orgId"
                :to="`/admin/org/${group.orgId}`"
                class="ws-group-link"
                :title="`查看「${group.orgName}」底下所有官方帳號的狀態`"
              >
                組織管理
              </NuxtLink>
              <button
                v-if="group.canCreate"
                class="ws-group-add-btn"
                :title="`在「${group.orgName}」新增官方帳號`"
                @click="openCreate(group)"
              >
                ＋ 新增
              </button>
            </div>
            <div class="ws-group-items">
              <button
                v-for="ws in group.items"
                :key="ws.workspaceId"
                class="ws-item"
                @click="enter(ws.workspaceId)"
              >
                <div class="ws-item-icon"><el-icon><ChatDotRound /></el-icon></div>
                <div class="ws-item-info">
                  <div class="ws-item-name">{{ ws.name }}</div>
                  <div class="ws-item-role">
                    <span>{{ roleLabel(ws.role) }}</span>
                    <el-tag
                      v-if="ws.plan"
                      size="small"
                      effect="plain"
                      class="ws-item-plan-tag"
                      :class="{ 'plan-tag--internal': isInternalPlan(ws.plan.id) }"
                      :type="planTagType(ws.plan.id)"
                    >
                      {{ ws.plan.name }}
                    </el-tag>
                  </div>
                </div>
                <span class="ws-item-arrow">→</span>
              </button>

              <!-- 無 workspace 時的提示 -->
              <div v-if="group.items.length === 0" class="ws-group-empty">
                此組織尚無官方帳號，點 + 建立第一個。
              </div>
            </div>
          </div>
        </div>

        <NuxtLink v-if="isSuperAdmin" to="/admin/super" class="ws-super-admin-link">
          <el-icon><Setting /></el-icon>
          <span>超級管理員後台</span>
          <span class="ws-item-arrow">→</span>
        </NuxtLink>

        <div class="ws-select-footer">
          <el-button @click="logout">登出</el-button>
        </div>
      </template>
    </div>
  </div>

  <!-- 新增官方帳號 dialog -->
  <el-dialog v-model="showCreate" title="新增官方帳號" width="min(420px, 92vw)" @closed="resetCreate">
    <div class="ws-create-dialog-body">
      <div class="admin-field-group">
        <AdminFieldLabel text="官方帳號名稱" tight />
        <el-input
          v-model="createForm.name"
          placeholder="例：MyFeel 官方帳號"
          @keyup.enter="submitCreate"
        />
      </div>
    </div>
    <template #footer>
      <el-button @click="showCreate = false">取消</el-button>
      <el-button
        type="primary"
        :loading="createSaving"
        :disabled="!createForm.name.trim()"
        @click="submitCreate"
      >
        建立
      </el-button>
    </template>
  </el-dialog>

  <AdminToastHost />
</template>

<script setup lang="ts">
import { ChatDotRound, OfficeBuilding, Setting } from '@element-plus/icons-vue'
const { showToast } = useAdminToast()
import type { WorkspaceItem } from '~~/app/composables/useWorkspace'
import { DEFAULT_LINE_WORKSPACE_ID } from '~~/shared/line-workspace'
import { BILLING_PLANS, type BillingPlanId } from '~~/shared/billing/plans'

definePageMeta({ middleware: 'auth', layout: false })
useHead({ title: useAdminTitle('選擇官方帳號') })

const { logout } = useAuth()
const { loadWorkspaceList, orgAdminOf } = useWorkspace()
const { $auth } = useNuxtApp()

const loading = ref(true)
const workspaceList = ref<WorkspaceItem[]>([])
const isSuperAdmin = ref(false)

// ── 沒有任何權限時的出口 ─────────────────────────────────────
// 顯示登入信箱：要邀請他的人需要的就是這個字串，而他自己往往不知道剛剛用了哪個 Google 帳號。
const userEmail = ref('')
const emailCopied = ref(false)

const config = useRuntimeConfig()
const contact = String(config.public.supportContact ?? '').trim()
const contactHref = contact
  ? (contact.startsWith('http') ? contact : `mailto:${contact}`)
  : ''
// 品牌名走 runtimeConfig（多租戶可覆寫），不寫死租戶名
const { brandName } = useSiteIdentity()

// ── 「我想開始使用」→ 自助開通精靈 ───────────────────────────
// 帶去 /admin/onboarding 讓他自己建立組織＋第一個帳號（免費方案），不再撞牆。
function startOnboarding() {
  navigateTo('/admin/onboarding')
}

async function copyEmail() {
  if (!userEmail.value) return
  try {
    await navigator.clipboard.writeText(userEmail.value)
    emailCopied.value = true
    setTimeout(() => { emailCopied.value = false }, 2000)
  }
  catch {
    showToast('複製失敗，請手動選取', 'error')
  }
}

/**
 * 預設只隱藏舊版單一 OA 的 `default` workspace；但若使用者完全沒有其他
 * workspace、也不是任何組織的 admin，仍顯示 default 作為唯一入口，
 * 避免把唯一一筆權限藏掉導致看到「沒有任何官方帳號的存取權限」。
 */
const visibleWorkspaceList = computed(() => {
  const nonDefault = workspaceList.value.filter(ws => ws.workspaceId !== DEFAULT_LINE_WORKSPACE_ID)
  if (nonDefault.length === 0 && orgAdminOf.value.length === 0) {
    return workspaceList.value
  }
  return nonDefault
})

const ROLE_LABELS: Record<string, string> = {
  owner: '擁有者',
  admin: '管理員',
  agent: '客服',
  viewer: '觀察者',
}

/** 方案標籤配色：免費=灰、付費=綠、內部/測試=橘（讓內部帳號一眼可辨）。 */
function planTagType(id: string): 'info' | 'success' {
  const p = BILLING_PLANS[id as BillingPlanId]
  if (!p) return 'info'
  // 內部/測試（無限）是平台自家帳號，用中性灰；橘色(warning) 只留給真正的警示（快撞頂／扣款失敗）
  if (p.internal) return 'info'
  return p.id === 'free' ? 'info' : 'success'
}
/** 內部/測試方案 → 套 .plan-tag--internal 暖中性灰（見 _shared.scss） */
function isInternalPlan(id: string) {
  return Boolean(BILLING_PLANS[id as BillingPlanId]?.internal)
}

function roleLabel(role: string) {
  return ROLE_LABELS[role] ?? role
}

interface OrgGroup {
  key: string
  orgName: string
  orgId: string | null
  items: WorkspaceItem[]
  canCreate: boolean
}

const groupedWorkspaces = computed<OrgGroup[]>(() => {
  const groups: Record<string, OrgGroup> = {}

  // 從 workspace 列表建立群組
  for (const ws of visibleWorkspaceList.value) {
    const key = ws.organizationId ?? '__none__'
    if (!groups[key]) {
      const orgId = ws.organizationId ?? null
      groups[key] = {
        key,
        orgId,
        orgName: ws.organizationName ?? (orgId ?? '未歸屬組織'),
        items: [],
        canCreate: orgId !== null && orgAdminOf.value.some((o: { id: string }) => o.id === orgId),
      }
    }
    groups[key].items.push(ws)
  }

  // 補入 org admin 管轄但目前還沒有 workspace 的組織（空白狀態入口）
  for (const org of orgAdminOf.value) {
    if (!groups[org.id]) {
      groups[org.id] = {
        key: org.id,
        orgId: org.id,
        orgName: org.name,
        items: [],
        canCreate: true,
      }
    }
  }

  return Object.values(groups).sort((a, b) => {
    if (a.key === '__none__') return 1
    if (b.key === '__none__') return -1
    return 0
  })
})

async function enter(workspaceId: string) {
  await navigateTo(`/admin/${workspaceId}/conversation-stats`)
}

// ── 新增官方帳號 ──────────────────────────────────────────────────

const showCreate = ref(false)
const createSaving = ref(false)
const createTargetOrgId = ref<string | null>(null)
const createForm = reactive({ name: '' })

function openCreate(group: OrgGroup) {
  createTargetOrgId.value = group.orgId
  createForm.name = ''
  showCreate.value = true
}

function resetCreate() {
  createForm.name = ''
  createTargetOrgId.value = null
}

async function submitCreate() {
  if (!createForm.name.trim()) {
    showToast('請輸入官方帳號名稱', 'error')
    return
  }
  if (!createTargetOrgId.value) return
  createSaving.value = true
  try {
    const token = await $auth.currentUser?.getIdToken()
    await $fetch(`/api/admin/org/${createTargetOrgId.value}/workspaces`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { name: createForm.name.trim() },
    })
    showCreate.value = false
    workspaceList.value = await loadWorkspaceList()
    showToast('官方帳號已建立', 'success')
  }
  catch (e: any) {
    const msg = e?.data?.statusMessage || e?.message || '建立失敗'
    showToast(msg, 'error')
  }
  finally {
    createSaving.value = false
  }
}

// ── Init ──────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    const [list, tokenResult] = await Promise.all([
      loadWorkspaceList(),
      $auth.currentUser?.getIdTokenResult(),
    ])
    workspaceList.value = list
    isSuperAdmin.value = tokenResult?.claims.superAdmin === true
    // 沒有任何權限時要顯示給他看（同事要邀請他就是需要這個信箱）
    userEmail.value = $auth.currentUser?.email ?? ''

    const onlyWorkspace = visibleWorkspaceList.value.length === 1 ? visibleWorkspaceList.value[0] : undefined
    if (!isSuperAdmin.value && onlyWorkspace && orgAdminOf.value.length === 0) {
      await enter(onlyWorkspace.workspaceId)
    }
  }
  catch {
    workspaceList.value = []
  }
  finally {
    loading.value = false
  }
})
</script>
