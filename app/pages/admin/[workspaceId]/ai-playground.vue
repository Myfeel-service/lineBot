<template>
  <AdminSplitLayout solo>
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="AI 客服"
        title="測試對話"
        caption="試答模式：以「真實 LINE 對話」方式測試 AI，不會影響正式對話"
        :help-topics="['ai-playground']"
      />
    </template>

    <template #editor-body>
      <div class="pg-body">
        <!-- ⛔ 還沒接 LINE 的人不講（`C-250`②）：「打開之後 LINE 上才會真的自動回」這句對他是提早了——
             他連 LINE 都還沒接，頁頂紅帶已經在講那件事；打造完落地第一眼這裡該只有「按送出」一件事 -->
        <el-alert
          v-if="aiDisabled && !onboardingIncomplete"
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
          <!-- 打造完落地（`C-250`②，示意頁 v80）：題目照他的店型先填好，這裡只講一件事——按送出。
               ⛔ 不再列通用的範例題（「退費要多久」）：他剛講完自己是哪一種店，給他一題別人的問題是倒退 -->
          <div v-if="!history.length && landingHint" class="pg-landing-hint">
            題目幫你填好了，<b>按「送出」看它怎麼回</b>。
          </div>
          <div v-else-if="!history.length" class="pg-empty">
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
                    <span class="badge badge-purple">觸發流程</span>
                    <span class="text-xs text-muted">{{ turn.result.scriptTrigger.mode === 'semantic' ? '看意思命中' : '關鍵字命中' }}</span>
                  </div>
                  <p class="pg-script-name">會啟動客服流程：<strong>{{ turn.result.scriptTrigger.name }}</strong></p>
                  <p class="text-muted">實際 LINE 對話會由這條客服流程接手（AI 不會介入）。這裡不模擬後續的多輪問答，請到「自動回應」頁編輯。</p>
                </div>

                <template v-else>
                <div class="pg-bubble-head">
                  <span :class="['badge', decisionBadge(turn.result)]">{{ decisionLabel(turn.result) }}</span>
                  <span v-if="turn.result.handoffReason" class="text-xs text-muted">{{ handoffReasonLabel(turn.result) }}</span>
                </div>

                <div v-if="turn.result.decision === 'answered'" class="pg-answer">
                  {{ turn.result.answer }}
                </div>
                <!-- 用到「等你看過」的卡（`C-250`③，示意頁 v80）：⛔ 不用綠（綠＝已經好了），用琥珀——
                     跟輪廓卡「我猜的」同一個意思（還沒確認過）。⭐ 他自己撞到「它讀懂了我的網站」，
                     看卡的動機就從「去做功課」變成「我要讓它這樣答」。紅線照舊：對客人只用點過頭的卡 -->
                <div v-if="turn.result.decision === 'answered' && draftUse(turn.result)" class="pg-draft-note">
                  <div class="pg-draft-note__t">{{ draftUse(turn.result) === 'all' ? '這句用的是還沒看過的卡' : '這句有用到還沒看過的卡' }}</div>
                  <div class="pg-draft-note__d">
                    <template v-if="draftPageName(turn.result)">出自你網站的「{{ draftPageName(turn.result) }}」。</template>在知識庫點頭之後，客人問才會這樣答。
                  </div>
                  <el-button size="small" type="primary" @click="goDrafts">去看這張卡 →</el-button>
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
                  <!-- 「命中 N 條」以前沒人解釋（`D-39` 08-28 列、`D-82` 補）：這是這一行裡
                       唯一看不懂又沒地方問的數字，而它正好回答「它到底有沒有資料可以答」。
                       ⓘ 沿用全後台共用的 .admin-unit-info（跟「則」旁邊那顆同一種），不另創樣式。 -->
                  <span class="pg-meta text-muted">
                    · 命中 {{ turn.result.sources.length }} 條
                    <el-tooltip
                      placement="top"
                      content="AI 從知識庫裡挑出這幾條最相關的知識，再據以回答。0 條＝知識庫裡沒有可用的資料，要回去補。按「展開詳情」看得到是哪幾條。"
                    >
                      <el-icon class="admin-unit-info"><InfoFilled /></el-icon>
                    </el-tooltip>
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

                <!-- 「再問它一題價格試試」（`C-250`②）：第一個「哇」之後的下一題——價格是知識卡才答得出來的題目，
                     ⭐ 他自己撞到「這題還答不出來」比被告知有用（`D-98`）。只掛在最新那一則、按過就收掉 -->
                <button
                  v-if="idx === latestAiIdx && priceAskText && !priceAskUsed"
                  type="button"
                  class="pg-try-price"
                  @click="askPrice"
                >
                  再問它一題價格試試
                </button>

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
          <!-- `data-tour="pg-input"`＝打造完落地導覽最後一步指的地方；走完導覽游標會放進來 -->
          <el-input
            ref="inputEl"
            v-model="query"
            data-tour="pg-input"
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
import { InfoFilled } from '@element-plus/icons-vue'
import {
  HANDOFF_REASON_LABELS,
  type AiAnswerResult,
  type AiSettingsDoc,
} from '~~/shared/types/ai-knowledge'

import type { StoreProfileDoc } from '~~/shared/types/store-profile'
import { storeBizWording } from '~~/shared/store-profile-biz'
import { splitProducts } from '~~/shared/store-profile-drafts'
import { LANDING_FROM_BUILD, markPlaygroundTried } from '~/utils/onboarding-landing'
import { useOnboardingEvents } from '~/composables/useOnboardingEvents'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { apiFetch, workspaceId } = useWorkspace()
const router = useRouter()
const route = useRoute()
const { showToast } = useAdminToast()
const { onboardingIncomplete } = useSetupStatus()

/**
 * 打造完「進入後台」落在這一頁（`?from=onboarding`，`C-250`②）。
 * ⚠️ **在 setup 就讀、存成常數**：小幫手掛載時會把 `from` 從網址拿掉（重新整理不重跑落地導覽），
 *    寫成 computed 的話那一下這一頁的狀態就跟著消失。
 */
const fromOnboarding = route.query.from === LANDING_FROM_BUILD
/** 題目是照他的店型幫他填好的（顯示虛線提示、不顯示通用範例題） */
const landingHint = ref(false)
/** 「再問它一題價格試試」要填進去的那一句（照型換：「牙齒矯正怎麼收費？」⛔ 不是「一瓶多少錢」） */
const priceAskText = ref('')
const priceAskUsed = ref(false)
const inputEl = ref<{ focus: () => void } | null>(null)
/** 幫他填好的那一題（紀錄用：他是直接送出、還是改了自己的） */
let prefilledQuestion = ''

/**
 * 開通步驟紀錄（`C-250`③）：⛔ **只記開帳那一趟的人**（剛打造完落地、或開通還沒做完），
 * 其他人天天在這裡測題目，全記下來是雜訊。一次進頁最多記前 5 題，⛔ 不記題目原文。
 */
const { track: trackOnboarding } = useOnboardingEvents({ workspaceId: () => workspaceId.value, flow: () => 'other' })
let onboardingSends = 0

async function prefillFromProfile() {
  try {
    const r = await apiFetch<{ profile: StoreProfileDoc }>('/api/store-profile')
    const w = storeBizWording(r.profile?.fields?.industry?.value ?? '')
    // ⚠️ 用共用的 splitProducts 拆：商品名裡的價格千分位逗號會把字串切壞（`D-92`）
    const first = splitProducts(r.profile?.fields?.products?.value ?? '')[0]?.trim()
    if (!query.value) {
      query.value = w.tryQuestion
      prefilledQuestion = w.tryQuestion
      landingHint.value = true
    }
    priceAskText.value = `${first || `你們的${w.noun}`}${w.priceAsk}`
  }
  catch { /* 拿不到輪廓就照舊的空狀態，⛔ 不猜一題 */ }
}

function askPrice() {
  priceAskUsed.value = true
  query.value = priceAskText.value
  inputEl.value?.focus()
}

/** 「等你看過」的卡住在哪一頁（sourceId → 頁名）；只有要講「出自哪一頁」時才去查 */
const draftPageNames = ref<Record<string, string>>({})
let draftNamesLoaded = false
async function loadDraftPageNames() {
  if (draftNamesLoaded) return
  draftNamesLoaded = true
  try {
    const r = await apiFetch<{ pages: Array<{ sourceId: string, name: string, url?: string }> }>('/api/ai/knowledge/drafts')
    // ⛔ 只收網站來的那幾頁（`D-109`）：請小幫手補的待審卡建在手寫資料底下、沒有網址，
    //    收進來的話畫面會說「出自你網站的『有沒有停車位』」——那張根本不是從網站來的
    draftPageNames.value = Object.fromEntries(r.pages.filter(p => !!p.url).map(p => [p.sourceId, p.name]))
  }
  catch { /* 查不到就不講頁名，其他照講 */ }
}
/** 這一題的來源裡有沒有等你看過的卡：全部都是／有一部分／沒有 */
function draftUse(r: AiResult): 'all' | 'some' | null {
  const n = r.sources.filter(s => s.draft).length
  if (!n) return null
  return n === r.sources.length ? 'all' : 'some'
}
function draftPageName(r: AiResult): string {
  const sid = r.sources.find(s => s.draft)?.sourceId
  return sid ? draftPageNames.value[sid] ?? '' : ''
}
function goDrafts() {
  void router.push(`/admin/${workspaceId.value}/knowledge/sources?drafts=1`)
}

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
  // 「上線之後」導覽的最後一步照這個決定要不要叫他來這裡問一題（`C-250`②）
  markPlaygroundTried(workspaceId.value)
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
    if (res.sources?.some(s => s.draft)) void loadDraftPageNames()
    if ((fromOnboarding || onboardingIncomplete.value) && onboardingSends < 5) {
      onboardingSends++
      trackOnboarding('playground_sent', {
        n: onboardingSends,
        fromOnboarding,
        // 幫他填的那題原封不動送出／按了「再問一題價格」／自己打的
        source: prefilledQuestion && trimmed === prefilledQuestion ? 'prefilled'
          : priceAskText.value && trimmed === priceAskText.value ? 'priceAsk'
          : 'own',
        decision: res.decision,
        // ⭐ 答案用到「等你看過」的卡了沒（`all`＝整題都靠那批卡答的）
        draft: draftUse(res) ?? 'none',
      })
    }
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
  // 帶 chunkId 過去；資料頁會反查所屬資料、自動選取並開啟該卡的編輯視窗。
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
  // 同監控頁「補知識」：資料頁自動開新增手寫視窗並預填。開新分頁保留測試對話。
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
  const q = String(route.query.q ?? '').trim()
  if (q) query.value = q
  if (fromOnboarding) void prefillFromProfile()
})
</script>
