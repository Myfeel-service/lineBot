<template>
  <div v-if="rows.length || showOnboardingBand" class="page-alert-strip" role="alert">
    <!-- 開通帶（2026-08-27 老闆拍板「加碼」）：開通沒完成時原本整條消失＝每一頁只剩
         誤導的 0，唯一訊號躲在右下角紅點。改成顯示**單一條**開通帶——只有一條、
         不逐項列（與 08-26「開通期側欄不整排亮」同一把尺：一多就變裝飾）。 -->
    <div v-if="showOnboardingBand" class="page-alert is-critical">
      <span class="page-alert__icon"><el-icon><Link /></el-icon></span>
      <div class="page-alert__main">
        <p class="page-alert__title">{{ onboardingBand.title }}</p>
        <p class="page-alert__detail">{{ onboardingBand.detail }}</p>
      </div>
      <el-button
        class="page-alert__action"
        size="small"
        type="danger"
        @click="goOnboarding"
      >
        帶我完成開通
      </el-button>
    </div>
    <div
      v-for="r in visibleRows"
      :key="r.alert.id"
      class="page-alert"
      :class="`is-${toneOf(r.alert)}`"
    >
      <span class="page-alert__icon"><el-icon><component :is="r.alert.icon" /></el-icon></span>
      <div class="page-alert__main">
        <p class="page-alert__title">{{ rowTitle(r.alert) }}</p>
        <p class="page-alert__detail">{{ rowDetail(r.alert) }}</p>
      </div>
      <!-- 「幫我修」（D-34）：一鍵修確認 popup。實心＝主要動作；「帶我看」退居 plain。
           popup 會先講「會動哪幾筆」再等人按確定，所以這顆按了不會直接改任何東西 -->
      <el-button
        v-if="r.alert.fixOpId"
        class="page-alert__action"
        size="small"
        :type="toneOf(r.alert) === 'critical' ? 'danger' : 'warning'"
        @click="openFix(r.alert)"
      >
        幫我修
      </el-button>
      <el-button
        v-if="rowActionLabel(r)"
        class="page-alert__action"
        size="small"
        plain
        :type="toneOf(r.alert) === 'critical' ? 'danger' : 'warning'"
        @click="go(r)"
      >
        {{ rowActionLabel(r) }}
      </el-button>
    </div>

    <!-- 六輪：多件事只展開最嚴重那件，其餘收成一行（老闆：「超過一個時佔畫面很大」）。
         真按鈕不是裝飾——鍵盤也要收得回去 -->
    <button
      v-if="collapsibleCount > 0"
      type="button"
      class="page-alert-strip__more"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <template v-if="!expanded">{{ moreLabel }}</template>
      <template v-else>收合，只顯示最重要的 ▴</template>
    </button>
  </div>
</template>

<script setup lang="ts">
import { Link } from '@element-plus/icons-vue'
import type { ResolvedAlert } from '~/composables/useWorkspaceAlerts'

/**
 * 頁面級提醒條（2026-08-27，D-33 二〜四輪——老闆實看後的三次回饋）。
 *
 * 二輪：點只回答「去哪一頁」，人到了頁面沒有東西接手 → 這條掛在 layout，
 * 每一頁的提醒都在同一個位置、同一個長相。
 * 三輪：本頁上按「去看」＝原地重整 → 按鈕優先序改「有能解決它的區塊就聚光燈帶過去」。
 * 四〜五輪：視覺定調＝**滿版貼齊的系統橫帶**（GitHub 那種），不是版面中的卡片——
 * 老闆抓到卡片「不 float、不 fixed、寬度又不拉滿」三不像。⚠️五輪同時否決了四輪的
 * 「頁面自己有呈現就閉嘴」（presents 抑制）：**進來第一眼就要看得到問題在哪**，
 * 頁內有重複呈現沒關係——橫帶負責第一眼，「帶我看」負責指到那個區塊。
 *
 * 按鈕的優先序（三輪拍板）：
 * 1. 異常掛了 `anchor` 且那個區塊在本頁存在 → 「帶我看」：el-tour 聚光燈，零重整。
 * 2. 深連結指到**別頁** → SPA 導航（deep-link 會在對方 onMounted 生效）。
 * 3. 深連結指到本頁、帶 query、又沒錨點可亮 → 整頁重載（deep-link 只在 onMounted
 *    讀 query——這是退路不是首選）；本頁自己、無 query、無錨點 → 不給按鈕。
 *
 * 資料紀律不變：吃 `alertsForPath`＝與側欄的點同一個展開；沒事整條不出現；
 * 開通沒做完不顯示。⛔別在頁內另刻異常提醒，有異常訊號的一律走這條。
 */
const route = useRoute()
const { alertsForPath, refresh } = useWorkspaceAlerts()
const { onboardingIncomplete, loaded: setupLoaded, onboardingBand } = useSetupStatus()
const { workspaceId } = useWorkspace()
const { startAdHocTour } = useTutorial()
const { openFix } = useAlertFix()

const rows = computed(() => {
  // 開通沒做完：營運異常量不出來也不成立，異常列不出——但**不再整條消失**，
  // 由上面的開通帶接手講真話（否則每一頁都是一片誤導的 0，見 showOnboardingBand）
  if (!setupLoaded.value || onboardingIncomplete.value)
    return []
  return alertsForPath(route.path)
})

/**
 * 開通帶（2026-08-27 老闆拍板）：開通沒完成時，每一頁同位置顯示一條「開通還沒完成」。
 * 起因＝小貓商店實測：什麼都沒接的帳號進後台一片祥和，統計頁還勸人「放寬到近 90 天」
 * ——0 技術上正確、語意上誤導。紅色沿用 08-07 拍板「還沒上線本身就是大問題＝紅、講後果」。
 * onboardingIncomplete 只看「接 LINE＋收到第一則」且限 admin（useSetupStatus 檔內有為什麼），
 * 所以文案能安心講 LINE；agent／viewer 看不到帶（他們也修不了）。
 * ⛔開通引導頁（/admin/onboarding）是 layout:false，不會出現這條，不用另外排除。
 *
 * 那兩句話（接上了沒／還差測試）住在 useSetupStatus.onboardingBand：側欄那顆點滑過去
 * 講的是同一件事，措辭要同一份（同日加的那顆點，見 utils/nav-alert-dot.ts 規則 3）。
 */
const showOnboardingBand = computed(() => setupLoaded.value && onboardingIncomplete.value)
function goOnboarding() {
  void navigateTo(`/admin/onboarding?workspaceId=${workspaceId.value}`)
}

/**
 * 摺疊（D-33 六〜七輪）：**紅色永不收合**（正在影響客人的事沒有「先別看」這個選項，
 * 跟 warning 才能靜音是同一把尺）；收的只有琥珀——沒有紅的時候露第一件琥珀，其餘
 * 收成一行「還有 N 件」。換頁就收回去——展開是「這一頁、這一次」的動作，不是偏好。
 *
 * ⛔七輪拍板「不做浮動提醒」：右下角小幫手就是現成的浮動異常中心，再加一個＝兩個
 * 浮的東西打架；而且可隱藏的浮窗被關掉之後徹底看不見——這整案的起點正是
 * 「異常都躲在小幫手裡沒人看」。被收合的事仍有三個地方掛號：這一行、側欄的點、
 * 小幫手徽章。
 */
const expanded = ref(false)
watch(() => route.path, () => { expanded.value = false })

/** 收合狀態要露幾件：有紅全露、沒紅露第一件（rows 紅在前，直接取前段就是對的） */
const alwaysShownCount = computed(() => {
  const crit = rows.value.filter(r => r.alert.severity === 'critical').length
  return crit > 0 ? crit : Math.min(1, rows.value.length)
})
const visibleRows = computed(() => expanded.value ? rows.value : rows.value.slice(0, alwaysShownCount.value))
/** 有沒有東西可收（決定「還有 N 件／收合」那一行要不要出現） */
const collapsibleCount = computed(() => rows.value.length - alwaysShownCount.value)
/** 只藏一件時把標題講出來（幾乎零成本的線索）；多件才只講數字 */
const moreLabel = computed(() => {
  const hidden = rows.value.slice(alwaysShownCount.value)
  if (hidden.length === 1)
    return `還有 1 件：${hidden[0]!.alert.title} ▾`
  return `還有 ${hidden.length} 件提醒 ▾`
})

function toneOf(a: ResolvedAlert): 'critical' | 'warning' {
  return a.severity === 'critical' ? 'critical' : 'warning'
}

/** 標題＝跟小幫手同一句（ALERT_LABELS）＋件數。⛔別在這裡改寫標題，兩處講不同話會漂 */
function rowTitle(a: ResolvedAlert): string {
  return a.count ? `${a.title}（${a.count}）` : a.title
}

function rowDetail(a: ResolvedAlert): string {
  const parts = [a.impact]
  if (a.detail)
    parts.push(a.detail)
  // 系統端的狀況要明講「不用你操作」，否則使用者會反覆找能按的東西（D-8③ 拍板）。
  // ⛔有一鍵修的例外（如知識卡卡住的「再排一次學習」）：有按鈕可按之後那句話就不是真的了
  if (a.owner === 'system' && !a.fixOpId)
    parts.push('這是系統端的狀況，不用你操作。')
  return parts.join(' ')
}

/**
 * 按鈕標籤⛔不查 DOM（六輪修正）：橫帶常常比頁面內容先渲染完，掛載當下
 * querySelector 查不到錨點區塊 → 標籤退化成導航字樣、甚至整顆消失，之後也不會
 * 更新（DOM 不是反應式來源）——老闆截圖裡兩條帶一條字樣錯、一條沒按鈕就是這樣。
 * 有掛錨點就顯示「帶我看」，找不找得到留給點擊當下處理（startAdHocTour 本來就會
 * 等元素出現；真的沒有再退回導航）。
 */
function rowActionLabel(r: { alert: ResolvedAlert, to: string }): string {
  if (r.alert.anchor)
    return '帶我看'
  // 沒有錨點：深連結是本頁自己（無 query）→ 按了等於原地不動，不給按鈕
  if (r.to === route.path)
    return ''
  return r.alert.cta
}

function go(r: { alert: ResolvedAlert, to: string }) {
  const a = r.alert
  // ① 本頁就有能處理它的區塊 → 聚光燈帶過去。點擊當下查一次 DOM：
  //    找得到（或 startAdHocTour 等得到）就聚光燈；真的沒有這個區塊才退回導航
  if (a.anchor && import.meta.client && document.querySelector(a.anchor.selector)) {
    void startAdHocTour([{
      target: a.anchor.selector,
      title: rowTitle(a),
      description: a.anchor.note,
    }])
    return
  }
  const [path] = r.to.split('?')
  // ② 別頁 → SPA 導航；③ 本頁帶 query 的退路 → 整頁重載讓 onMounted 重讀
  if (path === route.path && path !== r.to) {
    void navigateTo(r.to, { external: true })
    return
  }
  if (r.to !== route.path)
    void navigateTo(r.to)
}

// TTL 節流（60 秒內不重打）＋與小幫手共用 inflight，直接進頁也有資料可畫
onMounted(() => { void refresh() })
</script>

<!-- 樣式在 app/assets/scss/components/_block-status.scss（同批 D-33 元件） -->
