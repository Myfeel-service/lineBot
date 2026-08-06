<template>
  <div class="conv-ai-context-body">
    <div v-if="ctx.handoffSummary" class="conv-ai-row conv-ai-row--block">
      <span class="conv-ai-row__label">對話摘要</span>
      <div class="conv-ai-draft">{{ ctx.handoffSummary }}</div>
    </div>

    <div v-if="ctx.lastQuery" class="conv-ai-row">
      <span class="conv-ai-row__label">客人提問</span>
      <span class="conv-ai-row__value">{{ ctx.lastQuery }}</span>
    </div>

    <!-- 罐頭回覆（招呼語／越界拒答）的信心是寫死的 1.00,印「很有把握」是在對一句
         「不客氣」下能力判語 → 整列不顯示,底下 noLookupText 已把來由講清楚。 -->
    <div v-if="showConfidence" class="conv-ai-row">
      <span class="conv-ai-row__label">{{ isAnswered ? '把握度' : '知識命中分數' }}</span>
      <span class="conv-ai-row__value">
        <!-- 「有把握」是對『這則回答』的判語,只有真的回答了才成立。轉真人 / 反問時印它會與
             結論打對台（實測:0.77「有把握」卻是把別台的折扣碼答錯後轉真人）→ 只給分數不下判語。 -->
        <template v-if="isAnswered">
          <strong>{{ confidenceLabel(ctx.lastConfidence) }}</strong>
          <span class="conv-ai-confidence-raw">（{{ ctx.lastConfidence.toFixed(2) }}）</span>
        </template>
        <strong v-else>{{ ctx.lastConfidence.toFixed(2) }}</strong>
        <span v-if="ctx.lastHandoffReason" class="conv-ai-tag conv-ai-tag--warn">
          {{ handoffLabel }}
        </span>
      </span>
    </div>

    <!-- 卡名可以直接點開來改：AI 答得不對時,要動的就是這張卡,不該讓人自己去知識庫翻 -->
    <div v-if="ctx.sources.length" class="conv-ai-row conv-ai-row--block">
      <span class="conv-ai-row__label">命中知識（top {{ ctx.sources.length }}）</span>
      <ul class="conv-ai-source-list">
        <li v-for="src in ctx.sources" :key="src.chunkId">
          <button
            v-if="src.exists"
            type="button"
            class="conv-ai-source-link"
            title="打開這張知識卡來看／修改內容"
            @click="$emit('edit-chunk', src.chunkId)"
          >{{ src.title }}</button>
          <span v-else class="conv-ai-source-gone">{{ src.title }}</span>
        </li>
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
      <span v-if="!wrongMarked" class="conv-ai-actions__hint">標記之後這裡會告訴你接下來可以做什麼</span>
    </div>

    <!--
      標記完的下一步。原本按下去只跳一句「已記錄」就沒有下文,而實際上單獨一筆
      什麼都不會發生（同類要累積 2 筆、自動整理最長 7 天一輪）——使用者當然看不懂
      自己按了什麼。真正能救這一題的是「AI 照著哪張卡答錯就去改那張卡」,那張卡的
      名字我們手上就有,所以直接把路給出來,不要讓人等聚類。
    -->
    <div v-if="canMarkWrong && wrongMarked" class="conv-ai-followup">
      <p class="conv-ai-followup__line">
        已記下來了。<strong>剛才那則回覆已經送到客人手上，不會被收回</strong>——要更正請直接在下面回覆客人。
      </p>

      <template v-if="editableSources.length">
        <p class="conv-ai-followup__line">AI 這題是照下面這張知識卡回答的。內容不對就直接改它，這是唯一能讓 AI 下次答對的做法：</p>
        <div class="conv-ai-followup__cards">
          <el-button
            v-for="src in editableSources"
            :key="src.chunkId"
            size="small"
            type="primary"
            plain
            @click="$emit('edit-chunk', src.chunkId)"
          >
            去修「{{ src.title }}」
          </el-button>
        </div>
      </template>

      <!-- 引用的卡片後來被刪掉了:別叫人去修一張不存在的卡,直接導向補新的 -->
      <p v-else-if="ctx.sources.length" class="conv-ai-followup__line">
        AI 當時引用的知識卡已經被刪掉了，這題要重新補一張。
        <el-button size="small" type="primary" plain @click="$emit('add-knowledge', ctx.lastQuery)">補一張新的</el-button>
      </p>

      <p class="conv-ai-followup__line conv-ai-followup__line--muted">
        另外系統也會把同類問題收集起來：同一類再被記到一次（不論是又被標答錯、還是 AI 自己答不出而轉真人），
        知識庫的「建議收件匣」就會擬一張草稿讓你審。自動整理最長要等 7 天，想馬上看可以到收件匣按「重新掃描」。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 一次 AI 判斷的脈絡內容（不含外框）。**兩個地方共用**：
 *   - 對話最上方的「AI 脈絡」卡（這位客人最近一次，資料來自 aiMeta）
 *   - 每顆 AI 泡泡旁的「為什麼這樣答」（那一次回合，資料來自 aiTurns）
 *
 * 共用是刻意的：同一件事在兩個地方各寫一份，遲早會對同一場對話說出不一樣的話。
 */
import {
  HANDOFF_REASON_LABELS,
  isKnowledgeGapContext,
  type AiContextPayload,
} from '~~/shared/types/ai-knowledge'
import { useAdminToast } from '~~/app/composables/useAdminToast'

const props = defineProps<{
  ctx: AiContextPayload
  /** 對話文件 id（打回饋端點用） */
  userId: string | null
  apiFetch: <T = unknown>(url: string, opts?: Record<string, unknown>) => Promise<T>
}>()

const emit = defineEmits<{
  (e: 'apply-draft', text: string): void
  (e: 'add-knowledge', query: string): void
  (e: 'edit-chunk', chunkId: string): void
  /** 樂觀鎖擋下時要父層重抓脈絡（只有 aiMeta 那條舊路徑會發生） */
  (e: 'reload'): void
}>()

const { showToast } = useAdminToast()

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

/** 只有「真的回了客人」才適用把握度判語（見 template 註解） */
const isAnswered = computed(() => props.ctx.lastDecision === 'answered')

/** 還在知識庫裡、點得開來改的卡（被刪掉的不給連結） */
const editableSources = computed(() => props.ctx.sources.filter(s => s.exists))

/** 罐頭回覆沒有「把握度」可談（信心固定 1.00，不是算出來的） */
const isCanned = computed(() => {
  const kind = props.ctx.lastAnswerKind ?? 'kb'
  return kind === 'social' || kind === 'offtopic'
})
const showConfidence = computed(() => !isCanned.value)

const handoffLabel = computed(() => {
  const r = props.ctx.lastHandoffReason
  return r ? HANDOFF_REASON_LABELS[r] ?? r : ''
})

/** 判斷規則放在 shared（有測試涵蓋），這裡只餵資料：畫面與缺口聚類要同一套口徑 */
const knowledgeGap = computed(() => isKnowledgeGapContext({
  lastDecision: props.ctx.lastDecision,
  lastHandoffReason: props.ctx.lastHandoffReason,
  lastAnswerKind: props.ctx.lastAnswerKind,
  sourceCount: props.ctx.sources.length,
  hasSuggestedReply: Boolean(props.ctx.suggestedReply),
}))

/** 沒查知識庫的情況，直接說清楚為什麼沒有「命中知識」可看 */
const noLookupText = computed(() => {
  const c = props.ctx
  if (knowledgeGap.value || c.sources.length || c.suggestedReply) return ''
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
  props.ctx.lastDecision === 'answered' && props.ctx.lastAnswerKind === 'kb',
)

/**
 * 「這一次標過答錯了嗎」由後端給（ctx.wrongMarked），不是前端自己記。
 * 這裡只保留「剛剛按下去」的樂觀覆蓋值（等重新載入期間讓按鈕立刻變樣），
 * 換一份 ctx 就清掉，回歸後端的事實。
 */
const marking = ref(false)
const optimisticMarked = ref<boolean | null>(null)
const wrongMarked = computed(() => optimisticMarked.value ?? props.ctx.wrongMarked)
watch(() => [props.ctx.turnId, props.ctx.updatedAtMs], () => { optimisticMarked.value = null })

/**
 * 要標的是「哪一次」。turnId 有值＝綁在那一次回合上（append-only，舊回合照樣標得到、
 * 取消得掉）；沒有＝這功能上線前的舊訊息，只能退回用 aiMeta 的時間戳指認（後端有 409 樂觀鎖）。
 */
function feedbackTarget(): Record<string, unknown> {
  return props.ctx.turnId
    ? { turnId: props.ctx.turnId }
    : { interactionAtMs: props.ctx.updatedAtMs }
}

function feedbackQuery(): string {
  return props.ctx.turnId
    ? `turnId=${encodeURIComponent(props.ctx.turnId)}`
    : `interactionAtMs=${props.ctx.updatedAtMs}`
}

/** 這一次是否指認得出來（兩種識別都沒有就不該送出，否則後端只會回 400） */
const identified = computed(() => Boolean(props.ctx.turnId) || props.ctx.updatedAtMs > 0)

function applyDraft(text: string) {
  emit('apply-draft', text)
  // 採用率是草稿品質的長期指標；失敗不打擾客服現場
  if (props.userId && identified.value) {
    props.apiFetch(`/api/conversations/${encodeURIComponent(props.userId)}/ai-feedback`, {
      method: 'POST',
      body: { type: 'draft_applied', ...feedbackTarget() },
    }).catch(() => {})
  }
}

async function markWrong() {
  const userId = props.userId
  if (marking.value || wrongMarked.value || !userId || !identified.value) return
  marking.value = true
  try {
    await props.apiFetch(`/api/conversations/${encodeURIComponent(userId)}/ai-feedback`, {
      method: 'POST',
      body: { type: 'wrong_answer', ...feedbackTarget() },
    })
    // 回來時已經切到別的客人就別動畫面（那筆標記本身有效）
    if (props.userId === userId) {
      optimisticMarked.value = true
      showToast('已記下這題答錯了', 'success')
    }
  }
  catch (e: any) {
    const conflict = e?.statusCode === 409 || e?.response?.status === 409
    if (conflict) {
      // 只有舊路徑（靠 aiMeta 時間戳）會撞到：畫面上的脈絡是舊的（客人又問了一題）。
      // 當場把畫面救回來——只叫使用者「重新整理」但畫面上沒有刷新的地方，就是死路。
      emit('reload')
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
  if (marking.value || !wrongMarked.value || !userId || !identified.value) return
  marking.value = true
  try {
    await props.apiFetch(
      `/api/conversations/${encodeURIComponent(userId)}/ai-feedback?type=wrong_answer&${feedbackQuery()}`,
      { method: 'DELETE' },
    )
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
</script>
