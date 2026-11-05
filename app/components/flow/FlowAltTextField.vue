<template>
  <div class="admin-field-group">
    <AdminFieldLabel tight>
      提醒文字 <span class="text-muted">({{ required ? '必填' : '選填' }}，最多 {{ LINE_ALT_TEXT_MAX }} 字)</span>
    </AdminFieldLabel>
    <div class="flow-input-inset-wrap control-full">
      <VariableTextField
        :model-value="modelValue"
        :known-keys="knownKeys"
        :placeholder="placeholder"
        :maxlength="LINE_ALT_TEXT_MAX"
        @update:model-value="(v) => emit('update:modelValue', v)"
      />
      <FlowVariableInset
        :options="options"
        @pick="(token, range) => emit('pick', token, range)"
      />
    </div>
    <p class="text-xs text-muted">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import type { CaretRange } from '~/utils/insert-token-at-caret'
import type { VariableInsetOption } from '~/components/flow/FlowVariableInset.vue'
import { LINE_ALT_TEXT_MAX } from '~~/shared/line-alt-text'

/**
 * 「提醒文字」這一格（`C-468`）：五種模組以前五種長相、五種說法，現在只有這一支。
 *
 * ⛔ 文案寫在這裡、不要由呼叫端各傳一句——同一格在隔壁模組換個說法，就是這一輪要修掉的病。
 *   呼叫端只回答一件事：**沒填的話客人會看到什麼**（`empty-behavior`）。
 * ⛔ 哪幾種模組該出現這一格，看 `shared/line-alt-text.ts` 的 `flowMessageHasAltText()`：
 *   純文字、圖片、影片那幾種 LINE 根本沒有這一行字可以設，給了格子也是假的。
 */
const props = withDefaults(defineProps<{
  modelValue: string | undefined | null
  /** 沒填就送不出去（目前只有圖文訊息：整則只有一張圖，沒有文字可以自動拿來用） */
  required?: boolean
  /** 沒填的話客人會看到什麼，接在「沒填的話，客人會看到」後面 */
  emptyBehavior?: string
  options: VariableInsetOption[]
  knownKeys?: readonly string[]
}>(), { required: false, emptyBehavior: '', knownKeys: () => [] })

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'pick': [token: string, range: CaretRange | null]
}>()

const placeholder = computed(() => (props.required
  ? '例：母親節送禮指南，這週下單免運'
  : `沒填的話，客人會看到${props.emptyBehavior}`))

/**
 * ⛔ 不要寫「Alt Text」「替代文字」這種名字——店家看不懂。
 * 講他看得到的東西：手機上方跳出來那條通知、聊天列表裡那一行。
 */
const hint = computed(() => (props.required
  ? '客人手機跳出的通知、聊天列表那一行會顯示這句話。這一則整個是一張圖，沒有文字可以自動拿來用，所以要自己寫。'
  : '客人手機跳出的通知、聊天列表那一行會顯示這句話；點進來才看得到卡片本身。'))
</script>
