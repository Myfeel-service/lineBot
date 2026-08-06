<template>
  <!--
    這張卡回答的是「我要接手了，現在是什麼情況」——不是「上一則怎麼答的」。
    每一則 AI 回覆各自的判斷依據在泡泡旁邊的「為什麼這樣答」，那才是逐則的脈絡；
    把同一份東西在兩個地方各印一次，只會讓人問這兩個有什麼不一樣。
  -->
  <div v-if="visible" class="conv-ai-banner" :class="bannerClass">
    <div class="conv-ai-banner-header" @click="expanded = !expanded">
      <span class="conv-ai-banner-badge"><el-icon v-if="decisionIcon"><component :is="decisionIcon" /></el-icon> 目前狀況</span>
      <span class="conv-ai-banner-summary">{{ statusText }}</span>
      <span class="conv-ai-banner-time">{{ updatedAtLabel }}</span>
      <span class="conv-ai-banner-toggle">{{ expanded ? '▴' : '▾' }}</span>
    </div>

    <div v-if="expanded" class="conv-ai-banner-body">
      <!--
        摘要放最前面、不用再展一層：接手的人第一個要知道的就是「這場發生什麼事」，
        而不是上一則的把握度。沒有摘要時給一顆按鈕，不要只留一片空白。
      -->
      <div class="conv-ai-row conv-ai-row--block">
        <span class="conv-ai-row__label">這場對話發生什麼事</span>
        <div v-if="summaryText" class="conv-ai-draft">{{ summaryText }}</div>
        <p v-else class="conv-ai-note">
          {{ isHistoricalSession
            ? '這場結束時沒有留下摘要。'
            : '還沒整理過。按「我接手」時會自動整理，也可以現在就整理一份。' }}
        </p>
        <!-- 已結束的會話不給整理：摘要是拿最近幾則生的，在舊會話上按只會得到在講別場的話 -->
        <div v-if="!isHistoricalSession" class="conv-ai-summary-actions">
          <el-button size="small" plain :loading="summarizing" @click="refreshSummary">
            {{ summaryText ? '重新整理摘要' : '整理這場對話' }}
          </el-button>
          <span v-if="summaryAgeLabel" class="conv-ai-actions__hint">{{ summaryAgeLabel }}</span>
        </div>
      </div>

      <!--
        草稿模式：AI 不對客人發訊息，所以對話上沒有 AI 泡泡、也就沒有「為什麼這樣答」可點。
        這時這張卡是唯一看得到判斷依據的地方，完整脈絡必須留在上面。
        非草稿模式就不重複顯示——那些都在泡泡旁邊。
      -->
      <ConversationsAiContextBody
        v-if="ctx?.hasMeta && ctx.draftMode"
        :ctx="ctx"
        :user-id="userId"
        :api-fetch="apiFetch"
        @apply-draft="$emit('apply-draft', $event)"
        @add-knowledge="$emit('add-knowledge', $event)"
        @edit-chunk="$emit('edit-chunk', $event)"
        @reload="load"
      />

      <!-- 非草稿模式只留一句指路：真正的逐則脈絡在泡泡旁邊 -->
      <p v-else-if="ctx?.hasMeta" class="conv-ai-note">
        想看某一則 AI 回覆是怎麼判斷的（把握度、參考了哪條知識、標記答錯），點那則泡泡下面的「為什麼這樣答」。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 對話最上方的「目前狀況」卡：**接手前要知道的事**。
 *
 * 原本這裡印的是「最近一次 AI 互動」的技術細節（把握度／命中知識／答錯按鈕）。
 * 每一則 AI 回覆都有自己的脈絡之後，那些內容在泡泡旁邊都有了——留在這裡就是同一件事
 * 講兩遍，而且這裡只講得了最新那一次，反而誤導。
 *
 * 現在只留三件泡泡旁邊給不了的：
 *   1. 這場對話發生什麼事（接手摘要）
 *   2. 現在卡在哪（等客人選選項／等確認轉接／已轉真人）
 *   3. 草稿模式的完整脈絡（那時 AI 不發訊息，對話上根本沒有泡泡可點）
 */
import { ChatDotRound, CircleCheck, Clock, QuestionFilled, User } from '@element-plus/icons-vue'
import {
  HANDOFF_REASON_LABELS,
  isAiContextWithinSession,
  type AiContextPayload,
  type AiContextSessionWindow,
} from '~~/shared/types/ai-knowledge'
import { useAdminToast } from '~~/app/composables/useAdminToast'

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

const { showToast } = useAdminToast()

const ctx = ref<AiContextPayload | null>(null)
const expanded = ref(true)
const summarizing = ref(false)

/**
 * 手上這張脈絡屬於眼前這場會話嗎？判斷規則放在 shared（有測試涵蓋），這裡只餵資料。
 * 窗口起點的 60 秒回看由父層算好（比照 timeline 的訊息窗口）。
 */
const belongsToSession = computed(() =>
  isAiContextWithinSession(ctx.value?.updatedAtMs ?? 0, props.sessionWindow),
)

/**
 * 有摘要就顯示（摘要不屬於任何一次 AI 互動，看舊會話也成立）；
 * 只有 aiMeta 的狀態列要受場次限制——那講的是「現在」，套到已結束的舊會話上就是錯的。
 */
const showStatus = computed(() => Boolean(ctx.value?.hasMeta) && belongsToSession.value)

/**
 * 看的是一場**已結束**的會話（有窗口且有結束時間）。
 *
 * 這種時候不給「整理這場對話」：摘要是拿這位客人**最近**幾則訊息生的，
 * 在已結束的舊會話上按下去，只會得到一段在講別場的話——就是脈絡卡原本那個錯配的翻版。
 */
const isHistoricalSession = computed(() =>
  Boolean(props.sessionWindow) && Number.isFinite(props.sessionWindow!.endMs),
)

const summaryText = computed(() => {
  // handoffSummary 是 AI 轉真人當下生的，takeoverSummary 是客服要接手時生的。
  // 後者比較新、也比較貼近「我現在要接手」，優先用它。
  // 兩者都要落在這場會話的時間範圍內才算數（同 belongsToSession 的理由）。
  const c = ctx.value
  if (!c) return ''
  if (c.takeoverSummary && isAiContextWithinSession(c.takeoverSummaryAtMs, props.sessionWindow)) {
    return c.takeoverSummary
  }
  if (belongsToSession.value && c.handoffSummary) return c.handoffSummary
  return ''
})

const visible = computed(() => Boolean(ctx.value) && (showStatus.value || Boolean(summaryText.value)))

const summaryAgeLabel = computed(() => {
  const ms = ctx.value?.takeoverSummaryAtMs ?? 0
  if (!ms || !ctx.value?.takeoverSummary) return ''
  return `整理於 ${new Date(ms).toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`
})

const decisionIcon = computed(() => {
  if (!showStatus.value) return null
  const d = ctx.value!.lastDecision
  if (d === 'answered') return CircleCheck
  if (d === 'handoff') return User
  if (d === 'handoff_confirm') return ChatDotRound
  if (d === 'disambiguate') return QuestionFilled
  return Clock
})

const handoffLabel = computed(() => {
  const r = ctx.value?.lastHandoffReason
  return r ? HANDOFF_REASON_LABELS[r] ?? r : ''
})

/**
 * 「現在卡在哪」。刻意不再印把握度——那是對某一則的評價，屬於泡泡旁邊；
 * 這一行要回答的是「我需要插手嗎」。
 */
const statusText = computed(() => {
  if (!showStatus.value) return '這場沒有 AI 互動紀錄'
  const c = ctx.value!
  if (c.lastDecision === 'disambiguate') return 'AI 反問了客人，正在等他從選項挑一個'
  if (c.lastDecision === 'handoff_confirm') return `AI 問客人要不要轉接專員（${handoffLabel.value}），等他回覆`
  if (c.lastDecision === 'handoff') return `已轉真人 — ${handoffLabel.value}`
  if (c.lastDecision === 'answered') {
    if (c.draftMode) return 'AI 擬好草稿了，等你審過再回覆客人'
    return 'AI 已自動回覆客人'
  }
  return c.lastQuery || '—'
})

const bannerClass = computed(() => {
  if (!showStatus.value) return ''
  const d = ctx.value!.lastDecision
  if (d === 'handoff') return 'conv-ai-banner--handoff'
  if (d === 'handoff_confirm' || d === 'disambiguate') return 'conv-ai-banner--disambiguate'
  return 'conv-ai-banner--answered'
})

const updatedAtLabel = computed(() => {
  const ms = showStatus.value ? (ctx.value?.updatedAtMs ?? 0) : 0
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
})

/** 手動整理摘要。force：使用者明講要重新整理時才重生，否則沒有新訊息就沿用（省 LLM 費用） */
async function refreshSummary() {
  const userId = props.userId
  if (!userId || summarizing.value) return
  summarizing.value = true
  try {
    const res = await props.apiFetch<{ text: string; generatedAtMs: number }>(
      `/api/conversations/${encodeURIComponent(userId)}/summary`,
      { method: 'POST', body: { force: Boolean(summaryText.value) } },
    )
    if (props.userId !== userId) return
    if (!res.text) {
      showToast('這場對話還沒有足夠的內容可以整理', 'warning')
      return
    }
    if (ctx.value) {
      ctx.value.takeoverSummary = res.text
      ctx.value.takeoverSummaryAtMs = res.generatedAtMs
    }
  }
  catch {
    showToast('整理摘要失敗，請再試一次', 'error')
  }
  finally {
    summarizing.value = false
  }
}

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

defineExpose({ refreshSummary })

watch(() => [props.userId, props.refreshKey], load, { immediate: true })
</script>
