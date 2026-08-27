<template>
  <div v-if="show" class="quota-banner" :class="`quota-banner--${state.state}`" :role="state.state === 'over' ? 'alert' : 'status'">
    <span class="quota-banner__icon"><el-icon><component :is="state.state === 'over' ? CircleCloseFilled : WarningFilled" /></el-icon></span>

    <div class="quota-banner__body">
      <p class="quota-banner__title">{{ title }}</p>
      <!-- 重點是「用完會怎樣」，不是剩幾則。「剩 40 則」對客戶沒有意義，
           「用完後 AI 就不再自動回覆、客人全部轉給真人」才會讓人想升級。 -->
      <p class="quota-banner__desc">{{ desc }}</p>
    </div>

    <div class="quota-banner__actions">
      <el-button type="primary" size="small" @click="upgradeOpen = true">升級方案</el-button>
      <!-- 已經停止回覆時不給關閉：那是服務中斷，不是提醒 -->
      <el-button v-if="state.state === 'near'" size="small" text @click="dismiss">稍後再說</el-button>
    </div>

    <AdminPlanUpgradeDialog v-model="upgradeOpen" :current-plan-id="plan?.id ?? null" />
  </div>
</template>

<script setup lang="ts">
import { CircleCloseFilled, WarningFilled } from '@element-plus/icons-vue'
/**
 * 額度快用完 / 已用完的升級提示。
 *
 * 「免費額度用到 80%」是整個產品裡**轉換率最高的時機**——客人正在用、正覺得有用、
 * 正要不夠用。在那之前推銷是賣空氣，在那之後才推就已經斷線了。
 *
 * 顯示規則：
 *   · 只給**按得下升級鈕的人**看（admin 以上）。客服 / 觀察者看到也沒辦法處理，純噪音。
 *   · `near`（≥80%）→ 警告，可關閉（關閉只對「這個帳號的這一期」有效，下一期會再出現）。
 *   · `over`（100%）→ **不可關閉**。那不是提醒，那是 AI 已經停止回覆的服務中斷。
 *   · 客製 / 內部方案（無額度上限）→ 永遠不顯示。
 *   · 帳單頁本身不顯示（升級按鈕就在那頁上，再掛一條橫幅只是噪音）。
 */
const route = useRoute()
const { workspaceId, canManageSettings } = useWorkspace()
const { plan, state, load } = usePlanSummary()

const upgradeOpen = ref(false)
const dismissed = ref(false)

/** 關閉只針對「這個官方帳號的這一期」——下一期額度重置後要重新提醒。 */
const dismissKey = computed(() =>
  `quota-dismiss:${workspaceId.value}:${plan.value?.currentPeriodStart ?? ''}`,
)

const onBillingPage = computed(() => route.path.includes('/settings/billing'))

const show = computed(() => {
  if (!canManageSettings.value || onBillingPage.value) return false
  if (!plan.value || plan.value.answeredQuota == null) return false // 客製 / 內部方案：無上限
  if (state.value.state === 'over') return true // 服務已中斷 → 一律顯示，不理會關閉
  return state.value.state === 'near' && !dismissed.value
})

const title = computed(() => {
  if (state.value.state === 'over') return 'AI 已停止自動回覆'
  return `本期額度只剩 ${state.value.remaining?.toLocaleString() ?? 0} 則`
})

// ⚠️ 文案要準確：額度用完時**規則與腳本照常運作**，只有「原本由 AI 接手回答」的訊息
//    才會改成轉真人（見 server/utils/ai-answer.ts 的 quota 護欄）。寫成「所有訊息都轉真人」
//    會誇大，而客戶一用就會發現不是那樣——嚇唬人換來的升級，換來的是不信任。
const desc = computed(() => {
  const used = state.value.used.toLocaleString()
  const limit = state.value.limit?.toLocaleString() ?? ''
  if (state.value.state === 'over') {
    return `本期 ${limit} 則已用完。自動回覆與腳本仍正常運作，但需要 AI 回答的問題現在都會轉給真人客服。升級後立即恢復。`
  }
  return `本期已用 ${used} / ${limit} 則。用完後需要 AI 回答的問題會改為轉給真人客服（自動回覆與腳本不受影響）。`
})

function dismiss() {
  dismissed.value = true
  // 沒有本期起日就沒有穩定的鍵可用——這時寧可不記住「關閉」，也不要寫進一個
  // 沒有期別的鍵（`quota-dismiss:{ws}:`）：那會讓他關掉一次之後，**每一期都不再提醒**。
  if (!plan.value?.currentPeriodStart) return
  try {
    localStorage.setItem(dismissKey.value, '1')
  }
  catch { /* 無痕模式等情況：關不掉就下次再顯示，不是什麼大事 */ }
}

/** 已經為「哪個官方帳號」問過方案了。⛔不能只記 true/false：切帳號要重新問（見下面 watch） */
const loadedFor = ref('')

/**
 * ⚠️ **不能用 onMounted 判斷權限。**
 * canManageSettings 是從 workspaceList 導出的，而那份清單是由 layout 的 onMounted 去載的——
 * Vue 的子元件 onMounted **早於**父層 layout 的 onMounted，所以這裡在掛載當下看到的
 * 永遠是「還沒有權限」，然後就直接 return、永遠不載入，整個橫幅形同不存在。
 * 改成 watch：等權限真的出現時才打 API（只打一次）。
 */
/**
 * ⛔ 也要跟著 workspaceId 重載，不能只在「權限出現時」載一次。
 * 這個元件掛在 layout 上、切帳號時不會重新掛載：只載一次的話，切過去之後
 * `usePlanSummary` 的帳號戳記對不上（那道戳記是為了不把 A 家的方案顯示在 B 家），
 * 於是這條橫幅整條消失——B 家額度已經 100%、AI 停止回覆了卻沒有任何提示。
 */
watch([canManageSettings, workspaceId], async ([can, wid], [, prevWid]) => {
  if (!can) return // 沒有計費權限的人不必打這支（plan-summary 需要 admin，打了只會拿到 403）
  if (wid !== prevWid) loadedFor.value = '' // 換帳號＝要重新問一次
  if (!wid || loadedFor.value === wid) return
  loadedFor.value = wid
  await load()
  try {
    dismissed.value = localStorage.getItem(dismissKey.value) === '1'
  }
  catch { /* ignore */ }
}, { immediate: true })
</script>
