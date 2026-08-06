<template>
  <!--
    這張卡回答的是「我要接手了，現在是什麼情況」——不是「上一則怎麼答的」。
    每一則 AI 回覆各自的判斷依據在泡泡旁邊的「為什麼這樣答」，那才是逐則的脈絡；
    把同一份東西在兩個地方各印一次，只會讓人問這兩個有什麼不一樣。
  -->
  <div v-if="visible" class="conv-status" :class="toneClass">
    <!--
      絕大多數情況這裡只有一行：狀態。所以它是一條狀態列，不是一張卡——
      先前沿用舊卡片的外框（可收合、多列、滿版），結果一兩行內容配一大片空白橫在對話最上面，
      而版面最大的一塊還被「還沒整理過」這個空狀態佔走。
    -->
    <!--
      全部靠左擠在一起。先前狀態文字吃掉所有剩餘寬度，把「整理這場對話」推到
      1900px 外的右下角——動作跟它所屬的內容離了整個螢幕寬，看起來像兩件不相干的事。
    -->
    <div class="conv-status__line">
      <!-- 顏色本身就是狀態:有東西在等人＝琥珀,照常＝灰。比一顆看不懂的圖示直接 -->
      <span class="conv-status__dot" aria-hidden="true" />
      <span class="conv-status__text">{{ statusText }}</span>

      <!-- 相對時間而不是時刻：要判斷的是「這個狀態卡多久了、該不該插手」，不是幾點幾分 -->
      <span v-if="statusAgeLabel" class="conv-status__age">{{ statusAgeLabel }}</span>

      <div class="conv-status__actions">
        <!-- 已結束的會話不給整理：摘要是拿最近幾則生的，在舊會話上按只會得到在講別場的話 -->
        <el-button
          v-if="!isHistoricalSession && !summaryText"
          size="small"
          plain
          :loading="summarizing"
          @click="refreshSummary"
        >整理這場對話</el-button>

        <!-- 草稿模式才有東西可展開（AI 沒發訊息＝對話上沒有泡泡可點，判斷依據只能在這裡看） -->
        <el-button
          v-if="ctx?.hasMeta && ctx.draftMode"
          size="small"
          text
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >{{ expanded ? '收起草稿依據' : '看草稿依據' }}</el-button>
      </div>
    </div>

    <!-- 有摘要才佔版面。接手的人第一個要知道的就是這段，所以不藏在展開層裡 -->
    <div v-if="summaryText" class="conv-status__summary">
      <p class="conv-status__summary-text">{{ summaryText }}</p>
      <div class="conv-status__summary-meta">
        <span v-if="summaryAgeLabel" class="conv-status__age">{{ summaryAgeLabel }}</span>
        <el-button
          v-if="!isHistoricalSession"
          size="small"
          text
          :loading="summarizing"
          @click="refreshSummary"
        >重新整理</el-button>
      </div>
    </div>

    <ConversationsAiContextBody
      v-if="expanded && ctx?.hasMeta && ctx.draftMode"
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
/** 只有草稿模式那一塊需要展開；預設收著，不要一打開對話就攤一大片 */
const expanded = ref(false)
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
  const rel = relativeTime(ms)
  return rel ? `整理於 ${rel}` : ''
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

/**
 * 底色只分「要注意」與「照常」兩級。
 * 三種顏色會讓人以為顏色本身有意義，但這條列真正要傳達的只有一件事：
 * 現在是不是有東西在等人（等客人回覆／已轉真人＝可能要插手）。
 */
const toneClass = computed(() => {
  if (!showStatus.value) return ''
  const d = ctx.value!.lastDecision
  if (d === 'handoff' || d === 'handoff_confirm' || d === 'disambiguate') return 'conv-status--waiting'
  return ''
})

/**
 * 這個狀態卡多久了。用相對時間而不是「8/6 下午11:41」：
 * 要判斷的是「客人已經等 40 分鐘了、我該不該插手」，把時刻換算成多久是多一道手續。
 */
const statusAgeLabel = computed(() =>
  showStatus.value ? relativeTime(ctx.value?.updatedAtMs ?? 0) : '',
)

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
