<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="超級管理員"
        title="金流總覽"
        caption="本租戶所有官方帳號的付款紀錄與本月營收。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button :loading="loading" @click="load">重新整理</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <!-- 摘要 -->
        <div class="message-card ar-section-card">
          <div class="sa-pay-summary">
            <div class="sa-pay-stat">
              <div class="sa-pay-stat__label">本月營收（{{ summary.thisMonth || '—' }}）</div>
              <div class="sa-pay-stat__value">NT$ {{ summary.monthRevenue.toLocaleString() }}</div>
            </div>
            <div class="sa-pay-stat">
              <div class="sa-pay-stat__label">本月成交</div>
              <div class="sa-pay-stat__value">{{ summary.monthPaidCount }} 筆</div>
            </div>
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--alert': summary.monthFailedCount > 0 }">
              <div class="sa-pay-stat__label">本月刷卡失敗</div>
              <div class="sa-pay-stat__value">{{ summary.monthFailedCount }} 筆</div>
              <div class="sa-pay-stat__hint">含同一筆重試</div>
            </div>
            <div class="sa-pay-stat">
              <div class="sa-pay-stat__label">待付款</div>
              <div class="sa-pay-stat__value">{{ summary.pendingCount }} 筆</div>
            </div>
          </div>
        </div>

        <!-- 明細 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">付款紀錄</span>
            </div>
            <span class="text-xs text-muted">最近 {{ orders.length }} 筆</span>
          </div>
          <div class="card-section-stack">
            <el-table v-loading="loading" :data="orders" size="small" empty-text="尚無付款紀錄">
              <el-table-column label="時間" width="150">
                <template #default="{ row }"><span class="text-xs text-muted">{{ fmtTime(row.createdAt) }}</span></template>
              </el-table-column>
              <el-table-column label="官方帳號" min-width="160">
                <template #default="{ row }"><span class="text-sm font-bold">{{ row.workspaceName }}</span></template>
              </el-table-column>
              <el-table-column label="方案" width="90">
                <template #default="{ row }">{{ planName(row.planId) }}</template>
              </el-table-column>
              <el-table-column label="金額" width="110" align="right">
                <template #default="{ row }">NT${{ row.amount.toLocaleString() }}</template>
              </el-table-column>
              <el-table-column label="狀態" width="90">
                <template #default="{ row }"><el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag></template>
              </el-table-column>
              <el-table-column label="付款方式" width="90">
                <template #default="{ row }">{{ payTypeLabel(row.paymentType) }}</template>
              </el-table-column>
              <el-table-column label="訂單編號" min-width="160">
                <template #default="{ row }"><span class="sa-pay-order-no">{{ row.merchantOrderNo }}</span></template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { BILLING_PLANS } from '~~/shared/billing/plans'

definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '金流總覽 — 超級管理員' })

const { apiFetch } = useSuperAdmin()
const { showToast } = useAdminToast()

interface PayOrder {
  merchantOrderNo: string
  workspaceId: string
  workspaceName: string
  planId: string
  amount: number
  status: string
  paymentType: string | null
  createdAt: number | null
  paidAt: number | null
}
interface Summary { thisMonth: string; monthRevenue: number; monthPaidCount: number; monthFailedCount: number; pendingCount: number; count: number }

const loading = ref(false)
const orders = ref<PayOrder[]>([])
const summary = ref<Summary>({ thisMonth: '', monthRevenue: 0, monthPaidCount: 0, monthFailedCount: 0, pendingCount: 0, count: 0 })

async function load() {
  loading.value = true
  try {
    const res = await apiFetch<{ orders: PayOrder[]; summary: Summary }>('/api/admin/super/payments')
    orders.value = res.orders
    summary.value = res.summary
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '讀取失敗', 'error')
  }
  finally {
    loading.value = false
  }
}
onMounted(load)

function planName(id: string) { return BILLING_PLANS[id as keyof typeof BILLING_PLANS]?.name ?? id }

const STATUS_LABEL: Record<string, string> = { pending: '待付款', paid: '已付款', failed: '失敗', expired: '已逾期' }
function statusLabel(s: string) { return STATUS_LABEL[s] ?? s }
function statusType(s: string): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'paid') return 'success'
  if (s === 'failed') return 'danger'
  if (s === 'pending') return 'warning'
  return 'info'
}

const PAY_TYPE_LABEL: Record<string, string> = { CREDIT: '信用卡', VACC: 'ATM 轉帳', WEBATM: 'WebATM', CVS: '超商代碼', BARCODE: '超商條碼' }
function payTypeLabel(t: string | null) { return t ? (PAY_TYPE_LABEL[t] ?? t) : '—' }

function fmtTime(ms: number | null) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>
