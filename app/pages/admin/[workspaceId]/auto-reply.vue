<template>
  <AdminSplitLayout :is-empty="!selectedRule && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="ar-title">自動回覆</span>
      <el-button v-if="canOperate" :icon="Plus" type="primary" size="small" data-tour="ar-new" @click="openCreate">新增</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <div v-if="loading && !rules.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!rules.length" class="split-sidebar-empty">
        <span>尚無規則</span>
        <p class="text-xs text-muted">新增一條關鍵字規則來開始</p>
        <el-button v-if="canOperate" size="small" type="primary" plain @click="openCreate">立即新增</el-button>
      </div>
      <div v-else ref="listEl" class="split-list" @scroll.passive="onSidebarListScroll">
        <AdminSplitListItem
          v-for="rule in rules"
          :key="rule.id"
          :title="rule.name || rule.keyword || '(未命名)'"
          :active="selectedId === rule.id"
          time-in-title-row
          title-row-chip
          :chip-text="rule.isActive ? '啟用' : '停用'"
          :chip-tone="rule.isActive ? 'success' : 'neutral'"
          :meta-text="getActionSummary(rule)"
          :meta-truncate="true"
          @select="selectRule(rule)"
        />

        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
          <span>載入更多…</span>
        </div>
      </div>
    </template>

    <!-- ── Empty State ── -->
    <template #editor-empty>
      <el-icon class="empty-icon"><Lightning /></el-icon>
      <h3>選擇一條規則開始編輯</h3>
      <!-- AI 一句話生成草稿(沿用腳本頁同一組樣式,跨頁一致) -->
      <div v-if="canOperate" class="scripts-ai-generate" data-tour="ar-ai-gen">
        <span class="scripts-ai-generate-label">
          <el-icon><MagicStick /></el-icon> 用一句話描述，AI 幫你搭草稿
        </span>
        <el-input
          v-model="aiGenDesc"
          type="textarea"
          :rows="2"
          maxlength="500"
          placeholder="例：客人問運費就回:全館滿千免運,未滿收80"
          @keydown.enter.exact.prevent="generateFromAi"
        />
        <div class="scripts-ai-generate-actions">
          <span class="text-xs text-muted">生成後會填進表單讓你檢查，按「建立規則」才會存檔</span>
          <el-button type="primary" :loading="aiGenerating" :disabled="!aiGenDesc.trim()" @click="generateFromAi">
            {{ aiGenerating ? 'AI 生成中…' : 'AI 生成草稿' }}
          </el-button>
        </div>
      </div>
      <p>或點擊左側「新增」建立一條新的關鍵字觸發規則</p>
      <el-button v-if="canOperate" type="primary" @click="openCreate">新增規則</el-button>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <AdminEditorHeaderTitle
        v-model="form.name"
        field-label="規則名稱"
        create-prefix="新增規則:"
        placeholder="請輸入規則名稱..."
        caption="為這個自動回覆規則命名，方便後續管理"
        :is-creating="isCreating"
        @enter="submitForm"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button v-if="canOperate && !isCreating && selectedRule" :icon="Delete" type="danger" @click="deleteRule">
          刪除
        </el-button>
        <el-button @click="cancelEdit">取消</el-button>
        <el-button v-if="canOperate" type="primary" :loading="saving" @click="submitForm">
          {{ isCreating ? '建立規則' : '儲存變更' }}
        </el-button>
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <div class="ar-editor-body admin-panel-stack">
        <!-- Status section -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">狀態設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ar-section-hint">停用的規則將不會被觸發。</p>
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

        <!-- Keyword section -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">觸發條件</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ar-section-hint">設定客人訊息要「怎麼比對」才算命中：含到其中一個關鍵字、要全部關鍵字都出現、內容要一字不差，或是客人不管打什麼都會觸發。</p>
            <div class="admin-field-group">
              <AdminFieldLabel text="比對方式" tight />
              <el-select v-model="form.matchType" class="control-full">
                <el-option
                  v-for="option in triggerModeOptions"
                  :key="option.value"
                  :value="option.value"
                  :label="option.label"
                />
              </el-select>
            </div>
            <div v-if="form.matchType !== 'anyText'" class="admin-field-group">
              <AdminFieldLabel text="關鍵字內容" tight />
              <el-input
                v-model="form.keyword"
                :placeholder="keywordPlaceholder"
                @keydown.enter.prevent="submitForm"
              />
            </div>
            <div v-else class="ar-any-text-note">
              將於使用者輸入任意文字時觸發。
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="防重複觸發" tight />
              <el-switch
                v-model="form.cooldown.enabled"
                active-text="啟用"
                inactive-text="停用"
                class="ar-status-switch"
              />
            </div>
            <div v-if="form.cooldown.enabled" class="admin-field-group">
              <AdminFieldLabel text="冷卻時間" tight />
              <el-select v-model="form.cooldown.durationMs" class="control-full">
                <el-option
                  v-for="option in cooldownOptions"
                  :key="option.value"
                  :value="option.value"
                  :label="option.label"
                />
              </el-select>
              <p class="ar-section-hint">
                同一位客人在這段時間內又打了關鍵字，也不會再回一次，避免短時間內一直重複回覆。
              </p>
            </div>
          </div>
        </div>

        <!-- Action -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">觸發動作設定</span>
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
                :type-options="autoReplyActionTypeOptions"
                :module-options="modules"
                :variable-options="[]"
                header-label=""
                flat
                :show-label-field="false"
                :show-variable-inset="false"
                module-title="機器人模組"
                module-placeholder="請選擇要觸發的模組"
                text-title="回覆文字"
                text-placeholder="輸入要回覆給使用者的文字"
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
import { Delete, Lightning, MagicStick, Plus } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import {
  AUTO_REPLY_COOLDOWN_OPTIONS,
  normalizeAutoReplyAction,
  normalizeAutoReplyCooldown,
  normalizeAutoReplyRule,
  normalizeAutoReplyTagging,
  validateAutoReplyRule,
  type AutoReplyRuleShape,
} from '~~/shared/auto-reply-rule'

definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()

// ── State ────────────────────────────────────────────────
const modules = ref<any[]>([])
const {
  items: rules,
  loading,
  loadingMore,
  listEl,
  load: loadRules,
  onScroll: onSidebarListScroll,
} = useWorkspaceSidebarList<any>('/api/auto-reply/list')
const modulesLoading = ref(true)
const saving = ref(false)
const selectedId = ref<string | null>(null)
const isCreating = ref(false)
const { showToast } = useAdminToast()
const { tags: allTags, loading: tagsLoading, loadTags } = useAdminTagList()

const defaultForm = () => ({
  name: '',
  keyword: '',
  matchType: 'containsAny',
  action: normalizeAutoReplyAction({ type: 'module', moduleId: '' }),
  isActive: true,
  tagging: normalizeAutoReplyTagging(null),
  cooldown: normalizeAutoReplyCooldown(null),
})
const form = ref(defaultForm())
const { markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
})

const triggerModeOptions = [
  { value: 'containsAny', label: '包含任一' },
  { value: 'containsAll', label: '包含全部' },
  { value: 'exact', label: '內容完全一致' },
  { value: 'anyText', label: '輸入任何內容' },
]

const cooldownOptions = AUTO_REPLY_COOLDOWN_OPTIONS

const autoReplyActionTypeOptions = [
  { value: 'uri', label: '開啟網址' },
  { value: 'message', label: '傳送文字' },
  { value: 'module', label: '觸發機器人模組' },
]

const selectedRule = computed(() => rules.value.find(r => r.id === selectedId.value) ?? null)
const keywordPlaceholder = computed(() => {
  if (form.value.matchType === 'containsAll') return '例：訂單 取消（可用空白、逗號分隔多關鍵字）'
  if (form.value.matchType === 'containsAny') return '例：優惠、折扣、促銷（任一命中即觸發）'
  return '例：你好、優惠、查詢商品'
})

// ── Load ─────────────────────────────────────────────────
async function loadModules() {
  modulesLoading.value = true
  modules.value = await apiFetch<any[]>('/api/flow/list').catch(() => [])
  modulesLoading.value = false
}

onMounted(() => {
  loadRules(true)
  loadModules()
  loadTags({ status: 'active' })
})

// ── Select / Create ───────────────────────────────────────
function selectRule(rule: any, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = rule.id
  const normalized = normalizeAutoReplyRule(rule)
  form.value = {
    name: normalized.name,
    keyword: normalized.keyword,
    matchType: normalized.matchType,
    action: normalized.action,
    isActive: normalized.isActive,
    tagging: normalized.tagging,
    cooldown: normalized.cooldown,
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

// ── AI 一句話生成草稿(填進表單讓人審,按「建立規則」才存) ─────────────
const aiGenDesc = ref('')
const aiGenerating = ref(false)

async function generateFromAi() {
  const description = aiGenDesc.value.trim()
  if (!description || aiGenerating.value) return
  if (!confirmLeaveIfDirty()) return
  aiGenerating.value = true
  try {
    const draft = await apiFetch<any>('/api/auto-reply/generate', { method: 'POST', body: { description } })
    isCreating.value = true
    selectedId.value = null
    form.value = {
      ...defaultForm(),
      name: draft.name,
      keyword: draft.keyword,
      matchType: draft.matchType,
      action: normalizeAutoReplyAction(draft.action),
    }
    markClean()
    aiGenDesc.value = ''
    showToast('草稿已生成——檢查關鍵字和回覆文字，按「建立規則」存檔', 'success')
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.data?.statusMessage || err?.message || 'AI 生成失敗，換個說法再試一次', 'error')
  }
  finally {
    aiGenerating.value = false
  }
}

function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedRule.value) {
    selectRule(selectedRule.value, { skipDiscardConfirm: true })
    isCreating.value = false
  } else {
    isCreating.value = false
    selectedId.value = null
    form.value = defaultForm()
    markClean()
  }
}

// ── Save / Delete ─────────────────────────────────────────
async function submitForm() {
  if (!assertCanOperate()) return
  const payload: AutoReplyRuleShape = normalizeAutoReplyRule({
    ...form.value,
    tagging: form.value.tagging,
  })
  const validationError = validateAutoReplyRule(payload)
  if (validationError) return showToast(validationError, 'error')
  if (payload.tagging.enabled && payload.tagging.addTagIds.length === 0) {
    return showToast('已啟用貼標，請至少選擇一個標籤', 'error')
  }

  saving.value = true
  try {
    if (isCreating.value) {
      const res = await apiFetch<any>('/api/auto-reply/create', {
        method: 'POST',
        body: payload,
      })
      showToast('規則已建立', 'success')
      await loadRules(true)
      const newRule = rules.value.find(r => r.id === res.id) ?? rules.value[0]
      if (newRule) selectRule(newRule, { skipDiscardConfirm: true })
      isCreating.value = false
    } else {
      await apiFetch(`/api/auto-reply/${selectedId.value}`, {
        method: 'PUT',
        body: payload,
      })
      showToast('規則已更新', 'success')
      await loadRules(true)
      markClean()
    }
  } catch {
    showToast('儲存失敗', 'error')
  } finally {
    saving.value = false
  }
}


async function deleteRule() {
  if (!assertCanOperate()) return
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(`確定刪除「${form.value.name || form.value.keyword}」這條規則？`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/auto-reply/${selectedId.value}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    selectedId.value = null
    isCreating.value = false
    form.value = defaultForm()
    markClean()
    await loadRules(true)
  } catch {
    showToast('刪除失敗', 'error')
  }
}

// ── Helpers ───────────────────────────────────────────────
function getActionSummary(rule: any) {
  const normalized = normalizeAutoReplyRule(rule)
  if (normalized.action.type === 'module') {
    return modules.value.find(m => m.id === normalized.action.moduleId)?.name ?? '未選擇模組'
  }
  if (normalized.action.type === 'uri') {
    return normalized.action.uri || '開啟網址'
  }
  return normalized.action.text || '傳送文字'
}

</script>
