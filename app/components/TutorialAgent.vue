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
        aria-label="小幫手"
        @keydown.esc="closePanel"
      >
        <header class="ta-panel__head">
          <div class="ta-panel__avatar"><el-icon><IconRobot /></el-icon></div>
          <div class="ta-panel__head-meta">
            <div class="ta-panel__name">小幫手</div>
            <!-- 資料新鮮度取代裝飾性的「線上」：使用者真正想知道的是「這是多新的資訊」 -->
            <div class="ta-panel__status">{{ headerFreshness }}</div>
          </div>
          <div class="ta-tabs" role="tablist">
            <button type="button" role="tab" :aria-selected="panelTab === 'setup'" :class="{ 'is-active': panelTab === 'setup' }" @click="panelTab = 'setup'">目前狀況</button>
            <button type="button" role="tab" :aria-selected="panelTab === 'learn'" :class="{ 'is-active': panelTab === 'learn' }" @click="panelTab = 'learn'">教學</button>
            <button type="button" role="tab" :aria-selected="panelTab === 'chat'" :class="{ 'is-active': panelTab === 'chat' }" @click="panelTab = 'chat'">問助理</button>
          </div>
          <button class="ta-panel__close" aria-label="關閉" @click="closePanel"><el-icon><Close /></el-icon></button>
        </header>

        <!-- 問助理:用講的查後台(唯讀)。用 v-show 不用 v-if——切去看「目前狀況」再切回來，
             對話與捲動位置要還在，不然問到一半去對照狀態就等於重問一次 -->
        <AdminAgentChat v-show="panelTab === 'chat'" class="ta-panel__chat" />

        <div v-show="panelTab === 'setup'" class="ta-panel__body">
          <!-- 結論先行：先一句話講「有沒有事」，明細在下面（沿用 .ls-status 的視覺語言） -->
          <div v-if="verdict" class="ta-verdict" :class="`is-${verdict.tone}`">
            <el-icon class="ta-verdict__icon"><component :is="verdict.icon" /></el-icon>
            <span>{{ verdict.text }}</span>
          </div>

          <!-- agent 訊息泡泡：依真實設定狀態講白話文。導覽完成／異常修復的閉環回應
               也在這裡講——一個 agent 一個聲音，三個區塊各自代言只會像三個人在說話 -->
          <div class="ta-msg">
            <div class="ta-msg__avatar"><el-icon><IconRobot /></el-icon></div>
            <div class="ta-msg__bubble" aria-live="polite">
              <p>嗨{{ userName ? `，${userName}` : '' }}</p>
              <p v-if="postTourNote">{{ postTourNote }}</p>
              <p v-if="postFixNote">{{ postFixNote }}</p>
              <p>{{ agentLine }}</p>
            </div>
          </div>

          <!-- 目前異常：本來會動的東西壞了。排在設定待辦前面——「壞了」比「還沒做」急。
               紅橘語意差很多（客人正在受影響 vs 建議處理），分成兩組講，不共用一個標題 -->
          <template v-if="alerts.length">
            <div v-for="g in alertGroups" :key="g.key" class="ta-alerts">
              <div class="ta-alerts__label" :class="`ta-alerts__label--${g.key}`">{{ g.label }}</div>
              <!-- 卡片是 div 包兩顆真按鈕（主要動作／暫停提醒）：按鈕不能包按鈕 -->
              <div
                v-for="a in g.items"
                :key="a.id"
                class="ta-alert"
                :class="`is-${a.severity}`"
              >
                <button type="button" class="ta-alert__hit" @click="onFixAlert(a)">
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
                <!-- 只有 warning 給靜音：正在影響客人的事沒有「不想看」這個選項 -->
                <button
                  v-if="a.severity === 'warning'"
                  type="button"
                  class="ta-alert__snooze"
                  @click="snoozeAlert(a.id)"
                >暫停提醒 7 天</button>
              </div>
            </div>

            <div v-if="alertsLoaded && !activeAlerts.length" class="ta-alerts-clear">
              目前沒有發現異常。
            </div>

            <!-- 被靜音但還在發生的事也要現形：靜音是「先不吵我」，不是「當作沒事」 -->
            <div v-if="snoozedAlerts.length" class="ta-unknown">
              <span>已暫停提醒 {{ snoozedAlerts.length }} 項：{{ snoozedAlerts.map(a => a.title).join('、') }}。</span>
              <button class="ta-unknown__btn" @click="unsnoozeAll">恢復提醒</button>
            </div>
          </template>

          <!-- 檢查健康度：查詢失敗、查不到的項目（異常＋設定體檢）統一在這一條講、
               共用一顆「重新檢查」。先前最多五條灰橫幅各配一顆按鈕，比異常本身還吵。
               誠實原則不變：查不到＝不知道，不能靜默當成沒事 -->
          <div v-if="checkGapLines.length" class="ta-unknown" :class="{ 'ta-unknown--fail': alertsFailed && !alertsLoaded }">
            <span v-for="line in checkGapLines" :key="line">{{ line }}</span>
            <button class="ta-unknown__btn" :disabled="busy" @click="refreshAll(true)">重新檢查</button>
          </div>

          <!-- 昨日摘要（日報）：打的是統計頁同一支查詢，兩邊數字永遠對得上 -->
          <div v-if="briefVisible && briefY" class="ta-brief">
            <div class="ta-brief__head">
              <span>昨日摘要{{ briefDateLabel }}</span>
              <button type="button" class="ta-brief__link" @click="goStats">看完整統計 →</button>
            </div>
            <p v-if="!briefY.total" class="ta-brief__empty">昨天沒有客人對話。</p>
            <template v-else>
              <div class="ta-brief__grid">
                <div v-for="cell in briefCells" :key="cell.label" class="ta-brief__cell">
                  <span class="ta-brief__num">{{ cell.value }}</span>
                  <span class="ta-brief__label">{{ cell.label }}</span>
                  <span class="ta-brief__delta">前天 {{ cell.prev }}</span>
                </div>
              </div>
              <p v-if="briefY.unhandled" class="ta-brief__warn">
                其中 {{ briefY.unhandled }} 場從頭到尾沒有人回{{ unhandledSpike ? '，比平常多' : '' }}，建議去看一下。
              </p>
              <p v-if="trendLine" class="ta-brief__warn">{{ trendLine }}</p>
            </template>
          </div>

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

            </template>
          </template>
        </div>

        <!-- 教學：想學才來翻的參考庫（pull）。和「目前狀況」的異常/待辦（push）分開住，
             不緊急的內容不佔狀況版面 -->
        <div v-show="panelTab === 'learn'" class="ta-panel__body">
          <div class="ta-msg">
            <div class="ta-msg__avatar"><el-icon><IconRobot /></el-icon></div>
            <div class="ta-msg__bubble">
              <p>想學哪個功能？點一個主題，我直接在畫面上一步步帶你做。</p>
            </div>
          </div>
          <div v-if="groupedTopics.length" class="ta-review">
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
          <p v-else class="ta-options__empty">目前沒有可用的教學主題。</p>
        </div>

        <footer v-if="panelTab === 'setup'" class="ta-panel__foot">我只看你帳號真實的狀態，不會給你假資訊。</footer>
        <footer v-else-if="panelTab === 'learn'" class="ta-panel__foot">每個教學都會在實際畫面上一步步帶你操作。</footer>
        <footer v-else class="ta-panel__foot">回答都來自你帳號的真實資料;目前只能查詢,不能修改。</footer>
      </section>
    </Transition>

    <!-- 浮動按鈕 -->
    <button
      class="ta-fab"
      :class="{ 'ta-fab--open': panelOpen }"
      :aria-label="panelOpen ? '關閉小幫手' : '開啟小幫手'"
      @click="onFabClick"
    >
      <span class="ta-fab__icon"><el-icon><component :is="panelOpen ? Close : IconRobot" /></el-icon></span>
      <!-- 光暈等資料回來才閃：不然設定齊全的帳號每次載入都先閃一下（狼來了） -->
      <span v-if="!panelOpen && (criticalAlerts.length || (loaded && !allRequiredDone))" class="ta-fab__pulse" aria-hidden="true" />
      <!-- 數字＝「現在壞著」＋「必要設定沒做」；顏色分開講：紅只留給正在影響客人，
           純設定缺項用中性色——守住「紅＝客人正在受影響」的語意。黃色警示項不進數字 -->
      <span
        v-if="!panelOpen && badgeCount"
        class="ta-fab__badge"
        :class="{ 'ta-fab__badge--calm': !criticalAlerts.length }"
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
import type { Component } from 'vue'
import type { ResolvedCapability } from '~/composables/useSetupStatus'
import type { ResolvedAlert } from '~/composables/useWorkspaceAlerts'
import { CircleCheckFilled, CircleCloseFilled, Close, InfoFilled, QuestionFilled, View, WarningFilled } from '@element-plus/icons-vue'
import IconRobot from '~/components/icons/IconRobot.vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

const { user } = useAuth()
const { workspaceId } = useWorkspace()
const router = useRouter()

/** 面板分頁:目前狀況(異常+待辦+日報)/ 教學(主題庫)/ 問助理(admin 查詢副駕 P1) */
const panelTab = ref<'setup' | 'learn' | 'chat'>('setup')
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
  warningAlerts,
  suggestionAlerts,
  snoozedAlerts,
  unknownAlerts: unknownAlertItems,
  loaded: alertsLoaded,
  loading: alertsLoading,
  lastRefreshFailed: alertsFailed,
  checkedAgo,
  refresh: refreshAlerts,
  reset: resetAlerts,
  snoozeAlert,
  unsnoozeAll,
  POLL_INTERVAL_MS,
} = useWorkspaceAlerts()
const { brief, refresh: refreshBrief, reset: resetBrief } = useDailyBrief()
const { setDemo, clearDemo } = useFlowDemo()

/**
 * 三份資料（設定就緒度 + 目前異常 + 昨日摘要）一起重查。
 * force 用在「使用者按重新檢查」與「剛跑完導覽要確認有沒有生效」——這兩種情境
 * 一定要拿到當下的真實狀態，不能被節流擋掉回舊答案。
 */
function refreshAll(force = false) {
  return Promise.all([refresh({ force }), refreshAlerts({ force }), refreshBrief({ force })])
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

/** header 上的資料新鮮度：取代裝飾性的「線上」，回答「這是多新的資訊」 */
const headerFreshness = computed(() => {
  if (busy.value)
    return '檢查中…'
  return checkedAgo.value || '尚未檢查'
})

/** 昨日摘要（打統計頁同一支 KPI，口徑一致） */
const briefY = computed(() => brief.value?.yesterday ?? null)
/** 上線前（必要設定沒完成）不用日報打擾；一有過流量、或設定已完備就顯示——0 也是資訊 */
const briefVisible = computed(() => {
  const b = brief.value
  if (!b)
    return false
  return b.yesterday.total > 0 || b.dayBefore.total > 0 || allRequiredDone.value
})
const briefDateLabel = computed(() => {
  const d = brief.value?.date
  if (!d)
    return ''
  const [, m, day] = d.split('-')
  return `（${Number(m)}/${Number(day)}）`
})
const briefCells = computed(() => {
  const b = brief.value
  if (!b)
    return []
  return [
    { label: '客人對話', value: b.yesterday.total, prev: b.dayBefore.total },
    { label: 'AI／機器人先回', value: b.yesterday.autoFirst, prev: b.dayBefore.autoFirst },
    { label: '轉真人', value: b.yesterday.handoffs, prev: b.dayBefore.handoffs },
  ]
})
/**
 * 趨勢異常：昨天比前 7 天平均多一截才講，平常不出聲。
 * 門檻＝至少 3 件且達平均 2 倍——太敏感的趨勢提醒和狼來了是同一件事。
 * 顯示在日報區塊（數字旁邊講數字的事），不進開場白——開場白的日報句已經唸過轉真人件數，
 * 再唸一次會變成同一句話講兩遍。
 */
const trendLine = computed(() => {
  const b = brief.value
  if (!b?.baseline || !b.yesterday.total)
    return ''
  const h = b.yesterday.handoffs
  if (h >= 3 && h >= b.baseline.handoffs * 2)
    return `昨天轉真人 ${h} 件，平常一天約 ${formatAvg(b.baseline.handoffs)} 件——可能有哪類問題答不好，建議到統計頁看一下。`
  return ''
})
/** 沒人回的場數是不是異常偏多（門檻同上）；只拿來在既有的警語裡補一句「比平常多」 */
const unhandledSpike = computed(() => {
  const b = brief.value
  return Boolean(b?.baseline && b.yesterday.unhandled >= 3 && b.yesterday.unhandled >= b.baseline.unhandled * 2)
})
/** 平均數給人看：≥10 取整數，小的留一位小數（0.3 件/天四捨五入成 0 會變成在說謊） */
function formatAvg(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}

/** 開場白用的一句話日報 */
const briefLine = computed(() => {
  const b = brief.value
  if (!b)
    return ''
  if (!b.yesterday.total)
    return '昨天沒有客人對話。'
  const parts = [`昨天有 ${b.yesterday.total} 場客人對話`, `AI／機器人先回了 ${b.yesterday.autoFirst} 場`]
  if (b.yesterday.handoffs)
    parts.push(`轉真人 ${b.yesterday.handoffs} 件`)
  return `${parts.join('、')}。`
})

/**
 * 結論先行的狀態列：紅（正在影響客人）→ 橘（建議處理）→ 藍（設定還沒完）→ 綠（一切正常）。
 * 「查不到」不能歸進任何一級，單獨講。
 * FAB 紅點數字＝critical＋必要設定缺項，所以有異常時頭條也要把缺項帶上——
 * 按鈕寫 3、打開卻只講 1 件事，兩個最顯眼的數字就對不上了。
 */
const verdict = computed<{ tone: string, icon: Component, text: string } | null>(() => {
  const setupTail = loaded.value && incompleteRequired.value.length
    ? `、另差 ${incompleteRequired.value.length} 項必要設定`
    : ''
  if (criticalAlerts.value.length)
    return { tone: 'danger', icon: CircleCloseFilled, text: `${criticalAlerts.value.length} 件事正在影響客人${setupTail}` }
  if (warningAlerts.value.length)
    return { tone: 'warning', icon: WarningFilled, text: `${warningAlerts.value.length} 件事建議處理${setupTail}` }
  if (!alertsLoaded.value)
    return alertsFailed.value ? { tone: 'muted', icon: QuestionFilled, text: '目前檢查不到狀態' } : null
  if (loaded.value && incompleteRequired.value.length)
    return { tone: 'progress', icon: InfoFilled, text: `差 ${incompleteRequired.value.length} 項必要設定就能上線` }
  return { tone: 'ok', icon: CircleCheckFilled, text: '一切正常' }
})

/**
 * 檢查健康度收斂：查詢失敗、查不到狀態的項目（異常＋設定體檢）合成一條、共用一顆
 * 「重新檢查」。先前五種灰橫幅各配一顆按鈕、語氣格式各異，比異常本身還吵。
 */
const checkGapLines = computed(() => {
  const lines: string[] = []
  if (alertsFailed.value) {
    lines.push(alertsLoaded.value
      ? `剛才那次檢查失敗，上面是${checkedAgo.value || '稍早'}的結果。`
      : '我這次檢查不到異常狀態——這不代表沒有異常。')
  }
  const unknownTitles = [
    ...unknownAlertItems.value.map(a => a.title),
    ...(loaded.value ? unknownCaps.value.map(c => c.title) : []),
  ]
  if (unknownTitles.length)
    lines.push(`這幾項我這次查不到狀態：${unknownTitles.join('、')}。`)
  return lines
})

/** 異常分組呈現：紅（影響客人中）、橘（建議處理）、藍（可以更好——沒壞，是機會） */
const alertGroups = computed(() => [
  { key: 'critical', label: '現在影響客人', items: criticalAlerts.value },
  { key: 'warning', label: '建議處理', items: warningAlerts.value },
  { key: 'suggestion', label: '可以更好', items: suggestionAlerts.value },
].filter(g => g.items.length))

/** agent 開場白：完全依真實狀態講白話文。順序＝先講壞了的，再講還沒做的，最後才是日報 */
const agentLine = computed(() => {
  if (!loaded.value && !alertsLoaded.value)
    return '我先幫你看一下目前的狀況…'
  // 紅點同時數「壞著的」與「必要設定沒做」，開場白也要兩件都講，數字才對得上
  const setupTail = incompleteRequired.value.length
    ? `另外，必要設定還差 ${incompleteRequired.value.length} 項沒完成。`
    : ''
  if (criticalAlerts.value.length)
    return `先講重要的：有 ${criticalAlerts.value.length} 個地方現在不正常，客人會受影響。點下面就能去處理。${setupTail}`
  if (activeAlerts.value.length)
    return `有 ${activeAlerts.value.length} 件事建議處理一下，客人暫時不會有感，但別放太久。${setupTail}`
  if (!loaded.value)
    return '我先幫你看一下目前的設定狀況…'
  // 沒有可動手的設定項（例如觀察者）：不談設定，給日報或導向教學/問答
  if (!hasItems.value)
    return briefLine.value || '想了解後台狀況可以直接問我，想學功能就切到「教學」。'
  if (incompleteRequired.value.length)
    return `我看過你的帳號了。最重要的還差 ${incompleteRequired.value.length} 項還沒做，我們一個一個來，點下面就能開始。`
  if (!allRequiredDone.value) {
    const n = unknownCaps.value.filter(c => c.required).length
    return `有 ${n} 項必要設定我這次查不到狀態，先點「重新檢查」確認一下。`
  }
  if (incompleteAll.value.length)
    return `必要設定都完成了，可以上線囉！還有 ${incompleteAll.value.length} 個加分項，想做再做。`
  // 沒有壞的、沒有缺的：日報 + 機會（讓 AI 更聰明的建議）
  const nSuggest = suggestionAlerts.value.reduce((s, a) => s + (a.count ?? 1), 0)
  const suggestTail = nSuggest
    ? `另外我整理了 ${nSuggest} 個能讓 AI 答得更好的建議，看看下面的「可以更好」。`
    : ''
  if (briefLine.value)
    return `一切正常。${briefLine.value}${suggestTail}`
  if (suggestTail)
    return `一切正常。${suggestTail}`
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

/** 修復閉環：上次點「去修」的那件事，回來打開面板時要回報結果 */
const lastFix = ref<{ id: string, title: string, at: number } | null>(null)
const postFixNote = ref('')

/** 點異常：直接去能修的那一頁（異常沒有導覽——導覽教的是怎麼設定，不是怎麼修壞掉的東西） */
function onFixAlert(alert: ResolvedAlert) {
  const wid = workspaceId.value
  if (!wid)
    return
  // 只追異常的修復結果；「可以更好」的建議在收件匣裡逐筆採用/忽略，沒有修好不修好
  if (alert.severity !== 'suggestion')
    lastFix.value = { id: alert.id, title: alert.title, at: Date.now() }
  closePanel()
  void router.push(alert.route(wid))
}

/**
 * 打開面板時檢查上次去修的異常有沒有好（超過 30 分鐘就不追了——太久以前的事，
 * 「修好了」的歸因已經不可信）。一定要 force：使用者剛改完設定，
 * 拿 60 秒內的快取會誤報「還沒好」。
 */
async function verifyLastFix() {
  const f = lastFix.value
  if (!f || Date.now() - f.at > 30 * 60_000) {
    lastFix.value = null
    await refreshAll()
    return
  }
  lastFix.value = null
  await refreshAll(true)
  const item = alerts.value.find(a => a.id === f.id)
  if (!item)
    return
  if (item.state === 'clear')
    postFixNote.value = `剛剛那件「${f.title}」看起來修好了！`
  else if (item.state === 'active')
    postFixNote.value = `「${f.title}」看起來還沒解決——有些修正要幾分鐘才生效，可以待會再按「重新檢查」。`
  // unknown：查不到就不下結論
}

/** 昨日摘要的出口：想看趨勢與明細就去統計頁（同一份口徑的完整版） */
function goStats() {
  const wid = workspaceId.value
  if (!wid)
    return
  closePanel()
  void router.push(`/admin/${wid}/conversation-stats`)
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

/** 導覽「完成」：閉環——重抓狀態、依結果回應、重開面板（回應顯示在「目前狀況」） */
async function onTourFinish() {
  const finishedId = lastTopicId.value
  clearDemo()
  endTour()
  panelTab.value = 'setup'
  // 一定要 force：使用者剛才就在改設定，這裡拿到舊快取就會誤報「還沒生效」
  await refresh({ force: true })
  const cap = finishedId ? capabilities.value.find(c => c.tourId === finishedId) : null
  if (cap) {
    postTourNote.value = cap.status === 'done'
      ? `「${cap.title}」完成了，太好了！`
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
  resetBrief()
  void refreshAll(true)
})

// 每次打開面板都重新體檢（有待驗證的修復就 force 並回報結果）；關閉時清掉一次性回應
watch(panelOpen, (open) => {
  if (open) {
    void verifyLastFix()
  }
  else {
    postTourNote.value = ''
    postFixNote.value = ''
  }
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
