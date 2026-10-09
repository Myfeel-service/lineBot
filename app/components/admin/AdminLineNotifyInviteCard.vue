<template>
  <div v-if="show" class="ln-invite" :class="{ 'is-done': phase === 'done', 'is-warn': phase === 'notAdded' }" data-tour="ln-invite">
    <template v-if="phase === 'done'">
      <h4 class="ln-invite__title">好了，你的 LINE「{{ doneName }}」加進來了</h4>
      <p class="ln-invite__text">
        手機剛收到一則確認。想關掉，到<NuxtLink :to="`/admin/${workspaceId}/settings/line-notify`" class="admin-inline-link">「設定 → LINE 通知」</NuxtLink>。
      </p>
    </template>
    <!-- 綁好了卻沒進名單（`C-271`⑨）：⛔ 不可以照樣說「加進來了」，手機收到的是「沒有加進去」 -->
    <template v-else-if="phase === 'notAdded'">
      <h4 class="ln-invite__title">綁好了，但你的手機還沒收通知</h4>
      <p class="ln-invite__text">
        {{ notAddedFull ? '通知名單滿了（最多 10 位），請管理員關掉一位。' : '剛剛沒存進通知名單。' }}
        到<NuxtLink :to="`/admin/${workspaceId}/settings/line-notify`" class="admin-inline-link">「設定 → LINE 通知」</NuxtLink>把你那一列的「收通知」打開就好。
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
  receiving: boolean
  full: boolean
  inviteDismissed: boolean
  lineConnected: boolean
}

const { apiFetch, workspaceId, can } = useWorkspace()
const status = ref<SelfStatus | null>(null)
const phase = ref<'ask' | 'scan' | 'done' | 'notAdded'>('ask')
const doneName = ref('')
const notAddedFull = ref(false)
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

/** 綁好之後再問一次「真的進名單了沒」，照實講（名單滿／寫入失敗時手機收到的是「沒有加進去」） */
async function onDone(s: { lineDisplayName: string }) {
  doneName.value = s.lineDisplayName || '你'
  try {
    const now = await apiFetch<SelfStatus>(`/api/admin/workspaces/${workspaceId.value}/line-notify/self-status`)
    if (!now.receiving) {
      notAddedFull.value = now.full
      phase.value = 'notAdded'
      return
    }
  }
  catch { /* 問不到就照綁定成功講——那一刻手機已經收到確認訊息，講錯的代價比沉默小 */ }
  phase.value = 'done'
}

/**
 * 卡片真的出現在他眼前時記一下（`D-119` 拍板 B）：「設定 → LINE 通知」那一列才講得出
 * 他是「看過邀請還沒加」還是「根本沒看過」。⛔ 只在狀態問到、確定要顯示的那一刻記，
 * 「還不知道」不算看過；一次掛載只記一次。
 */
let seenRecorded = false
watch(show, (visible) => {
  if (!visible || seenRecorded || phase.value !== 'ask') return
  seenRecorded = true
  apiFetch(`/api/admin/workspaces/${workspaceId.value}/line-notify/invite-seen`, { method: 'POST' })
    .catch(() => { /* 記不起來只是那一列少一句，不影響他加手機 */ })
})

async function dismiss() {
  dismissed.value = true
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/line-notify/dismiss-invite`, { method: 'POST' })
  }
  catch { /* 記不起來頂多下次再問一次 */ }
}

onMounted(load)
</script>
