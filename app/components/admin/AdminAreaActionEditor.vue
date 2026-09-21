<template>
  <div class="carousel-actions">
    <div class="carousel-action-row">
      <div class="carousel-action-row-top">
        <span class="carousel-action-index">區塊動作</span>
      </div>

      <div class="admin-field-group">
        <AdminFieldLabel text="動作類型" tight />
        <el-select
          :model-value="String(action?.type || 'uri')"
          class="admin-w-full control-full"
          :disabled="disabled"
          @change="onTypeChange"
        >
          <el-option value="uri" label="開啟網址" />
          <el-option value="message" label="傳送文字" />
          <el-option value="module" label="觸發機器人模組" />
          <el-option v-if="allowSwitch" value="switch" label="切換選單" />
        </el-select>
      </div>

      <template v-if="action.type === 'uri'">
        <div class="admin-field-group">
          <AdminFieldLabel text="網址" tight />
          <el-input
            :model-value="String(action?.uri || '')"
            placeholder="https://..."
            :disabled="disabled"
            @update:model-value="(v) => patchAction({ uri: v })"
          />
        </div>
      </template>

      <template v-if="action.type === 'message'">
        <div class="admin-field-group">
          <AdminFieldLabel text="回覆文字" tight />
          <el-input
            :model-value="String(action?.text || '')"
            placeholder="輸入代發文字"
            :disabled="disabled"
            @update:model-value="(v) => patchAction({ text: v })"
          />
        </div>
      </template>

      <template v-if="action.type === 'module'">
        <div class="admin-field-group">
          <AdminFieldLabel :text="moduleLabel" tight />
          <el-select
            :model-value="String(action?.moduleId || '')"
            class="admin-w-full control-full"
            :placeholder="modulePlaceholder"
            :disabled="disabled"
            @update:model-value="(v) => patchAction({ moduleId: v })"
          >
            <el-option
              v-for="mod in moduleOptions"
              :key="mod.id"
              :value="mod.id"
              :label="mod.name"
            />
          </el-select>
        </div>
      </template>

      <template v-if="allowSwitch && action.type === 'switch'">
        <div class="admin-field-group">
          <AdminFieldLabel :text="switchLabel" tight />
          <el-select
            :model-value="String(action?.data || '')"
            class="admin-w-full control-full"
            :placeholder="switchPlaceholder"
            :disabled="disabled"
            @update:model-value="(v) => patchAction({ data: v })"
          >
            <el-option
              v-for="menu in availableMenuOptions"
              :key="menu.id"
              :value="`${menuValuePrefix}${menu.id}`"
              :label="menu.name"
            />
          </el-select>
        </div>
      </template>

      <template v-if="enableTagging">
        <div class="admin-field-group">
          <AdminFieldLabel text="啟用貼標" tight />
          <el-switch
            :model-value="Boolean(taggingSnapshot().enabled)"
            active-text="啟用"
            inactive-text="停用"
            class="ar-status-switch"
            :disabled="disabled || !isTaggableAction"
            @update:model-value="onTaggingEnabledChange"
          />
        </div>
        <div v-if="!isTaggableAction" class="text-xs text-muted">
          此動作類型目前不支援貼標。
        </div>
        <div v-if="taggingSnapshot().enabled" class="admin-field-group">
          <!-- C-208：共用選標籤欄位（多了「＋ 新標籤」與空狀態出口，不必離開這張表單） -->
          <AdminTagPicker
            :model-value="taggingSnapshot().addTagIds"
            :options="tagOptions"
            :disabled="disabled || !isTaggableAction"
            @update:model-value="onTaggingIdsChange"
          />
        </div>
      </template>

    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'

type EditorOption = { id: string; name: string }
type TagOption = { id: string; name: string; color?: string }

type ActionShape = {
  type?: string
  uri?: string
  text?: string
  moduleId?: string
  data?: string
  [key: string]: any
}

const props = withDefaults(defineProps<{
  modelValue: ActionShape
  moduleOptions: EditorOption[]
  tagOptions?: TagOption[]
  taggableActionTypes?: string[]
  menuOptions?: EditorOption[]
  allowSwitch?: boolean
  enableTagging?: boolean
  excludeMenuId?: string | null
  menuValuePrefix?: string
  moduleLabel?: string
  modulePlaceholder?: string
  switchLabel?: string
  switchPlaceholder?: string
  errorMessage?: string
  /** 唯讀（例如已發送推播僅檢視） */
  disabled?: boolean
}>(), {
  tagOptions: () => [],
  taggableActionTypes: () => ['module', 'message', 'uri'],
  menuOptions: () => [],
  allowSwitch: false,
  enableTagging: false,
  excludeMenuId: null,
  menuValuePrefix: 'switchMenu=',
  moduleLabel: '選擇目標模組',
  modulePlaceholder: '請選擇要觸發的機器人模組...',
  switchLabel: '選擇目標圖文選單',
  switchPlaceholder: '請選擇要切換的選單...',
  errorMessage: '',
  disabled: false,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: ActionShape): void
}>()

const action = computed(() => props.modelValue)

const availableMenuOptions = computed(() =>
  (props.menuOptions || []).filter((menu) => menu.id !== props.excludeMenuId),
)

const isTaggableAction = computed(() =>
  Array.isArray(props.taggableActionTypes)
  && props.taggableActionTypes.includes(String(action.value?.type || '')),
)

function patchAction(partial: Partial<ActionShape>) {
  emit('update:modelValue', { ...props.modelValue, ...partial } as ActionShape)
}

function taggingSnapshot(): { enabled: boolean; addTagIds: string[] } {
  const t = props.modelValue?.tagging
  if (!t || typeof t !== 'object') return { enabled: false, addTagIds: [] }
  return {
    enabled: Boolean(t.enabled),
    addTagIds: Array.isArray(t.addTagIds) ? t.addTagIds.map(String) : [],
  }
}

function onTypeChange(nextType: string | number | boolean | Record<string, unknown> | unknown[]) {
  if (props.disabled) return
  const t = String(nextType || 'uri')
  emit('update:modelValue', {
    ...props.modelValue,
    type: t,
    uri: '',
    text: '',
    moduleId: '',
    data: '',
    tagging: { enabled: false, addTagIds: [] },
  } as ActionShape)
}

function onTaggingEnabledChange(value: string | number | boolean) {
  if (props.disabled || !isTaggableAction.value) return
  const enabled = Boolean(value)
  const prev = taggingSnapshot()
  patchAction({
    tagging: {
      enabled,
      addTagIds: enabled ? prev.addTagIds : [],
    },
  })
}

function onTaggingIdsChange(ids: string[]) {
  if (props.disabled || !isTaggableAction.value) return
  patchAction({
    tagging: {
      ...taggingSnapshot(),
      addTagIds: Array.isArray(ids) ? ids.map(String) : [],
    },
  })
}

watch(isTaggableAction, (supported) => {
  if (!supported) {
    const snap = taggingSnapshot()
    if (snap.enabled || snap.addTagIds.length > 0)
      patchAction({ tagging: { enabled: false, addTagIds: [] } })
  }
}, { immediate: true })
</script>
