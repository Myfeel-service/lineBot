<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="超級管理員"
        title="全站異常總覽"
        caption="每個帳號的異常訊號跟它右下角的小幫手是同一份。這頁開頁現查、不靠排程——排程死掉時，靠排程發的 LINE 警報會跟著死，只有這裡看得到。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button :loading="loading" @click="reload">重新檢查</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon />

        <!-- 結論先行：四格摘要（照金流總覽的 .sa-pay-stat 版型） -->
        <div class="message-card ar-section-card">
          <div class="sa-pay-summary">
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--danger': hbState === 'stalled' }">
              <div class="sa-pay-stat__label">背景排程</div>
              <div class="sa-pay-stat__value">{{ hbValue }}</div>
              <div class="sa-pay-stat__hint">{{ hbHint }}</div>
            </div>
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--danger': criticalWsCount > 0 }">
              <div class="sa-pay-stat__label">客人正在受影響</div>
              <div class="sa-pay-stat__value">{{ criticalWsCount }} 個帳號</div>
              <div class="sa-pay-stat__hint">紅色異常，等同各帳號小幫手的紅點</div>
            </div>
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--alert': advisoryWsCount > 0 }">
              <div class="sa-pay-stat__label">有事建議處理</div>
              <div class="sa-pay-stat__value">{{ advisoryWsCount }} 個帳號</div>
              <div class="sa-pay-stat__hint">黃級與建議，客人暫時無感</div>
            </div>
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--alert': flaggedWsCount > 0 }">
              <div class="sa-pay-stat__label">高成本帳號</div>
              <div class="sa-pay-stat__value">{{ flaggedWsCount }} 個</div>
              <div class="sa-pay-stat__hint">呼叫超過計費則數 {{ USAGE_RATIO_FLAG_THRESHOLD }} 倍才算</div>
            </div>
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--danger': imgBurst }">
              <div class="sa-pay-stat__label">客人傳的圖讀不出來</div>
              <div class="sa-pay-stat__value">{{ imgValue }}</div>
              <div class="sa-pay-stat__hint">{{ imgHint }}</div>
            </div>
            <!-- `B-43`②：扣款失敗以前只有客戶收得到通知 -->
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--danger': pastDueCount > 0 }">
              <div class="sa-pay-stat__label">自動扣款失敗</div>
              <div class="sa-pay-stat__value">{{ dunningValue }}</div>
              <div class="sa-pay-stat__hint">{{ dunningHint }}</div>
            </div>
            <!-- `B-50`：寄信壞了金流照常、只有信沒出去 -->
            <div class="sa-pay-stat" :class="{ 'sa-pay-stat--danger': emailState === 'broken', 'sa-pay-stat--alert': emailState === 'unsent' }">
              <div class="sa-pay-stat__label">帳務信</div>
              <div class="sa-pay-stat__value">{{ emailValue }}</div>
              <div class="sa-pay-stat__hint">{{ emailHint }}</div>
            </div>
          </div>
          <p v-if="data?.truncated" class="sa-alerts-foot sa-alerts-foot--pad sa-alerts-foot--warn">
            ⚠️ 帳號數已達單次掃描上限，下表沒有涵蓋全部帳號。
          </p>
        </div>

        <!-- 明細 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">有狀況的帳號</span>
            </div>
            <span v-if="checkedAtText" class="text-xs text-muted">{{ checkedAtText }}</span>
          </div>
          <div class="card-section-stack">
            <el-table
              v-loading="loading"
              :data="problemRows"
              size="small"
              empty-text="所有帳號檢查正常，沒有要處理的事。"
            >
              <el-table-column label="帳號" min-width="140">
                <template #default="{ row }">
                  <div class="text-sm font-bold">{{ row.name }}</div>
                  <el-tooltip v-if="row.unknownCount" placement="top" content="查詢失敗或暫時問不到——不等於沒問題，按「重新檢查」再試一次">
                    <span class="sa-alerts-unknown">{{ row.unknownCount }} 項查不到狀態</span>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="正在影響客人" min-width="230">
                <template #default="{ row }">
                  <div v-if="row.critical.length" class="sa-alerts-tags">
                    <template v-for="c in row.critical" :key="c.text">
                      <el-tooltip v-if="c.detail" :content="c.detail" placement="top">
                        <el-tag type="danger" size="small">{{ c.text }}</el-tag>
                      </el-tooltip>
                      <el-tag v-else type="danger" size="small">{{ c.text }}</el-tag>
                    </template>
                  </div>
                  <span v-else class="sa-alerts-none">—</span>
                </template>
              </el-table-column>
              <el-table-column label="建議處理" min-width="230">
                <template #default="{ row }">
                  <div v-if="row.advisory.length" class="sa-alerts-tags">
                    <template v-for="c in row.advisory" :key="c.text">
                      <el-tooltip v-if="c.detail" :content="c.detail" placement="top">
                        <el-tag type="warning" size="small">{{ c.text }}</el-tag>
                      </el-tooltip>
                      <el-tag v-else type="warning" size="small">{{ c.text }}</el-tag>
                    </template>
                  </div>
                  <span v-else class="sa-alerts-none">—</span>
                </template>
              </el-table-column>
              <el-table-column label="本月 AI 呼叫 → 計費" width="180" align="right">
                <template #default="{ row }">
                  <template v-if="row.usage.invocations || row.usage.billable">
                    <div class="sa-alerts-usage">{{ row.usage.invocations }} → {{ row.usage.billable }}</div>
                    <el-tag v-if="row.usage.flagged" type="warning" size="small">
                      {{ row.usage.ratio === null ? '一則都沒收到' : `是計費則數的 ${row.usage.ratio.toFixed(1)} 倍` }}
                    </el-tag>
                  </template>
                  <el-tooltip v-else placement="top" content="本月沒有 AI 活動">
                    <span class="sa-alerts-none">—</span>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="" width="86" align="right">
                <template #default="{ row }">
                  <el-button size="small" plain @click="enterWorkspace(row.id)">進入</el-button>
                </template>
              </el-table-column>
            </el-table>
            <p class="sa-alerts-foot">
              其他 {{ healthyCount }} 個帳號檢查正常。高成本的標準：成本按「呼叫」走、收入按「計費則數」走（答出與反問才收得到錢，答不出轉真人不收），呼叫多、收得少的帳號成本掛在我們身上——超過
              {{ USAGE_RATIO_FLAG_THRESHOLD }} 倍才標（正常約 2～2.5 倍；本月呼叫不足 {{ USAGE_RATIO_MIN_INVOCATIONS }} 次的小樣本不判）。標「(系統端)」的異常是我們這邊要處理的，店家動不了手。
            </p>
          </div>
        </div>

        <!--
          `D-136`：同事在對話上標「資料沒錯，是 AI 弄錯了」——知識庫改不了，要我們修系統。
          以前畫面跟同事說「記下來了」，卻沒有任何地方會再出現
        -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">同事標「資料沒錯，是 AI 弄錯了」<template v-if="aiMistakes.length">（{{ aiMistakes.length }}）</template></span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="sa-alerts-foot">知識庫改不了這些，要我們改系統。改好一筆就按「處理好了」。</p>
            <el-alert v-if="data && data.aiMistakes === null" type="warning" title="這次查不到這份清單（不等於沒有），按「重新檢查」再試一次" :closable="false" show-icon />
            <el-table
              v-else
              v-loading="loading"
              :data="aiMistakes"
              size="small"
              empty-text="沒有待處理的。"
            >
              <el-table-column label="日期" width="90">
                <template #default="{ row }">{{ mdText(row.createdAtMs) }}</template>
              </el-table-column>
              <el-table-column label="帳號" prop="workspaceName" min-width="120" />
              <el-table-column label="客人問" prop="query" min-width="260" />
              <el-table-column label="" width="190" align="right">
                <template #default="{ row }">
                  <el-button size="small" plain @click="openMistakeConversation(row)">看對話</el-button>
                  <el-button size="small" type="primary" plain :loading="handlingMistakeId === row.id" @click="markMistakeHandled(row)">處理好了</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!-- `C-164`：客人傳的圖讀不出來＝我們系統壞掉、店家修不了，只列在這裡 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">客人傳的圖讀不出來（近 {{ imgWindowDays }} 天）</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="sa-alerts-foot">AI 讀圖交回來的格式壞掉：客人少了猜的選項，對話裡的圖片說明會是亂碼。店家修不了，要我們修。</p>
            <el-alert v-if="data && data.imageReadFailures === null" type="warning" title="這次查不到這份清單（不等於沒有）——多半是資料庫索引還沒建好，按「重新檢查」再試一次" :closable="false" show-icon />
            <template v-else>
              <el-table
                v-loading="loading"
                :data="imgRows"
                size="small"
                empty-text="沒有讀不出來的圖。"
              >
                <el-table-column label="帳號" prop="workspaceName" min-width="160" />
                <el-table-column label="張數" width="90" align="right">
                  <template #default="{ row }">
                    <span class="sa-alerts-usage">{{ row.count }} 張</span>
                  </template>
                </el-table-column>
                <el-table-column label="最近一張" width="130">
                  <template #default="{ row }">
                    <span class="sa-alerts-usage">{{ mdhmText(row.lastAtMs) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="" width="100" align="right">
                  <template #default="{ row }">
                    <el-button v-if="row.workspaceId" size="small" plain @click="openImageConversation(row)">看對話</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <p v-if="data?.imageReadFailures?.truncated" class="sa-alerts-foot sa-alerts-foot--warn">
                ⚠️ 太多了，只算了最新的 {{ data.imageReadFailures.total }} 張，更早的沒算進來。
              </p>
            </template>
          </div>
        </div>

        <!-- `B-43`②：扣款失敗以前只有客戶收得到通知（信、帳單頁、店家 LINE），我們自己不知道 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">自動扣款失敗</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="sa-alerts-foot">還在寬限期的（每天再扣一次）＋近 {{ RECENT_DOWNGRADE_DAYS }} 天因為扣不到款降回免費的。原因是「IP」之類的話，多半是我們這邊的設定問題，不是客人的卡。</p>
            <el-alert v-if="data && data.dunning === null" type="warning" title="這次查不到這份清單（不等於沒有），按「重新檢查」再試一次" :closable="false" show-icon />
            <AdminDunningTable v-else v-loading="loading" :rows="data?.dunning ?? []" />
          </div>
        </div>

        <!-- `B-50`：寄信設定壞了以前沒有任何地方看得到（金流照常、只有信沒出去） -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">帳務信（收據、扣款失敗、續扣提醒）</span>
            </div>
            <el-button size="small" :loading="sendingTestEmail" @click="sendTestEmail">寄一封測試信給我</el-button>
          </div>
          <div class="card-section-stack">
            <el-alert v-if="data && data.email === null" type="warning" title="這次查不到寄信紀錄（不等於沒問題），按「重新檢查」再試一次" :closable="false" show-icon />
            <div v-else-if="data?.email" class="sa-email-health">
              <div class="sa-email-health__row">
                <span class="sa-email-health__label">寄件人</span>
                <span v-if="data.email.configured" class="sa-email-health__value">{{ data.email.from }}<span class="text-xs text-muted">（{{ data.email.region }}）</span></span>
                <el-tag v-else :type="data.email.paymentEnabled ? 'danger' : 'info'" size="small">沒設定（EMAIL_FROM 或區域）</el-tag>
              </div>
              <div class="sa-email-health__row">
                <span class="sa-email-health__label">最近寄成功</span>
                <span class="sa-email-health__value">
                  <template v-if="data.email.lastSuccessAt">{{ mdhmText(data.email.lastSuccessAt) }}<span class="text-xs text-muted">　{{ data.email.lastSuccessSubject }}</span></template>
                  <span v-else class="text-xs text-muted">還沒有</span>
                </span>
              </div>
              <div v-if="data.email.lastFailureAt" class="sa-email-health__row">
                <span class="sa-email-health__label">最近寄失敗</span>
                <span class="sa-email-health__value">
                  {{ mdhmText(data.email.lastFailureAt) }}<span class="text-xs text-muted">　{{ data.email.lastFailureSubject }}</span>
                  <span class="sa-email-health__error">{{ data.email.lastFailureError }}</span>
                </span>
              </div>
            </div>
            <p class="sa-alerts-foot">測試信只會寄到你登入的信箱（{{ myEmail || '—' }}）。寄失敗的帳務信每 3 小時再試一次、最多 5 次。</p>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { ALERT_LABELS, ALERT_SEVERITY, SYSTEM_OWNED_ALERTS, severityOf } from '~~/shared/types/alerts'
import { USAGE_RATIO_FLAG_THRESHOLD, USAGE_RATIO_MIN_INVOCATIONS } from '~~/shared/billing/usage-ratio'
import type { UsageRatioVerdict } from '~~/shared/billing/usage-ratio'
import type { SuperAiMistake, SuperAlertsOverviewPayload, SuperAlertsWorkspace, SuperImageReadFailureRow } from '~~/shared/types/super-alerts'
import { pastDueAccountCount } from '~~/shared/super-alerts-nav'
import { RECENT_DOWNGRADE_DAYS } from '~~/shared/billing/dunning'
import { emailHealthState } from '~~/shared/billing/email-health'

definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '全站異常總覽' })

const { data, loading, error, checkedAt, refresh } = useSuperAlerts()
const { apiFetch } = useSuperAdmin()
const { showToast } = useAdminToast()

// ── 同事標「資料沒錯，是 AI 弄錯了」（`D-136`）──
/** 這次按過「處理好了」的：還在跑的那次重新整理晚回來、帶著舊快取，也不讓它長回來 */
const handledMistakeIds = ref<string[]>([])
const aiMistakes = computed<SuperAiMistake[]>(() =>
  (data.value?.aiMistakes ?? []).filter(m => !handledMistakeIds.value.includes(m.id)))
const handlingMistakeId = ref('')

function mdText(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function openMistakeConversation(row: SuperAiMistake) {
  navigateTo(`/admin/${row.workspaceId}/conversations?userId=${encodeURIComponent(row.userId)}`)
}

/**
 * ⛔ 不呼叫 refresh({ force: true })：那會把全部帳號的異常重新探測一輪（含 LINE API），只為了拿掉一列；
 * 而且碰上還在跑的一般重新整理會拿到 5 分鐘前的快取、那一列又出現（`/code-review` 10-19）。
 * 本地拿掉那一列就好；伺服器那份快取由 POST 那支清掉。
 */
async function markMistakeHandled(row: SuperAiMistake) {
  handlingMistakeId.value = row.id
  try {
    await apiFetch('/api/ai/feedback-marks', { method: 'POST', body: { reason: 'ai_mistake', ids: [row.id] } })
    handledMistakeIds.value = [...handledMistakeIds.value, row.id]
  }
  catch {
    showToast('沒有標成功，請再試一次', 'error')
  }
  finally {
    handlingMistakeId.value = ''
  }
}

// ── 客人傳的圖讀不出來（`C-164`）──
const imgRows = computed<SuperImageReadFailureRow[]>(() => data.value?.imageReadFailures?.workspaces ?? [])
const imgWindowDays = computed(() => data.value?.imageReadFailures?.windowDays ?? 7)
const imgBurst = computed(() => data.value?.imageReadFailures?.burst ?? null)

function hmText(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function mdhmText(ms: number): string {
  return ms ? `${mdText(ms)} ${hmText(ms)}` : '—'
}

const imgValue = computed(() => {
  if (!data.value) return '—'
  const f = data.value.imageReadFailures
  return f ? `${f.total} 張` : '查不到'
})

/** 結論先行：連著壞了就講是哪一段時間（側欄點紅的原因要在這頁第一眼看得到） */
const imgHint = computed(() => {
  if (!data.value) return '檢查中…'
  const f = data.value.imageReadFailures
  if (!f) return '不等於沒有，明細在最下面'
  if (f.burst)
    return `${mdText(f.burst.startMs)} ${hmText(f.burst.startMs)}–${hmText(f.burst.endMs)} 就有 ${f.burst.count} 張，不像偶發`
  return `近 ${f.windowDays} 天；一小時內 3 張以上才變紅`
})

function openImageConversation(row: SuperImageReadFailureRow) {
  navigateTo(`/admin/${row.workspaceId}/conversations?userId=${encodeURIComponent(row.lastConversationId)}`)
}

// ── 自動扣款失敗（`B-43`②）──
const pastDueCount = computed(() => pastDueAccountCount(data.value))
const dunningValue = computed(() => {
  if (!data.value) return '—'
  return data.value.dunning ? `${pastDueCount.value} 個帳號` : '查不到'
})
const dunningHint = computed(() => {
  if (!data.value) return '檢查中…'
  const rows = data.value.dunning
  if (!rows) return '不等於沒有，明細在下面'
  const down = rows.filter(r => r.state === 'downgraded').length
  return down ? `還在寬限期；近 ${RECENT_DOWNGRADE_DAYS} 天另有 ${down} 個已降回免費` : '還在寬限期、每天再扣一次'
})

// ── 帳務信（`B-50`）──
const { user } = useAuth()
const myEmail = computed(() => String(user.value?.email ?? ''))
const emailState = computed(() => (data.value?.email ? emailHealthState(data.value.email) : null))
const EMAIL_STATE_TEXT = { ok: '寄得出去', broken: '寄不出去', unsent: '還沒寄過', off: '沒有設定' } as const
const emailValue = computed(() => {
  if (!data.value) return '—'
  return emailState.value ? EMAIL_STATE_TEXT[emailState.value] : '查不到'
})
/** 結論先行：壞了講壞在哪，好的講最近一次什麼時候寄出去 */
const emailHint = computed(() => {
  const e = data.value?.email
  if (!data.value) return '檢查中…'
  if (!e) return '不等於沒問題，明細在最下面'
  switch (emailState.value) {
    case 'broken': return e.configured ? `最近一封寄失敗（${mdhmText(e.lastFailureAt ?? 0)}）` : '付款開著，但寄信設定不齊'
    case 'unsent': return '設定齊了、還沒寄出過——按最下面的測試信確認'
    case 'off': return '付款也沒開，不需要'
    default: return `最近寄出 ${mdhmText(e.lastSuccessAt ?? 0)}`
  }
})

const sendingTestEmail = ref(false)
/**
 * ⛔ 不呼叫 refresh({ force: true })：那會把全部帳號的異常重新探測一輪（含 LINE API），只為了更新寄信那一格。
 * 端點寄完回最新的寄信狀態，這裡就地換掉那一格就好。
 */
async function sendTestEmail() {
  sendingTestEmail.value = true
  try {
    const r = await apiFetch<{ ok: boolean, to: string, error?: string, health: SuperAlertsOverviewPayload['email'] }>(
      '/api/admin/super/test-email', { method: 'POST' })
    if (data.value && r.health) data.value = { ...data.value, email: r.health }
    if (r.ok) showToast(`已寄到 ${r.to}，去收信看看（也看一下垃圾郵件）`, 'success')
    else showToast(`寄不出去：${r.error ?? '原因不明'}`, 'error')
  }
  catch (e) {
    showToast((e as { data?: { statusMessage?: string } })?.data?.statusMessage ?? '寄不出去，請再試一次', 'error')
  }
  finally {
    sendingTestEmail.value = false
  }
}

onMounted(() => { refresh() })
function reload() { refresh({ force: true }) }

function enterWorkspace(id: string) {
  navigateTo(`/admin/${id}/conversation-stats`)
}

const checkedAtText = computed(() => {
  if (!checkedAt.value) return ''
  const d = new Date(checkedAt.value)
  return `上次檢查 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

// ── 心跳（結論先行：值講狀態、hint 講上次時間與怎麼辦） ──
function ageText(minutes: number): string {
  return minutes >= 120 ? `${Math.round(minutes / 60)} 小時` : `${minutes} 分鐘`
}

const hbState = computed(() => data.value?.heartbeat.state ?? 'unknown')

const hbValue = computed(() => {
  if (!data.value) return '—'
  if (hbState.value === 'ok') return '正常運作'
  if (hbState.value === 'stalled') return '停擺了'
  return '查不到'
})

const hbHint = computed(() => {
  const hb = data.value?.heartbeat
  if (!hb) return '檢查中…'
  if (hb.state === 'ok')
    return `上次自動維護約 ${ageText(hb.ageMinutes ?? 0)}前，正常每 10 分鐘一輪`
  if (hb.state === 'stalled')
    return `上次已是 ${ageText(hb.ageMinutes ?? 0)}前——LINE 警報、SLA、每日摘要都靠它發，先查 Cloud Scheduler 再看主機`
  return '心跳紀錄不存在（本機或還沒部署排程），不下結論'
})

// ── 表格列 ──
interface Chip { text: string, detail?: string }
interface Row {
  id: string
  name: string
  critical: Chip[]
  advisory: Chip[]
  unknownCount: number
  usage: UsageRatioVerdict
}

function toChip(item: SuperAlertsWorkspace['items'][number]): Chip {
  const count = (item.count ?? 0) > 1 ? `×${item.count}` : ''
  const sys = SYSTEM_OWNED_ALERTS.has(item.id) ? '(系統端)' : ''
  return { text: `${ALERT_LABELS[item.id] ?? item.id}${count}${sys}`, detail: item.detail }
}

const rows = computed<Row[]>(() => (data.value?.workspaces ?? []).map((w) => {
  const active = w.items.filter(i => i.state === 'active')
  return {
    id: w.id,
    name: w.name,
    critical: active.filter(i => severityOf(i) === 'critical').map(toChip),
    // 建議處理＝黃級＋「可以更好」一起列:超管視角都是要掃一眼的事,分兩欄只會更擠
    advisory: active.filter(i => severityOf(i) !== 'critical').map(toChip),
    unknownCount: w.items.filter(i => i.state === 'unknown').length,
    usage: w.usage,
  }
}))

const problemRows = computed(() =>
  rows.value
    .filter(r => r.critical.length || r.advisory.length || r.unknownCount || r.usage.flagged)
    .sort((a, b) =>
      (b.critical.length - a.critical.length)
      || (Number(b.usage.flagged) - Number(a.usage.flagged))
      || (b.advisory.length - a.advisory.length)))

const healthyCount = computed(() => rows.value.length - problemRows.value.length)
const criticalWsCount = computed(() => rows.value.filter(r => r.critical.length).length)
const advisoryWsCount = computed(() => rows.value.filter(r => r.advisory.length).length)
const flaggedWsCount = computed(() => rows.value.filter(r => r.usage.flagged).length)
</script>

<!-- 樣式在 app/assets/scss/pages/_super-admin.scss（依專案慣例不寫在 .vue 內） -->
