<template>
  <div class="admin-panel-stack sa-alerts-page">
    <div class="message-card ar-section-card">
      <div class="message-card-header">
        <div>
          <h2 class="section-title">全站異常總覽</h2>
          <p class="sa-cost-note">
            每個帳號的異常訊號跟該帳號右下角的小幫手是同一份。這頁開頁現查、不靠排程——
            排程死掉時，靠排程發的 LINE 警報會跟著死，只有這裡看得到。
          </p>
        </div>
        <div class="admin-header-actions">
          <span v-if="checkedAtText" class="sa-alerts-checked">{{ checkedAtText }}</span>
          <el-button :loading="loading" @click="reload">重新檢查</el-button>
        </div>
      </div>

      <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon />

      <div v-if="data" class="sa-alert-hb" :class="`is-${data.heartbeat.state}`">
        <span class="sa-alert-hb__dot" />
        <div>
          <div class="sa-alert-hb__title">{{ hbTitle }}</div>
          <div class="sa-alert-hb__sub">{{ hbSub }}</div>
        </div>
      </div>

      <p v-if="summaryText" class="sa-alerts-summary">{{ summaryText }}</p>
      <p v-if="data?.truncated" class="sa-alerts-summary sa-alerts-summary--warn">
        ⚠️ 帳號數已達單次掃描上限，下表沒有涵蓋全部帳號。
      </p>
    </div>

    <div class="message-card ar-section-card">
      <h3 class="section-title">有狀況的帳號</h3>

      <el-table v-if="problemRows.length" :data="problemRows" size="small">
        <el-table-column label="帳號" min-width="150">
          <template #default="{ row }">
            <span class="sa-host-row__name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="正在影響客人" min-width="220">
          <template #default="{ row }">
            <template v-if="row.critical.length">
              <span v-for="c in row.critical" :key="c.text" class="sa-alert-chip sa-alert-chip--crit" :title="c.detail">{{ c.text }}</span>
            </template>
            <span v-else class="sa-alerts-none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="建議處理" min-width="200">
          <template #default="{ row }">
            <template v-if="row.advisory.length">
              <span v-for="c in row.advisory" :key="c.text" class="sa-alert-chip sa-alert-chip--warn" :title="c.detail">{{ c.text }}</span>
            </template>
            <span v-else class="sa-alerts-none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="查不到" width="90">
          <template #default="{ row }">
            <span v-if="row.unknownCount" class="sa-alerts-unknown">{{ row.unknownCount }} 項</span>
            <span v-else class="sa-alerts-none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="本月 AI 呼叫 → 答出" min-width="170">
          <template #default="{ row }">
            <div class="sa-alerts-usage">{{ row.usage.invocations }} → {{ row.usage.answered }}</div>
            <span v-if="row.usage.flagged" class="sa-alert-chip sa-alert-chip--flag">
              {{ row.usage.ratio === null ? '都沒答出，成本要看' : `呼叫是答出的 ${row.usage.ratio.toFixed(1)} 倍` }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else-if="data && !loading" class="sa-cost-empty">所有帳號檢查正常，沒有要處理的事。</div>
      <div v-else-if="loading && !data" class="sa-cost-empty">檢查中…（逐帳號跑異常檢查，第一次約需幾秒）</div>

      <p v-if="data" class="sa-cost-note">
        其他 {{ healthyCount }} 個帳號檢查正常。
        「呼叫是答出的 N 倍」怎麼看：計費收在「答出」，呼叫多、答出少的帳號成本掛在我們身上——
        超過 {{ USAGE_RATIO_FLAG_THRESHOLD }} 倍才標（正常帳號約 2～2.5 倍；本月呼叫不足 {{ USAGE_RATIO_MIN_INVOCATIONS }} 次的小樣本不判）。
        標了「(系統端)」的異常是我們這邊要處理的，店家動不了手。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ALERT_LABELS, ALERT_SEVERITY, SYSTEM_OWNED_ALERTS } from '~~/shared/types/alerts'
import { USAGE_RATIO_FLAG_THRESHOLD, USAGE_RATIO_MIN_INVOCATIONS } from '~~/shared/billing/usage-ratio'
import type { UsageRatioVerdict } from '~~/shared/billing/usage-ratio'
import type { SuperAlertsWorkspace } from '~~/shared/types/super-alerts'

definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '全站異常總覽' })

const { data, loading, error, checkedAt, refresh } = useSuperAlerts()

onMounted(() => { refresh() })
function reload() { refresh({ force: true }) }

const checkedAtText = computed(() => {
  if (!checkedAt.value) return ''
  const d = new Date(checkedAt.value)
  return `上次檢查 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

function ageText(minutes: number): string {
  return minutes >= 120 ? `${Math.round(minutes / 60)} 小時` : `${minutes} 分鐘`
}

const hbTitle = computed(() => {
  const s = data.value?.heartbeat.state
  if (s === 'ok') return '背景排程正常運作'
  if (s === 'stalled') return '背景排程停擺了'
  return '查不到排程心跳'
})

const hbSub = computed(() => {
  const hb = data.value?.heartbeat
  if (!hb) return ''
  if (hb.state === 'ok')
    return `上次自動維護約 ${ageText(hb.ageMinutes ?? 0)}前（正常每 10 分鐘一輪）。SLA 提醒、每日摘要、LINE 異常警報都靠它發。`
  if (hb.state === 'stalled')
    return `上次自動維護已是 ${ageText(hb.ageMinutes ?? 0)}前。SLA 提醒、每日摘要、LINE 異常警報現在都發不出去——先查 Cloud Scheduler 有沒有在打，再看主機。`
  return '心跳紀錄不存在——本機開發或這個環境還沒部署過排程，不下結論。'
})

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
    critical: active.filter(i => ALERT_SEVERITY[i.id] === 'critical').map(toChip),
    // 建議處理＝黃級＋「可以更好」一起列:超管視角都是要掃一眼的事,分兩欄只會更擠
    advisory: active.filter(i => ALERT_SEVERITY[i.id] !== 'critical').map(toChip),
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

const summaryText = computed(() => {
  const d = data.value
  if (!d) return ''
  const crit = rows.value.filter(r => r.critical.length).length
  const warn = rows.value.filter(r => r.advisory.length).length
  const flagged = rows.value.filter(r => r.usage.flagged).length
  const parts: string[] = []
  if (crit) parts.push(`${crit} 個帳號的客人正在受影響`)
  if (warn) parts.push(`${warn} 個帳號有建議處理的事`)
  if (flagged) parts.push(`${flagged} 個高成本帳號`)
  return parts.length
    ? `檢查了 ${d.workspaces.length} 個帳號：${parts.join('、')}。`
    : `檢查了 ${d.workspaces.length} 個帳號。`
})
</script>

<!-- 樣式在 app/assets/scss/pages/_super-admin.scss（依專案慣例不寫在 .vue 內） -->
