<template>
  <div class="login-page">
    <div class="login-card">
      <!-- Logo：品牌名在 logotype 圖裡，h1 留著才有頁面標題語意（alt 就是品牌名）。
           2026-09-10 `D-74`：logotype 包成連回首頁的連結（BrandLogo 預設 alt＝品牌名，
           讀出來就是「MiniMe，連結」＝全站通用慣例，h1 的標題語意不變）。 -->
      <div class="login-logo">
        <h1 class="login-brand"><NuxtLink to="/"><BrandLogo /></NuxtLink></h1>
        <!--
          招呼語分兩種人（2026-09-10 `D-74` 老闆拍板 A 案）：
          ① 門面「免費打造／免費註冊」按進來的（`?intent=start`）——用他**剛按的那句話**
             接住他，並把「登入完還要做什麼」講完。原本這裡第一行寫「管理後台」，
             人還沒建任何東西就被帶到「後台」＝像走進員工入口。
          ② 裸 `/login`（導覽列「登入」、書籤、middleware 轉址）——維持原本的中性文案。
          ⛔ 兩邊的字都不要各自發明：intent 那組沿用首頁 CTA 與 `#fast` 區**已拍板的字**
             （「免費打造我的 MiniMe」／「用 Google 帳號登入」＋「不用另外設密碼」／
             「幫你的 MiniMe 取個名字」／「免費方案不用綁卡」），改首頁要一起改。
          ⚠️ 全站唯一講「用 Google 帳號登入、不用另外設密碼」的是 `#fast` 區，而它
             2026-09-08 起整區隱藏（`SHOW_FAST_SECTION`）＝客人現在是到這一頁才第一次
             知道要用 Google 帳號，所以這句話在這裡不是重複、是唯一一次。
        -->
        <template v-if="isStart">
          <p class="login-title">免費打造我的 {{ brandName }}</p>
          <p class="login-step">第一步：用 Google 帳號登入，不用另外設密碼</p>
        </template>
        <p v-else>管理後台 · 使用 Google 帳號登入</p>
      </div>

      <!-- Error -->
      <div v-if="errorMsg" class="login-error">
        {{ errorMsg }}
      </div>

      <!-- Login Button -->
      <button
        class="btn-google"
        :disabled="loading"
        @click="handleLogin"
      >
        <span v-if="loading" class="spinner" />
        <svg v-else width="18" height="18" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
        </svg>
        使用 Google 登入
      </button>

      <!-- 註冊那條路：按鈕底下先講**下一步是什麼**。他按下去之前最後一個顧慮是
           「登入完會不會就要給卡號、要弄多久」，這一行就是那個問題的答案，
           而且跟首頁承諾的「兩步 · 60 秒」對得上（登入＋取名字）。
           ⛔「免費方案不用綁卡」不可拿掉：首頁按鈕底下那行也是這句。 -->
      <p v-if="isStart" class="login-next">
        接著幫你的 {{ brandName }} 取個名字，帳號就開好了<b>免費方案不用綁卡</b>
      </p>

      <!--
        登入頁要同時服務三種人：想開始用的新客、被團隊邀請的成員、想先了解的人。
        原本只寫「邀請制」會把新客擋在門外；改成中性歡迎語，登入後的迎賓頁再分流
        （見 admin/workspaces.vue 空狀態）。
        ⚠️ 2026-09-10 `D-74`：`?intent=start` 進來的人已經在上面被講過「登入完要做什麼」，
           這裡只留受邀成員那半句——把「第一次使用？登入後可以建立…」再講一次
           會變成同一件事說兩遍（而且他按的按鈕就是那個意思）。
      -->
      <p v-if="isStart" class="login-hint">被團隊邀請的話，用受邀的 Google 信箱登入即可。</p>
      <p v-else class="login-hint">第一次使用？登入後可以建立自己的官方帳號空間。被團隊邀請的話，用受邀的 Google 信箱登入即可。</p>
      <p v-if="contactHref" class="login-hint">
        想先了解？<a :href="contactHref" target="_blank" rel="noopener" class="login-contact">聯繫我們 / 預約 Demo →</a>
      </p>

      <!-- 退路（2026-09-10 `D-74`）：這一頁原本除了「聯繫我們」之外沒有任何路回門面，
           猶豫的人只剩瀏覽器上一頁。字與法務頁的 `.lp-legal__back` 同一句。 -->
      <NuxtLink class="login-back" to="/">← 回首頁</NuxtLink>
    </div>

    <!-- Background decorations -->
    <div class="bg-glow bg-glow-1" />
    <div class="bg-glow bg-glow-2" />
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

import { isSignupStartIntent, resolveLoginRedirect } from '~~/shared/signup-entry'

const route = useRoute()
const { loginWithGoogle, isLoggedIn, waitForAuthReady } = useAuth()
// 品牌名走 runtimeConfig（多租戶可覆寫），不寫死租戶名
const { brandName } = useSiteIdentity()

/**
 * 是不是從門面的「免費打造／免費註冊」按進來的（`?intent=start`，見 shared/signup-entry.ts）。
 * 只影響**招呼語與登入後落點**，不影響權限；裸 `/login` 一律維持原本的中性文案。
 */
const isStart = computed(() => isSignupStartIntent(route.query.intent))

// 不是客戶的人也會走到登入頁 → 給他一個不用登入就能走的出口
const config = useRuntimeConfig()
const contact = String(config.public.supportContact ?? '').trim()
const contactHref = contact
  ? (contact.startsWith('http') ? contact : `mailto:${contact}`)
  : ''
const loading = ref(false)
const errorMsg = ref('')

/**
 * 登入成功後去哪：`?redirect=` 優先（被 middleware 擋下來的人有明確目的地），
 * 其次是註冊意圖（把 `intent=start` 帶去帳號選擇頁，零帳號的人在那裡被直接送進開通引導），
 * 都沒有就是原本的帳號選擇頁。判斷本體與理由在 shared/signup-entry.ts（有測試釘住）。
 */
function loginRedirectTarget(): string {
  return resolveLoginRedirect(route.query)
}

// 已登入時離開登入頁（等 auth 就緒，避免重整流程誤觸）
onMounted(async () => {
  await waitForAuthReady()
  if (isLoggedIn.value) await navigateTo(loginRedirectTarget())
})

async function handleLogin() {
  loading.value = true
  errorMsg.value = ''
  try {
    await loginWithGoogle()
    await navigateTo(loginRedirectTarget())
  }
  catch (e: any) {
    // 使用者自己關掉/取消登入視窗 → 正常取消，不當成錯誤顯示
    const code = String(e?.code ?? '')
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return
    }
    const FRIENDLY: Record<string, string> = {
      'auth/network-request-failed': '網路連線不穩，請檢查網路後再試一次。',
      'auth/popup-blocked': '瀏覽器擋掉了登入視窗，請允許彈出視窗後再試。',
      'auth/unauthorized-domain': '此網域尚未被授權登入，請聯繫管理員。',
      'auth/user-disabled': '此帳號已被停用，請聯繫管理員。',
    }
    errorMsg.value = FRIENDLY[code] || '登入失敗，請重試。'
  }
  finally {
    loading.value = false
  }
}
</script>
