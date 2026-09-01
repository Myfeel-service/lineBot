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
              <div class="sa-pay-stat__hint">呼叫超過答出 {{ USAGE_RATIO_FLAG_THRESHOLD }} 倍才算</div>
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
              <el-table-column label="本月 AI 呼叫 → 答出" width="180" align="right">
                <template #default="{ row }">
                  <template v-if="row.usage.invocations || row.usage.answered">
                    <div class="sa-alerts-usage">{{ row.usage.invocations }} → {{ row.usage.answered }}</div>
                    <el-tag v-if="row.usage.flagged" type="warning" size="small">
                      {{ row.usage.ratio === null ? '都沒答出' : `是答出的 ${row.usage.ratio.toFixed(1)} 倍` }}
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
              其他 {{ healthyCount }} 個帳號檢查正常。高成本的標準：計費收在「答出」，呼叫多、答出少的帳號成本掛在我們身上——超過
              {{ USAGE_RATIO_FLAG_THRESHOLD }} 倍才標（正常約 2～2.5 倍；本月呼叫不足 {{ USAGE_RATIO_MIN_INVOCATIONS }} 次的小樣本不判）。標「(系統端)」的異常是我們這邊要處理的，店家動不了手。
            </p>
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
import type { SuperAlertsWorkspace } from '~~/shared/types/super-alerts'

definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '全站異常總覽' })

const { data, loading, error, checkedAt, refresh } = useSuperAlerts()

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
