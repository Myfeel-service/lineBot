<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="超級管理員"
        title="金流總覽"
        caption="本租戶所有官方帳號的付款紀錄與本月營收。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button @click="openCredit">開折抵</el-button>
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
              <el-table-column label="狀態" width="110">
                <template #default="{ row }">
                  <el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
                  <!-- 人工退款只是紀錄(不動金流),但列表要看得出「這筆錢已退」,否則對帳會把它當正常營收 -->
                  <el-tooltip v-if="row.manualRefundTotal" placement="top" :content="`已退款 NT$${row.manualRefundTotal.toLocaleString()}（人工於 PAYUNi 後台退款,系統留痕）`">
                    <el-tag type="warning" size="small" class="sa-pay-refund-tag">
                      {{ row.manualRefundTotal >= row.amount ? '已退款' : '部分退款' }}
                    </el-tag>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="付款方式" width="90">
                <template #default="{ row }">{{ payTypeLabel(row.paymentType) }}</template>
              </el-table-column>
              <el-table-column label="訂單編號" min-width="160">
                <template #default="{ row }"><span class="sa-pay-order-no">{{ row.merchantOrderNo }}</span></template>
              </el-table-column>
              <el-table-column v-if="invoiceEnabled" label="發票" min-width="130">
                <template #default="{ row }">
                  <!-- 號碼可點開明細(含已作廢的——作廢原因要查得到);與客戶端同一支組裝,口徑一致 -->
                  <el-button
                    v-if="row.invoiceNumber"
                    link
                    type="primary"
                    size="small"
                    class="sa-pay-order-no"
                    @click="openInvoiceDetail(row)"
                  >{{ row.invoiceNumber }}</el-button>
                  <el-tag v-if="row.invoiceStatus === 'voided'" type="info" size="small">已作廢</el-tag>
                  <el-tag v-else-if="row.invoiceAllowanceTotal" type="warning" size="small">已折讓</el-tag>
                  <el-tag v-else-if="row.invoiceStatus === 'failed'" type="danger" size="small">開立失敗</el-tag>
                  <span v-else-if="!row.invoiceNumber" class="text-xs text-muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="150">
                <template #default="{ row }">
                  <template v-if="invoiceEnabled && row.invoiceStatus === 'issued' && row.invoiceNumber">
                    <el-button
                      size="small"
                      type="danger"
                      link
                      :loading="acting === row.merchantOrderNo"
                      @click="voidOrderInvoice(row)"
                    >作廢</el-button>
                    <el-button size="small" type="primary" link @click="openAllowance(row)">折讓</el-button>
                  </template>
                  <!-- 記退款不依賴發票開關:退錢是金流動作,發票沒接也可能要退 -->
                  <el-button
                    v-if="row.status === 'paid'"
                    size="small"
                    type="warning"
                    link
                    @click="openRefund(row)"
                  >記退款</el-button>
                  <span v-else-if="!(invoiceEnabled && row.invoiceStatus === 'issued' && row.invoiceNumber)" class="text-xs text-muted">—</span>
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

        <!--
          折抵對話框:給帳號一筆「可折抵下期扣款」的餘額。
          與「折讓」不同——折讓是對已開發票做稅務沖銷(退錢);折抵是「下期少收錢」,
          不動原發票、不退現金(老闆 2026-07-29 拍板)。升級差額、服務補償走這裡。
        -->
        <el-dialog v-model="credit.open" title="開折抵（折抵下期扣款）" width="min(440px, 92vw)">
          <div class="sa-allowance-form">
            <p class="text-xs text-muted">
              折抵會在該帳號<strong>下一期自動扣款</strong>時直接少收，原發票完全不動、不需折讓（稅務乾淨）。<br>
              可累積、逐期折到用完；若折抵 ≥ 月費，那期就完全不向信用卡請款、也不開發票。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="官方帳號 ID" tight />
              <el-input v-model="credit.workspaceId" placeholder="workspace ID" />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="折抵金額(含稅)" hint="可填負數以沖銷開錯的折抵；餘額不會低於 0" tight />
              <el-input-number v-model="credit.amount" :step="1" step-strictly controls-position="right" />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="原因" hint="會寫進 billingCredits 稽核紀錄" tight />
              <el-input v-model="credit.reason" placeholder="如:升級差額折抵、服務中斷補償" maxlength="60" />
            </div>
          </div>
          <template #footer>
            <el-button @click="credit.open = false">取消</el-button>
            <el-button
              type="primary"
              :loading="credit.loading"
              :disabled="!credit.workspaceId.trim() || !credit.reason.trim() || !credit.amount"
              @click="submitCredit"
            >確認開折抵</el-button>
          </template>
        </el-dialog>

        <!--
          記退款對話框:**純留痕,不打金流**(trade/close 未實作,見 STATUS B-11)。
          實際退款是人在 PAYUNi 商店後台操作的——原本系統完全不留痕,發票作廢有紀錄、
          錢退了沒有,對帳會斷(2026-08-16 稽核 B-44③)。與折讓的分工:折讓/作廢管稅務,
          這裡管「錢」的那半邊的帳。
        -->
        <el-dialog v-model="refund.open" title="記一筆人工退款（僅留紀錄）" width="min(440px, 92vw)">
          <div class="sa-allowance-form">
            <el-alert type="warning" :closable="false">
              <span class="text-xs">
                這裡<strong>不會真的退錢</strong>——請先在 PAYUNi 商店後台完成實際退款，再回來記這一筆。<br>
                發票的稅務動作另外走：作廢時效內用「作廢」，逾期或部分退款用「折讓」。
              </span>
            </el-alert>
            <p class="text-xs text-muted">
              訂單 <span class="sa-pay-order-no">{{ refund.merchantOrderNo }}</span> · 原請款 NT${{ refund.originalAmt.toLocaleString() }}
              <template v-if="refund.alreadyRefunded">· 先前已記退款 NT${{ refund.alreadyRefunded.toLocaleString() }}</template>
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="退款金額(含稅)" tight />
              <el-input-number
                v-model="refund.amount"
                :min="1"
                :max="refund.originalAmt - refund.alreadyRefunded"
                :step="1"
                step-strictly
                controls-position="right"
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="原因" hint="會寫進 billingRefunds 稽核紀錄" tight />
              <el-input v-model="refund.reason" placeholder="如:重複扣款退還、重大故障按日退費" maxlength="60" />
            </div>
          </div>
          <template #footer>
            <el-button @click="refund.open = false">取消</el-button>
            <el-button
              type="warning"
              :loading="refund.loading"
              :disabled="!refund.reason.trim() || !(refund.amount >= 1)"
              @click="submitRefund"
            >確認記錄</el-button>
          </template>
        </el-dialog>

        <!-- 發票明細:與客戶端帳單頁同一支組裝端點(超管版),樣式沿用共用的 bid-* class -->
        <el-dialog v-model="invoiceViewOpen" title="電子發票明細" width="min(420px, 92vw)">
          <div v-if="invoiceDetailLoading" class="billing-invoice-detail-loading">
            <div class="spinner" />
            <span class="text-sm text-muted">讀取發票明細…</span>
          </div>
          <!-- 讀取失敗不能長得像「沒有明細」——查不到 ≠ 沒有(假空狀態教訓,B-42) -->
          <el-alert v-else-if="invoiceDetailError" type="error" :closable="false">
            <span class="text-xs">{{ invoiceDetailError }}</span>
          </el-alert>
          <div v-else-if="invoiceDetail" class="billing-invoice-detail">
            <el-alert v-if="invoiceDetail.voided" type="warning" :closable="false">
              <span class="text-xs">
                這張發票已於 {{ fmtTime(invoiceDetail.voidedAt) }} 作廢{{ invoiceDetail.voidReason ? `（原因：${invoiceDetail.voidReason}）` : '' }},不可再用於報帳。
              </span>
            </el-alert>
            <div class="bid-row">
              <span class="bid-label">官方帳號</span>
              <span class="bid-value">{{ invoiceViewWorkspaceName }}</span>
            </div>
            <div class="bid-row">
              <span class="bid-label">發票號碼</span>
              <span class="billing-order-no bid-value">{{ invoiceDetail.invoiceNumber }}</span>
            </div>
            <div v-if="invoiceDetail.buyerType" class="bid-row">
              <span class="bid-label">發票類型</span>
              <span class="bid-value">{{ invoiceDetail.buyerType === 'b2b' ? '公司發票（三聯式）' : '個人發票（二聯式）' }}</span>
            </div>
            <div v-if="invoiceDetail.buyerUBN" class="bid-row">
              <span class="bid-label">統一編號</span>
              <span class="bid-value">
                <span class="billing-order-no">{{ invoiceDetail.buyerUBN }}</span>
                <el-button link size="small" type="primary" @click="copyText(invoiceDetail.buyerUBN)">複製</el-button>
              </span>
            </div>
            <div v-if="invoiceDetail.buyerName" class="bid-row">
              <span class="bid-label">{{ invoiceDetail.buyerType === 'b2b' ? '公司抬頭' : '買受人' }}</span>
              <span class="bid-value">{{ invoiceDetail.buyerName }}</span>
            </div>
            <div v-if="invoiceDetail.itemName" class="bid-row">
              <span class="bid-label">品名</span>
              <span class="bid-value">
                {{ invoiceDetail.itemName }}
                <span v-if="invoiceDetail.itemNameDerived" class="text-xs text-muted">（依現行方案名回推,以發票正本為準）</span>
              </span>
            </div>
            <div v-if="invoiceDetail.randomNum" class="bid-row">
              <span class="bid-label">隨機碼</span>
              <span class="bid-value">
                <span class="billing-order-no">{{ invoiceDetail.randomNum }}</span>
                <el-button link size="small" type="primary" @click="copyText(invoiceDetail.randomNum)">複製</el-button>
              </span>
            </div>
            <div class="bid-row">
              <span class="bid-label">開立時間</span>
              <span class="bid-value">{{ fmtTime(invoiceDetail.issuedAt) }}</span>
            </div>
            <div class="bid-row">
              <span class="bid-label">金額</span>
              <span class="bid-value">
                含稅 NT${{ invoiceDetail.totalAmt.toLocaleString() }}
                <span class="text-xs text-muted">（銷售額 {{ invoiceDetail.amt.toLocaleString() }} ＋ 稅額 {{ invoiceDetail.taxAmt.toLocaleString() }}）</span>
              </span>
            </div>
            <template v-if="invoiceDetail.allowanceTotal > 0">
              <div class="bid-row">
                <span class="bid-label">折讓紀錄</span>
                <span class="bid-value bid-allowance-list">
                  <span v-for="a in invoiceDetail.allowances" :key="a.allowanceNumber" class="bid-allowance">
                    −NT${{ a.amount.toLocaleString() }}・{{ a.reason }}
                    <span class="text-xs text-muted">（{{ a.createdAtMs ? fmtTime(a.createdAtMs) : '時間不詳' }}・單號 {{ a.allowanceNumber }}）</span>
                  </span>
                </span>
              </div>
              <div class="bid-row">
                <span class="bid-label">折讓後金額</span>
                <span class="bid-value">
                  含稅 NT${{ invoiceDetail.netAmt.toLocaleString() }}
                  <span class="text-xs text-muted">（原發票 NT${{ invoiceDetail.totalAmt.toLocaleString() }} − 已折讓 NT${{ invoiceDetail.allowanceTotal.toLocaleString() }}）</span>
                </span>
              </div>
            </template>
          </div>
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
  invoiceAllowanceTotal: number | null
  manualRefundTotal: number | null
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

// ── 開折抵（折抵下期扣款）──────────────────────────────────
// 與折讓的分工:折讓=對已開發票做稅務沖銷(退錢);折抵=下期少收錢,不動原發票、不退現金。
const credit = reactive({ open: false, loading: false, workspaceId: '', amount: 0, reason: '' })
function openCredit() {
  credit.workspaceId = ''
  credit.amount = 0
  credit.reason = ''
  credit.open = true
}
async function submitCredit() {
  const workspaceId = credit.workspaceId.trim()
  const reason = credit.reason.trim()
  if (!workspaceId || !reason || !credit.amount) return
  credit.loading = true
  try {
    const r = await apiFetch<{ before: number; after: number }>('/api/admin/super/grant-credit', {
      method: 'POST',
      body: { workspaceId, amount: credit.amount, reason },
    })
    showToast(`折抵餘額 NT$${r.before.toLocaleString()} → NT$${r.after.toLocaleString()}`, 'success')
    credit.open = false
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '開折抵失敗', 'error')
  }
  finally {
    credit.loading = false
  }
}

// ── 記人工退款（純留痕,不動金流;實際退款在 PAYUNi 後台操作）────────────
const refund = reactive({
  open: false,
  loading: false,
  merchantOrderNo: '',
  originalAmt: 0,
  alreadyRefunded: 0,
  amount: 0,
  reason: '',
})
function openRefund(row: PayOrder) {
  refund.merchantOrderNo = row.merchantOrderNo
  refund.originalAmt = row.amount
  refund.alreadyRefunded = row.manualRefundTotal || 0
  refund.amount = Math.max(1, row.amount - refund.alreadyRefunded)
  refund.reason = ''
  refund.open = true
}
async function submitRefund() {
  const reason = refund.reason.trim()
  if (!reason || !(refund.amount >= 1)) return
  refund.loading = true
  try {
    await apiFetch('/api/admin/super/record-refund', {
      method: 'POST',
      body: { merchantOrderNo: refund.merchantOrderNo, amount: refund.amount, reason },
    })
    showToast('退款已記錄', 'success')
    refund.open = false
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '記錄失敗', 'error')
  }
  finally {
    refund.loading = false
  }
}

// ── 發票明細（與客戶端同一支組裝,超管版端點）────────────────────────
interface InvoiceDetail {
  invoiceNumber: string
  randomNum: string | null
  totalAmt: number
  amt: number
  taxAmt: number
  issuedAt: number | null
  buyerType: 'b2b' | 'b2c' | null
  buyerUBN: string | null
  buyerName: string | null
  itemName: string | null
  itemNameDerived: boolean
  voided: boolean
  voidReason: string | null
  voidedAt: number | null
  allowances: { allowanceNumber: string; amount: number; reason: string; createdAtMs: number | null }[]
  allowanceTotal: number
  netAmt: number
}
const invoiceViewOpen = ref(false)
const invoiceDetailLoading = ref(false)
const invoiceDetail = ref<InvoiceDetail | null>(null)
// 讀取失敗要明講——空視窗長得像「沒有明細」,把故障演成沒資料（B-42 同款教訓）
const invoiceDetailError = ref('')
const invoiceViewWorkspaceName = ref('')
async function openInvoiceDetail(row: PayOrder) {
  invoiceViewOpen.value = true
  invoiceDetailLoading.value = true
  invoiceDetail.value = null
  invoiceDetailError.value = ''
  invoiceViewWorkspaceName.value = row.workspaceName
  try {
    invoiceDetail.value = await apiFetch<InvoiceDetail>(
      `/api/admin/super/invoice-detail?order=${encodeURIComponent(row.merchantOrderNo)}`,
    )
  }
  catch (e: any) {
    invoiceDetailError.value = e?.data?.statusMessage || '讀取發票明細失敗,請重試'
  }
  finally {
    invoiceDetailLoading.value = false
  }
}
async function copyText(text: string | null) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    showToast('已複製', 'success')
  }
  catch {
    showToast('複製失敗,請手動選取', 'error')
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
