<template>
  <AdminSplitLayout solo>
    <template #editor-header>
      <!-- 副標用問句講這一頁回答什麼（2026-08-07 拍板），並講明單位：
           這頁數「則」、統計頁數「場」——兩頁數字對不上不是 bug，是單位不同 -->
      <AdminSoloPageHeading
        field-label="AI 客服"
        title="用量 / 監控"
        caption="AI 做了多少工、花了多少——這裡數的是「則」（AI 每回一次算一則）。"
      >
        <template #caption>
          想看客人來了多少、誰接住的（數「場」）？<NuxtLink :to="`/admin/${workspaceId}/conversation-stats`" class="admin-inline-link">看對話統計 →</NuxtLink>
        </template>
      </AdminSoloPageHeading>
      <div class="flex gap-2 admin-header-actions">
        <el-select v-model="period" size="small" data-tour="usg-period" style="width: 130px" @change="loadAll">
          <el-option
            v-for="opt in periodOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
        <el-button :icon="Refresh" :loading="loading" @click="loadAll">重新整理</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="usage-body admin-panel-stack">
        <!-- ── AI 狀態列：老闆第一眼要知道 AI 有沒有在跑；未啟用時點明數字是歷史/測試 ── -->
        <div v-if="aiStatus" class="usage-status" :class="`usage-status--${aiStatus.tone}`">
          <span class="usage-status__dot" />
          <div class="usage-status__body">
            <span class="usage-status__title">{{ aiStatus.title }}</span>
            <span class="usage-status__desc">{{ aiStatus.desc }}</span>
          </div>
          <el-button v-if="aiStatus.tone === 'off'" size="small" type="primary" @click="goSettings">去啟用</el-button>
        </div>

        <!-- ── 方案額度（D1 進度條 / D2 超量提示） ── -->
        <template v-if="planQuota">
          <el-alert
            v-if="isCurrentPeriod && quotaState === 'over'"
            type="error"
            :closable="false"
            show-icon
            title="本月則數已用完"
            style="margin-bottom: 16px"
          >
            <div class="quota-alert-body">
              <span>AI 自動回覆已暫停、改由真人接手。升級方案或加購額度即可恢復自動回覆。</span>
              <el-button size="small" type="primary" @click="upgradeDialogOpen = true">升級方案</el-button>
            </div>
          </el-alert>
          <el-alert
            v-else-if="isCurrentPeriod && quotaState === 'near'"
            type="warning"
            :closable="false"
            show-icon
            title="本月則數即將用完"
            style="margin-bottom: 16px"
          >
            <div class="quota-alert-body">
              <span>已使用 {{ quotaPercentRaw }}%，用完後 AI 會暫停自動回覆並轉真人，建議提前升級方案。</span>
              <el-button size="small" type="primary" @click="upgradeDialogOpen = true">升級方案</el-button>
            </div>
          </el-alert>

          <div class="message-card usage-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">方案額度</span>
                <span class="text-xs text-muted">{{ planQuota.name }} · 本期 {{ quotaPeriodLabel }}</span>
              </div>
              <div class="plan-card-head-actions">
                <span v-if="planQuota.currentPeriodEnd" class="text-xs text-muted">{{ planQuota.currentPeriodEnd }} 續期</span>
                <!-- 無固定則數上限（客製/內部方案）打不到額度，升級對他沒意義 → 不顯示，避免噪音 -->
                <el-button v-if="quotaLimit != null" size="small" @click="upgradeDialogOpen = true">升級方案</el-button>
              </div>
            </div>
            <div class="card-section-stack">
              <template v-if="quotaLimit != null">
                <el-progress
                  :percentage="quotaPercent"
                  :color="quotaColor"
                  :stroke-width="18"
                  :text-inside="true"
                  :format="() => `${quotaPercentRaw}%`"
                />
                <p class="usage-hint">
                  本期已用 <strong>{{ formatNumber(quotaUsed) }}</strong> / {{ formatNumber(quotaLimit) }} 則
                  <template v-if="quotaRemaining !== null">（剩 {{ formatNumber(quotaRemaining) }} 則）</template>
                  <template v-if="planQuota.overagePerReply">・超量加購 NT${{ planQuota.overagePerReply }}/則</template>
                </p>
              </template>
              <p v-else class="usage-hint">此方案為客製額度，無固定則數上限。</p>
              <!-- 雙時間軸提醒：額度按「續約日」算一期，和上方報表的月份不是同一個區間，避免日期兜不起來被誤會 -->
              <p v-if="planQuota.currentPeriodStart" class="usage-hint usage-hint--muted">
                額度以「續約日」為一期（{{ quotaPeriodLabel }}），和上方報表選的月份不是同一個區間。
              </p>
            </div>
          </div>

          <AdminPlanUpgradeDialog v-model="upgradeDialogOpen" :current-plan-id="planQuota.id" />
        </template>

        <!-- ── KPI cards ─────────────────────── -->
        <div class="message-card usage-card" data-tour="usg-kpi">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">核心指標</span>
              <span class="text-xs text-muted">{{ periodLabel }}</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div v-if="loading && !summary" class="usage-loading"><div class="spinner" /></div>
            <template v-else>
              <!-- Hero：AI 出手 = 自己答完 + 轉給真人 + 先問清楚（乾淨拆解，一條分段長條看懂產出結構）。
                   用詞照 2026-08-07 的名詞收斂表（docs/STATS-SIMPLIFICATION-20260807.md）：
                   不再講「AI 介入／反問」——畫面早就是白話了，註解也別留舊詞免得被抄回去 -->
              <div class="usage-hero">
                <div class="usage-hero__head">
                  <strong class="usage-hero__num">{{ formatNumber(summary?.invocations) }}</strong>
                  <span class="usage-hero__label">則 <b>客人訊息</b><br>這個月 AI 幫你處理的則數</span>
                </div>
                <template v-if="(summary?.invocations ?? 0) > 0">
                  <div
                    class="usage-segbar"
                    role="img"
                    :aria-label="`自己答完 ${summary?.answered}、轉給真人 ${summary?.handoffs}、先問清楚 ${summary?.disambiguations}`"
                  >
                    <span class="usage-seg usage-seg--answered" :style="{ width: `${segPct.answered}%` }" />
                    <span class="usage-seg usage-seg--handoff" :style="{ width: `${segPct.handoff}%` }" />
                    <span class="usage-seg usage-seg--clarify" :style="{ width: `${segPct.clarify}%` }" />
                  </div>
                  <div class="usage-legend">
                    <div class="usage-leg usage-leg--answered">
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">自己答完</span>
                      <span class="usage-leg__v">{{ formatNumber(summary?.answered) }}</span>
                      <span class="usage-leg__pct">{{ formatPercent(summary?.autoReplyRate) }}</span>
                    </div>
                    <div
                      class="usage-leg usage-leg--handoff"
                      :class="{ 'usage-leg--link': (summary?.handoffs ?? 0) > 0 }"
                      :role="(summary?.handoffs ?? 0) > 0 ? 'button' : undefined"
                      :tabindex="(summary?.handoffs ?? 0) > 0 ? 0 : undefined"
                      @click="(summary?.handoffs ?? 0) > 0 && scrollToHandoffs()"
                      @keydown.enter="(summary?.handoffs ?? 0) > 0 && scrollToHandoffs()"
                    >
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">
                        轉給真人
                        <!-- 兩本帳的說明放在最容易被拿去對數字的位置：這裡數「次」（AI 每觸發一次轉接算一次）、
                             對話統計頁數「場」（同一場轉幾次都算 1）——兩邊數字不同是刻意的，見定義書 -->
                        <el-tooltip placement="top" content="這裡數「次」：AI 每觸發一次轉真人算一次。對話統計頁的「轉真人」數「場」（同一場轉幾次都算 1），所以兩頁數字不一樣是正常的。">
                          <el-icon class="usage-leg__info"><InfoFilled /></el-icon>
                        </el-tooltip>
                      </span>
                      <span class="usage-leg__v">{{ formatNumber(summary?.handoffs) }}</span>
                      <span class="usage-leg__pct">{{ formatPercent(summary?.handoffRate) }}</span>
                      <span v-if="(summary?.handoffs ?? 0) > 0" class="usage-leg__go">查看 ↓</span>
                    </div>
                    <div class="usage-leg usage-leg--clarify">
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">
                        先問清楚
                        <el-tooltip placement="top" content="AI 先問客人「你是要哪一個」再回答。偏高通常代表知識標題太相近。">
                          <el-icon class="usage-leg__info"><InfoFilled /></el-icon>
                        </el-tooltip>
                      </span>
                      <span class="usage-leg__v">{{ formatNumber(summary?.disambiguations) }}</span>
                      <span class="usage-leg__pct">{{ formatPercent(summary?.disambiguationRate) }}</span>
                    </div>
                  </div>
                </template>
                <div v-else class="usage-empty">這個月 AI 還沒有處理任何訊息</div>
              </div>

              <!-- 主畫面留給「答得好不好」。花費是平台的進貨成本（計費賣「則」），
                   只有 super admin 看得到——租戶端通篇只講「則」，API 也不回成本欄位。 -->
              <div class="usage-substats">
                <div v-if="isSuperAdmin" class="usage-substat">
                  <span class="usage-substat__label">
                    這個月 AI 花費
                    <el-tooltip placement="top" content="只算跟客人對話的部分。整理知識庫、後台自用的花費另計，在下方「進階」。金額為依 Gemini 公開價估算的參考值，實際以 Google 帳單為準。">
                      <el-icon class="usage-substat__info"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </span>
                  <strong class="usage-substat__value">約 NT${{ formatNumber(twd(summary?.estimatedCostUsd)) }}</strong>
                  <span class="usage-substat__sub">
                    跟客人對話的花費<template v-if="((summary?.buildCostUsd ?? 0) + (summary?.testCostUsd ?? 0)) > 0"> · 建置 / 測試另計，見進階</template> · 僅系統管理員看得到
                  </span>
                </div>
                <!-- 「答完客人又找真人」是目前唯一能回答「答得好不好」的數字，放主畫面，不收進進階。
                     沒有任何 AI 答題時顯示「—」:0% 上綠色會把「沒資料」講成「滿分」。 -->
                <div class="usage-substat">
                  <span class="usage-substat__label">
                    答完客人又找真人
                    <el-tooltip placement="top" content="AI 回答完 30 分鐘內，客人仍要求轉真人——通常代表沒答對或沒答到重點。這是最接近「答得好不好」的指標。">
                      <el-icon class="usage-substat__info"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </span>
                  <template v-if="(summary?.answered ?? 0) > 0">
                    <strong class="usage-substat__value" :class="metricTone('answeredThenHandoff', summary?.answeredThenHandoffRate)">{{ formatPercent(summary?.answeredThenHandoffRate) }}</strong>
                    <span class="usage-substat__sub">{{ formatNumber(summary?.answeredThenHandoffs) }} 次 · 越低越好</span>
                  </template>
                  <template v-else>
                    <strong class="usage-substat__value">—</strong>
                    <span class="usage-substat__sub">這個月 AI 還沒有答過題</span>
                  </template>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- ── 近 3 個月趨勢：讓「監控」看得出變好還變差，不只是單月快照 ── -->
        <div class="message-card usage-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">近 3 個月趨勢</span>
              <span class="text-xs text-muted">自己答完 vs 轉給真人</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div v-if="loadingTrend && !trend.length" class="usage-loading"><div class="spinner" /></div>
            <ClientOnly v-else-if="trendHasData">
              <VChart class="usage-trend-chart" :option="trendOption" autoresize />
              <template #fallback><div class="usage-loading"><div class="spinner" /></div></template>
            </ClientOnly>
            <div v-else class="usage-empty">還沒有足夠資料能看趨勢，AI 開始服務客人後這裡就會長出來。</div>
          </div>
        </div>

        <!-- ── 進階 / 技術細節（token / 成本組成 = 平台的進貨價 → 僅 super admin；預設收合） ── -->
        <div v-if="isSuperAdmin" class="message-card usage-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">進階 / 技術細節</span>
              <span class="badge badge-gray">僅系統管理員可見</span>
              <span class="text-xs text-muted">成本組成（依用途拆三桶）</span>
            </div>
            <el-button text size="small" @click="advancedOpen = !advancedOpen">
              {{ advancedOpen ? '收合' : '展開' }}
              <el-icon class="el-icon--right"><component :is="advancedOpen ? ArrowUp : ArrowDown" /></el-icon>
            </el-button>
          </div>
          <div v-show="advancedOpen" class="card-section-stack">
            <!-- 成本依用途拆三桶（台幣）：客人對話才是上方花費；建置與測試各自獨立 -->
            <div class="usage-cost-split">
              <div class="usage-cost-row">
                <span class="usage-cost-row__dot usage-cost-row__dot--conv" />
                <span class="usage-cost-row__k">客人對話</span>
                <span class="usage-cost-row__tok">{{ formatNumber(summary?.conversationTokens) }} tokens</span>
                <strong class="usage-cost-row__cost">約 NT${{ formatNumber(twd(summary?.estimatedCostUsd)) }}</strong>
              </div>
              <div class="usage-cost-row">
                <span class="usage-cost-row__dot usage-cost-row__dot--build" />
                <span class="usage-cost-row__k">知識庫建置</span>
                <span class="usage-cost-row__tok">{{ formatNumber(summary?.buildTokens) }} tokens</span>
                <strong class="usage-cost-row__cost">約 NT${{ formatNumber(twd(summary?.buildCostUsd)) }}</strong>
              </div>
              <div class="usage-cost-row">
                <span class="usage-cost-row__dot usage-cost-row__dot--test" />
                <span class="usage-cost-row__k">後台自用</span>
                <span class="usage-cost-row__tok">{{ formatNumber(summary?.testTokens) }} tokens</span>
                <strong class="usage-cost-row__cost">約 NT${{ formatNumber(twd(summary?.testCostUsd)) }}</strong>
              </div>
              <div class="usage-cost-total">
                <span>合計 · 工作區總花費</span>
                <strong>約 NT${{ formatNumber(twd(totalCostUsd)) }}</strong>
              </div>
            </div>
            <p class="usage-hint">
              成本依「用途」拆三塊：<strong>客人對話</strong>＝跟真客人來回問答（上方「這個月 AI 花費」就是這桶）；<strong>知識庫建置</strong>＝匯入、整理、讓 AI 學習這些內容，屬一次性 / 偶爾的花費，不是每次對話都有；<strong>後台自用</strong>＝你自己在後台操作 AI：試打、試答知識卡、問小幫手、一句話生成腳本，都不計入客人成本。
            </p>
            <p class="usage-hint">
              金額依 Gemini 公開價估算（USD 約 ×32 換台幣）的<strong>偏高參考值</strong><template v-if="pricing">，每 100 萬用量：送入 ${{ pricing.inputPerM }} / 產生 ${{ pricing.outputPerM }} / 搜尋 ${{ pricing.embedPerM }} USD</template>。實際費用以 Google 帳單為準。
            </p>
          </div>
        </div>

        <!-- ── 低信心 / 轉真人案例 ──────────────── -->
        <div ref="handoffCard" class="message-card usage-card" data-tour="usg-cases">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">近期轉真人案例</span>
              <span class="text-xs text-muted">還沒處理的問題</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="usage-hint">
              客人問了 AI 但答不出來的情況。點「補知識」直接到知識庫補一張對應卡。
            </p>
            <!-- 篩選移到卡片內（不再擠在標題列），並補中文 placeholder（原本顯示英文「Select」） -->
            <div class="usage-handoff-toolbar">
              <el-select v-model="reasonFilter" size="small" placeholder="全部原因" style="width: 150px" @change="loadHandoffs">
                <el-option label="全部原因" value="" />
                <!-- 由共用標籤表導出:手打第二份會漂移(曾發生下拉與列表徽章同一原因兩種名字) -->
                <el-option
                  v-for="opt in reasonOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <el-checkbox v-model="showResolved" size="small" @change="loadHandoffs">顯示已處理</el-checkbox>
            </div>
            <div v-if="loadingHandoffs && !handoffs.length" class="usage-loading"><div class="spinner" /></div>
            <!-- 和解：此清單＝「目前還卡著、尚未處理」的對話（不分月份），與上方本月轉接次數不是同一份計數，
                 避免「本月 141 次轉接」與「0 待處理」被誤讀成互相矛盾。空狀態要像「已清空」而非「沒資料」。 -->
            <div v-else-if="!handoffs.length" class="usage-empty usage-empty--good">
              <span class="usage-empty__icon">✓</span>
              <div>
                <div class="usage-empty__title">沒有待補知識的轉真人對話了</div>
                <div class="usage-empty__desc">這裡只列「目前還卡著、尚未處理」的對話，和上方本月轉接次數不是同一份計數。想回顧請勾「顯示已處理」。</div>
              </div>
            </div>
            <div v-else class="usage-handoff-list">
              <div v-for="row in handoffs" :key="`${row.userId}-${row.updatedAtMs}`" class="usage-handoff-row" :class="{ 'usage-handoff-row--resolved': row.resolved }">
                <div class="usage-handoff-meta">
                  <span :class="reasonBadgeClass(row.handoffReason)">{{ reasonLabel(row.handoffReason) }}</span>
                  <span v-if="row.resolved" class="badge badge-gray">已處理</span>
                  <span class="text-xs text-muted"><template v-if="advancedOpen">信心 {{ row.lastConfidence.toFixed(2) }} · </template>{{ formatTime(row.updatedAtMs) }}</span>
                </div>
                <div class="usage-handoff-query">
                  <span class="usage-handoff-user">{{ row.displayName || '匿名客人' }}：</span>
                  <span>{{ row.lastQuery || '(無問題內容)' }}</span>
                </div>
                <div v-if="row.sources.length" class="usage-handoff-sources">
                  最相近卡：{{ row.sources.slice(0, 2).map(s => s.title).join('、') }}
                </div>
                <div v-if="row.handoffReason === 'non_text_content'" class="usage-handoff-sources">
                  AI 目前看不懂圖片、影片這類內容，客人傳完後就要求真人。點「開對話」看客人傳了什麼。
                </div>
                <div class="usage-handoff-actions">
                  <!-- 傳圖案例沒有「補知識」可按,主要動作換成開對話,不讓那一列全是次要按鈕 -->
                  <el-button :icon="ChatDotRound" size="small" :type="row.handoffReason === 'non_text_content' ? 'primary' : undefined" plain @click="goConversation(row.userId)">開對話</el-button>
                  <!-- 傳圖案例:客人原句是「[圖片]」,補知識會拿它當卡片標題、重演會拿它去問 AI,兩個都是死路 -->
                  <el-button v-if="row.handoffReason !== 'non_text_content'" :icon="Upload" size="small" type="primary" plain @click="goAddKnowledge(row.lastQuery)">補知識</el-button>
                  <el-button v-if="advancedOpen && row.handoffReason !== 'non_text_content'" size="small" plain @click="goPlayground(row.lastQuery)">▶ 重演</el-button>
                  <el-button v-if="!row.resolved" size="small" type="success" plain :loading="resolvingUserId === row.userId" @click="resolveHandoff(row.userId)">✓ 已處理</el-button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { ArrowDown, ArrowUp, ChatDotRound, InfoFilled, Refresh, Upload } from '@element-plus/icons-vue'
import { HANDOFF_REASON_LABELS, type HandoffReason } from '~~/shared/types/ai-knowledge'
import { useAdminToast } from '~~/app/composables/useAdminToast'
import { derivePlanState } from '~~/shared/billing/plan-state'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { apiFetch, workspaceId } = useWorkspace()
const router = useRouter()
const route = useRoute()
const { showToast } = useAdminToast()
// 成本 / token 細目只給 super admin：金額是平台進貨價（計費賣「則」），租戶看得到就能反推毛利
const { isSuperAdmin, checkIsSuperAdmin } = useSuperAdmin()

// 用量明細（Token）預設收合：需要技術數字才展開（整卡僅 super admin 可見）
const advancedOpen = ref(false)

interface Summary {
  period: string
  /** AI 自動回覆是否已啟用；未啟用時 webhook 不跑 AI，畫面數字皆為歷史/測試 */
  aiEnabled: boolean
  replyMode: 'auto' | 'draft'
  /** 本期（訂閱週期）已用則數 —— 額度進度條看這個，與攔截同一顆計數器；不隨月份切換。 */
  quotaAnswered: number
  invocations: number
  answered: number
  handoffs: number
  answeredThenHandoffs: number
  answeredThenHandoffRate: number
  disambiguations: number
  disambiguationRate: number
  autoReplyRate: number
  handoffRate: number
  /** ↓ token / 成本細目：僅 super admin 的回應才有這些欄位（租戶端 API 直接不回） */
  inputTokens?: number
  outputTokens?: number
  embeddingTokens?: number
  importInputTokens?: number
  importOutputTokens?: number
  /** 三桶用途拆分：客人對話（headline 成本就是這桶）/ 知識庫建置 / 後台自用 */
  conversationTokens?: number
  buildTokens?: number
  buildCostUsd?: number
  testTokens?: number
  testCostUsd?: number
  estimatedCostUsd?: number
  perConversationUsd?: number
  pricing?: { inputPerM: number; outputPerM: number; embedPerM: number }
  plan: {
    id: string
    name: string
    answeredQuota: number | null
    overagePerReply: number | null
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
  } | null
}

interface HandoffRow {
  userId: string
  displayName: string
  lastQuery: string
  lastConfidence: number
  handoffReason: HandoffReason | null
  resolved: boolean
  sources: Array<{ chunkId: string; title: string }>
  updatedAtMs: number
}

interface TrendPoint {
  period: string
  label: string
  invocations: number
  answered: number
  handoffs: number
}

const summary = ref<Summary | null>(null)
const handoffs = ref<HandoffRow[]>([])
const trend = ref<TrendPoint[]>([])
const loading = ref(false)
const loadingHandoffs = ref(false)
const loadingTrend = ref(false)
const reasonFilter = ref<'' | HandoffReason>('')
const showResolved = ref(false)

// 'manual' 是內部人工指定,不提供篩選(後端白名單同樣排除)
const reasonOptions = (Object.entries(HANDOFF_REASON_LABELS) as Array<[HandoffReason, string]>)
  .filter(([value]) => value !== 'manual')
  .map(([value, label]) => ({ value, label }))

// 單價由 summary API 回傳（後端單一事實來源），還沒載到前先不顯示數字
const pricing = computed(() => summary.value?.pricing ?? null)

// AI 出手的三種結果佔比（分段長條寬度）。已驗證每次出手只記一種結果，
// 故 invocations = answered + handoffs + disambiguations 恆等，三段相加即 100%。
const segPct = computed(() => {
  const total = summary.value?.invocations || 0
  if (!total) return { answered: 0, handoff: 0, clarify: 0 }
  return {
    answered: ((summary.value?.answered ?? 0) / total) * 100,
    handoff: ((summary.value?.handoffs ?? 0) / total) * 100,
    clarify: ((summary.value?.disambiguations ?? 0) / total) * 100,
  }
})

// 頂端狀態列：AI 有沒有在跑（老闆第一眼要知道的）。未啟用時特別點明「數字是歷史/測試」。
const aiStatus = computed(() => {
  if (!summary.value) return null
  if (!summary.value.aiEnabled) {
    return { tone: 'off', title: 'AI 客服尚未啟用', desc: '客人目前不會收到 AI 回覆。下方數字是先前建置或測試留下的，不是真實客服表現。' }
  }
  if (summary.value.replyMode === 'draft') {
    return { tone: 'draft', title: 'AI 草稿模式', desc: 'AI 會擬好回覆放進收件匣，但不會自動發送給客人。' }
  }
  return { tone: 'on', title: 'AI 客服運作中', desc: '客人傳訊息時，AI 會自動回答；答不出來的會轉給真人。' }
})
function goSettings() {
  router.push(`/admin/${workspaceId.value}/ai-settings`)
}

// F7 下鑽：hero 的「轉給真人」可點，捲到同頁下方的轉真人清單（同頁、同不分月份口徑，
// 不會有「月份 KPI vs 清單」對不上的問題）。
const handoffCard = ref<HTMLElement | null>(null)
function scrollToHandoffs() {
  handoffCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 近 3 個月趨勢：有任何一個月有量才畫圖，否則顯示「資料不足」空狀態（剛上線/剛清空時）。
const trendHasData = computed(() => trend.value.some(p => p.invocations > 0))
const trendOption = computed(() => {
  const t = trend.value
  return {
    // ⚠️ 必須與 hero 分段長條同色（_ai-usage.scss 的 --brand-green-deep / #5b7a9d）：
    // 同一頁上下兩塊講同一件事，顏色一漂就變成「四種顏色三個意思」。
    // ECharts 吃不了 CSS 變數，只能硬寫——改 token 時要記得回來改這裡。
    color: ['#05b24c', '#5b7a9d'],
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 8, data: ['自己答完', '轉給真人'] },
    grid: { left: 8, right: 12, top: 22, bottom: 34, containLabel: true },
    xAxis: { type: 'category', data: t.map(p => p.label), axisTick: { alignWithLabel: true } },
    yAxis: {
      type: 'value',
      minInterval: 1,
      max: (v: { max: number }) => Math.max(1, Math.ceil((v.max || 1) * 1.15)),
      splitLine: { lineStyle: { type: 'dashed' } },
    },
    series: [
      { name: '自己答完', type: 'bar', barMaxWidth: 34, data: t.map(p => p.answered), label: { show: true, position: 'top', fontSize: 11 } },
      { name: '轉給真人', type: 'bar', barMaxWidth: 34, data: t.map(p => p.handoffs), label: { show: true, position: 'top', fontSize: 11 } },
    ],
  }
})

// 三桶成本相加＝工作區總花費（客人對話 + 知識庫建置 + 後台自用）
const totalCostUsd = computed(() => {
  const s = summary.value
  if (!s) return 0
  return (s.estimatedCostUsd ?? 0) + (s.buildCostUsd ?? 0) + (s.testCostUsd ?? 0)
})

// ── Period selector（過去 3 個月） ─────────────────────────
function makePeriodOptions() {
  const opts: Array<{ value: string; label: string }> = []
  // 月結桶用台灣時區（與 server currentYyyyMm / taipeiYyyyMm 同一把尺;台灣固定 UTC+8）
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000)
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth() - i, 1))
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    // 最近兩期講白話（value 仍是 yyyyMM，只改顯示）：這一頁其他地方都白話，
    // 只有這個選單露出 `2026-08` 原始格式。更早的月份照印年月才知道是哪一期。
    opts.push({ value: `${y}${m}`, label: i === 0 ? '這個月' : i === 1 ? '上個月' : `${y}-${m}` })
  }
  return opts
}
const periodOptions = makePeriodOptions()
const period = ref(periodOptions[0]!.value)
const periodLabel = computed(() => periodOptions.find(o => o.value === period.value)?.label ?? period.value)
const isCurrentPeriod = computed(() => period.value === periodOptions[0]!.value)

// ── 方案額度（D1/D2） ─────────────────────────────────────
// 額度狀態（門檻/顏色）由共用的 derivePlanState 導出，與設定頁方案卡同一份邏輯。
// 進度條吃 quotaAnswered（本期 = 訂閱週期）而不是 answered（所選月份的報表數字）——
// 額度按錨定日重置，跟日曆月不是同一把尺，拿報表數字當進度條會顯示錯的剩餘則數。
const planQuota = computed(() => summary.value?.plan ?? null)
const upgradeDialogOpen = ref(false)
const planState = computed(() => derivePlanState(planQuota.value, summary.value?.quotaAnswered ?? 0))
// 額度週期的起訖（錨定日制，例如 07/28 ~ 08/27）；與下方報表的月份選擇無關。
const quotaPeriodLabel = computed(() => {
  const p = planQuota.value
  if (!p?.currentPeriodStart || !p.currentPeriodEnd) return '—'
  return `${p.currentPeriodStart.slice(5)} ~ ${p.currentPeriodEnd.slice(5)}`
})
const quotaUsed = computed(() => planState.value.used)
const quotaLimit = computed(() => planState.value.limit)
const quotaPercentRaw = computed(() => planState.value.percentRaw)
const quotaPercent = computed(() => planState.value.percent)
const quotaRemaining = computed(() => planState.value.remaining)
const quotaState = computed(() => planState.value.state)
const quotaColor = computed(() => planState.value.color)

// ── Loaders ───────────────────────────────────────────────
async function loadSummary() {
  loading.value = true
  try {
    summary.value = await apiFetch<Summary>(`/api/ai/usage/summary?period=${period.value}`)
  }
  catch {
    summary.value = null
  }
  finally {
    loading.value = false
  }
}

async function loadHandoffs() {
  loadingHandoffs.value = true
  try {
    const params = new URLSearchParams({ limit: '20' })
    if (reasonFilter.value) params.set('reason', reasonFilter.value)
    if (showResolved.value) params.set('includeResolved', '1')
    handoffs.value = await apiFetch<HandoffRow[]>(`/api/ai/usage/handoffs?${params.toString()}`)
  }
  catch {
    handoffs.value = []
  }
  finally {
    loadingHandoffs.value = false
  }
}

async function loadTrend() {
  loadingTrend.value = true
  try {
    trend.value = await apiFetch<TrendPoint[]>('/api/ai/usage/trend?months=3')
  }
  catch {
    trend.value = []
  }
  finally {
    loadingTrend.value = false
  }
}

async function loadAll() {
  await Promise.all([loadSummary(), loadHandoffs(), loadTrend()])
}

// ── Format helpers ────────────────────────────────────────
function formatNumber(n?: number | null) {
  return (n ?? 0).toLocaleString('zh-TW')
}
function formatPercent(n?: number | null) {
  return `${Math.round((n ?? 0) * 100)}%`
}
// 成本用台幣白話呈現：USD × 匯率（粗估，實際以 Google 帳單為準，故四捨五入到整數即可）
const USD_TO_TWD = 32
function twd(usd?: number | null) {
  return Math.round((usd ?? 0) * USD_TO_TWD)
}

/**
 * 依「數值門檻」決定數字顏色（rates 為 0~1）。
 * 正向指標（越高越好）好→綠；負向指標（越高越糟）過線才橘。
 * 重點：0% 的「答後仍轉真人」是滿分，要綠不是橘——不再無條件警告。
 */
function metricTone(kind: string, v?: number | null): string {
  const x = v ?? 0
  if (kind === 'autoReply') return x >= 0.5 ? 'is-good' : x < 0.2 ? 'is-warn' : 'is-neutral'
  if (kind === 'handoff') return x <= 0.3 ? 'is-good' : x > 0.6 ? 'is-warn' : 'is-neutral'
  if (kind === 'answeredThenHandoff') return x <= 0.1 ? 'is-good' : x > 0.25 ? 'is-warn' : 'is-neutral'
  if (kind === 'disambiguation') return x <= 0.15 ? 'is-good' : x > 0.3 ? 'is-warn' : 'is-neutral'
  return 'is-neutral'
}
function formatTime(ms: number) {
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
function reasonLabel(r: HandoffReason | null) {
  return r ? HANDOFF_REASON_LABELS[r] ?? r : '(未知)'
}
function reasonBadgeClass(r: HandoffReason | null) {
  if (r === 'low_confidence') return 'badge badge-yellow'
  if (r === 'no_grounding') return 'badge badge-yellow'
  if (r === 'sensitive_topic') return 'badge badge-red'
  if (r === 'quota_exceeded') return 'badge badge-red'
  // 系統故障要一眼和「客人要求真人」這類正常轉接分開,不能同為灰色
  if (r === 'llm_error') return 'badge badge-red'
  // 傳圖:不是故障也不是客人主動要求,是 AI 讀不懂 → 給自己的顏色,才不會混進灰色那堆
  if (r === 'non_text_content') return 'badge badge-blue'
  return 'badge badge-gray'
}

// ── Navigation ────────────────────────────────────────────
function goConversation(userId: string) {
  router.push(`/admin/${workspaceId.value}/conversations?userId=${encodeURIComponent(userId)}`)
}
function goAddKnowledge(query: string) {
  // 帶客人原句過去:來源頁會自動開「新增手寫」視窗並預填標題,不用重打一遍。
  // 開新分頁(與測試對話、客服對話兩個入口一致):同頁跳轉會弄丟這份清單的篩選與捲動位置,
  // 而且補完卡沒有任何回得來的路。
  const q = (query || '').trim()
  const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
  window.open(`/admin/${workspaceId.value}/knowledge/sources${suffix}`, '_blank')
}
function goPlayground(query: string) {
  router.push(`/admin/${workspaceId.value}/ai-playground?q=${encodeURIComponent(query)}`)
}

const resolvingUserId = ref<string | null>(null)
async function resolveHandoff(userId: string) {
  resolvingUserId.value = userId
  try {
    await apiFetch('/api/ai/usage/handoffs/resolve', { method: 'POST', body: { userId } })
    // 「顯示已處理」開著時原地標記(可回顧);關著時直接從列表移除
    if (showResolved.value) {
      const row = handoffs.value.find(r => r.userId === userId)
      if (row) row.resolved = true
    }
    else {
      handoffs.value = handoffs.value.filter(r => r.userId !== userId)
    }
  }
  catch {
    // 保留在列表上讓使用者重試；沒有回饋會讓人以為按了沒反應而連點
    showToast('標記失敗，請再試一次', 'error')
  }
  finally {
    resolvingUserId.value = null
  }
}

onMounted(() => {
  void checkIsSuperAdmin().catch(() => {})
  // 異常中心「AI 服務近期失敗過」的深連結（?reason=llm_error&includeResolved=1）：
  // 自動套用原因篩選並捲到案例清單，省掉「落在頁頂自己找下拉」那一段
  const qReason = String(route.query.reason || '')
  const applied = qReason && reasonOptions.some(o => o.value === qReason)
  if (applied) {
    reasonFilter.value = qReason as HandoffReason
    // 警示看的是「發生過幾次」而非「還沒處理」→ 連結帶 includeResolved 才不會落在空清單
    if (String(route.query.includeResolved || '') === '1') showResolved.value = true
  }
  // deep-link 是一次性指令:用完清掉網址,否則使用者把篩選改回「全部原因」後 F5 又被套回來
  if (applied) router.replace({ query: {} }).catch(() => {})
  void loadAll().then(() => {
    if (applied)
      void nextTick(() => scrollToHandoffs())
  })
})
</script>
