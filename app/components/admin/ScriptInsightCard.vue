<template>
  <!--
    `D-138`：打開一條就先看到它有沒有在幫忙——走進來幾次、走完幾次，沒走完的停在哪一題、為什麼、是誰。
    以前只有「N 個客人走進這條流程」（其實是次數），停在哪一題、為什麼都看不到。
    「停在哪」靠每次走進來的紀錄（`scripts/{id}/runs`），從這版上線那天才開始有；之前的只剩總數。
  -->
  <section class="message-card scripts-section-card scripts-insight">
    <div class="message-card-header">
      <div class="card-header-main">
        <span class="section-title">成效</span>
        <span v-if="summary?.sinceMs" class="text-xs text-muted">停在哪一題從 {{ sinceText }} 開始記</span>
      </div>
    </div>
    <div class="card-section-stack">
      <p v-if="!starts" class="scripts-insight__empty">還沒有客人走過這一條。</p>
      <div v-else-if="!asksQuestions" class="scripts-insight__total">
        <span class="scripts-insight__num">{{ starts }}</span><span>次接到客人</span>
      </div>
      <div v-else class="scripts-insight__total" :class="{ 'is-warn': rate < LOW_RATE }">
        <span class="scripts-insight__num">{{ rate }}%</span>
        <span>走到最後</span>
        <span class="scripts-insight__detail">走進來 {{ starts }} 次・走完 {{ completions }} 次</span>
      </div>

      <template v-if="asksQuestions && starts">
        <p v-if="loadState === 'failed'" class="scripts-insight__note">停在哪一題這次沒讀到，重新整理再看一次。</p>
        <p v-else-if="loadState === 'ready' && !summary?.runs" class="scripts-insight__note">之後有客人沒走完，這裡會列出停在哪一題、為什麼。</p>
        <div v-else-if="loadState === 'ready' && summary" class="scripts-insight__stops">
          <div class="scripts-insight__stops-title">沒走完的停在哪</div>
          <div v-for="row in stopRows" :key="row.nodeId" class="scripts-insight__row" :class="{ 'is-hot': row.people > 0 }">
            <span class="scripts-insight__q">{{ row.label }}</span>
            <span class="scripts-insight__count">{{ row.people }} 位</span>
            <span class="scripts-insight__why">{{ row.why }}</span>
            <button v-if="row.people" type="button" class="scripts-insight__toggle" :aria-expanded="openRow === row.nodeId" @click="openRow = openRow === row.nodeId ? null : row.nodeId">
              {{ openRow === row.nodeId ? '收起' : '看是誰' }}
            </button>
            <ul v-if="openRow === row.nodeId" class="scripts-insight__who">
              <li v-for="p in row.who" :key="p.userDocId">
                <NuxtLink :to="`/admin/${workspaceId}/conversations?userId=${encodeURIComponent(p.userDocId)}`">{{ p.displayName || '（沒有名字）' }}</NuxtLink>
                <span class="text-xs text-muted">{{ timeText(p.atMs) }}・{{ SCRIPT_STOP_REASON_LABELS[p.reason] }}</span>
              </li>
            </ul>
          </div>
          <p class="scripts-insight__note">
            <template v-if="summary.inProgress">{{ summary.inProgress }} 位正在回答。</template>
            <template v-if="summary.imageAnswers">有 {{ summary.imageAnswers }} 題是客人傳圖片回答的。</template>
            <template v-if="summary.truncated">只算最近 500 次。</template>
          </p>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  SCRIPT_STOP_REASON_LABELS,
  isRunSummaryMemoFresh,
  type ScriptRunSummary,
  type ScriptRunSummaryMemo,
  type ScriptStopReason,
} from '~~/shared/script-runs'

const props = defineProps<{
  scriptId: string
  starts: number
  completions: number
  /** 這條有沒有要客人回答的題目（一句話回一件事的只講次數） */
  asksQuestions: boolean
  /** 題目照順序：nodeId → 「第 1 題・訂單編號」（停在不是題目的步驟就用 fallback） */
  questionLabels: Array<{ nodeId: string; label: string }>
}>()

const { workspaceId, apiFetch } = useWorkspace()

/** 低於這個走完率就轉警示色（同改版前的「多數客人沒走完＝某一題卡住」那條線） */
const LOW_RATE = 60

const rate = computed(() => (props.starts ? Math.round((props.completions / props.starts) * 100) : 0))

const summary = ref<ScriptRunSummary | null>(null)
const loadState = ref<'loading' | 'ready' | 'failed'>('loading')
const openRow = ref<string | null>(null)

/**
 * 讀過的成效記著（`C-379`）：每讀一次是最多 501 筆資料庫讀取，切來切去不重讀（規則見 isRunSummaryMemoFresh）。
 * 記在 useState：切換時這張卡整個重建（頁面掛了 `:key`），記在元件裡等於沒記。
 */
const memo = useState<Record<string, ScriptRunSummaryMemo>>('script-insight-memo', () => ({}))

async function load(force = false) {
  summary.value = null
  openRow.value = null
  if (!props.asksQuestions || !props.starts) return
  const key = `${workspaceId.value}/${props.scriptId}`
  const { starts, completions } = props
  const kept = memo.value[key]
  if (!force && isRunSummaryMemoFresh(kept, starts, completions, Date.now())) {
    summary.value = kept.summary
    loadState.value = 'ready'
    return
  }
  loadState.value = 'loading'
  try {
    summary.value = await apiFetch<ScriptRunSummary>(`/api/ai/scripts/list?runsOf=${encodeURIComponent(props.scriptId)}`)
    memo.value[key] = { starts, completions, atMs: Date.now(), summary: summary.value }
    loadState.value = 'ready'
  }
  catch {
    // 查不到就明講沒查到，不要靜靜當作「大家都走完了」
    loadState.value = 'failed'
  }
}
watch(() => [props.scriptId, props.starts, props.completions], () => load(), { immediate: true })
defineExpose({ reload: () => load(true) })

function mdHm(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const sinceText = computed(() => {
  const ms = summary.value?.sinceMs
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
})
function timeText(ms: number) { return mdHm(ms) }

/** 每一題一列（沒人停的也列，看得出卡在哪一題），題目以外的步驟排最後 */
const stopRows = computed(() => {
  const stops = summary.value?.stops ?? []
  const byNode = new Map(stops.map(s => [s.nodeId, s]))
  const rows = props.questionLabels.map(q => ({ nodeId: q.nodeId, label: q.label, stop: byNode.get(q.nodeId) }))
  for (const s of stops) {
    if (!props.questionLabels.some(q => q.nodeId === s.nodeId)) rows.push({ nodeId: s.nodeId, label: '（已刪掉或改過的步驟）', stop: s })
  }
  return rows.map(r => ({
    nodeId: r.nodeId,
    label: r.label,
    people: r.stop?.people ?? 0,
    who: r.stop?.who ?? [],
    why: r.stop ? whyText(r.stop.reasons) : '',
  }))
})

function whyText(reasons: Partial<Record<ScriptStopReason, number>>): string {
  return (Object.entries(reasons) as Array<[ScriptStopReason, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${SCRIPT_STOP_REASON_LABELS[k]} ${n}`)
    .join('・')
}
</script>
