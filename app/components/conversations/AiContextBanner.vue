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
        <span class="conv-ai-row__label">信心</span>
        <span class="conv-ai-row__value">
          <strong>{{ ctx.lastConfidence.toFixed(2) }}</strong>
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

      <div v-if="!ctx.suggestedReply && !ctx.sources.length" class="conv-ai-empty">
        <span>知識庫沒有相關資訊，AI 這題答不出來。把答案補進知識庫，下次遇到就會回答了。</span>
        <el-button size="small" type="primary" plain @click="$emit('add-knowledge', ctx.lastQuery)">
          補知識
        </el-button>
      </div>

      <!-- 「AI 自信地答錯」只有人看得出來:一鍵標記,訊號進知識缺口分析(帶當時命中的卡) -->
      <div v-if="ctx.lastDecision === 'answered'" class="conv-ai-actions">
        <el-button size="small" text type="danger" :disabled="wrongMarked" :loading="marking" @click="markWrong">
          {{ wrongMarked ? '已標記答錯' : '這題 AI 答錯了' }}
        </el-button>
        <span class="conv-ai-actions__hint">同類問題累積後，系統會在知識庫幫你擬一條</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChatDotRound, CircleCheck, Clock, QuestionFilled, User } from '@element-plus/icons-vue'
import { HANDOFF_REASON_LABELS, type HandoffReason, type AiDecision } from '~~/shared/types/ai-knowledge'
import { useAdminToast } from '~~/app/composables/useAdminToast'

interface AiContextResponse {
  hasMeta: boolean
  lastDecision: AiDecision | ''
  lastConfidence: number
  lastHandoffReason: HandoffReason | null
  lastQuery: string
  suggestedReply: string
  handoffSummary: string
  sources: Array<{ chunkId: string; title: string }>
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

const summaryText = computed(() => {
  if (!ctx.value?.hasMeta) return ''
  if (ctx.value.lastDecision === 'answered') return `AI 已回答（信心 ${ctx.value.lastConfidence.toFixed(2)}）`
  if (ctx.value.lastDecision === 'handoff') return `AI 轉真人 — ${handoffLabel.value}`
  if (ctx.value.lastDecision === 'handoff_confirm') return `AI 詢問是否轉接專員（${handoffLabel.value}），等客人確認`
  if (ctx.value.lastDecision === 'disambiguate') return `AI 反問澄清，等客人從選項挑一個`
  return ctx.value.lastQuery || '—'
})

const handoffLabel = computed(() => {
  const r = ctx.value?.lastHandoffReason
  return r ? HANDOFF_REASON_LABELS[r] ?? r : ''
})

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
 * 回饋（答錯 / 採用草稿）針對的是「畫面上這一次 AI 互動」。
 * 鍵一定要含 updatedAtMs：只用 userId 的話，同一位客人下次 AI 又答錯時，
 * 按鈕會卡在「已標記答錯」而按不下去。
 */
const interactionKey = computed(() =>
  props.userId && ctx.value?.updatedAtMs ? `${props.userId}:${ctx.value.updatedAtMs}` : '',
)
const markedWrongKey = ref('')
const marking = ref(false)
const wrongMarked = computed(() => !!interactionKey.value && markedWrongKey.value === interactionKey.value)

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
  // key 在送出前就固定住：await 之後才求值的話，這期間切到別的客人會把標記寫到那個人身上
  const key = interactionKey.value
  if (marking.value || wrongMarked.value || !userId || !at || !key) return
  marking.value = true
  try {
    await logFeedback('wrong_answer', userId, at)
    // 回來時已經切走就別動畫面（那筆標記本身有效，切回來會由 markedWrongKey 反映）
    markedWrongKey.value = key
    // 不要講成「會變成建議」:同類問題累積到一定次數才會成為主題,單獨一筆不會馬上出現
    if (props.userId === userId) showToast('已記錄。同類問題累積後會出現在知識庫的「AI 建議補的知識」', 'success')
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

async function load() {
  ctx.value = null
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
