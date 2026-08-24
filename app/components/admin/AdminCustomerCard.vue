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
        <span class="cust-card__name">{{ displayName || userId }}</span>
        <span v-if="detail?.isBlocked" class="cust-card__blocked">已封鎖／退追蹤</span>
        <span v-if="joinedText" class="cust-card__sub">加入於 {{ joinedText }}</span>
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

      <!-- ── 最後互動 ─────────────────────────────────── -->
      <section class="cust-card__section">
        <span class="cust-card__section-title">最後互動</span>
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
        <span class="cust-card__section-title">收集到的資料</span>
        <table v-if="attributeRows.length" class="cust-card__attrs">
          <tbody>
            <tr v-for="[k, v] in attributeRows" :key="k">
              <th>{{ k }}</th>
              <td>{{ v }}</td>
            </tr>
          </tbody>
        </table>
        <!-- ⚠️ 寫入這裡的是腳本「存進客人資料」步驟（saveLead），不是「收集」——
             收集只是問，有沒有存下來看腳本有沒有接那一步。文案照編輯器的步驟名講。 -->
        <p v-else class="cust-card__note">
          還沒有——腳本走到「存進客人資料」步驟時，存下來的欄位會出現在這裡。
        </p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { User } from '@element-plus/icons-vue'
import { INBOUND_TIME_TRACKING_SINCE } from '~~/shared/types/ai-knowledge'

interface CustomerDetail {
  id: string
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
}

const props = defineProps<{
  /** users 主鍵（`${workspaceId}_${lineUserId}`）；換人時自動重載 */
  userId: string
  apiFetch: <T>(url: string, opts?: any) => Promise<T>
  canOperate?: boolean
  /** 好友頁要顯示「看完整對話 →」；對話頁本身不需要（人已經在那裡了） */
  showConversationLink?: boolean
  /** 列表已知的名字／頭像：先畫出來再補詳情，避免面板一開是空的 */
  fallbackName?: string
  fallbackPicture?: string
}>()

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
const joinedText = computed(() => {
  const ms = detail.value?.createdAtMs
  return ms ? new Date(ms).toLocaleDateString('zh-TW') : ''
})

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
  if (id) void load()
}, { immediate: true })

onMounted(() => {
  if (!allTags.value.length) void loadTags({ limit: 200 })
})
</script>
