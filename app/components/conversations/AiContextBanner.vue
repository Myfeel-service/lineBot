<template>
  <div v-if="ctx?.hasMeta" class="conv-ai-banner" :class="bannerClass">
    <div class="conv-ai-banner-header" @click="expanded = !expanded">
      <span class="conv-ai-banner-badge"><el-icon v-if="decisionIcon"><component :is="decisionIcon" /></el-icon> AI 脈絡</span>
      <span class="conv-ai-banner-summary">
        {{ summaryText }}
      </span>
      <span class="conv-ai-banner-time">{{ updatedAtLabel }}</span>
      <span class="conv-ai-banner-toggle">{{ expanded ? '▴' : '▾' }}</span>
    </div>

    <div v-if="expanded" class="conv-ai-banner-body">
      <div v-if="ctx.handoffSummary" class="conv-ai-row conv-ai-row--block">
        <span class="conv-ai-row__label">對話摘要</span>
        <div class="conv-ai-draft">{{ ctx.handoffSummary }}</div>
      </div>

      <div v-if="ctx.lastQuery" class="conv-ai-row">
        <span class="conv-ai-row__label">客人提問</span>
        <span class="conv-ai-row__value">{{ ctx.lastQuery }}</span>
      </div>

      <div class="conv-ai-row">
        <span class="conv-ai-row__label">把握度</span>
        <span class="conv-ai-row__value">
          <strong>{{ confidenceLabel(ctx.lastConfidence) }}</strong>
          <span class="conv-ai-confidence-raw">（{{ ctx.lastConfidence.toFixed(2) }}）</span>
          <span v-if="ctx.lastHandoffReason" class="conv-ai-tag conv-ai-tag--warn">
            {{ handoffLabel }}
          </span>
        </span>
      </div>

      <div v-if="ctx.sources.length" class="conv-ai-row conv-ai-row--block">
        <span class="conv-ai-row__label">命中知識（top {{ ctx.sources.length }}）</span>
        <ul class="conv-ai-source-list">
          <li v-for="src in ctx.sources" :key="src.chunkId">{{ src.title }}</li>
        </ul>
      </div>

      <div v-if="ctx.suggestedReply" class="conv-ai-row conv-ai-row--block">
        <span class="conv-ai-row__label">AI 建議回覆</span>
        <div class="conv-ai-draft">{{ ctx.suggestedReply }}</div>
        <el-button size="small" type="primary" plain @click="applyDraft(ctx.suggestedReply)">
          填入回覆框
        </el-button>
      </div>

      <!-- 「沒命中知識卡」有兩種意思,不能混為一談(見 knowledgeGap / noLookupText) -->
      <div v-if="knowledgeGap" class="conv-ai-empty">
        <span>知識庫沒有相關資訊，AI 這題答不出來。把答案補進知識庫，下次遇到就會回答了。</span>
        <el-button size="small" type="primary" plain @click="$emit('add-knowledge', ctx.lastQuery)">
          補知識
        </el-button>
      </div>

      <div v-else-if="noLookupText" class="conv-ai-note">{{ noLookupText }}</div>

      <!-- 「AI 自信地答錯」只有人看得出來:一鍵標記,訊號進知識缺口分析(帶當時命中的卡)。
           招呼語／越界拒答不顯示:那些不是知識問題,標了只會把雜訊灌進缺口聚類。 -->
      <div v-if="canMarkWrong" class="conv-ai-actions">
        <el-button
          size="small"
          text
          :type="wrongMarked ? 'info' : 'danger'"
          :loading="marking"
          @click="wrongMarked ? unmarkWrong() : markWrong()"
        >
          {{ wrongMarked ? '已標記答錯（點一下取消）' : '這題 AI 答錯了' }}
        </el-button>
        <span class="conv-ai-actions__hint">同類問題累積後，系統會在知識庫幫你擬一條</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChatDotRound, CircleCheck, Clock, QuestionFilled, User } from '@element-plus/icons-vue'
import {
  HANDOFF_REASON_LABELS,
  isKnowledgeGapContext,
  type AiAnswerKind,
  type HandoffReason,
  type AiDecision,
} from '~~/shared/types/ai-knowledge'
import { useAdminToast } from '~~/app/composables/useAdminToast'

interface AiContextResponse {
  hasMeta: boolean
  lastDecision: AiDecision | ''
  lastConfidence: number
  lastHandoffReason: HandoffReason | null
  lastQuery: string
  lastAnswerKind: AiAnswerKind
  suggestedReply: string
  handoffSummary: string
  sources: Array<{ chunkId: string; title: string }>
  wrongMarked: boolean
  updatedAtMs: number
}

const props = defineProps<{
  userId: string | null
  /** 父元件 conversations 列表變更時要 trigger 重抓 */
  refreshKey?: number | string
  apiFetch: <T = unknown>(url: string, opts?: Record<string, unknown>) => Promise<T>
}>()

const emit = defineEmits<{
  (e: 'apply-draft', text: string): void
  (e: 'add-knowledge', query: string): void
}>()

const { showToast } = useAdminToast()

const ctx = ref<AiContextResponse | null>(null)
const expanded = ref(true)

const decisionIcon = computed(() => {
  if (!ctx.value?.hasMeta) return null
  if (ctx.value.lastDecision === 'answered') return CircleCheck
  if (ctx.value.lastDecision === 'handoff') return User
  if (ctx.value.lastDecision === 'handoff_confirm') return ChatDotRound
  if (ctx.value.lastDecision === 'disambiguate') return QuestionFilled
  return Clock
})

/**
 * 「信心 0.72」是內部分數,這張卡現在客服(agent)也看得到——
 * 建議收件匣那邊刻意不印分數(對商家沒意義,只會讓人以為要達到某個標準),同一套產品不該兩種待遇。
 * 白話等級為主,原始數字降為括號裡的小字(平台端排查用)。
 */
function confidenceLabel(c: number): string {
  if (c >= 0.8) return '很有把握'
  if (c >= 0.6) return '有把握'
  return '把握不高'
}

const summaryText = computed(() => {
  if (!ctx.value?.hasMeta) return ''
  if (ctx.value.lastDecision === 'answered') return `AI 已回答（${confidenceLabel(ctx.value.lastConfidence)}）`
  if (ctx.value.lastDecision === 'handoff') return `AI 轉真人 — ${handoffLabel.value}`
  if (ctx.value.lastDecision === 'handoff_confirm') return `AI 詢問是否轉接專員（${handoffLabel.value}），等客人確認`
  if (ctx.value.lastDecision === 'disambiguate') return `AI 反問澄清，等客人從選項挑一個`
  return ctx.value.lastQuery || '—'
})

const handoffLabel = computed(() => {
  const r = ctx.value?.lastHandoffReason
  return r ? HANDOFF_REASON_LABELS[r] ?? r : ''
})

/** 判斷規則放在 shared（有測試涵蓋），這裡只餵資料：畫面與缺口聚類要同一套口徑 */
const knowledgeGap = computed(() => {
  const c = ctx.value
  if (!c?.hasMeta) return false
  return isKnowledgeGapContext({
    lastDecision: c.lastDecision,
    lastHandoffReason: c.lastHandoffReason,
    lastAnswerKind: c.lastAnswerKind,
    sourceCount: c.sources.length,
    hasSuggestedReply: Boolean(c.suggestedReply),
  })
})

/** 沒查知識庫的情況，直接說清楚為什麼沒有「命中知識」可看 */
const noLookupText = computed(() => {
  const c = ctx.value
  if (!c?.hasMeta || knowledgeGap.value || c.sources.length || c.suggestedReply) return ''
  if (c.lastAnswerKind === 'social') return '這題是招呼語（打招呼／道謝／道別），AI 用固定回覆，沒有查知識庫。'
  if (c.lastAnswerKind === 'offtopic') return '這題不在服務範圍（閒聊／代寫／打探系統），AI 已禮貌拒答，沒有查知識庫。'
  if (c.lastDecision === 'handoff' || c.lastDecision === 'handoff_confirm') {
    return `這題不是知識庫的問題（${handoffLabel.value || '已轉真人'}），補知識幫不上，請直接接手回覆。`
  }
  return ''
})

/**
 * 「答錯」只對「AI 用知識庫回答」的題目有意義。
 * 招呼語／越界拒答標了只會把雜訊灌進缺口聚類（≥4 字就會被當成一個主題）。
 */
const canMarkWrong = computed(() =>
  ctx.value?.lastDecision === 'answered' && ctx.value.lastAnswerKind === 'kb',
)

const bannerClass = computed(() => {
  if (!ctx.value?.hasMeta) return ''
  if (ctx.value.lastDecision === 'handoff') return 'conv-ai-banner--handoff'
  if (ctx.value.lastDecision === 'handoff_confirm') return 'conv-ai-banner--disambiguate'
  if (ctx.value.lastDecision === 'disambiguate') return 'conv-ai-banner--disambiguate'
  return 'conv-ai-banner--answered'
})

const updatedAtLabel = computed(() => {
  const ms = ctx.value?.updatedAtMs ?? 0
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
})

/**
 * 「這一次互動標過答錯了嗎」由後端給（ctx.wrongMarked），不是前端自己記。
 * 先前只存在這個分頁的記憶體裡：重新整理後看起來像沒標過（其實標了），
 * 客服會重複按，也永遠看不出到底存進去了沒有。
 *
 * 這裡只保留「剛剛按下去」的樂觀覆蓋值（等重新載入 ctx 期間讓按鈕立刻變樣），
 * 每次 ctx 重新載入就清掉，回歸後端的事實。
 */
const marking = ref(false)
const optimisticMarked = ref<boolean | null>(null)
const wrongMarked = computed(() => optimisticMarked.value ?? ctx.value?.wrongMarked ?? false)

/**
 * 記錄一筆回饋事件。一定要帶 interactionAtMs：後端用它確認「你標的就是畫面上這一次」，
 * 也用它當固定 doc id（重複點覆寫同一筆，不會把缺口統計灌大）。
 */
function logFeedback(type: 'wrong_answer' | 'draft_applied', userId: string, interactionAtMs: number): Promise<unknown> {
  return props.apiFetch(`/api/conversations/${encodeURIComponent(userId)}/ai-feedback`, {
    method: 'POST',
    body: { type, interactionAtMs },
  })
}

/** 取消回饋。doc id 由 (type, 對話, interactionAtMs) 算出來，所以刪除不需要另存任何狀態。 */
function unlogFeedback(type: 'wrong_answer', userId: string, interactionAtMs: number): Promise<unknown> {
  return props.apiFetch(
    `/api/conversations/${encodeURIComponent(userId)}/ai-feedback?type=${type}&interactionAtMs=${interactionAtMs}`,
    { method: 'DELETE' },
  )
}

function applyDraft(text: string) {
  emit('apply-draft', text)
  // 採用率是草稿品質的長期指標；失敗不打擾客服現場
  const userId = props.userId
  const at = ctx.value?.updatedAtMs ?? 0
  if (userId && at) logFeedback('draft_applied', userId, at).catch(() => {})
}

async function markWrong() {
  const userId = props.userId
  const at = ctx.value?.updatedAtMs ?? 0
  if (marking.value || wrongMarked.value || !userId || !at) return
  marking.value = true
  try {
    await logFeedback('wrong_answer', userId, at)
    // 回來時已經切到別的客人就別動畫面（那筆標記本身有效，切回來會由後端的 wrongMarked 反映）
    if (props.userId === userId) {
      optimisticMarked.value = true
      // 不要講成「會變成建議」:同類問題累積到一定次數才會成為主題,單獨一筆不會馬上出現
      showToast('已記錄。按錯了可以再點一下取消', 'success')
    }
  }
  catch (e: any) {
    const conflict = e?.statusCode === 409 || e?.response?.status === 409
    if (conflict) {
      // 畫面上的脈絡是舊的（客人在你看的時候又問了一題）。這裡要當場把畫面救回來——
      // 只叫使用者「重新整理」但畫面上沒有任何刷新的地方，就是死路。
      await load()
      showToast('客人剛剛又問了新的問題，畫面已更新。請確認後再標記', 'warning')
    }
    else {
      showToast('記錄失敗，請再試一次', 'error')
    }
  }
  finally {
    marking.value = false
  }
}

/**
 * 取消「答錯」標記。刻意可以隨時取消（不設幾秒內撤回的窗口）：
 * 客服常常是隔一天回頭看才發現標錯，短窗口等於沒有。
 */
async function unmarkWrong() {
  const userId = props.userId
  const at = ctx.value?.updatedAtMs ?? 0
  if (marking.value || !wrongMarked.value || !userId || !at) return
  marking.value = true
  try {
    await unlogFeedback('wrong_answer', userId, at)
    if (props.userId === userId) {
      optimisticMarked.value = false
      // 講清楚「已經擬出來的建議不會自動收回」，否則客服會以為取消了就沒事
      showToast('已取消標記。若同類問題已擬成建議，請到知識庫的建議收件匣按「忽略」', 'success')
    }
  }
  catch {
    showToast('取消失敗，請再試一次', 'error')
  }
  finally {
    marking.value = false
  }
}

async function load() {
  ctx.value = null
  // 重新載入就回歸後端事實（含「這一次互動標過答錯了嗎」），不留上一次的樂觀值
  optimisticMarked.value = null
  if (!props.userId) return
  try {
    ctx.value = await props.apiFetch<AiContextResponse>(
      `/api/conversations/${encodeURIComponent(props.userId)}/ai-context`,
    )
  }
  catch {
    ctx.value = null
  }
}

watch(() => [props.userId, props.refreshKey], load, { immediate: true })
</script>

<style scoped lang="scss">
.conv-ai-banner {
  border-radius: 8px;
  margin: 0 12px 12px;
  border: 1px solid var(--el-border-color);
  background: var(--el-fill-color-light);
  font-size: 13px;

  &--handoff {
    border-color: var(--el-color-warning-light-5);
    background: var(--el-color-warning-light-9);
  }
  &--answered {
    border-color: var(--el-color-success-light-5);
    background: var(--el-color-success-light-9);
  }
  &--disambiguate {
    border-color: var(--el-color-info-light-5);
    background: var(--el-color-info-light-9);
  }
}

.conv-ai-banner-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}

.conv-ai-banner-badge {
  font-weight: 600;
  white-space: nowrap;
}

.conv-ai-banner-summary {
  flex: 1;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-ai-banner-time,
.conv-ai-banner-toggle {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.conv-ai-banner-body {
  padding: 8px 12px 12px;
  border-top: 1px dashed var(--el-border-color);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.conv-ai-row {
  display: flex;
  gap: 8px;
  font-size: 12px;

  &--block {
    flex-direction: column;
  }
}

.conv-ai-row__label {
  min-width: 90px;
  color: var(--el-text-color-secondary);
}

.conv-ai-row__value {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 原始信心分數:白話等級為主,分數留給平台端排查用 */
.conv-ai-confidence-raw {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.conv-ai-source-list {
  margin: 4px 0 0;
  padding-left: 18px;
  li {
    margin: 2px 0;
  }
}

.conv-ai-draft {
  padding: 8px 10px;
  background: white;
  border-radius: 4px;
  border-left: 3px solid var(--el-color-primary);
  white-space: pre-wrap;
  margin-bottom: 6px;
}

.conv-ai-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;

  &--warn {
    background: var(--el-color-warning-light-7);
    color: var(--el-color-warning-dark-2);
  }
}

.conv-ai-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--el-text-color-secondary);

  span {
    flex: 1;
  }
}

/* 「沒查知識庫」的說明:純資訊、沒有可按的動作,所以不做成 empty 那種帶按鈕的排版 */
.conv-ai-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.conv-ai-actions {
  display: flex;
  align-items: center;
  gap: 8px;

  &__hint {
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }
}
</style>
