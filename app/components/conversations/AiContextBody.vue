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

    <!--
      `D-135`（2026-10-18）：拿掉「把握度 有把握（0.76）」那一列——客服用不到那個數字，
      而且「有把握」曾經掛在答錯的那一則旁邊。轉真人的原因留著，自己一列。
    -->
    <div v-if="handoffLabel" class="conv-ai-row">
      <span class="conv-ai-row__label">轉真人原因</span>
      <span class="conv-ai-row__value">
        <span class="conv-ai-tag conv-ai-tag--warn">{{ handoffLabel }}</span>
      </span>
    </div>

    <!-- 名字可以直接點開來改。`D-135`：以前叫「命中知識（top 5）」 -->
    <div v-if="ctx.sources.length" class="conv-ai-row conv-ai-row--block">
      <span class="conv-ai-row__label">AI 參考的知識</span>
      <ul class="conv-ai-source-list">
        <li v-for="src in ctx.sources" :key="src.chunkId">
          <button
            v-if="src.exists"
            type="button"
            class="conv-ai-source-link"
            title="打開這條知識來看／修改內容"
            @click="$emit('edit-chunk', src.chunkId)"
          >{{ src.title }}</button>
          <!-- 換新版換掉的、刪掉的（`D-125`）：看得到當時用了哪一條，但不給點——點下去找不到它 -->
          <span v-else class="conv-ai-source-gone">{{ goneText(src.title) }}</span>
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

    <!--
      「這題 AI 答錯了」（`D-135`，2026-10-18 老闆「按照你建議的改」）：按下去先問錯在哪，四選一，
      每一種只給一句話＋一個按鈕。以前一按就當成「卡寫錯了」：撈到的每一條都標紅、列出最多 5 顆「去修」——
      正式站標過的 3 次都不是卡寫錯，10/13 同事照著把 5 條都改了一遍，改不到原因。
      招呼語／越界拒答不顯示：那些不是知識問題。
    -->
    <div v-if="canMarkWrong" class="conv-ai-mark">
      <div v-if="step === 'idle'" class="conv-ai-actions">
        <el-button size="small" type="danger" plain @click="step = 'ask'">這題 AI 答錯了</el-button>
        <span class="conv-ai-actions__hint">按了會先問你哪裡錯，再帶你到該改的地方</span>
      </div>

      <div v-else-if="step === 'ask'" class="conv-ai-mark__box">
        <p class="conv-ai-mark__muted">這則已經送到客人手上了，要更正請直接在下面回覆客人。</p>
        <p class="conv-ai-mark__title">哪裡錯了？</p>
        <div class="conv-ai-mark__options">
          <el-button
            v-for="r in WRONG_ANSWER_REASONS"
            :key="r"
            class="conv-ai-mark__option"
            :loading="marking && pendingReason === r"
            :disabled="marking"
            @click="choose(r)"
          >{{ WRONG_ANSWER_REASON_LABELS[r] }}</el-button>
        </div>
        <div class="conv-ai-mark__foot">
          <el-button size="small" text :disabled="marking" @click="cancelAsk">取消</el-button>
        </div>
      </div>

      <div v-else-if="step === 'reason' && savedReason" class="conv-ai-mark__box">
        <div class="conv-ai-mark__head">
          <span class="conv-ai-mark__muted">錯在：<strong class="conv-ai-mark__strong">{{ WRONG_ANSWER_REASON_LABELS[savedReason] }}</strong></span>
          <el-button link type="primary" size="small" :disabled="marking" @click="step = 'ask'">改選</el-button>
        </div>

        <template v-if="savedReason === 'wrong_product'">
          <p class="conv-ai-mark__text">記下來了。AI 認錯了客人問的是哪個商品——這要系統這邊修，知識庫的資料不用改。</p>
          <div class="conv-ai-mark__foot">
            <el-button size="small" type="primary" @click="step = 'done'">完成</el-button>
          </div>
        </template>

        <template v-else-if="savedReason === 'wrong_data'">
          <template v-if="editableSources.length">
            <p class="conv-ai-mark__title">是哪一條寫錯了？</p>
            <el-radio-group v-model="pickedChunkId" class="conv-ai-mark__cards">
              <el-radio
                v-for="src in editableSources"
                :key="src.chunkId"
                :value="src.chunkId"
                border
                class="conv-ai-mark__card"
              >
                <span class="conv-ai-mark__card-title">{{ src.title }}</span>
                <span v-if="src.snippet" class="conv-ai-mark__card-snippet">{{ src.snippet }}</span>
              </el-radio>
            </el-radio-group>
            <!-- 說明自己一行、按鈕自己一行：按鈕字會跟著選的那條變長，並排的話一選就把說明擠成兩行 -->
            <p class="conv-ai-mark__muted">只有選的這一條會列進知識庫「要處理的事」</p>
            <div class="conv-ai-mark__foot">
              <el-button
                size="small"
                type="primary"
                :disabled="!pickedChunkId"
                :loading="marking"
                @click="openPicked"
              >{{ pickedTitle ? `打開「${pickedTitle}」來改` : '先選一條' }}</el-button>
            </div>
          </template>
          <!-- 當時參考的那幾條後來被換掉或刪掉了（`D-125`）：沒有東西可選，改成補一條新的 -->
          <template v-else>
            <p class="conv-ai-mark__text">AI 當時參考的知識已經換掉或刪掉了，要改就補一條新的。</p>
            <div class="conv-ai-mark__foot">
              <el-button size="small" type="primary" @click="addCorrect">補一條正確的</el-button>
            </div>
          </template>
        </template>

        <template v-else-if="savedReason === 'missing'">
          <p class="conv-ai-mark__text">把正確的答案補進知識庫，下次 AI 就會照著答。</p>
          <p class="conv-ai-mark__muted">會先帶入客人的問題；你已經回覆客人的話，那句也會帶進去當答案。</p>
          <div class="conv-ai-mark__foot">
            <el-button size="small" type="primary" @click="addCorrect">補一條正確的</el-button>
          </div>
        </template>

        <template v-else>
          <p class="conv-ai-mark__text">
            記下來了。想讓這類問題以後都直接轉真人：{{ canEditAiSettings ? '' : '請管理員' }}在 AI 設定的「敏感詞」加一個詞（例如「退款」），客人一提到就會轉給你們。
          </p>
          <div class="conv-ai-mark__foot">
            <el-button v-if="canEditAiSettings" size="small" type="primary" @click="goSettings">前往 AI 設定</el-button>
            <el-button v-else size="small" type="primary" @click="step = 'done'">知道了</el-button>
          </div>
        </template>
      </div>

      <div v-else class="conv-ai-mark__done">
        <span class="conv-ai-mark__muted">
          已標記答錯<template v-if="savedReason">：<strong class="conv-ai-mark__strong">{{ WRONG_ANSWER_REASON_LABELS[savedReason] }}</strong></template>
        </span>
        <el-button link type="primary" size="small" :loading="marking" @click="unmarkWrong">取消標記</el-button>
      </div>
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
  WRONG_ANSWER_REASONS,
  WRONG_ANSWER_REASON_LABELS,
  isKnowledgeGapContext,
  type AiContextPayload,
  type WrongAnswerReason,
} from '~~/shared/types/ai-knowledge'
import { useAdminToast } from '~~/app/composables/useAdminToast'

const props = defineProps<{
  ctx: AiContextPayload
  /** 對話文件 id（打回饋端點用） */
  userId: string | null
  apiFetch: <T = unknown>(url: string, opts?: Record<string, unknown>) => Promise<T>
}>()

/** 補一條時要不要帶「客服已經回給客人的那句」當答案（`D-135`）：帶上這一次是哪一回合，父層去找那句 */
interface AddKnowledgeContext {
  turnId: string
}

const emit = defineEmits<{
  (e: 'apply-draft', text: string): void
  (e: 'add-knowledge', query: string, context?: AddKnowledgeContext): void
  (e: 'edit-chunk', chunkId: string): void
  /** 樂觀鎖擋下時要父層重抓脈絡（只有 aiMeta 那條舊路徑會發生） */
  (e: 'reload'): void
}>()

const { showToast } = useAdminToast()
const { can } = useAdminOperateGuard()

/** 「前往 AI 設定」只給改得了設定的人；其他人講「請管理員」，不給一顆進去什麼都不能改的按鈕 */
const canEditAiSettings = computed(() => can('ai.settings.write'))

/** 還在知識庫裡、點得開來改的卡（被刪掉的、在回收桶的不給連結） */
const editableSources = computed(() => props.ctx.sources.filter(s => s.exists))

/**
 * 點不開的那一條怎麼講（`D-125`）：在回收桶的（換新版換掉的、刪掉的）後端照給標題；
 * 回收桶也清掉了就沒有標題。⛔ 不讓它長得像連結、也不留一個不知道是什麼的空白。
 */
function goneText(title: string): string {
  return title ? `${title}（這條已經換掉或刪掉了）` : '（這條已經刪掉了）'
}

const route = useRoute()

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

/** 沒查知識庫的情況，直接說清楚為什麼沒有「AI 參考的知識」可看 */
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
 * 標記流程走到哪（`D-135`）：idle 還沒按 → ask 問錯在哪 → reason 選了、給下一步 → done 標好了。
 * 「這一次標過了嗎、錯在哪」的事實由後端給（ctx.wrongMarked／wrongMarkedReason）；這裡的 saved* 是
 * 「剛剛送出去的」覆蓋值，換一份 ctx（換一則、重新載入）就回歸後端的事實。
 */
type MarkStep = 'idle' | 'ask' | 'reason' | 'done'
const step = ref<MarkStep>('idle')
const savedMarked = ref(false)
const savedReason = ref<WrongAnswerReason | null>(null)
const pickedChunkId = ref('')
const marking = ref(false)
/** 正在送的是哪一個選項（只讓那一顆轉圈） */
const pendingReason = ref<WrongAnswerReason | null>(null)

function syncFromCtx() {
  savedMarked.value = props.ctx.wrongMarked
  savedReason.value = props.ctx.wrongMarkedReason ?? null
  step.value = props.ctx.wrongMarked ? 'done' : 'idle'
  pickedChunkId.value = ''
}
syncFromCtx()
watch(() => [props.ctx.turnId, props.ctx.updatedAtMs, props.ctx.wrongMarked, props.ctx.wrongMarkedReason], syncFromCtx)

const pickedTitle = computed(() => editableSources.value.find(s => s.chunkId === pickedChunkId.value)?.title ?? '')

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

/**
 * 送一次「答錯了」。同一次回答再送＝覆寫（改選原因、補上是哪一條都走這裡）。
 * 回傳是否成功；回來時已經切到別的客人就別動畫面（那筆標記本身有效）。
 */
async function sendMark(reason: WrongAnswerReason, chunkId?: string): Promise<boolean> {
  const userId = props.userId
  if (marking.value || !userId || !identified.value) return false
  marking.value = true
  pendingReason.value = reason
  try {
    await props.apiFetch(`/api/conversations/${encodeURIComponent(userId)}/ai-feedback`, {
      method: 'POST',
      body: { type: 'wrong_answer', reason, ...(chunkId ? { chunkId } : {}), ...feedbackTarget() },
    })
    if (props.userId !== userId) return false
    savedMarked.value = true
    savedReason.value = reason
    return true
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
    return false
  }
  finally {
    marking.value = false
    pendingReason.value = null
  }
}

/** 選了錯在哪：先記下來（之後只是換一條路走），再給這一種的下一步 */
async function choose(reason: WrongAnswerReason) {
  if (!(await sendMark(reason))) return
  pickedChunkId.value = ''
  step.value = 'reason'
}

/** 問到一半按取消：標過了就回到「已標記」那一行，還沒標就回到按鈕 */
function cancelAsk() {
  step.value = savedMarked.value ? 'done' : 'idle'
}

/** 「資料寫錯」選了是哪一條：補記那一條（只有它會列進知識庫待辦），再打開來改 */
async function openPicked() {
  const id = pickedChunkId.value
  if (!id) return
  if (!(await sendMark('wrong_data', id))) return
  emit('edit-chunk', id)
  step.value = 'done'
}

function addCorrect() {
  emit('add-knowledge', props.ctx.lastQuery, { turnId: props.ctx.turnId })
  step.value = 'done'
}

function goSettings() {
  window.open(`/admin/${String(route.params.workspaceId ?? '')}/ai-settings#sensitive-topics`, '_blank')
  step.value = 'done'
}

/**
 * 取消「答錯」標記。刻意可以隨時取消（不設幾秒內撤回的窗口）：
 * 客服常常是隔一天回頭看才發現標錯，短窗口等於沒有。
 */
async function unmarkWrong() {
  const userId = props.userId
  if (marking.value || !userId || !identified.value) return
  marking.value = true
  try {
    await props.apiFetch(
      `/api/conversations/${encodeURIComponent(userId)}/ai-feedback?type=wrong_answer&${feedbackQuery()}`,
      { method: 'DELETE' },
    )
    if (props.userId === userId) {
      savedMarked.value = false
      savedReason.value = null
      step.value = 'idle'
      showToast('已取消標記', 'success')
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
