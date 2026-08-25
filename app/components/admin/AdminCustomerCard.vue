<template>
  <!-- ══════════════════════════════════════════════════════════════
       客人檔案卡（G-26）：**一個客人、一張卡、兩個入口**的那張卡。
       兩個宿主共用同一份：
         ①「好友」頁點客人 → 右側抽屜
         ②「客服對話」頁選對話 → 右側常駐面板
       ⛔ 不要複製第二份：改一次要兩邊都變（複製品遲早只改到一邊）。

       版面參考 LINE 官方帳號後台的右側面板（2026-08-24 老闆指定）：
       頭像＋名字 → **標籤緊接在名字下面、附「＋ 新增標籤」即時操作** →
       其他資訊。把標籤放最上面是他們對的地方：接手一個客人時第一眼要看的就是
       「這人是誰」，不該藏在對話框後面。
       ══════════════════════════════════════════════════════════════ -->
  <div class="cust-card">
    <div class="cust-card__head">
      <img v-if="pictureUrl" :src="pictureUrl" class="cust-card__avatar" :alt="displayName" />
      <span v-else class="cust-card__avatar cust-card__avatar--empty"><el-icon><User /></el-icon></span>
      <div class="cust-card__title">
        <div class="cust-card__name-row">
          <span class="cust-card__name">{{ displayName || userId }}</span>
          <!-- 客服右鍵標的「待跟進」在清單上看得到、點進客人卻看不到 → 交接的人不知道
               前一手把這位列為待跟進（D-29②）。有標才出現。 -->
          <span v-if="detail?.flags?.followUp" class="cust-card__flag">🚩 待跟進</span>
        </div>
        <span v-if="detail?.isBlocked" class="cust-card__blocked">已封鎖／退追蹤</span>
        <div class="cust-card__subrow">
          <span v-if="joinedText" class="cust-card__sub">加入於 {{ joinedText }}</span>
          <!-- 查訂單、對帳、回報問題常要這串 ID，現在得去資料庫撈（D-29④） -->
          <button
            v-if="detail?.lineUserId"
            type="button"
            class="cust-card__copy"
            :title="`複製這位客人的 LINE ID：${detail.lineUserId}`"
            @click="copyLineId"
          >{{ copiedId ? '已複製' : '複製 ID' }}</button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="cust-card__loading"><div class="spinner" /><span>載入中…</span></div>
    <p v-else-if="loadError" class="cust-card__error">
      客人資料載入失敗。<el-button size="small" text type="primary" @click="load">重試</el-button>
    </p>

    <template v-else-if="detail">
      <!-- ── 標籤（照 LINE：緊接名字，且可就地新增）───────────── -->
      <section class="cust-card__section">
        <div class="cust-card__section-hd">
          <span class="cust-card__section-title">標籤</span>
          <button
            v-if="canOperate && !adding"
            type="button"
            class="cust-card__add"
            @click="startAdd"
          >＋ 新增標籤</button>
        </div>

        <div v-if="adding" class="cust-card__add-row">
          <el-select
            ref="addSelect"
            v-model="addTagId"
            filterable
            placeholder="選標籤（可打字搜尋）"
            size="small"
            class="cust-card__add-select"
            @change="applyAdd"
          >
            <el-option v-for="t in addableTags" :key="t.id" :label="t.name" :value="t.id">
              <AdminTagOptionRow :label="t.name" :color="t.color" />
            </el-option>
          </el-select>
          <el-button size="small" text @click="adding = false">取消</el-button>
        </div>

        <div v-if="tagRows.length" class="cust-card__tags">
          <AdminTagTintChip v-for="t in tagRows" :key="t.tagId" :color="t.color">
            {{ t.name }}<small v-if="t.sourceLabel" class="cust-card__tag-src">{{ t.sourceLabel }}</small>
            <button
              v-if="canOperate"
              type="button"
              class="tag-chip-remove"
              :title="`移除「${t.name}」`"
              @click="removeTag(t.tagId)"
            >✕</button>
          </AdminTagTintChip>
        </div>
        <span v-else-if="!adding" class="cust-card__empty">尚無標籤</span>
      </section>

      <!-- ── AI 建議（有才出現；採用才真的貼）──────────────── -->
      <section v-if="pendingSuggestions.length" class="cust-card__section cust-card__section--suggest">
        <span class="cust-card__section-title">AI 建議的標籤</span>
        <p class="cust-card__hint">AI 從對話內容判斷的，按「採用」才會真的貼上。</p>
        <div v-for="s in pendingSuggestions" :key="s.tagId" class="cust-card__suggest">
          <div class="cust-card__suggest-main">
            <AdminTagTintChip :color="tagById(s.tagId)?.color ?? '#8a95a1'">
              {{ tagById(s.tagId)?.name ?? '（已刪除的標籤）' }}
            </AdminTagTintChip>
            <span v-if="s.reason" class="cust-card__suggest-why">{{ s.reason }}</span>
          </div>
          <div v-if="canOperate" class="cust-card__suggest-actions">
            <el-button size="small" type="primary" :loading="acting === s.tagId" @click="actOnSuggestion(s.tagId, 'apply')">採用</el-button>
            <el-button size="small" :loading="acting === s.tagId" @click="actOnSuggestion(s.tagId, 'dismiss')">忽略</el-button>
          </div>
        </div>
      </section>

      <!-- ── 負責人員（D-29①）──────────────────────────────
           ⛔ 對話頁不顯示（`showAssignee=false`）：那一頁頂部已經有同一顆控制項，
              同一個畫面兩個入口改同一份資料＝遲早有人只改到一邊。
              好友頁抽屜沒有那顆，這裡是它唯一的家。 -->
      <section v-if="showAssignee" class="cust-card__section">
        <div class="cust-card__section-hd">
          <span class="cust-card__section-title">負責人員</span>
          <button
            v-if="canOperate && !assigneeEditing"
            type="button"
            class="cust-card__add"
            @click="startEditAssignee"
          >{{ assignee.uid ? '換人' : '＋ 指派' }}</button>
        </div>
        <template v-if="assigneeEditing">
          <el-select
            v-model="assigneePick"
            filterable
            clearable
            placeholder="選一位同事（清空＝取消指派）"
            size="small"
            class="cust-card__add-select"
            :loading="assigneeLoading"
            @change="applyAssignee"
          >
            <el-option v-for="m in assignableMembers" :key="m.uid" :label="m.name" :value="m.uid" />
          </el-select>
          <!-- ⛔ 三態：查不到同事名單要講出來，不可以顯示成一個空的下拉（08-09 假綠燈） -->
          <span v-if="assigneeLoadFailed" class="cust-card__empty">同事名單載入失敗，請重新整理。</span>
          <div class="cust-card__note-actions">
            <el-button size="small" @click="assigneeEditing = false">取消</el-button>
          </div>
        </template>
        <template v-else-if="assignee.uid">
          <p class="cust-card__owner">{{ assignee.name }}</p>
          <span v-if="assignee.assignedAtMs" class="cust-card__note-by">{{ relativeTime(assignee.assignedAtMs) }}指派</span>
        </template>
        <span v-else class="cust-card__empty">還沒有人負責</span>
      </section>

      <!-- ── 備註（客服交接用；客人看不到）────────────────── -->
      <section class="cust-card__section">
        <div class="cust-card__section-hd">
          <span class="cust-card__section-title">備註</span>
          <button
            v-if="canOperate && !editingNote"
            type="button"
            class="cust-card__add"
            @click="startEditNote"
          >{{ note.text ? '編輯' : '＋ 寫備註' }}</button>
        </div>
        <!-- 這句一定要在：客服不敢寫的第一個理由就是「這會不會被客人看到」 -->
        <p class="cust-card__hint">寫給同事看的，客人看不到。</p>

        <template v-if="editingNote">
          <el-input
            ref="noteInput"
            v-model="noteDraft"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 10 }"
            :maxlength="CUSTOMER_NOTE_MAX_CHARS"
            show-word-limit
            resize="none"
            placeholder="例：這位客人堅持要原廠保固，已回報廠商，等回覆"
          />
          <div class="cust-card__note-actions">
            <el-button size="small" :disabled="savingNote" @click="cancelEditNote">取消</el-button>
            <el-button size="small" type="primary" :loading="savingNote" @click="saveNote">儲存</el-button>
          </div>
        </template>
        <template v-else-if="note.text">
          <p class="cust-card__note-text">{{ note.text }}</p>
          <!-- 交接看的是「誰在什麼時候留的」：沒有這行，三天前的狀況會被當成現在的狀況 -->
          <span v-if="noteByline" class="cust-card__note-by">{{ noteByline }}</span>
        </template>
        <span v-else class="cust-card__empty">還沒有備註</span>
      </section>

      <!-- ── 最後互動 ───────────────────────────────────
           ⛔ 對話頁不顯示（`showLastActivity=false`，老闆 08-25 指出）：
              左邊就是完整對話，「最後訊息」在那裡看得一清二楚，再列一次是重複。
              但好友頁抽屜旁邊沒有對話，這區是判斷「這位還熱著嗎」唯一的線索——
              所以是**同一張卡在兩個家各顯示適合的欄位**，不是刪功能。 -->
      <section v-if="showLastActivity" class="cust-card__section">
        <span class="cust-card__section-title">最後互動</span>
        <!-- 新客與來過十幾次的常客，接手時的語氣完全不同（D-29③）。
             null＝查不到就整列不出現，⛔ 不要顯示「0 次」那種謊話 -->
        <div v-if="detail.sessionCount !== null" class="cust-card__kv">
          <span class="cust-card__k">來過</span>
          <b class="cust-card__v">{{ detail.sessionCount }} 次對話</b>
        </div>
        <div class="cust-card__kv">
          <span class="cust-card__k">最後來訊</span>
          <!-- ⛔ 三種「沒有時間」要分開講：舊客／從沒打字過／連對話都沒有（見 lastInbound） -->
          <b class="cust-card__v" :class="{ 'cust-card__v--soft': lastInbound.soft }">{{ lastInbound.text }}</b>
        </div>
        <div class="cust-card__kv">
          <span class="cust-card__k">最後訊息</span>
          <b class="cust-card__v cust-card__v--clip">
            <template v-if="detail.conversation?.lastMessage">
              {{ detail.conversation.lastDirection === 'incoming' ? '客人：' : '我們：' }}{{ detail.conversation.lastMessage }}
            </template>
            <template v-else>—</template>
          </b>
        </div>
        <div v-if="showConversationLink && detail.conversation" class="cust-card__section-actions">
          <el-button size="small" text type="primary" @click="emit('open-conversation')">看完整對話 →</el-button>
        </div>
      </section>

      <!-- ── 腳本收集到的資料 ──────────────────────────── -->
      <section class="cust-card__section">
        <div class="cust-card__section-hd">
          <span class="cust-card__section-title">收集到的資料</span>
          <!-- ⚠️ 寫入這裡的是腳本「存進客人資料」步驟（saveLead），不是「收集」——
               收集只是問，有沒有存下來看腳本有沒有接那一步。文案照編輯器的步驟名講。
               G-27⑥：這段解釋原本是常駐兩行的空狀態，但「多數客人沒填過表單」才是常態——
               常態不該佔兩行，收進問號裡，滑上去才講。 -->
          <span
            v-if="!attributeRows.length"
            class="cust-card__why"
            title="腳本走到「存進客人資料」步驟時，存下來的欄位會出現在這裡。多數客人沒走過收資料的腳本，所以這裡通常是空的。"
            aria-label="這裡為什麼是空的"
          >?</span>
        </div>
        <table v-if="attributeRows.length" class="cust-card__attrs">
          <tbody>
            <tr v-for="[k, v] in attributeRows" :key="k">
              <th>{{ k }}</th>
              <td>{{ v }}</td>
            </tr>
          </tbody>
        </table>
        <span v-else class="cust-card__empty">還沒有收集到資料</span>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { User } from '@element-plus/icons-vue'
import { INBOUND_TIME_TRACKING_SINCE } from '~~/shared/types/ai-knowledge'
import { CUSTOMER_NOTE_MAX_CHARS, type CustomerNote } from '~~/shared/customer-note'
import { NO_ASSIGNEE, type ConversationAssignee } from '~~/shared/conversation-assignee'

interface CustomerDetail {
  id: string
  /** 純 LINE userId（不含租戶前綴）——查訂單／對帳要複製的就是這串 */
  lineUserId: string
  displayName: string
  pictureUrl: string
  isBlocked: boolean
  createdAtMs: number
  attributes: Record<string, string>
  tags: Array<{ tagId: string; sourceType: string; createdAtMs: number }>
  conversation: {
    lastMessage: string
    lastDirection: 'incoming' | 'outgoing' | null
    lastMessageAtMs: number
    lastInboundMessageAtMs: number
  } | null
  tagSuggestions: { pending: Array<{ tagId: string; reason: string; suggestedAtMs: number }> } | null
  note: CustomerNote
  /** 來過幾次；null＝查不到（畫面不顯示那一列，不拿 0 充數） */
  sessionCount: number | null
  assignee: ConversationAssignee
  flags: { pinned: boolean; followUp: boolean }
}

const props = withDefaults(defineProps<{
  /** users 主鍵（`${workspaceId}_${lineUserId}`）；換人時自動重載 */
  userId: string
  apiFetch: <T>(url: string, opts?: any) => Promise<T>
  canOperate?: boolean
  /** 好友頁要顯示「看完整對話 →」；對話頁本身不需要（人已經在那裡了） */
  showConversationLink?: boolean
  /**
   * 「最後互動」要不要顯示（D-29②）。
   * 好友頁＝要（旁邊沒有對話，它是唯一線索）；對話頁＝不要（左邊就是完整對話，重複）。
   */
  showLastActivity?: boolean
  /**
   * 「負責人員」要不要顯示（D-29①）。
   * 好友頁＝要（那頁沒有別的地方看得到誰在跟）；對話頁＝不要（頂部已經有同一顆控制項，
   * 同畫面兩個入口改同一份資料遲早只改到一邊）。
   */
  showAssignee?: boolean
  /** 列表已知的名字／頭像：先畫出來再補詳情，避免面板一開是空的 */
  fallbackName?: string
  fallbackPicture?: string
}>(), {
  // 這兩個**預設要顯示**：好友頁（另一個宿主）什麼都不用傳就拿到完整的卡，
  // 只有對話頁需要明確關掉。⛔ 預設 false 的話新宿主會默默少東西。
  showLastActivity: true,
  showAssignee: true,
})

const emit = defineEmits<{
  /** 貼標／移標／採用建議之後：宿主可以重新載入自己的清單 */
  (e: 'changed'): void
  (e: 'open-conversation'): void
}>()

const { showToast } = useAdminToast()
const { tags: allTags, loadTags } = useAdminTagList()

const detail = ref<CustomerDetail | null>(null)
const loading = ref(false)
const loadError = ref(false)
const adding = ref(false)
const addTagId = ref<string>('')
const acting = ref<string | null>(null)

const displayName = computed(() => detail.value?.displayName || props.fallbackName || '')
const pictureUrl = computed(() => detail.value?.pictureUrl || props.fallbackPicture || '')
/**
 * ⛔ 和「最後來訊」走同一支 calendarDate（G-27⑥）。
 * 原本這裡是 toLocaleDateString() 的完整年月日、那邊是 relativeTime 的月日，
 * 同一張卡兩種日期寫法。
 */
const joinedText = computed(() => calendarDate(detail.value?.createdAtMs ?? 0))

/** 標籤來源白話標示：AI 貼的要看得出是 AI 貼的，出錯才追得回來。手動＝預設不標（整排「手動」是噪音） */
const TAG_SOURCE_LABELS: Record<string, string> = {
  import: '匯入', rule: '規則', system: '系統', ai: 'AI',
}

function tagById(tagId: string) {
  return allTags.value.find((t: any) => t.id === tagId) ?? null
}

const tagRows = computed(() =>
  (detail.value?.tags ?? []).map(t => ({
    tagId: t.tagId,
    name: tagById(t.tagId)?.name ?? '（已刪除的標籤）',
    color: tagById(t.tagId)?.color ?? '#8a95a1',
    sourceLabel: TAG_SOURCE_LABELS[t.sourceType] ?? '',
  })),
)

/** 還沒貼上的、啟用中的標籤才能加 */
const addableTags = computed(() => {
  const has = new Set((detail.value?.tags ?? []).map(t => t.tagId))
  return allTags.value.filter((t: any) => !has.has(t.id) && t.status !== 'inactive')
})

const pendingSuggestions = computed(() => detail.value?.tagSuggestions?.pending ?? [])
const attributeRows = computed(() => Object.entries(detail.value?.attributes ?? {}))

/* ── 負責人員（D-29①）──────────────────────────────────────
   ⛔ 端點與資料形狀跟對話頁頂部那顆共用（`/api/conversations/assignees`＋
   `/api/conversations/:userId/assignee`），不要在這裡自己寫一套判斷。 */
interface AssignableMember { uid: string, name: string }

const assigneeEditing = ref(false)
const assigneeLoading = ref(false)
/** ⛔ 三態：查不到同事名單要講出來，不可以顯示成一個空下拉（08-09「查不到≠沒問題」） */
const assigneeLoadFailed = ref(false)
const assigneeLoaded = ref(false)
const assignableMembers = ref<AssignableMember[]>([])
const assigneePick = ref('')

const assignee = computed<ConversationAssignee>(() => detail.value?.assignee ?? NO_ASSIGNEE)

async function startEditAssignee() {
  assigneePick.value = assignee.value.uid
  assigneeEditing.value = true
  if (assigneeLoaded.value || assigneeLoading.value) return
  assigneeLoading.value = true
  assigneeLoadFailed.value = false
  try {
    const res = await props.apiFetch<{ members: AssignableMember[] }>('/api/conversations/assignees')
    assignableMembers.value = res.members ?? []
    assigneeLoaded.value = true
  }
  catch {
    assigneeLoadFailed.value = true
  }
  finally {
    assigneeLoading.value = false
  }
}

/** 清空（uid 空字串）＝取消指派，與對話頁頂部那顆的語意一致 */
async function applyAssignee(uid: string | null) {
  const next = String(uid ?? '')
  try {
    const saved = await props.apiFetch<ConversationAssignee>(
      `/api/conversations/${props.userId}/assignee`,
      { method: 'POST', body: { uid: next } },
    )
    if (detail.value) detail.value.assignee = saved
    assigneeEditing.value = false
    showToast(saved.uid ? `已指派給 ${saved.name}` : '已取消指派', 'success')
    emit('changed')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '指派失敗', 'error')
  }
}

/* ── 複製 LINE ID（D-29④）───────────────────────────────── */
const copiedId = ref(false)

async function copyLineId() {
  const id = detail.value?.lineUserId
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    copiedId.value = true
    // ⛔ 用「已複製」取代 toast：這是一個小到不值得打斷視線的動作
    setTimeout(() => { copiedId.value = false }, 1500)
  }
  catch {
    // 剪貼簿被瀏覽器擋掉（非 https／權限）→ 講出來，不要按了完全沒反應
    showToast('瀏覽器擋住了複製，請手動選取', 'error')
  }
}

/* ── 備註（G-27 功能缺口①）────────────────────────────────── */
const editingNote = ref(false)
const savingNote = ref(false)
const noteDraft = ref('')
const noteInput = ref<{ focus: () => void } | null>(null)

const EMPTY_NOTE: CustomerNote = { text: '', updatedByName: '', updatedAtMs: 0 }
const note = computed<CustomerNote>(() => detail.value?.note ?? EMPTY_NOTE)

/** 「誰在什麼時候留的」。缺哪一半就只講有的那半，不要生出「（ 於 ）」這種空殼 */
const noteByline = computed(() => {
  const who = note.value.updatedByName
  const when = note.value.updatedAtMs ? relativeTime(note.value.updatedAtMs) : ''
  if (who && when) return `${who} · ${when}`
  return who || when
})

function startEditNote() {
  noteDraft.value = note.value.text
  editingNote.value = true
  void nextTick(() => noteInput.value?.focus())
}

function cancelEditNote() {
  editingNote.value = false
  noteDraft.value = ''
}

async function saveNote() {
  savingNote.value = true
  try {
    const saved = await props.apiFetch<CustomerNote>(`/api/users/${props.userId}/note`, {
      method: 'POST',
      body: { text: noteDraft.value },
    })
    // 就地更新，不整份重載：重載會把展開中的標籤選單、捲動位置一起打掉
    if (detail.value) detail.value.note = saved
    editingNote.value = false
    showToast(saved.text ? '備註已儲存' : '備註已清空', 'success')
    emit('changed')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '備註儲存失敗', 'error')
  }
  finally {
    savingNote.value = false
  }
}

/**
 * 「最後來訊」要顯示什麼。系統從 INBOUND_TIME_TRACKING_SINCE 才開始記，
 * 所以「查不到」有兩種完全不同的意思，不能用同一句話帶過。
 */
const lastInbound = computed<{ text: string; soft: boolean }>(() => {
  const conv = detail.value?.conversation
  if (!conv) return { text: '—', soft: true }
  if (conv.lastInboundMessageAtMs) return { text: relativeTime(conv.lastInboundMessageAtMs), soft: false }
  const cutoffMs = Date.parse(`${INBOUND_TIME_TRACKING_SINCE}T00:00:00+08:00`)
  if (conv.lastMessageAtMs && conv.lastMessageAtMs < cutoffMs) {
    return { text: `更早之前（系統 ${INBOUND_TIME_TRACKING_SINCE} 才開始記這個時間）`, soft: true }
  }
  return { text: '還沒傳過訊息（只按過按鈕或加了好友）', soft: true }
})

async function load() {
  if (!props.userId) return
  loading.value = true
  loadError.value = false
  try {
    detail.value = await props.apiFetch<CustomerDetail>(`/api/users/${props.userId}/detail`)
  }
  catch {
    // ⛔ 三態：載入失敗要講出來並給重試，不可靜靜回空值假裝「這個客人沒資料」
    detail.value = null
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

function startAdd() {
  addTagId.value = ''
  adding.value = true
}

async function applyAdd(tagId: string) {
  if (!tagId) return
  try {
    await props.apiFetch(`/api/users/${props.userId}/tags`, { method: 'POST', body: { tagIds: [tagId] } })
    showToast('標籤已加上', 'success')
    adding.value = false
    await load()
    emit('changed')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '加標失敗', 'error')
  }
}

async function removeTag(tagId: string) {
  try {
    await props.apiFetch(`/api/users/${props.userId}/tags/${tagId}`, { method: 'DELETE' })
    showToast('標籤已移除', 'success')
    await load()
    emit('changed')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '移除失敗', 'error')
  }
}

/** 採用＝真的貼上（來源記 AI、可撤）；忽略＝這顆標籤對這位客人永遠不再建議 */
async function actOnSuggestion(tagId: string, action: 'apply' | 'dismiss') {
  acting.value = tagId
  try {
    await props.apiFetch(`/api/users/${props.userId}/tag-suggestions`, {
      method: 'POST',
      body: { action, tagIds: [tagId] },
    })
    showToast(action === 'apply' ? '已採用，標籤貼上了' : '已忽略，不會再建議這個標籤', 'success')
    await load()
    emit('changed')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '操作失敗', 'error')
  }
  finally {
    acting.value = null
  }
}

// 換人就重載；標籤目錄只載一次（chip 的名字與顏色靠它）
watch(() => props.userId, (id) => {
  adding.value = false
  // ⛔ 換人一定要收掉編輯中的備註：不收的話上一位客人打到一半的字會留在框裡，
  //    下一位客人按儲存就把它寫到**別人**身上（同一個元件實例、只換 userId）
  cancelEditNote()
  assigneeEditing.value = false
  if (id) void load()
}, { immediate: true })

onMounted(() => {
  if (!allTags.value.length) void loadTags({ limit: 200 })
})
</script>
