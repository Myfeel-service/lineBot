<template>
  <div ref="rootEl" class="var-field">
    <!--
      底下就是原本的 el-input：存的是 `{{displayName}}`（v-model 照舊綁資料），
      Element Plus 的 formatter／parser 負責「畫面上顯示成膠囊用的字 ↔ 存的格式」來回換，游標位置它自己會補回來。
      其他屬性（rows、maxlength、placeholder、show-word-limit…）原樣傳給 el-input。
    -->
    <el-input
      v-bind="$attrs"
      :model-value="modelValue"
      :type="type"
      :formatter="format"
      :parser="parse"
      @update:model-value="onUpdate"
    />
    <!-- 膠囊那一層：疊在輸入框上面、滑鼠穿過去（點的還是輸入框），字是透明的，只畫膠囊的底色 -->
    <div v-show="layerVisible" ref="layerEl" class="var-field__layer" aria-hidden="true">
      <div ref="layerInnerEl" class="var-field__layer-inner"><template v-for="(seg, i) in segments" :key="i"><span v-if="seg.token" class="var-field__pill">{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template>{{ '​' }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 可以放「客人資料」變數的輸入框（`D-128`）：`{{displayName}}` 顯示成一顆膠囊「LINE 名稱」。
 *
 * ── 為什麼不是真的小方塊（contenteditable）─────────────────────
 * 底下保留原生 textarea／input：中文輸入法組字、字數、複製貼上、復原都照瀏覽器原本的；
 * 膠囊是另外一層照同樣的字型、內距排出來、只畫底色。代價是那一層要跟輸入框對齊（`syncLayer`）。
 *
 * ── 膠囊要像一個字 ──────────────────────────────────────────
 *  · 退格／Delete 在膠囊邊上＝整顆刪掉（不會刪成「LINE 名」半顆）
 *  · 左右鍵一次跳過整顆；點進膠囊中間，游標移到膠囊後面；選一段字邊緣卡在膠囊裡就擴到整顆
 * 規則（哪些字算膠囊、怎麼換）在 `shared/variable-tokens`（有測試）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  toDisplayText,
  toStoredText,
  variableTokenRanges,
  type VariableKeyMode,
} from '~~/shared/variable-tokens'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string | undefined | null
  type?: 'text' | 'textarea'
  /** send＝模組／推播／客服預存（只認英文變數名）；script＝自動回應（收集欄位可以是中文） */
  mode?: VariableKeyMode
  /** 這一頁「自己打括號也算變數」的欄位名（例如收集得到的 phone）。LINE 名稱永遠算 */
  knownKeys?: readonly string[]
}>(), { type: 'text', mode: 'send', knownKeys: () => [] })

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const onUpdate = (v: string) => emit('update:modelValue', v)
const format = (v: string) => toDisplayText(v, props.mode)
const parse = (v: string) => toStoredText(v, props.mode, props.knownKeys)

const rootEl = ref<HTMLElement | null>(null)
const layerEl = ref<HTMLElement | null>(null)
const layerInnerEl = ref<HTMLElement | null>(null)
const composing = ref(false)

const display = computed(() => format(String(props.modelValue ?? '')))
const ranges = computed(() => variableTokenRanges(display.value, props.mode))
const segments = computed(() => {
  const out: Array<{ text: string; token: boolean }> = []
  let at = 0
  for (const r of ranges.value) {
    if (r.start > at) out.push({ text: display.value.slice(at, r.start), token: false })
    out.push({ text: display.value.slice(r.start, r.end), token: true })
    at = r.end
  }
  if (at < display.value.length) out.push({ text: display.value.slice(at), token: false })
  return out
})
/** 組字中（中文輸入法還沒選字）輸入框裡多了還沒進資料的字，那一層會對不齊：先收起來 */
const layerVisible = computed(() => ranges.value.length > 0 && !composing.value)

let field: HTMLTextAreaElement | HTMLInputElement | null = null
let observer: ResizeObserver | null = null
let raf = 0

/** 那一層照輸入框的字型、內距、框線、大小擺好，捲動位置跟著輸入框 */
const COPY_STYLES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight', 'letterSpacing', 'wordSpacing',
  'textIndent', 'textTransform', 'textAlign', 'direction', 'tabSize', 'boxSizing',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'wordBreak', 'overflowWrap',
] as const

function syncLayer() {
  raf = 0
  const root = rootEl.value
  const layer = layerEl.value
  const inner = layerInnerEl.value
  if (!root || !layer || !inner || !field) return
  const cs = getComputedStyle(field)
  for (const p of COPY_STYLES) (layer.style as unknown as Record<string, string>)[p] = cs[p] as string
  layer.style.borderStyle = 'solid'
  layer.style.borderColor = 'transparent'
  const isArea = field.tagName === 'TEXTAREA'
  layer.style.whiteSpace = isArea ? 'pre-wrap' : 'pre'
  const fr = field.getBoundingClientRect()
  const rr = root.getBoundingClientRect()
  const bl = parseFloat(cs.borderLeftWidth) || 0
  const br = parseFloat(cs.borderRightWidth) || 0
  const bt = parseFloat(cs.borderTopWidth) || 0
  const bb = parseFloat(cs.borderBottomWidth) || 0
  layer.style.left = `${fr.left - rr.left}px`
  layer.style.top = `${fr.top - rr.top}px`
  // clientWidth 不含捲軸：多行字有捲軸時，排字的寬度要跟輸入框一樣窄，換行才會在同一個地方
  layer.style.width = `${field.clientWidth + bl + br}px`
  layer.style.height = `${field.clientHeight + bt + bb}px`
  // 單行輸入框的字是垂直置中的（不是靠行高）：行高設成整個內框高，字就落在同一條線上
  if (!isArea) layer.style.lineHeight = `${field.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)}px`
  inner.style.transform = `translate(${-field.scrollLeft}px, ${-field.scrollTop}px)`
}
function scheduleSync() {
  if (!raf) raf = requestAnimationFrame(syncLayer)
}

/** 游標／選取範圍卡在膠囊中間 → 移到膠囊邊上（點進中間＝跳到後面；選取的兩端擴到整顆） */
function snapSelection(prefer: 'start' | 'end' = 'end') {
  if (!field || composing.value) return
  const rs = variableTokenRanges(field.value, props.mode)
  if (!rs.length) return
  const s = field.selectionStart ?? 0
  const e = field.selectionEnd ?? 0
  let ns = s
  let ne = e
  for (const r of rs) {
    if (ns > r.start && ns < r.end) ns = s === e ? (prefer === 'start' ? r.start : r.end) : r.start
    if (ne > r.start && ne < r.end) ne = r.end
  }
  if (s === e) ne = ns
  if (ns !== s || ne !== e) field.setSelectionRange(ns, ne)
}

/** 把輸入框裡 [start, end) 那一段刪掉：走瀏覽器自己的刪除（復原得回來、el-input 照常收到 input） */
function deleteRange(start: number, end: number) {
  if (!field) return
  field.setSelectionRange(start, end)
  // execCommand 雖然列為舊 API，但它是唯一能讓瀏覽器把這一刪記進「復原」的方法（插入鈕也是這樣插的）
  const ok = typeof document.execCommand === 'function' && document.execCommand('delete')
  if (!ok) {
    field.value = field.value.slice(0, start) + field.value.slice(end)
    field.setSelectionRange(start, start)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function onKeydown(ev: Event) {
  const e = ev as KeyboardEvent
  if (!field || e.isComposing || composing.value || e.altKey || e.ctrlKey || e.metaKey) return
  const rs = variableTokenRanges(field.value, props.mode)
  if (!rs.length) return
  const s = field.selectionStart ?? 0
  const end = field.selectionEnd ?? 0
  if (s !== end) return
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const r = e.key === 'Backspace'
      ? rs.find(r => s > r.start && s <= r.end)
      : rs.find(r => s >= r.start && s < r.end)
    if (!r) return
    e.preventDefault()
    deleteRange(r.start, r.end)
    return
  }
  if (e.key === 'ArrowLeft' && !e.shiftKey) {
    const r = rs.find(r => s > r.start && s <= r.end)
    if (r) {
      e.preventDefault()
      field.setSelectionRange(r.start, r.start)
    }
    return
  }
  if (e.key === 'ArrowRight' && !e.shiftKey) {
    const r = rs.find(r => s >= r.start && s < r.end)
    if (r) {
      e.preventDefault()
      field.setSelectionRange(r.end, r.end)
    }
  }
}

const onKeyup = (ev: Event) => {
  const k = (ev as KeyboardEvent).key
  if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'Home' || k === 'PageUp') snapSelection('start')
  else snapSelection('end')
}
const onPointerUp = () => snapSelection('end')
const onCompositionStart = () => { composing.value = true }
const onCompositionEnd = () => {
  composing.value = false
  scheduleSync()
}

onMounted(() => {
  field = rootEl.value?.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input') ?? null
  if (!field) return
  field.addEventListener('keydown', onKeydown)
  field.addEventListener('keyup', onKeyup)
  field.addEventListener('mouseup', onPointerUp)
  field.addEventListener('scroll', scheduleSync)
  field.addEventListener('input', scheduleSync)
  field.addEventListener('compositionstart', onCompositionStart)
  field.addEventListener('compositionend', onCompositionEnd)
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(scheduleSync)
    observer.observe(field)
  }
  window.addEventListener('resize', scheduleSync)
  scheduleSync()
})

onBeforeUnmount(() => {
  if (field) {
    field.removeEventListener('keydown', onKeydown)
    field.removeEventListener('keyup', onKeyup)
    field.removeEventListener('mouseup', onPointerUp)
    field.removeEventListener('scroll', scheduleSync)
    field.removeEventListener('input', scheduleSync)
    field.removeEventListener('compositionstart', onCompositionStart)
    field.removeEventListener('compositionend', onCompositionEnd)
  }
  observer?.disconnect()
  window.removeEventListener('resize', scheduleSync)
  if (raf) cancelAnimationFrame(raf)
})

// 內容一變（插入、刪除、別處改了資料）就重新對齊：膠囊多一顆，自動長高的輸入框高度也會跟著變
watch(display, () => nextTick(scheduleSync))
</script>
