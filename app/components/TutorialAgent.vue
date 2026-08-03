<template>
  <!-- 常駐右下角的教學 agent。樣式見 assets/scss/components/_tutorial-agent.scss -->
  <div class="tutorial-agent">
    <!-- 異常小氣泡：壞掉的東西要主動講一次，不能只靠使用者注意到紅點 -->
    <!-- 外層是 div、內層兩顆真按鈕：按鈕不能包按鈕，且「關掉」要能用鍵盤獨立操作 -->
    <Transition name="ta-pop">
      <div v-if="alertNudge && !panelOpen" class="ta-nudge ta-nudge--alert">
        <button type="button" class="ta-nudge__text" @click="onAlertNudgeClick">{{ alertNudge }}</button>
        <button type="button" class="ta-nudge__close" aria-label="知道了" @click="alertNudge = ''"><el-icon><Close /></el-icon></button>
      </div>
    </Transition>

    <!-- 第一次來的引導小氣泡（一次性）。有異常時讓位給上面那顆 -->
    <Transition name="ta-pop">
      <div v-if="showNudge && !panelOpen && !alertNudge" class="ta-nudge">
        <button type="button" class="ta-nudge__text" @click="onNudgeClick">第一次來？我帶你一步步把設定做完</button>
        <button type="button" class="ta-nudge__close" aria-label="不用了" @click="dismissNudge"><el-icon><Close /></el-icon></button>
      </div>
    </Transition>

    <!-- 聊天面板 -->
    <Transition name="ta-pop">
      <section
        v-if="panelOpen"
        class="ta-panel"
        role="dialog"
        aria-label="教學助理"
      >
        <header class="ta-panel__head">
          <div class="ta-panel__avatar"><el-icon><IconRobot /></el-icon></div>
          <div class="ta-panel__head-meta">
            <div class="ta-panel__name">小幫手</div>
            <div class="ta-panel__status"><span class="ta-dot" />線上</div>
          </div>
          <div class="ta-tabs" role="tablist">
            <button type="button" role="tab" :aria-selected="panelTab === 'setup'" :class="{ 'is-active': panelTab === 'setup' }" @click="panelTab = 'setup'">目前狀況</button>
            <button type="button" role="tab" :aria-selected="panelTab === 'chat'" :class="{ 'is-active': panelTab === 'chat' }" @click="panelTab = 'chat'">問助理</button>
          </div>
          <button class="ta-panel__close" aria-label="關閉" @click="closePanel"><el-icon><Close /></el-icon></button>
        </header>

        <!-- 問助理:用講的查後台(唯讀)。用 v-show 不用 v-if——切去看「目前狀況」再切回來，
             對話與捲動位置要還在，不然問到一半去對照狀態就等於重問一次 -->
        <AdminAgentChat v-show="panelTab === 'chat'" class="ta-panel__chat" />

        <div v-show="panelTab === 'setup'" class="ta-panel__body">
          <!-- 導覽結束後的回應（閉環） -->
          <div v-if="postTourNote" class="ta-note">{{ postTourNote }}</div>

          <!-- agent 訊息泡泡：依真實設定狀態講白話文 -->
          <div class="ta-msg">
            <div class="ta-msg__avatar"><el-icon><IconRobot /></el-icon></div>
            <div class="ta-msg__bubble" aria-live="polite">
              <p>嗨{{ userName ? `，${userName}` : '' }}</p>
              <p>{{ agentLine }}</p>
            </div>
          </div>

          <!-- 目前異常：本來會動的東西壞了。排在設定待辦前面——「壞了」比「還沒做」急 -->
          <template v-if="alerts.length">
            <div v-if="activeAlerts.length" class="ta-alerts">
              <div class="ta-alerts__label">
                <span>需要處理</span>
                <span v-if="checkedAgo" class="ta-alerts__ago">{{ checkedAgo }}</span>
              </div>
              <button
                v-for="a in activeAlerts"
                :key="a.id"
                class="ta-alert"
                :class="`is-${a.severity}`"
                @click="onFixAlert(a)"
              >
                <span class="ta-alert__icon"><el-icon><component :is="a.icon" /></el-icon></span>
                <span class="ta-alert__main">
                  <span class="ta-alert__title">
                    {{ a.title }}
                    <span v-if="a.count" class="ta-alert__count">{{ a.count }}</span>
                  </span>
                  <span v-if="a.detail" class="ta-alert__detail">{{ a.detail }}</span>
                  <span class="ta-alert__impact">{{ a.impact }}</span>
                  <span class="ta-alert__cta">{{ a.cta }} →</span>
                </span>
              </button>
            </div>

            <div v-else-if="alertsLoaded" class="ta-alerts-clear">
              目前沒有發現異常{{ checkedAgo ? `（${checkedAgo}）` : '' }}。
            </div>

            <!-- 這次檢查不到的異常（現形，不要偷偷當成沒事） -->
            <div v-if="unknownAlertItems.length" class="ta-unknown">
              <span>這幾項我這次檢查不到：{{ unknownAlertItems.map(a => a.title).join('、') }}。</span>
              <button class="ta-unknown__btn" :disabled="alertsLoading" @click="refreshAll(true)">重新檢查</button>
            </div>
          </template>

          <!-- 載入骨架 -->
          <div v-if="!loaded" class="ta-skeleton" aria-hidden="true">
            <span class="ta-skel-bar" />
            <span class="ta-skel-bar" />
            <span class="ta-skel-bar" />
          </div>

          <template v-else>
            <!-- 設定體檢：只在這個帳號「有權限做設定」時才顯示（觀察者不會被沒法做的待辦打擾） -->
            <template v-if="hasItems">
            <!-- 完成度：主進度只看必要項 -->
            <div class="ta-progress">
              <div
                class="ta-progress__bar"
                role="progressbar"
                :aria-valuenow="requiredPercent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span class="ta-progress__fill" :style="{ width: `${requiredPercent}%` }" />
              </div>
              <div class="ta-progress__meta">
                <span>
                  必要設定 {{ requiredDone }}/{{ requiredTotal }}
                  <template v-if="allRequiredDone"> ・可以上線了</template>
                </span>
                <button class="ta-progress__refresh" :disabled="busy" @click="refreshAll(true)">
                  {{ busy ? '檢查中…' : '重新檢查' }}
                </button>
              </div>
              <div v-if="optionalTotal" class="ta-progress__optional">
                加分項 {{ optionalDone }}/{{ optionalTotal }}（做了 AI 更好用，不做也能上線）
              </div>
            </div>

            <!-- 缺項巡覽：次要連結，用 tour 帶你看一遍還沒做的 -->
            <button
              v-if="incompleteAll.length"
              class="ta-gaptour"
              @click="startGapTour"
            >
              <el-icon><View /></el-icon>
              <span>帶我看一遍還沒做的</span>
            </button>

            <!-- 待辦：還沒做完的項目（主要操作） -->
            <div v-if="incompleteAll.length" class="ta-todos">
              <button
                v-for="cap in incompleteAll"
                :key="cap.id"
                class="ta-todo"
                @click="onFix(cap)"
              >
                <span class="ta-todo__icon"><el-icon><component :is="cap.icon" /></el-icon></span>
                <span class="ta-todo__main">
                  <span class="ta-todo__title">
                    {{ cap.title }}
                    <span class="ta-todo__tag" :class="cap.required ? 'is-required' : 'is-optional'">
                      {{ cap.required ? '必要' : '加分' }}
                    </span>
                  </span>
                  <span class="ta-todo__why">{{ cap.why }}</span>
                  <span class="ta-todo__cta">{{ cap.tourId ? '帶我做 →' : '前往設定 →' }}</span>
                </span>
              </button>
            </div>

            <!-- 必要項都完成：閉環到「上線前先試答」，不要停在恭喜就沒了 -->
            <div v-else class="ta-alldone">
              <p class="ta-alldone__msg">必要設定都完成了，可以上線囉！</p>
              <p class="ta-alldone__hint">正式讓 AI 回客人之前，建議先自己試答幾題，確認答得穩。</p>
              <button class="ta-alldone__cta" @click="startTopicById('ai-playground')">
                去試答看看 →
              </button>
            </div>

            <!-- 這次查不到狀態的項目（現形，不偷偷扣分） -->
            <div v-if="unknownCaps.length" class="ta-unknown">
              <span>這幾項我這次查不到狀態：{{ unknownCaps.map(c => c.title).join('、') }}。</span>
              <button class="ta-unknown__btn" :disabled="busy" @click="refreshAll(true)">重新檢查</button>
            </div>
            </template>

            <!-- 複習教學：依分類收合，避免清單過長 -->
            <div v-if="groupedTopics.length" class="ta-review">
              <div class="ta-review__label">想複習教學</div>
              <div v-for="g in groupedTopics" :key="g.id" class="ta-review-group">
                <button
                  class="ta-review-group__head"
                  :aria-expanded="expandedGroups.has(g.id)"
                  @click="toggleGroup(g.id)"
                >
                  <span class="ta-review-group__title">{{ g.label }}</span>
                  <span class="ta-review-group__count">{{ g.topics.length }}</span>
                  <span class="ta-review-group__chev" :class="{ open: expandedGroups.has(g.id) }">▾</span>
                </button>
                <div v-if="expandedGroups.has(g.id)" class="ta-review-group__body">
                  <button
                    v-for="topic in g.topics"
                    :key="topic.id"
                    class="ta-option ta-option--sm"
                    @click="onPick(topic)"
                  >
                    <span class="ta-option__icon"><el-icon><component :is="topic.icon" /></el-icon></span>
                    <span class="ta-option__body">
                      <span class="ta-option__label">
                        {{ topic.label }}
                        <!-- 步數自動算：功能旗標關掉某步時會跟著少，不會跟文案漂移 -->
                        <span class="ta-option__steps">{{ stepCount(topic) }} 步</span>
                      </span>
                      <span class="ta-option__blurb">{{ topic.blurb }}</span>
                    </span>
                    <span class="ta-option__arrow">→</span>
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <footer v-if="panelTab === 'setup'" class="ta-panel__foot">我只看你帳號真實的狀態，不會給你假資訊。</footer>
        <footer v-else class="ta-panel__foot">回答都來自你帳號的真實資料;目前只能查詢,不能修改。</footer>
      </section>
    </Transition>

    <!-- 浮動按鈕 -->
    <button
      class="ta-fab"
      :class="{ 'ta-fab--open': panelOpen }"
      :aria-label="panelOpen ? '關閉教學助理' : '開啟教學助理'"
      @click="onFabClick"
    >
      <span class="ta-fab__icon"><el-icon><component :is="panelOpen ? Close : IconRobot" /></el-icon></span>
      <span v-if="!panelOpen && (!allRequiredDone || criticalAlerts.length)" class="ta-fab__pulse" aria-hidden="true" />
      <!-- 紅點只數「現在壞著」與「必要設定沒做」；建議處理的黃色項不進來，免得紅點長亮被無視 -->
      <span
        v-if="!panelOpen && badgeCount"
        class="ta-fab__badge"
        :aria-label="badgeLabel"
      >{{ badgeCount }}</span>
    </button>

    <!-- 導覽（Element Plus Tour）；用 zh-cn locale 讓按鈕是中文 -->
    <ClientOnly>
      <el-config-provider :locale="zhCn">
        <el-tour
          v-model="tourOpen"
          :current="tourStep"
          :z-index="3000"
          @update:current="(v) => (tourStep = v)"
          @close="onTourClose"
          @finish="onTourFinish"
        >
          <el-tour-step
            v-for="(step, i) in activeSteps"
            :key="i"
            :target="liveTarget"
            :placement="step.placement"
          >
            <template #header>
              <span class="ta-tour-head">
                <!-- 步數由畫面標，內容不寫「第 N 步」——跳步、加步都不會對不上 -->
                <span v-if="activeSteps.length > 1" class="ta-tour-count">{{ i + 1 }} / {{ activeSteps.length }}</span>
                <span class="ta-tour-title">{{ step.title }}</span>
              </span>
            </template>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="ta-tour-desc" v-html="step.description" />
            <!-- 目標找不到時要講出來。預設會退成置中說明卡，不講的話使用者只會覺得
                 「這步沒指到東西」而搞不清楚是壞了還是本來就沒有 -->
            <p v-if="targetMissing && step.target" class="ta-tour-missing">
              這一步要指的位置目前不在畫面上——通常是還沒選任何一筆資料，或這個功能沒開。上面的說明仍然適用。
            </p>
            <el-button
              v-if="step.actionTopicId"
              type="primary"
              size="small"
              class="ta-tour-action"
              @click="onStepAction(step.actionTopicId)"
            >
              帶我做這項 →
            </el-button>
          </el-tour-step>
        </el-tour>
      </el-config-provider>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import type { ResolvedCapability } from '~/composables/useSetupStatus'
import type { ResolvedAlert } from '~/composables/useWorkspaceAlerts'
import { Close, View } from '@element-plus/icons-vue'
import IconRobot from '~/components/icons/IconRobot.vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

const { user } = useAuth()
const { workspaceId } = useWorkspace()
const router = useRouter()

/** 面板分頁:設定進度(原教學小幫手)/ 問助理(admin 查詢副駕 P1) */
const panelTab = ref<'setup' | 'chat'>('setup')
const {
  panelOpen,
  tourOpen,
  tourStep,
  groupedTopics,
  activeSteps,
  lastTopicId,
  stepCount,
  openPanel,
  closePanel,
  togglePanel,
  startTopic,
  startTopicById,
  startAdHocTour,
  endTour,
} = useTutorial()
const {
  capabilities,
  hasItems,
  incompleteAll,
  incompleteRequired,
  unknownCaps,
  requiredTotal,
  requiredDone,
  optionalTotal,
  optionalDone,
  requiredPercent,
  allRequiredDone,
  loaded,
  loading,
  refresh,
  reset: resetSetupStatus,
} = useSetupStatus()
const {
  alerts,
  activeAlerts,
  criticalAlerts,
  unknownAlerts: unknownAlertItems,
  loaded: alertsLoaded,
  loading: alertsLoading,
  checkedAgo,
  refresh: refreshAlerts,
  reset: resetAlerts,
  POLL_INTERVAL_MS,
} = useWorkspaceAlerts()
const { setDemo, clearDemo } = useFlowDemo()

/**
 * 兩份體檢（設定就緒度 + 目前異常）一起重查。
 * force 用在「使用者按重新檢查」與「剛跑完導覽要確認有沒有生效」——這兩種情境
 * 一定要拿到當下的真實狀態，不能被節流擋掉回舊答案。
 */
function refreshAll(force = false) {
  return Promise.all([refresh({ force }), refreshAlerts({ force })])
}

const busy = computed(() => loading.value || alertsLoading.value)

/** 紅點：現在壞著的 + 必要設定沒做的。兩者都是「不處理就有事」，合成一個數字才不會互相遮蔽 */
const badgeCount = computed(() => criticalAlerts.value.length + incompleteRequired.value.length)
const badgeLabel = computed(() => {
  const parts: string[] = []
  if (criticalAlerts.value.length)
    parts.push(`${criticalAlerts.value.length} 個地方需要處理`)
  if (incompleteRequired.value.length)
    parts.push(`${incompleteRequired.value.length} 項必要設定未完成`)
  return parts.join('、')
})

const userName = computed(() => {
  const dn = user.value?.displayName?.trim()
  if (dn) return dn.split(' ')[0]
  return ''
})

/** agent 開場白：完全依真實狀態講白話文。順序＝先講壞了的，再講還沒做的 */
const agentLine = computed(() => {
  if (!loaded.value && !alertsLoaded.value)
    return '我先幫你看一下目前的狀況…'
  if (criticalAlerts.value.length)
    return `先講重要的：有 ${criticalAlerts.value.length} 個地方現在不正常，客人會受影響。點下面就能去處理。`
  if (activeAlerts.value.length)
    return `有 ${activeAlerts.value.length} 件事建議處理一下，客人暫時不會有感，但別放太久。`
  if (!loaded.value)
    return '我先幫你看一下目前的設定狀況…'
  // 沒有可動手的設定項（例如觀察者）：不談設定，直接導向教學
  if (!hasItems.value)
    return '嗨！想了解哪個功能，直接點下面的教學，我帶你看 '
  if (incompleteRequired.value.length)
    return `我看過你的帳號了。最重要的還差 ${incompleteRequired.value.length} 項還沒做，我們一個一個來，點下面就能開始 `
  if (!allRequiredDone.value)
    return `有 ${unknownCaps.value.length} 項我這次查不到狀態，先點「重新檢查」確認一下。`
  if (incompleteAll.value.length)
    return `必要設定都完成了 可以上線囉！還有 ${incompleteAll.value.length} 個加分項，想做再做。`
  return '你的設定都完成了。上線前建議先試答幾題確認 AI 答得穩，之後有任何不熟的地方隨時點我。'
})

function onPick(topic: Parameters<typeof startTopic>[0]) {
  void startTopic(topic)
}

// 複習教學分組的展開狀態；預設展開「開始設定」與「AI 客服」
const expandedGroups = ref<Set<string>>(new Set(['setup', 'ai']))
function toggleGroup(id: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expandedGroups.value = next
}

/** 點待辦：有導覽就帶著做，沒有就導到設定頁 */
function onFix(cap: ResolvedCapability) {
  if (cap.tourId && startTopicById(cap.tourId))
    return
  const wid = workspaceId.value
  if (!wid)
    return
  closePanel()
  void router.push(cap.route(wid))
}

/** 點異常：直接去能修的那一頁（異常沒有導覽——導覽教的是怎麼設定，不是怎麼修壞掉的東西） */
function onFixAlert(alert: ResolvedAlert) {
  const wid = workspaceId.value
  if (!wid)
    return
  closePanel()
  void router.push(alert.route(wid))
}

/** 缺項巡覽：用 tour 逐一高亮側欄上「還沒做完」的入口，每步附「帶我做這項」 */
function startGapTour() {
  const steps = incompleteAll.value.map(cap => ({
    target: cap.navTarget,
    title: `還沒做：${cap.title}`,
    description: cap.tourId
      ? `${cap.why}<br>側欄這個就是入口。`
      : `${cap.why}<br>點側欄這個項目進去設定。`,
    placement: 'right' as const,
    actionTopicId: cap.tourId,
  }))
  void startAdHocTour(steps)
}

/** 巡覽步驟內的「帶我做這項」：收掉巡覽，直接開那一頁的逐步導覽 */
function onStepAction(topicId: string) {
  endTour()
  startTopicById(topicId)
}

const postTourNote = ref('')

/** 導覽「完成」：閉環——重抓狀態、依結果回應、重開面板 */
async function onTourFinish() {
  const finishedId = lastTopicId.value
  clearDemo()
  endTour()
  // 一定要 force：使用者剛才就在改設定，這裡拿到舊快取就會誤報「還沒生效」
  await refresh({ force: true })
  const cap = finishedId ? capabilities.value.find(c => c.tourId === finishedId) : null
  if (cap) {
    postTourNote.value = cap.status === 'done'
      ? `「${cap.title}」完成了，太好了 `
      : `看起來「${cap.title}」還沒生效——設定完記得按「儲存」喔。需要的話可以再走一次。`
  }
  else {
    postTourNote.value = ''
  }
  openPanel()
}

/** 導覽被中途關閉：尊重使用者離開，不打擾，只默默重抓狀態 */
function onTourClose() {
  clearDemo()
  endTour()
  void refresh({ force: true })
}

// ── 第一次來的引導小氣泡（一次性，存 localStorage） ──
const showNudge = ref(false)
function nudgeKey() {
  return `ta-nudge-seen:${workspaceId.value || 'default'}`
}
function dismissNudge() {
  showNudge.value = false
  try {
    localStorage.setItem(nudgeKey(), '1')
  }
  catch {}
}
function onNudgeClick() {
  dismissNudge()
  openPanel()
}
function onFabClick() {
  if (!panelOpen.value) {
    dismissNudge()
    alertNudge.value = ''
  }
  togglePanel()
}

// ── 異常小氣泡 ──
// 只在「壞著」的項目上主動彈一次：紅點很容易被當成裝飾，壞掉的東西值得講出來。
// 用 sessionStorage 記已彈過，key 帶當下的異常組合——同一批異常這次登入不再吵，
// 但**冒出新的異常**（組合變了）會再彈一次。
const alertNudge = ref('')
function alertNudgeKey(signature: string) {
  return `ta-alert-nudge:${workspaceId.value || 'default'}:${signature}`
}
function onAlertNudgeClick() {
  alertNudge.value = ''
  panelTab.value = 'setup'
  openPanel()
}

watch(criticalAlerts, (list) => {
  if (!list.length || panelOpen.value)
    return
  const signature = list.map(a => a.id).sort().join(',')
  try {
    if (sessionStorage.getItem(alertNudgeKey(signature)))
      return
    sessionStorage.setItem(alertNudgeKey(signature), '1')
  }
  catch {}
  alertNudge.value = list.length === 1
    ? list[0]!.title
    : `有 ${list.length} 個地方需要處理，客人會受影響`
})

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await refreshAll()
  // 只有「真的還有必要項沒做」且沒看過，才彈引導
  try {
    if (!localStorage.getItem(nudgeKey()) && incompleteRequired.value.length > 0)
      showNudge.value = true
  }
  catch {}
  // 背景重查：使用者可能整天停在同一頁，不重查就等於沒有「主動告知」。
  // 分頁在背景、或這個角色一項異常都看不到（例如觀察者）就跳過，不浪費查詢額度。
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && alerts.value.length)
      void refreshAlerts()
  }, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  if (pollTimer)
    clearInterval(pollTimer)
  pollTimer = null
})

// 換工作區：先把上一個帳號的狀態清掉再重查。把 A 家的「扣款失敗」或「設定都完成了」
// 留在 B 家畫面上，比暫時空白嚴重得多
watch(workspaceId, (next, prev) => {
  if (!next || next === prev)
    return
  alertNudge.value = ''
  resetAlerts()
  resetSetupStatus()
  void refreshAll(true)
})

// 每次打開面板都重新體檢；關閉時清掉導覽回應
watch(panelOpen, (open) => {
  if (open)
    void refreshAll()
  else
    postTourNote.value = ''
})

/**
 * el-tour 高亮對不準的根因與解法。
 *
 * 根因：el-tour 的 isInViewPort 用「window 視窗」判斷要不要捲動目標，但本後台的
 * 側欄(.sidebar-scroll)與分割版面(.main-content:has(.split-layout) 內的捲動區)都是
 * 「內層捲動容器」。目標即使被擠在內層容器邊緣，對 window 仍算可見，el-tour 就不捲動，
 * 於是用目標當下的擠壓位置畫高亮；而它只在 open/target 變更或 window resize 時重算，
 * 我事後捲動再補發 resize 又跟它的同步讀取賽跑，所以一直對不準。
 *
 * 解法：把每一步的 target 都綁到同一個我可控的 liveTarget ref。因為各步共用同一個值，
 * el-tour 在換步時不會自動重讀(currentTarget 沒變)；改由我在「自己把目標捲到中央、
 * 且位置穩定後」才設定 liveTarget——這會走 el-tour 既有的 watch([open,target]) 重算路徑，
 * 用捲動後的正確 rect 重畫遮罩與卡片，不再有時序競態。
 */
const liveTarget = ref<HTMLElement | null>(null)

/** 捲到容器中央，並等到元素位置連續兩幀不再變動（避免讀到捲動中的暫態座標） */
function scrollAndSettle(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  return new Promise((resolve) => {
    let last = Number.NaN
    let frames = 0
    const tick = () => {
      const top = Math.round(el.getBoundingClientRect().top)
      if (top === last || frames >= 20) {
        resolve()
        return
      }
      last = top
      frames += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** 這一步指定了 target 卻找不到元素。要顯示在卡片上，不能安靜退化成置中說明卡 */
const targetMissing = ref(false)

async function focusActiveStep() {
  if (!tourOpen.value) {
    liveTarget.value = null
    targetMissing.value = false
    return
  }
  await nextTick()
  const step = activeSteps.value[tourStep.value]
  // 機器人模組示範：在示範草稿放一張該類型的卡（或清掉），給頁面時間渲染
  if (step?.demoType) {
    setDemo(step.demoType)
    await nextTick()
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  }
  else {
    clearDemo()
  }
  // 顯示前先點某元素（例如先進入新增模式，編輯區才會出現），再等頁面渲染
  if (step?.clickBefore) {
    document.querySelector<HTMLElement>(step.clickBefore)?.click()
    await nextTick()
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  }
  const selector = step?.target
  // 空 target ＝ 置中說明卡（不高亮）；否則輪詢等元素出現（示範卡可能要時間渲染）
  const el = selector ? await waitForElement(selector, 2000) : null
  targetMissing.value = Boolean(selector) && !el
  if (!el) {
    liveTarget.value = null
    return
  }
  await scrollAndSettle(el)
  // 同一個元素時，先清空再設定以確保觸發 el-tour 重算
  if (liveTarget.value === el) {
    liveTarget.value = null
    await nextTick()
  }
  liveTarget.value = el
}

watch([tourOpen, tourStep], focusActiveStep, { flush: 'post' })
</script>
