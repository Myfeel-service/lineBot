<template>
  <AdminSplitLayout solo>
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="AI 客服"
        title="AI 設定"
        caption="開關、回覆模式、語氣與轉真人規則;細部參數收在最下方「進階調校」"
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
              <span v-if="planView" class="ai-status-usage">
                本月已用 {{ planState.used.toLocaleString() }}<template v-if="planState.limit != null"> / {{ planState.limit.toLocaleString() }}</template> 則
              </span>
              <span v-else-if="usageTokens !== null" class="ai-status-usage">
                本月用量 {{ formatTokens(usageTokens) }}<template v-if="form.quota.monthlyTokenCap > 0"> / {{ formatTokens(form.quota.monthlyTokenCap) }}</template> tokens
              </span>
              <NuxtLink :to="`/admin/${workspaceId}/ai-usage`" class="ai-status-link">用量監控 →</NuxtLink>
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
                <span>設定轉真人通知(AI 答不了時才有人即時接手)</span>
              </div>
              <div class="ai-check-item">
                <span><el-icon><InfoFilled /></el-icon></span>
                <span>到「測試對話」試答幾題,確認 AI 答得對再上線;先用「草稿」模式跑一兩週更穩</span>
                <NuxtLink :to="`/admin/${workspaceId}/ai-playground`" class="ai-status-link">去測試 →</NuxtLink>
              </div>
            </div>
          </div>
        </div>

        <!-- ── 總開關 ─────────────────────────── -->
        <div class="message-card ai-section-card" data-tour="ais-toggle">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">總開關</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">關掉之後 AI 不接任何訊息;規則/腳本不受影響。</p>
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
        <div class="message-card ai-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">語氣與禁則</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">給 AI 的指示:講話口吻、不能說什麼、要怎麼處理特殊狀況。不知道怎麼寫?先套下面的範本再改。</p>
            <div class="ai-tone-row">
              <span class="ai-tone-label">套用範本</span>
              <el-button size="small" plain :disabled="!canEditSettings" @click="applyToneTemplate('friendly')">親切活潑</el-button>
              <el-button size="small" plain :disabled="!canEditSettings" @click="applyToneTemplate('professional')">專業簡潔</el-button>
              <el-button size="small" plain :disabled="!canEditSettings" @click="applyToneTemplate('warm')">溫暖體貼</el-button>
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

        <!-- ── 轉真人通知 ─────────────────────── -->
        <div class="message-card ai-section-card" data-tour="ais-handoff">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">轉真人通知</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              AI 或腳本把對話轉給真人時,用官方帳號推播 LINE 訊息提醒以下客服人員。
              收通知的人必須已加這個官方帳號為好友;同一位客人 10 分鐘內只通知一次。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="啟用通知" tight />
              <el-switch
                v-model="form.handoffNotify.enabled"
                active-text="啟用"
                inactive-text="停用"
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="通知對象(最多 10 位)" tight />
              <el-select
                v-model="form.handoffNotify.lineUserIds"
                multiple
                filterable
                remote
                allow-create
                :default-first-option="notifyQuery.length > 0"
                :remote-method="searchNotifyUsers"
                :loading="notifySearchLoading"
                :multiple-limit="10"
                :disabled="!form.handoffNotify.enabled"
                placeholder="點一下挑選,或輸入暱稱搜尋…"
                class="control-full"
                @change="syncNotifyDisplayNames"
                @visible-change="onNotifyDropdownVisible"
              >
                <el-option
                  v-for="opt in notifyUserOptions"
                  :key="opt.id"
                  :value="opt.id"
                  :label="opt.name"
                >
                  <span class="ai-notify-option">
                    <img
                      v-if="opt.picture"
                      :src="opt.picture"
                      class="ai-notify-option-avatar"
                      alt=""
                    >
                    <span v-else class="ai-notify-option-avatar-placeholder"><el-icon><User /></el-icon></span>
                    <span class="ai-notify-option-name">{{ opt.name }}</span>
                    <span class="ai-notify-option-id">{{ opt.id }}</span>
                  </span>
                </el-option>
                <template #empty>
                  <p class="ai-notify-empty">
                    {{ notifySearchLoading
                      ? '搜尋中…'
                      : notifyQuery
                        ? '找不到這個暱稱的會員'
                        : '還沒有人加這個官方帳號為好友,可直接貼上 U 開頭的 LINE userId' }}
                  </p>
                </template>
              </el-select>
              <p class="ai-section-hint">
                點一下從會員清單挑選(預設列出最近加入的好友),或輸入暱稱搜尋
                (對方需已加這個官方帳號好友並傳過訊息);也可直接貼上 U 開頭的 LINE userId 後按 Enter。
              </p>
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="超時再提醒(分鐘,0 = 關閉)" tight />
              <el-input-number
                v-model="form.handoffNotify.slaRemindMinutes"
                :min="0"
                :max="1440"
                :step="5"
                :disabled="!form.handoffNotify.enabled"
              />
              <p class="ai-section-hint">
                轉真人後超過此時間仍無人回覆,再推播提醒一次(每場會話只提醒一次)。
              </p>
            </div>
          </div>
        </div>

        <!-- ── 服務時間 / 勿擾時段 ─────────────── -->
        <div class="message-card ai-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">服務時間 / 勿擾時段</span>
              <span v-if="form.serviceHours.enabled" class="badge badge-green">啟用中</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ai-section-hint">
              設定服務時間後,非服務時間內不論腳本或 AI 要轉真人,都<strong>不推播通知客服</strong>(不半夜吵人),改回客人一則「勿擾訊息」。
              轉真人本身照常發生——客服上班回來在「對話」頁就能接手。時間以台灣時區為準。
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
            </div>
          </div>
        </div>

        <!-- ── 敏感詞 ─────────────────────────── -->
        <div class="message-card ai-section-card">
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
        <button type="button" class="ai-advanced-toggle" @click="showAdvanced = !showAdvanced">
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
          <div class="message-card ai-section-card">
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
            </div>
          </div>

          <!-- Quota:已開通方案的帳號用量以「則數」計(見「目前狀態」),token 上限不生效,整段隱藏 -->
          <div v-if="!planView" class="message-card ai-section-card">
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
import { CircleCheck, CircleCheckFilled, InfoFilled, User } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { buildDefaultAiSettings } from '~~/shared/types/ai-knowledge'
import type { AiSettingsDoc } from '~~/shared/types/ai-knowledge'
import { taipeiYyyyMm } from '~~/shared/time'

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
  handoffNotify: AiSettingsDoc['handoffNotify']
  handbackIdleMinutes: number
  disambiguation: AiSettingsDoc['disambiguation']
  serviceHours: AiSettingsDoc['serviceHours']
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
    handoffNotify: { ...d.handoffNotify, lineUserIds: [...d.handoffNotify.lineUserIds], displayNames: { ...d.handoffNotify.displayNames } },
    handbackIdleMinutes: d.handbackIdleMinutes,
    disambiguation: { ...d.disambiguation },
    serviceHours: { ...d.serviceHours },
  }
}

const form = ref<FormShape>(defaultForm())
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
const TONE_TEMPLATES = {
  friendly: `你是品牌的線上客服,語氣親切、活潑、有溫度,像朋友一樣聊天,可以適度使用表情符號。
回答要簡短好讀,先講重點再補充細節。
只根據知識庫內容回答;不確定的事不要猜,直接說會請真人客服協助。
不主動承諾退費、賠償或時程;涉及個資只引導客人到官方管道處理。`,
  professional: `你是品牌的線上客服,語氣專業、有禮、精準,不使用表情符號。
回答控制在三句話內,先給結論,必要時條列步驟。
只根據知識庫內容回答;沒有依據時不要推測,直接轉真人客服。
不代表公司做出任何承諾(退費、賠償、時程);涉及帳號或個資一律轉真人。`,
  warm: `你是品牌的線上客服,語氣溫暖、有同理心,先回應客人的感受再處理問題。
遇到抱怨或不滿,先道歉並表達理解,再說明能協助的部分。
只根據知識庫內容回答;答不出來就坦白說明並轉真人客服。
不做退費、賠償等承諾;敏感或情緒激動的情況盡快轉真人。`,
} as const

async function applyToneTemplate(name: keyof typeof TONE_TEMPLATES) {
  const next = TONE_TEMPLATES[name]
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
  const cap = form.value.quota.monthlyTokenCap
  if (usageTokens.value === null || cap <= 0) return null
  return Math.min(100, Math.round((usageTokens.value / cap) * 100))
})

const kbReady = computed(() => (cardCount.value ?? 0) > 0)
const notifyReady = computed(() => form.value.handoffNotify.enabled && form.value.handoffNotify.lineUserIds.length > 0)
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
  if (usage.status === 'fulfilled') {
    usageTokens.value = (usage.value.inputTokens ?? 0) + (usage.value.outputTokens ?? 0) + (usage.value.embeddingTokens ?? 0)
  }
  if (sources.status === 'fulfilled') {
    cardCount.value = sources.value.items.reduce((sum, s) => sum + (s.chunkCount ?? 0), 0)
  }
}

// ── 通知對象選人器:下拉直接挑會員,也能用暱稱搜尋,免去手抄 LINE userId ──
/** id 一律是純 LINE userId（Uxxx…）——存進設定後要直接餵給 LINE 推播，不能用 Firestore doc id */
type NotifyUser = { id: string; displayName: string; pictureUrl: string }

const notifySearchLoading = ref(false)
const notifySearchResults = ref<NotifyUser[]>([])
/** 沒打字時的預設清單(最近加入的好友)——下拉一點開就有人可選,不必先猜暱稱 */
const notifyDefaultUsers = ref<NotifyUser[]>([])
const notifyDefaultLoaded = ref(false)
const notifyQuery = ref('')
// userId → 暱稱/頭像(已儲存的 displayNames + 搜尋結果累積),讓已選 tag 顯示名字而不是 Uxxxx
const knownUserNames = ref<Record<string, string>>({})
const knownUserPictures = ref<Record<string, string>>({})

const notifyUserOptions = computed(() => {
  const map = new Map<string, string>()
  for (const uid of form.value.handoffNotify.lineUserIds) {
    map.set(uid, knownUserNames.value[uid] || uid)
  }
  for (const u of (notifyQuery.value ? notifySearchResults.value : notifyDefaultUsers.value)) {
    map.set(u.id, u.displayName || u.id)
  }
  return [...map.entries()].map(([id, name]) => ({
    id,
    name,
    picture: knownUserPictures.value[id] || '',
  }))
})

async function fetchNotifyUsers(search: string): Promise<NotifyUser[]> {
  const qs = search ? `search=${encodeURIComponent(search)}&limit=20` : 'limit=20'
  const res = await apiFetch<{ users: (NotifyUser & { lineUserId?: string })[] }>(`/api/users/list?${qs}`)
  // 取 lineUserId 而非 doc id：doc id 是 {workspaceId}_{lineUserId}，餵給 LINE 會被判無效、通知靜默失敗
  const users = res.users.map(u => ({
    id: String(u.lineUserId || '').trim(),
    displayName: u.displayName,
    pictureUrl: u.pictureUrl ?? '',
  })).filter(u => u.id)
  for (const u of users) {
    if (u.displayName) knownUserNames.value[u.id] = u.displayName
    if (u.pictureUrl) knownUserPictures.value[u.id] = u.pictureUrl
  }
  return users
}

/** 下拉展開時抓一次預設清單;失敗就放掉旗標,下次展開再試,不影響打字搜尋 */
async function ensureNotifyDefaultUsers() {
  if (notifyDefaultLoaded.value) return
  notifyDefaultLoaded.value = true
  notifySearchLoading.value = true
  try {
    notifyDefaultUsers.value = await fetchNotifyUsers('')
  }
  catch {
    notifyDefaultLoaded.value = false
  }
  finally {
    notifySearchLoading.value = false
  }
}

function onNotifyDropdownVisible(visible: boolean) {
  if (visible) void ensureNotifyDefaultUsers()
}

async function searchNotifyUsers(query: string) {
  const q = query.trim()
  notifyQuery.value = q
  // 清空關鍵字時退回預設清單,而不是變成空白下拉
  if (!q) {
    notifySearchResults.value = []
    await ensureNotifyDefaultUsers()
    return
  }
  notifySearchLoading.value = true
  try {
    notifySearchResults.value = await fetchNotifyUsers(q)
  }
  catch {
    notifySearchResults.value = []
  }
  finally {
    notifySearchLoading.value = false
  }
}

function syncNotifyDisplayNames() {
  const names: Record<string, string> = {}
  for (const uid of form.value.handoffNotify.lineUserIds) {
    const name = knownUserNames.value[uid]
    if (name) names[uid] = name
  }
  form.value.handoffNotify.displayNames = names
}

/** 把後端回傳的設定套進表單並標記乾淨。load 與 save 共用——save 後回填 normalize 結果，
 * 後端有任何修正（min/max 交換、clamp、剪 displayNames）畫面都會跟上,不會「設定自己跳掉」。 */
function applySettings(data: AiSettingsDoc) {
  form.value = {
    enabled: data.enabled,
    replyMode: data.replyMode === 'draft' ? 'draft' : 'auto',
    answerModel: data.answerModel,
    confidenceThreshold: data.confidenceThreshold,
    groundingThreshold: data.groundingThreshold,
    systemPrompt: data.systemPrompt,
    shopUrl: data.shopUrl ?? '',
    replyMaxLen: data.replyMaxLen,
    sensitiveTopics: [...data.sensitiveTopics],
    quota: { ...data.quota },
    handoffNotify: {
      enabled: data.handoffNotify?.enabled === true,
      lineUserIds: [...(data.handoffNotify?.lineUserIds ?? [])],
      displayNames: { ...(data.handoffNotify?.displayNames ?? {}) },
      slaRemindMinutes: Number(data.handoffNotify?.slaRemindMinutes ?? 15),
    },
    handbackIdleMinutes: Number(data.handbackIdleMinutes ?? 0),
    disambiguation: { ...data.disambiguation },
    serviceHours: { ...data.serviceHours },
  }
  // 回填名稱快取,讓已選通知對象的 tag 顯示暱稱
  for (const [uid, name] of Object.entries(data.handoffNotify?.displayNames ?? {})) {
    if (name) knownUserNames.value[uid] = name
  }
  lastLoadedDoc = data
  nextTick(() => markClean())
}

/** 最後一次成功載入 / 儲存的伺服器版本；取消編輯時用它原地還原,不必重打 API */
let lastLoadedDoc: AiSettingsDoc | null = null

async function loadSettings() {
  try {
    const data = await apiFetch<AiSettingsDoc>('/api/ai/settings')
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
    const updated = await apiFetch<AiSettingsDoc>('/api/ai/settings', { method: 'PUT', body: form.value })
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

onMounted(() => {
  loadSettings()
  loadStatus()
  checkIsSuperAdmin().catch(() => {})
})
</script>
