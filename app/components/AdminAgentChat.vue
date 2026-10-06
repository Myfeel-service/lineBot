<template>
  <div class="aa-chat">
    <!-- 上面的「目前狀況」展開時只藏這一塊（`D-114`）：建議與輸入框一直都在，任何時候都能直接打字。
         「我會做的 N 件」打開時也讓位給那份清單（`D-115`），對話與捲動位置都還在 -->
    <div v-show="!props.listHidden && !showAll" ref="listEl" class="aa-chat__list">
      <!-- 開場白（`D-112`，示意頁 v2）：先講它會**做**事，再講一律先問。
           ⛔ 以前「做」只寫在一行灰色括號裡，四個建議又全是查詢，大家想不起來可以叫它做。
           能做哪些事不在這裡列——輸入框上方的建議就是這一頁的清單，再列一次是同一件事講兩遍。 -->
      <div class="aa-msg aa-msg--ai">
        <div class="aa-msg__bubble">我可以幫你查，也可以直接幫你改。要改什麼，我會先給你看，按了確定才動手。</div>
      </div>

      <template v-for="(m, i) in msgs" :key="i">
        <div class="aa-msg" :class="m.who === 'me' ? 'aa-msg--me' : 'aa-msg--ai'">
          <div class="aa-msg__bubble">{{ m.text }}</div>
          <!-- 回答附帶的帶路卡（站內連結，後端白名單生成）：與開通精靈共用同一個渲染層 -->
          <div v-if="m.cards?.length" class="aa-msg__cards">
            <template v-for="(c, j) in m.cards" :key="`${i}-${j}`">
              <!-- 「帶我走一遍」卡（`D-109`）：按下去直接開導覽／劇本，不換頁。
                   只在這裡畫、不進共用的 AgentMessageRenderer——卡上的字要查教材名（導覽清單、劇本表），
                   那兩份很大，開通精靈那邊用不到，不該為了這張卡跟著載進去。 -->
              <button
                v-if="c.kind === 'teach'"
                v-show="teachLabel(c)"
                type="button"
                class="agm-card agm-link aa-teach"
                @click="runTeach(c)"
              >{{ teachLabel(c) }} →</button>
              <AgentMessageRenderer v-else :entry="{ id: j, role: 'agent', msg: c }" />
            </template>
          </div>
          <!-- 待確認的操作：此刻還沒有任何東西被改，要按了確定才會執行 -->
          <AgentOpConfirmCard
            v-if="m.pending"
            :key="`op-${i}`"
            :pending="m.pending"
            :superseded="m.pendingSuperseded === true"
            :cancelled-by-user="m.pendingCancelled === true"
            :stale="m.pending.token !== lastPendingToken"
            :proposed-at="m.pendingAt"
            @done="(r) => onOpDone(r, m.pending?.opId)"
            @cancel="onOpCancel"
            @dismiss="lastPendingToken = ''"
          />
          <!-- 改完「前往查看」（`D-112`）：他在別頁叫它做的、或這一頁找不到那一列時才給。
               ⛔ 不自動跳頁：他可能正在這一頁做別的事 -->
          <button
            v-if="m.view"
            type="button"
            class="agm-card agm-link aa-view"
            @click="goView(m.view)"
          >前往「{{ AGENT_OP_PAGE_LABEL[m.view.page] }}」查看 →</button>
          <div v-if="m.tools?.length" class="aa-msg__tools">查了：{{ m.tools.map(toolLabel).join('、') }}</div>
        </div>
      </template>

      <div v-if="loading" class="aa-msg aa-msg--ai">
        <div class="aa-msg__bubble aa-muted">查詢中…</div>
      </div>
    </div>

    <!--
      建議（`D-112`，示意頁 v2 的 ③）：**跟著頁面換、一直在輸入框上方**——以前四句固定的查詢、對話一開始就消失。
      綠的是「直接幫你做」：按了只放進輸入框，⛔ 不直接送（「運費」「80 元」是範例不是他的規則）；
      白的是「幫你查」：沒有副作用，按了就送。聊過之後縮成一排（可橫捲），把高度還給對話。
    -->
    <!--
      「我會做的 N 件」（`D-115`，2026-10-05 老闆照示意頁 v8 拍板）：先選一類、再點一句。
      以前是六組功能名詞一口氣攤開（字一堆、又不能點）；別家（Microsoft 365 Copilot 的範例庫）是分類＋可以直接點的句子。
      佔的是對話那一塊（面板高度不變），輸入框一直在。點一句＝放進輸入框讓他改（⛔ 不送出，同頁面建議）。
    -->
    <div v-if="showAll" class="aa-cat">
      <div class="aa-cat__head">
        <span>我會做的 {{ catalogueCount }} 件</span>
        <!-- 打開／收起跟上面「目前狀況」那一條同一種長相、同一組字（2026-10-06 老闆：「建議處理跟可以這樣說的收合是否用類似的方式做」）：
             灰色小字＋箭頭，收著朝下、打開後一律「收起 ︿」（⛔ 不再一個叫「收起」一個叫「收合」） -->
        <button type="button" class="aa-chat__all-toggle" aria-expanded="true" @click="showAll = false">收起<el-icon><ArrowUp /></el-icon></button>
      </div>
      <!-- 篩選膠囊（⛔ 不用 role="tab"：小幫手已經沒有分頁了，這只是一排篩選） -->
      <div class="aa-cat__tabs">
        <button
          v-for="g in catalogue"
          :key="g.page"
          type="button"
          class="aa-cat__tab"
          :class="{ 'is-on': g.page === catPage }"
          :aria-pressed="g.page === catPage"
          @click="catPage = g.page"
        >{{ g.label }}<span class="aa-cat__n">{{ g.items.length }}</span></button>
      </div>
      <div class="aa-cat__list">
        <button
          v-for="it in catItems"
          :key="it.op"
          type="button"
          class="aa-cat__item"
          @click="pickExample(it.say)"
        >{{ it.say }}</button>
      </div>
      <!-- 以前是面板頁尾一直佔著的那一行（`D-114` 第 3 題）：叫它做這幾件時它本來就會照實說、請他到那一頁按 -->
      <p class="aa-cat__self">要你自己按：{{ AGENT_SELF_ONLY }}</p>
    </div>

    <div v-show="!showAll" class="aa-chat__pills" :class="{ 'is-compact': msgs.length > 0 }">
      <!-- `D-114`：標題不說「做的事」——下面有查也有做；「全部 N 件」沒講是什麼，改成「我會做的 N 件」 -->
      <div class="aa-chat__pills-head">
        <span>{{ prompts.label ? `在「${prompts.label}」可以這樣跟我說` : '可以這樣跟我說' }}</span>
        <button
          v-if="catalogueCount"
          type="button"
          class="aa-chat__all-toggle"
          :aria-expanded="showAll"
          @click="openOpsList"
        >我會做的 {{ catalogueCount }} 件<el-icon><ArrowDown /></el-icon></button>
      </div>
      <div class="aa-chat__chips">
        <button
          v-for="d in prompts.dos"
          :key="d.say"
          type="button"
          class="aa-chip aa-chip--do"
          :disabled="loading"
          @click="fillSuggestion(d.say)"
        >{{ d.say }}</button>
        <button
          v-for="a in prompts.asks"
          :key="a"
          type="button"
          class="aa-chip"
          :disabled="loading"
          @click="send(a, 'suggestion')"
        >{{ a }}</button>
      </div>
    </div>

    <div class="aa-chat__input">
      <el-input
        ref="inputEl"
        v-model="input"
        :placeholder="prompts.placeholder"
        :disabled="loading"
        class="aa-chat__field"
        :class="{ 'is-turn': glow }"
        @keyup.enter="send()"
      />
      <el-button type="primary" :loading="loading" :disabled="!input.trim() && !loading" @click="send()">送出</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 小幫手的對話（`D-114` 前是「問／交辦」分頁，現在一直在狀況條下面）：用講的查後台、也用講的叫它改（改之前一律先給確認卡）。 */
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue'
import { ADMIN_AGENT_TOOL_LABELS } from '~~/shared/types/admin-agent'
import type { AgentMsg } from '~~/shared/types/agent-messages'
import type { AdminOpId, AdminOpPending } from '~~/shared/types/admin-ops'
import {
  ADMIN_OP_TARGET,
  AGENT_OP_PAGE_LABEL,
  AGENT_SELF_ONLY,
  type AgentAskSource,
  type AgentOpPage,
  agentOpCatalogue,
  agentOpViewPath,
  agentPromptPageFromPath,
  agentPromptsFor,
} from '~~/shared/agent-entry'
import type { AgentOpDoneEvent } from '~/composables/useAgentOpRefresh'

interface Msg {
  who: 'me' | 'ai'
  text: string
  tools?: string[]
  cards?: AgentMsg[]
  /** 待確認的操作（C-31 Phase 2）：卡片自己負責執行，這裡只負責把結果接回對話 */
  pending?: AdminOpPending
  /**
   * 這張卡什麼時候出現的。
   * ⛔ 訊息是累積的，舊卡片會一直留在上面而且**還按得下去**——不是最新的那張
   *    要讓人看得出「這是幾分鐘前提的」，否則捲上去按到會以為是剛剛那件事。
   */
  pendingAt?: number
  /** 已經被後面那張卡取代（同一個操作、同一個對象）→ 不給按 */
  pendingSuperseded?: boolean
  /** 使用者在對話裡收回了這個提議（「算了」「不用了」）→ 不給按 */
  pendingCancelled?: boolean
  /** 代辦做完、那一列不在眼前：給一顆「前往查看」（`D-112`） */
  view?: AgentOpDoneEvent
}

const props = defineProps<{
  /** 上面的「目前狀況」展開著（`D-114`）：只藏對話紀錄，建議與輸入框照常 */
  listHidden?: boolean
}>()
/** 他開始講話了（送出、按了建議）：小幫手把展開的狀況收起來，把位子還給對話 */
const emit = defineEmits<{ engage: [] }>()

const { apiFetch, workspaceId, can } = useWorkspace()
const { topics, startTopicById, openGuide, openPanelView, openCatalogue, requestedAgentAsk } = useTutorial()
const route = useRoute()
const { bumpAdminTagList } = useAdminTagRefresh()
const { showToast } = useAdminToast()

type TeachCard = Extract<AgentMsg, { kind: 'teach' }>

/**
 * 卡上的字照教材名顯示（教材名只有一份：導覽＝tutorial-topics 的 label、劇本＝AGENT_GUIDES 的 title）。
 * 回空字串＝這個角色跑不動或教材已經不在了 → 整張不畫（⛔ 不畫一張按了沒反應的卡）。
 * 後端已經照角色篩過一次，這裡是第二道：topics 是依角色＋功能旗標過濾過的清單。
 */
function teachLabel(c: TeachCard): string {
  if (c.teach === 'tour') {
    const t = topics.value.find(t => t.id === c.ref)
    return t ? `帶我走一遍：${t.label}` : ''
  }
  if (c.teach === 'guide') {
    const g = (AGENT_GUIDES as Record<string, { title: string } | undefined>)[c.ref]
    return g ? `陪我做：${g.title}` : ''
  }
  return '展開上面的「目前狀況」（一鍵修好的按鈕在那裡）'
}

function runTeach(c: TeachCard) {
  if (c.teach === 'tour') {
    // 導覽會自己把面板收起來、換到那一頁再開跑；跑不起來就退回全部教學讓他自己挑（⛔ 不要按了沒反應）
    if (!startTopicById(c.ref))
      openCatalogue()
    return
  }
  if (c.teach === 'guide') {
    openGuide(c.ref)
    return
  }
  openPanelView('status')
}

// 對話存在全域:切去「目前狀況」看一眼、或關掉面板再打開,問到一半的內容都還在。
// 但換工作區一定要清掉——B 家的畫面上留著 A 家的查詢結果會直接誤導人。
const msgs = useState<Msg[]>('admin-agent-chat-msgs', () => [])
const msgsWorkspace = useState('admin-agent-chat-workspace', () => '')
watchEffect(() => {
  const wid = workspaceId.value || ''
  if (msgsWorkspace.value === wid)
    return
  msgs.value = []
  msgsWorkspace.value = wid
})

const input = ref('')
const loading = ref(false)
/**
 * 上一個還沒執行的提議憑證：下一句話帶回後端，讓「第二題改成問電話」這種接續要求接得住。
 * ⛔ 帶的是憑證本身（後端會驗簽章），不是我們自己描述上次提議了什麼。
 * 按了確定或取消之後就清掉——那件事已經結束了，再帶回去只會誤導它。
 */
const lastPendingToken = ref('')
const listEl = ref<HTMLElement | null>(null)

// ── 這一頁的建議（`D-112`）────────────────────────────────────────
/** 他現在在哪一頁：建議、輸入框的範例字、記錄來源都看這個 */
const page = computed(() => agentPromptPageFromPath(route.path))
/** 已照權限篩過：觀察者一個「做」都不會看到（按了只會被拒絕的建議比沒有更糟） */
const prompts = computed(() => agentPromptsFor(page.value, can))
const catalogue = computed(() => agentOpCatalogue(can))
const catalogueCount = computed(() => catalogue.value.reduce((n, g) => n + g.items.length, 0))
const showAll = ref(false)
/** 「我會做的 N 件」選中的那一類 */
const catPage = ref<AgentOpPage | null>(null)
const catItems = computed(() => (catalogue.value.find(g => g.page === catPage.value) ?? catalogue.value[0])?.items ?? [])

/** 打開清單：先停在他正在看的那一頁那一類（那一頁沒有就第一類），把上面展開的狀況收起來 */
function openOpsList() {
  const here = catalogue.value.find(g => g.page === page.value)
  catPage.value = (here ?? catalogue.value[0])?.page ?? null
  showAll.value = true
  emit('engage')
}

/** 點一句範例：收起清單、放進輸入框讓他改（⛔ 不送出——同頁面上「做」的建議） */
function pickExample(say: string) {
  showAll.value = false
  fillSuggestion(say)
}

/**
 * 這一句是從哪個入口來的。按了「做」的建議或頁面上的「用一句話建立」之後才打字送出，
 * 也算那個入口（他只是把範例改成自己的）；把建議的字整個清掉＝重新開始，算自己打字。
 * ⚠️ 「用一句話建立」進來時輸入框本來就是空的，所以那一種不因為空而清掉。
 */
const pendingSource = ref<AgentAskSource | null>(null)
watch(input, (v) => {
  if (!v.trim() && pendingSource.value === 'suggestion')
    pendingSource.value = null
})

const inputEl = ref<{ focus: () => void, input?: HTMLInputElement } | null>(null)
/** 輸入框亮三下（同 AgentAskDock 的 `is-turn`）：從頁面按鈕進來時告訴他「在這裡講」 */
const glow = ref(false)

/**
 * @param withGlow 亮三下＝「在這裡講」的提示（從頁面按鈕、建議進來時）；
 *   單純打開面板（`D-114` 打開就能打字）只放游標、⛔ 不亮——每次打開都閃就成了裝飾
 */
function focusInput(withGlow = true) {
  if (withGlow) glow.value = false
  // 面板打開時會先把焦點放在面板本體（esc 才關得掉），這裡晚一拍再搶回輸入框
  nextTick(() => setTimeout(() => {
    inputEl.value?.focus()
    const el = inputEl.value?.input
    if (el) el.setSelectionRange(el.value.length, el.value.length)
    if (withGlow) glow.value = true
  }, 80))
}
defineExpose({ focusInput })

/** 「做」的建議：放進輸入框，等他改成自己的再送（⛔ 不直接送） */
function fillSuggestion(text: string) {
  input.value = text
  pendingSource.value = 'suggestion'
  emit('engage')
  focusInput()
}

// 頁面上的「用一句話建立」、目前狀況卡片的「交給小幫手」留在共享狀態的那句話。
// ⚠️ immediate：面板可能是被這個請求打開的，聊天元件掛上的時候請求早就在那裡了
watch(requestedAgentAsk, (req) => {
  if (!req) return
  requestedAgentAsk.value = null
  if (req.send && req.text) {
    void send(req.text, req.source)
    return
  }
  input.value = req.text ?? ''
  pendingSource.value = req.source
  focusInput()
}, { immediate: true })

// ── 改完：頁面跟著變（`D-112` 第 4 件）────────────────────────────
const pendingView = useAgentOpPendingView()

/**
 * 通知那一頁重讀並把改到的那一塊亮起來；那一頁不在眼前（或找不到那一列）就給「前往查看」。
 * 他手上有沒存的修改時頁面不會重讀——那時要照實講：畫面上還是舊的，直接存會把剛改的改回去。
 */
async function showResult(opId: AdminOpId, targetId: string | undefined, msg: Msg) {
  const t = ADMIN_OP_TARGET[opId]
  if (!t) return
  const evt: AgentOpDoneEvent = { opId, page: t.page, section: t.section, targetId, at: Date.now() }
  // 新建的標籤：別頁的標籤下拉也要看得到（`C-208` 的全站訊號）
  if (opId === 'tag-create') bumpAdminTagList()
  const shown = await dispatchAgentOpDone(evt)
  if (shown === 'shown') {
    msg.text += '\n（畫面上亮起來的就是）'
    return
  }
  if (shown === 'dirty') {
    msg.text += `\n⚠️ 你這一頁還有沒存的修改，所以畫面上還是舊的。直接按儲存會把我剛改的改回去——要保留的話先按「取消」。`
    return
  }
  // 不在這一頁（absent），或這一頁現在看不到它（被篩選掉、在別一區）→「前往查看」
  msg.view = evt
}

async function goView(evt: AgentOpDoneEvent) {
  const wid = workspaceId.value
  if (!wid) return
  // ⛔ 已經在那一頁：換到同一個網址不會重新掛載（`?id=` 那些不會再跑），直接叫那一頁把它拿出來
  if (page.value === evt.page) {
    const r = await dispatchAgentOpDone(evt, 'reveal')
    if (r === 'dirty') showToast('你正在編還沒存的內容，先沒幫你切過去——存好或取消後再按一次', 'warning')
    else if (r === 'missing') showToast('這一頁找不到它，可能已經被刪掉了', 'warning')
    if (r !== 'absent') return
  }
  pendingView.value = { ...evt, at: Date.now() }
  void navigateTo(agentOpViewPath(evt.page, wid, evt.targetId))
}

// 工具顯示名收 shared 單一來源:之前這裡手寫第二份,08-06 加 get_conversation_stats
// 就漏了標籤(UI 直接秀英文工具名)——兩份表遲早漂移的實證
function toolLabel(name: string): string {
  return (ADMIN_AGENT_TOOL_LABELS as Record<string, string>)[name] ?? name
}

function scrollToBottom() {
  nextTick(() => { listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' }) })
}

/** 代辦執行完：結果進對話（成功失敗都講，⛔不要只在卡片上留一個小勾） */
async function onOpDone(res: { ok: boolean, message: string, details?: string[], targetId?: string }, opId?: AdminOpId) {
  lastPendingToken.value = '' // 這件事已經結束了，別再當成「上一個提議」帶回去
  const detail = res.details?.length ? `\n${res.details.join('\n')}` : ''
  msgs.value.push({ who: 'ai', text: `${res.message}${detail}` })
  scrollToBottom()
  // 沒做成就沒有東西可以看（⛔ 不亮一個沒變的東西）
  if (!res.ok || !opId) return
  // ⚠️ 改的是陣列裡那一份（響應式的），不是剛剛推進去的那個字面物件
  const msg = msgs.value[msgs.value.length - 1]!
  await showResult(opId, res.targetId, msg)
  scrollToBottom()
}

function onOpCancel() {
  lastPendingToken.value = ''
  msgs.value.push({ who: 'ai', text: '好，那就不改。需要的時候再跟我說。' })
  scrollToBottom()
}

/**
 * @param preset 直接送的那句話（「查」的建議、卡片上的「交給小幫手」）；不給＝送輸入框裡的字
 * @param source 從哪個入口來（`D-112` 量入口用）；不給＝看輸入框裡的字是怎麼來的
 */
async function send(preset?: string, source?: AgentAskSource) {
  const text = String(preset ?? input.value).trim()
  if (!text || loading.value) return
  emit('engage')
  // 查詢期間可能被切到別的工作區。回來時對不上就整個丟掉——
  // 把 A 家的查詢結果貼進 B 家的對話,是會讓人照著錯資料做決定的那種錯
  const askedFor = workspaceId.value || ''
  const stillHere = () => (workspaceId.value || '') === askedFor
  const from: AgentAskSource = source ?? (preset ? 'suggestion' : pendingSource.value ?? 'typed')
  pendingSource.value = null
  input.value = ''
  msgs.value.push({ who: 'me', text })
  loading.value = true
  scrollToBottom()
  try {
    // 帶最近 6 則當上下文,追問(「那上個月呢?」)才接得住
    const history = msgs.value.slice(-7, -1).map(m => ({ role: m.who === 'me' ? 'user' : 'assistant', text: m.text }))
    const res = await apiFetch<{
      reply: string
      toolCalls: string[]
      messages?: AgentMsg[]
      pendingOp?: AdminOpPending
      cancelPrevious?: boolean
    }>('/api/admin/agent/chat', {
      method: 'POST',
      body: {
        message: text,
        history,
        ...(lastPendingToken.value ? { lastToken: lastPendingToken.value } : {}),
        // 只拿來記錄（後端照表收斂），⛔ 不影響它怎麼回答
        source: from,
        page: page.value,
      },
    })
    if (stillHere()) {
      // 這一輪之後，上面那張還按得下去的舊卡還算不算數？三種情況分開處理——
      // ⛔ 不可以「只要有新提議就把舊的全灰掉」：「下架查詢訂單」與「下架更改地址」
      //    是兩件不同的事，灰掉前者等於擋掉一個仍然成立的提議。
      const prevToken = lastPendingToken.value
      if (prevToken && (res.cancelPrevious || res.pendingOp?.replacesPrevious)) {
        const prev = msgs.value.find(m => m.pending?.token === prevToken)
        if (prev) {
          if (res.cancelPrevious) prev.pendingCancelled = true
          else prev.pendingSuperseded = true
        }
      }
      msgs.value.push({
        who: 'ai',
        text: res.reply,
        tools: res.toolCalls,
        cards: res.messages,
        pending: res.pendingOp,
        ...(res.pendingOp ? { pendingAt: Date.now() } : {}),
      })
      lastPendingToken.value = res.pendingOp?.token ?? ''
    }
  }
  catch (err: any) {
    if (stillHere())
      msgs.value.push({ who: 'ai', text: err?.statusMessage || err?.data?.statusMessage || '查詢失敗了，稍後再試一次 🙏' })
  }
  finally {
    loading.value = false
    scrollToBottom()
  }
}
</script>

<!-- 樣式在 app/assets/scss/components/_tutorial-agent.scss(與教學小幫手同一份 partial) -->
