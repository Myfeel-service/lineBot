<template>
  <!--
    知識庫頁右邊「問 AI 一題」（`C-315`，2026-10-15 老闆拍板 D-126②，示意頁 RhjGQXbdZhqiXpXuM3Vjei ①②）。
    打一句客人會問的話，馬上看到 AI 怎麼答、用了哪幾條；答錯了當場「寫一句正確答案」。
    用的是測試對話那一支（/api/ai/playground）：不寫對話紀錄、不扣額度，只記花掉的 AI 用量（測試那一格）。
    寬度不寫死，放在哪一欄、多寬由頁面決定；高度吃滿父層（父層給高度，中間那段才會自己捲）。

    `D-168`（2026-11-04 老闆「好改」，示意頁 P2eM2kiRXe6X6SZsWNT6y6）：
    - 輸入框固定在標題下面。以前問了第一題就從最上面跳到最底下，還要讓出右下角小幫手那顆的寬度（輸入框剩一半）
    - 一題一張、最新那題接在輸入框正下方；之前問的收成一行＋結果小章，點開看全文。
      這裡刻意一題一題試（一般提問不帶前文），以前長得像聊天——接著打「那多少錢？」AI 不會接上一題，LINE 上卻接得上
    - 還沒問過時列幾句點了就問的（頁面給：打開的那一份的客人問法／AI 答不出來的客人原句）。以前整欄空白
  -->
  <section class="kb-ask" data-tour="kb-ask">
    <header class="kb-ask__head">
      <h3 class="kb-ask__title">問 AI 一題</h3>
      <p class="kb-ask__sub">不會傳給客人</p>
      <div class="kb-ask__bar">
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
      </div>
    </header>

    <div ref="bodyEl" class="kb-ask__body">
      <!-- 還沒問過：點一句就直接問（範例就是說明）。頁面沒給（兩種來源都沒有）就不列，只留輸入框 -->
      <div v-if="!cards.length && examples?.questions.length" class="kb-ask__try">
        <p class="kb-ask__try-label">{{ examples.label }}</p>
        <button
          v-for="q in examples.questions"
          :key="q"
          type="button"
          class="kb-ask__try-q"
          :disabled="!canAsk || running"
          @click="askText(q)"
        >
          {{ q }}
        </button>
      </div>

      <template v-for="(c, ci) in shownCards" :key="c.id">
        <p v-if="ci === 1" class="kb-ask__older-label">剛剛問過</p>
        <article class="kb-ask__card" :class="{ 'is-older': ci > 0 }">
          <!-- 之前問的：一行（題目＋結果小章），點了展開看全文 -->
          <button v-if="ci > 0" type="button" class="kb-ask__card-head is-toggle" :aria-expanded="isOpen(c)" @click="toggle(c)">
            <!-- ⛔ 不用 ▸ 字元：13px 的字裡只剩一個小點，看不出點得開（`D-168` 守門員截圖抓到） -->
            <el-icon class="kb-ask__caret" :class="{ 'is-open': isOpen(c) }" aria-hidden="true"><ArrowRight /></el-icon>
            <span class="kb-ask__q">{{ c.question }}</span>
            <el-tag v-if="verdicts[c.id]" :type="verdicts[c.id]?.tone" size="small" round disable-transitions class="kb-ask__verdict">{{ verdicts[c.id]?.text }}</el-tag>
          </button>
          <div v-else class="kb-ask__card-head">
            <span class="kb-ask__q">{{ c.question }}</span>
            <el-tag v-if="verdicts[c.id]" :type="verdicts[c.id]?.tone" size="small" round disable-transitions class="kb-ask__verdict">{{ verdicts[c.id]?.text }}</el-tag>
          </div>

          <div v-if="ci === 0 || isOpen(c)" class="kb-ask__card-body">
            <div v-for="(t, si) in c.steps" :key="t.id" class="kb-ask__step" :data-step="t.id">
              <!-- 點反問選項那一步：客人按下去的那個字（第一步就是標題那一題，不重講） -->
              <div v-if="si > 0" class="kb-ask__bubble kb-ask__bubble--cust">{{ t.text }}</div>

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

                <!-- 先反問客人是指哪一個：照 LINE 上的樣子列選項，點一個看接下來怎麼答（只有最新那一題的最後一步點得到） -->
                <div v-else-if="t.view.kind === 'ask'" class="kb-ask__bubble kb-ask__bubble--ai">
                  <p class="kb-ask__line">{{ t.view.clarification }}</p>
                  <div class="kb-ask__options">
                    <el-button
                      v-for="opt in t.view.options"
                      :key="opt.chunkId || opt.text"
                      size="small"
                      plain
                      :disabled="ci !== 0 || si !== c.steps.length - 1 || running"
                      @click="pickOption(c, t, opt.text)"
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
                    @click="emit('add-one', { question: c.question })"
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

                <!-- 答錯了當場補（`C-317` 的小視窗由頁面打開），帶的是這一題（點反問選項那幾步也是原本那一題）。轉真人那幾種上面已經有主要按鈕，不再擺第二顆 -->
                <el-button
                  v-if="canAddKnowledge && fixLink(t)"
                  class="kb-ask__fix"
                  link
                  type="primary"
                  size="small"
                  @click="emit('add-one', { question: c.question })"
                >
                  答得不對？寫一句正確答案
                </el-button>
              </template>
            </div>
          </div>
        </article>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight } from '@element-plus/icons-vue'
import { apiErrorText } from '~/utils/api-error-text'
import type { AskExamples } from '~/utils/kb-ask-examples'
import {
  askSourceLabel,
  askVerdict,
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
  /** 還沒問過時列的那幾句（`D-168`，頁面照「有沒有打開一份資料」給，規則見 utils/kb-ask-examples）；沒有＝不列 */
  examples?: AskExamples | null
}>(), {
  sourceNames: undefined,
  currentSourceId: null,
  examples: null,
})

const emit = defineEmits<{
  (e: 'open-chunk', payload: { chunkId: string, sourceId: string | null }): void
  (e: 'add-one', payload: { question: string }): void
}>()

const { apiFetch, can } = useWorkspace()
const canAsk = computed(() => can('playground.use'))
/** 「寫一句正確答案」打的是 /api/ai/knowledge/create（或建議的 accept），兩支都是 knowledge.write（`G-109`：照端點讀權限表） */
const canAddKnowledge = computed(() => can('knowledge.write'))

/** 一步＝送出一句、拿回一個結果。第一步是那一題；點反問選項，選項的字是下一步 */
interface Step {
  id: number
  /** 這一步送出的那句（第一步＝那一題，點反問選項那一步＝選項的字） */
  text: string
  pending: boolean
  error: string
  view: AskView | null
  /** 重送用（再問一次） */
  req: { query: string, followupOf?: string, history?: Array<{ role: 'user' | 'bot', text: string }> }
}

/** 一題一張（`D-168`）：點反問選項的那幾步跟在同一張裡 */
interface Card {
  id: number
  /** 客人問的那一題：卡片標題、「寫一句正確答案」要帶出去的也是這句 */
  question: string
  steps: Step[]
}

const query = ref('')
const running = ref(false)
/** 舊 → 新（只留最近幾題，見 keepRecentTurns） */
const cards = ref<Card[]>([])
const bodyEl = ref<HTMLElement | null>(null)
let nextId = 1

/** 畫面上新的在上面：最新那一張接在輸入框正下方 */
const shownCards = computed(() => [...cards.value].reverse())

/** 之前問的哪幾張點開了（問了新的一題就全部收起來：一次只看現在那一題） */
const openIds = ref<number[]>([])
const isOpen = (c: Card) => openIds.value.includes(c.id)
function toggle(c: Card) {
  openIds.value = isOpen(c) ? openIds.value.filter(id => id !== c.id) : [...openIds.value, c.id]
}

/** 每一張標題旁的小章：看最後一步（反問了還沒點＝「會先反問」，點了選項就看點了之後怎麼答）；還在問的不標 */
const verdicts = computed<Record<number, ReturnType<typeof askVerdict>>>(() => Object.fromEntries(cards.value.map((c) => {
  const t = c.steps[c.steps.length - 1]
  return [c.id, t && !t.pending ? askVerdict(t.view, t.error) : null]
})))

const fetchedNames = ref<Record<string, string> | null>(null)
let namesRequested = false
const names = computed(() => props.sourceNames ?? fetchedNames.value)

function sourceLabel(row: AskSourceRow): string {
  return askSourceLabel(row, names.value, props.currentSourceId)
}

/** 答得出來／反問的那幾種下面掛一行連結；招呼語、自動回應、跳過、服務失敗不掛（補知識沒有用） */
function fixLink(t: Step): boolean {
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

/**
 * 讓這一步看得到：新的一題在最上面＝捲回頂；點反問選項那一步接在最新那一張下面＝捲到看得到它為止。
 * 底下那一段內距是讓出右下角小幫手那顆的（頁面給的），算「看得到」時不算進去。
 */
async function reveal(t: Step) {
  await nextTick()
  const body = bodyEl.value
  if (!body) return
  const el = body.querySelector<HTMLElement>(`[data-step="${t.id}"]`)
  if (!el || el === body.querySelector('[data-step]')) {
    body.scrollTop = 0
    return
  }
  const b = body.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const visibleBottom = b.bottom - (Number.parseFloat(getComputedStyle(body).paddingBottom) || 0)
  if (r.bottom > visibleBottom) body.scrollTop += Math.min(r.bottom - visibleBottom + 12, r.top - b.top - 12)
  else if (r.top < b.top) body.scrollTop -= b.top - r.top + 12
}

async function run(t: Step) {
  running.value = true
  t.pending = true
  t.error = ''
  t.view = null
  await reveal(t)
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
    await reveal(t)
  }
}

function newStep(text: string, req: Step['req']): Step {
  return { id: nextId++, text, pending: true, error: '', view: null, req }
}

/** 新的一題：開一張新的放最上面，之前點開的全部收起來 */
function pushCard(text: string): Step {
  const card: Card = { id: nextId++, question: text, steps: [newStep(text, { query: text })] }
  cards.value = keepRecentTurns([...cards.value, card])
  openIds.value = []
  // 拿回陣列裡那一個（reactive proxy）：之後改 pending／view 畫面才會跟著動
  return cards.value[cards.value.length - 1]!.steps[0]!
}

async function askText(raw: string) {
  const text = raw.trim()
  if (!text || running.value || !canAsk.value) return
  await run(pushCard(text))
}

async function ask() {
  const text = query.value.trim()
  if (!text || running.value || !canAsk.value) return
  query.value = ''
  await askText(text)
}

function onEnter(evt: Event | KeyboardEvent) {
  const e = evt as KeyboardEvent
  // ⛔ 注音／倉頡選字按的 Enter 不算送出（不擋的話選第一個字就整句送出去）
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  void ask()
}

/** 點反問的選項：接在同一張裡（LINE 上客人就是接著上一句按的，這一步才帶前文） */
async function pickOption(c: Card, t: Step, optionText: string) {
  if (running.value || t.view?.kind !== 'ask') return
  const history = [
    { role: 'user' as const, text: c.question },
    { role: 'bot' as const, text: t.view.clarification },
  ].filter(h => h.text.trim())
  c.steps.push(newStep(optionText, { query: optionText, followupOf: c.question, history }))
  await run(c.steps[c.steps.length - 1]!)
}

async function retry(t: Step) {
  if (running.value) return
  await run(t)
}
</script>
