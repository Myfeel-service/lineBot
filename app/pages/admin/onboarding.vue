<template>
  <div class="onbc-page">
    <!-- 非管理員（被邀請的 agent / viewer）：不給假按鈕，如實說要請管理員做（2026-08-07 拍板） -->
    <div v-if="mode === 'locked'" class="onb-card">
      <div class="onb-head">
        <BrandLogo mark class="onb-mark" />
        <h1>請管理員完成接線</h1>
        <p class="onb-sub">接 LINE 憑證與 AI 設定需要管理員權限。你可以先進後台看看，管理員可以從右下角小幫手的「用聊天引導完成開通」接著做。</p>
      </div>
      <el-button type="primary" class="onb-primary-btn" @click="goWorkspace">先進後台看看</el-button>
      <div class="onb-foot">
        <NuxtLink to="/admin/workspaces">回帳號選擇</NuxtLink>
      </div>
    </div>

    <!-- 對話式開通引導 -->
    <div v-else class="onbc-shell">
      <header class="onbc-head">
        <BrandLogo mark class="onbc-mark" />
        <div class="onbc-head__text">
          <span class="onbc-head__title">開通引導</span>
          <span class="onbc-head__sub">小幫手陪你把設定做完</span>
        </div>
        <!-- 完成畫面（progress 走到最後一格）不再給「之後再說」（2026-08-28 拍板）：
             都做完了，沒有東西可以「之後再說」，那句話在這一頁語意是錯的。
             出口交給對話裡那排——「去看剛剛那則對話」才是這一刻講得對的說法。 -->
        <NuxtLink v-if="progress < ONBOARDING_PROGRESS_LABELS.length - 1" class="onbc-exit" :to="exitTo">之後再說</NuxtLink>
      </header>

      <div class="onbc-progress" aria-hidden="true">
        <div
          v-for="(label, i) in ONBOARDING_PROGRESS_LABELS"
          :key="label"
          class="onbc-step"
          :class="{ 'is-done': i < progress, 'is-current': i === progress }"
        >{{ label }}</div>
      </div>

      <div ref="listEl" class="onbc-chat" aria-live="polite">
        <AgentMessageRenderer v-for="e in entries" :key="e.id" :entry="e" />
        <div v-if="typing" class="agm-msg agm-msg--agent">
          <div class="agm-bubble agm-typing"><i /><i /><i /></div>
        </div>
        <!-- 選項鈕跟著對話長在最新訊息下面（LINE 快速按鈕位置）；輸入格才留在底部 dock -->
        <AgentChoiceChips :ask="ask" :busy="busy" @choice="onChoice" />
      </div>

      <AgentAskDock
        :ask="ask"
        :busy="busy"
        @submit="onSubmit"
        @pick="onPick"
        @skip="onSkip"
      />
    </div>

    <AdminToastHost />
  </div>
</template>

<script setup lang="ts">
/**
 * 開通引導：由 agent 用聊天方式帶完「能上線」的設定。
 * 劇本與狀態機在 useOnboardingChat（零 LLM，完成判定全靠後端真實訊號）；
 * 規格：docs/ONBOARDING-CHAT-DESIGN-20260807.md。
 *
 * 兩種進場：
 * - 無參數＝全新開通（聊天中建 org + workspace，建完不導走、同一場對話接 LINE）
 * - ?workspaceId=＝續走（健康卡「用聊天引導完成開通」進來），做過的步驟靜默跳過
 */
definePageMeta({ middleware: 'auth', layout: false })
useHead({ title: '開通引導 — 小幫手' })

const route = useRoute()
const { showToast } = useAdminToast()
const { ensureWorkspaceList, roleFor } = useWorkspace()

const continueWid = computed(() => String(route.query.workspaceId || '').trim())
const mode = ref<'chat' | 'locked'>('chat')

const {
  entries, ask, typing, busy, progress, activeWorkspaceId,
  onChoice, onSubmit, onPick, onSkip,
  start, dispose,
} = useOnboardingChat()

// 「之後再說」：帳號一旦建好（或續走模式），直接進那個帳號的後台，不繞回帳號選擇頁。
// 出口一律走 onboardingLandingPath（對話頁）——新帳號統計全 0，空的對話清單比空報表誠實（G-11 同一拍板）
const exitTo = computed(() => {
  const target = continueWid.value || activeWorkspaceId.value
  return target ? onboardingLandingPath(target) : '/admin/workspaces'
})

function goWorkspace() {
  return navigateTo(onboardingLandingPath(continueWid.value))
}

// 人已經在開通頁＝這一輪載入不需要再被「自動拉回開通」提醒。
// 不記的話：按「之後再說」出去 → 版型掛載 → 又被抓回來，要按兩次才逃得掉。
const onboardingPopped = useState<Record<string, boolean>>('onb-auto-popped', () => ({}))
watch([() => continueWid.value, activeWorkspaceId], ([cw, aw]) => {
  for (const w of [cw, aw]) {
    if (w && !onboardingPopped.value[w])
      onboardingPopped.value = { ...onboardingPopped.value, [w]: true }
  }
}, { immediate: true })

const listEl = ref<HTMLElement | null>(null)
watch([() => entries.value.length, typing, ask], () => {
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight }))
})

onMounted(async () => {
  if (!continueWid.value) {
    void start()
    return
  }
  // 續走模式：/admin/onboarding 不在 auth middleware 的 workspace 檢查範圍內，
  // 這裡自己驗「這個帳號是不是你的、你能不能動設定」
  const { loaded } = await ensureWorkspaceList()
  if (!loaded) {
    showToast('連不上伺服器，請稍後再試', 'error')
    return navigateTo('/admin/workspaces', { replace: true })
  }
  const role = roleFor(continueWid.value)
  if (!role) {
    showToast('你沒有這個官方帳號的權限，已回到帳號選擇頁', 'error')
    return navigateTo('/admin/workspaces', { replace: true })
  }
  if (role !== 'owner' && role !== 'admin') {
    mode.value = 'locked'
    return
  }
  void start(continueWid.value)
})

onUnmounted(dispose)
</script>

<!-- 樣式：app/assets/scss/pages/_onboarding.scss（onbc- 區段）＋ components/_agent-chat.scss -->
