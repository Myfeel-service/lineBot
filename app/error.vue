<template>
  <div class="error-page">
    <div class="error-card">
      <div class="error-logo">
        <span class="logo-circle"><el-icon color="#fff"><ChatDotRound /></el-icon></span>
        <span class="error-brand">{{ brandName }} 管理後台</span>
      </div>

      <div class="error-icon" :class="`error-icon--${view.tone}`">
        <el-icon><component :is="view.icon" /></el-icon>
      </div>

      <h1 class="error-title">{{ view.title }}</h1>
      <p class="error-desc">{{ view.desc }}</p>

      <div class="error-actions">
        <el-button type="primary" @click="go(view.primary.to)">
          {{ view.primary.label }}
        </el-button>
        <el-button v-if="view.secondary" @click="view.secondary.action">
          {{ view.secondary.label }}
        </el-button>
      </div>

      <!-- 技術細節收起來：一般使用者不需要看，但客服請他截圖時要拿得到 -->
      <details v-if="detail" class="error-detail">
        <summary>技術細節（回報問題時附上這段）</summary>
        <code>{{ detail }}</code>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app'
import { ChatDotRound, Lock, QuestionFilled, WarningFilled } from '@element-plus/icons-vue'

/**
 * 全站錯誤頁。
 *
 * 在這個檔案存在之前，任何一個沒被接住的錯誤都是 Nuxt 內建的裸畫面
 * （「500 Internal Server Error」＋一行英文原文），使用者看不出那到底是
 * 「我沒有權限」、「網址打錯」還是「系統壞了」，也沒有任何回得去的路。
 * 這頁的工作就是把狀態碼翻成人話，並且一定給一個出口。
 */
const props = defineProps<{ error: NuxtError }>()

const { brandName } = useSiteIdentity()
const { logout } = useAuth()

useHead({ title: `${brandName} 管理後台` })

const status = computed(() => Number(props.error?.statusCode) || 500)
// message 與 statusMessage 兩邊都看：同一個錯誤在 SSR / client 兩條路上會落在不同欄位，
// 只讀一邊的話，「其實是登入狀態掉了」的線索有時候就被吃掉。
const rawMessage = computed(() => {
  const parts = [props.error?.message, props.error?.statusMessage]
    .map(s => String(s ?? '').trim())
    .filter(Boolean)
  // 兩個欄位常常是同一句話，去重後才不會在技術細節裡看到重複兩次
  return [...new Set(parts)].join(' ')
})

/** Firebase auth 的原文（auth/xxx）翻成人話；也用來判斷「其實是登入狀態掉了」。 */
const AUTH_HINTS: Array<{ code: string; desc: string }> = [
  { code: 'auth/network-request-failed', desc: '網路連線不穩，讀不到你的登入狀態。請確認網路後重新登入。' },
  { code: 'auth/user-token-expired', desc: '登入狀態已經過期，請重新登入。' },
  { code: 'auth/invalid-user-token', desc: '登入狀態已失效，請重新登入。' },
  { code: 'auth/user-disabled', desc: '這個帳號已被停用，請聯繫管理員。' },
]
const authHint = computed(() => AUTH_HINTS.find(h => rawMessage.value.includes(h.code)) ?? null)

async function reLogin() {
  // 先清掉錯誤狀態再登出，否則錯誤頁會蓋在導頁之上
  await clearError()
  await logout()
}

function reload() {
  if (import.meta.client) window.location.reload()
}

const BACK_TO_WORKSPACES = { label: '回帳號選擇頁', to: '/admin/workspaces' }

const view = computed(() => {
  const relogin = { label: '重新登入', action: reLogin }

  if (authHint.value) {
    return {
      tone: 'warn' as const,
      icon: Lock,
      title: '請重新登入一次',
      desc: authHint.value.desc,
      primary: BACK_TO_WORKSPACES,
      secondary: relogin,
    }
  }

  if (status.value === 401 || status.value === 403) {
    return {
      tone: 'warn' as const,
      icon: Lock,
      title: '你沒有這個頁面的權限',
      desc: '這一頁需要更高的權限，或者你不是這個官方帳號的成員。回到帳號選擇頁，挑一個你有權限的帳號；如果應該有權限，請管理員把你加進成員。',
      primary: BACK_TO_WORKSPACES,
      secondary: relogin,
    }
  }

  if (status.value === 404) {
    return {
      tone: 'info' as const,
      icon: QuestionFilled,
      title: '找不到這個頁面',
      desc: '網址可能打錯了，或這個頁面已經搬家。從帳號選擇頁重新進入後台就可以了。',
      primary: BACK_TO_WORKSPACES,
      secondary: { label: '回首頁', action: () => go('/') },
    }
  }

  return {
    tone: 'error' as const,
    icon: WarningFilled,
    title: '系統出了一點問題',
    desc: '這不是你操作錯誤。重新載入通常就會恢復；如果一直這樣，請把下面的技術細節截圖給我們。',
    primary: BACK_TO_WORKSPACES,
    secondary: { label: '重新載入', action: reload },
  }
})

const detail = computed(() => {
  const parts = [`${status.value}`]
  if (rawMessage.value) parts.push(rawMessage.value)
  const url = (props.error as { url?: string })?.url
  if (url) parts.push(url)
  return parts.join(' · ')
})

function go(to: string) {
  return clearError({ redirect: to })
}
</script>
