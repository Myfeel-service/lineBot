<!--
  共用的「選標籤」欄位（`C-208`）。

  **它解的問題**：標籤全站只有標籤頁建得出來（`/api/tag/create` 以前只有 `tags.vue`
  兩處呼叫），但要「選標籤」的地方有六處。新帳號在模組編輯器按下「啟用貼標」，
  下拉是空的、而且**一個字都沒說**——只能放棄還沒存的表單、去別頁建好再回來重做。
  正式庫佐證這一步真的把人擋掉了：客服預存 10 則 0 則開貼標、71 個模組只有 4 個按鈕貼標。

  所以這顆元件一次給三件事：
  1. 打得出字的下拉（39 顆標籤用捲的找太慢）
  2. 「＋ 新標籤」小視窗，建完**當場選起來**，不用離開這張表單
  3. 一顆標籤都沒有時，講一句人話並給出口——⛔ 不是留一個空下拉

  ⚠️ **`allow-create=false` 的情境是真的存在的**：推播的「發送對象」也是選標籤，
     但那裡是**拿標籤篩人**不是貼標籤，就地建一顆新的等於挑到 0 個人、發給沒有人。
     那一格只給出口與說明，不給建立鈕。

  ⚠️ **英文代號仍然秀在小視窗裡**：要不要改成自動生成不顯示是 `D-83`③，還沒拍板。
     這裡只是幫他預填一組合法的值（`shared/tag-code-suggest.ts`），沒有把欄位藏起來。
-->
<template>
  <div class="tag-picker">
    <div v-if="!mergedOptions.length" class="tag-picker__empty">
      <p class="tag-picker__empty-text">{{ emptyText || defaultEmptyText }}</p>
      <div class="tag-picker__empty-actions">
        <el-button
          v-if="showCreateButton"
          size="small"
          type="primary"
          plain
          :disabled="disabled"
          @click="openCreate"
        >
          ＋ 新標籤
        </el-button>
        <NuxtLink v-if="tagsPagePath" :to="tagsPagePath" class="ar-link">
          去標籤管理
        </NuxtLink>
      </div>
    </div>

    <template v-else>
      <el-select
        :model-value="modelValue"
        multiple
        filterable
        collapse-tags
        collapse-tags-tooltip
        :placeholder="placeholder"
        :size="size"
        :disabled="disabled"
        class="admin-w-full control-full"
        @update:model-value="onSelectChange"
      >
        <el-option
          v-for="tag in mergedOptions"
          :key="tag.id"
          :value="tag.id"
          :label="tag.name"
        >
          <AdminTagOptionRow :label="tag.name" :color="tag.color" />
        </el-option>
      </el-select>
      <div v-if="showCreateButton" class="tag-picker__actions">
        <el-button size="small" text :disabled="disabled" @click="openCreate">
          ＋ 新標籤
        </el-button>
      </div>
    </template>

    <el-dialog
      v-model="createOpen"
      title="新增標籤"
      width="420px"
      append-to-body
      :close-on-click-modal="false"
    >
      <div class="tag-picker__form">
        <div class="admin-field-group">
          <AdminFieldLabel text="顯示名稱（最多 30 字）" tight />
          <el-input
            v-model="draft.name"
            maxlength="30"
            placeholder="例如 問過出貨進度"
            @update:model-value="onNameInput"
          />
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="分類" tight />
          <el-select v-model="draft.category" class="admin-w-full">
            <el-option
              v-for="option in TAG_CATEGORY_OPTIONS"
              :key="option.value"
              :value="option.value"
              :label="option.label"
            />
          </el-select>
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="英文代號（系統辨識用，建立後就不能改）" tight />
          <el-input v-model="draft.code" placeholder="例如 asked_shipping" @input="codeTouched = true" />
          <p class="tag-picker__hint">
            已照名稱幫你填一組，客人看不到，要改就現在改。只能用英文小寫、數字、底線，開頭要是英文字母。
          </p>
        </div>

        <p class="tag-picker__hint tag-picker__hint--muted">
          顏色、要不要讓 AI 自己判斷這顆標籤，之後都可以到「標籤管理」慢慢設。
        </p>

        <p v-if="createError" class="tag-picker__error">{{ createError }}</p>
      </div>

      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">建立並選用</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { TAG_CATEGORY_OPTIONS } from '~~/shared/tag-admin'
import { suggestTagCode, isValidTagCode } from '~~/shared/tag-code-suggest'

/** `code` 只有猜下一組代號時會用到（`/api/tag/list` 本來就會回），呼叫端沒帶也不會壞 */
type TagOption = { id: string; name: string; color?: string; code?: string }

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: TagOption[]
  disabled?: boolean
  size?: 'default' | 'small'
  placeholder?: string
  /** 貼標情境給 true（預設）；「拿標籤篩人」的情境（推播受眾）要給 false */
  allowCreate?: boolean
  /** 一顆標籤都沒有時要講的話；不給就用預設 */
  emptyText?: string
}>(), {
  disabled: false,
  size: 'default',
  placeholder: '選擇要貼的標籤（可打字搜尋）',
  allowCreate: true,
  emptyText: '',
})

const emit = defineEmits<{
  'update:modelValue': [string[]]
  /** 建好一顆（已經自動選起來了）。頁面想順手做別的事才需要聽，不聽也不會壞 */
  'created': [TagOption]
}>()

const { apiFetch, workspaceId, canOperate } = useWorkspace()
const { showToast } = useAdminToast()
const { bumpAdminTagList } = useAdminTagRefresh()

/**
 * 這顆元件自己建出來的標籤。
 *
 * ⛔ **不能只靠頁面重新載入清單**：`options` 是 prop，重載是非同步的，
 *    中間那幾百毫秒下拉裡沒有這顆 id，`el-select` 會把它**原封不動印出 UUID**。
 *    先併進來，畫面才不會閃一段亂碼給人看。
 */
const locallyCreated = ref<TagOption[]>([])

const mergedOptions = computed<TagOption[]>(() => {
  const seen = new Set(props.options.map((tag) => tag.id))
  return [...props.options, ...locallyCreated.value.filter((tag) => !seen.has(tag.id))]
})

const showCreateButton = computed(() => props.allowCreate && canOperate.value)

const tagsPagePath = computed(() =>
  workspaceId.value ? `/admin/${workspaceId.value}/tags` : '',
)

const defaultEmptyText = computed(() =>
  showCreateButton.value
    ? '還沒有任何標籤。標籤是之後挑推播名單、篩好友的依據——現在就可以建一顆，不用離開這一頁。'
    : '還沒有任何標籤。要先建標籤、而且標籤要貼在客人身上，這裡才挑得到人。',
)

function onSelectChange(value: unknown) {
  emit('update:modelValue', Array.isArray(value) ? value.map((id) => String(id)) : [])
}

const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const codeTouched = ref(false)
const draft = reactive({ name: '', category: 'custom' as string, code: '' })

function openCreate() {
  draft.name = ''
  draft.category = 'custom'
  draft.code = ''
  codeTouched.value = false
  createError.value = ''
  createOpen.value = true
}

/** 這個工作區已經用掉的代號（拿來去重，避免預填一組一定會撞 409 的值） */
const usedCodes = computed(() =>
  mergedOptions.value.map((tag) => tag.code ?? '').filter(Boolean),
)

/** 名稱還在打的時候一路跟著猜代號；⛔ 人一旦自己動過代號就不要再蓋掉他 */
function onNameInput(value: string) {
  if (codeTouched.value) return
  draft.code = value.trim() ? suggestTagCode(value, usedCodes.value) : ''
}

async function submitCreate() {
  const name = draft.name.trim()
  const code = draft.code.trim()

  if (!name) {
    createError.value = '請先填顯示名稱。'
    return
  }
  if (!isValidTagCode(code)) {
    createError.value = '英文代號只能用英文小寫、數字、底線，而且開頭要是英文字母。'
    return
  }

  creating.value = true
  createError.value = ''
  try {
    const created = await apiFetch<TagOption & { code: string }>('/api/tag/create', {
      method: 'POST',
      body: { code, name, category: draft.category, status: 'active' },
    })
    const option: TagOption = {
      id: created.id,
      name: created.name,
      color: created.color,
      code: created.code,
    }
    locallyCreated.value = [...locallyCreated.value, option]
    // ⛔ 舊資料的 addTagIds 可能根本不存在（貼標節點是後來才加的欄位）。
    //    型別上它是必填，但那只擋得住新寫的程式；這裡展開 undefined 會直接炸在使用者臉上，
    //    而且是「他剛按下建立」的那一刻——標籤建好了、畫面卻爆掉，最難查。
    emit('update:modelValue', [...(Array.isArray(props.modelValue) ? props.modelValue : []), option.id])
    emit('created', option)
    bumpAdminTagList()
    showToast(`已建立「${option.name}」並選起來了`, 'success')
    createOpen.value = false
  }
  catch (e: any) {
    // ⛔ 後端 409 那句是英文的（Tag code "x" already exists…），不可以直接噴給店家看
    if (e?.status === 409 || e?.statusCode === 409 || e?.response?.status === 409) {
      createError.value = `英文代號「${code}」已經有人用了，換一個（例如在後面加數字）。`
    }
    else {
      createError.value = e?.data?.statusMessage || '建立失敗，請再試一次。'
    }
  }
  finally {
    creating.value = false
  }
}
</script>
