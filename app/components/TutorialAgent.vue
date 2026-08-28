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
        <!-- 標頭也是拖曳把手（面板開著時要能搬）。裡面的分頁與關閉鈕照常點——
             onDragStart 會把「從按鈕上按下去」的手勢讓掉 -->
        <header class="ta-panel__head" @pointerdown="onDragStart">
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

        <!-- 問助理:用講的查後台(唯讀)。用 v-show 不用 v-if——切去看「目前狀況」再切回來，
             對話與捲動位置要還在，不然問到一半去對照狀態就等於重問一次 -->
        <AdminAgentChat v-show="!activeGuide && panelTab === 'chat'" class="ta-panel__chat" />

        <div v-show="!activeGuide && panelTab === 'setup'" class="ta-panel__body">
          <!-- 結論先行：先一句話講「有沒有事」，明細在下面（沿用 .ls-status 的視覺語言） -->
          <div v-if="verdict" class="ta-verdict" :class="`is-${verdict.tone}`">
            <el-icon class="ta-verdict__icon"><component :is="verdict.icon" /></el-icon>
            <span>{{ verdict.text }}</span>
          </div>

          <!-- 開通英雄卡（2026-08-20 拍板）：開通沒完成＝新帳號最大的問題，
               放結論正下方、全面板最顯眼的設計——列出還缺哪幾步＋一顆大 CTA。
               有它的時候，下面的待辦清單不再重複列「接上 LINE」（英雄卡代言） -->
          <div v-if="onboardingIncomplete" class="ta-hero">
            <div class="ta-hero__head">
              <!-- 結論紅條開通期讓位（統一成一塊），後果句由標題扛 -->
              <div class="ta-hero__title">開通還沒完成——機器人還不能上線</div>
              <button type="button" class="ta-hero__refresh" :disabled="busy" @click="refreshAll(true)">
                {{ busy ? '檢查中…' : '重新檢查' }}
              </button>
            </div>
            <div class="ta-hero__steps">
              <div v-for="st in onboardingSteps" :key="st.id" class="ta-hero__step" :class="{ 'is-done': st.done }">
                <span class="ta-hero__mark">{{ st.done ? '✓' : '○' }}</span>
                <span>{{ st.label }}</span>
              </div>
            </div>
            <button type="button" class="ta-hero__cta" @click="goOnboardingChat">
              <el-icon><ChatDotRound /></el-icon>
              <span>用聊天引導完成開通 →</span>
            </button>
          </div>

          <!-- agent 訊息泡泡：依真實設定狀態講白話文。導覽完成／異常修復的閉環回應
               也在這裡講——一個 agent 一個聲音，三個區塊各自代言只會像三個人在說話 -->
          <div class="ta-msg">
            <div class="ta-msg__avatar"><el-icon><IconRobot /></el-icon></div>
            <div class="ta-msg__bubble" aria-live="polite">
              <!-- 不帶名字：displayName 常是組織名（例：Myfeel），拿來當人名打招呼很怪（D-20 ⑤） -->
              <p>嗨 👋</p>
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
            <button type="button" class="ta-festival__cta" @click="goBroadcasts">去排推播 →</button>
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
                <button class="ta-progress__refresh" :disabled="busy" @click="refreshAll(true)">
                  {{ busy ? '檢查中…' : '重新檢查' }}
                </button>
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
              <button
                v-for="(cap, i) in todosForList"
                :key="cap.id"
                class="ta-todo ta-todo--required"
                @click="onFix(cap)"
              >
                <span class="ta-todo__step">{{ i + 1 }}</span>
                <span class="ta-todo__main">
                  <span class="ta-todo__title">{{ cap.title }}</span>
                  <span class="ta-todo__why">{{ cap.why }}</span>
                  <span class="ta-todo__cta">{{ cap.tourId ? '帶我做 →' : '前往設定 →' }}</span>
                </span>
              </button>
            </div>

            <!-- 加分項：定位由分組標題講一次，卡上不再各掛「必要/加分」小標籤 -->
            <div v-if="incompleteOptional.length" class="ta-todos">
              <div class="ta-todos__head">加分項（做了 AI 更好用，不做也能上線）</div>
              <button
                v-for="cap in incompleteOptional"
                :key="cap.id"
                class="ta-todo"
                @click="onFix(cap)"
              >
                <span class="ta-todo__icon"><el-icon><component :is="cap.icon" /></el-icon></span>
                <span class="ta-todo__main">
                  <span class="ta-todo__title">{{ cap.title }}</span>
                  <span class="ta-todo__why">{{ cap.why }}</span>
                  <span class="ta-todo__cta">{{ cap.tourId ? '帶我做 →' : '前往設定 →' }}</span>
                </span>
              </button>
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

        <!-- 教學：想學才來翻的參考庫（pull）。和「目前狀況」的異常/待辦（push）分開住，
             不緊急的內容不佔狀況版面 -->
        <div v-show="!activeGuide && panelTab === 'learn'" class="ta-panel__body">
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

        <!-- 頁尾：一句話講這個分頁的立場，＋搬過位置的人要有回原位的退路。
             四個分頁本來各寫一個 <footer>，收成一個——同一條列印四份，改文案時漏一份就漂了 -->
        <footer class="ta-panel__foot">
          <span>{{ footNote }}</span>
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
      <!-- 數字＝「現在壞著」＋「必要設定沒做」，一律紅：還沒上線本身就是大問題
           （2026-08-07 拍板，取代先前「純設定缺項用中性色」的分色）。黃色警示項不進數字 -->
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
import type { Component } from 'vue'
import type { ResolvedCapability } from '~/composables/useSetupStatus'
import type { ResolvedAlert } from '~/composables/useWorkspaceAlerts'
import type { AgentGuideId } from '~/utils/agent-guides'
import { ChatDotRound, CircleCheckFilled, CircleCloseFilled, Close, QuestionFilled, View, WarningFilled } from '@element-plus/icons-vue'
import IconRobot from '~/components/icons/IconRobot.vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { festivalHint } from '~/utils/festival-hint'
import { taipeiDate } from '~~/shared/time'

const { user } = useAuth()
const { workspaceId, ensureWorkspaceList } = useWorkspace()
const router = useRouter()
// 只給 ?tour= 深連結用（開通引導結尾送人進來時開跑那一支）。
// ⛔ 教學清單本身刻意不看當前路由：那件事由每頁頁首的「？」負責，不要長出第二套入口邏輯。
const route = useRoute()

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
  onboardingIncomplete,
  onboardingSteps,
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

/** 開場白用的一句話日報 */
const briefLine = computed(() => {
  const b = brief.value
  if (!b)
    return ''
  if (!b.yesterday.total) {
    return b.yesterday.newFriends > 0
      ? `昨天沒有客人對話，但有 ${b.yesterday.newFriends} 位新朋友加了好友。`
      : '昨天沒有客人對話。'
  }
  // 「其中」不可省：轉真人與 AI 先回是重疊的，並列講會被聽成兩類相加（同摘要卡的坑）
  const parts = [`昨天有 ${b.yesterday.total} 場客人對話，其中 ${b.yesterday.autoFirst} 場是 AI／機器人先回`]
  if (b.yesterday.handoffs)
    parts.push(`後來有 ${b.yesterday.handoffs} 場轉給真人`)
  if (b.yesterday.newFriends > 0)
    parts.push(`另外有 ${b.yesterday.newFriends} 位新朋友加了好友`)
  return `${parts.join('、')}。`
})

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
  // 開通期泡泡只講「下一步」：結論已經由上面的紅條講過，再複述一次＝兩個聲音講同一件事
  if (onboardingIncomplete.value) {
    const next = onboardingSteps.value.find(st => !st.done)
    return `下一步：${next?.label || '完成開通'}。按上面綠色卡片，我用聊天帶你做完。`
  }
  // 先講後果再講差幾項：「還差 2 項」聽起來像快好了，「客人得不到回應」才是實況
  if (incompleteRequired.value.length)
    return `我看過你的帳號了。現在${notLiveConsequence.value}——還差 ${incompleteRequired.value.length} 項必要設定才能上線。從第 1 步開始，我一步步帶你做。`
  if (!allRequiredDone.value) {
    const n = unknownCaps.value.filter(c => c.required).length
    return `有 ${n} 項必要設定我這次查不到狀態，先點「重新檢查」確認一下。`
  }
  if (incompleteAll.value.length) {
    // AI 開著 + 知識庫全空＝客人問什麼 AI 都答不出來，這不是普通的「想做再做」，
    // 要點名講清楚後果（仍不擋「可以上線」——擋不擋是拍板過的加分項定位）
    if (capabilities.value.find(c => c.id === 'knowledgeReady')?.status === 'incomplete')
      return `必要設定都完成了。不過知識庫還是空的——客人問的問題 AI 幾乎都答不出來、只能轉給真人，建議先把知識庫建起來再上線。`
    return `必要設定都完成了，可以上線囉！還有 ${incompleteAll.value.length} 個加分項，想做再做。`
  }
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
 * 「帶你修好」引導劇本（C-31 Phase 1）：跑在面板裡、一步步修＋當場驗證，
 * 跟 onFixAlert 的差別是人不離開面板。劇本註冊在 utils/agent-guides，
 * 哪些異常有劇本看註冊表的 guideId。
 */
const activeGuide = ref<AgentGuideId | null>(null)

/** 頁尾那句話：講這個分頁的立場（誠實邊界／怎麼運作），不重複畫面上已經有的內容 */
const footNote = computed(() => {
  if (activeGuide.value)
    return '跟著做就好——每一步完成，我都會真的檢查有沒有生效。'
  if (panelTab.value === 'setup')
    return '我只看你帳號真實的狀態，不會給你假資訊。'
  if (panelTab.value === 'learn')
    return '每個教學都會在實際畫面上一步步帶你操作。'
  return '回答都來自你帳號的真實資料；目前只能查詢，不能修改。'
})

function openGuide(alert: ResolvedAlert) {
  if (!alert.guideId)
    return
  activeGuide.value = alert.guideId
}
// 關面板順手收掉跑到一半的劇本：下次打開回到「目前狀況」，不殘留舊對話
watch(panelOpen, (open) => {
  if (!open)
    activeGuide.value = null
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
  void router.push(`/admin/onboarding?workspaceId=${wid}`)
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
  // 2026-08-28 拍板：**每一支**導覽跑完都要講「還能再看、去哪看」。
  // 在這之前只有掛了 tourId 的那 4 支會回話，其餘 18 支按完最後一步畫面一個字都不多說，
  // 而且全站沒有任何地方提過教學可以重開——正是老闆點名的缺口。
  const reopen = '想再看一次？每頁頁首的「？」，或這裡的「教學」分頁隨時都在。'
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
    //    退回「打開教學分頁」——讓人自己挑一支，這是唯一不會變成「按了沒反應」的收場。
    if (!startTopicById(wantTour)) {
      panelTab.value = 'learn'
      openPanel()
    }
  }
  await refreshAll()
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
    nextTick(() => panelEl.value?.focus())
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
  // 顯示前先點某元素（例如先進入新增模式，編輯區才會出現），再等頁面渲染。
  // ⛔ 有 clickBeforeUnless 的先問「使用者手上是不是已經開著東西」——無條件點下去
  //    等於把他正在讀的對話切掉，而按「上一步」回到這步還會再切一次
  //    （2026-08-28 code review 修，規則在 utils/tutorial-step-visibility.ts）。
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
  // 同一個元素時，先清空再設定以確保觸發 el-tour 重算
  if (liveTarget.value === el) {
    liveTarget.value = null
    await nextTick()
  }
  liveTarget.value = el
}

watch([tourOpen, tourStep], focusActiveStep, { flush: 'post' })
</script>
