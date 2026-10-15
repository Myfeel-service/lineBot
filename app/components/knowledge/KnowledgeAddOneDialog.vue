<template>
  <!--
    「補一條知識」（`C-317`，2026-10-15 老闆拍板 D-126③，示意頁 RhjGQXbdZhqiXpXuM3Vjei ④）。
    每個「補一條」的入口都打開這一個：客人問＋正確答案（一兩句）→ 可以按「AI 幫我整理」看一眼 → 加入就上線。
    ⛔ 不出現標籤（系統分類用的，`C-314`）、不出現問法編輯器（客人問的那句自動放進去，見 utils/kb-add-one）。
    ⛔ 你自己寫的不進「等你看過」：手動那條路建的是直接上線的一條（create 不帶 draft）。
  -->
  <el-dialog
    v-model="visible"
    title="補一條知識"
    width="min(560px, 92vw)"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="kb-addone">
      <!--
        一題以上的建議（`C-311`）：勾這一條回答了哪幾題，沒勾的留在清單上。
        這份清單就是「客人問」——同樣的題目不列兩次（勾選清單取代「客人問」那一格）。
      -->
      <div v-if="isMulti" class="kb-suggest-queries">
        <div class="kb-suggest-queries__head">
          <span class="kb-suggest-queries__label">這一條回答了哪幾題？</span>
          <el-checkbox
            v-if="queries.length > 2"
            :model-value="allTicked"
            :indeterminate="someTicked"
            @change="toggleAll"
          >
            全部
          </el-checkbox>
        </div>
        <el-checkbox-group v-model="ticked" class="kb-suggest-queries__checks">
          <el-checkbox v-for="q in queries" :key="q" :value="q">「{{ q }}」</el-checkbox>
        </el-checkbox-group>
        <p v-if="untickedCount" class="kb-suggest-queries__note">沒勾的 {{ untickedCount }} 題會留著，之後再補。</p>
      </div>
      <div v-else class="admin-field-group">
        <AdminFieldLabel text="客人問" tight />
        <el-input v-model="question" maxlength="200" placeholder="例：運費怎麼算？" />
      </div>

      <div class="admin-field-group">
        <AdminFieldLabel text="正確答案（一兩句就好）" tight />
        <el-input
          v-model="answer"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          maxlength="5000"
          placeholder="例：滿 1000 元免運，未滿收 80 元。"
        />
        <div class="kb-addone__tidy">
          <el-button size="small" plain :loading="tidying" :disabled="!normalizeInput" @click="tidy">
            AI 幫我整理
          </el-button>
        </div>
      </div>

      <!-- 整理好的那一條：直接改得到。答案一改這一塊就收掉（見 AddOnePreview.basis），加入改回照打的字 -->
      <div v-if="preview" class="kb-addone__preview">
        <span class="kb-addone__preview-label">{{ preview.fromDraft ? 'AI 先擬好的' : 'AI 整理成這樣' }}</span>
        <el-input v-model="preview.title" maxlength="100" class="kb-addone__preview-title" />
        <el-input v-model="preview.content" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" maxlength="5000" />
        <p v-if="blanks" class="kb-addone__warn">「請填寫」的地方換成正確內容才能加入</p>
      </div>

      <!-- 額度滿了、這一組已經被別的分頁處理掉…：伺服器講的原因留在視窗裡（toast 三秒半就消失，來不及看） -->
      <p v-if="errorText" class="kb-addone__error">{{ errorText }}</p>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!button.ok" @click="submit">
        {{ button.label }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { useAdminToast } from '~~/app/composables/useAdminToast'
import { countKnowledgeDraftBlanks } from '~~/shared/types/ai-knowledge'
import { apiErrorStatus, apiErrorText } from '~/utils/api-error-text'
import {
  addOneButton,
  addOneDoneToast,
  addOneNormalizeInput,
  addOnePayload,
  previewFromDraft,
  previewStillFits,
  type AddOneCreated,
  type AddOnePreview,
  type AddOneState,
  type AddOneSuggestion,
} from '~/utils/kb-add-one'

const props = withDefaults(defineProps<{
  open: boolean
  /** 「客人問」預填（問 AI 一題答錯的那句、對話頁帶過來的那句） */
  initialQuestion?: string
  suggestion?: AddOneSuggestion | null
  /** 手動那條路：這一條在講哪個商品（只有呼叫端確定時才帶；沒帶＝不是講單一商品） */
  productName?: string
}>(), {
  initialQuestion: '',
  suggestion: null,
  productName: '',
})

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'created', payload: AddOneCreated): void
}>()

const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const question = ref('')
const answer = ref('')
const preview = ref<AddOnePreview | null>(null)
const queries = ref<string[]>([])
const ticked = ref<string[]>([])
const tidying = ref(false)
const saving = ref(false)
const errorText = ref('')
/** 每打開一次加一：上一次打開時送出去、這次才回來的整理結果不收（不然會蓋到這一次的預覽上） */
let session = 0

const state = computed<AddOneState>(() => ({
  question: question.value,
  answer: answer.value,
  preview: preview.value,
  queries: queries.value,
  ticked: ticked.value,
}))
const isMulti = computed(() => queries.value.length > 1)
const allTicked = computed(() => ticked.value.length === queries.value.length)
const someTicked = computed(() => ticked.value.length > 0 && !allTicked.value)
const untickedCount = computed(() => (isMulti.value ? queries.value.length - ticked.value.length : 0))
const normalizeInput = computed(() => addOneNormalizeInput(state.value))
const blanks = computed(() => (preview.value ? countKnowledgeDraftBlanks(preview.value.content) : 0))
const button = computed(() => addOneButton(state.value))

function toggleAll(v: unknown) {
  ticked.value = v ? [...queries.value] : []
}

function reset() {
  session++
  const s = props.suggestion
  const qs = (s?.queries ?? []).map(q => String(q).trim()).filter(Boolean)
  queries.value = qs
  // 預設勾哪幾題由列表那邊用 defaultAnsweredQueries 算好帶進來（⛔ 不預設全勾，理由見那支）；萬一是空的，至少勾第一題
  const defaults = (s?.answeredDefault ?? []).filter(q => qs.includes(q))
  ticked.value = qs.length > 1 ? (defaults.length ? defaults : [qs[0]!]) : []
  question.value = (props.initialQuestion || defaults[0] || qs[0] || '').trim()
  answer.value = ''
  preview.value = previewFromDraft(s?.draft, qs.length > 1 ? (defaults[0] ?? qs[0] ?? '') : question.value)
  errorText.value = ''
  tidying.value = false
}

watch(() => props.open, (v) => { if (v) reset() }, { immediate: true })

// 答案改了，照舊答案整理出來的那一份就不算數（AI 先擬好的草稿：他開始自己寫答案＝不用那一份）
watch(answer, (a) => {
  if (preview.value && !previewStillFits(preview.value, a)) preview.value = null
})

async function tidy() {
  const input = normalizeInput.value
  if (!input) return
  const mine = session
  tidying.value = true
  errorText.value = ''
  try {
    const res = await apiFetch<{ title: string; content: string; tags: string[]; questions?: string[] }>(
      '/api/ai/knowledge/normalize',
      { method: 'POST', body: { title: input.title, content: input.content, tags: [] } },
    )
    // 等的時候他關掉重開了、或又改了答案：這份整理對不上現在的字，不收
    if (mine !== session || answer.value.trim() !== input.content) return
    preview.value = {
      title: String(res.title || input.title).trim().slice(0, 100),
      content: String(res.content ?? '').trim() || input.content,
      questions: (res.questions ?? []).map(q => String(q).trim()).filter(Boolean),
      tags: (res.tags ?? []).map(t => String(t).trim()).filter(Boolean),
      basis: input.content,
      fromDraft: false,
    }
  }
  catch (err) {
    if (mine !== session) return
    // AI 沒整理成照樣加得進去（標題＝客人問的那句、內容＝打的答案）。
    // ⛔ 伺服器 5xx 的原因是工程用語（「normalize: LLM 回傳的 content 為空」），只有 4xx（沒權限、AI 用量上限）才照講
    const s = apiErrorStatus(err)
    const why = s >= 400 && s < 500 ? apiErrorText(err, 'AI 這次沒整理成') : 'AI 這次沒整理成'
    showToast(`${why}，可以直接按「加入」`, 'warning')
  }
  finally {
    if (mine === session) tidying.value = false
  }
}

interface AcceptResponse {
  chunkId: string
  sourceId: string
  status: string
  verify: { decision: string; confidence: number } | null
  remainingQuestions?: number
}
interface CreateResponse {
  id: string
  sourceId: string
  status: string
}

async function submit() {
  if (!button.value.ok || saving.value) return
  const payload = addOnePayload(state.value)
  const s = props.suggestion
  saving.value = true
  errorText.value = ''
  try {
    if (s) {
      // 建議那條路（`C-318`）：走 accept——額度、兩個分頁搶同一筆、只回答其中幾題、銷監控頁案例、稽核都在那支
      const res = await apiFetch<AcceptResponse>(`/api/ai/knowledge/suggestions/${encodeURIComponent(s.id)}/accept`, {
        method: 'POST',
        body: payload,
      })
      const t = addOneDoneToast({ status: res.status, verifyDecision: res.verify?.decision ?? null, verified: !!res.verify, remainingQuestions: res.remainingQuestions })
      showToast(t.text, t.tone)
      emit('created', { chunkId: res.chunkId, sourceId: res.sourceId, mode: 'suggestion', remainingQuestions: res.remainingQuestions ?? 0 })
    }
    else {
      // 手動那條路：⛔ 不帶 draft（帶了會進「等你看過」要再審一次，D-126③ 拍板拿掉）；商品名只有呼叫端帶了才送
      const res = await apiFetch<CreateResponse>('/api/ai/knowledge/create', {
        method: 'POST',
        body: {
          title: payload.title,
          content: payload.content,
          tags: payload.tags,
          questions: payload.questions,
          ...(props.productName.trim() ? { productName: props.productName.trim() } : {}),
        },
      })
      // 手動那條路也要真的試問一次才講「AI 會用這一條」（/code-review 第 5 條；建議那條路由 accept 回 verify）。
      // 試問失敗或逾時＝不知道，不算答不出來（null）；學都沒學成就不必試
      let verifyDecision: string | null = null
      const asked = (question.value || payload.title).trim()
      if (res.status === 'indexed' && asked) {
        try {
          const v = await apiFetch<{ timedOut: boolean; decision: string }>('/api/ai/knowledge/verify', { method: 'POST', body: { query: asked } })
          verifyDecision = v.timedOut ? null : v.decision
        }
        catch { /* 試問失敗不影響已經加好的這一條 */ }
      }
      const t = addOneDoneToast({ status: res.status, verifyDecision, verified: verifyDecision !== null })
      showToast(t.text, t.tone)
      emit('created', { chunkId: res.id, sourceId: res.sourceId, mode: 'manual' })
    }
    visible.value = false
  }
  catch (err) {
    errorText.value = apiErrorText(err, '沒加成，請再試一次')
  }
  finally {
    saving.value = false
  }
}
</script>
