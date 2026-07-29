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
              <el-table-column v-if="invoiceEnabled" label="發票" min-width="110">
                <template #default="{ row }">
                  <span v-if="row.invoiceStatus === 'voided'" class="text-xs text-muted">已作廢</span>
                  <span v-else-if="row.invoiceNumber" class="sa-pay-order-no">{{ row.invoiceNumber }}</span>
                  <el-tag v-else-if="row.invoiceStatus === 'failed'" type="danger" size="small">開立失敗</el-tag>
                  <span v-else class="text-xs text-muted">—</span>
                </template>
              </el-table-column>
              <el-table-column v-if="invoiceEnabled" label="操作" width="130">
                <template #default="{ row }">
                  <template v-if="row.invoiceStatus === 'issued' && row.invoiceNumber">
                    <el-button
                      size="small"
                      type="danger"
                      link
                      :loading="acting === row.merchantOrderNo"
                      @click="voidOrderInvoice(row)"
                    >作廢</el-button>
                    <el-button size="small" type="primary" link @click="openAllowance(row)">折讓</el-button>
                  </template>
                  <span v-else class="text-xs text-muted">—</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!--
          折讓對話框:銷貨退回／部分退款用,對原發票開折讓證明單(原發票不作廢)。
          金額預設全額、可改部分;買方以原發票快照為準(見 allowance.post.ts)。
        -->
        <el-dialog v-model="allowance.open" title="開立折讓" width="min(420px, 92vw)">
          <div class="sa-allowance-form">
            <p class="text-xs text-muted">
              折讓用於銷貨退回／部分退款,會對原發票開折讓證明單(原發票不作廢)。逾作廢時效或已申報的退款走這裡。<br>
              發票號碼 <span class="sa-pay-order-no">{{ allowance.invoiceNumber }}</span> · 原金額 NT${{ allowance.originalAmt.toLocaleString() }}
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="折讓金額(含稅)" tight />
              <el-input-number
                v-model="allowance.amount"
                :min="1"
                :max="allowance.originalAmt"
                :step="1"
                step-strictly
                controls-position="right"
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="折讓原因／品名" tight />
              <el-input v-model="allowance.reason" placeholder="如:退款折讓、部分退費" maxlength="60" />
            </div>
          </div>
          <template #footer>
            <el-button @click="allowance.open = false">取消</el-button>
            <el-button
              type="primary"
              :loading="allowance.loading"
              :disabled="!allowance.reason.trim() || !(allowance.amount >= 1)"
              @click="submitAllowance"
            >確認開立折讓</el-button>
          </template>
        </el-dialog>
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

const config = useRuntimeConfig()
const invoiceEnabled = Boolean(config.public.invoiceEnabled)

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
  invoiceNumber: string | null
  invoiceStatus: 'issued' | 'failed' | 'skipped' | 'voided' | null
}
interface Summary { thisMonth: string; monthRevenue: number; monthPaidCount: number; monthFailedCount: number; pendingCount: number; count: number }

const loading = ref(false)
const orders = ref<PayOrder[]>([])
const summary = ref<Summary>({ thisMonth: '', monthRevenue: 0, monthPaidCount: 0, monthFailedCount: 0, pendingCount: 0, count: 0 })

// ── 作廢發票 ──────────────────────────────────────────────
// 作廢有時效（B2C 2 日 / B2B 7 日、當期未申報）,逾期只能改折讓——這裡先提示,實際時效由光貲端認定。
const acting = ref('')
async function voidOrderInvoice(row: PayOrder) {
  let reason: string
  try {
    const r = await ElMessageBox.prompt(
      `將作廢發票 ${row.invoiceNumber}（${row.workspaceName}）。\n⚠️ 作廢僅限開立後短期內（B2C 2 日／B2B 7 日、當期未申報）;逾期請改開折讓。若客戶還需要發票,作廢後要另行重開。`,
      '作廢發票',
      {
        confirmButtonText: '確認作廢',
        cancelButtonText: '取消',
        inputPlaceholder: '作廢原因(必填,如:統編填錯、重複開立、已退款)',
        inputValidator: (v: string) => (v && v.trim() ? true : '請填寫作廢原因'),
        type: 'warning',
      },
    )
    reason = String(r.value || '').trim()
  }
  catch { return } // 使用者取消
  if (!reason) return

  acting.value = row.merchantOrderNo
  try {
    await apiFetch('/api/admin/super/void-invoice', {
      method: 'POST',
      body: { merchantOrderNo: row.merchantOrderNo, reason },
    })
    showToast('發票已作廢', 'success')
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '作廢失敗', 'error')
  }
  finally {
    acting.value = ''
  }
}

// ── 開折讓 ──────────────────────────────────────────────
// 銷貨退回／部分退款用;金額預設全額、可改部分。買方以原發票快照為準(後端擋)。
const allowance = reactive({
  open: false,
  merchantOrderNo: '',
  invoiceNumber: '',
  originalAmt: 0,
  amount: 0,
  reason: '',
  loading: false,
})
function openAllowance(row: PayOrder) {
  allowance.merchantOrderNo = row.merchantOrderNo
  allowance.invoiceNumber = row.invoiceNumber || ''
  allowance.originalAmt = row.amount
  allowance.amount = row.amount
  allowance.reason = ''
  allowance.open = true
}
async function submitAllowance() {
  const reason = allowance.reason.trim()
  if (!reason || !(allowance.amount >= 1)) return
  allowance.loading = true
  try {
    await apiFetch('/api/admin/super/allowance', {
      method: 'POST',
      body: { merchantOrderNo: allowance.merchantOrderNo, amount: allowance.amount, reason },
    })
    showToast('折讓已開立', 'success')
    allowance.open = false
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '折讓失敗', 'error')
  }
  finally {
    allowance.loading = false
  }
}

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
