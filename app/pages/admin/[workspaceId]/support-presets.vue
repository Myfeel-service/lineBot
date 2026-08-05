<template>
  <AdminSplitLayout :is-empty="!selectedPreset && !isCreating">
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="sp-title">客服預存</span>
      <el-button v-if="canOperate" :icon="Plus" type="primary" size="small" data-tour="sp-new" @click="openCreate">新增</el-button>
    </template>

    <template #sidebar-list>
      <div v-if="loading && !presets.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!presets.length" class="split-sidebar-empty">
        <span>尚無預存</span>
        <p class="text-xs text-muted">新增常用回覆或模組捷徑，於「對話」中一選即送</p>
        <el-button v-if="canOperate" size="small" type="primary" plain @click="openCreate">立即新增</el-button>
      </div>
      <div v-else ref="listEl" class="split-list" @scroll.passive="onSidebarListScroll">
        <AdminSplitListItem
          v-for="preset in presets"
          :key="preset.id"
          :title="preset.name || '(未命名)'"
          :active="selectedId === preset.id"
          time-in-title-row
          title-row-chip
          :chip-text="preset.isActive ? '啟用' : '停用'"
          :chip-tone="preset.isActive ? 'success' : 'neutral'"
          :meta-text="getActionSummary(preset)"
          :meta-truncate="true"
          @select="selectPreset(preset)"
        />
        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
          <span>載入更多…</span>
        </div>
      </div>
    </template>

    <template #editor-empty>
      <el-icon class="empty-icon"><Box /></el-icon>
      <h3>選擇一筆預存開始編輯</h3>
      <p>或點擊左側「新增」建立新的客服預存</p>
      <el-button v-if="canOperate" type="primary" @click="openCreate">新增預存</el-button>
    </template>

    <template #editor-header>
      <AdminEditorHeaderTitle
        v-model="form.name"
        field-label="預存名稱"
        create-prefix="新增預存:"
        placeholder="請輸入預存名稱..."
        caption="為這筆預存命名；僅「啟用」的預存會出現在對話頁選單"
        :is-creating="isCreating"
        @enter="submitForm"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button v-if="canOperate && !isCreating && selectedPreset" :icon="Delete" type="danger" @click="deletePreset">
          刪除
        </el-button>
        <el-button @click="cancelEdit">取消</el-button>
        <el-button v-if="canOperate" type="primary" :loading="saving" @click="submitForm">
          {{ isCreating ? '建立預存' : '儲存變更' }}
        </el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="ar-editor-body admin-panel-stack">
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">狀態設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ar-section-hint">停用的預存不會出現在對話頁的「客服預存」選單，但仍可在此編輯。</p>
            <div class="admin-field-group">
              <AdminFieldLabel text="啟用狀態" tight />
              <el-switch
                v-model="form.isActive"
                active-text="啟用中"
                inactive-text="已停用"
                class="ar-status-switch"
              />
            </div>
          </div>
        </div>

        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">動作設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ar-section-hint">可選擇開啟網址、傳送文字，或觸發機器人模組。</p>
            <div v-if="modulesLoading" class="ar-modules-loading">
              <div class="spinner" />
            </div>
            <div v-else-if="!modules.length" class="ar-no-modules">
              尚無模組。請先前往「<NuxtLink :to="`/admin/${workspaceId}/flow`" class="link">機器人模組</NuxtLink>」建立。
            </div>
            <div v-else>
              <FlowActionEditor
                :action="form.action"
                :type-options="presetActionTypeOptions"
                :module-options="modules"
                :variable-options="[]"
                header-label=""
                flat
                :show-label-field="false"
                :show-variable-inset="false"
                module-title="機器人模組"
                module-placeholder="請選擇要觸發的模組"
                text-title="回覆文字"
                text-placeholder="輸入要回覆給使用者的文字（可換行分段）"
                :text-multiline="true"
                uri-title="網址"
                uri-placeholder="https://..."
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="啟用貼標" tight />
              <el-switch
                v-model="form.tagging.enabled"
                active-text="啟用"
                inactive-text="停用"
                class="ar-status-switch"
              />
            </div>
            <div v-if="form.tagging.enabled" class="admin-field-group">
              <div v-if="tagsLoading" class="ar-modules-loading">
                <div class="spinner" />
              </div>
              <div v-else-if="!allTags.length" class="ar-no-modules">
                尚無標籤，請先前往「<NuxtLink :to="`/admin/${workspaceId}/tags`" class="link">標籤管理</NuxtLink>」建立。
              </div>
              <el-select
                v-else
                v-model="form.tagging.addTagIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                placeholder="選擇要貼的標籤"
                class="admin-w-full"
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
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

</template>

<script setup lang="ts">
import { Box, Delete, Plus } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { normalizeAutoReplyAction, normalizeAutoReplyTagging } from '~~/shared/auto-reply-rule'
import {
  normalizeSupportPreset,
  validateSupportPreset,
  type SupportPresetShape,
} from '~~/shared/support-preset'

definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()

const modules = ref<any[]>([])
const {
  items: presets,
  loading,
  loadingMore,
  listEl,
  load: loadPresets,
  onScroll: onSidebarListScroll,
} = useWorkspaceSidebarList<any>('/api/support-preset/list')
const modulesLoading = ref(true)
const saving = ref(false)
const selectedId = ref<string | null>(null)
const isCreating = ref(false)
const { showToast } = useAdminToast()
const { tags: allTags, loading: tagsLoading, loadTags } = useAdminTagList()

const defaultForm = () => ({
  name: '',
  action: normalizeAutoReplyAction({ type: 'module', moduleId: '' }),
  isActive: true,
  tagging: normalizeAutoReplyTagging(null),
})
const form = ref(defaultForm())
const { markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
})

const presetActionTypeOptions = [
  { value: 'uri', label: '開啟網址' },
  { value: 'message', label: '傳送文字' },
  { value: 'module', label: '觸發機器人模組' },
]

const selectedPreset = computed(() => presets.value.find(p => p.id === selectedId.value) ?? null)

async function loadModules() {
  modulesLoading.value = true
  modules.value = await apiFetch<any[]>('/api/flow/list').catch(() => [])
  modulesLoading.value = false
}

onMounted(() => {
  loadPresets(true)
  loadModules()
  loadTags({ status: 'active' })
})

function selectPreset(preset: any, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = preset.id
  const normalized = normalizeSupportPreset(preset)
  form.value = {
    name: normalized.name,
    action: normalized.action,
    isActive: normalized.isActive,
    tagging: normalized.tagging,
  }
  markClean()
}

function openCreate() {
  if (!confirmLeaveIfDirty()) return
  isCreating.value = true
  selectedId.value = null
  form.value = defaultForm()
  markClean()
}

function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedPreset.value) {
    selectPreset(selectedPreset.value, { skipDiscardConfirm: true })
    isCreating.value = false
  } else {
    isCreating.value = false
    selectedId.value = null
    form.value = defaultForm()
    markClean()
  }
}

async function submitForm() {
  if (!assertCanOperate()) return
  const payload: SupportPresetShape = normalizeSupportPreset({
    ...form.value,
    tagging: form.value.tagging,
  })
  const validationError = validateSupportPreset(payload)
  if (validationError) return showToast(validationError, 'error')
  if (payload.tagging.enabled && payload.tagging.addTagIds.length === 0) {
    return showToast('已啟用貼標，請至少選擇一個標籤', 'error')
  }

  saving.value = true
  try {
    if (isCreating.value) {
      const res = await apiFetch<any>('/api/support-preset/create', {
        method: 'POST',
        body: payload,
      })
      showToast('預存已建立', 'success')
      await loadPresets(true)
      const created = presets.value.find(p => p.id === res.id) ?? presets.value[0]
      if (created) selectPreset(created, { skipDiscardConfirm: true })
      isCreating.value = false
    } else {
      await apiFetch(`/api/support-preset/${selectedId.value}`, {
        method: 'PUT',
        body: payload,
      })
      showToast('預存已更新', 'success')
      await loadPresets(true)
      markClean()
    }
  } catch {
    showToast('儲存失敗', 'error')
  } finally {
    saving.value = false
  }
}

async function deletePreset() {
  if (!assertCanOperate()) return
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(`確定刪除「${form.value.name || '此預存'}」？`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/support-preset/${selectedId.value}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    selectedId.value = null
    isCreating.value = false
    form.value = defaultForm()
    markClean()
    await loadPresets(true)
  } catch {
    showToast('刪除失敗', 'error')
  }
}

function getActionSummary(preset: any) {
  const normalized = normalizeSupportPreset(preset)
  if (normalized.action.type === 'module') {
    return modules.value.find(m => m.id === normalized.action.moduleId)?.name ?? '未選擇模組'
  }
  if (normalized.action.type === 'uri') {
    return normalized.action.uri || '開啟網址'
  }
  return normalized.action.text || '傳送文字'
}
</script>
