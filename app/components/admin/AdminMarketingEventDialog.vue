<!--
  店家自己的檔期：加、改、從推播「設成檔期」共用的小視窗（`D-122`②）。只有名稱＋日期兩格。

  三個入口：
  - 首頁「接下來的檔期」卡片的「＋ 加自己的檔期」（mode=create）
  - 卡片上自己的那一檔攤開後的「修改」（mode=edit）
  - 推播頁一則已排程推播的「⋯ → 設成檔期」（mode=fromBroadcast：名稱、日期先帶那則推播的，送出時一起綁上）
  ⛔ 不從推播名稱猜檔期：這裡只收人親手按的。
  ⛔ 日期只給選今天到 90 天內（卡片只看未來 90 天）：加了卻在卡片上看不到，等於加了就不見。
-->
<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="min(420px, 92vw)"
    append-to-body
    :close-on-click-modal="false"
    class="mkt-event-dialog"
    @update:model-value="close"
  >
    <div class="mkt-event">
      <p v-if="mode === 'fromBroadcast'" class="mkt-event__lead">
        首頁「接下來的檔期」會多這一檔，這則推播就是它排好的那一則。
      </p>
      <div class="admin-field-group">
        <AdminFieldLabel text="檔期名稱" tight />
        <el-input
          v-model="name"
          :maxlength="MARKETING_EVENT_NAME_MAX"
          show-word-limit
          placeholder="例如：週年慶、新品開賣"
          @keyup.enter="save"
        />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="日期" tight />
        <el-date-picker
          v-model="date"
          type="date"
          format="YYYY/MM/DD"
          value-format="YYYY-MM-DD"
          placeholder="選日期"
          :disabled-date="disabledDate"
          :clearable="false"
          class="mkt-event__date"
        />
      </div>
      <p v-if="errorText" class="mkt-event__error">{{ errorText }}</p>
    </div>

    <template #footer>
      <el-button :disabled="saving" @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="saving" @click="save">{{ submitLabel }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {
  MARKETING_EVENT_NAME_MAX,
  isEventDateDisabled,
  validateEventInput,
  type MarketingEvent,
} from '~~/shared/marketing-events'
import { taipeiDate } from '~~/shared/time'

const props = defineProps<{
  visible: boolean
  workspaceId: string
  mode: 'create' | 'edit' | 'fromBroadcast'
  /** 打開時先填好的值。edit 要帶 id；fromBroadcast 帶推播名稱與排程那天 */
  initial?: { id?: string, name?: string, date?: string }
  /** fromBroadcast：那則推播的 id（後端同一個交易把它綁到這一檔） */
  broadcastId?: string
}>()

const emit = defineEmits<{
  'update:visible': [boolean]
  /** 存好了（帶存好的那一筆），呼叫端負責講一句話、重載 */
  'saved': [MarketingEvent, boolean]
}>()

const { apiFetch } = useWorkspaceApiFetch(() => props.workspaceId)

const name = ref('')
const date = ref('')
const saving = ref(false)
const errorText = ref('')

const title = computed(() => ({ create: '加自己的檔期', edit: '修改檔期', fromBroadcast: '設成檔期' })[props.mode])
const submitLabel = computed(() => ({ create: '新增', edit: '儲存', fromBroadcast: '設成檔期' })[props.mode])

watch(() => props.visible, (open) => {
  if (!open) return
  // ⛔ 每次打開都從乾淨的狀態開始，不要留上一次的殘值
  name.value = String(props.initial?.name ?? '').slice(0, MARKETING_EVENT_NAME_MAX)
  const d = String(props.initial?.date ?? '')
  date.value = d && !isEventDateDisabled(d, taipeiDate()) ? d : ''
  saving.value = false
  errorText.value = ''
}, { immediate: true })

/** 日期選單的格子是瀏覽器當地時間的 0 點，取它的年月日 */
function disabledDate(d: Date): boolean {
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return isEventDateDisabled(key, taipeiDate())
}

function close() {
  if (saving.value) return
  emit('update:visible', false)
}

async function save() {
  if (saving.value) return // ⛔ 防連點：按兩下會加出兩檔一模一樣的
  // 跟後端同一支規則先驗一次（⛔ 兩邊各寫一份，遲早一邊放行一邊擋）
  const v = validateEventInput({ name: name.value, date: date.value }, taipeiDate())
  if (!v.ok) {
    errorText.value = v.message
    return
  }
  saving.value = true
  errorText.value = ''
  try {
    const isNew = props.mode !== 'edit'
    const r = await apiFetch<{ event: MarketingEvent }>('/api/marketing-calendar', {
      method: 'POST',
      body: {
        op: isNew ? 'create' : 'update',
        ...(isNew ? {} : { id: props.initial?.id }),
        name: v.name,
        date: v.date,
        ...(props.mode === 'fromBroadcast' && props.broadcastId ? { broadcastId: props.broadcastId } : {}),
      },
    })
    emit('update:visible', false)
    emit('saved', r.event, isNew)
  }
  catch (e: unknown) {
    // 後端的訊息本來就是白話的（「只有已排程的推播可以設成檔期」），直接用
    errorText.value = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || '存不起來，請再試一次。'
  }
  finally {
    saving.value = false
  }
}
</script>
