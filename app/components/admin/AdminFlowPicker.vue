<!--
  共用的「選機器人模組」欄位（`D-86`）。

  **它解的問題**：會選模組的地方有六處（圖文選單按鈕／推播／活動／客服預存／AI 腳本，
  再加模組自己的按鈕指到另一個模組），但那裡以前就是一個**光禿禿的下拉**：
  不能打字搜尋（正式庫 71 個模組，用捲的找不到）、不能建、不能跳過去看，
  而且選到已經被刪掉的模組時會**把一串 uuid 原樣印在畫面上**（跟 `C-209` 修掉的標籤同一族，
  正式庫現在就有一個按鈕是這個狀態）。

  所以這顆元件一次給四件事：
  1. 打得出字的下拉
  2. 「編輯這個模組 ↗」——**開新分頁**（這幾頁都有「還沒存喔」的攔截，
     直接跳走就是把他填到一半的表單丟掉）
  3. 「＋ 新模組」小視窗，建完**當場選起來**，不用離開這張表單
  4. 把三種「選了會出事」的狀況講出來：還沒有內容／已停用／已經被刪掉

  ⛔ **小視窗不是模組編輯器，也不可以變成模組編輯器**：正式庫 71 個模組裡 68 個含圖片、
     輪播或快速回覆，那些東西本來就要在模組頁做。這裡只負責**生出一個立刻就能用的最小模組**
     （名字＋一則回覆文字），要加圖片就按「建立並開啟編輯器」。
  ⛔ **絕對不要做「只有名字的空模組」**：後端 `assertValidFlowMessages` 也擋著（至少一則）。
     空模組＝客人走到這裡什麼都收不到、畫面上還看不出問題，
     那正是空「歡迎模組」害約 667 位加好友的人一句話都沒收到的形狀（`D-23`）。
-->
<template>
  <div class="flow-picker">
    <div v-if="!mergedOptions.length" class="flow-picker__empty">
      <p class="flow-picker__empty-text">{{ emptyText || defaultEmptyText }}</p>
      <div class="flow-picker__empty-actions">
        <el-button
          v-if="showCreateButton"
          size="small"
          type="primary"
          plain
          :disabled="disabled"
          @click="openCreate"
        >
          ＋ 新模組
        </el-button>
        <NuxtLink v-if="flowPagePath" :to="flowPagePath" class="ar-link">
          去機器人模組
        </NuxtLink>
      </div>
    </div>

    <template v-else>
      <el-select
        :model-value="modelValue"
        filterable
        clearable
        :placeholder="placeholder"
        :size="size"
        :disabled="disabled"
        class="admin-w-full control-full"
        @update:model-value="onSelectChange"
      >
        <el-option
          v-for="option in mergedOptions"
          :key="option.id"
          :value="option.id"
          :label="option.name"
        >
          <span class="flow-picker__option">
            <span class="flow-picker__option-name">{{ option.name }}</span>
            <span v-if="option.flag" :class="['flow-picker__flag', `flow-picker__flag--${option.flagTone}`]">
              {{ option.flag }}
            </span>
          </span>
        </el-option>
      </el-select>

      <div v-if="showActions" class="flow-picker__actions">
        <!--
          ⛔ 一定要 `target="_blank"`：這幾頁都掛了「還沒存喔」的離開確認，
             同分頁跳走＝他填到一半的東西要嘛不見、要嘛被一個對話框攔下來。
        -->
        <a
          v-if="editHref"
          class="ar-link flow-picker__edit"
          :href="editHref"
          target="_blank"
          rel="noopener"
        >編輯這個模組 ↗</a>
        <el-button v-if="showCreateButton" size="small" text :disabled="disabled" @click="openCreate">
          ＋ 新模組
        </el-button>
      </div>

      <!-- ⛔ 三種「選了會出事」的狀況要講出來，不可以只是下拉裡一個小字 -->
      <p v-if="selectedWarning" class="flow-picker__warn">{{ selectedWarning }}</p>
      <!--
        `C-238`：**只有推播那一頁**會看到這一句。
        同一個模組，客人從圖文選單按進去會貼標，被推播送出去就不會——
        因為推播是一次把同一份訊息送給一群人，認不出是誰點的。
        ⛔ 開關是開的、標籤就是沒貼、畫面上一個字都沒講，所以一定要在這裡講。
      -->
      <p v-if="broadcastUriTagNote" class="flow-picker__warn">{{ broadcastUriTagNote }}</p>
    </template>

    <el-dialog
      v-model="createOpen"
      title="新增機器人模組"
      width="480px"
      append-to-body
      :close-on-click-modal="false"
    >
      <div class="flow-picker__form">
        <div class="admin-field-group">
          <AdminFieldLabel text="模組名稱（最多 30 字）" tight />
          <el-input v-model="draft.name" maxlength="30" placeholder="例如 出貨進度查詢" />
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel
            text="客人走到這裡時，先回這段話"
            hint="至少要有一句話，模組才算做好了——沒有內容的模組，客人按下去會什麼都收不到。之後可以再加圖片、按鈕。"
            tight
          />
          <el-input
            v-model="draft.text"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            resize="none"
            placeholder="例如：您好，請提供訂單編號，我幫您查詢出貨進度。"
          />
        </div>

        <p v-if="createError" class="flow-picker__error">{{ createError }}</p>
      </div>

      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button :loading="creating" @click="submitCreate(true)">建立並開啟編輯器</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate(false)">建立並選用</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

/**
 * `messageCount` 由 `/api/flow/list?fields=picker` 帶回來（`D-86`）。
 * ⚠️ 呼叫端沒帶也不會壞——但那樣就**標不出「還沒有內容」**，等於少了一半價值。
 */
type ModuleOption = {
  id: string
  name: string
  isActive?: boolean
  messageCount?: number
  /** `C-238`：這個模組裡有幾顆「開了貼標的網址按鈕」（推播送出時那個貼標不會生效） */
  taggedUriButtons?: number
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: ModuleOption[]
  disabled?: boolean
  size?: 'default' | 'small'
  placeholder?: string
  allowCreate?: boolean
  /** 一個模組都沒有時要講的話；不給就用預設 */
  emptyText?: string
  /**
   * `C-238`：這一格長在哪裡。
   * `broadcast` 時會多講一句「網址按鈕的貼標在推播裡不會生效」——
   * ⛔ 其他地方**不可以**講這句：那些路徑貼標是**有效**的，講了等於叫人關掉能用的功能。
   */
  context?: 'default' | 'broadcast'
}>(), {
  disabled: false,
  size: 'default',
  placeholder: '選擇機器人模組（可打字搜尋）',
  allowCreate: true,
  emptyText: '',
  context: 'default',
})

const emit = defineEmits<{
  'update:modelValue': [string]
  /** 建好一個（已經自動選起來了）。頁面想順手做別的事才需要聽，不聽也不會壞 */
  'created': [ModuleOption]
}>()

const { apiFetch, workspaceId, canOperate } = useWorkspace()
const { showToast } = useAdminToast()
const { bumpAdminFlowList } = useAdminFlowRefresh()

/**
 * 這顆元件自己建出來的模組。
 * ⛔ **不能只靠頁面重新載入清單**：`options` 是 prop，重載是非同步的，
 *    中間那幾百毫秒下拉裡沒有這個 id，`el-select` 會把它**原封印出 uuid**。
 */
const locallyCreated = ref<ModuleOption[]>([])

type Row = ModuleOption & { flag: string; flagTone: 'empty' | 'inactive' | 'gone'; missing?: boolean }

const mergedOptions = computed<Row[]>(() => {
  const seen = new Set(props.options.map(m => m.id))
  const merged = [...props.options, ...locallyCreated.value.filter(m => !seen.has(m.id))]

  const decorate = (m: ModuleOption): Row => {
    if (m.isActive === false) return { ...m, flag: '已停用', flagTone: 'inactive' }
    // ⚠️ `messageCount` 沒帶回來時（呼叫端沒升級）一律當成「不知道」＝不標，
    //    ⛔ 不可以當成 0 而標成「還沒有內容」——那是拿「查不到」冒充「沒有」。
    if (m.messageCount === 0) return { ...m, flag: '還沒有內容', flagTone: 'empty' }
    return { ...m, flag: '', flagTone: 'empty' }
  }

  /**
   * `C-209` 同款：**已經選起來、但清單裡沒有的模組也要給它一個名字**。
   * ⛔ 不可以默默把它清掉：那會在使用者**沒有按儲存**的情況下改掉他的設定。
   */
  const known = new Set(merged.map(m => m.id))
  const orphan = props.modelValue && !known.has(props.modelValue)
    ? [{ id: props.modelValue, name: '（已刪除的模組）', flag: '已刪除', flagTone: 'gone' as const, missing: true }]
    : []

  return [...merged.map(decorate), ...orphan]
})

const selectedRow = computed(() => mergedOptions.value.find(m => m.id === props.modelValue) ?? null)

const showCreateButton = computed(() => props.allowCreate && canOperate.value)
const showActions = computed(() => showCreateButton.value || !!editHref.value)

const flowPagePath = computed(() =>
  workspaceId.value ? `/admin/${workspaceId.value}/flow` : '',
)

/** 已刪除的模組沒有東西可以編輯，這時不給連結（點過去只會看到「找不到這個模組」） */
const editHref = computed(() => {
  const row = selectedRow.value
  if (!row || row.missing || !flowPagePath.value) return ''
  return `${flowPagePath.value}?id=${encodeURIComponent(row.id)}`
})

const selectedWarning = computed(() => {
  const row = selectedRow.value
  if (!row) return ''
  if (row.missing) return '這個模組已經被刪掉了，客人走到這裡不會有任何反應——請改選一個，或把這個動作拿掉。'
  if (row.isActive === false) return '這個模組目前是停用的，客人走到這裡不會收到東西。'
  if (row.messageCount === 0) return '這個模組還沒有任何內容，客人走到這裡會什麼都收不到。'
  return ''
})

/**
 * `C-238`：推播選到「裡面有開了貼標的網址按鈕」的模組時要講的那句話。
 *
 * ⚠️ 用語刻意講**後果＋替代方案**，不只說「不支援」：
 *    他開那個開關是為了「知道誰點了」，所以要告訴他哪一條路拿得到。
 * ⛔ 只在推播講；⛔ 也不要因此把那個開關藏起來——它在別條路上是好的。
 */
const broadcastUriTagNote = computed(() => {
  if (props.context !== 'broadcast') return ''
  const n = selectedRow.value?.taggedUriButtons ?? 0
  if (!n) return ''
  return `提醒：這個模組裡有 ${n} 顆網址按鈕開了「啟用貼標」，但推播是一次寄給一群人、認不出是誰點的，所以那個貼標在推播裡不會生效（客人從圖文選單或別的模組按進去時才會）。想知道誰有興趣的話，改用「觸發模組」那種按鈕就記得到。`
})

const defaultEmptyText = computed(() =>
  showCreateButton.value
    ? '還沒有任何機器人模組。模組就是「客人走到這一步時，機器人要回什麼」——現在就可以建一個，不用離開這一頁。'
    : '還沒有任何機器人模組。要先到「機器人模組」建一個，這裡才選得到。',
)

function onSelectChange(value: unknown) {
  emit('update:modelValue', value == null ? '' : String(value))
}

const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const draft = reactive({ name: '', text: '' })

function openCreate() {
  draft.name = ''
  draft.text = ''
  createError.value = ''
  createOpen.value = true
}

/** @param openEditor 建完要不要順手在新分頁打開模組編輯器（要加圖片／按鈕的人走這條） */
async function submitCreate(openEditor: boolean) {
  const name = draft.name.trim()
  const text = draft.text.trim()
  if (!name) {
    createError.value = '請先填模組名稱。'
    return
  }
  if (!text) {
    // ⛔ 不要放行成空模組：後端也會擋，但錯誤訊息要在他還看得到這張表單的時候講
    createError.value = '請先寫一句要回給客人的話——沒有內容的模組，客人按下去會什麼都收不到。'
    return
  }

  creating.value = true
  createError.value = ''
  try {
    const created = await apiFetch<{ id: string; name: string }>('/api/flow/create', {
      method: 'POST',
      body: { name, messages: [{ type: 'text', text }], isActive: true },
    })

    const option: ModuleOption = {
      id: created.id,
      name: created.name ?? name,
      isActive: true,
      messageCount: 1,
    }
    locallyCreated.value = [...locallyCreated.value, option]
    emit('update:modelValue', option.id)
    emit('created', option)
    bumpAdminFlowList()
    showToast(`已建立「${option.name}」並選起來了`, 'success')
    createOpen.value = false

    if (openEditor && flowPagePath.value) {
      // 新分頁：原本這張表單多半還沒存，同分頁跳走就是丟掉他填到一半的東西
      window.open(`${flowPagePath.value}?id=${encodeURIComponent(option.id)}`, '_blank', 'noopener')
    }
  }
  catch (e: any) {
    createError.value = e?.data?.statusMessage || e?.statusMessage || '建立失敗，請再試一次。'
  }
  finally {
    creating.value = false
  }
}
</script>
