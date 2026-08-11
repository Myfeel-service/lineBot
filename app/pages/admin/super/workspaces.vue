<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="超級管理員"
        title="官方帳號管理"
        caption="管理系統中的所有 LINE 官方帳號（Workspace）。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button type="primary" @click="openCreate">+ 建立官方帳號</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">所有官方帳號</span>
            </div>
            <span class="text-xs text-muted">共 {{ visibleWorkspaces.length }} 筆</span>
          </div>
          <div class="card-section-stack">
            <el-table v-loading="loading" :data="visibleWorkspaces" size="small">
              <el-table-column label="名稱" min-width="160">
                <template #default="{ row }">{{ row.name }}</template>
              </el-table-column>
              <el-table-column label="所屬組織" min-width="150">
                <template #default="{ row }">
                  <span v-if="orgNameMap[row.organizationId]" class="text-sm">{{ orgNameMap[row.organizationId] }}</span>
                  <span v-else class="ws-sa-no-org-cell">未指定</span>
                </template>
              </el-table-column>
              <el-table-column label="ID" min-width="220">
                <template #default="{ row }">
                  <span class="text-xs text-muted sa-uid-mono">{{ row.id }}</span>
                </template>
              </el-table-column>
              <el-table-column label="計費方案" min-width="150">
                <template #default="{ row }">
                  <div v-if="row.subscription" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                    <el-tag :type="statusTagType(row.subscription.status)" size="small">
                      {{ statusLabel(row.subscription.status) }}
                    </el-tag>
                    <span class="text-sm">{{ planName(row.subscription.planId) }}</span>
                  </div>
                  <span v-else class="text-xs text-muted">未開通</span>
                </template>
              </el-table-column>
              <!-- ⛔ 主數字是 invocations，量詞必須是「次」不是「則」：2026-08-11 老闆對照
                   成本總覽（「呼叫 AI 235 次（答出 95 則）」）發現這裡把同一個 235 寫成「則」——
                   而且它就排在「計費方案」右邊，會被直接讀成計費則數（真值是 95，差 2.5 倍）。
                   兩個數字都要在：管理視角問的是「有沒有在用（次）」與「收得到多少錢（則）」。
                   ⚠️ 這裡的則數是**日曆月**桶，不是額度的錨定期——所以不並排額度上限，
                   免得看起來像進度條卻跟攔截點對不上（額度看組織頁 / 帳號的方案卡）。 -->
              <el-table-column label="本月 AI 用量" min-width="190">
                <template #header>
                  <span class="ws-sa-usage-th">
                    本月 AI 用量
                    <el-tooltip placement="top">
                      <template #content>
                        <div class="ws-sa-usage-tip">
                          <p>{{ CALL_UNIT_TIP }}</p>
                          <p>{{ REPLY_UNIT_TIP }}</p>
                        </div>
                      </template>
                      <el-icon class="admin-unit-info"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </span>
                </template>
                <template #default="{ row }">
                  <div class="ws-sa-usage">
                    <div class="ws-sa-usage__top">
                      <el-tag :type="row.usage?.aiEnabled ? 'success' : 'info'" size="small">
                        {{ row.usage?.aiEnabled ? '啟用' : '未啟用' }}
                      </el-tag>
                      <span class="text-sm">呼叫 {{ (row.usage?.invocations ?? 0).toLocaleString('zh-TW') }} 次</span>
                    </div>
                    <div v-if="(row.usage?.invocations ?? 0) > 0" class="text-xs text-muted">
                      答出 {{ (row.usage?.answered ?? 0).toLocaleString('zh-TW') }} 則
                      <template v-if="(row.usage?.conversationCostUsd ?? 0) > 0">・約 NT${{ Math.round((row.usage?.conversationCostUsd ?? 0) * 32).toLocaleString('zh-TW') }}</template>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="LINE 設定" width="100" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.channelAccessTokenConfigured && row.channelSecretConfigured" type="success" size="small">已設定</el-tag>
                  <el-tag v-else type="warning" size="small">未完整</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="130" align="right">
                <template #default="{ row }">
                  <el-button size="small" plain @click="openEdit(row)">編輯</el-button>
                  <el-button size="small" plain @click="enterWorkspace(row.id)">進入</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <!-- Create dialog -->
  <el-dialog v-model="showCreate" title="建立官方帳號" width="min(480px, 92vw)">
    <div class="admin-panel-stack">
      <div class="admin-field-group">
        <AdminFieldLabel text="帳號名稱" tight />
        <el-input v-model="form.name" placeholder="例：MyFeel 官方帳號" />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="Owner Email" tight />
        <el-input v-model="form.ownerEmail" placeholder="owner@example.com" />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="所屬組織（必填）" tight />
        <el-select
          v-model="form.organizationId"
          placeholder="請選擇組織"
          style="width: 100%"
          :class="{ 'ws-sa-select-error': createSubmitted && !form.organizationId }"
        >
          <el-option v-for="org in orgs" :key="org.id" :label="org.name" :value="org.id" />
        </el-select>
        <p v-if="createSubmitted && !form.organizationId" class="ws-sa-field-error">請選擇所屬組織</p>
      </div>
    </div>
    <template #footer>
      <el-button @click="showCreate = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="createWorkspace">建立</el-button>
    </template>
  </el-dialog>

  <!-- Edit dialog -->
  <el-dialog v-model="showEdit" title="編輯官方帳號" width="min(440px, 92vw)">
    <div class="admin-panel-stack">
      <div v-if="!editForm.organizationId" class="ws-sa-no-org-warning">
        此帳號尚未歸屬任何組織，org admin 將無法存取，建議補填。
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="帳號名稱" tight />
        <el-input v-model="editForm.name" />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="所屬組織" tight />
        <el-select v-model="editForm.organizationId" placeholder="未指定" clearable style="width: 100%">
          <el-option v-for="org in orgs" :key="org.id" :label="org.name" :value="org.id" />
        </el-select>
      </div>

      <el-divider content-position="left">計費方案</el-divider>

      <div class="admin-field-group">
        <AdminFieldLabel text="方案" tight />
        <el-select v-model="editForm.planId" placeholder="未開通（不攔截則數）" clearable style="width: 100%">
          <el-option v-for="id in planOrder" :key="id" :label="planOptionLabel(id)" :value="id" />
        </el-select>
        <p class="text-xs text-muted" style="margin-top: 4px">未開通的帳號不會被則數上限攔截（沿用內部 token 護欄）。</p>
      </div>

      <template v-if="editForm.planId">
        <div class="admin-field-group">
          <AdminFieldLabel text="訂閱狀態" tight />
          <el-select v-model="editForm.status" style="width: 100%">
            <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </div>
        <div class="admin-field-group">
          <AdminFieldLabel text="到期日（選填）" tight />
          <el-date-picker
            v-model="editForm.currentPeriodEnd"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="不設定"
            style="width: 100%"
          />
        </div>
        <div class="admin-field-group">
          <AdminFieldLabel text="額度覆蓋（選填，留空用方案預設）" tight />
          <el-input-number
            v-model="editForm.quotaOverride"
            :min="0"
            :controls="false"
            :placeholder="quotaPlaceholder"
            style="width: 100%"
          />
        </div>
        <div class="admin-field-group">
          <AdminFieldLabel text="備註（選填，僅內部）" tight />
          <el-input v-model="editForm.note" placeholder="開通原因 / 合約號…" />
        </div>
      </template>
    </div>
    <template #footer>
      <el-button @click="showEdit = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveEdit">儲存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { InfoFilled } from '@element-plus/icons-vue'
import { BILLING_PLANS, BILLING_PLAN_ORDER } from '~~/shared/billing/plans'
import type { BillingPlanId, SubscriptionStatus } from '~~/shared/billing/plans'
import { CALL_UNIT_TIP, REPLY_UNIT_TIP } from '~~/shared/billing/usage-units'

definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '官方帳號管理 — 超級管理員' })

const { apiFetch } = useSuperAdmin()
const { showToast } = useAdminToast()

const loading = ref(false)
const saving = ref(false)
const workspaces = ref<any[]>([])
const orgs = ref<any[]>([])
const showCreate = ref(false)
const showEdit = ref(false)
const editTarget = ref<any>(null)
const createSubmitted = ref(false)

const orgNameMap = computed<Record<string, string>>(() =>
  Object.fromEntries(orgs.value.map(o => [o.id, o.name])),
)

const visibleWorkspaces = computed(() =>
  workspaces.value.filter(w => String(w?.id || '').trim() !== 'default'),
)

const form = reactive({
  name: '',
  ownerEmail: '',
  organizationId: '',
})

const editForm = reactive<{
  name: string
  organizationId: string
  planId: BillingPlanId | ''
  status: SubscriptionStatus
  currentPeriodEnd: string | null
  quotaOverride: number | undefined
  note: string
}>({
  name: '',
  organizationId: '',
  planId: '',
  status: 'active',
  currentPeriodEnd: null,
  quotaOverride: undefined,
  note: '',
})

const planOrder = BILLING_PLAN_ORDER
const statusOptions: { value: SubscriptionStatus; label: string }[] = [
  { value: 'active', label: '啟用中' },
  { value: 'trialing', label: '試用中' },
  { value: 'past_due', label: '逾期未付' },
  { value: 'canceled', label: '已取消' },
]

function planName(id: string): string {
  return BILLING_PLANS[id as BillingPlanId]?.name ?? id
}
function planOptionLabel(id: BillingPlanId): string {
  const p = BILLING_PLANS[id]
  const quota = p.answeredQuota == null ? '客製' : `${p.answeredQuota.toLocaleString()} 則`
  return `${p.name}（${quota}／月）`
}
function statusLabel(s: string): string {
  return statusOptions.find(o => o.value === s)?.label ?? s
}
function statusTagType(s: string): 'success' | 'primary' | 'warning' | 'info' {
  if (s === 'active') return 'success'
  if (s === 'trialing') return 'primary'
  if (s === 'past_due') return 'warning'
  return 'info'
}
const quotaPlaceholder = computed(() => {
  if (!editForm.planId) return '方案預設'
  const q = BILLING_PLANS[editForm.planId].answeredQuota
  return q == null ? '客製（不設上限）' : `方案預設 ${q.toLocaleString()} 則`
})

async function load() {
  loading.value = true
  try {
    [workspaces.value, orgs.value] = await Promise.all([
      apiFetch<any[]>('/api/admin/super/workspaces'),
      apiFetch<any[]>('/api/admin/super/organizations'),
    ])
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '載入失敗', 'error')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.name = ''
  form.ownerEmail = ''
  form.organizationId = ''
  createSubmitted.value = false
  showCreate.value = true
}

function openEdit(row: any) {
  editTarget.value = row
  editForm.name = row.name
  editForm.organizationId = row.organizationId ?? ''
  const sub = row.subscription
  editForm.planId = sub?.planId ?? ''
  editForm.status = sub?.status ?? 'active'
  editForm.currentPeriodEnd = sub?.currentPeriodEnd ?? null
  editForm.quotaOverride = sub?.quotaOverride ?? undefined
  editForm.note = sub?.note ?? ''
  showEdit.value = true
}

async function createWorkspace() {
  createSubmitted.value = true
  if (!form.name.trim()) return showToast('請輸入帳號名稱', 'error')
  if (!form.ownerEmail.trim()) return showToast('請輸入 Owner Email', 'error')
  if (!form.organizationId) return showToast('請選擇所屬組織', 'error')
  saving.value = true
  try {
    await apiFetch('/api/admin/super/workspaces', {
      method: 'POST',
      body: {
        name: form.name,
        ownerEmail: form.ownerEmail,
        organizationId: form.organizationId || null,
      },
    })
    showToast('官方帳號已建立', 'success')
    showCreate.value = false
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '建立失敗', 'error')
  } finally {
    saving.value = false
  }
}

async function saveEdit() {
  if (!editForm.name.trim()) return showToast('名稱不能為空', 'error')
  saving.value = true
  try {
    const subscription = editForm.planId
      ? {
          planId: editForm.planId,
          status: editForm.status,
          currentPeriodStart: editTarget.value?.subscription?.currentPeriodStart ?? null,
          currentPeriodEnd: editForm.currentPeriodEnd || null,
          // 原樣帶回錨定日：若只靠 currentPeriodStart 反推，錨定日 31 的訂閱在經過 2 月
          // （起日被夾成 28）之後會被永久改成 28，之後再也回不到 31。
          anchorDay: editTarget.value?.subscription?.anchorDay ?? null,
          quotaOverride: editForm.quotaOverride ?? null,
          note: editForm.note.trim() || null,
        }
      : null
    await apiFetch(`/api/admin/super/workspaces/${editTarget.value.id}`, {
      method: 'PATCH',
      body: {
        name: editForm.name,
        organizationId: editForm.organizationId || null,
        subscription,
      },
    })
    showToast('已更新', 'success')
    showEdit.value = false
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '更新失敗', 'error')
  } finally {
    saving.value = false
  }
}

function enterWorkspace(id: string) {
  navigateTo(`/admin/${id}/conversation-stats`)
}

onMounted(load)
</script>
