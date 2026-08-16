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
              :disabled="paymentEnabled && agreed && invoiceReady"
              :content="checkoutBlockReason"
              placement="top"
            >
              <!-- disabled 的按鈕不會觸發 tooltip，需外層 span 承接 hover -->
              <span>
                <el-button
                  :type="planAction(row) === '降級' ? 'info' : 'primary'"
                  :plain="planAction(row) === '降級'"
                  size="small"
                  :disabled="!isScheduledDowngrade(row) && (!paymentEnabled || !agreed || !invoiceReady)"
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
      <!-- 發票提示：付款成功的那一秒就會照現行設定開票（零緩衝），所以「會開出什麼」
           必須在付款前露出——沒設定過的公司客戶才不會拿到不能報帳的個人紙本發票，
           事後只能作廢重開（跨月還得走折讓）。載入失敗整塊不顯示：寧可少一行提示，
           也不能猜一個錯的發票別給人看。 -->
      <div v-if="invoiceEnabled && effectiveInvoice" class="plan-upgrade-invoice">
        <!-- 填過發票資訊（含沿用組織的）：一行摘要＋改的入口就好，不重問 -->
        <p v-if="!invoiceUnset">
          這次付款會開出：<strong>{{ invoiceLabel }}</strong>
          <a href="#" @click.prevent="goInvoiceSettings">改發票資訊</a>
        </p>
        <!-- 沒填過（預設會開個人紙本）：照一般電商慣例**就地問**要不要打統編（2026-08-17 拍板）。
             原本「先去帳單頁填」要跨三個畫面再自己走回來，公司客戶漏填就拿到不能報帳的
             個人紙本發票。選個人維持零動作，不擋人。 -->
        <template v-else>
          <div class="plan-upgrade-invoice-kind">
            <span>這次付款會開出：</span>
            <el-radio-group v-model="invoiceKind">
              <el-radio value="personal">個人發票（紙本）</el-radio>
              <el-radio value="company">公司統編發票（報帳用）</el-radio>
            </el-radio-group>
            <!-- 載具／捐贈碼低頻且欄位互斥規則多，不塞進結帳，留設定頁的入口 -->
            <a href="#" @click.prevent="goInvoiceSettings">用載具或捐贈碼？</a>
          </div>
          <div v-if="invoiceKind === 'company'" class="plan-upgrade-invoice-fields">
            <el-input v-model="b2bForm.buyerUBN" placeholder="統一編號（8 碼數字）" maxlength="8" />
            <el-input v-model="b2bForm.buyerName" placeholder="公司抬頭（發票要開給誰）" maxlength="60" />
            <el-input v-model="b2bForm.buyerEmail" placeholder="發票寄送 Email" />
            <p v-if="b2bFormatError" class="text-xs text-danger">{{ b2bFormatError }}</p>
            <p v-else class="text-xs text-muted">會存成這個官方帳號的發票資訊，之後每月自動扣款開發票也用同一組，隨時可在帳單頁修改。</p>
          </div>
        </template>
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
import { BILLING_PLANS, BILLING_PLAN_ORDER, FEATURED_PLAN_IDS, type BillingPlan, type BillingPlanId } from '~~/shared/billing/plans'
import { CHECKOUT_CONSENT_TEXT, POLICY_LINKS } from '~~/shared/legal'
import { cardStatementNotice } from '~~/shared/billing/statement'
import { describeInvoiceProfile, hasInvoiceProfile, type InvoiceProfile } from '~~/shared/types/organization'

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

// 這張表對客戶展示哪些方案，三層規則：
// 1. internal（super admin 指派的內部/測試方案）不顯示。
// 2. landingHidden（售價未向 PAYUNi 申報）不顯示——這張表不是型錄、是真的能按下去
//    結帳的，露出等於讓客戶買到未申報的價格。2026-08-14 補上，原本專業版 4,990 從這裡漏出去。
// 3. 剩下的只列「檯面上主打的」（FEATURED_PLAN_IDS，目前＝免費＋399）＋客戶**自己目前的**
//    方案——正在用 799／1,499 的客戶仍要看得到自己在哪，才能續訂或期末降級。
//    2026-08-17 補上：「只 show 399」（D-14）當時只改了官網，這張表照列全部申報價，
//    被老闆抓到「付款頁面還是有各種金額」。企業「面談報價」列也跟著首頁拍板
//    （D-13④ 企業卡不再露出）一併拿掉，想談客製走頁尾聯繫方式。
const plans = computed(() =>
  BILLING_PLAN_ORDER
    .map(id => BILLING_PLANS[id])
    .filter(p => !p.internal && !p.landingHidden)
    .filter(p => FEATURED_PLAN_IDS.includes(p.id) || p.id === props.currentPlanId))

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

const { getBearer, workspaceId, apiFetch } = useWorkspace()
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
 * 目前生效的發票資訊（OA 覆寫 > 組織預設，與實際開票同一支 resolve）。
 * null = 還沒載到或載入失敗 → 提示整行不顯示，不猜「個人紙本」誤導人。
 */
const effectiveInvoice = ref<InvoiceProfile | null>(null)
const invoiceEnabled = Boolean(config.public.invoiceEnabled)
const invoiceLabel = computed(() => effectiveInvoice.value ? describeInvoiceProfile(effectiveInvoice.value) : '')
/** 載入成功且全空（會開預設的個人紙本）→ 結帳時就地問要不要打統編。 */
const invoiceUnset = computed(() =>
  effectiveInvoice.value != null && !hasInvoiceProfile(effectiveInvoice.value))

// ── 就地選發票別（只在 invoiceUnset 時出現）────────────────────
const invoiceKind = ref<'personal' | 'company'>('personal')
const b2bForm = reactive({ buyerUBN: '', buyerName: '', buyerEmail: '' })

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// 格式錯誤只在「填了但填錯」時亮紅字；空欄位不罵人，交給付款鈕的 tooltip 講缺什麼
const b2bFormatError = computed(() => {
  const ubn = b2bForm.buyerUBN.trim()
  if (ubn && !/^\d{8}$/.test(ubn)) return '統一編號需為 8 碼數字'
  const email = b2bForm.buyerEmail.trim()
  if (email && !EMAIL_RE.test(email)) return 'Email 格式不正確'
  return ''
})
// 三格全要：統編＝報帳身分、抬頭＝發票開給誰、Email＝可入帳的電子發票寄送管道
// （光貿只在有帶 email 時才寄，缺了這張要報帳的發票就靜默寄不出去）
const b2bComplete = computed(() =>
  /^\d{8}$/.test(b2bForm.buyerUBN.trim())
  && b2bForm.buyerName.trim() !== ''
  && EMAIL_RE.test(b2bForm.buyerEmail.trim()))
/** 選了公司統編就要填完整才放行付款；選個人（或本來就填過發票資訊）不擋。 */
const invoiceReady = computed(() =>
  !invoiceUnset.value || invoiceKind.value !== 'company' || b2bComplete.value)

/** 這一筆付款實際會用的發票資訊：就地填的公司統編優先，否則現行設定。 */
const checkoutInvoice = computed<InvoiceProfile | null>(() =>
  invoiceUnset.value && invoiceKind.value === 'company'
    ? { buyerUBN: b2bForm.buyerUBN.trim(), buyerName: b2bForm.buyerName.trim(), buyerEmail: b2bForm.buyerEmail.trim() }
    : effectiveInvoice.value)

/** 付款鈕被停用時 tooltip 要講「為什麼按不了」，照攔到的順序給一個原因。 */
const checkoutBlockReason = computed(() => {
  if (!paymentEnabled) return '線上付款尚未開通，請聯繫我們'
  if (!agreed.value) return '請先勾選下方的條款同意'
  return '請填完公司發票的統編、抬頭與 Email'
})

async function loadInvoiceProfile() {
  if (!invoiceEnabled) return
  try {
    const res = await apiFetch<{ effective: InvoiceProfile }>('/api/payment/invoice-profile')
    effectiveInvoice.value = res.effective
  }
  catch {
    effectiveInvoice.value = null
  }
}

/** 關掉對話框、帶去帳單頁的發票區（billing.vue 看到 #invoice 會捲過去）。 */
function goInvoiceSettings() {
  emit('update:modelValue', false)
  navigateTo(`/admin/${workspaceId.value}/settings/billing#invoice`)
  // 本來就在帳單頁時路由不變、watcher 不會觸發 → 直接捲；跨頁時元素還不存在，交給目標頁處理
  document.getElementById('invoice')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/**
 * 是否已勾選同意條款。每次開啟對話框都重設為未勾選——同意要對應「這一次」的結帳，
 * 上次開著沒付款的勾選不該延用。
 */
const agreed = ref(false)
watch(() => props.modelValue, (open) => {
  if (!open) return
  agreed.value = false
  // 就地填的統編同理：對應「這一次」結帳，上次打開填一半的不留著
  invoiceKind.value = 'personal'
  b2bForm.buyerUBN = ''
  b2bForm.buyerName = ''
  b2bForm.buyerEmail = ''
  loadInvoiceProfile() // 每次開啟都重抓：中途去改過發票資訊，回來要看到新的
}, { immediate: true })

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
  if (!paymentEnabled || !agreed.value || !invoiceReady.value) return

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
  // 帳單上的請款名稱與品牌不同（myfeel ≠ MiniMe）——**按付款鍵前**是唯一一定會被看到的時機。
  // 不講的話，客人一個月後在帳單看到陌生名字會當成盜刷去爭議，而幕後扣款的爭議款我方自負。
  // 理由與單一事實來源見 shared/billing/statement.ts。
  // 發票會開成什麼、寄到哪，在**按付款鍵之前**講一次。
  // 個人發票維持零必填（多數人只要個人發票，擋在這裡只會流失）；公司統編改成結帳時
  // 就地填（checkoutInvoice），不再要求先去帳單頁設定——發票品名與買方一經開立就
  // 改不掉（要走作廢重開），所以確認框要照「實際會開的那一份」講。
  // 載具那種不寄通知信（發票直接進載具），所以措辭跟著換，不要說「寄到」。
  const inv = checkoutInvoice.value
  const invoiceLine = invoiceEnabled && inv
    ? (String(inv.carrierNum ?? '').trim()
        ? `發票：${describeInvoiceProfile(inv)}（存入載具，不另寄通知信）`
        : `發票：${describeInvoiceProfile(inv)}，通知寄到 ${String(inv.buyerEmail ?? '').trim() || '你的登入信箱'}`)
    : ''
  const statement = cardStatementNotice({
    statementName: String(config.public.cardStatementName || ''),
    legalCompanyName: String(config.public.legalCompanyName || ''),
    brandName: String(config.public.brandName || ''),
  })
  // 沒有委託的降級仍是「重新起算一期」：舊方案剩餘天數不折抵——按下去前必須講清楚,
  // 否則使用者會「付了錢還虧掉剩餘天數」而不自知。（有委託的降級走期末生效,不會有這問題。）
  const downgradeWarn = action === '降級' ? '⚠️ 降級會立即生效，且目前方案剩餘天數不折抵。' : ''
  try {
    await ElMessageBox.confirm(
      `${downgradeWarn}${terms}接著前往統一金流 PAYUNi 的安全付款頁面完成付款。`
      + (invoiceLine ? `\n\n${invoiceLine}` : '')
      + `\n${statement}`,
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

  // 就地填的公司統編：確認後、建單前先存成這個官方帳號的發票資訊——付款成功當下就照它
  // 開票，之後每月自動續扣開發票也沿用同一組（訂閱制跟一般電商的差別：這組資訊不是跟著
  // 這筆訂單，是跟著帳號走，只問這一次）。存失敗就中止結帳：寧可讓客戶再按一次，
  // 也不能收了錢開一張錯的發票。
  if (invoiceUnset.value && invoiceKind.value === 'company') {
    try {
      const r = await apiFetch<{ profile: InvoiceProfile }>('/api/payment/invoice-profile', {
        method: 'POST',
        body: { ...b2bForm, carrierNum: '', loveCode: '' },
      })
      effectiveInvoice.value = r.profile // 存成功→就地表單收合成「會開出：公司發票…」摘要
    }
    catch (e: any) {
      showToast(e?.data?.statusMessage || e?.data?.message || '發票資訊儲存失敗，請再試一次', 'error')
      return
    }
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
