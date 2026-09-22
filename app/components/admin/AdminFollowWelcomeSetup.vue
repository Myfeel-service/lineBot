<!--
  「客人加好友時」的簡單設定（`D-23` 2026-09-21 拍板）。

  **一種東西、兩種深度**：這個小視窗是淺的那一層——選一個機器人模組，或直接打一段文字。
  存下去之後就是一條正常的加好友自動回應，要收資料、貼標、分支的人照舊用完整編輯器改它。
  ⛔ 不是第二種資料，底層就是 `scripts` 那一條。

  **為什麼需要這一層**：加好友歡迎以前藏在「新增 → 觸發方式第三顆」，
  商家腦中的詞（歡迎訊息）跟我們的詞（客服流程／觸發方式）對不上——
  MYFEEL 7 條自動回應裡一條加好友的都沒有，最近 90 天約 667 位掃 QR 加好友的人
  一句話都沒收到。
-->
<template>
  <el-dialog
    :model-value="visible"
    title="設定「客人加好友時」"
    width="560px"
    append-to-body
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <div class="fws">
      <p class="fws__intro">
        客人按下加好友的那一刻要看到什麼。<strong>掃 QR、搜尋 ID、從活動連結進來的人都適用</strong>
        （從活動連結來的人如果那個活動自己有歡迎訊息，會以活動的為準，不會連收兩則）。
      </p>

      <div class="admin-field-group">
        <AdminFieldLabel text="要送什麼" tight />
        <el-radio-group v-model="mode" class="fws__radios">
          <el-radio value="module">送一個機器人模組</el-radio>
          <el-radio value="text">直接打一段文字</el-radio>
        </el-radio-group>

        <el-select
          v-if="mode === 'module'"
          v-model="moduleId"
          filterable
          placeholder="選一個機器人模組"
          class="admin-w-full"
        >
          <el-option v-for="m in moduleOptions" :key="m.id" :value="m.id" :label="m.name" />
        </el-select>
        <el-input
          v-else
          v-model="text"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          maxlength="500"
          show-word-limit
          placeholder="例如：謝謝你加入！有任何問題都可以直接在這裡問我們。"
        />
        <p class="fws__hint">
          想要圖片、按鈕或多則訊息，就先到「機器人模組」做好，這裡選那個模組。
          之後要問客人問題、收電話、順手貼標籤，存好後在編輯器裡把它加上去就行。
        </p>
      </div>

      <!-- ⚠️ 這一段是這個視窗裡最容易被忽略、後果卻最直接的一件事 -->
      <div class="fws__warn">
        <p class="fws__warn-title">⚠️ 記得去 LINE 後台關掉內建的那則</p>
        <p>{{ LINE_BUILTIN_WELCOME_NOTE }}</p>
      </div>

      <p v-if="errorText" class="fws__error">{{ errorText }}</p>
    </div>

    <template #footer>
      <el-button :disabled="saving" @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="saving" @click="save">存起來並啟用</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import {
  LINE_BUILTIN_WELCOME_NOTE,
  buildFollowWelcomeScript,
  validateFollowWelcome,
  type FollowWelcomeReply,
} from '~~/shared/follow-welcome'

const props = defineProps<{
  visible: boolean
  moduleOptions: Array<{ id: string; name: string }>
}>()

const emit = defineEmits<{
  'update:visible': [boolean]
  /** 建好了（帶 id），頁面要重載清單並選到它 */
  'created': [string]
}>()

const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()

const mode = ref<'module' | 'text'>('module')
const moduleId = ref('')
const text = ref('')
const saving = ref(false)
const errorText = ref('')

const reply = computed<FollowWelcomeReply>(() =>
  mode.value === 'module'
    ? { kind: 'module', moduleId: moduleId.value }
    : { kind: 'text', text: text.value },
)

watch(() => props.visible, (open) => {
  if (!open) return
  // ⛔ 每次打開都從乾淨的狀態開始，不要留上一次的殘值
  mode.value = props.moduleOptions.length ? 'module' : 'text'
  moduleId.value = ''
  text.value = ''
  saving.value = false
  errorText.value = ''
})

function close() {
  if (saving.value) return
  emit('update:visible', false)
}

async function save() {
  if (saving.value) return // ⛔ 防連點：後端只准有一條啟用中的加好友流程，按兩下第二次會撞 409
  const invalid = validateFollowWelcome(reply.value)
  if (invalid) {
    errorText.value = invalid
    return
  }

  saving.value = true
  errorText.value = ''
  try {
    const { nodes, rootNodeId } = buildFollowWelcomeScript(reply.value, {
      triggerId: uuidv4(),
      replyId: uuidv4(),
    })
    const created = await apiFetch<{ id: string }>('/api/ai/scripts/create', {
      method: 'POST',
      body: { name: '加好友歡迎', enabled: true, nodes, rootNodeId },
    })
    showToast('設定好了，之後加好友的人就會收到', 'success')
    emit('update:visible', false)
    emit('created', created.id)
  }
  catch (e: any) {
    /**
     * 409＝已經有一條啟用中的加好友流程（後端的鐵律：兩條都開客人會連收兩份）。
     * ⛔ 後端那句話本來就是白話的，直接用它，不要自己另編一句比較模糊的。
     */
    errorText.value = e?.data?.statusMessage || e?.statusMessage || '存不起來，請再試一次。'
  }
  finally {
    saving.value = false
  }
}
</script>
