<template>
  <!--
    `D-138`：右邊常駐的「試試看」，取代以前兩個各說各話的工具——觸發卡裡的「測試觸發」（只會用「含任一」比、
    看意思時只說「無法確定」）＋最底下要點開的「試跑」（打什麼第一句都會走進來）。
    第一句照正式回客人的規則判斷（後端同一份 script-match），命中這條才接著模擬對話；
    沒命中就講會走哪裡、為什麼。純預覽，不寫任何資料。
  -->
  <aside class="scripts-try" aria-label="試試看" data-tour="scr-sim">
    <div class="scripts-try__head">
      <div class="scripts-try__title">
        <span class="section-title">試試看</span>
        <button v-if="log.length" type="button" class="scripts-try__reset" @click="reset">重來</button>
      </div>
      <span class="text-xs text-muted">{{ isFollow ? '模擬客人加好友，看他會收到什麼' : '打一句客人會講的話，照真的判斷跑一次，不會送出' }}</span>
    </div>

    <div ref="chatEl" class="scripts-sim-chat scripts-try__chat" data-tour="scr-sim-panel">
      <p v-if="!log.length" class="scripts-sim-empty">
        {{ isFollow ? '按下面「模擬客人加好友」開始' : '例：我的訂單到哪了' }}
      </p>
      <template v-for="(m, i) in log" :key="i">
        <p v-if="m.who === 'verdict'" class="scripts-try__verdict" :class="`is-${m.tone}`">
          {{ m.text }}
          <button v-if="m.retry" type="button" class="scripts-try__assume" @click="assumeHit">當作會走這一條，繼續試</button>
        </p>
        <!-- `C-232`：送出整個模組這一步要真的畫出來；抓不到時由 AdminActionPreview 自己講，不畫成空白 -->
        <AdminActionPreview
          v-else-if="m.moduleId"
          class="scripts-sim-module"
          :action="{ type: 'module', moduleId: m.moduleId, text: '', uri: '' }"
          :module-options="moduleOptions"
          title=""
        />
        <div v-else-if="m.who === 'sys'" class="scripts-sim-sys">{{ m.text }}</div>
        <div v-else class="scripts-sim-line" :class="`is-${m.who}`">
          <div v-if="m.image" class="scripts-try__image">圖片</div>
          <!-- ⛔ 純連結卡那一則沒有文字，不要畫出「（空白訊息）」——那是給真的漏填文字的人看的 -->
          <div v-else-if="!m.linkCard || m.text" class="scripts-sim-bubble">{{ m.text || '（空白訊息）' }}</div>
          <div v-if="m.buttons?.length" class="scripts-sim-qr">
            <button v-for="(b, bi) in m.buttons" :key="bi" type="button" @click="send(b)">{{ b || '（空白按鈕）' }}</button>
          </div>
          <!-- `C-232`：回覆帶連結時另外送一則按鈕卡（引擎就是這樣送的）；按鈕在試跑裡不可點 -->
          <div v-if="m.linkCard" class="scripts-sim-linkcard">
            <p class="scripts-sim-linkcard__text">{{ m.linkCard.text }}</p>
            <span class="scripts-sim-linkcard__btn">{{ m.linkCard.label }}</span>
            <span class="scripts-sim-linkcard__url">{{ m.linkCard.url }}</span>
          </div>
        </div>
      </template>
      <p v-if="judging" class="scripts-sim-sys">判斷中…</p>
    </div>

    <div class="scripts-sim-input" data-tour="scr-test">
      <!-- 加好友的沒有「第一句話」——第一步由加好友事件觸發，之後才輪到打字 -->
      <el-button v-if="isFollow && !log.length" type="primary" @click="followStart">模擬客人加好友</el-button>
      <template v-else>
        <el-input v-model="input" :placeholder="log.length ? '接著打…' : '輸入客人會講的話'" :disabled="judging" @keyup.enter="send()" />
        <el-button v-if="waiting === 'collect'" title="客人用圖片（例如訂單截圖）回答這一題" :disabled="judging" @click="sendImage">傳圖片</el-button>
        <el-button type="primary" :disabled="judging" @click="send()">送出</el-button>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { ScriptNode, ScriptTryResult } from '~~/shared/types/ai-script'
import {
  DEFAULT_COLLECT_REASK,
  DEFAULT_REPLY_LINK_LABEL,
  SCRIPT_IMAGE_ANSWER,
  collectSkipLabel,
  consumePrefilledCollect,
  extractCollectValue,
  isHumanRequestText,
  prefillCollectFields,
  renderScriptTemplate,
  resolveBranchNext,
} from '~~/shared/types/ai-script'
import { LINE_CARD_BODY_DEFAULT } from '~~/shared/line-card-copy'

const props = defineProps<{
  /** 編輯中的那一份（可能還沒存、可能關著）：判斷時一起送去，試的就是「改成這樣之後」 */
  scriptId: string | null
  name: string
  enabled: boolean
  priority: number
  nodes: ScriptNode[]
  rootNodeId: string
  moduleOptions: Array<{ id: string; name: string; isActive?: boolean; messageCount?: number }>
}>()

const { apiFetch, can } = useWorkspace()

interface SimMsg {
  who: 'bot' | 'me' | 'sys' | 'verdict'
  text: string
  tone?: 'hit' | 'miss' | 'warn'
  /** 判斷失敗時給一顆「當作會走這一條」 */
  retry?: boolean
  buttons?: string[]
  image?: boolean
  moduleId?: string
  linkCard?: { text: string; label: string; url: string }
}

const log = ref<SimMsg[]>([])
const input = ref('')
const judging = ref(false)
const waiting = ref<'collect' | 'quickReply' | null>(null)
const nodeId = ref<string | null>(null)
const collected = ref<Record<string, string>>({})
/** 客人前面已經講過、走到那一題要跳過的欄位（與引擎同一套 prefillCollectFields，`C-343`） */
const prefilled = ref<string[]>([])
const done = ref(false)
/** 判斷失敗時記住那一句，按「當作會走這一條」就拿它開始 */
let pendingFirst = ''

const trigger = computed(() => {
  const t = props.nodes.find(n => n.id === props.rootNodeId)
  return t?.type === 'trigger' ? t : null
})
const isFollow = computed(() => trigger.value?.triggerEvent === 'follow')

function push(m: SimMsg) { log.value.push(m) }

/** 面板拉滿時對話在面板裡捲（2026-10-22）：有新的一句就捲到最底，跟聊天軟體一樣。排在下面那種不會捲，設了也沒作用 */
const chatEl = ref<HTMLElement | null>(null)
watch(() => [log.value.length, judging.value], () => nextTick(() => {
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
}))

function reset() {
  log.value = []
  input.value = ''
  waiting.value = null
  nodeId.value = null
  collected.value = {}
  prefilled.value = []
  done.value = false
  pendingFirst = ''
}

function moduleLabel(id: string): string {
  return props.moduleOptions.find(m => m.id === id)?.name ?? id
}

function prefill(text: string) {
  const found = prefillCollectFields(props.nodes, text, collected.value)
  const fields = Object.keys(found)
  if (!fields.length) return
  collected.value = { ...collected.value, ...found }
  prefilled.value = [...new Set([...prefilled.value, ...fields])]
}

/** 從某一步往前推非互動步驟：遇到問題停下等輸入、遇到結尾結束（與引擎同一套純函式） */
function run(startId: string) {
  let cursor = startId
  for (let i = 0; i < 50; i++) {
    const end = (text: string) => { push({ who: 'sys', text }); done.value = true; waiting.value = null }
    if (!cursor) return end('（這條路沒有接下一步，流程結束）')
    const node = props.nodes.find(n => n.id === cursor)
    if (!node) return end('（接到不存在的步驟，流程結束）')
    if (node.type === 'trigger') { cursor = node.next; continue }
    if (node.type === 'branch') { cursor = resolveBranchNext(node, collected.value); continue }
    if (node.type === 'tag') { push({ who: 'sys', text: `（貼標：${node.addTagIds.length} 個標籤）` }); cursor = node.next; continue }
    if (node.type === 'saveLead') {
      // 跟引擎一致：截圖那題不寫進客人資料（「（圖片）」不是訂單編號）
      const stored = node.fieldMap.filter(m => collected.value[m.fromField] && collected.value[m.fromField] !== SCRIPT_IMAGE_ANSWER)
      push({ who: 'sys', text: stored.length ? '（已把答案存進客人資料，截圖不存）' : '（沒有要存進客人資料的答案：截圖不存）' })
      cursor = node.next
      continue
    }
    if (node.type === 'collect') {
      const remaining = consumePrefilledCollect(node.fieldName, { collected: collected.value, prefilled: prefilled.value })
      if (remaining) {
        prefilled.value = remaining
        push({ who: 'sys', text: `（客人前面已經給過：${collected.value[node.fieldName]}，這一題不再問）` })
        cursor = node.next
        continue
      }
      const skip = collectSkipLabel(node)
      push({ who: 'bot', text: renderScriptTemplate(node.question, { collected: collected.value }), ...(skip ? { buttons: [skip] } : {}) })
      nodeId.value = node.id
      waiting.value = 'collect'
      return
    }
    if (node.type === 'quickReply') {
      push({ who: 'bot', text: renderScriptTemplate(node.question, { collected: collected.value }), buttons: node.options.map(o => o.label) })
      nodeId.value = node.id
      waiting.value = 'quickReply'
      return
    }
    if (node.type === 'module') {
      // ⛔ 還沒選模組時不可以走預覽那條路（會畫成「空白訊息」，看起來像客人收到空訊息）
      if (!node.moduleId) return end('（這一步還沒選要送哪一個機器人模組，客人什麼都收不到）')
      push({ who: 'bot', text: '', moduleId: node.moduleId })
      return end(`（以上是機器人模組「${moduleLabel(node.moduleId)}」的內容，流程結束）`)
    }
    if (node.type === 'reply') {
      push({ who: 'bot', text: renderScriptTemplate(node.text, { collected: collected.value }) })
      const linkUrl = renderScriptTemplate(String(node.linkUrl ?? '').trim(), { collected: collected.value })
      if (linkUrl) {
        push({ who: 'bot', text: '', linkCard: { text: LINE_CARD_BODY_DEFAULT, label: String(node.linkLabel ?? '').trim() || DEFAULT_REPLY_LINK_LABEL, url: linkUrl } })
      }
      return end(node.thenHandoff ? '↳ 交給真人客服（下班時間會併上「幾點起回覆」）' : '（流程結束）')
    }
    return
  }
}

function startFlow(firstText: string) {
  if (!trigger.value) { push({ who: 'sys', text: '（這條沒有開始的設定）' }); return }
  prefill(firstText)
  run(trigger.value.next)
}

function followStart() {
  push({ who: 'sys', text: '（客人把你的官方帳號加為好友）' })
  if (trigger.value) run(trigger.value.next)
}

function assumeHit() {
  const first = pendingFirst
  pendingFirst = ''
  for (const m of log.value) m.retry = false
  startFlow(first)
}

/** 第一句：照正式回客人的規則判斷會走哪一條（後端 script-match），命中這條才接著模擬 */
async function judgeFirst(text: string) {
  // 沒有試答權限（觀察者）：問不到後端，講清楚、讓他照樣試流程本身
  if (!can('playground.use')) {
    pendingFirst = text
    push({ who: 'verdict', tone: 'warn', text: '你的帳號不能跑「會不會走這一條」的判斷。', retry: true })
    return
  }
  judging.value = true
  try {
    const r = await apiFetch<ScriptTryResult>('/api/ai/playground', {
      method: 'POST',
      body: {
        query: text,
        routeOnly: true,
        draft: { id: props.scriptId ?? '', name: props.name, enabled: props.enabled, priority: props.priority, nodes: props.nodes, rootNodeId: props.rootNodeId },
      },
    })
    const verdict = verdictOf(r)
    push({ who: 'verdict', tone: verdict.hit ? 'hit' : 'miss', text: verdict.text })
    if (verdict.hit) startFlow(text)
    else done.value = true
  }
  catch {
    pendingFirst = text
    push({ who: 'verdict', tone: 'warn', text: '沒判斷成功（網路或伺服器問題），再試一次。', retry: true })
  }
  finally {
    judging.value = false
  }
}

function verdictOf(r: ScriptTryResult): { hit: boolean; text: string } {
  if (r.kind === 'script' && r.isDraft) {
    const when = props.enabled ? '' : '（開啟之後）'
    if (r.via === 'meaning') return { hit: true, text: `✓ ${when}會走這一條（AI 判斷意思相符）` }
    return { hit: true, text: r.keyword ? `✓ ${when}會走這一條（含「${r.keyword}」就直接接）` : `✓ ${when}會走這一條（客人打什麼都接）` }
  }
  if (r.kind === 'script') {
    const why = r.via === 'keyword' && r.keyword ? `（含「${r.keyword}」）` : '（AI 判斷）'
    return { hit: false, text: `✗ 不會走這一條：會走「${r.name || '(未命名)'}」${why}` }
  }
  if (r.kind === 'sensitive') return { hit: false, text: `✗ 不會走這一條：含敏感詞「${r.topic}」，會直接交給真人` }
  if (r.kind === 'orderInfoAsk') return { hit: false, text: '✗ 不會走這一條：客人只丟了訂單資料，機器人會先問他想詢問什麼' }
  if (r.reason === 'ship') return { hit: false, text: '✗ 不會走這一條：問的是出貨時間，交給 AI 回答' }
  return { hit: false, text: r.aiReplies ? '✗ 不會走這一條，交給 AI 回答' : '✗ 不會走這一條。AI 沒開，這句不會有人回' }
}

async function send(text?: string) {
  const msg = String(text ?? input.value).trim()
  if (!msg || judging.value) return
  input.value = ''
  push({ who: 'me', text: msg })
  if (done.value) { push({ who: 'sys', text: '（已經結束了，按「重來」再試一次）' }); return }

  if (!waiting.value) { await judgeFirst(msg); return }

  // 逃生門（與正式引擎同一份判斷詞）：流程進行中喊「找真人」→ 放棄流程、轉真人
  if (isHumanRequestText(msg)) {
    push({ who: 'sys', text: '↳ 放棄這條，轉真人客服（會回覆客人並通知值班同仁）' })
    done.value = true
    waiting.value = null
    return
  }
  const node = props.nodes.find(n => n.id === nodeId.value)
  if (node?.type === 'collect') {
    // 與引擎一致：先看是不是點了跳過按鈕（先於格式驗證）
    const skip = collectSkipLabel(node)
    if (skip && msg.toLowerCase() === skip.toLowerCase()) { run(node.skipNext!); return }
    const res = extractCollectValue(node, msg)
    if (!res.ok) {
      push({ who: 'bot', text: renderScriptTemplate(node.reaskText?.trim() || DEFAULT_COLLECT_REASK, { collected: collected.value }), buttons: [...(skip ? [skip] : []), '找真人'] })
      return
    }
    collected.value = { ...collected.value, [node.fieldName]: res.value }
    prefill(msg)
    run(node.next)
  }
  else if (node?.type === 'quickReply') {
    const opt = node.options.find(o => o.label.trim().toLowerCase() === msg.toLowerCase())
    if (!opt) {
      const labels = node.options.map(o => o.label)
      if (!labels.some(l => isHumanRequestText(l))) labels.push('找真人')
      push({ who: 'bot', text: renderScriptTemplate(node.question, { collected: collected.value }), buttons: labels })
      return
    }
    run(opt.next)
  }
  else {
    push({ who: 'sys', text: '（狀態異常，請按重來）' })
  }
}

/** 客人用圖片回答這一題（`D-138`②，與引擎一致：收下、往下走） */
function sendImage() {
  const node = props.nodes.find(n => n.id === nodeId.value)
  if (node?.type !== 'collect') return
  push({ who: 'me', text: '', image: true })
  collected.value = { ...collected.value, [node.fieldName]: SCRIPT_IMAGE_ANSWER }
  run(node.next)
}

defineExpose({ reset })
</script>
