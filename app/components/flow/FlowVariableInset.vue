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
          <!-- `C-428`：有試算表可挑的時候分兩組，不然「試算表」會掛在「客人資料」底下（名不符實，`D-166`） -->
          <li v-if="sheetPicker" class="flow-var-inset__group" role="presentation">客人資料</li>
          <el-dropdown-item
            v-for="opt in options"
            :key="opt.value"
            :command="opt.token"
          >
            <span class="flow-var-inset__item">
              <span class="flow-var-inset__item-label">{{ opt.label }}</span>
              <span v-if="opt.hint" class="flow-var-inset__item-hint">{{ opt.hint }}</span>
            </span>
          </el-dropdown-item>
          <!-- `C-423`：只有模組頁有（那邊送出端才會換這種標記） -->
          <template v-if="sheetPicker">
            <li class="flow-var-inset__group flow-var-inset__group--divided" role="presentation">試算表</li>
            <el-dropdown-item :command="SHEET_COMMAND" data-tour="var-sheet-field">
              <span class="flow-var-inset__item">
                <span class="flow-var-inset__item-label">商品資料</span>
                <!-- `C-448`：⛔ 例子不寫任何一家店的商品名（每個店家都看得到） -->
                <span class="flow-var-inset__item-hint">例：商品的出貨時間。改試算表，這裡跟 AI 一起變</span>
              </span>
            </el-dropdown-item>
          </template>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <!--
      `C-423`：挑「哪一份試算表 → 哪個商品 → 哪一項」，下面直接秀現在寫的內容（挑對了沒一眼看得出來）。
      插進去的是一顆藍色膠囊「出貨時間・商品名」；送出時換成那張知識卡上當下寫的。
      `C-428`：用店家的話（商品／哪一項），⛔ 不用試算表的「列／欄」。
    -->
    <el-dialog
      v-if="sheetPicker && sheetOpen"
      v-model="sheetOpen"
      title="帶出試算表的資料"
      width="min(520px, 92vw)"
      append-to-body
      class="flow-sheet-dialog"
    >
      <div v-if="sheetPicker.loading.value && !sheetPicker.sources.value" class="tags-loading">
        <div class="spinner" />
        <span>讀試算表中…</span>
      </div>
      <p v-else-if="sheetPicker.error.value" class="flow-sheet-dialog__error">{{ sheetPicker.error.value }}</p>
      <p v-else-if="!sheetSources.length" class="flow-sheet-dialog__empty">
        這個帳號還沒有接 Google 試算表。到「AI 知識庫 → 加入知識 → Google 試算表」接一份（一列一個商品、第一列寫欄名），這裡就挑得到。
      </p>
      <div v-else class="admin-field-stack">
        <div class="admin-field-group">
          <AdminFieldLabel text="試算表" tight />
          <el-select v-model="sheetSourceId" class="control-full" @change="onSheetSourceChange">
            <el-option v-for="s in sheetSources" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </div>
        <p v-if="pickedSource && !pickedSource.headers" class="flow-sheet-dialog__empty">
          這份試算表要再同步一次才挑得到欄位：到「AI 知識庫」打開這份資料按「立即同步」，或等一小時內自動同步。
        </p>
        <template v-else-if="pickedSource">
          <div class="admin-field-group">
            <!-- `C-448`：「這個商品」是新做法，旁邊給教學（設好之後客人會看到什麼＋一步一張圖） -->
            <div class="afh-row">
              <AdminFieldLabel text="商品" tight />
              <AdminFieldHelp id="productTemplate" />
            </div>
            <!--
              `C-437`：第一個選項「這個商品」＝商品資訊範本的寫法——一份回覆給所有商品，
              客人在商品目錄點了哪個商品就填哪個的。其他是寫死某一個商品（`C-423`）。
            -->
            <el-select v-model="sheetRow" filterable class="control-full" placeholder="打字找商品" @change="onSheetRowChange">
              <el-option :value="SHEET_CURRENT_ROW" :label="CURRENT_ROW_OPTION" />
              <el-option v-for="r in pickedSource.rows" :key="r.title" :label="r.title" :value="r.title" />
            </el-select>
          </div>
          <div class="admin-field-group">
            <AdminFieldLabel text="哪一項" tight />
            <el-select v-model="sheetField" class="control-full">
              <el-option v-if="isCurrentRow" :value="SHEET_FIELD_NAME" label="商品名" />
              <el-option v-for="h in pickedSource.headers" :key="h" :label="h" :value="h" />
            </el-select>
          </div>
          <p v-if="isCurrentRow && sheetField" class="flow-sheet-dialog__hint">
            送出時填客人在商品目錄點的那個商品。那個商品的「{{ sheetField === SHEET_FIELD_NAME ? '商品名' : sheetField }}」空白的話，這一行整行不顯示。
          </p>
          <div v-else-if="sheetRow && sheetField" class="admin-field-group">
            <AdminFieldLabel text="現在寫的是" tight />
            <p v-if="pickedValue" class="flow-sheet-dialog__value">{{ pickedValue }}</p>
            <p v-else class="flow-sheet-dialog__empty">這個商品的「{{ sheetField }}」是空的——插進去的話客人會看到空白，先到試算表填好。</p>
          </div>
        </template>
        <!--
          `C-428`：店家要的通常是「把手打的那段換成跟試算表同步」，不是再插一段（`D-166`：舊的「10 月底」還留在框裡）。
          選取那段再按插入就會直接換掉——有選取的時候直接講會換掉幾個字，沒有的時候教他怎麼做。
        -->
        <p v-if="replacingChars > 0" class="flow-sheet-dialog__hint">會換掉你在輸入框選取的那段字（{{ replacingChars }} 字）。</p>
        <p v-else class="flow-sheet-dialog__hint">要換掉原本手打的字：先在輸入框選取那一段，再按「＋ 插入」，插入時會直接換掉。</p>
      </div>
      <template #footer>
        <el-button @click="sheetOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!sheetRow || !sheetField || !pickedSource?.headers" @click="insertSheetField">插入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref } from 'vue'
import type { CaretRange } from '~/utils/insert-token-at-caret'
import { insertTokenAtCaret } from '~/utils/insert-token-at-caret'
import { FLOW_SHEET_PICKER_KEY, SHEET_LABELS_KEY } from '~/utils/flow-sheet-picker'
import { SHEET_CURRENT_ROW, SHEET_FIELD_NAME, sheetFieldLabel, sheetFieldToken } from '~~/shared/sheet-field'
import { VAR_TOKEN_EDGE } from '~~/shared/variable-tokens'

/**
 * token＝插進輸入框的字。`D-128` 起是膠囊的顯示用字（`displayTokenFor`），輸入框要是 `VariableTextField`；
 * label＝選單上的名稱（「LINE 名稱」），hint＝底下一行小字講它是什麼。
 */
export type VariableInsetOption = { value: string; label: string; token: string; hint?: string }

const props = withDefaults(
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

/**
 * `D-128`（2026-10-17 老闆「看起來很像程式碼」）：按鈕以前寫「{{...}}」——工程符號，店家看不出按了會怎樣。
 * 改講會做什麼；單行的小輸入框（卡片標題）位置窄，用短的。
 */
const glyph = computed(() => {
  // `C-428`：模組頁還能插試算表的資料，「插入客人資料」就名不符實了（`D-166`）
  if (sheetPicker) return '＋ 插入'
  return props.size === 'sm' ? '＋ 客人資料' : '＋ 插入客人資料'
})
const ariaLabel = computed(() => (sheetPicker ? '插入客人資料或試算表的資料' : '插入客人資料'))
const hint = computed(() => (sheetPicker
  ? '插入客人的資料（例：LINE 名稱），或試算表上的一格（例：出貨時間）'
  : '插入客人的資料（例：LINE 名稱），送出時換成每位客人自己的'))

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
  //   欄位頂到 `maxlength` 時（文字訊息 5000 字；`C-397` 以前掛按鈕只剩 160）瀏覽器會拒絕插入卻回 true，
  //   放著不管就是「按了沒反應」；萬一它改成只插得下半截，`{{displa` 這種殘骸更糟。
  //   對不上就回 false，交給下面的退路整串插進去（維持舊行為：上限由紅字警告與存檔閘門擋）。
  return ok && field.value === insertTokenAtCaret(before, token, range).text
}

// ── `C-423`：試算表的一格 ──────────────────────────────────
const SHEET_COMMAND = '__sheet_field__'
const sheetPicker = inject(FLOW_SHEET_PICKER_KEY, null)
const sheetOpen = ref(false)
const sheetSourceId = ref('')
const sheetRow = ref('')
const sheetField = ref('')
/** 打開小視窗那一刻的游標（選完回來插在原位；有選取一段字＝插入時換掉那一段） */
let sheetCaret: CaretRange | null = null
const replacingChars = ref(0)
const sheetLabelsRef = inject(SHEET_LABELS_KEY, null)
const sheetSources = computed(() => sheetPicker?.sources.value ?? [])
const pickedSource = computed(() => sheetSources.value.find(s => s.id === sheetSourceId.value) ?? null)
const pickedValue = computed(() => pickedSource.value?.rows.find(r => r.title === sheetRow.value)?.values[sheetField.value] ?? '')

function onSheetSourceChange() {
  sheetRow.value = ''
  sheetField.value = pickedSource.value?.headers?.[0] ?? ''
}

// `C-437`：「這個商品」多一項「商品名」（第一欄，不在欄名清單裡）；換回某個商品時這一項就不在了
const CURRENT_ROW_OPTION = '這個商品（客人在商品目錄點的那一個）'
const isCurrentRow = computed(() => sheetRow.value === SHEET_CURRENT_ROW)
function onSheetRowChange() {
  if (!isCurrentRow.value && sheetField.value === SHEET_FIELD_NAME) sheetField.value = pickedSource.value?.headers?.[0] ?? ''
}

async function openSheetPicker(range: CaretRange | null) {
  sheetCaret = range
  replacingChars.value = range ? Math.abs(range.end - range.start) : 0
  sheetOpen.value = true
  // 每次打開都重讀一次（剛改完試算表、按了同步，要看得到新的）
  await sheetPicker?.reload(true)
  if (!pickedSource.value) {
    // 預設挑第一份「知道有哪幾欄」的
    sheetSourceId.value = (sheetSources.value.find(s => s.headers) ?? sheetSources.value[0])?.id ?? ''
    onSheetSourceChange()
  }
}

function insertSheetField() {
  if (!sheetRow.value || !sheetField.value) return
  const picked = { row: sheetRow.value, field: sheetField.value }
  // 跟輸入框畫的同一個名字（短名查對照，查不到用全名）——輸入框才換得回存的格式
  const label = sheetLabelsRef?.value?.labelFor(sheetFieldToken(picked)) ?? sheetFieldLabel(picked)
  const token = `${VAR_TOKEN_EDGE}${label}${VAR_TOKEN_EDGE}`
  sheetOpen.value = false
  caretRange = sheetCaret
  void onCommand(token)
}

async function onCommand(cmd: string | number | object) {
  if (cmd === SHEET_COMMAND) {
    const range = caretRange
    caretRange = null
    void openSheetPicker(range)
    return
  }
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
