<template>
  <!-- 建議收件匣:系統從「客人問了但 AI 答不出」的真實對話整理主題並擬好草稿,店家審一眼就能用 -->
  <!-- 只要載入完就顯示（不等第一次掃描）:整塊藏起來會連「重新掃描」按鈕都看不到,
       從未掃描過的工作區就沒有任何方法觸發第一次掃描。 -->
  <div v-if="loaded" class="kb-suggest">
    <p class="kb-suggest-head">
      <el-icon class="kb-suggest-icon"><MagicStick /></el-icon>
      <span>
        <strong>AI 建議補的知識</strong><template v-if="items.length">：{{ items.length }} 個主題待處理</template>
      </span>
    </p>
    <p class="kb-suggest-hint">從「客人問過、但 AI 答不出來」的真實對話整理，草稿已擬好，審一眼就能用。</p>

    <div v-if="items.length" class="kb-suggest-list">
      <div v-for="s in items" :key="s.id" class="kb-suggest-item">
        <div class="kb-suggest-item__main">
          <span class="kb-suggest-item__topic">{{ s.topic }}</span>
          <!-- sampled = 事件多到撞掃描上限,次數是低估值 → 說「至少」而不是印成實數 -->
          <span class="kb-suggest-item__count">30 天內{{ s.sampled ? '至少' : '' }}被問 {{ s.eventCount }} 次</span>
        </div>
        <div v-if="canEdit" class="kb-suggest-item__actions">
          <el-button size="small" type="primary" plain @click="openReview(s)">看草稿</el-button>
          <el-button size="small" text :loading="dismissingId === s.id" @click="dismiss(s)">忽略</el-button>
        </div>
      </div>
    </div>
    <p v-else-if="!lastScanAtMs" class="kb-suggest-empty">
      還沒分析過。AI 開始服務客人後，系統會自動找出「客人問了但答不出來」的主題並擬好草稿。
    </p>
    <p v-else class="kb-suggest-empty">目前沒有待處理的建議——最近客人問的，AI 都答得出來。</p>

    <p class="kb-suggest-foot">
      <span>{{ scanLabel }}</span>
      <el-button v-if="canEdit && !scanRequested" size="small" text :loading="refreshing" @click="requestRefresh">
        重新掃描
      </el-button>
    </p>

    <!-- 審核草稿:可改可直接採用;含佔位符(知識庫查不到的事實)要先補完 -->
    <el-dialog
      v-model="reviewOpen"
      title="審核知識卡草稿"
      width="620px"
      :close-on-click-modal="false"
      append-to-body
    >
      <template v-if="reviewing">
        <div class="kb-suggest-queries">
          <span class="kb-suggest-queries__label">客人這樣問（30 天內 {{ reviewing.eventCount }} 次）</span>
          <ul>
            <li v-for="(q, i) in reviewing.sampleQueries" :key="i">「{{ q }}」</li>
          </ul>
        </div>

        <el-alert
          v-if="draftBlanks > 0"
          type="warning"
          :closable="false"
          show-icon
          :title="`草稿有 ${draftBlanks} 個「請填寫」空格`"
          description="那些是知識庫裡查不到的資訊，AI 依規則留空、不自己編。請把正確內容補進去再採用。"
          style="margin-bottom: 12px"
        />
        <el-alert
          v-else-if="reviewing.draftError"
          type="info"
          :closable="false"
          show-icon
          title="草稿產生失敗，請自行撰寫內容"
          :description="reviewing.draftError"
          style="margin-bottom: 12px"
        />

        <el-form label-position="top">
          <el-form-item label="標題" required>
            <el-input v-model="form.title" maxlength="100" show-word-limit placeholder="這張卡回答什麼，例：運費與到貨時間" />
          </el-form-item>
          <el-form-item label="內容" required>
            <el-input
              v-model="form.content"
              type="textarea"
              :rows="10"
              maxlength="5000"
              show-word-limit
              placeholder="用可以直接回覆客人的語氣寫"
            />
          </el-form-item>
          <el-form-item label="客人可能怎麼問（會幫 AI 更容易找到這張卡）">
            <el-select
              v-model="form.questions"
              multiple
              filterable
              allow-create
              default-first-option
              :multiple-limit="3"
              placeholder="輸入後按 Enter，最多 3 條"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="標籤（選填）">
            <el-select
              v-model="form.tags"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder="輸入後按 Enter"
              style="width: 100%"
            />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <div class="kb-suggest-dialog-footer">
          <el-button text :loading="dismissingId === reviewing?.id" @click="reviewing && dismiss(reviewing)">
            忽略這個主題
          </el-button>
          <div>
            <el-button @click="reviewOpen = false">取消</el-button>
            <!-- 還有「請填寫」空格就先擋在前端:讓人按了才被後端 400 是白跑一趟 -->
            <el-button
              type="primary"
              :loading="accepting"
              :disabled="!form.title.trim() || !form.content.trim() || draftBlanks > 0"
              @click="accept"
            >
              {{ draftBlanks > 0 ? `還有 ${draftBlanks} 個空格要補` : '採用並學習' }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { MagicStick } from '@element-plus/icons-vue'
import { useAdminToast } from '~~/app/composables/useAdminToast'
import { countKnowledgeDraftBlanks, type KnowledgeSuggestionDraft } from '~~/shared/types/ai-knowledge'

interface SuggestionRow {
  id: string
  topic: string
  eventCount: number
  /** 次數是取樣值（事件撞到掃描上限）→ 顯示「至少 N 次」 */
  sampled: boolean
  sampleQueries: string[]
  draft: KnowledgeSuggestionDraft | null
  blanksCount: number
  draftError: string
  lastSeenAtMs: number
}

interface AcceptResponse {
  chunkId: string
  status: string
  failureReason: string | null
  resolvedConversations: number
  verify: { decision: string; confidence: number } | null
}

const emit = defineEmits<{
  /** 採用成功(知識庫多了一個 manual 來源),父頁面要重載來源列表 */
  (e: 'accepted'): void
}>()

const { apiFetch, can } = useWorkspace()
const { showToast } = useAdminToast()

const canEdit = computed(() => can('knowledge.write'))

const loaded = ref(false)
const items = ref<SuggestionRow[]>([])
const lastScanAtMs = ref(0)
const scanRequested = ref(false)
const refreshing = ref(false)
const dismissingId = ref<string | null>(null)
const accepting = ref(false)

const reviewOpen = ref(false)
const reviewing = ref<SuggestionRow | null>(null)
const form = ref<{ title: string; content: string; tags: string[]; questions: string[] }>({
  title: '', content: '', tags: [], questions: [],
})

const lastError = ref('')

/**
 * 佔位符即時計數:使用者在彈窗補完空格,警示要跟著消失。
 * 用 shared 的同一支正則——各寫一份的話,後端擋下採用時前端卻顯示「草稿乾淨」,
 * 使用者會收到 400 卻看不出哪裡要補。
 */
const draftBlanks = computed(() => countKnowledgeDraftBlanks(form.value.content))

const scanLabel = computed(() => {
  if (scanRequested.value) return '已排入重新掃描，約 10 分鐘內完成'
  // 掃描失敗要說出來:不講的話畫面是「剛剛掃過 + 沒有建議」,看起來像真的沒缺口
  if (lastError.value) return '上次分析失敗了，可以再按一次重新掃描'
  if (!lastScanAtMs.value) return '尚未分析'
  const mins = Math.floor((Date.now() - lastScanAtMs.value) / 60_000)
  if (mins < 60) return `上次分析：${Math.max(1, mins)} 分鐘前`
  if (mins < 48 * 60) return `上次分析：${Math.floor(mins / 60)} 小時前`
  return `上次分析：${Math.floor(mins / 1440)} 天前`
})

async function load() {
  try {
    const res = await apiFetch<{
      items: SuggestionRow[]
      scan: { lastScanAtMs: number; requested: boolean; lastError: string }
    }>('/api/ai/knowledge/suggestions')
    items.value = res.items ?? []
    lastError.value = res.scan?.lastError ?? ''
    lastScanAtMs.value = res.scan?.lastScanAtMs ?? 0
    scanRequested.value = !!res.scan?.requested
  }
  catch {
    // 建議是加值資訊,載入失敗不打擾來源頁主流程
    items.value = []
  }
  finally {
    loaded.value = true
  }
}

function openReview(s: SuggestionRow) {
  reviewing.value = s
  form.value = {
    title: s.draft?.title ?? s.topic,
    content: s.draft?.content ?? '',
    tags: [...(s.draft?.tags ?? [])],
    questions: s.draft?.questions?.length ? [...s.draft.questions] : [...s.sampleQueries.slice(0, 3)],
  }
  reviewOpen.value = true
}

async function accept() {
  const s = reviewing.value
  if (!s) return
  accepting.value = true
  try {
    const res = await apiFetch<AcceptResponse>(`/api/ai/knowledge/suggestions/${s.id}/accept`, {
      method: 'POST',
      body: {
        title: form.value.title.trim(),
        content: form.value.content.trim(),
        tags: form.value.tags,
        questions: form.value.questions,
      },
    })
    reviewOpen.value = false
    items.value = items.value.filter(i => i.id !== s.id)

    // 回饋要講清楚三件事:學會了沒、試答結果、順手銷了幾筆案例
    const resolvedNote = res.resolvedConversations > 0 ? `，並把 ${res.resolvedConversations} 筆監控頁案例標為已處理` : ''
    if (res.status !== 'indexed') {
      showToast('卡片已建立，但 AI 學習失敗——請到卡片上按「重新學習」', 'error')
    }
    else if (res.verify?.decision === 'answered') {
      showToast(`已學會！試答通過（信心 ${res.verify.confidence.toFixed(2)}）${resolvedNote}`, 'success')
    }
    else {
      // 卡建好了但試答沒答出來＝還沒真的解決,用警示色(不是綠色成功)
      showToast(`卡片已建立${resolvedNote}，但試答仍答不出來，建議到「測試對話」確認`, 'warning')
    }
    emit('accepted')
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || err?.statusMessage || '採用失敗，請再試一次', 'error')
  }
  finally {
    accepting.value = false
  }
}

async function dismiss(s: SuggestionRow) {
  dismissingId.value = s.id
  try {
    await apiFetch(`/api/ai/knowledge/suggestions/${s.id}/dismiss`, { method: 'POST' })
    items.value = items.value.filter(i => i.id !== s.id)
    if (reviewing.value?.id === s.id) reviewOpen.value = false
    showToast('已忽略。同一主題如果被問的次數翻倍，會再次出現', 'success')
  }
  catch {
    showToast('忽略失敗，請再試一次', 'error')
  }
  finally {
    dismissingId.value = null
  }
}

async function requestRefresh() {
  refreshing.value = true
  try {
    const res = await apiFetch<{ queued: boolean; retryAfterMinutes?: number }>(
      '/api/ai/knowledge/suggestions/refresh',
      { method: 'POST' },
    )
    if (res.queued) {
      scanRequested.value = true
      showToast('已排入重新掃描，約 10 分鐘內完成', 'success')
    }
    else {
      // 有最小間隔:這支分析會跑 AI,不能被連點
      showToast(`剛剛分析過了，請 ${res.retryAfterMinutes ?? 30} 分鐘後再試`, 'warning')
    }
  }
  catch {
    showToast('排入掃描失敗，請再試一次', 'error')
  }
  finally {
    refreshing.value = false
  }
}

onMounted(load)
</script>
