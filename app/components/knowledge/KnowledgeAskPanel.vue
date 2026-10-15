<template>
  <!--
    知識庫頁右邊「問 AI 一題」（`C-315`，2026-10-15 老闆拍板 D-126②，示意頁 RhjGQXbdZhqiXpXuM3Vjei ①②）。
    打一句客人會問的話，馬上看到 AI 怎麼答、用了哪幾條；答錯了當場「寫一句正確答案」。
    用的是測試對話那一支（/api/ai/playground）：不寫對話紀錄、不扣額度，只記花掉的 AI 用量（測試那一格）。
    寬度不寫死，放在哪一欄、多寬由頁面決定；高度吃滿父層（父層給高度，中間那段才會自己捲）。
  -->
  <section class="kb-ask" data-tour="kb-ask">
    <header class="kb-ask__head">
      <h3 class="kb-ask__title">問 AI 一題</h3>
      <p class="kb-ask__sub">不會傳給客人</p>
    </header>

    <div v-if="turns.length" ref="logEl" class="kb-ask__log">
      <div v-for="(t, idx) in turns" :key="t.id" class="kb-ask__turn">
        <div class="kb-ask__bubble kb-ask__bubble--cust">{{ t.text }}</div>

        <div v-if="t.pending" class="kb-ask__bubble kb-ask__bubble--ai is-muted">AI 思考中⋯</div>

        <!-- 這支 API 本身沒回來（斷線、逾時）：跟知識沒關係，講原因＋再問一次 -->
        <div v-else-if="t.error" class="kb-ask__bubble kb-ask__bubble--ai is-error">
          <p class="kb-ask__line">沒問成：{{ t.error }}</p>
          <el-button link type="primary" size="small" :disabled="running" @click="retry(t)">再問一次</el-button>
        </div>

        <template v-else-if="t.view">
          <!-- 答得出來 -->
          <template v-if="t.view.kind === 'answer'">
            <div class="kb-ask__bubble kb-ask__bubble--ai">{{ t.view.answer }}</div>
            <div v-if="t.view.sources.length" class="kb-ask__used">
              <span>用了這 {{ t.view.sources.length }} 條：</span>
              <button
                v-for="row in t.view.sources"
                :key="row.chunkId"
                type="button"
                class="kb-ask__src"
                @click="emit('open-chunk', { chunkId: row.chunkId, sourceId: row.sourceId })"
              >
                <span class="kb-ask__cite">{{ row.n }}</span>
                <span class="kb-ask__src-title">{{ row.title }}</span>
                <span v-if="sourceLabel(row)" class="kb-ask__src-name">· {{ sourceLabel(row) }}</span>
                <span v-if="row.draft" class="kb-ask__src-draft">（還沒上線）</span>
              </button>
              <!-- 全部都是「等你看過」的（`C-250`③）：試答讀得到、正式回客人不會用——不講的話他會以為已經會答了 -->
              <span v-if="t.view.draftOnly" class="kb-ask__src-draft">客人現在問還不會這樣答</span>
            </div>
          </template>

          <!-- 先反問客人是指哪一個：照 LINE 上的樣子列選項，點一個看接下來怎麼答（只有最新那題點得到） -->
          <div v-else-if="t.view.kind === 'ask'" class="kb-ask__bubble kb-ask__bubble--ai">
            <p class="kb-ask__line">{{ t.view.clarification }}</p>
            <div class="kb-ask__options">
              <el-button
                v-for="opt in t.view.options"
                :key="opt.chunkId || opt.text"
                size="small"
                plain
                :disabled="idx !== turns.length - 1 || running"
                @click="pickOption(t, opt.text)"
              >
                {{ opt.text }}
              </el-button>
            </div>
          </div>

          <!-- 轉真人：講原因＋客人實際會收到什麼（信心不足／沒有資料那幾種是先問要不要轉，⛔ 不說成直接轉） -->
          <div v-else-if="t.view.kind === 'handoff'" class="kb-ask__bubble kb-ask__bubble--ai">
            <p class="kb-ask__line kb-ask__line--strong">{{ t.view.why }}</p>
            <p class="kb-ask__line is-muted">{{ t.view.customerGets }}</p>
            <el-button
              v-if="t.view.canAddOne && canAddKnowledge"
              class="kb-ask__fix-main"
              size="small"
              type="primary"
              plain
              @click="emit('add-one', { question: t.question })"
            >
              寫一句正確答案
            </el-button>
          </div>

          <div v-else-if="t.view.kind === 'script'" class="kb-ask__bubble kb-ask__bubble--ai is-muted">
            這句會交給自動回應「{{ t.view.name }}」，AI 不會回。
          </div>

          <div v-else-if="t.view.kind === 'retry'" class="kb-ask__bubble kb-ask__bubble--ai is-error">
            <p class="kb-ask__line">{{ t.view.why }}</p>
            <el-button link type="primary" size="small" :disabled="running" @click="retry(t)">再問一次</el-button>
          </div>

          <div v-else class="kb-ask__bubble kb-ask__bubble--ai is-muted">AI 跳過這題，客人不會收到回覆。</div>

          <!-- 答錯了當場補（`C-317` 的小視窗由頁面打開）。轉真人那幾種上面已經有主要按鈕，不再擺第二顆 -->
          <el-button
            v-if="canAddKnowledge && fixLink(t)"
            class="kb-ask__fix"
            link
            type="primary"
            size="small"
            @click="emit('add-one', { question: t.question })"
          >
            答得不對？寫一句正確答案
          </el-button>
        </template>
      </div>
    </div>

    <footer class="kb-ask__foot">
      <el-input
        v-model="query"
        :maxlength="500"
        :disabled="!canAsk"
        :placeholder="canAsk ? '打一句客人會問的話…' : '你的帳號不能試問'"
        @keydown.enter="onEnter"
      />
      <el-button type="primary" :loading="running" :disabled="!canAsk || !query.trim()" @click="ask">
        送出
      </el-button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { apiErrorText } from '~/utils/api-error-text'
import {
  askSourceLabel,
  askView,
  keepRecentTurns,
  type AskResult,
  type AskSourceRow,
  type AskView,
} from '~/utils/kb-ask-result'

const props = withDefaults(defineProps<{
  /**
   * sourceId → 資料名（「用了這 N 條」後面的「· 哪一份」）。頁面手上本來就有資料清單，傳進來就不再查一次；
   * 沒傳（undefined）才自己去讀一次 /api/ai/sources/list。
   */
  sourceNames?: Record<string, string>
  /** 中間現在打開的那一份：用到它的那幾條標「這一份」 */
  currentSourceId?: string | null
}>(), {
  sourceNames: undefined,
  currentSourceId: null,
})

const emit = defineEmits<{
  (e: 'open-chunk', payload: { chunkId: string, sourceId: string | null }): void
  (e: 'add-one', payload: { question: string }): void
}>()

const { apiFetch, can } = useWorkspace()
const canAsk = computed(() => can('playground.use'))
/** 「寫一句正確答案」打的是 /api/ai/knowledge/create（或建議的 accept），兩支都是 knowledge.write（`G-109`：照端點讀權限表） */
const canAddKnowledge = computed(() => can('knowledge.write'))

interface Turn {
  id: number
  /** 泡泡上的那句（點反問選項時是選項的字） */
  text: string
  /** 「寫一句正確答案」要帶的客人問題：點反問選項的那一輪＝原本那一題 */
  question: string
  pending: boolean
  error: string
  view: AskView | null
  /** 重送用（再問一次） */
  req: { query: string, followupOf?: string, history?: Array<{ role: 'user' | 'bot', text: string }> }
}

const query = ref('')
const running = ref(false)
const turns = ref<Turn[]>([])
const logEl = ref<HTMLElement | null>(null)
let nextId = 1

const fetchedNames = ref<Record<string, string> | null>(null)
let namesRequested = false
const names = computed(() => props.sourceNames ?? fetchedNames.value)

function sourceLabel(row: AskSourceRow): string {
  return askSourceLabel(row, names.value, props.currentSourceId)
}

/** 答得出來／反問的那幾種下面掛一行連結；招呼語、自動回應、跳過、服務失敗不掛（補知識沒有用） */
function fixLink(t: Turn): boolean {
  const v = t.view
  return !!v && (v.kind === 'answer' || v.kind === 'ask') && v.canAddOne
}

async function ensureNames(r: AskResult) {
  if (props.sourceNames || namesRequested) return
  if (!r.sources?.some(s => s.sourceId)) return
  namesRequested = true
  try {
    const res = await apiFetch<{ items: Array<{ id: string, name: string }> }>('/api/ai/sources/list')
    fetchedNames.value = Object.fromEntries((res.items ?? []).map(s => [s.id, s.name]))
  }
  catch {
    // 查不到名字就只列標題（askSourceLabel 查不到不講、⛔ 不猜）；下一題再試一次
    namesRequested = false
  }
}

async function scrollToBottom() {
  await nextTick()
  const el = logEl.value
  if (el) el.scrollTop = el.scrollHeight
}

async function run(t: Turn) {
  running.value = true
  t.pending = true
  t.error = ''
  t.view = null
  await scrollToBottom()
  try {
    const res = await apiFetch<AskResult>('/api/ai/playground', {
      method: 'POST',
      body: {
        query: t.req.query,
        // 一般提問不帶前文（`C-315`）：這裡是一題一題確認，上一題問 A 商品、這一題問「多少錢」的話，
        // 帶前文會被當成在追問 A——跟他想確認的不是同一件事。只有點反問選項那一輪才帶（LINE 上就是接著上一句）
        ...(t.req.history ? { history: t.req.history, skipDisambiguation: true, isFollowup: true, followupOf: t.req.followupOf } : {}),
      },
    })
    t.view = askView(res)
    void ensureNames(res)
  }
  catch (err) {
    t.error = apiErrorText(err, '連不上，請再試一次')
  }
  finally {
    t.pending = false
    running.value = false
    await scrollToBottom()
  }
}

function push(turn: Omit<Turn, 'id' | 'pending' | 'error' | 'view'>): Turn {
  const t: Turn = { ...turn, id: nextId++, pending: true, error: '', view: null }
  turns.value = keepRecentTurns([...turns.value, t])
  // 拿回陣列裡那一個（reactive proxy）：之後改 pending／view 畫面才會跟著動
  return turns.value[turns.value.length - 1]!
}

async function ask() {
  const text = query.value.trim()
  if (!text || running.value || !canAsk.value) return
  query.value = ''
  await run(push({ text, question: text, req: { query: text } }))
}

function onEnter(evt: Event | KeyboardEvent) {
  const e = evt as KeyboardEvent
  // ⛔ 注音／倉頡選字按的 Enter 不算送出（不擋的話選第一個字就整句送出去）
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  void ask()
}

async function pickOption(t: Turn, optionText: string) {
  if (running.value || t.view?.kind !== 'ask') return
  const history = [
    { role: 'user' as const, text: t.question },
    { role: 'bot' as const, text: t.view.clarification },
  ].filter(h => h.text.trim())
  await run(push({ text: optionText, question: t.question, req: { query: optionText, followupOf: t.question, history } }))
}

async function retry(t: Turn) {
  if (running.value) return
  await run(t)
}
</script>
