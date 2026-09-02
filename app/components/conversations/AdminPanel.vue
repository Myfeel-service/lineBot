<template>
  <AdminSplitLayout class="conversations-page" :is-empty="!selectedUserId">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <!-- 側欄選單昨天改叫「客服對話」了，這裡跟著改：同一個東西同一個名字（G-27⑤） -->
      <span class="split-sidebar-title conv-sidebar-title-row" data-tour="conv-list">💬 客服對話<AdminPageHelpButton :topics="['conversations']" /></span>
      <div class="conv-sidebar-actions">
        <!-- 換電腦／清過快取／新同事第一次登入時整排全紅，沒這顆就只能一位一位點開才消得掉 -->
        <el-tooltip
          v-if="unreadRowCount > 0"
          content="把這份清單上看得到的紅點一次清掉（只影響你這台電腦，不會動到同事看到的；還沒捲到的下面幾頁不受影響）"
          placement="bottom"
        >
          <button
            type="button"
            class="conv-mark-all-read"
            @click="markAllConversationsRead"
          >標記全部已讀（{{ unreadRowCount }}）</button>
        </el-tooltip>
        <el-button size="small" :loading="listLoading" @click="loadList('reset')">重整</el-button>
      </div>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <!-- Status Tabs：這一排全部是「系統判定的會話狀態」，人工標記不放這裡（會被當成同一種東西）。
           G-27③：只留「要人動手」的三個在檯面上，其餘收進右邊的下拉（原本六個擠三排吃掉約 100px，
           而且最大的數字「機器人」正好是最不需要人看的一群）。 -->
      <div class="conv-status-tabs" data-tour="conv-tabs">
        <button
          v-for="tab in PRIMARY_STATUS_TABS"
          :key="tab.value"
          type="button"
          class="conv-status-tab"
          :class="{ active: activeTab === tab.value }"
          :title="tab.hint"
          @click="switchTab(tab.value)"
        >{{ statusTabText(tab) }}</button>
        <el-dropdown
          trigger="click"
          placement="bottom-end"
          class="conv-status-more"
          @command="switchTab"
        >
          <!-- ⚠️這顆刻意留原生 title：它是 el-dropdown 的觸發元件，外面再包一層
               el-tooltip 會把觸發綁到 tooltip 上、下拉選單就打不開了（D-33 P2） -->
          <button
            type="button"
            class="conv-status-tab conv-status-tab--more"
            :class="{ active: secondaryTabActive }"
            title="全部、機器人自動回覆中、已結束——這三個是翻閱用的，不是待辦"
          >{{ secondaryTabLabel }} ▾</button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="tab in SECONDARY_STATUS_TABS"
                :key="tab.value"
                :command="tab.value"
                :title="tab.hint"
              >
                <span class="conv-status-more-item" :class="{ active: activeTab === tab.value }">
                  {{ statusTabText(tab) }}
                </span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div class="conv-search-bar">
        <el-input v-model="searchText" placeholder="搜尋名稱…" clearable size="small" />
        <!-- 右鍵標記完要找得回來：沒有這個出口，標記就是個看不到的動作。
             和上面那排刻意分行分色 ——「待跟進」是人標的，不是系統狀態 -->
        <el-tooltip
          v-if="activeTab === 'all'"
          :content="`待跟進＝你和同事手動標記、要回頭處理的對話（和上面系統判定的「待處理」不是同一件事）${followUpCount === null ? '。⚠️數量這次讀不到，篩選仍可用' : ''}`"
          placement="bottom"
        >
          <button
            type="button"
            class="conv-flag-filter"
            :class="{ active: followUpFilterOn }"
            :aria-pressed="followUpFilterOn"
            @click="toggleFollowUpFilter"
          >
            <span class="conv-flag-filter__icon" aria-hidden="true">🚩</span>
            只看待跟進{{ typeof followUpCount === 'number' && followUpCount > 0 ? `（${followUpCount}）` : '' }}
          </button>
        </el-tooltip>
      </div>
      <div v-if="listLoading && !sidebarItems.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!sidebarItems.length" class="split-sidebar-empty">
        <span>{{ sidebarEmpty.title }}</span>
        <!-- 空清單不要變死路：這裡順便講怎麼標，這也是唯一會說明「待跟進怎麼來」的地方 -->
        <span v-if="sidebarEmpty.hint" class="conv-empty-hint">{{ sidebarEmpty.hint }}</span>
      </div>
      <div
        v-else
        ref="sidebarListEl"
        class="split-list"
        @scroll.passive="onSidebarListScroll"
      >
        <div v-if="followUpListTruncated" class="conv-list-notice">
          待跟進超過 {{ FOLLOW_UP_LIST_LIMIT }} 筆，這裡只顯示最新的 {{ FOLLOW_UP_LIST_LIMIT }} 筆
        </div>
        <!-- 搜尋中的清單不會自己更新（見 listAutoRefreshPaused）：不講的話，
             客服會以為「都沒有新訊息」，其實是畫面停在搜尋當下那一刻 -->
        <div v-if="listAutoRefreshPaused" class="conv-list-notice">
          搜尋結果不會自動更新，新訊息與紅點請清空搜尋或按「重整」
        </div>
        <!--
          G-27③：釘選區的標題。
          釘選一律置頂，釘到 12 筆時第一screen 就整片都是 📌，中間沒有任何字說明
          「這一段是釘選」——讀起來就變成「每列都有圖釘」。標一下、並且可以收起來，
          收起來才拿得回照時間排序的收件匣。
        -->
        <button
          v-if="pinnedRowCount > 0"
          type="button"
          class="conv-list-group"
          :aria-expanded="pinnedGroupOpen"
          :title="pinnedGroupOpen
            ? '收起釘選區，只看照時間排序的對話'
            : '展開釘選區（釘選的對話一律排在最上面）'"
          @click="pinnedGroupOpen = !pinnedGroupOpen"
        >
          <span class="conv-list-group__caret" aria-hidden="true">{{ pinnedGroupOpen ? '▾' : '▸' }}</span>
          <span>📌 釘選中（{{ pinnedRowCount }}）</span>
        </button>
        <!-- Session-based view (status tabs) -->
        <template v-if="activeTab !== 'all'">
          <div
            v-for="(s, idx) in sessionSidebarItems"
            :key="s.sessionId"
            class="conv-list-row"
            :class="{ 'is-pinned-edge': idx === lastPinnedSessionIndex }"
          >
            <AdminSplitListItem
              :title="s.displayName"
              :leading-avatar-url="s.pictureUrl"
              show-leading-avatar-fallback
              time-in-title-row
              :show-unread-dot="isRowUnread(s.userId, sessionRowCustomerMs(s))"
              :active="selectedSessionId === s.sessionId"
              :title-icon="s.pinned ? '📌' : ''"
              :owner-initial="assigneeInitial(s.assignee?.name ?? '')"
              :owner-title="s.assignee?.name ? `負責人員：${s.assignee.name}` : ''"
              :meta-tag="s.followUp ? '待跟進' : ''"
              :meta-prefix="directionPrefix(s)"
              :meta-text="s.lastMessage || SESSION_NO_PREVIEW"
              :meta-strong="s.lastDirection === 'incoming' && !!s.lastMessage"
              :meta-truncate="true"
              :chip-text="formatTime(s.lastActivityAt)"
              :context-menu-enabled="canOperate"
              @select="selectSession(s)"
              @contextmenu="openConvContextMenu($event, s)"
            />
            <button
              v-if="canOperate"
              type="button"
              class="conv-list-row__more"
              title="釘選 / 待跟進"
              aria-label="更多動作"
              @click.stop="openContextMenuFromButton($event, s)"
            >⋯</button>
          </div>
        </template>
        <!-- User-based view (all tab) -->
        <template v-else>
          <div
            v-for="(c, idx) in convSidebarItems"
            :key="c.userId"
            class="conv-list-row"
            :class="{ 'is-pinned-edge': idx === lastPinnedIndex }"
          >
            <AdminSplitListItem
              :title="c.displayName"
              :leading-avatar-url="c.pictureUrl"
              show-leading-avatar-fallback
              time-in-title-row
              :show-unread-dot="isRowUnread(c.userId, convRowCustomerMs(c))"
              :active="selectedUserId === c.userId && !selectedSessionId"
              :title-icon="c.pinned ? '📌' : ''"
              :owner-initial="assigneeInitial(c.assignee?.name ?? '')"
              :owner-title="c.assignee?.name ? `負責人員：${c.assignee.name}` : ''"
              :meta-tag="c.followUp ? '待跟進' : ''"
              :meta-prefix="directionPrefix(c)"
              :meta-text="c.lastMessage"
              :meta-strong="c.lastDirection === 'incoming' && !!c.lastMessage"
              :meta-truncate="true"
              :chip-text="formatTime(c.lastMessageAt)"
              chip-tone="neutral"
              :context-menu-enabled="canOperate"
              @select="selectUser(c)"
              @contextmenu="openConvContextMenu($event, c)"
            />
            <!-- 右鍵是隱藏功能,沒人會自己發現:滑過就露出同一份選單的入口 -->
            <button
              v-if="canOperate"
              type="button"
              class="conv-list-row__more"
              title="釘選 / 待跟進"
              aria-label="更多動作"
              @click.stop="openContextMenuFromButton($event, c)"
            >⋯</button>
          </div>
        </template>
        <div v-if="listLoadingMore" class="conv-list-load-more">
          <div class="spinner" />
          <span>載入更多…</span>
        </div>
      </div>
    </template>

    <!-- ── Empty State ── -->
    <template #editor-empty>
      <el-icon class="empty-icon"><ChatDotRound /></el-icon>
      <h3>選擇一個對話</h3>
      <p>從左側選擇一位好友，查看訊息紀錄並直接回覆</p>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <!--
        標頭收成**兩列**（原本是四列，每列各自為政）：
          第一列＝這是誰（頭像／名字　……　客人檔案 →）
          第二列＝現況在左（狀態徽章＋負責人員）、我能做什麼在右（接手／交還／結束）
        原本的問題是「亂」而且量得出來：四列的左緣分別落在 12／60／804／12／60 五個位置，
        「客人檔案 →」還因為 margin-left:auto 落在 column 容器裡而獨占一整列飄在右上角。
        收完之後只剩兩條左緣（頭像 12、名字 60），標頭高度 135px → 約 80px，
        省下來的都給訊息區——這頁最缺的就是垂直空間。
      -->
      <div class="conv-editor-header-block" data-tour="conv-header">
        <div class="conv-header-row conv-header-row--identity">
          <div class="conv-user-info">
            <img
              v-if="selectedUser?.pictureUrl"
              :src="selectedUser.pictureUrl"
              class="conv-avatar"
              :alt="selectedUser.displayName"
            />
            <span v-else class="conv-avatar-placeholder">👤</span>
            <div>
              <div class="split-editor-title">{{ selectedUser?.displayName }}</div>
            </div>
          </div>
          <!-- 收起來之後要有路回來（LINE 的收合箭頭同款；只在有選中客人時才有意義） -->
          <el-button
            v-if="selectedUserId && !customerPanelOpen"
            size="small"
            text
            type="primary"
            class="conv-customer-reopen"
            @click="customerPanelOpen = true"
          >客人檔案 →</el-button>
        </div>

        <!--
          G-27⑥ 色階：狀態用標籤、動作用同一款次要按鈕，
          **只有「當下最該做的那一件」給主色**——也就是客人在等人接手時的「我接手」。
          ⛔「交還機器人」不可以是綠的：這個專案裡綠＝好／完成，但它是一個動作不是好消息
          （原本三個控制項三種視覺重量，眼睛不知道該先看哪個）。

          這一列的分工：**左邊全是「現在是什麼狀況」，右邊全是「我可以做什麼」**。
          先前狀態徽章和三顆動作按鈕混在同一排、視覺重量又接近，眼睛分不出哪個是現況哪個能按。
        -->
        <div
          v-if="sessionToolbarMeta || (selectedUserId && canOperate)"
          class="conv-header-row conv-header-row--session"
        >
          <!--
            這場的狀態是這一塊最重要的資訊（決定我現在該不該開口），先前**五種狀態全部
            寫死 type="info"**＝一律同一顆藍徽章：客人在等人接手，和機器人正在自動回覆，
            長得一模一樣。改成照急迫度給色（紅＞橘＞藍＞灰），見 sessionStateTone。
          -->
          <template v-if="sessionToolbarMeta">
            <!--
              ⛔ 只在看「某一場舊會話」時才標範圍：那是例外情況（按鈕作用在那一場、不是最新那場），
              值得講。看進行中的那場是常態，多一個「進行中會話」的小灰字只是雜訊。
            -->
            <span v-if="selectedSessionId" class="conv-session-scope">此場會話</span>
            <el-tag
              size="small"
              :type="sessionStateTone.type"
              :class="{ 'conv-session-state--muted': sessionStateTone.muted }"
              :title="sessionStateTone.hint"
            >{{ sessionToolbarMeta.statusLabel }}</el-tag>
          </template>
          <!--
            負責人員（G-27 功能缺口②）：接手前先看得到「是誰在跟」，才不會兩個人同時回。
            放頂部而不是右側客人卡：撞車是**回訊息之前**要擋的，視線不會先繞到右邊那張卡。
            ⛔ 沒有選中客人時不出現（沒有對話可以指派）。
            ⛔ 它是**對話層級**的，不可以跟著 sessionToolbarMeta 一起消失——沒有進行中會話的
               對話照樣要指派得了人。
          -->
          <el-dropdown
            v-if="selectedUserId && canOperate"
            trigger="click"
            placement="bottom-start"
            class="conv-assignee"
            :disabled="assigneeSaving"
            @command="setAssignee"
            @visible-change="onAssigneeMenuToggle"
          >
            <button
              type="button"
              class="conv-assignee__btn"
              :class="{ 'is-set': !!currentAssignee.uid }"
              :title="currentAssignee.uid
                ? `負責人員：${currentAssignee.name}（點一下可換人或取消）`
                : '指定一位同事負責這條線，其他人就看得出來已經有人在跟'"
            >{{ currentAssignee.uid ? `👤 ${currentAssignee.name}` : '👤 指派負責人' }}</button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-if="assigneeLoading" disabled>載入同事名單…</el-dropdown-item>
                <!-- ⛔ 查不到不可以靜靜顯示空選單（08-09「查不到≠沒問題」三態） -->
                <el-dropdown-item v-else-if="assigneeLoadFailed" disabled>
                  同事名單載入失敗，請重新整理
                </el-dropdown-item>
                <el-dropdown-item v-else-if="!assignableMembers.length" disabled>
                  這個官方帳號只有你一位客服
                </el-dropdown-item>
                <template v-else>
                  <el-dropdown-item
                    v-for="m in assignableMembers"
                    :key="m.uid"
                    :command="m.uid"
                  >
                    <span :class="{ 'conv-assignee__current': m.uid === currentAssignee.uid }">
                      {{ m.name }}
                    </span>
                  </el-dropdown-item>
                  <el-dropdown-item v-if="currentAssignee.uid" command="" divided>
                    取消指派
                  </el-dropdown-item>
                </template>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <div v-if="sessionToolbarMeta" class="conv-session-actions" data-tour="conv-actions">
            <el-tooltip v-if="canTakeOverSession" content="接手後，機器人與 AI 不會再自動回覆這位客人，直到你按「交還機器人」或會話結束" placement="top">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="takingOverSession"
                @click="takeOverSelectedSession"
              >
                我接手（暫停自動回覆）
              </el-button>
            </el-tooltip>
            <el-tooltip
              v-if="canOperate && (sessionToolbarMeta.status === 'pending_human' || sessionToolbarMeta.status === 'human_handling')"
              content="交還後，機器人與 AI 會恢復自動回覆這位客人"
              placement="top"
            >
              <el-button
                size="small"
                plain
                :loading="handingBackSession"
                @click="handBackSelectedSession"
              >
                交還機器人
              </el-button>
            </el-tooltip>
            <el-button
              v-if="canOperate && sessionToolbarMeta.status !== 'closed'"
              size="small"
              plain
              :loading="closingSession"
              @click="closeSelectedSession"
            >
              結束會話
            </el-button>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <!-- ══ G-26：對話區 ＋ 右側客人卡 ══════════════════════════
           版面照 LINE 官方帳號後台：左清單／中對話／右客人資訊。
           ⛔ 只加外層容器、**內容不重新縮排**——那會產生 600 行的假 diff，
              把真正的改動埋掉（縮排對 CSS 沒有影響）。 -->
      <div class="conv-body-split">
      <div class="conv-body-main">
      <!--
        G-27①：收起來的軌跡換成這一行。
        五個灰膠囊擠在訊息中間 → 一行「這場：新會話 → AI 客服 → 真人（12:03 接手）」，
        開關就放在同一行的右邊（要看細節的人在這裡找得到，不必猜它被藏到哪去了）。
      -->
      <div
        v-if="selectedUserId && (sessionFlowSummary || hiddenEventCount > 0 || showAllEvents)"
        class="conv-flow-summary"
      >
        <span v-if="sessionFlowSummary" class="conv-flow-summary__path">
          這場：{{ sessionFlowSummary }}
        </span>
        <span v-else class="conv-flow-summary__path text-muted">這段還沒有系統紀錄</span>
        <button
          v-if="hiddenEventCount > 0 || showAllEvents"
          type="button"
          class="conv-flow-summary__toggle"
          :title="showAllEvents
            ? '收起純軌跡（新會話開始、進入某模組、真人首次回覆），只留下解釋換手的那幾筆'
            : '把新會話開始、進入某模組這類系統內部軌跡也顯示在對話裡'"
          @click="showAllEvents = !showAllEvents"
        >{{ showAllEvents ? '收起系統紀錄' : `顯示系統紀錄（${hiddenEventCount}）` }}</button>
      </div>
      <ConversationsAiContextBanner
        v-if="canOperate"
        ref="aiContextBanner"
        :user-id="selectedUserId"
        :refresh-key="aiContextRefreshKey"
        :session-window="aiContextSessionWindow"
        :api-fetch="apiFetch"
        @apply-draft="applyAiDraft"
        @add-knowledge="goAddKnowledge"
        @edit-chunk="goEditChunk"
      />
      <!-- 圖片可以直接拖進對話區（貼上則綁在輸入框），不必繞 ＋ →「圖片」→ 選檔案 -->
      <div
        ref="messagesEl"
        class="conv-messages"
        data-tour="conv-messages"
        :class="{ 'is-drop-target': canOperate && isDraggingImage }"
        @scroll.passive="onMessagesScroll"
        @load.capture="onMessagesContentGrew"
        @error.capture="onMessagesContentGrew"
        @loadedmetadata.capture="onMessagesContentGrew"
        @dragenter.prevent="canOperate && onDragEnter($event)"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop.prevent="canOperate && onDropFile($event)"
      >
        <div v-if="canOperate && isDraggingImage" class="conv-drop-hint">
          放開就把圖片帶進來，送出前還可以先看一眼
        </div>
        <div v-if="msgLoading" class="split-sidebar-loading">
          <div class="spinner" />
        </div>
        <div v-else-if="!chatRows.length" class="split-empty-state">
          <p>尚無對話內容</p>
        </div>
        <!--
          往上滑到接近頂端就會自己把更早的一段讀進來（見 onMessagesScroll）。
          這一列同時是「上面還有」的說明和手動的入口：只靠滑動的話，用鍵盤或
          Home 鍵跳到頂的人不會知道還有東西可以讀。
        -->
        <div v-if="timelineHasOlder && !msgLoading" class="conv-timeline-more">
          <span v-if="loadingOlder" class="conv-timeline-more__label">正在載入更早的訊息…</span>
          <button v-else type="button" class="conv-timeline-more__btn" @click="loadOlderTimeline">
            載入更早的訊息
          </button>
        </div>
        <!-- 一天一組（見 chatDayGroups）：日期膠囊吸在自己這一組的頂端，滑到下一天才換上新的那顆 -->
        <div v-for="(group, groupIdx) in chatDayGroups" :key="group.key || `nd-${groupIdx}`" class="conv-day-group">
          <div v-if="group.label" class="conv-day-divider">
            <span class="conv-day-divider__label">{{ group.label }}</span>
          </div>
          <template v-for="row in group.rows" :key="row.key">
            <div
              v-if="row.kind === 'event'"
              class="conv-timeline-event"
              :class="{ 'conv-timeline-event--action': row.variant === 'action' }"
              :title="row.variant === 'action' ? '客人在 LINE 裡做的動作（按按鈕、加好友、活動登記），不是他傳的訊息' : undefined"
            >
              <span v-if="row.variant === 'action'" class="conv-timeline-event__icon" aria-hidden="true">👆</span>
              <span v-else class="conv-timeline-event__dot" aria-hidden="true" />
              <span class="conv-timeline-event__label">{{ row.label }}</span>
              <span class="conv-timeline-event__time">{{ formatClockTime(row.timestamp) }}</span>
            </div>
            <template v-else>
              <template v-for="msg in [row.msg]" :key="msg.id">
                <div
                  class="conv-bubble-row"
                  :class="msg.direction"
                >
                  <div
                    class="conv-bubble-wrap"
                    :class="[
                      msg.direction,
                      { 'is-structured': isStructuredLineMessage(msg), 'is-media': isMediaMessage(msg) },
                    ]"
                  >
                    <div
                      class="conv-bubble"
                      :class="[
                        msg.direction,
                        { 'is-structured': isStructuredLineMessage(msg), 'is-media': isMediaMessage(msg) },
                      ]"
                    >
                      <template v-if="getMessageType(msg) === 'text'">
                <div v-if="isEmojiOnlyMessage(msg)" class="conv-emoji-message">
                  <img
                    v-for="(emoji, idx) in splitEmojiUnits(getMessageDisplayText(msg))"
                    :key="`${msg.id}-emoji-${idx}`"
                    :src="getEmojiImageUrl(emoji)"
                    :alt="emoji"
                    class="conv-emoji-image"
                  />
                </div>
                <div v-else class="conv-bubble-text">
                  <div v-for="(line, lineIdx) in splitMessageLines(msg)" :key="`${msg.id}-line-${lineIdx}`">
                    <template v-for="(seg, segIdx) in splitMessageLineSegments(line)" :key="`${msg.id}-seg-${lineIdx}-${segIdx}`">
                      <span :class="{ 'conv-link-text': seg.isLink }">{{ seg.text }}</span>
                    </template>
                  </div>
                </div>
              </template>
              <template v-else-if="getMessageType(msg) === 'image'">
                <el-image
                  v-if="getMessageImageUrl(msg)"
                  class="conv-inline-image"
                  :src="getMessageImageUrl(msg)"
                  fit="contain"
                  :preview-src-list="[getMessageImageUrl(msg)]"
                  :preview-teleported="true"
                />
                <div v-else class="conv-media-fallback">{{ mediaFallbackText(msg) }}</div>
                <!-- AI 讀出來的圖片說明：明講是 AI 讀的，客服才知道這句話可能不準、要自己看圖確認 -->
                <div v-if="msg.mediaDescription" class="conv-media-caption">
                  <span class="conv-media-caption__tag">AI 看到</span>{{ msg.mediaDescription }}
                </div>
              </template>
              <template v-else-if="getLineRichImageUrl(msg)">
                <el-image
                  class="conv-inline-image conv-inline-image--line-rich"
                  :style="getLineRichImageFrameStyle(msg)"
                  :src="getLineRichImageUrl(msg)"
                  fit="contain"
                  :preview-src-list="[getLineRichImageUrl(msg)]"
                  :preview-teleported="true"
                />
              </template>
              <template v-else-if="getMessageType(msg) === 'video'">
                <!-- 客人傳來的影片沒有預覽圖，只能直接放播放器；客服自己送的有預覽圖就先顯示 -->
                <video
                  v-if="getVideoUrl(msg)"
                  class="conv-inline-video"
                  :src="getVideoUrl(msg)"
                  :poster="getVideoPreviewImageUrl(msg) || undefined"
                  controls
                  preload="metadata"
                />
                <div v-else-if="getVideoPreviewImageUrl(msg)" class="conv-video-frame">
                  <img
                    :src="getVideoPreviewImageUrl(msg)"
                    alt="video-preview"
                    class="conv-video-preview"
                  />
                  <div class="conv-video-play">▶</div>
                </div>
                <div v-else class="conv-media-fallback">{{ mediaFallbackText(msg) }}</div>
              </template>
              <template v-else-if="getMessageType(msg) === 'audio'">
                <a
                  v-if="getAudioUrl(msg)"
                  :href="getAudioUrl(msg)"
                  class="conv-attachment-card"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span class="conv-attachment-card__icon">🎵</span>
                  <span class="conv-attachment-card__meta">
                    <span class="conv-attachment-card__title">語音訊息</span>
                    <span class="conv-attachment-card__desc">{{ getAudioDurationLabel(msg) }}・點擊播放</span>
                  </span>
                </a>
                <div v-else class="conv-media-fallback">{{ mediaFallbackText(msg) }}</div>
              </template>
              <template v-else-if="getMessageType(msg) === 'file'">
                <a
                  v-if="getFileUrl(msg)"
                  :href="getFileUrl(msg)"
                  class="conv-attachment-card"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span class="conv-attachment-card__icon">📎</span>
                  <span class="conv-attachment-card__meta">
                    <span class="conv-attachment-card__title">{{ getFileName(msg) }}</span>
                    <span class="conv-attachment-card__desc">點擊下載</span>
                  </span>
                </a>
                <div v-else class="conv-media-fallback">{{ mediaFallbackText(msg) }}</div>
              </template>
              <template v-else-if="isStructuredLineMessage(msg)">
                <div class="conv-line-template" :class="getStructuredTemplateClass(msg)">
                  <div
                    v-if="shouldUseStructuredCarousel(msg)"
                    class="conv-line-template-carousel"
                  >
                    <button
                      type="button"
                      class="conv-line-template-carousel__arrow"
                      :disabled="isStructuredCarouselAtStart(msg)"
                      @click="moveStructuredCarousel(msg, -1)"
                    >
                      &lt;
                    </button>
                    <div class="conv-line-template-carousel__viewport">
                      <div
                        class="conv-line-template-carousel__track"
                        :style="{ transform: `translateX(calc(-1 * ${getStructuredCarouselIndex(msg)} * (50% + (var(--conv-carousel-gap) / 2))))` }"
                      >
                        <div
                          v-for="(card, cardIdx) in getStructuredCards(msg)"
                          :key="`${msg.id}-card-slide-${cardIdx}`"
                          class="conv-line-template-carousel__item"
                        >
                          <div
                            class="conv-line-card"
                            :class="getStructuredCardClass(msg, card)"
                          >
                            <img
                              v-if="card.imageUrl"
                              :src="card.imageUrl"
                              :alt="card.title || 'preview'"
                              class="conv-line-card-image"
                              :style="getCardImageStyle(msg, card)"
                            />
                            <div
                              v-if="shouldShowFlexImageHeroOverlay(msg, card) || (getStructuredVariant(msg) === 'image_carousel' && getCardOverlayLabel(card))"
                              class="conv-line-card-image-overlay"
                            >
                              {{ getCardOverlayLabel(card) }}
                            </div>
                            <div v-if="card.title" class="conv-line-card-title">{{ card.title }}</div>
                            <div v-if="card.text" class="conv-line-card-text">{{ card.text }}</div>
                            <div
                              v-if="card.actions.length"
                              class="conv-line-card-actions"
                              :class="{ 'is-line-action': shouldUseLineActionStyle(msg) }"
                            >
                              <button
                                v-for="(act, actIdx) in card.actions"
                                :key="`${msg.id}-act-${cardIdx}-${actIdx}`"
                                type="button"
                                class="conv-line-card-action"
                                :class="{ 'is-line-action': shouldUseLineActionStyle(msg) }"
                              >
                                {{ act }}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      class="conv-line-template-carousel__arrow"
                      :disabled="isStructuredCarouselAtEnd(msg)"
                      @click="moveStructuredCarousel(msg, 1)"
                    >
                      >
                    </button>
                  </div>
                  <div v-else class="conv-line-template-cards">
                    <div
                      v-for="(card, cardIdx) in getStructuredCards(msg)"
                      :key="`${msg.id}-card-${cardIdx}`"
                      class="conv-line-card"
                      :class="getStructuredCardClass(msg, card)"
                    >
                      <img
                        v-if="card.imageUrl"
                        :src="card.imageUrl"
                        :alt="card.title || 'preview'"
                        class="conv-line-card-image"
                        :style="getCardImageStyle(msg, card)"
                      />
                      <div
                        v-if="shouldShowFlexImageHeroOverlay(msg, card) || (getStructuredVariant(msg) === 'image_carousel' && getCardOverlayLabel(card))"
                        class="conv-line-card-image-overlay"
                      >
                        {{ getCardOverlayLabel(card) }}
                      </div>
                      <div v-if="card.title" class="conv-line-card-title">{{ card.title }}</div>
                      <div v-if="card.text" class="conv-line-card-text">{{ card.text }}</div>
                      <div
                        v-if="card.actions.length"
                        class="conv-line-card-actions"
                        :class="{ 'is-line-action': shouldUseLineActionStyle(msg) }"
                      >
                        <button
                          v-for="(act, actIdx) in card.actions"
                          :key="`${msg.id}-act-${cardIdx}-${actIdx}`"
                          type="button"
                          class="conv-line-card-action"
                          :class="{ 'is-line-action': shouldUseLineActionStyle(msg) }"
                        >
                          {{ act }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
              <template v-else-if="getMessageType(msg) === 'sticker'">
                <div class="conv-sticker-message">
                  <el-image
                    v-if="getStickerImageUrl(msg)"
                    class="conv-inline-sticker"
                    :src="getStickerImageUrl(msg)"
                    fit="contain"
                    :preview-src-list="[getStickerImageUrl(msg)]"
                    :preview-teleported="true"
                  />
                </div>
              </template>
              <template v-else>
                <el-tag size="small" type="info">{{ getMessageType(msg) }}</el-tag>
                <span class="conv-bubble-text">{{ getMessageDisplayText(msg) }}</span>
                <span v-if="getPayloadSummary(msg)" class="conv-bubble-text text-muted">{{ getPayloadSummary(msg) }}</span>
              </template>
              </div>
                    <div class="conv-bubble-meta">
                      <!-- 還在送 / 送失敗的本地泡泡：時間還不確定，先不要寫一個假的上去 -->
                      <span v-if="msg.sendStatus === 'sending'" class="conv-bubble-sending">傳送中…</span>
                      <span v-else-if="msg.sendStatus === 'failed'" class="conv-bubble-failed">傳送失敗</span>
                      <template v-else>
                        <!--
                          誰回的標籤與時間同一行：各佔一行的話 meta 會變成三層高，比旁邊
                          一行字的泡泡還高。標籤放泡泡外面是刻意的——進泡泡裡會被誤讀成
                          訊息內容（客人那邊看不到這顆標籤）。
                          舊訊息沒有 sender 就整顆不出現，見 shared/message-sender.ts。
                        -->
                        <span class="conv-bubble-meta__line">
                          <span
                            v-if="msg.sender"
                            class="conv-sender-tag"
                            :class="{ 'conv-sender-tag--human': msg.sender === 'human' }"
                            :title="senderTagTitle(msg)"
                          >{{ MESSAGE_SENDER_LABELS[msg.sender] }}</span>
                          <span class="conv-bubble-time">{{ formatClockTime(msg.timestamp) }}</span>
                        </span>
                        <el-tooltip
                          v-if="msg.direction === 'outgoing' && msg.readByPeer"
                          content="客人後來有回訊息或點按鈕，代表他應該已看過這則之前的訊息；這是系統推估的，跟 LINE App 裡的「已讀」不一定完全一樣。"
                          placement="top"
                        >
                          <span class="conv-bubble-read">已讀</span>
                        </el-tooltip>
                      </template>
                    </div>
                  </div>
                </div>

                <!--
                  這則訊息附的快速回覆按鈕。客人在 LINE 看到的是一排可點的膠囊，點了就送出
                  對應文字——不畫出來的話，客人下一句「找真人」看起來像自己打的，客服根本
                  不知道那是我們給的選項、也不知道當時還給過哪些選擇。
                  只是紀錄，刻意做成不可點（span 不是 button）。
                  跟「為什麼這樣答」同理由放泡泡下面自己一排，不塞旁邊那條 meta。
                -->
                <div v-if="getQuickReplyItems(msg).length" class="conv-quickreply-row" :class="msg.direction">
                  <el-tooltip content="這則訊息在 LINE 裡附了這排按鈕，客人點一顆就會送出那段文字。這裡只是紀錄，按不了。" placement="top">
                    <span class="conv-quickreply-row__tag">客人看到的按鈕</span>
                  </el-tooltip>
                  <span
                    v-for="(opt, optIdx) in getQuickReplyItems(msg)"
                    :key="`${msg.id}-qr-${optIdx}`"
                    class="conv-quickreply-chip"
                    :title="opt.send && opt.send !== opt.label ? `點了會送出：${opt.send}` : undefined"
                  >{{ opt.label }}</span>
                </div>

                <!--
                  這一則的「為什麼這樣答」。綁在泡泡上而不是只有最上面那張卡：一場對話 AI 回好幾次，
                  最上面那張永遠只講最新一次——客服想標的通常是更早那一則（發現答錯多半是客人抱怨之後）。
                  沒有 aiTurnId 的（這功能上線前的舊訊息）不出現，刻意不用時間去猜。

                  按鈕與展開的內容都放在泡泡「下面」自己一區，**不塞進旁邊那條 meta**：
                  meta 是貼在泡泡右側的窄欄、與泡泡共用寬度上限，多一列會把它撐成三層高
                  （比泡泡還高）、六個字也會把泡泡擠窄。同 conv-send-failed-row 的理由。
                -->
                <div v-if="canOperate && msg.aiTurnId" class="conv-turn-row" :class="msg.direction">
                  <button
                    type="button"
                    class="conv-bubble-why"
                    :aria-expanded="openTurnKey === msg.aiTurnId"
                    @click="toggleTurn(msg.aiTurnId)"
                  >{{ openTurnKey === msg.aiTurnId ? '收起' : '為什麼這樣答' }}</button>

                  <div v-if="openTurnKey === msg.aiTurnId" class="conv-turn-panel">
                    <div v-if="turnLoading" class="conv-turn-panel__loading"><div class="spinner" /></div>
                    <p v-else-if="turnError" class="conv-turn-panel__error">{{ turnError }}</p>
                    <ConversationsAiContextBody
                      v-else-if="turnCtx"
                      :ctx="turnCtx"
                      :user-id="selectedUserId"
                      :api-fetch="apiFetch"
                      @apply-draft="applyAiDraft"
                      @add-knowledge="goAddKnowledge"
                      @edit-chunk="goEditChunk"
                      @reload="loadTurn(msg.aiTurnId)"
                    />
                  </div>
                </div>
                <!--
                  失敗的原因和補救動作放在泡泡「下面」自己一行，不塞進旁邊那條 meta：
                  meta 只有泡泡剩下的寬度，一句「已封鎖」就被壓成三行讀不下去。
                -->
                <div v-if="msg.sendStatus === 'failed'" class="conv-send-failed-row">
                  <span class="conv-send-failed-row__reason">{{ msg.sendError }}</span>
                  <span class="conv-bubble-retry">
                    <button type="button" @click="retryPendingOutgoing(String(msg.localId))">重試</button>
                    <button type="button" @click="discardPendingOutgoing(String(msg.localId))">收回文字</button>
                  </span>
                </div>
              </template>
            </template>
          </template>
        </div>
        <!--
          看的是已結束的舊會話時，畫面停在那一場的尾巴——下面還有沒讀進來的訊息。
          刻意不做成「滑到底自動讀」：那會和「黏在底部」打架，一路把整段歷史自動翻完。
        -->
        <div v-if="timelineHasNewer && !msgLoading" class="conv-timeline-more">
          <span class="conv-timeline-more__label">這場之後還有訊息</span>
          <button
            type="button"
            class="conv-timeline-more__btn"
            :disabled="loadingNewer"
            @click="loadNewerTimeline"
          >
            {{ loadingNewer ? '載入中…' : '載入後續訊息' }}
          </button>
        </div>
        <!--
          往上翻舊訊息時，這顆浮在對話右下角，一按就回到最新一則（下面還有沒載入的
          就先把最新那一段讀回來，見 jumpToLatest）。
          它是保險，不是主力：正常情況下開對話就已經停在最下面（見 scrollToBottom），
          但圖片／圖文卡載得慢、或客服自己正在翻舊訊息時，總要有一條看得見的路回來。

          它必須是訊息區的**最後一個子元素**：靠 sticky 吸在捲動區底部，才會剛好落在
          「最後一則訊息與回覆區之間」。放到訊息區外面就只能對齊整個編輯區的底，
          那是輸入框的位置，會蓋在打字區上。
        -->
        <div v-if="showJumpToLatest" class="conv-jump-latest-anchor">
          <button
            type="button"
            class="conv-jump-latest"
            :class="{ 'has-new': hasNewBelow }"
            title="回到對話的最後一則訊息"
            @click="jumpToLatest"
          >
            <span class="conv-jump-latest__arrow" aria-hidden="true">↓</span>
            <span>{{ hasNewBelow ? '有新訊息' : '回到最新' }}</span>
          </button>
        </div>
      </div>

      <!--
        客人封鎖後推播一定被 LINE 退件。不先講的話，客服會認真打完一長串才看到「發送失敗」，
        而且不會知道是自己這邊沒問題——所以擋在回覆區上面，不是等送出才說。
      -->
      <div v-if="canOperate && selectedUser?.isBlocked" class="conv-blocked-notice">
        <span class="conv-blocked-notice__icon" aria-hidden="true">🚫</span>
        <span>這位客人已封鎖官方帳號，訊息送不出去。要聯絡他請改用其他管道。</span>
      </div>

      <!--
        觀察者整條回覆區都不出現（和上面的 AI 脈絡卡同一個判斷）。
        原本只靠 .conversations-page .el-button--primary 的唯讀 CSS 把「送出」藏掉，
        但那只擋得住 primary 按鈕——picker 裡任何非 primary 的動作鈕都會漏出來，
        點了才跳「觀察者無法執行此操作」。權限要在 markup 決定，不是靠按鈕顏色。
      -->
      <div v-if="canOperate" class="conv-input-tools">
        <div class="conv-picker-actions" data-tour="conv-presets">
          <el-dropdown trigger="click" placement="top-start" @command="onQuickSendCommand">
            <button
              type="button"
              class="conv-picker-trigger"
              :disabled="sending || msgLoading || !selectedUserId"
              title="傳圖片、影片或檔案給客人"
            >
              <span class="conv-picker-trigger__plus">＋</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="action in quickSendActions"
                  :key="action.type"
                  :command="action.type"
                >
                  <span class="conv-quick-send-item">
                    <span class="conv-quick-send-item__icon">{{ action.icon }}</span>
                    <span>{{ action.label }}</span>
                  </span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-popover
            v-for="picker in pickerModes"
            :key="picker.key"
            v-model:visible="pickerVisible[picker.key]"
            trigger="click"
            placement="top-start"
            :width="340"
            popper-class="conv-picker-popover"
            @hide="pendingSticker = null"
          >
            <template #reference>
              <button
                type="button"
                class="conv-picker-trigger"
                :disabled="sending"
                :title="picker.hint"
              >
                <img
                  :src="picker.triggerIcon"
                  :alt="picker.key"
                  class="conv-picker-trigger__icon"
                />
              </button>
            </template>
            <div class="conv-picker-panel">
              <div class="conv-picker-title">{{ picker.title }}</div>
              <div class="conv-picker-tabs">
                <button
                  v-for="cat in picker.categories"
                  :key="cat.id"
                  type="button"
                  class="conv-picker-tab"
                  :class="{ active: getActiveCategory(picker.key) === cat.id }"
                  @click="setActiveCategory(picker.key, cat.id)"
                >
                  <span>{{ cat.label }}</span>
                </button>
              </div>
              <div class="conv-picker-scrollbox">
                <div class="conv-picker-grid" :class="`conv-picker-grid--${picker.key}`">
                  <button
                    v-for="item in getPickerItems(picker.key)"
                    :key="item.id"
                    type="button"
                    class="conv-picker-option"
                    :class="[
                      `conv-picker-option--${picker.key}`,
                      { active: isPendingSticker(item) },
                    ]"
                    :disabled="sending"
                    @click="onPickerItemSelect(picker.key, item)"
                  >
                    <img
                      v-if="item.kind === 'sticker'"
                      :src="stickerPreviewUrl(item.stickerId)"
                      :alt="`sticker ${item.stickerId}`"
                      class="conv-picker-option__image"
                    />
                    <span v-else class="conv-picker-option__emoji">{{ item.emoji }}</span>
                  </button>
                </div>
              </div>
              <!--
                貼圖改成先選再送。表情是插進輸入框（送出前隨時能刪），但貼圖點下去就直接
                飛給客人、收不回來——同一顆按鈕裡兩種力道，得讓不可逆的那個多一步。
              -->
              <template v-if="picker.key === 'sticker'">
                <p class="conv-picker-note">
                  {{ pendingSticker ? '確認送出後客人馬上會收到，收不回來。' : '點一張貼圖選起來，再按送出。' }}
                </p>
                <div class="conv-picker-footer">
                  <el-button
                    size="small"
                    type="primary"
                    :loading="sending"
                    :disabled="!pendingSticker || sending"
                    @click="sendPendingSticker"
                  >
                    送出貼圖
                  </el-button>
                </div>
              </template>
            </div>
          </el-popover>
          <el-popover
            v-if="selectedUserId"
            v-model:visible="quickReplyPickerVisible"
            trigger="click"
            placement="top-start"
            :width="340"
            popper-class="conv-picker-popover"
            @hide="pendingQuickReplyId = ''"
          >
            <template #reference>
              <!-- ⚠️同上：這是 el-popover 的 reference，包 tooltip 會搶掉觸發（D-33 P2） -->
              <button
                type="button"
                class="conv-picker-trigger"
                :disabled="sending || msgLoading"
                title="挑一則客服預存回覆：可直接送出，也可先填進回覆框改過再送"
              >
                <span class="conv-picker-trigger__emoji">📦</span>
              </button>
            </template>
            <div class="conv-picker-panel">
              <div class="conv-picker-title">挑一則回覆</div>
              <el-input
                v-if="quickReplyNeedsSearch"
                v-model="quickReplySearch"
                placeholder="搜尋名稱…"
                clearable
                size="small"
              />
              <div class="conv-picker-scrollbox">
                <div v-if="quickReplyLoading" class="conv-picker-empty">載入中…</div>
                <div v-else-if="!quickReplyItems.length" class="conv-picker-empty">
                  <template v-if="quickReplySearch.trim()">
                    找不到符合「{{ quickReplySearch.trim() }}」的項目
                  </template>
                  <template v-else>
                    還沒有啟用的客服預存。建立常用回覆後，就能在這裡直接取用。
                    <a class="conv-picker-empty__link" @click="openQuickReplySource()">去建立客服預存</a>
                  </template>
                </div>
                <div v-else class="conv-support-preset-list">
                  <button
                    v-for="item in quickReplyItems"
                    :key="item.id"
                    type="button"
                    class="conv-support-preset-option"
                    :class="{ active: pendingQuickReplyId === item.id }"
                    :disabled="isSupportPresetBusy || quickReplyFilling"
                    @click="pendingQuickReplyId = item.id"
                  >
                    <span class="conv-support-preset-option__name">{{ item.name || '(未命名)' }}</span>
                    <span class="conv-support-preset-option__meta">{{ item.meta }}</span>
                  </button>
                </div>
              </div>
              <p class="conv-picker-note">{{ quickReplyNote }}</p>
              <div class="conv-picker-footer">
                <el-button
                  size="small"
                  :loading="sending"
                  :disabled="!pendingQuickReplyItem || isSupportPresetBusy || quickReplyFilling"
                  @click="sendQuickReply"
                >
                  直接送出
                </el-button>
                <el-button
                  size="small"
                  type="primary"
                  :loading="quickReplyFilling"
                  :disabled="!canFillQuickReply || isSupportPresetBusy"
                  @click="fillQuickReply"
                >
                  填入回覆框
                </el-button>
              </div>
            </div>
          </el-popover>
        </div>
        <!-- ⛔ 這裡原本有一整句「點上面的按鈕，可以挑圖片、貼圖…」的說明：第一天有用，
             第一百天還在，佔一整行而且每次視線往下都要越過它（G-27②）。
             說明改掛在四顆圖示各自的 title 上（滑上去才講）。 -->
      </div>

      <div v-if="canOperate" class="conv-input-row" data-tour="conv-reply">
        <el-input
          ref="inputRef"
          v-model="inputText"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 8 }"
          resize="none"
          placeholder="輸入訊息（可含 emoji），Enter 送出、Shift + Enter 換行…"
          :disabled="sending"
          @keydown.enter="onInputEnter"
          @paste="onInputPaste"
        />
        <el-button type="primary" :loading="sending" :disabled="!canSend" @click="send">
          送出
        </el-button>
      </div>
      </div>

      <!-- 右側客人卡：**與好友頁同一個元件**（改一次兩邊都變）。
           ⛔ 按需載入——它自己在 userId 變動時撈一次，**沒有掛進 30 秒清單輪詢**
              （那是 2026-08-11 讀取費暴衝的形狀）。 -->
      <aside v-if="selectedUserId && customerPanelOpen" class="conv-customer">
        <div class="conv-customer__hd">
          <span class="conv-customer__title">客人檔案</span>
          <button type="button" class="conv-customer__collapse" title="收起客人檔案" @click="customerPanelOpen = false">✕</button>
        </div>
        <div class="conv-customer__body">
          <AdminCustomerCard
            :user-id="selectedUserId"
            :api-fetch="apiFetch"
            :can-operate="canOperate"
            :fallback-name="selectedUser?.displayName"
            :fallback-picture="selectedUser?.pictureUrl"
            :show-last-activity="false"
            :show-assignee="false"
            @open-conversation="sid => sid && openSessionById(sid)"
          />
        </div>
      </aside>
      </div>
    </template>
  </AdminSplitLayout>

  <el-dialog
    v-model="mediaDialogVisible"
    :title="quickSendDialogTitle"
    width="min(520px, 92vw)"
    destroy-on-close
  >
    <div class="admin-field-stack conv-quick-send-form">
      <div v-if="quickSendType === 'image'" class="admin-field-group">
        <AdminFieldLabel text="圖片檔案" tight />
        <div class="conv-quick-upload conv-quick-upload--zone">
          <input
            ref="imageInputRef"
            type="file"
            :accept="IMAGE_ACCEPT_ATTR"
            class="admin-hidden-input"
            :disabled="sending || quickMediaUploading"
            @change="onQuickFileChange('image', $event)"
          />
          <div
            v-if="mediaForm.originalContentUrl"
            class="fuz-preview conv-quick-preview-zone"
            :style="quickMediaFrameStyle"
          >
            <img
              :src="mediaForm.originalContentUrl"
              alt="image-preview"
              class="fuz-preview-img"
              @load="onQuickImageLoad"
            />
            <div class="fuz-preview-overlay">
              <el-button size="small" type="primary" :disabled="sending || quickMediaUploading" @click="triggerQuickPick('image')">
                更換圖片
              </el-button>
            </div>
          </div>
          <div
            v-else
            class="upload-zone fuz-zone"
            :class="{ uploading: quickMediaUploading }"
            @click="triggerQuickPick('image')"
          >
            <div class="fuz-idle">
              <span class="fuz-icon">📷</span>
              <span class="fuz-label">點擊上傳圖片</span>
              <el-button type="primary" size="small" class="admin-btn-compact fuz-upload-btn" :disabled="sending || quickMediaUploading">
                選擇圖片
              </el-button>
              <span class="fuz-hint">JPG / PNG，最大 {{ imageMaxKb }}KB</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="quickSendType === 'video'" class="admin-field-group">
        <AdminFieldLabel text="影片檔案" tight />
        <div class="conv-quick-upload conv-quick-upload--zone">
          <input
            ref="videoInputRef"
            type="file"
            :accept="VIDEO_ACCEPT_ATTR"
            class="admin-hidden-input"
            :disabled="sending || quickMediaUploading"
            @change="onQuickFileChange('video', $event)"
          />
          <div
            v-if="mediaForm.originalContentUrl"
            class="fuz-preview conv-quick-preview-zone"
            :style="quickMediaFrameStyle"
          >
            <video
              :src="mediaForm.originalContentUrl"
              class="fuz-preview-img"
              controls
              preload="metadata"
              @loadedmetadata="onQuickVideoMetadata"
            />
            <div class="fuz-preview-overlay">
              <el-button size="small" type="primary" :disabled="sending || quickMediaUploading" @click="triggerQuickPick('video')">
                更換影片
              </el-button>
            </div>
          </div>
          <div
            v-else
            class="upload-zone fuz-zone"
            :class="{ uploading: quickMediaUploading }"
            @click="triggerQuickPick('video')"
          >
            <div class="fuz-idle">
              <span class="fuz-icon">🎬</span>
              <span class="fuz-label">點擊上傳影片</span>
              <el-button type="primary" size="small" class="admin-btn-compact fuz-upload-btn" :disabled="sending || quickMediaUploading">
                選擇影片
              </el-button>
              <span class="fuz-hint">MP4，最大 {{ videoMaxMb }}MB（系統會自動產生預覽）</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="quickSendType === 'audio'" class="admin-field-group">
        <AdminFieldLabel text="音訊檔案" tight />
        <div class="conv-quick-upload">
          <input
            ref="audioInputRef"
            type="file"
            :accept="AUDIO_ACCEPT_ATTR"
            class="admin-hidden-input"
            :disabled="sending || quickMediaUploading"
            @change="onQuickFileChange('audio', $event)"
          />
          <el-button :disabled="sending || quickMediaUploading" @click="triggerQuickPick('audio')">
            {{ mediaForm.originalContentUrl ? '重新上傳音訊' : '選擇音訊' }}
          </el-button>
          <span class="conv-quick-upload__hint">M4A / MP3 / WAV，最大 {{ audioMaxMb }}MB</span>
        </div>
      </div>

      <div v-if="quickMediaUploading" class="conv-quick-uploading text-muted">
        上傳中，請稍候...
      </div>
    </div>
    <template #footer>
      <div class="conv-quick-send-form__footer">
        <el-button :disabled="sending || quickMediaUploading" @click="mediaDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="sending" :disabled="!canSendQuickMedia" @click="sendQuickMedia">
          送出
        </el-button>
      </div>
    </template>
  </el-dialog>

  <!-- 對話列表右鍵／⋯ 選單（釘選 / 待跟進）；觀察者不會開啟，保留瀏覽器原生選單 -->
  <AdminContextMenu
    v-model:visible="contextMenuVisible"
    :x="contextMenuPos.x"
    :y="contextMenuPos.y"
    :title="contextMenuTarget?.displayName"
    :items="contextMenuItems"
    @select="onContextMenuSelect"
  />

</template>

<script setup lang="ts">
import { ChatDotRound } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import {
  AUDIO_ACCEPT_ATTR,
  AUDIO_MAX_BYTES,
  IMAGE_ACCEPT_ATTR,
  IMAGE_MAX_BYTES,
  VIDEO_ACCEPT_ATTR,
  VIDEO_MAX_BYTES,
} from '~~/shared/upload-rules'
import { lineAspectRatioToCss } from '~~/shared/media-preview'
import {
  MODULE_TYPE_LABELS,
  STATUS_LABELS,
  type ConversationStatus,
  type ModuleType,
} from '~~/shared/types/conversation-stats'
import { FOLLOW_UP_LIST_LIMIT } from '~~/shared/conversation-flags'
import { assigneeInitial, NO_ASSIGNEE, type ConversationAssignee } from '~~/shared/conversation-assignee'
import { customerLastMessageMs, isConversationUnread } from '~~/shared/conversation-unread'
import { MESSAGE_SENDER_LABELS, MESSAGE_SENDER_HINTS, type MessageSender } from '~~/shared/message-sender'
import { isCustomerActionMessage } from '~~/shared/customer-action'
import { chatDayKey, formatChatDayLabel } from '~~/shared/chat-day'
import type { AutoReplyActionType } from '~~/shared/auto-reply-rule'
import type { TimelineItem, TimelineResponse, TimelineSessionMeta } from '~~/shared/types/conversation-timeline'
import type { AiContextPayload, AiContextSessionWindow } from '~~/shared/types/ai-knowledge'
import type { AdminContextMenuItem } from '~/components/admin/ContextMenu.vue'

/** 與 `useWorkspace().apiFetch` 相同簽章，由路由頁注入（含 workspaceId）。 */
const props = defineProps<{
  apiFetch: <T>(url: string, options?: Parameters<typeof $fetch>[1]) => Promise<T>
}>()

const { apiFetch } = props
const { assertCanOperate } = useAdminOperateGuard()

const route = useRoute()
const workspaceId = computed(() => String(route.params.workspaceId || ''))

/**
 * 未讀紅點的兩個記號，都只存在這台電腦的 localStorage（每個 workspace 一份）：
 *
 * · convLastReadMs  — 每位客人「我看到哪個時間點為止」
 * · readAllBeforeMs — 舊版「全部已讀」留下的那條全域時間線，比它舊的一律算看過。
 *                    **只讀不再寫**：2026-08-19 改成逐位客人蓋章（見 markAllConversationsRead）。
 *                    留著是為了升級當下不要把使用者早就清掉的紅點整批倒回來。
 *
 * 兩者取大的那個當基準（見 isRowUnread）。已讀是每個人自己的，不跟同事共用——
 * 同事看過不代表你看過。
 */
const convLastReadMs = ref<Record<string, number>>({})
const readAllBeforeMs = ref(0)
/** 已讀記錄的保留筆數上限：只留最近看過的這幾位，免得 localStorage 無限長大 */
const CONV_READ_KEEP = 1000
const pageHasFocus = ref(true)
const savedDocumentTitle = ref('')
let listPollTimer: ReturnType<typeof setInterval> | null = null

function convReadStorageKey(): string {
  const wid = workspaceId.value
  return wid ? `admin-conv-lastRead:${wid}` : ''
}

function convReadAllStorageKey(): string {
  const wid = workspaceId.value
  return wid ? `admin-conv-readAll:${wid}` : ''
}

function readStoredConvLastRead(): Record<string, number> {
  if (typeof localStorage === 'undefined')
    return {}
  const key = convReadStorageKey()
  if (!key)
    return {}
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) as Record<string, number> : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    return {}
  }
}

/**
 * 兩份已讀記錄合成一份，每位客人各取比較晚的那個。
 *
 * 已讀只會往前走（看過的不會變成沒看過），所以「取大的」永遠是安全的合併方式。
 * 這是同一台電腦開兩個後台分頁時唯一不會互相蓋掉的做法——先前兩邊各自把記憶體裡的
 * 整包寫回去、後寫的贏，於是 A 分頁清掉的紅點會被 B 分頁倒回來（反過來也一樣），
 * 使用者看到的就是紅點忽有忽無。
 */
function mergeConvLastRead(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...a }
  for (const [userId, ms] of Object.entries(b)) {
    const n = Number(ms)
    if (Number.isFinite(n) && n > (merged[userId] ?? 0)) merged[userId] = n
  }
  return merged
}

function hydrateConvLastRead() {
  if (typeof localStorage === 'undefined')
    return
  const key = convReadStorageKey()
  if (!key) {
    convLastReadMs.value = {}
    readAllBeforeMs.value = 0
    return
  }
  convLastReadMs.value = readStoredConvLastRead()
  const allMs = Number(localStorage.getItem(convReadAllStorageKey()) || 0)
  readAllBeforeMs.value = Number.isFinite(allMs) && allMs > 0 ? allMs : 0
}

/**
 * 寫回 localStorage 前先把硬碟上那份併進來（見 mergeConvLastRead）：
 * 另一個分頁在我們載入之後蓋的章不能被沖掉。
 */
function persistConvLastRead() {
  if (typeof localStorage === 'undefined')
    return
  const key = convReadStorageKey()
  if (!key)
    return
  const merged = pruneConvLastRead(mergeConvLastRead(readStoredConvLastRead(), convLastReadMs.value))
  convLastReadMs.value = merged
  try {
    localStorage.setItem(key, JSON.stringify(merged))
  }
  catch {
    /* quota or private mode */
  }
}

/**
 * 另一個分頁蓋了已讀 → 這個分頁的紅點也要跟著消。
 * localStorage 的 storage 事件只在**其他**分頁寫入時觸發，所以不會跟自己打架。
 */
function onConvReadStorage(e: StorageEvent) {
  const key = convReadStorageKey()
  if (!key || (e.key && e.key !== key))
    return
  convLastReadMs.value = mergeConvLastRead(convLastReadMs.value, readStoredConvLastRead())
  applyUnreadDocumentTitle()
}

/** 超過上限就丟掉最久沒看的那些（被丟掉的列往後捲到才會再亮一次，總比爆掉配額好） */
function pruneConvLastRead(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map)
  if (entries.length <= CONV_READ_KEEP)
    return map
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, CONV_READ_KEEP))
}

/**
 * 把這位客人標成「看到 seenUpToMs 為止」。
 *
 * 記的是**看到哪一則**，不是**幾點看的**——一律用伺服器蓋的時間戳（列上那一列的時間、
 * 這次真的載到的最新一則），完全不碰 Date.now()。兩個理由，方向相反但都會出事：
 *
 * · 電腦時鐘**慢**兩分鐘 → 已讀時間永遠早於訊息時間，紅點按幾次都不會消。
 * · 電腦時鐘**快**兩分鐘 → 已讀基準被推到未來，接下來兩分鐘內客人來訊一律不亮紅點，
 *   而且毫無徵兆。這個比前者更糟：前者看得出來，後者是靜靜漏掉客人。
 *
 * 兩邊比的都是伺服器時間就沒有這回事。另一個好處是「看舊會話」不會誤蓋新的：
 * 點開上個月那場，看到的最新一則就是那場的最後一則，蓋不到這位客人現在那場的新訊息，
 * 所以進行中那場的紅點會正確地留著（已讀是記在客人身上的，見 convLastReadMs）。
 */
function markConversationRead(userId: string, seenUpToMs = 0) {
  if (!userId)
    return
  const readMs = Math.max(seenUpToMs, convLastReadMs.value[userId] ?? 0)
  if (readMs <= 0)
    return
  convLastReadMs.value = pruneConvLastRead({ ...convLastReadMs.value, [userId]: readMs })
  persistConvLastRead()
}

/**
 * 分頁在背景（切到別的分頁、或視窗沒有焦點）時先不蓋已讀，等人回來再蓋。
 *
 * 對話開著的時候客人來訊，我們會自己把新的一段讀進來（見 maybeRefreshOpenTimeline）——
 * 那一步順手蓋已讀的話，人明明不在電腦前面，紅點和分頁標題的「（3）」就先被清掉了，
 * 那顆標題數字整個失去意義（它只在背景時才顯示，見 applyUnreadDocumentTitle）。
 * 所以背景時只記著「欠這位客人一個章」，回到前景那一刻才真的蓋下去。
 */
/**
 * 一位客人一筆，不是只留最後一位——**先前只存一筆**，切走前連看兩位客人的話，
 * 前一位的章會被後一位覆蓋掉，他的紅點就消不掉了。
 */
const pendingReadStamps = new Map<string, number>()

function pageIsVisible(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    return false
  return pageHasFocus.value
}

function stampConversationRead(userId: string, seenUpToMs: number) {
  if (!userId || seenUpToMs <= 0)
    return
  if (pageIsVisible()) {
    markConversationRead(userId, seenUpToMs)
    return
  }
  pendingReadStamps.set(userId, Math.max(pendingReadStamps.get(userId) ?? 0, seenUpToMs))
}

function flushPendingReadStamp() {
  if (!pendingReadStamps.size || !pageIsVisible())
    return
  const pending = [...pendingReadStamps.entries()]
  pendingReadStamps.clear()
  for (const [userId, seenUpToMs] of pending) markConversationRead(userId, seenUpToMs)
}

/** 一批時間戳裡最新的那個（ms）；用來把「這次畫面上真的看到的最新一則」交給 markConversationRead */
function newestTimestampMs(list: unknown[]): number {
  let max = 0
  for (const ts of list) {
    const ms = messageTimestampToMs(ts)
    if (ms > max)
      max = ms
  }
  return max
}

/**
 * 「全部已讀」：把**目前清單上看得到的**紅點一次清掉，逐位客人各蓋一個章。
 *
 * 2026-08-19 從「一條全域時間線」改成這樣。原本那條線取的是已載入列裡最新的動靜時間
 * （lastActivityAt——結案、接手、半夜排程都會把它往前推），比它舊的一律算看過。
 * 問題是它跨分頁生效又永遠不會降：在「待真人」按下寫著「全部已讀（2）」的按鈕，
 * 會把「全部」分頁裡所有比那個時間早、你從沒點開過的客人一起變成已讀，而且救不回來——
 * 按鈕上的數字講的是這個分頁的 2 列，實際清掉的是整個 workspace，兩者對不起來。
 *
 * 逐列蓋章的代價是蓋不到還沒載入的後面幾頁（換電腦、清過快取時整排全紅的情境）：
 * 往下捲載進來之後再按一次就好，而且**這次按下去清掉的東西，畫面上都看得見**。
 *
 * 一樣不碰 Date.now()（理由見 markConversationRead），蓋的是每一列上「客人最後開口」
 * 那個時間戳，與紅點比對的欄位同一族。
 */
function markAllConversationsRead() {
  const next = { ...convLastReadMs.value }
  const stamp = (userId: string, ms: number) => {
    if (!userId || ms <= 0) return
    next[userId] = Math.max(next[userId] ?? 0, ms)
  }
  for (const c of conversations.value as ConvItem[]) stamp(c.userId, convRowCustomerMs(c))
  for (const s of sessions.value as SessionItem[]) stamp(s.userId, sessionRowCustomerMs(s))
  convLastReadMs.value = pruneConvLastRead(next)
  persistConvLastRead()
}

function messageTimestampToMs(ts: any): number {
  if (ts == null || ts === '')
    return 0
  if (typeof ts === 'number' && Number.isFinite(ts))
    return ts < 1e11 ? Math.round(ts * 1000) : Math.round(ts)
  if (typeof ts === 'string') {
    const d = new Date(ts)
    const t = d.getTime()
    return Number.isFinite(t) ? t : 0
  }
  if (typeof ts === 'object') {
    if (typeof ts.toMillis === 'function') {
      const t = ts.toMillis()
      return Number.isFinite(t) ? t : 0
    }
    if (typeof ts.toDate === 'function') {
      const d = ts.toDate()
      const t = d?.getTime?.() ?? NaN
      return Number.isFinite(t) ? t : 0
    }
    const secRaw = ts._seconds ?? ts.seconds
    if (secRaw !== undefined && secRaw !== null && secRaw !== '') {
      const sec = typeof secRaw === 'string' ? Number(secRaw) : secRaw
      const nsRaw = ts._nanoseconds ?? ts.nanoseconds ?? 0
      const ns = typeof nsRaw === 'string' ? Number(nsRaw) : nsRaw
      if (Number.isFinite(sec))
        return sec * 1000 + (Number.isFinite(ns) ? Math.floor(ns / 1e6) : 0)
    }
  }
  return 0
}

/**
 * 列表摘要前面那句「這則是誰送的」。
 *
 * 兩邊都標，不是只標我們送的那一側：「我們」「客人」都是兩個字加全形冒號，寬度一樣，
 * 所以摘要一律從同一條直線開始——掃一整排的時候方向自己對齊成一欄，不用逐列讀。
 * 先前是 `↑` 箭頭，沒有人看得出那是什麼意思。
 *
 * 只講方向、不講是誰回的（真人／AI／機器人的區分在泡泡旁邊的標籤，見 shared/message-sender.ts）——
 * 列表要回答的是「這位客人還在等我們嗎」，所以對外一律算「我們」。
 */
function directionPrefix(row: { lastMessage?: string, lastDirection?: string }): string {
  if (!String(row.lastMessage || '').trim()) return ''
  return row.lastDirection === 'outgoing' ? '我們：' : '客人：'
}

/**
 * 這一列「客人最後開口」是什麼時候（epoch ms）——紅點比的就是這個值，
 * 蓋已讀章的也是這個值。規則與舊資料退路寫在 shared/conversation-unread.ts。
 *
 * 兩種列各有自己的欄位名，但意思完全一樣，所以拆成兩支小的、不要在呼叫端東拼西湊：
 * 會話列的最後一則叫 unreadAt（已結束的場為 null），對話列的叫 lastMessageAt。
 */
function convRowCustomerMs(c: ConvItem): number {
  return customerLastMessageMs({
    customerLastMs: messageTimestampToMs(c.customerLastAt),
    lastMessageMs: messageTimestampToMs(c.lastMessageAt),
    lastDirection: c.lastDirection,
  })
}

function sessionRowCustomerMs(s: SessionItem): number {
  return customerLastMessageMs({
    customerLastMs: messageTimestampToMs(s.customerLastAt),
    lastMessageMs: messageTimestampToMs(s.unreadAt),
    lastDirection: s.lastDirection,
  })
}

/**
 * 紅點＝「客人講過話，而且還沒有人真的看過這段對話」。
 *
 * 2026-08-19 老闆拍板換掉舊口徑（「最後一則是客人送的」＝把紅點當待辦、AI 回完就不算）。
 * 為什麼換、以及舊資料怎麼退路，全寫在 shared/conversation-unread.ts，那裡是唯一一份規則。
 *
 * 這一支只負責把「我看到哪為止」湊上去：這位客人的已讀時間，和舊版「全部已讀」留下的
 * 那條全域時間線，取大的那個。已讀時間都記在同一位客人身上（見 convLastReadMs），
 * 所以同一位客人在五個分頁看到的紅點一致。
 *
 * ⛔ 這裡比的欄位改動時，蓋已讀章的來源（selectedRowCustomerLastMs、loadTimeline）
 *    必須一起改成同一族時間戳，否則章永遠差一步、紅點怎麼等都不會消。
 */
function isRowUnread(userId: string, customerLastMs: number): boolean {
  const readMs = Math.max(readAllBeforeMs.value, convLastReadMs.value[userId] ?? 0)
  return isConversationUnread({ customerLastMs, lastMessageMs: 0 }, readMs)
}

function applyUnreadDocumentTitle() {
  if (typeof document === 'undefined' || !savedDocumentTitle.value)
    return
  const n = unreadRowCount.value
  const backgrounded = document.visibilityState === 'hidden' || !pageHasFocus.value
  if (n > 0 && backgrounded)
    document.title = `（${n}）${savedDocumentTitle.value}`
  else
    document.title = savedDocumentTitle.value
}

function onWindowFocus() {
  pageHasFocus.value = true
  flushPendingReadStamp()
  applyUnreadDocumentTitle()
}

function onWindowBlur() {
  pageHasFocus.value = false
  applyUnreadDocumentTitle()
}

function onVisibilityChange() {
  flushPendingReadStamp()
  applyUnreadDocumentTitle()
  // 背景時輪詢是停的（見 listPollTimer），回前景補刷一次把漏掉的變化拉回來。
  // 搜尋中一樣不重抓（口徑同輪詢，否則每次切回分頁就重掃一次全 workspace 的對話）
  if (typeof document !== 'undefined' && !document.hidden && !listAutoRefreshPaused.value
    && !listLoading.value && !listLoadingMore.value)
    void refreshListQuiet()
}

// ── Session tab types ─────────────────────────────────────────────

// 沿用共用型別，不要在這裡再列一次（列兩份就會像先前的標籤那樣各自漂走）
type ConvSessionStatus = ConversationStatus
type TabValue = 'all' | ConvSessionStatus

interface SessionItem {
  sessionId: string
  userId: string
  displayName: string
  pictureUrl: string
  status: ConvSessionStatus
  initialHandler: string
  hasHandoff: boolean
  /** 這場最後一次有動靜的時間（含接手／交還／結案／排程等非訊息動作）＝列上那顆時間膠囊 */
  lastActivityAt: any
  /**
   * 這場最後一則**訊息**的時間（不分方向）；已結束的場為 null。
   * 用途有兩個：舊資料的紅點退路（見 shared/conversation-unread.ts），以及判斷
   * 開著的對話要不要重讀（見 maybeRefreshOpenTimeline）。
   * 為什麼不能拿 lastActivityAt 兼用，見 sessions.get.ts 的 mapSessionToRow。
   */
  unreadAt: any
  /** 客人最後一則訊息的時間＝紅點比的那個值；已結束的場為 null（＝不亮） */
  customerLastAt: any
  /**
   * 這場會話的最後一則訊息。進行中的場來自對話文件、已結束的場來自關閉當下的快照，
   * 都在後端算好（見 sessions.get.ts 的 mapSessionToRow）。
   * 空字串＝快照上線前就結束的舊會話，畫面顯示 SESSION_NO_PREVIEW，不猜內容。
   */
  lastMessage: string
  lastDirection: 'incoming' | 'outgoing'
  /** 對話層級的人工標記（見 ConvItem） */
  pinned?: boolean
  followUp?: boolean
  /** 負責人員也是對話層級的（見 ConvItem） */
  assignee?: ConversationAssignee
}

/** 舊會話沒有訊息快照時的第二行。講清楚是「我們沒留」不是「客人沒講話」 */
const SESSION_NO_PREVIEW = '（舊會話沒有訊息預覽）'

/**
 * 這一排全部是**系統依對話狀況判定**的會話狀態，不是人標的。
 * hint 會變成 title tooltip：兩個「待」開頭的分頁光看名字分不出差別，滑上去要講得出來。
 */
const STATUS_TABS: { value: TabValue; label: string; hint: string }[] = [
  { value: 'all', label: '全部', hint: '所有對話，最新訊息排前面（釘選的會置頂）' },
  { value: 'pending_human', label: '待真人', hint: '系統判定：客人要求真人，還沒有人接手' },
  { value: 'human_handling', label: '真人處理', hint: '系統判定：已經有同事接手，機器人與 AI 暫停自動回覆' },
  // 「待處理」＝還需不需要人處理（佇列語意）。不要改成「未首接」——那是統計看板
  // 的指標名稱（有沒有人回答過），兩者是不同的一群對話，同名會被誤讀成同一個數字。
  // 也不要和右鍵的人工標記混用同一個詞，那個叫「待跟進」（見 shared/conversation-flags.ts）。
  { value: 'open', label: '待處理', hint: '系統判定：這場對話還沒有人處理過（不是你手動標的「待跟進」）' },
  { value: 'bot_handling', label: '機器人', hint: '系統判定：目前由機器人／AI 自動回覆中' },
  { value: 'closed', label: '結束', hint: '系統判定：已結束的會話' },
]

/**
 * 六個分頁擠成三排（G-27③）：吃掉清單上方約 100px，而且六個平權——
 * 其中「機器人 2324」這個最大的數字，正好是**最不需要人看**的一群（AI 自己處理完的），
 * 視覺上卻最搶眼。
 *
 * 收法＝一排只放「要人動手」的三個，其餘（全部／機器人／結束）收進右邊一個下拉。
 * ⛔ 不是刪掉，是換位置：三個都還在下拉裡，而且哪一個在用就顯示哪一個。
 * ⛔ 順序照「急迫度」排，不照原本的宣告順序。
 */
const PRIMARY_TAB_VALUES: TabValue[] = ['pending_human', 'human_handling', 'open']

/** 一排顯示的那三個（照急迫度排，不照宣告順序） */
const PRIMARY_STATUS_TABS = PRIMARY_TAB_VALUES
  .map(v => STATUS_TABS.find(t => t.value === v))
  .filter((t): t is (typeof STATUS_TABS)[number] => !!t)

/** 收進下拉的其餘三個（全部／機器人／結束） */
const SECONDARY_STATUS_TABS = STATUS_TABS.filter(t => !PRIMARY_TAB_VALUES.includes(t.value))

/**
 * 直接用共用定義，不要在這裡再抄一份。
 *
 * 先前這裡自己寫了一份、而且把 open 從「待處理」覆寫成「未首接」，結果同一個詞
 * 在側欄（還需不需要人處理）和統計看板（有沒有人回答過）指兩件不同的事，
 * 連新手教學講的都跟畫面不一致。詳見 docs/CONVERSATION-STATS-DEFINITIONS.md。
 */
const SESSION_STATUS_LABELS = STATUS_LABELS

interface ConvItem {
  userId: string
  displayName: string
  pictureUrl: string
  lastMessage: string
  lastDirection: 'incoming' | 'outgoing'
  lastMessageAt: any
  /** 客人最後一則訊息的時間＝紅點比的那個值（見 shared/conversation-unread.ts） */
  customerLastAt?: any
  /** 客人已封鎖官方帳號：推播會被 LINE 退件，回覆區要先擋一句話 */
  isBlocked?: boolean
  /**
   * 右鍵下的兩個人工標記（全 workspace 共用）。與會話狀態、統計完全無關——
   * 為什麼是「待跟進」不是「待處理」見 ~~/shared/conversation-flags.ts。
   */
  pinned?: boolean
  followUp?: boolean
  /** 負責人員：哪一位同事在跟這條線（G-27 功能缺口②）。uid 空字串＝還沒有人負責 */
  assignee?: ConversationAssignee
}

interface MsgItem {
  id: string
  direction: 'incoming' | 'outgoing'
  text: string
  messageType?: string
  payload?: any
  timestamp: any
  /** 對方曾來訊／互動後推定已讀（見後端說明） */
  readByPeer?: boolean
  /** 客人傳的圖，AI 讀出來的一句說明；AI 未啟用或讀不出來就沒有 */
  mediaDescription?: string
  /**
   * 這則是誰回的（真人 / AI / 機器人 / 系統）。null 或沒有＝這功能上線前存的舊訊息，
   * 泡泡上不掛標籤——猜一個來源比空白更糟（客服會拿假來源去追責任）。
   */
  sender?: MessageSender | null
  /** 標籤 tooltip 上補的一句：真人＝哪位同事，機器人＝哪個模組／規則 */
  senderName?: string
  /**
   * 這則是哪一次 AI 回合送出的。有值才給「為什麼這樣答」——空＝這功能上線前的舊訊息，
   * 刻意不用時間去猜是哪一回合（猜錯會讓客服對著錯的那一題按「答錯」）。
   */
  aiTurnId?: string
  /**
   * 只有「還在送 / 送失敗」的那則會有：這是還沒被伺服器確認的本地泡泡。
   * 有值代表這則不是從後端讀回來的（見 pendingOutgoing）。
   */
  localId?: string
  sendStatus?: 'sending' | 'failed'
  sendError?: string
}

/** 樂觀上畫面的待送訊息：先出現在對話裡，POST 在背景跑 */
interface PendingOutgoing {
  localId: string
  /** 綁在哪位客人身上——客服可能送完就切走，回來還要看得到 */
  userId: string
  text: string
  at: number
  status: 'sending' | 'failed'
  error?: string
}

/**
 * 時間軸 API 的形狀（TimelineItem／TimelineResponse／會話 meta）定義在
 * shared/types/conversation-timeline.ts，前後端**同一份**——先前兩邊各抄一份，欄位已經
 * 漂走了（這邊少了 moduleId、把列舉放寬成 string），而兩份都編得過，沒有人會發現。
 */
type SessionPanelMeta = TimelineSessionMeta

/**
 * 訊息流中央那一行灰字。兩種來源共用同一個樣子：
 *   · 系統事件（新會話開始／已交還機器人／群發）
 *   · 客人動作（客人點了什麼、從哪個活動登記）→ variant='action'，多一個手指圖示
 * 刻意不做成泡泡：那不是誰「說」的話，做成泡泡會被讀成訊息內容。
 */
type ChatRowEvent = { kind: 'event'; key: string; label: string; timestamp: any; variant?: 'action'
  /** 原始事件型別：用來分「換手／客人動作」與「純軌跡」，⛔別用 label 字串猜（文案改了就失效） */
  eventType?: string
  /** entered_module 專用：摘要列要講「進了哪一種模組」，label 已經被包成「進入：X」不好拆 */
  moduleType?: string }
type ChatRowMsg = { kind: 'msg'; key: string; msg: MsgItem }
type ChatRow = ChatRowEvent | ChatRowMsg

type PickerKind = 'emoji' | 'sticker'
type QuickSendType = 'image' | 'video' | 'audio'
/** 「挑一則送出」的來源：客服預存 / 自動回覆規則 */
type QuickReplyItem = {
  id: string
  name: string
  meta: string
  /** message = 有純文字可以填進回覆框改；module / uri 只能原封不動送出 */
  actionType: AutoReplyActionType
  /** 送出時會自動貼標籤——改走「填入回覆框」自己送就不會貼，要跟客服講清楚 */
  taggingEnabled: boolean
}

type PickerCategory = {
  id: string
  label: string
}

type PickerItem =
  | { id: string, kind: 'emoji', emoji: string }
  | { id: string, kind: 'sticker', packageId: string, stickerId: string }

type MessageTextSegment = {
  text: string
  isLink: boolean
}

type StructuredCardPreview = {
  title: string
  text: string
  imageUrl: string
  actions: string[]
  /** Flex Image Carousel 用：LINE aspectRatio 字串，例如 "16:9" */
  imageAspectRatio?: string
  /** Flex Image Carousel：整圖點擊動作提示（無底部按鈕時顯示 overlay） */
  heroActionLabel?: string
}

type StructuredVariant = 'buttons' | 'confirm' | 'carousel' | 'image_carousel' | 'flex_image_carousel' | 'flex' | 'imagemap' | 'generic'

type StructuredMessagePreview = {
  variant: StructuredVariant
  cards: StructuredCardPreview[]
}

const { showToast } = useAdminToast()
const { uploadToStorage, validateFile } = useMediaUpload()

const CONV_LIST_PAGE_SIZE = 30

const listLoading = ref(false)
const listLoadingMore = ref(false)
/**
 * 背景刷新進行中。刻意不是 ref：它不該影響任何畫面（那正是「不要整個重整」的重點），
 * 只用來擋自己重入。做成 ref 遲早會有人拿去綁 spinner，就白改了。
 */
let listMerging = false
/** 載入批次流水號，用來丟掉「回來時已經過期」的那一批結果（見 loadList） */
let listLoadSeq = 0
const listHasMore = ref(false)
const listPage = ref(1)
const sidebarListEl = ref<HTMLElement | null>(null)
const msgLoading = ref(false)
const sending = ref(false)
const conversations = ref<ConvItem[]>([])
const sessions = ref<SessionItem[]>([])
/**
 * 目前這位客人的對話時間軸：訊息 + 系統事件 + 群發，已載入的那幾段。
 *
 * 五個分頁共用同一份（不再分「全部走 messages、會話分頁走 timeline」）——同一位客人
 * 從哪個分頁點進去都是同一條完整對話，看到的東西不會不一樣。
 */
const timelineItems = ref<TimelineItem[]>([])
/** 上面還有更早的訊息沒讀（往上滑會自己接著讀，見 loadOlderTimeline） */
const timelineHasOlder = ref(false)
/** 下面還有更晚的訊息沒讀：點進已結束的舊會話時才會有（見 loadNewerTimeline） */
const timelineHasNewer = ref(false)
const loadingOlder = ref(false)
const loadingNewer = ref(false)
/** 選中會話的資料（從會話分頁點進來的那一場） */
const sessionMeta = ref<SessionPanelMeta | null>(null)
/** 「全部」分頁：依 conversations.currentSessionId 取得的進行中會話（可手動結束） */
const allTabActiveSession = ref<SessionPanelMeta | null>(null)
const sessionStatusCounts = ref<Record<ConvSessionStatus, number>>({
  open: 0,
  bot_handling: 0,
  pending_human: 0,
  human_handling: 0,
  closed: 0,
})
const closingSession = ref(false)
const handingBackSession = ref(false)
const takingOverSession = ref(false)
const selectedUserId = ref<string | null>(null)
const selectedSessionId = ref<string | null>(null)
const selectedUser = ref<ConvItem | null>(null)
/**
 * 右側客人檔案面板開著沒（G-26）。用 useState 讓它跨頁記住——客服會依自己的螢幕寬度
 * 決定要不要開，每次進頁面都重新彈出來很煩。預設開：接手前先知道對方是誰，
 * 正是這個面板存在的理由（老闆 08-24 拍板照 LINE 的版面做）。
 */
const customerPanelOpen = useState('conv-customer-panel-open', () => true)
const activeTab = ref<TabValue>('all')

/** 現在選的是不是收在下拉裡那三個（是的話下拉那顆要亮起來，並顯示它的名字） */
const secondaryTabActive = computed(() => !PRIMARY_TAB_VALUES.includes(activeTab.value))

const secondaryTabLabel = computed(() =>
  secondaryTabActive.value
    ? (STATUS_TABS.find(t => t.value === activeTab.value)?.label ?? '其他')
    : '其他',
)

/**
 * 分頁上的數字。
 * ⛔「全部」與「結束」刻意不給數字：那兩個是翻閱用的，給了數字會被讀成待辦數。
 */
function statusTabText(tab: { value: TabValue; label: string }): string {
  if (tab.value === 'all' || tab.value === 'closed') return tab.label
  return `${tab.label}（${sessionStatusCounts.value[tab.value as ConvSessionStatus]}）`
}

const inputText = ref('')
const searchText = ref('')
/** 「只看待跟進」：只在「全部」分頁有意義（其他分頁看的是會話狀態，不是人工標記） */
const followUpFilterOn = ref(false)
/** 待跟進數超過顯示上限時要在列表上明講，不要讓人以為看到的就是全部 */
const followUpListTruncated = ref(false)
// null＝這次讀不到（缺索引之類）：不顯示數字、tooltip 講明，⛔不可以拿 0 冒充（D-43④）
const followUpCount = ref<number | null>(0)
const contextMenuVisible = ref(false)
const contextMenuPos = ref({ x: 0, y: 0 })
const contextMenuTarget = ref<ConvItem | SessionItem | null>(null)
const aiContextRefreshKey = ref(0)
/** 按「我接手」時要叫它整理這場對話的摘要（接手的人第一個想知道的就是這個） */
const aiContextBanner = ref<{ refreshSummary: () => Promise<void> } | null>(null)
/**
 * AI 脈絡卡（含「補知識」與「這題 AI 答錯了」）開放到客服層級。
 *
 * 原本是 super admin only 的階段性開關，但那讓兩顆按鈕對客戶等於不存在——
 * 尤其「答錯了」是唯一能讓人告訴系統「AI 這題答錯」的地方，沒有它就只收得到
 * 「AI 自己說答不出來」那一半訊號。
 * 用 canOperate（agent 以上，不含觀察者）對齊按鈕實際需要的權限：
 * 補知識 = knowledge.write（agent）、答錯標記 = ai-feedback 端點（agent）。
 */
const { canOperate } = useWorkspace()
// 開通沒完成時，空清單要講真話（見 sidebarEmpty）——只讀狀態，不在這裡發查詢
const { onboardingIncomplete } = useSetupStatus()

const inputRef = ref<{ focus: () => void, textarea?: HTMLTextAreaElement } | null>(null)

/**
 * 樂觀送出：泡泡先上畫面、輸入框立刻清空並保持可打字，POST 在背景跑。
 *
 * 原本是等 POST 加整包訊息重新載完才解鎖輸入框——客服要盯著轉圈等好幾秒才能打下一句。
 * 現在等待完全在背景，畫面上只有那顆泡泡旁邊的「傳送中…」。
 */
const pendingOutgoing = ref<PendingOutgoing[]>([])
let pendingOutgoingSeq = 0

/**
 * 每位客人各自的未送出草稿。
 *
 * 原本全站只有一個 inputText：幫 A 客人打到一半、切去看 B 客人一眼，那段字會跟著過去，
 * 一按 Enter 就送給錯的人。切走時收進抽屜、切回來時放回去。
 * 也寫進 localStorage：不小心關掉分頁或重新整理，打到一半的回覆不該就這樣不見。
 */
const drafts = new Map<string, string>()
/** 每位客人的草稿上限（LINE 單則就 5000 字），以及總共記幾位客人 */
const DRAFT_MAX_CHARS = 5000
const DRAFT_MAX_USERS = 50

const draftsStorageKey = computed(() => `conv-drafts:${workspaceId.value || 'unknown'}`)

function loadPersistedDrafts() {
  try {
    const raw = localStorage.getItem(draftsStorageKey.value)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [uid, text] of Object.entries(parsed ?? {})) {
      if (typeof text === 'string' && text.trim()) drafts.set(uid, text.slice(0, DRAFT_MAX_CHARS))
    }
  }
  catch {
    // 存壞了就當作沒有草稿，不要因此擋住整個對話頁
  }
}

function persistDrafts() {
  try {
    // 只留最近動到的幾位，免得 localStorage 無限長大
    const entries = [...drafts.entries()].slice(-DRAFT_MAX_USERS)
    if (!entries.length) localStorage.removeItem(draftsStorageKey.value)
    else localStorage.setItem(draftsStorageKey.value, JSON.stringify(Object.fromEntries(entries)))
  }
  catch {
    // 隱私模式／配額滿：草稿存不進去不影響這次回覆，靜靜略過
  }
}

function stashDraft() {
  const uid = selectedUserId.value
  if (!uid) return
  if (inputText.value.trim()) drafts.set(uid, inputText.value.slice(0, DRAFT_MAX_CHARS))
  else drafts.delete(uid)
  persistDrafts()
}

/** 邊打邊存（節流）：不等切走才存，重新整理也留得住 */
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
watch(inputText, () => {
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(stashDraft, 500)
})

/** 填進回覆框後把游標帶過去：客服下一步一定是改字，不該還要自己再點一次 */
function focusInput() {
  inputRef.value?.focus?.()
}

function applyAiDraft(text: string) {
  inputText.value = String(text || '')
  nextTick(focusInput)
}

/** 開新分頁去補知識（帶客人原句預填），不離開現場對話——和 playground 同一做法 */
function goAddKnowledge(query: string) {
  const q = String(query || '').trim()
  const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
  window.open(`/admin/${workspaceId.value}/knowledge/sources${suffix}`, '_blank')
}

/**
 * 「去修這張卡」：AI 答錯時，要動的就是它照著答的那張知識卡。
 * 知識庫頁已經吃 ?chunkId=（反查所屬資料、選中、直接開編輯視窗），這裡沿用同一個入口。
 */
function goEditChunk(chunkId: string) {
  const id = String(chunkId || '').trim()
  if (!id) return
  window.open(`/admin/${workspaceId.value}/knowledge/sources?chunkId=${encodeURIComponent(id)}`, '_blank')
}

/**
 * 泡泡旁「為什麼這樣答」展開的那一則。
 *
 * 一次只開一則（同時攤開三則脈絡，對話就讀不下去了）。內容等點下去才抓——
 * 一串對話可能有十幾則 AI 回覆，預先全撈是十幾次讀取換一個多半沒人看的面板。
 */
const openTurnKey = ref('')
const turnCtx = ref<AiContextPayload | null>(null)
const turnLoading = ref(false)
const turnError = ref('')

function toggleTurn(turnId?: string) {
  const id = String(turnId || '').trim()
  if (!id) return
  if (openTurnKey.value === id) {
    openTurnKey.value = ''
    turnCtx.value = null
    return
  }
  openTurnKey.value = id
  loadTurn(id)
}

async function loadTurn(turnId?: string) {
  const id = String(turnId || '').trim()
  const uid = selectedUserId.value
  if (!id || !uid) return
  turnLoading.value = true
  turnError.value = ''
  turnCtx.value = null
  try {
    const res = await apiFetch<AiContextPayload>(
      `/api/conversations/${encodeURIComponent(uid)}/ai-turn/${encodeURIComponent(id)}`,
    )
    // 抓回來時使用者可能已經收起來或改開別則，別把畫面蓋掉
    if (openTurnKey.value === id) turnCtx.value = res
  }
  catch {
    if (openTurnKey.value === id) turnError.value = '讀不到這一次的判斷紀錄（可能已超過保留期限）'
  }
  finally {
    turnLoading.value = false
  }
}

// 換客人／換會話就收起來：面板講的是上一位客人的那一則
watch([selectedUserId, selectedSessionId], () => {
  openTurnKey.value = ''
  turnCtx.value = null
  turnError.value = ''
})

/**
 * 看的是「某一場會話」時，把那場的時間範圍交給 AI 脈絡卡自行判斷要不要顯示。
 *
 * aiMeta 每位客人只留一張、每次 AI 互動整份覆寫，不分場次：點進三天前那場已結束的會話，
 * 訊息換成那場的、脈絡卡卻還是今天最新那次，兩邊兜不起來；而且此時按「這題 AI 答錯了」
 * 會成功記到今天那次頭上（時間戳與後端一致，後端樂觀鎖只擋「互動被更新」、擋不到「看錯場次」）。
 *
 * 起點比照 timeline 的訊息窗口往前 60 秒，否則觸發開場的那次 AI 互動會被誤判成別場的。
 * 拿不到時間（舊資料）就回無限大窗口＝維持原本一律顯示的行為，不要因為缺欄位就把卡片藏光。
 */
const aiContextSessionWindow = computed<AiContextSessionWindow | null>(() => {
  if (!selectedSessionId.value) return null
  const m = sessionMeta.value
  if (!m || m.sessionId !== selectedSessionId.value) return null
  return {
    startMs: m.openedAtMs ? m.openedAtMs - 60_000 : 0,
    endMs: m.closedAtMs || Number.POSITIVE_INFINITY,
  }
})

const messagesEl = ref<HTMLElement | null>(null)
/**
 * 「黏在最下面」：開對話、送出、背景刷新後都停在最新一則。
 * 使用者自己往上翻（離底超過 NEAR_BOTTOM_PX）就放掉，改用右下角那顆「回到最新」把人送回去——
 * 正在讀舊訊息時被硬拉到底，比看不到最新一則更惹人厭。
 */
const stickToBottom = ref(true)
const NEAR_BOTTOM_PX = 80
let pinBottomTimer: ReturnType<typeof setInterval> | null = null
const supportPresetsRaw = ref<any[]>([])
/** 自動回覆規則清單：規則可能很多，等 picker 第一次打開才載入 */
const quickReplySearch = ref('')
const pendingQuickReplyId = ref('')
/** 受控開合：填進回覆框後要自己把 popover 關掉，客服才看得到填進去的字 */
const quickReplyPickerVisible = ref(false)
const quickReplyFilling = ref(false)
const mediaDialogVisible = ref(false)
const quickMediaUploading = ref(false)
const quickSendType = ref<QuickSendType>('image')
const imageInputRef = ref<HTMLInputElement | null>(null)
const videoInputRef = ref<HTMLInputElement | null>(null)
const audioInputRef = ref<HTMLInputElement | null>(null)
const mediaForm = ref({
  originalContentUrl: '',
  previewImageUrl: '',
  durationSeconds: 5,
})
const imageMaxKb = Math.floor(IMAGE_MAX_BYTES / 1024)
const videoMaxMb = Math.floor(VIDEO_MAX_BYTES / (1024 * 1024))
const audioMaxMb = Math.floor(AUDIO_MAX_BYTES / (1024 * 1024))
const structuredCarouselPage = ref<Record<string, number>>({})

const quickMediaUrl = computed(() => String(mediaForm.value.originalContentUrl || '').trim())
const quickMediaKind = computed(() => (quickSendType.value === 'video' ? 'video' : 'image') as 'image' | 'video')
const {
  frameStyle: quickMediaFrameStyle,
  onImageLoad: onQuickImageLoad,
  onVideoMetadata: onQuickVideoMetadata,
} = useMediaPreviewDimensions(quickMediaUrl, quickMediaKind, {
  maxHeight: '320px',
})

const activeSupportPresets = computed(() =>
  supportPresetsRaw.value.filter((p: any) => p.isActive !== false),
)
const isSupportPresetBusy = computed(() => sending.value || msgLoading.value)

/**
 * 「挑一則送出」只有客服預存一個來源。
 * 原本還能借用「自動回覆規則」的內容，那個功能已於 2026-08-09 下架。
 */
/** 超過這個數量才顯示搜尋框：只有 3 則時多一個輸入框是噪音 */
const QUICK_REPLY_SEARCH_THRESHOLD = 8

const quickReplyLoading = computed(() => false)
const quickReplySourceItems = computed<QuickReplyItem[]>(() => {
  return activeSupportPresets.value.map((p: any) => ({
    id: String(p.id),
    name: String(p.name || ''),
    meta: getActionSummary(p),
    actionType: getActionType(p),
    taggingEnabled: p?.tagging?.enabled === true,
  }))
})
const quickReplyNeedsSearch = computed(() =>
  quickReplySourceItems.value.length > QUICK_REPLY_SEARCH_THRESHOLD,
)
const quickReplyItems = computed<QuickReplyItem[]>(() => {
  const kw = quickReplySearch.value.trim().toLowerCase()
  if (!kw) return quickReplySourceItems.value
  return quickReplySourceItems.value.filter(
    item => `${item.name} ${item.meta}`.toLowerCase().includes(kw),
  )
})
const pendingQuickReplyItem = computed<QuickReplyItem | null>(
  () => quickReplyItems.value.find(item => item.id === pendingQuickReplyId.value) ?? null,
)
/** 只有純文字才填得進回覆框改；模組／網址卡沒有可編輯的文字 */
const canFillQuickReply = computed(() => pendingQuickReplyItem.value?.actionType === 'message')
/**
 * 選到的這則要說什麼：不能改的要先講原因，會貼標籤的要講「自己送就不會貼」，
 * 不然客服會以為兩顆按鈕只差在能不能改字。
 */
const quickReplyNote = computed(() => {
  const item = pendingQuickReplyItem.value
  const handoff = '送出後這場會話轉為真人處理，機器人與 AI 不會再自動回覆，直到你按「交還機器人」。'
  if (!item) return handoff
  const lines: string[] = []
  if (item.actionType === 'module') lines.push('這則是觸發機器人模組，沒有可以改的文字，只能直接送出。')
  else if (item.actionType === 'uri') lines.push('這則是網址按鈕卡，沒有可以改的文字，只能直接送出。')
  if (item.taggingEnabled) lines.push('這則直接送出會自動貼標籤；填入回覆框自己送不會貼。')
  lines.push(handoff)
  return lines.join('')
})
const quickSendActions: Array<{ type: QuickSendType, label: string, icon: string }> = [
  { type: 'image', label: '圖片', icon: '🖼️' },
  { type: 'video', label: '影片', icon: '🎬' },
  { type: 'audio', label: '音訊', icon: '🎵' },
]
const quickSendDialogTitle = computed(() => {
  const label = quickSendActions.find(action => action.type === quickSendType.value)?.label || ''
  return `傳送${label}`
})
const canSendQuickMedia = computed(() => {
  if (quickMediaUploading.value) return false
  const originalContentUrl = String(mediaForm.value.originalContentUrl || '').trim()
  if (!originalContentUrl) return false
  if (quickSendType.value === 'audio') {
    return Number(mediaForm.value.durationSeconds) > 0
  }
  return true
})

const EMOJI_ALL = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍',
  '🤩', '😘', '😗', '☺️', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🫠', '🤗', '🤭',
  '🫢', '🫣', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😶‍🌫️', '😏', '😒', '🙄',
  '😬', '😮‍💨', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵',
  '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '☹️',
  '😮', '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖',
  '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩',
  '🤡', '👹', '👺', '👻', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀',
  '😿', '😾', '🫶', '👐', '🙌', '👏', '🤝', '👍', '👎', '👊', '✊', '🤛', '🤜', '🫷', '🫸',
  '🤞', '✌️', '🤟', '🤘', '👌', '🤏', '🫰', '🤌', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️',
  '🫵', '🙏', '🫱', '🫲', '💪', '🦾', '🧠', '🫀', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤',
  '🩶', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💯', '💢', '💥',
  '💫', '💦', '💨', '🕳️', '💬', '👋', '🙈', '🙉', '🙊', '🔥', '✨', '⭐', '🌟', '🎉', '🎊',
]

const activeEmojiCategory = ref('recent')
const recentEmojis = ref<string[]>(['😀', '😂', '🥹', '🙏', '🎉', '❤️', '👍', '🔥'])
const emojiCategories: PickerCategory[] = [
  { id: 'recent', label: '🕘' },
  { id: 'smileys', label: '🙂' },
  { id: 'gestures', label: '👋' },
  { id: 'hearts', label: '❤️' },
  { id: 'symbols', label: '✨' },
]

const emojiCategoryMap: Record<string, string[]> = {
  smileys: EMOJI_ALL.slice(0, 130),
  gestures: EMOJI_ALL.slice(130, 170),
  hearts: EMOJI_ALL.slice(170, 186),
  symbols: EMOJI_ALL.slice(186),
}

function buildStickerRange(packageId: string, start: number, end: number) {
  const list: Array<{ packageId: string, stickerId: string }> = []
  for (let id = start; id <= end; id++) {
    list.push({ packageId, stickerId: String(id) })
  }
  return list
}

const activeStickerCategory = ref('cute')
const stickerCategories: PickerCategory[] = [
  { id: 'cute', label: '⭐' },
  { id: 'funny', label: '🤣' },
  { id: 'reaction', label: '💬' },
]

const stickerCategoryMap: Record<string, Array<{ packageId: string, stickerId: string }>> = {
  cute: [
    ...buildStickerRange('11537', 52002734, 52002767),
  ],
  funny: [
    ...buildStickerRange('11538', 51626494, 51626533),
  ],
  reaction: [
    ...buildStickerRange('11539', 52114110, 52114149),
  ],
}

/** 選起來還沒送的貼圖；貼圖 picker 收起來時會清掉，不留幽靈選取 */
const pendingSticker = ref<{ packageId: string, stickerId: string } | null>(null)
/** 兩個 picker 各自的開合：送出貼圖後要自己把它關上 */
const pickerVisible = reactive<Record<PickerKind, boolean>>({ emoji: false, sticker: false })

const pickerModes: Array<{
  key: PickerKind
  title: string
  /**
   * 滑上去才說的那句（G-27②）。輸入框上方原本有一整行說明把四顆按鈕一次講完，
   * 第一天有用、第一百天還在佔位；拆成每顆自己的 tooltip，講的是「按了會怎樣」
   * 而不只是重複按鈕的名字。
   */
  hint: string
  triggerIcon: string
  categories: PickerCategory[]
}> = [
  {
    key: 'emoji',
    title: 'Emoji',
    hint: '插入 Emoji（會填進回覆框，送出前還能改）',
    triggerIcon: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f600.png',
    categories: emojiCategories,
  },
  {
    key: 'sticker',
    title: 'LINE 貼圖',
    hint: '傳 LINE 貼圖（先選一張，再按送出）',
    triggerIcon: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f9e9.png',
    categories: stickerCategories,
  },
]

/**
 * 釘選置頂。
 *
 * 「全部」分頁後端第一頁已經排好，這裡再排一次是為了「按下右鍵到下次載入之間」畫面就先動——
 * 不然按了釘選什麼都沒發生，會以為沒生效。filter 保序，所以兩邊順序一致。
 * 會話分頁後端沒有排（釘選是對話層級、查詢是會話層級），全靠這裡排；
 * 不排的話同一個 📌 在「全部」置頂、切過去卻沉在中間，看起來像壞掉。
 */
function pinnedFirst<T extends { pinned?: boolean }>(rows: T[]): T[] {
  if (!rows.some(r => r.pinned)) return rows
  return [...rows.filter(r => r.pinned), ...rows.filter(r => !r.pinned)]
}

/**
 * 釘選區要不要展開（G-27③）。
 *
 * 2026-08-24 老闆回報「每一列都有圖釘」。查了正式資料**不是 bug**：MYFEEL 真的有
 * 12 筆被釘（08-17～08-24 陸續釘的），而釘選一律置頂 → 第一screen 12 列剛好全是釘選，
 * 中間沒有任何標題說「這一段是釘選」，讀起來就變成「每列都有圖釘＝圖釘沒有意義」。
 *
 * 所以修法不是動渲染條件，是**把那一段標示成一個區塊**，並且可以收起來——
 * 收起來之後才拿得回照時間排序的收件匣。
 */
const pinnedGroupOpen = useState('conv-pinned-group-open', () => true)

/** 收起釘選區時要真的從清單裡拿掉（只影響顯示，不動任何資料） */
function applyPinnedGroup<T extends { pinned?: boolean }>(rows: T[]): T[] {
  const sorted = pinnedFirst(rows)
  return pinnedGroupOpen.value ? sorted : sorted.filter(r => !r.pinned)
}

const sessionSidebarItems = computed<SessionItem[]>(() => {
  const kw = searchText.value.toLowerCase().trim()
  const rows = !kw || activeTab.value === 'all'
    ? sessions.value
    : sessions.value.filter(s => s.displayName.toLowerCase().includes(kw))
  return applyPinnedGroup(rows)
})

const convSidebarItems = computed<ConvItem[]>(() => applyPinnedGroup(conversations.value))

/**
 * 這個分頁上有幾筆被釘選（給區塊標題用）。
 * ⛔ 要數收起來之前的原始清單，不能數 sidebarItems——收起來之後那份是 0，
 *    標題就會變成「釘選中（0）」而且再也點不開。
 */
const pinnedRowCount = computed(() => {
  const rows: { pinned?: boolean }[] = activeTab.value === 'all'
    ? conversations.value
    : sessions.value
  return rows.filter(r => r.pinned).length
})

/** 釘選區的最後一筆：底下畫一條線，讀者才知道「時間序從這裡開始」 */
function lastPinnedEdge(rows: { pinned?: boolean }[]): number {
  let last = -1
  for (let i = 0; i < rows.length; i++) if (rows[i]?.pinned) last = i
  // 整份清單都是釘選時不用畫線（下面沒有東西了）
  return last >= 0 && last < rows.length - 1 ? last : -1
}

const lastPinnedIndex = computed(() => lastPinnedEdge(convSidebarItems.value))
const lastPinnedSessionIndex = computed(() => lastPinnedEdge(sessionSidebarItems.value))

/**
 * 搜尋中的清單是一份快照，不跟著每 30 秒的輪詢更新（重送搜尋等於重掃一次全 workspace
 * 的對話，2026-08-11 讀取費暴衝那筆帳）。停就停，但要**講出來**——清單上會出現一行說明，
 * 否則客服搜完名字沒清掉字，看到的就是一個從此不再有新訊息、紅點也不會亮的畫面。
 */
const listAutoRefreshPaused = computed(() => activeTab.value === 'all' && !!searchText.value.trim())

const sidebarEmpty = computed<{ title: string, hint: string }>(() => {
  if (followUpFilterOn.value) {
    return searchText.value
      ? { title: '待跟進裡沒有符合的對話', hint: '' }
      // 空清單不能只說「沒有」就結束：順便講怎麼標，不然這個篩選看起來像壞掉
      : { title: '目前沒有待跟進的對話', hint: '在左側對話上按右鍵（或滑過按 ⋯）→「標記待跟進」，之後就能從這裡找回來' }
  }
  if (searchText.value)
    return { title: '無符合結果', hint: '' }
  // 開通沒完成時「尚無對話紀錄」是誤導：不是客人不傳，是傳了也進不來（2026-08-27）
  if (onboardingIncomplete.value)
    return { title: '開通還沒完成，還不會有對話', hint: '接上 LINE 並收到第一則訊息後，客人的對話會自動出現在這裡' }
  return { title: '尚無對話紀錄', hint: '' }
})

/**
 * 目前這個分頁上還沒看的列數：分頁標題的「（3）」和「全部已讀」按鈕都用它。
 *
 * 一定要跟著分頁走：loadList 換到會話分頁時會把 conversations 清空，
 * 先前只數 conversations，結果停在「待處理」時標題那個數字永遠是 0。
 * 只數已載入的那幾頁——沒載到的列本來就還沒算進畫面上任何一個數字。
 */
const unreadRowCount = computed(() =>
  activeTab.value === 'all'
    ? convSidebarItems.value.filter(c => isRowUnread(c.userId, convRowCustomerMs(c))).length
    : sessionSidebarItems.value.filter(s => isRowUnread(s.userId, sessionRowCustomerMs(s))).length,
)

watch(unreadRowCount, () => {
  applyUnreadDocumentTitle()
})

watch(workspaceId, () => {
  hydrateConvLastRead()
  applyUnreadDocumentTitle()
  // 換 workspace 就丟掉已簽好的媒體網址（換帳號後不該還留著上一家的檔案連結）
  remoteMedia.value = {}
  mediaQueue.length = 0
})

const sidebarItems = computed(() =>
  activeTab.value === 'all' ? convSidebarItems.value : sessionSidebarItems.value,
)

const sessionToolbarMeta = computed<SessionPanelMeta | null>(() => {
  if (selectedSessionId.value && sessionMeta.value)
    return sessionMeta.value
  if (activeTab.value === 'all' && allTabActiveSession.value)
    return allTabActiveSession.value
  return null
})

/**
 * 標頭那顆狀態徽章的顏色。先前五種狀態**全部寫死 `type="info"`**，
 * 於是「客人在等人接手」和「機器人正在自動回覆」長得一模一樣——
 * 而這是整個標頭最重要的一格（決定客服現在該不該開口）。
 *
 * 配色照**急迫度**排，不是照狀態名稱：紅（客人正在被晾著）＞橘（沒人碰過）＞
 * 藍（有人在跟，資訊性）＞灰（不需要人）。
 *
 * ⛔ 刻意不用綠：這個專案的 `primary` 就是品牌綠（`element-variables.scss`），
 *    旁邊的「我接手」正是綠色主按鈕。再給狀態一顆綠，同一列兩種綠語意不同
 *    ——那正是 `C-72` 已經記在案、還沒拍板的老問題，不要在這裡再製造一個。
 * ⛔ 這個調色盤裡 `info` 是**藍色**（#2563eb）不是灰，所以「中性灰」EP 給不了，
 *    只能靠 muted 這個 class 把三個 --el-tag-* 變數改掉。
 */
const sessionStateTone = computed<{ type: 'danger' | 'warning' | 'info'; muted: boolean; hint: string }>(() => {
  switch (sessionToolbarMeta.value?.status) {
    case 'pending_human':
      return { type: 'danger', muted: false, hint: '客人要求真人、還沒有人接手——這場最需要你' }
    case 'open':
      return { type: 'warning', muted: false, hint: '這場對話還沒有人處理過' }
    case 'human_handling':
      return { type: 'info', muted: false, hint: '已經有同事接手，機器人與 AI 暫停自動回覆' }
    case 'bot_handling':
      return { type: 'info', muted: true, hint: '目前由機器人／AI 自動回覆中，不需要人介入' }
    default:
      return { type: 'info', muted: true, hint: '' }
  }
})

/**
 * 「我接手」＝這場還是機器人／AI 在自動回覆（open / bot_handling）時才有意義。
 * 已經是待真人 / 真人處理中的話，該顯示的是反向的「交還機器人」。
 */
const canTakeOverSession = computed(() => {
  if (!canOperate.value) return false
  const st = sessionToolbarMeta.value?.status
  return st === 'open' || st === 'bot_handling'
})

/**
 * 目前這位客人還沒被伺服器確認的訊息，接在對話最後面。
 *
 * 和真的訊息共用同一套泡泡渲染（只是多一個 sendStatus），所以送出成功、
 * 本地泡泡換成伺服器那則的時候看不出來有換過。
 */
const pendingRows = computed<ChatRowMsg[]>(() => {
  const uid = selectedUserId.value
  if (!uid) return []
  return pendingOutgoing.value
    .filter(p => p.userId === uid)
    .map(p => ({
      kind: 'msg' as const,
      key: p.localId,
      msg: {
        id: p.localId,
        localId: p.localId,
        direction: 'outgoing' as const,
        text: p.text,
        messageType: 'text',
        payload: null,
        timestamp: p.at,
        readByPeer: false,
        // 自己剛打的，當然是真人。先標好，等伺服器那則換上來時標籤才不會閃一下
        sender: 'human' as const,
        sendStatus: p.status,
        sendError: p.error,
      },
    }))
})

/**
 * 客人動作紀錄（見 shared/customer-action.ts）存的是一則訊息，但**不能當泡泡畫**：
 * 那不是客人說的話，是他按了什麼。轉成中央那一行灰字，對話頁與會話時間軸兩邊都吃這一條路。
 */
function chatRowForMessage(msg: MsgItem): ChatRow {
  if (isCustomerActionMessage(msg.messageType)) {
    return { kind: 'event', key: msg.id, label: msg.text, timestamp: msg.timestamp, variant: 'action' }
  }
  return { kind: 'msg', key: msg.id, msg }
}

/**
 * 事件行裡「進入：某模組」只留**換手**的那幾筆。
 *
 * 每一句客人的話都會讓系統再進一次模組，所以整條對話攤開來看，「進入：機器人流程」
 * 會出現在幾乎每一則回覆前面——實測 20 則訊息配 14 行事件，對話被切成一格一格，
 * 而且那句話沒有新資訊：泡泡旁邊的標籤已經講了這則是機器人／AI／真人回的。
 * 換手（機器人 → AI → 真人）才是客服要看的訊號，那一筆留著。
 *
 * 每一場會話重新算（見下面遇到 conversation_opened 時的重設）：一場的開頭講一次
 * 「這場是誰接的」有意義，「同一場裡又進了同一個模組」沒有。
 */
function keepsModuleEvent(item: TimelineItem, lastModuleType: string): boolean {
  if (item.eventType !== 'entered_module') return true
  return String(item.moduleType || '') !== lastModuleType
}

/**
 * 哪些系統事件「一定要看得到」（G-27①）。
 *
 * 老闆回報版面亂，逐區一看：一場對話畫面上 5 個系統膠囊、真訊息只有 3 則——
 * 軌跡資料和對話內容平起平坐擺在動線正中間，把訊息切碎。
 * 收法＝**只留下「解釋了為什麼換手」的事件**，純軌跡（新會話開始、進入某模組、
 * 真人首次回覆——那個泡泡旁邊本來就有「真人」標籤）預設收起來。
 *
 * ⛔ 用 eventType 分類，不要比對 label 字串：文案改一次分類就靜默失效。
 * ⛔ 客人動作（variant='action'：按按鈕、加好友、活動登記）**永遠不收**——
 *    那是客人真的做了什麼，不是系統的內部軌跡。
 */
const ALWAYS_SHOWN_EVENT_TYPES = new Set([
  'handoff_request',       // 為什麼轉真人
  'returned_to_bot',       // 為什麼 AI 又開始回話
  'human_lead_continued',  // 為什麼這場一開始就是真人（否則看起來像 AI 壞了）
  'conversation_closed',   // 這場結束了
  'postback_no_reply',     // 客人按了按鈕卻沒人回＝故障訊號
])

/** 展開全部系統事件（預設收起）。跨對話記住：客服的閱讀習慣不會因為換一個人就改變 */
const showAllEvents = useState('conv-show-all-events', () => false)

const serverChatRows = computed<ChatRow[]>(() => {
  const rows: ChatRow[] = []
  let lastModuleType = ''
  for (const item of timelineItems.value) {
    // broadcast 是後端讀取時才拼進來的群發標記（不是真的訊息文件），與事件同樣渲染成一行泡泡
    if (item.type === 'event' || item.type === 'broadcast') {
      if (!keepsModuleEvent(item, lastModuleType)) continue
      if (item.eventType === 'conversation_opened') lastModuleType = ''
      else if (item.eventType === 'entered_module') lastModuleType = String(item.moduleType || '')
      rows.push({
        kind: 'event' as const,
        key: `e-${item.id}`,
        label: item.label || '',
        timestamp: item.timestamp,
        eventType: item.eventType ? String(item.eventType) : undefined,
        moduleType: item.moduleType ? String(item.moduleType) : undefined,
      })
      continue
    }
    const msg: MsgItem = {
      id: item.id,
      direction: item.direction === 'outgoing' ? 'outgoing' : 'incoming',
      text: item.text ?? '',
      messageType: String(item.messageType || 'text'),
      payload: item.payload as any,
      timestamp: item.timestamp,
      readByPeer: item.readByPeer,
      mediaDescription: item.mediaDescription,
      sender: item.sender ?? null,
      senderName: item.senderName,
      aiTurnId: item.aiTurnId,
    }
    rows.push(chatRowForMessage(msg))
  }
  return rows
})

const allChatRows = computed<ChatRow[]>(() => [...serverChatRows.value, ...pendingRows.value])

/**
 * 收起狀態下這一列看不看得到。**開關的數字與實際隱藏的列一定要吃同一個判斷**——
 * 先前是兩份各寫一套，沒帶 eventType 的列（群發標記、上線前的舊事件）在清單裡是「保守顯示」、
 * 在數字裡卻被算成「已收起」，開關就會寫著「顯示系統紀錄（4）」但按下去一列都沒多出來。
 */
function isRowVisibleWhenCollapsed(r: ChatRow): boolean {
  if (r.kind !== 'event') return true
  if (r.variant === 'action') return true
  // 沒帶型別 → 保守顯示（群發標記與這功能上線前的舊事件都走這條）
  return r.eventType ? ALWAYS_SHOWN_EVENT_TYPES.has(r.eventType) : true
}

/** 收起來的純軌跡事件有幾筆（給開關顯示數字用；0 就不必出現那顆開關） */
const hiddenEventCount = computed(() =>
  allChatRows.value.filter(r => !isRowVisibleWhenCollapsed(r)).length,
)

/**
 * 畫面上真的要畫的列。系統事件預設只留「解釋為什麼換手」那幾類（見 ALWAYS_SHOWN_EVENT_TYPES），
 * 其餘用開關展開——⛔ 只影響顯示，不動任何資料與統計。
 */
const chatRows = computed<ChatRow[]>(() => {
  if (showAllEvents.value) return allChatRows.value
  return allChatRows.value.filter(isRowVisibleWhenCollapsed)
})

/**
 * 收起來的那幾筆軌跡，濃縮成頂部一行：「這場：新會話 → AI 客服 → 真人（12:03 接手）」。
 *
 * 為什麼要有這一行：把五個膠囊直接藏掉會少掉「這場是怎麼走到現在的」——
 * 那是客服接手前唯一想知道的事。收起來但不丟掉，換成一行讀得完的。
 *
 * ⛔ 只讀**已經載入的這一段**時間軸（往上分段讀還沒讀到的不算），
 *    所以往上翻越多這行會越長，這是誠實的：它描述的是「你看得到的這段」。
 */
const SESSION_FLOW_STAGE_LABELS: Record<string, string> = {
  conversation_opened: '新會話',
  handoff_request: '轉真人',
  returned_to_bot: '交還機器人',
  human_lead_continued: '真人續接',
  conversation_closed: '結束',
}

const sessionFlowSummary = computed<string>(() => {
  const stages: string[] = []
  for (const row of allChatRows.value) {
    if (row.kind !== 'event' || row.variant === 'action') continue
    const type = row.eventType
    if (!type) continue
    let stage = ''
    if (type === 'entered_module') {
      stage = MODULE_TYPE_LABELS[row.moduleType as ModuleType] ?? '模組'
    }
    else if (type === 'human_first_reply') {
      // 接手時間是這行最有價值的一格：客服想知道的是「什麼時候有人接的」
      const at = formatTime(row.timestamp)
      stage = at ? `真人（${at} 接手）` : '真人'
    }
    else {
      stage = SESSION_FLOW_STAGE_LABELS[type] ?? ''
    }
    // 連續重複的階段收成一格（同一場反覆進出同一個模組不必列兩次）
    if (stage && stages[stages.length - 1] !== stage) stages.push(stage)
  }
  return stages.join(' → ')
})

/**
 * 「回到最新」只在真的看不到最新一則時出現：空對話、載入中、已經停在底部都不該冒出來。
 * 例外是看舊會話（timelineHasNewer）：那時就算貼在載入內容的底部，看到的也不是最新一則。
 */
const showJumpToLatest = computed(() =>
  (!stickToBottom.value || timelineHasNewer.value) && !msgLoading.value && chatRows.value.length > 0,
)

/**
 * 往上翻的時候，背景刷新刻意不把畫面拉走（見 scrollToBottom 的 force）——
 * 那就得由這顆按鈕負責講「下面有新的」，否則客服在翻舊訊息，客人的新訊息就悄悄地沒人看到。
 */
const chatNewestMs = computed(() => newestTimestampMs(
  chatRows.value.map(r => (r.kind === 'event' ? r.timestamp : r.msg.timestamp)),
))
const seenNewestMs = ref(0)
const hasNewBelow = computed(() => !stickToBottom.value && chatNewestMs.value > seenNewestMs.value)
// 人停在底部＝最新那則就在眼前，基準線跟著往前推
watch([stickToBottom, chatNewestMs], ([stuck, newest]) => {
  if (stuck) seenNewestMs.value = newest
}, { immediate: true })

/** 泡泡與事件行都吃這一支，好讓日期分組判斷「這一則是哪一天」 */
function chatRowMs(row: ChatRow): number {
  if (row.kind === 'msg') return messageTimestampToMs(row.msg.timestamp)
  return messageTimestampToMs(row.timestamp)
}

/**
 * 訊息流照 LINE 的做法用日期分段：一整條長對話滑下來，沒有分隔線就分不出
 * 「這句是今天問的還是上個月問的」——泡泡旁只有時分（見 formatClockTime），
 * 日期一律由分隔線負責，兩邊不重複講同一件事。文字規則見 shared/chat-day.ts。
 *
 * **為什麼是「分組」而不是在流裡插一列**：日期膠囊要吸在畫面頂端，滑到下一天時
 * 才換成新的那顆。sticky 的推擠邊界是它的父層，所以一天一個 .conv-day-group
 * 才會有「上一顆被自己那組的底邊推出去」的效果；全部攤平在同一層的話，
 * 先吸上去的那顆永遠不會被推走，第二天的膠囊會直接疊在它上面。
 *
 * 拿不到時間的那幾則（timestamp 為空、或剛送出還沒回時間）跟著上一段走，
 * 不自己開一段：免得中間憑空多一條「1970」或把同一天切成兩段。
 */
type ChatDayGroup = { key: string; label: string; rows: ChatRow[] }

const chatDayGroups = computed<ChatDayGroup[]>(() => {
  const groups: ChatDayGroup[] = []
  for (const row of chatRows.value) {
    const ms = chatRowMs(row)
    const key = ms > 0 ? chatDayKey(ms) : ''
    let group = groups[groups.length - 1]
    if (!group || (key && key !== group.key)) {
      group = { key, label: key ? formatChatDayLabel(ms) : '', rows: [] }
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
})

// ── 右鍵／⋯：釘選、待跟進 ────────────────────────────────────────
// 兩個都是「對話層級」的人工標記，所以會話列表按右鍵也是標到同一位客人身上。
// 「待跟進」刻意不叫「待處理」——那個詞是上面分頁（系統判定）的，見 shared/conversation-flags.ts。

const contextMenuItems = computed<AdminContextMenuItem[]>(() => {
  const t = contextMenuTarget.value
  if (!t) return []
  return [
    { key: 'pin', icon: '📌', label: t.pinned ? '取消釘選' : '釘選（排到最上面）' },
    { key: 'followUp', icon: '🚩', label: t.followUp ? '取消待跟進' : '標記待跟進' },
  ]
})

function openContextMenuAt(x: number, y: number, target: ConvItem | SessionItem) {
  // 觀察者不開自訂選單（SplitListItem 也不會擋掉原生選單）：無權限一律隱藏，不給按了才說不行
  if (!canOperate.value) return
  contextMenuTarget.value = target
  contextMenuPos.value = { x, y }
  contextMenuVisible.value = true
}

function openConvContextMenu(ev: MouseEvent, target: ConvItem | SessionItem) {
  openContextMenuAt(ev.clientX, ev.clientY, target)
}

/** 滑過列表列露出的「⋯」：從按鈕左下角展開，不要蓋住按鈕自己 */
function openContextMenuFromButton(ev: MouseEvent, target: ConvItem | SessionItem) {
  const rect = (ev.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  if (!rect) return openConvContextMenu(ev, target)
  openContextMenuAt(rect.left, rect.bottom + 4, target)
}

/** 同一位客人可能同時出現在 conversations 與 sessions 兩份清單，兩邊都要跟著更新 */
/* ── 負責人員（G-27 功能缺口②）─────────────────────────────── */

interface AssignableMember { uid: string, name: string, email: string, role: string }

const assignableMembers = ref<AssignableMember[]>([])
const assigneeLoading = ref(false)
/** ⛔ 三態：載入失敗要講出來，不可以顯示成一個空的同事名單（08-09 假綠燈教訓） */
const assigneeLoadFailed = ref(false)
const assigneeLoaded = ref(false)
const assigneeSaving = ref(false)

const currentAssignee = computed<ConversationAssignee>(
  () => selectedUser.value?.assignee ?? NO_ASSIGNEE,
)

/** 名單只在第一次打開選單時才抓：多數時候客服不會動它，不必每開一個對話就多打一支 API */
async function onAssigneeMenuToggle(open: boolean) {
  if (!open || assigneeLoaded.value || assigneeLoading.value) return
  assigneeLoading.value = true
  assigneeLoadFailed.value = false
  try {
    const res = await apiFetch<{ members: AssignableMember[] }>('/api/conversations/assignees')
    assignableMembers.value = res.members ?? []
    assigneeLoaded.value = true
  }
  catch {
    assigneeLoadFailed.value = true
  }
  finally {
    assigneeLoading.value = false
  }
}

/**
 * 從剛重抓回來的清單，把負責人員補回頂部那顆按鈕。
 *
 * 為什麼需要：按「我接手」時後端會自動把負責人指給按的人（takeover.post.ts），
 * 但 `selectedUser` 是選取當下複製出來的一份，清單重抓不會動到它——
 * 不補的話接手完頂部還寫著「指派負責人」，看起來像自動指派沒生效。
 */
function syncSelectedAssigneeFromList() {
  const userId = selectedUserId.value
  if (!userId || !selectedUser.value) return
  const row: { assignee?: ConversationAssignee } | undefined
    = conversations.value.find((c: ConvItem) => c.userId === userId)
      ?? sessions.value.find((s: SessionItem) => s.userId === userId)
  if (row?.assignee) selectedUser.value.assignee = row.assignee
}

/** 把負責人員同步到畫面上所有看得到這位客人的地方（清單兩份＋頂部） */
function applyLocalAssignee(userId: string, assignee: ConversationAssignee) {
  for (const row of conversations.value) if (row.userId === userId) row.assignee = assignee
  for (const row of sessions.value) if (row.userId === userId) row.assignee = assignee
  if (selectedUser.value?.userId === userId) selectedUser.value.assignee = assignee
}

async function setAssignee(uid: string) {
  const userId = selectedUserId.value
  if (!userId || !assertCanOperate()) return
  if (uid === currentAssignee.value.uid) return

  const previous = currentAssignee.value
  assigneeSaving.value = true
  try {
    const saved = await apiFetch<ConversationAssignee>(
      `/api/conversations/${encodeURIComponent(userId)}/assignee`,
      { method: 'POST', body: { uid } },
    )
    applyLocalAssignee(userId, saved)
    showToast(saved.uid ? `已指派給 ${saved.name}` : '已取消指派', 'success')
  }
  catch (e: any) {
    // ⛔ 失敗要轉回去：留著假的指派比沒有指派更糟（同事會以為有人在跟）
    applyLocalAssignee(userId, previous)
    showToast(e?.data?.statusMessage || '指派失敗', 'error')
  }
  finally {
    assigneeSaving.value = false
  }
}

function applyLocalFlags(userId: string, flags: Partial<{ pinned: boolean, followUp: boolean }>) {
  for (const row of conversations.value) {
    if (row.userId === userId) Object.assign(row, flags)
  }
  for (const row of sessions.value) {
    if (row.userId === userId) Object.assign(row, flags)
  }
  if (contextMenuTarget.value?.userId === userId) Object.assign(contextMenuTarget.value, flags)
}

async function onContextMenuSelect(key: string) {
  const target = contextMenuTarget.value
  if (!target || !assertCanOperate()) return

  const isPin = key === 'pin'
  const next = isPin ? !target.pinned : !target.followUp
  const userId = target.userId

  // 先上畫面再送出：釘選要重排、標記要冒出膠囊，等 200~500ms 才動會像沒按到。
  // 失敗就整個轉回去（含數字），不要留下一個假的已標記狀態。
  applyLocalFlags(userId, isPin ? { pinned: next } : { followUp: next })
  if (!isPin && followUpCount.value !== null) followUpCount.value = Math.max(0, followUpCount.value + (next ? 1 : -1))

  try {
    const res = await apiFetch<{ pinned: boolean, followUp: boolean }>(
      `/api/conversations/${userId}/flags`,
      { method: 'POST', body: isPin ? { pinned: next } : { followUp: next } },
    )
    // 以伺服器回的狀態為準（例如同事剛好也動過同一筆）
    applyLocalFlags(userId, { pinned: res.pinned, followUp: res.followUp })
    if (isPin) {
      showToast(next ? '已釘選，排在列表最上面' : '已取消釘選', 'success')
    }
    else {
      showToast(next ? '已標記待跟進' : '已取消待跟進', 'success')
      // 正在「只看待跟進」時取消標記，那一筆要當場消失，不然畫面在說謊
      if (!next && followUpFilterOn.value) await loadList('reset')
    }
  }
  catch (e: any) {
    applyLocalFlags(userId, isPin ? { pinned: !next } : { followUp: !next })
    if (!isPin && followUpCount.value !== null) followUpCount.value = Math.max(0, followUpCount.value + (next ? -1 : 1))
    showToast(e?.data?.statusMessage || '標記失敗，請稍後再試', 'error')
  }
}

async function toggleFollowUpFilter() {
  followUpFilterOn.value = !followUpFilterOn.value
  await loadList('reset')
}

async function switchTab(tab: TabValue) {
  activeTab.value = tab
  // 「只看待跟進」是「全部」分頁專用的視角，切走就關掉，免得切回來還套著看不見的篩選
  if (tab !== 'all') followUpFilterOn.value = false
  selectedSessionId.value = null
  allTabActiveSession.value = null
  sessionMeta.value = null
  await loadList('reset')
  // 切分頁不換人：同一位客人在「全部」和會話分頁看到的是同一條對話，
  // 只是工具列從「進行中會話」換成「此場會話」（見 sessionToolbarMeta）
  if (tab === 'all' && selectedUserId.value && selectedUser.value) {
    await selectUser(selectedUser.value)
  }
}

async function selectSession(s: SessionItem) {
  // 換會話＝重新黏回底部（同 selectUser）
  stickToBottom.value = true
  selectedSessionId.value = s.sessionId
  allTabActiveSession.value = null
  aiContextSeenAtMs = 0
  // 同 selectUser：這一場的最新一則等一下就讀進來了，記成「已經為它讀過」
  openTimelineRowMs = messageTimestampToMs(s.unreadAt)
  selectedUserId.value = s.userId
  const convItem: ConvItem = {
    userId: s.userId,
    displayName: s.displayName,
    pictureUrl: s.pictureUrl,
    lastMessage: s.lastMessage,
    lastDirection: s.lastDirection,
    // 這一份要跟 lastMessage 同一則（切到「全部」分頁時會拿去當已讀基準），
    // 所以是 unreadAt 不是 lastActivityAt；已結束的場沒有就留 null，不拿動靜時間充數
    lastMessageAt: s.unreadAt ?? null,
    // 紅點與已讀章比的是這個（見 isRowUnread），切到「全部」分頁時要接得上
    customerLastAt: s.customerLastAt ?? null,
    pinned: s.pinned === true,
    followUp: s.followUp === true,
    // 負責人員是對話層級的，切到會話分頁要接得上（否則頂部那顆會顯示「指派負責人」）
    assignee: s.assignee ?? NO_ASSIGNEE,
  }
  selectedUser.value = convItem
  // 先用列表那一列的狀態把工具列填好，時間軸讀回來再換成完整的（含起訊時間）
  sessionMeta.value = {
    sessionId: s.sessionId,
    status: s.status,
    statusLabel: SESSION_STATUS_LABELS[s.status] ?? String(s.status),
  }
  await loadTimeline(s.userId, { sessionId: s.sessionId, seenUpToMs: sessionRowCustomerMs(s) })
}

const canSend = computed(() => !!inputText.value.trim())

/**
 * 載入清單的三種模式。
 *
 * · reset — 使用者主動換了脈絡（按重整、換分頁、搜尋、進頁）：清空重來，轉圈是誠實的
 * · more  — 往下捲載下一頁：接在後面
 * · merge — 背景刷新（每 30 秒輪詢、送出訊息後、標記後）：重抓第一頁併進現有清單，
 *           不清空、不轉圈、不掉已載入的後續頁。整份換掉的話每 30 秒整排列都會重繪一次，
 *           畫面閃、捲軸跳、hover 中的 ⋯ 消失。細節見 ~/utils/list-merge。
 */
type LoadListMode = 'reset' | 'more' | 'merge'

/**
 * 回傳「這一輪有沒有真的跑」（被上面三道閘門擋掉就是 false）。
 * 呼叫端靠它決定要不要自己補一次分頁數字——被擋掉的那次連數字都沒重抓，
 * 接手／交還／送訊息之後少了那一次，分頁上的「未首接 12」就會停在動作前的舊值。
 */
async function loadList(mode: LoadListMode = 'reset'): Promise<boolean> {
  if (mode === 'reset') {
    if (listLoading.value) return false
    listLoading.value = true
    listPage.value = 1
    listHasMore.value = false
    conversations.value = []
    sessions.value = []
  }
  else if (mode === 'more') {
    if (listLoadingMore.value || listLoading.value || !listHasMore.value) return false
    listLoadingMore.value = true
  }
  else {
    // 背景刷新不搶正在進行的載入，也不重入自己
    if (listLoading.value || listLoadingMore.value || listMerging) return false
    listMerging = true
  }

  /**
   * 這一批載入的流水號。
   *
   * 背景刷新不像 reset 有 listLoading 擋著，所以「輪詢送出去了 → 使用者按重整／換分頁 →
   * 輪詢才回來」是真的會發生的順序。回來時號碼被追過就整批丟掉，不要把舊分頁的資料
   * 併進新分頁的清單裡。
   */
  const seq = ++listLoadSeq

  /**
   * 分頁上的數字（未首接 12、待跟進 3…）跟清單**同時**出發。
   *
   * ⛔ 不要再接在清單後面 `await`：兩者沒有先後依賴，排成一條線的代價是清單回來了才開始
   * 問數字——2026-08-27 正式站實測，清單第 3.8 秒回來、數字再花 2.3 秒＝整頁 6.1 秒，
   * 而這一頁是全站唯一「瓶頸真的在自己資料」的頁面，那 2.3 秒是純排隊。
   * 這支自己 try/catch（失敗只是數字維持上次的值），所以不會有沒人接的 rejection。
   */
  const countsTask = loadSessionCounts()

  // 背景刷新永遠只重抓第一頁：那裡才有最新的變化，後面幾頁維持原樣
  const page = mode === 'merge' ? 1 : listPage.value
  // 併入前先記住捲動位置：新的列插在最上面會把內容往下推，不補回去就等於捲軸自己跳走
  const listEl = mode === 'merge' ? sidebarListEl.value : null
  const scrollTopBefore = listEl?.scrollTop ?? 0
  const scrollHeightBefore = listEl?.scrollHeight ?? 0

  try {
    if (activeTab.value === 'all') {
      const res = await apiFetch<{
        conversations: ConvItem[]
        total: number
        hasMore: boolean
        truncated?: boolean
      }>('/api/conversations/list', {
        params: {
          page,
          limit: CONV_LIST_PAGE_SIZE,
          search: searchText.value.trim() || undefined,
          flag: followUpFilterOn.value ? 'followup' : undefined,
          // 「載入更多」帶游標接在已載入的最後一筆之後：後端用 offset 翻頁會對跳過的
          // 每一筆收讀取費，游標只要 1 次。搜尋／待跟進模式的分頁邏輯不同，不帶
          after: mode === 'more' && !searchText.value.trim() && !followUpFilterOn.value
            ? conversations.value[conversations.value.length - 1]?.userId || undefined
            : undefined,
        },
      })
      if (seq !== listLoadSeq) return true
      const chunk = res.conversations ?? []
      conversations.value = mode === 'merge'
        ? mergeIntoList(conversations.value, chunk, c => c.userId, res.hasMore)
        : mode === 'reset' ? chunk : [...conversations.value, ...chunk]
      // 背景刷新只看第一頁時後面幾頁還在清單裡，不能拿第一頁的 hasMore 覆蓋掉
      if (mode !== 'merge' || !res.hasMore) listHasMore.value = Boolean(res.hasMore)
      followUpListTruncated.value = followUpFilterOn.value && res.truncated === true
      // 待跟進總數不在這裡算：這裡的 total 會被顯示上限截掉，真正的數字由 loadSessionCounts() 帶回來
    }
    else {
      const res = await apiFetch<{
        sessions: SessionItem[]
        total: number
        hasMore: boolean
      }>('/api/conversations/sessions', {
        params: {
          status: activeTab.value,
          page,
          limit: CONV_LIST_PAGE_SIZE,
          // 同「全部」分頁：載入更多用游標，省掉 offset 的跳過費
          after: mode === 'more'
            ? sessions.value[sessions.value.length - 1]?.sessionId || undefined
            : undefined,
        },
      })
      if (seq !== listLoadSeq) return true
      const chunk = res.sessions ?? []
      sessions.value = mode === 'merge'
        ? mergeIntoList(sessions.value, chunk, s => s.sessionId, res.hasMore)
        : mode === 'reset' ? chunk : [...sessions.value, ...chunk]
      if (mode !== 'merge' || !res.hasMore) listHasMore.value = Boolean(res.hasMore)
    }

    if (listEl && scrollTopBefore > 0) {
      await nextTick()
      // 上面多出來的高度補回捲軸，客服正在看的那幾列就會停在原地
      const delta = listEl.scrollHeight - scrollHeightBefore
      if (delta) listEl.scrollTop = scrollTopBefore + delta
    }
  }
  catch {
    if (mode === 'reset') {
      conversations.value = []
      sessions.value = []
    }
    // 背景刷新失敗不吵：畫面上還是上一輪的資料，沒有壞掉的東西要通知
    if (mode !== 'merge') showToast('載入對話列表失敗', 'error')
  }
  finally {
    // 只清自己那一批的旗標：被追過的話新那批還在跑，清掉會讓它的轉圈提早消失、
    // 也會放行本來該被擋下的重入
    if (seq === listLoadSeq) {
      listLoading.value = false
      listLoadingMore.value = false
    }
    listMerging = false
  }
  if (seq !== listLoadSeq) return true
  await countsTask
  maybeRefreshAiContext()
  // 只跟背景刷新走。reset（換分頁／按重整／搜尋）後面通常緊接著一次 selectUser 重讀，
  // 這裡再插一支就是同一段時間軸兩個請求在路上，沒好處
  if (mode === 'merge') maybeRefreshOpenTimeline()
  if (mode === 'reset') void autoFillSidebarList()
  return true
}

/**
 * 開著的那個對話，客人來訊時把新的一段自己讀進來。
 *
 * 沒有這一支的話：每 30 秒的背景刷新只重整左側清單，右邊的泡泡不會動——客人在客服正
 * 盯著他的時候傳訊息，左邊那列亮紅點、摘要也換了，右邊卻什麼都沒多出來；而且已讀只在
 * 「點開對話」那一刻蓋，對話早就開著，那顆紅點連消都消不掉，要點去別人那再點回來。
 *
 * 判斷用列上的時間戳跟「已經載進來的最新一則」比，兩邊都是伺服器蓋的時間才比得準
 * （不可以拿 chatRows，那裡面有還沒送出去的本機泡泡，時間是本機時鐘）。
 * 已結束的那一段 unreadAt 是 null → 讀不到時間 → 不重讀，正好也是我們要的：
 * 那一段被錨定在該場的結尾，新訊息本來就不屬於它（見 reloadAfterOutgoing 的說明）。
 *
 * ⛔ 光比「列上的時間有沒有比較新」不夠，還要記住上次為哪一則讀過（openTimelineRowMs）。
 * 2026-08-14 以前存進資料庫的訊息，列上那個時間比訊息自己的時間晚幾百毫秒
 * （見 handler.ts 的 lastMessageAt），這個比較會**永遠成立**——那些對話只要開著，
 * 就每 30 秒重抓一整段時間軸，讀取費照筆算。記住之後：列上的時間有動才讀，
 * 客人來一則就讀一次，沒動就不讀。
 * 代價是這一次讀失敗就要等客人再開口（或客服自己點一下）才會再試，換掉的是「每 30 秒
 * 重試到天荒地老」——失敗時那句錯誤提示也從每 30 秒一次變成只跳一次。
 */
let openTimelineRowMs = 0

/**
 * 目前選中那一列上的「最後一則訊息時間」（不分方向）。
 *
 * 只給 maybeRefreshOpenTimeline 判斷「這一列有沒有多出東西、要不要重讀」用——
 * 開著的對話 AI 回了一句也算多出東西，所以這裡**不能**換成客人那側的時間，
 * 否則畫面不會自己長出 AI 那句。蓋已讀章請用下面那支。
 */
function selectedRowLastMessageMs(): number {
  const uid = selectedUserId.value
  if (!uid) return 0
  const sid = selectedSessionId.value
  return sid
    ? messageTimestampToMs(sessions.value.find((s: SessionItem) => s.sessionId === sid)?.unreadAt)
    : messageTimestampToMs(conversations.value.find((c: ConvItem) => c.userId === uid)?.lastMessageAt)
}

/**
 * 目前選中那一列上的「客人最後一則」——**紅點就是拿這個值在比**（見 isRowUnread）。
 *
 * 蓋已讀章一定要用它，不能用時間軸上最新那一則的時間：同一則訊息在兩邊有兩個時間戳
 * （見 handler.ts 的 lastMessageAt），2026-08-14 以前的資料上列這個比較晚，差幾百毫秒——
 * 而紅點差 1 毫秒就算沒看過。用錯來源的話章永遠差最後一步，紅點怎麼等都不會消。
 * ⛔ 蓋章的來源必須跟紅點比對的來源是同一個欄位，改任一邊都要一起改。
 */
function selectedRowCustomerLastMs(): number {
  const uid = selectedUserId.value
  if (!uid) return 0
  const sid = selectedSessionId.value
  if (sid) {
    const s = sessions.value.find((row: SessionItem) => row.sessionId === sid)
    return s ? sessionRowCustomerMs(s) : 0
  }
  const c = conversations.value.find((row: ConvItem) => row.userId === uid)
  return c ? convRowCustomerMs(c) : 0
}

function maybeRefreshOpenTimeline() {
  const uid = selectedUserId.value
  if (!uid) return
  // 有東西正在讀就跳過，等下一輪：插隊進去只會跟它搶同一份 timelineItems
  if (msgLoading.value || loadingOlder.value || loadingNewer.value) return
  const rowMs = selectedRowLastMessageMs()
  if (rowMs <= 0) return
  if (rowMs <= openTimelineRowMs) return
  if (rowMs <= newestTimestampMs(timelineItems.value.map((i: TimelineItem) => i.timestamp))) return
  openTimelineRowMs = rowMs
  void reloadTimeline({ quiet: true })
}

/**
 * 選中的客人有新訊息時，讓 AI 脈絡卡重抓一次。
 * 沒有這個的話卡片只在「切換客人」時更新——客服看著舊那題,客人其實已經又問了一題,
 * 對舊那題按「這題 AI 答錯了」就會被後端以 409 擋下(它比對的是最新那次互動)。
 */
let aiContextSeenAtMs = 0
function maybeRefreshAiContext() {
  const uid = selectedUserId.value
  if (!uid) return
  const row = conversations.value.find(c => c.userId === uid)
  const ms = row ? messageTimestampToMs(row.lastMessageAt) : 0
  if (!ms) return
  if (aiContextSeenAtMs && ms > aiContextSeenAtMs) aiContextRefreshKey.value++
  aiContextSeenAtMs = ms
}

async function loadMoreList() {
  if (!listHasMore.value || listLoading.value || listLoadingMore.value) return
  listPage.value += 1
  await loadList('more')
}

function onSidebarListScroll() {
  const el = sidebarListEl.value
  if (!el) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80)
    void loadMoreList()
}

/**
 * 「還有下一頁、但目前筆數少到撐不出捲軸」＝ 捲動事件永遠不會觸發，清單卡死在幾筆。
 * 補一輪自動續載，直到撐出捲軸或真的沒有下一頁為止（上限防呆，避免後端 hasMore 永遠為真時空轉）。
 */
const AUTO_FILL_MAX_PAGES = 5
async function autoFillSidebarList() {
  for (let i = 0; i < AUTO_FILL_MAX_PAGES; i++) {
    await nextTick()
    const el = sidebarListEl.value
    if (!el || !listHasMore.value) return
    if (el.scrollHeight > el.clientHeight + 40) return
    const before = activeTab.value === 'all' ? conversations.value.length : sessions.value.length
    await loadMoreList()
    const after = activeTab.value === 'all' ? conversations.value.length : sessions.value.length
    if (after <= before) return
  }
}

/**
 * 背景刷新（輪詢、送出訊息後、標記後）。
 *
 * 以前捲下去超過 80px 就整個放棄、只更新分頁數字——因為那時是整份重載，
 * 一刷新捲軸就跳回頂端。現在改成併入 + 補回捲動位置，捲到哪裡都能安全刷新。
 */
async function refreshListQuiet(): Promise<boolean> {
  return await loadList('merge')
}

let searchListTimer: ReturnType<typeof setTimeout> | null = null
watch(searchText, () => {
  if (searchListTimer) clearTimeout(searchListTimer)
  searchListTimer = setTimeout(() => void loadList('reset'), 300)
})

/**
 * 側欄分頁的數字。這一支後端是 8 個計數查詢，所以兩件事要把關：
 *
 * 1. **同一瞬間只跑一支**：`loadList` 一開頭就會叫它，而 reset 與 merge 是可以並存的
 *    （merge 只被 `listMerging` 擋，reset 只被 `listLoading` 擋）——不收斂的話換分頁
 *    撞上背景刷新就是兩份 8 個計數查詢同時出去。這個 repo 有讀取費暴衝的前科（`E-8`）。
 * 2. **落後的那一支不准寫**：兩支同時在路上時，先發的可能後到，寫下去等於把新的數字
 *    換回舊的——徽章上的「未首接 12」會比旁邊的清單舊好幾秒。
 */
let countsInflight: Promise<void> | null = null
let countsSeq = 0

/**
 * @param options.force 動作剛寫進資料庫（接手／交還／送訊息）之後要用。
 *   ⛔ 這種情境不可以共用飛行中的那一支：它可能是動作**之前**送出去的，
 *   拿它的答案等於徽章停在動作前的舊值（交還後「未首接」不減一）。
 */
async function loadSessionCounts(options: { force?: boolean } = {}) {
  if (countsInflight && !options.force) return countsInflight
  const ticket = ++countsSeq
  const task = (async () => {
    try {
      const res = await apiFetch<{ counts: Record<ConvSessionStatus, number>, followUp?: number | null }>(
        '/api/conversations/sessions-counts',
      )
      if (ticket !== countsSeq) return
      for (const k of Object.keys(sessionStatusCounts.value) as ConvSessionStatus[]) {
        sessionStatusCounts.value[k] = Number(res.counts?.[k] ?? 0)
      }
      // null＝後端查不到（⛔不轉成 0——那會把「不知道」印成「沒有」）
      followUpCount.value = typeof res.followUp === 'number' ? res.followUp : null
    }
    catch {
      // 分頁仍可用；數字維持上次成功值
    }
    finally {
      // 只有「最新那一支」有資格收尾：force 造成兩支重疊時，落後的那支不能把新的旗標清掉
      if (ticket === countsSeq) countsInflight = null
    }
  })()
  countsInflight = task
  return task
}

async function loadSupportPresets() {
  supportPresetsRaw.value = await apiFetch<any[]>('/api/support-preset/list').catch(() => [])
}

function openQuickReplySource() {
  window.open(`/admin/${workspaceId.value}/support-presets`, '_blank')
}

async function sendQuickReply() {
  if (!assertCanOperate()) return
  const id = pendingQuickReplyId.value
  if (!id || !selectedUserId.value || !selectedUser.value) return
  sending.value = true
  try {
    await apiFetch(
      `/api/conversations/${selectedUserId.value}/send-preset`,
      { method: 'POST', body: { presetId: id } },
    )
    showToast('已送出客服預存', 'success')
    // 送完就收起來：這顆按鈕的事已經做完，留著擋住剛送出的訊息
    quickReplyPickerVisible.value = false
    await reloadAfterOutgoing()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '送出預存失敗', 'error')
  }
  finally {
    sending.value = false
    pendingQuickReplyId.value = ''
  }
}

/**
 * 把預存／規則的文字填進回覆框，讓客服改完再自己送。
 *
 * 文字向後端要，不直接用清單裡那份：{{屬性}} 要換成這位客人的實際值，
 * 代換規則得和真的送出同一套，否則客服會把 {{displayName}} 原封不動送出去。
 */
async function fillQuickReply() {
  if (!assertCanOperate()) return
  const item = pendingQuickReplyItem.value
  if (!item || !selectedUserId.value) return
  quickReplyFilling.value = true
  try {
    const res = await apiFetch<{ text: string | null }>(
      `/api/conversations/${selectedUserId.value}/quick-reply-text`,
      { params: { presetId: item.id } },
    )
    const text = String(res?.text ?? '')
    if (!text) {
      showToast('這則沒有可以修改的文字，請用「直接送出」', 'warning')
      return
    }
    inputText.value = text
    quickReplyPickerVisible.value = false
    pendingQuickReplyId.value = ''
    await nextTick()
    focusInput()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '載入內容失敗', 'error')
  }
  finally {
    quickReplyFilling.value = false
  }
}

function getActionType(preset: any): AutoReplyActionType {
  const type = preset?.action?.type
  return type === 'module' || type === 'uri' ? type : 'message'
}

function getActionSummary(preset: any): string {
  const action = preset?.action || {}
  if (action.type === 'module') return '觸發機器人模組'
  if (action.type === 'uri') return action.uri || '開啟網址'
  return action.text || '傳送文字'
}

/**
 * 依 userId 選中對話；不在已載入的第一頁時，用列表端點的 userId 直達參數撈那一筆。
 * 深連結帶的是純 LINE userId、清單列的是複合 doc id，比對要兩種都認。
 * ⛔ 不要退回 search=userId：那會走整段清單掃描（客人越舊掃越多，最舊一次要掃
 *    3,000 條對話），直達照編號讀只要 1 次，而且再舊的客人都找得到。
 */
async function selectUserById(userId: string, opts?: { sessionId?: string }) {
  let target = conversations.value.find(c => c.userId === userId || c.userId.endsWith(`_${userId}`)) ?? null
  if (!target) {
    const res = await apiFetch<{ conversations: ConvItem[] }>('/api/conversations/list', {
      params: { page: 1, limit: 1, userId },
    }).catch(() => null)
    target = res?.conversations?.[0] ?? null
  }
  if (target) {
    await selectUser(target, opts)
    return
  }
  // 找不到就要說:靜默不動的話,從監控頁按「開對話」會像連結壞掉
  showToast('找不到這位客人的對話，請用左側搜尋看看', 'warning')
}

/**
 * @param opts.sessionId 指定要落在**哪一場**（AI 建議的出處、深連結）。
 *   不給＝最新那場（一般點選客人的行為）。
 *   ⛔ 要在這裡就帶進去、不要「先開最新那場再切過去」：那會讀兩次時間軸，
 *      畫面還會先閃一下最新的對話再跳走。
 */
async function selectUser(c: ConvItem, opts?: { sessionId?: string }) {
  // 換人＝重新黏回底部。不重設的話，上一位客人翻到一半的狀態會跟著帶進來
  stickToBottom.value = true
  // 換人前先把打到一半的字收進這位客人的抽屜，再拿出下一位的
  if (selectedUserId.value !== c.userId) {
    stashDraft()
    inputText.value = drafts.get(c.userId) ?? ''
  }
  selectedSessionId.value = opts?.sessionId || null
  sessionMeta.value = null
  allTabActiveSession.value = null
  // 換人就重設基準時間，否則會拿上一位客人的時間戳去比、一進來就誤判成「有新訊息」
  aiContextSeenAtMs = 0
  // 同理（見 maybeRefreshOpenTimeline）：這裡就把最新那一則讀進來了，記成「已經為它讀過」。
  // 留著上一位的數字，換到比較安靜的客人時會把他之後的新訊息全判成舊的、不自己更新
  openTimelineRowMs = messageTimestampToMs(c.lastMessageAt)
  selectedUserId.value = c.userId
  selectedUser.value = c
  pendingQuickReplyId.value = ''
  /**
   * 已讀章只蓋到「客人最後開口」為止（見 loadTimeline 裡的說明）。
   *
   * ⛔ **指定了某一場時不可以用 `convRowCustomerMs`**：那是**整段對話**最後一則客人訊息的
   * 時間（跨所有場次），但畫面上只載入了那一場的內容。拿它蓋章＝把根本沒顯示出來的
   * 新訊息一起標成已讀，紅點消失、而且沒有人會知道有那幾則（`markConversationRead`
   * 取 max，所以只有「傳太大」會出事，傳小的是無害的 no-op）。
   * 傳 0＝只用這一段實際載到的最新一則客人訊息蓋章，與 `selectSession` 的口徑一致
   * （那支用的是 `sessionRowCustomerMs`＝那一場的）。
   */
  await loadTimeline(c.userId, {
    seenUpToMs: opts?.sessionId ? 0 : convRowCustomerMs(c),
    sessionId: opts?.sessionId,
  })
}

/**
 * 就地切到指定的那一場（人已經選好了）。
 * 給右側客人檔案卡的「AI 建議 → 看這段對話」用：即使人已經在對話頁，
 * 正在看的也未必是產生那條建議的那一場。
 */
async function openSessionById(sessionId: string) {
  const userId = selectedUserId.value
  if (!userId || !sessionId) return
  if (selectedSessionId.value === sessionId) return
  stickToBottom.value = true
  selectedSessionId.value = sessionId
  allTabActiveSession.value = null
  sessionMeta.value = null
  aiContextSeenAtMs = 0
  await loadTimeline(userId, { sessionId })
}

// ── 對話時間軸：一段一段讀 ──────────────────────────────────────────
// 一次撈半年的對話沒有意義（開啟要等、九成九沒人看），所以只讀最新一段，
// 往上滑到頂再接著讀更早的一段。五個分頁走同一條路，看到的是同一條完整對話。

/** 一段幾則。與後端預設一致；改這裡就好，後端會照著吃 */
const TIMELINE_PAGE_SIZE = 40
/** 捲到離頂端這麼近就去讀更早的一段（留一點提前量，不要等真的貼到頂才動） */
const LOAD_OLDER_EDGE_PX = 160

/** 目前載入到的最舊／最新那一則**訊息**的 id：往上／往下讀的游標（事件與群發不是訊息文件，不能當游標） */
function oldestMessageId(): string {
  return timelineItems.value.find(i => i.type === 'message')?.id ?? ''
}
function newestMessageId(): string {
  for (let i = timelineItems.value.length - 1; i >= 0; i--) {
    const item = timelineItems.value[i]!
    if (item.type === 'message') return item.id
  }
  return ''
}

/**
 * 把新讀到的一段併進已載入的內容。
 *
 * 照 id 去重（不是照位置）：往下讀時「會話已結束」那一行會同時落在相鄰兩段的範圍裡
 * （它在最後一則訊息之後、下一則訊息之前，見後端 TimeWindow），不去重就會出現兩次。
 * 沒變的那幾則沿用原物件，Vue 才不會把整串泡泡重繪一遍——圖片泡泡重繪會閃，
 * 已簽好的媒體網址也會被重跑一輪。
 */
function mergeTimeline(prev: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const incomingIds = new Set(incoming.map(i => i.id))
  const merged = [...prev.filter(i => !incomingIds.has(i.id)), ...incoming]
  merged.sort((a, b) => messageTimestampToMs(a.timestamp) - messageTimestampToMs(b.timestamp))
  return reuseUnchangedRows(prev, merged, i => i.id)
}

/**
 * 讀這位客人的對話（最新的一段）。
 *
 * sessionId = 從會話分頁點進來的那一場：已結束的場會從那場的尾巴開始讀，客服點三天前
 * 那場就看到那場（後端負責錨定），下面沒讀的部分由 timelineHasNewer 告訴使用者。
 * quiet = 自己剛送出後的刷新：不清空、不轉圈，只把最新一段併進來。原本這條走整份重載，
 * 每回一句就把整個對話清成一顆 spinner 再長回來——連回三句就閃三次。
 */
/**
 * 這段回應還是不是「現在畫面上這一段」。
 *
 * 只比對客人不夠：同一位客人的兩場會話點得快一點，兩個請求會同時在路上，而已結束那場要多做
 * 錨定查詢、通常比較慢。晚回來的那段若照樣蓋上去，時間軸、上下還有沒有的旗標、工具列狀態
 * 就會是另一場的（左側還亮在你點的那場），看起來就是「點了 A 卻顯示 B」。
 */
function isStaleTimelineResponse(userId: string, sessionId: string): boolean {
  return selectedUserId.value !== userId || (selectedSessionId.value || '') !== sessionId
}

async function loadTimeline(
  userId: string,
  options?: { sessionId?: string, quiet?: boolean, seenUpToMs?: number },
) {
  const quiet = options?.quiet === true
  const sessionId = options?.sessionId || ''
  let loaded = false
  if (!quiet) {
    timelineItems.value = []
    timelineHasOlder.value = false
    timelineHasNewer.value = false
    msgLoading.value = true
  }
  try {
    const res = await apiFetch<TimelineResponse>(`/api/conversations/${userId}/messages`, {
      params: { limit: TIMELINE_PAGE_SIZE, sessionId: sessionId || undefined },
    })
    // 回來時人或會話已經切走了就整段丟掉，不要把上一個畫面的內容貼到現在這個上面
    if (isStaleTimelineResponse(userId, sessionId)) return
    const incoming = res.items ?? []
    timelineItems.value = quiet ? mergeTimeline(timelineItems.value, incoming) : incoming
    /**
     * 安靜刷新讀的是「最新一段」，但畫面上可能已經往上讀了好幾段。
     * 這一段說「上面還有」時，那可能只是指我們手上已經載到的那些——所以只有在
     * 已載入的內容沒有比這一段更舊的東西時，才照它的答案，否則維持原本的旗標。
     */
    const pageOldestMs = messageTimestampToMs(incoming.find(i => i.type === 'message')?.timestamp)
    const keptOlder = quiet && pageOldestMs > 0 && timelineItems.value.some(
      i => i.type === 'message' && messageTimestampToMs(i.timestamp) < pageOldestMs,
    )
    if (!keptOlder) timelineHasOlder.value = res.hasOlder === true
    timelineHasNewer.value = res.hasNewer === true
    allTabActiveSession.value = sessionId ? null : res.activeSession ?? null
    if (sessionId && res.session) sessionMeta.value = res.session
    await nextTick()
    // 安靜刷新（自己剛送完）不強拉：客服正在往上翻舊訊息時，畫面不該自己跳走
    scrollToBottom({ force: !quiet })
    /**
     * 已讀章只吃**客人那側的訊息時間**，跟紅點比的欄位同一族（見 isRowUnread）。
     *
     * ⛔ 不可以退回「時間軸上最新那一則」：那會把我們自己回的、AI 回的、系統事件的
     * 伺服器時間也蓋進去，而客人來訊蓋的是 LINE 事件時間。兩族混用的話，webhook 遲送
     * 或客人跟我們幾乎同時發話時，新進來那則的時間會早於已讀基準 → 那一列摘要換了、
     * 前綴是「客人：」，就是永遠不會亮紅點。
     */
    stampConversationRead(userId, Math.max(
      newestTimestampMs(timelineItems.value
        .filter((i: TimelineItem) => i.type === 'message' && i.direction === 'incoming')
        .map((i: TimelineItem) => i.timestamp)),
      options?.seenUpToMs ?? 0,
    ))
    loaded = true
  }
  catch {
    showToast('載入對話失敗', 'error')
  }
  finally {
    if (!quiet) msgLoading.value = false
  }
  // 續讀要等 msgLoading 放掉才動：loadOlderTimeline 看到還在載入中會直接回頭
  if (loaded && !quiet) await autoFillTimeline()
}

/**
 * 接著讀上一段／下一段。
 *
 * 兩個方向只差四件事：用哪一頭的游標、動哪一組旗標、失敗時說哪一句、以及要不要把捲軸
 * 補回原位。其餘的守衛、合併、過期判斷完全一樣——拆成兩支的話，之後改其中一邊的規則
 * （像過期回應要不要連會話一起比對）另一邊就會悄悄留在舊行為。
 *
 * · 往上（older）：捲到接近頂端時自動觸發。讀完要把捲軸補回原位，內容接在**上面**，
 *   不補的話客服正在看的那幾則會被推到畫面外，等於自己往下跳了一段。
 * · 往下（newer）：只有點進已結束的舊會話時才有意義，所以是使用者按了才讀、不自動觸發
 *   （自動的話「黏在底部」會一路把整段歷史翻完）。
 */
async function loadTimelinePage(direction: 'older' | 'newer') {
  const older = direction === 'older'
  const loading = older ? loadingOlder : loadingNewer
  const hasMore = older ? timelineHasOlder : timelineHasNewer
  if (loading.value || msgLoading.value || !hasMore.value) return
  const userId = selectedUserId.value
  if (!userId) return
  const sessionId = selectedSessionId.value || ''
  const cursor = older ? oldestMessageId() : newestMessageId()
  /**
   * 這一段一則訊息都沒有（只有事件行）＝沒有可以接續的游標——那場的訊息被保留期清掉時
   * 就會這樣。游標是訊息 id，接不下去。往下讀是使用者按的，直接 return 會讓按鈕看起來
   * 壞掉，所以帶他到最新一段並說明；往上讀是捲動自動觸發的，靜靜停住就好。
   */
  if (!cursor) {
    if (!older) {
      showToast('這一段沒有可接續的訊息（可能已超過保留期限），已跳到最新', 'warning')
      await leaveSessionSegment(userId)
    }
    return
  }

  loading.value = true
  const el = messagesEl.value
  const heightBefore = el?.scrollHeight ?? 0
  const topBefore = el?.scrollTop ?? 0
  try {
    const res = await apiFetch<TimelineResponse>(`/api/conversations/${userId}/messages`, {
      params: { limit: TIMELINE_PAGE_SIZE, ...(older ? { beforeId: cursor } : { afterId: cursor }) },
    })
    if (isStaleTimelineResponse(userId, sessionId)) return
    const incoming = res.items ?? []
    timelineItems.value = mergeTimeline(timelineItems.value, incoming)
    hasMore.value = (older ? res.hasOlder : res.hasNewer) === true && incoming.length > 0
    if (older && el) {
      await nextTick()
      el.scrollTop = topBefore + (el.scrollHeight - heightBefore)
    }
  }
  catch {
    showToast(older ? '載入更早的訊息失敗' : '載入後續訊息失敗', 'error')
  }
  finally {
    loading.value = false
  }
}

function loadOlderTimeline() { return loadTimelinePage('older') }
function loadNewerTimeline() { return loadTimelinePage('newer') }

/**
 * 「還有更早的、但目前內容少到撐不出捲軸」＝捲動事件永遠不會觸發，對話卡在幾則。
 * 補一輪自動續讀，直到撐出捲軸或真的沒有更早的為止（同側欄的 autoFillSidebarList）。
 */
async function autoFillTimeline() {
  for (let i = 0; i < AUTO_FILL_MAX_PAGES; i++) {
    await nextTick()
    const el = messagesEl.value
    if (!el || !timelineHasOlder.value) return
    if (el.scrollHeight > el.clientHeight + 40) return
    const before = timelineItems.value.length
    await loadOlderTimeline()
    if (timelineItems.value.length <= before) return
  }
}

/**
 * 回到對話的最後一則。
 *
 * 下面還有沒讀的內容時（看舊會話），單純捲到底只會停在「已載入的最後一則」——
 * 那不是最新的。這時要重新讀一次最新一段，畫面才真的回到現在。
 */
async function jumpToLatest() {
  if (timelineHasNewer.value && selectedUserId.value) {
    await leaveSessionSegment(selectedUserId.value)
    return
  }
  scrollToBottom()
}

/**
 * 離開「某一場會話」的那一段，回到對話的最新一段。
 * 這一跳離開了那一場的範圍，工具列跟著回到「進行中會話」，不要繼續顯示舊那場的狀態。
 */
async function leaveSessionSegment(userId: string) {
  // 先問再清：清掉之後就找不到剛剛看的那一場，那一則的時間也就拿不到了。
  // 跳回最新一段之後畫面上就是最後一則，這一跳要算「看過了」（見 reloadTimeline）
  const seenUpToMs = selectedRowCustomerLastMs()
  selectedSessionId.value = null
  sessionMeta.value = null
  await loadTimeline(userId, { seenUpToMs })
}

/**
 * Enter 送出、Shift + Enter 換行。
 *
 * isComposing 一定要擋：用注音／拼音打字時，按 Enter 是在選字，不是要送出——
 * 沒擋的話會把還沒選完的半句送給客人。
 */
function onInputEnter(evt: Event | KeyboardEvent) {
  const e = evt as KeyboardEvent
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  send()
}

/**
 * 送出文字：泡泡先上畫面，等待丟到背景。
 *
 * 刻意不設 sending（那會 disable 輸入框）：像 LINE 一樣，按下 Enter 的那一刻
 * 訊息就出現在對話裡、輸入框清空，客服可以直接打下一句，不必等伺服器回來。
 * 真的送不出去時那顆泡泡會變成「傳送失敗」，就地可以重試或刪掉——
 * 比「彈個 toast、字已經不見了」誠實得多。
 */
async function send() {
  if (!assertCanOperate()) return
  const userId = selectedUserId.value
  if (!userId) return
  const text = inputText.value.trim()
  if (!text) {
    showToast('請輸入訊息', 'error')
    return
  }

  const localId = `local-${++pendingOutgoingSeq}`
  pendingOutgoing.value.push({ localId, userId, text, at: Date.now(), status: 'sending' })
  inputText.value = ''
  drafts.delete(userId)
  persistDrafts()
  await nextTick()
  scrollToBottom()
  focusInput()

  void deliverPendingOutgoing(localId)
}

async function deliverPendingOutgoing(localId: string) {
  const entry = pendingOutgoing.value.find(p => p.localId === localId)
  if (!entry) return
  entry.status = 'sending'
  entry.error = undefined
  try {
    await apiFetch(`/api/conversations/${entry.userId}/send`, {
      method: 'POST',
      body: { type: 'text', text: entry.text },
    })
    // 背景對一次帳（狀態列的「真人處理中」、側欄最後一句、分頁數字都靠它）。
    // 客服早就在打下一句了，這幾百毫秒看不見。
    if (selectedUserId.value === entry.userId) await reloadAfterOutgoing()
    else await refreshListQuiet()
    // 伺服器那則已經在畫面上了，本地泡泡才能撤：反過來會閃一下空白
    pendingOutgoing.value = pendingOutgoing.value.filter(p => p.localId !== localId)
  }
  catch (e: any) {
    entry.status = 'failed'
    entry.error = e?.data?.statusMessage || '發送失敗'
  }
}

function retryPendingOutgoing(localId: string) {
  if (!assertCanOperate()) return
  void deliverPendingOutgoing(localId)
}

/** 放棄這則：文字先還回輸入框，才不會連改都沒機會就整段消失 */
function discardPendingOutgoing(localId: string) {
  const entry = pendingOutgoing.value.find(p => p.localId === localId)
  pendingOutgoing.value = pendingOutgoing.value.filter(p => p.localId !== localId)
  if (!entry) return
  // 已經切到別位客人的話，寫回那位客人的草稿抽屜，別把 A 的話塞進 B 的輸入框
  if (selectedUserId.value !== entry.userId) {
    const kept = drafts.get(entry.userId)
    drafts.set(entry.userId, kept?.trim() ? `${kept.replace(/\s+$/, '')}\n${entry.text}` : entry.text)
    persistDrafts()
    showToast('文字已收回那位客人的輸入框', 'success')
    return
  }
  inputText.value = inputText.value.trim()
    ? `${inputText.value.replace(/\s+$/, '')}\n${entry.text}`
    : entry.text
  nextTick(focusInput)
}

/**
 * 重新讀最新一段（接手／交還／結案後）：狀態列與事件行都會變，但已讀到的舊訊息留著。
 *
 * 看的是歷史那一段（下面還有沒讀的）時不重讀：那一段的內容不會因為現在按了什麼而改變，
 * 重讀只會把客服正在看的位置甩掉。
 *
 * 已讀章一律蓋到「列上客人最後那一則」為止（selectedRowCustomerLastMs），不是時間軸最新那一則——
 * 走這支的每一條路（接手／交還／結案／自己回一句／開著的對話自己收新訊息）事後都該是
 * 「看過了」。少了它，按完接手那顆紅點還亮著，要點去別人那再點回來才消得掉。
 */
async function reloadTimeline(options?: { quiet?: boolean }) {
  const userId = selectedUserId.value
  if (!userId || timelineHasNewer.value) return
  await loadTimeline(userId, {
    sessionId: selectedSessionId.value || undefined,
    quiet: options?.quiet === true,
    seenUpToMs: selectedRowCustomerLastMs(),
  })
}

/**
 * 自己剛送出東西後的刷新：一律安靜（不清空、不轉圈），只有內容悄悄多一則。
 *
 * 例外是**看已結束的那一場**：那一段被後端錨定在該場的 closedAt（見 messages.get.ts 的
 * anchorCloseMs），剛送出的這則時間在那之後，永遠不會出現在這一段裡——安靜刷新等於拿回
 * 一段沒有它的內容，接著 deliverPendingOutgoing 撤掉本地泡泡，訊息就整個從畫面上消失
 * （客服會當成沒送出去而重送，客人收到兩次）。所以送完就離開那一段回到最新。
 */
async function reloadAfterOutgoing() {
  const userId = selectedUserId.value
  if (!userId) return
  if (selectedSessionId.value && Number(sessionMeta.value?.closedAtMs) > 0) {
    await leaveSessionSegment(userId)
    // 清單那輪跑到的話它開頭已經發過一次數字；被閘門擋掉才補（force：剛送出的那則要算進去）
    if (!(await refreshListQuiet())) await loadSessionCounts({ force: true })
    return
  }
  await reloadTimeline({ quiet: true })
  // 有選到場就重抓清單（`loadList` 開頭已含分頁數字那一支）；被閘門擋掉或沒選到場才單獨補
  if (!selectedSessionId.value || !(await refreshListQuiet())) await loadSessionCounts({ force: true })
}

/**
 * 客服主動接手：把這場轉真人處理，機器人／AI 停止自動回覆後續訊息。
 * 先前只能「回一句話」才會讓機器人閉嘴——想先看資料再回覆的時候沒有辦法先卡住它。
 */
async function takeOverSelectedSession() {
  const sid = selectedSessionId.value || allTabActiveSession.value?.sessionId
  if (!sid || !canTakeOverSession.value) return
  if (!assertCanOperate()) return
  takingOverSession.value = true
  try {
    await apiFetch(`/api/conversations/sessions/${sid}/takeover`, {
      method: 'POST',
    })
    showToast('已接手，機器人與 AI 不會再自動回覆這位客人（按「交還機器人」可恢復）', 'success')
    // 接手的人最需要的就是「這場到現在發生什麼事」。刻意不 await：摘要要跑一次 LLM，
    // 讓它擋住接手的畫面更新沒有道理——接手本身已經成立，摘要晚兩秒出現即可。
    aiContextBanner.value?.refreshSummary()
    await reloadTimeline()
    const listRan = await refreshListQuiet()
    // 後端接手時會自動把負責人指給按的人；清單重抓後把它補到頂部那顆按鈕上
    syncSelectedAssigneeFromList()
    // 側欄分頁的數字：`loadList` 一開頭就會發一次（動作已經寫進資料庫了，那一次讀到的是新值），
    // 所以只有它被閘門擋掉（正好有另一輪背景刷新在跑）時才需要自己補，否則就是白打一次八個計數查詢
    if (!listRan) await loadSessionCounts({ force: true })
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '接手失敗', 'error')
  }
  finally {
    takingOverSession.value = false
  }
}

async function handBackSelectedSession() {
  const sid = selectedSessionId.value || allTabActiveSession.value?.sessionId
  const st = sessionToolbarMeta.value?.status
  if (!sid || (st !== 'pending_human' && st !== 'human_handling'))
    return
  if (!assertCanOperate()) return
  handingBackSession.value = true
  try {
    await apiFetch(`/api/conversations/sessions/${sid}/handback`, {
      method: 'POST',
    })
    showToast('已交還機器人，AI / 自動回覆恢復接手', 'success')
    await reloadTimeline()
    // 狀態變了，側欄分頁的數字也要跟著動（先前漏了，交還後徽章會停在舊值）；
    // `loadList` 跑到的話它自己開頭就發過一次，只有被擋掉才補
    if (!(await refreshListQuiet())) await loadSessionCounts({ force: true })
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '交還機器人失敗', 'error')
  }
  finally {
    handingBackSession.value = false
  }
}

async function closeSelectedSession() {
  const sid = selectedSessionId.value || allTabActiveSession.value?.sessionId
  const st = sessionToolbarMeta.value?.status
  if (!sid || st === 'closed')
    return
  try {
    await ElMessageBox.confirm('結束會話後，這位客人下次來訊會被視為新的一段會話。確定結束？', '結束會話', {
      confirmButtonText: '結束會話',
      cancelButtonText: '取消',
      type: 'warning',
    })
  }
  catch { return }
  closingSession.value = true
  try {
    await apiFetch(`/api/conversations/sessions/${sid}/close`, {
      method: 'POST',
    })
    showToast('已結束會話', 'success')
    await reloadTimeline()
    await refreshListQuiet()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '結束會話失敗', 'error')
  }
  finally {
    closingSession.value = false
  }
}

function resetQuickMediaForm() {
  quickMediaUploading.value = false
  mediaForm.value = {
    originalContentUrl: '',
    previewImageUrl: '',
    durationSeconds: 5,
  }
  clearQuickFileInputs()
}

function clearQuickFileInputs() {
  if (imageInputRef.value) imageInputRef.value.value = ''
  if (videoInputRef.value) videoInputRef.value.value = ''
  if (audioInputRef.value) audioInputRef.value.value = ''
}

type QuickPickKind = 'image' | 'video' | 'audio'

function triggerQuickPick(kind: QuickPickKind) {
  if (kind === 'image') imageInputRef.value?.click()
  else if (kind === 'video') videoInputRef.value?.click()
  else if (kind === 'audio') audioInputRef.value?.click()
}

function toUploadMediaKind(kind: QuickPickKind): 'image' | 'video' | 'audio' {
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  return 'audio'
}

async function getAudioDurationSeconds(file: File): Promise<number> {
  return await new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      const duration = Number(audio.duration)
      URL.revokeObjectURL(objectUrl)
      resolve(Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.round(duration)) : 5)
    }
    audio.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(5)
    }
    audio.src = objectUrl
  })
}

async function createVideoPreviewFile(file: File): Promise<File | null> {
  if (typeof document === 'undefined') return null
  const objectUrl = URL.createObjectURL(file)
  try {
    const frameBlob = await new Promise<Blob | null>((resolve) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      video.playsInline = true

      video.onloadeddata = () => {
        const sourceWidth = video.videoWidth || 1280
        const sourceHeight = video.videoHeight || 720
        const targetWidth = Math.min(sourceWidth, 960)
        const targetHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * targetWidth))
        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(video, 0, 0, targetWidth, targetHeight)
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.86)
      }

      video.onerror = () => resolve(null)
      video.src = objectUrl
    })

    if (!frameBlob) return null
    const baseName = file.name.replace(/\.[^/.]+$/, '') || 'video'
    return new File([frameBlob], `${baseName}-preview.jpg`, { type: 'image/jpeg' })
  }
  finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function onQuickFileChange(kind: QuickPickKind, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await ingestQuickFile(kind, file)
}

/** 檢查 + 上傳 + 填進媒體表單。選檔、貼上、拖曳三條路都走這裡 */
async function ingestQuickFile(kind: QuickPickKind, file: File) {
  const validation = validateFile(file, toUploadMediaKind(kind))
  if (!validation.ok) {
    showToast(validation.message, 'error')
    return
  }

  quickMediaUploading.value = true
  try {
    const url = await uploadToStorage(file)
    if (!url) throw new Error('empty upload url')

    if (kind === 'image') {
      mediaForm.value.originalContentUrl = url
      mediaForm.value.previewImageUrl = url
    }
    else if (kind === 'video') {
      mediaForm.value.originalContentUrl = url
      mediaForm.value.previewImageUrl = url
      const previewFile = await createVideoPreviewFile(file)
      if (previewFile) {
        try {
          const previewUrl = await uploadToStorage(previewFile)
          mediaForm.value.previewImageUrl = previewUrl || url
        }
        catch {
          showToast('已上傳影片，預覽圖自動產生失敗，將使用影片連結', 'error')
        }
      }
    }
    else if (kind === 'audio') {
      mediaForm.value.originalContentUrl = url
      mediaForm.value.durationSeconds = await getAudioDurationSeconds(file)
    }
  }
  catch {
    showToast('上傳失敗，請稍後再試', 'error')
  }
  finally {
    quickMediaUploading.value = false
  }
}

function onQuickSendCommand(command: string | number | object) {
  const type = String(command || '') as QuickSendType
  if (!selectedUserId.value) {
    showToast('請先選擇一位使用者', 'error')
    return
  }
  if (!quickSendActions.some(action => action.type === type)) return
  quickSendType.value = type
  resetQuickMediaForm()
  mediaDialogVisible.value = true
}

/**
 * 貼上（Cmd+V）或拖進來的圖片。
 *
 * 客服最常做的動作是截圖直接貼，原本一定要走 ＋ →「圖片」→ 對話框 → 選檔案。
 * 這裡刻意不直接送出，而是開原本那個媒體對話框並把圖帶進去：
 * 送圖給客人收不回來，貼錯一張的代價比多按一次「送出」高太多。
 */
async function acceptDroppedImage(file: File) {
  if (!assertCanOperate()) return
  if (!selectedUserId.value) {
    showToast('請先選擇一位使用者', 'error')
    return
  }
  quickSendType.value = 'image'
  resetQuickMediaForm()
  mediaDialogVisible.value = true
  await ingestQuickFile('image', file)
}

function pickImageFile(source: DataTransfer | null | undefined): File | null {
  const items = Array.from(source?.items ?? [])
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}

/** 貼上圖片就接手；貼的是文字則什麼都不做，維持原本的貼上行為 */
function onInputPaste(evt: Event) {
  const file = pickImageFile((evt as ClipboardEvent).clipboardData)
  if (!file) return
  evt.preventDefault()
  void acceptDroppedImage(file)
}

/** 拖曳計數器：dragleave 進到子元素也會觸發，用進出次數判斷才不會閃 */
const dragDepth = ref(0)
const isDraggingImage = computed(() => dragDepth.value > 0)

function onDragEnter(evt: DragEvent) {
  if (!Array.from(evt.dataTransfer?.types ?? []).includes('Files')) return
  dragDepth.value++
}

function onDragLeave() {
  if (dragDepth.value > 0) dragDepth.value--
}

function onDropFile(evt: DragEvent) {
  dragDepth.value = 0
  const file = pickImageFile(evt.dataTransfer)
  if (!file) {
    // 拖進來的不是圖片就要說一聲，不然會以為系統壞了
    if (Array.from(evt.dataTransfer?.types ?? []).includes('Files'))
      showToast('這裡只收圖片；影片、音訊、檔案請用左下角的 ＋', 'warning')
    return
  }
  void acceptDroppedImage(file)
}

async function sendQuickMedia() {
  if (!assertCanOperate()) return
  if (!selectedUserId.value || !canSendQuickMedia.value) return
  const body: Record<string, any> = {
    type: quickSendType.value,
    originalContentUrl: String(mediaForm.value.originalContentUrl || '').trim(),
  }
  if (quickSendType.value === 'image' || quickSendType.value === 'video') {
    body.previewImageUrl = String(mediaForm.value.previewImageUrl || mediaForm.value.originalContentUrl || '').trim()
  }
  if (quickSendType.value === 'audio') {
    body.duration = Math.round(Number(mediaForm.value.durationSeconds) * 1000)
  }

  sending.value = true
  try {
    await apiFetch(`/api/conversations/${selectedUserId.value}/send`, {
      method: 'POST',
      body,
    })
    mediaDialogVisible.value = false
    resetQuickMediaForm()
    await reloadAfterOutgoing()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '發送失敗', 'error')
  }
  finally {
    sending.value = false
  }
}

/**
 * 捲到最新一則。
 *
 * 為什麼不是一行 `scrollTop = scrollHeight` 就好：捲的那一刻，圖片／影片／圖文卡的高度**還是 0**
 * （el-image 的 <img> 還沒載完、版面還沒撐開），捲到底其實是捲到「還沒長高的底」。
 * 圖一載完，下面又多出好幾百 px，畫面就停在半路——最後一則整張圖的推播訊息看不到。
 * 所以捲完要再守一小段時間：只要人還黏在底部、內容又長高了，就再貼回最下面。
 * 超過這段時間才載完的（大圖、慢網路）由 onMessagesContentGrew 接手。
 *
 * force = 使用者主動換脈絡（開對話、送出訊息）：一定回到最新。
 * force = false 的背景刷新只在人本來就停在底部時才捲，正在翻舊訊息不會被拉走。
 */
const PIN_BOTTOM_MS = 1500
const PIN_BOTTOM_STEP_MS = 100

function scrollToBottom(options?: { force?: boolean }) {
  if (options?.force !== false) stickToBottom.value = true
  if (!stickToBottom.value) return
  if (pinBottomTimer) clearInterval(pinBottomTimer)
  scrollToBottomNow()
  const until = Date.now() + PIN_BOTTOM_MS
  pinBottomTimer = setInterval(() => {
    if (!stickToBottom.value || !messagesEl.value || Date.now() > until) {
      stopPinBottom()
      return
    }
    scrollToBottomNow()
  }, PIN_BOTTOM_STEP_MS)
}

function scrollToBottomNow() {
  const el = messagesEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function stopPinBottom() {
  if (pinBottomTimer) clearInterval(pinBottomTimer)
  pinBottomTimer = null
}

/**
 * 使用者往上翻就放掉「黏在底部」，右下角換成「回到最新」。
 * 內容在下面長高不會觸發 scroll（scrollTop 沒變），所以這裡只會收到真的捲動。
 *
 * 快翻到頂就順手把更早的一段讀進來（見 loadOlderTimeline）——這就是「往上滑才載入」。
 */
function onMessagesScroll() {
  const el = messagesEl.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  /**
   * 停在「已載入的最後一則」不等於停在對話的最後一則：看已結束的舊會話時，下面還有
   * 沒讀進來的訊息。這時不黏底——黏了的話圖片載完的重貼底會一路把整段歷史自動翻完，
   * 而右下角那顆按鈕才是往下走的路（見 jumpToLatest）。
   */
  stickToBottom.value = atBottom && !timelineHasNewer.value
  if (el.scrollTop <= LOAD_OLDER_EDGE_PX) void loadOlderTimeline()
}

/**
 * 對話區裡任何一張圖／一支影片載完（load / error / loadedmetadata 都在捕獲階段收，
 * 這些事件不會冒泡，只能用 capture 從外面攔）。載完＝版面剛長高，還黏在底部就再貼回去。
 */
function onMessagesContentGrew() {
  if (stickToBottom.value) scrollToBottomNow()
}

function formatTime(ts: any): string {
  if (!ts) return ''
  const d = ts?.toDate ? ts.toDate() : new Date(ts._seconds ? ts._seconds * 1000 : ts)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}

/**
 * 訊息流裡的時間一律只給時分。
 *
 * 側欄的 formatTime 是「今天給時間、以前給日期」——那是列表要的（一眼看出多久沒回）。
 * 但泡泡不能這樣：舊訊息只印「8/5」就等於把時間吃掉，客服看不出那天幾點回的。
 * 日期交給上面的分隔線（見 chatDayGroups），這裡專心講幾點幾分。
 */
function formatClockTime(ts: any): string {
  const ms = messageTimestampToMs(ts)
  if (ms <= 0) return ''
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function getActiveCategory(kind: PickerKind): string {
  return kind === 'emoji' ? activeEmojiCategory.value : activeStickerCategory.value
}

function setActiveCategory(kind: PickerKind, categoryId: string) {
  if (kind === 'emoji') activeEmojiCategory.value = categoryId
  else activeStickerCategory.value = categoryId
}

function getPickerItems(kind: PickerKind): PickerItem[] {
  if (kind === 'emoji') {
    const active = activeEmojiCategory.value
    const list = active === 'recent'
      ? recentEmojis.value
      : (emojiCategoryMap[active] || EMOJI_ALL)
    return list.map(emoji => ({ id: `emoji-${emoji}`, kind: 'emoji', emoji }))
  }

  const stickers = stickerCategoryMap[activeStickerCategory.value] ?? stickerCategoryMap.cute ?? []
  return stickers.map(preset => ({
    id: `sticker-${preset.packageId}-${preset.stickerId}`,
    kind: 'sticker',
    packageId: preset.packageId,
    stickerId: preset.stickerId,
  }))
}

function onPickerItemSelect(kind: PickerKind, item: PickerItem) {
  if (kind === 'emoji' && item.kind === 'emoji') {
    appendEmoji(item.emoji)
    return
  }
  // 貼圖只是選起來；真的送出要再按一次（見 picker 底部的說明）
  if (kind === 'sticker' && item.kind === 'sticker') {
    pendingSticker.value = { packageId: item.packageId, stickerId: item.stickerId }
  }
}

function isPendingSticker(item: PickerItem): boolean {
  if (item.kind !== 'sticker') return false
  const picked = pendingSticker.value
  return !!picked && picked.packageId === item.packageId && picked.stickerId === item.stickerId
}

async function sendPendingSticker() {
  const picked = pendingSticker.value
  if (!picked) return
  await sendSticker(picked.packageId, picked.stickerId)
}

/**
 * 把字插在游標的位置，不是一律黏到最後面。
 *
 * 訊息可以換行之後這個差別很明顯：寫完三段想在第一段補個 emoji，原本會掉到第三段尾巴。
 * 有選取範圍就取代掉它（和一般輸入框一樣的直覺）。
 */
function insertAtCursor(text: string) {
  const el = inputRef.value?.textarea
  if (!el) {
    inputText.value += text
    return
  }
  const start = el.selectionStart ?? inputText.value.length
  const end = el.selectionEnd ?? start
  inputText.value = inputText.value.slice(0, start) + text + inputText.value.slice(end)
  const caret = start + text.length
  nextTick(() => {
    el.focus()
    el.setSelectionRange(caret, caret)
  })
}

function appendEmoji(emoji: string) {
  insertAtCursor(emoji)
  recentEmojis.value = [
    emoji,
    ...recentEmojis.value.filter(item => item !== emoji),
  ].slice(0, 16)
}

async function sendSticker(packageId: string, sid: string) {
  if (!assertCanOperate()) return
  if (!selectedUserId.value) {
    showToast('請先選擇一位使用者', 'error')
    return
  }
  sending.value = true
  try {
    await apiFetch(`/api/conversations/${selectedUserId.value}/send`, {
      method: 'POST',
      body: { type: 'sticker', packageId, stickerId: sid },
    })
    // 送完就收起來（@hide 會順手清掉選取），別擋住剛送出去的那張
    pickerVisible.sticker = false
    await reloadAfterOutgoing()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '發送失敗', 'error')
  }
  finally {
    sending.value = false
  }
}

function stickerPreviewUrl(stickerSid: string): string {
  return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerSid}/android/sticker.png`
}

/**
 * 「真人／AI／機器人／系統」標籤的 tooltip。
 *
 * 標籤本身只有兩三個字，剩下的話留在 hover：這句是哪裡來的、要改文案的話去哪改，
 * 還有真人是哪位同事／機器人是哪個模組。名字取不到就只出現說明那一行。
 */
function senderTagTitle(msg: MsgItem): string {
  if (!msg.sender) return ''
  const hint = MESSAGE_SENDER_HINTS[msg.sender]
  const name = String(msg.senderName || '').trim()
  return name ? `${hint}\n來源：${name}` : hint
}

function getMessageType(msg: MsgItem): string {
  const payloadType = String(msg?.payload?.type || '').trim()
  if (payloadType) return payloadType
  return String(msg?.messageType || 'text')
}

function getMessageDisplayText(msg: MsgItem): string {
  const type = getMessageType(msg)
  if (type === 'text') {
    const payloadText = String(msg?.payload?.text || '').trim()
    return payloadText || msg.text || ''
  }
  if (type === 'template' || type === 'flex') {
    const altText = String(msg?.payload?.altText || '').trim()
    return altText || msg.text || ''
  }
  return msg.text || ''
}

function splitMessageLines(msg: MsgItem): string[] {
  return getMessageDisplayText(msg).split('\n')
}

function splitMessageLineSegments(line: string): MessageTextSegment[] {
  const text = String(line || '')
  if (!text) return [{ text: '', isLink: false }]
  const urlRegex = /(https?:\/\/[^\s]+)/g
  const segments: MessageTextSegment[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = urlRegex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, m.index), isLink: false })
    }
    segments.push({ text: m[0], isLink: true })
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isLink: false })
  }
  return segments.length ? segments : [{ text, isLink: false }]
}

/**
 * 每則訊息的快速回覆只解析一次。
 *
 * 樣板裡 v-if 與 v-for 各叫一次，而且每次重繪（送完訊息的安靜刷新、清單輪詢、載入旗標
 * 翻動…）都會把整串重算一遍，等於每次重繪產生 2×N 份新陣列與新物件——正好把
 * reuseUnchangedRows 為了不讓泡泡閃而做的「沒變就沿用原物件」抵銷掉。
 *
 * 用 WeakMap 掛在訊息物件上：訊息載進來之後 payload 不會再變，列被丟掉時快取自動回收，
 * 不需要任何失效邏輯。
 */
const quickReplyItemsCache = new WeakMap<object, Array<{ label: string, send: string }>>()

/**
 * 這則訊息在 LINE 裡附的快速回覆按鈕（AI 反問澄清的選項、腳本的選項、機器人流程都會帶）。
 * label 是客人看到的字，send 是點下去實際送出的文字（postback 這類沒有送出文字，留空）。
 * 不設數量上限：LINE 規格本身就只收 13 顆。
 */
function getQuickReplyItems(msg: MsgItem): Array<{ label: string, send: string }> {
  if (!msg || typeof msg !== 'object') return []
  const cached = quickReplyItemsCache.get(msg)
  if (cached) return cached

  const items = msg?.payload?.quickReply?.items
  const parsed = Array.isArray(items)
    ? items
        .map((item: any) => {
          const action = item?.action ?? {}
          return {
            label: String(action.label || action.text || '').trim(),
            send: String(action.text || action.displayText || '').trim(),
          }
        })
        .filter(o => o.label)
    : []
  quickReplyItemsCache.set(msg, parsed)
  return parsed
}

function isStructuredLineMessage(msg: MsgItem): boolean {
  const type = getMessageType(msg)
  return type === 'template' || type === 'flex' || type === 'imagemap'
}

function isMediaMessage(msg: MsgItem): boolean {
  const type = getMessageType(msg)
  return type === 'image' || type === 'sticker' || type === 'video'
}

function toActionLabel(action: any): string {
  return String(
    action?.label
      || action?.text
      || action?.displayText
      || action?.uri
      || action?.data
      || action?.type
      || '動作',
  ).trim().slice(0, 42)
}

function normalizeCard(input?: Partial<StructuredCardPreview>): StructuredCardPreview {
  const actions = Array.isArray(input?.actions) ? input.actions.filter(Boolean) : []
  return {
    title: String(input?.title || '').trim(),
    text: String(input?.text || '').trim(),
    imageUrl: String(input?.imageUrl || '').trim(),
    actions,
    ...(input?.imageAspectRatio ? { imageAspectRatio: input.imageAspectRatio } : {}),
    ...(input?.heroActionLabel ? { heroActionLabel: input.heroActionLabel } : {}),
  }
}

function parseFlexImageCarouselBody(body: any): { title: string; text: string } {
  const contents = body?.contents
  if (!Array.isArray(contents)) return { title: '', text: '' }
  const textNodes = contents.filter((item: any) => item?.type === 'text')
  if (!textNodes.length) return { title: '', text: '' }
  const first = textNodes[0]
  const firstIsTitle = first?.weight === 'bold' || first?.size === 'md'
  if (textNodes.length === 1) {
    if (firstIsTitle) return { title: String(first.text || '').trim(), text: '' }
    return { title: '', text: String(first.text || '').trim() }
  }
  return {
    title: String(textNodes[0]?.text || '').trim(),
    text: textNodes.slice(1).map((item: any) => String(item.text || '').trim()).filter(Boolean).join('\n'),
  }
}

function isFlexImageCarouselBubble(bubble: any): boolean {
  if (bubble?.type !== 'bubble') return false
  // size 可能未儲存，只排除明確非 mega 的值
  if (bubble?.size && bubble.size !== 'mega') return false
  // 不允許有 header
  if (bubble?.header) return false
  // hero 如果存在，必須是圖片
  if (bubble?.hero && bubble.hero.type !== 'image') return false
  // body 如果存在，必須是 vertical box，且 contents 全為 text
  if (bubble?.body) {
    if (bubble.body.type !== 'box' || bubble.body.layout !== 'vertical') return false
    const bodyContents = bubble.body?.contents
    if (!Array.isArray(bodyContents) || !bodyContents.every((item: any) => item?.type === 'text')) {
      return false
    }
  }
  // footer 如果存在，必須是 vertical box，且 contents 全為 button
  if (bubble?.footer) {
    if (bubble.footer.type !== 'box') return false
    const footerContents = bubble.footer?.contents
    if (!Array.isArray(footerContents) || !footerContents.every((item: any) => item?.type === 'button')) {
      return false
    }
  }
  // 至少要有 hero、body、footer 其中一個
  return Boolean(bubble?.hero?.type === 'image' || bubble?.body || bubble?.footer)
}

function extractFlexTexts(node: any, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc
  if (typeof node.text === 'string' && node.text.trim()) acc.push(node.text.trim())
  if (Array.isArray(node.contents)) {
    node.contents.forEach((child: any) => extractFlexTexts(child, acc))
  }
  if (node.header) extractFlexTexts(node.header, acc)
  if (node.body) extractFlexTexts(node.body, acc)
  if (node.footer) extractFlexTexts(node.footer, acc)
  return acc
}

function extractFlexActions(node: any, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc
  if (node.action) acc.push(toActionLabel(node.action))
  if (Array.isArray(node.contents)) {
    node.contents.forEach((child: any) => extractFlexActions(child, acc))
  }
  if (node.header) extractFlexActions(node.header, acc)
  if (node.body) extractFlexActions(node.body, acc)
  if (node.footer) extractFlexActions(node.footer, acc)
  return acc
}

function getStructuredMessagePreview(msg: MsgItem): StructuredMessagePreview | null {
  const payload = msg?.payload || {}
  const type = getMessageType(msg)

  if (type === 'template') {
    const tpl = payload?.template || {}
    const tplType = String(tpl?.type || '').trim()
    if (tplType === 'buttons') {
      const title = String(tpl.title || '').trim()
      const text = String(tpl.text || '').trim()
      return {
        variant: 'buttons',
        cards: [normalizeCard({
          title: title || text,
          text: title ? text : '',
          imageUrl: tpl.thumbnailImageUrl,
          actions: Array.isArray(tpl.actions) ? tpl.actions.map(toActionLabel) : [],
        })],
      }
    }
    if (tplType === 'confirm') {
      const text = String(tpl.text || '').trim()
      return {
        variant: 'confirm',
        cards: [normalizeCard({
          title: text,
          text: '',
          actions: Array.isArray(tpl.actions) ? tpl.actions.map(toActionLabel) : [],
        })],
      }
    }
    if (tplType === 'carousel') {
      return {
        variant: 'carousel',
        cards: (Array.isArray(tpl.columns) ? tpl.columns : []).map((c: any) => normalizeCard({
          title: c.title,
          text: c.text,
          imageUrl: c.thumbnailImageUrl,
          actions: Array.isArray(c.actions) ? c.actions.map(toActionLabel) : [],
        })),
      }
    }
    if (tplType === 'image_carousel') {
      return {
        variant: 'image_carousel',
        cards: (Array.isArray(tpl.columns) ? tpl.columns : []).map((c: any) => normalizeCard({
          imageUrl: c.imageUrl,
          actions: c.action ? [toActionLabel(c.action)] : [],
        })),
      }
    }
    return { variant: 'generic', cards: [normalizeCard({ text: payload.altText || msg.text })] }
  }

  if (type === 'flex') {
    const contents = payload?.contents
    if (contents?.type === 'carousel' && Array.isArray(contents.contents)) {
      // Flex Image Carousel：hero 圖片 + 可選 footer 按鈕
      const isFlexImageCarousel = (contents.contents as any[]).every(isFlexImageCarouselBubble)
      if (isFlexImageCarousel) {
        return {
          variant: 'flex_image_carousel',
          cards: (contents.contents as any[]).map((bubble: any) => {
            const footerActions = extractFlexActions(bubble.footer, [])
            const heroActionLabel = bubble.hero?.action
              ? toActionLabel(bubble.hero.action)
              : ''
            const { title, text } = parseFlexImageCarouselBody(bubble.body)
            return normalizeCard({
              title,
              text,
              imageUrl: String(bubble.hero?.url || '').trim(),
              actions: footerActions,
              heroActionLabel: footerActions.length > 0 ? '' : heroActionLabel,
              imageAspectRatio: String(bubble.hero?.aspectRatio || '16:9').trim(),
            })
          }),
        }
      }
      return {
        variant: 'carousel',
        cards: contents.contents.map((bubble: any) => {
          const texts = extractFlexTexts(bubble, []).slice(0, 3)
          const actions = extractFlexActions(bubble, []).slice(0, 4)
          return normalizeCard({
            title: texts[0],
            text: texts.slice(1).join('\n'),
            actions,
          })
        }),
      }
    }
    const texts = extractFlexTexts(contents, []).slice(0, 4)
    const actions = extractFlexActions(contents, []).slice(0, 4)
    return {
      variant: 'flex',
      cards: [normalizeCard({
        title: texts[0],
        text: texts.slice(1).join('\n') || payload?.altText || msg.text,
        actions,
      })],
    }
  }

  if (type === 'imagemap') {
    return {
      variant: 'imagemap',
      cards: [normalizeCard({
        text: payload?.altText || msg.text || 'Imagemap',
        imageUrl: payload?.baseUrl ? `${payload.baseUrl}/1040` : '',
        actions: Array.isArray(payload?.actions) ? payload.actions.map(toActionLabel) : [],
      })],
    }
  }

  return { variant: 'generic', cards: [normalizeCard({ text: msg.text })] }
}

function getStructuredVariant(msg: MsgItem): StructuredVariant {
  return getStructuredMessagePreview(msg)?.variant || 'generic'
}

function getStructuredCards(msg: MsgItem): StructuredCardPreview[] {
  return getStructuredMessagePreview(msg)?.cards || []
}

function hasStructuredCardImage(msg: MsgItem): boolean {
  return getStructuredCards(msg).some(card => Boolean(card.imageUrl))
}

function getStructuredTemplateClass(msg: MsgItem): Array<string> {
  const variant = getStructuredVariant(msg)
  return [
    `variant-${variant}`,
    ...(hasStructuredCardImage(msg) ? ['has-card-image'] : ['is-text-only']),
  ]
}

function getStructuredCardClass(msg: MsgItem, card: StructuredCardPreview): Record<string, boolean> {
  const variant = getStructuredVariant(msg)
  const hasImage = Boolean(card.imageUrl)
  const hasBody = Boolean(String(card.title || '').trim() || String(card.text || '').trim())
  const hasActions = Array.isArray(card.actions) && card.actions.length > 0
  return {
    'has-card-image': hasImage,
    'has-card-body': hasBody,
    'has-card-actions': hasActions,
    'is-card-text-only': (variant === 'carousel' || variant === 'flex_image_carousel') && !hasImage,
    'is-card-image-only': variant === 'flex_image_carousel' && hasImage && !hasBody && !hasActions,
  }
}

function getCardImageStyle(msg: MsgItem, card: StructuredCardPreview): Record<string, string> {
  if (getStructuredVariant(msg) !== 'flex_image_carousel') return {}
  const ar = card.imageAspectRatio || '16:9'
  const [w, h] = ar.split(':').map(Number)
  if (!w || !h) return {}
  return { aspectRatio: `${w} / ${h}` }
}

function getCardOverlayLabel(card: StructuredCardPreview): string {
  const heroLabel = String(card.heroActionLabel || '').trim()
  if (heroLabel && heroLabel.toLowerCase() !== 'ignore') return heroLabel
  const fromAction = Array.isArray(card.actions) && card.actions.length > 0
    ? String(card.actions[0] || '').trim()
    : ''
  if (fromAction && fromAction.toLowerCase() !== 'ignore') return fromAction
  return String(card.title || '').trim()
}

function shouldUseLineActionStyle(msg: MsgItem): boolean {
  const variant = getStructuredVariant(msg)
  if (variant === 'flex_image_carousel') {
    return getStructuredCards(msg).some(card => card.actions.length > 0)
  }
  return variant === 'buttons' || variant === 'confirm' || variant === 'carousel' || variant === 'image_carousel'
}

function shouldShowFlexImageHeroOverlay(msg: MsgItem, card: StructuredCardPreview): boolean {
  if (getStructuredVariant(msg) !== 'flex_image_carousel') return false
  if (card.actions.length > 0) return false
  return Boolean(String(card.heroActionLabel || '').trim())
}

function shouldUseStructuredCarousel(msg: MsgItem): boolean {
  const variant = getStructuredVariant(msg)
  if (variant !== 'carousel' && variant !== 'image_carousel' && variant !== 'flex_image_carousel') return false
  return getStructuredCards(msg).length > 2
}

function getStructuredCarouselMaxIndex(msg: MsgItem): number {
  const cards = getStructuredCards(msg)
  return Math.max(0, cards.length - 2)
}

function getStructuredCarouselIndex(msg: MsgItem): number {
  const maxIndex = getStructuredCarouselMaxIndex(msg)
  const currentIndex = Number(structuredCarouselPage.value[msg.id] ?? 0)
  if (!Number.isFinite(currentIndex)) return 0
  return Math.max(0, Math.min(maxIndex, currentIndex))
}

function isStructuredCarouselAtStart(msg: MsgItem): boolean {
  return getStructuredCarouselIndex(msg) <= 0
}

function isStructuredCarouselAtEnd(msg: MsgItem): boolean {
  return getStructuredCarouselIndex(msg) >= getStructuredCarouselMaxIndex(msg)
}

function moveStructuredCarousel(msg: MsgItem, delta: number) {
  const maxIndex = getStructuredCarouselMaxIndex(msg)
  if (maxIndex <= 0) return
  const currentIndex = getStructuredCarouselIndex(msg)
  const nextIndex = Math.max(0, Math.min(maxIndex, currentIndex + delta))
  structuredCarouselPage.value[msg.id] = nextIndex
}

/**
 * 客人傳來的圖／影／音／檔，LINE webhook 只給一個 messageId、沒有任何網址
 * （payload 長這樣：{ type: 'image', id: '625…', contentProvider: { type: 'line' } }）。
 * 原始檔得由後端向 LINE 拿、存進 Storage 後簽一組短效網址，前端才顯示得出來——
 * 這裡就是「一則訊息 → 一組可顯示網址」的載入狀態，key 是訊息文件 id。
 */
type RemoteMediaState = 'loading' | 'ready' | 'expired' | 'not_ready' | 'too_large' | 'error'
const remoteMedia = ref<Record<string, { state: RemoteMediaState; url?: string }>>({})

const REMOTE_MEDIA_TYPES = ['image', 'video', 'audio', 'file']

/** payload 內就有網址的情況：客服自己送出的圖／影／音，或 contentProvider 為外部來源 */
function payloadMediaUrl(msg: MsgItem, prefer: 'preview' | 'original'): string {
  const p = msg?.payload || {}
  const provider = p?.contentProvider || {}
  const candidates = prefer === 'preview'
    ? [p.previewImageUrl, p.originalContentUrl, provider.previewImageUrl, provider.originalContentUrl]
    : [p.originalContentUrl, provider.originalContentUrl]
  for (const c of candidates) {
    const url = String(c || '').trim()
    if (url) return url
  }
  return ''
}

function needsRemoteMedia(msg: MsgItem): boolean {
  if (!REMOTE_MEDIA_TYPES.includes(getMessageType(msg))) return false
  if (payloadMediaUrl(msg, 'preview')) return false
  return Boolean(String(msg?.payload?.id || '').trim())
}

/** 一次只補幾個：一則對話可能有十幾張圖，全部同時打會讓每個請求都變慢 */
const MEDIA_CONCURRENCY = 4
const mediaQueue: MsgItem[] = []
let mediaInFlight = 0

async function loadRemoteMedia(msg: MsgItem): Promise<void> {
  const key = msg.id
  const userId = selectedUser.value?.userId || selectedUserId.value
  if (!userId) {
    // 還不知道要問誰，把佔位清掉讓下次進畫面時能重試
    delete remoteMedia.value[key]
    return
  }
  try {
    const res = await apiFetch<{ state: RemoteMediaState; url?: string }>(
      `/api/conversations/${userId}/media/${key}`,
    )
    remoteMedia.value[key] = {
      state: res?.url ? 'ready' : (res?.state || 'error'),
      url: res?.url,
    }
  }
  catch {
    remoteMedia.value[key] = { state: 'error' }
  }
}

function pumpMediaQueue(): void {
  while (mediaInFlight < MEDIA_CONCURRENCY && mediaQueue.length) {
    const next = mediaQueue.shift()!
    mediaInFlight += 1
    void loadRemoteMedia(next).finally(() => {
      mediaInFlight -= 1
      pumpMediaQueue()
    })
  }
}

function enqueueRemoteMedia(msg: MsgItem): void {
  // loading / ready / 失敗都不重排：失敗多半是 LINE 已刪檔，重打只是浪費
  if (remoteMedia.value[msg.id]) return
  remoteMedia.value[msg.id] = { state: 'loading' }
  mediaQueue.push(msg)
  pumpMediaQueue()
}

// 訊息一進畫面就去補檔案網址（客服不該還要多按一下才看得到照片）。
// 由新到舊排：聊天室是停在最下面的，先補看得到的那幾則。
watch(chatRows, (rows) => {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!
    if (row.kind !== 'msg') continue
    if (needsRemoteMedia(row.msg)) enqueueRemoteMedia(row.msg)
  }
}, { immediate: true })

function remoteMediaUrl(msg: MsgItem): string {
  return String(remoteMedia.value[msg.id]?.url || '').trim()
}

/** 沒有網址可顯示時，說清楚是哪一種「沒有」——空白泡泡會讓人以為後台壞了 */
function mediaFallbackText(msg: MsgItem): string {
  const type = getMessageType(msg)
  const noun = type === 'video' ? '影片' : type === 'audio' ? '語音' : type === 'file' ? '檔案' : '圖片'
  const state = remoteMedia.value[msg.id]?.state
  if (state === 'loading') return `${noun}載入中…`
  if (state === 'expired') return `這個${noun}已經無法取得（LINE 只保留客人傳來的檔案一小段時間）`
  if (state === 'not_ready') return `${noun}還在 LINE 處理中，稍後重新整理再看`
  if (state === 'too_large') return `${noun}太大，後台不預覽（請到 LINE 官方帳號 App 查看）`
  if (state === 'error') return `${noun}載入失敗，重新整理再試一次`
  // 沒有狀態＝這則訊息連檔案編號都沒留下（極少見），重試也不會有結果，別叫人白試
  return `這則訊息沒有可以顯示的${noun}`
}

function getMessageImageUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'image') return ''
  return payloadMediaUrl(msg, 'preview') || remoteMediaUrl(msg)
}

function getLineRichImageUrl(msg: MsgItem): string {
  const type = getMessageType(msg)
  const payload = msg?.payload || {}
  if (type === 'imagemap') {
    return String(payload?.baseUrl ? `${payload.baseUrl}/1040` : '').trim()
  }
  if (type !== 'flex') return ''

  const rootContents = payload?.contents
  const bubble = rootContents?.type === 'carousel' && Array.isArray(rootContents?.contents)
    ? rootContents.contents[0]
    : rootContents
  const bodyContents = Array.isArray(bubble?.body?.contents) ? bubble.body.contents : []
  const imageNode = bodyContents.find((item: any) => item?.type === 'image' && item?.url)
  const overlayOnly =
    bodyContents.length > 1
    && bodyContents
      .filter((item: any) => item?.type !== 'image')
      .every((item: any) => item?.position === 'absolute' && item?.action)
  if (!imageNode?.url || !overlayOnly) return ''
  return String(imageNode.url).trim()
}

function getLineRichImageFrameStyle(msg: MsgItem): Record<string, string> {
  const type = getMessageType(msg)
  const payload = msg?.payload || {}
  if (type === 'imagemap') {
    const w = Number(payload?.baseSize?.width || 0)
    const h = Number(payload?.baseSize?.height || 0)
    if (w > 0 && h > 0) return { aspectRatio: `${w} / ${h}` }
  }
  if (type === 'flex') {
    const rootContents = payload?.contents
    const bubble = rootContents?.type === 'carousel' && Array.isArray(rootContents?.contents)
      ? rootContents.contents[0]
      : rootContents
    const bodyContents = Array.isArray(bubble?.body?.contents) ? bubble.body.contents : []
    const imageNode = bodyContents.find((item: any) => item?.type === 'image')
    const css = lineAspectRatioToCss(imageNode?.aspectRatio)
    if (css) return { aspectRatio: css }
  }
  return {}
}

function getVideoPreviewImageUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'video') return ''
  return String(msg?.payload?.previewImageUrl || '').trim()
}

function getVideoUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'video') return ''
  return payloadMediaUrl(msg, 'original') || remoteMediaUrl(msg)
}

function getStickerImageUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'sticker') return ''
  const sid = String(msg?.payload?.stickerId || '').trim()
  if (!sid) return ''
  return stickerPreviewUrl(sid)
}

function getAudioUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'audio') return ''
  return payloadMediaUrl(msg, 'original') || remoteMediaUrl(msg)
}

function getAudioDurationLabel(msg: MsgItem): string {
  if (getMessageType(msg) !== 'audio') return ''
  const durationMs = Number(msg?.payload?.duration || 0)
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '音訊'
  return `${Math.max(1, Math.round(durationMs / 1000))} 秒`
}

function getFileUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'file') return ''
  return payloadMediaUrl(msg, 'original') || remoteMediaUrl(msg)
}

function getFileName(msg: MsgItem): string {
  if (getMessageType(msg) !== 'file') return ''
  const fileName = String(msg?.payload?.fileName || '').trim()
  return fileName || '檔案'
}

function splitEmojiUnits(text: string): string[] {
  const source = String(text || '').trim()
  if (!source) return []
  const segmenter = typeof Intl !== 'undefined' && (Intl as any).Segmenter
    ? new (Intl as any).Segmenter('en', { granularity: 'grapheme' })
    : null
  const units = segmenter
    ? Array.from(segmenter.segment(source), (s: any) => s.segment as string)
    : Array.from(source)
  return units.filter(u => /\p{Extended_Pictographic}/u.test(u))
}

function isEmojiOnlyMessage(msg: MsgItem): boolean {
  const text = getMessageDisplayText(msg).trim()
  if (!text) return false
  const withoutSpaces = text.replace(/\s+/g, '')
  if (!withoutSpaces) return false
  const emojis = splitEmojiUnits(withoutSpaces)
  if (!emojis.length || emojis.length > 8) return false
  return emojis.join('') === withoutSpaces
}

function getEmojiImageUrl(emoji: string): string {
  const codePoints = Array.from(emoji)
    .map(ch => ch.codePointAt(0)?.toString(16))
    .filter((cp): cp is string => Boolean(cp) && cp !== 'fe0f')
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codePoints.join('-')}.png`
}

function getPayloadSummary(msg: MsgItem): string {
  const payload = msg?.payload
  if (!payload || typeof payload !== 'object') return ''
  if (payload.type === 'template' && payload.template?.type) {
    return `template: ${String(payload.template.type)}`
  }
  if (payload.type === 'flex' && payload.contents?.type) {
    return `flex: ${String(payload.contents.type)}`
  }
  if (payload.type === 'imagemap') {
    const actions = Array.isArray(payload.actions) ? payload.actions.length : 0
    return actions > 0 ? `imagemap actions: ${actions}` : 'imagemap'
  }
  if (payload.type === 'sticker') {
    return ''
  }
  return ''
}

onMounted(() => {
  if (typeof document !== 'undefined')
    savedDocumentTitle.value = document.title
  hydrateConvLastRead()
  // 上次沒送出的草稿先撈回來，selectUser 選到那位客人時就會自己填回輸入框
  loadPersistedDrafts()
  // 從統計頁下鑽帶進來的分頁（?tab=open/bot_handling/pending_human/closed…）
  const qTab = String(route.query.tab || '')
  if (qTab && STATUS_TABS.some(t => t.value === qTab))
    activeTab.value = qTab as TabValue
  // 從監控頁「開對話」帶進來的客人（?userId=）：載入清單後直接選中，不讓人再找一次
  const qUserId = String(route.query.userId || '')
  /**
   * 指定要落在哪一場（?sessionId=）。給好友頁「AI 建議 → 看這段對話」用：
   * 要判斷該不該採用那個標籤，得看到**產生它的那一場**——客人來過很多次時，
   * 最新那場多半不是同一場，落錯場等於看了也判斷不了。
   */
  const qSessionId = String(route.query.sessionId || '')
  void loadList('reset').then(() => {
    if (qUserId && activeTab.value === 'all')
      void selectUserById(qUserId, qSessionId ? { sessionId: qSessionId } : undefined)
  })
  loadSupportPresets()
  listPollTimer = setInterval(() => {
    // 分頁在背景（切走／視窗最小化）不刷新——回前景時 onVisibilityChange 會補刷一次。
    // 沒有這條的話，掛在背景的分頁每 30 秒照打後端（2026-08-11 資料庫讀取暴衝的幫兇）
    if (typeof document !== 'undefined' && document.hidden) return
    // 搜尋字留在框裡時不重抓清單：背景刷新會把搜尋字一起重送，等於每 30 秒重掃一次
    // 全 workspace 的對話。但**分頁上的數字照更新**（那支只讀計數、很便宜），
    // 而且清單上會明講「搜尋結果不會自己更新」——先前是整支輪詢直接 return，
    // 客服搜完名字沒清掉字（很常見）就再也收不到新訊息與紅點，畫面上一點徵兆都沒有。
    if (listAutoRefreshPaused.value) {
      void loadSessionCounts()
      return
    }
    if (!listLoading.value && !listLoadingMore.value)
      void refreshListQuiet()
  }, 30_000)
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('storage', onConvReadStorage)
  }
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', onVisibilityChange)
  applyUnreadDocumentTitle()
})

onUnmounted(() => {
  if (listPollTimer) {
    clearInterval(listPollTimer)
    listPollTimer = null
  }
  stopPinBottom()
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onWindowFocus)
    window.removeEventListener('blur', onWindowBlur)
  }
  if (typeof window !== 'undefined')
    window.removeEventListener('storage', onConvReadStorage)
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (savedDocumentTitle.value)
      document.title = savedDocumentTitle.value
  }
})
</script>
