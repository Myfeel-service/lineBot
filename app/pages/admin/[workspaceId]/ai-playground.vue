<template>
  <AdminSplitLayout solo>
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="AI 客服"
        title="測試對話"
        caption="試答模式：以「真實 LINE 對話」方式測試 AI，不會影響正式對話"
      />
    </template>

    <template #editor-body>
      <div class="pg-body">
        <el-alert
          v-if="aiDisabled"
          class="pg-disabled-alert"
          type="warning"
          show-icon
          :closable="false"
        >
          <template #title>
            AI 自動回覆目前為關閉狀態
          </template>
          <div>
            這裡是試答模式，仍可正常測試。覺得 OK 後請到
            <NuxtLink :to="`/admin/${workspaceId}/ai-settings`">AI 設定</NuxtLink>
            把「啟用 AI 自動回覆」打開，LINE 上才會真的自動回。
          </div>
        </el-alert>

        <!-- ── 對話歷史 ─────────────────────── -->
        <div ref="historyEl" class="pg-chat" data-tour="pg-chat">
          <div v-if="!history.length" class="pg-empty">
            <div class="pg-empty-badge">💬</div>
            <h3 class="pg-empty-title">輸入問題，看 AI 會怎麼回</h3>
            <p class="pg-empty-desc">
              AI 會用「真實 LINE 對話」的方式回應，遇到模糊問題會反問，<br>
              你可以點按鈕模擬客人回答。
            </p>
            <div class="pg-empty-suggest">
              <div class="pg-empty-suggest-label">試試這些問題</div>
              <button
                v-for="ex in exampleQuestions"
                :key="ex"
                type="button"
                class="pg-suggest-card"
                :disabled="running"
                @click="tryExample(ex)"
              >
                <span class="pg-suggest-text">{{ ex }}</span>
                <span class="pg-suggest-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </div>

          <template v-for="(turn, idx) in history" :key="idx">
            <!-- 客人訊息 -->
            <div v-if="turn.role === 'user'" class="pg-msg pg-msg--user">
              <div class="pg-bubble pg-bubble--user">
                {{ turn.text }}
              </div>
            </div>

            <!-- AI 訊息 -->
            <div v-else class="pg-msg pg-msg--ai">
              <div class="pg-bubble pg-bubble--ai">
                <!-- 腳本觸發：正式 LINE 會由腳本接手，不跑 AI -->
                <div v-if="turn.result.scriptTrigger" class="pg-script-trigger">
                  <div class="pg-bubble-head">
                    <span class="badge badge-purple">觸發腳本</span>
                    <span class="text-xs text-muted">{{ turn.result.scriptTrigger.mode === 'semantic' ? '看意思命中' : '關鍵字命中' }}</span>
                  </div>
                  <p class="pg-script-name">會啟動腳本：<strong>{{ turn.result.scriptTrigger.name }}</strong></p>
                  <p class="text-muted">實際 LINE 對話會由這條腳本接手（AI 不會介入）。playground 不模擬腳本後續的多輪問答，請到「腳本」頁編輯流程。</p>
                </div>

                <template v-else>
                <div class="pg-bubble-head">
                  <span :class="['badge', decisionBadge(turn.result)]">{{ decisionLabel(turn.result) }}</span>
                  <span v-if="turn.result.handoffReason" class="text-xs text-muted">{{ handoffReasonLabel(turn.result) }}</span>
                </div>

                <div v-if="turn.result.decision === 'answered'" class="pg-answer">
                  {{ turn.result.answer }}
                </div>
                <div v-else-if="turn.result.decision === 'disambiguate' && turn.result.disambiguation" class="pg-disambiguate">
                  <p class="pg-clarification">{{ turn.result.disambiguation.clarification }}</p>
                  <div class="pg-option-row">
                    <el-button
                      v-for="opt in turn.result.disambiguation.options"
                      :key="opt.chunkId"
                      size="small"
                      plain
                      :disabled="idx !== latestAiIdx || running"
                      @click="pickOption(opt.title)"
                    >
                      {{ opt.label || opt.title }}
                    </el-button>
                    <el-button
                      size="small"
                      plain
                      :disabled="idx !== latestAiIdx || running"
                      @click="pickOption('找真人')"
                    >
                      🙋 找真人
                    </el-button>
                  </div>
                  <p v-if="idx !== latestAiIdx" class="text-xs text-muted pg-options-note">
                    （已選過，無法再點）
                  </p>
                </div>
                <div v-else-if="turn.result.handoffReason === 'llm_error'" class="pg-llm-error">
                  <p><strong>AI 服務暫時失敗</strong></p>
                  <p class="text-muted">
                    通常是 AI 服務短暫過載，請按<strong>重試</strong>；若重試多次仍失敗，請聯絡系統管理員。
                  </p>
                  <p class="text-xs text-muted">
                    （給管理員：server log 搜 <code>[ai-answer] generateText failed</code> 或 <code>embedQuery failed</code>）
                  </p>
                  <div class="pg-llm-error-actions">
                    <el-button
                      v-if="idx === latestAiIdx"
                      size="small"
                      type="primary"
                      :disabled="running"
                      @click="retryLast"
                    >
                      重試上一題
                    </el-button>
                  </div>
                </div>
                <div v-else-if="turn.result.handoffReason === 'manual'" class="pg-skipped">
                  <p>AI 跳過此題。</p>
                  <p class="text-muted">
                    可能原因：query 為空、或 AI 流程被設定中斷。LINE 上不會回任何訊息給客人。
                  </p>
                </div>
                <div v-else class="pg-handoff-notice">
                  <p>本題會自動轉真人客服。</p>
                  <p
                    v-if="turn.result.handoffReason === 'no_grounding' || turn.result.handoffReason === 'low_confidence'"
                    class="text-muted pg-confirm-note"
                  >
                    實際 LINE 對話中，這種情況會先問客人「需要幫您轉接專員嗎？」並附按鈕，客人按「轉接專員」才真的轉接（這裡是試答，直接顯示判定結果）。
                  </p>
                  <template v-if="turn.result.handoffReason === 'no_grounding'">
                    <p class="text-muted">
                      知識庫沒有足夠相關內容。補一張對應的卡，回來再試一次就會生效。
                    </p>
                    <el-button size="small" type="primary" plain @click="goAddKnowledge(queryForTurn(idx))">
                      補這題的知識
                    </el-button>
                  </template>
                  <p v-else-if="turn.result.handoffReason === 'low_confidence'" class="text-muted">
                    AI 找到了卡但把握不足。可以調低信心門檻或補充更精準的卡。
                  </p>
                  <p v-else-if="turn.result.handoffReason === 'sensitive_topic'" class="text-muted">
                    命中敏感主題，依設定直接轉真人。
                  </p>
                  <p v-else-if="turn.result.handoffReason === 'quota_exceeded'" class="text-muted">
                    本月 token 用量已達上限，依設定全部轉真人。
                  </p>
                </div>

                <div class="pg-meta-row">
                  <span class="pg-meta">
                    信心：<strong>{{ pct(turn.result.confidence) }}</strong>
                  </span>
                  <span class="pg-meta text-muted">
                    （{{ relevantThresholdLabel(turn.result) }} {{ pct(relevantThreshold(turn.result)) }}）
                  </span>
                  <span class="pg-meta text-muted">
                    · 命中 {{ turn.result.sources.length }} 張卡
                  </span>
                  <el-button
                    v-if="turn.result.sources.length || turn.result.debugPrompt"
                    size="small"
                    text
                    class="pg-expand-toggle"
                    @click="turn.expanded = !turn.expanded"
                  >
                    {{ turn.expanded ? '收合詳情' : '展開詳情' }}
                  </el-button>
                </div>

                <div v-if="turn.expanded" class="pg-bubble-details">
                  <div v-if="turn.result.sources.length" class="pg-sources">
                    <div
                      v-for="(src, i) in turn.result.sources"
                      :key="src.chunkId"
                      class="pg-source-row"
                    >
                      <span class="pg-source-rank">#{{ i + 1 }}</span>
                      <span class="pg-source-title">{{ src.title }}</span>
                      <span class="pg-source-score">{{ src.similarity.toFixed(3) }}</span>
                      <el-button size="small" plain @click="goEditChunk(src.chunkId)">編輯</el-button>
                    </div>
                  </div>
                  <details v-if="turn.result.debugPrompt" class="pg-debug">
                    <summary>Debug：實際送給 LLM 的 prompt</summary>
                    <pre class="pg-debug-pre">{{ turn.result.debugPrompt }}</pre>
                  </details>
                </div>
                </template>
              </div>
            </div>
          </template>
        </div>

        <!-- ── 輸入區 ──────────────────────── -->
        <div class="pg-composer" data-tour="pg-composer">
          <el-input
            v-model="query"
            type="textarea"
            :rows="2"
            :maxlength="500"
            placeholder="例：請問退費要多久才會收到？（⌘+Enter 送出）"
            @keydown="onComposerKeydown"
          />
          <div class="pg-composer-actions">
            <el-button
              type="primary"
              :loading="running"
              :disabled="!query.trim()"
              @click="run"
            >
              {{ running ? 'AI 思考中⋯' : '送出' }}
            </el-button>
            <el-button
              v-if="history.length"
              plain
              :disabled="running"
              @click="resetConversation"
            >
              新對話
            </el-button>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import {
  HANDOFF_REASON_LABELS,
  type AiAnswerResult,
  type AiSettingsDoc,
} from '~~/shared/types/ai-knowledge'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { apiFetch, workspaceId } = useWorkspace()
const router = useRouter()
const { showToast } = useAdminToast()

type AiResult = AiAnswerResult & {
  debugPrompt?: string
  /** 有值代表這句在正式 LINE 會觸發腳本、不跑 AI */
  scriptTrigger?: { name: string; mode: 'keyword' | 'semantic' }
}
type UserTurn = { role: 'user'; text: string }
type AiTurn = { role: 'ai'; result: AiResult; expanded: boolean }
type Turn = UserTurn | AiTurn

const query = ref('')
const running = ref(false)
const history = ref<Turn[]>([])
const confidenceThreshold = ref(0.75)
const groundingThreshold = ref(0.7)
const aiDisabled = ref(false)
const historyEl = ref<HTMLElement | null>(null)

const latestAiIdx = computed(() => {
  for (let i = history.value.length - 1; i >= 0; i--) {
    if (history.value[i]!.role === 'ai') return i
  }
  return -1
})

function decisionLabel(r: AiResult) {
  if (r.decision === 'answered') return 'AI 回答'
  if (r.decision === 'disambiguate') return '反問澄清'
  if (r.handoffReason === 'llm_error') return 'AI 服務失敗'
  if (r.handoffReason === 'manual') return 'AI 跳過'
  return '轉真人'
}

function decisionBadge(r: AiResult) {
  if (r.decision === 'answered') return 'badge-green'
  if (r.decision === 'disambiguate') return 'badge-blue'
  if (r.handoffReason === 'llm_error') return 'badge-red'
  if (r.handoffReason === 'manual') return 'badge-gray'
  return 'badge-orange'
}

function handoffReasonLabel(r: AiResult) {
  return r.handoffReason ? HANDOFF_REASON_LABELS[r.handoffReason] ?? r.handoffReason : ''
}

function relevantThreshold(r: AiResult) {
  return r.handoffReason === 'no_grounding' ? groundingThreshold.value : confidenceThreshold.value
}

function relevantThresholdLabel(r: AiResult) {
  return r.handoffReason === 'no_grounding' ? '知識相關度門檻' : '信心門檻'
}

/** 信心/門檻對外一律用百分比呈現（0.75 → 75%），比原始小數好懂 */
function pct(n: number) {
  return `${Math.round(n * 100)}%`
}

async function scrollToBottom() {
  await nextTick()
  const el = historyEl.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 把目前畫面上的對話轉成 answerWithAi 吃的 history（最近 6 則、要有文字）。 */
function buildHistoryPayload(): Array<{ role: 'user' | 'bot'; text: string }> {
  return history.value
    .map((t: Turn) => t.role === 'user'
      ? { role: 'user' as const, text: t.text }
      : {
          role: 'bot' as const,
          text: t.result.decision === 'answered'
            ? t.result.answer
            : (t.result.decision === 'disambiguate' ? t.result.disambiguation?.clarification ?? '' : ''),
        })
    .filter((t: { role: 'user' | 'bot'; text: string }) => t.text.trim())
    .slice(-6)
}

async function send(text: string, opts: { skipDisambiguation?: boolean; isFollowup?: boolean; followupOf?: string } = {}) {
  const trimmed = text.trim()
  if (!trimmed) return
  // 帶入「本次提問之前」的對話脈絡，讓 playground 跟正式 LINE 一樣支援多輪追問
  const historyPayload = buildHistoryPayload()
  // 模擬正式環境的反問冷卻：上一個 AI 回合若是反問，這句就跳過反問（避免鬼打牆）。
  // 正式 LINE 用 disambiguation.cooldownMinutes 做時間冷卻，playground 用「連續反問」近似。
  const lastAi = [...history.value].reverse().find((t): t is AiTurn => t.role === 'ai')
  const autoSkipDisambiguation = lastAi?.result.decision === 'disambiguate'
  history.value.push({ role: 'user', text: trimmed })
  await scrollToBottom()
  running.value = true
  try {
    const res = await apiFetch<AiResult>('/api/ai/playground', {
      method: 'POST',
      body: {
        query: trimmed,
        history: historyPayload,
        skipDisambiguation: opts.skipDisambiguation === true || autoSkipDisambiguation,
        isFollowup: opts.isFollowup === true,
        followupOf: opts.followupOf,
      },
    })
    history.value.push({ role: 'ai', result: res, expanded: false })
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.message || '請求失敗', 'error')
    // 整個 HTTP 都失敗（playground API 本身回 5xx），跟 LLM 失敗同類顯示
    history.value.push({
      role: 'ai',
      result: {
        decision: 'handoff',
        answer: '',
        confidence: 0,
        sources: [],
        handoffReason: 'llm_error',
      },
      expanded: false,
    })
  }
  finally {
    running.value = false
    await scrollToBottom()
  }
}

function onComposerKeydown(evt: Event | KeyboardEvent) {
  // ⌘+Enter(mac)/ Ctrl+Enter(win)送出
  const e = evt as KeyboardEvent
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    run()
  }
}

async function run() {
  const text = query.value
  query.value = ''
  await send(text)
}

// 空狀態的範例問題：都是通用客服提問（不綁特定租戶/產品），點一下直接送出、馬上看 AI 怎麼回。
// 三題刻意涵蓋不同結果：一般問答、營業資訊、明確要真人 → 讓第一次用的人看到各種回應樣態。
const exampleQuestions = ['退費要多久才會收到？', '你們的營業時間是？', '我想找真人客服']

async function tryExample(q: string) {
  if (running.value) return
  await send(q)
}

async function pickOption(title: string) {
  // 模擬客人點按鈕：跟 LINE handler 一樣帶 skipDisambiguation + isFollowup，
  // 並帶上反問前的原始問題（最後一句 user 訊息），讓 AI 回答「選到的主題的原始問題」
  const lastUser = [...history.value].reverse().find((t): t is UserTurn => t.role === 'user')
  await send(title, { skipDisambiguation: true, isFollowup: true, followupOf: lastUser?.text })
}

async function retryLast() {
  // 找最後一個 user turn，把它再送一次（不寫進 history，直接重發 → 替換掉舊的 AI failure）
  let lastUserIdx = -1
  for (let i = history.value.length - 1; i >= 0; i--) {
    if (history.value[i]!.role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx < 0) return
  const lastUser = history.value[lastUserIdx] as UserTurn
  // 把失敗的 AI turn 移除（重試會產生新的）
  if (history.value.length > lastUserIdx + 1 && history.value[lastUserIdx + 1]!.role === 'ai') {
    history.value.splice(lastUserIdx + 1, 1)
  }
  // 也把 user turn 移除（send 會再 push 一次）
  history.value.splice(lastUserIdx, 1)
  await send(lastUser.text)
}

function resetConversation() {
  history.value = []
  query.value = ''
}

function goEditChunk(chunkId: string) {
  // 帶 chunkId 過去；來源頁會反查所屬來源、自動選取並開啟該卡的編輯視窗。
  // 開新分頁：整頁跳轉會弄丟這裡的整段測試對話，修完卡回來就無法接著驗證。
  const href = router.resolve(`/admin/${workspaceId.value}/knowledge/sources?chunkId=${encodeURIComponent(chunkId)}`).href
  window.open(href, '_blank')
}

/** 找出第 idx 個 AI 回合對應的客人提問（往前找最近的 user turn） */
function queryForTurn(idx: number): string {
  for (let i = idx - 1; i >= 0; i--) {
    const t = history.value[i]
    if (t?.role === 'user') return t.text
  }
  return ''
}

function goAddKnowledge(q: string) {
  // 同監控頁「補知識」：來源頁自動開新增手寫視窗並預填。開新分頁保留測試對話。
  const suffix = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
  const href = router.resolve(`/admin/${workspaceId.value}/knowledge/sources${suffix}`).href
  window.open(href, '_blank')
}

async function loadSettings() {
  try {
    const data = await apiFetch<AiSettingsDoc>('/api/ai/settings')
    confidenceThreshold.value = data.confidenceThreshold
    groundingThreshold.value = data.groundingThreshold
    aiDisabled.value = !data.enabled
  }
  catch { /* 忽略：拿不到就用預設 */ }
}

onMounted(() => {
  loadSettings()
  // 監控頁「▶ 重演」帶 ?q= 過來：預填輸入框，讓使用者按送出重演該題
  const q = String(useRoute().query.q ?? '').trim()
  if (q) query.value = q
})
</script>
