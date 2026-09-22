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
          <!-- `D-86`：共用的選模組欄位（搜尋／編輯這個模組 ↗／＋ 新模組／標出還沒有內容） -->
          <AdminFlowPicker
            :model-value="String(action?.moduleId || '')"
            :options="moduleOptions"
            :placeholder="modulePlaceholder"
            :disabled="disabled"
            @update:model-value="(v) => patchAction({ moduleId: v })"
          />
        </div>
      </template>

      <!--
        `C-228`②：卡片上那句話與按鈕上那幾個字。
        ⛔ 只有「會組成一張按鈕卡片送出去」的地方才給這兩格（＝推播），所以由 `enableCardCopy`
        開關控制。圖文選單用的是同一支元件，但客人是**直接點圖上的格子**，沒有卡片也沒有按鈕
        文字——在那裡多出這兩格只會讓人填了一個永遠不會出現的東西。
      -->
      <template v-if="enableCardCopy && actionSendsCard">
        <div class="admin-field-group">
          <AdminFieldLabel text="卡片上要寫什麼（選填）" tight />
          <el-input
            :model-value="String(action?.cardText || '')"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 5 }"
            :maxlength="LINE_BUTTONS_TEMPLATE_TEXT_MAX"
            show-word-limit
            :placeholder="LINE_CARD_BODY_DEFAULT"
            :disabled="disabled"
            @update:model-value="(v) => patchAction({ cardText: v })"
          />
          <!--
            這一段是這兩格存在的全部理由：在 `C-228` 以前，這句話是系統替店家寫的，
            而他從來不知道有這句話（`D-87`）。所以**第一件事是先講「客人收到的不是網址」**。
          -->
          <p class="text-xs text-muted">
            客人收到的<b>不是</b>一串網址，而是一張卡片：上面一句話、下面一顆按鈕。
            這一格就是那句話。不填的話會用灰字那句。
          </p>
        </div>
        <div class="admin-field-group">
          <AdminFieldLabel text="按鈕上要寫什麼（選填）" tight />
          <el-input
            :model-value="String(action?.buttonLabel || '')"
            :maxlength="LINE_ACTION_LABEL_MAX"
            show-word-limit
            :placeholder="cardButtonPlaceholder"
            :disabled="disabled"
            @update:model-value="(v) => patchAction({ buttonLabel: v })"
          />
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
import {
  LINE_ACTION_LABEL_MAX,
  LINE_CARD_BODY_DEFAULT,
  LINE_CARD_BUTTON_LABEL_MODULE_DEFAULT,
  LINE_CARD_BUTTON_LABEL_URI_DEFAULT,
} from '~~/shared/line-card-copy'
import { LINE_BUTTONS_TEMPLATE_TEXT_MAX } from '~~/shared/line-text-limits'

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
  /**
   * `C-228`②：顯示「卡片上要寫什麼／按鈕上要寫什麼」兩格。
   * ⛔ 預設關著：只有真的會把動作組成一張按鈕卡片送出去的地方（推播）才該開。
   * 圖文選單是直接點圖上的格子，沒有卡片。
   */
  enableCardCopy?: boolean
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
  enableCardCopy: false,
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

/**
 * `C-228`②：這個動作送出去時會不會變成一張按鈕卡片。
 * 只有「開啟網址」與「觸發機器人模組」會——「傳送文字」是純文字氣泡（沒有卡片也沒有按鈕），
 * 「切換選單」根本不送訊息。⛔ 在那兩種上面顯示這兩格，就是讓人填一個永遠不會出現的東西。
 */
const actionSendsCard = computed(() => {
  const t = String(action.value?.type || '')
  return t === 'uri' || t === 'module'
})

/** 按鈕的灰字提示要跟送出端的預設一致，否則畫面示範的是一顆客人不會看到的按鈕 */
const cardButtonPlaceholder = computed(() =>
  String(action.value?.type || '') === 'module'
    ? LINE_CARD_BUTTON_LABEL_MODULE_DEFAULT
    : LINE_CARD_BUTTON_LABEL_URI_DEFAULT,
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
  /*
   * 換動作類型＝整格重來（既有行為：網址、文字、模組、貼標全清）。
   * `C-228`②的兩格也一起清。⛔ 不要為它們開例外說「反正網址跟模組都是卡片、留著吧」——
   * 同一個下拉，有些欄位會被清、有些不會，是最難預期的那種行為；而且換到「傳送文字」
   * 或「切換選單」時本來就沒有卡片，留著等於留一個看不到也刪不掉的殘值。
   */
  emit('update:modelValue', {
    ...props.modelValue,
    type: t,
    uri: '',
    text: '',
    moduleId: '',
    data: '',
    cardText: '',
    buttonLabel: '',
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
