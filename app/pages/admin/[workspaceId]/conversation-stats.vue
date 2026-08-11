<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <!-- 副標用問句講這一頁回答什麼（2026-08-07 拍板）；單位一律「場」，與昨日摘要卡一致。
           ⛔ 姊妹頁的連結別再標「（數「則」）」：2026-08-10 AI 表現頁主指標也改成「場」了，
           兩頁現在同一把尺（那正是改場制的目的）。留著舊對照＝教一個已經不存在的差異。
           兩頁的差別在**問題**不在單位，所以連結只講問題。 -->
      <AdminSoloPageHeading
        field-label="統計"
        title="客服對話統計"
        caption="客人來了多少、誰接住的——這裡數的是「場」（一位客人 24 小時內的一段來回算一場）。"
      >
        <template #caption>
          想看 AI 自己搞定多少、還有什麼要補？<NuxtLink :to="`/admin/${route.params.workspaceId}/ai-usage`" class="admin-inline-link">看 AI 表現 →</NuxtLink>
        </template>
      </AdminSoloPageHeading>
      <div class="conv-stats-header-actions admin-header-actions" data-tour="cs-filter">
        <div class="conv-stats-filter-row">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="開始日期"
            end-placeholder="結束日期"
            value-format="YYYY-MM-DD"
            size="small"
            @change="onRangeChange"
          />
          <el-tooltip content="重新整理" placement="top">
            <el-button size="small" :icon="Refresh" circle :loading="loading" aria-label="重新整理" @click="loadAll" />
          </el-tooltip>
        </div>
        <div class="conv-stats-filter-row">
          <el-radio-group v-model="rangePreset" size="small" @change="onPresetChange">
            <el-radio-button value="7">近 7 天</el-radio-button>
            <el-radio-button value="30">近 30 天</el-radio-button>
            <el-radio-button value="90">近 90 天</el-radio-button>
          </el-radio-group>
          <el-button size="small" type="primary" plain :icon="Download" :disabled="!trend.buckets.length" @click="exportCsv">匯出 CSV</el-button>
        </div>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack conv-stats-page">
        <div v-if="kpiLoading" class="tags-loading">
          <div class="spinner" />
          <span>載入中…</span>
        </div>

        <template v-else>
          <!-- Hero（新增對話）＋ 新加好友 ＋ 結果指標（轉真人 / 已結束）─────────────── -->
          <el-row :gutter="16" data-tour="cs-kpi">
            <el-col :xs="24" :md="12">
              <el-card shadow="hover" class="conv-stats-kpi-card conv-stats-hero">
                <div class="conv-stats-kpi-body">
                  <div class="stat-label">新增對話</div>
                  <div class="conv-stats-hero-row">
                    <span class="stat-value conv-stats-hero-value">{{ kpi.total }}</span>
                    <el-tooltip v-if="deltaLabel" content="跟前一段同樣長度的期間相比，對話數增加或減少" placement="top">
                      <span class="conv-stats-delta" :class="deltaClass">{{ deltaLabel }}</span>
                    </el-tooltip>
                  </div>
                  <div class="text-xs text-muted conv-stats-kpi-foot">
                    {{ rangeLabel }}<template v-if="prevTotal !== null">・較上期 {{ prevTotal }}</template>
                  </div>
                </div>
              </el-card>
            </el-col>
            <!-- 手機一排三張（xs=8）：三張的第二行都刻意保持短（較上期 N／佔 N%／有人接的裡面 N%），
                 否則 116px 寬會折成三行、三張卡高度不齊 -->
            <el-col :xs="8" :md="4">
              <el-card shadow="hover" class="conv-stats-kpi-card">
                <div class="conv-stats-kpi-body">
                  <el-tooltip content="這段期間第一次加好友的人數。加了好友還沒開口的人不算進「新增對話」——沒有來回就還不是對話。" placement="top">
                    <div class="stat-label">新加好友 <span class="conv-stats-info">ⓘ</span></div>
                  </el-tooltip>
                  <div class="stat-value">{{ kpi.newFriends < 0 ? '—' : kpi.newFriends }}</div>
                  <!-- 第二行給「較上期」而不是重複標題的廢話（原本寫「第一次加好友」＝0 資訊） -->
                  <div class="text-xs text-muted conv-stats-kpi-foot">
                    <template v-if="kpi.newFriends < 0">這次查不到</template>
                    <template v-else-if="prevNewFriends !== null">較上期 {{ prevNewFriends }}</template>
                  </div>
                </div>
              </el-card>
            </el-col>
            <el-col :xs="8" :md="4">
              <el-card
                shadow="hover"
                class="conv-stats-kpi-card conv-stats-kpi-card--handoff is-clickable"
                @click="drillTo('pending_human')"
              >
                <div class="conv-stats-kpi-body">
                  <el-tooltip content="曾經轉給真人的對話數；同一場轉多次只算一次。點擊查看待真人的對話。" placement="top">
                    <div class="stat-label">轉真人 <span class="conv-stats-info">ⓘ</span></div>
                  </el-tooltip>
                  <div class="stat-value">{{ kpi.handoffCount }}</div>
                  <div class="text-xs text-muted conv-stats-kpi-foot">佔 {{ pctNum(kpi.handoffRate) }}</div>
                </div>
              </el-card>
            </el-col>
            <el-col :xs="8" :md="4">
              <el-card
                shadow="hover"
                class="conv-stats-kpi-card conv-stats-kpi-card--closed is-clickable"
                @click="drillTo('closed')"
              >
                <div class="conv-stats-kpi-body">
                  <!-- 兩個分母不同的比率並排是這一頁最難懂的一行（也讓手機上這張卡折成三行）。
                       主顯示只留「有人接的裡面收尾了幾成」，另一個進 tooltip。 -->
                  <el-tooltip
                    :content="`已結束的對話 ${kpi.closedCount} 場。「有人接的裡面」= 排除沒人回的那些（${kpi.handledCount} 場）算出來的收尾比例；若以全部 ${kpi.total} 場為分母則是 ${pctNum(kpi.closeRateByTotal)}。點擊查看已結束的對話。`"
                    placement="top"
                  >
                    <div class="stat-label">已結束 <span class="conv-stats-info">ⓘ</span></div>
                  </el-tooltip>
                  <div class="stat-value">{{ kpi.closedCount }}</div>
                  <div class="text-xs text-muted conv-stats-kpi-foot">
                    有人接的裡面 {{ pctNum(kpi.closeRateByHandled) }}
                  </div>
                </div>
              </el-card>
            </el-col>
          </el-row>

          <!-- 首接類型堆疊長條 ───────────────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">第一句話是誰回的</span>
                <span class="text-xs text-muted">這 {{ kpi.total }} 場對話，第一句話是誰回的？（點類別可查看對話）</span>
              </div>
            </div>
            <div class="card-section-stack">
              <div v-if="kpi.total > 0" class="conv-seg-bar">
                <el-tooltip
                  v-for="seg in visibleSegs"
                  :key="seg.key"
                  :content="`${seg.label} ${seg.value}（${pct(seg.value, kpi.total)}）`"
                  placement="top"
                >
                  <div
                    class="conv-seg"
                    :class="[seg.cls, { 'is-clickable': !!seg.tab }]"
                    :style="{ width: (seg.value / kpi.total * 100) + '%' }"
                    @click="seg.tab && drillTo(seg.tab)"
                  />
                </el-tooltip>
              </div>
              <div v-else class="conv-seg-bar conv-seg-bar--empty" />

              <div class="conv-seg-legend">
                <el-tooltip v-for="seg in firstContactSegs" :key="seg.key" :content="seg.help" placement="top">
                  <button
                    type="button"
                    class="conv-seg-legend-item"
                    :class="{ 'is-clickable': !!seg.tab }"
                    @click="seg.tab && drillTo(seg.tab)"
                  >
                    <span class="conv-seg-dot" :class="seg.cls" />
                    <span class="conv-seg-legend-label">{{ seg.label }}</span>
                    <span class="conv-seg-legend-num">{{ seg.value }}</span>
                    <span class="conv-seg-legend-pct">{{ pct(seg.value, kpi.total) }}</span>
                    <span v-if="seg.escalated" class="conv-seg-legend-esc">其中後來轉真人 {{ seg.escalated }}</span>
                  </button>
                </el-tooltip>
              </div>
            </div>
          </div>
        </template>

        <!-- 趨勢：折線圖 ＋ 可展開明細表 ───────────────────────── -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">趨勢</span>
              <span class="text-xs text-muted">各期新增對話數與組成（點下方圖例可開關線條）</span>
            </div>
            <el-select
              v-model="granularity"
              class="conv-stats-granularity"
              size="small"
              @change="loadTrend"
            >
              <el-option label="日" value="day" />
              <el-option label="週" value="week" />
              <el-option label="月" value="month" />
            </el-select>
          </div>
          <div class="card-section-stack">
            <div v-if="trendLoading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <template v-else-if="trend.buckets.length">
              <ClientOnly>
                <VChart class="conv-echart" :option="chartOption" autoresize />
                <template #fallback>
                  <div class="conv-echart-fallback">
                    <div class="spinner" />
                    <span>圖表載入中…</span>
                  </div>
                </template>
              </ClientOnly>

              <div class="conv-trend-detail">
                <button
                  type="button"
                  class="conv-detail-toggle"
                  :class="{ 'is-open': showDetail }"
                  @click="showDetail = !showDetail"
                >
                  <span class="conv-detail-chevron" aria-hidden="true" />
                  {{ showDetail ? '收合每期明細' : `展開每期明細（${trend.buckets.length} 列）` }}
                </button>
                <el-table v-if="showDetail" :data="trend.buckets" size="small" stripe class="conv-detail-table">
                  <el-table-column prop="date" label="日期" min-width="110" />
                  <el-table-column prop="total" label="總計" width="70" align="right" />
                  <el-table-column prop="bot" label="機器人先回" width="100" align="right" />
                  <el-table-column prop="ai" label="AI 先回" width="80" align="right" />
                  <el-table-column prop="human" label="客服先回" width="90" align="right" />
                  <el-table-column prop="unhandled" label="沒人回" width="80" align="right" />
                  <el-table-column prop="handoff" label="轉真人" width="80" align="right" />
                  <el-table-column prop="closed" label="已結束" width="80" align="right" />
                  <el-table-column label="新朋友" width="80" align="right">
                    <!-- 查失敗整批缺欄（見 trend.get.ts）→ 顯示 —,不裝 0 -->
                    <template #default="{ row }">{{ row.newFriends ?? '—' }}</template>
                  </el-table-column>
                </el-table>
              </div>
            </template>
            <div v-else class="tags-empty conv-stats-empty">
              <span>此區間無資料</span>
              <el-button size="small" @click="widenRange">放寬到近 90 天</el-button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { Download, Refresh } from '@element-plus/icons-vue'
import type { KpiResult, TrendGranularity, TrendBucket } from '~~/shared/types/conversation-stats'
import { useAdminToast } from '~~/app/composables/useAdminToast'

definePageMeta({ middleware: 'auth', layout: 'default' })

useHead({
  title: useAdminTitle('對話統計'),
})

const { showToast } = useAdminToast()
const { apiFetch } = useWorkspace()
const route = useRoute()

function fmtDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// 近 N 天（含今天）。預設近 30 天：讓 KPI 與趨勢吃同一段區間，避免「KPI 有數字、趨勢無資料」，
// 也讓使用者一進頁面就知道現在看的是哪段時間（不再是兩個空白日期欄）。
function presetToRange(days: number): [string, string] {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - (days - 1))
  return [fmtDate(start), fmtDate(end)]
}

/**
 * 從網址帶進來的區間（`?startDate=&endDate=`）——小幫手昨日摘要的「看完整統計」會帶。
 * 沒帶或格式不對就退回預設近 30 天。
 * 這條在的意義：日報講「昨天 16 場」，點進來要看到同一天，
 * 否則使用者第一眼就是一組對不上的數字（見 goStats 的註解）。
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
function rangeFromQuery(): [string, string] | null {
  const s = String(route.query.startDate ?? '')
  const e = String(route.query.endDate ?? '')
  return DAY_RE.test(s) && DAY_RE.test(e) ? [s, e] : null
}

const queryRange = rangeFromQuery()
const dateRange = ref<[string, string] | null>(queryRange ?? presetToRange(30))
// 快捷區間高亮：'7' | '30' | '90'；使用者自訂日期（或網址帶進來）時設為 '' 表示不對應任何快捷鈕。
const rangePreset = ref(queryRange ? '' : '30')
const granularity = ref<TrendGranularity>('day')
const loading = ref(false)
const kpiLoading = ref(false)
const trendLoading = ref(false)

const kpi = ref<KpiResult>({
  total: 0, botHandled: 0, aiHandled: 0, humanHandled: 0, unhandled: 0,
  botEscalated: 0, aiEscalated: 0,
  handoffCount: 0, handoffRate: 0, closedCount: 0, handledCount: 0,
  closeRateByTotal: 0, closeRateByHandled: 0, newFriends: 0, unhandledSamples: [],
  handoffWaitExceeded: 0, handoffWaitSlaMinutes: 30, handoffWaitOffHours: 0, handoffWaitSamples: [],
})
const prevTotal = ref<number | null>(null)
/** 上一期的新加好友（同一支 prev KPI 查詢就有，不必多打一次） */
const prevNewFriends = ref<number | null>(null)
const trend = ref<{ buckets: TrendBucket[] }>({ buckets: [] })
const showDetail = ref(false)

const rangeLabel = computed(() => {
  if (dateRange.value?.[0] && dateRange.value?.[1]) return `${dateRange.value[0]} ~ ${dateRange.value[1]}`
  return '近 30 天'
})

// ── 「第一句話是誰回的」分段（堆疊長條 + 圖例共用一份資料）────────────────
// 名詞 2026-08-07 拍板統一：介面不再講「首接／未首接」，跟昨日摘要卡同一套話
// （第一句話是誰回的／沒人回／客服）。資料欄位 initialHandler 不動。
const firstContactSegs = computed(() => {
  const k = kpi.value
  return [
    { key: 'bot', label: '機器人', value: k.botHandled, escalated: k.botEscalated, cls: 'seg-bot', tab: 'bot_handling', help: '第一個回覆客人的是機器人罐頭回覆或流程。' },
    { key: 'ai', label: 'AI', value: k.aiHandled, escalated: k.aiEscalated, cls: 'seg-ai', tab: '', help: '第一個回覆客人的是 AI 客服（知識庫問答）。' },
    { key: 'human', label: '客服', value: k.humanHandled, escalated: 0, cls: 'seg-human', tab: 'human_handling', help: '第一個回覆客人的是真人客服（例如客人一進來就找真人，或真人直接接手還沒人回過的對話）。' },
    // tab 刻意留空（不可點）：收件匣的「待處理」問的是「還需不需要人處理」，
    // 這裡的「沒人回」問的是「有沒有人回答過」——兩邊是不同的一群對話，
    // 接過去只會看到不一樣的數字。口徑見 docs/CONVERSATION-STATS-DEFINITIONS.md
    { key: 'unhandled', label: '沒人回', value: k.unhandled, escalated: 0, cls: 'seg-unhandled', tab: '', help: '整場對話從頭到尾沒有機器人、AI 或真人回覆過（例如只收到系統通知）。這是回顧指標，跟收件匣的「待處理」不是同一群對話——那邊看的是現在還需要人處理的。' },
  ]
})
const visibleSegs = computed(() => firstContactSegs.value.filter(s => s.value > 0))

// ── 較上期：抹一段等長的上一區間，只比總會話 ──────────────────
function prevRange(): [string, string] | null {
  if (!dateRange.value?.[0] || !dateRange.value?.[1]) return null
  const start = new Date(dateRange.value[0])
  const end = new Date(dateRange.value[1])
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  const prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1)
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - (days - 1))
  return [fmtDate(prevStart), fmtDate(prevEnd)]
}
const deltaPct = computed(() => {
  if (prevTotal.value === null || prevTotal.value === 0) return null
  return (kpi.value.total - prevTotal.value) / prevTotal.value
})
const deltaLabel = computed(() => {
  const v = deltaPct.value
  if (v === null) return ''
  const arrow = v > 0 ? '↑' : v < 0 ? '↓' : ''
  return `${arrow} ${Math.abs(v * 100).toFixed(0)}%`
})
const deltaClass = computed(() => {
  const v = deltaPct.value
  if (v === null || v === 0) return 'is-flat'
  return v > 0 ? 'is-up' : 'is-down'
})

// ── 趨勢折線圖：ECharts option（Y 軸刻度、內建 tooltip、圖例點擊開關、峰值標點）──
// total 畫成面積當「量」的輪廓，其餘畫成線呈現組成/結果。series 順序對齊 color 陣列。
/**
 * 趨勢線。
 *
 * 配色規則（踩過的坑）：這一頁有兩套色彩語彙——上面分段條是「分類」（機器人綠 #16a34a／
 * AI 藍 #2563eb／客服紫 #9333ea／沒人回橘 #e8912d），這裡是「量的時間序」。
 * 兩套可以不同，但**不可以同色不同義**：原本「總對話」用 #22c55e，跟分段條的機器人綠
 * 幾乎同色卻是完全不同的意思，同一頁上下兩塊互相干擾。總對話是量的輪廓、不是分類，
 * 改用中性板岩灰；「沒人回」則刻意與分段條**同色同義**。
 *
 * `axis: 'right'`＝掛第二 Y 軸。新朋友與對話數量級差很多（實測 8/6：43 位好友 vs 16 場對話，
 * 活動日可能 500 vs 20），共用一軸會讓「沒人回／轉真人」被壓到貼底完全看不出變化。
 * 右軸那條額外畫**虛線**：不同刻度的線放同一張圖，最怕的是被拿去比高低，
 * 虛線 ＋ 圖例標「（右軸）」兩道提示，讀者才不會把它當同一把尺。
 */
type SeriesKey = 'total' | 'unhandled' | 'handoff' | 'closed' | 'newFriends'
const TREND_SERIES: { key: SeriesKey; label: string; color: string; area?: boolean; axis?: 'right' }[] = [
  { key: 'total', label: '總對話', color: '#64748b', area: true },
  { key: 'unhandled', label: '沒人回', color: '#e8912d' },
  { key: 'handoff', label: '轉真人', color: '#9b59b6' },
  // 中階灰：比總對話淺一階可區分，但別再更淺——#cbd5e1 會和總對話的面積填色混在一起看不見
  { key: 'closed', label: '已結束', color: '#94a3b8' },
  // 標「（右軸）」不是囉唆——不寫的話讀者會拿兩條不同刻度的線比高低，那才是真的誤導
  { key: 'newFriends', label: '新朋友（右軸）', color: '#0ea5e9', axis: 'right' },
]

const chartOption = computed(() => {
  const bs = trend.value.buckets
  return {
    color: TREND_SERIES.map(s => s.color),
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    legend: {
      bottom: 0,
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 8,
      data: TREND_SERIES.map(s => s.label),
    },
    grid: { left: 8, right: 16, top: 28, bottom: 40, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: bs.map(b => b.date),
      /**
       * 日／週刻度縮寫成 `8/1`：
       * 1. `boundaryGap:false` 時第一個標籤會有一半突出格線左緣，`containLabel` 不管這段，
       *    完整的 `2026-08-01` 會被容器裁掉一個字（實測長這樣：`026-08-01`）。
       * 2. 七個「2026-08-0x」除了雜訊沒給任何資訊——同一段區間年月本來就一樣。
       * 月刻度保留 `YYYY-MM`（跨年時年份才是資訊）。
       */
      axisLabel: {
        hideOverlap: true,
        formatter: (v: string) => {
          if (granularity.value === 'month')
            return v
          const [, m, d] = v.split('-')
          return m && d ? `${Number(m)}/${Number(d)}` : v
        },
      },
      axisTick: { alignWithLabel: true },
    },
    yAxis: [
      {
        type: 'value',
        name: '對話',
        nameTextStyle: { fontSize: 10, color: '#94a3b8', align: 'left' },
        minInterval: 1,
        // 頂部留 ~12% 餘量，避免峰值標點（pin）頂到邊被切掉
        max: (v: { max: number }) => Math.max(1, Math.ceil((v.max || 1) * 1.12)),
        splitLine: { lineStyle: { type: 'dashed' } },
      },
      {
        // 右軸只給新朋友。不畫格線：兩套虛線格線疊在一起會讓人分不清哪條刻度屬於哪軸
        type: 'value',
        name: '新朋友',
        nameTextStyle: { fontSize: 10, color: '#0ea5e9', align: 'right' },
        minInterval: 1,
        max: (v: { max: number }) => Math.max(1, Math.ceil((v.max || 1) * 1.12)),
        splitLine: { show: false },
        axisLabel: { color: '#0ea5e9' },
      },
    ],
    series: TREND_SERIES.map(s => ({
      name: s.label,
      type: 'line',
      yAxisIndex: s.axis === 'right' ? 1 : 0,
      showSymbol: false,
      smooth: false,
      emphasis: { focus: 'series' },
      lineStyle: { width: s.area ? 2.4 : 1.6, type: s.axis === 'right' ? 'dashed' : 'solid' },
      areaStyle: s.area ? { opacity: 0.13 } : undefined,
      markPoint: s.key === 'total'
        ? {
            symbol: 'pin',
            symbolSize: 46,
            label: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
            data: [{ type: 'max', name: '峰值' }],
          }
        : undefined,
      data: bs.map(b => b[s.key]),
    })),
  }
})

function buildQuery() {
  const params: Record<string, string> = {}
  if (dateRange.value?.[0]) params.startDate = dateRange.value[0]
  if (dateRange.value?.[1]) params.endDate = dateRange.value[1]
  return params
}

function pct(part: number, total: number) {
  if (!total) return '0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function pctNum(rate: number) {
  return `${(rate * 100).toFixed(1)}%`
}

// 下鑽：跳到「對話」頁並帶上最接近的狀態分頁。
// 註：統計是「日期區間 + 首接類型」的分析數字，對話頁分頁是「目前的狀態」清單，
// 兩者口徑不同，數字不會完全相等——這裡只是導覽到相關會話。
function drillTo(tab: string) {
  const wid = String(route.params.workspaceId || '')
  if (!wid || !tab) return
  navigateTo({ path: `/admin/${wid}/conversations`, query: { tab } })
}

function onPresetChange(val: string | number | boolean | undefined) {
  dateRange.value = presetToRange(Number(val))
  loadAll()
}

function onRangeChange() {
  rangePreset.value = '' // 自訂日期 → 取消快捷高亮
  loadAll()
}

function widenRange() {
  rangePreset.value = '90'
  dateRange.value = presetToRange(90)
  loadAll()
}

async function loadKpi() {
  kpiLoading.value = true
  try {
    const data = await apiFetch<KpiResult>('/api/conversation-stats/kpi', {
      params: buildQuery(),
    })
    kpi.value = data
  } catch (e) {
    console.error('[stats] kpi error:', e)
    showToast('載入 KPI 失敗', 'error')
  } finally {
    kpiLoading.value = false
  }
}

async function loadPrevKpi() {
  const r = prevRange()
  if (!r) { prevTotal.value = null; prevNewFriends.value = null; return }
  try {
    const data = await apiFetch<KpiResult>('/api/conversation-stats/kpi', {
      params: { startDate: r[0], endDate: r[1] },
    })
    prevTotal.value = data.total
    // 查不到（-1）不當成 0：那會變成「較上期 0」在說謊
    prevNewFriends.value = data.newFriends >= 0 ? data.newFriends : null
  } catch (e) {
    console.error('[stats] prev kpi error:', e)
    prevTotal.value = null
    prevNewFriends.value = null
  }
}

async function loadTrend() {
  trendLoading.value = true
  try {
    const data = await apiFetch<{ buckets: TrendBucket[] }>('/api/conversation-stats/trend', {
      params: { ...buildQuery(), granularity: granularity.value },
    })
    trend.value = data
  } catch (e) {
    console.error('[stats] trend error:', e)
    showToast('載入趨勢失敗', 'error')
  } finally {
    trendLoading.value = false
  }
}

async function loadAll() {
  loading.value = true
  await Promise.all([loadKpi(), loadPrevKpi(), loadTrend()])
  loading.value = false
}

function exportCsv() {
  if (!trend.value.buckets.length) return
  const header = '日期,總計,機器人先回,AI先回,客服先回,沒人回,轉真人,已結束,新朋友'
  // 新朋友查失敗時整批缺欄（見 trend.get.ts）→ CSV 留空格,不填 0 假裝查到了
  const rows = trend.value.buckets.map(b =>
    `${b.date},${b.total},${b.bot},${b.ai},${b.human},${b.unhandled},${b.handoff},${b.closed},${b.newFriends ?? ''}`,
  )
  const csv = [header, ...rows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `conversation-stats-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(loadAll)
</script>
