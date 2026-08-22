<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="會員"
        title="好友與標籤"
        caption="管理 LINE 好友，查看與操作會員標籤"
      />
      <div class="flex gap-1 admin-header-actions">
        <el-button v-if="canOperate" size="small" type="primary" data-tour="usr-sync" :loading="syncingLine" @click="syncFromLine">
          從 LINE 同步好友
        </el-button>
        <span v-if="syncingLine" class="text-xs text-muted">{{ syncProgress }}</span>
        <el-button size="small" @click="loadData">重新整理</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div v-if="selectedIds.length" class="users-batch-bar">
          <span class="users-batch-info">已選 {{ selectedIds.length }} 位</span>
          <el-button v-if="canOperate" size="small" type="primary" @click="openBatchTag('add')">＋ 批次加標</el-button>
          <el-button v-if="canOperate" size="small" @click="openBatchTag('remove')">－ 批次移標</el-button>
          <el-button size="small" text @click="selectedIds = []">取消選取</el-button>
        </div>

        <div class="message-card users-page-card" data-tour="usr-list">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">篩選與表格</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="users-toolbar" data-tour="usr-filter">
              <div class="users-toolbar__field users-toolbar__field--search">
                <AdminFieldLabel text="搜尋顯示名稱" tight />
                <el-input v-model="searchText" placeholder="輸入關鍵字…" clearable />
              </div>
              <div class="users-toolbar__field users-toolbar__field--tags">
                <AdminFieldLabel text="篩選標籤（符合任一）" tight />
                <el-select
                  v-model="filterTagIds"
                  multiple
                  collapse-tags
                  placeholder="選擇標籤"
                  clearable
                >
                  <el-option
                    v-for="tag in allTags"
                    :key="tag.id"
                    :label="tag.name"
                    :value="tag.id"
                  >
                    <AdminTagOptionRow :label="tag.name" :color="tag.color" />
                  </el-option>
                </el-select>
              </div>
              <span class="tags-count text-muted">共 {{ total.toLocaleString('zh-TW') }} 位</span>
            </div>
            <p class="users-sync-hint text-muted">
              清單來自資料庫：若只有「曾傳訊／按鈕／加好友後有觸發 Webhook」的帳號，請按上方「從 LINE 同步好友」以拉取官方好友名單（Messaging API
              <code class="users-sync-hint__code">/v2/bot/followers/ids</code>）。大量好友時會自動分批，可連按數次直到完成。
            </p>

            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <div v-else-if="!users.length" class="tags-empty">
              <span>{{ total ? '無符合條件的會員' : '尚無好友資料' }}</span>
            </div>
            <div v-else class="table-wrap">
              <table class="users-table">
                <thead>
                  <tr>
                    <th class="users-table__th--check">
                      <input
                        type="checkbox"
                        :checked="isAllSelected"
                        :indeterminate="isIndeterminate"
                        @change="toggleSelectAll"
                      />
                    </th>
                    <th>會員</th>
                    <th>加入時間</th>
                    <th class="users-table__th--actions">標籤操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="user in users" :key="user.id">
                    <td>
                      <input
                        type="checkbox"
                        :checked="selectedIds.includes(user.id)"
                        @change="toggleSelect(user.id)"
                      />
                    </td>
                    <td>
                      <!-- 點名字開單頁（G-6）：鍵盤走右邊「查看」按鈕，這裡是滑鼠捷徑 -->
                      <div class="user-identity user-identity--clickable" @click="openUserDetail(user)">
                        <img
                          v-if="user.pictureUrl"
                          :src="user.pictureUrl"
                          class="user-avatar"
                          :alt="user.displayName"
                        />
                        <span v-else class="user-avatar-placeholder"><el-icon><User /></el-icon></span>
                        <span class="user-name">{{ user.displayName || user.id }}</span>
                      </div>
                    </td>
                    <td class="td-time">{{ formatZhDateOnly(user.createdAt) }}</td>
                    <td>
                      <div class="td-actions">
                        <el-button size="small" @click="openUserDetail(user)">查看</el-button>
                        <el-button size="small" @click="openUserTagDialog(user)">
                          標籤（{{ user.tags.length }}）
                        </el-button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="!loading && total > pageSize" class="admin-table-pager">
              <el-pagination
                :current-page="page"
                :page-size="pageSize"
                :total="total"
                layout="total, prev, pager, next"
                background
                @current-change="onPageChange"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <el-dialog
    v-model="batchDialogVisible"
    :title="batchMode === 'add' ? `批次加標（${selectedIds.length} 位）` : `批次移標（${selectedIds.length} 位）`"
    width="min(420px, 92vw)"
  >
    <div class="admin-field-stack">
      <div class="admin-field-group">
        <AdminFieldLabel :text="batchMode === 'add' ? '選擇要加上的標籤' : '選擇要移除的標籤'" tight />
        <el-select
          v-model="batchTagIds"
          multiple
          placeholder="選擇標籤"
          class="users-dialog-select"
        >
          <el-option v-for="tag in allTags" :key="tag.id" :label="tag.name" :value="tag.id">
            <AdminTagOptionRow :label="tag.name" :color="tag.color" />
          </el-option>
        </el-select>
      </div>
      <div class="admin-alert admin-alert--warn">
        <span>此操作將影響 <strong>{{ selectedIds.length }}</strong> 位會員</span>
      </div>
    </div>
    <template #footer>
      <el-button @click="batchDialogVisible = false">取消</el-button>
      <el-button
        v-if="canOperate"
        type="primary"
        :loading="batchSaving"
        :disabled="!batchTagIds.length"
        @click="submitBatch"
      >
        {{ batchMode === 'add' ? '確認加標' : '確認移標' }}
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="userTagDialogVisible"
    :title="`管理標籤：${dialogUser?.displayName ?? ''}`"
    width="min(480px, 92vw)"
    class="users-tag-dialog"
  >
    <div v-if="dialogUser" class="admin-field-stack">
      <div class="admin-field-group">
        <AdminFieldLabel text="目前標籤" tight />
        <div v-if="dialogUser.tags.length" class="user-tags-row">
          <AdminTagTintChip
            v-for="tag in dialogUser.tags"
            :key="tag.id"
            :color="tag.color"
          >
            {{ tag.name }}
            <button v-if="canOperate" type="button" class="tag-chip-remove" @click="removeUserTag(dialogUser.id, tag.id)">✕</button>
          </AdminTagTintChip>
        </div>
        <span v-else class="text-muted text-sm">尚無標籤</span>
      </div>

      <div class="admin-field-group">
        <AdminFieldLabel text="加入標籤" tight />
        <div class="users-add-tag-row">
          <el-select
            v-model="addTagIds"
            multiple
            placeholder="選擇要加的標籤"
            class="users-add-tag-row__select"
          >
            <el-option
              v-for="tag in availableTagsForDialog"
              :key="tag.id"
              :label="tag.name"
              :value="tag.id"
            >
              <AdminTagOptionRow :label="tag.name" :color="tag.color" />
            </el-option>
          </el-select>
          <el-button
            v-if="canOperate"
            type="primary"
            :loading="userTagSaving"
            :disabled="!addTagIds.length"
            @click="addUserTags"
          >
            加入
          </el-button>
        </div>
      </div>
    </div>
    <template #footer>
      <el-button @click="userTagDialogVisible = false">關閉</el-button>
    </template>
  </el-dialog>

  <!-- ── 客人單頁（G-6）：一位客人的完整檔案 ──────────────────
       腳本收進來的答案（attributes）原本後台沒有任何一頁顯示＝「進得去、看不到」，
       這個抽屜就是它的家；AI 建議標籤（D-24）的採用／忽略也在這裡按。 -->
  <el-drawer
    v-model="detailVisible"
    size="min(460px, 94vw)"
    :with-header="false"
    class="user-detail-drawer"
  >
    <div v-if="detailUser" class="user-detail">
      <div class="user-detail__head">
        <img v-if="detailUser.pictureUrl" :src="detailUser.pictureUrl" class="user-detail__avatar" :alt="detailUser.displayName" />
        <span v-else class="user-detail__avatar user-detail__avatar--empty"><el-icon><User /></el-icon></span>
        <div class="user-detail__title">
          <span class="user-detail__name">{{ detailUser.displayName || detailUser.id }}</span>
          <span v-if="detail?.isBlocked" class="user-detail__blocked">已封鎖／退追蹤</span>
          <span class="user-detail__sub">加入於 {{ formatZhDateOnly(detailUser.createdAt) }}</span>
        </div>
      </div>

      <div v-if="detailLoading" class="tags-loading"><div class="spinner" /><span>載入中…</span></div>

      <template v-else-if="detail">
        <!-- 最後互動 -->
        <div class="user-detail__meta">
          <div class="user-detail__meta-item">
            <span class="user-detail__meta-label">最後來訊</span>
            <b>{{ detail.conversation?.lastInboundMessageAtMs ? relativeTime(detail.conversation.lastInboundMessageAtMs) : '—' }}</b>
          </div>
          <div class="user-detail__meta-item">
            <span class="user-detail__meta-label">最後訊息</span>
            <b class="user-detail__last-message">
              <template v-if="detail.conversation?.lastMessage">
                {{ detail.conversation.lastDirection === 'incoming' ? '客人：' : '我們：' }}{{ detail.conversation.lastMessage }}
              </template>
              <template v-else>—</template>
            </b>
          </div>
        </div>

        <!-- AI 建議標籤（D-24 收件匣）：有建議才出現，採用才真的貼 -->
        <section v-if="detail.tagSuggestions?.pending.length" class="user-detail__section user-detail__section--suggest">
          <AdminFieldLabel text="AI 建議的標籤" tight />
          <p class="user-detail__suggest-hint">AI 從對話內容判斷的，你按「採用」才會真的貼上。</p>
          <div v-for="s in detail.tagSuggestions.pending" :key="s.tagId" class="user-detail__suggest-row">
            <div class="user-detail__suggest-main">
              <AdminTagTintChip :color="tagById(s.tagId)?.color ?? '#8a95a1'">
                {{ tagById(s.tagId)?.name ?? '（已刪除的標籤）' }}
              </AdminTagTintChip>
              <span v-if="s.reason" class="user-detail__suggest-reason">{{ s.reason }}</span>
            </div>
            <div v-if="canOperate" class="user-detail__suggest-actions">
              <el-button size="small" type="primary" :loading="suggestActing === s.tagId" @click="actOnSuggestion(s.tagId, 'apply')">採用</el-button>
              <el-button size="small" :loading="suggestActing === s.tagId" @click="actOnSuggestion(s.tagId, 'dismiss')">忽略</el-button>
            </div>
          </div>
        </section>

        <!-- 標籤 -->
        <section class="user-detail__section">
          <AdminFieldLabel text="標籤" tight />
          <div v-if="detailTags.length" class="user-tags-row">
            <AdminTagTintChip v-for="t in detailTags" :key="t.tagId" :color="t.color">
              {{ t.name }}<small class="user-detail__tag-source">{{ t.sourceLabel }}</small>
            </AdminTagTintChip>
          </div>
          <span v-else class="text-muted text-sm">尚無標籤</span>
          <div class="user-detail__section-actions">
            <el-button size="small" @click="openUserTagDialog(detailUser)">管理標籤</el-button>
          </div>
        </section>

        <!-- 腳本收集到的資料（G-6 的根：進得去、看不到 → 現在看得到） -->
        <section class="user-detail__section">
          <AdminFieldLabel text="收集到的資料" tight />
          <table v-if="detailAttributes.length" class="user-detail__attrs">
            <tbody>
              <tr v-for="[k, v] in detailAttributes" :key="k">
                <th>{{ k }}</th>
                <td>{{ v }}</td>
              </tr>
            </tbody>
          </table>
          <span v-else class="text-muted text-sm">還沒有——腳本的「收集」步驟問到的答案會存在這裡。</span>
        </section>
      </template>
    </div>
  </el-drawer>

</template>

<script setup lang="ts">
import { User } from '@element-plus/icons-vue'
import { formatZhDateOnly } from '~~/shared/firestore-date'

definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()

const {
  users,
  loading: usersLoading,
  total,
  page,
  pageSize,
  loadUsers,
} = useAdminUserList()
const { tags: allTags, loading: tagsLoading, loadTags: loadTagOptions } = useAdminTagList()
const loading = computed(() => usersLoading.value || tagsLoading.value)

const searchText = ref('')
const filterTagIds = ref<string[]>([])
const selectedIds = ref<string[]>([])
const { showToast } = useAdminToast()

const batchDialogVisible = ref(false)
const batchMode = ref<'add' | 'remove'>('add')
const batchTagIds = ref<string[]>([])
const batchSaving = ref(false)

const userTagDialogVisible = ref(false)
const dialogUser = ref<any>(null)
const addTagIds = ref<string[]>([])
const userTagSaving = ref(false)
const syncingLine = ref(false)
const syncProgress = ref('')

// ── 客人單頁（G-6）────────────────────────────────────────
type UserDetail = {
  id: string
  isBlocked: boolean
  attributes: Record<string, string>
  tags: Array<{ tagId: string; sourceType: string; createdAtMs: number }>
  conversation: { lastMessage: string; lastDirection: 'incoming' | 'outgoing' | null; lastMessageAtMs: number; lastInboundMessageAtMs: number } | null
  tagSuggestions: { pending: Array<{ tagId: string; reason: string; suggestedAtMs: number }> } | null
}

const detailVisible = ref(false)
const detailLoading = ref(false)
/** 列表那一列（先拿名字頭像即時開抽屜，詳情再補） */
const detailUser = ref<any>(null)
const detail = ref<UserDetail | null>(null)
/** 正在採用／忽略中的建議 tagId（按鈕 loading 用） */
const suggestActing = ref<string | null>(null)

/** 標籤來源的白話標示：AI 貼的要看得出是 AI 貼的，出錯才追得回來 */
const TAG_SOURCE_LABELS: Record<string, string> = {
  manual: '手動',
  import: '匯入',
  rule: '規則',
  system: '系統',
  ai: 'AI',
}

function tagById(tagId: string) {
  return allTags.value.find(t => t.id === tagId) ?? null
}

const detailTags = computed(() =>
  (detail.value?.tags ?? []).map(t => ({
    ...t,
    name: tagById(t.tagId)?.name ?? '（已刪除的標籤）',
    color: tagById(t.tagId)?.color ?? '#8a95a1',
    // 「手動」是預設不標，其他來源才標——列表一排全是「手動」只是噪音
    sourceLabel: t.sourceType !== 'manual' ? (TAG_SOURCE_LABELS[t.sourceType] ?? t.sourceType) : '',
  })),
)

const detailAttributes = computed(() => Object.entries(detail.value?.attributes ?? {}))

async function openUserDetail(user: any) {
  detailUser.value = user
  detail.value = null
  detailVisible.value = true
  await loadUserDetail(user.id)
}

async function loadUserDetail(id: string) {
  detailLoading.value = true
  try {
    detail.value = await apiFetch<UserDetail>(`/api/users/${id}/detail`)
  }
  catch {
    showToast('載入客人資料失敗', 'error')
  }
  finally {
    detailLoading.value = false
  }
}

/** 採用＝真的貼上（來源記 AI、可撤）；忽略＝這個標籤對這位客人永遠不再建議 */
async function actOnSuggestion(tagId: string, action: 'apply' | 'dismiss') {
  if (!assertCanOperate()) return
  if (!detailUser.value) return
  suggestActing.value = tagId
  try {
    await apiFetch(`/api/users/${detailUser.value.id}/tag-suggestions`, {
      method: 'POST',
      body: { action, tagIds: [tagId] },
    })
    showToast(action === 'apply' ? '已採用，標籤貼上了' : '已忽略，不會再建議這個標籤', 'success')
    await Promise.all([loadUserDetail(detailUser.value.id), refreshUsersOnly()])
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '操作失敗', 'error')
  }
  finally {
    suggestActing.value = null
  }
}

function userListQuery(targetPage = page.value) {
  return {
    page: targetPage,
    limit: pageSize.value,
    tagIds: filterTagIds.value.length ? filterTagIds.value : undefined,
    search: searchText.value,
  }
}

async function reloadUsers(resetPage = false): Promise<boolean> {
  const targetPage = resetPage ? 1 : page.value
  const ok = await loadUsers(userListQuery(targetPage))
  if (!ok) showToast('載入會員失敗', 'error')
  return ok
}

async function onPageChange(nextPage: number) {
  selectedIds.value = []
  await loadUsers(userListQuery(nextPage))
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(filterTagIds, () => {
  selectedIds.value = []
  void reloadUsers(true)
}, { deep: true })
watch(searchText, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    selectedIds.value = []
    void reloadUsers(true)
  }, 300)
})

const isAllSelected = computed(
  () => users.value.length > 0 && users.value.every((u) => selectedIds.value.includes(u.id)),
)
const isIndeterminate = computed(
  () => !isAllSelected.value && users.value.some((u) => selectedIds.value.includes(u.id)),
)

const availableTagsForDialog = computed(() => {
  if (!dialogUser.value) return allTags.value
  return allTags.value.filter((t) => !dialogUser.value.tagIds?.includes(t.id))
})

function toggleSelect(id: string) {
  const idx = selectedIds.value.indexOf(id)
  if (idx > -1) selectedIds.value.splice(idx, 1)
  else selectedIds.value.push(id)
}

function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedIds.value = []
  }
  else {
    selectedIds.value = users.value.map((u) => u.id)
  }
}

async function syncFromLine() {
  if (!assertCanOperate()) return
  if (syncingLine.value) return
  syncingLine.value = true
  syncProgress.value = '同步中…'
  let offset = 0
  let totalProcessed = 0
  let lastRemaining = -1
  try {
    for (let round = 0; round < 25; round++) {
      const res = await apiFetch<{
        ok?: boolean
        lineFollowerTotal?: number
        offset?: number
        processed?: number
        remaining?: number
        profileFailures?: number
        created?: number
        updated?: number
        listTruncated?: boolean
      }>('/api/users/sync-from-line', {
        method: 'POST',
        body: { offset, maxFetchProfiles: 400 },
      })
      if (!res?.ok) {
        showToast('LINE 同步回傳異常', 'error')
        break
      }
      totalProcessed += res.processed ?? 0
      lastRemaining = res.remaining ?? 0
      offset += res.processed ?? 0
      syncProgress.value = `同步中：已處理 ${totalProcessed} 筆${(res.remaining ?? 0) > 0 ? `，剩約 ${res.remaining} 位` : ''}`
      if ((res.remaining ?? 0) <= 0) {
        const extra = (res.profileFailures ?? 0) > 0 ? `（${res.profileFailures} 位頭像／名稱未取得）` : ''
        showToast(
          `同步完成：官方好友 ${res.lineFollowerTotal ?? 0} 人，本次寫入 ${totalProcessed} 筆${extra}`,
          'success',
        )
        if (res.listTruncated) showToast('LINE 回傳的好友清單已達上限截斷，請洽開發者調高 maxIds', 'warning')
        await refreshUsersOnly()
        return
      }
    }
    if (lastRemaining > 0) {
      showToast(`已處理 ${totalProcessed} 筆，尚有約 ${lastRemaining} 位未寫入，請再按一次「從 LINE 同步好友」`, 'warning')
      await refreshUsersOnly()
    }
  }
  catch (e: any) {
    const msg = String(e?.data?.statusMessage || e?.message || e || '同步失敗')
    showToast(msg.length > 120 ? `${msg.slice(0, 120)}…` : msg, 'error')
  }
  finally {
    syncingLine.value = false
    syncProgress.value = ''
  }
}

async function loadData() {
  const [uOk, tOk] = await Promise.all([
    reloadUsers(true),
    loadTagOptions({ status: 'active' }),
  ])
  if (!tOk) showToast('載入標籤失敗', 'error')
}

/** tag 增刪操作後只重抓 users，標籤不會變動，避免每次都重複拉 `/api/tag/list` */
async function refreshUsersOnly() {
  await reloadUsers()
}

function openBatchTag(mode: 'add' | 'remove') {
  batchMode.value = mode
  batchTagIds.value = []
  batchDialogVisible.value = true
}

async function submitBatch() {
  if (!assertCanOperate()) return
  if (!selectedIds.value.length) {
    showToast('請先勾選至少一位會員', 'error')
    return
  }
  if (!batchTagIds.value.length) {
    showToast('請至少選擇一個標籤', 'error')
    return
  }
  batchSaving.value = true
  try {
    const endpoint = batchMode.value === 'add'
      ? '/api/user-tags/batch-add'
      : '/api/user-tags/batch-remove'

    const res = await apiFetch<{ added?: number; removed?: number }>(
      endpoint,
      { method: 'POST', body: { userIds: selectedIds.value, tagIds: batchTagIds.value } },
    )

    const count = res.added ?? res.removed ?? 0
    showToast(`完成！已影響 ${count} 筆紀錄`, 'success')
    batchDialogVisible.value = false
    selectedIds.value = []
    await refreshUsersOnly()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '操作失敗', 'error')
  }
  finally {
    batchSaving.value = false
  }
}

function openUserTagDialog(user: any) {
  dialogUser.value = JSON.parse(JSON.stringify(user))
  addTagIds.value = []
  userTagDialogVisible.value = true
}

async function addUserTags() {
  if (!assertCanOperate()) return
  if (!dialogUser.value) return
  if (!addTagIds.value.length) {
    showToast('請至少選擇一個標籤', 'error')
    return
  }
  userTagSaving.value = true
  try {
    await apiFetch(`/api/users/${dialogUser.value.id}/tags`, {
      method: 'POST',
      body: { tagIds: addTagIds.value },
    })
    showToast('標籤已加入', 'success')
    addTagIds.value = []
    await refreshUsersOnly()
    const updated = users.value.find((u) => u.id === dialogUser.value!.id)
    if (updated) dialogUser.value = JSON.parse(JSON.stringify(updated))
    // 抽屜開著同一位 → 詳情跟著更新，不然抽屜上的標籤是舊的
    if (detailVisible.value && detailUser.value?.id === updated?.id) void loadUserDetail(updated.id)
  }
  catch {
    showToast('加標失敗', 'error')
  }
  finally {
    userTagSaving.value = false
  }
}

async function removeUserTag(userId: string, tagId: string) {
  if (!assertCanOperate()) return
  try {
    await apiFetch(`/api/users/${userId}/tags/${tagId}`, { method: 'DELETE' })
    showToast('標籤已移除', 'success')
    await refreshUsersOnly()
    const updated = users.value.find((u) => u.id === userId)
    if (updated) dialogUser.value = JSON.parse(JSON.stringify(updated))
    if (detailVisible.value && detailUser.value?.id === userId) void loadUserDetail(userId)
  }
  catch {
    showToast('移除失敗', 'error')
  }
}

onMounted(loadData)
</script>
