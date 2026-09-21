<template>
  <div ref="rootEl" class="flow-var-inset" @click.stop>
    <el-dropdown trigger="click" placement="bottom-end" teleported @command="onCommand">
      <button
        type="button"
        :class="['flow-var-inset__btn', { 'flow-var-inset__btn--sm': size === 'sm' }]"
        :aria-label="ariaLabel"
        :title="hint"
        @pointerdown="rememberCaret"
        @keydown="rememberCaret"
      >
        {{ glyph }}
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="opt in options"
            :key="opt.value"
            :command="opt.token"
          >
            {{ opt.label }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { CaretRange } from '~/utils/insert-token-at-caret'
import { insertTokenAtCaret } from '~/utils/insert-token-at-caret'

export type VariableInsetOption = { value: string; label: string; token: string }

withDefaults(
  defineProps<{
    options: VariableInsetOption[]
    /** Compact trigger for size="small" inputs */
    size?: 'default' | 'sm'
  }>(),
  { size: 'default' },
)

const emit = defineEmits<{
  /** range = 使用者按下插入鈕當下的游標位置；null＝當時人不在輸入框裡（接在最後面） */
  pick: [token: string, range: CaretRange | null]
}>()

const glyph = '{{...}}'
const ariaLabel = '插入變數'
// 滑鼠懸停說明（白話），避免 {{...}} 這個工程符號沒人看得懂
const hint = '插入變數（例：聯絡人名稱）'

const rootEl = ref<HTMLElement | null>(null)

/**
 * 只認純文字欄位。`input[type=number]` 這種不支援選取的，Chrome 連讀 `selectionStart`
 * 都會丟例外——選擇器擋在這裡，將來有人把 inset 掛到那種欄位上也只是退回「接在最後面」。
 */
const FIELD_SELECTOR = 'textarea, input[type="text"], input:not([type])'

/**
 * 插入鈕自己去找旁邊那個輸入框：每個外層（`.flow-textarea-wrapper` / `.flow-input-inset-wrap`）
 * 裡就只有一個 el-input，所以直接問父層要，呼叫端不必多傳一個 ref 進來。
 */
function resolveField(): HTMLTextAreaElement | HTMLInputElement | null {
  const wrap = rootEl.value?.parentElement
  return wrap?.querySelector<HTMLTextAreaElement | HTMLInputElement>(FIELD_SELECTOR) ?? null
}

/**
 * ⛔ 一定要在 **pointerdown** 記下游標：按鈕一被按下輸入框就失焦了，等下拉選單的
 *   command 事件回來時，`selectionStart` 雖然還讀得到，卻已經分不出「使用者剛剛真的
 *   在那裡打字」還是「這個框從頭到尾沒被點過」——沒被點過時它也是 0，照插就會插到最前面。
 *   所以判斷基準是「按下的當下，焦點是不是就在這個框」。
 */
let caretRange: CaretRange | null = null
function rememberCaret() {
  const field = resolveField()
  if (!field || document.activeElement !== field) {
    caretRange = null
    return
  }
  const start = field.selectionStart
  const end = field.selectionEnd
  caretRange = typeof start === 'number' && typeof end === 'number' ? { start, end } : null
}

async function onCommand(cmd: string | number | object) {
  const token = String(cmd)
  const range = caretRange
  caretRange = null

  const field = resolveField()
  // 先算好游標要停哪（此時 field.value 還是插入前的文字），跟父層用的是同一支函式
  const caret = field ? insertTokenAtCaret(field.value, token, range).caret : null

  emit('pick', token, range)

  if (!field || caret === null) return
  // 插完把焦點還給輸入框、游標停在變數後面，否則使用者得再點一次才能接著打字
  await nextTick()
  field.focus()
  if (typeof field.selectionStart === 'number') field.setSelectionRange(caret, caret)
}
</script>
