<!--
  店家輪廓卡（`D-85` / `C-217`）——MiniMe 對這家店的認識。

  掛在「組織與 LINE」頁最上面。⛔ 刻意不加側欄項目：它不是一個新功能，
  是「這個帳號是誰」的一部分，跟組織名稱、官方帳號名稱住在一起才找得到。

  ⛔ 三件事不可以妥協：
    ① **每一格都要說得出是誰講的**（你說的／AI 推測／從對話學）。AI 猜的必須看得出是猜的。
    ② **「還沒有」與「找過但沒有」講的不是同一句話**：前者是還沒問，後者是讀了網站沒提到。
       合成一句就是那條沉默死亡（`shared/types/store-profile.ts` 的鐵律 ②）。
    ③ **商家改過的永遠贏**：改完那一格會標成「你說的」，之後 AI 重讀網站不會蓋掉它。
-->
<template>
  <div class="message-card ar-section-card store-profile" data-tour="org-store-profile">
    <div class="message-card-header">
      <div class="card-header-main">
        <span class="section-title">MiniMe 認識的你</span>
        <span class="text-xs text-muted">{{ headerCaption }}</span>
      </div>
      <el-button v-if="ready && canEdit" size="small" :loading="loading" @click="reload">重新載入</el-button>
    </div>

    <div class="card-section-stack">
      <!-- 查不到 ≠ 沒有：載入失敗要講出來，不可以畫成一張空的輪廓 -->
      <el-alert v-if="loadError" type="warning" :closable="false" show-icon>
        <template #title>這次讀不到你的輪廓</template>
        {{ loadError }}
      </el-alert>

      <div v-else-if="loading && !loaded" class="store-profile__muted">正在讀你的輪廓…</div>

      <!-- 還不認識：講清楚少了它會怎樣，而不是只說「尚未設定」 -->
      <div v-else-if="!ready" class="store-profile__empty">
        <p class="store-profile__empty-title">MiniMe 還不認識你的店</p>
        <p class="store-profile__empty-body">
          它現在只知道你的帳號名稱和 LINE 連線資料。
          所以節慶前給你的行銷提醒只能是<b>跨產業通用的一句話</b>，講不出「你的商品該怎麼搭這個節日」，
          AI 回客人的語氣也只能用通用範本。
        </p>
        <p class="store-profile__empty-body">花 <b>3 分鐘</b>回答五個問題，再貼一個網址讓它自己去讀就好。</p>
        <el-button v-if="canEdit" type="primary" @click="goWizard">讓 MiniMe 認識你的店 →</el-button>
        <p v-else class="store-profile__muted">這要請管理員來做。</p>
      </div>

      <template v-else>
        <dl class="store-profile__rows">
          <template v-for="row in rows" :key="row.id">
            <dt>{{ row.label }}</dt>
            <dd>
              <div v-if="editingId !== row.id" class="store-profile__val">
                <span :class="['store-profile__text', { 'is-empty': !row.value }]">
                  {{ row.value || row.emptyText }}
                </span>
                <span :class="['store-profile__src', `is-${row.sourceKind}`]">{{ row.sourceText }}</span>
                <!-- `C-226`：從對話學來的，還沒有人確認過。按了就變成「你說的」，
                     之後不會再被自動更新。⛔ 不可以靜默把它當成他說的。 -->
                <el-button
                  v-if="canEdit && row.sourceKind === 'conversation' && row.value"
                  link
                  type="success"
                  size="small"
                  :loading="savingId === row.id"
                  @click="confirmLearned(row.id)"
                >
                  對，就是這樣
                </el-button>
                <el-button v-if="canEdit" link type="primary" size="small" @click="startEdit(row.id)">
                  {{ row.value ? '改' : '補' }}
                </el-button>
              </div>

              <div v-else class="store-profile__edit">
                <!-- ⛔ 有選項的用 el-select、沒選項的用 el-input，不手刻原生元件 -->
                <el-select
                  v-if="row.options"
                  v-model="draft"
                  class="store-profile__input"
                  filterable
                  allow-create
                  default-first-option
                  placeholder="選一個，或直接打字"
                >
                  <el-option v-for="o in row.options" :key="o" :label="o" :value="o" />
                </el-select>
                <el-input
                  v-else
                  v-model="draft"
                  class="store-profile__input"
                  :placeholder="row.placeholder || '寫一句話就好'"
                  :maxlength="valueMax"
                  show-word-limit
                />
                <div class="store-profile__edit-actions">
                  <el-button size="small" :disabled="savingId === row.id" @click="cancelEdit">取消</el-button>
                  <el-button size="small" type="primary" :loading="savingId === row.id" @click="saveField(row.id)">存起來</el-button>
                </div>
              </div>
            </dd>
          </template>
        </dl>

        <div class="store-profile__foot">
          <p>
            <b>{{ filledCount }}</b> / {{ totalCount }} 項有內容。
            標「AI 推測」的是它讀你的網站猜的，猜錯直接改；<b>你改過的，之後重讀網站不會被蓋掉</b>。
          </p>
          <p v-if="siteLine" class="store-profile__site">{{ siteLine }}</p>
          <p v-if="failedPages.length" class="store-profile__warn">
            讀不到的頁：{{ failedPages.join('、') }}
          </p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  describeMissing,
  describeSiteRead,
  failReasonText,
  filledFieldCount,
  STORE_PROFILE_FIELDS,
  STORE_PROFILE_SOURCE_LABELS,
  STORE_PROFILE_VALUE_MAX,
  storeProfileFieldDef,
  type StoreProfileDoc,
  type StoreProfileFieldId,
} from '~~/shared/types/store-profile'

const props = defineProps<{ workspaceId: string, canEdit: boolean }>()

const { apiFetch } = useWorkspaceApiFetch(() => props.workspaceId)

const profile = ref<StoreProfileDoc | null>(null)
const ready = ref(false)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
const editingId = ref<StoreProfileFieldId | null>(null)
const draft = ref('')
const savingId = ref<StoreProfileFieldId | null>(null)

const valueMax = STORE_PROFILE_VALUE_MAX
const totalCount = STORE_PROFILE_FIELDS.length

async function reload() {
  loading.value = true
  loadError.value = ''
  try {
    const r = await apiFetch<{ profile: StoreProfileDoc, ready: boolean }>('/api/store-profile')
    profile.value = r.profile
    ready.value = r.ready
    loaded.value = true
  }
  catch (e: unknown) {
    // ⛔ 查不到不可以畫成一張空輪廓：那會讓人以為自己填的東西不見了
    loadError.value = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || '請稍後再試一次'
  }
  finally {
    loading.value = false
  }
}

const rows = computed(() => STORE_PROFILE_FIELDS.map((def) => {
  const f = profile.value?.fields?.[def.id]
  return {
    id: def.id,
    label: def.label,
    value: f?.value ?? '',
    options: def.options,
    placeholder: def.placeholder,
    emptyText: describeMissing(def, f?.missing),
    sourceKind: f?.value ? (f.source ?? 'ai') : 'none',
    sourceText: f?.value ? STORE_PROFILE_SOURCE_LABELS[f.source ?? 'ai'] : '還沒有',
  }
}))

const filledCount = computed(() => (profile.value ? filledFieldCount(profile.value) : 0))

const headerCaption = computed(() => {
  if (!ready.value) return '還沒有認識過'
  return '你改過的內容，AI 重讀網站時不會蓋掉'
})

const siteLine = computed(() => {
  const p = profile.value
  if (!p) return ''
  if (!p.siteUrl) return ''
  return `${p.siteUrl}　${describeSiteRead(p.siteRead)}`
})

const failedPages = computed(() => {
  const list = profile.value?.siteRead?.pagesFailed ?? []
  return list.slice(0, 5).map(p => `${p.url}（${failReasonText(p.reason)}）`)
})

function startEdit(id: StoreProfileFieldId) {
  editingId.value = id
  draft.value = profile.value?.fields?.[id]?.value ?? ''
}

function cancelEdit() {
  editingId.value = null
  draft.value = ''
}

async function saveField(id: StoreProfileFieldId) {
  savingId.value = id
  try {
    const r = await apiFetch<{ profile: StoreProfileDoc, ready: boolean }>('/api/store-profile', {
      method: 'POST',
      body: { fields: { [id]: draft.value } },
    })
    profile.value = r.profile
    ready.value = r.ready
    editingId.value = null
    draft.value = ''
    ElMessage.success(`「${storeProfileFieldDef(id)?.label ?? '這一項'}」已更新`)
  }
  catch (e: unknown) {
    ElMessage.error((e as { data?: { statusMessage?: string } })?.data?.statusMessage || '存不起來，請再試一次')
  }
  finally {
    savingId.value = null
  }
}

/**
 * 確認「從對話學來的」那一格（`C-226`）。
 * ⭐ 按下去＝這一格從此是「你說的」，自動更新不會再動它——
 *    這跟「改」是同一支端點，差別只在不用他重打一次字。
 */
async function confirmLearned(id: StoreProfileFieldId) {
  const v = profile.value?.fields?.[id]?.value
  if (!v) return
  savingId.value = id
  try {
    const r = await apiFetch<{ profile: StoreProfileDoc, ready: boolean }>('/api/store-profile', {
      method: 'POST',
      body: { fields: { [id]: v } },
    })
    profile.value = r.profile
    ready.value = r.ready
    ElMessage.success('好，這一格之後不會再被自動更新')
  }
  catch (e: unknown) {
    ElMessage.error((e as { data?: { statusMessage?: string } })?.data?.statusMessage || '存不起來，請再試一次')
  }
  finally {
    savingId.value = null
  }
}

function goWizard() {
  // 回到同一支開通精靈：它已經有「做過的靜默跳過」的續走機制，
  // ⛔ 不另外做一份只問五題的畫面（同一件事兩套劇本遲早會講不一樣的話）。
  // ⛔ **`focus=profile` 不可以拿掉**：沒有它會落進續走模式，而續走只跑接線那四步——
  //    已經接好 LINE 的人（老店就是）會看到「歡迎回來」然後直接跳到成績單，五題一句都沒問。
  void navigateTo(`/admin/onboarding?workspaceId=${props.workspaceId}&focus=profile`)
}

onMounted(reload)
</script>
