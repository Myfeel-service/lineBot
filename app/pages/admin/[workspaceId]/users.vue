<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <!-- ⛔ 這頁的人一律叫「好友」不叫「會員」（2026-08-23 老闆拍板）：LINE 官方帳號後台
           自己就叫好友、我們抓的是 followers API，而「會員」會讓店家以為有註冊／等級這種
           不存在的功能。側欄、大標、說明、週報指路全部同一個字，人才找得到這頁。
           ⚠️「客人」是另一回事，刻意不統一：好友＝加過官方帳號的所有人（含從沒講話的），
           客人＝對話裡正在講話的那位；對話頁講「客人」是對的。 -->
      <AdminSoloPageHeading
        field-label="好友"
        title="好友"
        caption="查看好友、貼標籤、看 AI 建議"
        :help-topics="['users']"
      />
      <div class="flex gap-1 admin-header-actions">
        <el-button v-if="canOperate" size="small" type="primary" data-tour="usr-sync" :loading="syncingLine" @click="syncFromLine">
          從 LINE 同步好友
        </el-button>
        <!--
          原本這段說明是**一段三行的常駐文字，壓在表格正上方**——每天都要經過，
          但它問的是「你的帳號是不是只有觸發過 Webhook 的人」，這件事沒有人答得出來。
          它真正回答的是「為什麼我的好友數比 LINE 上少」，那是偶爾才冒出來的疑問，
          所以收到同步按鈕旁邊：想問的時候按得到，不想問的時候不佔版面。
          ⛔ 內容沒有刪掉，只是換了位置＋改成不必自己判斷條件的講法。
        -->
        <el-popover placement="bottom-end" :width="330" trigger="click">
          <template #reference>
            <el-button size="small" text class="users-sync-info" title="好友名單是怎麼來的？">
              <el-icon><InfoFilled /></el-icon>
            </el-button>
          </template>
          <div class="users-sync-pop">
            <p class="users-sync-pop__title">好友名單是怎麼來的？</p>
            <p>
              這份清單來自我們自己的資料庫，<strong>可能比 LINE 後台看到的少</strong>——
              只有跟你互動過的人（傳過訊息、按過按鈕、或加好友當下系統有收到通知）才會自動進來。
            </p>
            <p>
              按左邊的「從 LINE 同步好友」可以把官方帳號的完整名單拉進來。
              好友很多時會自動分批，<strong>按到人數不再增加就是完成了</strong>。
            </p>
            <p class="users-sync-pop__tech">
              資料來源：Messaging API <code>/v2/bot/followers/ids</code>
            </p>
          </div>
        </el-popover>
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

        <!--
          AI 建議待辦條。**這是收件匣真正的入口**——先前唯一的入口是每一列名字後面那顆橘章，
          它只說得出「這一列有」，說不出「這一頁有」：4 位建議散在 93 頁裡，
          除非剛好翻到那一列，否則永遠不知道有事情等你決定。
          ⛔ 沒有待辦就整條不出現（不做成永遠亮著的裝飾）。
          ⛔ 數字**不吃畫面上的篩選**（見 API 的 pendingSuggestionTotal）：
             篩選之後變小會讓人以為已經處理掉了。
        -->
        <button
          v-if="pendingSuggestionTotal > 0 && !filterSuggested"
          type="button"
          class="users-todo"
          @click="filterSuggested = true"
        >
          <span class="users-todo__text">
            AI 有 <strong>{{ pendingSuggestionTotal }}</strong> 位客人的標籤建議等你決定
          </span>
          <span class="users-todo__cta">看一下 →</span>
        </button>

        
        <div class="message-card users-page-card" data-tour="usr-list">
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
              <div class="users-toolbar__field users-toolbar__field--suggest">
                <AdminFieldLabel text="AI 建議" tight />
                <el-checkbox v-model="filterSuggested">只看有 AI 建議的</el-checkbox>
              </div>
              <!--
                ⛔ 篩選之後這個數字講的是「符合條件的數量」不是好友總數。
                原本兩種情況都寫「共 N 位」，篩到剩 12 位時顯示「共 12 位」＝會被讀成好友只剩 12 位。
              -->
              <span class="tags-count text-muted">{{ countLabel }}</span>
            </div>

            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <!-- ⛔「掃不完」不可以顯示成「沒有」：好友很多時後端只掃前 5,000 位，
                 條件命中的人剛好在後面就會查不到——要講出來並給下一步 -->
            <div v-else-if="!users.length" class="tags-empty">
              <span v-if="truncated">好友太多，只查了前 5,000 位就停下來——用上面的搜尋或標籤縮小範圍再看一次。</span>
              <!-- 開通沒完成時「尚無好友資料」是誤導：不是還沒有人加，是加了也進不來（2026-08-27） -->
              <span v-else>{{ total ? '無符合條件的好友' : (onboardingIncomplete ? '開通還沒完成——接上 LINE 後，加好友的客人會自動出現在這裡' : '尚無好友資料') }}</span>
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
                    <th>好友</th>
                    <!--
                      這頁的用途就是貼標籤，先前列表上卻**一個標籤都看不到**（只有「標籤（1）」這個數字），
                      要知道是哪一個得逐一點開。而標籤的名字與顏色**每次載入本來就跟著資料回來了**
                      （list.get.ts 的 enriched.tags），只被拿去算長度——補這一欄零查詢、零後端改動。
                    -->
                    <th class="users-table__th--tags">標籤</th>
                    <th class="users-table__th--time">加入時間</th>
                    <!-- 欄名改「操作」：「查看」開的是整個人的檔案，跟標籤無關，原本的「標籤操作」名不符實 -->
                    <th class="users-table__th--actions">操作</th>
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
                        <!-- 收件匣入口（G-20③）：有 AI 建議的客人要在列表上看得到，
                             不能靠「碰巧點開」才發現。用共用的 .badge badge-orange，
                             ⛔別自刻琥珀膠囊（同色不同尺寸＝跨頁 drift，換色時也會漏改） -->
                        <span v-if="user.hasTagSuggestions" class="badge badge-orange user-suggest-badge">AI 建議</span>
                      </div>
                    </td>
                    <td>
                      <!--
                        點標籤欄＝開這個人的標籤視窗（原本「標籤（N）」那顆做的事）。
                        ⛔ 超過 MAX_ROW_TAGS 顆就收成「＋N」：標籤多的人會把那一列撐成好幾行，
                           整張表的列高又會回到參差不齊。
                      -->
                      <div
                        class="user-tags-cell"
                        :class="{ 'is-clickable': canTagCellOpen(user) }"
                        :title="rowTagsTitle(user)"
                        @click="canTagCellOpen(user) && openUserTagDialog(user)"
                      >
                        <template v-if="user.tags.length">
                          <AdminTagTintChip
                            v-for="tag in user.tags.slice(0, MAX_ROW_TAGS)"
                            :key="tag.id"
                            :color="tag.color"
                          >{{ tag.name }}</AdminTagTintChip>
                          <!-- 沿用共用的 .tag-chip-more（標籤頁那套膠囊的一員），不要另刻一顆 -->
                          <span v-if="user.tags.length > MAX_ROW_TAGS" class="tag-chip-more">
                            ＋{{ user.tags.length - MAX_ROW_TAGS }}
                          </span>
                        </template>
                        <!-- ⛔ 空的時候不要留白：留白看不出「可以按這裡加」 -->
                        <span v-else class="user-tags-cell__empty">{{ canOperate ? '＋ 加標籤' : '—' }}</span>
                      </div>
                    </td>
                    <td class="td-time">{{ formatZhDateOnly(user.createdAt) }}</td>
                    <td>
                      <!-- 一行放得下就不要換行：先前欄寬 132px 裝不下 48+78 兩顆，
                           每一列被撐成 77px（單行 44px），兩顆的左緣還差 12px -->
                      <div class="td-actions">
                        <el-button size="small" @click="openUserDetail(user)">查看</el-button>
                        <el-button v-if="canOperate" size="small" @click="openUserTagDialog(user)">改標籤</el-button>
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
        <span>此操作將影響 <strong>{{ selectedIds.length }}</strong> 位好友</span>
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
      <!-- 眉標：第一次用的人要知道這個面板叫什麼（G-20④） -->
      <span class="user-detail__eyebrow">客人檔案</span>
      <!-- ⛔ 卡片內容是**共用元件**（G-26）：客服對話頁右側用的是同一份，
           改一次兩邊都變。別在這裡另刻一份客人資訊。 -->
      <AdminCustomerCard
        :user-id="detailUser.id"
        :api-fetch="apiFetch"
        :can-operate="canOperate"
        :fallback-name="detailUser.displayName"
        :fallback-picture="detailUser.pictureUrl"
        show-conversation-link
        @changed="refreshUsersOnly"
        @open-conversation="goConversation"
      />
    </div>
  </el-drawer>

</template>

<script setup lang="ts">
import { InfoFilled, User } from '@element-plus/icons-vue'
import { formatZhDateOnly } from '~~/shared/firestore-date'

definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
// 開通沒完成時，空清單要講真話（不是還沒有人加好友，是加了也進不來）
const { onboardingIncomplete } = useSetupStatus()
const route = useRoute()
const { canOperate, assertCanOperate } = useAdminOperateGuard()

const {
  users,
  loading: usersLoading,
  total,
  page,
  pageSize,
  truncated,
  pendingSuggestionTotal,
  loadUsers,
} = useAdminUserList()
const { tags: allTags, loading: tagsLoading, loadTags: loadTagOptions } = useAdminTagList()
const loading = computed(() => usersLoading.value || tagsLoading.value)

const searchText = ref('')

/**
 * 篩選條件的初始值**直接從網址帶進來**（`?tagIds=a,b` 從標籤頁「好友數」來、
 * `?suggested=1` 從「待審 N 位」來）。
 *
 * ⛔ 一定要寫在 ref 的初始值裡，**不可以搬回 onMounted 設定**：那幾支 watch 會因為
 * 「值變了」各觸發一次 reloadUsers，加上 loadData 自己那次＝一進頁打兩次
 * `/api/users/list`。這頁的列表查詢正是 08-11 讀取費暴衝的那一支，白打一次就是白付一次。
 * 寫成初始值則從頭到尾沒有「變過」，watcher 一次都不會醒。
 */
const filterTagIds = ref<string[]>(
  String(route.query.tagIds ?? '').split(',').map(s => s.trim()).filter(Boolean))
const filterSuggested = ref(String(route.query.suggested ?? '') === '1')
const selectedIds = ref<string[]>([])
const { showToast } = useAdminToast()

/**
 * 一列最多直接列幾顆標籤，其餘收成「＋N」。
 * ⛔ 不要拿掉這個上限：標籤多的人會把那一列撐成好幾行，整張表的列高又變參差
 *    ——那正是這次要修掉的毛病（原本按鈕換行造成列高 77px）。
 */
const MAX_ROW_TAGS = 3

/**
 * 這一格能不能點開標籤視窗。
 * ⛔ 唯讀角色**且這個人沒有標籤**時不給點：那會開出一個「尚無標籤」又不能加的死路。
 *    有標籤的話唯讀角色仍可以點——被「＋N」收起來的那幾顆總要有地方看得到。
 */
function canTagCellOpen(user: any): boolean {
  return canOperate.value || (user?.tags?.length ?? 0) > 0
}

/** 滑上去看完整的標籤（列上只顯示前幾顆，被收起來的那些要有地方看得到） */
function rowTagsTitle(user: any): string {
  const names = (user?.tags ?? []).map((t: any) => t.name).filter(Boolean)
  if (!names.length) return canOperate.value ? '還沒有標籤，點一下可以加' : '還沒有標籤'
  return canOperate.value ? `${names.join('、')}（點一下可以改）` : names.join('、')
}

/**
 * 「共 N 位」在有篩選時講的其實是「符合條件的數量」。
 * 兩種情況共用同一句話會誤導：篩到剩 12 位時顯示「共 12 位」，會被讀成好友只剩 12 位。
 */
const countLabel = computed(() => {
  const n = total.value.toLocaleString('zh-TW')
  const filtering = !!searchText.value.trim() || filterTagIds.value.length > 0 || filterSuggested.value
  return filtering ? `符合條件 ${n} 位` : `共 ${n} 位`
})

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

// ── 客人單頁（G-6／G-26）──────────────────────────────────
// 卡片內容與所有讀寫都在共用元件 AdminCustomerCard 裡（客服對話頁用同一份）。
// 這裡只留「開哪一位」的狀態。
const detailVisible = ref(false)
/** 列表那一列：先把名字頭像交給卡片當 fallback，詳情由卡片自己撈 */
const detailUser = ref<any>(null)

function openUserDetail(user: any) {
  detailUser.value = user
  detailVisible.value = true
}

/** 通往完整對話：對話頁的 ?userId= 深連結是現成的（監控頁「開對話」同一條路） */
/**
 * 打開這位客人的對話。
 * 帶 sessionId＝從「AI 建議」按過來的，要直接落在**產生那條建議的那一場**
 * （不指定的話會落在最新那場，而客人來過很多次時那多半不是同一場＝看了也判斷不了）。
 */
function goConversation(sessionId?: string) {
  if (!detailUser.value) return
  const base = `/admin/${workspaceId.value}/conversations?userId=${encodeURIComponent(detailUser.value.id)}`
  navigateTo(sessionId ? `${base}&sessionId=${encodeURIComponent(sessionId)}` : base)
}


function userListQuery(targetPage = page.value) {
  return {
    page: targetPage,
    limit: pageSize.value,
    tagIds: filterTagIds.value.length ? filterTagIds.value : undefined,
    search: searchText.value,
    suggested: filterSuggested.value,
  }
}

async function reloadUsers(resetPage = false): Promise<boolean> {
  const targetPage = resetPage ? 1 : page.value
  const ok = await loadUsers(userListQuery(targetPage))
  if (!ok) showToast('載入好友失敗', 'error')
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
watch(filterSuggested, () => {
  selectedIds.value = []
  void reloadUsers(true)
})
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
    showToast('請先勾選至少一位好友', 'error')
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

  }
  catch {
    showToast('移除失敗', 'error')
  }
}

/**
 * 網址帶來的篩選（`?tagIds=` / `?suggested=`）在上面 ref 的初始值就吃掉了，
 * 這裡只要載入一次——⛔ 別把那幾行搬回來（會多打一次列表查詢，理由寫在 ref 那邊）。
 */
onMounted(() => {
  void loadData()
})
</script>
