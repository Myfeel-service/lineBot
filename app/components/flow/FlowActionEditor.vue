<template>
  <div :class="['carousel-action-row', { 'carousel-action-row--flat': flat }]">
    <div v-if="headerLabel || $slots['top-extra']" class="carousel-action-row-top">
      <span class="carousel-action-index">{{ headerLabel }}</span>
      <slot name="top-extra" />
    </div>

    <div class="admin-field-group">
      <AdminFieldLabel :text="typeTitle" tight />
      <el-select v-model="action.type" :size="fieldSize" class="control-full">
        <el-option
          v-for="option in typeOptions"
          :key="option.value"
          :value="option.value"
          :label="option.label"
        />
      </el-select>
    </div>

    <template v-if="showLabelField && isActionEnabled">
      <div class="admin-field-group">
        <AdminFieldLabel :text="labelTitle" tight />
        <div :class="['flow-input-inset-wrap', insetWrapClass, 'control-full']">
          <el-input
            v-model="action.label"
            :placeholder="labelPlaceholder"
            :maxlength="labelMaxlength"
            :show-word-limit="labelShowWordLimit"
            :size="fieldSize"
          />
          <FlowVariableInset
            v-if="showVariableInset"
            :size="insetButtonSize"
            :options="variableOptions"
            @pick="(token) => insertToken('label', String(token))"
          />
        </div>
      </div>
    </template>

    <template v-if="action.type === moduleTypeValue">
      <div class="admin-field-group">
        <AdminFieldLabel :text="moduleTitle" tight />
        <el-select
          v-model="action.moduleId"
          :placeholder="modulePlaceholder"
          :size="fieldSize"
          class="control-full"
        >
          <el-option
            v-for="moduleOption in moduleOptions"
            :key="moduleOption.id"
            :value="moduleOption.id"
            :label="moduleOption.name"
          />
        </el-select>
      </div>
    </template>

    <template v-else-if="action.type === uriTypeValue">
      <div class="admin-field-group">
        <AdminFieldLabel :text="uriTitle" tight />
        <el-input v-model="action.uri" :placeholder="uriPlaceholder" :size="fieldSize" />
      </div>
    </template>

    <template v-else-if="action.type === messageTypeValue">
      <div class="admin-field-group">
        <AdminFieldLabel :text="textTitle" tight />
        <div :class="['flow-input-inset-wrap', insetWrapClass, 'control-full']">
          <!--
            textMultiline：這段文字是機器人「回」給客人的（預存／自動回覆／行銷活動）時要能換行——
            段落、條列、留白都是回覆的一部分，擠成一行客人讀不下去。
            按鈕動作那種「代客人送出的文字」維持單行：那是一句話，不是一段文案。
          -->
          <el-input
            v-model="action.text"
            :type="textMultiline ? 'textarea' : 'text'"
            :autosize="textMultiline ? { minRows: 3, maxRows: 12 } : undefined"
            :resize="textMultiline ? 'none' : undefined"
            :placeholder="textPlaceholder"
            :size="fieldSize"
          />
          <FlowVariableInset
            v-if="showVariableInset"
            :size="insetButtonSize"
            :options="variableOptions"
            @pick="(token) => insertToken('text', String(token))"
          />
        </div>
      </div>
    </template>

    <template v-if="enableTagging && isActionEnabled">
      <div class="admin-field-group">
        <AdminFieldLabel text="啟用貼標" tight />
        <el-switch
          v-model="ensureTaggingState().enabled"
          active-text="啟用"
          inactive-text="停用"
          class="ar-status-switch"
          :disabled="!isTaggableAction"
        />
      </div>
      <div v-if="!isTaggableAction" class="text-xs text-muted">
        此動作類型目前不支援貼標。
      </div>
      <div v-if="ensureTaggingState().enabled" class="admin-field-group">
        <AdminFieldLabel text="命中後加上標籤" tight />
        <el-select
          v-model="ensureTaggingState().addTagIds"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="選擇要貼的標籤"
          class="admin-w-full"
          :disabled="!isTaggableAction"
        >
          <el-option
            v-for="tag in tagOptions"
            :key="tag.id"
            :label="tag.name"
            :value="tag.id"
          >
            <AdminTagOptionRow :label="tag.name" :color="tag.color" />
          </el-option>
        </el-select>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
type ActionOption = {
  value: string
  label: string
}

type VariableOption = {
  value: string
  label: string
  token: string
}

type ModuleOption = {
  id: string
  name: string
}

type TagOption = {
  id: string
  name: string
  color?: string
}

const props = withDefaults(defineProps<{
  action: Record<string, any>
  typeOptions: ActionOption[]
  moduleOptions: ModuleOption[]
  tagOptions?: TagOption[]
  taggableActionTypes?: string[]
  variableOptions: VariableOption[]
  headerLabel?: string
  typeTitle?: string
  showLabelField?: boolean
  labelTitle?: string
  labelPlaceholder?: string
  labelMaxlength?: number
  labelShowWordLimit?: boolean
  textTitle?: string
  textPlaceholder?: string
  /** 回覆文字用多行輸入（機器人回給客人的文案）；按鈕的「代發文字」維持單行 */
  textMultiline?: boolean
  uriTitle?: string
  uriPlaceholder?: string
  moduleTitle?: string
  modulePlaceholder?: string
  fieldSize?: 'default' | 'small'
  flat?: boolean
  showVariableInset?: boolean
  hideFieldsWhenNone?: boolean
  enableTagging?: boolean
  noneTypeValue?: string
  messageTypeValue?: string
  uriTypeValue?: string
  moduleTypeValue?: string
}>(), {
  tagOptions: () => [],
  taggableActionTypes: () => ['module', 'message', 'uri'],
  headerLabel: '按鈕動作',
  typeTitle: '動作類型',
  showLabelField: true,
  labelTitle: '按鈕顯示文字（最多 20 字）',
  labelPlaceholder: '按鈕名稱 (必填，限 20 字)',
  labelMaxlength: 20,
  labelShowWordLimit: false,
  textTitle: '回覆文字',
  textPlaceholder: '回覆文字',
  textMultiline: false,
  uriTitle: '網址',
  uriPlaceholder: 'https://...',
  moduleTitle: '機器人模組',
  modulePlaceholder: '選擇機器人模組',
  fieldSize: 'default',
  flat: false,
  showVariableInset: true,
  hideFieldsWhenNone: false,
  enableTagging: false,
  noneTypeValue: 'none',
  messageTypeValue: 'message',
  uriTypeValue: 'uri',
  moduleTypeValue: 'module',
})

const isActionEnabled = computed(() =>
  !props.hideFieldsWhenNone || props.action.type !== props.noneTypeValue,
)
const isTaggableAction = computed(() =>
  Array.isArray(props.taggableActionTypes)
  && props.taggableActionTypes.includes(String(props.action.type || '')),
)

const insetWrapClass = computed(() =>
  props.fieldSize === 'small' ? 'flow-input-inset-wrap--sm' : '',
)

const insetButtonSize = computed(() =>
  props.fieldSize === 'small' ? 'sm' : 'default',
)

function insertToken(key: 'label' | 'text', token: string) {
  const current = typeof props.action[key] === 'string' ? props.action[key] : ''
  props.action[key] = `${current}${token}`
}

function ensureTaggingState() {
  if (!props.action.tagging || typeof props.action.tagging !== 'object') {
    props.action.tagging = { enabled: false, addTagIds: [] }
  }
  if (!Array.isArray(props.action.tagging.addTagIds)) {
    props.action.tagging.addTagIds = []
  }
  return props.action.tagging as { enabled: boolean; addTagIds: string[] }
}

watch(isTaggableAction, (supported) => {
  if (!supported) {
    const tagging = ensureTaggingState()
    tagging.enabled = false
    tagging.addTagIds = []
  }
}, { immediate: true })
</script>
