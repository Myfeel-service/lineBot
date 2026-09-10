<template>
  <div class="ws-select-page">
    <div class="ws-select-card">
      <div class="ws-select-logo">
        <!-- logotype 已含品牌名，h1 只補「管理後台」；讀出來仍是「MiniMe 管理後台」 -->
        <h1><BrandLogo /><span>管理後台</span></h1>
      </div>
      <!-- ⚠️ 2026-09-10 `D-74`：沒有任何帳號時不出這一行——他沒有東西可選，
           而下面出的是歡迎卡（三選一）。載入中照舊出（維持原本的畫面、不多一次位移），
           代價是**裸 `/login` 進來的全新使用者會看到這行閃一下**（一個轉圈的時間）；
           `?intent=start` 進來的人根本不會停在這一頁。 -->
      <p v-if="loading || groupedWorkspaces.length > 0" class="ws-select-sub">選擇要管理的官方帳號</p>

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
          <!-- ⚠️ 中英之間留一個空格（`D-75`⑭）：登入頁的「免費打造我的 MiniMe」有，這裡原本沒有 -->
          <p class="ws-empty-title">歡迎使用 {{ brandName }}</p>
          <!-- ⛔ 不掛 `text-muted` 工具類（`D-75`A①：2.54:1）；字級與顏色都由 partial 給 -->
          <p class="ws-empty-lead">選一個最符合你狀況的方式繼續：</p>

          <!-- ① 想開始使用 → 自助開通精靈（建立自己的組織＋第一個帳號＋免費方案）
               ⚠️ ≤480px 時整張卡改成上下堆疊（`D-75`⑬）：並排時文字欄被壓到 130px、
                  說明折成三行擠在 88px 的按鈕旁邊。堆疊規則在 `_workspaces.scss`。 -->
          <div class="ws-welcome-opt ws-welcome-opt--primary">
            <div class="ws-welcome-opt__body">
              <div class="ws-welcome-opt__title">我想開始使用</div>
              <div class="ws-welcome-opt__desc">建立你自己的官方帳號空間，免費方案不需綁卡。</div>
            </div>
            <el-button type="primary" class="ws-welcome-opt__btn" @click="startOnboarding">開始使用</el-button>
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

          <!-- ③ 想先了解 / 企業需求
               ⚠️ 連結整段 nowrap（`D-75`⑫）：390px 實截時箭頭被擠到下一行、變成孤立的一個「→」。
               ⚠️ 2026-09-10 `G-73` 措辭更正：原本寫「聯繫我們 / 預約 Demo →」，但**預約 Demo 表單
                  2026-08-14 已整區移除**、首頁同日把口徑改成「寄信給我們」——這行點下去其實只是
                  開信件視窗，承諾一個不存在的東西。⛔ 改文案要跟首頁收尾 CTA 那句同口徑。
               ⛔ 這一行**刻意保留**（登入頁那行同日移除）：這裡是已經登入、零帳號、還講「企業需求」
                  ＝真的銷售時機，而且這一頁沒有別的路可以找人談。 -->
          <p v-if="contactHref" class="ws-empty-ask">
            想先了解或有企業需求？
            <a :href="contactHref" target="_blank" rel="noopener" class="entry-link">寄信給我們 →</a>
          </p>
        </div>

        <NuxtLink v-if="isSuperAdmin" to="/admin/super" class="ws-super-admin-link">
          <el-icon><Setting /></el-icon>
          <span>超級管理員後台</span>
          <span class="ws-item-arrow">→</span>
        </NuxtLink>
        <!-- 頁尾一行（`D-75`⑪）：原本「登出」是這一頁**唯一的按鈕**、置中在底部，
             看起來像主要動作（而它是最不該按的那個）。改成「我是誰 · 登出」一行，
             順便回答「我到底是用哪個 Google 帳號登進來的」——原本只有受邀那個選項看得到信箱。 -->
        <p class="entry-foot">
          <span v-if="userEmail" class="ws-foot-who" :title="userEmail">以 {{ userEmail }} 登入</span>
          <span v-if="userEmail" class="entry-foot__dot" aria-hidden="true">·</span>
          <button type="button" class="entry-link entry-link--quiet" @click="logout">登出</button>
        </p>
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
                <!-- 帳號名的第一個字當頭像（`D-75`⑩）：原本每個帳號都是同一顆聊天圖示，
                     清單掃過去每一列長得一樣、認不出誰是誰。單一色調＋首字＝差異在**字**上，
                     不發明一組裝飾用的配色（也不跟方案標籤的語意色搶）。
                     視覺沿用首頁 `.lp-chip__av`（綠 wash 底＋可讀深綠字）。
                     ⚠️ aria-hidden：名字就在右邊，讀屏不必再唸一次首字。 -->
                <div class="ws-item-avatar" aria-hidden="true">{{ initialOf(ws.name) }}</div>
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

        <!-- 頁尾一行（`D-75`⑪）：原本「登出」是這一頁**唯一的按鈕**、置中在底部，
             看起來像主要動作（而它是最不該按的那個）。改成「我是誰 · 登出」一行，
             順便回答「我到底是用哪個 Google 帳號登進來的」——原本只有受邀那個選項看得到信箱。 -->
        <p class="entry-foot">
          <span v-if="userEmail" class="ws-foot-who" :title="userEmail">以 {{ userEmail }} 登入</span>
          <span v-if="userEmail" class="entry-foot__dot" aria-hidden="true">·</span>
          <button type="button" class="entry-link entry-link--quiet" @click="logout">登出</button>
        </p>
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
// ⚠️ ChatDotRound 2026-09-10 移除：帳號圖示改成「名字首字頭像」（`D-75`⑩）
import { OfficeBuilding, Setting } from '@element-plus/icons-vue'
const { showToast } = useAdminToast()
import type { WorkspaceItem } from '~~/app/composables/useWorkspace'
import { DEFAULT_LINE_WORKSPACE_ID } from '~~/shared/line-workspace'
import { BILLING_PLANS, type BillingPlanId } from '~~/shared/billing/plans'
import { isSignupStartIntent, shouldFastLaneToOnboarding } from '~~/shared/signup-entry'

definePageMeta({ middleware: 'auth', layout: false })
useHead({ title: useAdminTitle('選擇官方帳號') })

const route = useRoute()
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

/**
 * 帳號名的第一個字＝頭像上的字（`D-75`⑩）。
 *
 * ⚠️ 用 `Array.from` 取字元、不用 `name[0]`：emoji 與部分罕用字是兩個 code unit，
 *    `name[0]` 會切出半個字、畫面上變成「�」。
 * ⚠️ 名字全空白／空字串時回「·」，⛔ 不要回空字串——圓圈裡什麼都沒有比一個點更像壞掉。
 */
function initialOf(name: string): string {
  const s = String(name ?? '').trim()
  return Array.from(s)[0] ?? '·'
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
  let listLoaded = false
  try {
    const [list, tokenResult] = await Promise.all([
      loadWorkspaceList(),
      $auth.currentUser?.getIdTokenResult(),
    ])
    workspaceList.value = list
    listLoaded = true
    isSuperAdmin.value = tokenResult?.claims.superAdmin === true
    // 沒有任何權限時要顯示給他看（同事要邀請他就是需要這個信箱）
    userEmail.value = $auth.currentUser?.email ?? ''

    // ── 註冊快車道（2026-09-10 `D-74` 老闆拍板 A 案）───────────────────
    // 從門面「免費打造」按進來、而且真的一個帳號都沒有 → 直接進開通引導，
    // 不要再問他一次「選一個最符合你狀況的方式」——他按那顆按鈕時就回答過了。
    // 判斷本體（含「清單沒查到時不可以送」等四個條件）在 shared/signup-entry.ts，有測試釘住。
    // ⛔ replace 不用 push：他不該按上一頁又回到這個中繼頁。
    if (shouldFastLaneToOnboarding({
      intentIsStart: isSignupStartIntent(route.query.intent),
      listLoaded,
      groupCount: groupedWorkspaces.value.length,
      isSuperAdmin: isSuperAdmin.value,
    })) {
      return await navigateTo('/admin/onboarding', { replace: true })
    }

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
