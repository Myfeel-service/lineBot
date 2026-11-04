<template>
  <!--
    客人生日（`C-57`，John 哥 2026-11-04「只要有人生日，我就會被逼著做動作」）。
    加好友時在歡迎訊息後面問生日（LINE 內建選日期、只存月日），每個月 1 號貼「本月壽星」。
    卡上與回覆的字都吃 `shared/birthday.ts`——跟送出端同一份，⛔ 這裡不另寫一份預覽文字。
  -->
  <el-dialog v-model="visible" class="birthday-dialog" title="生日" width="min(560px, 94vw)" append-to-body>
    <p class="birthday__intro">
      客人加好友時，歡迎訊息後面多一張卡。按「告訴我生日」會跳出 LINE 內建的選日期，<strong>只會記下月和日</strong>。
      每個月 1 號，這個月生日的人會貼上「<strong>本月壽星</strong>」標籤，推播時選這個標籤就只發給他們。
    </p>

    <div v-if="loading" class="tags-loading">
      <div class="spinner" />
      <span>載入中…</span>
    </div>
    <p v-else-if="loadError" class="birthday__notice is-error">{{ loadError }}</p>
    <template v-else>
      <div class="admin-field-stack">
        <div class="admin-field-group birthday__switch-row">
          <el-switch v-model="form.enabled" :disabled="!canEdit" data-tour="bday-switch" />
          <span class="birthday__switch-label">加好友時問生日</span>
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="生日當月送什麼（選填）" tight />
          <el-input
            v-model="form.gift"
            :maxlength="BIRTHDAY_GIFT_MAX"
            show-word-limit
            placeholder="例：來店招待一杯飲料"
            :disabled="!canEdit"
          />
          <p class="birthday__hint">沒寫就只問生日、不提禮物。寫了就要真的送——客人會記得。</p>
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="客人會看到" tight />
          <div class="birthday__phone">
            <div class="birthday__card">
              <div class="birthday__card-body">
                <b>{{ askText }}</b>
                <span>{{ BIRTHDAY_ASK_NOTE }}</span>
              </div>
              <div class="birthday__card-btn">{{ BIRTHDAY_BUTTON_LABEL }}</div>
            </div>
            <span class="birthday__phone-cap">選好日期之後，會收到這一句</span>
            <div class="birthday__bubble">{{ confirmText }}</div>
          </div>
        </div>

        <div class="birthday__stats" data-tour="bday-stats">
          <template v-if="stats">
            <template v-if="stats.total">
              已經有 <strong>{{ stats.total }}</strong> 位留了生日；這個月（{{ stats.month }} 月）<strong>{{ stats.thisMonth }}</strong> 位。
            </template>
            <template v-else>還沒有人留生日。</template>
          </template>
          <template v-else-if="statsError">{{ statsError }}</template>
        </div>
        <p class="birthday__hint">已經是好友的人不會再收到歡迎訊息，所以這張卡只會給之後加好友的人。</p>
      </div>
    </template>

    <template #footer>
      <p v-if="!canEdit && !loading" class="birthday__hint birthday__foot-note">只有管理員可以改這裡的設定。</p>
      <el-button @click="visible = false">{{ canEdit ? '取消' : '關閉' }}</el-button>
      <el-button v-if="canEdit" type="primary" :loading="saving" :disabled="loading || !!loadError || !dirty" @click="save">儲存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {
  BIRTHDAY_ASK_NOTE,
  BIRTHDAY_BUTTON_LABEL,
  BIRTHDAY_GIFT_MAX,
  birthdayAskText,
  birthdayConfirmText,
  normalizeBirthdaySettings,
  type BirthdaySettings,
} from '~~/shared/birthday'

interface BirthdayStats { byMonth: number[], total: number, month: number, thisMonth: number }

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const { apiFetch } = useWorkspace()
const { can } = useAdminOperateGuard()
const { showToast } = useAdminToast()
/** 存檔打的是 PUT /api/ai/settings（`ai.settings.write`），⛔ 用同一項能力決定能不能改 */
const canEdit = computed(() => can('ai.settings.write'))

const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const saved = ref<BirthdaySettings>({ enabled: false, gift: '' })
const form = reactive<BirthdaySettings>({ enabled: false, gift: '' })
const stats = ref<BirthdayStats | null>(null)
const statsError = ref('')

const dirty = computed(() => form.enabled !== saved.value.enabled || form.gift.trim() !== saved.value.gift)
const askText = computed(() => birthdayAskText(form.gift))
// 預覽用 3 月 12 日當例子（⛔ 不是哪一位客人的生日）
const confirmText = computed(() => birthdayConfirmText(3, 12, form.gift, false))

watch(visible, (v) => {
  if (v) void load()
}, { immediate: true })

async function load() {
  loading.value = true
  loadError.value = ''
  statsError.value = ''
  stats.value = null
  try {
    const s = await apiFetch<{ birthday?: Partial<BirthdaySettings> }>('/api/ai/settings')
    saved.value = normalizeBirthdaySettings(s?.birthday)
    Object.assign(form, saved.value)
  }
  catch {
    loadError.value = '讀不到設定，等一下再打開一次試試。'
  }
  finally {
    loading.value = false
  }
  // 數字讀不到不擋設定（⛔ 也不顯示成 0：那是「沒有」的另一個意思）
  apiFetch<BirthdayStats>('/api/ai/settings', { query: { part: 'birthday' } })
    .then((r) => { stats.value = r })
    .catch(() => { statsError.value = '幾位留了生日這次讀不到。' })
}

async function save() {
  saving.value = true
  try {
    const next = normalizeBirthdaySettings({ enabled: form.enabled, gift: form.gift })
    const r = await apiFetch<{ birthday?: Partial<BirthdaySettings> }>('/api/ai/settings', {
      method: 'PUT',
      body: { birthday: next },
    })
    saved.value = normalizeBirthdaySettings(r?.birthday ?? next)
    Object.assign(form, saved.value)
    showToast(saved.value.enabled ? '已儲存：之後加好友的客人會被問生日' : '已儲存：加好友時不問生日', 'success')
    visible.value = false
  }
  catch (e: unknown) {
    const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
    showToast(msg || '沒有存成功，再按一次試試', 'error')
  }
  finally {
    saving.value = false
  }
}
</script>
