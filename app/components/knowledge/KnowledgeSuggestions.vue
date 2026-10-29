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
        <!-- 這個月 AI 讀對話到上限（`C-414`）：沒在分析，⛔ 不能講成「目前沒有」 -->
        <template v-else-if="budgetPaused">：這個月先不分析</template>
        <!-- 掃描失敗要說出來：不講的話標題是「目前沒有」，看起來像真的沒缺口 -->
        <template v-else-if="lastError">：上次分析沒跑成</template>
        <template v-else-if="!lastScanAtMs">：還沒分析過</template>
        <template v-else-if="gapEvents > 0">：還沒有同一類被問兩次的</template>
        <template v-else>：目前沒有</template>
      </span>
      <!-- 先停的時候不給「重新掃描」（`C-414`）：排程不會掃，按了只會說排進去了 -->
      <template v-if="!budgetPaused">
        <span v-if="scanRequested" class="kb-suggest-head__aside">已排入重新掃描，約 10 分鐘內完成</span>
        <el-button v-else-if="canEdit" link type="primary" size="small" class="kb-suggest-head__aside" :loading="refreshing" @click="requestRefresh">
          重新掃描
        </el-button>
      </template>
    </div>
    <p v-if="loadFailed" class="kb-suggest-hint">
      這一區的資料沒讀到，所以<strong>現在無法判斷有沒有要補的知識</strong>。重新整理頁面再看一次；一直這樣請告訴我們。
      <span v-if="loadError" class="text-xs text-muted">（{{ loadError }}）</span>
    </p>
    <!-- 先停的原因跟幾號恢復（`C-414`）：清單上已經有的照樣可以處理，只是不會再長新的 -->
    <p v-else-if="budgetPaused" class="kb-suggest-hint">{{ budgetPausedText }}</p>
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
        <!--
          三選一（`C-318`，2026-10-15 老闆拍板 D-126④）。以前只有「審核草稿」跟「忽略」：MYFEEL 36 筆只採用 2 筆、忽略 28 筆，
          忽略的大多是真缺口——不是沒用，是補起來太麻煩（草稿常是空的、要自己從頭寫標題＋內容＋問法＋標籤）。
          「寫一句答案」打開同一個「補一條知識」小視窗（一兩句→AI 整理→加入就上線）；
          「交給真人就好」＝這類問題本來就該真人回（查訂單、議價）；「不用管」＝不是缺口。後兩個都是整組拿掉，原因記下來。
        -->
        <div v-if="canEdit" class="kb-suggest-item__actions kb-suggest-item__actions--three">
          <el-button size="small" type="primary" @click="openAddOne(s)">寫一句答案</el-button>
          <el-button
            size="small"
            :loading="dismissing?.id === s.id && dismissing.reason === 'handoff'"
            :disabled="!!dismissing"
            @click="dismiss(s, 'handoff')"
          >
            交給真人就好
          </el-button>
          <el-button
            size="small"
            :loading="dismissing?.id === s.id && dismissing.reason === 'ignore'"
            :disabled="!!dismissing"
            @click="dismiss(s, 'ignore')"
          >
            不用管
          </el-button>
        </div>
      </div>
    </div>

    <!--
      `C-318`：原本的「審核草稿」大視窗（標題／內容／問法／標籤四格）換成「補一條知識」小視窗。
      AI 先擬好的草稿有內容就當成一開始的預覽（「AI 先擬好的」），他也可以自己打一兩句再按「AI 幫我整理」。
      一題以上的組照舊勾「這一條回答了哪幾題？」（`C-311`，沒勾的留在清單上）。
    -->
    <KnowledgeAddOneDialog
      v-model:open="addOneOpen"
      :suggestion="addOneSuggestion"
      @created="onCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { MagicStick } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { useAdminToast } from '~~/app/composables/useAdminToast'
import type { KnowledgeSuggestionDraft } from '~~/shared/types/ai-knowledge'
import { aiBudgetMessage } from '~~/shared/ai-budget'
import { apiErrorText } from '~/utils/api-error-text'
import { suggestionTopicLabel } from '~/utils/kb-suggestion-label'
import { defaultAnsweredQueries } from '~/utils/kb-suggestion-answered'
import type { AddOneCreated, AddOneSuggestion } from '~/utils/kb-add-one'

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

/** 「交給真人就好」／「不用管」（`C-318`）：一樣是整組拿掉，原因記下來（dismiss 端點收 reason） */
type DismissReason = 'handoff' | 'ignore'

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
/** 正在拿掉哪一筆、按的是哪一顆（兩顆都會整組拿掉，轉圈要轉在按下去的那一顆） */
const dismissing = ref<{ id: string; reason: DismissReason } | null>(null)

const addOneOpen = ref(false)
const addOneSuggestion = ref<AddOneSuggestion | null>(null)

const lastError = ref('')
/** 這個月 AI 讀對話到上限、整理答不出來的問題先停（`C-414`，伺服器即時查的） */
const budgetPaused = ref(false)
const budgetPausedText = computed(() => {
  const m = aiBudgetMessage('background')
  return `${m.title}。${m.body}`
})

/** 這一組全部的客人原句（`C-311`）：伺服器還沒給 queries（舊版）就退回樣本句 */
const groupQueries = (s: SuggestionRow) => (s.queries?.length ? s.queries : s.sampleQueries)

// 載入完成與採用/忽略後都會換新陣列 → 每次變動都把最新數字報給父頁面
watch(items, v => emit('count', v.length))

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
      scan: { lastScanAtMs: number; requested: boolean; lastError: string; lastScanGapEvents: number; budgetPaused?: boolean }
    }>('/api/ai/knowledge/suggestions')
    items.value = res.items ?? []
    loadFailed.value = false
    lastError.value = res.scan?.lastError ?? ''
    budgetPaused.value = res.scan?.budgetPaused === true
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

/**
 * 「寫一句答案」（`C-318`）：打開「補一條知識」小視窗（建議那條路）。
 * 預設勾哪幾題照 `C-311` 的 defaultAnsweredQueries：第三個參數是「標題欄會填的字」——草稿標題，沒有草稿就是主題名，
 * 而主題名常就是其中一題的原句（正式站小滑手那組主題＝第 3 題「只能沖義式嗎」）。⛔ 不預設全勾（理由見那支）。
 * 草稿有內容就交給視窗當「AI 先擬好的」預覽；草稿常是空的（知識庫本來就沒答案才會答不出來），那就等他自己打一兩句。
 */
function openAddOne(s: SuggestionRow) {
  const qs = groupQueries(s)
  const title = s.draft?.title ?? s.topic
  addOneSuggestion.value = {
    id: s.id,
    queries: [...qs],
    answeredDefault: qs.length > 1 ? defaultAnsweredQueries(qs, s.draft?.questions, title) : [...qs.slice(0, 1)],
    draft: s.draft,
  }
  addOneOpen.value = true
}

/** 加好了（提示視窗自己講過了）：只回答其中幾題的那筆還在、伺服器重算了次數也換了名字——重讀清單才對得上（不在這裡自己猜） */
async function onCreated(p: AddOneCreated) {
  const id = addOneSuggestion.value?.id
  if ((p.remainingQuestions ?? 0) > 0) await load()
  else if (id) items.value = items.value.filter(i => i.id !== id)
  emit('accepted')
}

/**
 * 「交給真人就好」／「不用管」（`C-318`）：都是整組拿掉，原因記下來（dismiss 收 reason）。
 * 一組有好幾題時先講清楚會一起拿掉（`C-311`：「寫一句答案」那邊是可以只回答其中幾題的，不講的話容易以為這裡也是）。
 */
async function dismiss(s: SuggestionRow, reason: DismissReason) {
  if (dismissing.value) return
  const n = groupQueries(s).length
  if (n > 1) {
    try {
      await ElMessageBox.confirm(
        `這一組的 ${n} 題都不再列。`,
        reason === 'handoff' ? '這一組都交給真人？' : '這一組都不用管？',
        { confirmButtonText: '好', cancelButtonText: '取消', type: 'warning' },
      )
    }
    catch {
      return
    }
  }
  dismissing.value = { id: s.id, reason }
  try {
    await apiFetch(`/api/ai/knowledge/suggestions/${encodeURIComponent(s.id)}/dismiss`, { method: 'POST', body: { reason } })
    items.value = items.value.filter(i => i.id !== s.id)
    showToast(reason === 'handoff' ? '好，這類問題交給真人' : '已略過', 'success')
  }
  catch (err) {
    showToast(apiErrorText(err, '沒改成，請再試一次'), 'error')
  }
  finally {
    dismissing.value = null
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
