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

        <!--
          `D-83`③ 2026-09-21 老闆拍板：**就地建標籤時不要出現英文代號那一格**，由系統自己生。
          ⛔ 規則本身沒有變（後端仍然只收 `^[a-z][a-z0-9_]*$`、建立後仍然不能改），
             變的是不再要求他想一個自己永遠不會再看到的英文字串——那是這個流程最卡的一格。
          ⛔ 因為他改不到了，撞號就**不可以**丟一句「請換一個」給他看：`submitCreate` 會自動換下一組再試。
          ⚠️ 標籤管理那一頁的完整表單**維持原樣**（在那裡建標籤是刻意的動作，看得到代號是對的）。
        -->
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
  const merged = [...props.options, ...locallyCreated.value.filter((tag) => !seen.has(tag.id))]

  /**
   * C-209：**已經選起來、但不在清單裡的標籤也要給它一個名字**。
   *
   * 所有頁面都只載入「啟用中」的標籤，所以一顆標籤被停用（或被刪）之後，
   * 存在設定裡的那個 id 就對不到任何選項——`el-select` 會把 **UUID 原封印在畫面上**，
   * 看起來像資料壞掉，而且完全看不出那原本是什麼。
   * ⛔ 不可以默默把它從選取中拿掉：那會在使用者**沒有按儲存**的情況下改掉他的設定。
   */
  const known = new Set(merged.map((tag) => tag.id))
  const orphans = (Array.isArray(props.modelValue) ? props.modelValue : [])
    .filter((id) => id && !known.has(id))
    .map((id) => ({ id, name: '（已停用或已刪除的標籤）', color: '#9CA3AF' }))

  return [...merged, ...orphans]
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
const draft = reactive({ name: '', category: 'custom' as string })

function openCreate() {
  draft.name = ''
  draft.category = 'custom'
  createError.value = ''
  createOpen.value = true
}

/** 這個工作區已經用掉的代號（拿來去重，避免生出一組一定會撞 409 的值） */
const usedCodes = computed(() =>
  mergedOptions.value.map((tag) => tag.code ?? '').filter(Boolean),
)

const isConflict = (e: any) =>
  e?.status === 409 || e?.statusCode === 409 || e?.response?.status === 409

async function submitCreate() {
  const name = draft.name.trim()
  if (!name) {
    createError.value = '請先填顯示名稱。'
    return
  }

  creating.value = true
  createError.value = ''
  try {
    /**
     * 代號由系統生（`D-83`③ 拍板）。
     *
     * ⛔ **撞號一定要自己換一組重試**：使用者已經看不到這一格，也就改不了它，
     *    丟一句「換一個代號」給他等於叫他做一件畫面上做不到的事。
     *    撞號在這裡是真的會發生的——`usedCodes` 只看得到**這一頁載到的**標籤，
     *    別人同時建了一顆同名的、或清單還沒載完，都會撞。
     * ⚠️ 只重試 3 次：再撞下去就不是巧合，是有別的問題，這時才講給他聽。
     */
    const taken = [...usedCodes.value]
    let created: (TagOption & { code: string }) | null = null
    let lastError: any = null

    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      const code = suggestTagCode(name, taken)
      if (!isValidTagCode(code)) {
        // 走不到才對（`suggestTagCode` 有 13 條測試釘住「任何輸入都合法」），但不假設它永遠對
        lastError = null
        createError.value = '這個名稱產不出合法的代號，請換一個名稱。'
        break
      }
      try {
        created = await apiFetch<TagOption & { code: string }>('/api/tag/create', {
          method: 'POST',
          body: { code, name, category: draft.category, status: 'active' },
        })
      }
      catch (e: any) {
        lastError = e
        if (!isConflict(e)) break
        taken.push(code) // 這組被占走了，下一圈會自動換成 xxx_2、xxx_3…
      }
    }

    if (!created) {
      if (lastError) {
        createError.value = isConflict(lastError)
          // 後端 409 那句是英文的（Tag code "x" already exists…），不可以直接噴給店家看
          ? '這個名稱一直跟現有的標籤撞在一起，請換一個名稱再試。'
          : lastError?.data?.statusMessage || '建立失敗，請再試一次。'
      }
      return
    }

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
  finally {
    creating.value = false
  }
}
</script>
