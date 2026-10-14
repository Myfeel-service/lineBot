<template>
  <!-- 建議收件匣:系統從「客人問了但 AI 答不出」的真實對話整理主題、能擬就擬草稿（常常是空的：知識庫本來就沒有答案），店家寫上答案採用 -->
  <!-- 只要載入完就顯示（不等第一次掃描）:整塊藏起來會連「重新掃描」按鈕都看不到,
       從未掃描過的工作區就沒有任何方法觸發第一次掃描。 -->
  <div v-if="loaded" class="kb-suggest" data-tour="kb-suggest">
    <!-- 沒建議是最常見的狀態:結論直接寫進標題那一行,不佔五行解釋掃描機制。
         「沒有建議」有兩種完全不同的意思,講錯就是騙人:
         (a) 客人問的 AI 都答得出來
         (b) 有人被問倒了,只是同一類還沒被問到兩次(門檻)——實測 8/04 就是這種:
             12 位客人沒被答到,畫面卻說「都答得出來」。 -->
    <!--
      `C-314`（老闆 10-14「只呈現需要的東西」）：標題直接講這一區是什麼——「客人問了、AI 答不出來（N）」。
      拿掉標題下那一行（「從真實對話整理，草稿已擬好，審一眼就能用」：標題已經講了來源，
      而且草稿常常是空的——知識庫裡本來就沒有答案，才會答不出來——「審一眼就能用」是多承諾）；
      拿掉「上次分析：N 天前」（沒有人要拿它做什麼），「重新掃描」縮成標題右邊一個小連結。
      讀不到、上次分析失敗、只被問過一次這三種照舊要講（下一步不一樣，見下面）。
    -->
    <div class="kb-suggest-head">
      <el-icon class="kb-suggest-icon"><MagicStick /></el-icon>
      <span class="kb-suggest-head__title">
        <strong>客人問了、AI 答不出來</strong>
        <template v-if="items.length">（{{ items.length }}）</template>
        <!-- ⛔ 讀不到必須排在所有「沒有建議」的說法之前(`D-41` 死路②):
             退成「還沒分析過」的話,壞掉跟真的沒缺口在畫面上完全一樣 -->
        <template v-else-if="loadFailed">：讀不到（不是沒有）</template>
        <!-- 掃描失敗要說出來：不講的話標題是「目前沒有」，看起來像真的沒缺口 -->
        <template v-else-if="lastError">：上次分析沒跑成</template>
        <template v-else-if="!lastScanAtMs">：還沒分析過</template>
        <template v-else-if="gapEvents > 0">：還沒有同一類被問兩次的</template>
        <template v-else>：目前沒有</template>
      </span>
      <span v-if="scanRequested" class="kb-suggest-head__aside">已排入重新掃描，約 10 分鐘內完成</span>
      <el-button v-else-if="canEdit" link type="primary" size="small" class="kb-suggest-head__aside" :loading="refreshing" @click="requestRefresh">
        重新掃描
      </el-button>
    </div>
    <p v-if="loadFailed" class="kb-suggest-hint">
      這一區的資料沒讀到，所以<strong>現在無法判斷有沒有要補的知識</strong>。重新整理頁面再看一次；一直這樣請告訴我們。
      <span v-if="loadError" class="text-xs text-muted">（{{ loadError }}）</span>
    </p>
    <!-- 有清單時標題講的是條數，上次分析失敗只能在這裡講（沒清單時標題已經講了） -->
    <p v-else-if="lastError && items.length" class="kb-suggest-hint">上次分析失敗了，可以再按一次「重新掃描」。</p>
    <p v-else-if="!items.length && !lastError && lastScanAtMs && gapEvents > 0" class="kb-suggest-hint">
      最近 30 天有 <strong>{{ gapEvents }}</strong> 題 AI 答不出來，想先補的，到 <NuxtLink :to="`/admin/${workspaceId}/ai-usage`">AI 表現</NuxtLink> 的案例清單。
    </p>

    <div v-if="items.length" class="kb-suggest-list">
      <div v-for="s in items" :key="s.id" class="kb-suggest-item">
        <div class="kb-suggest-item__main">
          <!--
            主題名（`D-124` 新手走查）：以前直接秀 s.topic，而 AI 還沒擬到草稿的那幾筆，topic 是客人原句的前 12 字
            （「您好，請問，小耳記，go」）——新手看不懂這是什麼。有草稿就用草稿的標題；真的還沒有，就照實標成「客人問」的引號句。
          -->
          <span class="kb-suggest-item__topic">
            <template v-if="topicLabel(s).quoted"><span class="kb-suggest-item__quote-tag">客人問</span>「{{ topicLabel(s).text }}」</template>
            <template v-else>{{ topicLabel(s).text }}</template>
          </span>
          <!-- sampled = 事件多到撞掃描上限,次數是低估值 → 說「至少」而不是印成實數。
               `C-314`：拿掉「30 天內」——每一筆都一樣，講一次都嫌多 -->
          <span class="kb-suggest-item__count">{{ s.sampled ? '至少' : '' }}被問 {{ s.eventCount }} 次</span>
        </div>
        <div v-if="canEdit" class="kb-suggest-item__actions">
          <el-button size="small" type="primary" plain @click="openReview(s)">審核草稿</el-button>
          <el-button size="small" text :loading="dismissingId === s.id" @click="dismiss(s)">忽略</el-button>
        </div>
      </div>
    </div>

    <!-- 審核草稿:可改可直接採用;含佔位符(知識庫查不到的事實)要先補完 -->
    <el-dialog
      v-model="reviewOpen"
      title="審核知識草稿"
      width="620px"
      :close-on-click-modal="false"
      append-to-body
    >
      <template v-if="reviewing">
        <!--
          `C-311`：同一組常是同一個產品的不同問題（「小滑手」那組：哪一國做的／只能沖義式嗎／寬深高…）。
          以前寫一條回答其中一題、按採用，整組消失，其他題目沒人回答。一題以上就讓他勾這一條回答了哪幾題，
          沒勾的留在清單上。這份勾選清單取代原本的「客人這樣問」，同樣的題目不列兩次；預設勾哪幾題見 defaultAnsweredQueries。
        -->
        <div class="kb-suggest-queries">
          <template v-if="isMulti">
            <div class="kb-suggest-queries__head">
              <span class="kb-suggest-queries__label">這一條回答了哪幾題？</span>
              <el-checkbox
                v-if="reviewQueries.length > 2"
                :model-value="allTicked"
                :indeterminate="someTicked"
                @change="toggleAll"
              >
                全部
              </el-checkbox>
            </div>
            <el-checkbox-group v-model="answeredModel" class="kb-suggest-queries__checks">
              <el-checkbox v-for="q in reviewQueries" :key="q" :value="q">「{{ q }}」</el-checkbox>
            </el-checkbox-group>
            <p class="kb-suggest-queries__note">沒勾的會留在清單上，之後再補。</p>
          </template>
          <template v-else>
            <span class="kb-suggest-queries__label">客人這樣問（30 天內 {{ reviewing.eventCount }} 次）</span>
            <ul>
              <li v-for="(q, i) in reviewing.sampleQueries" :key="i">「{{ q }}」</li>
            </ul>
          </template>
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
            <el-input v-model="form.title" maxlength="100" show-word-limit placeholder="這一條回答什麼，例：運費與到貨時間" />
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
          <el-form-item label="客人可能怎麼問（會幫 AI 更容易找到這一條）">
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
              :disabled="!form.title.trim() || !form.content.trim() || draftBlanks > 0 || noneTicked"
              @click="accept"
            >
              {{ draftBlanks > 0 ? `還有 ${draftBlanks} 個空格要補` : noneTicked ? '至少勾一題' : '採用並學習' }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { MagicStick } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { useAdminToast } from '~~/app/composables/useAdminToast'
import { countKnowledgeDraftBlanks, type KnowledgeSuggestionDraft } from '~~/shared/types/ai-knowledge'
import { suggestionTopicLabel } from '~/utils/kb-suggestion-label'
import { defaultAnsweredQueries, syncTickedQuestions } from '~/utils/kb-suggestion-answered'

interface SuggestionRow {
  id: string
  topic: string
  /** topic 是客人原句（伺服器判好的，見 suggestionTopicLabel） */
  topicIsRaw?: boolean
  eventCount: number
  /** 次數是取樣值（事件撞到掃描上限）→ 顯示「至少 N 次」 */
  sampled: boolean
  sampleQueries: string[]
  /** 這一組全部的客人原句（最多 30 條，`C-311`）：勾「這一條回答了哪幾題」用 */
  queries?: string[]
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
  /** 沒勾、還留在清單上的題數（`C-311`；整組採用＝0） */
  remainingQuestions?: number
}

const emit = defineEmits<{
  /** 採用成功(知識庫多了一個 manual 資料),父頁面要重載資料列表 */
  (e: 'accepted'): void
  /** 待處理建議數:父頁面側欄的「工作台入口」要顯示數字 */
  (e: 'count', n: number): void
}>()

const { apiFetch, can, workspaceId } = useWorkspace()
const { showToast } = useAdminToast()

const canEdit = computed(() => can('knowledge.write'))

/** 列表上的主題名（`D-124`）：規則與理由在 utils/kb-suggestion-label（有測試） */
const topicLabel = (s: SuggestionRow) => suggestionTopicLabel(s)

const loaded = ref(false)
/**
 * 這一區的資料「讀不到」（`D-41` 死路②）。與 lastError（＝掃描本身失敗）是兩件事：
 * lastError 是後端有回應、但上次掃描失敗；loadFailed 是**連回應都沒拿到**。
 */
const loadFailed = ref(false)
const loadError = ref('')
const items = ref<SuggestionRow[]>([])
const lastScanAtMs = ref(0)
/** 上次掃描窗口內「AI 答不出來」的事件數:用來分辨「沒缺口」與「有缺口但還沒重複」 */
const gapEvents = ref(0)
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

/** 這一組全部的客人原句（`C-311`）：伺服器還沒給 queries（舊版）就退回樣本句 */
const groupQueries = (s: SuggestionRow) => (s.queries?.length ? s.queries : s.sampleQueries)

/**
 * 「這一條回答了哪幾題？」（`C-311`）。只有一題的組照舊（沒有可選的）；一題以上才出現勾選清單。
 * 勾選一變，「客人可能怎麼問」跟著變（規則見 syncTickedQuestions）——所以 v-model 綁的是這個可寫 computed，
 * 不用 watch：watch 在開下一筆時也會觸發，會拿上一筆的勾選去改這一筆的問法。
 */
const reviewQueries = computed(() => (reviewing.value ? groupQueries(reviewing.value) : []))
const isMulti = computed(() => reviewQueries.value.length > 1)
const answered = ref<string[]>([])
const answeredModel = computed<string[]>({
  get: () => answered.value,
  set: (next) => {
    form.value.questions = syncTickedQuestions(form.value.questions, answered.value, next)
    answered.value = next
  },
})
const allTicked = computed(() => answered.value.length === reviewQueries.value.length)
const someTicked = computed(() => answered.value.length > 0 && !allTicked.value)
/** 一題都沒勾＝這一條沒回答任何一題，採用按鈕擋下（伺服器也會 400） */
const noneTicked = computed(() => isMulti.value && !answered.value.length)
function toggleAll(v: unknown) {
  answeredModel.value = v ? [...reviewQueries.value] : []
}

// 載入完成與採用/忽略後都會換新陣列 → 每次變動都把最新數字報給父頁面
watch(items, v => emit('count', v.length))

/**
 * 佔位符即時計數:使用者在彈窗補完空格,警示要跟著消失。
 * 用 shared 的同一支正則——各寫一份的話,後端擋下採用時前端卻顯示「草稿乾淨」,
 * 使用者會收到 400 卻看不出哪裡要補。
 */
const draftBlanks = computed(() => countKnowledgeDraftBlanks(form.value.content))

/*
 * `C-314`：底下那一行（「上次分析：N 天前」／「尚未分析」／「讀不到分析結果」）拿掉了——
 * 時間沒有人要拿來做什麼；另外兩種跟標題講的是同一件事。還要講的（排入掃描了、上次失敗）搬到標題那一行與標題下面。
 */

async function load() {
  loadFailed.value = false
  loadError.value = ''
  try {
    const res = await apiFetch<{
      items: SuggestionRow[]
      scan: { lastScanAtMs: number; requested: boolean; lastError: string; lastScanGapEvents: number }
    }>('/api/ai/knowledge/suggestions')
    items.value = res.items ?? []
    loadFailed.value = false
    lastError.value = res.scan?.lastError ?? ''
    lastScanAtMs.value = res.scan?.lastScanAtMs ?? 0
    gapEvents.value = res.scan?.lastScanGapEvents ?? 0
    scanRequested.value = !!res.scan?.requested
  }
  catch (err: any) {
    /**
     * ⛔ 載入失敗 ≠ 沒有建議（`D-41` 死路②，2026-09-03 修）。
     *
     * 原本這裡只把清單清空、什麼都不說，於是畫面顯示「尚未分析」——
     * **API 掛掉跟「真的還沒分析過」長得一模一樣**。第一次來的人會以為功能還沒開始跑，
     * 而實際上是壞了；已經在用的人會以為知識庫沒缺口，因此不去補。
     * 這是本專案第四次同款的「查不到＝沒問題」（見記憶 feedback_absence_claims_need_verification）。
     * 三種狀態要分得出來：有建議／真的沒有／讀不到。
     */
    items.value = []
    loadFailed.value = true
    loadError.value = String(
      err?.data?.statusMessage || err?.statusMessage || err?.message || '',
    ).slice(0, 160)
  }
  finally {
    loaded.value = true
  }
}

function openReview(s: SuggestionRow) {
  reviewing.value = s
  const qs = groupQueries(s)
  const multi = qs.length > 1
  // 標題欄填什麼，預設就勾那一題：沒有草稿時填的是主題名，而主題名常就是其中一題的原句
  //（正式站小滑手那組主題＝第 3 題「只能沖義式嗎」）——兩邊不一致會建出標題跟題目對不上的一條
  const title = s.draft?.title ?? s.topic
  const ticked = multi ? defaultAnsweredQueries(qs, s.draft?.questions, title) : []
  answered.value = ticked
  form.value = {
    title,
    content: s.draft?.content ?? '',
    tags: [...(s.draft?.tags ?? [])],
    // 一題以上（`C-311`）：問法＝AI 擬的＋預設勾的客人原句。⛔ 沒有草稿時不再拿前 3 句客人原句當問法——
    // 那會把沒勾（＝這一條沒回答）的題目也寫進這一條
    questions: multi
      ? syncTickedQuestions(s.draft?.questions ?? [], [], ticked)
      : (s.draft?.questions?.length ? [...s.draft.questions] : [...s.sampleQueries.slice(0, 3)]),
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
        // `C-311`：勾了哪幾題（照清單順序）。只有一題的組不帶＝整組採用，跟以前一樣
        ...(isMulti.value ? { answeredQueries: reviewQueries.value.filter(q => answered.value.includes(q)) } : {}),
      },
    })
    reviewOpen.value = false
    const left = res.remainingQuestions ?? 0
    if (left > 0) {
      // 沒勾的留在同一筆、伺服器重算了次數也換了名字——重讀清單才對得上（不在這裡自己猜）
      await load()
    }
    else {
      items.value = items.value.filter(i => i.id !== s.id)
    }

    // 回饋要講清楚三件事:學會了沒、試答結果、順手銷了幾筆案例；只回答其中幾題的再講沒勾的去哪了（`C-311`）
    const resolvedNote = res.resolvedConversations > 0 ? `，並把 ${res.resolvedConversations} 筆監控頁案例標為已處理` : ''
    const leftNote = left > 0 ? `。沒勾的 ${left} 題還在清單上` : ''
    if (res.status !== 'indexed') {
      showToast(`知識已建立，但 AI 學習失敗——請到知識上按「重新學習」${leftNote}`, 'error')
    }
    else if (res.verify?.decision === 'answered') {
      // 不印相關度分數:對商家沒有意義,只會讓人以為那個數字要達到某個標準
      showToast(`已學會！剛才用客人的問法試問過，AI 答得出來了${resolvedNote}${leftNote}`, 'success')
    }
    else {
      // 卡建好了但試答沒答出來＝還沒真的解決,用警示色(不是綠色成功)
      showToast(`知識已建立${resolvedNote}，但試答仍答不出來，建議到「測試對話」確認${leftNote}`, 'warning')
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
  // `C-311`：忽略照舊是整組。一組有好幾題時先講清楚會一起拿掉——審核視窗裡有勾選清單，
  // 不講的話容易以為只略過沒勾的那幾題
  const n = groupQueries(s).length
  if (n > 1) {
    try {
      await ElMessageBox.confirm(
        `這一組的 ${n} 題會全部從清單拿掉。`,
        '忽略這個主題？',
        { confirmButtonText: '全部忽略', cancelButtonText: '取消', type: 'warning' },
      )
    }
    catch {
      return
    }
  }
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
