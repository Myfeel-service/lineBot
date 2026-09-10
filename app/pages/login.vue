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
        <p v-if="!isStart">管理後台 · 使用 Google 帳號登入</p>
      </div>

      <!-- 註冊那條路的招呼語＝**首頁的招牌裝置**（淡綠泡泡，`G-75`）：
           門面五個區塊的標題都是「MiniMe 說一句話」，搬過來這一頁才不會只是白卡上一排字。
           ⛔ 淡綠底＋深色字，**不是**綠底白字泡泡（那個試過兩次都被打槍）。
           ⚠️ 字沿用已拍板的那組（標題＝首頁 CTA 的同一句、小字＝`#fast` 區的「不用另外設密碼」）。

           ⭐ 2026-09-10 `G-76`：**頭像那顆綠磚拿掉了**（使用者：「是否把對話框旁邊的 logo 拿掉，
              因為上面就有 Logo 了」＋「有點偏一邊」）。量到的偏移＝logotype／按鈕／說明／小標／
              回首頁五塊都在中軸（0px），只有泡泡被 36px 頭像＋12px 間距推開 **+24px**、
              裡面的標題文字實際偏 **−40px**——一顆卡上六個東西置中、一個不置中。
           ⛔ 拿掉頭像之後**尾巴要移到泡泡正上方中央**（不是留在左邊指著空白）：
              上面那顆 logotype 就是說話的人，這樣「誰在說話」還是講得通。 -->
      <div v-if="isStart" class="entry-say">
        <div class="entry-say__bubble">
          <p class="entry-say__t">免費打造我的 {{ brandName }}</p>
          <!-- ⚠️「不用另外設密碼」包 `.entry-nb`：390px 實測它會被斷成「不用／另外設密碼」 -->
          <p class="entry-say__s">第一步：用 Google 帳號登入，<span class="entry-nb">不用另外設密碼</span></p>
        </div>
      </div>

      <!-- Error -->
      <div v-if="errorMsg" class="login-error">
        {{ errorMsg }}
      </div>

      <!-- 按鈕＋它的說明＝一組（`D-75`⑨ 的三層節奏之二）。
           ⚠️ `.entry-btn` 是與選帳頁共用的白色膠囊（`_entry-shell.scss`）＝首頁 `.lp-btn--white`
              的同一套語言；`D-75`⑧ 之前這顆是全卡**最輕**的元素，而它是這一頁唯一該按的東西。 -->
      <div class="login-main">
        <button
          class="entry-btn btn-google"
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
          接著幫你的 {{ brandName }} 取個名字，帳號就開好了
        </p>
        <!-- 「免費方案不用綁卡」＝安心小標（`G-75`）：沿用門面 `.lp-soon` 那顆 wash 標籤的做法，
             把一行粗體綠字變成一個做過設計的元素。⛔ 文字不可改（首頁按鈕底下那行也是這句）。 -->
        <span v-if="isStart" class="entry-chip">免費方案不用綁卡</span>
      </div>

      <!--
        頁尾＝一個出口（`G-73`：2026-09-10 使用者「這邊字很多，『想先了解』是否可以不用放這邊」）。

        ⛔ **移除了「想先了解？聯繫我們 / 預約 Demo →」**，理由三條：
          ① 走到這一頁的人**上一頁就是首頁**（八顆註冊鈕全部從那裡來），而首頁的收尾 CTA
             有「想先聊聊？寄信給我們」、頁尾有客服電話／信箱——按「回首頁」一步就回得去。
          ② 這一刻他要的是「按下去會怎樣」，不是「找人談」；那行還是全卡唯一跟主按鈕
             搶注意力的綠色連結。
          ③ 措辭本身**已經過期**：預約 Demo 表單 2026-08-14 整區移除，首頁同日改口徑成
             「寄信給我們」，這兩頁沒跟上（那行點下去其實只是開信件視窗）。
        ⚠️ 這**不是**首頁那條紅線（`index.vue` 收尾 CTA 的「想先聊聊」＝全頁唯一找人談的
           入口、⛔不可拿掉）；登入頁從來沒有那條拍板。
        ⚠️ 真的需要找人談的路徑仍在：回首頁→收尾 CTA／頁尾，以及**登入後**帳號選擇頁
           空狀態那行（那裡刻意保留：已經登入、零帳號、講「企業需求」＝真的銷售時機）。
        ⛔「← 回首頁」不可拿掉：移除上面那行之後，它是這一頁**唯一**的退路。

        受邀成員那半句：`?intent=start` 進來的人是**按了「免費打造」**的，不是被邀請的，
        而且他登入後會落在帳號選擇頁的三選一，那裡有「我是被邀請加入團隊的」＋信箱＋複製鈕
        （比這裡一句提示更有用）。所以 start 模式不再放這句；裸 `/login`（導覽列「登入」、
        書籤、middleware 轉址＝回訪客戶與受邀成員在走的路）保留完整那一句。
      -->
      <div class="login-foot">
        <p v-if="!isStart" class="login-hint">第一次使用？登入後可以建立自己的官方帳號空間。被團隊邀請的話，用受邀的 Google 信箱登入即可。</p>

        <p class="entry-foot">
          <NuxtLink class="entry-link entry-link--quiet" to="/">← 回首頁</NuxtLink>
        </p>
      </div>
    </div>
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

// ⚠️ `supportContact`（聯繫我們）2026-09-10 `G-73` 從這一頁移除＝這裡不再需要讀 runtimeConfig。
//    想找人談的入口在首頁（收尾 CTA＋頁尾）與登入後的帳號選擇頁空狀態，理由見上面 template 的註解。
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
