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
        :templates="starterTemplates"
        :generating="aiGenerating"
        @start="startFrom"
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
        `D-138`④：左邊設定、右邊「試試看」常駐。
        2026-10-22 老闆「高度拉滿然後 fixed，參考其他頁面」：右邊照推播頁（`C-251`）貼齊右緣、拉滿編輯區、
        捲左邊時不動，對話在面板裡捲；編輯區不夠寬時照舊排到下面、跟著整頁捲（量法見 workspaceEl）。
      -->
      <div
        ref="workspaceEl"
        class="ai-scripts-body scripts-workspace"
        :class="{ 'is-wide': workspaceWide }"
        :style="workspaceViewH ? { '--scripts-view-h': `${workspaceViewH}px` } : undefined"
      >
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
                <!--
                  「客人加好友時」不在這裡切（2026-10-22 老闆「統一在左邊設定，這邊兩種就好」）：
                  它只從清單最上面那一列進來，打開就寫明是哪種、不給切——以前在這裡切來切去，
                  會把「查詢訂單」變成歡迎訊息，或把歡迎訊息切回一般的、左邊那一列變回「還沒設定」。
                -->
                <div class="admin-field-group" data-tour="scr-trigger-mode">
                  <b v-if="triggerUiMode(triggerNode) === 'follow'" class="scripts-trigger-fixed">客人加好友時</b>
                  <el-radio-group v-else :model-value="triggerUiMode(triggerNode)" class="scripts-trigger-modes" @change="setTriggerMode(triggerNode, $event)">
                    <el-radio-button value="semantic">客人在問這類事（AI 判斷）</el-radio-button>
                    <el-radio-button value="keyword">客人打特定的字（關鍵字）</el-radio-button>
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
                    <AdminLineListInput
                      :model-value="triggerNode.examples ?? []"
                      :rows="3"
                      :max="MAX_TRIGGER_EXAMPLES"
                      placeholder="例：&#10;我想查訂單&#10;我的訂單到哪了"
                      @update:model-value="triggerNode.examples = $event"
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
                    <AdminLineListInput
                      :model-value="triggerNode.excludes ?? []"
                      :rows="2"
                      :max="MAX_TRIGGER_EXCLUDES"
                      placeholder="例：&#10;什麼時候出貨&#10;何時會收到貨"
                      @update:model-value="setExcludes(triggerNode, $event)"
                    />
                    <p class="scripts-section-hint">意思一樣的不走這一條、交給 AI 回答。</p>
                  </div>
                  <button v-else-if="canEditScripts" type="button" class="scripts-skip-add" @click="openExcludes">
                    ＋ 有些講法不要接（交給 AI 回答）
                  </button>
                </template>

                <!--
                  `D-148`（2026-10-22 老闆「操作盡量非常接近一致」）：跟上面 AI 判斷同一個順序——
                  先填客人打什麼（同一種一行一個的多行框）→ 再選怎樣才接 → 一樣有「有些講法不要接」→ 防重複觸發。
                  以前是先選「怎麼比對」（四選一的下拉）才填字，字用逗號或空白隔開（「LINE Pay」被拆成兩個）。
                -->
                <template v-else>
                  <div v-if="triggerNode.keywordMatch !== 'anyText'" class="admin-field-group">
                    <AdminFieldLabel text="客人打這些字（一行一個）" tight />
                    <AdminLineListInput
                      :model-value="triggerNode.keywords"
                      :rows="3"
                      :max="20"
                      :separator="KEYWORD_SEPARATOR"
                      :placeholder="keywordPlaceholder(triggerNode)"
                      @update:model-value="triggerNode.keywords = $event"
                    />
                  </div>
                  <div class="admin-field-group" data-tour="scr-match">
                    <AdminFieldLabel text="怎樣才接" tight />
                    <!-- 常用的只有兩種；「全部都有」「打什麼都接」只在舊設定已經選了才出現（後者會攔掉所有訊息） -->
                    <el-radio-group :model-value="triggerNode.keywordMatch ?? 'any'" class="scripts-keyword-match" @change="setKeywordMatch(triggerNode, $event)">
                      <el-radio value="any">訊息裡有這些字就接</el-radio>
                      <el-radio value="exact">一模一樣才接</el-radio>
                      <el-radio v-if="triggerNode.keywordMatch === 'all'" value="all">這些字全部都有才接</el-radio>
                      <!-- ⛔ 名字不改：異常提醒、小幫手一鍵停用都叫它「客人輸入任何內容」 -->
                      <el-radio v-if="triggerNode.keywordMatch === 'anyText'" value="anyText">客人輸入任何內容</el-radio>
                    </el-radio-group>
                    <!-- 介面上鼓勵用 AI 判斷（2026-10-21 老闆「好」）：講清楚這一種是給誰用的，一般講法指回 AI 判斷 -->
                    <p v-if="(triggerNode.keywordMatch ?? 'any') === 'exact'" class="scripts-section-hint">只看字、不經過 AI。客人要打得一模一樣才接，適合活動口令、固定公告。</p>
                    <p v-else-if="triggerNode.keywordMatch !== 'anyText'" class="scripts-section-hint">只看字、不經過 AI。訊息裡出現就接，太常見的字會攔到不相關的話；一般講法用「客人在問這類事（AI 判斷）」比較不會漏接或接錯。</p>
                    <!-- 這種設定排在 AI 前面，開著等於把 AI 整個關掉 -->
                    <el-alert
                      v-if="triggerNode.keywordMatch === 'anyText'"
                      type="warning"
                      :closable="false"
                      show-icon
                      title="這條啟用後，會攔截「所有」文字訊息"
                      description="客人不管打什麼都會走進這一條，AI 客服和其他自動回應都收不到訊息、完全失效，而且不會有任何錯誤提示。除非你是刻意要暫停 AI，否則建議改成「訊息裡有這些字就接」。"
                    />
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
                      description="訊息裡有這幾個字就會被攔走，例如設「問題」，客人打「我的訂單有問題」也會被這一條接走、AI 就答不到了。建議改成這一條專屬的具體詞（兩個字以上），或改成「一模一樣才接」。"
                    />
                  </div>
                  <!-- 「不要接」：同 AI 判斷那一格；一模一樣才接的用不到（整句都對上了） -->
                  <template v-if="triggerNode.keywordMatch !== 'exact' && triggerNode.keywordMatch !== 'anyText'">
                    <div v-if="excludesOpen(triggerNode)" class="admin-field-group">
                      <AdminFieldLabel text="這些交給 AI 回答，不要接（一行一句）" tight />
                      <AdminLineListInput
                        :model-value="triggerNode.excludes ?? []"
                        :rows="2"
                        :max="MAX_TRIGGER_EXCLUDES"
                        placeholder="例：&#10;我不想退貨了&#10;退貨要多久"
                        @update:model-value="setExcludes(triggerNode, $event)"
                      />
                      <p class="scripts-section-hint">訊息裡有這幾句，就不走這一條、交給 AI 回答。</p>
                    </div>
                    <button v-else-if="canEditScripts" type="button" class="scripts-skip-add" @click="openExcludes">
                      ＋ 有些講法不要接（交給 AI 回答）
                    </button>
                  </template>
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
                  <!--
                    2026-10-22 老闆「這邊的 UIUX 再優化、要能拖曳排序，參考別家」（`D-140`，調查見 docs/AUTO-RESPONSE-QUESTION-LIST-EVAL-20261022.md）：
                    ① 照順序就是下一題，「答了 →」只在設了跳題的那張卡出現（表單工具與漸強、Intercom 新版都這樣）；
                    ② 存進客人資料勾在每一題上（ManyChat、respond.io、Landbot 等八家都放在題目上）；
                    ③ ⠿ 拖曳（同機器人模組）＋「⋯」裡上移下移；刪除、跳題、客人可能沒有收進「⋯」（全站次要動作都在「⋯」）。
                    ⛔ 「客人可能根本沒有、又沒給路」那種提醒照樣直接露出——那是客人會被一直重問的事，不能藏進選單。
                  -->
                  <div
                    v-for="(item, i) in qList.items"
                    :key="item.id"
                    class="scripts-q"
                    :class="{
                      'is-focused': highlightStep === item.id,
                      'is-try-current': tryStateOf(item.id) === 'current',
                      'is-dragging': qDragFrom === i,
                      'is-drag-over': qDragOver === i && qDragFrom !== null && qDragFrom !== i,
                    }"
                    :data-node-id="item.id"
                    @dragover.prevent="onQDragOver(i)"
                    @dragenter.prevent
                    @drop.prevent="onQDrop(i)"
                  >
                    <div class="scripts-q__head">
                      <span
                        v-if="canEditScripts && qList.items.length > 1"
                        class="drag-handle scripts-q__handle"
                        draggable="true"
                        title="拖曳調整順序"
                        aria-hidden="true"
                        @dragstart="onQDragStart($event, i)"
                        @dragend="onQDragEnd"
                      >⠿</span>
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
                        <el-select v-if="isFormatShown(item)" :model-value="item.format ?? 'any'" class="scripts-q__format" @change="item.format = $event">
                          <el-option v-for="f in COLLECT_FORMAT_OPTIONS" :key="f.value" :label="f.label" :value="f.value" />
                        </el-select>
                      </template>
                      <b v-else class="scripts-q__kind">給客人按鈕選</b>
                      <span v-if="item.type === 'collect' && isCodeFormat(item)" class="scripts-q__tag" title="客人傳訂單截圖也算回答了這一題">截圖也收</span>
                      <!-- `D-142`①：右邊試試看走到哪、這裡跟著標（同 n8n 跑完的節點變綠） -->
                      <span v-if="tryStateOf(item.id) === 'current'" class="scripts-q__try is-current">試的客人在這一題</span>
                      <span v-else-if="tryStateOf(item.id) === 'walked'" class="scripts-q__try">✓ 試的時候走過</span>
                      <span class="scripts-q__head-end">
                        <el-checkbox
                          v-if="item.type === 'collect' && item.fieldName.trim()"
                          :model-value="savedFields.includes(item.fieldName)"
                          :disabled="!canEditScripts"
                          class="scripts-q__save"
                          title="後台客人資料看得到，之後回覆也能帶入"
                          @change="toggleSavedField(item.fieldName, Boolean($event))"
                        >存進客人資料</el-checkbox>
                        <AdminMoreMenu v-if="canEditScripts" variant="row" :items="questionMenuItems(item, i)" @command="onQuestionMenu(item, i, $event)" />
                      </span>
                    </div>
                    <VariableTextField
                      v-model="item.question"
                      mode="script"
                      :known-keys="scriptVariableKeys"
                      :placeholder="item.type === 'collect' ? '例：請問您的訂單編號是？' : '例：請問需要哪項服務？'"
                    />
                    <el-input v-if="item.type === 'collect' && item.format === 'custom'" v-model="item.pattern" placeholder="進階比對規則，例：[A-Za-z]\d{3,}（訂單編號 A123）" />

                    <p v-if="qList.unreachable.has(item.id)" class="scripts-q__unreached">客人走不到這一題：沒有哪一題、哪顆按鈕接到這裡。</p>

                    <!-- 照順序的路不寫出來；只有設了跳題、看答案走不同路、客人說沒有、格式不對時的話、或要提醒的才多一行 -->
                    <div v-if="item.type === 'collect' && (isJumpShown(item, i) || qList.branches.has(item.id) || isSkipOpen(item) || isReaskShown(item) || (canEditScripts && isStuckCollect(item)))" class="scripts-q__routes">
                      <!--
                        看答案走不同路（`D-150`①，示意第⑨張）：一行一條，跟按鈕「按鈕字 → 去哪」同一個寫法，取代「答了 →」。
                        由上往下比，第一條符合的就走它；都不符合走「其他答案」。
                      -->
                      <template v-if="qList.branches.has(item.id)">
                        <div v-for="{ r, c } in caseRows(item)" :key="`case${r.index}`" class="scripts-q__route">
                          <el-select :model-value="c.op" class="scripts-q__op" @change="setCaseOp(c, $event)">
                            <el-option label="答案是" value="equals" />
                            <el-option label="答案裡有" value="contains" />
                            <el-option v-if="c.op === 'exists'" label="有回答" value="exists" />
                          </el-select>
                          <span v-if="c.field !== item.fieldName" class="scripts-q__route-label">看「{{ fieldLabel(c.field) || '…' }}」</span>
                          <el-input v-if="c.op !== 'exists'" v-model="c.value" maxlength="40" placeholder="例：VIP" class="scripts-q__value" />
                          <span class="scripts-q__route-label">→</span>
                          <el-select :model-value="r.target || undefined" placeholder="去哪…" class="scripts-q__target" @change="onListTarget($event, (id) => retarget(item, r, id))">
                            <el-option v-for="t in listTargets(i, r.target)" :key="t.value" :label="t.label" :value="t.value" />
                          </el-select>
                          <AdminScriptRouteTags :tag-ids="routeTagIds(r)" :options="tagList" :can-edit="canEditScripts" :can-add="false" @update="setRowTags(item, r, $event)" />
                          <el-button v-if="canEditScripts" text type="danger" class="scripts-q__x" title="拿掉這一條" @click="dropBranchCase(item, r.index)">✕</el-button>
                          <span v-if="isBackwardTarget(qList, i, r.target)" class="scripts-q__warn">會跳回前面那一題，客人要重答</span>
                        </div>
                        <div v-for="r in routesOfKind(item, 'other')" :key="r.kind" class="scripts-q__route">
                          <!-- 跟上面「答案是 … →」同寬，去哪那一格才對得齊 -->
                          <span class="scripts-q__route-label scripts-q__other">其他答案</span>
                          <span class="scripts-q__route-label">→</span>
                          <el-select :model-value="r.target || undefined" placeholder="去哪…" class="scripts-q__target" @change="onListTarget($event, (id) => retarget(item, r, id))">
                            <el-option v-for="t in listTargets(i, r.target)" :key="t.value" :label="t.label" :value="t.value" />
                          </el-select>
                          <AdminScriptRouteTags :tag-ids="routeTagIds(r)" :options="tagList" :can-edit="canEditScripts" :can-add="false" @update="setRowTags(item, r, $event)" />
                          <span v-if="canEditScripts" class="scripts-q__x-slot" aria-hidden="true" />
                          <span v-if="isBackwardTarget(qList, i, r.target)" class="scripts-q__warn">會跳回前面那一題，客人要重答</span>
                        </div>
                        <div v-if="canEditScripts"><el-button size="small" plain @click="addBranchCase(qList, item)">＋ 再加一條</el-button></div>
                      </template>
                      <div v-for="r in (isJumpShown(item, i) ? routesOfKind(item, 'answer') : [])" :key="r.kind" class="scripts-q__route">
                        <span class="scripts-q__route-label">答了 →</span>
                        <el-select :model-value="r.target || undefined" placeholder="去哪…" class="scripts-q__target" @change="onListTarget($event, (id) => retarget(item, r, id))">
                          <el-option v-for="t in listTargets(i, r.target)" :key="t.value" :label="t.label" :value="t.value" />
                        </el-select>
                        <AdminScriptRouteTags :tag-ids="routeTagIds(r)" :options="tagList" :can-edit="canEditScripts" :can-add="false" @update="setRowTags(item, r, $event)" />
                        <el-button v-if="canEditScripts && canResetJump(i)" text type="danger" title="拿掉跳題，改回照順序（接下一題）" @click="resetJump(item, i)">✕</el-button>
                        <span v-if="isBackwardTarget(qList, i, r.target)" class="scripts-q__warn">會跳回前面那一題，客人要重答</span>
                      </div>
                      <div v-if="isSkipOpen(item)" class="scripts-q__route">
                        <span class="scripts-q__route-label">客人說沒有 →</span>
                        <el-input v-model="item.skipLabel" maxlength="20" placeholder="按鈕字，例：我沒有訂單編號" class="scripts-q__button-label" />
                        <el-select :model-value="routesOfKind(item, 'skip')[0]?.target || undefined" placeholder="前往…" class="scripts-q__target" @change="onListTarget($event, (id) => retargetSkip(item, id))">
                          <el-option v-for="t in listTargets(i, routesOfKind(item, 'skip')[0]?.target)" :key="t.value" :label="t.label" :value="t.value" />
                        </el-select>
                        <el-button v-if="canEditScripts" text type="danger" title="拿掉這條路" @click="clearCollectSkip(item)">✕</el-button>
                        <span v-if="isBackwardTarget(qList, i, routesOfKind(item, 'skip')[0]?.target ?? '')" class="scripts-q__warn">會跳回前面那一題，客人要重答</span>
                      </div>
                      <button
                        v-else-if="canEditScripts && isStuckCollect(item)"
                        type="button"
                        class="scripts-skip-add is-suggested"
                        @click="openCollectSkip(item, i)"
                      >
                        ⚠ 這種編號客人手上可能根本沒有，沒給路會被一直重問　<b>＋ 客人說沒有的話…</b>
                      </button>
                      <div v-if="isReaskShown(item)" class="scripts-q__route">
                        <span class="scripts-q__route-label">格式不對 →</span>
                        <el-input v-model="item.reaskText" :placeholder="`再問這句（留空：${DEFAULT_COLLECT_REASK}）`" class="scripts-q__reask" />
                        <el-button v-if="canEditScripts" text type="danger" title="拿掉，改用預設那句" @click="clearReask(item)">✕</el-button>
                      </div>
                    </div>
                    <!-- 一顆一列「按鈕字 → 去哪」；按了就貼標籤（`D-150`②）貼在那一列上 -->
                    <div v-else-if="item.type === 'quickReply'" class="scripts-q__routes">
                      <div v-for="{ o, r } in optionRows(item)" :key="r.index" class="scripts-q__route">
                        <el-input v-model="o.label" maxlength="20" placeholder="按鈕字" class="scripts-q__button-label" />
                        <span class="scripts-q__route-label">→</span>
                        <el-select :model-value="r.target || undefined" placeholder="去哪…" class="scripts-q__target" @change="onListTarget($event, (id) => retarget(item, r, id))">
                          <el-option v-for="t in listTargets(i, r.target)" :key="t.value" :label="t.label" :value="t.value" />
                        </el-select>
                        <AdminScriptRouteTags :tag-ids="routeTagIds(r)" :options="tagList" :can-edit="canEditScripts" :can-add="canEditScripts" @update="setRowTags(item, r, $event)" />
                        <el-button v-if="canEditScripts" text type="danger" title="拿掉這顆按鈕" @click="removeListOption(item, r)">✕</el-button>
                        <span v-if="isBackwardTarget(qList, i, r.target)" class="scripts-q__warn">會跳回前面那一題</span>
                      </div>
                      <div v-if="canEditScripts"><el-button size="small" plain @click="addQuickReplyOption(item, orderNextOf(qList, i))">＋ 新增按鈕</el-button></div>
                    </div>
                  </div>

                  <!-- `D-150`：「依答案走不同路…」（切到流程圖編法）拿掉了——看答案分路在每一題的「⋯」裡 -->
                  <div v-if="canEditScripts" class="scripts-q__add" data-tour="scr-grow">
                    <el-button plain @click="addListQuestion('collect')">＋ 再問一題</el-button>
                    <el-button plain @click="addListQuestion('quickReply')">＋ 給客人按鈕選</el-button>
                  </div>
                </div>
              </section>

              <!--
                ── 最後 ──
                `D-149`：可以有好幾種結尾（服務分流那種：按不同按鈕回不同的話）。只有一種時長得跟以前一樣；
                好幾種時每一種一張小卡，標題跟著「哪顆按鈕／哪一題」走到這裡，內容跟一種的時候一模一樣。
              -->
              <section
                class="message-card scripts-section-card"
                :class="{ 'is-focused': qList.endings.length === 1 && highlightStep === qList.terminal.id }"
                :data-node-id="qList.endings.length === 1 ? qList.terminal.id : undefined"
              >
                <div class="message-card-header">
                  <div class="card-header-main">
                    <span class="section-title">最後</span>
                    <span v-if="qList.endings.length > 1" class="text-xs text-muted">看客人怎麼走，有 {{ qList.endings.length }} 種</span>
                  </div>
                </div>
                <div class="card-section-stack">
                <div
                  v-for="(ending, ei) in qList.endings"
                  :key="ending.terminal.id"
                  class="scripts-ending"
                  :class="{ 'is-many': qList.endings.length > 1, 'is-focused': qList.endings.length > 1 && highlightStep === ending.terminal.id, 'is-unreached': qList.unreachable.has(ending.entryId) }"
                  :data-node-id="qList.endings.length > 1 ? ending.terminal.id : undefined"
                >
                  <div v-if="qList.endings.length > 1" class="scripts-ending__head">
                    <span class="scripts-ending__mark" aria-hidden="true" />
                    <b :class="{ 'is-orphan': !endingSources(ending).length }">{{ endingTitle(ending) }}</b>
                    <span class="scripts-q__head-end">
                      <AdminMoreMenu
                        v-if="canEditScripts"
                        variant="row"
                        :items="[{ command: 'remove', label: '刪除這個結尾', danger: true }]"
                        @command="removeListEnding(ending)"
                      />
                    </span>
                  </div>
                  <p v-if="qList.unreachable.has(ending.entryId)" class="scripts-q__unreached">客人走不到這一段，這句不會送出。</p>
                  <template v-if="ending.terminal.type === 'reply'">
                    <div class="admin-field-group" :data-tour="ei === 0 ? 'scr-reply' : undefined">
                      <AdminFieldLabel text="回客人" tight />
                      <VariableTextField
                        v-model="ending.terminal.text"
                        type="textarea"
                        mode="script"
                        :known-keys="scriptVariableKeys"
                        :rows="3"
                        placeholder="例：已收到您的資訊，我們會盡快為您處理 🙇"
                      />
                      <el-dropdown v-if="canEditScripts" size="small" trigger="click" class="scripts-var-insert" @command="insertEndingReplyVar(ending, $event)">
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
                    <div v-if="ending.terminal.linkUrl !== undefined" class="admin-field-group">
                      <AdminFieldLabel text="附一顆連結按鈕（選填）" tight />
                      <div class="scripts-branch-case scripts-branch-case--map">
                        <span class="text-xs text-muted">網址</span>
                        <el-input v-model="ending.terminal.linkUrl" placeholder="https://…（可插入客人回答的）" class="scripts-branch-field" />
                        <span class="text-xs text-muted">按鈕字</span>
                        <el-input v-model="ending.terminal.linkLabel" maxlength="20" :placeholder="DEFAULT_REPLY_LINK_LABEL" class="scripts-branch-field" />
                        <el-button v-if="canEditScripts" type="danger" plain class="scripts-branch-remove" title="移除連結按鈕" @click="clearReplyLink(ending.terminal)">✕</el-button>
                      </div>
                      <p class="scripts-section-hint">會在回覆下面多送一則帶按鈕的訊息。網址要以 https:// 開頭。</p>
                    </div>
                    <el-checkbox v-model="ending.terminal.thenHandoff">回完交給真人</el-checkbox>
                    <p v-if="ending.terminal.thenHandoff" class="scripts-section-hint">下班時間會在同一則補上幾點起回覆，不會另外再送一則。</p>
                  </template>
                  <div v-else class="admin-field-group">
                    <AdminFieldLabel text="送出哪個模組" tight />
                    <div v-if="modulesLoading" class="text-xs text-muted">載入中…</div>
                    <AdminFlowPicker v-else :model-value="ending.terminal.moduleId" :options="moduleOptions" placeholder="選擇模組（可打字搜尋）" @update:model-value="setEndingModule(ending, $event)" />
                    <p class="scripts-section-hint">送出你在「機器人模組」做好的那一組訊息。若那是「真人客服」模組，會照常轉真人。</p>
                  </div>

                  <!-- 「存進客人資料」2026-10-22 搬到每一題上（`D-140`），這裡不再列一排 -->

                  <div v-if="ending.tag" class="admin-field-group">
                    <AdminFieldLabel text="替客人貼上標籤" tight />
                    <div class="scripts-q__route">
                      <AdminTagPicker
                        :model-value="ending.tag.addTagIds"
                        :options="tagList"
                        placeholder="選擇標籤（可多選、可打字搜尋）"
                        class="scripts-q__tags"
                        @update:model-value="setEndingTags(ending, $event)"
                      />
                      <el-button v-if="canEditScripts" text type="danger" title="不貼標籤了" @click="removeListTag(ending)">✕</el-button>
                    </div>
                  </div>

                  <div v-if="canEditScripts" class="scripts-q__add">
                    <button v-if="ending.terminal.type === 'reply' && ending.terminal.linkUrl === undefined" type="button" class="scripts-skip-add" @click="openEndingLink(ending)">＋ 附一顆連結按鈕</button>
                    <button v-if="!ending.tag" type="button" class="scripts-skip-add" @click="addListTag(ending)">＋ 貼標籤</button>
                    <button type="button" class="scripts-skip-add" @click="toggleTerminalKind(ending)">{{ ending.terminal.type === 'reply' ? '＋ 改送一個模組' : '改回一段文字' }}</button>
                  </div>
                </div>
                </div>
              </section>

              <!--
                ── 排不進清單的步驟（`D-150`③）──
                舊資料、AI 草稿、改到一半留下的：照樣列出來標黃，⛔ 不換一套畫面。客人走得到的照樣會經過，
                要改就刪掉、在上面用題目卡重做；走不到的刪掉就好。
              -->
              <section v-if="qList.strays.length" class="message-card scripts-section-card" data-tour="scr-strays">
                <div class="message-card-header">
                  <div class="card-header-main">
                    <span class="section-title">排不進清單的步驟</span>
                  </div>
                </div>
                <div class="card-section-stack">
                  <div v-for="s in qList.strays" :key="s.node.id" class="scripts-stray" :class="{ 'is-focused': highlightStep === s.node.id }" :data-node-id="s.node.id">
                    <div class="scripts-stray__head">
                      <b>{{ strayLabel(s.node) }}</b>
                      <el-button v-if="canEditScripts" size="small" type="danger" plain @click="removeStray(form.nodes, s.node.id)">刪除這一步</el-button>
                    </div>
                    <span>{{ s.reachable ? '客人照樣會經過這一步，只是排不進上面的清單；要改就刪掉，在上面重做。' : '沒有路接到這一步，客人走不到。' }}</span>
                  </div>
                </div>
              </section>
            </template>

            <!-- 只有連開頭或結尾都沒有（資料壞掉）才會到這裡：講清楚、給一顆補回來的按鈕 -->
            <section v-else class="message-card scripts-section-card">
              <div class="card-section-stack">
                <el-alert type="warning" :closable="false" show-icon title="這一條少了開頭或結尾，客人走不完">
                  補一個「回客人」當結尾，再接著設定。
                </el-alert>
                <div v-if="canEditScripts"><el-button type="primary" plain @click="repairMissingEnds">補一個結尾</el-button></div>
              </div>
            </section>
          </el-form>
        </div>

        <div class="scripts-side">
          <!-- `D-142` 路線：有岔路才畫（直線流程的清單本身就是那張圖）；點一站捲到左邊那一題 -->
          <AdminScriptRouteMap
            v-if="routeView"
            :map="routeView.map"
            :stations="routeView.stations"
            :station-of="routeView.stationOf"
            :visited="tryProgress.visited"
            :current="tryProgress.current"
            :flagged="flaggedNodeIds"
            @jump="focusStep"
          />
          <!-- 換一條（或新開一條）就整個重來：試到一半的對話不該帶到另一條去 -->
          <AdminScriptTryPanel
            :key="tryKey"
            :script-id="selectedId"
            :name="form.name"
            :enabled="form.enabled"
            :priority="form.priority"
            :nodes="form.nodes"
            :root-node-id="form.rootNodeId"
            :module-options="moduleOptions"
            @progress="tryProgress = $event"
          />
        </div>
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
import { CircleCheckFilled, CircleCloseFilled, CopyDocument, Delete, Operation, Plus, WarningFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { confirmSaveBeforeCopy } from '~/utils/confirm-save-before-copy'
import { v4 as uuidv4 } from 'uuid'
import {
  BUILTIN_SCRIPT_VARIABLES,
  FOLLOW_WELCOME_LABEL,
  followWelcomeRow,
} from '~~/shared/follow-welcome'
import { DISPLAY_NAME_VARIABLE_OPTION, SCRIPT_PRESET_FIELD_LABELS } from '~~/shared/variable-tokens'
import {
  addBranch,
  addBranchCase,
  addEnding,
  appendQuestion,
  endingOfNode,
  insertEndStep,
  isBackwardTarget,
  isOrderTarget,
  moveQuestion,
  orderNextOf,
  removeBranchCase,
  removeEndStep,
  removeEnding,
  removeQuestion,
  removeStray,
  replaceTerminal,
  routesOf,
  setRouteTags,
  setRouteTarget,
  startFirst,
  toQuestionList,
  type QuestionEnding,
  type QuestionItem,
  type QuestionRoute,
} from '~~/shared/script-question-list'
import { buildRouteMap, type RouteStation } from '~~/shared/script-route-map'
import type {
  BranchOp,
  CollectFormat,
  ScriptBranchCase,
  ScriptCollectNode,
  ScriptDoc,
  ScriptNode,
  ScriptQuickReplyNode,
  ScriptReplyNode,
  ScriptModuleNode,
  ScriptSaveLeadNode,
  ScriptTagNode,
  ScriptTriggerNode,
  TriggerMatchMode,
} from '~~/shared/types/ai-script'
import { DEFAULT_COLLECT_EXPIRE_MS, DEFAULT_COLLECT_REASK, DEFAULT_REPLY_LINK_LABEL, DEFAULT_SCRIPT_PRIORITY, MAX_TRIGGER_EXAMPLES, MAX_TRIGGER_EXCLUDES, SCRIPT_NODE_TYPE_LABELS, findPlaceholderTexts, findStuckCollects, scriptTriggerEvent, validateScriptDoc } from '~~/shared/types/ai-script'
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

/**
 * 預設「客人在問這類事（AI 判斷）」（2026-10-21 老闆「好」：介面上鼓勵用 AI 判斷）——
 * 比較不會漏接或接錯，而且這一步不算則數。要一字不差的（活動口令）才換成「客人打特定的字」。
 */
function defaultTriggerNode(nextId: string): ScriptTriggerNode {
  return { id: uuidv4(), type: 'trigger', matchMode: 'semantic', keywords: [], examples: [], priority: DEFAULT_SCRIPT_PRIORITY, next: nextId }
}
function defaultReplyNode(): ScriptReplyNode {
  return { id: uuidv4(), type: 'reply', text: '', thenHandoff: false }
}
function defaultCollectNode(nextId: string): ScriptCollectNode {
  return { id: uuidv4(), type: 'collect', question: '', fieldName: '', expireMs: DEFAULT_COLLECT_EXPIRE_MS, format: 'any', next: nextId }
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
 * 設定畫面只有一套：問答清單（`D-138`④；`D-150` 起流程圖編法拿掉）。
 * 2026-10-23 老闆「應該做成通用的版本，讓 UX 操作盡量一致，而不是這樣硬改」——以前清單不會畫的就退回流程圖編法，
 * 現在任何一份都排得進清單（看答案分路掛在題目上、路上的標籤掛在那條路上、排不進去的照樣列出來標黃）。
 * 只有連開頭或結尾都沒有（資料壞掉）才是 null，畫面講清楚、給一顆補回來的按鈕。
 */
const qList = computed(() => toQuestionList(form.value.nodes, form.value.rootNodeId))

/** 這一題往外的路（某一種）；路線、去處、路上的標籤都從這裡讀 */
function routesOfKind(item: QuestionItem, kind: QuestionRoute['kind']): QuestionRoute[] {
  return qList.value ? routesOf(qList.value, item).filter(r => r.kind === kind) : []
}
/** 按鈕題：一顆一列（按鈕本身＋它那條路） */
function optionRows(item: ScriptQuickReplyNode) {
  return routesOfKind(item, 'option').flatMap(r => (item.options[r.index] ? [{ o: item.options[r.index]!, r }] : []))
}
/** 看答案走不同路：一條一列（條件本身＋它那條路） */
function caseRows(item: ScriptCollectNode) {
  const branch = qList.value?.branches.get(item.id)
  return routesOfKind(item, 'case').flatMap(r => (branch?.cases[r.index] ? [{ c: branch.cases[r.index]!, r }] : []))
}
/** 改一條路去哪（路上貼了標籤的，標籤照貼） */
function retarget(item: QuestionItem, route: QuestionRoute, id: string) {
  if (qList.value) setRouteTarget(qList.value, item, route, id)
}
/** 「客人說沒有 →」去哪：剛按開、還沒選過時那條路還不存在，直接寫 */
function retargetSkip(item: ScriptCollectNode, id: string) {
  const r = routesOfKind(item, 'skip')[0]
  if (r) retarget(item, r, id)
  else item.skipNext = id
}

// ── 好幾種結尾（`D-149`）：每一種叫什麼，跟著「哪顆按鈕／哪一題」走到這裡 ──
interface EndingSource { kind: 'answer' | 'button'; text: string }
function endingSources(ending: QuestionEnding): EndingSource[] {
  const out: EndingSource[] = []
  const view = qList.value
  if (!view) return out
  view.items.forEach((it, i) => {
    for (const r of routesOf(view, it)) {
      if (r.target !== ending.entryId) continue
      if (r.kind === 'answer') out.push({ kind: 'answer', text: `第 ${i + 1} 題答完` })
      else if (r.kind === 'other') out.push({ kind: 'answer', text: `第 ${i + 1} 題其他答案` })
      else if (r.kind === 'case') out.push({ kind: 'answer', text: `答「${caseText(view.branches.get(it.id)?.cases[r.index])}」` })
      else if (r.kind === 'skip' && it.type === 'collect' && it.skipLabel?.trim()) out.push({ kind: 'button', text: it.skipLabel.trim() })
      else if (r.kind === 'option' && it.type === 'quickReply') out.push({ kind: 'button', text: it.options[r.index]?.label.trim() || '（空白按鈕）' })
    }
  })
  return out
}
/** 短的名字（路線圖那一站、「去哪」下拉）：出貨查詢／第 2 題答完 */
function endingShortLabel(ending: QuestionEnding): string {
  const s = endingSources(ending)
  if (!s.length) return '還沒有路接到這裡'
  return s.length > 1 ? `${s[0]!.text} 等` : s[0]!.text
}
/** 小卡標題：按「出貨查詢」之後／第 2 題答完之後 */
function endingTitle(ending: QuestionEnding): string {
  const s = endingSources(ending)
  if (!s.length) return '還沒有路接到這裡（選一顆按鈕或一題接過來）'
  const first = s[0]!.kind === 'button' ? `按「${s[0]!.text}」之後` : `${s[0]!.text}之後`
  return s.length > 1 ? `${first}（另有 ${s.length - 1} 條路也到這裡）` : first
}

/** 「去哪」下拉的最後一項：多一種結尾 */
const NEW_ENDING = '__new_ending__'
/** 「去哪」下拉改了：選「＋ 新的結尾」就先建一種結尾再接過去，捲到那張小卡 */
function onListTarget(value: string | number | boolean | undefined, assign: (id: string) => void) {
  const v = String(value ?? '')
  const view = qList.value
  if (v !== NEW_ENDING || !view) { assign(v); return }
  const terminal = defaultReplyNode()
  assign(addEnding(form.value.nodes, view, terminal, defaultSaveLeadNode('')))
  focusStep(terminal.id)
}

/** 拿掉一種結尾：指到它的路改去第一種（如果拿掉的就是第一種，改去第二種）；寫了字的先問 */
async function removeListEnding(ending: QuestionEnding) {
  const view = qList.value
  if (!view || view.endings.length < 2) return
  const fallback = view.endings.find(e => e.entryId !== ending.entryId)!
  const hasText = ending.terminal.type === 'reply' ? Boolean(ending.terminal.text.trim()) : Boolean(ending.terminal.moduleId)
  if (hasText) {
    const ok = await ElMessageBox.confirm(`接到這裡的路會改去「${endingShortLabel(fallback)}」那一種。`, '刪除這個結尾', { confirmButtonText: '刪除', cancelButtonText: '先不要', type: 'warning' })
      .then(() => true).catch(() => false)
    if (!ok) return
  }
  removeEnding(form.value.nodes, view, ending.entryId, fallback.entryId)
}

// ── 看答案走不同路（`D-150`①）：掛在那一題上，一行一條 ──
/** 一條的答案怎麼講（結尾小卡標題、路線圖用）：答案是／答案裡有都講填的那幾個字 */
function caseText(c: ScriptBranchCase | undefined): string {
  if (!c) return ''
  if (c.op === 'exists') return '有回答'
  return String(c.value ?? '').trim() || '…'
}
/** 換比對方式：切到「有回答」不需要答案，清掉殘留免得切回時冒出舊值 */
function setCaseOp(c: ScriptBranchCase, op: string | number | boolean | undefined) {
  const next: BranchOp = op === 'equals' || op === 'contains' ? op : 'exists'
  c.op = next
  if (next === 'exists') c.value = ''
}
/** 拿掉一條；拿光了就是不看答案了（這一題答了直接去「其他答案」那裡） */
function dropBranchCase(item: ScriptCollectNode, index: number) {
  if (qList.value) removeBranchCase(form.value.nodes, qList.value, item, index)
}
/** 「⋯ → 看答案走不同路」：先給一條空的、游標放進答案那格 */
function openBranch(item: ScriptCollectNode) {
  addBranch(form.value.nodes, item, uuidv4())
  nextTick(() => document.querySelector<HTMLInputElement>(`[data-node-id="${item.id}"] .scripts-q__value input`)?.focus())
}

// ── 路上貼標籤（`D-150`②）：按了那顆按鈕就貼（一列只放小膠囊，選標籤在點開的小視窗：AdminScriptRouteTags） ──
/** 這條路上現在貼哪些（路上有好幾個標籤步驟時合在一起看） */
function routeTagIds(r: QuestionRoute): string[] {
  return [...new Set(r.tags.flatMap(t => t.addTagIds))]
}
function setRowTags(item: QuestionItem, r: QuestionRoute, ids: string[]) {
  if (qList.value) setRouteTags(form.value.nodes, qList.value, item, r, ids, uuidv4())
}
/** 拿掉一顆按鈕：它路上的標籤一起拿掉 */
function removeListOption(item: ScriptQuickReplyNode, r: QuestionRoute) {
  if (r.tags.length && qList.value) setRouteTags(form.value.nodes, qList.value, item, r, [], '')
  removeQuickReplyOption(item, r.index)
}

// ── 排不進清單的步驟（`D-150`③）──
/** 那一步是什麼：照畫面上的叫法講，帶一點內容讓他認得出來 */
function strayLabel(node: ScriptNode): string {
  if (node.type === 'branch') return `${SCRIPT_NODE_TYPE_LABELS.branch}（看「${fieldLabel(node.cases[0]?.field ?? '') || '…'}」）`
  if (node.type === 'saveLead') return `${SCRIPT_NODE_TYPE_LABELS.saveLead}（${node.fieldMap.map(m => m.attrKey || fieldLabel(m.fromField)).join('、') || '…'}）`
  if (node.type === 'tag') return `${SCRIPT_NODE_TYPE_LABELS.tag}（${node.addTagIds.map(id => tagList.value.find(t => t.id === id)?.name ?? id).join('、') || '…'}）`
  if (node.type === 'trigger') return `多出來的「${SCRIPT_NODE_TYPE_LABELS.trigger}」`
  return SCRIPT_NODE_TYPE_LABELS[node.type] ?? '步驟'
}
/** 資料壞掉（沒有開頭或結尾）：補一個開頭／一個「回客人」，接上去 */
function repairMissingEnds() {
  const nodes = form.value.nodes
  let trigger = triggerNode.value
  if (!trigger) {
    trigger = defaultTriggerNode('')
    nodes.unshift(trigger)
    form.value.rootNodeId = trigger.id
  }
  if (!nodes.some(n => n.type === 'reply' || n.type === 'module')) {
    const reply = defaultReplyNode()
    nodes.push(reply)
    if (!trigger.next || !nodes.some(n => n.id === trigger!.next)) trigger.next = reply.id
  }
}

/** 這一題的名字：常用欄位講中文（不露出 order_id），自己命名的照他取的名字 */
function fieldLabel(fieldName: string): string {
  return SCRIPT_PRESET_FIELD_LABELS[fieldName] ?? fieldName
}
function listItemLabel(item: QuestionItem): string {
  if (item.type === 'collect') return fieldLabel(item.fieldName) || item.question.slice(0, 12) || '（還沒選）'
  return `給按鈕選「${item.question.slice(0, 8) || '…'}」`
}

/**
 * 「答了 →」「客人說沒有 →」「按鈕 →」可以去哪：後面的題目，或直接到最後（`D-140`：跳題只往後，同 Typeform、Microsoft Forms）。
 * 換順序之後已經變成往回跳的那個（current）照樣列出來，下拉才顯示得出它現在接哪、旁邊標紅。
 */
function listTargets(index: number, current?: string): Array<{ value: string; label: string }> {
  const view = qList.value
  if (!view) return []
  const out = view.items
    .map((it, k) => ({ it, k }))
    .filter(({ it, k }) => k > index || (current !== undefined && it.id === current))
    .map(({ it, k }) => ({ value: it.id, label: `第 ${k + 1} 題・${listItemLabel(it)}${k === index + 1 ? '（下一題）' : k <= index ? '（往回）' : ''}` }))
  // 一種結尾＝「直接到最後」；好幾種＝每一種一項（`D-149`）
  if (view.endings.length === 1) out.push({ value: view.endId, label: '直接到最後' })
  else for (const e of view.endings) out.push({ value: e.entryId, label: `最後：${endingShortLabel(e)}` })
  // 接到排不進清單的步驟（`D-150`③）：照實列出來，下拉才顯示得出它現在接哪
  const stray = current ? view.strays.find(s => s.node.id === current) : undefined
  if (stray) out.push({ value: stray.node.id, label: `排不進清單的一步：${strayLabel(stray.node)}` })
  if (canEditScripts.value) out.push({ value: NEW_ENDING, label: '＋ 新的結尾（這條路回不一樣的話）' })
  return out
}

/**
 * 「答了 →」那一行要不要出現：沒照順序（設了跳題）、路上貼了標籤、或剛從「⋯」按了「答了改跳到別題」；
 * 看答案走不同路的那一題沒有「答了 →」（每一條、其他答案取代它）
 */
const openedJumps = ref<Set<string>>(new Set())
function isJumpShown(item: ScriptCollectNode, index: number): boolean {
  const view = qList.value
  if (!view || view.branches.has(item.id)) return false
  const r = routesOf(view, item).find(x => x.kind === 'answer')
  return Boolean(r) && (!isOrderTarget(view, index, r!.target) || r!.tags.length > 0 || openedJumps.value.has(item.id))
}
/** 「答了 →」的 ✕（改回照順序）：好幾種結尾時最後一題沒有「照順序」可回（去哪一種一定是選的） */
function canResetJump(index: number): boolean {
  const view = qList.value
  return Boolean(view) && isOrderTarget(view!, index, orderNextOf(view!, index))
}
function resetJump(item: ScriptCollectNode, index: number) {
  const view = qList.value
  const r = view && routesOf(view, item).find(x => x.kind === 'answer')
  if (!view || !r) return
  setRouteTarget(view, item, r, orderNextOf(view, index))
  const next = new Set(openedJumps.value)
  next.delete(item.id)
  openedJumps.value = next
}

/** 每一題的「⋯」：次要動作都收在這裡（同全站），刪除排最後 */
function questionMenuItems(item: QuestionItem, index: number) {
  const last = (qList.value?.items.length ?? 1) - 1
  const isCollect = item.type === 'collect'
  const hasBranch = Boolean(qList.value?.branches.has(item.id))
  return [
    { command: 'jump', label: '答了改跳到別題', show: isCollect && !hasBranch && !isJumpShown(item, index) },
    { command: 'skip', label: '客人可能沒有這個資料', show: isCollect && !isSkipOpen(item) },
    // `D-150`①：看客人答什麼走不同路（示意第⑨張，排在「客人可能沒有」後面）
    { command: 'branch', label: '看答案走不同路', show: isCollect && !hasBranch },
    { command: 'format', label: '改答案格式', show: isCollect && !isFormatShown(item) },
    { command: 'reask', label: '格式不對時怎麼問', show: isCollect && canReask(item) && !isReaskShown(item) },
    { command: 'up', label: '上移', show: index > 0 },
    { command: 'down', label: '下移', show: index < last },
    { command: 'remove', label: '刪除這一題', danger: true },
  ]
}
function onQuestionMenu(item: QuestionItem, index: number, cmd: string) {
  if (cmd === 'jump' && item.type === 'collect') openedJumps.value = new Set(openedJumps.value).add(item.id)
  else if (cmd === 'skip' && item.type === 'collect') openCollectSkip(item, index)
  else if (cmd === 'branch' && item.type === 'collect') openBranch(item)
  else if ((cmd === 'format' || cmd === 'reask') && item.type === 'collect') openCollectExtra(item, cmd)
  else if (cmd === 'up') moveListItem(index, index - 1)
  else if (cmd === 'down') moveListItem(index, index + 1)
  else if (cmd === 'remove') removeListItem(item.id)
}

/** 換順序（拖曳或上移下移）：規則在 moveQuestion——照順序的跟著新順序、指定的跳題不變；換完捲過去亮一下 */
function moveListItem(from: number, to: number) {
  const view = qList.value
  const moved = view?.items[from]
  if (!view || !moved) return
  moveQuestion(form.value.nodes, view, from, to)
  focusStep(moved.id)
}

// 拖曳：⠿ 是拖的把手、整張卡是放的地方（同機器人模組的訊息卡）
const qDragFrom = ref<number | null>(null)
const qDragOver = ref<number | null>(null)
function onQDragStart(e: DragEvent, index: number) {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    // 拖的是整張卡的樣子，不是那個小把手
    const card = (e.target as HTMLElement | null)?.closest('.scripts-q')
    if (card) e.dataTransfer.setDragImage(card, 24, 20)
  }
  // 同機器人模組：dragstart 當下改 DOM（加 class）Chrome 會把拖曳取消，晚一拍再標
  requestAnimationFrame(() => { qDragFrom.value = index })
}
function onQDragOver(index: number) {
  if (qDragFrom.value !== null) qDragOver.value = index
}
function onQDrop(index: number) {
  const from = qDragFrom.value
  onQDragEnd()
  if (from !== null && from !== index) moveListItem(from, index)
}
function onQDragEnd() {
  qDragFrom.value = null
  qDragOver.value = null
}

/** 客人可能拿截圖回答的那種（編號、序號）：旁邊講一句「傳截圖也算回答」（`D-138`②） */
function isCodeFormat(item: ScriptCollectNode): boolean {
  return ['alphanumeric', 'alphanumericSymbol', 'number', 'custom'].includes(item.format ?? 'any')
}

/** 答案格式（自己命名的那題直接給選；常用欄位挑了就帶好，要改從「⋯」） */
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
/** 有勾「存進客人資料」的題目：好幾種結尾時每一種都有自己的那一步（`D-149`），任何一種有就算勾了 */
const savedFields = computed(() => [...new Set((qList.value?.endings ?? []).flatMap(e => (e.saveLead?.fieldMap ?? []).map(m => m.fromField)))].filter(Boolean))

/** 每一題上的「存進客人資料」勾選（`D-140` 從「最後」那一排搬上來；存法照舊走 setSavedFields） */
function toggleSavedField(field: string, on: boolean) {
  const others = savedFields.value.filter(f => f !== field)
  setSavedFields(on ? listFields.value.map(f => f.value).filter(f => f === field || others.includes(f)) : others)
}

/**
 * 勾選要存的題目 ↔「存進客人資料」那一步：勾第一個時掛上去、全部取消就拿掉。
 * 已經存在的對應保留原本的名字（MYFEEL 的「訂單編號」「電話」），新勾的用這一題的中文名。
 * 好幾種結尾（`D-149`）：每一種都掛同一份——題目上勾的是「問到就存」，不管客人最後走到哪一種。
 */
function setSavedFields(values: Array<string | number | boolean>) {
  const picked = values.map(String)
  // 一種一種改：掛上或拿掉都會讓清單重新解讀，每次重抓目前的樣子
  const count = qList.value?.endings.length ?? 0
  for (let k = 0; k < count; k++) {
    const view = qList.value
    const ending = view?.endings[k]
    if (!view || !ending) return
    if (!ending.saveLead) {
      if (!picked.length) continue
      const node = defaultSaveLeadNode('')
      node.fieldMap = picked.map(f => ({ fromField: f, attrKey: fieldLabel(f) }))
      insertEndStep(form.value.nodes, view, node, ending)
      continue
    }
    const kept = ending.saveLead.fieldMap.filter(m => picked.includes(m.fromField))
    const added = picked.filter(f => !kept.some(m => m.fromField === f)).map(f => ({ fromField: f, attrKey: fieldLabel(f) }))
    const next = [...kept, ...added]
    if (next.length) ending.saveLead.fieldMap = next
    else removeEndStep(form.value.nodes, ending.saveLead.id)
  }
}

// ── 每一種結尾自己的貼標籤、模組、連結（`D-149`：以前只有一種，直接用 qList.tag／terminal） ──
function addListTag(ending: QuestionEnding) {
  const view = qList.value
  if (view && !ending.tag) insertEndStep(form.value.nodes, view, defaultTagNode(''), ending)
}
function removeListTag(ending: QuestionEnding) {
  if (ending.tag) removeEndStep(form.value.nodes, ending.tag.id)
}
function setEndingTags(ending: QuestionEnding, ids: string[]) {
  if (ending.tag) ending.tag.addTagIds = ids
}
function setEndingModule(ending: QuestionEnding, moduleId: string) {
  if (ending.terminal.type === 'module') ending.terminal.moduleId = moduleId
}
function openEndingLink(ending: QuestionEnding) {
  if (ending.terminal.type === 'reply') ending.terminal.linkUrl = ''
}
function insertEndingReplyVar(ending: QuestionEnding, field: string) {
  if (ending.terminal.type === 'reply') insertReplyVar(ending.terminal, field)
}

/** 結尾換成送一個模組／改回一段文字。回覆已經寫了字的先問一聲（換過去那段字就沒了） */
async function toggleTerminalKind(ending: QuestionEnding) {
  const view = qList.value
  if (!view) return
  if (ending.terminal.type === 'reply') {
    if (ending.terminal.text.trim()) {
      const ok = await ElMessageBox.confirm('改送一個模組的話，「回客人」那段字會清掉。', '改送模組', { confirmButtonText: '改送模組', cancelButtonText: '先不要', type: 'warning' })
        .then(() => true).catch(() => false)
      if (!ok) return
    }
    replaceTerminal(form.value.nodes, view, defaultModuleNode(), ending)
  }
  else {
    replaceTerminal(form.value.nodes, view, defaultReplyNode(), ending)
  }
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

/** 「不要接」那一格（一行一句，AdminLineListInput 已經整理好）：清空就拿掉這個欄位 */
function setExcludes(node: ScriptTriggerNode, list: string[]) {
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

/** 「怎樣才接」（`D-148`）：圓鈕給的值收回四種比對方式之一 */
function setKeywordMatch(node: ScriptTriggerNode, value: string | number | boolean | undefined) {
  const v = String(value)
  if (v === 'any' || v === 'all' || v === 'exact' || v === 'anyText') node.keywordMatch = v
}

/** 一行一個（`D-148`，同「客人會這樣講」那一格）：例子照比對方式換 */
function keywordPlaceholder(node: ScriptTriggerNode): string {
  const mode = node.keywordMatch ?? 'any'
  if (mode === 'all') return '例：\n訂單\n取消'
  if (mode === 'exact') return '例：\n抽獎\n週年慶'
  return '例：\n退貨\n退費'
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
      // 叫法同那一題卡片上的「＋ 客人說沒有的話…」（`D-149`②：以前這裡叫「退路」，卡片上叫另一個名字）
      text: `客人答不出「${what}」就出不去——這種編號他手上可能根本沒有，會被一直重問。建議在那一題設「客人說沒有」的路。`,
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
  // 兩種寫法對齊（`D-148`）：「我想查訂單」等 3 句／「抽獎」等 2 個關鍵字
  if (trig.keywordMatch === 'anyText') return '客人輸入任何內容'
  const kw = (trig.keywords ?? []).filter(Boolean)
  if (!kw.length) return '還沒填關鍵字'
  return kw.length > 1 ? `「${kw[0]}」等 ${kw.length} 個關鍵字` : `「${kw[0]}」`
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

// 點路線圖上的步驟 → 捲到下面對應的卡片並短暫高亮，讓「圖」和「編輯卡片」連成一個可導覽的流程
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

// 試跑（「試試看」）搬到右邊的 AdminScriptTryPanel（`D-138`）：換一條時靠 :key 整個重來。

/**
 * 試到哪了（`D-142`①，同 n8n 跑完的節點變綠）：左邊那張卡標「試的客人在這一題」、走過的標「試的時候走過」，
 * 右邊路線圖同一站亮起來。換一條（tryKey 變了）試試看整個重來，這裡跟著清空。
 */
const tryProgress = ref<{ visited: string[]; current: string | null }>({ visited: [], current: null })
watch(tryKey, () => { tryProgress.value = { visited: [], current: null } })
function tryStateOf(id: string): 'current' | 'walked' | null {
  if (tryProgress.value.current === id) return 'current'
  return tryProgress.value.visited.includes(id) ? 'walked' : null
}

/** 路線圖上一站的名字：比清單短（小卡只有一百多 px 寬），按鈕題不帶問句 */
function routeStationLabel(item: QuestionItem): string {
  return item.type === 'collect' ? (fieldLabel(item.fieldName) || '（還沒選）') : '給按鈕選'
}

/** 結尾站的小字：這一種結尾做什麼 */
function endingKindText(e: QuestionEnding): string {
  return e.terminal.type === 'module' ? '送模組' : e.terminal.thenHandoff ? '回覆・轉真人' : '回覆'
}
/**
 * 右邊路線圖要畫什麼（`D-142`／`D-149`／`D-150`）：題目與每一種結尾；看答案走不同路掛在題目上、不是一站。
 * 只在有岔路時畫（直線的清單本身就是那張圖）。
 */
const routeView = computed(() => {
  const view = qList.value
  if (!view) return null
  const map = buildRouteMap(view)
  if (!map.brackets.length) return null
  const n = view.items.length
  const many = view.endings.length > 1
  const stations: RouteStation[] = [
    ...view.items.map((it, i) => {
      const label = routeStationLabel(it)
      return { id: it.id, label, isEnd: false, title: `第 ${i + 1} 題・${label}`, jumpId: it.id }
    }),
    ...view.endings.map((e) => {
      const label = many ? endingShortLabel(e) : '最後'
      return { id: e.entryId, label, isEnd: true, sub: many ? '' : endingKindText(e), title: `${label}：${endingKindText(e)}`, jumpId: e.terminal.id }
    }),
  ]
  // 試試看走過的步驟算第幾站：看答案分路算它掛的那一題，結尾那一段的步驟算那一種結尾
  const branchOwner = new Map([...view.branches].map(([itemId, b]) => [b.id, itemId]))
  const stationOf = (id: string) => {
    const i = view.items.findIndex(it => it.id === (branchOwner.get(id) ?? id))
    if (i >= 0) return i
    const e = endingOfNode(view, id)
    return e ? n + view.endings.indexOf(e) : -1
  }
  return { map, stations, stationOf }
})

/**
 * 右邊試試看拉滿編輯區（2026-10-22 老闆：「高度拉滿然後 fixed，參考其他頁面」＝推播頁 `C-251`）。
 * 面板高度＝捲動區（`.split-editor-body`）看得到的高度，量出來交給 CSS——⛔ 不照推播頁寫死頁首高度：
 * 這頁頁首多一行「選填，沒填就用…」、唯讀時又少一行，寫死的數字會差一截、面板底對不齊。
 * ⛔ 也不用 container query 量：那要把捲動區設成 size container，而這頁的說明、貼標籤、挑模組小視窗
 *    沒有掛到 body 上，會被框在編輯區裡打開。
 * 同一個量法順便判寬窄：放不下「左邊約 450＋右邊 300＋左右留白」就照舊排到下面、跟著整頁捲。
 * 780＝1280 寬的筆電（編輯區 800）也並排；老闆 10-22 截圖那台編輯區約 849，改版前就是並排、右邊約 300 寬。
 */
const SCRIPTS_WIDE_MIN_PX = 780
const workspaceEl = ref<HTMLElement | null>(null)
const workspaceViewH = ref(0)
const workspaceWide = ref(true)
let workspaceObserver: ResizeObserver | null = null
watch(workspaceEl, (el) => {
  workspaceObserver?.disconnect()
  workspaceObserver = null
  const scroller = el?.closest<HTMLElement>('.split-editor-body')
  if (!scroller || typeof ResizeObserver === 'undefined') return
  workspaceObserver = new ResizeObserver(() => {
    workspaceViewH.value = scroller.clientHeight
    workspaceWide.value = scroller.clientWidth >= SCRIPTS_WIDE_MIN_PX
  })
  workspaceObserver.observe(scroller)
}, { flush: 'post' })
onBeforeUnmount(() => workspaceObserver?.disconnect())

/**
 * 換一份進編輯器時，把「展開了什麼」歸零、依內容重推欄位模式與編法（清單／流程圖）。
 * ⛔ 試試看的「重來」不碰這些：重置一個預覽不該把使用者剛展開的欄位收回去。
 */
function resetEditorDisclosure(nodes: ScriptNode[]) {
  openedSkips.value = new Set()
  openedExcludes.value = false
  syncFieldModes(nodes)
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

// ── 收集步驟：常用欄位 ──────────────────────────────────────────────
// 「給答案取個代號（order_id）」是整頁最像工程師介面的一格。改成挑常用欄位，
// 問句、格式、代號一次帶好；真的不在清單裡才手打。
const COMMON_COLLECT_FIELDS: Array<{ key: string; label: string; question: string; format: CollectFormat }> = [
  { key: 'order_id', label: '訂單編號', question: '請提供您的訂單編號 🙂', format: 'alphanumericSymbol' },
  { key: 'name', label: '姓名', question: '請問怎麼稱呼您？', format: 'any' },
  { key: 'phone', label: '電話', question: '請留下方便聯絡的電話 📞', format: 'phone' },
  { key: 'email', label: 'Email', question: '請留下您的 Email', format: 'email' },
  { key: 'address', label: '地址', question: '請提供您的收件地址', format: 'any' },
  // 2026-10-22：MYFEEL「新增備註」那題叫 note（AI 搭草稿取的），畫面上一直露出英文代號
  { key: 'note', label: '備註', question: '請問要備註的內容是？', format: 'any' },
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
/**
 * 打開「客人說沒有 →」。清單編法（傳了 index）先帶好：按鈕字「我沒有＋這一題的名字」、去向＝下一題
 * （`D-140`：別家的跳過按鈕預設也是去下一題）——不然一打開就是兩格空的、存檔被擋。流程圖編法照舊留空讓他接。
 */
function openCollectSkip(node: ScriptCollectNode, index?: number) {
  openedSkips.value = new Set(openedSkips.value).add(node.id)
  const view = qList.value
  if (index === undefined || !view) return
  if (!node.skipLabel?.trim() && node.fieldName.trim()) node.skipLabel = `我沒有${fieldLabel(node.fieldName)}`.slice(0, 20)
  if (!node.skipNext) node.skipNext = orderNextOf(view, index)
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

// ── 收集步驟：答案格式、格式不對時再問的那句 ─────────────────────────────
// 2026-10-22 補回：`C-366` 改版時這兩格從畫面上消失（報告沒有要拿掉），MYFEEL 開著的三條每一題都設了自己的那句，
// 客人照樣收得到、後台卻看不到也改不了。照 `D-140` 的規矩收在「⋯」：有設定的（或常用欄位的格式被改過）打開就露出來。
const openedFormats = ref<Set<string>>(new Set())
const openedReasks = ref<Set<string>>(new Set())

/** 答案格式那格：自己命名的一直在；常用欄位只在格式跟預設不同、或從「⋯」按開時出現 */
function isFormatShown(node: ScriptCollectNode): boolean {
  const key = presetKeyOf(node)
  if (key === '__custom' || openedFormats.value.has(node.id)) return true
  const preset = COMMON_COLLECT_FIELDS.find(p => p.key === key)
  return Boolean(preset) && (node.format ?? 'any') !== preset!.format
}
/** 不限制格式就不會重問（什麼都收），這一句用不到 */
function canReask(node: ScriptCollectNode): boolean {
  return (node.format ?? 'any') !== 'any'
}
function isReaskShown(node: ScriptCollectNode): boolean {
  return canReask(node) && (Boolean(node.reaskText?.trim()) || openedReasks.value.has(node.id))
}
function openCollectExtra(node: ScriptCollectNode, kind: 'format' | 'reask') {
  const opened = kind === 'format' ? openedFormats : openedReasks
  opened.value = new Set(opened.value).add(node.id)
}
function clearReask(node: ScriptCollectNode) {
  node.reaskText = ''
  const next = new Set(openedReasks.value)
  next.delete(node.id)
  openedReasks.value = next
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
  const nodes = deepCloneNodes(script.nodes)
  // 開頭接的那一題排第一（`D-150`：舊資料的節點順序可能跟走的順序對不上；只換順序，怎麼走不變）——在 markClean 之前做，不算他改的
  startFirst(nodes, script.rootNodeId)
  form.value = {
    name: script.name,
    enabled: script.enabled,
    priority: script.priority || DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: script.rootNodeId,
    nodes,
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
  startFirst(draft.nodes, draft.rootNodeId)
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
  trigger.matchMode = 'keyword' // 空白的預設是 AI 判斷，這個起點要的是「看字」
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
/**
 * 關鍵字那一格的分隔（`D-148`）：一行一個，逗號也算。⛔ 空白不算：以前空白也拆，「LINE Pay」變成
 * 「LINE」「Pay」兩個字，選「一模一樣才接」時客人打「LINE Pay」反而接不到。
 */
const KEYWORD_SEPARATOR = /[\n,，、]+/g

/**
 * 觸發方式有三種（關鍵字／看意思／客人加好友時；畫面上只在前兩種之間切），但資料上是兩個欄位
 * （triggerEvent 事件型 vs matchMode 文字比對）——這裡是唯一一處換算，模板都吃這支。
 */
function triggerUiMode(node: ScriptTriggerNode): 'keyword' | 'semantic' | 'follow' {
  if (node.triggerEvent === 'follow') return 'follow'
  return (node.matchMode ?? 'keyword') === 'semantic' ? 'semantic' : 'keyword'
}

/** 只在兩種文字比對之間切（加好友那種不在這裡切，見模板「什麼時候開始」那段註解） */
function setTriggerMode(node: ScriptTriggerNode, mode: string | number | boolean | undefined) {
  const m: TriggerMatchMode = mode === 'semantic' ? 'semantic' : 'keyword'
  node.matchMode = m
  if (m === 'semantic' && !node.examples) node.examples = []
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
