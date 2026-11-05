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
        <!-- code review 第 1、6 條：講清楚哪些人會收到、什麼時候不附（⛔ 不可以默默不送） -->
        <p class="birthday__hint birthday__switch-hint">
          打開後，客人加好友時歡迎訊息後面多附這張卡（從活動連結加好友的人也會收到）。
          歡迎訊息最後一則有快速回覆按鈕時不附——附了那排按鈕會不見。
        </p>

        <div class="admin-field-group">
          <AdminFieldLabel text="生日當月送什麼（選填）" tight />
          <el-input
            v-model="form.gift"
            :maxlength="BIRTHDAY_GIFT_MAX"
            show-word-limit
            placeholder="例：來店招待一杯飲料"
            :disabled="!canEdit"
          />
          <p class="birthday__hint">
            沒寫就只問生日、不提禮物。寫了就要真的送——加好友那張卡、「問生日」模組、選完日期的回覆、生日祝福都會講。
          </p>
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
        <!--
          `C-57` 甲（老闆 2026-11-04 選的）：已經是好友的人不會再收到歡迎訊息——
          建一個「問生日」機器人模組（一則字＋一顆「問生日」按鈕），推播選「觸發機器人模組」、圖文選單指向它就能問。
        -->
        <div class="admin-field-group birthday__existing" data-tour="bday-module">
          <AdminFieldLabel text="問已經是好友的人" tight />
          <p class="birthday__hint">
            他們不會再收到歡迎訊息。建一個「問生日」機器人模組，推播選「觸發機器人模組 → 問生日」就能問；
            圖文選單也能放一格指向它，讓客人隨時自己留。
          </p>
          <!-- code review 第 9 條：清單還沒讀回來不給建立鈕（手快一按就建出第二個「問生日」） -->
          <div v-if="moduleLoading" class="birthday__hint">正在看有沒有建過…</div>
          <div v-else-if="moduleRow" class="birthday__module-row">
            <span>已經有「{{ moduleRow.name }}」模組。</span>
            <a class="ar-link" :href="moduleEditHref" target="_blank" rel="noopener">編輯這個模組 ↗</a>
            <a class="ar-link" :href="broadcastHref" target="_blank" rel="noopener">去推播 ↗</a>
          </div>
          <div v-else-if="moduleLoadError" class="birthday__hint">{{ moduleLoadError }}</div>
          <el-button v-else-if="canCreateModule" size="small" :loading="creatingModule" class="birthday__module-btn" @click="createModule">
            建立「問生日」模組
          </el-button>
          <p v-else class="birthday__hint">建模組要能編輯機器人模組的人來按。</p>
        </div>
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
  BIRTHDAY_MODULE_NAME,
  birthdayAskText,
  birthdayConfirmText,
  buildBirthdayModuleMessages,
  normalizeBirthdaySettings,
  type BirthdaySettings,
} from '~~/shared/birthday'
import { apiErrorText } from '~/utils/api-error-text'
import { readBirthdaySettings, saveBirthdaySettings } from '~/utils/birthday-settings'

interface BirthdayStats { byMonth: number[], total: number, month: number, thisMonth: number }

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const { workspaceId, apiFetch } = useWorkspace()
const { can } = useAdminOperateGuard()
const { showToast } = useAdminToast()
/** 存檔打的是 PUT /api/ai/settings（`ai.settings.write`），⛔ 用同一項能力決定能不能改 */
const canEdit = computed(() => can('ai.settings.write'))
/** 建模組打的是 `flow/create`（`marketing.write`，同 AdminFlowPicker 的「＋ 新模組」） */
const canCreateModule = computed(() => can('marketing.write'))

/** 已經有「問生日」模組了沒（照名字找自建模組；他改了名字＝找不到，會再給一次建立鈕） */
const moduleRow = ref<{ id: string, name: string } | null>(null)
const moduleLoadError = ref('')
const moduleLoading = ref(false)
const creatingModule = ref(false)
const moduleEditHref = computed(() => moduleRow.value ? `/admin/${workspaceId.value}/flow?id=${encodeURIComponent(moduleRow.value.id)}` : '')
const broadcastHref = computed(() => `/admin/${workspaceId.value}/broadcasts`)

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
  // 讀寫都走 `utils/birthday-settings`（三個畫面同一條路，code review 第 7 條）
  const current = await readBirthdaySettings(apiFetch)
  if (current) {
    saved.value = current
    Object.assign(form, current)
  }
  else {
    loadError.value = '讀不到設定，等一下再打開一次試試。'
  }
  loading.value = false
  // 數字讀不到不擋設定（⛔ 也不顯示成 0：那是「沒有」的另一個意思）
  apiFetch<BirthdayStats>('/api/ai/settings', { query: { part: 'birthday' } })
    .then((r) => { stats.value = r })
    .catch(() => { statsError.value = '幾位留了生日這次讀不到。' })
  moduleLoadError.value = ''
  moduleLoading.value = true
  apiFetch<Array<{ id: string, name?: string, isSystem?: boolean }>>('/api/flow/list', { query: { fields: 'picker' } })
    .then((rows) => {
      const hit = (rows ?? []).find(r => !r.isSystem && String(r.name ?? '').trim() === BIRTHDAY_MODULE_NAME)
      moduleRow.value = hit ? { id: hit.id, name: String(hit.name) } : null
    })
    // ⛔ 讀不到不可以當成「沒有」再給建立鈕：會建出第二個「問生日」
    .catch(() => { moduleLoadError.value = '讀不到機器人模組清單，等一下再打開一次試試。' })
    .finally(() => { moduleLoading.value = false })
}

/**
 * 建「問生日」模組。⚠️ 框裡改了還沒存就先存（code review 第 7 條）：模組那句話寫的是**存好的**生日禮，
 * 跟選完日期的回覆、生日祝福講的同一份——⛔ 不可以模組卡寫了禮物、回覆卻不提。
 */
async function createModule() {
  if (canEdit.value && dirty.value && !(await persist())) return
  creatingModule.value = true
  try {
    const created = await apiFetch<{ id: string, name?: string }>('/api/flow/create', {
      method: 'POST',
      body: { name: BIRTHDAY_MODULE_NAME, messages: buildBirthdayModuleMessages(saved.value.gift), isActive: true },
    })
    moduleRow.value = { id: created.id, name: String(created.name || BIRTHDAY_MODULE_NAME) }
    showToast('已建立「問生日」模組：推播選「觸發機器人模組」就能發給現有好友', 'success')
  }
  catch (e: unknown) {
    const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
    showToast(msg || '沒有建成功，再按一次試試', 'error')
  }
  finally {
    creatingModule.value = false
  }
}

/** 存設定；成功回 true（儲存鈕與「建立『問生日』模組」共用） */
async function persist(): Promise<boolean> {
  saving.value = true
  try {
    // 這個框是**兩格都在這裡編的**，所以整包送（別處要打開開關一律走 `enableBirthday()`，
    // 整包送會蓋掉生日禮——code review 第 3 條）
    saved.value = await saveBirthdaySettings(apiFetch, { enabled: form.enabled, gift: form.gift })
    Object.assign(form, saved.value)
    return true
  }
  catch (e: unknown) {
    // ⛔ 不自己撈 statusMessage（第 6 條：`apiErrorText` 會補 data.message、濾掉英文的開發訊息）
    showToast(apiErrorText(e, '沒有存成功，再按一次試試'), 'error')
    return false
  }
  finally {
    saving.value = false
  }
}

async function save() {
  if (!(await persist())) return
  showToast(saved.value.enabled ? '已儲存：之後加好友的客人會被問生日' : '已儲存：加好友時不問生日', 'success')
  visible.value = false
}
</script>
