<!--
  「一檔活動」精靈（`C-212`）。

  **為什麼要有**：使用者的單位是「一檔商品」不是「一種東西一頁」。每上一檔要跨
  標籤管理 → 機器人模組 → 活動標籤 → 推播四頁、順序固定、缺零件就中斷回頭，
  MYFEEL 已經這樣做了 8 次（8 個活動全部同時綁標籤＋模組）。

  ⛔ **不取代既有表單**：熟手照舊按「新增」。這顆是給第一次的人用的。
  ⛔ **底層仍是四筆資料、四支既有端點**，這裡只負責順序與預設值。
  ⛔ **建到一半失敗一定要講得出已經建好了什麼**——一次建四樣，第三樣失敗時
     只說「建立失敗」的話，人會以為什麼都沒發生而重跑一次，於是多出重複的標籤與模組。
     那段判斷在 `shared/campaign-wizard.ts`（純函式，測試釘住）。
-->
<template>
  <el-dialog
    :model-value="visible"
    title="用精靈建立一檔活動"
    width="620px"
    append-to-body
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <!-- ── 跑完之後的結果 ────────────────────────────────── -->
    <div v-if="finished" class="cwz">
      <p :class="['cwz__headline', outcome.ok ? 'cwz__headline--ok' : 'cwz__headline--bad']">
        {{ outcome.headline }}
      </p>
      <ul class="cwz__lines">
        <li v-for="(line, i) in outcome.lines" :key="i">{{ line }}</li>
      </ul>

      <div v-if="outcome.leftovers.length" class="cwz__leftovers">
        <p class="cwz__leftovers-title">已經建好、還留在系統裡的東西：</p>
        <ul>
          <li v-for="(item, i) in outcome.leftovers" :key="i">{{ item }}</li>
        </ul>
        <p class="cwz__hint">
          再試一次的時候，標籤請改挑「沿用既有標籤」、模組請改挑「用既有的模組」，
          不然會多出一份一模一樣的。
        </p>
      </div>

      <div v-if="outcome.ok && entryUrl" class="cwz__url">
        <p class="cwz__url-title">活動進入網址（貼到問卷完成頁、廣告按鈕或簡訊）</p>
        <div class="cwz__url-row">
          <code>{{ entryUrl }}</code>
          <el-button size="small" @click="copyEntryUrl">複製</el-button>
        </div>
      </div>
    </div>

    <!-- ── 還沒跑：填表 ──────────────────────────────────── -->
    <div v-else class="cwz">
      <p class="cwz__intro">
        一頁把一檔活動需要的東西一次建好：<strong>標籤</strong>（記住這一檔的人）、
        <strong>加好友後的第一則訊息</strong>、<strong>活動連結</strong>，
        還可以順手留一張之後要發的推播草稿。
      </p>

      <div class="admin-field-group">
        <AdminFieldLabel text="① 這一檔叫什麼" tight />
        <el-input v-model="form.name" maxlength="40" placeholder="例如 宜米製冰機" @update:model-value="onNameInput" />
      </div>

      <div class="admin-field-group">
        <AdminFieldLabel text="② 客人加好友時，幫他貼什麼標籤" tight />
        <el-radio-group v-model="tagMode" class="cwz__radios">
          <el-radio value="new">幫我建一顆新的</el-radio>
          <el-radio value="existing">沿用既有標籤</el-radio>
        </el-radio-group>
        <el-input v-if="tagMode === 'new'" v-model="form.newTagName" maxlength="30" placeholder="標籤名稱" />
        <AdminTagPicker
          v-else
          :model-value="form.existingTagIds"
          :options="tagOptions"
          @update:model-value="(ids) => (form.existingTagIds = ids)"
        />
        <p class="cwz__hint">之後要發推播給這一檔的人，就是靠這顆標籤挑名單。</p>
      </div>

      <div class="admin-field-group">
        <AdminFieldLabel text="③ 客人加好友後，馬上看到什麼" tight />
        <el-radio-group v-model="form.replyMode" class="cwz__radios">
          <el-radio value="newModule">幫我建一則新訊息</el-radio>
          <el-radio value="existingModule">用既有的模組</el-radio>
          <el-radio value="none">先不回訊息</el-radio>
        </el-radio-group>
        <el-input
          v-if="form.replyMode === 'newModule'"
          v-model="form.newModuleText"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          maxlength="400"
          show-word-limit
          placeholder="例如：謝謝你報名宜米製冰機的活動！開賣當天我們會第一時間通知你。"
        />
        <el-select
          v-else-if="form.replyMode === 'existingModule'"
          v-model="form.existingModuleId"
          filterable
          placeholder="選一個機器人模組"
          class="admin-w-full"
        >
          <el-option v-for="m in moduleOptions" :key="m.id" :value="m.id" :label="m.name" />
        </el-select>
        <p v-if="form.replyMode === 'newModule'" class="cwz__hint">
          會建成一個機器人模組，之後在「機器人模組」那一頁還可以加圖片、按鈕。
        </p>
      </div>

      <div class="admin-field-group">
        <AdminFieldLabel text="④ 要不要順手留一張推播草稿" tight />
        <el-checkbox v-model="form.createBroadcastDraft">
          建一張「{{ broadcastName || '（先填活動名字）' }}」草稿，對象已選好這顆標籤
        </el-checkbox>
        <p class="cwz__hint">
          ⛔ 只是草稿，<strong>不會發出去</strong>，也不會佔用 LINE 額度。要發的時候到推播頁自己按。
        </p>
      </div>

      <p v-if="blockedReason" class="cwz__error">{{ blockedReason }}</p>

      <!-- 跑到一半的即時進度 -->
      <ul v-if="running" class="cwz__lines">
        <li v-for="(line, i) in outcome.lines" :key="i">{{ line }}</li>
      </ul>
    </div>

    <template #footer>
      <template v-if="finished">
        <el-button @click="close">關閉</el-button>
        <el-button v-if="outcome.ok" type="primary" @click="close">好，去看這個活動</el-button>
      </template>
      <template v-else>
        <el-button :disabled="running" @click="close">取消</el-button>
        <el-button type="primary" :loading="running" :disabled="running" @click="run">
          建立這一檔
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  buildCampaignWizardPlan,
  defaultBroadcastName,
  defaultNewTagName,
  summarizeCampaignWizard,
  validateCampaignWizard,
  type CampaignWizardInput,
  type CampaignWizardStep,
} from '~~/shared/campaign-wizard'
import { suggestTagCode } from '~~/shared/tag-code-suggest'
import { normalizeUnifiedAction } from '~~/shared/action-schema'
import { unifiedActionToLineMessages } from '~~/shared/broadcast-content'

const props = defineProps<{
  visible: boolean
  /** 既有標籤（給「沿用既有標籤」用） */
  tagOptions: Array<{ id: string; name: string; color?: string; code?: string }>
  /** 既有模組 */
  moduleOptions: Array<{ id: string; name: string }>
  /** LIFF 設好了沒；沒設好就整個擋住（跟既有表單同一個判斷） */
  liffReady: boolean
  /** LIFF 沒設好時要講的那句話（沿用頁面既有的措辭，不要另寫一套） */
  liffBlockedReason: string
}>()

const emit = defineEmits<{
  'update:visible': [boolean]
  /** 活動建好了（帶 id），頁面要重載清單並選到它 */
  'created': [string]
}>()

const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()
const { bumpAdminTagList } = useAdminTagRefresh()

const tagMode = ref<'new' | 'existing'>('new')
const form = reactive<CampaignWizardInput>({
  name: '',
  newTagName: '',
  existingTagIds: [],
  replyMode: 'newModule',
  newModuleText: '',
  existingModuleId: '',
  createBroadcastDraft: true,
})

const running = ref(false)
const finished = ref(false)
const steps = ref<CampaignWizardStep[]>([])
const entryUrl = ref('')
const createdCampaignId = ref('')
/** 名字被人自己改過就不要再跟著活動名字跑 */
const tagNameTouched = ref(false)

const broadcastName = computed(() => defaultBroadcastName(form.name))
const outcome = computed(() => summarizeCampaignWizard(steps.value))

/** 送出去的那份輸入：選「沿用既有」時不可以還帶著新標籤名字 */
const effectiveInput = computed<CampaignWizardInput>(() => ({
  ...form,
  newTagName: tagMode.value === 'new' ? form.newTagName.trim() : '',
  existingTagIds: tagMode.value === 'existing' ? form.existingTagIds : [],
}))

const blockedReason = computed(() =>
  validateCampaignWizard(effectiveInput.value, { liffReady: props.liffReady })
  || '',
)

function onNameInput(value: string) {
  if (!tagNameTouched.value) form.newTagName = defaultNewTagName(value)
}
watch(() => form.newTagName, (next) => {
  if (next !== defaultNewTagName(form.name)) tagNameTouched.value = true
})

watch(() => props.visible, (open) => {
  if (!open) return
  // 每次打開都從乾淨的狀態開始（⛔ 不要留著上一檔的殘值）
  form.name = ''
  form.newTagName = ''
  form.existingTagIds = []
  form.replyMode = 'newModule'
  form.newModuleText = ''
  form.existingModuleId = ''
  form.createBroadcastDraft = true
  tagMode.value = 'new'
  tagNameTouched.value = false
  running.value = false
  finished.value = false
  steps.value = []
  entryUrl.value = ''
  createdCampaignId.value = ''
})

function close() {
  if (running.value) return // ⛔ 跑到一半不讓關：關掉之後沒有人會告訴他建到哪裡
  emit('update:visible', false)
  if (createdCampaignId.value) emit('created', createdCampaignId.value)
}

async function copyEntryUrl() {
  try {
    await navigator.clipboard.writeText(entryUrl.value)
    showToast('已複製活動網址', 'success')
  }
  catch {
    showToast('這個瀏覽器不讓我複製，請手動選取', 'warning')
  }
}

/** 把後端的錯誤翻成看得懂的一句話 */
function readableError(e: any, fallback: string): string {
  const msg = String(e?.data?.statusMessage || e?.statusMessage || '').trim()
  if (msg) return msg
  return fallback
}

async function run() {
  if (running.value) return // ⛔ 防連點：按兩下會建出兩檔活動
  const blocked = blockedReason.value
  if (blocked) {
    showToast(blocked, 'error')
    return
  }

  const input = effectiveInput.value
  steps.value = buildCampaignWizardPlan(input)
  running.value = true

  const markSkippedFrom = (index: number) => {
    for (let i = index; i < steps.value.length; i += 1) {
      if (steps.value[i]!.status === 'pending') steps.value[i]!.status = 'skipped'
    }
  }

  let tagIds = [...input.existingTagIds]
  let moduleId = input.existingModuleId

  try {
    for (let i = 0; i < steps.value.length; i += 1) {
      const step = steps.value[i]!
      try {
        if (step.key === 'tag') {
          const created = await apiFetch<{ id: string }>('/api/tag/create', {
            method: 'POST',
            body: {
              code: suggestTagCode(input.newTagName, props.tagOptions.map(t => t.code ?? '')),
              name: input.newTagName,
              category: 'activity', // 這顆標籤就是「參加過這一檔」
              status: 'active',
            },
          })
          tagIds = [created.id]
          step.createdId = created.id
          bumpAdminTagList()
        }
        else if (step.key === 'module') {
          const created = await apiFetch<{ id: string }>('/api/flow/create', {
            method: 'POST',
            body: {
              name: input.name.trim(),
              messages: [{ type: 'text', text: input.newModuleText.trim(), actions: [] }],
              isActive: true,
            },
          })
          moduleId = created.id
          step.createdId = created.id
        }
        else if (step.key === 'campaign') {
          const created = await apiFetch<{ id: string; publishedCtaUrl?: string | null }>(
            '/api/campaigns/create',
            {
              method: 'POST',
              body: {
                name: input.name.trim(),
                tagIds,
                isActive: true,
                ...(moduleId ? { action: { type: 'module', moduleId } } : {}),
              },
            },
          )
          createdCampaignId.value = created.id
          entryUrl.value = String(created.publishedCtaUrl ?? '')
          step.createdId = created.id
        }
        else if (step.key === 'broadcast') {
          /**
           * ⛔ `/api/broadcast/create` 是 `name + audienceSource + messages` 三樣都必填，
           * 少帶 messages 會 400（第一版就是這樣，靠實機才抓到）。
           * 草稿的內容直接沿用這一檔的模組——之後要發的就是同一套東西；
           * 沒有模組時放這一檔的文字，真的都沒有才退回一句佔位字。
           */
          const draftText = input.newModuleText.trim() || `${input.name.trim()} 開賣囉！`
          const action = normalizeUnifiedAction(
            moduleId ? { type: 'module', moduleId } : { type: 'message', text: draftText },
            'A',
          )
          const created = await apiFetch<{ id: string }>('/api/broadcast/create', {
            method: 'POST',
            body: {
              name: defaultBroadcastName(input.name),
              audienceSource: { type: 'tags', tagIds },
              messages: unifiedActionToLineMessages(action),
            },
          })
          step.createdId = created.id
        }
        step.status = 'done'
      }
      catch (e: any) {
        step.status = 'failed'
        step.error = readableError(e, '這一步失敗了')
        /**
         * ⛔ **一步失敗就停**，不要硬著頭皮往下做：
         * 標籤沒建成還去建活動的話，活動會沒有標籤（後端會擋）或綁到錯的標籤。
         * 剩下的標成「沒有執行」，結果頁才講得出「建到哪裡」。
         */
        markSkippedFrom(i + 1)
        break
      }
    }
  }
  finally {
    running.value = false
    finished.value = true
  }
}
</script>
