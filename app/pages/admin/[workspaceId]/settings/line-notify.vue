<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="LINE 通知"
        caption="客人要找真人、每天早上的摘要，會用 LINE 傳到下面這些人的手機。"
        :help-topics="['line-notify']"
      />
    </template>

    <template #editor-body>
      <div v-if="loadError" class="solo-editor-body ai-load-error">
        <p>讀不到這一頁的資料，下面顯示的不是實際狀況。</p>
        <el-button type="primary" plain @click="load">重試</el-button>
      </div>
      <div v-else-if="!data" class="solo-editor-body tags-loading">
        <div class="spinner" />
        <span>載入中…</span>
      </div>

      <div v-else class="solo-editor-body admin-panel-stack">
        <!-- ── 誰會收到 ───────────────────────── -->
        <div class="message-card ln-card" data-tour="ln-who">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">誰會收到</span>
            </div>
            <span v-if="receivingCount" class="ln-card__meta">{{ receivingCount }} 位會收到</span>
          </div>
          <div class="card-section-stack">
            <p v-if="!data.lineConnected" class="ln-banner">
              還沒接上 LINE，通知傳不出去。先到「設定 → 組織與 LINE」接好，再回來把手機加進來。
            </p>
            <p v-else-if="!receivingCount && !adding" class="ln-banner">
              現在沒有人會收到。客人要找真人時，不會有人知道。
            </p>

            <ul class="ln-rows">
              <li v-for="row in data.rows" :key="row.uid" class="ln-row" :class="{ 'is-flash': flashUid === row.uid }">
                <img v-if="row.line?.pictureUrl" :src="row.line.pictureUrl" class="ln-row__avatar" alt="">
                <span v-else class="ln-row__avatar ln-row__avatar--initial">{{ initialOf(row) }}</span>
                <div class="ln-row__who">
                  <div class="ln-row__name">
                    {{ row.isSelf ? `你（${row.email || '我'}）` : (row.email || '（沒有 Email）') }}
                    <span class="ln-row__role">{{ roleLabel(row.role) }}</span>
                  </div>
                  <div class="ln-row__status" :class="statusOf(row).cls">
                    {{ statusOf(row).text }}
                    <span v-if="statusOf(row).sub" class="ln-row__sub">{{ statusOf(row).sub }}</span>
                  </div>
                </div>
                <div class="ln-row__actions">
                  <!-- 綁好的：收通知開關（自己那一列、或管理員） -->
                  <template v-if="row.line">
                    <!-- 觀察者不收通知（`C-271`⑬）：舊資料裡已經在收的只給關、不給開 -->
                    <el-switch
                      v-if="(row.isSelf || data.canManage) && (row.role !== 'viewer' || row.receiving)"
                      :model-value="row.receiving"
                      :loading="savingUid === row.uid"
                      active-text="收通知"
                      @change="setReceiving(row, $event === true)"
                    />
                    <el-button v-if="row.isSelf && !adding" size="small" text @click="startAdd">換一支手機</el-button>
                    <el-button v-else-if="!row.isSelf && data.canManage" size="small" text type="danger" @click="unbind(row)">解除綁定</el-button>
                  </template>
                  <!-- 還沒綁的：自己＝掃 QR；別人＝管理員可以改傳連結 -->
                  <template v-else>
                    <el-button
                      v-if="row.isSelf && !adding"
                      type="primary"
                      size="small"
                      data-tour="ln-add"
                      :disabled="!data.lineConnected"
                      @click="startAdd"
                    >
                      把我的手機加進來
                    </el-button>
                    <el-button
                      v-else-if="!row.isSelf && data.canManage"
                      size="small"
                      plain
                      :disabled="!data.lineConnected"
                      @click="sendLink(row)"
                    >
                      {{ copiedUid === row.uid ? '連結已複製' : '改傳連結' }}
                    </el-button>
                  </template>
                </div>
              </li>

              <!-- 舊資料：名單上、卻不是任何一位成員的 LINE 帳號（名單現在只收綁好的成員，只能拿掉） -->
              <li v-for="o in data.others" :key="o.lineUserId" class="ln-row">
                <span class="ln-row__avatar ln-row__avatar--initial">?</span>
                <div class="ln-row__who">
                  <div class="ln-row__name">{{ o.displayName || `LINE 帳號 …${o.lineUserId.slice(-6)}` }}</div>
                  <div class="ln-row__status is-warn">
                    不是成員的 LINE 帳號
                    <span class="ln-row__sub">名單只收綁好 LINE 的成員。這個帳號會一直收到客人的名字與訊息，確定是誰之前建議拿掉。</span>
                  </div>
                </div>
                <div class="ln-row__actions">
                  <el-button v-if="data.canManage" size="small" plain type="danger" @click="removeOther(o.lineUserId)">拿掉</el-button>
                </div>
              </li>
            </ul>

            <AdminLineNotifySelfAdd v-if="adding" @done="onAdded" @cancel="adding = false" />

            <div v-if="justAdded" class="ln-done" :class="{ 'is-warn': !justAdded.receiving }">
              <div>
                <h4 class="ln-done__title">
                  {{ justAdded.receiving ? `好了，你的 LINE「${justAdded.name}」加進來了` : `綁好了，但這支手機還沒收通知` }}
                </h4>
                <!-- ⛔ 沒進名單的原因要照實講（`C-271`⑨）：原本一律說「名單滿了」，寫入失敗時把人帶去做沒用的事 -->
                <p class="ln-done__text">
                  <template v-if="justAdded.receiving">
                    你的手機剛收到一則確認，寫著之後會收到什麼。{{ firstDigestPhrase }} 會收到第一則摘要。
                  </template>
                  <template v-else-if="justAdded.full">
                    名單滿了（最多 10 位）。請管理員關掉一位，再把你那一列的「收通知」打開。
                  </template>
                  <template v-else>
                    剛剛沒存進通知名單。把你那一列的「收通知」打開就好。
                  </template>
                </p>
              </div>
              <el-button size="small" plain @click="justAdded = null">知道了</el-button>
            </div>

            <p v-if="!data.deliveryKnown" class="ln-card__note">
              送到了沒的紀錄這次讀不到，上面每一列都先不講（不代表都送到了）。
            </p>
          </div>
        </div>

        <!-- ── 什麼時候通知（管理員；客服看不到這一塊，無權限一律隱藏） ── -->
        <div v-if="data.canManage" class="message-card ln-card" data-tour="ln-when">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">什麼時候通知</span>
            </div>
            <span class="ln-card__meta">上面每個人收到的都一樣</span>
          </div>
          <div class="card-section-stack">
            <div class="ln-when">
              <div class="ln-when__form">
                <div class="admin-field-group">
                  <AdminFieldLabel text="客人要找真人時" tight />
                  <el-radio-group v-model="timing.mode" class="ln-when__modes" @change="onModeChange">
                    <div class="ln-when__mode">
                      <el-radio value="always">馬上通知，</el-radio>
                      <!-- ⚠️ 上限要跟後端 normalize 一樣是 1440（`C-271`③）：寫小了，Element 一載入就把
                           超過的舊設定夾小並寫回，存任何一格時一起存進去＝提醒時間被默默改短 -->
                      <el-input-number
                        v-model="slaAlways"
                        :min="0"
                        :max="SLA_MAX"
                        :step="5"
                        size="small"
                        controls-position="right"
                        :disabled="timing.mode !== 'always'"
                        class="ln-when__num"
                        @change="saveTiming"
                      />
                      <span class="ln-when__tail">分鐘還沒人回再提醒一次</span>
                    </div>
                    <div class="ln-when__mode">
                      <el-radio value="missed_only">先不吵，等</el-radio>
                      <el-input-number
                        v-model="slaMissed"
                        :min="5"
                        :max="SLA_MAX"
                        :step="5"
                        size="small"
                        controls-position="right"
                        :disabled="timing.mode !== 'missed_only'"
                        class="ln-when__num"
                        @change="saveTiming"
                      />
                      <span class="ln-when__tail">分鐘沒人接手才通知</span>
                    </div>
                  </el-radio-group>
                  <p class="ai-section-hint">
                    {{ timing.mode === 'missed_only'
                      ? '客服整天開著後台的團隊用這個，省官方帳號的訊息額度。'
                      : '填 0 就只傳當下那一則，不再提醒。' }}
                  </p>
                </div>

                <div class="admin-field-group">
                  <AdminFieldLabel text="每天早上的摘要" tight />
                  <div class="ln-when__inline">
                    <el-select v-model="timing.digestHour" size="small" class="ai-hour-select" @change="saveTiming">
                      <el-option v-for="h in 24" :key="h - 1" :value="h - 1" :label="`${String(h - 1).padStart(2, '0')}:00`" />
                    </el-select>
                    <span class="ln-when__tail">傳昨天的成績和今天要處理的事</span>
                  </div>
                  <p v-if="data.serviceHours.enabled && data.serviceHours.weekendOff" class="ai-section-hint">
                    週末不傳（「服務時間」設了週六日休息）
                  </p>
                  <el-checkbox v-model="timing.festivalTips" @change="saveTiming">節日前 7／3／1 天，順便提醒行銷</el-checkbox>
                  <el-checkbox v-model="timing.weeklyInsights" @change="saveTiming">週一附「本週顧客觀察」</el-checkbox>
                </div>

                <div class="admin-field-group">
                  <AdminFieldLabel text="出大事時" tight />
                  <el-checkbox v-model="timing.criticalAlertPush" @change="saveTiming">不等摘要，馬上通知</el-checkbox>
                  <p class="ai-section-hint">機器人收不到客人訊息、回覆額度用完這類正在影響客人的事。只在 9:00–21:00 傳。</p>
                </div>
              </div>

              <div class="ln-phone" data-tour="ln-preview" aria-label="手機會收到的樣子">
                <div class="ln-phone__top"><span class="ln-phone__oa">LINE</span>手機會收到這樣的訊息</div>
                <el-radio-group v-model="previewTab" size="small" class="ln-phone__tabs">
                  <el-radio-button value="handoff">客人找真人</el-radio-button>
                  <el-radio-button value="digest">早上的摘要</el-radio-button>
                  <el-radio-button value="crit">出大事</el-radio-button>
                </el-radio-group>
                <div class="ln-phone__screen">
                  <template v-for="(b, i) in previewBubbles" :key="i">
                    <span v-if="b.when" class="ln-phone__when">{{ b.when }}</span>
                    <div class="ln-phone__bubble" :class="{ 'is-me': b.me }">{{ b.text }}</div>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
/**
 * 「設定 → LINE 通知」（`D-103`／`C-270`，2026-09-27 老闆拍板，照示意頁 artifact `DCNtvHLkws7NRiMmDXXqeZ` 做）。
 *
 * 一頁回答三件事：誰會收到（每位成員一列：綁了沒、收不收、送到了沒）、什麼時候收、手機上長什麼樣。
 * - 綁好＝加進名單；掃 QR 就加進來、當場知道成功（⛔ 不再有「我完成了」、不用再去別頁勾）
 * - 送不到的那一列變黃、寫原因（封鎖／被 LINE 退回）
 * - 名單只收綁好 LINE 的成員（第 2 題）；客服可以加／退自己（第 3 題）
 * - 右邊手機的內容跟真正送出的是**同一支函式**（`shared/line-notify-messages.ts`、`shared/daily-digest-message.ts`）
 */
import { ElMessageBox } from 'element-plus'
import {
  buildCriticalAlertText,
  buildHandoffNotifyText,
  buildNotifyConfirmText,
  nextDigestPhrase,
} from '~~/shared/line-notify-messages'
import { buildDigestLines, taipeiDateLabel } from '~~/shared/daily-digest-message'
import { taipeiDateKey } from '~~/shared/taipei-day'

definePageMeta({ middleware: ['auth', 'workspace-notify'], layout: 'default' })
useHead({ title: useAdminTitle('LINE 通知') })

type RecipientState =
  | { state: 'blocked', since: number, via: 'unfollow' | 'push' }
  | { state: 'failing', at: number, reason: string }
  /** 一時的失敗（LINE 5xx、送太快、斷線）：講一句「下一則會再試」，⛔ 不當成收不到（`C-271`⑦） */
  | { state: 'glitch', at: number, reason: string }
  | { state: 'ok', at: number, kind: 'notify' | 'confirm' }
  | { state: 'never' }

interface Row {
  uid: string
  email: string
  role: string
  isSelf: boolean
  line: { userId: string, displayName: string, pictureUrl: string } | null
  receiving: boolean
  pendingCodeExpiresAt: number | null
  delivery: RecipientState | null
}
interface Timing {
  mode: 'always' | 'missed_only'
  slaRemindMinutes: number
  digestHour: number
  festivalTips: boolean
  weeklyInsights: boolean
  criticalAlertPush: boolean
}
interface PageData {
  canManage: boolean
  selfUid: string
  selfIsMember: boolean
  lineConnected: boolean
  full: boolean
  rows: Row[]
  others: { lineUserId: string, displayName: string, delivery: RecipientState }[]
  deliveryKnown: boolean
  timing: Timing
  serviceHours: { enabled: boolean, start: string, end: string, weekendOff: boolean }
  /** 通知裡有沒有放連結（開關關著時預覽也不畫連結） */
  linksEnabled: boolean
}

const { apiFetch, workspaceId } = useWorkspace()
const { showToast } = useAdminToast()
const route = useRoute()
const router = useRouter()

const data = ref<PageData | null>(null)
const loadError = ref(false)
const adding = ref(false)
const justAdded = ref<{ name: string, receiving: boolean, full: boolean } | null>(null)
const flashUid = ref('')
const savingUid = ref('')
const copiedUid = ref('')
const previewTab = ref<'handoff' | 'digest' | 'crit'>('handoff')

/** 分鐘數上限：跟後端 normalizeAiSettings 的夾值同一個數字（24 小時） */
const SLA_MAX = 1440
const timing = ref<Timing>({ mode: 'always', slaRemindMinutes: 30, digestHour: 9, festivalTips: true, weeklyInsights: true, criticalAlertPush: true })
/** 兩個模式各記一個分鐘數：切模式時不會把另一邊的數字帶過去（missed_only 最少 5 分鐘） */
const slaAlways = ref(30)
const slaMissed = ref(30)

const receivingCount = computed(() =>
  (data.value?.rows.filter(r => r.receiving).length ?? 0) + (data.value?.others.length ?? 0))

const ROLE_LABELS: Record<string, string> = { owner: '擁有者', admin: '管理員', agent: '客服', viewer: '觀察者' }
function roleLabel(role: string) { return ROLE_LABELS[role] ?? role }
function initialOf(row: Row) {
  return (row.line?.displayName || row.email || '?').trim().slice(0, 1).toUpperCase()
}

function hhmm(ms: number) {
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
}
/** 「剛剛」「14:32」「9/25 10:02」 */
function when(ms: number) {
  const diff = Date.now() - ms
  if (diff < 2 * 60_000) return '剛剛'
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? hhmm(ms) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ms)}`
}

/** 那一列名字下面那一行 */
function statusOf(row: Row): { text: string, sub?: string, cls: string } {
  const lineName = row.line?.displayName ? `LINE「${row.line.displayName}」` : 'LINE 已綁定'
  if (row.line && row.receiving) {
    const d = row.delivery
    if (!data.value?.deliveryKnown || !d) return { text: lineName, cls: 'is-ok' }
    if (d.state === 'blocked') {
      const since = new Date(d.since)
      const who = row.isSelf ? '這支手機' : '對方'
      // 推播被退回那一種，LINE 對「封鎖」與「還沒加好友」回同一句，分不出來就兩個都講（⛔ 不講死是封鎖）
      return d.via === 'unfollow'
        ? {
            text: `送不到：${who}封鎖了官方帳號（${since.getMonth() + 1}/${since.getDate()} 起）`,
            sub: `請${row.isSelf ? '在 LINE 上' : '對方在 LINE '}解除封鎖，下一則就會送到。`,
            cls: 'is-warn',
          }
        : {
            text: `送不到：${who}封鎖了官方帳號，或還沒加好友（${since.getMonth() + 1}/${since.getDate()} 起）`,
            sub: `請${row.isSelf ? '' : '對方'}加官方帳號好友（或解除封鎖），下一則就會送到。`,
            cls: 'is-warn',
          }
    }
    if (d.state === 'failing') return { text: `上次沒送到（${when(d.at)}）：${d.reason}`, cls: 'is-warn' }
    // 一時的：照講發生了什麼，但不變黃（下一則會再試，通常就過了）
    if (d.state === 'glitch') return { text: `${lineName} · 上次沒送到（${when(d.at)}，${d.reason}），下一則會再試`, cls: '' }
    if (d.state === 'ok') {
      const t = when(d.at)
      return { text: `${lineName} · ${d.kind === 'confirm' ? `${t}送達確認訊息` : `上次送達 ${t}`}`, cls: 'is-ok' }
    }
    return { text: `${lineName} · 還沒傳過通知`, cls: 'is-ok' }
  }
  if (row.line) return { text: `${lineName} · 通知關著`, cls: '' }
  if (row.pendingCodeExpiresAt) return { text: `還沒加進來 · 等對方點連結（${hhmm(row.pendingCodeExpiresAt)} 前有效）`, cls: '' }
  if (row.isSelf) return { text: data.value?.selfIsMember ? '還沒加進來' : '還沒加進來（你不是這個帳號的成員，不能綁手機）', cls: '' }
  return { text: '還沒加進來 · 對方登入後台時會被問一次', cls: '' }
}

// ── 載入 ──
let pollTimer: ReturnType<typeof setInterval> | null = null
async function load() {
  try {
    const res = await apiFetch<PageData>(`/api/admin/workspaces/${workspaceId.value}/line-notify`)
    data.value = res
    applyTiming(res.timing)
    loadError.value = false
  }
  catch (e: any) {
    loadError.value = true
    showToast(e?.data?.statusMessage || '載入失敗', 'error')
  }
}
function applyTiming(t: Timing) {
  timing.value = { ...t }
  if (t.mode === 'missed_only') slaMissed.value = t.slaRemindMinutes
  else slaAlways.value = t.slaRemindMinutes
}

/** 有人在等對方點「改傳連結」的連結時，每 15 秒重抓一次（那一列會自己轉綠） */
function syncPoll() {
  const waiting = data.value?.rows.some(r => r.pendingCodeExpiresAt && r.pendingCodeExpiresAt > Date.now())
  if (waiting && !pollTimer) pollTimer = setInterval(load, 15_000)
  if (!waiting && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
watch(data, syncPoll)

// ── 自己加進來 ──
function startAdd() {
  justAdded.value = null
  adding.value = true
}
async function onAdded(s: { lineDisplayName: string, message: string }) {
  adding.value = false
  await load()
  const self = data.value?.rows.find(r => r.isSelf)
  justAdded.value = {
    name: s.lineDisplayName || self?.line?.displayName || '你',
    receiving: Boolean(self?.receiving),
    full: Boolean(data.value?.full),
  }
  // 手機預覽先秀他剛收到的那一來一回；點任何一個分頁就換回範例
  if (justAdded.value.receiving) confirmSent.value = s.message
  if (self) flash(self.uid)
}
/** 剛加好時他從手機送出的那一行；有值＝手機預覽秀「確認」那一來一回 */
const confirmSent = ref('')
watch(previewTab, () => { confirmSent.value = '' })
watch(justAdded, (v) => { if (!v) confirmSent.value = '' })
function flash(uid: string) {
  flashUid.value = uid
  setTimeout(() => { if (flashUid.value === uid) flashUid.value = '' }, 1600)
}

// ── 那一列的動作 ──
async function setReceiving(row: Row, on: boolean) {
  savingUid.value = row.uid
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/line-notify/receiving`, { method: 'PUT', body: { uid: row.uid, on } })
    await load()
    showToast(on ? '打開了，之後會收到通知' : '關掉了，這支手機不會再收到通知', 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '存不進去', 'error')
  }
  finally {
    savingUid.value = ''
  }
}

async function sendLink(row: Row) {
  try {
    const res = await apiFetch<{ message: string, bindUrl: string, expiresAt: number }>(
      `/api/admin/workspaces/${workspaceId.value}/members/${row.uid}/line-bind-code`,
      { method: 'POST' },
    )
    const text = res.bindUrl || res.message
    try {
      await navigator.clipboard.writeText(text)
      copiedUid.value = row.uid
      setTimeout(() => { if (copiedUid.value === row.uid) copiedUid.value = '' }, 2500)
      showToast(`連結已複製，用 LINE 傳給對方；${hhmm(res.expiresAt)} 前點開按送出就好`, 'success')
    }
    catch {
      await ElMessageBox.alert(text, '把這條連結傳給對方', { confirmButtonText: '好' })
    }
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '產生連結失敗', 'error')
  }
}

async function unbind(row: Row) {
  try {
    await ElMessageBox.confirm(
      '解除之後，這位成員的手機不會再收到任何 LINE 通知；要再收，得重新把手機加進來。',
      '解除 LINE 綁定',
      { confirmButtonText: '解除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger', type: 'warning' },
    )
  }
  catch { return }
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/members/${row.uid}/line-binding`, { method: 'DELETE' })
    showToast('已解除綁定', 'success')
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '解除失敗', 'error')
  }
}

async function removeOther(lineUserId: string) {
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/line-notify/receiving`, { method: 'PUT', body: { lineUserId, on: false } })
    showToast('拿掉了', 'success')
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '拿不掉', 'error')
  }
}

// ── 什麼時候通知（改了就存，跟每一列的開關一樣） ──
function onModeChange() {
  // 「只通知沒人接手的」下分鐘數是唯一的通知路徑，最少 5 分鐘（跟後端 normalize 同一條）
  if (timing.value.mode === 'missed_only' && slaMissed.value < 5) slaMissed.value = 30
  void saveTiming()
}
async function saveTiming() {
  const body = {
    ...timing.value,
    slaRemindMinutes: timing.value.mode === 'missed_only' ? slaMissed.value : slaAlways.value,
  }
  try {
    const res = await apiFetch<{ timing: Timing }>(`/api/admin/workspaces/${workspaceId.value}/line-notify/settings`, { method: 'PUT', body })
    applyTiming(res.timing)
    if (data.value) data.value.timing = res.timing
    showToast('已儲存', 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
    if (data.value) applyTiming(data.value.timing)
  }
}

// ── 手機預覽：跟送出端同一支函式，餵範例資料 ──
const currentTiming = computed(() => ({
  ...timing.value,
  slaRemindMinutes: timing.value.mode === 'missed_only' ? slaMissed.value : slaAlways.value,
}))
const firstDigestPhrase = computed(() =>
  nextDigestPhrase(Date.now(), currentTiming.value.digestHour, data.value?.serviceHours))
/** 開關關著（預設）就不放：預覽跟真正送出的一樣，退回「請至後台…」那一句 */
const sampleLink = computed(() => data.value?.linksEnabled ? `https://${useRequestURL().host}/c/7Kq2abX` : undefined)

const previewBubbles = computed<{ when: string, text: string, me?: boolean }[]>(() => {
  const t = currentTiming.value
  const link = sampleLink.value
  // 剛加好：他剛收到的那一則確認（跟後端回覆同一支函式、同一份設定）
  if (confirmSent.value && data.value) {
    return [
      { when: '剛剛', text: confirmSent.value, me: true },
      { when: '', text: buildNotifyConfirmText({ result: 'added', cfg: t, serviceHours: data.value.serviceHours, nowMs: Date.now() }) },
    ]
  }
  if (previewTab.value === 'handoff') {
    const sample = {
      customerName: '阿明',
      customerMessage: '我訂的禮盒可以改寄公司嗎',
      reasonLabel: '客人要求真人',
      summary: '想把禮盒改寄到公司，問還來不來得及',
      link,
    }
    if (t.mode === 'missed_only') {
      return [{ when: `範例 · 轉真人後 ${t.slaRemindMinutes} 分鐘`, text: buildHandoffNotifyText({ ...sample, slaReminderMinutes: t.slaRemindMinutes }) }]
    }
    const out = [{ when: '範例 · 轉真人當下', text: buildHandoffNotifyText(sample) }]
    if (t.slaRemindMinutes > 0) {
      out.push({
        when: `${t.slaRemindMinutes} 分鐘後還沒人回`,
        text: buildHandoffNotifyText({ customerName: '阿明', customerMessage: '', reasonLabel: '', slaReminderMinutes: t.slaRemindMinutes, link }),
      })
    }
    return out
  }
  if (previewTab.value === 'digest') {
    const tomorrow = taipeiDateKey(new Date(Date.now() + 86_400_000))
    const lines = buildDigestLines({
      dateLabel: taipeiDateLabel(tomorrow),
      yesterday: { total: 18, selfServed: 14, humanServed: 3, unhandled: 1, unhandledNames: ['小美'], newFriends: 2 },
      waiting: { count: 2, offHoursCount: 0, samples: [{ name: '阿明', waitedMinutes: 25 }, { name: 'Lulu', waitedMinutes: 120 }], truncated: false, staleHumanCount: 0 },
      todo: { outdatedSources: 0, failedSources: 0, expiredCards: 0, suggestions: 3, tagSuggestUsers: 0, warnings: 0, topWarningLabel: '' },
      festivalText: t.festivalTips ? '再過 7 天就是中秋節，禮盒與送禮的需求會明顯升溫。' : '',
      weeklyLines: [],
      unknownNotes: [],
      link,
    }) ?? []
    return [{ when: `範例 · 每天 ${String(t.digestHour).padStart(2, '0')}:00`, text: lines.join('\n') }]
  }
  if (!t.criticalAlertPush)
    return [{ when: '這一類關著', text: '出大事時不會另外傳，隔天的摘要裡會寫。' }]
  return [{
    when: '範例 · 週四 14:20',
    text: buildCriticalAlertText({ count: 1, lines: ['・機器人收不到客人訊息'], more: 0, link }),
  }]
})

onMounted(async () => {
  await load()
  // 小幫手「現在沒有人會收到」帶路時帶 ?add=me：直接打開掃 QR 那一塊（參數用完即丟）
  if (route.query.add === 'me') {
    router.replace({ query: { ...route.query, add: undefined } })
    const self = data.value?.rows.find(r => r.isSelf)
    if (self && !self.line && data.value?.lineConnected) startAdd()
  }
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
