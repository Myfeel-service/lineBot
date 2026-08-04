<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="超級管理員"
        title="AI 成本總覽"
        caption="全部官方帳號的 AI 花費，一頁看清楚錢花在哪、誰花的。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-date-picker
          v-model="period"
          type="month"
          value-format="YYYYMM"
          format="YYYY 年 MM 月"
          :clearable="false"
          placeholder="選擇月份"
        />
        <el-button :loading="loading" @click="load">重新整理</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <!-- 提醒：此頁只含 AI 成本 -->
        <div class="sa-cost-note">
          此頁只含 <b>AI 花費</b>（用 Google Gemini 回答與整理知識的錢），已用較貴的費率估算（偏保守、偏高）。
          <b>雲端主機、資料庫、LINE 推播、金流手續費不在此</b>，那些要看各平台帳單；實際金額以 Google 帳單為準。
        </div>

        <!-- 本月總成本 + 比例條 -->
        <div class="message-card ar-section-card">
          <div class="sa-cost-body">
            <div class="sa-cost-hero">
              <div class="sa-cost-hero__label">{{ periodLabel }} AI 總花費（估算）</div>
              <div class="sa-cost-hero__row">
                <div class="sa-cost-hero__value">{{ ntd(totals.totalCostUsd) }}</div>
                <span
                  v-if="hasSpend && deltaPct !== null"
                  class="sa-cost-delta"
                  :class="deltaPct > 0 ? 'is-up' : (deltaPct < 0 ? 'is-down' : 'is-flat')"
                >
                  較上月 {{ deltaPct > 0 ? '▲' : (deltaPct < 0 ? '▼' : '＝') }} {{ Math.abs(deltaPct) }}%
                </span>
              </div>
              <div class="sa-cost-hero__sub">
                {{ activeCount }} 個帳號有花費 ・ 本月回答客人 {{ totals.answered.toLocaleString() }} 則 ・ 後台測試 {{ totals.testInvocations.toLocaleString() }} 次
              </div>
            </div>

            <!-- 一條比例條看出三桶怎麼分（總額不到 NT$1 就不畫，避免出現「有%沒金額」） -->
            <template v-if="hasSpend">
              <div class="sa-cost-bar">
                <span class="sa-cost-seg sa-cost-seg--conv" :style="{ width: pct(totals.conversationCostUsd) + '%' }" />
                <span class="sa-cost-seg sa-cost-seg--build" :style="{ width: pct(totals.buildCostUsd) + '%' }" />
                <span class="sa-cost-seg sa-cost-seg--test" :style="{ width: pct(totals.testCostUsd) + '%' }" />
              </div>
              <div class="sa-cost-legend">
                <div class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--conv" />
                  <span class="sa-cost-legend__name">回答客人</span>
                  <span class="sa-cost-legend__val">{{ ntdSoft(totals.conversationCostUsd) }} ・ {{ pct(totals.conversationCostUsd) }}%</span>
                </div>
                <div class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--build" />
                  <span class="sa-cost-legend__name">整理知識庫</span>
                  <span class="sa-cost-legend__val">{{ ntdSoft(totals.buildCostUsd) }} ・ {{ pct(totals.buildCostUsd) }}%</span>
                </div>
                <div class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--test" />
                  <span class="sa-cost-legend__name">後台測試</span>
                  <span class="sa-cost-legend__val">{{ ntdSoft(totals.testCostUsd) }} ・ {{ pct(totals.testCostUsd) }}%</span>
                </div>
              </div>
            </template>
            <div v-else class="sa-cost-empty">{{ emptyText }}</div>
          </div>
        </div>

        <!-- 教學型：這些錢花在哪、做什麼、多少錢 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">這些錢花在哪？一看就懂</span>
            </div>
          </div>
          <div class="sa-cost-body">
            <p class="sa-cost-guide__intro">
              AI 是<b>按用量計費</b>的（單位叫 token，可想成「字數」）—— 客人問的字、AI 回的字都算錢。
              下面是三種會花錢的情況，以及各自大概多少。
            </p>
            <div class="sa-cost-guide">
              <div class="sa-cost-guide__col sa-cost-guide__col--conv">
                <div class="sa-cost-guide__head">
                  <span class="sa-cost-dot sa-cost-dot--conv" /> 回答客人
                  <span class="sa-cost-guide__when">客人每次來問就會用到</span>
                </div>
                <ul class="sa-cost-guide__list">
                  <li><b>看懂問題</b>：先判斷客人這句在問哪一類 <span class="sa-cost-guide__price">幾乎免費</span></li>
                  <li><b>找答案</b>：從知識庫挑出最相關的幾則資料 <span class="sa-cost-guide__price">幾乎免費</span></li>
                  <li><b>寫出回覆</b>：參考資料、產生答案（一則主要花這） <span class="sa-cost-guide__price">—</span></li>
                </ul>
                <div class="sa-cost-guide__foot">合計一則約 <b>NT$0.11</b></div>
              </div>

              <div class="sa-cost-guide__col sa-cost-guide__col--build">
                <div class="sa-cost-guide__head">
                  <span class="sa-cost-dot sa-cost-dot--build" /> 整理知識庫
                  <span class="sa-cost-guide__when">你上傳或整理資料時才會用到</span>
                </div>
                <ul class="sa-cost-guide__list">
                  <li><b>整理文件</b>：把 PDF／文件拆成一條條知識 <span class="sa-cost-guide__price">一份約 NT$2–5</span></li>
                  <li><b>掃描檔轉文字</b>：圖片型 PDF 先辨識成文字，最貴 <span class="sa-cost-guide__price">一份約 NT$5–10</span></li>
                </ul>
                <div class="sa-cost-guide__foot sa-cost-guide__foot--warn">⚠ 重傳同一份會重算重收，別重複上傳沒改的檔</div>
              </div>

              <div class="sa-cost-guide__col sa-cost-guide__col--test">
                <div class="sa-cost-guide__head">
                  <span class="sa-cost-dot sa-cost-dot--test" /> 後台測試
                  <span class="sa-cost-guide__when">你在後台試 AI 時才會用到</span>
                </div>
                <ul class="sa-cost-guide__list">
                  <li><b>試玩／測試</b>：自己在後台測 AI 回答的效果 <span class="sa-cost-guide__price">同回答客人</span></li>
                </ul>
                <div class="sa-cost-guide__foot">花費跟真的回答一樣，但記在這桶、不算到客人頭上</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 逐帳號明細 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">各官方帳號花了多少</span>
            </div>
            <span class="text-xs text-muted">{{ workspaces.length }} 個帳號 ・ 由高到低</span>
          </div>
          <div class="card-section-stack">
            <el-table v-loading="loading" :data="workspaces" size="small" empty-text="本月尚無 AI 花費">
              <el-table-column label="官方帳號" min-width="180">
                <template #default="{ row }">
                  <span class="text-sm font-bold">{{ row.name }}</span>
                  <el-tag v-if="!row.aiEnabled" size="small" type="info" class="sa-cost-off">AI 未啟用</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="本月回答" width="90" align="right">
                <template #default="{ row }"><span class="text-xs text-muted">{{ row.answered.toLocaleString() }} 則</span></template>
              </el-table-column>
              <el-table-column label="回答客人" width="105" align="right">
                <template #header><span class="sa-cost-th"><span class="sa-cost-dot sa-cost-dot--conv" />回答客人</span></template>
                <template #default="{ row }">{{ ntdSoft(row.conversationCostUsd) }}</template>
              </el-table-column>
              <el-table-column label="整理知識庫" width="110" align="right">
                <template #header><span class="sa-cost-th"><span class="sa-cost-dot sa-cost-dot--build" />整理知識庫</span></template>
                <template #default="{ row }">{{ ntdSoft(row.buildCostUsd) }}</template>
              </el-table-column>
              <el-table-column label="後台測試" width="115" align="right">
                <template #header><span class="sa-cost-th"><span class="sa-cost-dot sa-cost-dot--test" />後台測試</span></template>
                <template #default="{ row }">
                  <div>{{ ntdSoft(row.testCostUsd) }}</div>
                  <div v-if="row.testInvocations" class="text-xs text-muted">{{ row.testInvocations.toLocaleString() }} 次</div>
                </template>
              </el-table-column>
              <el-table-column label="合計" width="120" align="right">
                <template #default="{ row }"><span class="sa-cost-total">{{ ntdSoft(row.totalCostUsd) }}</span></template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!-- 外部成本估算（拖拉 what-if，不落地儲存） -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">加上外部成本，看概估總花費</span>
            </div>
            <span class="text-xs text-muted">拖用量參數估算 ・ 不會儲存</span>
          </div>
          <div class="sa-cost-body">
            <p class="sa-cost-guide__intro">
              拖動下面的<b>用量參數</b>（訊息量、推播量、營收），系統用實際單價幫你換算成本 —— 不是叫你憑空填金額。
              提醒：成本主要跟<b>訊息量、推播量、營收</b>走，<b>單純人數多不太花錢</b>（要有互動才算）。
            </p>
            <div class="sa-cost-est">
              <div class="sa-cost-est__inputs">
                <div class="sa-cost-est__row">
                  <div class="sa-cost-est__label">
                    <span class="sa-cost-est__name">每月訊息則數</span>
                    <span class="sa-cost-est__hint">客人來訊 ＋ AI 回覆的總量 → 資料庫 ＋ 主機 ＋ 儲存</span>
                  </div>
                  <el-slider v-model="msgsPerMonth" :max="500000" :step="1000" show-input />
                </div>
                <div class="sa-cost-est__row">
                  <div class="sa-cost-est__label">
                    <span class="sa-cost-est__name">每月主動推播則數</span>
                    <span class="sa-cost-est__hint">群發／排程訊息 → LINE 推播費（超過免費額度後每則約 NT${{ linePerPush }}）</span>
                  </div>
                  <el-slider v-model="pushesPerMonth" :max="200000" :step="1000" show-input />
                </div>
                <div class="sa-cost-est__row">
                  <div class="sa-cost-est__label">
                    <span class="sa-cost-est__name">每月營收（NT$）</span>
                    <span class="sa-cost-est__hint">刷卡總額 → 金流手續費（約 {{ feeRate }}%）</span>
                  </div>
                  <el-slider v-model="monthlyRevenue" :max="500000" :step="1000" show-input />
                </div>
                <div class="sa-cost-est__row">
                  <div class="sa-cost-est__label">
                    <span class="sa-cost-est__name">雲端固定月費</span>
                    <span class="sa-cost-est__hint">主機部署 ＋ 排程 ＋ 儲存基底（×2 系統，與訊息量無關）。小規模常在免費額度內 ≈ 0，看 AWS＋Firebase 帳單填</span>
                  </div>
                  <el-slider v-model="cloudFixed" :max="10000" :step="500" show-input />
                </div>
                <details class="sa-cost-est__adv">
                  <summary>進階：調整換算假設</summary>
                  <div class="sa-cost-est__advgrid">
                    <label>金流費率（%）<el-input-number v-model="feeRate" :min="0" :max="10" :step="0.05" :controls="false" size="small" /></label>
                    <label>LINE 每則（NT$）<el-input-number v-model="linePerPush" :min="0" :max="5" :step="0.1" :controls="false" size="small" /></label>
                    <label>資料保留月數<el-input-number v-model="retentionMonths" :min="1" :max="36" :step="1" :controls="false" size="small" /></label>
                  </div>
                </details>
              </div>
              <div class="sa-cost-est__out">
                <div class="sa-cost-est__outtitle">成本明細（每月估）</div>
                <div class="sa-cost-est__line"><span>資料庫＋主機＋儲存</span><b>{{ ntTwd(costMsgTotal) }}</b></div>
                <div class="sa-cost-est__line"><span>LINE 推播</span><b>{{ ntTwd(costLine) }}</b></div>
                <div class="sa-cost-est__line"><span>金流手續費</span><b>{{ ntTwd(costFee) }}</b></div>
                <div class="sa-cost-est__line"><span>雲端固定</span><b>{{ ntTwd(cloudFixed) }}</b></div>
                <div class="sa-cost-est__line sa-cost-est__line--sub"><span>外部估計小計</span><b>{{ ntTwd(extTotal) }}</b></div>
                <div class="sa-cost-est__line"><span>本頁 AI 成本（實算）</span><b>{{ ntd(totals.totalCostUsd) }}</b></div>
                <div class="sa-cost-est__grand">
                  <span>概估每月總花費</span><b>{{ ntTwd(grandTotal) }}</b>
                </div>
                <p class="sa-cost-est__foot">外部為依「用量參數 × 公開單價」推估（資料庫+主機每則約 NT$0.0025、儲存按保留月數累積、LINE 每則與金流費率見左），非帳單金額；實際以各平台帳單與合約為準。</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: 'AI 成本總覽 — 超級管理員' })

const { apiFetch } = useSuperAdmin()
const { showToast } = useAdminToast()

interface CostRow {
  id: string
  name: string
  organizationId: string | null
  aiEnabled: boolean
  invocations: number
  answered: number
  testInvocations: number
  conversationCostUsd: number
  buildCostUsd: number
  testCostUsd: number
  totalCostUsd: number
}
interface Totals {
  conversationCostUsd: number
  buildCostUsd: number
  testCostUsd: number
  totalCostUsd: number
  invocations: number
  answered: number
  testInvocations: number
  activeWorkspaces: number
}
interface CostsResponse {
  period: string
  prevPeriod: string
  totals: Totals
  prevTotalCostUsd: number
  workspaces: CostRow[]
}

const USD_TO_TWD = 32
function twd(usd: number) { return Math.round((usd || 0) * USD_TO_TWD) }
function ntd(usd: number) { return `NT$${twd(usd).toLocaleString('en-US')}` }
// 有一點點花費、但四捨五入後不到 NT$1 → 顯示「<NT$1」而非誤導的「NT$0」
function ntdSoft(usd: number) { return (usd > 0 && twd(usd) === 0) ? '<NT$1' : ntd(usd) }
// 已是台幣的金額（外部估算）直接格式化
function ntTwd(n: number) { return `NT$${Math.round(n || 0).toLocaleString('en-US')}` }

function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}

const loading = ref(false)
const period = ref(currentPeriod())
const workspaces = ref<CostRow[]>([])
const totals = ref<Totals>({ conversationCostUsd: 0, buildCostUsd: 0, testCostUsd: 0, totalCostUsd: 0, invocations: 0, answered: 0, testInvocations: 0, activeWorkspaces: 0 })
const prevTotalCostUsd = ref(0)

// 外部成本估算：拖「用量參數」用實際單價換算成本（NT$/月，what-if，不落地儲存）
// 單位成本沿用拆解頁的口徑（每則資料庫讀寫、主機請求、每則每月儲存）。
const DB_PER_MSG = (15 * 0.06 / 1e5 + 7 * 0.18 / 1e5) * USD_TO_TWD // 15 讀 7 寫
const HOST_PER_MSG = 0.0000556 * USD_TO_TWD // 主機請求（Amplify）
const STORE_PER_MSG_MONTH = (2 / 1e6) * 0.18 * USD_TO_TWD // 每則約 2KB × 儲存單價 / 月

const msgsPerMonth = ref(0) // 每月訊息則數（客人來訊 + AI 回覆）
const pushesPerMonth = ref(0) // 每月主動推播則數
const monthlyRevenue = ref(0) // 每月營收（NT$）
const cloudFixed = ref(0) // 雲端固定月費（主機基礎/排程/兩套系統）
const feeRate = ref(2.75) // 金流費率（%）
const linePerPush = ref(0.2) // LINE 每則（NT$，超過免費額度後）
const retentionMonths = ref(6) // 資料保留月數（180 天 ≈ 6）

// 訊息量 → 資料庫 + 主機 + 儲存（儲存按保留月數累積）
const costMsgTotal = computed(() =>
  msgsPerMonth.value * (DB_PER_MSG + HOST_PER_MSG)
  + msgsPerMonth.value * retentionMonths.value * STORE_PER_MSG_MONTH)
const costLine = computed(() => pushesPerMonth.value * (linePerPush.value || 0))
const costFee = computed(() => monthlyRevenue.value * (feeRate.value || 0) / 100)
const extTotal = computed(() => costMsgTotal.value + costLine.value + costFee.value + cloudFixed.value)
// 概估每月總花費 = 本頁 AI 成本（換台幣）+ 外部估計小計
const grandTotal = computed(() => twd(totals.value.totalCostUsd) + extTotal.value)

const periodLabel = computed(() => {
  const p = period.value || ''
  return p.length === 6 ? `${p.slice(0, 4)} 年 ${p.slice(4, 6)} 月` : p
})

// 以「四捨五入後的台幣」判定本月是否有實質花費（避免零頭造成有%沒金額）
const hasSpend = computed(() => twd(totals.value.totalCostUsd) >= 1)
const activeCount = computed(() => workspaces.value.filter(w => twd(w.totalCostUsd) >= 1).length)
const emptyText = computed(() =>
  totals.value.totalCostUsd > 0
    ? `${periodLabel.value} AI 花費不到 NT$1（可視為 0）`
    : `${periodLabel.value} 尚無 AI 花費`,
)

// 成本佔比（三桶相加＝總成本，用來畫比例條）
function pct(usd: number) {
  const t = totals.value.totalCostUsd
  return t > 0 ? Math.round((usd / t) * 100) : 0
}

// 較上月變化（%）；上月為 0 或無資料則不顯示，避免除以 0 或誤導
const deltaPct = computed(() => {
  const cur = totals.value.totalCostUsd
  const prev = prevTotalCostUsd.value
  if (!prev) return null
  return Math.round(((cur - prev) / prev) * 100)
})

async function load() {
  loading.value = true
  try {
    const res = await apiFetch<CostsResponse>(`/api/admin/super/costs?period=${period.value}`)
    workspaces.value = res.workspaces
    totals.value = res.totals
    prevTotalCostUsd.value = res.prevTotalCostUsd
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '讀取失敗', 'error')
  }
  finally {
    loading.value = false
  }
}
onMounted(load)
watch(period, load)
</script>
