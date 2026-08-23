<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="標籤管理"
        title="標籤列表"
        caption="建立與管理好友標籤，用於分眾推播"
      />
      <div class="flex gap-1 admin-header-actions">
        <el-button v-if="canOperate" :icon="Plus" type="primary" size="small" data-tour="tag-new" @click="openCreate">新增</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card tags-page-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">篩選與表格</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="tags-toolbar" data-tour="tag-filter">
              <div class="tags-toolbar__field tags-toolbar__field--search">
                <AdminFieldLabel text="搜尋（標籤名稱或英文代號）" tight />
                <el-input v-model="searchText" placeholder="輸入關鍵字…" clearable />
              </div>
              <div class="tags-toolbar__field tags-toolbar__field--category">
                <AdminFieldLabel text="分類" tight />
                <el-select v-model="filterCategory" placeholder="全部" clearable>
                  <el-option
                    v-for="c in TAG_CATEGORY_OPTIONS"
                    :key="c.value"
                    :label="c.label"
                    :value="c.value"
                  />
                </el-select>
              </div>
              <div class="tags-toolbar__field tags-toolbar__field--status">
                <AdminFieldLabel text="狀態" tight />
                <el-select v-model="filterStatus" placeholder="全部" clearable>
                  <el-option label="啟用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </div>
              <span class="tags-count text-muted">共 {{ total.toLocaleString('zh-TW') }} 筆</span>
            </div>

            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <div v-else-if="!tags.length" class="tags-empty">
              <span>{{ total ? '無符合的標籤' : '尚無任何標籤，請點擊右上角「新增標籤」開始' }}</span>
            </div>
            <div v-else class="table-wrap">
              <table class="tags-table">
                <thead>
                  <tr>
                    <th class="tags-table__th--swatch" />
                    <th>名稱</th>
                    <th>Code</th>
                    <th>分類</th>
                    <th>狀態</th>
                    <th class="tags-table__th--count">好友數</th>
                    <th>建立時間</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="tag in tags"
                    :key="tag.id"
                    class="tags-table__row--clickable"
                    tabindex="0"
                    @click="openEdit(tag)"
                    @keydown.enter="openEdit(tag)"
                  >
                    <td>
                      <span class="tag-color-dot" :style="{ '--dot-bg': tag.color || '#6B7280' }" />
                    </td>
                    <td class="td-name">{{ tag.name }}</td>
                    <td class="td-code">{{ tag.code }}</td>
                    <td>
                      <span class="badge badge-gray">{{ tagCategoryLabel(tag.category) }}</span>
                    </td>
                    <td>
                      <span :class="tag.status === 'active' ? 'badge badge-green' : 'badge badge-gray'">
                        {{ tag.status === 'active' ? '啟用' : '停用' }}
                      </span>
                    </td>
                    <td class="td-count">{{ formatMemberCount(tag.memberCount) }}</td>
                    <td class="td-time">{{ formatZhDateOnly(tag.createdAt) }}</td>
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
    v-model="dialogVisible"
    :title="isEditing ? '編輯標籤' : '新增標籤'"
    width="min(480px, 92vw)"
    class="tags-dialog"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" @submit.prevent>
      <div class="admin-field-stack">
        <div class="admin-field-group">
          <AdminFieldLabel text="啟用狀態" tight />
          <el-switch
            v-model="form.status"
            active-value="active"
            inactive-value="inactive"
            active-text="啟用中"
            inactive-text="已停用"
            class="tags-status-switch"
          />
          <span class="tags-hint">停用的標籤不會出現在貼標選單，但仍可在此編輯</span>
        </div>

        <div class="admin-field-group" data-tour="tag-code">
          <AdminFieldLabel text="英文代號（系統辨識用，建立後就不能改）" tight />
          <el-input
            v-model="form.code"
            :disabled="isEditing"
            placeholder="例如 interest_food、vip"
            maxlength="40"
          />
          <span class="tags-hint">給系統認的英文代號（不會給客人看到）：只能用英文小寫、數字、底線，開頭要是英文字母</span>
        </div>

        <div class="admin-field-group" data-tour="tag-name">
          <AdminFieldLabel text="顯示名稱（最多 30 字）" tight />
          <el-input v-model="form.name" placeholder="例如 美食愛好者" maxlength="30" />
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="分類" tight />
          <el-select v-model="form.category" class="tags-dialog-select">
            <el-option
              v-for="c in TAG_CATEGORY_OPTIONS"
              :key="c.value"
              :label="c.label"
              :value="c.value"
            />
          </el-select>
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="標籤顏色" tight />
          <div class="tags-color-row">
            <button
              v-for="c in TAG_PRESET_COLORS"
              :key="c"
              type="button"
              class="tags-color-swatch"
              :class="{ active: form.color === c }"
              :style="{ '--swatch-bg': c }"
              @click="form.color = c"
            />
          </div>
        </div>

        <!-- ⛔ 這一欄**不只是內部備註**：開了「AI 讀對話建議標籤」之後，AI 判斷時看到的就是
             「名稱＋這一欄」（見 server/utils/ai-tag-suggest.ts 的 buildSuggestPrompt）。
             原本標題寫「備註說明」、提示寫「供內部參考」是加 AI 之前的文案，會讓人不知道
             這裡寫的字有真實作用（2026-08-24 老闆直接問「這邊的說明就是會讓 AI 判斷嗎」）。
             ⛔ 改字數上限時要連 ai-tag-suggest 的 DESCRIPTION_IN_PROMPT_MAX 一起改，
             否則會變成「讓人打 200 字、AI 只讀前 80 字」的靜默截斷。 -->
        <div class="admin-field-group">
          <AdminFieldLabel text="說明（選填，也是 AI 判斷這顆標籤的條件）" tight />
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="3"
            placeholder="例：客人詢問、比較除濕機，或提到家裡潮濕、衣服晾不乾想找解法。只問舊機維修的不算。"
            maxlength="200"
            show-word-limit
          />
          <p class="tags-desc-hint text-muted">
            這段話有兩個用途：給團隊看，以及<strong>當 AI 的判斷條件</strong>——開了「AI 讀對話，建議該貼什麼標籤」
            （在「AI 設定 → 顧客標籤」）之後，AI 會拿整段對話對照這裡寫的條件。
            寫法：<strong>客人說了什麼算</strong>、順便寫<strong>什麼不算</strong>，越像人話越準。
          </p>
        </div>
      </div>
    </el-form>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button v-if="canOperate" type="primary" :loading="saving" @click="submitForm">
        {{ isEditing ? '儲存變更' : '建立標籤' }}
      </el-button>
    </template>
  </el-dialog>

</template>

<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'
import { formatZhDateOnly } from '~~/shared/firestore-date'
import { TAG_CATEGORY_OPTIONS, TAG_PRESET_COLORS, tagCategoryLabel } from '~~/shared/tag-admin'

definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()
const { tags, loading, total, page, pageSize, loadTags } = useAdminTagList()
const { showToast } = useAdminToast()

const saving = ref(false)
const dialogVisible = ref(false)
const isEditing = ref(false)
const searchText = ref('')
const filterCategory = ref('')
const filterStatus = ref('')

const defaultForm = () => ({
  id: '',
  code: '',
  name: '',
  category: 'custom' as const,
  color: '#6B7280',
  description: '',
  status: 'active' as 'active' | 'inactive',
})
const form = ref(defaultForm())

function formatMemberCount(count: number | undefined) {
  return (count ?? 0).toLocaleString('zh-TW')
}

function tagListQuery(targetPage = page.value) {
  return {
    page: targetPage,
    limit: pageSize.value,
    includeMemberCount: true,
    status: filterStatus.value || undefined,
    category: filterCategory.value || undefined,
    search: searchText.value,
  }
}

async function reloadTags(resetPage = false) {
  const targetPage = resetPage ? 1 : page.value
  const ok = await loadTags(tagListQuery(targetPage))
  if (!ok) showToast('載入標籤失敗', 'error')
}

async function refreshTags() {
  await reloadTags()
}

async function onPageChange(nextPage: number) {
  await loadTags(tagListQuery(nextPage))
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch([filterStatus, filterCategory], () => {
  void reloadTags(true)
})
watch(searchText, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void reloadTags(true), 300)
})

function openCreate() {
  isEditing.value = false
  form.value = defaultForm()
  dialogVisible.value = true
}

function openEdit(tag: any) {
  isEditing.value = true
  form.value = {
    id: tag.id,
    code: tag.code,
    name: tag.name,
    category: (tag.category ?? 'custom') as any,
    color: tag.color ?? '#6B7280',
    description: tag.description ?? '',
    status: tag.status === 'inactive' ? 'inactive' : 'active',
  }
  dialogVisible.value = true
}

function validateForm(): string | null {
  if (!form.value.code.trim()) return '請填寫 Code'
  if (!/^[a-z][a-z0-9_]*$/.test(form.value.code)) return 'Code 格式錯誤（英文小寫開頭，可含數字與底線）'
  if (!form.value.name.trim()) return '請填寫顯示名稱'
  if (!form.value.category) return '請選擇分類'
  return null
}

async function submitForm() {
  if (!assertCanOperate()) return
  const err = validateForm()
  if (err) return showToast(err, 'error')
  saving.value = true
  try {
    if (isEditing.value) {
      await apiFetch(`/api/tag/${form.value.id}`, {
        method: 'PUT',
        body: {
          name: form.value.name.trim(),
          category: form.value.category,
          color: form.value.color,
          description: form.value.description.trim(),
          status: form.value.status,
        },
      })
      showToast('標籤已更新', 'success')
    }
    else {
      await apiFetch('/api/tag/create', {
        method: 'POST',
        body: {
          code: form.value.code.trim(),
          name: form.value.name.trim(),
          category: form.value.category,
          color: form.value.color,
          description: form.value.description.trim(),
          status: form.value.status,
        },
      })
      showToast('標籤已建立', 'success')
    }
    dialogVisible.value = false
    await refreshTags()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

onMounted(() => reloadTags(true))
</script>
