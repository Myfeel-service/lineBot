<template>
  <!-- 常駐的教學 agent（預設右下角，可拖移）。樣式見 assets/scss/components/_tutorial-agent.scss -->
  <div
    class="tutorial-agent"
    :class="{ 'is-dragging': dragging, 'is-left': dockSide === 'left', 'is-top': dockVertical === 'top' }"
    :style="dockStyle"
  >
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
        ref="panelEl"
        class="ta-panel"
        role="dialog"
        aria-label="小幫手"
        tabindex="-1"
        @keydown.esc="closePanel"
      >
        <!-- 標頭也是拖曳把手（面板開著時要能搬）。關閉鈕照常點——
             onDragStart 會把「從按鈕上按下去」的手勢讓掉。
             `D-114`（2026-10-05 拍板）：三個分頁拿掉、合成一頁。以前「問／交辦」排第三格、打開先停在「目前狀況」，
             紅點講的又都是狀況，大家把它當警報、想不到能叫它做事。 -->
        <header class="ta-panel__head" @pointerdown="onDragStart">
          <div class="ta-panel__avatar"><el-icon><IconRobot /></el-icon></div>
          <div class="ta-panel__name">小幫手</div>
          <button class="ta-panel__close" aria-label="關閉" @click="closePanel"><el-icon><Close /></el-icon></button>
        </header>

        <!-- 「帶你修好」引導劇本（C-31 Phase 1）：跑劇本時整個面板讓給它，按返回才回分頁。
             關面板＝整段卸載（根是 v-if），runner 會 dispose、劇本就地停下 -->
        <AgentGuidePanel
          v-if="activeGuide"
          :key="activeGuide"
          :guide-id="activeGuide"
          class="ta-panel__guide"
          @close="activeGuide = null"
          @done="refreshAll(true)"
        />

        <!-- 全部教學（`D-114`：原本的「教學」分頁）：頁首「？」最下面那一行、`?tour=` 跑不起來時才會來 -->
        <div v-if="!activeGuide && view === 'catalogue'" class="ta-panel__body ta-catalogue">
          <div class="ta-catalogue__head">
            <button type="button" class="ta-catalogue__back" @click="view = 'main'">← 回到小幫手</button>
          </div>
          <div class="ta-catalogue__title">全部教學</div>
          <p class="ta-catalogue__hint">點一個，我在畫面上一步步帶你做。</p>
          <!-- 「看看你剛剛做的東西」（`D-95`，`C-250`②）：排在所有教學前面——剛打造完的人這一刻想確認的是
               「剛剛那幾樣建到哪去了」，全站地圖那 7 步對還沒接 LINE 的人一半是空的。⛔ 不自動跑，要他自己按。 -->
          <button
            v-if="builtTour.length"
            type="button"
            class="ta-option ta-option--sm ta-option--built"
            @click="startBuiltTour"
          >
            <span class="ta-option__icon"><el-icon><Box /></el-icon></span>
            <span class="ta-option__body">
              <span class="ta-option__label">
                看看你剛剛做的東西
                <span class="ta-option__steps">{{ builtTour.length }} 步</span>
              </span>
              <span class="ta-option__blurb">開帳那一趟建的那幾樣，各在哪一頁</span>
            </span>
            <span class="ta-option__arrow">→</span>
          </button>
          <div v-if="groupedTopics.length || walkthroughGuides.length" class="ta-review">
            <!-- 帶著做（D-40 補遺）：陪你做完並驗證的劇本。放最上面＝第一次用的人先看到；
                 跟下面「看一遍畫面」的導覽分開住，不然選單裡兩個都在教「怎麼放知識」分不出差別 -->
            <div v-if="walkthroughGuides.length" class="ta-review-group">
              <button
                class="ta-review-group__head"
                :aria-expanded="expandedGroups.has('walkthrough')"
                @click="toggleGroup('walkthrough')"
              >
                <span class="ta-review-group__title">帶著做（做完會幫你驗證）</span>
                <span class="ta-review-group__count">{{ walkthroughGuides.length }}</span>
                <span class="ta-review-group__chev" :class="{ open: expandedGroups.has('walkthrough') }">▾</span>
              </button>
              <div v-if="expandedGroups.has('walkthrough')" class="ta-review-group__body">
                <button
                  v-for="g in walkthroughGuides"
                  :key="g.id"
                  class="ta-option ta-option--sm"
                  @click="activeGuide = g.id"
                >
                  <span class="ta-option__icon"><el-icon><ChatDotRound /></el-icon></span>
                  <span class="ta-option__body">
                    <span class="ta-option__label">{{ g.title }}</span>
                    <span class="ta-option__blurb">{{ g.blurb }}</span>
                  </span>
                  <span class="ta-option__arrow">→</span>
                </button>
              </div>
            </div>

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
          <p v-else-if="!walkthroughGuides.length" class="ta-options__empty">目前沒有可用的教學主題。</p>
        </div>

        <!-- 「目前狀況」收成最上面這一條（`D-114`）：一句結論加顏色，按了往下展開完整內容。
             有紅色的事，打開時自動展開（`autoStatus`）——「壞了的事先講」不因為合成一頁就往後擠。 -->
        <button
          v-if="!activeGuide && view === 'main'"
          type="button"
          class="ta-strip"
          :class="`is-${strip.tone}`"
          :aria-expanded="statusOpen"
          aria-controls="ta-status"
          @click="toggleStatus"
        >
          <el-icon class="ta-strip__icon"><component :is="strip.icon" /></el-icon>
          <span class="ta-strip__text">{{ strip.text }}<span v-if="strip.sub" class="ta-strip__sub">{{ strip.sub }}</span></span>
          <span class="ta-strip__toggle">{{ statusOpen ? '收起' : '展開' }}<el-icon><component :is="statusOpen ? ArrowUp : ArrowDown" /></el-icon></span>
        </button>

        <div v-show="!activeGuide && view === 'main' && statusOpen" id="ta-status" class="ta-panel__body">
          <!-- 資料新鮮度（以前在標頭）：使用者真正想知道的是「這是多新的資訊」，＋全面板唯一一顆「重新檢查」 -->
          <div class="ta-fresh">
            <span>{{ headerFreshness }}</span>
            <button type="button" class="ta-fresh__btn" :disabled="busy" @click="refreshAll(true)">
              {{ busy ? '檢查中…' : '重新檢查' }}
            </button>
          </div>

          <!-- 導覽走完／異常修好的閉環回應：一個 agent 一個聲音，講在狀況最上面（有這兩句時打開會自動展開） -->
          <p v-if="postTourNote" class="ta-note" aria-live="polite">{{ postTourNote }}</p>
          <p v-if="postFixNote" class="ta-note" aria-live="polite">{{ postFixNote }}</p>

          <!-- 開通英雄卡（2026-08-20 拍板）：開通沒完成＝新帳號最大的問題，
               全面板最顯眼的設計——列出還缺哪幾步＋一顆大 CTA。
               有它的時候，下面的待辦清單不再重複列「接上 LINE」（英雄卡代言）。
               `D-114`：標題「還沒上線——…」由最上面那一條扛（同一句話不講兩遍），這裡只留步驟與按鈕 -->
          <div v-if="onboardingIncomplete" class="ta-hero">
            <div class="ta-hero__steps">
              <div v-for="st in onboardingSteps" :key="st.id" class="ta-hero__step" :class="{ 'is-done': st.done }">
                <span class="ta-hero__mark">{{ st.done ? '✓' : '○' }}</span>
                <span>{{ st.label }}</span>
              </div>
            </div>
            <!-- ⚠️ 鈕上的字吃 `onboardingBand.heroCta`（紅帶那顆同一份來源，照「接上了沒」換） -->
            <button type="button" class="ta-hero__cta" @click="goOnboardingChat">
              <el-icon><ChatDotRound /></el-icon>
              <span>{{ onboardingBand.heroCta }}</span>
            </button>
          </div>

          <!-- ⛔ 以前這裡有一顆「嗨 👋＋整段開場白」的泡泡（`agentLine`）：`D-114` 合成一頁後，
               它講的「有幾件事、還差幾項」最上面那一條已經講了，下面的卡片又各講一次＝同一件事講三遍，拿掉。 -->

          <!-- 開帳那一趟建了什麼、在哪裡（`D-89` 第二輪，`C-250`②）：精靈說「之後隨時可以改」，
               就要**給得出路**——知道在哪卻得自己去找，跟那句假承諾是同一種形狀。
               ⚠️ 只列採用了的；開通做完（接上 LINE＋用手機測試過）就收起來，那時候面板要講營運。 -->
          <div v-if="onboardingIncomplete && builtItems.length" class="ta-built">
            <div class="ta-built__title">開帳那一趟幫你建的，都在這裡（隨時可以改）</div>
            <button
              v-for="b in builtItems"
              :key="b.key"
              type="button"
              class="ta-built__row"
              @click="goBuilt(b)"
            >
              <span>{{ BUILT_PLACE[b.key]?.icon }} {{ b.label }}</span>
              <span class="ta-built__go">{{ BUILT_PLACE[b.key]?.page }} ›</span>
            </button>
            <!-- `D-114`：原本只在「教學」分頁，分頁拿掉後放在它講的那幾樣旁邊（全部教學裡也還有） -->
            <button v-if="builtTour.length" type="button" class="ta-built__tour" @click="startBuiltTour">
              <el-icon><View /></el-icon>
              <span>帶我看一遍（{{ builtTour.length }} 步）</span>
            </button>
          </div>

          <!-- 等你看過的知識卡（`C-250`③，示意頁 v80 的「知識卡」那一條）：⛔ 不是紅的——它不擋上線，
               只是會讓 AI 答得更好；也不跟「接上 LINE」一起收（接好 LINE 不代表卡看過了）。 -->
          <div v-if="draftCards > 0" class="ta-kbtodo">
            <div class="ta-kbtodo__t">📖 看過知識卡，它才答得出細節</div>
            <p class="ta-kbtodo__d">你網站整理出來的 <b>{{ draftCards }} 張卡</b>在等你看過。點頭進去之後，客人問<b>價格、細節</b>，它才答得出來。</p>
            <button type="button" class="ta-kbtodo__go" @click="goDrafts">去「知識庫」看 →</button>
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
                :class="g.key === 'notice' ? 'is-notice' : `is-${a.severity}`"
              >
                <button type="button" class="ta-alert__hit" @click="onFixAlert(a)">
                  <span class="ta-alert__icon"><el-icon><component :is="a.icon" /></el-icon></span>
                  <span class="ta-alert__main">
                    <span class="ta-alert__title">
                      {{ a.title }}
                      <span v-if="a.count" class="ta-alert__count">{{ a.count }}</span>
                      <!-- 系統側（D-8③）：使用者去點什麼都不會讓它好。仍然照嚴重度顯示
                           （llmError 就是客人問了得不到回答），但要當場說清楚不用他動手，
                           否則他會反覆點進去找不到能做的事，最後學會忽略整個面板。 -->
                      <!-- ⛔有一鍵修的不講「不用你操作」：有按鈕可按之後那句話就不是真的了（D-34） -->
                      <span v-if="a.owner === 'system' && !a.fixOpId" class="ta-alert__sys">不用你操作</span>
                    </span>
                    <span v-if="a.detail" class="ta-alert__detail">{{ a.detail }}</span>
                    <span class="ta-alert__impact">{{ a.impact }}</span>
                  </span>
                </button>
                <!--
                  動作收成一排真按鈕（2026-08-27）：這些是「怎麼修」的入口，原本是三行
                  11px 純文字靠右堆疊——長得像備註、點擊目標又只有一行字高。順序＝最短的路排最前
                  （一鍵 → 對話帶做 → 自己去那一頁），視覺重量也照這個順序遞減。
                  ⛔「暫停提醒」永遠排最後且維持淡色：它是降噪的退路，不是修法。
                -->
                <div class="ta-alert__actions">
                  <!-- 「幫我修」（D-34 一鍵修）：開確認 popup——先講會動哪幾筆、人按確定才執行 -->
                  <button
                    v-if="a.fixOpId"
                    type="button"
                    class="ta-alert__act ta-alert__act--primary"
                    @click="openFix(a)"
                  >幫我修</button>
                  <!-- 「用聊天帶我修」：有引導劇本的異常才有——把人留在面板裡一步步修＋當場驗證 -->
                  <button
                    v-if="a.guideId"
                    type="button"
                    class="ta-alert__act"
                    @click="openGuide(a)"
                  >用聊天帶我修</button>
                  <button type="button" class="ta-alert__act ta-alert__act--ghost" @click="onFixAlert(a)">
                    {{ a.cta }}
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
            </div>

            <!-- 「沒有發現異常」只在必要設定完成後才講：還沒開通的帳號量不出營運異常，
                 這句安心話會蓋過「還不能上線」的重點（2026-08-07 老闆回饋：新帳號看起來像沒事） -->
            <div v-if="alertsLoaded && !activeAlerts.length && allRequiredDone" class="ta-alerts-clear">
              目前沒有發現異常{{ alertsCheckedCount ? `——這次檢查了 ${alertsCheckedCount} 項` : '' }}。
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
            <!-- 新朋友：跟對話是兩件事（加了好友沒開口不算對話），所以自成一行、不進下面的母數。
                 沒有新朋友的日子不顯示 0——日報講發生了什麼，不逐條報「沒發生」 -->
            <p v-if="briefY.newFriends > 0" class="ta-brief__friends">
              新朋友 <b>+{{ briefY.newFriends }}</b> 位加了好友
            </p>
            <p v-if="!briefY.total" class="ta-brief__empty">昨天沒有客人對話。</p>
            <template v-else>
              <!-- 母數：全卡唯一的大字，底下每個數字都是它的一部分（單位統一用統計頁的「場」） -->
              <div class="ta-brief__total">
                <span class="ta-brief__num">{{ briefY.total }}</span>
                <span class="ta-brief__label">場對話</span>
                <!-- 帶單位：只寫「前天 12」要讀的人自己猜它跟左邊那個大數字是不是同一種東西 -->
                <span class="ta-brief__delta">前天 {{ briefD?.total ?? 0 }} 場</span>
              </div>

              <!-- 問題一：互斥分項，加起來一定等於母數——讀的人不必自己減 -->
              <div class="ta-brief__split">
                <span class="ta-brief__q">第一句話是誰回的</span>
                <div class="ta-brief__parts">
                  <span
                    v-for="p in briefParts"
                    :key="p.key"
                    class="ta-brief__part"
                    :class="{ 'is-warn': p.warn, 'is-zero': !p.value }"
                  >{{ p.label }} <b>{{ p.value }}</b></span>
                </div>
              </div>

              <!-- 問題二：子集，不是第四類。「這 N 場裡」這幾個字就是防止被拿去相加的關鍵。
                   ⛔ 試過在這兩排各加一條比例長條（上排滿格、下排 69%），老闆判定沒有變好：
                   上排永遠填滿等於把數字再畫一次，兩條灰軌道疊起來像進度條／載入骨架。
                   這張卡只有三四個數字，不需要圖——別再加回來。 -->
              <p class="ta-brief__sub">
                這 {{ briefY.total }} 場裡，後來轉給真人的 <b>{{ briefY.handoffs }}</b> 場
              </p>

              <!-- 沒人回＝日報裡唯一要行動的事，所以直接點名、點名字開那場對話。
                   刻意不連去「篩選過的收件匣」：統計的「沒人回」與收件匣的「待處理」是兩群對話
                   （定義書明文），開單場對話就不會撞口徑。名單查不到時退回純文字提醒。 -->
              <p v-if="briefY.unhandled" class="ta-brief__warn">
                <template v-if="briefY.unhandledSamples.length">
                  {{ briefY.unhandled }} 場沒人回{{ unhandledSpike ? '（比平常多）' : '' }}：
                  <button
                    v-for="u in briefY.unhandledSamples"
                    :key="u.userId"
                    type="button"
                    class="ta-brief__warnlink"
                    @click="goConversation(u.userId)"
                  >{{ u.displayName }}</button>
                  <!-- 只點名 3 位，剩下的要有出口，否則「看到 8 場只能點 3 個」＝死路。
                       goStats 會帶上這一天的日期，所以進去看到的就是同一批（見 goStats 註解） -->
                  <button
                    v-if="briefY.unhandled > briefY.unhandledSamples.length"
                    type="button"
                    class="ta-brief__warnlink"
                    @click="goStats"
                  >…等 {{ briefY.unhandled }} 位</button>
                </template>
                <template v-else>
                  有客人一整天沒收到回覆{{ unhandledSpike ? '，比平常多' : '' }}，建議去看一下。
                </template>
              </p>

              <!-- 等太久：轉真人後超過 SLA 才等到人（或到現在還沒等到）。門檻印實際設定值，
                   不寫死 30——工作區改了 SLA 這裡要跟著講實話。同「沒人回」的點名模式。
                   下班時段的等待分開講（拍板選項 c）：全部都是下班進來的就退成灰色，
                   否則這行天天紅字＝狼來了。點名優先列服務時間內那幾場（後端已排序）。 -->
              <p v-if="waitLine" class="ta-brief__warn" :class="{ 'is-mild': waitAllOffHours }">
                {{ waitLine }}<template v-if="briefY.handoffWaitSamples.length">：
                  <button
                    v-for="u in briefY.handoffWaitSamples"
                    :key="u.userId"
                    type="button"
                    class="ta-brief__warnlink"
                    @click="goConversation(u.userId)"
                  >{{ u.displayName }}</button>
                  <button
                    v-if="briefY.handoffWaitExceeded > briefY.handoffWaitSamples.length"
                    type="button"
                    class="ta-brief__warnlink"
                    @click="goStats"
                  >…等 {{ briefY.handoffWaitExceeded }} 位</button>
                </template>
              </p>
              <p v-if="trendLine" class="ta-brief__warn">{{ trendLine }}</p>
            </template>
          </div>

          <!-- 節慶行銷提醒（2026-08-28 老闆拍板：不再只在 LINE）。
               LINE 那則是 7／3／1 天各一次的一次性訊息；這張卡是**常駐**的——
               窗內每天打開面板都看得到，文案跟 LINE 同一支函式產（festival-hint.ts）。
               排在昨日摘要後面：先講營運、再講行銷，跟 LINE 那則的段落順序同一套。
               開通沒完成不顯示（連客人都還進不來，排什麼推播）。 -->
          <div v-if="festival && !onboardingIncomplete" class="ta-festival">
            <div class="ta-festival__head">🎉 {{ festival.name }}快到了</div>
            <p class="ta-festival__text">{{ festival.text }}</p>
            <!-- `D-112` 第 1 件：系統先發現該做的事，卡片一按就叫它開工（Shopify／Zendesk／Square 的主要做法）。
                 它會先問要發什麼、建的只是草稿；發送照舊要他自己到推播頁按（紅線）。
                 沒有建推播權限的人只看到原本那條路。 -->
            <div v-if="can(ADMIN_OP_CAPABILITY[AGENT_FESTIVAL_ASK.op])" class="ta-alert__actions">
              <button type="button" class="ta-alert__act ta-alert__act--primary" @click="askFestival">交給小幫手擬草稿</button>
              <button type="button" class="ta-alert__act ta-alert__act--ghost" @click="goBroadcasts">去推播頁</button>
            </div>
            <button v-else type="button" class="ta-festival__cta" @click="goBroadcasts">去排推播 →</button>
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
            <!-- 開通期不顯示：英雄卡＋待辦已把狀態講完，第三份記帳只會吵（D-20 ④）；
                 「重新檢查」開通期搬到英雄卡上 -->
            <div v-if="!onboardingIncomplete" class="ta-progress">
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
                <!-- 「重新檢查」搬到狀況最上面那一行（`D-114`：一頁裡只留一顆） -->
              </div>
              <!-- 定位說明在下面加分項區塊的標題講，這裡只報數，同一句話不講兩遍 -->
              <div v-if="optionalTotal" class="ta-progress__optional">
                加分項 {{ optionalDone }}/{{ optionalTotal }}
              </div>
            </div>

            <!-- 開通步驟：必要項照依賴順序編號（先接 LINE 才輪得到 AI）。
                 跟加分項拆成兩塊——同重量的卡混排讀不出「先做哪個」（2026-08-07） -->
            <div v-if="todosForList.length" class="ta-todos">
              <div class="ta-todos__head ta-todos__head--required">先做這 {{ todosForList.length }} 件，機器人才會動</div>
              <!-- `D-112` 第 1 件：小幫手做得到的那幾項多一顆「交給小幫手」。
                   ⛔ 按鈕不能包按鈕，所以有那顆的卡改成 div 包兩顆真按鈕（同異常卡的做法） -->
              <template v-for="(cap, i) in todosForList" :key="cap.id">
                <div v-if="todoAsk(cap)" class="ta-todo ta-todo--required ta-todo--split">
                  <button type="button" class="ta-todo__hit" @click="onFix(cap)">
                    <span class="ta-todo__step">{{ i + 1 }}</span>
                    <span class="ta-todo__main">
                      <span class="ta-todo__title">{{ cap.title }}</span>
                      <span class="ta-todo__why">{{ cap.why }}</span>
                      <span class="ta-todo__cta">{{ cap.guideId || cap.tourId ? '帶我做 →' : '前往設定 →' }}</span>
                    </span>
                  </button>
                  <div class="ta-alert__actions ta-todo__actions">
                    <button type="button" class="ta-alert__act ta-alert__act--primary" @click="askTodo(cap)">交給小幫手</button>
                  </div>
                </div>
                <button
                  v-else
                  class="ta-todo ta-todo--required"
                  @click="onFix(cap)"
                >
                  <span class="ta-todo__step">{{ i + 1 }}</span>
                  <span class="ta-todo__main">
                    <span class="ta-todo__title">{{ cap.title }}</span>
                    <span class="ta-todo__why">{{ cap.why }}</span>
                    <span class="ta-todo__cta">{{ cap.guideId || cap.tourId ? '帶我做 →' : '前往設定 →' }}</span>
                  </span>
                </button>
              </template>
            </div>

            <!-- 加分項：定位由分組標題講一次，卡上不再各掛「必要/加分」小標籤 -->
            <div v-if="incompleteOptional.length" class="ta-todos">
              <div class="ta-todos__head">加分項（做了 AI 更好用，不做也能上線）</div>
              <template v-for="cap in incompleteOptional" :key="cap.id">
                <div v-if="todoAsk(cap)" class="ta-todo ta-todo--split">
                  <button type="button" class="ta-todo__hit" @click="onFix(cap)">
                    <span class="ta-todo__icon"><el-icon><component :is="cap.icon" /></el-icon></span>
                    <span class="ta-todo__main">
                      <span class="ta-todo__title">{{ cap.title }}</span>
                      <span class="ta-todo__why">{{ cap.why }}</span>
                      <span class="ta-todo__cta">{{ cap.guideId || cap.tourId ? '帶我做 →' : '前往設定 →' }}</span>
                    </span>
                  </button>
                  <div class="ta-alert__actions ta-todo__actions">
                    <button type="button" class="ta-alert__act ta-alert__act--primary" @click="askTodo(cap)">交給小幫手</button>
                  </div>
                </div>
                <button
                  v-else
                  class="ta-todo"
                  @click="onFix(cap)"
                >
                  <span class="ta-todo__icon"><el-icon><component :is="cap.icon" /></el-icon></span>
                  <span class="ta-todo__main">
                    <span class="ta-todo__title">{{ cap.title }}</span>
                    <span class="ta-todo__why">{{ cap.why }}</span>
                    <span class="ta-todo__cta">{{ cap.guideId || cap.tourId ? '帶我做 →' : '前往設定 →' }}</span>
                  </span>
                </button>
              </template>
            </div>

            <!-- 缺項巡覽：次要出口，擺清單後面——跟主 CTA 並排會互搶 -->
            <button
              v-if="incompleteAll.length"
              class="ta-gaptour"
              @click="startGapTour"
            >
              <el-icon><View /></el-icon>
              <span>帶我看一遍還沒做的</span>
            </button>

            <!-- 必要項都完成：閉環到「上線前先試答」，不要停在恭喜就沒了 -->
            <div v-if="!incompleteAll.length" class="ta-alldone">
              <p class="ta-alldone__msg">必要設定都完成了，可以上線囉！</p>
              <p class="ta-alldone__hint">正式讓 AI 回客人之前，建議先自己試答幾題，確認答得穩。</p>
              <button class="ta-alldone__cta" @click="startTopicById('ai-playground')">
                去試答看看 →
              </button>
            </div>

            </template>
          </template>
        </div>

        <!-- 對話：一直在狀況條下面（`D-114`）。用 v-show 不用 v-if——看一眼狀況或全部教學再回來，
             對話與捲動位置要還在，不然問到一半去對照狀態就等於重問一次。
             狀況展開時只藏對話紀錄、⛔ 不藏輸入框：任何時候都能直接打字，這正是合成一頁的理由。 -->
        <AdminAgentChat
          v-show="!activeGuide && view === 'main'"
          ref="chatRef"
          class="ta-panel__chat"
          :class="{ 'is-input-only': statusOpen }"
          :list-hidden="statusOpen"
          @engage="onChatEngage"
        />

        <!-- 頁尾只剩兩種時候要講話：劇本跑著（講它怎麼運作）、面板被搬過（回原位的退路）。
             ⛔ 以前「問／交辦」那行紅線（發推播、回客人…一律要你自己按）收進「我會做的 15 件」了（`D-114` 第 3 題） -->
        <footer v-if="activeGuide || moved" class="ta-panel__foot">
          <span>{{ activeGuide ? GUIDE_FOOT_NOTE : '' }}</span>
          <button v-if="moved" type="button" class="ta-panel__foot-reset" @click="resetPos">移回右下角</button>
        </footer>
      </section>
    </Transition>

    <!-- 浮動按鈕（也是拖曳把手：按住可以把整個小幫手搬到不擋事的位置） -->
    <button
      ref="fabRef"
      class="ta-fab"
      data-tour="ta-fab"
      :class="{ 'ta-fab--open': panelOpen }"
      :aria-label="panelOpen ? '關閉小幫手' : '開啟小幫手'"
      title="按住可以拖到別的位置"
      @pointerdown="onDragStart"
      @click="onFabClick"
    >
      <span class="ta-fab__icon"><el-icon><component :is="panelOpen ? Close : IconRobot" /></el-icon></span>
      <!-- 光暈等資料回來才閃：不然設定齊全的帳號每次載入都先閃一下（狼來了） -->
      <span v-if="!panelOpen && (criticalAlerts.length || (loaded && !allRequiredDone))" class="ta-fab__pulse" aria-hidden="true" />
      <!-- 「可以更好」的低調訊號（D-43③，2026-08-31 拍板）：面板裡有建議時 FAB 上完全沒訊號，
           等於永遠沒人知道要點開。規則＝紅色數字（badgeCount）永遠優先，只有它是 0 才畫這顆；
           刻意是靜態小灰點、不呼吸不計數——「會不會動」是嚴重度語言，建議級不可以搶那個頻道。 -->
      <span
        v-if="!panelOpen && !badgeCount && suggestionBadgeCount"
        class="ta-fab__hint"
        role="img"
        :aria-label="`有 ${suggestionBadgeCount} 個可以更好的建議`"
      />
      <!-- 數字＝「現在壞著」＋「必要設定沒做」，一律紅：還沒上線本身就是大問題
           （2026-08-07 拍板，取代先前「純設定缺項用中性色」的分色）。黃色警示項不進數字 -->
      <span
        v-if="!panelOpen && badgeCount"
        class="ta-fab__badge"
        :aria-label="badgeLabel"
      >{{ badgeCount }}</span>
    </button>

    <!-- 導覽（Element Plus Tour）；locale 一定要用 zh-tw：zh-cn 的「結束導覽／關閉此對話框」是簡體 -->
    <ClientOnly>
      <el-config-provider :locale="zhTw">
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
              v-if="step.actionTopicId || step.actionGuideId"
              type="primary"
              size="small"
              class="ta-tour-action"
              @click="onStepAction(step.actionTopicId, step.actionGuideId)"
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
import type { AgentGuideId } from '~/utils/agent-guides'
import { ArrowDown, ArrowUp, Box, ChatDotRound, CircleCheckFilled, CircleCloseFilled, Close, Loading, QuestionFilled, View, WarningFilled } from '@element-plus/icons-vue'
import type { TutorialStep } from '~/utils/tutorial-topics'
import {
  BUILT_PLACE,
  LANDING_FROM_BUILD,
  LANDING_FROM_LINE,
  type OnboardingBuiltItem,
  builtTourSteps,
  hasTriedPlayground,
  landingTourSteps,
  liveTourSteps,
  readOnboardingBuilt,
} from '~/utils/onboarding-landing'
import IconRobot from '~/components/icons/IconRobot.vue'
import zhTw from 'element-plus/es/locale/lang/zh-tw'
import { festivalHint } from '~/utils/festival-hint'
import { taipeiDate } from '~~/shared/time'
import { ADMIN_OP_CAPABILITY, AGENT_FESTIVAL_ASK, AGENT_SETUP_ASKS } from '~~/shared/agent-entry'
import { useOnboardingEvents } from '~/composables/useOnboardingEvents'

const { user } = useAuth()
const { workspaceId, ensureWorkspaceList, can } = useWorkspace()
/** 開通步驟紀錄：這裡只記落地那兩支導覽走完或關掉（`C-250`③） */
const { track: trackOnboarding } = useOnboardingEvents({ workspaceId: () => workspaceId.value, flow: () => 'other' })
const router = useRouter()
// 只給 ?tour= 深連結用（開通引導結尾送人進來時開跑那一支）。
// ⛔ 教學清單本身刻意不看當前路由：那件事由每頁頁首的「？」負責，不要長出第二套入口邏輯。
const route = useRoute()

/**
 * 面板只有一頁（`D-114`，2026-10-05 拍板，以前是「目前狀況／教學／問／交辦」三個分頁）：
 * 最上面一條「目前狀況」（`statusOpen` 決定展不展開）＋下面一直是對話。
 * `catalogue`＝全部教學（原本的「教學」分頁），只從頁首「？」最下面那一行、`?tour=` 的退路進來。
 */
const view = ref<'main' | 'catalogue'>('main')
const statusOpen = ref(false)
const {
  panelOpen,
  tourOpen,
  tourStep,
  groupedTopics,
  activeSteps,
  lastTopicId,
  requestedGuideId,
  requestedPanelView,
  stepCount,
  openPanel,
  closePanel,
  togglePanel,
  startTopic,
  startTopicById,
  startAdHocTour,
  endTour,
  askAgent,
  openPanelView,
} = useTutorial()
const {
  capabilities,
  hasItems,
  incompleteAll,
  incompleteRequired,
  onboardingIncomplete,
  onboardingSteps,
  onboardingBand,
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
  noticeAlerts,
  snoozedAlerts,
  unknownAlerts: unknownAlertItems,
  checkedCount: alertsCheckedCount,
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
// 一鍵修 popup（D-34）：openFix 只塞開窗狀態，dialog 本體掛在 layout（AlertFixDialog）
const { openFix } = useAlertFix()
const { brief, loading: briefLoading, refresh: refreshBrief, reset: resetBrief } = useDailyBrief()
const { setDemo, clearDemo } = useFlowDemo()
// 可拖移（2026-08-27）：右下角常常正好壓著要看的東西，讓人搬走並記住位置
const { fabRef, dockStyle, dockSide, dockVertical, dragging, moved, onDragStart, consumeDrag, resetPos } = useAgentDock()

/**
 * 設定就緒度 + 目前異常一起重查。
 * force 用在「使用者按重新檢查」與「剛跑完導覽要確認有沒有生效」——這兩種情境
 * 一定要拿到當下的真實狀態，不能被節流擋掉回舊答案。
 *
 * ⛔ 昨日摘要**不在這裡**：它只長在面板裡（`ta-brief`），而這個元件掛在 layout 上
 * ＝每一頁都會跑一次 `onMounted`。原本一起抓的話，面板還沒打開就先打了 3 支 KPI
 * （昨天／前天／前七天基準），每支都要掃一遍對話場——2026-08-27 正式站實測，
 * 好友頁與圖文選單頁「最後才回來」的就是這三支，對話統計那支等了 4.4 秒，
 * 而使用者根本沒打開面板、查完沒有人看。改由下面的 `watch(panelOpen)` 在打開時才查。
 */
function refreshAll(force = false) {
  const tasks = [refresh({ force }), refreshAlerts({ force })]
  // 面板已經開著時（例如按面板裡的「重新檢查」）摘要要跟著更新，否則畫面上的數字會停在舊的
  if (panelOpen.value)
    tasks.push(refreshBrief({ force }))
  return Promise.all(tasks)
}

// 摘要改成「打開面板才查」之後，它的載入也要算進 busy：否則面板剛打開的那幾秒，
// 摘要區塊還不存在、header 卻寫「剛剛檢查」、「重新檢查」也能按，數字晚幾秒才突然長出來
const busy = computed(() => loading.value || alertsLoading.value || briefLoading.value)

/** 紅點：現在壞著的 + 必要設定沒做的。兩者都是「不處理就有事」，合成一個數字才不會互相遮蔽 */
/** 英雄卡在場時「接上 LINE」由它代言，必要待辦不再重複列同一件事 */
const todosForList = computed(() =>
  onboardingIncomplete.value
    ? incompleteRequired.value.filter(c => c.id !== 'lineConnected')
    : incompleteRequired.value,
)

const badgeCount = computed(() => criticalAlerts.value.length + incompleteRequired.value.length)
/** 「可以更好」的建議總數（notice「供你參考」不算）：FAB 小灰點與開場白共用同一個數 */
const suggestionBadgeCount = computed(() => suggestionAlerts.value.reduce((s, a) => s + (a.count ?? 1), 0))
const badgeLabel = computed(() => {
  const parts: string[] = []
  if (criticalAlerts.value.length)
    parts.push(`${criticalAlerts.value.length} 個地方需要處理`)
  if (incompleteRequired.value.length)
    parts.push(`${incompleteRequired.value.length} 項必要設定未完成`)
  return parts.join('、')
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
const briefD = computed(() => brief.value?.dayBefore ?? null)

/**
 * 節慶行銷提醒（判定與文案在 utils/festival-hint.ts，跟 LINE 那則同一套來源）。
 * 日期用台北時區的「今天」：直接拿本機日期的話，凌晨（台北已換日、UTC 還沒）會慢一天。
 * 只在面板打開的當下算一次就夠——節日窗是以「天」為單位的東西，不需要反應式跟著時鐘走。
 */
const festival = computed(() => festivalHint(taipeiDate()))
function goBroadcasts() {
  closePanel()
  void navigateTo(`/admin/${workspaceId.value}/broadcasts`)
}

/**
 * 「交給小幫手」（`D-112` 第 1 件）：切到「問／交辦」並替他講那一句（直接送出）。
 * 句子在 shared/agent-entry（測試釘住對得上真的代辦）；權限照那件代辦本身的門檻。
 */
function askFestival() {
  const f = festival.value
  if (!f) return
  askAgent({ text: AGENT_FESTIVAL_ASK.text(f.name), send: true, source: 'status-card' })
}
function todoAsk(cap: ResolvedCapability) {
  const a = AGENT_SETUP_ASKS[cap.id]
  return a && can(ADMIN_OP_CAPABILITY[a.op]) ? a : null
}
function askTodo(cap: ResolvedCapability) {
  const a = todoAsk(cap)
  if (a) askAgent({ text: a.text, send: true, source: 'status-card' })
}
/**
 * 「第一句話誰回的」的互斥分項：**只有加起來等於總場數的東西可以並排**。
 * 這一排的全部價值就是「不用自己減」——所以舊資料湊不到總數時要補一格「其他」，
 * 而不是讓它靜靜地對不起來（那就退回原本被誤讀的狀態了）。
 */
const briefParts = computed(() => {
  const y = briefY.value
  if (!y)
    return []
  const parts = [
    { key: 'auto', label: '機器人／AI', value: y.autoFirst, warn: false },
    { key: 'human', label: '客服', value: y.humanFirst, warn: false },
    // 0 的時候是好消息，不該長得像警告；>0 才轉警示色
    { key: 'none', label: '沒人回', value: y.unhandled, warn: y.unhandled > 0 },
  ]
  const rest = y.total - y.autoFirst - y.humanFirst - y.unhandled
  if (rest > 0)
    parts.push({ key: 'rest', label: '其他', value: rest, warn: false })
  return parts
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
/**
 * 「等太久」那一行的句子（拍板選項 c：下班時段分開講）。
 * 組在 script 不塞樣板：三層條件寫成巢狀三元後沒人看得懂，改文案也不敢動。
 * 全部都是下班進來的 → 講「都是」，不要出現「8 場…其中 8 場」這種廢話。
 */
const waitLine = computed(() => {
  const y = briefY.value
  if (!y?.handoffWaitExceeded)
    return ''
  const base = `${y.handoffWaitExceeded} 場客人等超過 ${y.handoffWaitSlaMinutes} 分鐘`
  if (!y.handoffWaitOffHours)
    return base
  return y.handoffWaitOffHours >= y.handoffWaitExceeded
    ? `${base}（都是下班時間進來的）`
    : `${base}（其中 ${y.handoffWaitOffHours} 場是下班時間進來的）`
})
/** 全部都落在下班時段＝沒有一場是客服能檢討的 → 退成灰色，別天天紅字喊狼來了 */
const waitAllOffHours = computed(() => {
  const y = briefY.value
  return Boolean(y?.handoffWaitExceeded && y.handoffWaitOffHours >= y.handoffWaitExceeded)
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

/** 開通沒完成時最上面那一條講的話（`C-250`②，示意頁 v80：講後果講他在乎的那一件——客人找不到他，⛔ 不講「機器人」這種我們的詞） */
const NOT_LIVE_TITLE = '還沒上線——客人還找不到你的 MiniMe'

/**
 * 「還不能上線」的後果句：依缺的是哪個根結講——LINE 沒接＝訊息完全進不來、
 * 什麼都不會回；LINE 有接但 AI 沒開＝收得到但 AI 不會回。
 * 一律講後果、不講進度（2026-08-07 老闆回饋：新帳號整片綠、看不出
 * 「客人現在得不到任何回應」有多嚴重）。
 */
const notLiveConsequence = computed(() =>
  capabilities.value.find(c => c.id === 'lineConnected')?.status === 'incomplete'
    ? '客人傳訊息進來，不會有任何回應'
    // ⛔仍然別寫「訊息進得來」：2026-08-21 起 lineConnected 已經會真的去問 LINE
    // （網址有設、開關有開才算完成，見 D-15(b)），但那驗的是**送得出來**——
    // 第二把鑰匙（Channel Secret）貼錯的話，LINE 送過來會被我方簽章擋掉，
    // 這裡照樣看不出來。宣稱「進得來」的唯一鐵證是真的收過一則（firstMessageReceived）。
    : 'AI 還沒開，客人的問題沒有人回',
)

/** 加分項還沒做的：必要項在「開通步驟」區編號講，這一份只剩加分，兩塊分開呈現 */
const incompleteOptional = computed(() => incompleteAll.value.filter(c => !c.required))

/**
 * 結論先行的狀態列：紅（正在影響客人）→ 紅（還不能上線）→ 橘（建議處理）→ 綠（一切正常）。
 * 「查不到」不能歸進任何一級，單獨講。
 * FAB 紅點數字＝critical＋必要設定缺項，所以有異常時頭條也要把缺項帶上——
 * 按鈕寫 3、打開卻只講 1 件事，兩個最顯眼的數字就對不上了。
 * ⛔「差 N 項就能上線」的品牌綠進度講法被否決（好消息的長相）；先改橘、
 * 2026-08-07 老闆再拍板升紅：還沒上線本身就是大問題，且要排在「建議處理」級之前，
 * 不能被一顆橘色警告把頭條搶走。
 */
const verdict = computed<{ tone: string, icon: Component, text: string } | null>(() => {
  if (criticalAlerts.value.length) {
    const setupTail = loaded.value && incompleteRequired.value.length
      ? `、另差 ${incompleteRequired.value.length} 項必要設定`
      : ''
    return { tone: 'danger', icon: CircleCloseFilled, text: `${criticalAlerts.value.length} 件事正在影響客人${setupTail}` }
  }
  // 開通未完成＝英雄卡整塊代言，結論列不另出一條（2026-08-20 拍板：兩塊統一成一塊）。
  // ⛔要 return null 擋在這裡，不能讓它往下掉到「一切正常」——還沒開通不是正常
  if (loaded.value && onboardingIncomplete.value)
    return null
  if (loaded.value && incompleteRequired.value.length)
    return { tone: 'danger', icon: CircleCloseFilled, text: `還不能上線：${notLiveConsequence.value}（差 ${incompleteRequired.value.length} 項必要設定）` }
  if (warningAlerts.value.length)
    return { tone: 'warning', icon: WarningFilled, text: `${warningAlerts.value.length} 件事建議處理` }
  if (!alertsLoaded.value)
    return alertsFailed.value ? { tone: 'muted', icon: QuestionFilled, text: '目前檢查不到狀態' } : null
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

/**
 * 異常分組呈現：紅（影響客人中）、橘（建議處理）、藍（可以更好——沒壞，是機會）、
 * 灰（供你參考——連機會都不是，純告知）。
 *
 * 第四組是 2026-08-27 分出來的：「發票還在開立中」原本掛在「可以更好」裡，
 * 但那一組的組名在講「採用了 AI 會答更好」，而發票這張是「你什麼都不用做」——
 * 語氣不合，讀的人會卡住。灰色、排最後，不跟有事可做的建議搶注意力。
 */
const alertGroups = computed(() => [
  { key: 'critical', label: '現在影響客人', items: criticalAlerts.value },
  { key: 'warning', label: '建議處理', items: warningAlerts.value },
  { key: 'suggestion', label: '可以更好', items: suggestionAlerts.value },
  { key: 'notice', label: '供你參考（不用處理）', items: noticeAlerts.value },
].filter(g => g.items.length))

/**
 * 最上面那一條（`D-114`）：結論沿用 `verdict`（紅點、頭條同一套口徑），收起來時也看得到。
 * - 開通沒完成＝英雄卡的標題搬上來（開通期 verdict 回 null，見上面）
 * - 一切正常時補一小段：知識庫還空著要點名（AI 開著卻答不出來，⛔ 不能只講「一切正常」——
 *   以前這句在開場白裡講，開場白拿掉後搬到這裡）→ 有「可以更好」的建議 → 昨天幾場對話
 */
const strip = computed<{ tone: string, icon: Component, text: string, sub: string }>(() => {
  const v = verdict.value
  if (v) {
    if (v.tone !== 'ok')
      return { ...v, sub: '' }
    let sub = ''
    if (hasItems.value && capabilities.value.find(c => c.id === 'knowledgeReady')?.status === 'incomplete')
      sub = '・知識庫還是空的'
    else if (suggestionBadgeCount.value)
      sub = `・${suggestionBadgeCount.value} 個可以更好的建議`
    else if (briefY.value)
      sub = `・昨天 ${briefY.value.total} 場對話`
    return { ...v, sub }
  }
  if (loaded.value && onboardingIncomplete.value)
    return { tone: 'danger', icon: CircleCloseFilled, text: NOT_LIVE_TITLE, sub: '' }
  return { tone: 'muted', icon: Loading, text: '我先幫你看一下目前的狀況…', sub: '' }
})

/**
 * 什麼時候自動展開：紅的（正在影響客人、還不能上線）＋導覽走完／修好了有話要講。
 * ⛔ 只在他還沒自己動過之前才自動——資料晚一點回來、背景重查冒出新紅燈時，
 *    他可能正在打字，這時把對話收掉換成狀況＝搶走他手上的事。
 */
let statusTouched = false
function autoStatus() {
  if (statusTouched)
    return
  statusOpen.value = strip.value.tone === 'danger' || Boolean(postTourNote.value || postFixNote.value)
}
function toggleStatus() {
  statusTouched = true
  statusOpen.value = !statusOpen.value
}
/** 他開始講話了（送出、按了建議）：狀況收起來，把位子還給對話 */
function onChatEngage() {
  statusTouched = true
  statusOpen.value = false
}
watch(() => strip.value.tone, () => {
  if (panelOpen.value)
    autoStatus()
})

/** 劇本跑著時頁尾那一句：講它怎麼運作（以前每個分頁各一句，分頁拿掉後只剩這一句） */
const GUIDE_FOOT_NOTE = '跟著做就好——每一步完成，我都會真的檢查有沒有生效。'

const chatRef = ref<{ focusInput: (glow?: boolean) => void } | null>(null)

function onPick(topic: Parameters<typeof startTopic>[0]) {
  void startTopic(topic)
}

// ── 開帳那一趟建了什麼（`C-250`②）─────────────────────────────
/** 這台瀏覽器記著的那份（精靈結尾寫進去，見 `utils/onboarding-landing.ts`） */
const builtItems = ref<OnboardingBuiltItem[]>([])
function loadBuiltItems() {
  builtItems.value = workspaceId.value ? readOnboardingBuilt(workspaceId.value) : []
}
const builtTour = computed(() => builtTourSteps(builtItems.value))
const { showToast } = useAdminToast()
function goBuilt(b: OnboardingBuiltItem) {
  const wid = workspaceId.value
  const place = BUILT_PLACE[b.key]
  if (!wid || !place) return
  closePanel()
  void router.push(place.path(wid))
  showToast(`「${b.label}」就在這一頁，改完存檔就生效`, 'info')
}
/** 指的是側欄那幾列（恆常存在），⛔ 不先換頁——換了反而把他剛看的東西蓋掉 */
function startBuiltTour() {
  void startAdHocTour(builtTour.value)
}

// ── 等你看過的知識卡（`C-250`③）──────────────────────────────
const { apiFetch } = useWorkspace()
const draftCards = ref(0)
async function loadDraftCards() {
  if (!workspaceId.value) {
    draftCards.value = 0
    return
  }
  try {
    // `summary=1`：只要張數（⛔ 每次打開面板都讀全部卡片全文只為了一個數字，code review 抓到）
    const r = await apiFetch<{ total: number }>('/api/ai/knowledge/drafts?summary=1')
    draftCards.value = r.total
  }
  catch { draftCards.value = 0 /* 查不到就不提（⛔ 不猜一個數字） */ }
}
function goDrafts() {
  const wid = workspaceId.value
  if (!wid) return
  closePanel()
  void router.push(`/admin/${wid}/knowledge/sources?drafts=1`)
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

/**
 * 點待辦：有劇本就跑劇本 → 其次導覽 → 都沒有才導到設定頁。
 *
 * 劇本優先（D-40）：導覽只教「畫面長怎樣」，跑完不知道你到底做完了沒有；
 * 劇本會等真訊號、做完還會補最後一哩（例如知識放好了但 AI 開關還關著）。
 * ⛔面板要留著：劇本是跑在面板裡的，closePanel 會把它關掉。
 */
function onFix(cap: ResolvedCapability) {
  if (cap.guideId) {
    activeGuide.value = cap.guideId
    return
  }
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
 * 「帶你修好」引導劇本（C-31 Phase 1）：跑在面板裡、一步步修＋當場驗證，
 * 跟 onFixAlert 的差別是人不離開面板。劇本註冊在 utils/agent-guides，
 * 哪些異常有劇本看註冊表的 guideId。
 */
const activeGuide = ref<AgentGuideId | null>(null)

/**
 * 「帶著做」清單（教學分頁最上區＋頁首問號都吃這份）。
 * 角色過濾跟導覽同一把尺：跑不動的劇本整條不出現，不要出現按了才說沒權限的按鈕。
 */
const walkthroughGuides = computed(() =>
  WALKTHROUGH_GUIDES
    .filter(g => can(g.requires))
    .map(g => ({ ...g, title: AGENT_GUIDES[g.id].title })),
)

// 面板外的入口（頁首問號）要開劇本時會把 id 留在這格共享狀態（useTutorial.openGuide）
watch(requestedGuideId, (id) => {
  if (!id)
    return
  requestedGuideId.value = null
  if (id in AGENT_GUIDES)
    activeGuide.value = id as AgentGuideId
})
// 聊天回答裡那張「打開目前狀況」卡（`D-109`）、卡片與頁面上的「交給小幫手」（`D-112`）、
// 頁首「？」的「看全部教學」（`D-114`）：面板狀態在這裡，別的元件用這格共享狀態傳話。
// ⚠️ 跟下面的 watch(panelOpen) 誰先跑都要對：這裡一律記成「他指定過了」，那邊就不會再自動蓋掉
watch(requestedPanelView, (v) => {
  if (!v)
    return
  requestedPanelView.value = null
  activeGuide.value = null
  statusTouched = true
  if (v === 'catalogue') {
    view.value = 'catalogue'
    return
  }
  view.value = 'main'
  statusOpen.value = v === 'status'
})

function openGuide(alert: ResolvedAlert) {
  if (!alert.guideId)
    return
  activeGuide.value = alert.guideId
}
// 關面板順手收掉跑到一半的劇本與全部教學：下次打開回到那一頁，不殘留舊畫面
watch(panelOpen, (open) => {
  if (open)
    return
  activeGuide.value = null
  view.value = 'main'
  statusTouched = false
})

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

/**
 * 昨日摘要的出口：想看趨勢與明細就去統計頁（同一份口徑的完整版）。
 *
 * **一定要帶上摘要卡講的那一天**：統計頁預設是近 30 天，不帶日期就會出現
 * 「卡上寫 16 場、點進去三百多場」——這張卡整輪都在修「數字對不上」，
 * 出口自己再製造一次就白做了。
 */
function goStats() {
  const wid = workspaceId.value
  if (!wid)
    return
  closePanel()
  const day = brief.value?.date
  void router.push({
    path: `/admin/${wid}/conversation-stats`,
    query: day ? { startDate: day, endDate: day } : undefined,
  })
}

/** 沒人回的點名出口：直接開那一位客人的對話（?userId= 深連結，收件匣 AdminPanel 會自動選中） */
function goConversation(userId: string) {
  const wid = workspaceId.value
  if (!wid || !userId)
    return
  closePanel()
  void router.push(`/admin/${wid}/conversations?userId=${encodeURIComponent(userId)}`)
}

/**
 * 開通引導接手：把人帶去聊天式精靈（/admin/onboarding?workspaceId=）。
 * 同一份劇本、訊號驅動——做過的步驟自動跳過，從第一個真實缺口接著帶。
 */
function goOnboardingChat() {
  const wid = workspaceId.value
  if (!wid)
    return
  closePanel()
  // `entry=hero`：開通步驟紀錄要知道他從哪個入口回來接 LINE（`C-250`③）
  void router.push(`/admin/onboarding?workspaceId=${wid}&entry=hero`)
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
    actionGuideId: cap.guideId,
  }))
  void startAdHocTour(steps)
}

/**
 * 巡覽步驟內的「帶我做這項」：收掉巡覽，開那一項的教法。
 * 有劇本就開劇本（跟清單點下去同一套——⛔同一件事不能因為入口不同就兩種教法）。
 */
function onStepAction(topicId?: string, guideId?: string) {
  endTour()
  if (guideId) {
    activeGuide.value = guideId as AgentGuideId
    openPanel()
    return
  }
  if (topicId)
    startTopicById(topicId)
}

const postTourNote = ref('')

/**
 * 某一支導覽走完要做的事，**取代**預設的「重開面板」（`C-250`②）。
 * 打造完的落地導覽最後一步叫他按送出——這時候蓋一塊面板上去就是擋路（`D-102` 審查：
 * 小幫手面板 322px 寬、貼右邊，正好蓋住剛出來的回答），所以改成把游標放進輸入框。
 * ⚠️ 只認**開跑時那一份步驟**：別支導覽開跑（小幫手清單、頁首問號）就作廢，
 *    否則下一支隨便哪個導覽走完都會被拿去做這件事。
 * ⛔ **不可以在 `onTourClose` 裡作廢、也不可以在這裡比對 `activeSteps`**：el-tour 按「完成」時
 *    是**先發 close、再發 finish**（`element-plus/es/components/tour/src/step.vue` 的 `onFinish`），
 *    close 那一下 `endTour()` 已經把步驟清空了——兩種寫法都會讓這個設定永遠不生效。
 */
let finishOverride: { steps: TutorialStep[], run: () => void } | null = null
/**
 * 落地導覽開跑中（開通步驟紀錄用）：走完幾步、還是中途關掉。
 * ⚠️ 同 `finishOverride` 的坑：close 比 finish **先到**——close 那一下先記「停在第幾步」，
 *    晚一拍還沒被 finish 認領才算「關掉」。
 */
let landingTrack: { kind: string, steps: TutorialStep[] } | null = null
watch(activeSteps, (steps) => {
  if (finishOverride && steps.length && toRaw(steps) !== finishOverride.steps)
    finishOverride = null
  if (landingTrack && steps.length && toRaw(steps) !== landingTrack.steps)
    landingTrack = null
})

/** 導覽「完成」：閉環——重抓狀態、依結果回應、重開面板（回應顯示在「目前狀況」） */
async function onTourFinish() {
  const finishedId = lastTopicId.value
  if (landingTrack) {
    trackOnboarding('landing_tour', { kind: landingTrack.kind, done: true, steps: landingTrack.steps.length })
    landingTrack = null
  }
  const override = finishOverride
  finishOverride = null
  clearDemo()
  endTour()
  if (override) {
    override.run()
    void refresh({ force: true })
    return
  }
  // 回應講在「目前狀況」最上面：下面設好 postTourNote 之後打開面板，`autoStatus` 會把狀況展開
  view.value = 'main'
  // 一定要 force：使用者剛才就在改設定，這裡拿到舊快取就會誤報「還沒生效」
  await refresh({ force: true })
  const cap = finishedId ? capabilities.value.find(c => c.tourId === finishedId) : null
  // 2026-08-28 拍板：**每一支**導覽跑完都要講「還能再看、去哪看」。
  // 在這之前只有掛了 tourId 的那 4 支會回話，其餘 18 支按完最後一步畫面一個字都不多說，
  // 而且全站沒有任何地方提過教學可以重開——正是老闆點名的缺口。
  // `D-114`：「教學」分頁拿掉了，全部教學改從「？」最下面那一行進
  const reopen = '想再看一次？每頁標題旁的「？」隨時都在，最下面還有「看全部教學」。'
  if (cap) {
    const verdict = cap.status === 'done'
      ? `「${cap.title}」完成了，太好了！`
      : `看起來「${cap.title}」還沒生效——設定完記得按「儲存」喔。`
    postTourNote.value = `${verdict}${reopen}`
  }
  else {
    postTourNote.value = reopen
  }
  openPanel()
}

/** 導覽被中途關閉：尊重使用者離開，不打擾，只默默重抓狀態 */
function onTourClose() {
  const t = landingTrack
  if (t) {
    const at = tourStep.value + 1
    setTimeout(() => {
      if (landingTrack !== t) return // 被 finish 認領了＝走完
      trackOnboarding('landing_tour', { kind: t.kind, done: false, at, steps: t.steps.length })
      landingTrack = null
    }, 0)
  }
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
  // 剛剛那一下是把小幫手拖走，不是要開面板——拖完面板自己彈出來會很煩
  if (consumeDrag())
    return
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
  openPanelView('status')
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

/**
 * 開帳走完落地的兩支導覽（`C-250`②）：打造完「進入後台」→ 測試對話的落地 3 步；
 * 接完 LINE「去看看」→ 客服對話的「上線之後」3 步。步驟內容在 `utils/onboarding-landing.ts` 組。
 * ⚠️ 要等設定狀態載完才開跑：紅帶（第 2 步指的那一條）是看狀態才長出來的。
 */
async function startLandingTour(kind: string) {
  const wid = workspaceId.value
  if (!wid) return
  await ensureWorkspaceList()
  await loadDraftCards()
  if (kind === LANDING_FROM_BUILD) {
    const band = await waitForElement('[data-tour="onboarding-band"]', 1500)
    const steps = landingTourSteps(readOnboardingBuilt(wid), { hasBand: !!band, bandAction: onboardingBand.value.action, draftCards: draftCards.value })
    // ⭐ 走完把游標放進輸入框＝下一個動作就在手邊（第一個「哇」接在導覽後面，⛔ 不打開面板蓋住它）
    // ⚠️ el-input 會把 `data-tour` 直接掛在 textarea 本身（不在外層），所以錨點就是輸入框
    // ⚠️ 要晚一拍：el-tour 關掉時會把焦點還給開導覽前的那個元素，當下 focus 會被它蓋回去（實走抓到的）
    finishOverride = {
      steps,
      run: () => setTimeout(() => document.querySelector<HTMLElement>('[data-tour="pg-input"]')?.focus(), 150),
    }
    landingTrack = { kind: 'build', steps }
    await startAdHocTour(steps)
    return
  }
  // 「上線之後」：第 1 步要他那一場對話已經列出來（清單是非同步載的，等一下）
  // ⚠️ 「收到第一則訊息」不在能力註冊表（`capabilities`）裡，只在開通步驟那一份——
  //    從 `capabilities` 找永遠是 undefined＝第 1 步永遠被拿掉（實走抓到的）
  const received = onboardingSteps.value.find(s => s.id === 'firstMessageReceived')?.done === true
  const hasRow = received && !!(await waitForElement('.conv-list-row .split-list-item', 4000))
  const steps = liveTourSteps({ received: hasRow, triedPlayground: hasTriedPlayground(wid), draftCards: draftCards.value, phoneNotified: landingNotify })
  landingTrack = { kind: 'line', steps }
  await startAdHocTour(steps)
}
const { markSeen: markTourSeen } = useTourSeen()
/** 落地那一刻網址上帶的「手機已加進通知名單」（讀到就從網址拿掉） */
let landingNotify = false

onMounted(async () => {
  // ⚠️ `?from=` 要在第一個 await 之前讀、立刻拿掉（重新整理不重跑）；測試對話頁自己在 setup 就讀過了
  const landingFrom = String(route.query.from || '').trim()
  const wantLanding = (landingFrom === LANDING_FROM_BUILD && route.path.endsWith('/ai-playground'))
    || (landingFrom === LANDING_FROM_LINE && route.path.endsWith('/conversations'))
  if (wantLanding) {
    // `notify=1`＝精靈裡按了「是我」、手機真的加進通知名單了（`C-250`③）
    landingNotify = String(route.query.notify ?? '') === '1'
    const { from: _from, notify: _notify, ...restQuery } = route.query
    void router.replace({ query: restQuery })
    // 🔴 落地這一頁**當場**記成看過（`D-101` 問題 5：一路被導覽追著跑）——
    //    ⛔ 不可以等落地導覽開跑之後才記：那一頁「第一次進來自動跑」的導覽 0.9 秒後就做決定，
    //    接完 LINE 那一刻閘門剛打開，實走時收件匣 7 步就這樣搶先跑掉、落地那支反而沒跑。
    //    key＝那一頁頁首問號的 topics（客服對話 `['conversations']`、測試對話 `['ai-playground']`）
    markTourSeen(landingFrom === LANDING_FROM_LINE ? 'conversations' : 'ai-playground')
  }
  // 開通引導結尾的「帶你認識後台」把人送進後台之後，由這裡接手開跑（開通頁是 layout:false，
  // 沒有側欄／小幫手這些要被高亮的元素，導覽只能在後台版型裡跑）。
  // ⛔ 開跑前先把 query 拿掉：留著的話重新整理會一直重跑同一支導覽。
  // ⛔ 認不得的值一律當沒帶（打錯字不要變成「按了沒反應」），沿用標籤頁 ?aiMode= 的守門方式。
  const wantTour = String(route.query.tour || '').trim()
  if (wantTour) {
    const { tour: _dropped, ...restQuery } = route.query
    void router.replace({ query: restQuery })
    // ⛔ 開跑前一定要先等角色載進來（2026-08-28 code review 修）：子元件的初始化比版型早，
    //    這一行原本會在「載入帳號清單」之前跑完。那一瞬間讀不到角色＝需要管理權限的步驟
    //    會被靜靜丟掉，而過濾只在開場算一次、之後不會補——擁有者跑完一支少一步的導覽，
    //    而且不知道自己少看了什麼。
    await ensureWorkspaceList()
    // ⛔ 認不得的值／這個角色一步都跑不起來時要**有出路**（同一輪 review 修）：
    //    網址上那段已經被清掉了，重新整理救不回來，所以不能就這樣沉默結束。
    //    退回「打開全部教學」——讓人自己挑一支，這是唯一不會變成「按了沒反應」的收場。
    if (!startTopicById(wantTour))
      openPanelView('catalogue')
  }
  await refreshAll()
  loadBuiltItems()
  if (wantLanding) {
    // ⛔ 「第一次來？我帶你一步步把設定做完」這顆氣泡跟落地導覽講相反的事（導覽說 LINE「不用現在做」），
    //    而且就長在測試對話的送出鈕旁邊——落地的人直接當看過，⛔ 不再彈
    dismissNudge()
    await startLandingTour(landingFrom)
  }
  // 只有「真的還有必要項沒做」且沒看過，才彈引導
  // ⛔ 導覽正在跑就不要彈（2026-08-28 code review 修）：開通完成後按「帶你認識後台」
  //    落地的那一刻，剛好同時滿足「必要項還沒做完」（新帳號的知識庫／AI 一定是空的）
  //    與「沒看過這顆氣泡」——結果是一顆「要不要我帶你把設定做完」蓋在他剛剛選擇的
  //    導覽旁邊，還就長在導覽下一步要高亮的那顆 FAB 上。這顆氣泡沒被 dismiss 就不會
  //    寫記憶，所以只是延到下次進後台再說，不會消失。
  try {
    if (!tourOpen.value && !localStorage.getItem(nudgeKey()) && incompleteRequired.value.length > 0)
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
  loadBuiltItems()
  resetAlerts()
  resetSetupStatus()
  resetBrief()
  void refreshAll(true)
})

/**
 * 面板本體。打開時要把焦點移進來，Esc 才關得掉——
 * `@keydown.esc` 掛在面板上，焦點留在浮動按鈕的話這顆鍵一路都沒人接。
 */
const panelEl = ref<HTMLElement | null>(null)

// 每次打開面板都重新體檢（有待驗證的修復就 force 並回報結果）；關閉時清掉一次性回應
watch(panelOpen, (open) => {
  if (open) {
    autoStatus()
    nextTick(() => {
      panelEl.value?.focus()
      // 狀況收著＝打開就能直接打字（`D-114`）。⚠️ 晚一拍、不亮框：亮框是留給「用一句話建立」那種
      // 「在這裡講」的提示；而且面板剛打開時焦點先在面板本體（Esc 才關得掉），要等它就位再搶回輸入框
      if (!statusOpen.value && view.value === 'main' && !activeGuide.value)
        chatRef.value?.focusInput(false)
    })
    loadBuiltItems()
    void loadDraftCards()
    // 昨日摘要在這一刻才查（見 refreshAll 的註解）。不 force：useDailyBrief 自己有
    // 10 分鐘節流與跨日重抓，開開關關不會重打，但隔天再打開會拿到新的日期
    void refreshBrief()
    void verifyLastFix()
  }
  else {
    postTourNote.value = ''
    postFixNote.value = ''
  }
})
// 「修好了沒」是打開之後才查完的（verifyLastFix）：有話要講就展開，讓那一句看得到
watch([postTourNote, postFixNote], () => {
  if (panelOpen.value)
    autoStatus()
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

/**
 * 這個元素塞得進它所在的捲動區嗎（給 targetTooTallFallback 用）。
 *
 * 往上找第一個真的會捲動的祖先（側欄是 .sidebar-scroll）；找不到就拿視窗高度比。
 * 留 8px 餘裕：剛好等高時遮罩邊緣會壓在容器邊界上，看起來就是「超出去」。
 */
function fitsInScrollParent(el: HTMLElement): boolean {
  let p: HTMLElement | null = el.parentElement
  while (p) {
    const style = getComputedStyle(p)
    if (/(auto|scroll)/.test(style.overflowY) && p.clientHeight > 0)
      return el.getBoundingClientRect().height <= p.clientHeight - 8
    p = p.parentElement
  }
  return el.getBoundingClientRect().height <= window.innerHeight - 8
}

/** 導覽步驟順手標亮的那幾個元素（`TutorialStep.mark`）。換步、關掉、完成時一律收掉 */
const TOUR_MARK_CLASS = 'ta-tour-mark'
function clearTourMarks() {
  document.querySelectorAll(`.${TOUR_MARK_CLASS}`).forEach(n => n.classList.remove(TOUR_MARK_CLASS))
}

async function focusActiveStep() {
  clearTourMarks()
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
  // 顯示前先點某元素（例如先進入新增模式，編輯區才會出現），再等頁面渲染。
  // ⛔ 有 clickBeforeUnless 的先問「使用者手上是不是已經開著東西」——無條件點下去
  //    等於把他正在讀的對話切掉，而按「上一步」回到這步還會再切一次
  //    （2026-08-28 code review 修，規則在 utils/tutorial-step-visibility.ts）。
  // ⛔ 要點的東西可能還沒畫出來（2026-09-29 `D-109` 實走踩到）：機器人模組第 2 步要先點「真人客服」，
  //    但清單還在載——點了空氣，那一步講的是真人客服、畫面上卻什麼都沒選，後面兩步跟著全錯。
  //    先等它出現（最多 3 秒）再決定點不點；「已經開著就不要點」那條判斷照舊在下面。
  if (step?.clickBefore && !(step.clickBeforeUnless && document.querySelector(step.clickBeforeUnless)))
    await waitForElement(step.clickBefore, 3000)
  if (step && shouldRunClickBefore(step, sel => !!document.querySelector(sel))) {
    document.querySelector<HTMLElement>(step.clickBefore!)?.click()
    await nextTick()
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  }
  const selector = step?.target
  // 空 target ＝ 置中說明卡（不高亮）；否則輪詢等元素出現（示範卡可能要時間渲染）
  let el = selector ? await waitForElement(selector, 2000) : null
  // ⛔ 兩個退路（2026-08-28 code review 修）——都只在「同一件事的上層」之間退，
  //    不是拿來隨便找個東西指（理由寫在 utils/tutorial-topics.ts 的兩個欄位上）：
  //    ① 主目標的渲染條件比「這頁打得開」細一層（對話頁那排動作要有進行中的會話）
  //    ② 主目標比它所在的捲動區還高（側欄那三段在短螢幕上塞不進可視範圍，
  //       遮罩挖的洞會超出去、上下還有列藏著；scrollAndSettle 只救得了比容器小的目標）
  if (!el && step?.targetFallback)
    el = await waitForElement(step.targetFallback, 800)
  if (el && step?.targetTooTallFallback && !fitsInScrollParent(el)) {
    const smaller = document.querySelector<HTMLElement>(step.targetTooTallFallback)
    if (smaller)
      el = smaller
  }
  targetMissing.value = Boolean(selector) && !el
  if (!el) {
    liveTarget.value = null
    return
  }
  await scrollAndSettle(el)
  // ⚠️ 標亮要在量位置之後、交給 el-tour 之前：標亮只改底色與外框，不動版面
  if (step?.mark)
    document.querySelectorAll(step.mark).forEach(n => n.classList.add(TOUR_MARK_CLASS))
  // 同一個元素時，先清空再設定以確保觸發 el-tour 重算
  if (liveTarget.value === el) {
    liveTarget.value = null
    await nextTick()
  }
  liveTarget.value = el
}

watch([tourOpen, tourStep], focusActiveStep, { flush: 'post' })
</script>
