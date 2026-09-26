<template>
  <div v-if="show" class="ln-invite" :class="{ 'is-done': phase === 'done' }" data-tour="ln-invite">
    <template v-if="phase === 'done'">
      <h4 class="ln-invite__title">好了，你的 LINE「{{ doneName }}」加進來了</h4>
      <p class="ln-invite__text">
        手機剛收到一則確認。想關掉，到<NuxtLink :to="`/admin/${workspaceId}/settings/line-notify`" class="admin-inline-link">「設定 → LINE 通知」</NuxtLink>。
      </p>
    </template>
    <template v-else>
      <h4 class="ln-invite__title">客人要找真人時，要傳到你的手機嗎？</h4>
      <p class="ln-invite__text">還有每天早上的摘要。用手機掃一下就好，之後隨時可以關。</p>
      <div v-if="phase === 'ask'" class="ln-invite__actions">
        <el-button type="primary" size="small" @click="phase = 'scan'">用手機掃 QR 加進來</el-button>
        <el-button size="small" plain @click="dismiss">先不用</el-button>
      </div>
      <AdminLineNotifySelfAdd v-else @done="onDone" @cancel="phase = 'ask'" />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 首頁（對話統計）最上面那張卡（`D-103`⑧，2026-09-27）：還沒把手機加進 LINE 通知的成員，登入時問一次。
 *
 * 為什麼要有：原本同事要收通知，得等管理員在成員管理產碼、用別的管道傳給他、他送出、
 * 管理員再去 AI 設定勾一次——正式資料上 MYFEEL 4 位客服七週都沒走完。現在他自己登入就會被問。
 *
 * 出現條件（全部成立才出現）：客服以上、是這個帳號的成員、還沒綁、官方帳號已接上 LINE、沒按過「先不用」。
 * ⛔ 不做成自動跳出的面板：會蓋住首頁本來的內容（老闆 09-25 抓過同一種問題）。
 * ⛔ 狀態還沒問到之前不顯示任何東西（「不知道」不可以當成「還沒綁」就先亮出來）。
 */
interface SelfStatus {
  isMember: boolean
  bound: boolean
  inviteDismissed: boolean
  lineConnected: boolean
}

const { apiFetch, workspaceId, can } = useWorkspace()
const status = ref<SelfStatus | null>(null)
const phase = ref<'ask' | 'scan' | 'done'>('ask')
const doneName = ref('')
const dismissed = ref(false)

const show = computed(() => {
  if (dismissed.value) return false
  if (phase.value !== 'ask') return true
  const s = status.value
  return Boolean(s && s.isMember && !s.bound && s.lineConnected && !s.inviteDismissed)
})

async function load() {
  if (!can('notify.self')) return
  try {
    status.value = await apiFetch<SelfStatus>(`/api/admin/workspaces/${workspaceId.value}/line-notify/self-status`)
  }
  catch { /* 問不到就不出現：這張卡是邀請，不是警報 */ }
}

function onDone(s: { lineDisplayName: string }) {
  doneName.value = s.lineDisplayName || '你'
  phase.value = 'done'
}

async function dismiss() {
  dismissed.value = true
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/line-notify/dismiss-invite`, { method: 'POST' })
  }
  catch { /* 記不起來頂多下次再問一次 */ }
}

onMounted(load)
</script>
