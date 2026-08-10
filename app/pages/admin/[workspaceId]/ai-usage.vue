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
        <!-- 刻意沒有卡片標題：原本寫「核心指標」是內部術語，而且月份 hero 自己會講，
             標題列等於把下面那句再說一次 -->
        <div class="message-card usage-card" data-tour="usg-kpi">
          <div class="card-section-stack">
            <div v-if="loading && !summary" class="usage-loading"><div class="spinner" /></div>
            <!-- 載入失敗 ≠ 還沒有客人來問：summary 拿不到時如實說「不知道」。
                 「查不到」跟「沒問題」必須是兩種畫面（08-09 假綠燈教訓，三個載入點都比照） -->
            <div v-else-if="!summary" class="usage-empty usage-empty--error">
              <span class="usage-empty__icon usage-empty__icon--error">!</span>
              <div>
                <div class="usage-empty__title">數據剛剛沒有載出來</div>
                <div class="usage-empty__desc">不是沒有客人來問，是還不知道——通常重試一次就好。</div>
              </div>
              <el-button size="small" @click="loadAll">重試</el-button>
            </div>
            <template v-else>
              <!-- Hero：AI 出手 = 自己答完 + 轉給真人 + 先問清楚（乾淨拆解，一條分段長條看懂產出結構）。
                   用詞照 2026-08-07 的名詞收斂表（docs/STATS-SIMPLIFICATION-20260807.md）：
                   不再講「AI 介入／反問」——畫面早就是白話了，註解也別留舊詞免得被抄回去 -->
              <div class="usage-hero">
                <div class="usage-hero__head">
                  <!-- Hero 主角＝自己搞定率，不是處理了幾則（2026-08-10 拍板）。
                       這是 agent 產品真正在賣的東西：幫你擋掉多少，而不是用掉多少。
                       則數退居副標——它是分母，不是成績。 -->
                  <template v-if="(summary?.aiEngaged ?? 0) > 0">
                    <strong class="usage-hero__num" :class="metricTone('autoReply', summary?.autoReplyRate)">
                      {{ formatPercent(summary?.autoReplyRate) }}
                    </strong>
                    <span class="usage-hero__label"><b>自己搞定</b><br>{{ periodLabel }} AI 出手 {{ formatNumber(summary?.aiEngaged) }} 次{{ invocationsDeltaText }}</span>
                    <!-- 比率的變化要用「百分點」不是「%」：68%→74% 是進步 6 個百分點，不是 6%。
                         這顆可以上色——自己搞定率越高越好，方向明確（訊息量則不然，故只寫在副標不上色）。 -->
                    <span
                      v-if="autoReplyDeltaPts !== null"
                      class="usage-delta"
                      :class="autoReplyDeltaPts > 0 ? 'usage-delta--good' : (autoReplyDeltaPts < 0 ? 'usage-delta--warn' : '')"
                    >
                      較上月 {{ autoReplyDeltaPts > 0 ? '▲' : (autoReplyDeltaPts < 0 ? '▼' : '＝') }} {{ Math.abs(autoReplyDeltaPts) }} 個百分點
                    </span>
                  </template>
                  <!-- 一則都沒有時不能顯示「0% 自己搞定」——那會把「沒資料」講成「一題都沒答對」。
                       「有客人但全是指名真人」也不能說成「還沒有客人來問」——那是另一回事。 -->
                  <template v-else>
                    <strong class="usage-hero__num">—</strong>
                    <span class="usage-hero__label"><b>自己搞定</b><br>{{ (summary?.invocations ?? 0) > 0 ? `${periodLabel} 客人都直接找真人，AI 沒有出手` : `${periodLabel} 還沒有客人來問` }}</span>
                  </template>
                </div>
                <template v-if="(summary?.aiEngaged ?? 0) > 0">
                  <div
                    class="usage-segbar"
                    role="img"
                    :aria-label="`自己答完 ${summary?.answered}、轉給真人 ${aiHandoffCount}、先問清楚 ${summary?.disambiguations}`"
                  >
                    <span class="usage-seg usage-seg--answered" :style="{ width: `${segPct.answered}%` }" />
                    <span class="usage-seg usage-seg--handoff" :style="{ width: `${segPct.handoff}%` }" />
                    <span class="usage-seg usage-seg--clarify" :style="{ width: `${segPct.clarify}%` }" />
                  </div>
                  <div class="usage-legend">
                    <div class="usage-leg usage-leg--answered">
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">自己答完</span>
                      <span class="usage-leg__v">{{ formatNumber(summary?.answered) }}</span>
                      <span class="usage-leg__pct">{{ formatPercent(summary?.autoReplyRate) }}</span>
                    </div>
                    <div
                      class="usage-leg usage-leg--handoff"
                      :class="{ 'usage-leg--link': (summary?.handoffs ?? 0) > 0 }"
                      :role="(summary?.handoffs ?? 0) > 0 ? 'button' : undefined"
                      :tabindex="(summary?.handoffs ?? 0) > 0 ? 0 : undefined"
                      @click="(summary?.handoffs ?? 0) > 0 && scrollToHandoffs()"
                      @keydown.enter="(summary?.handoffs ?? 0) > 0 && scrollToHandoffs()"
                    >
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">
                        轉給真人
                        <!-- 兩本帳的說明放在最容易被拿去對數字的位置：這裡數「次」（AI 每觸發一次轉接算一次）、
                             對話統計頁數「場」（同一場轉幾次都算 1）——兩邊數字不同是刻意的，見定義書 -->
                        <el-tooltip placement="top" content="AI 看過之後判斷該給真人接的次數。客人一開口就指名真人的不算在這（另列在下方）。這裡數「次」，對話統計頁數「場」（同一場轉幾次都算 1），兩頁數字不一樣是正常的。">
                          <el-icon class="usage-leg__info"><InfoFilled /></el-icon>
                        </el-tooltip>
                      </span>
                      <span class="usage-leg__v">{{ formatNumber(aiHandoffCount) }}</span>
                      <span class="usage-leg__pct">{{ formatPercent(summary?.handoffRate) }}</span>
                      <span v-if="(summary?.handoffs ?? 0) > 0" class="usage-leg__go">查看 ↓</span>
                    </div>
                    <div class="usage-leg usage-leg--clarify">
                      <span class="usage-leg__dot" />
                      <span class="usage-leg__k">
                        先問清楚
                        <el-tooltip placement="top" content="這是中間一步、不是結局：AI 先問「你是要哪一個」，客人選完 AI 才接著回答。偏高通常代表知識卡標題太相近。">
                          <el-icon class="usage-leg__info"><InfoFilled /></el-icon>
                        </el-tooltip>
                      </span>
                      <span class="usage-leg__v">{{ formatNumber(summary?.disambiguations) }}</span>
                      <span class="usage-leg__pct">{{ formatPercent(summary?.disambiguationRate) }}</span>
                      <!-- 反問的成果：followup 不記 answered，用子計數補能見度（8/10 起才有資料，0 就不顯示） -->
                      <span v-if="(summary?.followupAnswered ?? 0) > 0" class="usage-leg__pct usage-leg__followup">問完答成功 {{ formatNumber(summary?.followupAnswered) }} 次</span>
                    </div>
                  </div>
                </template>

                <!-- 轉真人拆解：同一個數字拆成「有救的」跟「本來就設計要人接的」，才知道力氣花哪。
                     放在 v-if 外面：就算整月都是客人指名（沒有長條），下面那行也要照講。 -->
                <div v-if="handoffBreakdown" class="usage-note">
                  轉給真人的 {{ formatNumber(handoffBreakdown.total) }} 次裡：答不出來 <b>{{ formatNumber(handoffBreakdown.gap) }}</b> 次（補知識就有救）<template v-if="handoffBreakdown.intended">・刻意設計要人接的 <b>{{ formatNumber(handoffBreakdown.intended) }}</b> 次（查訂單、敏感話題這類）</template><template v-if="handoffBreakdown.unknown">・其餘 {{ formatNumber(handoffBreakdown.unknown) }} 次是較早的紀錄，沒留下原因</template>
                </div>

                <!-- 客人指名真人：這是客人偏好，不是 AI 的成績（分子分母都不含），所以列在長條外面 -->
                <div v-if="(summary?.directHandoffs ?? 0) > 0" class="usage-note">
                  另有 <b>{{ formatNumber(summary?.directHandoffs) }}</b> 次客人一開口就指名真人、直接轉接——這是客人偏好，不算進上面的成績。
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

              <!-- ⛔ 這頁不放任何金額與 token：計費賣「則數」，成本是平台的進貨價，
                   一律只在超管的「成本總覽」頁講（2026-08-10 拍板）。這裡通篇只講則數與品質。 -->
              <div class="usage-substats">
                <!-- 「答完客人又找真人」是目前唯一能回答「答得好不好」的數字。
                     沒有任何 AI 答題時顯示「—」:0% 上綠色會把「沒資料」講成「滿分」。 -->
                <div class="usage-substat">
                  <span class="usage-substat__label">
                    答完客人又找真人
                    <el-tooltip placement="top" content="AI 回答完 30 分鐘內，客人仍要求轉真人——通常代表沒答對或沒答到重點。這是最接近「答得好不好」的指標。">
                      <el-icon class="usage-substat__info"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </span>
                  <template v-if="(summary?.answered ?? 0) > 0">
                    <strong class="usage-substat__value" :class="metricTone('answeredThenHandoff', summary?.answeredThenHandoffRate)">{{ formatPercent(summary?.answeredThenHandoffRate) }}</strong>
                    <span class="usage-substat__sub">{{ formatNumber(summary?.answeredThenHandoffs) }} 次 · 越低越好</span>
                  </template>
                  <template v-else>
                    <strong class="usage-substat__value">—</strong>
                    <span class="usage-substat__sub">{{ periodLabel }} AI 還沒有答過題</span>
                  </template>
                </div>
              </div>
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

        <!-- ── 近 3 個月趨勢：讓「監控」看得出變好還變差，不只是單月快照 ── -->
        <div class="message-card usage-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">近 3 個月趨勢</span>
              <span class="text-xs text-muted">柱子看量、折線看自己搞定率（線往上＝變好）</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div v-if="loadingTrend && !trend.length" class="usage-loading"><div class="spinner" /></div>
            <div v-else-if="trendError" class="usage-empty usage-empty--error">
              <span class="usage-empty__icon usage-empty__icon--error">!</span>
              <div>
                <div class="usage-empty__title">趨勢剛剛沒有載出來</div>
                <div class="usage-empty__desc">不是沒有資料，是還不知道——通常重試一次就好。</div>
              </div>
              <el-button size="small" @click="loadTrend">重試</el-button>
            </div>
            <ClientOnly v-else-if="trendHasData">
              <VChart class="usage-trend-chart" :option="trendOption" autoresize />
              <template #fallback><div class="usage-loading"><div class="spinner" /></div></template>
            </ClientOnly>
            <div v-else class="usage-empty">
              <template v-if="trendMonthsWithData === 1">目前只有一個月的資料，再過一個月就能看出是變好還是變差。</template>
              <template v-else>還沒有足夠資料能看趨勢，AI 開始服務客人後這裡就會長出來。</template>
            </div>
          </div>
        </div>
        <!-- 方案額度排最後：這是行政資訊，平常只是「確認一下還夠」。
             一打開就先講用掉多少 = 先講錢再講價值；真的快用完時上面本來就有紅／黃警示。 -->
        <template v-if="planQuota">
          <div class="message-card usage-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">方案額度</span>
                <span class="text-xs text-muted">{{ planQuota.name }} · 本期 {{ quotaPeriodLabel }}</span>
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
                  <template v-if="quotaRemaining !== null">（剩 {{ formatNumber(quotaRemaining) }} 則）</template>
                  <template v-if="planQuota.overagePerReply">・超量加購 NT${{ planQuota.overagePerReply }}/則</template>
                </p>
              </template>
              <p v-else class="usage-hint">此方案為客製額度，無固定則數上限。</p>
              <!-- 雙時間軸提醒：額度按「續約日」算一期，和上方報表的月份不是同一個區間，避免日期兜不起來被誤會 -->
              <p v-if="planQuota.currentPeriodStart" class="usage-hint usage-hint--muted">
                額度以「續約日」為一期（{{ quotaPeriodLabel }}），和上方報表選的月份不是同一個區間。
              </p>
            </div>
          </div>

          <AdminPlanUpgradeDialog v-model="upgradeDialogOpen" :current-plan-id="planQuota.id" />
        </template>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { ChatDotRound, InfoFilled, Refresh, Upload } from '@element-plus/icons-vue'
import { HANDOFF_REASON_LABELS, KNOWLEDGE_GAP_HANDOFF_REASONS, type HandoffReason } from '~~/shared/types/ai-knowledge'
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

interface TrendPoint {
  period: string
  label: string
  invocations: number
  answered: number
  handoffs: number
  disambiguations: number
  directHandoffs: number
}

const summary = ref<Summary | null>(null)
const handoffs = ref<HandoffRow[]>([])
const trend = ref<TrendPoint[]>([])
// ⛔ 三個 loading 初始都是 true：初始 render 發生在 onMounted 之前，
// 初始 false 會讓「還沒開始載」的那一幀直接掉進空狀態（畫面閃一下「還沒有客人來問」）
const loading = ref(true)
const loadingHandoffs = ref(true)
const loadingTrend = ref(true)
// 失敗三態：「查不到」和「沒問題」要分開（凡是查不到＝沒事的檢查都是假綠燈）
const trendError = ref(false)
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

// AI 出手的三種結果佔比（分段長條寬度）。分母是 aiEngaged（AI 真的出手過）——
// 客人指名真人的 directHandoffs 分子分母一起扣，恆等式仍成立：
// answered + (handoffs − direct) + disambiguations = aiEngaged，三段相加即 100%。
const segPct = computed(() => {
  const total = summary.value?.aiEngaged || 0
  if (!total) return { answered: 0, handoff: 0, clarify: 0 }
  return {
    answered: ((summary.value?.answered ?? 0) / total) * 100,
    handoff: (aiHandoffCount.value / total) * 100,
    clarify: ((summary.value?.disambiguations ?? 0) / total) * 100,
  }
})

/** 「AI 判斷後轉真人」＝總轉真人扣掉客人指名的那些（圖例與長條都用這個數） */
const aiHandoffCount = computed(() =>
  Math.max(0, (summary.value?.handoffs ?? 0) - (summary.value?.directHandoffs ?? 0)))

/**
 * 轉真人原因拆解：讓「轉給真人 77 次」看得出該做什麼。
 * 分兩類就好——「補知識有救」（用 gap 建議同一份白名單，兩處不會各判各的）
 * vs「刻意設計要人接」（查訂單、敏感話題這類，補知識沒用）。
 * 客人指名真人的兩種原因不進這行（那些已在長條外單獨講）；
 * 事件比總數少的差額如實標「沒留下原因」——事件表 2026-08-10 前記不全、且有 240 天 TTL。
 */
const handoffBreakdown = computed(() => {
  const total = aiHandoffCount.value
  if (!total) return null
  const counts = summary.value?.handoffReasonCounts ?? {}
  let gap = 0
  let intended = 0
  for (const [reason, n] of Object.entries(counts)) {
    if (reason === 'user_request' || reason === 'non_text_content') continue
    if (KNOWLEDGE_GAP_HANDOFF_REASONS.has(reason)) gap += n
    else intended += n
  }
  if (!gap && !intended) return null // 事件全缺（太舊）就不顯示，別出現「0 次有救」
  const unknown = Math.max(0, total - gap - intended)
  return { total, gap, intended, unknown }
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
  const s = summary.value
  // 用 aiEngaged 當門檻：客人全是指名真人的月份 AI 沒出手，沒有成績可以下判語
  if (!s || !s.aiEngaged) return null
  const rate = s.autoReplyRate
  const pct = formatPercent(rate)
  const tone = metricTone('autoReply', rate).replace('is-', '') // good | warn | neutral

  const title = tone === 'good'
    ? `客人來問的，AI 自己搞定 ${pct}，表現不錯`
    : tone === 'warn'
      ? `客人來問的，AI 只搞定 ${pct}，大部分還是要人接`
      : `客人來問的，AI 自己搞定 ${pct}，還有進步空間`

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
    next = `下面有 ${pending}${pendingGapHasMore.value ? '+' : ''} 題答不出來還沒補知識，補完最有機會把這個數字拉上去。`
    canAct = true
  }
  else {
    next = '目前沒有待補的知識，維持下去就好。'
  }

  // 品質但書：回答完 30 分鐘內又被找真人的比例過線（>25%）就要講——「搞定」可能沒答到重點
  if (s.answered > 0 && metricTone('answeredThenHandoff', s.answeredThenHandoffRate) === 'is-warn')
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

/**
 * 所選月份 vs 前一個月的訊息量變化。沿用趨勢那份資料（同一支 API、同一把台灣時區的尺），
 * 不另外再查一次。趨勢是「舊→新」排序，前一期即 index-1；選到最舊那個月沒得比 → null 不顯示。
 */
/** 所選月份在趨勢陣列裡的前一期（趨勢是「舊→新」排序）；選到最舊那個月就沒得比 */
const prevTrendPoint = computed(() => {
  const idx = trend.value.findIndex(p => p.period === period.value)
  return idx > 0 ? (trend.value[idx - 1] ?? null) : null
})

/**
 * 自己搞定率的變化，單位是**百分點**。
 * ⛔ 別寫成百分比：68% → 74% 是「進步 6 個百分點」，不是「進步 6%」（那是 8.8%）。
 * 比率的比率最容易被誤讀，寫錯就等於報錯成績。
 */
const autoReplyDeltaPts = computed(() => {
  const prev = prevTrendPoint.value
  if (!prev) return null
  // 上月也用同一把「AI 出手過」的尺（舊月份 directHandoffs=0 → 自動等於舊算法）
  const prevEngaged = prev.invocations - (prev.directHandoffs ?? 0)
  if (!prevEngaged) return null
  const cur = summary.value
  if (!cur?.aiEngaged) return null
  const prevRate = prev.answered / prevEngaged
  return Math.round((cur.autoReplyRate - prevRate) * 100)
})

/** 則數的變化只寫在副標、不上色：訊息變多是生意變好還是負擔變重，看的人自己判斷 */
const invocationsDeltaText = computed(() => {
  const p = prevTrendPoint.value
  const prev = p ? p.invocations - (p.directHandoffs ?? 0) : 0
  const cur = summary.value?.aiEngaged ?? 0
  if (!prev) return ''
  const pct = Math.round(((cur - prev) / prev) * 100)
  if (pct === 0) return '（與上月持平）'
  return `（較上月 ${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%）`
})

/**
 * ⛔ 至少要**兩個月**有量才畫趨勢圖。
 * 只有一個月的話畫出來是孤零零一組柱子——那不是趨勢，只是把單月數字換個樣子再講一次，
 * 反而讓人以為「看起來很少」。剛上線的第一個月就該老實說「還要再一個月」。
 */
const trendMonthsWithData = computed(() => trend.value.filter(p => p.invocations > 0).length)
const trendHasData = computed(() => trendMonthsWithData.value >= 2)
/**
 * 每個月的「AI 出手過」次數與自己搞定率——與 hero 同一把尺（扣掉客人指名真人的）。
 * 舊月份沒有 directHandoffs（0）→ 自然退回舊算法，歷史數字不會跳。
 */
const trendRows = computed(() => trend.value.map((p) => {
  const direct = p.directHandoffs ?? 0
  const engaged = Math.max(0, p.invocations - direct)
  return {
    ...p,
    direct,
    engaged,
    aiHandoffs: Math.max(0, p.handoffs - direct),
    // 沒出手的月份給 null 而不是 0：ECharts 會斷線，不會畫一條假的 0% 下去
    ratePct: engaged > 0 ? Math.round((p.answered / engaged) * 100) : null,
  }
}))

const trendOption = computed(() => {
  const rows = trendRows.value
  return {
    // ⚠️ 必須與 hero 分段長條同色（_ai-usage.scss 的 --brand-green-deep / #5b7a9d）：
    // 同一頁上下兩塊講同一件事，顏色一漂就變成「四種顏色三個意思」。
    // ECharts 吃不了 CSS 變數，只能硬寫——改 token 時要記得回來改這裡。
    color: ['#05b24c', '#5b7a9d', '#d99a2b', '#3f5a78'],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      /**
       * ⛔ 第一行必須是結論（自己搞定率＋上月對比），三個原始數字擺後面。
       * 這張圖存在的唯一理由是回答「有沒有變好」，而變好＝率上升，不是柱子變高：
       * 客人變多時三根柱子會一起長，看起來很熱鬧但可能其實在退步。
       * 只丟 80/90/33 就是要使用者自己心算 80÷203 再跟上月比——那正是要消滅的事。
       */
      formatter: (params: Array<{ dataIndex: number }>) => {
        const i = params?.[0]?.dataIndex ?? 0
        const r = rows[i]
        if (!r) return ''
        const prev = rows[i - 1]
        const head = r.ratePct === null
          ? `<div style="font-weight:700">${r.label}　AI 沒有出手</div>`
          : `<div style="font-weight:700">${r.label}　自己搞定 ${r.ratePct}%`
            + (prev?.ratePct != null ? `<span style="font-weight:400;opacity:.7">（上月 ${prev.ratePct}%）</span>` : '')
            + '</div>'
        const line = (c: string, k: string, v: number) =>
          `<div style="display:flex;align-items:center;gap:6px;font-size:12px">`
          + `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></span>`
          + `<span style="flex:1">${k}</span><b>${v}</b></div>`
        // 過渡期揭露：舊月份的 handoffs 混著「客人指名真人」，數不出來就講明白，
        // 免得這張圖和 hero 底下的拆解行互相打架
        const note = r.direct > 0
          ? `<div style="font-size:11px;opacity:.7;margin-top:4px">含客人指名真人 ${r.direct} 次，已不計入成績</div>`
          : (r.handoffs > 0 && r.aiHandoffs === r.handoffs && r.period < '202609'
              ? '<div style="font-size:11px;opacity:.7;margin-top:4px">此月尚未區分「客人指名真人」，數字偏高</div>'
              : '')
        return head
          + line('#05b24c', '自己答完', r.answered)
          + line('#5b7a9d', '轉給真人', r.aiHandoffs)
          + line('#d99a2b', '先問清楚', r.disambiguations)
          + note
      },
    },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 8, data: ['自己答完', '轉給真人', '先問清楚', '自己搞定率'] },
    grid: { left: 8, right: 12, top: 22, bottom: 34, containLabel: true },
    xAxis: { type: 'category', data: rows.map(p => p.label), axisTick: { alignWithLabel: true } },
    // 雙軸：左邊看量（柱），右邊看好壞（率）。量會隨客人數一起長，只看柱子看不出退步
    yAxis: [
      {
        type: 'value',
        minInterval: 1,
        max: (v: { max: number }) => Math.max(1, Math.ceil((v.max || 1) * 1.15)),
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
    series: [
      { name: '自己答完', type: 'bar', barMaxWidth: 34, data: rows.map(p => p.answered), label: { show: true, position: 'top', fontSize: 11 } },
      { name: '轉給真人', type: 'bar', barMaxWidth: 34, data: rows.map(p => p.aiHandoffs), label: { show: true, position: 'top', fontSize: 11 } },
      // 三段要湊齊：少畫這段的話柱子加起來 ≠ hero 總數，看的人一定會拿去對帳
      { name: '先問清楚', type: 'bar', barMaxWidth: 34, data: rows.map(p => p.disambiguations), label: { show: true, position: 'top', fontSize: 11 } },
      // 折線＝這張圖真正的主角：線往上就是變好，不必心算
      {
        name: '自己搞定率',
        type: 'line',
        yAxisIndex: 1,
        data: rows.map(p => p.ratePct),
        smooth: false,
        symbolSize: 7,
        lineStyle: { width: 2 },
        label: { show: true, position: 'top', fontSize: 11, formatter: '{c}%' },
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

async function loadTrend() {
  loadingTrend.value = true
  try {
    trend.value = await apiFetch<TrendPoint[]>('/api/ai/usage/trend?months=3')
    trendError.value = false
  }
  catch {
    trend.value = []
    trendError.value = true
  }
  finally {
    loadingTrend.value = false
  }
}

async function loadAll() {
  await Promise.all([loadSummary(), loadHandoffs(), loadTrend()])
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
