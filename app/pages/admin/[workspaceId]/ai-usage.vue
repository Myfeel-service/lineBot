<template>
  <AdminSplitLayout solo>
    <template #editor-header>
      <!-- 副標只回答「這頁是什麼」，換行後才接姊妹頁連結（原本兩個主題擠成一句沒斷點）。
           ⛔ 別在這裡解釋「則」——原本寫「這裡數的是『則』（客人每來一則訊息算一則）」
           是用「則」解釋「則」，等於沒解釋。單位差異留在數字旁的 tooltip 講。 -->
      <AdminSoloPageHeading
        field-label="AI 客服"
        title="AI 表現"
        caption="你的 AI 做得好不好、還有什麼要補。"
      >
        <template #caption>
          <br>想看客人來了多少、誰接住的？<NuxtLink :to="`/admin/${workspaceId}/conversation-stats`" class="admin-inline-link">看對話統計 →</NuxtLink>
        </template>
      </AdminSoloPageHeading>
      <div class="flex gap-2 admin-header-actions">
        <el-select v-model="period" size="small" data-tour="usg-period" class="usage-period-select" @change="loadAll">
          <el-option
            v-for="opt in periodOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
        <el-button :icon="Refresh" :loading="loading" @click="loadAll">重新整理</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="usage-body admin-panel-stack">
        <!-- ── AI 狀態列：老闆第一眼要知道 AI 有沒有在跑；未啟用時點明數字是歷史/測試 ── -->
        <div v-if="aiStatus" class="usage-status" :class="`usage-status--${aiStatus.tone}`">
          <span class="usage-status__dot" />
          <div class="usage-status__body">
            <span class="usage-status__title">{{ aiStatus.title }}</span>
            <span class="usage-status__desc">{{ aiStatus.desc }}</span>
          </div>
          <!-- 額度即時數（2026-08-10 老闆拍板 A 案）：跟錢有關的要第一眼看到——
               放狀態列比整張卡搬上來更快，且不動「先講價值再講帳」的卡片順序。
               只有「有上限」方案顯示（無限方案沒有「剩多少」可言）；點了捲到方案卡看細節。 -->
          <button
            v-if="quotaChip"
            type="button"
            class="usage-status__quota"
            :class="`usage-status__quota--${quotaState}`"
            @click="scrollToQuota"
          >
            {{ quotaChip }}
          </button>
          <el-button v-if="aiStatus.tone === 'off'" size="small" type="primary" @click="goSettings">去啟用</el-button>
        </div>

        <!-- 額度警示留在最上面：會直接讓 AI 停掉自動回覆，不能等人捲到頁尾才看到。
             （額度本身那張卡放在頁尾，平常只是確認還夠不夠） -->
        <template v-if="planQuota">
          <el-alert
            v-if="isCurrentPeriod && quotaState === 'over'"
            type="error"
            :closable="false"
            show-icon
            title="本期則數已用完"
            class="usage-quota-alert"
          >
            <div class="quota-alert-body">
              <span>AI 自動回覆已暫停、改由真人接手。升級方案或加購額度即可恢復自動回覆。</span>
              <el-button size="small" type="primary" @click="upgradeDialogOpen = true">升級方案</el-button>
            </div>
          </el-alert>
          <el-alert
            v-else-if="isCurrentPeriod && quotaState === 'near'"
            type="warning"
            :closable="false"
            show-icon
            title="本期則數即將用完"
            class="usage-quota-alert"
          >
            <div class="quota-alert-body">
              <span>已使用 {{ quotaPercentRaw }}%，用完後 AI 會暫停自動回覆並轉真人，建議提前升級方案。</span>
              <el-button size="small" type="primary" @click="upgradeDialogOpen = true">升級方案</el-button>
            </div>
          </el-alert>
        </template>

        <!-- ── AI 表現：這頁的主角 ─────────────────────── -->
        <!-- 2026-08-10 老闆拍板改「場」制：主指標＝AI 接的對話裡，幾場從頭到尾沒用到真人。
             「場」是使用者本來就懂、在對話列表自己驗證得了的單位；「題」「出手」這些
             工程單位一律不再出現在畫面上（口徑細節收 tooltip）。
             資料源＝對話統計頁的 session 分類（同一支 trend API、同一份 aiEscalated 條件），
             兩頁數字永遠對得起來，「次 vs 場」的和解條約也就不需要了。 -->
        <div class="message-card usage-card" data-tour="usg-kpi">
          <div class="card-section-stack">
            <div v-if="heroLoading" class="usage-loading"><div class="spinner" /></div>
            <!-- 載入失敗 ≠ 還沒有客人來：拿不到資料時如實說「不知道」。
                 「查不到」跟「沒問題」必須是兩種畫面（08-09 假綠燈教訓，三個載入點都比照） -->
            <div v-else-if="heroError" class="usage-empty usage-empty--error">
              <span class="usage-empty__icon usage-empty__icon--error">!</span>
              <div>
                <div class="usage-empty__title">數據剛剛沒有載出來</div>
                <div class="usage-empty__desc">不是沒有客人來，是還不知道——通常重試一次就好。</div>
              </div>
              <el-button size="small" @click="loadAll">重試</el-button>
            </div>
            <template v-else>
              <div class="usage-hero">
                <div class="usage-hero__head">
                  <template v-if="(heroMonth?.ai ?? 0) > 0">
                    <strong class="usage-hero__num" :class="metricTone('autoReply', heroRate)">
                      {{ formatPercent(heroRate) }}
                    </strong>
                    <!-- 副標把分子分母都念出來（「接了 120 場，其中 70 場沒用到真人」）：
                         比例打哪來是用讀的就懂的事，不必對照長條或自己心算 -->
                    <span class="usage-hero__label">
                      <b>全程搞定</b>
                      <el-tooltip placement="top">
                        <template #content>
                          AI 第一個接住這場對話、而且到結束都沒有交給真人，就算「全程搞定」。<br>
                          一場裡客人問了幾件事、AI 來回幾則訊息都不影響——只看最後有沒有用到你的人。<br>
                          場的算法與「對話統計」頁同一份資料，兩頁對得起來。
                        </template>
                        <el-icon class="usage-hero__info"><InfoFilled /></el-icon>
                      </el-tooltip>
                      <br>{{ periodLabel }} AI 接了 {{ formatNumber(heroMonth?.ai) }} 場對話{{ sessionsDeltaText }}，其中 <b>{{ formatNumber(heroMonth?.solved) }}</b> 場從頭到尾沒用到真人
                    </span>
                    <!-- 比率的變化要用「百分點」不是「%」：68%→74% 是進步 6 個百分點，不是 6%。
                         這顆可以上色——搞定率越高越好，方向明確（場數多寡則不然，故只寫在副標不上色）。 -->
                    <span
                      v-if="rateDeltaPts !== null"
                      class="usage-delta"
                      :class="rateDeltaPts > 0 ? 'usage-delta--good' : (rateDeltaPts < 0 ? 'usage-delta--warn' : '')"
                    >
                      較上月 {{ rateDeltaPts > 0 ? '▲' : (rateDeltaPts < 0 ? '▼' : '＝') }} {{ Math.abs(rateDeltaPts) }} 個百分點
                    </span>
                  </template>
                  <!-- 一場都沒有時不能顯示「0% 全程搞定」——那會把「沒資料」講成「每場都失敗」。
                       「有客人但 AI 都沒接到」也不能說成「還沒有客人來」——那是另一回事。 -->
                  <template v-else>
                    <strong class="usage-hero__num">—</strong>
                    <span class="usage-hero__label"><b>全程搞定</b><br>{{ (heroMonth?.total ?? 0) > 0 ? `${periodLabel} 客人來的 ${formatNumber(heroMonth?.total)} 場對話都由真人或選單流程服務，AI 沒有接到場` : `${periodLabel} 還沒有客人來過` }}</span>
                  </template>
                </div>
                <template v-if="(heroMonth?.ai ?? 0) > 0">
                  <div
                    class="usage-segbar"
                    role="img"
                    :aria-label="`全程搞定 ${heroMonth?.solved} 場、用到真人 ${heroMonth?.escalated} 場`"
                  >
                    <span class="usage-seg usage-seg--answered" :style="{ width: `${segPct.solved}%` }" />
                    <span class="usage-seg usage-seg--handoff" :style="{ width: `${segPct.escalated}%` }" />
                  </div>
                  <div class="usage-legend">
                    <div class="usage-leg usage-leg--answered">
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">全程搞定</span>
                      <span class="usage-leg__v">{{ formatNumber(heroMonth?.solved) }}</span>
                      <span class="usage-leg__pct">{{ formatPercent(heroRate) }}</span>
                    </div>
                    <div
                      class="usage-leg usage-leg--handoff"
                      :class="{ 'usage-leg--link': (heroMonth?.escalated ?? 0) > 0 }"
                      :role="(heroMonth?.escalated ?? 0) > 0 ? 'button' : undefined"
                      :tabindex="(heroMonth?.escalated ?? 0) > 0 ? 0 : undefined"
                      @click="(heroMonth?.escalated ?? 0) > 0 && scrollToHandoffs()"
                      @keydown.enter="(heroMonth?.escalated ?? 0) > 0 && scrollToHandoffs()"
                    >
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">
                        用到真人
                        <el-tooltip placement="top" content="AI 先接住、但這場後來還是把客人交給了真人——含客人自己開口指名真人的。想知道原因和能補救的，看下面的案例清單。">
                          <el-icon class="usage-leg__info"><InfoFilled /></el-icon>
                        </el-tooltip>
                      </span>
                      <span class="usage-leg__v">{{ formatNumber(heroMonth?.escalated) }}</span>
                      <span class="usage-leg__pct">{{ heroMonth?.ai ? formatPercent(heroMonth.escalated / heroMonth.ai) : '' }}</span>
                      <span v-if="(heroMonth?.escalated ?? 0) > 0" class="usage-leg__go">查看 ↓</span>
                    </div>
                  </div>
                </template>

                <!-- 不是 AI 接的場：只補一句去處。明細（真人首接/沒人回/選單）是對話統計頁的事，這頁不重複 -->
                <div v-if="heroOtherCount > 0" class="usage-note">
                  另有 {{ formatNumber(heroOtherCount) }} 場不是 AI 接的（真人直接服務、選單流程、或還沒人回）——明細看<NuxtLink :to="`/admin/${workspaceId}/conversation-stats`" class="admin-inline-link">對話統計</NuxtLink>。
                </div>

                <!-- ⛔ 原因拆解行（91 次：答不出來 62、指名 1…）已整行退場（2026-08-10 老闆「很混亂」拍板）：
                     它數「事件次數」、hero 數「場」，且包含非 AI 首接的場——一行永遠對不回上面 43 場、
                     也對不回 verdict 的待補件數，三組數字互相打架。「答不出來→補知識」的動作
                     由 verdict＋案例清單（預設就停在「答不出來」組）全權承接，需要逐筆查帳的人清單裡都有。 -->

                <!-- 「先問清楚」退出主畫面（2026-08-10 老闆拍板：使用者不在乎機制）——
                     只在偏高時現身一行，直接給診斷與動作，是訊號不是統計 -->
                <div v-if="clarifyWarning" class="usage-note usage-note--warn">
                  ⚠ {{ clarifyWarning }}
                </div>
              </div>

              <!-- 結論先行：報表給數字，儀表板給判斷。上面一堆數字之後要有一句
                   「這樣算好還是不好、接下來做什麼」，否則老闆得自己相加相除再猜。
                   ⛔ 判語一律從後端真實數字推（沿用新手教學 agent 的原則），不讓 LLM 臆測。 -->
              <div v-if="verdict" class="usage-verdict" :class="`usage-verdict--${verdict.tone}`">
                <span class="usage-verdict__mark">{{ verdict.mark }}</span>
                <div class="usage-verdict__body">
                  <span class="usage-verdict__title">{{ verdict.title }}</span>
                  <span class="usage-verdict__next">{{ verdict.next }}</span>
                </div>
                <el-button v-if="verdict.canAct" size="small" @click="scrollToHandoffs">去看看</el-button>
              </div>

              <!-- ⛔ 這頁不放任何金額與 token（2026-08-10 拍板：成本一律只在超管「成本總覽」）。
                   「答完客人又找真人」的常駐數字已拆（2026-08-10 老闆拍板）：場制 hero 已把
                   「答了但客人不滿意」自然吸收進「用到真人」，它只剩診斷價值——比照「先問清楚」，
                   偏高（>25%）時才在上面 verdict 以但書現身，正常月份誰都不會看到。
                   拆掉它之後全頁只剩兩種單位：表現區講「場」、頁尾帳務卡講「則」。 -->
            </template>
          </div>
        </div>

        <!-- ── 待補知識的轉真人案例：這是這頁唯一「你現在可以動手」的區塊，
             所以排在回顧性的趨勢圖前面（2026-08-10 UIUX 評估 G） ── -->
        <div ref="handoffCard" class="message-card usage-card" data-tour="usg-cases">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">近期轉真人案例</span>
              <span class="text-xs text-muted">還沒處理的問題</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="usage-hint">
              AI 轉給真人的對話。預設只列「答不出來、補知識有救」的：點「補知識」直接到知識庫補一張對應卡；其他原因用下拉切換。
              同一題被問很多次的，AI 會先在知識庫的「建議收件匣」擬好草稿，<NuxtLink :to="`/admin/${workspaceId}/knowledge/sources`" class="admin-inline-link">去那裡採用更快 →</NuxtLink>
            </p>
            <!-- 篩選移到卡片內（不再擠在標題列）。分組與 hero 拆解行同一套語言：
                 上面學一次「答不出來／刻意設計要人接／客人指名」，這裡直接用，不再攤 12 個原始原因 -->
            <div class="usage-handoff-toolbar">
              <el-select v-model="reasonFilter" size="small" placeholder="篩選原因" class="usage-reason-select" @change="onFilterChange">
                <el-option
                  v-for="opt in reasonOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <el-checkbox v-model="showResolved" size="small" @change="onFilterChange">顯示已處理</el-checkbox>
              <!-- 這顆原本在「進階／技術細節」卡裡，那張卡（只放金額）已移除，
                   但它還控制著下方的信心值與「重演」，所以搬來這裡。維持只有超管能開。 -->
              <el-checkbox v-if="isSuperAdmin" v-model="advancedOpen" size="small">顯示技術細節</el-checkbox>
            </div>
            <div v-if="loadingHandoffs && !handoffs.length" class="usage-loading"><div class="spinner" /></div>
            <div v-else-if="handoffsError" class="usage-empty usage-empty--error">
              <span class="usage-empty__icon usage-empty__icon--error">!</span>
              <div>
                <div class="usage-empty__title">案例清單剛剛沒有載出來</div>
                <div class="usage-empty__desc">不是都處理完了，是還不知道——通常重試一次就好。</div>
              </div>
              <el-button size="small" @click="() => loadHandoffs()">重試</el-button>
            </div>
            <!-- 和解：此清單＝「目前還卡著、尚未處理」的對話（不分月份），與上方本月轉接次數不是同一份計數，
                 避免「本月 141 次轉接」與「0 待處理」被誤讀成互相矛盾。空狀態要像「已清空」而非「沒資料」。
                 綠色「都清完了」只在預設的「答不出來」視角出現；其他篩選下空了就平實地說沒有。 -->
            <div v-else-if="!handoffs.length && reasonFilter === GAP_FILTER && !showResolved" class="usage-empty usage-empty--good">
              <span class="usage-empty__icon">✓</span>
              <div>
                <div class="usage-empty__title">沒有待補知識的轉真人對話了</div>
                <div class="usage-empty__desc">這裡只列「目前還卡著、尚未處理」的對話，和上方本月轉接次數不是同一份計數。想回顧請勾「顯示已處理」。</div>
              </div>
            </div>
            <div v-else-if="!handoffs.length" class="usage-empty">
              這個篩選下沒有案例。換個原因看看，或勾「顯示已處理」回顧處理過的。
            </div>
            <div v-else class="usage-handoff-list">
              <div v-for="row in handoffs" :key="`${row.userId}-${row.updatedAtMs}`" class="usage-handoff-row" :class="{ 'usage-handoff-row--resolved': row.resolved }">
                <div class="usage-handoff-meta">
                  <span :class="reasonBadgeClass(row.handoffReason)">{{ reasonLabel(row.handoffReason) }}</span>
                  <span v-if="row.resolved" class="badge badge-gray">已處理</span>
                  <span class="text-xs text-muted"><template v-if="advancedOpen">信心 {{ row.lastConfidence.toFixed(2) }} · </template>{{ formatTime(row.updatedAtMs) }}</span>
                </div>
                <div class="usage-handoff-query">
                  <span class="usage-handoff-user">{{ row.displayName || '匿名客人' }}：</span>
                  <span>{{ row.lastQuery || '(無問題內容)' }}</span>
                </div>
                <div v-if="row.sources.length" class="usage-handoff-sources">
                  最相近卡：{{ row.sources.slice(0, 2).map(s => s.title).join('、') }}
                </div>
                <div v-if="row.handoffReason === 'non_text_content'" class="usage-handoff-sources">
                  AI 目前看不懂圖片、影片這類內容，客人傳完後就要求真人。點「開對話」看客人傳了什麼。
                </div>
                <div class="usage-handoff-actions">
                  <!-- 傳圖案例沒有「補知識」可按,主要動作換成開對話,不讓那一列全是次要按鈕 -->
                  <el-button :icon="ChatDotRound" size="small" :type="row.handoffReason === 'non_text_content' ? 'primary' : undefined" plain @click="goConversation(row.userId)">開對話</el-button>
                  <!-- 傳圖案例:客人原句是「[圖片]」,補知識會拿它當卡片標題、重演會拿它去問 AI,兩個都是死路 -->
                  <el-button v-if="row.handoffReason !== 'non_text_content'" :icon="Upload" size="small" type="primary" plain @click="goAddKnowledge(row.lastQuery)">補知識</el-button>
                  <el-button v-if="advancedOpen && row.handoffReason !== 'non_text_content'" size="small" plain @click="goPlayground(row.lastQuery)">▶ 重演</el-button>
                  <!-- 「已處理」只影響這份清單，不通知任何人——不講清楚的話沒人敢按 -->
                  <el-tooltip v-if="!row.resolved" placement="top" content="標記處理完成、從這份清單移除。只影響這裡，不會通知任何人。">
                    <el-button size="small" type="success" plain :loading="resolvingUserId === row.userId" @click="resolveHandoff(row.userId)">✓ 已處理</el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>
            <!-- 清單固定一次 20 筆：不給出口的話，第 21 筆之後的案例等於不存在 -->
            <div v-if="handoffs.length && handoffsHasMore" class="usage-more">
              <el-button size="small" :loading="loadingMore" @click="loadHandoffs(true)">載入更多</el-button>
            </div>
          </div>
        </div>

        <!-- ── 方案用量／額度：跟錢有關，排在行動之後、回顧（趨勢）之前（2026-08-10 老闆拍板往上移）。
             仍在 hero 與案例清單之後：先講價值與待辦；錢真正危急的時刻（快用完/用完）
             由頁頂的紅黃警示搶第一眼，不靠這張卡的位置。 ── -->
        <template v-if="planQuota">
          <div ref="quotaCard" class="message-card usage-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <!-- 無上限的方案沒有「額度」可言，標題跟著實況講 -->
                <span class="section-title">{{ quotaLimit != null ? '方案額度' : '方案用量' }}</span>
                <!-- 有上限：顯示額度的「本期」（續約日制）；無上限：跟著上方報表的月份走（見下） -->
                <span class="text-xs text-muted">{{ planQuota.name }}<template v-if="quotaLimit != null"> · 本期 {{ quotaPeriodLabel }}</template></span>
              </div>
              <div class="plan-card-head-actions">
                <span v-if="planQuota.currentPeriodEnd" class="text-xs text-muted">{{ planQuota.currentPeriodEnd }} 續期</span>
                <!-- 無固定則數上限（客製/內部方案）打不到額度，升級對他沒意義 → 不顯示，避免噪音 -->
                <el-button v-if="quotaLimit != null" size="small" @click="upgradeDialogOpen = true">升級方案</el-button>
              </div>
            </div>
            <div class="card-section-stack">
              <template v-if="quotaLimit != null">
                <el-progress
                  :percentage="quotaPercent"
                  :color="quotaColor"
                  :stroke-width="18"
                  :text-inside="true"
                  :format="() => `${quotaPercentRaw}%`"
                />
                <p class="usage-hint">
                  本期已用 <strong>{{ formatNumber(quotaUsed) }}</strong> / {{ formatNumber(quotaLimit) }} 則
                  <el-tooltip placement="top" :content="QUOTA_UNIT_TIP">
                    <el-icon class="usage-info"><InfoFilled /></el-icon>
                  </el-tooltip>
                  <template v-if="quotaRemaining !== null">（剩 {{ formatNumber(quotaRemaining) }} 則）</template>
                  <template v-if="planQuota.overagePerReply">・超量加購 NT${{ planQuota.overagePerReply }}/則</template>
                </p>
                <!-- 雙時間軸提醒只有「有上限」需要：額度按續約日重置，跟上方報表的月份不是同一個區間。
                     無上限的用量已改用同一個月份（下方分支），沒有第二條時間軸要解釋 -->
                <p v-if="planQuota.currentPeriodStart" class="usage-hint usage-hint--muted">
                  額度以「續約日」為一期（{{ quotaPeriodLabel }}），和上方報表選的月份不是同一個區間。
                </p>
              </template>
              <!-- 無上限也要給用量（2026-08-10 老闆拍板）：「無限」是計費條件，不是隱藏數字的理由。
                   ⛔ 窗口改用「上方報表選的月份」（summary.answered）而不是訂閱期的 quotaAnswered——
                   無限方案沒有額度要對，卻繼承續約日窗口只會多一條時間軸（老闆實測「94 則哪來的」）。
                   給事實不給焦慮：沒有進度條、剩餘、升級鈕。 -->
              <p v-else class="usage-hint">
                {{ periodLabel }} AI 已回答 <strong>{{ formatNumber(summary?.answered) }}</strong> 則
                <el-tooltip placement="top" :content="QUOTA_UNIT_TIP">
                  <el-icon class="usage-info"><InfoFilled /></el-icon>
                </el-tooltip>
                ・此方案不限則數。
              </p>
            </div>
          </div>

          <AdminPlanUpgradeDialog v-model="upgradeDialogOpen" :current-plan-id="planQuota.id" />
        </template>

        <!-- ── 每月趨勢：讓「監控」看得出變好還變差，不只是單月快照 ── -->
        <div class="message-card usage-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">{{ trendTitle }}</span>
              <!-- 副標直接寫算式：整根柱＝分母、綠段＝分子，折線就是綠段佔整根的比例。
                   老闆反映「怎麼算出來的還是有點難理解」——一句話講完，比 tooltip 可靠 -->
              <span class="text-xs text-muted">一根柱子＝AI 接的對話場數，折線＝全程沒用到真人的比例（線往上＝變好）</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div v-if="loadingSessions && !sessionBuckets.length" class="usage-loading"><div class="spinner" /></div>
            <div v-else-if="sessionsError" class="usage-empty usage-empty--error">
              <span class="usage-empty__icon usage-empty__icon--error">!</span>
              <div>
                <div class="usage-empty__title">趨勢剛剛沒有載出來</div>
                <div class="usage-empty__desc">不是沒有資料，是還不知道——通常重試一次就好。</div>
              </div>
              <el-button size="small" @click="loadSessions">重試</el-button>
            </div>
            <ClientOnly v-else-if="trendHasData">
              <VChart class="usage-trend-chart" :option="trendOption" autoresize />
              <template #fallback><div class="usage-loading"><div class="spinner" /></div></template>
            </ClientOnly>
            <div v-else class="usage-empty">
              <template v-if="trendMonthsWithData === 1">目前只有一個月的資料，再過一個月就能看出是變好還是變差。</template>
              <template v-else>還沒有足夠資料能看趨勢，AI 開始接對話後這裡就會長出來。</template>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { ChatDotRound, InfoFilled, Refresh, Upload } from '@element-plus/icons-vue'
import { HANDOFF_REASON_LABELS, KNOWLEDGE_GAP_HANDOFF_REASONS, type HandoffReason } from '~~/shared/types/ai-knowledge'
import type { TrendBucket } from '~~/shared/types/conversation-stats'
import { useAdminToast } from '~~/app/composables/useAdminToast'
import { derivePlanState } from '~~/shared/billing/plan-state'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { apiFetch, workspaceId } = useWorkspace()
const router = useRouter()
const route = useRoute()
const { showToast } = useAdminToast()
// 技術細節（信心值、重演按鈕）只給 super admin：一般使用者用不到也看不懂
const { isSuperAdmin, checkIsSuperAdmin } = useSuperAdmin()

/** 轉真人案例的「顯示技術細節」開關（信心值＋重演按鈕）；預設關 */
const advancedOpen = ref(false)

interface Summary {
  period: string
  /** AI 自動回覆是否已啟用；未啟用時 webhook 不跑 AI，畫面數字皆為歷史/測試 */
  aiEnabled: boolean
  replyMode: 'auto' | 'draft'
  /** 本期（訂閱週期）已用則數 —— 額度進度條看這個，與攔截同一顆計數器；不隨月份切換。 */
  quotaAnswered: number
  invocations: number
  answered: number
  handoffs: number
  /** invocations − directHandoffs（後端算好），成績的分母 */
  aiEngaged: number
  /** 客人一開口就指名真人、AI 沒出手（handoffs 的子集；2026-08-10 起才有資料） */
  directHandoffs: number
  /** 先問清楚之後成功答出的次數（2026-08-10 起才有資料） */
  followupAnswered: number
  /** 當月轉真人原因 → 次數（事件表聚合；查失敗為空物件） */
  handoffReasonCounts: Record<string, number>
  answeredThenHandoffs: number
  answeredThenHandoffRate: number
  disambiguations: number
  disambiguationRate: number
  autoReplyRate: number
  handoffRate: number
  // ⛔ 這頁不放任何金額與 token（一律只在超管「成本總覽」頁）。
  // API 仍會回成本欄位給 super admin（ai-settings 的 token 數還在用），這裡刻意不宣告、不取用。
  plan: {
    id: string
    name: string
    answeredQuota: number | null
    overagePerReply: number | null
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
  } | null
}

interface HandoffRow {
  userId: string
  displayName: string
  lastQuery: string
  lastConfidence: number
  handoffReason: HandoffReason | null
  resolved: boolean
  sources: Array<{ chunkId: string; title: string }>
  updatedAtMs: number
}

const summary = ref<Summary | null>(null)
const handoffs = ref<HandoffRow[]>([])
/** 場制資料源：對話統計的 session 月桶（hero 與趨勢圖共用同一份回應） */
const sessionBuckets = ref<TrendBucket[]>([])
// ⛔ 三個 loading 初始都是 true：初始 render 發生在 onMounted 之前，
// 初始 false 會讓「還沒開始載」的那一幀直接掉進空狀態（畫面閃一下「還沒有客人來」）
const loading = ref(true)
const loadingHandoffs = ref(true)
const loadingSessions = ref(true)
// 失敗三態：「查不到」和「沒問題」要分開（凡是查不到＝沒事的檢查都是假綠燈）
const sessionsError = ref(false)
const handoffsError = ref(false)
// 案例清單的「還有更舊的」與載入更多游標（後端回 nextBefore，見 handoffs.get.ts）
const handoffsHasMore = ref(false)
const handoffsCursor = ref(0)
const loadingMore = ref(false)
const showResolved = ref(false)

/**
 * 篩選分組與 hero 拆解行同一套語言（答不出來／刻意設計要人接／客人指名），
 * 使用者在上面學一次分類、下面直接用；不再攤 12 個原始原因讓人自己歸類。
 * 值＝逗號分隔的原因組（後端吃 in 查詢）；「答不出來」那組由共用白名單導出，
 * 跟 hero 的「補知識就有救」永遠同一份，不會兩處各判各的。
 */
const GAP_FILTER = Array.from(KNOWLEDGE_GAP_HANDOFF_REASONS).join(',')
const reasonGroupOptions = [
  { label: '答不出來（可補知識）', value: GAP_FILTER },
  { label: '刻意設計要人接', value: 'order_status,sensitive_topic,commercial_inquiry' },
  { label: '客人指名真人', value: 'user_request' },
  { label: '傳了圖片/檔案', value: 'non_text_content' },
  { label: '系統狀況（AI 失敗、額度用完…）', value: 'llm_error,quota_exceeded,auto_reply_repeat' },
  { label: '全部原因', value: '' },
]
// 預設停在「答不出來」：這張卡的存在理由是補知識，指名真人／查訂單那些沒有動作可做
const reasonFilter = ref<string>(GAP_FILTER)
/** 深連結帶進來的單一原因（如異常中心的 llm_error）——臨時加一個選項讓下拉顯示得出名字 */
const extraReasonOption = ref<{ label: string; value: string } | null>(null)
const reasonOptions = computed(() =>
  extraReasonOption.value ? [...reasonGroupOptions, extraReasonOption.value] : reasonGroupOptions)

function onFilterChange() {
  void loadHandoffs()
}

/**
 * 場制主資料（2026-08-10 老闆拍板）：hero 與趨勢都吃對話統計的 session 月桶。
 * 一場＝對話列表看得到的一場會話；ai＝AI 首接的場、aiEscalated＝其中後來仍轉真人的場。
 * 與對話統計頁同一支 API、同一份分類條件——兩頁數字天生一致，免換算免和解。
 */
const monthRowsAll = computed(() => {
  const byKey = new Map(sessionBuckets.value.map(b => [b.date, b]))
  // periodOptions 是新→舊，圖與「上月」比較都要舊→新
  return [...periodOptions].reverse().map((o) => {
    const key = `${o.value.slice(0, 4)}-${o.value.slice(4)}`
    const b = byKey.get(key)
    const ai = b?.ai ?? 0
    const escalated = Math.min(ai, b?.aiEscalated ?? 0)
    return {
      period: o.value,
      label: key,
      total: b?.total ?? 0,
      ai,
      escalated,
      solved: ai - escalated,
      ratePct: ai > 0 ? Math.round(((ai - escalated) / ai) * 100) : null,
    }
  })
})
/** 所選月份的場數（月份選單一定在 monthRowsAll 裡，找不到＝資料還沒到 → 零狀態） */
const heroMonth = computed(() => monthRowsAll.value.find(r => r.period === period.value) ?? null)
const heroRate = computed(() => {
  const m = heroMonth.value
  return m && m.ai > 0 ? m.solved / m.ai : 0
})
/** 兩段長條寬度：全程搞定＋用到真人＝AI 接的場數，相加即 100% */
const segPct = computed(() => {
  const m = heroMonth.value
  if (!m || !m.ai) return { solved: 0, escalated: 0 }
  return { solved: (m.solved / m.ai) * 100, escalated: (m.escalated / m.ai) * 100 }
})
/** 不是 AI 接的場（真人首接／沒人回／純機器人流程）——補一句去處就好，明細歸對話統計頁 */
const heroOtherCount = computed(() => {
  const m = heroMonth.value
  return m ? Math.max(0, m.total - m.ai) : 0
})
// hero 卡的載入／失敗閘門：summary（狀態列、拆解行）與 session 桶（主數字）任一沒到就不能開演
const heroLoading = computed(() =>
  (loading.value && !summary.value) || (loadingSessions.value && !sessionBuckets.value.length))
const heroError = computed(() => !summary.value || sessionsError.value)

/**
 * 「先問清楚」退出主畫面（2026-08-10 老闆拍板：使用者不在乎機制、只在乎要不要做事）。
 * 只在偏高（metricTone warn，>30%）時現身一行診斷＋動作——是訊號，不是統計。
 * 正常月份使用者完全不會看到這個詞。
 */
const clarifyWarning = computed(() => {
  const s = summary.value
  if (!s || !s.disambiguations) return null
  if (metricTone('disambiguation', s.disambiguationRate) !== 'is-warn') return null
  return `AI 這個月有 ${formatNumber(s.disambiguations)} 個問題得先反問客人才能回答（佔 ${formatPercent(s.disambiguationRate)}），偏高——通常是知識卡標題太相近，去把名字改清楚就會降。`
})

/**
 * verdict 的「待補知識」數，與篩選脫鉤的獨立底帳。
 *
 * ⛔ 不能直接數 handoffs 陣列：那份清單會跟著使用者的篩選漂
 * （深連結切到 llm_error 時，verdict 會把 3 筆系統失敗講成「3 題答不出來」）。
 * 只在載的是預設「答不出來」那組時更新；null＝還沒成功載過（載入中或失敗），
 * 此時 verdict 不得宣稱「沒有待補」——那正是假綠燈。
 */
const pendingGap = ref<number | null>(null)
const pendingGapHasMore = ref(false)
function syncPendingGap() {
  if (reasonFilter.value !== GAP_FILTER) return
  pendingGap.value = handoffs.value.filter(r => !r.resolved).length
  pendingGapHasMore.value = handoffsHasMore.value
}

/**
 * 一句解讀：「現在算好還是不好、接下來做什麼」。
 *
 * 全部從真實數字推，沒有任何臆測：
 *   - 好壞門檻沿用既有的 metricTone('autoReply')（≥50% 好、<20% 要留意），不另立一套標準
 *   - 「該做什麼」只數「答不出來、補知識有救」的案例（pendingGap）——
 *     客人指名、查訂單、傳圖這些補知識沒救，混進來會叫人白做工
 *   - 「答完客人又找真人」偏高時要講：那代表「搞定」有一部分是假象，
 *     不講的話 verdict 的 ✓ 會跟旁邊的橘色數字互相打架
 * ⛔ 一則都沒有時不下判語——沒資料不是成績，硬給結論會變成瞎掰。
 */
const verdict = computed(() => {
  const m = heroMonth.value
  // 用「AI 接過場」當門檻：AI 一場都沒接的月份，沒有成績可以下判語
  if (!m || !m.ai) return null
  const rate = heroRate.value
  const pct = formatPercent(rate)
  const tone = metricTone('autoReply', rate).replace('is-', '') // good | warn | neutral

  const title = tone === 'good'
    ? `AI 接的對話，${pct} 從頭到尾不用真人，表現不錯`
    : tone === 'warn'
      ? `AI 接的對話只有 ${pct} 能自己收尾，大部分還是要人接`
      : `AI 接的對話 ${pct} 全程自己搞定，還有進步空間`

  const pending = pendingGap.value
  let next: string
  let canAct = false
  if (pending === null) {
    // 底帳還沒建立（載入中／失敗／深連結載的是別組）：只指路，不下「沒有待補」的結論
    next = handoffsError.value
      ? '下方案例清單剛剛沒有載出來，重試後再看有什麼要補。'
      : '到下方案例清單看看有沒有能補的知識。'
    canAct = !handoffsError.value
  }
  else if (pending > 0) {
    next = `下面有 ${pending}${pendingGapHasMore.value ? '+' : ''} 個客人的問題答不出來還沒補知識，補完最有機會把這個數字拉上去。`
    canAct = true
  }
  else {
    next = '目前沒有待補的知識，維持下去就好。'
  }

  // 品質但書：回答完 30 分鐘內又被找真人的比例過線（>25%）就要講——「搞定」可能沒答到重點
  const s = summary.value
  if (s && s.answered > 0 && metricTone('answeredThenHandoff', s.answeredThenHandoffRate) === 'is-warn')
    next += `另外有 ${formatPercent(s.answeredThenHandoffRate)} 的回答，客人看完仍要找真人，可能沒答到重點——建議開幾場對話抽查。`

  return { tone, mark: tone === 'good' ? '✓' : tone === 'warn' ? '⚠' : '→', title, next, canAct }
})

// 頂端狀態列：AI 有沒有在跑（老闆第一眼要知道的）。未啟用時特別點明「數字是歷史/測試」。
const aiStatus = computed(() => {
  if (!summary.value) return null
  if (!summary.value.aiEnabled) {
    return { tone: 'off', title: 'AI 客服尚未啟用', desc: '客人目前不會收到 AI 回覆。下方數字是先前建置或測試留下的，不是真實客服表現。' }
  }
  if (summary.value.replyMode === 'draft') {
    return { tone: 'draft', title: 'AI 草稿模式', desc: 'AI 會擬好回覆放進收件匣，但不會自動發送給客人。' }
  }
  return { tone: 'on', title: 'AI 客服運作中', desc: '客人傳訊息時，AI 會自動回答；答不出來的會轉給真人。' }
})
function goSettings() {
  router.push(`/admin/${workspaceId.value}/ai-settings`)
}

// F7 下鑽：hero 的「轉給真人」可點，捲到同頁下方的轉真人清單（同頁、同不分月份口徑，
// 不會有「月份 KPI vs 清單」對不上的問題）。
const handoffCard = ref<HTMLElement | null>(null)
function scrollToHandoffs() {
  handoffCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 所選月份的前一個月（monthRowsAll 是舊→新）；選到最舊那個月就沒得比 */
const prevMonthRow = computed(() => {
  const idx = monthRowsAll.value.findIndex(r => r.period === period.value)
  return idx > 0 ? (monthRowsAll.value[idx - 1] ?? null) : null
})

/**
 * 全程搞定率的變化，單位是**百分點**。
 * ⛔ 別寫成百分比：68% → 74% 是「進步 6 個百分點」，不是「進步 6%」（那是 8.8%）。
 * 比率的比率最容易被誤讀，寫錯就等於報錯成績。
 */
const rateDeltaPts = computed(() => {
  const prev = prevMonthRow.value
  const cur = heroMonth.value
  // ⛔ 上月不足 5 場不比：跟 1 場比出來的「▼67 個百分點」是垃圾數字還掛警示色（實測畫面抓到）
  if (!prev || prev.ai < 5 || !cur?.ai) return null
  return Math.round((heroRate.value - prev.solved / prev.ai) * 100)
})

/** 場數的變化只寫在副標、不上色：對話變多是生意變好還是負擔變重，看的人自己判斷。
 *  上月基數太小（<5 場）只印事實「（上月僅 N 場）」——「較上月 ▲6300%」沒有資訊量只有嚇人 */
const sessionsDeltaText = computed(() => {
  const prev = prevMonthRow.value?.ai ?? 0
  const cur = heroMonth.value?.ai ?? 0
  if (!prev) return ''
  if (prev < 5) return `（上月僅 ${prev} 場）`
  const pct = Math.round(((cur - prev) / prev) * 100)
  if (pct === 0) return '（與上月持平）'
  return `（較上月 ${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%）`
})

/**
 * ⛔ 至少要**兩個月**有場才畫趨勢圖。
 * 只有一個月的話畫出來是孤零零一根柱子——那不是趨勢，只是把單月數字換個樣子再講一次，
 * 反而讓人以為「看起來很少」。剛上線的第一個月就該老實說「還要再一個月」。
 */
const trendMonthsWithData = computed(() => monthRowsAll.value.filter(r => r.ai > 0).length)
const trendHasData = computed(() => trendMonthsWithData.value >= 2)
/**
 * 標題跟著實際畫幾根柱子講。查的是近 3 個月，但開頭沒場的月份會被裁掉（見 trendRows），
 * 寫死「近 3 個月」卻只有 2 根柱子＝畫面自己對不起來，這種數字不符老闆一眼就會抓。
 */
const trendTitle = computed(() =>
  trendHasData.value ? `近 ${trendRows.value.length} 個月趨勢` : '每月趨勢')
/**
 * 趨勢列＝monthRowsAll（場制、與 hero 同一份）裁掉「AI 還沒開始接場」的開頭空月份：
 * 留著只是一整欄空白，把真實柱子擠到右邊。
 * ⛔ 只裁開頭——中間的空月份要留，那代表 AI 中途停過（是資訊，不是雜訊）；
 * 最後一個月是當月，永遠留（月初還沒量也要看得到自己在這條線上）。
 */
const trendRows = computed(() => {
  const all = monthRowsAll.value
  const first = all.findIndex(r => r.ai > 0)
  return first > 0 ? all.slice(first) : all
})

const trendOption = computed(() => {
  const rows = trendRows.value
  return {
    // ⚠️ 前兩色必須與 hero 分段長條同色（_ai-usage.scss 的 --brand-green-deep / #5b7a9d）：
    // 同一頁上下兩塊講同一件事，顏色一漂就變成「三種顏色兩個意思」。
    // 第三色（折線）刻意是中性炭灰、不是藍：它是「綠段佔整根的比例」這個結論，
    // 不是第三種資料。ECharts 吃不了 CSS 變數，只能硬寫——改 token 時要記得回來改這裡。
    color: ['#05b24c', '#5b7a9d', '#374151'],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      /**
       * ⛔ 第一行必須是結論（全程搞定率＋上月對比），原始數字擺後面。
       * 這張圖存在的唯一理由是回答「有沒有變好」，而變好＝率上升，不是柱子變高：
       * 客人變多時整根柱子會長高，看起來很熱鬧但可能其實在退步。
       * 順序刻意是「結論 → 分母（整根柱子）→ 兩段分子」：照著讀下來就是 70 ÷ 120 = 58%，
       * 使用者不必自己心算，也看得懂那個百分比打哪來（老闆實際反映看不懂怎麼算的）。
       */
      formatter: (params: Array<{ dataIndex: number }>) => {
        const i = params?.[0]?.dataIndex ?? 0
        const r = rows[i]
        if (!r) return ''
        const prev = rows[i - 1]
        const head = r.ratePct === null
          ? `<div style="font-weight:700">${r.label}　AI 沒有接到場</div>`
          : `<div style="font-weight:700">${r.label}　全程搞定 ${r.ratePct}%`
            + (prev?.ratePct != null ? `<span style="font-weight:400;opacity:.7">（上月 ${prev.ratePct}%）</span>` : '')
            + '</div>'
        // 分母：整根柱子。標成「＝整根柱子」讓圖與數字對得起來
        const total = r.ai > 0
          ? `<div style="font-size:12px;margin-top:3px;padding-bottom:3px;border-bottom:1px solid rgba(0,0,0,.08)">`
            + `<span>AI 接的對話（整根柱子）</span>　<b>${r.ai}</b> 場</div>`
          : ''
        const line = (c: string, k: string, v: number) =>
          `<div style="display:flex;align-items:center;gap:6px;font-size:12px">`
          + `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></span>`
          + `<span style="flex:1">${k}</span><b>${v}</b></div>`
        return head
          + total
          + line('#05b24c', '全程搞定', r.solved)
          + line('#5b7a9d', '用到真人', r.escalated)
      },
    },
    // 圖例圖示分家：兩段是色塊（資料），折線用它自己的線圖示（結論）。
    // ⛔ 別在 legend 層寫 icon:'roundRect'——那會把折線也畫成色塊，變成「三根柱子」
    legend: {
      bottom: 0,
      itemWidth: 14,
      itemHeight: 8,
      data: [
        { name: '全程搞定', icon: 'roundRect' },
        { name: '用到真人', icon: 'roundRect' },
        { name: '全程搞定率' },
      ],
    },
    grid: { left: 8, right: 12, top: 22, bottom: 34, containLabel: true },
    xAxis: { type: 'category', data: rows.map(p => p.label), axisTick: { alignWithLabel: true } },
    // 雙軸：左邊看量（整根柱＝AI 接的場數），右邊看好壞（率）。
    // 量會隨客人數一起長，只看柱子看不出退步
    yAxis: [
      {
        type: 'value',
        minInterval: 1,
        // 留 15% headroom 給柱頂的總數標籤，再進位到「好看的刻度」——
        // 直接用 203×1.15 會讓軸頂印出「234」這種沒人想讀的數字（實測過）
        max: (v: { max: number }) => {
          const m = Math.max(1, (v.max || 1) * 1.15)
          const step = Math.pow(10, Math.floor(Math.log10(m))) / 2
          return Math.ceil(m / step) * step
        },
        splitLine: { lineStyle: { type: 'dashed' } },
      },
      {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    /**
     * 兩段**堆疊**成一根＝AI 接的場數，與 hero 的分段長條同一個心智模型。
     * ⛔ 別退回並排柱：並排看不到分母，「全程搞定 58%」就跟畫面上任何東西都對不起來
     *（老闆實際反映「還是有點難理解」）。堆疊之後率＝綠段佔整根的比例，用眼睛就驗得出來。
     * 每段的確切數字交給 tooltip：段內白字在綠底上對比不足，柱頂並排小字是視覺噪音。
     */
    series: [
      { name: '全程搞定', type: 'bar', stack: 'sessions', barMaxWidth: 44, data: rows.map(p => p.solved) },
      // 標籤掛在堆疊最上面這段＝標在整根柱頂，印的是總數（ai）不是自己的值；
      // 沒接到場的月份回空字串，免得在基線上印一個孤零零的 0
      {
        name: '用到真人',
        type: 'bar',
        stack: 'sessions',
        barMaxWidth: 44,
        data: rows.map(p => p.escalated),
        label: {
          show: true,
          position: 'top',
          fontSize: 11,
          fontWeight: 700,
          formatter: (p: { dataIndex: number }) => {
            const n = rows[p.dataIndex]?.ai ?? 0
            return n > 0 ? String(n) : ''
          },
        },
      },
      // 折線＝這張圖真正的主角：線往上就是變好，不必心算
      {
        name: '全程搞定率',
        type: 'line',
        yAxisIndex: 1,
        data: rows.map(p => p.ratePct),
        smooth: false,
        symbolSize: 7,
        lineStyle: { width: 2 },
        // ⛔ 標籤一定要墊白底：折線會穿過堆疊柱，標籤落在藍色段上會讀不清（實測截圖抓過）
        label: {
          show: true,
          position: 'top',
          fontSize: 11,
          fontWeight: 700,
          color: '#374151',
          backgroundColor: '#fff',
          borderRadius: 3,
          padding: [2, 4],
          formatter: '{c}%',
        },
        z: 3,
      },
    ],
  }
})

// ── Period selector（過去 3 個月） ─────────────────────────
function makePeriodOptions() {
  const opts: Array<{ value: string; label: string }> = []
  // 月結桶用台灣時區（與 server currentYyyyMm / taipeiYyyyMm 同一把尺;台灣固定 UTC+8）
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000)
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth() - i, 1))
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    // 最近兩期講白話（value 仍是 yyyyMM，只改顯示）：這一頁其他地方都白話，
    // 只有這個選單露出 `2026-08` 原始格式。更早的月份照印年月才知道是哪一期。
    opts.push({ value: `${y}${m}`, label: i === 0 ? '這個月' : i === 1 ? '上個月' : `${y}-${m}` })
  }
  return opts
}
const periodOptions = makePeriodOptions()
const period = ref(periodOptions[0]!.value)
const periodLabel = computed(() => periodOptions.find(o => o.value === period.value)?.label ?? period.value)
const isCurrentPeriod = computed(() => period.value === periodOptions[0]!.value)

// ── 方案額度（D1/D2） ─────────────────────────────────────
// 額度狀態（門檻/顏色）由共用的 derivePlanState 導出，與設定頁方案卡同一份邏輯。
// 進度條吃 quotaAnswered（本期 = 訂閱週期）而不是 answered（所選月份的報表數字）——
// 額度按錨定日重置，跟日曆月不是同一把尺，拿報表數字當進度條會顯示錯的剩餘則數。
const planQuota = computed(() => summary.value?.plan ?? null)
/** 「則」是收錢的單位，定義要就地問得到——客人最有資格知道怎麼扣（與 recordQuotaAnswered 的實際行為一致） */
const QUOTA_UNIT_TIP = '1 則＝AI 成功回答客人一個新問題。AI 反問的那句、反問後接著答的、轉真人的說明訊息，都不算則數。跟 LINE 官方帳號方案的「訊息則數」是兩回事，互不相干。'

/**
 * 狀態列右側的額度即時數（2026-08-10 老闆拍板 A 案）：「跟錢有關的要第一眼看到」。
 * 只有「有上限」方案有東西可顯示；無限方案沒有「剩多少」的概念，不佔位。
 * 顏色沿用 derivePlanState 的門檻（ok/near/over），與方案卡、頁頂警示同一套規則。
 */
const quotaChip = computed(() => {
  if (!planQuota.value || quotaLimit.value == null) return ''
  return `本期 ${formatNumber(quotaUsed.value)}／${formatNumber(quotaLimit.value)} 則`
})
const quotaCard = ref<HTMLElement | null>(null)
function scrollToQuota() {
  quotaCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
const upgradeDialogOpen = ref(false)
const planState = computed(() => derivePlanState(planQuota.value, summary.value?.quotaAnswered ?? 0))
// 額度週期的起訖（錨定日制，例如 07/28 ~ 08/27）；與下方報表的月份選擇無關。
const quotaPeriodLabel = computed(() => {
  const p = planQuota.value
  if (!p?.currentPeriodStart || !p.currentPeriodEnd) return '—'
  return `${p.currentPeriodStart.slice(5)} ~ ${p.currentPeriodEnd.slice(5)}`
})
const quotaUsed = computed(() => planState.value.used)
const quotaLimit = computed(() => planState.value.limit)
const quotaPercentRaw = computed(() => planState.value.percentRaw)
const quotaPercent = computed(() => planState.value.percent)
const quotaRemaining = computed(() => planState.value.remaining)
const quotaState = computed(() => planState.value.state)
const quotaColor = computed(() => planState.value.color)

// ── Loaders ───────────────────────────────────────────────
// ⛔ 失敗一律留下錯誤訊號給畫面顯示「載入失敗＋重試」，不准吞成空資料——
// 這頁的空狀態全是正面文案（還沒有客人來問／都處理完了），吞掉錯誤等於把斷線講成好消息。
async function loadSummary() {
  loading.value = true
  try {
    summary.value = await apiFetch<Summary>(`/api/ai/usage/summary?period=${period.value}`)
  }
  catch {
    summary.value = null // 模板以 !summary 判定失敗態（成功時 API 必回物件）
  }
  finally {
    loading.value = false
  }
}

async function loadHandoffs(append = false) {
  if (append) loadingMore.value = true
  else loadingHandoffs.value = true
  try {
    const params = new URLSearchParams({ limit: '20' })
    if (reasonFilter.value) params.set('reason', reasonFilter.value)
    if (showResolved.value) params.set('includeResolved', '1')
    if (append && handoffsCursor.value) params.set('before', String(handoffsCursor.value))
    const res = await apiFetch<{ rows: HandoffRow[]; hasMore: boolean; nextBefore: number }>(`/api/ai/usage/handoffs?${params.toString()}`)
    handoffs.value = append ? [...handoffs.value, ...res.rows] : res.rows
    handoffsHasMore.value = res.hasMore
    handoffsCursor.value = res.nextBefore || 0
    handoffsError.value = false
    syncPendingGap()
  }
  catch {
    if (append) {
      // 載入更多失敗：清單還在，退回按鈕讓人再按就好，別把整卡換成錯誤態
      showToast('載入更多失敗，請再試一次', 'error')
    }
    else {
      handoffs.value = []
      handoffsError.value = true
    }
  }
  finally {
    loadingMore.value = false
    loadingHandoffs.value = false
  }
}

/**
 * 場制資料：對話統計的 session 月桶（granularity=month），一次拿近 3 個月。
 * hero（所選月份）與趨勢圖共用同一份回應——兩塊永遠對得起來，也少打一支 API。
 */
async function loadSessions() {
  loadingSessions.value = true
  try {
    // 起點＝3 個月前的 1 號、終點＝今天。台北日曆鍵（台灣固定 UTC+8），與後端 taipei-day 同一把尺
    const tw = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const start = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth() - 2, 1))
    const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    const res = await apiFetch<{ buckets: TrendBucket[] }>(
      `/api/conversation-stats/trend?granularity=month&startDate=${key(start)}&endDate=${key(tw)}`)
    sessionBuckets.value = res.buckets
    sessionsError.value = false
  }
  catch {
    sessionBuckets.value = []
    sessionsError.value = true
  }
  finally {
    loadingSessions.value = false
  }
}

async function loadAll() {
  await Promise.all([loadSummary(), loadHandoffs(), loadSessions()])
}

// ── Format helpers ────────────────────────────────────────
function formatNumber(n?: number | null) {
  return (n ?? 0).toLocaleString('zh-TW')
}
function formatPercent(n?: number | null) {
  return `${Math.round((n ?? 0) * 100)}%`
}
/**
 * 依「數值門檻」決定數字顏色（rates 為 0~1）。
 * 正向指標（越高越好）好→綠；負向指標（越高越糟）過線才橘。
 * 重點：0% 的「答後仍轉真人」是滿分，要綠不是橘——不再無條件警告。
 */
function metricTone(kind: string, v?: number | null): string {
  const x = v ?? 0
  if (kind === 'autoReply') return x >= 0.5 ? 'is-good' : x < 0.2 ? 'is-warn' : 'is-neutral'
  if (kind === 'handoff') return x <= 0.3 ? 'is-good' : x > 0.6 ? 'is-warn' : 'is-neutral'
  if (kind === 'answeredThenHandoff') return x <= 0.1 ? 'is-good' : x > 0.25 ? 'is-warn' : 'is-neutral'
  if (kind === 'disambiguation') return x <= 0.15 ? 'is-good' : x > 0.3 ? 'is-warn' : 'is-neutral'
  return 'is-neutral'
}
function formatTime(ms: number) {
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
function reasonLabel(r: HandoffReason | null) {
  return r ? HANDOFF_REASON_LABELS[r] ?? r : '(未知)'
}
function reasonBadgeClass(r: HandoffReason | null) {
  if (r === 'low_confidence') return 'badge badge-yellow'
  if (r === 'no_grounding') return 'badge badge-yellow'
  if (r === 'sensitive_topic') return 'badge badge-red'
  if (r === 'quota_exceeded') return 'badge badge-red'
  // 系統故障要一眼和「客人要求真人」這類正常轉接分開,不能同為灰色
  if (r === 'llm_error') return 'badge badge-red'
  // 傳圖:不是故障也不是客人主動要求,是 AI 讀不懂 → 給自己的顏色,才不會混進灰色那堆
  if (r === 'non_text_content') return 'badge badge-blue'
  return 'badge badge-gray'
}

// ── Navigation ────────────────────────────────────────────
function goConversation(userId: string) {
  router.push(`/admin/${workspaceId.value}/conversations?userId=${encodeURIComponent(userId)}`)
}
function goAddKnowledge(query: string) {
  // 帶客人原句過去:來源頁會自動開「新增手寫」視窗並預填標題,不用重打一遍。
  // 開新分頁(與測試對話、客服對話兩個入口一致):同頁跳轉會弄丟這份清單的篩選與捲動位置,
  // 而且補完卡沒有任何回得來的路。
  const q = (query || '').trim()
  const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
  window.open(`/admin/${workspaceId.value}/knowledge/sources${suffix}`, '_blank')
}
function goPlayground(query: string) {
  router.push(`/admin/${workspaceId.value}/ai-playground?q=${encodeURIComponent(query)}`)
}

const resolvingUserId = ref<string | null>(null)
async function resolveHandoff(userId: string) {
  resolvingUserId.value = userId
  try {
    await apiFetch('/api/ai/usage/handoffs/resolve', { method: 'POST', body: { userId } })
    // 「顯示已處理」開著時原地標記(可回顧);關著時直接從列表移除
    if (showResolved.value) {
      const row = handoffs.value.find(r => r.userId === userId)
      if (row) row.resolved = true
    }
    else {
      handoffs.value = handoffs.value.filter(r => r.userId !== userId)
      // 清到見底但更舊的還有 → 自動補一頁，別讓「都處理完了」的綠框說謊
      if (!handoffs.value.length && handoffsHasMore.value) void loadHandoffs()
    }
    syncPendingGap()
  }
  catch {
    // 保留在列表上讓使用者重試；沒有回饋會讓人以為按了沒反應而連點
    showToast('標記失敗，請再試一次', 'error')
  }
  finally {
    resolvingUserId.value = null
  }
}

onMounted(() => {
  void checkIsSuperAdmin().catch(() => {})
  // 異常中心「AI 服務近期失敗過」的深連結（?reason=llm_error&includeResolved=1）：
  // 自動套用原因篩選並捲到案例清單，省掉「落在頁頂自己找下拉」那一段。
  // 下拉現在是分組選項，深連結的單一原因不在其中 → 動態補一個「只看：⋯」選項，
  // 篩選語意照舊精準（只查那一個原因），下拉也顯示得出名字而不是原始代碼
  const qReason = String(route.query.reason || '')
  const applied = !!qReason && qReason !== 'manual' && qReason in HANDOFF_REASON_LABELS
  if (applied) {
    extraReasonOption.value = { label: `只看：${HANDOFF_REASON_LABELS[qReason as HandoffReason]}`, value: qReason }
    reasonFilter.value = qReason
    // 警示看的是「發生過幾次」而非「還沒處理」→ 連結帶 includeResolved 才不會落在空清單
    if (String(route.query.includeResolved || '') === '1') showResolved.value = true
  }
  // deep-link 是一次性指令:用完清掉網址,否則使用者把篩選改回「全部原因」後 F5 又被套回來
  if (applied) router.replace({ query: {} }).catch(() => {})
  void loadAll().then(() => {
    if (applied)
      void nextTick(() => scrollToHandoffs())
  })
})
</script>
