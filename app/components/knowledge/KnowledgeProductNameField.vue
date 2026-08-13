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

const { names, status, load } = useProductNames()
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
