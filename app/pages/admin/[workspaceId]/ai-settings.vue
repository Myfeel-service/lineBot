<template>
  <AdminSplitLayout solo>
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="AI 客服"
        title="AI 設定"
        caption="開關、回覆模式、語氣與轉真人規則;細部參數收在最下方「進階調校」"
        :help-topics="['ai-settings']"
      />
      <div v-if="canEditSettings" class="flex gap-1 admin-header-actions">
        <el-button :disabled="!dirty" @click="cancelEdits">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty" data-tour="ais-save" @click="save">儲存設定</el-button>
      </div>
      <div v-else class="text-xs text-muted">僅檢視;修改 AI 設定需要管理員權限</div>
    </template>

    <template #editor-body>
      <!-- 載入失敗:不給人編輯一份存不了的空表單,顯示錯誤 + 重試 -->
      <div v-if="loadError" class="solo-editor-body ai-load-error">
        <p>設定載入失敗,目前顯示的不是這個工作區的實際設定。</p>
        <el-button type="primary" plain @click="loadSettings">重試</el-button>
      </div>
      <el-form v-else :disabled="!canEditSettings" class="solo-editor-body admin-panel-stack" @submit.prevent>
        <!-- ── 目前狀態 ───────────────────────── -->
        <div class="message-card ai-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">目前狀態</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="ai-status-row">
              <span :class="['badge', statusBadgeClass]">{{ statusLabel }}</span>
              <!-- ⛔「本期」不是「本月」：planState 讀的是額度攔截那顆計數器,按續約錨定日一期。
                   ⓘ 講清楚「則」是什麼——這一行是很多人第一次看到這個單位的地方。 -->
              <span v-if="planView" class="ai-status-usage">
                本期已用 {{ planState.used.toLocaleString() }}<template v-if="planState.limit != null"> / {{ planState.limit.toLocaleString() }}</template> 則
                <el-tooltip placement="top" :content="REPLY_UNIT_TIP">
                  <el-icon class="admin-unit-info"><InfoFilled /></el-icon>
                </el-tooltip>
              </span>
              <span v-else-if="usageTokens !== null" class="ai-status-usage">
                本月用量 {{ formatTokens(usageTokens) }}<template v-if="form.quota.monthlyTokenCap > 0"> / {{ formatTokens(form.quota.monthlyTokenCap) }}</template> tokens
              </span>
              <NuxtLink :to="`/admin/${workspaceId}/ai-usage`" class="ai-status-link">AI 表現 →</NuxtLink>
            </div>
            <el-progress
              v-if="quotaPct !== null"
              :percentage="quotaPct"
              :stroke-width="8"
              :status="quotaPct >= 90 ? 'exception' : quotaPct >= 70 ? 'warning' : undefined"
            />
            <div v-if="showChecklist" class="ai-checklist">
              <p class="ai-section-hint ai-checklist-title">上線前建議完成:</p>
              <div class="ai-check-item">
                <span><el-icon :color="kbReady ? 'var(--brand-green-text)' : 'var(--text-muted)'"><component :is="kbReady ? CircleCheckFilled : CircleCheck" /></el-icon></span>
                <span>知識庫有內容(目前 {{ cardCount ?? '—' }} 條)</span>
                <NuxtLink :to="`/admin/${workspaceId}/knowledge/sources`" class="ai-status-link">去補知識 →</NuxtLink>
              </div>
              <div class="ai-check-item">
                <span><el-icon :color="notifyReady ? 'var(--brand-green-text)' : 'var(--text-muted)'"><component :is="notifyReady ? CircleCheckFilled : CircleCheck" /></el-icon></span>
                <span>把手機加進 LINE 通知(AI 答不了時才有人即時接手)</span>
                <!-- `G-107`：兩個落點頁都是客服以上才進得去（line-notify＝notify.self、測試對話＝playground.use），
                     觀察者點下去只會被守門彈回來，連結不給 -->
                <NuxtLink v-if="can('notify.self')" :to="`/admin/${workspaceId}/settings/line-notify`" class="ai-status-link">去加手機 →</NuxtLink>
              </div>
              <div class="ai-check-item">
                <span><el-icon><InfoFilled /></el-icon></span>
                <span>到「測試對話」試答幾題,確認 AI 答得對再上線;先用「草稿」模式跑一兩週更穩</span>
                <NuxtLink v-if="can('playground.use')" :to="`/admin/${workspaceId}/ai-playground`" class="ai-status-link">去測試 →</NuxtLink>
              </div>
            </div>
          </div>
        </div>

        <!-- ── 總開關 ─────────────────────────── -->
        <!-- `data-agent-target`（`D-112`）：小幫手改完這一塊會亮一下（對照 shared/agent-entry 的 ADMIN_OP_TARGET） -->
        <div class="message-card ai-section-card" data-tour="ais-toggle" data-agent-target="ai-toggle">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">總開關</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- ⛔「規則」2026-08-09 就下架併進自動回應了，這裡只剩一種東西不受影響 -->
            <p class="ai-section-hint">關掉之後 AI 不接任何訊息;自動回應不受影響,照常運作。</p>
            <div class="admin-field-group">
              <AdminFieldLabel text="啟用 AI 自動回覆" tight />
              <el-switch
                v-model="form.enabled"
                active-text="啟用"
                inactive-text="停用"
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="回覆模式" tight />
              <el-radio-group v-model="form.replyMode" :disabled="!form.enabled">
                <el-radio value="auto">全自動(AI 直接回覆客人)</el-radio>
                <el-radio value="draft">草稿(AI 只給客服建議回覆,不回覆客人)</el-radio>
              </el-radio-group>
              <p class="ai-section-hint">
                建議新導入時先用「草稿」跑一到兩週:AI 的建議回覆會出現在「對話」頁的 AI 脈絡區塊,
                由客服一鍵帶入回覆框。確認答題品質穩定後再切「全自動」。
              </p>
            </div>
          </div>
        </div>

        <!-- ── 回答風格 ──────────────────────── -->
        <div class="message-card ai-section-card" data-tour="ais-style">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">回答風格</span>
              <span v-if="!activePreset" class="badge badge-gray">已自訂</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              決定 AI「多有把握才開口」。拿不準的問題一律轉真人客服,不會亂答。
            </p>
            <div class="ai-preset-cards">
              <button
                v-for="p in PRESET_CARDS"
                :key="p.key"
                type="button"
                class="ai-preset-card"
                :class="{ 'is-active': activePreset === p.key }"
                :disabled="!canEditSettings"
                @click="applyPreset(p.key)"
              >
                <span class="ai-preset-card__mark" aria-hidden="true" />
                <span class="ai-preset-card__text">
                  <span class="ai-preset-card__title">
                    {{ p.title }}
                    <span v-if="p.key === 'balanced'" class="ai-preset-card__tag">預設</span>
                  </span>
                  <span class="ai-preset-card__desc">{{ p.desc }}</span>
                </span>
              </button>
            </div>
            <p v-if="!activePreset" class="ai-section-hint">
              目前門檻是在「進階調校」手動調整過的組合;點任一風格會覆蓋回預設組合。
            </p>
          </div>
        </div>

        <!-- ── 系統提示 ──────────────────────── -->
        <!-- `ais-tone`（`D-109`）：導覽以前把「語氣與人設」講在上一張「多有把握才開口」那張卡上，
             真正改語氣的是這一張，現在自己一步 -->
        <div class="message-card ai-section-card" data-tour="ais-tone" data-agent-target="tone">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">語氣與禁則</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">給 AI 的指示:講話口吻、不能說什麼、要怎麼處理特殊狀況。<template v-if="canEditSettings">不知道怎麼寫?先套下面的範本再改。</template></p>
            <!-- `G-107`：套範本是純動作（不是在顯示目前的值），存不了的人整排不出現，不做灰掉 -->
            <div v-if="canEditSettings" class="ai-tone-row">
              <span class="ai-tone-label">套用範本</span>
              <el-button size="small" plain @click="applyToneTemplate('friendly')">親切活潑</el-button>
              <el-button size="small" plain @click="applyToneTemplate('professional')">專業簡潔</el-button>
              <el-button size="small" plain @click="applyToneTemplate('warm')">溫暖體貼</el-button>
            </div>
            <el-input
              v-model="form.systemPrompt"
              type="textarea"
              :rows="8"
              :maxlength="4000"
              placeholder="例:你是品牌的線上客服,語氣親切簡潔。只根據知識庫內容回答,不確定就轉真人客服…"
            />
          </div>
        </div>

        <!-- ── 商店網址 ──────────────────────── -->
        <div class="message-card ai-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">商店 / 官網網址</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              客人問價格 / 購買、但知識裡沒有對應連結時,AI 會用這個網址回覆「最新價格與購買請見…」。留空則不啟用。
            </p>
            <el-input
              v-model="form.shopUrl"
              :maxlength="500"
              placeholder="https://your-shop.example.com/"
              clearable
            />
          </div>
        </div>

        <!-- ── LINE 通知（2026-09-27 `C-270`：整區搬到「設定 → LINE 通知」，這裡只留指路）──
             ⛔ 不在這裡留一份可以改的名單：兩個地方都能改＝遲早對不上；而且這頁要開了 AI 才進得去，
             純真人客服的帳號永遠改不到。 -->
        <div class="message-card ai-section-card" data-tour="ais-handoff">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">LINE 通知</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              AI 答不出來、客人要找真人時要傳到誰的手機、什麼時候傳，搬到
              <!-- `G-107`：觀察者進不去那一頁（notify.self＝客服以上），只講在哪、不給連結 -->
              <NuxtLink v-if="can('notify.self')" :to="`/admin/${workspaceId}/settings/line-notify`">「設定 → LINE 通知」</NuxtLink>
              <template v-else>「設定 → LINE 通知」</template>
              了。
            </p>
          </div>
        </div>

        <!-- ── 客人傳的照片 ─────────────── -->
        <div class="message-card ai-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">客人傳的照片</span>
              <span v-if="form.imageAnswer.enabled" class="badge badge-green">啟用中</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              AI 一律會<strong>讀圖寫一句說明給客服看</strong>(顯示在「對話」頁的照片下方);
              這顆開關只決定客人收到什麼——停用時回客人「我目前只能閱讀文字」;
              啟用後,客人有打字就照他打的回答,先傳照片再問的,AI 回答時會參考照片內容;只傳照片沒說話時,問他想了解什麼,並附上 AI 猜的選項。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="讓 AI 參考照片回覆客人" tight />
              <el-switch
                v-model="form.imageAnswer.enabled"
                :disabled="!form.enabled"
                active-text="啟用"
                inactive-text="停用"
              />
              <!-- 開啟後這段建議就沒意義了,留著只是雜訊(同「回答風格」的 v-if 慣例) -->
              <p v-if="!form.imageAnswer.enabled" class="ai-section-hint">
                建議先停用一陣子,到「對話」頁看 AI 寫的照片說明準不準,再決定要不要讓它開口。
                客人傳的照片常是瑕疵品、付款失敗畫面、訂單爭議,這些本來就適合真人處理。
              </p>
            </div>
          </div>
        </div>

        <!-- ── 顧客標籤（CRM 分眾，CRM-EVAL-20260822 P1）─────────────── -->
        <div class="message-card ai-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">顧客標籤</span>
              <span v-if="form.autoTagSuggest.enabled" class="badge badge-green">AI 建議啟用中</span>
              <!-- 沒互動標籤預設開＝正常狀態不用講；被關掉才值得在標題列看得到（G-20⑥） -->
              <span v-if="!form.inactiveTag.enabled" class="badge badge-gray">沒互動標籤已停用</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              標籤是發推播挑名單的依據。這裡的兩個功能都只在後台動標籤,<strong>不會對客人說任何話</strong>。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="太久沒來訊的客人，自動貼「沒互動」標籤" tight />
              <el-switch
                v-model="form.inactiveTag.enabled"
                active-text="啟用"
                inactive-text="停用"
              />
              <p class="ai-section-hint">
                超過天數沒來訊就自動貼上（標籤叫「{{ form.inactiveTag.days }} 天沒互動」），
                客人一回來就自動摘掉——發「好久不見」推播時選這個標籤就是名單。
                ⚠️ 系統從 {{ INBOUND_TIME_TRACKING_SINCE }} 才開始記「客人最後一次來訊」的時間，
                在那之前就沒再來訊的老客第一批抓不到，會隨時間自然補齊。
              </p>
              <div v-if="form.inactiveTag.enabled" class="admin-field-group">
                <AdminFieldLabel text="幾天沒來訊算「沒互動」" tight />
                <el-input-number
                  v-model="form.inactiveTag.days"
                  :min="MIN_INACTIVE_TAG_DAYS"
                  :max="MAX_INACTIVE_TAG_DAYS"
                  :step="1"
                />
              </div>
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="AI 讀對話，建議這位客人該貼什麼標籤" tight />
              <el-switch
                v-model="form.autoTagSuggest.enabled"
                active-text="啟用"
                inactive-text="停用"
              />
              <p class="ai-section-hint">
                這是總開關。開了之後，AI 只會判斷<strong>你在「標籤管理」逐顆指定的標籤</strong>
                （每顆標籤可選：不用／AI 先建議／AI 直接貼；判斷條件也寫在標籤上）——
                問卷、客服紀錄這類沒指定的標籤，AI 完全不會碰。
                「先建議」的會出現在「好友」頁點開客人時的 AI 建議區，你按「採用」才貼上。
                開啟後每場對話會多一次小額 AI 費用。
              </p>
              <!-- ⛔ 這段是必要的（08-25 code review 抓到）：同一顆開關自 C-70 起還會啟動
                   「發現新標籤」——它會讀最近兩週的對話**發明全新的標籤名**。上面那句
                   「沒指定的標籤 AI 完全不會碰」講的是既有標籤，不涵蓋這件事；
                   不補這段，使用者是在不知情的狀況下同意了另一件事。 -->
              <p class="ai-section-hint">
                <strong>還有一件事也會一起開：</strong>系統每週會讀一次最近兩週的對話，
                找「很多客人在聊、但你還沒有標籤」的主題，在「標籤管理」頁提議新標籤。
                <strong>它只提議、不會自己建</strong>，你按了才會新增。
              </p>
            </div>
          </div>
        </div>

        <!-- ── 服務時間 / 勿擾時段 ─────────────── -->
        <div class="message-card ai-section-card" data-tour="ais-hours" data-agent-target="service-hours">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">服務時間 / 勿擾時段</span>
              <span v-if="form.serviceHours.enabled" class="badge badge-green">啟用中</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              設定服務時間後,非服務時間內不論客服流程或 AI 要轉真人,都<strong>不推播通知客服</strong>(不半夜吵人),改回客人一則「勿擾訊息」。
              轉真人本身照常發生——客服上班回來在「對話」頁就能接手。時間以台灣時區為準。
            </p>
            <p class="ai-section-hint">
              勾了「週六日整天休息」還會多一件事:<strong>假日不發每日摘要</strong>,那些事會併進上班日的那一則。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="啟用服務時間 / 勿擾" tight />
              <el-switch v-model="form.serviceHours.enabled" active-text="啟用" inactive-text="停用" />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="服務時段(台灣時間)" tight />
              <div class="ai-hours-row">
                <el-time-select
                  v-model="form.serviceHours.start"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="開始"
                  :clearable="false"
                  :disabled="!form.serviceHours.enabled"
                />
                <span class="ai-hours-sep">～</span>
                <el-time-select
                  v-model="form.serviceHours.end"
                  start="00:00"
                  step="00:30"
                  end="23:30"
                  placeholder="結束"
                  :clearable="false"
                  :disabled="!form.serviceHours.enabled"
                />
              </div>
              <p class="ai-section-hint">此時段以外算「非服務時間」。若結束時間早於開始(例:22:00～06:00)視為跨夜營業。</p>
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="週末" tight />
              <el-switch
                v-model="form.serviceHours.weekendOff"
                active-text="週六日整天休息"
                inactive-text="週末照常服務"
                :disabled="!form.serviceHours.enabled"
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="勿擾時段回覆客人的訊息" tight />
              <el-input
                v-model="form.serviceHours.dndReply"
                type="textarea"
                :rows="2"
                :maxlength="500"
                :disabled="!form.serviceHours.enabled"
                placeholder="您好,目前非客服服務時間,我們會在服務時間盡快回覆您 🙏"
              />
              <!-- 客人看到的字會多一行,這裡不講清楚的話店家會以為系統擅自改了他的文案。
                   時間由上面的欄位帶,店家改營業時間不必回頭改這段文字（也就不會留下假資訊）。
                   ⛔ 這行只在**真的會補**的時候出現：關著、或起訖同一分鐘／格式壞掉時
                   appendServiceHoursLine 一個字都不會補,卻拿一個寫死的例子講「會自動補」,
                   那就是在畫面上示範一句客人永遠不會收到的話。 -->
              <p v-if="serviceHoursPreview" class="ai-section-hint">
                送出時會自動在後面補一行實際的服務時間(「服務時間：{{ serviceHoursPreview }}」),
                客人才知道要等到什麼時候。文案裡自己寫了時間就不會重複補。
              </p>
            </div>
          </div>
        </div>

        <!-- ── 敏感詞 ─────────────────────────── -->
        <div class="message-card ai-section-card" data-agent-target="sensitive-topics">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">敏感詞</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">命中以下任一關鍵字,AI 一律不答、直接轉真人。子字串比對。</p>
            <div class="ai-tag-row">
              <el-tag
                v-for="topic in form.sensitiveTopics"
                :key="topic"
                type="warning"
                :closable="canEditSettings"
                class="ai-tag"
                @close="removeSensitive(topic)"
              >
                {{ topic }}
              </el-tag>
              <el-input
                v-if="sensitiveInputVisible"
                ref="sensitiveInputEl"
                v-model="sensitiveInput"
                size="small"
                class="ai-tag-input"
                @keydown.enter.prevent="commitSensitive"
                @blur="commitSensitive"
              />
              <el-button v-else-if="canEditSettings" size="small" plain @click="showSensitiveInput">＋ 新增</el-button>
            </div>
          </div>
        </div>

        <!-- ── 進階調校(預設收合)──────────────── -->
        <!-- data-tour="ais-advanced"：導覽要教「真人閒置自動交還」得先幫他把這一段展開
             （⛔ 已經展開就不可以再點一次——那會把它收起來，見 clickBeforeUnless） -->
        <button type="button" class="ai-advanced-toggle" data-tour="ais-advanced" @click="showAdvanced = !showAdvanced">
          <span class="ai-advanced-toggle__arrow">{{ showAdvanced ? '▾' : '▸' }}</span>
          進階調校
          <span class="ai-advanced-toggle__sub">門檻、反問澄清、用量上限{{ isSuperAdmin ? '、模型' : '' }} — 一般情況用上方「回答風格」即可</span>
        </button>

        <template v-if="showAdvanced">
          <!-- 門檻 / 回答行為 -->
          <div class="message-card ai-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">回答行為調校</span>
                <!-- 一組一顆求救鈕（D-33 P1）：每一格底下都已經有說明，缺的是「三個門檻
                     在同一條線上的關係」。⛔別改成一格一顆＝五顆問號還是講不出那條線。 -->
                <AdminFieldHelp id="aiThresholds" />
              </div>
            </div>
            <div class="card-section-stack">
              <p class="ai-section-hint">
                手動調整後,上方「回答風格」會顯示「已自訂」。按「儲存設定」才生效。
              </p>
              <div class="admin-field-group">
                <AdminFieldLabel :text="`信心門檻:${form.confidenceThreshold.toFixed(2)}`" tight />
                <el-slider
                  v-model="form.confidenceThreshold"
                  :min="0"
                  :max="1"
                  :step="0.05"
                />
                <p class="ai-section-hint">低於此門檻 AI 會放棄回答、轉真人客服。建議 0.75 起手,跑兩週後依數據再降。</p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel :text="`知識庫相關度門檻:${form.groundingThreshold.toFixed(2)}`" tight />
                <el-slider
                  v-model="form.groundingThreshold"
                  :min="0"
                  :max="1"
                  :step="0.05"
                />
                <p class="ai-section-hint">
                  AI 找到最接近的那一條知識,必須夠相關(相關度 ≥ 此值)才准開口回答;不夠相關就轉真人,不硬掰。
                  預設 0.7;如果客人問題常常只差一點點(0.65–0.69)就被擋下來、老是轉真人,可以把它調低一些。
                </p>
              </div>
            </div>
          </div>

          <!-- 反問澄清 -->
          <div class="message-card ai-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">反問澄清</span>
              </div>
            </div>
            <div class="card-section-stack">
              <p class="ai-section-hint">
                當客人問題太籠統、知識庫剛好有好幾條都沾得上邊時,AI 會主動反問、給客人幾個按鈕點選,
                而不是硬答或直接轉真人。什麼時候該反問,會依你選的「回答風格」自動設定,通常不用自己調。
              </p>
              <div class="admin-field-group">
                <AdminFieldLabel text="啟用反問澄清" tight />
                <el-switch
                  v-model="form.disambiguation.enabled"
                  active-text="啟用"
                  inactive-text="停用"
                />
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel :text="`反問下限(最相關卡 ≥):${form.disambiguation.top1Min.toFixed(2)}`" tight />
                <el-slider
                  v-model="form.disambiguation.top1Min"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  :disabled="!form.disambiguation.enabled"
                />
                <p class="ai-section-hint">如果最相關的那一條相關度太低(低於此值),代表知識庫其實沒有對應內容,就不反問、照一般規則處理。</p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel :text="`反問上限(最相關卡 <):${form.disambiguation.top1Max.toFixed(2)}`" tight />
                <el-slider
                  v-model="form.disambiguation.top1Max"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  :disabled="!form.disambiguation.enabled"
                />
                <p class="ai-section-hint">如果最相關的那一條相關度夠高(高於此值),代表答案很明確,就不反問、直接回答。</p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel :text="`前兩條差距小於:${form.disambiguation.maxSpread.toFixed(2)}`" tight />
                <el-slider
                  v-model="form.disambiguation.maxSpread"
                  :min="0"
                  :max="0.3"
                  :step="0.01"
                  :disabled="!form.disambiguation.enabled"
                />
                <p class="ai-section-hint">最相關的前兩條分數很接近(差距小於此值)時,才算「分不出客人要問哪一條」而反問;數字調越大越容易反問。</p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel text="最多選項數" tight />
                <el-input-number
                  v-model="form.disambiguation.maxOptions"
                  :min="2"
                  :max="10"
                  :disabled="!form.disambiguation.enabled"
                  controls-position="right"
                />
                <p class="ai-section-hint">AI 反問時最多列幾個按鈕給客人點選。上限 10(對齊 LINE 快速回覆;反問另有一顆「找真人」)。列越多客人越要挑,不見得越好。</p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel text="冷卻時間(分鐘)" tight />
                <el-input-number
                  v-model="form.disambiguation.cooldownMinutes"
                  :min="0"
                  :max="1440"
                  :disabled="!form.disambiguation.enabled"
                  controls-position="right"
                />
                <p class="ai-section-hint">同一對話內,兩次反問至少間隔多久,避免 AI 短時間一直反問惹人煩(反問過度是實測最常見的缺陷)。設 0 表示不限。</p>
              </div>
            </div>
          </div>

          <!-- 真人接手 / 交還(進階:接手生命週期的細部行為)-->
          <div class="message-card ai-section-card" data-tour="ais-handback" data-agent-target="handback">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">真人接手 / 交還</span>
              </div>
            </div>
            <div class="card-section-stack">
              <div class="admin-field-group">
                <AdminFieldLabel text="真人閒置自動交還機器人(分鐘,0 = 關閉)" tight />
                <el-input-number
                  v-model="form.handbackIdleMinutes"
                  :min="0"
                  :max="1440"
                  :step="5"
                />
                <p class="ai-section-hint">
                  真人接手後若超過此時間沒有再回覆,系統自動把會話交還機器人,AI / 自動回覆恢復接手,
                  避免真人忘記收尾時客人後續訊息沒人理。也可在「對話」頁手動點「交還機器人」。
                </p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel text="太久沒動靜時自動結束對話" tight />
                <el-switch
                  v-model="autoCloseIdleOn"
                  active-text="啟用"
                  inactive-text="停用"
                />
                <p class="ai-section-hint">
                  真人接手後,這段對話<strong>只有真人按「結束會話」或「交還機器人」才會結束</strong>——
                  客人隔幾天回一句「好,那就這樣訂」仍然接在真人手上,不會被 AI 搶著回答。
                  這顆開關預設停用;啟用的話,雙方都沒有動靜超過下面設的時數,系統會幫忙把那一段收起來
                  (客人不會因此被交回 AI,下次來訊仍然是真人的)。
                </p>
              </div>
              <div v-if="autoCloseIdleOn" class="admin-field-group">
                <AdminFieldLabel text="多久沒動靜就自動結束(小時)" tight />
                <el-input-number
                  v-model="form.humanSessionMaxIdleHours"
                  :min="MIN_HUMAN_SESSION_MAX_IDLE_HOURS"
                  :max="MAX_HUMAN_SESSION_MAX_IDLE_HOURS"
                  :step="12"
                />
                <p class="ai-section-hint">
                  時間從「雙方最後一次有動靜」起算。收起來的那一段時間軸會寫「太久沒有動靜,
                  系統自動結束會話」,跟真人自己按的分開講。
                </p>
              </div>
            </div>
          </div>

          <!-- Quota:已開通方案的帳號用量以「則數」計(見「目前狀態」),token 上限不生效,整段隱藏。
               另外只給改得動的人(admin)看:planView 來自 admin 端點,agent/viewer 拿 403 會誤判成
               「無方案」而錯誤顯示這一區 -->
          <div v-if="!planView && canEditSettings" class="message-card ai-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">用量上限</span>
              </div>
            </div>
            <div class="card-section-stack">
              <div class="admin-field-group">
                <AdminFieldLabel text="每月用量上限（token）" tight />
                <el-input-number
                  v-model="form.quota.monthlyTokenCap"
                  :min="0"
                  :max="100000000"
                  :step="100000"
                  controls-position="right"
                  class="control-full"
                />
                <p class="ai-section-hint">
                  這裡算的是 AI 的總使用量（送進 AI 的、AI 產生的、搜尋知識庫用的都算在內）。設 0 表示不限制。
                  <template v-if="usageTokens !== null">本月已用 {{ formatTokens(usageTokens) }} tokens。</template>
                </p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel text="用量超過上限時" tight />
                <el-radio-group v-model="form.quota.onExceed">
                  <el-radio value="handoff_all">全部轉真人(保守、推薦)</el-radio>
                  <el-radio value="downgrade_model">改用更省的模型(服務不中斷)</el-radio>
                </el-radio-group>
              </div>
            </div>
          </div>

          <!-- 模型(僅 super admin)-->
          <div v-if="isSuperAdmin" class="message-card ai-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">模型與成本</span>
                <span class="badge badge-gray">僅系統管理員可見</span>
              </div>
            </div>
            <div class="card-section-stack">
              <div class="admin-field-group">
                <AdminFieldLabel text="回答模型" tight />
                <el-select v-model="form.answerModel" class="control-full">
                  <el-option label="Gemini 2.5 Flash(推薦)" value="gemini-2.5-flash" />
                  <el-option label="Gemini 2.5 Flash Lite(更省)" value="gemini-2.5-flash-lite" />
                </el-select>
                <p class="ai-section-hint">
                  Embedding 模型固定為 gemini-embedding-001(768 dim);切換會使所有知識索引失效,不開放調整。
                </p>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel :text="`回覆長度上限:${form.replyMaxLen} 字`" tight />
                <el-slider
                  v-model="form.replyMaxLen"
                  :min="50"
                  :max="1000"
                  :step="50"
                />
                <p class="ai-section-hint">AI 會盡量把回覆控制在此字數內,過長會截斷。回覆越長 token 成本越高,故收在此由平台統一控管、一般管理員不開放調整。</p>
              </div>
            </div>
          </div>
        </template>
      </el-form>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { CircleCheck, CircleCheckFilled, InfoFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import {
  buildDefaultAiSettings,
  DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS,
  SUGGESTED_HUMAN_SESSION_MAX_IDLE_HOURS,
  MIN_HUMAN_SESSION_MAX_IDLE_HOURS,
  MAX_HUMAN_SESSION_MAX_IDLE_HOURS,
  MIN_INACTIVE_TAG_DAYS,
  MAX_INACTIVE_TAG_DAYS,
  INBOUND_TIME_TRACKING_SINCE,
} from '~~/shared/types/ai-knowledge'
import type { AiSettingsDoc } from '~~/shared/types/ai-knowledge'
import { serviceHoursSentence, taipeiYyyyMm } from '~~/shared/time'
import { REPLY_UNIT_TIP } from '~~/shared/billing/usage-units'
import { AI_TONE_TEMPLATES, type AiToneTemplateKey } from '~~/shared/ai-tone-templates'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { apiFetch, workspaceId, can } = useWorkspace()
const canEditSettings = computed(() => can('ai.settings.write'))
const { showToast } = useAdminToast()
const { isSuperAdmin, checkIsSuperAdmin } = useSuperAdmin()

interface FormShape {
  enabled: boolean
  replyMode: AiSettingsDoc['replyMode']
  answerModel: AiSettingsDoc['answerModel']
  confidenceThreshold: number
  groundingThreshold: number
  systemPrompt: string
  shopUrl: string
  replyMaxLen: number
  sensitiveTopics: string[]
  quota: { monthlyTokenCap: number; onExceed: AiSettingsDoc['quota']['onExceed'] }
  // ⛔ handoffNotify 不在這張表單裡（2026-09-27 `C-270` 搬到「設定 → LINE 通知」）：
  //    存 AI 設定時整份送出，帶著一份舊的名單就會把別人剛加進來的手機蓋掉
  handbackIdleMinutes: number
  humanSessionMaxIdleHours: number
  disambiguation: AiSettingsDoc['disambiguation']
  imageAnswer: AiSettingsDoc['imageAnswer']
  serviceHours: AiSettingsDoc['serviceHours']
  inactiveTag: AiSettingsDoc['inactiveTag']
  autoTagSuggest: AiSettingsDoc['autoTagSuggest']
}

/** 表單預設值直接取自後端同一份 buildDefaultAiSettings，避免兩份預設漂移（top1Min 0.65 事故的根因） */
function defaultForm(): FormShape {
  const d = buildDefaultAiSettings()
  return {
    enabled: d.enabled,
    replyMode: d.replyMode,
    answerModel: d.answerModel,
    confidenceThreshold: d.confidenceThreshold,
    groundingThreshold: d.groundingThreshold,
    systemPrompt: d.systemPrompt,
    shopUrl: d.shopUrl,
    replyMaxLen: d.replyMaxLen,
    sensitiveTopics: [...d.sensitiveTopics],
    quota: { ...d.quota },
    handbackIdleMinutes: d.handbackIdleMinutes,
    humanSessionMaxIdleHours: d.humanSessionMaxIdleHours,
    disambiguation: { ...d.disambiguation },
    imageAnswer: { ...d.imageAnswer },
    serviceHours: { ...d.serviceHours },
    inactiveTag: { ...d.inactiveTag },
    autoTagSuggest: { ...d.autoTagSuggest },
  }
}

const form = ref<FormShape>(defaultForm())
/**
 * 說明文字裡示範的那句服務時間,跟客人真的會收到的字用**同一支函式**算。
 * ⛔ 不可以有寫死的退路:回 null 代表這個設定下**一個字都不會補**（沒開、起訖同一分鐘＝
 *    整天不服務、或時間格式壞掉）,這時拿一個編出來的例子講「會自動補」就是在示範
 *    一句客人永遠不會收到的話。回 null 時整行說明不出現（見模板的 v-if）。
 * ⛔ 也不要餵 enabled: true:那會讓「功能關著」也算出一句話來。
 */
const serviceHoursPreview = computed(() => serviceHoursSentence(form.value.serviceHours))
const saving = ref(false)
const showAdvanced = ref(false)
const loadError = ref(false)
const { markClean, hasUnsavedChanges: dirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
  // 站內換頁預設有攔；F5 / 關分頁也要攔（prompt 可能寫了幾百字）
  enableBeforeUnload: true,
})

// 反問上下限交叉防呆:拉高下限就推高上限、壓低上限就壓低下限,
// 讓「min ≤ max」恆成立——否則後端會靜默交換存檔,畫面顯示的和存進去的不一樣
watch(() => form.value.disambiguation.top1Min, (v) => {
  if (v > form.value.disambiguation.top1Max) form.value.disambiguation.top1Max = v
})
watch(() => form.value.disambiguation.top1Max, (v) => {
  if (v < form.value.disambiguation.top1Min) form.value.disambiguation.top1Min = v
})

/**
 * 門檻 preset:非工程背景的管理者沒有依據逐項調 RAG 參數,基本層只露出三檔風格;
 * 個別 slider 收在「進階調校」。嚴格 = 寧可轉真人也不要答錯;寬鬆 = 知識庫成熟後拉高自動回覆率。
 */
type PresetName = 'strict' | 'balanced' | 'loose'

const PRESETS: Record<PresetName, { conf: number; grounding: number; top1Min: number; top1Max: number }> = {
  strict: { conf: 0.8, grounding: 0.75, top1Min: 0.7, top1Max: 0.82 },
  balanced: { conf: 0.75, grounding: 0.7, top1Min: 0.7, top1Max: 0.78 },
  loose: { conf: 0.65, grounding: 0.6, top1Min: 0.55, top1Max: 0.7 },
}

const activePreset = computed<PresetName | ''>(() => {
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.001
  for (const [name, ps] of Object.entries(PRESETS) as Array<[PresetName, typeof PRESETS.strict]>) {
    if (
      eq(form.value.confidenceThreshold, ps.conf)
      && eq(form.value.groundingThreshold, ps.grounding)
      && eq(form.value.disambiguation.top1Min, ps.top1Min)
      && eq(form.value.disambiguation.top1Max, ps.top1Max)
    ) return name
  }
  return ''
})

function applyPreset(name: PresetName) {
  const ps = PRESETS[name]
  form.value.confidenceThreshold = ps.conf
  form.value.groundingThreshold = ps.grounding
  form.value.disambiguation.top1Min = ps.top1Min
  form.value.disambiguation.top1Max = ps.top1Max
}

// 三檔風格卡的顯示內容(標題 + 白話說明);「預設」徽章單獨標在平衡上
const PRESET_CARDS: Array<{ key: PresetName; title: string; desc: string }> = [
  { key: 'strict', title: '嚴格', desc: '寧可轉真人也不答錯,適合知識庫剛起步' },
  { key: 'balanced', title: '平衡', desc: '適合多數情況' },
  { key: 'loose', title: '寬鬆', desc: '多答少轉,適合知識庫成熟、答題已穩定' },
]

// ── 語氣範本:解決「空白 textarea 不知道寫什麼」 ──────────
// 範本本體在 shared（`D-109`）：小幫手「幫我換成專業一點的語氣」吃同一份，⛔ 不在這裡另抄一份
async function applyToneTemplate(name: AiToneTemplateKey) {
  const next = AI_TONE_TEMPLATES[name].text
  const current = form.value.systemPrompt.trim()
  if (current && current !== next) {
    try {
      await ElMessageBox.confirm('套用範本會覆蓋目前的系統提示內容,確定嗎?', '套用語氣範本', {
        confirmButtonText: '覆蓋',
        cancelButtonText: '取消',
        type: 'warning',
      })
    }
    catch { return }
  }
  form.value.systemPrompt = next
}

const sensitiveInput = ref('')
const sensitiveInputVisible = ref(false)
const sensitiveInputEl = ref<{ focus: () => void } | null>(null)

function showSensitiveInput() {
  sensitiveInputVisible.value = true
  nextTick(() => sensitiveInputEl.value?.focus())
}

function commitSensitive() {
  const t = sensitiveInput.value.trim()
  if (t && !form.value.sensitiveTopics.includes(t)) {
    form.value.sensitiveTopics = [...form.value.sensitiveTopics, t]
  }
  sensitiveInput.value = ''
  sensitiveInputVisible.value = false
}

function removeSensitive(topic: string) {
  form.value.sensitiveTopics = form.value.sensitiveTopics.filter(t => t !== topic)
}

// ── 目前狀態面板:讓「調整設定」跟「現在是什麼狀態」在同一頁 ──
const usageTokens = ref<number | null>(null)
const cardCount = ref<number | null>(null)

const statusLabel = computed(() => {
  if (!form.value.enabled) return 'AI 已停用'
  return form.value.replyMode === 'draft' ? '草稿模式運作中(不會自動回客人)' : '全自動運作中'
})

// 方案（則數）摘要：已開通方案的帳號以「則數」為上限，token 上限不生效
const { plan: planView, state: planState, load: loadPlanSummary } = usePlanSummary()

const statusBadgeClass = computed(() => {
  if (!form.value.enabled) return 'badge-gray'
  return form.value.replyMode === 'draft' ? 'badge-yellow' : 'badge-green'
})

const quotaPct = computed(() => {
  // 已開通方案 → 進度以「則數」為準（token 上限不再生效）
  if (planView.value) return planState.value.limit != null ? planState.value.percent : null
  const cap = form.value.quota.monthlyTokenCap ?? 0 // 看不到上限的角色不畫進度（`G-103`）
  if (usageTokens.value === null || cap <= 0) return null
  return Math.min(100, Math.round((usageTokens.value / cap) * 100))
})

/**
 * 「太久沒動靜自動結束對話」開關。後端只認一個數字（0 ＝ 關閉、>0 ＝ 幾小時後收），
 * 開關與時數是同一個欄位的兩種樣子——⛔ 刻意不多存一個 boolean：兩份狀態遲早會不一致
 * （開關說開、時數是 0 就變成無聲的關閉，而畫面上看起來是開的）。
 * 打開時填建議值 48 小時，關掉時寫 0。
 */
const autoCloseIdleOn = computed({
  get: () => form.value.humanSessionMaxIdleHours > 0,
  set: (on: boolean) => {
    form.value.humanSessionMaxIdleHours = on ? SUGGESTED_HUMAN_SESSION_MAX_IDLE_HOURS : 0
  },
})

const kbReady = computed(() => (cardCount.value ?? 0) > 0)
/** 名單上有沒有人在收（唯讀，從載入的設定讀；名單本身在「設定 → LINE 通知」改） */
const notifyReady = ref(false)
const showChecklist = computed(() => !form.value.enabled || !kbReady.value || !notifyReady.value)

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

async function loadStatus() {
  const period = taipeiYyyyMm() // 與後端 aiUsage 月結桶同一把尺(台灣時區),避免月底 8 小時讀錯月
  loadPlanSummary().catch(() => {}) // 方案摘要：決定用量以「則數」還是 token 呈現
  const [usage, sources] = await Promise.allSettled([
    apiFetch<{ inputTokens: number; outputTokens: number; embeddingTokens: number }>(`/api/ai/usage/summary?period=${period}`),
    apiFetch<{ items: Array<{ chunkCount: number }> }>('/api/ai/sources/list'),
  ])
  // token 細目僅 super admin 的回應才有（成本可見性收歸平台）；欄位不在就維持 null，
  // 不能用 ?? 0 硬算——那會把「看不到」顯示成「本月已用 0 tokens」。
  if (usage.status === 'fulfilled' && typeof usage.value.inputTokens === 'number') {
    usageTokens.value = (usage.value.inputTokens ?? 0) + (usage.value.outputTokens ?? 0) + (usage.value.embeddingTokens ?? 0)
  }
  if (sources.status === 'fulfilled') {
    cardCount.value = sources.value.items.reduce((sum, s) => sum + (s.chunkCount ?? 0), 0)
  }
}

/**
 * `GET`／`PUT /api/ai/settings` 回來的是**依角色遮過**的版本（`G-103`，`ai-settings-redact.ts`）：
 *   - 回答模型、回覆長度：只有超管拿得到
 *   - 每月 token 上限：只有 ai.settings.write（管理員）拿得到
 *   - LINE 通知名單：只有 notify.self（客服以上）拿得到；人數 `recipientCount` 每個角色都有
 * ⛔ 這幾格不在時**不要**當成 0／空名單解讀——那是「你看不到」，不是「沒有」。
 */
type AiSettingsResponse = Omit<AiSettingsDoc, 'answerModel' | 'replyMaxLen' | 'quota' | 'handoffNotify'> & {
  answerModel?: AiSettingsDoc['answerModel']
  replyMaxLen?: number
  quota: Omit<AiSettingsDoc['quota'], 'monthlyTokenCap'> & { monthlyTokenCap?: number }
  handoffNotify?: { recipientCount?: number, lineUserIds?: string[] }
}

/** 把後端回傳的設定套進表單並標記乾淨。load 與 save 共用——save 後回填 normalize 結果，
 * 後端有任何修正（min/max 交換、clamp、剪 displayNames）畫面都會跟上,不會「設定自己跳掉」。 */
function applySettings(data: AiSettingsResponse) {
  const d = buildDefaultAiSettings()
  form.value = {
    enabled: data.enabled,
    replyMode: data.replyMode === 'draft' ? 'draft' : 'auto',
    // 超管以外拿不到這兩格：填預設只是讓表單型別完整——畫面只有超管那張卡會顯示它們，
    // 管理員存檔時送上去也會被 PUT 丟掉、沿用現值（settings.put.ts），不會被預設值蓋掉
    answerModel: data.answerModel ?? d.answerModel,
    confidenceThreshold: data.confidenceThreshold,
    groundingThreshold: data.groundingThreshold,
    systemPrompt: data.systemPrompt,
    shopUrl: data.shopUrl ?? '',
    replyMaxLen: data.replyMaxLen ?? d.replyMaxLen,
    sensitiveTopics: [...data.sensitiveTopics],
    // 看不到上限的人（客服、觀察者）當 0＝「不顯示上限」：頁首那行 `> 0` 才顯示、用量進度條 `cap <= 0` 不畫；
    // 能改的人（管理員）一定拿得到真值，所以這個 0 不會被存回去
    quota: { ...data.quota, monthlyTokenCap: data.quota?.monthlyTokenCap ?? 0 },
    handbackIdleMinutes: Number(data.handbackIdleMinutes ?? 0),
    humanSessionMaxIdleHours: Number(data.humanSessionMaxIdleHours ?? DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS),
    disambiguation: { ...data.disambiguation },
    imageAnswer: { ...data.imageAnswer },
    serviceHours: { ...data.serviceHours },
    // 舊工作區沒有這兩個欄位時退回預設（normalize 也會補，這裡是載入時的同一個口徑）
    inactiveTag: { ...(data.inactiveTag ?? buildDefaultAiSettings().inactiveTag) },
    autoTagSuggest: { ...(data.autoTagSuggest ?? buildDefaultAiSettings().autoTagSuggest) },
  }
  // 名單有人＝有人在收（舊資料「有人但關著」後端 normalize 已收成空名單，⛔ 這裡不再另判 enabled）。
  // `G-103`：觀察者拿不到名單本身，改看每個角色都有的人數；舊版後端沒有人數時才退回數名單
  notifyReady.value = (data.handoffNotify?.recipientCount ?? data.handoffNotify?.lineUserIds?.length ?? 0) > 0
  lastLoadedDoc = data
  nextTick(() => markClean())
}

/** 最後一次成功載入 / 儲存的伺服器版本；取消編輯時用它原地還原,不必重打 API */
let lastLoadedDoc: AiSettingsResponse | null = null

async function loadSettings() {
  try {
    const data = await apiFetch<AiSettingsResponse>('/api/ai/settings')
    applySettings(data)
    loadError.value = false
  }
  catch (err: any) {
    // 載入失敗時不能讓人編輯一份存不了的空表單:顯示錯誤狀態 + 重試(見模板)
    loadError.value = true
    showToast(err?.statusMessage || '載入設定失敗', 'error')
  }
}

async function cancelEdits() {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('放棄未儲存的變更?', '取消編輯', {
        confirmButtonText: '放棄變更',
        cancelButtonText: '繼續編輯',
        type: 'warning',
      })
    }
    catch { return }
  }
  if (lastLoadedDoc) applySettings(lastLoadedDoc)
  else await loadSettings()
}

async function save() {
  // 像網域但缺協定的放行——後端 normalize 會補 https:// 並經 applySettings 回填顯示;
  // 完全不像網址的才擋（AI 會把它原樣發給客人）
  const url = form.value.shopUrl.trim()
  if (url && !/^https?:\/\//i.test(url) && !/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(url)) {
    showToast('商店網址格式不正確（需為網址,AI 會把它原樣發給客人）', 'error')
    return
  }
  saving.value = true
  try {
    const updated = await apiFetch<AiSettingsResponse>('/api/ai/settings', { method: 'PUT', body: form.value })
    applySettings(updated)
    showToast('已儲存', 'success')
  }
  catch (err: any) {
    showToast(err?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

// ── 舊連結：?focus=handoff ──────────────────────────────
// 以前小幫手「設定轉真人通知」帶人來這頁聚光那一卡；那一區搬到「設定 → LINE 通知」之後（`C-270`），
// 還拿著舊連結進來的人直接送過去，⛔ 不讓他在這頁找一個已經不在的區塊。
const route = useRoute()

// ── 小幫手改完（`D-112` 第 4 件）：重讀設定、改到的那一塊亮一下 ──────────────
// 🔴 這一頁是「整份表單一起存」：畫面停在舊值時他順手按一下儲存，就把小幫手剛改的改回去，
//    而且兩邊都不會有人講一聲。所以沒有沒存的修改就重讀；有的話⛔不重讀（會蓋掉他打到一半的東西），
//    回 dirty 讓聊天照實講「直接存會改回去」。
useAgentOpRefresh('ai-settings', async (evt, { mode }) => {
  if (mode === 'fresh' && dirty.value) return 'dirty'
  if (mode !== 'arrived' && !dirty.value) await loadSettings()
  // 「真人接手／交還」收在「進階調校」裡：先展開才看得到
  if (evt.section === 'handback') showAdvanced.value = true
  await nextTick()
  return (await flashAgentTarget(evt.section, mode === 'arrived' ? 8000 : 3000)) ? 'shown' : 'missing'
})

onMounted(() => {
  if (route.query.focus === 'handoff') {
    void navigateTo(`/admin/${workspaceId.value}/settings/line-notify?add=me`, { replace: true })
    return
  }
  loadSettings()
  loadStatus()
  checkIsSuperAdmin().catch(() => {})
})
</script>
