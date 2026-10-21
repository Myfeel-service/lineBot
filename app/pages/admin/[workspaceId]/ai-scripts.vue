<template>
  <AdminSplitLayout :is-empty="!selectedScript && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title">自動回應<AdminPageHelpButton :topics="['ai-scripts']" /></span>
      <!-- `D-138`④：「新增」先挑起點（三種＋一句話描述＋範本），不再直接給一張空白表單 -->
      <el-button v-if="canEditScripts" :icon="Plus" type="primary" size="small" data-tour="scr-new" @click="openStarter">新增</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <!-- `D-112`：「用一句話建立」接在「新增」正下方（標頭 240px 塞不下第三顆） -->
      <AgentAskButton page="ai-scripts" row />
      <div v-if="loading && !scripts.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <!-- ⛔ 2026-09-29（`D-109`）：以前一條都沒有時整塊換成「尚無客服流程」，那一列「客人加好友時」
           跟著消失——違反下面 `D-23` 的「沒設定也在」，而最需要看到它的正是剛開的帳號。
           現在清單永遠畫，空的說明接在那一列下面。 -->
      <div v-else ref="listEl" class="split-list" data-tour="scr-list" @scroll.passive="onSidebarListScroll">
        <!--
          `D-23` 拍板：**「客人加好友時」永遠釘在最上面，沒設定也在。**
          以前它藏在「新增 → 觸發方式的第三顆」，商家腦中的詞（歡迎訊息）跟我們的詞
          （客服流程／觸發方式）對不上，結果 MYFEEL 7 條自動回應裡一條加好友的都沒有，
          最近 90 天約 667 位掃 QR 加好友的人一句話都沒收到，而後台沒有任何地方會講。
          ⛔ 不新增側欄項目（08-22 拍板），它本來就是一條自動回應。
        -->
        <AdminSplitListItem
          :title="FOLLOW_WELCOME_LABEL"
          :active="isFollowRowActive"
          data-tour="scr-follow-row"
          title-row-chip
          :chip-text="followRow.chipText"
          :chip-tone="followRow.chipTone"
          :meta-text="followRow.meta"
          :meta-truncate="false"
          :class="['scripts-follow-row', { 'scripts-follow-row--unset': followRow.state === 'unset' }]"
          :data-agent-target="followScript?.id"
          @select="onFollowRowSelect"
        />
        <div v-if="!messageScripts.length" class="split-sidebar-empty">
          <span>還沒有別的自動回應</span>
          <p class="text-xs text-muted">建一條：客人說了某句話，就自動回一段，或一步步問他資料</p>
          <el-button v-if="canEditScripts" size="small" type="primary" plain @click="openStarter">立即新增</el-button>
        </div>
        <AdminSplitListItem
          v-for="script in messageScripts"
          :key="script.id"
          :title="script.name || '(未命名流程)'"
          :active="selectedId === script.id"
          time-in-title-row
          title-row-chip
          :chip-text="script.enabled ? '啟用' : '停用'"
          :chip-tone="script.enabled ? 'success' : 'neutral'"
          :meta-text="listMeta(script)"
          :meta-truncate="true"
          :data-agent-target="script.id"
          @select="selectScript(script)"
        />
        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
        </div>
      </div>
    </template>

    <!-- ── Empty State ── -->
    <template #editor-empty>
      <!-- 什麼都沒選＝新增的起點：範本與「AI 搭草稿」不再只在這裡（以前點過任何一條就要「新增 → 取消」才找得到） -->
      <AdminScriptStarter
        v-if="canEditScripts"
        ref="starterEl"
        heading="新增自動回應：先挑一個起點"
        :follow-set="Boolean(followScript)"
        :templates="starterTemplates"
        :generating="aiGenerating"
        @start="startFrom"
        @follow="onFollowRowSelect"
        @template="createFromTemplate"
        @generate="generateFromAi"
      />
      <template v-else>
        <el-icon class="empty-icon"><Operation /></el-icon>
        <h3>選擇一條自動回應開始檢視</h3>
      </template>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <!-- `D-138`④：名稱選填——沒填就用客人會講的第一句（以前必填、擋存檔，一句話的設定也要先想名字） -->
      <AdminEditorHeaderTitle
        v-if="canEditScripts"
        v-model="form.name"
        field-label="名稱"
        create-prefix="新增自動回應："
        :placeholder="namePlaceholder"
        caption="選填，沒填就用客人會講的第一句"
        :is-creating="isCreating"
        @enter="submitForm"
      />
      <!-- `G-107`：存不了的人名稱只給看（同知識庫頁資料名稱的做法） -->
      <div v-else class="admin-flex-1">
        <AdminFieldLabel text="名稱" tight />
        <div class="admin-title-row">
          <span class="split-editor-title">{{ form.name || '(未命名)' }}</span>
        </div>
      </div>
      <div class="flex gap-2 admin-header-actions">
        <!-- 開關搬到標題列（`D-138`④）：以前在「基本設定」卡裡、排在內容上面 -->
        <el-switch v-if="canEditScripts" v-model="form.enabled" class="scripts-header-switch" active-text="啟用" inactive-text="停用" />
        <span v-else class="scripts-header-state">{{ form.enabled ? '啟用中' : '停用' }}</span>
        <el-button @click="cancelEdit">{{ canEditScripts ? '取消' : '關閉' }}</el-button>
        <el-button v-if="canEditScripts" type="primary" :loading="saving" data-tour="scr-save" @click="submitForm">
          {{ isCreating ? '建立自動回應' : '儲存變更' }}
        </el-button>
        <!-- 複製／刪除收在「⋯」（全站同一顆）。
             ⛔「客人加好友時」那條不給複製：一個帳號只能有一條在用，而清單只釘一列（啟用的優先），
                停用的複本畫面上任何地方都看不到＝建好了卻找不到。 -->
        <AdminMoreMenu
          v-if="canEditScripts && !isCreating && selectedScript"
          :items="[
            { command: 'duplicate', label: '複製', icon: CopyDocument, disabled: duplicating, show: !selectedIsFollowScript },
            { command: 'delete', label: '刪除', icon: Delete, danger: true },
          ]"
          @command="onHeaderCommand"
        />
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <!--
        `D-138`④：左邊設定、右邊「試試看」常駐（編輯區不夠寬時試試看排到下面，用 container query 不用 @media）。
        ⛔ 一頁只留一條捲軸：右邊不吸頂、不自己捲（08-09 老闆回報過「上面一塊自己捲、下面又捲一次」）。
      -->
      <div class="ai-scripts-body scripts-workspace">
        <div class="scripts-main admin-panel-stack">
          <!--
            即時檢查：三件事疊在同一條線上才敢亮綠燈——
            ① 接線合法（擋存檔，沿用後端同一套 validateScriptDoc）
            ② 每一題走得完（findStuckCollects：問代碼類資料又沒退路＝客人被無限重問）
            ③ 這條輪得到（findUnreachableScripts：撞到敏感情境詞或被別條包住會無聲失效）
            只驗①的綠燈會保證它沒檢查過的事——正式站的「查詢訂單」接線全對，客人卻走不出去。
            清單模式沒問題時不亮綠燈那一列：照順序問的設定沒有接線可以錯，那一句只是多一行字。
          -->
          <div v-if="flowIssue" class="scripts-flow-status is-error">
            <el-icon><CircleCloseFilled /></el-icon>
            <span>還差一步：{{ flowIssue }}</span>
          </div>
          <div v-for="w in flowWarnings" :key="w.key" class="scripts-flow-status is-warn">
            <el-icon><WarningFilled /></el-icon>
            <span>{{ w.text }}</span>
            <el-button v-if="w.nodeId" size="small" text type="primary" class="scripts-flow-status-action" @click="focusStep(w.nodeId)">去看這一題</el-button>
          </div>
          <div v-if="!flowIssue && !flowWarnings.length && !qList" class="scripts-flow-status is-ok">
            <el-icon><CircleCheckFilled /></el-icon>
            <span>{{ allClearText }}</span>
          </div>

          <!-- 成效：打開就先看到它有沒有在幫忙、沒走完的停在哪一題（`D-138`） -->
          <AdminScriptInsightCard
            v-if="selectedScript && !isCreating"
            :key="selectedScript.id"
            :script-id="selectedScript.id"
            :starts="selectedScript.stats?.starts ?? 0"
            :completions="selectedScript.stats?.completions ?? 0"
            :asks-questions="asksQuestions"
            :question-labels="questionLabels"
          />

          <!--
            `G-107`：沒有 scripts.write 的人（觀察者）以前每一格都改得動、底下卻沒有儲存鈕，切走還會跳「未儲存」。
            編輯區包進 el-form 用 disabled 當唯讀（同 AI 設定頁）；純動作的鈕另外用 v-if 拿掉。
            ⛔ 右邊「試試看」刻意不包：那是純預覽、不存任何東西，觀察者也該能用。
          -->
          <el-form :disabled="!canEditScripts" class="admin-panel-stack" @submit.prevent>
            <!-- ── 什麼時候開始（兩種編法共用）── -->
            <section
              v-if="triggerNode"
              class="message-card scripts-section-card"
              :class="{ 'is-focused': highlightStep === triggerNode.id }"
              :data-node-id="triggerNode.id"
            >
              <div class="message-card-header">
                <div class="card-header-main">
                  <span class="section-title">什麼時候開始</span>
                </div>
              </div>
              <div class="card-section-stack">
                <!-- scr-trigger-mode：導覽用這一格當「編輯器已經開著」的判斷，開著就不再幫他點「新增」 -->
                <div class="admin-field-group" data-tour="scr-trigger-mode">
                  <el-radio-group :model-value="triggerUiMode(triggerNode)" class="scripts-trigger-modes" @change="setTriggerMode(triggerNode, $event)">
                    <el-radio-button value="semantic">客人在問這類事（AI 判斷）</el-radio-button>
                    <el-radio-button value="keyword">客人打特定的字</el-radio-button>
                    <el-radio-button value="follow">客人加好友時</el-radio-button>
                  </el-radio-group>
                </div>

                <template v-if="triggerUiMode(triggerNode) === 'follow'">
                  <p class="scripts-section-hint">
                    客人把這個官方帳號加為好友（含封鎖後再解除）的那一刻就會走這一條，不用打任何字。一個帳號只能有一條這樣設定的。
                  </p>
                  <!-- 與 LINE 內建歡迎訊息打對台：兩邊都開＝客人一加好友連收兩份 -->
                  <el-alert
                    type="info"
                    :closable="false"
                    show-icon
                    title="LINE 內建的「加入好友的歡迎訊息」記得關掉"
                    description="LINE 官方帳號後台（LINE Official Account Manager）本身也有一則內建的歡迎訊息，兩邊都開的話，客人一加好友會連收兩份。請到那個後台把「加入好友的歡迎訊息」關閉，只留這一條。"
                  />
                </template>

                <template v-else-if="triggerUiMode(triggerNode) === 'semantic'">
                  <div class="admin-field-group" data-tour="scr-meaning">
                    <AdminFieldLabel text="客人會這樣講（一行一句）" tight />
                    <el-input
                      :model-value="(triggerNode.examples ?? []).join('\n')"
                      type="textarea"
                      :rows="3"
                      placeholder="例：&#10;我想查訂單&#10;我的訂單到哪了"
                      @update:model-value="updateExamples(triggerNode, $event)"
                    />
                    <p class="scripts-section-hint">意思相近 AI 就會接，不用列出所有講法；3～5 句不同說法就夠（最多 {{ MAX_TRIGGER_EXAMPLES }} 句）。</p>
                  </div>
                  <!--
                    `C-370`（老闆「走長遠」）：「看意思」的只看這兩格，不再有「含這些字就直接接」——
                    那份字清單只會越加越亂、加錯沒人發現（MYFEEL「查詢訂單」藏著「訂單」，「保留訂單」被接走）。
                    要「打這個字就回」的，用另一種開始方式「客人打特定的字」。
                  -->
                  <div v-if="excludesOpen(triggerNode)" class="admin-field-group">
                    <AdminFieldLabel text="這些交給 AI 回答，不要接（一行一句）" tight />
                    <el-input
                      :model-value="(triggerNode.excludes ?? []).join('\n')"
                      type="textarea"
                      :rows="2"
                      placeholder="例：&#10;什麼時候出貨&#10;何時會收到貨"
                      @update:model-value="updateExcludes(triggerNode, $event)"
                    />
                    <p class="scripts-section-hint">意思一樣的不走這一條、交給 AI 回答。</p>
                  </div>
                  <button v-else-if="canEditScripts" type="button" class="scripts-skip-add" @click="openExcludes">
                    ＋ 有些講法不要接（交給 AI 回答）
                  </button>
                </template>

                <template v-else>
                  <div class="admin-field-group" data-tour="scr-match">
                    <AdminFieldLabel text="怎麼比對" tight />
                    <el-select :model-value="triggerNode.keywordMatch ?? 'any'" class="control-full" @change="triggerNode.keywordMatch = $event">
                      <el-option v-for="m in KEYWORD_MATCH_OPTIONS" :key="m.value" :label="m.label" :value="m.value" />
                    </el-select>
                    <!-- 這種設定排在 AI 前面，開著等於把 AI 整個關掉 -->
                    <el-alert
                      v-if="triggerNode.keywordMatch === 'anyText'"
                      type="warning"
                      :closable="false"
                      show-icon
                      title="這條啟用後，會攔截「所有」文字訊息"
                      description="客人不管打什麼都會走進這一條，AI 客服和其他自動回應都收不到訊息、完全失效，而且不會有任何錯誤提示。除非你是刻意要暫停 AI，否則建議改用「含任一關鍵字」。"
                    />
                  </div>
                  <div v-if="triggerNode.keywordMatch !== 'anyText'" class="admin-field-group">
                    <AdminFieldLabel text="關鍵字" tight />
                    <el-input
                      :model-value="triggerNode.keywords.join('，')"
                      :placeholder="keywordPlaceholder(triggerNode)"
                      @update:model-value="updateKeywords(triggerNode, $event)"
                    />
                    <p class="scripts-section-hint">只看字、不經過 AI：沒打到這幾個字的不會走這一條。</p>
                    <!--
                      打字當下就講（D-33 P1）：太短或太常見的關鍵字會攔到一大堆不相關的訊息
                      （`C-25` 那場「觸發詞劫持」就是人手設的）。⛔只提醒不阻擋——既有設定可能刻意這樣設。
                    -->
                    <el-alert
                      v-if="riskyKeywordsOf(triggerNode).length"
                      type="warning"
                      :closable="false"
                      show-icon
                      :title="`「${riskyKeywordsOf(triggerNode).join('、')}」太常見了，會攔到很多不相關的訊息`"
                      description="關鍵字是「訊息裡有這幾個字就攔走」，例如設「問題」，客人打「我的訂單有問題」也會被這一條接走、AI 就答不到了。建議改成這一條專屬的具體詞（兩個字以上）。"
                    />
                  </div>
                </template>

                <!-- 防重複觸發（＝自動回覆的冷卻）。多數用不到，沒設時只留一顆鈕 -->
                <div v-if="triggerNode.cooldownMs !== undefined" class="admin-field-group">
                  <AdminFieldLabel text="防重複觸發（選填）" tight />
                  <div class="scripts-branch-case scripts-branch-case--route">
                    <span class="text-xs text-muted">間隔</span>
                    <el-select :model-value="triggerNode.cooldownMs" class="scripts-branch-field" @change="triggerNode.cooldownMs = $event">
                      <el-option v-for="o in COOLDOWN_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
                    </el-select>
                    <span class="text-xs text-muted">內不再接</span>
                    <span />
                    <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" title="取消防重複觸發" @click="clearCooldown(triggerNode)">✕</el-button>
                  </div>
                  <p class="scripts-section-hint">
                    {{ triggerUiMode(triggerNode) === 'follow'
                      ? '同一位客人在這段時間內封鎖又解除、再次加好友，也不會再收到一次。'
                      : '同一位客人在這段時間內又說了一次，也不會再走一次這一條（會改由 AI 回答）。' }}
                  </p>
                </div>
                <button v-else-if="canEditScripts" type="button" class="scripts-skip-add" @click="enableCooldown(triggerNode)">
                  ＋ 設定防重複觸發（同一位客人隔多久才能再走一次）
                </button>
              </div>
            </section>

            <!-- ── 照順序問的：問答清單（`D-138`④）── -->
            <template v-if="qList">
              <section class="message-card scripts-section-card" data-tour="scr-questions">
                <div class="message-card-header">
                  <div class="card-header-main">
                    <span class="section-title">先問客人（照順序）</span>
                  </div>
                </div>
                <div class="card-section-stack">
                  <p v-if="!qList.items.length" class="scripts-section-hint">不用問，客人一說就直接回「最後」那一段。</p>
                  <div
                    v-for="(item, i) in qList.items"
                    :key="item.id"
                    class="scripts-q"
                    :class="{ 'is-focused': highlightStep === item.id }"
                    :data-node-id="item.id"
                  >
                    <div class="scripts-q__head">
                      <span class="scripts-q__num">{{ i + 1 }}</span>
                      <template v-if="item.type === 'collect'">
                        <el-select :model-value="presetKeyOf(item)" placeholder="這一題問的是…" class="scripts-q__field" @change="applyFieldPreset(item, $event)">
                          <el-option v-for="p in COMMON_COLLECT_FIELDS" :key="p.key" :label="p.label" :value="p.key" />
                          <el-option label="其他（自己命名）" value="__custom" />
                        </el-select>
                        <el-input
                          v-if="presetKeyOf(item) === '__custom'"
                          v-model="item.fieldName"
                          placeholder="這一題叫什麼，例：退貨原因"
                          class="scripts-q__field"
                          @focus="fieldRenameFrom = item.fieldName"
                          @change="renameCollectField(item, fieldRenameFrom)"
                        />
                        <el-select v-if="presetKeyOf(item) === '__custom'" :model-value="item.format ?? 'any'" class="scripts-q__format" @change="item.format = $event">
                          <el-option v-for="f in COLLECT_FORMAT_OPTIONS" :key="f.value" :label="f.label" :value="f.value" />
                        </el-select>
                      </template>
                      <b v-else class="scripts-q__kind">給客人按鈕選</b>
                      <el-button v-if="canEditScripts" text type="danger" class="scripts-q__remove" @click="removeListItem(item.id)">移除</el-button>
                    </div>
                    <VariableTextField
                      v-model="item.question"
                      mode="script"
                      :known-keys="scriptVariableKeys"
                      :placeholder="item.type === 'collect' ? '例：請問您的訂單編號是？' : '例：請問需要哪項服務？'"
                    />
                    <el-input v-if="item.type === 'collect' && item.format === 'custom'" v-model="item.pattern" placeholder="進階比對規則，例：[A-Za-z]\d{3,}（訂單編號 A123）" />

                    <div v-if="item.type === 'collect'" class="scripts-q__routes">
                      <div class="scripts-q__route">
                        <span class="scripts-q__route-label">答了 →</span>
                        <el-select :model-value="item.next" class="scripts-q__target" @change="item.next = $event">
                          <el-option v-for="t in listTargets(item.id, i)" :key="t.value" :label="t.label" :value="t.value" />
                        </el-select>
                        <span v-if="isCodeFormat(item)" class="scripts-q__note">傳截圖也算回答</span>
                      </div>
                      <div v-if="isSkipOpen(item)" class="scripts-q__route">
                        <span class="scripts-q__route-label">客人說沒有 →</span>
                        <el-input v-model="item.skipLabel" maxlength="20" placeholder="按鈕字，例：我沒有訂單編號" class="scripts-q__button-label" />
                        <el-select :model-value="item.skipNext ?? ''" placeholder="前往…" class="scripts-q__target" @change="item.skipNext = $event">
                          <el-option v-for="t in listTargets(item.id, i)" :key="t.value" :label="t.label" :value="t.value" />
                        </el-select>
                        <el-button v-if="canEditScripts" text type="danger" title="拿掉這條路" @click="clearCollectSkip(item)">✕</el-button>
                      </div>
                      <button
                        v-else-if="canEditScripts"
                        type="button"
                        class="scripts-skip-add"
                        :class="{ 'is-suggested': isStuckCollect(item) }"
                        @click="openCollectSkip(item)"
                      >
                        <template v-if="isStuckCollect(item)">
                          ⚠ 這種編號客人手上可能根本沒有，沒給路會被一直重問　<b>＋ 客人說沒有的話…</b>
                        </template>
                        <template v-else>＋ 客人可能沒有這個資料</template>
                      </button>
                    </div>
                    <div v-else class="scripts-q__routes">
                      <div v-for="(o, oi) in item.options" :key="oi" class="scripts-q__route">
                        <el-input v-model="o.label" maxlength="20" placeholder="按鈕字" class="scripts-q__button-label" />
                        <span class="scripts-q__route-label">→</span>
                        <el-select :model-value="o.next" class="scripts-q__target" @change="o.next = $event">
                          <el-option v-for="t in listTargets(item.id, i)" :key="t.value" :label="t.label" :value="t.value" />
                        </el-select>
                        <el-button v-if="canEditScripts" text type="danger" title="拿掉這顆按鈕" @click="removeQuickReplyOption(item, oi)">✕</el-button>
                      </div>
                      <div v-if="canEditScripts"><el-button size="small" plain @click="addQuickReplyOption(item, qList.endId)">＋ 新增按鈕</el-button></div>
                    </div>
                  </div>

                  <div v-if="canEditScripts" class="scripts-q__add" data-tour="scr-grow">
                    <el-button plain @click="addListQuestion('collect')">＋ 再問一題</el-button>
                    <el-button plain @click="addListQuestion('quickReply')">＋ 給客人按鈕選</el-button>
                    <button type="button" class="scripts-inline-toggle" data-tour="scr-advanced" @click="switchToFlow">依答案走不同路…</button>
                  </div>
                </div>
              </section>

              <!-- ── 最後 ── -->
              <section
                class="message-card scripts-section-card"
                :class="{ 'is-focused': highlightStep === qList.terminal.id }"
                :data-node-id="qList.terminal.id"
              >
                <div class="message-card-header">
                  <div class="card-header-main">
                    <span class="section-title">最後</span>
                  </div>
                </div>
                <div class="card-section-stack">
                  <template v-if="listReply">
                    <div class="admin-field-group" data-tour="scr-reply">
                      <AdminFieldLabel text="回客人" tight />
                      <VariableTextField
                        v-model="listReply.text"
                        type="textarea"
                        mode="script"
                        :known-keys="scriptVariableKeys"
                        :rows="3"
                        placeholder="例：已收到您的資訊，我們會盡快為您處理 🙇"
                      />
                      <el-dropdown v-if="canEditScripts" size="small" trigger="click" class="scripts-var-insert" @command="insertListReplyVar">
                        <el-button size="small" plain>＋ 插入客人資料 ▾</el-button>
                        <template #dropdown>
                          <el-dropdown-menu>
                            <el-dropdown-item v-for="f in BUILTIN_SCRIPT_VARIABLES" :key="f.key" :command="f.key">
                              <span class="flow-var-inset__item">
                                <span class="flow-var-inset__item-label">{{ f.key === 'displayName' ? DISPLAY_NAME_VARIABLE_OPTION.label : f.label }}</span>
                                <span v-if="f.key === 'displayName'" class="flow-var-inset__item-hint">{{ DISPLAY_NAME_VARIABLE_OPTION.hint }}</span>
                              </span>
                            </el-dropdown-item>
                            <el-dropdown-item v-for="(f, fi) in collectFieldOptions" :key="f.value" :command="f.value" :divided="fi === 0">
                              <span class="flow-var-inset__item">
                                <span class="flow-var-inset__item-label">{{ f.label }}</span>
                                <span class="flow-var-inset__item-hint">客人回答的</span>
                              </span>
                            </el-dropdown-item>
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </div>
                    <div v-if="listReply.linkUrl !== undefined" class="admin-field-group">
                      <AdminFieldLabel text="附一顆連結按鈕（選填）" tight />
                      <div class="scripts-branch-case scripts-branch-case--map">
                        <span class="text-xs text-muted">網址</span>
                        <el-input v-model="listReply.linkUrl" placeholder="https://…（可插入客人回答的）" class="scripts-branch-field" />
                        <span class="text-xs text-muted">按鈕字</span>
                        <el-input v-model="listReply.linkLabel" maxlength="20" :placeholder="DEFAULT_REPLY_LINK_LABEL" class="scripts-branch-field" />
                        <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" title="移除連結按鈕" @click="clearReplyLink(listReply)">✕</el-button>
                      </div>
                      <p class="scripts-section-hint">會在回覆下面多送一則帶按鈕的訊息。網址要以 https:// 開頭。</p>
                    </div>
                    <el-checkbox v-model="listReply.thenHandoff">回完交給真人</el-checkbox>
                    <p v-if="listReply.thenHandoff" class="scripts-section-hint">下班時間會在同一則補上幾點起回覆，不會另外再送一則。</p>
                  </template>
                  <div v-else-if="listModule" class="admin-field-group">
                    <AdminFieldLabel text="送出哪個模組" tight />
                    <div v-if="modulesLoading" class="text-xs text-muted">載入中…</div>
                    <AdminFlowPicker v-else :model-value="listModule.moduleId" :options="moduleOptions" placeholder="選擇模組（可打字搜尋）" @update:model-value="listModule.moduleId = $event" />
                    <p class="scripts-section-hint">送出你在「機器人模組」做好的那一組訊息。若那是「真人客服」模組，會照常轉真人。</p>
                  </div>

                  <div v-if="listFields.length" class="admin-field-group">
                    <AdminFieldLabel text="存進客人資料（後台客人資料看得到，之後回覆也能帶入）" tight />
                    <el-checkbox-group :model-value="savedFields" @change="setSavedFields">
                      <el-checkbox v-for="f in listFields" :key="f.value" :value="f.value">{{ f.label }}</el-checkbox>
                    </el-checkbox-group>
                  </div>

                  <div v-if="qList.tag" class="admin-field-group">
                    <AdminFieldLabel text="替客人貼上標籤" tight />
                    <div class="scripts-q__route">
                      <AdminTagPicker
                        :model-value="qList.tag.addTagIds"
                        :options="tagList"
                        placeholder="選擇標籤（可多選、可打字搜尋）"
                        class="scripts-q__tags"
                        @update:model-value="setListTags"
                      />
                      <el-button v-if="canEditScripts" text type="danger" title="不貼標籤了" @click="removeListTag">✕</el-button>
                    </div>
                  </div>

                  <div v-if="canEditScripts" class="scripts-q__add">
                    <button v-if="listReply && listReply.linkUrl === undefined" type="button" class="scripts-skip-add" @click="listReply.linkUrl = ''">＋ 附一顆連結按鈕</button>
                    <button v-if="!qList.tag" type="button" class="scripts-skip-add" @click="addListTag">＋ 貼標籤</button>
                    <button type="button" class="scripts-skip-add" @click="toggleTerminalKind">{{ listReply ? '＋ 改送一個模組' : '改回一段文字' }}</button>
                  </div>
                </div>
              </section>
            </template>

            <!-- ── 有依答案分路、好幾個結尾的：流程圖編法（跟以前一樣）── -->
            <section v-else class="message-card scripts-section-card">
              <div class="message-card-header">
                <div class="card-header-main">
                  <span class="section-title">流程步驟</span>
                  <span class="text-xs text-muted">有依答案分路或好幾個結尾，用流程圖編</span>
                </div>
              </div>
              <div class="card-section-stack">
          <!-- 流程圖：即時把整條流程畫出來，分支往內縮一層、一眼看懂走向。 -->
          <div v-if="flowRows.length" class="scripts-flow-map">
            <div class="scripts-flow-map-head">
              <span class="scripts-flow-map-title">流程圖</span>
              <span class="text-xs text-muted">即時預覽・點步驟可跳到下面編輯</span>
            </div>
            <div class="scripts-flow-rows">
              <div
                v-for="row in flowRows"
                :key="row.key"
                class="scripts-flow-row"
                :class="[`scripts-flow-row--${row.kind}`, { 'is-indented': row.depth > 0 }]"
                :style="row.depth ? { marginInlineStart: `${row.depth * 22}px` } : undefined"
              >
                <span
                  v-if="row.kind === 'node'"
                  class="scripts-flow-box is-clickable"
                  :class="[nodeBadgeClass(row.type ?? 'reply'), { 'is-flagged': flaggedNodeIds.has(row.id ?? '') }]"
                  role="button"
                  tabindex="0"
                  @click="focusStep(row.id)"
                  @keydown.enter="focusStep(row.id)"
                >
                  <el-icon><component :is="nodeIcon(row.type ?? 'reply')" /></el-icon>
                  <b>{{ row.title }}</b>
                  <span v-if="row.sub" class="scripts-flow-sub">{{ row.sub }}</span>
                  <!-- 有問題的步驟標一顆黃點，跟上面那條狀態列同一套訊號（走不完、代號撞名…） -->
                  <span v-if="flaggedNodeIds.has(row.id ?? '')" class="scripts-flow-flag" title="這一步有要處理的問題，看上面的提醒">⚠</span>
                </span>
                <span v-else-if="row.kind === 'label'" class="scripts-flow-label">{{ row.title }}</span>
                <span v-else class="scripts-flow-note">{{ row.title }}</span>
              </div>
            </div>
          </div>

            <!-- 開始那一步在上面「什麼時候開始」編，這裡只列後面的步驟 -->
            <div class="scripts-node-list">
              <div v-for="node in flowNodes" :key="node.id" class="scripts-node-card" :class="{ 'is-focused': highlightStep === node.id }" :data-node-id="node.id">
                <div class="scripts-node-header">
                  <span class="scripts-node-badge" :class="nodeBadgeClass(node.type)">
                    <el-icon><component :is="nodeIcon(node.type)" /></el-icon> {{ nodeTypeLabel(node.type) }}
                  </span>
                  <span v-if="nodeHeaderHint(node)" class="text-xs text-muted">{{ nodeHeaderHint(node) }}</span>
                  <el-button
                    v-if="canEditScripts"
                    size="small"
                    type="danger"
                    plain
                    class="scripts-node-delete"
                    @click="removeNode(node.id)"
                  >
                    移除
                  </el-button>
                </div>
                <p class="scripts-node-purpose">{{ nodePurpose(node.type) }}</p>

                <!-- Collect -->
                <template v-if="node.type === 'collect'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="問題（要問使用者的話）" tight />
                    <!-- `D-128`：問句裡的 {{displayName}} 也會換（renderScriptTemplate），顯示成膠囊 -->
                    <VariableTextField v-model="node.question" mode="script" :known-keys="scriptVariableKeys" placeholder="例：請輸入您的訂單編號" />
                  </div>
                  <!-- 這一題問的是什麼：選常用欄位就自動帶好問句、格式與代號，
                       不用開店的人自己想出 order_id 這種 snake_case 識別字 -->
                  <div class="admin-field-group">
                    <AdminFieldLabel text="這一題問的是" tight />
                    <el-select :model-value="presetKeyOf(node)" placeholder="選一個" class="control-full" @change="applyFieldPreset(node, $event)">
                      <el-option v-for="p in COMMON_COLLECT_FIELDS" :key="p.key" :label="p.label" :value="p.key" />
                      <el-option label="其他（自己命名）" value="__custom" />
                    </el-select>
                    <el-input
                      v-if="presetKeyOf(node) === '__custom'"
                      v-model="node.fieldName"
                      placeholder="給這個答案取個代號，例：order_id"
                      @focus="fieldRenameFrom = node.fieldName"
                      @change="renameCollectField(node, fieldRenameFrom)"
                    />
                    <p v-if="node.fieldName.trim()" class="scripts-section-hint">💡 之後在「回覆」步驟按「＋ 插入客人資料」選 <b>{{ node.fieldName }}</b>，就會帶入客人的答案</p>
                  </div>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="答案格式（系統會自動從客人訊息抓出答案；格式不對會再問一次）" tight />
                    <el-select :model-value="node.format ?? 'any'" size="small" @change="node.format = $event">
                      <el-option label="不限制（整句存）" value="any" />
                      <el-option label="電話" value="phone" />
                      <el-option label="Email" value="email" />
                      <el-option label="純數字" value="number" />
                      <el-option label="英文＋數字（例：A123456）" value="alphanumeric" />
                      <el-option label="英文＋數字＋符號（例：OD-2024/001）" value="alphanumericSymbol" />
                      <el-option label="自訂（進階比對規則）" value="custom" />
                    </el-select>
                  </div>
                  <div v-if="node.format === 'custom'" class="admin-field-group">
                    <AdminFieldLabel text="自訂格式（進階比對規則，需懂正規表達式；不確定可先用上面的預設格式）" tight>
                      自訂格式（進階比對規則）
                      <!-- 標籤自己寫著「需懂正規表達式」＝已經承認是術語，那就得給出口（D-33 P1） -->
                      <AdminFieldHelp id="scriptCustomFormat" />
                    </AdminFieldLabel>
                    <el-input v-model="node.pattern" placeholder="例：[A-Za-z]\d{3,}（訂單編號 A123）" />
                  </div>
                  <div v-if="(node.format ?? 'any') !== 'any'" class="admin-field-group">
                    <AdminFieldLabel text="格式不符時的重問話術（可留空用預設）" tight />
                    <el-input v-model="node.reaskText" placeholder="例：訂單編號好像怪怪的，可以再確認一次嗎？" />
                  </div>
                  <!--
                    答不出來的退路：八成的收集步驟用不到，所以沒設定時只留一顆按鈕，不永遠佔一整塊。
                    問代碼類資料（訂單編號、序號…）又沒設時，按鈕改成帶語氣的建議——判斷用 findStuckCollects，
                    跟小幫手異常中心同一支函式，不會出現「這裡說沒事、那裡報警」的兩套標準。
                  -->
                  <div v-if="isSkipOpen(node)" class="admin-field-group">
                    <AdminFieldLabel text="答不出來的退路（選填）" tight />
                    <div class="scripts-branch-case scripts-branch-case--route">
                      <span class="text-xs text-muted">按鈕</span>
                      <el-input v-model="node.skipLabel" maxlength="20" placeholder="例：我沒有訂單編號" class="scripts-branch-field" />
                      <span class="text-xs text-muted scripts-branch-arrow">→</span>
                      <el-select :model-value="node.skipNext ?? ''" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, node.skipNext ?? '', (id) => node.skipNext = id)">
                        <el-option v-for="t in targetOptions(node.id)" :key="t.value" :label="t.label" :value="t.value" />
                        <el-option-group label="接下一步（會新增一個步驟）">
                          <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                        </el-option-group>
                      </el-select>
                      <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" title="移除這條退路" @click="clearCollectSkip(node)">✕</el-button>
                    </div>
                    <p class="scripts-section-hint">
                      問這一題時會多這顆按鈕，點了就改走你指定的那一步。
                      想給客人「好幾個」選擇？把「前往」指到一個<b>快速回覆</b>步驟，按鈕要幾顆都行。
                    </p>
                  </div>
                  <button
                    v-else-if="canEditScripts"
                    type="button"
                    class="scripts-skip-add"
                    :class="{ 'is-suggested': isStuckCollect(node) }"
                    @click="openCollectSkip(node)"
                  >
                    <template v-if="isStuckCollect(node)">
                      ⚠ 這種編號客人手上可能根本沒有，沒退路會被一直重問　<b>＋ 加一條退路</b>
                    </template>
                    <template v-else>
                      ＋ 加一條退路（客人答不出來時）
                    </template>
                  </button>
                </template>

                <!-- Reply -->
                <template v-else-if="node.type === 'reply'">
                  <div class="admin-field-group" data-tour="scr-reply">
                    <AdminFieldLabel text="回覆文字（可插入客人資料）" tight />
                    <!-- `D-128`：{{displayName}}、{{收集欄位}} 顯示成膠囊；自動回應的欄位名可以是中文（mode="script"） -->
                    <VariableTextField
                      v-model="node.text"
                      type="textarea"
                      mode="script"
                      :known-keys="scriptVariableKeys"
                      :rows="3"
                      placeholder="例：已收到您的訂單，將盡快為您處理 🙇"
                    />
                    <!--
                      `D-23`D：⛔ 這顆選單以前 `v-if="collectFieldOptions.length"`——
                      **沒有收集步驟就整顆不出現**，於是「客人的名字」這個最常用、
                      而且不需要收集就有的變數，**沒有任何地方教得到**（加好友歡迎正是
                      沒有收集步驟的那種）。現在內建變數永遠在，選單也就永遠在。
                    -->
                    <el-dropdown
                      v-if="canEditScripts"
                      size="small"
                      trigger="click"
                      class="scripts-var-insert"
                      @command="(f) => insertReplyVar(node, f)"
                    >
                      <el-button size="small" plain>＋ 插入客人資料 ▾</el-button>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item
                            v-for="f in BUILTIN_SCRIPT_VARIABLES"
                            :key="f.key"
                            :command="f.key"
                          >
                            <span class="flow-var-inset__item">
                              <span class="flow-var-inset__item-label">{{ f.key === 'displayName' ? DISPLAY_NAME_VARIABLE_OPTION.label : f.label }}</span>
                              <span v-if="f.key === 'displayName'" class="flow-var-inset__item-hint">{{ DISPLAY_NAME_VARIABLE_OPTION.hint }}</span>
                            </span>
                          </el-dropdown-item>
                          <el-dropdown-item
                            v-for="(f, i) in collectFieldOptions"
                            :key="f.value"
                            :command="f.value"
                            :divided="i === 0"
                          >
                            <span class="flow-var-inset__item">
                              <span class="flow-var-inset__item-label">{{ f.value }}</span>
                              <span class="flow-var-inset__item-hint">這個流程收集到的答案</span>
                            </span>
                          </el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                    <p class="scripts-section-hint">
                      {{ BUILTIN_VARIABLE_HINT }}
                    </p>
                  </div>
                  <!-- 連結按鈕（＝自動回覆的「開啟網址」）。多數回覆用不到，沒設定時只留一顆鈕 -->
                  <div v-if="node.linkUrl !== undefined" class="admin-field-group">
                    <AdminFieldLabel text="附一顆連結按鈕（選填）" tight />
                    <div class="scripts-branch-case scripts-branch-case--map">
                      <span class="text-xs text-muted">網址</span>
                      <el-input v-model="node.linkUrl" placeholder="https://…（可用 {{ 欄位 }} 帶入答案）" class="scripts-branch-field" />
                      <span class="text-xs text-muted">按鈕字</span>
                      <el-input v-model="node.linkLabel" maxlength="20" :placeholder="DEFAULT_REPLY_LINK_LABEL" class="scripts-branch-field" />
                      <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" title="移除連結按鈕" @click="clearReplyLink(node)">✕</el-button>
                    </div>
                    <p class="scripts-section-hint">會在回覆文字下面多送一則帶按鈕的訊息。網址要以 https:// 開頭。</p>
                  </div>
                  <button v-else-if="canEditScripts" type="button" class="scripts-skip-add" @click="node.linkUrl = ''">
                    ＋ 附一顆連結按鈕
                  </button>

                  <div class="admin-field-group">
                    <AdminFieldLabel text="回覆後直接轉真人" tight />
                    <el-switch v-model="node.thenHandoff" active-text="開" inactive-text="關" />
                  </div>
                </template>

                <!-- Branch -->
                <template v-else-if="node.type === 'branch'">
                  <p class="scripts-section-hint">依照前面問到的答案決定接下來走哪條路。由上往下檢查，第一個符合的條件就走它。</p>
                  <div v-for="(c, ci) in node.cases" :key="ci" class="scripts-branch-case scripts-branch-case--cond">
                    <span class="text-xs text-muted">如果</span>
                    <el-select :model-value="c.field" filterable placeholder="選欄位" class="scripts-branch-field" @change="c.field = $event">
                      <el-option v-for="f in collectFieldOptions" :key="f.value" :label="f.label" :value="f.value" />
                    </el-select>
                    <el-select :model-value="c.op" class="scripts-branch-op" @change="setBranchOp(c, $event)">
                      <el-option label="有填寫" value="exists" />
                      <el-option label="等於" value="equals" />
                      <el-option label="包含" value="contains" />
                    </el-select>
                    <!-- 「有填寫」不需要比較值，但格子要留著：同一張卡裡幾條條件混用時，
                         欄數一變，後面的「→」和「前往」就會在各列之間左右錯開。 -->
                    <span class="scripts-branch-value">
                      <el-input v-if="c.op !== 'exists'" v-model="c.value" placeholder="比較值" />
                    </span>
                    <span class="text-xs text-muted scripts-branch-arrow">→</span>
                    <el-select :model-value="c.next" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, c.next, (id) => c.next = id)">
                      <el-option v-for="o in targetOptions(node.id)" :key="o.value" :label="o.label" :value="o.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                    <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" @click="removeBranchCase(node, ci)">✕</el-button>
                  </div>
                  <el-button v-if="canEditScripts" size="small" plain @click="addBranchCase(node)">＋ 新增條件</el-button>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="其餘情況（都不符合時）→ 前往" tight />
                    <el-select :model-value="node.defaultNext" placeholder="前往…" @change="onTargetChange($event, node.defaultNext, (id) => node.defaultNext = id)">
                      <el-option v-for="o in targetOptions(node.id)" :key="o.value" :label="o.label" :value="o.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                  </div>
                </template>

                <!-- Quick reply -->
                <template v-else-if="node.type === 'quickReply'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="問句（出選項時一起送）" tight />
                    <VariableTextField v-model="node.question" mode="script" :known-keys="scriptVariableKeys" placeholder="例：請問需要哪項服務？" />
                  </div>
                  <p class="scripts-section-hint">客人點按鈕即走對應路線（按鈕文字就是送出的文字）。</p>
                  <div v-for="(o, oi) in node.options" :key="oi" class="scripts-branch-case scripts-branch-case--route">
                    <span class="text-xs text-muted">按鈕</span>
                    <el-input v-model="o.label" placeholder="按鈕文字（≤20 字）" class="scripts-branch-field" />
                    <span class="text-xs text-muted scripts-branch-arrow">→</span>
                    <el-select :model-value="o.next" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, o.next, (id) => o.next = id)">
                      <el-option v-for="t in targetOptions(node.id)" :key="t.value" :label="t.label" :value="t.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                    <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" @click="removeQuickReplyOption(node, oi)">✕</el-button>
                  </div>
                  <el-button v-if="canEditScripts" size="small" plain @click="addQuickReplyOption(node)">＋ 新增選項</el-button>
                </template>

                <!-- Tag -->
                <template v-else-if="node.type === 'tag'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="替客人貼上標籤" tight />
                    <!-- C-208：共用選標籤欄位（「＋ 新標籤」＋空狀態出口，不必離開這條還沒存的流程） -->
                    <AdminTagPicker
                      :model-value="node.addTagIds"
                      :options="tagList"
                      placeholder="選擇標籤（可多選、可打字搜尋）"
                      @update:model-value="(ids) => (node.addTagIds = ids)"
                    />
                    <p class="scripts-section-hint">流程走到這裡就貼標，然後自動往下。</p>
                  </div>
                </template>

                <!-- Save lead -->
                <template v-else-if="node.type === 'saveLead'">
                  <p class="scripts-section-hint">把這次問到的答案長期存進這位客人的資料裡，之後在後台看得到，回覆文字也能帶入使用。</p>
                  <div v-for="(m, mi) in node.fieldMap" :key="mi" class="scripts-branch-case scripts-branch-case--map">
                    <span class="text-xs text-muted">收集欄位</span>
                    <el-select :model-value="m.fromField" filterable placeholder="選欄位" class="scripts-branch-field" @change="m.fromField = $event">
                      <el-option v-for="f in collectFieldOptions" :key="f.value" :label="f.label" :value="f.value" />
                    </el-select>
                    <span class="text-xs text-muted">存成</span>
                    <el-input v-model="m.attrKey" placeholder="如 訂單編號" class="scripts-branch-field" />
                    <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" @click="removeSaveLeadField(node, mi)">✕</el-button>
                  </div>
                  <el-button v-if="canEditScripts" size="small" plain @click="addSaveLeadField(node)">＋ 新增欄位</el-button>
                </template>

                <!-- Module：送出某個機器人模組的訊息，然後結束 -->
                <template v-else-if="node.type === 'module'">
                  <p class="scripts-section-hint">送出你在「機器人模組」做好的那一組訊息，然後結束流程。若那是「真人客服」模組，會照常轉真人。</p>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="要送出哪個模組" tight />
                    <div v-if="modulesLoading" class="text-xs text-muted">載入中…</div>
                    <!--
                      `D-86`：改用共用的 AdminFlowPicker。
                      ⚠️ 原本手刻的「還沒有機器人模組→去那一頁建」那段一併拿掉——
                         那顆元件自己的空狀態講得更完整，而且**當場就建得起來**，
                         不必離開這張還沒存的腳本表單。
                    -->
                    <AdminFlowPicker
                      v-else
                      :model-value="node.moduleId"
                      :options="moduleOptions"
                      placeholder="選擇模組（可打字搜尋）"
                      @update:model-value="node.moduleId = $event"
                    />
                  </div>
                </template>

                <!-- 下一步摘要：把自動接線/結束這種看不見的去向講出來（一步的設定沒有「下一步」可講） -->
                <p v-if="autoNextLabel(node)" class="scripts-next-hint" :class="{ 'is-unwired': isNodeUnwired(node) }">
                  ↳ 下一步：<strong>{{ autoNextLabel(node) }}</strong>
                </p>
              </div>
            </div>

            <!-- `scr-palette`：「多步驟接待」那支導覽用（`D-109`） -->
            <div v-if="canEditScripts" class="scripts-add-palette" data-tour="scr-palette">
              <div v-for="grp in nodePalette" :key="grp.group" class="scripts-add-group">
                <span class="scripts-add-group-title">{{ grp.group }}</span>
                <div class="scripts-add-cards">
                  <button
                    v-for="it in grp.items"
                    :key="it.type"
                    type="button"
                    class="scripts-add-card"
                    @click="addNode(it.type)"
                  >
                    <span class="scripts-add-card-icon" :class="nodeBadgeClass(it.type)">
                      <el-icon><component :is="nodeIcon(it.type)" /></el-icon>
                    </span>
                    <span class="scripts-add-card-text">
                      <b>＋ {{ it.name }}</b>
                      <small>{{ it.desc }}</small>
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <p v-if="canEditScripts" class="scripts-section-hint">
              一般步驟會由上到下自動接下去；只有「依答案分路」和「快速回覆」要自己用「前往…」下拉，指定每條路各接到哪一步。
            </p>
              </div>
            </section>
          </el-form>
        </div>

        <!-- 換一條（或新開一條）就整個重來：試到一半的對話不該帶到另一條去 -->
        <AdminScriptTryPanel
          :key="tryKey"
          class="scripts-side"
          :script-id="selectedId"
          :name="form.name"
          :enabled="form.enabled"
          :priority="form.priority"
          :nodes="form.nodes"
          :root-node-id="form.rootNodeId"
          :module-options="moduleOptions"
        />
      </div>
    </template>
  </AdminSplitLayout>

  <!-- `D-23`：還沒設過「客人加好友時」時，點那一列開的淺層設定（選模組或打一段字） -->
  <AdminFollowWelcomeSetup
    v-model:visible="followSetupVisible"
    :module-options="moduleOptions"
    @created="onFollowWelcomeCreated"
  />
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { ChatDotRound, CircleCheckFilled, CircleCloseFilled, Collection, Connection, CopyDocument, Delete, Notebook, Operation, Plus, Pointer, Position, PriceTag, Share, WarningFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { confirmSaveBeforeCopy } from '~/utils/confirm-save-before-copy'
import { v4 as uuidv4 } from 'uuid'
import {
  BUILTIN_SCRIPT_VARIABLES,
  BUILTIN_VARIABLE_HINT,
  FOLLOW_WELCOME_LABEL,
  followWelcomeRow,
} from '~~/shared/follow-welcome'
import { DISPLAY_NAME_VARIABLE_OPTION, SCRIPT_PRESET_FIELD_LABELS } from '~~/shared/variable-tokens'
import {
  appendQuestion,
  insertEndStep,
  removeEndStep,
  removeQuestion,
  replaceTerminal,
  toQuestionList,
  type QuestionItem,
} from '~~/shared/script-question-list'
import type {
  BranchOp,
  CollectFormat,
  ScriptBranchNode,
  ScriptCollectNode,
  ScriptDoc,
  ScriptNode,
  ScriptQuickReplyNode,
  ScriptReplyNode,
  ScriptModuleNode,
  ScriptSaveLeadNode,
  ScriptTagNode,
  ScriptTriggerNode,
  TriggerKeywordMatch,
  TriggerMatchMode,
} from '~~/shared/types/ai-script'
import { DEFAULT_COLLECT_EXPIRE_MS, DEFAULT_REPLY_LINK_LABEL, DEFAULT_SCRIPT_PRIORITY, MAX_TRIGGER_EXAMPLES, MAX_TRIGGER_EXCLUDES, SCRIPT_NODE_TYPE_LABELS, collectSkipLabel, findPlaceholderTexts, findStuckCollects, scriptTriggerEvent, validateScriptDoc } from '~~/shared/types/ai-script'
import type { ScriptForReachability } from '~~/shared/types/ai-script-reachability'
import { findUnreachableScripts } from '~~/shared/types/ai-script-reachability'
import { SCRIPT_TEMPLATES, type ScriptTemplate } from '~~/shared/types/ai-script-templates'
import { AUTO_REPLY_COOLDOWN_OPTIONS } from '~~/shared/auto-reply-rule'
import { riskyTriggerKeywords } from '~~/shared/script-trigger-keywords'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { workspaceId, apiFetch, can } = useWorkspace()
const canEditScripts = computed(() => can('scripts.write'))
const { showToast } = useAdminToast()


interface ScriptRow extends ScriptDoc { id: string }

const {
  items: scripts,
  loading,
  loadingMore,
  listEl,
  load: loadScripts,
  onScroll: onSidebarListScroll,
  loadUntilFound: findScriptUntilFound,
} = useWorkspaceSidebarList<ScriptRow>('/api/ai/scripts/list')
const { openFromQueryId } = useAdminDeepLink()

const saving = ref(false)
const duplicating = ref(false)
const selectedId = ref<string | null>(null)
const isCreating = ref(false)

/**
 * 「新增」底下那排範本（`D-138`④）：加好友歡迎有自己那張卡、找真人系統本來就認得（找真人／轉接專員…），
 * 這兩個不再列——找真人快速通道建出來只會跟內建的逃生門搶同一句話。
 */
const starterTemplates = SCRIPT_TEMPLATES.filter(t => t.key !== 'follow-welcome' && t.key !== 'to-human')

// 貼標節點用的工作區標籤清單
const { tags: tagList, loadTags } = useAdminTagList()
// C-208：一條流程可以有好幾個貼標節點，其中一個就地建了標籤，其他要跟著看得到
useAdminTagRefresh().onAdminTagListChanged(() => loadTags({ status: 'active' }))
// `D-86`：別處就地建了模組，這一頁的下拉要跟著看得到（否則人會以為沒建成功）
useAdminFlowRefresh().onAdminFlowListChanged(() => void loadModuleOptions())

// 機器人模組步驟用的模組清單（只在真的有 module 步驟時才需要，但清單很小、一次抓完最簡單）
const modulesLoading = ref(true)
/**
 * `D-86`：形狀從 `{value,label}` 改成跟全站一致的 `{id,name,…}`。
 * ⚠️ 順便把 `isActive`／`messageCount` 帶進來——共用的 AdminFlowPicker 靠它們才標得出
 * 「還沒有內容／已停用」。原本那份自己的轉換只有這一頁在用，留著就是同一件事兩種寫法。
 */
const moduleOptions = ref<Array<{ id: string; name: string; isActive?: boolean; messageCount?: number }>>([])
async function loadModuleOptions() {
  // 只取選單要的欄位：整份模組清單是 133 KB（含每則訊息內容），這裡只用到名稱、編號與幾則
  const list = await apiFetch<Array<Record<string, any>>>('/api/flow/list?fields=picker').catch(() => [])
  // moduleId 就是 flows 的文件 id（見 getFlowByModuleId），所以直接用 m.id
  moduleOptions.value = (Array.isArray(list) ? list : [])
    .map(m => ({
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? '(未命名模組)'),
      isActive: m.isActive,
      messageCount: m.messageCount,
    }))
    .filter(m => m.id)
  modulesLoading.value = false
}
// C-208：貼標節點改用共用的 AdminTagPicker（吃 {id,name,color} 原樣），
// 原本那份 {value,label} 的轉換沒有別人用，一併移除。

function defaultTriggerNode(nextId: string): ScriptTriggerNode {
  return { id: uuidv4(), type: 'trigger', matchMode: 'keyword', keywords: [], examples: [], priority: DEFAULT_SCRIPT_PRIORITY, next: nextId }
}
function defaultReplyNode(): ScriptReplyNode {
  return { id: uuidv4(), type: 'reply', text: '', thenHandoff: false }
}
function defaultCollectNode(nextId: string): ScriptCollectNode {
  return { id: uuidv4(), type: 'collect', question: '', fieldName: '', expireMs: DEFAULT_COLLECT_EXPIRE_MS, format: 'any', next: nextId }
}
function defaultBranchNode(defaultNext: string): ScriptBranchNode {
  return { id: uuidv4(), type: 'branch', cases: [], defaultNext }
}
function defaultQuickReplyNode(nextId: string): ScriptQuickReplyNode {
  return { id: uuidv4(), type: 'quickReply', question: '', expireMs: DEFAULT_COLLECT_EXPIRE_MS, options: [{ label: '', next: nextId }] }
}
function defaultTagNode(nextId: string): ScriptTagNode {
  return { id: uuidv4(), type: 'tag', addTagIds: [], next: nextId }
}
function defaultModuleNode(): ScriptModuleNode {
  // 與 reply 一樣是終點，沒有 next
  return { id: uuidv4(), type: 'module', moduleId: '' }
}
function defaultSaveLeadNode(nextId: string): ScriptSaveLeadNode {
  return { id: uuidv4(), type: 'saveLead', fieldMap: [{ fromField: '', attrKey: '' }], next: nextId }
}

function blankForm() {
  const trigger = defaultTriggerNode('')
  const reply = defaultReplyNode()
  trigger.next = reply.id
  return {
    name: '',
    enabled: true,
    priority: DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: trigger.id,
    nodes: [trigger, reply] as ScriptNode[],
  }
}

const form = ref(blankForm())
const { markClean, markDirty, confirmLeaveIfDirty, hasUnsavedChanges } = useUnsavedChanges({
  // `G-107`：存不了的人就沒有「未儲存的變更」——切走、關分頁都不要問他
  getSnapshot: () => (canEditScripts.value ? form.value : null),
  // 腳本節點流程可能編很久；F5 / 關分頁也要攔，避免整段遺失
  enableBeforeUnload: true,
})

const selectedScript = computed(() => scripts.value.find(s => s.id === selectedId.value) ?? null)

/** 開始那一步（「什麼時候開始」那一段編它） */
const triggerNode = computed(() => {
  const t = form.value.nodes.find(n => n.id === form.value.rootNodeId)
  return t?.type === 'trigger' ? t : null
})

/**
 * 兩種編法（`D-138`④）：照順序問的用**問答清單**（一題一列、不用接線），
 * 有「依答案分路」或好幾個結尾的用**流程圖**（跟以前一樣）。同一份資料、只是看法不同。
 *
 * ⛔ 編法在「打開一條」的那一刻決定、之後只跟著使用者的按鈕走（「依答案走不同路…」切到流程圖）——
 *    不從資料即時推導：在流程圖裡改一個「前往…」剛好變成能用清單看，整個畫面在他手底下翻掉
 *    （同 `presetKeyOf` 那次「打到一半輸入框消失」的教訓）。
 */
const editorMode = ref<'list' | 'flow'>('list')
function syncEditorMode() {
  editorMode.value = toQuestionList(form.value.nodes, form.value.rootNodeId) ? 'list' : 'flow'
}
/** 清單看法；流程圖模式、或改到清單看不懂時是 null（模板就退回流程圖編法，不會什麼都不畫） */
const qList = computed(() => (editorMode.value === 'list' ? toQuestionList(form.value.nodes, form.value.rootNodeId) : null))
const listReply = computed(() => (qList.value?.terminal.type === 'reply' ? qList.value.terminal : null))
const listModule = computed(() => (qList.value?.terminal.type === 'module' ? qList.value.terminal : null))

/** 流程圖編法裡列的步驟：開始那一步在上面「什麼時候開始」編 */
const flowNodes = computed(() => form.value.nodes.filter(n => n.type !== 'trigger'))

function switchToFlow() {
  editorMode.value = 'flow'
  nextTick(() => document.querySelector('[data-tour="scr-palette"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
}

/** 這一題的名字：常用欄位講中文（不露出 order_id），自己命名的照他取的名字 */
function fieldLabel(fieldName: string): string {
  return SCRIPT_PRESET_FIELD_LABELS[fieldName] ?? fieldName
}
function listItemLabel(item: QuestionItem): string {
  if (item.type === 'collect') return fieldLabel(item.fieldName) || item.question.slice(0, 12) || '（還沒選）'
  return `給按鈕選「${item.question.slice(0, 8) || '…'}」`
}

/** 「答了 →」「客人說沒有 →」「按鈕 →」可以去哪：別一題，或直接到最後 */
function listTargets(selfId: string, index: number): Array<{ value: string; label: string }> {
  const view = qList.value
  if (!view) return []
  const out = view.items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.id !== selfId)
    .map(({ it, i }) => ({ value: it.id, label: `第 ${i + 1} 題・${listItemLabel(it)}${i === index + 1 ? '（下一題）' : ''}` }))
  out.push({ value: view.endId, label: '直接到最後' })
  return out
}

/** 客人可能拿截圖回答的那種（編號、序號）：旁邊講一句「傳截圖也算回答」（`D-138`②） */
function isCodeFormat(item: ScriptCollectNode): boolean {
  return ['alphanumeric', 'alphanumericSymbol', 'number', 'custom'].includes(item.format ?? 'any')
}

/** 答案格式（自己命名的那題才給選；常用欄位挑了就帶好） */
const COLLECT_FORMAT_OPTIONS: Array<{ value: CollectFormat; label: string }> = [
  { value: 'any', label: '不限制（整句存）' },
  { value: 'phone', label: '電話' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: '純數字' },
  { value: 'alphanumeric', label: '英文＋數字（例：A123456）' },
  { value: 'alphanumericSymbol', label: '英文＋數字＋符號（例：OD-2024/001）' },
  { value: 'custom', label: '自訂（進階比對規則）' },
]

function addListQuestion(kind: 'collect' | 'quickReply') {
  const view = qList.value
  if (!view) return
  const item = kind === 'collect' ? defaultCollectNode('') : defaultQuickReplyNode('')
  appendQuestion(form.value.nodes, view, item)
  focusStep(item.id)
}

function removeListItem(itemId: string) {
  const view = qList.value
  if (!view) return
  removeQuestion(form.value.nodes, view, itemId)
}

/** 有哪幾題可以存進客人資料（有名字的「問一題」） */
const listFields = computed(() =>
  (qList.value?.items ?? [])
    .filter((it): it is ScriptCollectNode => it.type === 'collect' && Boolean(it.fieldName.trim()))
    .map(it => ({ value: it.fieldName, label: fieldLabel(it.fieldName) })),
)
const savedFields = computed(() => (qList.value?.saveLead?.fieldMap ?? []).map(m => m.fromField).filter(Boolean))

/**
 * 勾選要存的題目 ↔「存進客人資料」那一步：勾第一個時掛上去、全部取消就拿掉。
 * 已經存在的對應保留原本的名字（MYFEEL 的「訂單編號」「電話」），新勾的用這一題的中文名。
 */
function setSavedFields(values: Array<string | number | boolean>) {
  const view = qList.value
  if (!view) return
  const picked = values.map(String)
  if (!view.saveLead) {
    if (!picked.length) return
    const node = defaultSaveLeadNode('')
    node.fieldMap = picked.map(f => ({ fromField: f, attrKey: fieldLabel(f) }))
    insertEndStep(form.value.nodes, view, node)
    return
  }
  const kept = view.saveLead.fieldMap.filter(m => picked.includes(m.fromField))
  const added = picked.filter(f => !kept.some(m => m.fromField === f)).map(f => ({ fromField: f, attrKey: fieldLabel(f) }))
  const next = [...kept, ...added]
  if (next.length) view.saveLead.fieldMap = next
  else removeEndStep(form.value.nodes, view.saveLead.id)
}

function addListTag() {
  const view = qList.value
  if (view && !view.tag) insertEndStep(form.value.nodes, view, defaultTagNode(''))
}
function removeListTag() {
  const tag = qList.value?.tag
  if (tag) removeEndStep(form.value.nodes, tag.id)
}
function setListTags(ids: string[]) {
  const tag = qList.value?.tag
  if (tag) tag.addTagIds = ids
}

/** 結尾換成送一個模組／改回一段文字。回覆已經寫了字的先問一聲（換過去那段字就沒了） */
async function toggleTerminalKind() {
  const view = qList.value
  if (!view) return
  if (view.terminal.type === 'reply') {
    if (view.terminal.text.trim()) {
      const ok = await ElMessageBox.confirm('改送一個模組的話，「回客人」那段字會清掉。', '改送模組', { confirmButtonText: '改送模組', cancelButtonText: '先不要', type: 'warning' })
        .then(() => true).catch(() => false)
      if (!ok) return
    }
    replaceTerminal(form.value.nodes, view, defaultModuleNode())
  }
  else {
    replaceTerminal(form.value.nodes, view, defaultReplyNode())
  }
}

function insertListReplyVar(field: string) {
  if (listReply.value) insertReplyVar(listReply.value, field)
}

/** 這條有沒有要客人回答的題目（成效卡：一句話回一件事的只講次數） */
const asksQuestions = computed(() => form.value.nodes.some(n => n.type === 'collect' || n.type === 'quickReply'))
/** 成效卡每一列的題名：清單編法照順序編號，流程圖編法照節點順序 */
const questionLabels = computed(() => {
  const items = qList.value?.items ?? form.value.nodes.filter((n): n is QuestionItem => n.type === 'collect' || n.type === 'quickReply')
  return items.map((it, i) => ({ nodeId: it.id, label: qList.value ? `${i + 1}　${listItemLabel(it)}` : listItemLabel(it) }))
})

/** 「看意思」的「不要接」：有資料就攤開，沒有的話按了才出現 */
const openedExcludes = ref(false)
function excludesOpen(node: ScriptTriggerNode) {
  return openedExcludes.value || (node.excludes ?? []).length > 0
}
function openExcludes() { openedExcludes.value = true }

function updateExcludes(node: ScriptTriggerNode, value: string) {
  const list = String(value || '').split(/\n+/g).map(e => e.trim()).filter(Boolean).slice(0, MAX_TRIGGER_EXCLUDES)
  if (list.length) node.excludes = list
  else delete node.excludes
}

/** 名稱沒填就用這個（`D-138`④）：客人會講的第一句／第一個字 */
function autoName(): string {
  const t = triggerNode.value
  if (!t) return ''
  if (t.triggerEvent === 'follow') return '客人加好友時'
  if ((t.matchMode ?? 'keyword') === 'semantic') return (t.examples?.[0] || '').slice(0, 30)
  if (t.keywordMatch === 'anyText') return '客人輸入任何內容'
  return (t.keywords?.[0] || '').slice(0, 30)
}
const namePlaceholder = computed(() => `例：${autoName() || '訂單查詢、退換貨'}`)

/** 右邊「試試看」換一條就整個重來（新開的每一條也算新的一條） */
const createSeq = ref(0)
const tryKey = computed(() => selectedId.value ?? `new-${createSeq.value}`)

/** 關鍵字比對方式；文案與自動回覆的「比對方式」對齊，兩邊講的是同一件事 */
const KEYWORD_MATCH_OPTIONS: Array<{ value: TriggerKeywordMatch; label: string }> = [
  { value: 'any', label: '含任一關鍵字' },
  { value: 'all', label: '含全部關鍵字' },
  { value: 'exact', label: '內容完全一致' },
  { value: 'anyText', label: '客人輸入任何內容' },
]

/** 防重複觸發的間隔選項；與自動回覆共用同一份，兩邊講的是同一件事 */
const COOLDOWN_OPTIONS = AUTO_REPLY_COOLDOWN_OPTIONS
const DEFAULT_COOLDOWN_MS = COOLDOWN_OPTIONS[0]?.value ?? 60_000

function enableCooldown(node: ScriptTriggerNode) {
  node.cooldownMs = DEFAULT_COOLDOWN_MS
}
function clearCooldown(node: ScriptTriggerNode) {
  delete node.cooldownMs
}

/**
 * 這個觸發填了哪幾個會惹禍的關鍵字（D-33 P1）。
 *
 * 名單與判斷來自 `shared/script-trigger-keywords`——跟 AI 生成端剔除用的是**同一份**，
 * ⛔別在這裡自己另寫一組詞，否則會出現「生成端剔掉、編輯器說沒事」的兩套標準。
 * 這裡只提醒不阻擋（既有腳本可能刻意這樣設）。
 */
function riskyKeywordsOf(node: ScriptTriggerNode): string[] {
  if ((node.keywordMatch ?? 'any') === 'anyText')
    return []
  // 「完全符合」是一字不差地比對整句，不會誤攔別的訊息，所以不用提醒
  if (node.keywordMatch === 'exact')
    return []
  return riskyTriggerKeywords(node.keywords ?? [])
}

function keywordPlaceholder(node: ScriptTriggerNode): string {
  const mode = node.keywordMatch ?? 'any'
  if (mode === 'all') return '例：訂單 取消（要全部出現才算命中）'
  if (mode === 'exact') return '例：查訂單（客人要一字不差地打這句）'
  return '例：退換貨，退費，要退（用逗號或空白分隔，任一命中即觸發）'
}

/**
 * 即時流程檢查：沿用「後端存檔時同一套」validateScriptDoc，設定當下就知道還差什麼、
 * 不用按了儲存才被擋。名稱用佔位符帶入 → 這條專講「流程結構」問題，腳本名稱由標題欄位與送出時把關。
 * 這一支只驗「接線合不合法」——走得完、輪不輪得到是另外兩件事（見 flowWarnings）。
 */
const flowIssue = computed(() =>
  validateScriptDoc({ name: form.value.name.trim() || '未命名流程', nodes: form.value.nodes, rootNodeId: form.value.rootNodeId }),
)

/**
 * 敏感情境詞會排在腳本之前攔截，所以要拿來一起判「這條腳本輪不輪得到」。
 * （原本還會比對自動回覆規則，那個功能 2026-08-09 已下架，順位收成單一條之後不再有那種蓋台。）
 */
const sensitiveTopics = ref<string[]>([])
const reachabilityState = ref<'loading' | 'ready' | 'failed'>('loading')

async function loadReachabilityContext() {
  try {
    const settings = await apiFetch<{ sensitiveTopics?: string[] }>('/api/ai/settings')
    sensitiveTopics.value = settings?.sensitiveTopics ?? []
    reachabilityState.value = 'ready'
  }
  catch {
    // 查不到就明講沒查到，不要靜靜當作「沒問題」
    reachabilityState.value = 'failed'
  }
}

/** 編輯中這條腳本「輪不輪得到」：把草稿和其他啟用中的腳本一起餵進去，只取草稿自己的問題 */
const DRAFT_SCRIPT_ID = '__draft__'
const reachabilityIssues = computed(() => {
  if (!form.value.enabled) return [] // 停用是刻意的，不是異常
  const draftId = selectedId.value ?? DRAFT_SCRIPT_ID
  const draft: ScriptForReachability = {
    id: draftId,
    name: form.value.name.trim() || '這條流程',
    nodes: form.value.nodes,
    rootNodeId: form.value.rootNodeId,
    enabled: true,
    priority: form.value.priority,
  }
  const others: ScriptForReachability[] = scripts.value
    .filter(s => s.id !== draftId && s.enabled)
    .map(s => ({ id: s.id, name: s.name, nodes: s.nodes ?? [], rootNodeId: s.rootNodeId, enabled: true, priority: s.priority }))
  return findUnreachableScripts([draft, ...others], { sensitiveTopics: sensitiveTopics.value })
    // noTrigger 交給 validateScriptDoc 講（「請為觸發步驟設定至少一個關鍵字」），不要同一件事講兩遍
    .filter(i => i.scriptId === draftId && i.reason !== 'noTrigger')
})

interface FlowWarning { key: string; text: string; nodeId?: string }

/**
 * 不擋存檔、但客人會踩到的風險（黃燈）。只驗接線的綠燈會保證一件它沒檢查過的事——
 * 正式站那條「查詢訂單」接線全對、狀態列亮綠燈，客人卻永遠走不出去。
 */
/** 問代碼類資料又沒給退路的步驟；退路建議鈕與狀態列共用同一份，不會各算各的 */
const stuckCollectIds = computed(() => new Set(findStuckCollects(form.value.nodes).map(s => s.nodeId)))

/**
 * 兩個收集步驟用同一個代號 → 答案存在同一格，後面那題會蓋掉前面那題
 * （collected 是一張以代號為鍵的表）。驗證器只拿代號做「有沒有這個欄位」的比對，
 * 不會發現重複，所以這裡要講出來。刻意不擋存檔：既有腳本可能已經是這樣，擋了會存不回去。
 */
const duplicateFieldWarnings = computed<FlowWarning[]>(() => {
  const seen = new Map<string, string>()
  const out: FlowWarning[] = []
  for (const n of form.value.nodes) {
    if (n.type !== 'collect') continue
    const name = n.fieldName.trim()
    if (!name) continue
    if (seen.has(name)) {
      out.push({
        key: `dup:${n.id}`,
        text: `有兩題都叫「${fieldLabel(name)}」，後面這題的答案會蓋掉前面那題，請把其中一題改成別的`,
        nodeId: n.id,
      })
    }
    else { seen.set(name, n.id) }
  }
  return out
})

const flowWarnings = computed<FlowWarning[]>(() => {
  const out: FlowWarning[] = []
  for (const s of findStuckCollects(form.value.nodes)) {
    const what = fieldLabel(s.fieldName) || s.question || '這一題'
    out.push({
      key: `stuck:${s.nodeId}`,
      text: `客人答不出「${what}」就出不去——這種編號他手上可能根本沒有，會被一直重問。建議加一條退路。`,
      nodeId: s.nodeId,
    })
  }
  // AI 生成草稿的「不編造事實」占位符：沒補完就存檔，客人會原封不動看到【請填入：…】
  for (const hit of findPlaceholderTexts(form.value.nodes)) {
    out.push({
      key: `placeholder:${hit.nodeId}`,
      text: `這一步的文案還留著「${hit.snippet}」——AI 不知道的資料不會亂編，請把真實內容填進去再存檔`,
      nodeId: hit.nodeId,
    })
  }
  out.push(...duplicateFieldWarnings.value)
  // 一個帳號只能有一條啟用中的「加好友時」腳本（後端存檔也會擋；這裡先講，別等按存檔才知道）
  if (editingFollowScript.value && form.value.enabled) {
    const draftId = selectedId.value
    const rival = scripts.value.find(s => s.id !== draftId && s.enabled && scriptTriggerEvent(s) === 'follow')
    if (rival) {
      out.push({
        key: 'follow:dup',
        text: `「${rival.name || '(未命名流程)'}」也是在客人加好友時啟動、而且開著——兩條都開的話客人會連收兩份，存檔會被擋下來。請先停用那一條，或直接改那一條`,
      })
    }
  }
  for (const issue of reachabilityIssues.value) {
    // 被「另一條腳本」蓋住時，講「自動回覆排在前面」會把人指去翻錯的地方
    const why = issue.reason === 'otherScript' ? '' : '（安全層排在自動回應前面）'
    out.push({ key: `reach:${issue.reason}`, text: `${issue.detail}${why}` })
  }
  if (reachabilityState.value === 'failed') {
    out.push({
      key: 'reach:unknown',
      text: '讀不到 AI 設定，這次沒辦法確認這條流程的觸發詞會不會撞到敏感情境詞。重新整理再看一次。',
    })
  }
  return out
})

/** 流程圖上要標黃點的步驟 */
const flaggedNodeIds = computed(() => new Set(flowWarnings.value.map(w => w.nodeId).filter(Boolean) as string[]))

/** 綠燈只能宣告「真的查過」的事：規則還沒到手時，不可以說「不會被自動回覆蓋掉」 */
const allClearText = computed(() => {
  const fullyChecked = reachabilityState.value === 'ready' && form.value.enabled
  return fullyChecked
    ? '流程完整、每一題客人都走得完，觸發也不會被別的設定蓋掉 ✓'
    : '流程完整、每一題客人都走得完 ✓'
})

// ── List helpers ───────────────────────────────────────────────────
function triggerSummary(script: ScriptRow): string {
  const trig = script.nodes?.find(n => n.type === 'trigger') as ScriptTriggerNode | undefined
  if (!trig) return '還沒設什麼時候開始'
  if (trig.triggerEvent === 'follow') return '客人加好友時'
  if ((trig.matchMode ?? 'keyword') === 'semantic') {
    const ex = (trig.examples ?? []).filter(Boolean)
    if (!ex.length) return '還沒填客人會怎麼講'
    return ex.length > 1 ? `「${ex[0]}」等 ${ex.length} 句` : `「${ex[0]}」`
  }
  if (trig.keywordMatch === 'anyText') return '客人輸入任何內容'
  const kw = (trig.keywords ?? []).filter(Boolean)
  if (!kw.length) return '還沒填關鍵字'
  return kw.length > 1 ? `打了「${kw[0]}」等 ${kw.length} 個字` : `打了「${kw[0]}」`
}

/**
 * 清單每一列：什麼時候開始＋有沒有在幫忙（`D-138`④：以前只寫觸發詞，172 次、74% 要點進去才看得到）。
 * 只回一句話的那種沒有「走完」可講，只講次數。
 */
function listMeta(script: ScriptRow): string {
  const when = triggerSummary(script)
  const starts = script.stats?.starts ?? 0
  if (!starts) return `${when}・還沒有人走過`
  const asks = (script.nodes ?? []).some(n => n.type === 'collect' || n.type === 'quickReply')
  if (!asks) return `${when}・${starts} 次`
  return `${when}・${starts} 次，走完 ${Math.round(((script.stats?.completions ?? 0) / starts) * 100)}%`
}

function nodeIcon(type: string): Component {
  if (type === 'trigger') return Position
  if (type === 'collect') return Collection
  if (type === 'branch') return Share
  if (type === 'quickReply') return Pointer
  if (type === 'tag') return PriceTag
  if (type === 'saveLead') return Notebook
  if (type === 'module') return Connection
  return ChatDotRound
}

function nodeTypeLabel(type: string) {
  return SCRIPT_NODE_TYPE_LABELS[type as ScriptNode['type']] ?? '回覆'
}

function nodeBadgeClass(type: string) {
  if (type === 'trigger') return 'scripts-node-badge--trigger'
  if (type === 'collect') return 'scripts-node-badge--collect'
  if (type === 'branch') return 'scripts-node-badge--branch'
  if (type === 'quickReply') return 'scripts-node-badge--quickreply'
  if (type === 'tag' || type === 'saveLead' || type === 'module') return 'scripts-node-badge--action'
  return 'scripts-node-badge--reply'
}

/** 給「下一步」下拉用的節點選項標籤（trigger 不能當目標） */
function nodeOptionLabel(n: ScriptNode): string {
  if (n.type === 'collect') return `問：${fieldLabel(n.fieldName) || '(還沒選)'}`
  if (n.type === 'quickReply') return `快速回覆${n.question ? `「${n.question.slice(0, 8)}」` : ''}`
  if (n.type === 'reply') return `回覆「${(n.text || '').slice(0, 8) || '空白'}」`
  if (n.type === 'module') return `機器人模組「${moduleLabel(n.moduleId)}」`
  return SCRIPT_NODE_TYPE_LABELS[n.type]
}

/** 模組 id → 顯示名稱（清單還沒載到就先顯示 id，不要顯示空白） */
function moduleLabel(moduleId: string): string {
  if (!moduleId) return '未選擇'
  return moduleOptions.value.find(m => m.id === moduleId)?.name ?? moduleId
}

/** 節點短名（給「下一步」摘要用） */
function shortNodeName(id: string): string {
  const n = form.value.nodes.find(x => x.id === id)
  return n ? nodeOptionLabel(n) : '（尚未接，存檔會擋）'
}
/**
 * 把「看不見的去向」講出來：
 * - 線性節點（觸發/收集/貼標/寫名單）自動接下一個，但畫面上看不到 → 顯示 ↳ 下一步：X
 * - 回覆節點是終點 → 顯示是否結束/轉真人
 * - 分支/快速回覆的出口已在各自的列上顯示，回 null 不重複
 */
function autoNextLabel(node: ScriptNode): string | null {
  if (node.type === 'trigger' || node.type === 'collect' || node.type === 'tag' || node.type === 'saveLead') {
    const main = node.next ? shortNodeName(node.next) : '（尚未接，存檔會擋）'
    // 收集節點有跳過出口 → 把兩條去向都講出來
    if (node.type === 'collect' && collectSkipLabel(node)) {
      return `${main}；按「${collectSkipLabel(node)}」→ ${shortNodeName(node.skipNext!)}`
    }
    return main
  }
  if (node.type === 'reply') {
    return node.thenHandoff ? '流程結束，並轉真人客服' : '流程結束'
  }
  if (node.type === 'module') return '送出模組訊息，流程結束'
  return null
}

/** 線性節點的出口是空的（存檔驗證會擋）→ 把該節點的「↳ 下一步」標紅，指出要修的地方 */
function isNodeUnwired(node: ScriptNode): boolean {
  return (node.type === 'trigger' || node.type === 'collect' || node.type === 'tag' || node.type === 'saveLead') && !node.next
}

// ── 流程圖（即時預覽）──────────────────────────────────────────────
// 從觸發節點走訪整條流程，攤平成「縮排的流程列」：線性步驟同層往下，分支/快速回覆
// 的每條路往內縮一層並標上條件。純唯讀，跟著下面卡片即時變動；用路徑 visited 斷循環。
interface FlowRow { key: string; kind: 'node' | 'label' | 'note'; type?: ScriptNode['type']; title: string; sub?: string; depth: number; id?: string }

function flowTruncate(s: string, n = 16): string {
  const t = String(s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
function flowNodeTitle(node: ScriptNode): string {
  if (node.type === 'collect') return `問：${fieldLabel(node.fieldName) || '還沒選'}`
  return nodeTypeLabel(node.type)
}
function flowNodeSub(node: ScriptNode): string {
  if (node.type === 'trigger') {
    if (node.triggerEvent === 'follow') return '客人加好友時'
    const list = ((node.matchMode ?? 'keyword') === 'semantic' ? (node.examples ?? []) : (node.keywords ?? [])).filter(Boolean)
    return list.length ? `${list.slice(0, 3).join('、')}${list.length > 3 ? '…' : ''}` : '未設條件'
  }
  if (node.type === 'collect' || node.type === 'quickReply') return node.question ? `問「${flowTruncate(node.question)}」` : ''
  if (node.type === 'reply') return node.thenHandoff ? '回覆後轉真人 → 結束' : '回覆 → 結束'
  if (node.type === 'tag') return `${node.addTagIds.length} 個標籤`
  if (node.type === 'saveLead') return `存 ${node.fieldMap.length} 個欄位`
  if (node.type === 'module') return `${moduleLabel(node.moduleId)} → 結束`
  return ''
}
function flowBranchLabel(c: ScriptBranchNode['cases'][number]): string {
  const f = c.field || '欄位'
  if (c.op === 'equals') return `若 ${f} =「${c.value || ''}」`
  if (c.op === 'contains') return `若 ${f} 含「${c.value || ''}」`
  return `若 ${f} 有填`
}

const flowRows = computed<FlowRow[]>(() => {
  const nodes = form.value.nodes
  const byId = new Map(nodes.map(n => [n.id, n]))
  const rows: FlowRow[] = []
  const rendered = new Set<string>()
  const MAX = 60
  let seq = 0

  const pushNode = (node: ScriptNode, depth: number) => {
    rendered.add(node.id)
    rows.push({ key: `n${seq++}`, kind: 'node', type: node.type, title: flowNodeTitle(node), sub: flowNodeSub(node), depth, id: node.id })
  }
  const pushLabel = (title: string, depth: number) => rows.push({ key: `l${seq++}`, kind: 'label', title, depth })
  const pushNote = (title: string, depth: number) => rows.push({ key: `x${seq++}`, kind: 'note', title, depth })

  function walk(id: string, depth: number, path: Set<string>) {
    if (rows.length >= MAX) return
    if (!id) return pushNote('（尚未接下一步）', depth)
    const node = byId.get(id)
    if (!node) return pushNote('（接到不存在的步驟）', depth)
    if (path.has(id)) return pushNote(`↩ 回到「${flowNodeTitle(node)}」`, depth)
    const seen = new Set(path)
    seen.add(id)

    pushNode(node, depth)
    if (node.type === 'branch') {
      for (const c of node.cases) { pushLabel(flowBranchLabel(c), depth + 1); walk(c.next, depth + 1, seen) }
      pushLabel('其餘情況', depth + 1)
      walk(node.defaultNext, depth + 1, seen)
    }
    else if (node.type === 'quickReply') {
      for (const o of node.options) { pushLabel(`按「${o.label || '未命名'}」`, depth + 1); walk(o.next, depth + 1, seen) }
    }
    else if (node.type === 'collect' && collectSkipLabel(node)) {
      // 有跳過出口的收集：像分支一樣畫兩條路，照常回答往下、按跳過鈕走另一條
      pushLabel('照常回答', depth + 1)
      walk(node.next, depth + 1, seen)
      pushLabel(`按「${collectSkipLabel(node)}」`, depth + 1)
      walk(node.skipNext!, depth + 1, seen)
    }
    // reply / module 是終點，沒有下一步可走
    else if (node.type !== 'reply' && node.type !== 'module') {
      walk(node.next, depth, seen)
    }
  }

  const root = nodes.find(n => n.id === form.value.rootNodeId)
  if (root) walk(root.id, 0, new Set())
  // 沒被走訪到的孤兒節點（觸發除外）：提醒還沒接進流程
  for (const n of nodes) {
    if (n.type !== 'trigger' && !rendered.has(n.id)) pushNote(`⚠「${flowNodeTitle(n)}」還沒接進流程`, 0)
  }
  return rows
})

// 點流程圖上的步驟 → 捲到下面對應的卡片並短暫高亮，讓「圖」和「編輯卡片」連成一個可導覽的流程
const highlightStep = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null
function focusStep(id?: string) {
  if (!id) return
  highlightStep.value = id
  // nextTick：剛新增的步驟卡片要等 DOM 更新後才捲得到
  nextTick(() => {
    document.querySelector(`[data-node-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightStep.value = null }, 1600)
}

// ── 「前往…」下拉裡直接「＋ 接下一步」：把「按鈕/分支可以接子流程」變成看得見的動作 ──
// 快速回覆排第一：「這一題想給客人好幾個選擇」最常見的解法就是把路指到一個快速回覆步驟
const newStepOptions = [
  { value: '__new:quickReply', label: '＋ 新增：快速回覆（給客人幾顆按鈕選）' },
  { value: '__new:collect', label: '＋ 新增：收集（問一個問題）' },
  { value: '__new:branch', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.branch}` },
  { value: '__new:tag', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.tag}` },
  { value: '__new:saveLead', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.saveLead}` },
  { value: '__new:reply', label: '＋ 新增：回覆（結束）' },
  { value: '__new:module', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.module}（送出訊息並結束）` },
]

function makeStep(type: 'collect' | 'quickReply' | 'branch' | 'tag' | 'saveLead' | 'reply' | 'module', nextId: string): ScriptNode {
  if (type === 'collect') return defaultCollectNode(nextId)
  if (type === 'quickReply') return defaultQuickReplyNode(nextId)
  if (type === 'branch') return defaultBranchNode(nextId)
  if (type === 'tag') return defaultTagNode(nextId)
  if (type === 'saveLead') return defaultSaveLeadNode(nextId)
  if (type === 'module') return defaultModuleNode()
  return defaultReplyNode()
}

/**
 * 「前往…」被改變時：
 * - 選了一般步驟 → 直接把這條路指過去。
 * - 選了「＋ 接下一步」→ 建一個新步驟「插進這條路」：新步驟的下一步自動接回原本的目標
 *   （不會把原本接的東西弄丟），再把這條路指到新步驟，然後捲過去讓你填內容。
 */
function onTargetChange(value: string, currentTarget: string, setNext: (id: string) => void) {
  if (typeof value === 'string' && value.startsWith('__new:')) {
    const type = value.slice(6) as 'collect' | 'quickReply' | 'branch' | 'tag' | 'saveLead' | 'reply' | 'module'
    const node = makeStep(type, currentTarget)
    form.value.nodes.push(node)
    setNext(node.id)
    focusStep(node.id)
  }
  else {
    setNext(value)
  }
}

// ── 加積木選單：分「常用 / 進階」＋一句說明，讓人一眼知道每種在做什麼 ──────
const nodePalette: Array<{ group: string; items: Array<{ type: 'collect' | 'quickReply' | 'reply' | 'branch' | 'tag' | 'saveLead' | 'module'; name: string; desc: string }> }> = [
  { group: '常用', items: [
    { type: 'collect', name: '收集', desc: '問客人一個問題、記住答案' },
    { type: 'quickReply', name: '快速回覆', desc: '給幾顆按鈕讓客人點選' },
    { type: 'reply', name: '回覆', desc: '機器人回一句話，可結束或轉真人' },
  ] },
  { group: '進階', items: [
    { type: 'branch', name: SCRIPT_NODE_TYPE_LABELS.branch, desc: '依前面的答案自動走不同路' },
    { type: 'tag', name: SCRIPT_NODE_TYPE_LABELS.tag, desc: '自動幫這位客人貼上標籤' },
    { type: 'saveLead', name: SCRIPT_NODE_TYPE_LABELS.saveLead, desc: '長期留存，後台看得到、之後回覆也能帶入' },
    { type: 'module', name: SCRIPT_NODE_TYPE_LABELS.module, desc: '送出做好的一組訊息並結束' },
  ] },
]

// 試跑（「試試看」）搬到右邊的 AdminScriptTryPanel（`D-138`）：換一條時靠 :key 整個重來。

/**
 * 換一份進編輯器時，把「展開了什麼」歸零、依內容重推欄位模式與編法（清單／流程圖）。
 * ⛔ 試試看的「重來」不碰這些：重置一個預覽不該把使用者剛展開的欄位收回去。
 */
function resetEditorDisclosure(nodes: ScriptNode[]) {
  openedSkips.value = new Set()
  openedExcludes.value = false
  syncFieldModes(nodes)
  syncEditorMode()
}

/** 編輯中的這條是不是「加好友時」那種（重複警告用） */
const editingFollowScript = computed(() => triggerNode.value?.triggerEvent === 'follow')

/**
 * 目前所有「問一題」的欄位（給分支／存客人資料／插入客人資料選，避免手打 typo）。
 * label 講中文（`D-138`④：常用欄位不露出 order_id），value 照存的代號。
 */
const collectFieldOptions = computed(() =>
  form.value.nodes
    .filter((n): n is ScriptCollectNode => n.type === 'collect' && !!n.fieldName.trim())
    .map(n => ({ value: n.fieldName, label: fieldLabel(n.fieldName) })),
)
/** 節點標頭的用途提示（取代誤導的「節點 N」序號——分支圖裡順序≠流程） */
function nodeHeaderHint(node: ScriptNode): string {
  if (node.type === 'collect') return node.fieldName ? `欄位「${fieldLabel(node.fieldName)}」` : '（未命名欄位）'
  if (node.type === 'reply') return node.thenHandoff ? '結束 → 轉真人' : '結束'
  return ''
}

/** 每種步驟「在做什麼」的白話一句話，當步驟卡片副標，降低第一次使用的學習成本 */
function nodePurpose(type: string): string {
  if (type === 'trigger') return '決定客人說什麼，會啟動這條流程'
  if (type === 'collect') return '問客人一個問題，把答案記起來（例：訂單編號）'
  if (type === 'reply') return '機器人回一句話收尾，可選擇結束或轉真人'
  if (type === 'branch') return '依前面收到的答案，自動走不同路（不花 AI）'
  if (type === 'quickReply') return '給客人幾顆按鈕點選，依點哪顆走不同路'
  if (type === 'tag') return '自動幫這位客人貼上標籤，然後往下'
  if (type === 'saveLead') return '把收集到的答案，長期存進客人資料'
  if (type === 'module') return '送出做好的一組訊息，然後結束流程'
  return ''
}
/** 移除回覆的連結按鈕（兩格一起清，不留半套資料被存檔驗證擋下） */
function clearReplyLink(node: ScriptReplyNode) {
  delete node.linkUrl
  delete node.linkLabel
}

/** 在回覆文字尾端插入一個欄位變數 */
function insertReplyVar(node: ScriptReplyNode, field: string) {
  if (!field) return
  node.text = `${node.text || ''}{{${field}}}`
}
/** 回覆文字「自己打括號也算」的變數名：LINE 名稱＋這個流程收集的欄位（`D-128`） */
const scriptVariableKeys = computed(() => [
  ...BUILTIN_SCRIPT_VARIABLES.map(f => f.key as string),
  ...collectFieldOptions.value.map(f => f.value),
])

function addSaveLeadField(node: ScriptSaveLeadNode) {
  node.fieldMap.push({ fromField: '', attrKey: '' })
}
function removeSaveLeadField(node: ScriptSaveLeadNode, idx: number) {
  node.fieldMap.splice(idx, 1)
}
function targetOptions(selfId: string) {
  return form.value.nodes
    .filter(n => n.id !== selfId && n.type !== 'trigger')
    .map(n => ({ value: n.id, label: nodeOptionLabel(n) }))
}

function addBranchCase(node: ScriptBranchNode) {
  node.cases.push({ op: 'exists', field: '', value: '', next: '' })
}
function removeBranchCase(node: ScriptBranchNode, idx: number) {
  node.cases.splice(idx, 1)
}
function setBranchOp(c: ScriptBranchNode['cases'][number], op: string | number | boolean | undefined) {
  const next: BranchOp = (op === 'equals' || op === 'contains') ? op : 'exists'
  c.op = next
  // 切到 exists 不需要比較值，清掉殘留避免切回時冒出舊值
  if (next === 'exists') c.value = ''
}

// ── 收集步驟：常用欄位 ──────────────────────────────────────────────
// 「給答案取個代號（order_id）」是整頁最像工程師介面的一格。改成挑常用欄位，
// 問句、格式、代號一次帶好；真的不在清單裡才手打。
const COMMON_COLLECT_FIELDS: Array<{ key: string; label: string; question: string; format: CollectFormat }> = [
  { key: 'order_id', label: '訂單編號', question: '請提供您的訂單編號 🙂', format: 'alphanumericSymbol' },
  { key: 'name', label: '姓名', question: '請問怎麼稱呼您？', format: 'any' },
  { key: 'phone', label: '電話', question: '請留下方便聯絡的電話 📞', format: 'phone' },
  { key: 'email', label: 'Email', question: '請留下您的 Email', format: 'email' },
  { key: 'address', label: '地址', question: '請提供您的收件地址', format: 'any' },
]

const PRESET_FIELD_KEYS = new Set(COMMON_COLLECT_FIELDS.map(p => p.key))

/**
 * 每個收集步驟的「這一題問的是」選了什麼（步驟 id → 常用欄位 key 或 '__custom'）；沒有＝還沒選。
 *
 * ⛔ 不能從 fieldName 即時推導。手打代號打到剛好等於某個內建代號的那一刻（`nam` → `name`），
 * 推導出來的值會從 '__custom' 跳成 'name'，輸入框當場被 v-if 移除、@change 永遠不會觸發，
 * 於是「改名時順便修好所有引用」那段沒跑到，存檔被擋在「欄位沒有對應的收集步驟」，
 * 而且完全看不出是剛剛改名造成的。
 */
const fieldMode = ref<Record<string, string>>({})

/** 依目前的 fieldName 推一次初始模式（換腳本、載入草稿時呼叫；之後只跟著使用者的選擇走） */
function syncFieldModes(nodes: ScriptNode[]) {
  const next: Record<string, string> = {}
  for (const n of nodes) {
    if (n.type !== 'collect') continue
    const name = n.fieldName.trim()
    if (!name) continue
    next[n.id] = PRESET_FIELD_KEYS.has(name) ? name : '__custom'
  }
  fieldMode.value = next
}

/** 目前這一題選了哪個常用欄位；空字串＝還沒選（下拉顯示 placeholder） */
function presetKeyOf(node: ScriptCollectNode): string {
  return fieldMode.value[node.id] ?? ''
}

/**
 * 代號不能和別的收集步驟撞名——撞名的話兩題的答案會存進同一格、後面蓋掉前面。
 * 選常用欄位時自動讓開（姓名 → name、第二個 name_2），使用者會直接看到真正的代號。
 */
function uniqueFieldName(base: string, selfId: string): string {
  const taken = new Set(
    form.value.nodes
      .filter((n): n is ScriptCollectNode => n.type === 'collect' && n.id !== selfId)
      .map(n => n.fieldName.trim())
      .filter(Boolean),
  )
  if (!taken.has(base)) return base
  for (let i = 2; i <= 20; i++) {
    if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }
  return base
}

function applyFieldPreset(node: ScriptCollectNode, key: string | number | boolean | undefined) {
  const preset = COMMON_COLLECT_FIELDS.find(p => p.key === key)
  if (!preset) {
    // 切到「其他」：保留現有代號讓人直接改，不清空（清空會讓下面的分路條件瞬間失效）
    fieldMode.value = { ...fieldMode.value, [node.id]: '__custom' }
    return
  }
  const prev = node.fieldName
  const name = uniqueFieldName(preset.key, node.id)
  node.fieldName = name
  node.format = preset.format
  if (!node.question.trim()) node.question = preset.question
  // 撞名讓開後代號已經不是內建的那個，下拉要顯示「其他」才不會和輸入框裡的值互相矛盾
  fieldMode.value = { ...fieldMode.value, [node.id]: name === preset.key ? preset.key : '__custom' }
  if (name !== preset.key) {
    showToast(`已經有另一個步驟用「${preset.key}」了，這一題的代號改用「${name}」，避免兩題的答案互相蓋掉`, 'success')
  }
  renameCollectField(node, prev)
}

/** 手打代號時記住改之前叫什麼，change（失焦/Enter）才一次修好所有引用 */
const fieldRenameFrom = ref('')

/**
 * 改欄位代號時，把引用它的地方一起改掉。不修的話舊名字會變成「沒有對應的收集步驟」，
 * 存檔被擋、而且不容易看出是剛剛改名造成的。
 *
 * ⛔ 變數要四個地方一起換：引擎會對**回覆文字、收集問句、快速回覆問句、格式錯誤的重問話術**
 * 都跑 renderScriptTemplate（server/utils/ai-scripts.ts）。只換回覆文字的話，客人會實際收到
 * 一句「請確認 {{order_id}} 是否正確」——renderScriptTemplate 對認不得的變數是刻意原樣保留的。
 */
function renameCollectField(node: ScriptCollectNode, prev: string) {
  const next = node.fieldName.trim()
  if (!prev || !next || prev === next) return
  // 還有別的收集步驟叫這個舊名字 → 引用指的是誰無法判斷，不要亂改（同名本身會另外跳警告）
  const stillUsed = form.value.nodes.some(n => n.type === 'collect' && n.id !== node.id && n.fieldName.trim() === prev)
  if (stillUsed) return

  const varRe = new RegExp(`\\{\\{\\s*${prev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g')
  const swap = (text: string | undefined) => String(text ?? '').replace(varRe, `{{${next}}}`)

  for (const n of form.value.nodes) {
    if (n.type === 'branch') {
      for (const c of n.cases) if (c.field === prev) c.field = next
    }
    else if (n.type === 'saveLead') {
      for (const m of n.fieldMap) if (m.fromField === prev) m.fromField = next
    }
    else if (n.type === 'reply') {
      n.text = swap(n.text)
    }
    else if (n.type === 'quickReply') {
      n.question = swap(n.question)
    }
    else if (n.type === 'collect') {
      n.question = swap(n.question)
      if (n.reaskText) n.reaskText = swap(n.reaskText)
    }
  }
}

// ── 收集步驟：答不出來的退路 ─────────────────────────────────────────
// 八成的題目用不到，所以預設收起；已經設好的、或這一輪剛按開的才展開。
const openedSkips = ref<Set<string>>(new Set())

function isSkipOpen(node: ScriptCollectNode): boolean {
  // 單邊有值也要展開：那是還沒設完的狀態，收起來就沒人修得到（存檔會被擋）
  return !!node.skipLabel || !!node.skipNext || openedSkips.value.has(node.id)
}
function openCollectSkip(node: ScriptCollectNode) {
  openedSkips.value = new Set(openedSkips.value).add(node.id)
}

/** 這一題問的是「客人可能根本沒有」的代碼、又還沒給退路（和狀態列讀同一份，不會各算各的） */
function isStuckCollect(node: ScriptCollectNode): boolean {
  return stuckCollectIds.value.has(node.id)
}

/** 清掉收集節點的跳過出口（兩格一起清，避免留單邊被存檔驗證擋下） */
function clearCollectSkip(node: ScriptCollectNode) {
  node.skipLabel = ''
  node.skipNext = ''
  const next = new Set(openedSkips.value)
  next.delete(node.id)
  openedSkips.value = next
}

/** 多一顆按鈕；清單編法帶「直接到最後」當預設去向（流程圖編法照舊留空、讓他自己接） */
function addQuickReplyOption(node: ScriptQuickReplyNode, defaultNext = '') {
  node.options.push({ label: '', next: defaultNext })
}
function removeQuickReplyOption(node: ScriptQuickReplyNode, idx: number) {
  node.options.splice(idx, 1)
}

// ── Edit ───────────────────────────────────────────────────────────
function selectScript(script: ScriptRow, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = script.id
  form.value = {
    name: script.name,
    enabled: script.enabled,
    priority: script.priority || DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: script.rootNodeId,
    nodes: deepCloneNodes(script.nodes),
  }
  markClean()
  resetEditorDisclosure(form.value.nodes)
}

/** 「新增」：回到起點選擇（＝什麼都沒選的那個畫面，`D-138`④） */
function openStarter() {
  if (!confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = null
  form.value = blankForm()
  markClean()
  resetEditorDisclosure(form.value.nodes)
}

/** 把一份還沒存的草稿放進編輯器。dirty＝裡面已經有內容（範本、AI 草稿）：切走要問，不然整份消失 */
function loadDraft(draft: ReturnType<typeof blankForm>, dirty: boolean) {
  isCreating.value = true
  selectedId.value = null
  form.value = draft
  if (dirty) markDirty()
  else markClean()
  createSeq.value++
  resetEditorDisclosure(form.value.nodes)
}

/**
 * 「先問資料，再交給真人」的起點：看意思開始、先問訂單編號（客人說沒有就直接到最後）、回完交給真人。
 * 跟 MYFEEL 現在在用的三條同一個樣子；問句是常用欄位帶的那句，改不改都可以。
 */
function handoffStarter(): ReturnType<typeof blankForm> {
  const reply: ScriptReplyNode = { ...defaultReplyNode(), text: '已收到您的資訊，我們會盡快為您處理，謝謝您 🙇', thenHandoff: true }
  const ask: ScriptCollectNode = {
    ...defaultCollectNode(reply.id),
    question: '請問您的訂單編號是？',
    fieldName: 'order_id',
    format: 'alphanumericSymbol',
    skipLabel: '我沒有訂單編號',
    skipNext: reply.id,
  }
  const trigger: ScriptTriggerNode = { ...defaultTriggerNode(ask.id), matchMode: 'semantic', examples: [] }
  return { name: '', enabled: true, priority: DEFAULT_SCRIPT_PRIORITY, rootNodeId: trigger.id, nodes: [trigger, ask, reply] }
}

/** 「客人打特定的字，就回固定內容」的起點：一字不差才回（LINE 內建的自動回應也是這樣，店家熟） */
function fixedStarter(): ReturnType<typeof blankForm> {
  const f = blankForm()
  const trigger = f.nodes[0] as ScriptTriggerNode
  trigger.keywordMatch = 'exact'
  return f
}

function startFrom(kind: 'handoff' | 'fixed' | 'blank') {
  if (!confirmLeaveIfDirty()) return
  loadDraft(kind === 'handoff' ? handoffStarter() : kind === 'fixed' ? fixedStarter() : blankForm(), false)
}

// ── `D-23`：「客人加好友時」那一列 ────────────────────────────────────
/** 清單本體只列「客人說什麼」那種；加好友那條由上面釘住的那一列代表 */
const messageScripts = computed(() =>
  scripts.value.filter((s: any) => scriptTriggerEvent(s) !== 'follow'),
)
const followScript = computed<any | null>(() =>
  scripts.value.find((s: any) => scriptTriggerEvent(s) === 'follow' && s.enabled !== false)
  ?? scripts.value.find((s: any) => scriptTriggerEvent(s) === 'follow')
  ?? null,
)
const followRow = computed(() =>
  followWelcomeRow(scripts.value.map((s: any) => ({
    enabled: s.enabled,
    name: s.name,
    triggerEvent: scriptTriggerEvent(s),
  }))),
)
const isFollowRowActive = computed(() =>
  Boolean(followScript.value && selectedId.value === followScript.value.id),
)

/** 已經設過就進既有編輯器（＝進階那一層）；還沒設過就開「選一個模組或打一段字」的小視窗 */
const followSetupVisible = ref(false)
function onFollowRowSelect() {
  if (followScript.value) {
    selectScript(followScript.value as ScriptRow)
    return
  }
  if (!canEditScripts.value) return
  followSetupVisible.value = true
}

async function onFollowWelcomeCreated(scriptId: string) {
  await loadScripts()
  const created = scripts.value.find((s: any) => s.id === scriptId)
  if (created) selectScript(created as ScriptRow, { skipDiscardConfirm: true })
}

// 右上「⋯」選單：複製 / 刪除
function onHeaderCommand(cmd: string) {
  if (cmd === 'duplicate') void duplicateScript()
  else if (cmd === 'delete') void deleteScript()
}

/** 「客人加好友時」那條（不給複製，理由見模板上的註解） */
const selectedIsFollowScript = computed(() =>
  Boolean(selectedScript.value && scriptTriggerEvent(selectedScript.value) === 'follow'),
)

/**
 * 複製：近似的自動回應（「更改地址」「新增備註」常常只有最後一題不同）不用整條重刻。
 *
 * 跟機器人模組、推播同一套規則（`C-294`，`docs/COPY-RULES-AND-INVENTORY-20261009.md`）：
 * 按下去就存好一份「原名 (複製)」、排在清單最上面並打開它；有沒存的修改先問要不要存。
 * ⛔ 複本一定先**停用**：觸發詞跟原本那條一模一樣，兩條都啟用會互相蓋台，剛複製完就踩這個坑很冤。
 * （2026-10-09 以前是「複製成還沒存的草稿、按建立才存」，跟另外兩頁不一樣，改成同一套。）
 * 節點 id 沿用即可：只要在單一腳本內唯一，跨文件重複沒有影響。
 */
async function duplicateScript() {
  if (!canEditScripts.value || !selectedId.value) return
  if (hasUnsavedChanges.value) {
    if (!(await confirmSaveBeforeCopy())) return
    await submitForm()
    // 存失敗、或在「會影響其他流程」那一步按了先不要，都還是有修改＝不複製
    if (hasUnsavedChanges.value) return
  }
  const src = scripts.value.find(s => s.id === selectedId.value)
  if (!src) return
  duplicating.value = true
  try {
    const res = await apiFetch<{ id: string }>('/api/ai/scripts/create', {
      method: 'POST',
      body: {
        name: `${src.name || '未命名流程'} (複製)`,
        enabled: false,
        priority: src.priority || DEFAULT_SCRIPT_PRIORITY,
        rootNodeId: src.rootNodeId,
        nodes: deepCloneNodes(src.nodes),
      },
    })
    showToast('已複製。複本先停用（觸發詞跟原本那條一樣），改好再啟用', 'success')
    await loadScripts(true)
    const fresh = scripts.value.find(s => s.id === res.id)
    if (fresh) {
      selectScript(fresh, { skipDiscardConfirm: true })
      // 新的排在清單最上面；人可能正捲在下面看一條舊的，捲回去讓他看得到反白的那一列
      await nextTick()
      listEl.value?.querySelector(`[data-agent-target="${res.id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || err?.statusMessage || '複製失敗', 'error')
  }
  finally {
    duplicating.value = false
  }
}

// ── AI 一句話生成草稿 ────────────────────────────────────────────────
const aiGenerating = ref(false)
const starterEl = ref<{ clearDesc: () => void } | null>(null)

/** 呼叫生成端點,把草稿載入編輯器(與範本同一條路:未存檔,人審後按「建立」才寫入) */
async function generateFromAi(description: string) {
  if (!description.trim() || aiGenerating.value) return
  if (!confirmLeaveIfDirty()) return
  aiGenerating.value = true
  try {
    const draft = await apiFetch<{ name: string; nodes: ScriptNode[]; rootNodeId: string }>(
      '/api/ai/scripts/generate',
      { method: 'POST', body: { description: description.trim() } },
    )
    starterEl.value?.clearDesc()
    loadDraft({
      name: draft.name,
      enabled: true,
      priority: DEFAULT_SCRIPT_PRIORITY,
      rootNodeId: draft.rootNodeId,
      nodes: deepCloneNodes(draft.nodes),
    }, true)
    showToast('草稿搭好了——看一遍、在右邊「試試看」打一句，調整後按「建立自動回應」', 'success')
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.data?.statusMessage || err?.message || 'AI 生成失敗,換個說法再試一次', 'error')
  }
  finally {
    aiGenerating.value = false
  }
}

/** 從範本一鍵建立：載入到編輯器（尚未存檔，使用者微調後按建立才寫入） */
function createFromTemplate(tpl: ScriptTemplate) {
  if (!confirmLeaveIfDirty()) return
  loadDraft({
    name: tpl.label,
    enabled: true,
    priority: DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: tpl.rootNodeId,
    nodes: deepCloneNodes(tpl.nodes),
  }, true)
}

function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedScript.value) {
    selectScript(selectedScript.value, { skipDiscardConfirm: true })
    isCreating.value = false
  }
  else {
    isCreating.value = false
    selectedId.value = null
    form.value = blankForm()
    markClean()
    resetEditorDisclosure(form.value.nodes)
  }
}

function deepCloneNodes(nodes: ScriptNode[] = []): ScriptNode[] {
  return JSON.parse(JSON.stringify(nodes || []))
}

// ── Node operations ─────────────────────────────────────────────────
function updateKeywords(node: ScriptTriggerNode, value: string) {
  node.keywords = String(value || '')
    .split(/[\n,，、\s]+/g)
    .map(k => k.trim())
    .filter(Boolean)
    .slice(0, 20)
}

/**
 * 觸發方式在畫面上是三選一（關鍵字／看意思／客人加好友時），但資料上是兩個欄位
 * （triggerEvent 事件型 vs matchMode 文字比對）——這裡是唯一一處換算，模板都吃這支。
 */
function triggerUiMode(node: ScriptTriggerNode): 'keyword' | 'semantic' | 'follow' {
  if (node.triggerEvent === 'follow') return 'follow'
  return (node.matchMode ?? 'keyword') === 'semantic' ? 'semantic' : 'keyword'
}

function setTriggerMode(node: ScriptTriggerNode, mode: string | number | boolean | undefined) {
  if (mode === 'follow') {
    node.triggerEvent = 'follow'
    return
  }
  // 切回文字比對：關鍵字／範例還留在欄位上，切回來就看得到（存檔時 follow 腳本才會被清空）
  delete node.triggerEvent
  const m: TriggerMatchMode = mode === 'semantic' ? 'semantic' : 'keyword'
  node.matchMode = m
  if (m === 'semantic' && !node.examples) node.examples = []
}

function updateExamples(node: ScriptTriggerNode, value: string) {
  // 一行一句（語意比對靠整句意思，不需逗號拆短詞）
  node.examples = String(value || '')
    .split(/\n+/g)
    .map(e => e.trim())
    .filter(Boolean)
    .slice(0, MAX_TRIGGER_EXAMPLES)
}

function addNode(type: 'collect' | 'reply' | 'branch' | 'quickReply' | 'tag' | 'saveLead' | 'module') {
  const nodes = form.value.nodes

  if (type === 'reply' || type === 'module') {
    // 終點步驟：通常只會有一個。若已有終點，這顆需手動接（當分支的某個出口）
    nodes.push(type === 'module' ? defaultModuleNode() : defaultReplyNode())
    return
  }

  // 其餘節點：插在最後一個 reply 之前，把「原本指到 reply 的節點」改指到新節點，
  // 新節點則接到那個 reply。沒 reply 時出口留空（驗證會擋）。
  const replyIdx = nodes.findIndex(n => n.type === 'reply')
  const reply = nodes[replyIdx] as ScriptReplyNode | undefined
  const nextId = reply?.id ?? ''
  const newNode: ScriptCollectNode | ScriptBranchNode | ScriptQuickReplyNode | ScriptTagNode | ScriptSaveLeadNode
    = type === 'collect' ? defaultCollectNode(nextId)
      : type === 'branch' ? defaultBranchNode(nextId)
        : type === 'quickReply' ? defaultQuickReplyNode(nextId)
          : type === 'tag' ? defaultTagNode(nextId)
            : defaultSaveLeadNode(nextId)

  if (!reply) {
    nodes.push(newNode)
    return
  }
  // 找「目前指到 reply 的那個節點」改指到新節點（涵蓋 trigger/collect 的 next、branch 的 defaultNext、
  // quickReply 的某個選項），讓新節點自動串進線性流程，避免變孤兒。
  const beforeReply = nodes.find(n =>
    ((n.type === 'trigger' || n.type === 'collect') && n.next === reply.id)
    || (n.type === 'branch' && n.defaultNext === reply.id)
    || (n.type === 'quickReply' && n.options.some(o => o.next === reply.id)),
  )
  if (beforeReply) {
    if (beforeReply.type === 'branch') beforeReply.defaultNext = newNode.id
    else if (beforeReply.type === 'quickReply') {
      const opt = beforeReply.options.find(o => o.next === reply.id)
      if (opt) opt.next = newNode.id
    }
    else if (beforeReply.type === 'trigger' || beforeReply.type === 'collect') beforeReply.next = newNode.id
  }
  nodes.splice(replyIdx, 0, newNode)
}

function removeNode(id: string) {
  const nodes = form.value.nodes
  const idx = nodes.findIndex(n => n.id === id)
  if (idx < 0) return
  const removed = nodes[idx]
  if (!removed || removed.type === 'trigger') return // trigger 不可移除

  // 接替出口：單一出口節點→其 next；branch→defaultNext；quickReply→首選項 next；reply→空
  const fallback = (removed.type === 'collect' || removed.type === 'tag' || removed.type === 'saveLead')
    ? removed.next
    : removed.type === 'branch'
      ? removed.defaultNext
      : removed.type === 'quickReply' ? (removed.options[0]?.next ?? '') : ''

  // 修補所有指向 removed.id 的出口（trigger/collect 的 next+skipNext、branch defaultNext+cases、quickReply options）
  for (const n of nodes) {
    if ((n.type === 'trigger' || n.type === 'collect') && n.next === id) n.next = fallback
    if (n.type === 'collect' && n.skipNext === id) n.skipNext = fallback
    if (n.type === 'branch') {
      if (n.defaultNext === id) n.defaultNext = fallback
      for (const c of n.cases) if (c.next === id) c.next = fallback
    }
    if (n.type === 'quickReply') {
      for (const o of n.options) if (o.next === id) o.next = fallback
    }
  }
  nodes.splice(idx, 1)
}

// ── 小幫手改完（`D-112` 第 4 件）：清單重讀、那一列亮一下 ─────────────────
// ⛔ 正開著的就是那一條、又有沒存的修改：不重讀（會蓋掉他打到一半的東西），回 dirty 讓聊天照實講
useAgentOpRefresh('ai-scripts', async (evt, { mode }) => {
  const id = evt.targetId
  if (!id) return 'missing'
  // 從別頁「前往查看」過來：`?id=` 深連結會自己翻頁打開它，這裡只等那一列出現
  if (mode === 'arrived') return (await flashAgentTarget(id, 8000)) ? 'shown' : 'missing'
  if (mode === 'fresh') await loadScripts(true)
  // 不在已載入的那幾頁：往下翻到找到為止（同 `?id=` 深連結那一招）
  if (!scripts.value.some(s => s.id === id))
    await findScriptUntilFound(s => s.id === id).catch(() => null)
  const row = scripts.value.find(s => s.id === id)
  if (!row) return 'missing'
  const isOpen = selectedId.value === id
  if (isOpen && hasUnsavedChanges.value) return 'dirty'
  // 正開著的就是它 → 換成新的內容；他按了「前往查看」→ 打開它（⛔ 手上有別條沒存的就只亮、不切）
  if (isOpen || (mode === 'reveal' && !hasUnsavedChanges.value))
    selectScript(row, { skipDiscardConfirm: true })
  return (await flashAgentTarget(id)) ? 'shown' : 'missing'
})

// ── Load / Save / Delete ────────────────────────────────────────────
onMounted(async () => {
  const listed = loadScripts(true)
  loadTags({ status: 'active' }).catch(() => {})
  // 自己有 try/catch、失敗會轉成 reachabilityState='failed'（狀態列會據此改口），不會 reject
  loadReachabilityContext()
  loadModuleOptions()
  await listed
  // `C-237`：網址帶 ?id= 就直接開那一條自動回應
  await openFromQueryId({
    label: '自動回應',
    list: { loadUntilFound: findScriptUntilFound, listEl },
    select: item => selectScript(item, { skipDiscardConfirm: true }),
    isBusy: () => hasUnsavedChanges.value,
  })
})

/**
 * 上下架之前先問後端「按下去之後誰會變得輪不到、誰會活過來」。
 *
 * ⛔ 只有**看不見的影響**才跳確認（這條開了也輪不到、或它會把別條蓋掉）：
 *    「這條不再回覆客人」開關底下那句話已經講了，每次都跳只會訓練人閉眼按確定。
 * 讀不到影響時一律放行——查不到不等於有問題，不能因為問不到就擋住人存檔。
 */
async function confirmToggleImpact(scriptId: string, enabled: boolean): Promise<boolean> {
  let impact: {
    hasImpact: boolean
    selfStillBlocked: { detail: string } | null
    newlyBlocked: { detail: string }[]
    newlyFreed: { detail: string }[]
  }
  try {
    // ⛔ 要把**編輯中**的步驟一起送過去：只送開關的話，後端會拿資料庫裡的舊觸發詞去算，
    //    「把觸發詞放寬又同時啟用」這種最該被警告的情況反而會回報「沒有影響」
    impact = await apiFetch('/api/ai/scripts/preview-impact', {
      method: 'POST',
      body: { scriptId, enabled, nodes: form.value.nodes, rootNodeId: form.value.rootNodeId },
    })
  }
  catch {
    return true
  }
  if (!impact.hasImpact) return true

  const lines = [
    ...(impact.selfStillBlocked ? [`・${impact.selfStillBlocked.detail}（開了等於沒開）`] : []),
    ...impact.newlyBlocked.map(i => `・${i.detail}`),
    ...impact.newlyFreed.map(i => `・${i.detail}（會恢復作用）`),
  ]
  return await ElMessageBox.confirm(
    `${enabled ? '開啟' : '關閉'}這條流程會連帶影響其他流程：\n\n${lines.join('\n')}\n\n確定要存檔嗎？`,
    '存檔前先確認影響',
    { confirmButtonText: '確定存檔', cancelButtonText: '先不要', type: 'warning' },
  ).then(() => true).catch(() => false)
}

async function submitForm() {
  // 名稱選填（`D-138`④）：沒填就用客人會講的第一句，畫面上那格跟著填上，看得到存成什麼
  const name = form.value.name.trim() || autoName()
  if (!name) return showToast('先填客人會怎麼講（或取個名稱）再存', 'error')
  form.value.name = name
  // trigger 同步 priority
  const trig = form.value.nodes.find(n => n.type === 'trigger') as ScriptTriggerNode | undefined
  if (trig) trig.priority = form.value.priority

  // 上下架的影響常常不在這條身上，在別條身上——存檔前講清楚（原本這裡完全沒有確認）
  if (!isCreating.value && selectedId.value) {
    const stored = scripts.value.find(s => s.id === selectedId.value)
    if (stored && stored.enabled !== form.value.enabled) {
      const go = await confirmToggleImpact(selectedId.value, form.value.enabled)
      if (!go) return
    }
  }

  saving.value = true
  try {
    const payload = {
      name,
      enabled: form.value.enabled,
      priority: form.value.priority,
      rootNodeId: form.value.rootNodeId,
      nodes: form.value.nodes,
    }
    if (isCreating.value) {
      const res = await apiFetch<{ id: string }>('/api/ai/scripts/create', { method: 'POST', body: payload })
      showToast('自動回應已建立', 'success')
      await loadScripts(true)
      const fresh = scripts.value.find(s => s.id === res.id)
      if (fresh) selectScript(fresh, { skipDiscardConfirm: true })
      isCreating.value = false
    }
    else if (selectedId.value) {
      await apiFetch(`/api/ai/scripts/${selectedId.value}`, { method: 'PUT', body: payload })
      showToast('已儲存', 'success')
      await loadScripts(true)
      markClean()
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.message || '儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

async function deleteScript() {
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(`確定刪除「${form.value.name}」這條自動回應？`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/ai/scripts/${selectedId.value}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    selectedId.value = null
    isCreating.value = false
    form.value = blankForm()
    markClean()
    await loadScripts(true)
  }
  catch {
    showToast('刪除失敗', 'error')
  }
}
</script>

<!-- 樣式見 app/assets/scss/pages/_ai-scripts.scss（與其他 admin 頁一致，不寫在 .vue） -->
