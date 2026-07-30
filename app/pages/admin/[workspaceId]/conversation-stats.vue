<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="統計"
        title="客服對話統計"
        caption="依日期查看新增對話數、由誰先接手、轉真人與結案比例；下方趨勢圖可匯出 CSV。"
      />
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
          <!-- Hero（總會話）＋ 結果指標（轉真人 / 已結束）─────────────── -->
          <el-row :gutter="16" data-tour="cs-kpi">
            <el-col :xs="24" :md="12">
              <el-card shadow="hover" class="conv-stats-kpi-card conv-stats-hero">
                <div class="conv-stats-kpi-body">
                  <div class="stat-label">總新增會話</div>
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
            <el-col :xs="12" :md="6">
              <el-card
                shadow="hover"
                class="conv-stats-kpi-card conv-stats-kpi-card--handoff is-clickable"
                @click="drillTo('pending_human')"
              >
                <div class="conv-stats-kpi-body">
                  <el-tooltip content="曾經轉給真人的會話數；同一場轉多次只算一次。點擊查看待真人的對話。" placement="top">
                    <div class="stat-label">轉真人場數 <span class="conv-stats-info">ⓘ</span></div>
                  </el-tooltip>
                  <div class="stat-value">{{ kpi.handoffCount }}</div>
                  <div class="text-xs text-muted conv-stats-kpi-foot">佔 {{ pctNum(kpi.handoffRate) }}</div>
                </div>
              </el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card
                shadow="hover"
                class="conv-stats-kpi-card conv-stats-kpi-card--closed is-clickable"
                @click="drillTo('closed')"
              >
                <div class="conv-stats-kpi-body">
                  <el-tooltip content="已結束的會話。「佔已處理」= 在有被接手的會話裡已結案的比例（排除未首接）。點擊查看已結束的對話。" placement="top">
                    <div class="stat-label">已結束 <span class="conv-stats-info">ⓘ</span></div>
                  </el-tooltip>
                  <div class="stat-value">{{ kpi.closedCount }}</div>
                  <div class="text-xs text-muted conv-stats-kpi-foot">
                    佔總 {{ pctNum(kpi.closeRateByTotal) }}・佔已處理 {{ pctNum(kpi.closeRateByHandled) }}
                  </div>
                </div>
              </el-card>
            </el-col>
          </el-row>

          <!-- 首接類型堆疊長條 ───────────────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">首接類型</span>
                <span class="text-xs text-muted">這 {{ kpi.total }} 場對話，第一個接手的是誰？（點類別可查看對話）</span>
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
                  <el-table-column prop="bot" label="機器人首接" width="100" align="right" />
                  <el-table-column prop="ai" label="AI 首接" width="80" align="right" />
                  <el-table-column prop="human" label="真人首接" width="90" align="right" />
                  <el-table-column prop="unhandled" label="未首接" width="80" align="right" />
                  <el-table-column prop="handoff" label="轉真人" width="80" align="right" />
                  <el-table-column prop="closed" label="已結束" width="80" align="right" />
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

const dateRange = ref<[string, string] | null>(presetToRange(30))
// 快捷區間高亮：'7' | '30' | '90'；使用者自訂日期時設為 '' 表示不對應任何快捷鈕。
const rangePreset = ref('30')
const granularity = ref<TrendGranularity>('day')
const loading = ref(false)
const kpiLoading = ref(false)
const trendLoading = ref(false)

const kpi = ref<KpiResult>({
  total: 0, botHandled: 0, aiHandled: 0, humanHandled: 0, unhandled: 0,
  botEscalated: 0, aiEscalated: 0,
  handoffCount: 0, handoffRate: 0, closedCount: 0, handledCount: 0,
  closeRateByTotal: 0, closeRateByHandled: 0,
})
const prevTotal = ref<number | null>(null)
const trend = ref<{ buckets: TrendBucket[] }>({ buckets: [] })
const showDetail = ref(false)

const rangeLabel = computed(() => {
  if (dateRange.value?.[0] && dateRange.value?.[1]) return `${dateRange.value[0]} ~ ${dateRange.value[1]}`
  return '近 30 天'
})

// ── 首接類型分段（堆疊長條 + 圖例共用一份資料）────────────────
const firstContactSegs = computed(() => {
  const k = kpi.value
  return [
    { key: 'bot', label: '機器人', value: k.botHandled, escalated: k.botEscalated, cls: 'seg-bot', tab: 'bot_handling', help: '第一個回覆客人的是機器人罐頭回覆或流程。' },
    { key: 'ai', label: 'AI', value: k.aiHandled, escalated: k.aiEscalated, cls: 'seg-ai', tab: '', help: '第一個回覆客人的是 AI 客服（知識庫問答）。' },
    { key: 'human', label: '真人', value: k.humanHandled, escalated: 0, cls: 'seg-human', tab: 'human_handling', help: '第一個回覆客人的是真人客服（例如客人一進來就找真人，或真人直接接手還沒人回過的對話）。' },
    { key: 'unhandled', label: '未首接', value: k.unhandled, escalated: 0, cls: 'seg-unhandled', tab: 'open', help: '整場對話從頭到尾沒有機器人、AI 或真人接手回覆（例如只收到系統通知，或加了好友卻沒互動）。' },
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
type SeriesKey = 'total' | 'unhandled' | 'handoff' | 'closed'
const TREND_SERIES: { key: SeriesKey; label: string; color: string; area?: boolean }[] = [
  { key: 'total', label: '總會話', color: '#22c55e', area: true },
  { key: 'unhandled', label: '未首接', color: '#e8912d' },
  { key: 'handoff', label: '轉真人', color: '#9b59b6' },
  { key: 'closed', label: '已結束', color: '#909399' },
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
      axisLabel: { hideOverlap: true },
      axisTick: { alignWithLabel: true },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      // 頂部留 ~12% 餘量，避免峰值標點（pin）頂到邊被切掉
      max: (v: { max: number }) => Math.max(1, Math.ceil((v.max || 1) * 1.12)),
      splitLine: { lineStyle: { type: 'dashed' } },
    },
    series: TREND_SERIES.map(s => ({
      name: s.label,
      type: 'line',
      showSymbol: false,
      smooth: false,
      emphasis: { focus: 'series' },
      lineStyle: { width: s.area ? 2.4 : 1.6 },
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
  if (!r) { prevTotal.value = null; return }
  try {
    const data = await apiFetch<KpiResult>('/api/conversation-stats/kpi', {
      params: { startDate: r[0], endDate: r[1] },
    })
    prevTotal.value = data.total
  } catch (e) {
    console.error('[stats] prev kpi error:', e)
    prevTotal.value = null
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
  const header = '日期,總計,機器人首接,AI首接,真人首接,未首接,轉真人,已結束'
  const rows = trend.value.buckets.map(b =>
    `${b.date},${b.total},${b.bot},${b.ai},${b.human},${b.unhandled},${b.handoff},${b.closed}`,
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
