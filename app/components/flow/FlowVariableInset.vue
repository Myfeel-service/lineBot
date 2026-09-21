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
  /**
   * **退路用**：正常情況下這個元件是請瀏覽器自己把字打進去（見 `onCommand`），
   * v-model 會由 `input` 事件更新，父層什麼都不用做。只有瀏覽器不給插的時候才會發這個事件，
   * 由父層直接改資料。
   * `range` = 使用者按下插入鈕當下的游標位置；`null` ＝當時人不在輸入框裡（接在最後面）。
   */
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

/**
 * ⭐ **請瀏覽器自己把字打進去，不要我們改資料**（`insertText` 這個編輯指令）。
 * 它等同「使用者自己打了這幾個字」，於是白送兩件我們自己做會很難做對的事：
 *   ① **⌘Z／Ctrl+Z 收得回來**——這一筆會進到輸入框原生的復原紀錄裡。自己覆寫整個值
 *      的話，瀏覽器不當它是一次編輯，那段歷史等於被清掉，按復原完全沒反應。
 *   ② **畫面停在游標那一行**——捲動交給瀏覽器處理（打字本來就會把游標帶進畫面）。
 *      自己覆寫整個值，游標會被重設到最尾巴、長文案當場捲到最底（實測 1,026px 到底）。
 * 值則由它自己發的 `input` 事件回流到 v-model，所以這條路**不要**再 emit 一次，會插兩份。
 *
 * ⚠️ `execCommand` 名義上已棄用，但這是目前唯一能寫進原生復原紀錄的做法，
 *   Chrome／Safari／Firefox 都還支援；失敗時下面有退路，不會變成「按了沒反應」。
 */
function insertByBrowser(field: HTMLTextAreaElement | HTMLInputElement, token: string, range: CaretRange | null): boolean {
  const before = field.value
  field.focus()
  // 把選取還原成按下按鈕之前的樣子（沒有游標就插在最後面）
  const start = range ? Math.min(range.start, range.end) : before.length
  const end = range ? Math.max(range.start, range.end) : before.length
  if (typeof field.selectionStart !== 'number') return false
  field.setSelectionRange(Math.min(start, before.length), Math.min(end, before.length))

  let ok = false
  try {
    ok = document.execCommand('insertText', false, token)
  }
  catch {
    ok = false
  }
  // ⛔ 不能只信回傳值，要比對「插出來的字跟我們要的一模一樣」。
  //   欄位頂到 `maxlength` 時（文字訊息掛了按鈕就只剩 160 字）瀏覽器會拒絕插入卻回 true，
  //   放著不管就是「按了沒反應」；萬一它改成只插得下半截，`{{displa` 這種殘骸更糟。
  //   對不上就回 false，交給下面的退路整串插進去（維持舊行為：上限由紅字警告與存檔閘門擋）。
  return ok && field.value === insertTokenAtCaret(before, token, range).text
}

async function onCommand(cmd: string | number | object) {
  const token = String(cmd)
  const range = caretRange
  caretRange = null

  const field = resolveField()
  if (field && insertByBrowser(field, token, range)) return

  // 退路：瀏覽器不給插（不支援、或被 maxlength 擋掉）時，照舊由父層改資料。
  // ⚠️ 這條路沒有原生復原，也要自己把游標放回去。
  const caret = field ? insertTokenAtCaret(field.value, token, range).caret : null
  emit('pick', token, range)

  if (!field || caret === null) return
  await nextTick()
  // ⛔ 先擺游標再 focus：反過來的話 focus 會捲到「值被整份換掉後」游標所在的最尾巴。
  if (typeof field.selectionStart === 'number') field.setSelectionRange(caret, caret)
  field.focus()
}
</script>
