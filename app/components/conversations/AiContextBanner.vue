<template>
  <!--
    這張卡講的是「這位客人最近一次」AI 互動，不是「這場會話」的。從側欄點進一場已結束的
    會話時，訊息換成那場的、卡片卻還是最新那次，兩邊兜不起來；更糟的是此時按「答錯」會
    成功記到最新那次頭上（時間戳與後端一致，樂觀鎖擋不住），客服卻以為標的是眼前這場。
    所以窗口對不上就整張收掉，只留一句說明——不是靜靜消失，那會讓人以為系統壞了。
  -->
  <div v-if="ctx?.hasMeta && !belongsToSession" class="conv-ai-banner conv-ai-banner--stale">
    <span class="conv-ai-banner-badge">AI 脈絡</span>
    <span class="conv-ai-banner-stale-text">
      這場會話當時的 AI 脈絡沒有留下來。系統只保留每位客人「最近一次」AI 互動，後來的對話已經把它蓋掉了。
    </span>
  </div>

  <div v-else-if="ctx?.hasMeta" class="conv-ai-banner" :class="bannerClass">
    <div class="conv-ai-banner-header" @click="expanded = !expanded">
      <span class="conv-ai-banner-badge"><el-icon v-if="decisionIcon"><component :is="decisionIcon" /></el-icon> AI 脈絡</span>
      <span class="conv-ai-banner-summary">
        {{ summaryText }}
      </span>
      <span class="conv-ai-banner-time">{{ updatedAtLabel }}</span>
      <span class="conv-ai-banner-toggle">{{ expanded ? '▴' : '▾' }}</span>
    </div>

    <ConversationsAiContextBody
      v-if="expanded"
      :ctx="ctx"
      :user-id="userId"
      :api-fetch="apiFetch"
      @apply-draft="$emit('apply-draft', $event)"
      @add-knowledge="$emit('add-knowledge', $event)"
      @edit-chunk="$emit('edit-chunk', $event)"
      @reload="load"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 對話最上方的「AI 脈絡」卡：這位客人**最近一次** AI 互動（資料來自 aiMeta）。
 *
 * 每一則 AI 回覆各自的脈絡在泡泡旁邊（見 AdminPanel 的「為什麼這樣答」），資料來自 aiTurns。
 * 兩邊渲染的是同一個 AiContextBody，只有資料來源與外框不同。
 */
import { ChatDotRound, CircleCheck, Clock, QuestionFilled, User } from '@element-plus/icons-vue'
import {
  HANDOFF_REASON_LABELS,
  isAiContextWithinSession,
  type AiContextPayload,
  type AiContextSessionWindow,
} from '~~/shared/types/ai-knowledge'

const props = defineProps<{
  userId: string | null
  /** 父元件 conversations 列表變更時要 trigger 重抓 */
  refreshKey?: number | string
  /**
   * 看的是「某一場會話」時，那場的時間範圍（endMs 可為 Infinity＝還沒結束）。
   * 用來判斷手上這張脈絡是不是這場的，見 belongsToSession。null＝看的是進行中的對話。
   */
  sessionWindow?: AiContextSessionWindow | null
  apiFetch: <T = unknown>(url: string, opts?: Record<string, unknown>) => Promise<T>
}>()

defineEmits<{
  (e: 'apply-draft', text: string): void
  (e: 'add-knowledge', query: string): void
  (e: 'edit-chunk', chunkId: string): void
}>()

const ctx = ref<AiContextPayload | null>(null)
const expanded = ref(true)

const decisionIcon = computed(() => {
  if (!ctx.value?.hasMeta) return null
  if (ctx.value.lastDecision === 'answered') return CircleCheck
  if (ctx.value.lastDecision === 'handoff') return User
  if (ctx.value.lastDecision === 'handoff_confirm') return ChatDotRound
  if (ctx.value.lastDecision === 'disambiguate') return QuestionFilled
  return Clock
})

/** 與 AiContextBody 同一套白話等級（那邊是內容、這裡是摘要列） */
function confidenceLabel(c: number): string {
  if (c >= 0.8) return '很有把握'
  if (c >= 0.6) return '有把握'
  return '把握不高'
}

/**
 * 手上這張脈絡屬於眼前這場會話嗎？判斷規則放在 shared（有測試涵蓋），這裡只餵資料。
 * 窗口起點的 60 秒回看由父層算好（比照 timeline 的訊息窗口），見 aiContextSessionWindow。
 */
const belongsToSession = computed(() =>
  isAiContextWithinSession(ctx.value?.updatedAtMs ?? 0, props.sessionWindow),
)

const summaryText = computed(() => {
  if (!ctx.value?.hasMeta) return ''
  if (ctx.value.lastDecision === 'answered') {
    // 招呼語／越界拒答不報把握度：那句話是寫死的，不是 AI 判斷得多準
    if (ctx.value.lastAnswerKind === 'social') return 'AI 已回覆招呼語（固定回覆，未查知識庫）'
    if (ctx.value.lastAnswerKind === 'offtopic') return 'AI 已禮貌拒答（不在服務範圍）'
    return `AI 已回答（${confidenceLabel(ctx.value.lastConfidence)}）`
  }
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

async function load() {
  ctx.value = null
  if (!props.userId) return
  try {
    ctx.value = await props.apiFetch<AiContextPayload>(
      `/api/conversations/${encodeURIComponent(props.userId)}/ai-context`,
    )
  }
  catch {
    ctx.value = null
  }
}

watch(() => [props.userId, props.refreshKey], load, { immediate: true })
</script>
