<template>
  <div class="ln-qr" data-tour="ln-qr">
    <div v-if="state === 'loading'" class="ln-qr__loading">
      <div class="spinner" />
      <span>準備中…</span>
    </div>

    <div v-else-if="state === 'error'" class="ln-qr__body">
      <p class="ln-qr__text">{{ errorText }}</p>
      <div class="ln-qr__actions">
        <el-button size="small" type="primary" plain @click="retry">再試一次</el-button>
        <el-button size="small" text @click="$emit('cancel')">先不用</el-button>
      </div>
    </div>

    <template v-else>
      <div v-if="code.qrDataUrl" class="ln-qr__code">
        <img :src="code.qrDataUrl" alt="把你的手機加進 LINE 通知的 QR code">
      </div>
      <div class="ln-qr__body">
        <template v-if="code.bindUrl">
          <h4 class="ln-qr__title">用手機相機掃這個</h4>
          <p class="ln-qr__text">LINE 會打開你的官方帳號的聊天室，訊息已經幫你打好，按送出就好。</p>
          <p class="ln-qr__alt">正在用手機看這頁？<a :href="code.bindUrl" class="ln-qr__link">直接打開 LINE</a></p>
          <a :href="code.bindUrl" class="el-button el-button--primary ln-qr__mobile-open">打開 LINE 加進來</a>
        </template>
        <!-- 拿不到官方帳號 ID（沒有「訊息已打好」的連結）：退回照打那一行 -->
        <template v-else>
          <h4 class="ln-qr__title">在手機上傳這行字給你的官方帳號</h4>
          <div class="member-bind-code">
            <code>{{ code.message }}</code>
            <el-button size="small" plain @click="copyMessage">{{ copied ? '已複製' : '複製' }}</el-button>
          </div>
        </template>
        <div class="ln-qr__wait"><span class="ln-qr__dot" />等你在手機上按送出…</div>
        <el-button class="ln-qr__cancel" size="small" text @click="$emit('cancel')">先不用</el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 「把我的手機加進來」（`D-103`④，2026-09-27）：「設定 → LINE 通知」頁與首頁那張卡共用。
 *
 * 流程：幫自己產一組綁定碼（連 QR）→ 手機相機掃 → LINE 打開、訊息已打好 → 按送出
 * → 後端綁好＋加進名單＋回他一則確認 → 這裡每 2.5 秒問一次，綁好就 `done`（⛔ 不要「我完成了」鈕）。
 *
 * ⚠️ 判斷「這次綁好了」看的是**綁定時間晚於這組碼產生的時間**，不是「有沒有綁」——
 *    換手機的人本來就綁著，只看 bound 會一開面板就判成完成。
 * ⚠️ 碼 10 分鐘過期：面板還開著就自動換一組新的（人還在掃，不該叫他按「重新產生」）。
 * ⛔ 等了 15 分鐘還沒好就停止輪詢、講一句話，不無限打 API。
 */
const emit = defineEmits<{
  /** `message`＝他剛從手機送出的那一行（「綁定 A3F9K2」），頁面上的手機預覽拿來畫那一來一回 */
  done: [status: { lineDisplayName: string, linePictureUrl: string, message: string }]
  cancel: []
}>()

interface SelfCode { code: string, expiresAt: number, message: string, bindUrl: string, qrDataUrl: string }
interface SelfStatus { bound: boolean, boundAt: number, lineDisplayName: string, linePictureUrl: string }

const BIND_CODE_TTL_MS = 10 * 60 * 1000
const POLL_MS = 2500
const GIVE_UP_MS = 15 * 60 * 1000

const { apiFetch, workspaceId } = useWorkspace()
const state = ref<'loading' | 'qr' | 'error'>('loading')
const errorText = ref('')
const code = ref<SelfCode>({ code: '', expiresAt: 0, message: '', bindUrl: '', qrDataUrl: '' })
const copied = ref(false)

/** 這組碼在伺服器上產生的時間（用伺服器給的到期時間往回推，不吃本機時鐘） */
let issuedServerMs = 0
/** 本機時鐘上「該換新碼」的時間點 */
let refreshAtLocal = 0
let startedAtLocal = 0
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function issue() {
  state.value = 'loading'
  try {
    const res = await apiFetch<SelfCode>(`/api/admin/workspaces/${workspaceId.value}/line-notify/self-code`, { method: 'POST' })
    code.value = res
    issuedServerMs = res.expiresAt - BIND_CODE_TTL_MS
    refreshAtLocal = Date.now() + BIND_CODE_TTL_MS - 15_000
    if (!startedAtLocal) startedAtLocal = Date.now()
    state.value = 'qr'
    schedule()
  }
  catch (e: any) {
    state.value = 'error'
    errorText.value = e?.data?.statusMessage || '準備不起來，請再試一次。'
  }
}

/**
 * 「再試一次」：15 分鐘的等候從現在重新算（`C-271`⑤）。
 * ⛔ 不重設的話，等滿 15 分鐘放棄之後，這顆鈕每按一次都在 2.5 秒後又判成「等太久」，永遠沒用。
 */
function retry() {
  startedAtLocal = 0
  stopped = false
  void issue()
}

function schedule() {
  if (timer) clearTimeout(timer)
  if (stopped) return
  timer = setTimeout(poll, POLL_MS)
}

async function poll() {
  if (stopped) return
  if (Date.now() - startedAtLocal > GIVE_UP_MS) {
    state.value = 'error'
    errorText.value = '等了一陣子還沒收到。確認手機上有按送出，再試一次。'
    return
  }
  try {
    const s = await apiFetch<SelfStatus>(`/api/admin/workspaces/${workspaceId.value}/line-notify/self-status`)
    // 綁定時間比這組碼新＝這次掃的（換手機的人本來就是 bound，不能只看 bound）
    if (s.bound && s.boundAt >= issuedServerMs - 5_000) {
      stopped = true
      emit('done', { lineDisplayName: s.lineDisplayName, linePictureUrl: s.linePictureUrl, message: code.value.message })
      return
    }
  }
  catch { /* 一次問不到就下一輪再問；15 分鐘後統一收尾 */ }
  if (Date.now() >= refreshAtLocal) {
    await issue()
    return
  }
  schedule()
}

async function copyMessage() {
  try {
    await navigator.clipboard.writeText(code.value.message)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
  catch { /* 複製不了就讓他自己選那行字 */ }
}

onMounted(issue)
onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
})
</script>
