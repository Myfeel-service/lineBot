<template>
  <div class="aa-chat">
    <div ref="listEl" class="aa-chat__list">
      <!-- 開場白 + 能力邊界（C-31 Phase 2 起多了「幾件事可以代辦」，但一律先問再做） -->
      <div class="aa-msg aa-msg--ai">
        <div class="aa-msg__bubble">想知道後台的什麼？我會查真實資料回答，不會亂編。<br><span class="aa-muted">（少數設定也可以我來改，例如服務時間、自動回應開關——我會先給你看改什麼，按了確定才動手）</span></div>
      </div>

      <template v-for="(m, i) in msgs" :key="i">
        <div class="aa-msg" :class="m.who === 'me' ? 'aa-msg--me' : 'aa-msg--ai'">
          <div class="aa-msg__bubble">{{ m.text }}</div>
          <!-- 回答附帶的帶路卡（站內連結，後端白名單生成）：與開通精靈共用同一個渲染層 -->
          <div v-if="m.cards?.length" class="aa-msg__cards">
            <AgentMessageRenderer
              v-for="(c, j) in m.cards"
              :key="`${i}-${j}`"
              :entry="{ id: j, role: 'agent', msg: c }"
            />
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
            @done="onOpDone"
            @cancel="onOpCancel"
            @dismiss="lastPendingToken = ''"
          />
          <div v-if="m.tools?.length" class="aa-msg__tools">查了：{{ m.tools.map(toolLabel).join('、') }}</div>
        </div>
      </template>

      <div v-if="loading" class="aa-msg aa-msg--ai">
        <div class="aa-msg__bubble aa-muted">查詢中…</div>
      </div>
    </div>

    <!-- 建議問題:還沒開始聊才顯示,一鍵就懂能問什麼 -->
    <div v-if="!msgs.length && !loading" class="aa-chat__starters">
      <button v-for="s in starters" :key="s" type="button" @click="send(s)">{{ s }}</button>
    </div>

    <div class="aa-chat__input">
      <el-input
        v-model="input"
        placeholder="例：哪些客服流程沒啟用？"
        :disabled="loading"
        @keyup.enter="send()"
      />
      <el-button type="primary" :loading="loading" :disabled="!input.trim() && !loading" @click="send()">送出</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** Admin 查詢副駕(P1)的聊天面板:唯讀問答,掛在教學小幫手的「問助理」分頁。 */
import { ADMIN_AGENT_TOOL_LABELS } from '~~/shared/types/admin-agent'
import type { AgentMsg } from '~~/shared/types/agent-messages'
import type { AdminOpPending } from '~~/shared/types/admin-ops'

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
}

const { apiFetch, workspaceId } = useWorkspace()

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

const starters = [
  '現在有什麼要處理的？',
  '這個月 AI 用量如何?',
  '哪些客服流程還沒啟用？',
  '知識庫有沒有匯入失敗？',
]

// 工具顯示名收 shared 單一來源:之前這裡手寫第二份,08-06 加 get_conversation_stats
// 就漏了標籤(UI 直接秀英文工具名)——兩份表遲早漂移的實證
function toolLabel(name: string): string {
  return (ADMIN_AGENT_TOOL_LABELS as Record<string, string>)[name] ?? name
}

function scrollToBottom() {
  nextTick(() => { listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' }) })
}

/** 代辦執行完：結果進對話（成功失敗都講，⛔不要只在卡片上留一個小勾） */
function onOpDone(res: { ok: boolean, message: string, details?: string[] }) {
  lastPendingToken.value = '' // 這件事已經結束了，別再當成「上一個提議」帶回去
  const detail = res.details?.length ? `\n${res.details.join('\n')}` : ''
  msgs.value.push({ who: 'ai', text: `${res.message}${detail}` })
  scrollToBottom()
}

function onOpCancel() {
  lastPendingToken.value = ''
  msgs.value.push({ who: 'ai', text: '好，那就不改。需要的時候再跟我說。' })
  scrollToBottom()
}

async function send(preset?: string) {
  const text = String(preset ?? input.value).trim()
  if (!text || loading.value) return
  // 查詢期間可能被切到別的工作區。回來時對不上就整個丟掉——
  // 把 A 家的查詢結果貼進 B 家的對話,是會讓人照著錯資料做決定的那種錯
  const askedFor = workspaceId.value || ''
  const stillHere = () => (workspaceId.value || '') === askedFor
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
      body: { message: text, history, ...(lastPendingToken.value ? { lastToken: lastPendingToken.value } : {}) },
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
