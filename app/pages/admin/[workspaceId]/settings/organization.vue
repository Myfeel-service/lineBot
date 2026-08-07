<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="組織與 LINE"
        caption="設定你的組織與 LINE 官方帳號，以及連上 LINE 需要的資料。Token、Secret 只有第一次要貼；存好後會自動隱藏，要換再點一下就能重填。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button :loading="loading" @click="reloadAll">重新載入</el-button>
        <el-button type="primary" :loading="saving" data-tour="org-save" @click="save">儲存</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="ls-page-body admin-panel-stack">
        <div class="message-card ar-section-card" data-tour="org-identity">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">組織與官方帳號</span>
            </div>
          </div>
          <div class="card-section-stack">
            <dl class="ls-kv">
              <dt>組織名稱</dt>
              <dd>{{ organizationNameDisplay }}</dd>
              <dt>官方帳號名稱</dt>
              <dd>{{ officialAccountDisplayName }}</dd>
              <dt>你的角色</dt>
              <dd>
                <el-tag :type="roleTagType(currentRole)" :effect="roleTagEffect(currentRole)">{{ roleLabel(currentRole) }}</el-tag>
              </dd>
            </dl>
            <p class="ls-kv-note">以上名稱為顯示用；需變更請洽平台管理員。</p>
          </div>
        </div>

        <div v-if="planView" class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">目前方案</span>
              <span class="text-xs text-muted">{{ planView.name }}</span>
            </div>
            <el-button size="small" @click="upgradeOpen = true">{{ planState.limit == null ? '查看方案' : '升級方案' }}</el-button>
          </div>
          <div class="card-section-stack">
            <template v-if="planState.limit != null">
              <el-progress
                :percentage="planState.percent"
                :color="planState.color"
                :stroke-width="16"
                :text-inside="true"
                :format="() => `${planState.percentRaw}%`"
              />
              <p class="text-xs text-muted">
                本月已用 <strong>{{ planState.used.toLocaleString() }}</strong> / {{ planState.limit.toLocaleString() }} 則
                <template v-if="planState.remaining !== null">（剩 {{ planState.remaining.toLocaleString() }} 則）</template>
                · <NuxtLink :to="usageLink" class="ar-link">查看用量</NuxtLink>
              </p>
            </template>
            <p v-else class="text-xs text-muted">
              客製額度，無固定則數上限。 · <NuxtLink :to="usageLink" class="ar-link">查看用量</NuxtLink>
            </p>
          </div>
          <AdminPlanUpgradeDialog v-model="upgradeOpen" :current-plan-id="planView.id" />
        </div>

        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">LINE 憑證、LIFF 與 Webhook</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ls-subgroup">LIFF（活動頁）</p>
            <div class="admin-field-group" data-tour="org-liff">
              <AdminFieldLabel text="預設 LIFF（選填，活動頁用）" tight />
              <el-input
                v-model="form.defaultLiffId"
                placeholder="例：2007123456-AbCdEfGh"
              />
              <p class="text-xs text-muted">活動沒填 LIFF 時會用這一組。</p>
            </div>
            <p class="ar-section-hint">
              這個 LIFF 的 Endpoint URL 要填下方的「活動 LIFF 頁」網址，<strong>別填成 Webhook 那組</strong>，不然客人會打不開。
            </p>
            <div v-if="suggestedLiffEndpointUrl" class="admin-field-group">
              <AdminFieldLabel text="活動 LIFF 頁（貼到 LINE Developers → 該 LIFF 的 Endpoint URL）" tight />
              <div class="cmp-url-row">
                <el-input :model-value="suggestedLiffEndpointUrl" readonly />
                <el-button @click="copyLiffEndpointUrl">複製</el-button>
              </div>
            </div>
            <div v-if="liffChecks.length || checkingLiff" class="admin-field-group">
              <AdminFieldLabel text="LINE 上的登記狀態" tight />
              <div
                v-for="c in liffChecks"
                :key="c.liffId"
                class="ls-status"
                :class="`ls-status--${liffCheckBadge(c).tone}`"
              >
                <p class="ls-status-title">{{ liffCheckBadge(c).text }}</p>
                <p class="ls-status-hint">{{ liffCheckBadge(c).hint }}</p>
                <p v-if="c.endpoint" class="ls-status-detail">
                  LINE 那邊填的網址：<span class="ls-status-url">{{ c.endpoint }}</span>
                </p>
              </div>
              <div>
                <el-button size="small" :loading="checkingLiff" @click="checkLiffEndpoints({ force: true })">
                  重新檢查
                </el-button>
              </div>
            </div>
            <p class="ls-subgroup">LINE 憑證</p>
            <p class="ar-section-hint">
              請到 LINE Developers → Messaging API 複製貼上。
            </p>
            <div class="admin-field-group" data-tour="org-token">
              <AdminFieldLabel text="Channel Access Token（必填）" tight />
              <div
                v-if="showMaskedAccessToken"
                class="ls-cred-mask"
                role="button"
                tabindex="0"
                aria-label="Channel Access Token 已儲存，點擊以變更"
                @click="revealAccessToken"
                @keydown.enter.prevent="revealAccessToken"
              >
                <span class="ls-cred-mask-dots" aria-hidden="true">{{ maskDots }}</span>
                <span v-if="meta.channelAccessTokenSuffix" class="ls-cred-mask-suffix">尾碼 {{ meta.channelAccessTokenSuffix }}</span>
                <span class="ls-cred-mask-hint">已儲存（內容隱藏），點此變更</span>
              </div>
              <el-input
                v-else
                ref="accessTokenInputRef"
                v-model="form.channelAccessToken"
                type="password"
                show-password
                placeholder="貼上完整 Token"
                autocomplete="off"
                @blur="onAccessTokenBlur"
              />
            </div>
            <div class="admin-field-group" data-tour="org-secret">
              <AdminFieldLabel text="Channel Secret（必填）" tight />
              <div
                v-if="showMaskedSecret"
                class="ls-cred-mask"
                role="button"
                tabindex="0"
                aria-label="Channel Secret 已儲存，點擊以變更"
                @click="revealSecret"
                @keydown.enter.prevent="revealSecret"
              >
                <span class="ls-cred-mask-dots" aria-hidden="true">{{ maskDots }}</span>
                <span v-if="meta.channelSecretSuffix" class="ls-cred-mask-suffix">尾碼 {{ meta.channelSecretSuffix }}</span>
                <span class="ls-cred-mask-hint">已儲存（內容隱藏），點此變更</span>
              </div>
              <el-input
                v-else
                ref="channelSecretInputRef"
                v-model="form.channelSecret"
                type="password"
                show-password
                placeholder="貼上完整 Secret"
                autocomplete="off"
                @blur="onSecretBlur"
              />
              <p class="text-xs text-muted">須與 LINE 後台同一組。</p>
            </div>
            <div v-if="!meta.savedInFirestore && !meta.channelAccessTokenConfigured" class="text-xs text-muted">
              尚未在此頁存過憑證，請貼上 Token、Secret 後按儲存。
            </div>

            <p class="ls-subgroup">Webhook（收訊息）</p>
            <p class="ar-section-hint">
              把下面的網址貼到
              <a
                href="https://developers.line.biz/console/"
                target="_blank"
                rel="noopener noreferrer"
                class="ar-link"
              >LINE Developers</a>
              → Messaging API 的 Webhook URL（要 https、外面連得到）。測試失敗多半是 Channel Secret 兩邊沒填成同一組。
            </p>
            <div class="admin-field-group" data-tour="org-webhook">
              <AdminFieldLabel text="Webhook 網址（複製貼到 LINE）" tight />
              <div v-if="suggestedWebhookUrl" class="cmp-url-row">
                <el-input :model-value="suggestedWebhookUrl" readonly />
                <el-button @click="copyWebhookUrl">複製</el-button>
              </div>
              <p v-else class="text-xs text-muted">開啟本頁後會自動帶入。</p>
            </div>
            <p class="ls-subgroup">檢查連線</p>
            <div class="admin-field-group" data-tour="org-verify">
              <div class="flex flex-wrap gap-2">
                <el-button
                  :loading="verifyingWebhook"
                  :disabled="testDisabled"
                  type="primary"
                  plain
                  @click="verifyWebhook(true)"
                >
                  測試連線
                </el-button>
              </div>
              <p v-if="testDisabledReason" class="text-xs text-warning">{{ testDisabledReason }}</p>
              <p v-else class="text-xs text-muted">按一下，LINE 會真的送一則測試訊息，確認「LINE 那邊填的網址」現在收得到（不是這頁的網址）。次數有限，別連續猛按。</p>
            </div>
            <div v-if="webhookVerifyResult && webhookStatusBadge" class="admin-field-group">
              <AdminFieldLabel text="LINE 目前狀態" tight />
              <div class="ls-status" :class="`ls-status--${webhookStatusBadge.tone}`">
                <p class="ls-status-title">{{ webhookStatusBadge.text }}</p>
                <p class="ls-status-hint">{{ webhookStatusBadge.hint }}</p>
                <p
                  v-if="webhookVerifyResult.getOk && webhookVerifyResult.lineEndpoint"
                  class="ls-status-detail"
                >
                  LINE 那邊填的網址：<span class="ls-status-url">{{ webhookVerifyResult.lineEndpoint }}</span>
                </p>
              </div>
            </div>

            <template v-if="showClearStoredCredentials">
              <hr class="divider">
              <p class="ar-section-hint">
                清掉本頁存的 Token／Secret。LINE 後台不用改；其他請交給技術人員處理。
              </p>
              <el-button type="danger" plain :loading="clearing" @click="clearWorkspace">
                清除已儲存的憑證
              </el-button>
            </template>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

definePageMeta({ middleware: ['auth', 'workspace-settings'], layout: 'default' })

useHead({
  title: useAdminTitle('組織與 LINE'),
})

type WorkspaceGet = {
  id: string
  /** 這套系統對外的正式網址（PUBLIC_BASE_URL）；後端沒設定時為空字串 */
  publicBaseUrl: string
  savedInFirestore: boolean
  name: string
  defaultLiffId: string
  effectiveDefaultLiffId?: string
  channelAccessTokenConfigured: boolean
  channelAccessTokenSuffix: string | null
  channelSecretConfigured: boolean
  channelSecretSuffix: string | null
}

const { showToast } = useAdminToast()
const route = useRoute()
const router = useRouter()
const {
  getBearer,
  workspaceId,
  workspaceList,
  loadWorkspaceList,
  currentWorkspaceName,
  currentRole,
} = useWorkspace()

const currentWorkspaceRow = computed(() =>
  workspaceList.value.find(w => w.workspaceId === workspaceId.value) ?? null,
)

const organizationNameDisplay = computed(() => {
  const n = currentWorkspaceRow.value?.organizationName?.trim()
  return n || '—'
})

const officialAccountDisplayName = computed(() => currentWorkspaceName.value || '—')

// ── 目前方案（設定頁的方案卡；資料走 usePlanSummary，與用量監控頁共用邏輯） ──
const { plan: planView, state: planState, load: loadPlanSummary } = usePlanSummary()
const upgradeOpen = ref(false)
const usageLink = computed(() => `/admin/${workspaceId.value}/ai-usage`)

const ROLE_LABELS: Record<string, string> = {
  owner: '擁有者',
  admin: '管理員',
  agent: '客服',
  viewer: '觀察者',
}

function roleLabel(role: WorkspaceMemberRole | null) {
  return role ? (ROLE_LABELS[role] ?? role) : '—'
}

function roleTagType(role: WorkspaceMemberRole | null) {
  if (role === 'owner') return 'primary'
  if (role === 'admin') return 'warning'
  if (role === 'agent') return 'success'
  return 'info'
}

// 擁有者用實心品牌色標籤，與其他淺色標籤（尤其客服的 success 綠）明顯區隔，避免兩綠相混
function roleTagEffect(role: WorkspaceMemberRole | null) {
  return role === 'owner' ? 'dark' : 'light'
}

/** 暫時隱藏「清除已儲存的憑證」區塊；改為 true 即可顯示 */
const showClearStoredCredentials = false

const loading = ref(false)
const saving = ref(false)
const clearing = ref(false)

const meta = ref<WorkspaceGet>({
  id: 'default',
  publicBaseUrl: '',
  savedInFirestore: false,
  name: '',
  defaultLiffId: '',
  channelAccessTokenConfigured: false,
  channelAccessTokenSuffix: null,
  channelSecretConfigured: false,
  channelSecretSuffix: null,
})

const form = ref({
  defaultLiffId: '',
  channelAccessToken: '',
  channelSecret: '',
})

const { hasUnsavedChanges, markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => ({
    defaultLiffId: form.value.defaultLiffId.trim(),
    channelAccessToken: form.value.channelAccessToken.trim(),
    channelSecret: form.value.channelSecret.trim(),
  }),
})

// 測試打的是「已儲存」的憑證（後端讀 Firestore），不是表單裡剛打的字。
// 所以還沒存過、或有未儲存變更時先擋住，免得測到舊資料、拿到誤導的結果。
const testDisabledReason = computed(() => {
  if (!meta.value.channelAccessTokenConfigured) return '先填好並儲存 Token、Secret，才能測試。'
  if (hasUnsavedChanges.value) return '有還沒儲存的變更 —— 先按「儲存」再測試（測試用的是已儲存的內容）。'
  return ''
})
const testDisabled = computed(() => testDisabledReason.value !== '')

const maskDots = '••••••••••••'

const accessTokenInputRef = ref<{ focus: () => void } | null>(null)
const channelSecretInputRef = ref<{ focus: () => void } | null>(null)
const accessTokenReveal = ref(false)
const secretReveal = ref(false)

const showMaskedAccessToken = computed(
  () =>
    meta.value.channelAccessTokenConfigured
    && !form.value.channelAccessToken.trim()
    && !accessTokenReveal.value,
)

const showMaskedSecret = computed(
  () =>
    meta.value.channelSecretConfigured
    && !form.value.channelSecret.trim()
    && !secretReveal.value,
)

function revealAccessToken() {
  accessTokenReveal.value = true
  nextTick(() => accessTokenInputRef.value?.focus?.())
}

function revealSecret() {
  secretReveal.value = true
  nextTick(() => channelSecretInputRef.value?.focus?.())
}

function onAccessTokenBlur() {
  if (!form.value.channelAccessToken.trim() && meta.value.channelAccessTokenConfigured)
    accessTokenReveal.value = false
}

function onSecretBlur() {
  if (!form.value.channelSecret.trim() && meta.value.channelSecretConfigured)
    secretReveal.value = false
}

/** 瀏覽器當下的網址；只在後端沒設定對外網址時（本機開發）當退路 */
const browserOrigin = ref('')

/**
 * 要貼到 LINE 的網址、以及跟 LINE 上設定比對的基準，一律用「這套系統對外的正式網址」，
 * **不是**使用者當下瀏覽的網址——同一套系統可能有自訂網域＋amplifyapp 兩個入口，
 * 從其中一個進後台就會誤判「LINE 那邊填錯了」，也會叫使用者把錯的網址貼去 LINE
 * 覆蓋掉本來正常的設定。後端 workspace-alerts 的 webhook 檢查用的是同一個基準。
 */
const publicBaseUrl = computed(() =>
  (meta.value.publicBaseUrl || browserOrigin.value).replace(/\/$/, ''),
)
const suggestedWebhookUrl = computed(() => publicBaseUrl.value ? `${publicBaseUrl.value}/webhook` : '')
const suggestedLiffEndpointUrl = computed(() => publicBaseUrl.value ? `${publicBaseUrl.value}/liff/lead` : '')

async function copyLiffEndpointUrl() {
  if (!suggestedLiffEndpointUrl.value) return
  try {
    await navigator.clipboard.writeText(suggestedLiffEndpointUrl.value)
    showToast('已複製活動 LIFF 頁網址', 'success')
  }
  catch {
    showToast('複製失敗，請手動複製', 'error')
  }
}

async function copyWebhookUrl() {
  if (!suggestedWebhookUrl.value) return
  try {
    await navigator.clipboard.writeText(suggestedWebhookUrl.value)
    showToast('已複製 Webhook URL', 'success')
  }
  catch {
    showToast('複製失敗，請手動複製', 'error')
  }
}

// ── LIFF 登記狀態（LINE 上的 Endpoint URL 是不是活動頁）──────────────────
// 訊號口徑與小幫手的 liffEndpointBroken/liffEndpointUrlMismatch 同一份（同一個後端 probe）。
type LiffEndpointCheckItem = {
  liffId: string
  source: 'default' | 'campaign'
  status: 'ok' | 'mismatch' | 'broken' | 'unknown'
  endpoint: string | null
  reason?: 'wrong_page' | 'unreachable' | 'deleted'
}

const liffChecks = ref<LiffEndpointCheckItem[]>([])
const checkingLiff = ref(false)

/**
 * silent=true：進頁被動帶出（免費 GET）。查失敗靜靜略過、不清空既有結果，別在載入時嚇人。
 * force=true：使用者剛去 LINE 後台改完回頭確認——跳過後端 5 分鐘快取真的再查。
 */
async function checkLiffEndpoints(opts: { force?: boolean, silent?: boolean } = {}) {
  if (!opts.silent) checkingLiff.value = true
  try {
    const token = await getBearer()
    const data = await $fetch<{ expectedUrl: string, checks: LiffEndpointCheckItem[] }>(
      '/api/admin/liff-endpoint-check',
      {
        query: { workspaceId: workspaceId.value, ...(opts.force ? { force: '1' } : {}) },
        headers: { Authorization: `Bearer ${token}` },
      },
    )
    liffChecks.value = data.checks
  }
  catch (e: any) {
    if (!opts.silent)
      showToast(e?.data?.statusMessage || e?.message || '查詢 LIFF 登記狀態失敗', 'error')
  }
  finally {
    if (!opts.silent) checkingLiff.value = false
  }
}

const LIFF_SOURCE_LABEL: Record<LiffEndpointCheckItem['source'], string> = {
  default: '預設',
  campaign: '活動用',
}

// 一眼結論（與 webhook 徽章同一套呈現）：徽章下結論、hint 一句白話講怎麼辦
function liffCheckBadge(c: LiffEndpointCheckItem): { text: string, tone: 'success' | 'warning' | 'danger', hint: string } {
  const who = `LIFF ${c.liffId}（${LIFF_SOURCE_LABEL[c.source]}）`
  if (c.status === 'ok')
    return { text: `✓ ${who} 設定正確`, tone: 'success', hint: '客人點活動連結會正確開到活動頁。' }
  if (c.status === 'mismatch')
    return { text: `✕ ${who} 網址不一致（填的是舊網址）`, tone: 'danger', hint: '登記的不是這套系統的正式網址。客人登入活動頁會多繞、可能卡住；那個舊網址一停用，活動連結會整個打不開。把上面「活動 LIFF 頁」網址複製、到 LINE Developers 蓋掉這個 LIFF 的 Endpoint URL。' }
  if (c.status === 'broken') {
    if (c.reason === 'deleted' || !c.endpoint)
      return { text: `✕ ${who} 在 LINE 上找不到`, tone: 'danger', hint: '這個 LIFF 可能已被刪除、或 ID 貼錯了。確認上面欄位的 ID，或到 LINE Developers 重建一個。' }
    if (c.reason === 'unreachable')
      return { text: `✕ ${who} 網址已連不上`, tone: 'danger', hint: '登記的網址已經連不上了（多半是舊網域停用了）——客人點活動連結會打不開。把上面「活動 LIFF 頁」網址複製、到 LINE Developers 蓋掉這個 LIFF 的 Endpoint URL。' }
    return { text: `✕ ${who} 到不了活動頁`, tone: 'danger', hint: '登記的網址不是這套系統的活動頁——客人點活動連結會被帶去別的地方。把上面「活動 LIFF 頁」網址複製、到 LINE Developers 蓋掉這個 LIFF 的 Endpoint URL。' }
  }
  return { text: `？ ${who} 這次查不到`, tone: 'warning', hint: '暫時問不到 LINE，稍後按「重新檢查」。查不到不代表沒問題。' }
}

type WebhookVerifyResult = {
  getOk: boolean
  getMessage?: string
  lineEndpoint: string | null
  lineActive: boolean | null
  urlMatchesCompare: boolean | null
  /** 網址不一致時「LINE 填的那個網址」是否已連不上（null＝沒得比、沒戳） */
  endpointUnreachable: boolean | null
  test: {
    success: boolean
    reason?: string
    detail?: string
    statusCode?: number
  } | null
  testSkipped: boolean
  testError?: string
}

type SaveWorkspaceResponse = {
  ok: boolean
  id: string
  webhookVerification?: {
    ok: boolean
    message: string
  }
}

const webhookVerifyResult = ref<WebhookVerifyResult | null>(null)
const verifyingWebhook = ref(false)

// 一眼結論：徽章下結論、hint 用一句白話說「怎麼辦」。嚴重度優先序＝測試失敗 > 沒開/不一致 > 正常。
const webhookStatusBadge = computed<{ text: string, tone: 'success' | 'warning' | 'danger', hint: string } | null>(() => {
  const r = webhookVerifyResult.value
  if (!r) return null
  if (!r.getOk)
    return { text: '✕ 問不到狀態', tone: 'danger', hint: r.getMessage || '目前問不到 LINE，稍後再試，或確認 Token 是否正確。' }
  if (!r.testSkipped && (r.testError || (r.test && !r.test.success))) {
    const is401 = r.test?.statusCode === 401
    return {
      text: '✕ 測試沒過',
      tone: 'danger',
      hint: is401
        ? 'LINE 連到你的系統了，但被擋下來 —— 多半是這頁的 Channel Secret 跟 LINE 後台不是同一組，重貼一次再存。'
        : 'LINE 連你的系統時失敗了。確認網址對外連得到、開頭是 https。',
    }
  }
  if (r.lineActive === false)
    return { text: '⚠ Webhook 沒開', tone: 'warning', hint: 'LINE 後台的 Webhook 開關沒打開，這樣收不到訊息 —— 到 LINE Developers 把它打開。' }
  // 網址不一致一律紅（2026-08-08 拍板：填著的多半是排定停用的舊網址，等斷了才紅就晚了）；
  // 「已連不上」與「還能動」分開講，後果不同
  if (r.urlMatchesCompare === false && r.endpointUnreachable)
    return { text: '✕ LINE 填的網址已連不上', tone: 'danger', hint: 'LINE 現在把訊息送往一個已經連不上的網址（多半是舊網域停用了），客人傳什麼都收不到。把上面那格「Webhook 網址」複製、貼到 LINE 後台覆蓋掉。' }
  if (r.urlMatchesCompare === false)
    return { text: '✕ 網址不一致（填的是舊網址）', tone: 'danger', hint: 'LINE 那邊填的不是這套系統的正式網址。訊息目前還進得來，但那個網址一停用就會無聲斷線。趁還沒斷，把上面那格「Webhook 網址」複製、貼到 LINE 後台覆蓋掉。' }
  if (!r.testSkipped && r.test?.success)
    return { text: '✓ 一切正常', tone: 'success', hint: 'LINE 連得到你的系統，訊息收發沒問題。' }
  return { text: '✓ 看起來正常', tone: 'success', hint: '想再確認的話，按上方「測試連線」實跑一次。' }
})

/**
 * 查 LINE 上的 webhook 狀態；runTest=true 會多打一發「測試派送」（有次數上限）。
 * silent=true 用於進頁時被動帶出登記狀態（免費 GET）：不跳 toast、不顯示按鈕 loading，
 * 且只在成功時才填結果面板，查失敗就靜靜略過、別在載入時嚇人。
 */
async function verifyWebhook(runTest: boolean, opts: { silent?: boolean } = {}) {
  const silent = opts.silent === true
  if (!silent) verifyingWebhook.value = true
  webhookVerifyResult.value = null
  try {
    const token = await getBearer()
    const data = await $fetch<WebhookVerifyResult>('/api/admin/line-webhook-verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        workspaceId: workspaceId.value,
        compareUrl: suggestedWebhookUrl.value || undefined,
        runTest,
      },
    })
    if (silent) {
      if (data.getOk) webhookVerifyResult.value = data
      return
    }
    webhookVerifyResult.value = data
    if (data.getOk && runTest && !data.testSkipped && data.test?.success) {
      showToast('Webhook 串接驗證通過', 'success')
    }
    else if (data.getOk && runTest && !data.testSkipped && data.test && !data.test.success) {
      showToast('測試派送失敗，請查看下方說明', 'error')
    }
    else if (data.getOk && data.testError) {
      showToast('無法完成測試，請查看下方說明', 'error')
    }
    else if (data.getOk) {
      showToast('查詢完成', 'success')
    }
    else {
      showToast(data.getMessage || '查詢失敗', 'error')
    }
  }
  catch (e: any) {
    if (!silent)
      showToast(e?.data?.statusMessage || e?.data?.message || e?.message || '驗證請求失敗', 'error')
  }
  finally {
    if (!silent) verifyingWebhook.value = false
  }
}

async function load() {
  loading.value = true
  try {
    const token = await getBearer()
    const data = await $fetch<WorkspaceGet>('/api/admin/line-workspace', {
      query: { workspaceId: workspaceId.value },
      headers: { Authorization: `Bearer ${token}` },
    })
    meta.value = data
    form.value.defaultLiffId = data.defaultLiffId || ''
    form.value.channelAccessToken = ''
    form.value.channelSecret = ''
    accessTokenReveal.value = false
    secretReveal.value = false
    markClean()
  }
  catch (e: any) {
    showToast(e?.data?.message || e?.message || '載入失敗', 'error')
  }
  finally {
    loading.value = false
  }
}

async function reloadAll() {
  if (!confirmLeaveIfDirty()) return
  // loadWorkspaceList 有 in-flight dedup，與 layout 同時觸發時只會發 1 次
  await loadWorkspaceList().catch(() => {})
  await load()
}

async function save() {
  const defaultLiffId = form.value.defaultLiffId.trim()
  const t = form.value.channelAccessToken.trim()
  const s = form.value.channelSecret.trim()
  const tc = meta.value.channelAccessTokenConfigured
  const sc = meta.value.channelSecretConfigured

  // 預設 LIFF 2026-08-07 拍板改為選填（加分項 liffReady）：沒填不擋存檔，
  // 否則在開通引導跳過 LIFF 的人，回來改 Token 會被卡在這裡。
  if (!tc && !t) {
    showToast('請填寫 Channel Access Token', 'error')
    return
  }
  if (!sc && !s) {
    showToast('請填寫 Channel Secret', 'error')
    return
  }
  if (t && !s && !sc) {
    showToast('請填寫 Channel Secret', 'error')
    return
  }
  if (s && !t && !tc) {
    showToast('請填寫 Channel Access Token', 'error')
    return
  }

  saving.value = true
  try {
    const token = await getBearer()
    const body: Record<string, unknown> = { defaultLiffId }
    if (t) body.channelAccessToken = t
    if (s) body.channelSecret = s
    const data = await $fetch<SaveWorkspaceResponse>('/api/admin/line-workspace', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        workspaceId: workspaceId.value,
        ...body,
        verifyWebhookOnSave: true,
        compareWebhookUrl: suggestedWebhookUrl.value || undefined,
      },
    })
    await loadWorkspaceList().catch(() => {})
    await load()
    await verifyWebhook(false)
    // 剛存的可能是新 LIFF ID：登記狀態跟著重新帶出（新 ID 不會命中舊快取）
    checkLiffEndpoints({ silent: true }).catch(() => {})
    if (data.webhookVerification?.ok) {
      showToast(data.webhookVerification.message, 'success')
    }
    else if (data.webhookVerification?.message) {
      showToast(data.webhookVerification.message, 'error')
    }
    else {
      showToast('已儲存', 'success')
    }
  }
  catch (e: any) {
    showToast(e?.data?.message || e?.message || '儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

async function clearWorkspace() {
  try {
    await ElMessageBox.confirm('確定清除在此頁儲存的 LINE 憑證？此動作無法復原。', '清除憑證', {
      confirmButtonText: '清除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  clearing.value = true
  try {
    const token = await getBearer()
    await $fetch('/api/admin/line-workspace', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: { workspaceId: workspaceId.value, clearWorkspace: true },
    })
    showToast('已清除儲存的憑證', 'success')
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.message || e?.message || '清除失敗', 'error')
  }
  finally {
    clearing.value = false
  }
}

/**
 * 從小幫手的異常卡片進來（?verify=webhook）：捲到「檢查連線」並實跑一次測試——
 * 使用者已經在卡片上按過「去檢查」，到頁面不該再自己找一遍要看哪裡。
 *
 * 進來就先把參數清掉。留著的話每次重整、每次上一頁回來，都會再真的請 LINE 送一則
 * 測試訊息，而那個次數是有上限的（後端的常駐檢查刻意只查設定不打測試，就是為了留額度）。
 */
async function consumeAlertHandoff() {
  const target = String(route.query.verify ?? '')
  if (target !== 'webhook' && target !== 'liff') return
  const { verify: _drop, ...rest } = route.query
  await router.replace({ query: rest })
  await nextTick()
  if (target === 'liff') {
    // LIFF 檢查是免費 GET 沒有次數上限，直接強制重查（使用者可能剛去 LINE 改完）
    document.querySelector('[data-tour="org-liff"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await checkLiffEndpoints({ force: true }).catch(() => {})
    return
  }
  document.querySelector('[data-tour="org-verify"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  // 實跑測試，結果面板會直接講「LINE 那邊填的網址」是什麼、差在哪
  if (meta.value.channelAccessTokenConfigured)
    await verifyWebhook(true).catch(() => {})
}

// 小幫手在本頁也掛著。在這頁點卡片時只有 query 變，Nuxt 不會重掛頁面元件、
// onMounted 不會再跑——只靠 onMounted 讀參數的話，按了會完全沒反應
watch(() => route.query.verify, (v) => {
  if (v) void consumeAlertHandoff()
})

onMounted(async () => {
  browserOrigin.value = window.location.origin
  // workspaceList 由 layout (default.vue) 的 onMounted 負責載入；此頁只需載入 LINE 憑證 meta
  loadPlanSummary().catch(() => {})
  await load()
  const verifyTarget = String(route.query.verify ?? '')
  if (verifyTarget === 'webhook' || verifyTarget === 'liff') {
    void consumeAlertHandoff()
    // handoff 只處理點進來的那一項；另一塊的登記狀態照常靜默帶出
    if (verifyTarget === 'liff' && meta.value.channelAccessTokenConfigured)
      verifyWebhook(false, { silent: true }).catch(() => {})
    else
      checkLiffEndpoints({ silent: true }).catch(() => {})
  }
  else {
    // 平常進頁：靜默帶出 LINE 登記狀態（webhook 與 LIFF 都是免費 GET、不佔測試次數、不跳 toast）
    if (meta.value.channelAccessTokenConfigured)
      verifyWebhook(false, { silent: true }).catch(() => {})
    checkLiffEndpoints({ silent: true }).catch(() => {})
  }
})
</script>
