<script setup lang="ts">
/**
 * 「所屬產品」欄位：先從已經在用的產品名裡挑，沒有的才自己打。
 *
 * 為什麼不是純文字框（原本的做法）：同一台機器三月打「GPLUS 智慧除濕機 12L」、六月打
 * 「GPLUS除濕機12公升」，AI 就當成兩台不同機器——客人問保固會被反問「您指的是哪一台」，
 * 選項還是同一台的兩種寫法。「產品名稱整理」只能事後把它們併回去；這裡是事前不讓它分岔。
 *
 * ⚠️ 為什麼不用 `el-select` + `allow-create`：那個組合要打完**按 Enter 或點下拉裡新增的那一項**
 * 才算數，直接按儲存的話打的字會被安靜丟掉（欄位留在舊值）——填了東西卻沒存到是最糟的失敗。
 * 這裡用可提示的輸入框：打什麼就是什麼，點一下（或打字）才多給一份現成清單可挑。
 */
const props = withDefaults(defineProps<{
  modelValue: string
  disabled?: boolean
  size?: 'small' | 'default' | 'large'
  placeholder?: string
  /** 下方那行「有幾個現成的可挑」說明；欄位周圍已經有夠多說明時可關掉 */
  showHint?: boolean
}>(), {
  disabled: false,
  size: 'default',
  placeholder: '例：GPLUS 智慧除濕機 12L（留空 = 不是單一產品的資料）',
  showHint: true,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { names, known, status, load } = useProductNames()
onMounted(() => { void load() })

const text = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', String(v ?? '')),
})

/** 空字串 = 剛點進來還沒打字 → 列出全部（「看得到有哪些」正是這個欄位要解決的事） */
function querySuggestions(query: string, cb: (items: Array<{ value: string }>) => void) {
  const kw = query.trim().toLowerCase()
  const list = kw ? names.value.filter(n => n.toLowerCase().includes(kw)) : names.value
  cb(list.map(n => ({ value: n })))
}

/**
 * 打字當下的相似提示：打錯字（GPLSU vs GPLUS）在進庫**之前**就攔下來。
 * 進了庫才靠「產品名稱整理」抓的話，錯字卡已經上線，客人指名問會被反問二選一。
 * 判定與後端偵測共用 shared/product-name-similarity（同一把尺，兩個畫面不能兩種說法）。
 */
import { findSimilarProductName, normalizeProductName } from '~~/shared/product-name-similarity'

const trimmed = computed(() => props.modelValue.trim())
/** 按過「不是，這是新產品」的組合（輸入值×現成名），這次開著就不再問；改字會重新判斷 */
const dismissed = ref<Set<string>>(new Set())
function pairKey(a: string, b: string): string {
  return [normalizeProductName(a), normalizeProductName(b)].sort().join('||')
}

/** 原樣完全等於某個現成名 = 就是在用現成的，什麼都不用講 */
const isExisting = computed(() => names.value.includes(trimmed.value))

const similar = computed(() => {
  // 清單讀失敗時不做任何「這是新的」判斷——「查不到就等於沒有」是踩過的假綠燈
  if (status.value !== 'ready' || !trimmed.value || isExisting.value) return null
  const v = findSimilarProductName(trimmed.value, names.value)
  if (!v || dismissed.value.has(pairKey(trimmed.value, v.match))) return null
  return v
})

/**
 * 清單裡沒有、也不像任何現成名 → 老實講「這會新增一個產品」（打錯字的人在這行就會愣住）。
 * 比對用 known（含已合併掉的舊叫法）而不是收斂後的 names：舊叫法答題端本來就會歸一到正式名，
 * 對它喊「會新增產品」是假話。
 */
const isNewName = computed(() =>
  status.value === 'ready' && !!trimmed.value && !isExisting.value
  && !known.value.some(n => normalizeProductName(n) === normalizeProductName(trimmed.value))
  && !similar.value)

function useSuggested() {
  if (similar.value) text.value = similar.value.match
}

function keepMine() {
  if (!similar.value) return
  const next = new Set(dismissed.value)
  next.add(pairKey(trimmed.value, similar.value.match))
  dismissed.value = next
}
</script>

<template>
  <div class="product-name-field">
    <el-autocomplete
      v-model="text"
      :fetch-suggestions="querySuggestions"
      :disabled="disabled"
      :size="size"
      :placeholder="placeholder"
      :maxlength="60"
      :trigger-on-focus="true"
      clearable
      class="product-name-field__input"
      popper-class="product-name-field__popper"
    />

    <!-- 打字當下的攔截:跟現成名幾乎一樣 → 問「是同一台嗎」;全新名字 → 老實講會新增產品。
         這兩塊不吃 showHint(匯入預覽把 showHint 關了,但這裡正是它最需要出現的地方) -->
    <div v-if="similar" class="product-name-field__ask">
      <p class="product-name-field__ask-text">
        <template v-if="similar.kind === 'spelling'">
          跟現有的「<strong>{{ similar.match }}</strong>」只差空白或符號——AI 會當同一台，建議直接用現成的寫法。
        </template>
        <template v-else>
          跟現有的「<strong>{{ similar.match }}</strong>」只差 {{ similar.distance }} 個字——是同一台嗎？（打錯字很常見）
        </template>
      </p>
      <div class="product-name-field__ask-actions">
        <el-button size="small" type="primary" plain :disabled="disabled" @click="useSuggested">
          {{ similar.kind === 'spelling' ? '改用現成寫法' : `是，改用「${similar.match}」` }}
        </el-button>
        <el-button size="small" text :disabled="disabled" @click="keepMine">
          {{ similar.kind === 'spelling' ? '保留我打的' : '不是，這是新產品' }}
        </el-button>
      </div>
    </div>
    <p v-else-if="isNewName" class="product-name-field__new">
      清單裡沒有這個名字，存檔後會<strong>新增一個產品</strong>「{{ trimmed }}」。
    </p>

    <!-- 三態:有清單／真的還沒有／根本沒讀到。第三種不能講成第二種——
         「之後就會出現在下拉裡」在讀取失敗時是假的 -->
    <p v-if="showHint" class="product-name-field__hint">
      <template v-if="names.length">
        點一下欄位會列出你已經在用的 {{ names.length }} 個產品，<strong>同一台請選現成的</strong>（自己重打一次容易變成兩台）；新產品直接打。
      </template>
      <template v-else-if="status === 'failed'">
        （現有產品清單這次讀不到，直接打產品名就好，一樣會存起來。）
      </template>
      <template v-else>
        直接打產品名，含品牌與型號（例：GPLUS 智慧除濕機 12L）。之後再填就會出現在下拉裡可以直接選。
      </template>
    </p>
  </div>
</template>
