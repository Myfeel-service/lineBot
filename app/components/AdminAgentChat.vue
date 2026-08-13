<template>
  <div class="aa-chat">
    <div ref="listEl" class="aa-chat__list">
      <!-- 開場白 + 唯讀說明 -->
      <div class="aa-msg aa-msg--ai">
        <div class="aa-msg__bubble">想知道後台的什麼?我會查真實資料回答,不會亂編。<br><span class="aa-muted">(目前只能查詢,不能幫你修改設定)</span></div>
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
          <div v-if="m.tools?.length" class="aa-msg__tools">查了:{{ m.tools.map(toolLabel).join('、') }}</div>
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
        placeholder="例:哪些腳本沒啟用?"
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

interface Msg { who: 'me' | 'ai'; text: string; tools?: string[]; cards?: AgentMsg[] }

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
const listEl = ref<HTMLElement | null>(null)

const starters = [
  '現在有什麼要處理的?',
  '這個月 AI 用量如何?',
  '哪些腳本還沒啟用?',
  '知識庫有沒有匯入失敗?',
]

// 工具顯示名收 shared 單一來源:之前這裡手寫第二份,08-06 加 get_conversation_stats
// 就漏了標籤(UI 直接秀英文工具名)——兩份表遲早漂移的實證
function toolLabel(name: string): string {
  return (ADMIN_AGENT_TOOL_LABELS as Record<string, string>)[name] ?? name
}

function scrollToBottom() {
  nextTick(() => { listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' }) })
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
    const res = await apiFetch<{ reply: string; toolCalls: string[]; messages?: AgentMsg[] }>('/api/admin/agent/chat', {
      method: 'POST',
      body: { message: text, history },
    })
    if (stillHere())
      msgs.value.push({ who: 'ai', text: res.reply, tools: res.toolCalls, cards: res.messages })
  }
  catch (err: any) {
    if (stillHere())
      msgs.value.push({ who: 'ai', text: err?.statusMessage || err?.data?.statusMessage || '查詢失敗了,稍後再試一次 🙏' })
  }
  finally {
    loading.value = false
    scrollToBottom()
  }
}
</script>

<!-- 樣式在 app/assets/scss/components/_tutorial-agent.scss(與教學小幫手同一份 partial) -->
