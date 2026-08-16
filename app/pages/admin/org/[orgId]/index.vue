<template>
  <!-- 用共用的 AdminShell（和 default / super-admin 同一套外殼），側欄全部用共用
       class（logo / sidebar-workspace / nav-item / footer-user），只換內容、不客製樣式，
       且只放組織層導覽、不露出任何超管選單。 -->
  <AdminShell>
    <template #sidebar>
      <div class="sidebar-logo">
        <span class="logo-icon"><el-icon color="#fff"><OfficeBuilding /></el-icon></span>
        <div>
          <span class="logo-text">{{ orgName || '組織管理' }}</span>
          <span class="logo-sub">組織管理</span>
        </div>
      </div>

      <!-- 切換帳號放側欄上方（和 super/admin 的 sidebar-workspace 同位置），
           footer 才能只留「你的帳號 + 登出」、位置與其他頁完全一致。 -->
      <div class="sidebar-workspace">
        <NuxtLink to="/admin/workspaces" class="ws-sidebar-switch">
          <span class="ws-sidebar-switch__icon"><el-icon><ChatDotRound /></el-icon></span>
          <span class="ws-sidebar-switch__main">
            <span class="ws-sidebar-switch__title">切換帳號</span>
            <span class="ws-sidebar-switch__sub">選擇其他組織或官方帳號</span>
          </span>
          <span class="ws-sidebar-switch__arrow">→</span>
        </NuxtLink>
      </div>

      <!-- nav 用和 super/admin 完全相同的 <NuxtLink class="nav-item">，只是切的是 ?tab= -->
      <nav class="sidebar-nav">
        <NuxtLink :to="{ query: { ...route.query, tab: 'overview' } }" replace class="nav-item" :class="{ active: tab === 'overview' }">
          <el-icon class="nav-icon"><DataBoard /></el-icon><span>總覽</span>
        </NuxtLink>
        <NuxtLink :to="{ query: { ...route.query, tab: 'billing' } }" replace class="nav-item" :class="{ active: tab === 'billing' }">
          <el-icon class="nav-icon"><Wallet /></el-icon><span>帳務</span>
        </NuxtLink>
        <NuxtLink :to="{ query: { ...route.query, tab: 'members' } }" replace class="nav-item" :class="{ active: tab === 'members' }">
          <el-icon class="nav-icon"><UserFilled /></el-icon><span>管理員</span>
        </NuxtLink>
      </nav>
    </template>

    <!-- Footer 與 super/admin 完全一致：只有「你的帳號」＋ 登出，位置相同 -->
    <template #footer>
      <div class="sidebar-footer-user">
        <div class="sidebar-footer-avatar"><el-icon><Avatar /></el-icon></div>
        <div class="sidebar-footer-user-meta">
          <div class="sidebar-footer-email truncate text-sm font-bold">{{ user?.email ?? '管理員' }}</div>
          <div class="text-xs text-muted">組織管理員</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm w-full" @click="logout">
        <el-icon><SwitchButton /></el-icon> 登出
      </button>
    </template>

    <div v-if="loading" class="org-loading">
      <div class="spinner" />
      <span>載入中…</span>
    </div>

    <template v-else>
        <!-- ── 總覽 ──────────────────────────────────────────── -->
        <div v-show="tab === 'overview'" class="org-pane">
          <!-- 一張資訊飽滿的組織摘要卡：帳號健康（結論先行）＋ 分段條 ＋ 次要指標。
               用一張密實的卡，而不是一堆大空框裝很少的內容。 -->
          <div v-if="rows.length" class="org-summary">
            <div class="org-summary-top">
              <div class="org-summary-lead">
                <span class="org-summary-label">帳號健康</span>
                <div class="org-hero-headline">
                  <span class="org-hero-count">{{ rows.length }}</span>
                  <span class="org-hero-unit">個官方帳號</span>
                </div>
              </div>
              <span class="org-hero-verdict" :class="`is-${healthTone}`">
                <el-icon>
                  <CircleCheckFilled v-if="healthTone === 'ok'" />
                  <WarningFilled v-else />
                </el-icon>
                {{ healthVerdict }}
              </span>
            </div>

            <div class="org-health-bar">
              <div v-if="okCount" class="org-health-seg seg-ok" :style="{ flexGrow: okCount }" />
              <div v-if="needsAttention.length" class="org-health-seg seg-alert" :style="{ flexGrow: needsAttention.length }" />
            </div>
            <div class="org-health-legend">
              <span class="org-health-item"><i class="org-health-dot seg-ok" />運作正常 {{ okCount }}</span>
              <button
                v-if="needsAttention.length"
                type="button"
                class="org-health-item org-health-item--btn"
                @click="scrollToAlerts"
              >
                <i class="org-health-dot seg-alert" />需要處理 {{ needsAttention.length }} →
              </button>
              <span v-else class="org-health-item is-muted"><i class="org-health-dot seg-alert" />需要處理 0</span>
            </div>

            <div class="org-summary-stats">
              <div class="org-substat">
                <span class="org-substat-num">{{ paidCount }}</span>
                <span class="org-substat-label">付費方案</span>
              </div>
              <div class="org-substat">
                <span class="org-substat-num">{{ totalAnswered.toLocaleString() }}</span>
                <!-- ⛔ 定義用共用的 REPLY_UNIT_TIP，別自己造句：原本寫「AI 自動回覆訊息的則數」，
                     漏掉草稿模式擬稿也扣（2026-08-10 拍板），跟計費行為對不上。 -->
                <el-tooltip :content="`${REPLY_UNIT_TIP}（各帳號週期起算日可能不同，這裡是各自本期的加總）`" placement="top">
                  <span class="org-substat-label org-stat-label--hint">本期 AI 回覆則數</span>
                </el-tooltip>
              </div>
            </div>
          </div>

          <div v-if="!rows.length" class="org-empty">
            <p>這個組織還沒有任何官方帳號。</p>
            <NuxtLink to="/admin/workspaces" class="text-xs">回帳號選擇頁建立第一個 →</NuxtLink>
          </div>

          <!-- 需要處理的排最前面：管 10 個 OA 的人要的是「哪個出事了」，不是一份名單 -->
          <div v-else ref="gridRef" class="org-grid">
            <button
              v-for="r in sortedRows"
              :key="r.workspaceId"
              class="org-card"
              :class="{ 'is-alert': isAlert(r) }"
              @click="enter(r.workspaceId)"
            >
              <span class="org-card-avatar" :class="{ 'is-alert': isAlert(r) }">{{ r.name.charAt(0) }}</span>

              <div class="org-card-main">
                <div class="org-card-head">
                  <span class="org-card-name">{{ r.name }}</span>
                  <el-tag
                    v-if="r.plan"
                    size="small"
                    effect="plain"
                    :type="planTagType(r.plan.id)"
                    :class="{ 'plan-tag--internal': isInternalPlan(r.plan.id) }"
                  >
                    {{ r.plan.name }}
                  </el-tag>
                </div>

                <div v-if="r.plan?.answeredQuota != null" class="org-card-quota">
                  <el-progress
                    :percentage="state(r).percent"
                    :color="state(r).color"
                    :stroke-width="6"
                    :show-text="false"
                  />
                  <span class="org-card-quota-text">
                    本期 {{ r.answered.toLocaleString() }} / {{ r.plan.answeredQuota.toLocaleString() }} 則
                  </span>
                </div>
                <div v-else class="org-card-quota">
                  <span class="org-card-quota-text">客製額度，無固定上限</span>
                </div>

                <!-- 一張卡一個結論（v-else-if 鏈，嚴重的先講）。異常旗標與右下角小幫手
                     同一套訊號與嚴重度；tooltip 列出是哪幾件事，不用點進去才知道 -->
                <div class="org-card-flags">
                  <span v-if="!r.lineConnected" class="org-flag org-flag--warn">尚未接上 LINE</span>
                  <el-tooltip
                    v-else-if="alertSummary(r.workspaceId)?.critical"
                    :content="alertSummary(r.workspaceId)?.titles.join('、') ?? ''"
                    placement="top"
                  >
                    <span class="org-flag org-flag--bad">{{ alertSummary(r.workspaceId)?.critical }} 件事正在影響客人</span>
                  </el-tooltip>
                  <span v-else-if="state(r).state === 'over'" class="org-flag org-flag--bad">額度已用完，AI 停止回覆</span>
                  <span v-else-if="state(r).state === 'near'" class="org-flag org-flag--warn">額度即將用完</span>
                  <span v-else-if="r.plan?.status === 'past_due'" class="org-flag org-flag--warn">扣款未成功</span>
                  <el-tooltip
                    v-else-if="alertSummary(r.workspaceId)?.warning"
                    :content="alertSummary(r.workspaceId)?.titles.join('、') ?? ''"
                    placement="top"
                  >
                    <span class="org-flag org-flag--warn">{{ alertSummary(r.workspaceId)?.warning }} 件事建議處理</span>
                  </el-tooltip>
                  <span v-else class="org-flag org-flag--ok">運作正常</span>
                </div>
              </div>

              <span class="org-card-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </div>
        <!-- ── 帳務 ──────────────────────────────────────────── -->
        <div v-show="tab === 'billing'" class="org-pane">
          <div class="org-summary">
            <div class="org-summary-stats">
              <div class="org-substat">
                <span class="org-substat-num">NT${{ monthlyTotal.toLocaleString() }}</span>
                <span class="org-substat-label">下一輪自動扣款總額</span>
              </div>
              <div class="org-substat">
                <span class="org-substat-num">{{ autoRenewCount }}</span>
                <span class="org-substat-label">自動續訂中</span>
              </div>
            </div>
            <p v-if="noAutoCharge" class="org-summary-note">
              目前沒有需自動扣款的項目——底下帳號都不是自動續訂。
            </p>
          </div>

          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">各帳號方案</span>
              </div>
            </div>
            <div class="card-section-stack">
              <el-table :data="billingRows" size="small" empty-text="尚無官方帳號">
                <el-table-column label="官方帳號" min-width="140">
                  <template #default="{ row }">{{ row.name }}</template>
                </el-table-column>
                <el-table-column label="方案" min-width="80">
                  <template #default="{ row }">
                    <el-tag
                      v-if="row.plan"
                      size="small"
                      effect="plain"
                      :type="planTagType(row.plan.id)"
                      :class="{ 'plan-tag--internal': isInternalPlan(row.plan.id) }"
                    >
                      {{ row.plan.name }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="月費" min-width="90" align="right">
                  <template #default="{ row }">{{ priceLabel(row.plan?.id) }}</template>
                </el-table-column>
                <el-table-column label="續訂狀態" min-width="160">
                  <template #default="{ row }">
                    <span class="text-xs">{{ renewLabel(row) }}</span>
                  </template>
                </el-table-column>
                <el-table-column width="70" align="right">
                  <template #default="{ row }">
                    <el-button size="small" text @click="goBilling(row.workspaceId)">管理</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>

          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">付款紀錄</span>
                <span class="text-xs text-muted">整個組織，新到舊</span>
              </div>
            </div>
            <div class="card-section-stack">
              <!-- 對客戶（組織管理員）的口徑是「開立中」不是「失敗」——系統每日自動補開,
                   客戶無事可做;真實狀態（failed）不動,超管金流總覽照樣紅（2026-08-16 拍板） -->
              <el-alert
                v-if="invoiceEnabled && hasFailedInvoice"
                type="info"
                :closable="false"
                show-icon
                title="電子發票開立中"
              >
                <span class="text-xs">已付款訂單的電子發票由系統自動開立，完成後會在下方付款紀錄顯示號碼並寄送通知。若有設定上的問題（例如統編），我們會主動與你聯繫。</span>
              </el-alert>
              <!-- 讀不到就要說讀不到。渲染成一張「尚無付款紀錄」的空表，
                   等於告訴客戶他從來沒付過錢——那比誠實報錯糟糕得多。 -->
              <el-alert v-if="ordersError" type="warning" :closable="false" show-icon :title="ordersError" />
              <el-table v-else :data="orders" size="small" empty-text="尚無付款紀錄">
                <el-table-column label="日期" min-width="130">
                  <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
                </el-table-column>
                <el-table-column label="官方帳號" min-width="120">
                  <template #default="{ row }">{{ row.workspaceName }}</template>
                </el-table-column>
                <el-table-column label="方案" min-width="70">
                  <template #default="{ row }">{{ planName(row.planId) }}</template>
                </el-table-column>
                <el-table-column label="金額(含稅)" min-width="80" align="right">
                  <template #default="{ row }">NT${{ row.amount.toLocaleString() }}</template>
                </el-table-column>
                <el-table-column label="狀態" min-width="70">
                  <template #default="{ row }">
                    <el-tag :type="orderStatusType(row.status)" size="small">{{ orderStatusLabel(row.status) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column v-if="invoiceEnabled" label="發票號碼" min-width="100">
                  <template #default="{ row }">
                    <span v-if="row.invoiceStatus === 'voided'" class="text-xs text-muted">已作廢</span>
                    <span v-else-if="row.invoiceNumber" class="billing-order-no">{{ row.invoiceNumber }}</span>
                    <el-tooltip
                      v-else-if="row.invoiceStatus === 'failed'"
                      content="發票由系統自動開立，完成後這裡會顯示號碼並寄送通知"
                      placement="top"
                    >
                      <el-tag type="info" size="small">開立中</el-tag>
                    </el-tooltip>
                    <span v-else class="text-xs text-muted">—</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>

          <!-- 發票資訊放在帳務分頁：它是帳務的一部分，不是「總覽」的一部分 -->
          <div v-if="invoiceEnabled" class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">發票資訊</span>
                <span class="text-xs text-muted">底下所有官方帳號預設沿用這一份</span>
              </div>
              <el-button
                size="small"
                :loading="savingInvoice"
                :disabled="!invoiceLoaded || !invoiceValid"
                @click="saveInvoiceProfile"
              >
                儲存
              </el-button>
            </div>
            <!-- 讀不到就**不准存**。表單會是空的，而儲存是整份覆蓋——按下去等於把組織的
                 統編與抬頭清成空白，底下每個 OA 都開始開出沒有統編的發票，
                 而客戶要到會計退件那天才會發現。 -->
            <el-alert
              v-if="!invoiceLoaded"
              type="error"
              :closable="false"
              show-icon
              title="發票資訊讀取失敗，暫時無法編輯"
            >
              <span class="text-xs">為避免覆蓋掉已儲存的統編與抬頭，儲存已停用。請重新整理後再試。</span>
            </el-alert>
            <AdminInvoiceProfileForm v-else v-model="invoiceForm" :fallback-name-hint="orgName" @update:valid="invoiceValid = $event" />
          </div>
        </div>
        <!-- ── 成員 ──────────────────────────────────────────── -->
        <div v-show="tab === 'members'" class="org-pane">
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">組織管理員</span>
                <span class="text-xs text-muted">可管理這個組織底下的所有官方帳號</span>
              </div>
            </div>
            <div class="card-section-stack">
              <!-- 目前沒有邀請信：加進來的人不會收到任何通知，這件事必須講清楚，
                   不然邀請者會以為系統幫他通知了，然後兩邊都在等對方。 -->
              <el-alert type="info" :closable="false" show-icon>
                <span class="text-xs">
                  以 Google 信箱認人，對方不需要先註冊。<strong>系統目前不會寄出通知信</strong>——
                  加完之後請自行告訴他可以用這個信箱登入了。
                </span>
              </el-alert>

              <div class="org-member-add">
                <el-input
                  v-model="newMemberEmail"
                  placeholder="輸入 Google 信箱"
                  @keyup.enter="addMember"
                />
                <el-button type="primary" :loading="addingMember" @click="addMember">新增管理員</el-button>
              </div>

              <el-table :data="members" size="small" empty-text="尚無管理員">
                <el-table-column label="Email" min-width="220">
                  <template #default="{ row }">
                    <span class="billing-order-no">{{ row.email }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="身分" min-width="120">
                  <template #default="{ row }">
                    <el-tag v-if="row.isOwner" size="small" type="success" effect="plain">登記擁有者</el-tag>
                    <el-tag v-else-if="row.isSelf" size="small" effect="plain">你自己</el-tag>
                  </template>
                </el-table-column>
                <el-table-column width="80" align="right">
                  <template #default="{ row }">
                    <el-button
                      v-if="!row.isOwner && !row.isSelf && members.length > 1"
                      size="small"
                      text
                      type="danger"
                      @click="removeMember(row)"
                    >
                      移除
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </div>
      </template>

    <template #overlay>
      <AdminToastHost />
    </template>
  </AdminShell>
</template>

<script setup lang="ts">
import { Avatar, ChatDotRound, CircleCheckFilled, DataBoard, OfficeBuilding, SwitchButton, UserFilled, Wallet, WarningFilled } from '@element-plus/icons-vue'
import { derivePlanState, type PlanView } from '~~/shared/billing/plan-state'
import { REPLY_UNIT_TIP } from '~~/shared/billing/usage-units'
import { BILLING_PLANS, type BillingPlanId } from '~~/shared/billing/plans'
import { ALERT_LABELS } from '~~/shared/types/alerts'
import type { WorkspaceAlertId, WorkspaceAlertItem } from '~~/shared/types/alerts'
import { ALERT_SEVERITY } from '~/composables/useWorkspaceAlerts'
import type { PaymentOrderStatus } from '~~/shared/types/payment'
import type { InvoiceForm } from '~~/app/components/admin/AdminInvoiceProfileForm.vue'

definePageMeta({ middleware: 'auth', layout: false })
useHead({ title: useAdminTitle('組織管理') })

const route = useRoute()
const router = useRouter()
const { getBearer } = useWorkspace()
const { showToast } = useAdminToast()
const { user, logout } = useAuth()

const orgId = computed(() => String(route.params.orgId || ''))
// 分頁狀態直接以 URL 的 ?tab= 為準（和 super/admin 一樣用連結切換）→ nav 就能用
// 共用的 <NuxtLink class="nav-item">，不必自刻 <button> 樣式，也不會再有字體/外觀 drift。
const ORG_TABS = ['overview', 'billing', 'members']
const tab = computed(() => {
  const t = String(route.query.tab || '')
  return ORG_TABS.includes(t) ? t : 'overview'
})

const config = useRuntimeConfig()
const invoiceEnabled = Boolean(config.public.invoiceEnabled)

const loading = ref(true)
const refreshing = ref(false)
const orgName = ref('')

async function orgFetch<T>(path: string, opts: Record<string, unknown> = {}): Promise<T> {
  const token = await getBearer()
  return await $fetch(`/api/admin/org/${orgId.value}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}` },
  }) as T
}

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
function planName(id: string) { return BILLING_PLANS[id as BillingPlanId]?.name ?? id }
function priceLabel(id?: BillingPlanId) {
  const p = id ? BILLING_PLANS[id] : null
  if (!p || p.priceMonthly == null) return '—'
  return p.priceMonthly === 0 ? '免費' : `NT$${p.priceMonthly.toLocaleString()}`
}

// ── 總覽 ──────────────────────────────────────────────────
interface OverviewRow {
  workspaceId: string
  name: string
  plan: PlanView | null
  answered: number
  lineConnected: boolean
}
const rows = ref<OverviewRow[]>([])

function state(r: OverviewRow) {
  return derivePlanState(r.plan, r.answered)
}

// ── 跨工作區異常彙總（與右下角小幫手同一套訊號、同一把嚴重度尺）──────
// 帳號卡上既有的旗標已經在講額度與扣款，這幾個 id 不重複計，免得同一件事算兩次
const FLAG_COVERED_ALERT_IDS = new Set<WorkspaceAlertId>(['quotaExceeded', 'quotaRunningOut', 'paymentPastDue'])
const wsAlerts = ref<Record<string, WorkspaceAlertItem[]>>({})

interface WsAlertSummary { critical: number; warning: number; titles: string[] }
const alertSummaries = computed<Record<string, WsAlertSummary>>(() => {
  const out: Record<string, WsAlertSummary> = {}
  for (const [wid, items] of Object.entries(wsAlerts.value)) {
    const sum: WsAlertSummary = { critical: 0, warning: 0, titles: [] }
    for (const it of items) {
      if (it.state !== 'active' || FLAG_COVERED_ALERT_IDS.has(it.id)) continue
      const sev = ALERT_SEVERITY[it.id]
      if (sev === 'critical') sum.critical++
      else if (sev === 'warning') sum.warning++
      else continue // suggestion 是「可以更好」，不是異常，組織彙總不計
      sum.titles.push(ALERT_LABELS[it.id])
    }
    out[wid] = sum
  }
  return out
})
/** null = 這個工作區的訊號還沒回來（或讀取失敗）——不下結論，旗標只用 overview 既有資訊 */
function alertSummary(wid: string): WsAlertSummary | null {
  return alertSummaries.value[wid] ?? null
}

async function loadAlerts() {
  try {
    const res = await orgFetch<{ workspaces: Array<{ workspaceId: string; items: WorkspaceAlertItem[] }> }>('/alerts')
    wsAlerts.value = Object.fromEntries(res.workspaces.map(w => [w.workspaceId, w.items]))
  }
  catch {
    // 讀不到就維持「不下結論」：帳號卡只靠 overview 的旗標，不誤報也不假裝正常
  }
}

/** 需要處理 = 額度撞頂 / 快撞頂 / LINE 還沒接 / 扣款未成功 / 異常中心有紅橘訊號。 */
function isAlert(r: OverviewRow): boolean {
  if (!r.lineConnected) return true
  if (r.plan?.status === 'past_due') return true
  const a = alertSummary(r.workspaceId)
  if (a && (a.critical > 0 || a.warning > 0)) return true
  const s = state(r).state
  return s === 'over' || s === 'near'
}

const needsAttention = computed(() => rows.value.filter(isAlert))
const okCount = computed(() => rows.value.length - needsAttention.value.length)
const healthTone = computed<'ok' | 'alert'>(() => (needsAttention.value.length > 0 ? 'alert' : 'ok'))
/** hero 的結論句：先講「幾個正常／幾個要處理」，而不是丟一個裸數字。 */
const healthVerdict = computed(() => {
  if (!rows.value.length) return ''
  return needsAttention.value.length === 0
    ? '全部運作正常'
    : `${needsAttention.value.length} 個需要處理`
})
// 「付費」= 真的產生營收的方案：排除免費層與內部/測試（無限）帳號。
// 內部方案 id 不是 'free' 但 priceMonthly=0，只看 id !== 'free' 會把內部帳號誤算成付費，
// 和帳務分頁「月費免費／下一輪扣款 NT$0」自相矛盾。
const paidCount = computed(() =>
  rows.value.filter(r => Boolean(r.plan && r.plan.id !== 'free' && !BILLING_PLANS[r.plan.id as BillingPlanId]?.internal)).length,
)
const totalAnswered = computed(() => rows.value.reduce((sum, r) => sum + r.answered, 0))

/** 嚴重度排序：正在影響客人（異常中心紅級）> AI 已停止回覆 > 還沒接上線 > 快撞頂/警示 > 正常。 */
function severity(r: OverviewRow): number {
  const a = alertSummary(r.workspaceId)
  const s = state(r).state
  if (a?.critical) return 4
  if (s === 'over') return 3
  if (!r.lineConnected) return 2
  if (s === 'near' || r.plan?.status === 'past_due' || a?.warning) return 1
  return 0
}
const sortedRows = computed(() =>
  [...rows.value].sort((a, b) => severity(b) - severity(a) || a.name.localeCompare(b.name)),
)

// 點「需要處理」→ 捲到官方帳號列表（已把出事的排最前面）
const gridRef = ref<HTMLElement>()
function scrollToAlerts() {
  gridRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function enter(workspaceId: string) {
  router.push(`/admin/${workspaceId}/conversation-stats`)
}

// ── 帳務 ──────────────────────────────────────────────────
interface BillingRow {
  workspaceId: string
  name: string
  plan: PlanView | null
  nextChargeDate: string | null
}
interface OrderRow {
  merchantOrderNo: string
  workspaceName: string
  planId: string
  amount: number
  status: PaymentOrderStatus
  createdAt: number | null
  invoiceNumber: string | null
  invoiceStatus: 'issued' | 'failed' | 'skipped' | 'voided' | null
}
const billingRows = ref<BillingRow[]>([])
const orders = ref<OrderRow[]>([])
/** 有付款成功、但發票開立失敗的紀錄 → 帳務區顯示警示（與帳單頁一致，稅務問題要看得到）。 */
const hasFailedInvoice = computed(() => orders.value.some(o => o.status === 'paid' && o.invoiceStatus === 'failed'))
const monthlyTotal = ref(0)
/** 付款紀錄讀不到時的訊息。有值 → 顯示錯誤，**不要**渲染成一張「尚無付款紀錄」的空表。 */
const ordersError = ref<string | null>(null)

const autoRenewCount = computed(() => billingRows.value.filter(r => r.plan?.autoRenew).length)
/** 全為內部/免費或單次付款時，兩個 0 會像沒載入——補一句白話說明「本來就不用扣」。 */
const noAutoCharge = computed(() => billingRows.value.length > 0 && monthlyTotal.value === 0 && autoRenewCount.value === 0)

/** 續訂狀態要一句話說完，不要讓人自己去拼「autoRenew + cancelAtPeriodEnd + status」。 */
function renewLabel(r: BillingRow): string {
  const p = r.plan
  if (!p || p.id === 'free') return '—'
  if (p.status === 'past_due') return '扣款未成功'
  if (p.cancelAtPeriodEnd) return `已取消，用到 ${p.currentPeriodEnd}`
  if (p.autoRenew) return `自動續訂・${r.nextChargeDate} 扣款`
  return `單次付款，${p.currentPeriodEnd} 到期`
}

function goBilling(workspaceId: string) {
  router.push(`/admin/${workspaceId}/settings/billing`)
}

const ORDER_STATUS_LABEL: Record<PaymentOrderStatus, string> = {
  pending: '待付款', paid: '已付款', failed: '失敗', expired: '已逾期',
}
function orderStatusLabel(s: PaymentOrderStatus) { return ORDER_STATUS_LABEL[s] ?? s }
function orderStatusType(s: PaymentOrderStatus): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'paid') return 'success'
  if (s === 'failed') return 'danger'
  if (s === 'pending') return 'warning'
  return 'info'
}
function fmtTime(ms: number | null) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── 發票資訊（組織層的預設值）─────────────────────────────────
const invoiceForm = reactive<InvoiceForm>({
  buyerUBN: '', buyerName: '', buyerEmail: '', carrierNum: '', loveCode: '',
})
const savingInvoice = ref(false)
const invoiceValid = ref(true)
/** 讀取成功才允許儲存——見下方 saveInvoiceProfile 的說明。 */
const invoiceLoaded = ref(false)

async function saveInvoiceProfile() {
  // 儲存是**整份覆蓋**。若 GET 失敗過（表單是空的而不是「真的沒填」），存下去等於把組織
  // 已儲存的統編與抬頭清成 null，而底下每個 OA 都沿用這一份 → 全部開始開出沒有統編的發票。
  // 這種錯誤是靜默的，客戶要到會計退件那天才會發現。所以沒讀成功就一律不准存。
  if (!invoiceLoaded.value) {
    showToast('發票資訊尚未讀取成功，為避免覆蓋既有資料，請重新整理後再試', 'error')
    return
  }

  savingInvoice.value = true
  try {
    await orgFetch('/invoice-profile', { method: 'POST', body: { ...invoiceForm } })
    showToast('發票資訊已儲存，底下所有官方帳號都會沿用', 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    savingInvoice.value = false
  }
}

// ── 組織管理員 ────────────────────────────────────────────
interface MemberRow {
  docId: string
  email: string
  isOwner: boolean
  isSelf: boolean
}
const members = ref<MemberRow[]>([])
const newMemberEmail = ref('')
const addingMember = ref(false)

async function addMember() {
  const email = newMemberEmail.value.trim()
  if (!email) return

  // 組織管理員 = 組織底下所有官方帳號的 admin。這不是一個輕的動作，要問清楚。
  try {
    await ElMessageBox.confirm(
      `「${email}」將成為組織管理員，可以管理這個組織底下的所有官方帳號，包含計費與付款。`,
      '新增組織管理員',
      { confirmButtonText: '確認新增', cancelButtonText: '取消', type: 'warning' },
    )
  }
  catch { return }

  addingMember.value = true
  try {
    await orgFetch('/members', { method: 'POST', body: { email } })
    showToast(`已新增。請自行通知對方可以用這個信箱登入了（系統不會寄信）`, 'success')
    newMemberEmail.value = ''
    await loadMembers()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '新增失敗', 'error')
  }
  finally {
    addingMember.value = false
  }
}

async function removeMember(row: MemberRow) {
  try {
    await ElMessageBox.confirm(
      `移除後「${row.email}」將失去這個組織底下所有官方帳號的管理權限。`,
      '移除組織管理員',
      { confirmButtonText: '確認移除', cancelButtonText: '取消', type: 'warning' },
    )
  }
  catch { return }

  try {
    await orgFetch(`/members/${row.docId}`, { method: 'DELETE' })
    showToast('已移除', 'success')
    await loadMembers()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '移除失敗', 'error')
  }
}

// ── 載入 ──────────────────────────────────────────────────
async function loadOverview() {
  const res = await orgFetch<{ org: { name: string }; workspaces: OverviewRow[] }>('/overview')
  orgName.value = res.org.name
  rows.value = res.workspaces
}

async function loadBilling() {
  try {
    const res = await orgFetch<{
      workspaces: BillingRow[]
      monthlyTotal: number
      orders: OrderRow[]
      ordersError: string | null
    }>('/billing')
    billingRows.value = res.workspaces
    monthlyTotal.value = res.monthlyTotal
    orders.value = res.orders
    ordersError.value = res.ordersError
  }
  catch (e: any) {
    // 帳務讀不到不該讓整頁掛掉，但也不能假裝一切正常
    ordersError.value = e?.data?.statusMessage || '帳務資料暫時讀不到，請稍後再試'
  }
}

async function loadMembers() {
  try {
    const res = await orgFetch<{ members: MemberRow[] }>('/members')
    members.value = res.members
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '管理員名單讀取失敗', 'error')
  }
}

async function loadInvoiceProfile() {
  if (!invoiceEnabled) return
  try {
    const { profile } = await orgFetch<{ profile: Record<string, string | null> }>('/invoice-profile')
    invoiceForm.buyerUBN = profile.buyerUBN ?? ''
    invoiceForm.buyerName = profile.buyerName ?? ''
    invoiceForm.buyerEmail = profile.buyerEmail ?? ''
    invoiceForm.carrierNum = profile.carrierNum ?? ''
    invoiceForm.loveCode = profile.loveCode ?? ''
    invoiceLoaded.value = true // ← 讀成功才准存（見 saveInvoiceProfile）
  }
  catch {
    invoiceLoaded.value = false
  }
}

async function reloadAll(isRefresh = false) {
  if (isRefresh) refreshing.value = true
  try {
    // 總覽是主資料（也負責驗權限）；其餘並行拉，任一失敗不影響其他分頁
    await loadOverview()
    // 異常彙總最慢（逐工作區跑 probe、含外部 API），不擋整頁載入——
    // 旗標晚點到會自動從「運作正常」升級成異常結論
    void loadAlerts()
    await Promise.all([loadBilling(), loadMembers(), loadInvoiceProfile()])
  }
  catch (e: any) {
    // 不是這個組織的管理員 → 沒必要停在一個空頁面上，送他回帳號選擇頁
    if (e?.status === 403 || e?.statusCode === 403) {
      showToast('你不是此組織的管理員', 'error')
      await navigateTo('/admin/workspaces')
      return
    }
    showToast(e?.data?.statusMessage || '載入失敗', 'error')
  }
  finally {
    loading.value = false
    refreshing.value = false
  }
}

onMounted(() => reloadAll())
</script>
