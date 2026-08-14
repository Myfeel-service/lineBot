<template>
  <el-dialog
    :model-value="modelValue"
    title="選擇方案"
    width="min(720px, 95vw)"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <!-- 方案比較表：方案為列、規格為欄，橫向對齊好比較「升級到底多拿到什麼」。
         窄螢幕時整張表可左右捲動（see .plan-compare-scroll），不擠壓欄位。 -->
    <div class="plan-compare-scroll">
      <el-table :data="plans" size="small" class="plan-compare-table" :row-class-name="rowClass">
        <el-table-column label="方案" min-width="104" fixed>
          <template #default="{ row }">
            <span class="pu-name">{{ row.name }}</span>
            <el-tag v-if="row.id === currentPlanId" size="small" type="success" effect="plain">目前</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="每月則數" min-width="84">
          <template #default="{ row }">{{ quotaLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="席次" min-width="58">
          <template #default="{ row }">{{ row.seats == null ? '不限' : `${row.seats} 席` }}</template>
        </el-table-column>
        <el-table-column label="腳本" width="54" align="center">
          <template #default="{ row }"><span :class="row.scripting ? 'pu-yes' : 'pu-no'">{{ row.scripting ? '✓' : '—' }}</span></template>
        </el-table-column>
        <el-table-column label="API" width="52" align="center">
          <template #default="{ row }"><span :class="row.api ? 'pu-yes' : 'pu-no'">{{ row.api ? '✓' : '—' }}</span></template>
        </el-table-column>
        <el-table-column label="月費" min-width="92" align="right">
          <template #default="{ row }">{{ priceLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="" min-width="88" align="right">
          <template #default="{ row }">
            <el-tooltip
              v-if="canCheckout(row)"
              :disabled="paymentEnabled && agreed"
              :content="paymentEnabled ? '請先勾選下方的條款同意' : '線上付款尚未開通，請聯繫我們'"
              placement="top"
            >
              <!-- disabled 的按鈕不會觸發 tooltip，需外層 span 承接 hover -->
              <span>
                <el-button
                  :type="planAction(row) === '降級' ? 'info' : 'primary'"
                  :plain="planAction(row) === '降級'"
                  size="small"
                  :disabled="!isScheduledDowngrade(row) && (!paymentEnabled || !agreed)"
                  :loading="checkoutLoading === row.id"
                  @click="checkout(row)"
                >
                  <!-- 期末降級沒有新的一筆交易 → 不需勾同意、也不受金流未設定影響,
                       而且按鈕要講清楚是「期末」生效,別讓人以為按下去就馬上降。 -->
                  {{ isScheduledDowngrade(row) ? '期末降級' : planAction(row) }}
                </el-button>
              </span>
            </el-tooltip>
            <template v-else-if="row.custom">
              <el-button v-if="contactHref" size="small" @click="contactUs">聯繫我們</el-button>
              <span v-else class="text-xs text-muted">請洽窗口</span>
            </template>
            <!-- 免費層：不需結帳，但也不要留空白格（會像壞掉） -->
            <span v-else class="text-xs text-muted">{{ row.id === currentPlanId ? '使用中' : '免費' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div class="plan-upgrade-foot">
      <!-- 條款同意：勾了才能按付款。這不是裝飾——「不適用七日猶豫期」的法律前提就是
           付款前取得同意（見 shared/legal.ts），同意紀錄會寫進訂單。
           連結不放在 checkbox 的 label 裡（點連結會誤觸勾選），改列在下一行。 -->
      <el-checkbox v-model="agreed" class="plan-upgrade-consent">{{ CHECKOUT_CONSENT_TEXT }}</el-checkbox>
      <div class="plan-upgrade-policies">
        <span class="text-xs text-muted">條款全文</span>
        <a v-for="p in POLICY_LINKS" :key="p.to" :href="p.to" target="_blank" rel="noopener">{{ p.label }}</a>
      </div>
      <span class="text-xs text-muted">
        方案以「官方帳號」為單位各自計價，額度不跨帳號共用。所有價格均為含稅價。付款由統一金流 PAYUNi 處理，付款後開立電子發票。
        <template v-if="recurringEnabled">每月自動續扣，可隨時取消，取消後用到本期結束。</template>
      </span>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElLoading, ElMessageBox } from 'element-plus'
import { BILLING_PLANS, BILLING_PLAN_ORDER, type BillingPlan, type BillingPlanId } from '~~/shared/billing/plans'
import { CHECKOUT_CONSENT_TEXT, POLICY_LINKS } from '~~/shared/legal'

const props = defineProps<{
  modelValue: boolean
  currentPlanId?: string | null
  /**
   * 背後有生效中的自動扣款委託。有的話**降級改成期末生效**（不立即扣款、不吃掉客戶
   * 已付的剩餘天數）；沒有的話降級就是「下次自己買便宜的方案」= 立即付款一期。
   */
  hasMandate?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; changed: [] }>()

// 內部/測試方案不對客戶顯示（僅 super admin 指派）。
// ⚠️ 也要濾掉 landingHidden：那個旗標的意思是「這個售價**沒有向 PAYUNi 申報**」，
//    而這張表不是型錄、是真的能按下去結帳的（見下面的 checkout），
//    露出來等於讓客戶買得到一個未申報的價格。2026-08-14 補上——原本只濾 internal，
//    專業版 4,990 一直從這裡漏出去。要恢復販售請先完成申報再拿掉 landingHidden。
const plans = BILLING_PLAN_ORDER.map(id => BILLING_PLANS[id]).filter(p => !p.internal && !p.landingHidden)

/** 比較表裡把「目前方案」那一列淡淡標色，一眼看到自己在哪。 */
function rowClass({ row }: { row: BillingPlan }) {
  return row.id === props.currentPlanId ? 'plan-compare-row--current' : ''
}

/** 相對目前方案的動作：續訂 / 升級 / 降級——避免客戶把降級誤看成升級而誤扣款。 */
function planAction(p: BillingPlan): '續訂' | '升級' | '降級' {
  if (p.id === props.currentPlanId) return '續訂'
  const cur = BILLING_PLAN_ORDER.indexOf((props.currentPlanId ?? 'free') as BillingPlanId)
  return BILLING_PLAN_ORDER.indexOf(p.id) > cur ? '升級' : '降級'
}

const { getBearer, workspaceId } = useWorkspace()
const { showToast } = useAdminToast()

const config = useRuntimeConfig()
/** PAYUNi 金鑰都設好才允許結帳；否則按下去只會拿到 500「金流尚未設定」。 */
const paymentEnabled = Boolean(config.public.paymentEnabled)
/**
 * 每月自動扣款是否已開通（PAYUNi 信用卡約定 Token；見 PAYUNI_PERIOD_ENABLED）。
 * 開通 → 首刷同時建立約定、之後每月自動扣款；未開通 → 單次付款（客戶每個月自己回來刷）。
 *
 * ⚠️ 這個旗標只決定**文案與同意內容**,不決定打哪支 API——兩條路都走 create-order
 *    （建約定與否由後端同一支旗標決定）。文案與實際行為必須同源,否則會出現
 *    「畫面說單次付款、實際綁了每月扣款」——那是同意瑕疵,不只是文案不一致。
 */
const recurringEnabled = Boolean(config.public.recurringEnabled)
const contact = String(config.public.supportContact ?? '').trim()
const contactHref = contact
  ? (contact.startsWith('http') ? contact : `mailto:${contact}`)
  : ''
function contactUs() {
  if (contactHref) window.open(contactHref, '_blank')
}

/** 可線上結帳:付費且非客製方案(免費層不需結帳、企業走聯繫)。 */
function canCheckout(p: BillingPlan): boolean {
  return !p.custom && p.priceMonthly != null && p.priceMonthly > 0
}

const checkoutLoading = ref('')

/**
 * 是否已勾選同意條款。每次開啟對話框都重設為未勾選——同意要對應「這一次」的結帳，
 * 上次開著沒付款的勾選不該延用。
 */
const agreed = ref(false)
watch(() => props.modelValue, (open) => { if (open) agreed.value = false })

interface CreateOrderResponse { action: string; method: string; fields: Record<string, string> }

/**
 * 降級走「期末生效」而不是立即付款——條件是背後真的有自動扣款委託（有那一刻可以生效）。
 * 沒有委託的人降級 = 下次自己買便宜的方案,仍走一般結帳。
 */
function isScheduledDowngrade(p: BillingPlan): boolean {
  return props.hasMandate === true && planAction(p) === '降級'
}

/** 預約期末降級：不收錢、不動本期方案,只記下下期要換成哪個方案。 */
async function scheduleDowngrade(p: BillingPlan) {
  if (!workspaceId.value) return
  try {
    await ElMessageBox.confirm(
      `「${p.name}」方案（${quotaLabel(p)}）會在「本期結束後」才生效——目前方案可以用到期末，`
      + `剩餘天數不會消失，這次也不會扣款。下一次自動扣款起改收 NT$${(p.priceMonthly ?? 0).toLocaleString()}/月。`,
      '確認預約降級',
      { confirmButtonText: '預約期末降級', cancelButtonText: '取消', type: 'warning' },
    )
  }
  catch {
    return // 使用者取消
  }
  checkoutLoading.value = p.id
  try {
    const token = await getBearer()
    const r = await $fetch<{ effectiveFrom: string | null }>('/api/payment/schedule-plan-change', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { planId: p.id, workspaceId: workspaceId.value },
    })
    showToast(`已預約：${r.effectiveFrom ?? '本期'}之後改為「${p.name}」方案`, 'success')
    emit('changed')
    emit('update:modelValue', false)
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || e?.data?.message || e?.message || '預約降級失敗', 'error')
  }
  finally {
    checkoutLoading.value = ''
  }
}

async function checkout(p: BillingPlan) {
  if (!workspaceId.value) return
  // 期末降級不經過金流,所以不需要 paymentEnabled 也不需要同意條款（沒有新的一筆交易）
  if (isScheduledDowngrade(p)) return scheduleDowngrade(p)
  if (!paymentEnabled || !agreed.value) return

  // 結帳前先確認：講清楚要付多少、買哪個方案。避免一個誤點（尤其降級）就被直接
  // 帶去外部金流扣款。
  const action = planAction(p)
  const price = (p.priceMonthly ?? 0).toLocaleString()
  const quota = quotaLabel(p) // 重述拿到什麼（每月 X 則），讓人確認價值,不只看到金額
  // 自動續訂是「授權往後每個月都扣」，這件事必須在按下去之前講清楚——事後才發現
  // 被持續扣款是最容易變成客訴與爭議款的。
  const terms = recurringEnabled
    ? `將以 NT$${price}/月（含稅）${action}「${p.name}」方案（${quota}），立即開通一個月，之後每月自動扣款。可隨時取消，取消後服務用到本期結束。`
    : `將以 NT$${price}（含稅）${action}「${p.name}」方案（${quota}・單次付款、一個月）。`
  // 沒有委託的降級仍是「重新起算一期」：舊方案剩餘天數不折抵——按下去前必須講清楚,
  // 否則使用者會「付了錢還虧掉剩餘天數」而不自知。（有委託的降級走期末生效,不會有這問題。）
  const downgradeWarn = action === '降級' ? '⚠️ 降級會立即生效，且目前方案剩餘天數不折抵。' : ''
  try {
    await ElMessageBox.confirm(
      `${downgradeWarn}${terms}接著前往統一金流 PAYUNi 的安全付款頁面完成付款。`,
      `確認${action}方案`,
      {
        confirmButtonText: recurringEnabled ? '前往付款並開始訂閱' : '前往付款',
        cancelButtonText: '取消',
        type: action === '降級' ? 'warning' : 'info',
      },
    )
  }
  catch {
    return // 使用者取消
  }

  checkoutLoading.value = p.id
  // 導向外部金流中間會有一段空白，給明確過場提示，不要讓畫面像當掉
  const overlay = ElLoading.service({ lock: true, text: '正在前往 PAYUNi 安全付款頁面…' })
  try {
    const token = await getBearer()
    // 單次付款與「首刷建立約定」共用同一支端點:PAYUNi 兩者都走 UPP,只差 EncryptInfo
    // 多帶幾個建約定欄位。（舊的 create-subscription 是藍新委託專用,已不再使用。）
    const res = await $fetch<CreateOrderResponse>('/api/payment/create-order', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      // termsAccepted：後端沒收到就不建單（同意紀錄會存進訂單，見 shared/legal.ts）
      body: { planId: p.id, workspaceId: workspaceId.value, termsAccepted: true },
    })
    if (!res.action) throw new Error('金流尚未設定')
    submitToGateway(res.action, res.fields)
    // 送出後瀏覽器即導向 PAYUNi 付款頁；overlay 保持到頁面離開為止
  }
  catch (e: any) {
    overlay.close()
    showToast(e?.data?.statusMessage || e?.data?.message || e?.message || '建立訂單失敗', 'error')
    checkoutLoading.value = ''
  }
}

// submitToGateway 由 useGatewayCheckout composable 自動 import（與帳單頁共用）

function quotaLabel(p: BillingPlan): string {
  if (p.answeredQuota == null) return '客製額度'
  return `${p.answeredQuota.toLocaleString()} 則/月`
}
function priceLabel(p: BillingPlan): string {
  if (p.priceMonthly == null) return '面談報價'
  if (p.priceMonthly === 0) return '免費'
  return `NT$${p.priceMonthly.toLocaleString()}/月`
}
</script>
