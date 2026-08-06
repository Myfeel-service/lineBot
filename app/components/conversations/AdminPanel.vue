<template>
  <AdminSplitLayout class="conversations-page" :is-empty="!selectedUserId">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title conv-sidebar-title-row" data-tour="conv-list">💬 對話</span>
      <el-button size="small" :loading="listLoading" @click="loadList(true)">重整</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <!-- Status Tabs：這一排全部是「系統判定的會話狀態」，人工標記不放這裡（會被當成同一種東西） -->
      <div class="conv-status-tabs" data-tour="conv-tabs">
        <button
          v-for="tab in STATUS_TABS"
          :key="tab.value"
          type="button"
          class="conv-status-tab"
          :class="{ active: activeTab === tab.value }"
          :title="tab.hint"
          @click="switchTab(tab.value)"
        >
          {{
            tab.value === 'all'
              ? tab.label
              : tab.value === 'closed'
                ? tab.label
                : `${tab.label}（${sessionStatusCounts[tab.value]}）`
          }}
        </button>
      </div>
      <div class="conv-search-bar">
        <el-input v-model="searchText" placeholder="搜尋名稱…" clearable size="small" />
        <!-- 右鍵標記完要找得回來：沒有這個出口，標記就是個看不到的動作。
             和上面那排刻意分行分色 ——「待跟進」是人標的，不是系統狀態 -->
        <button
          v-if="activeTab === 'all'"
          type="button"
          class="conv-flag-filter"
          :class="{ active: followUpFilterOn }"
          :aria-pressed="followUpFilterOn"
          title="待跟進＝你和同事手動標記、要回頭處理的對話（和上面系統判定的「待處理」不是同一件事）"
          @click="toggleFollowUpFilter"
        >
          <span class="conv-flag-filter__icon" aria-hidden="true">🚩</span>
          只看待跟進{{ followUpCount > 0 ? `（${followUpCount}）` : '' }}
        </button>
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
        <!-- Session-based view (status tabs) -->
        <template v-if="activeTab !== 'all'">
          <div
            v-for="s in sessionSidebarItems"
            :key="s.sessionId"
            class="conv-list-row"
          >
            <AdminSplitListItem
              :title="s.displayName"
              :leading-avatar-url="s.pictureUrl"
              show-leading-avatar-fallback
              time-in-title-row
              :active="selectedSessionId === s.sessionId"
              :title-icon="s.pinned ? '📌' : ''"
              :meta-tag="s.followUp ? '待跟進' : ''"
              :meta-text="SESSION_STATUS_LABELS[s.status] || s.status"
              :meta-truncate="true"
              :chip-text="formatTime(s.lastActivityAt)"
              :chip-tone="sessionChipTone(s.status)"
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
              :show-unread-dot="isConvItemUnread(c)"
              :active="selectedUserId === c.userId && !selectedSessionId"
              :title-icon="c.pinned ? '📌' : ''"
              :meta-tag="c.followUp ? '待跟進' : ''"
              :meta-text="(c.lastDirection === 'outgoing' ? '↑ ' : '') + c.lastMessage"
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
      <div class="conv-editor-header-block">
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
        <div v-if="sessionToolbarMeta" class="conv-session-toolbar">
          <span class="conv-session-toolbar__hint">{{ selectedSessionId ? '此場會話' : '進行中會話' }}</span>
          <el-tag size="small" type="info">{{ sessionToolbarMeta.statusLabel }}</el-tag>
          <el-button
            v-if="canTakeOverSession"
            size="small"
            type="primary"
            plain
            :loading="takingOverSession"
            title="接手後，機器人與 AI 不會再自動回覆這位客人，直到你按「交還機器人」或會話結束"
            @click="takeOverSelectedSession"
          >
            我接手（暫停自動回覆）
          </el-button>
          <el-button
            v-if="canOperate && (sessionToolbarMeta.status === 'pending_human' || sessionToolbarMeta.status === 'human_handling')"
            size="small"
            type="primary"
            plain
            :loading="handingBackSession"
            title="交還後，機器人與 AI 會恢復自動回覆這位客人"
            @click="handBackSelectedSession"
          >
            交還機器人
          </el-button>
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
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <ConversationsAiContextBanner
        v-if="canOperate"
        :user-id="selectedUserId"
        :refresh-key="aiContextRefreshKey"
        :api-fetch="apiFetch"
        @apply-draft="applyAiDraft"
        @add-knowledge="goAddKnowledge"
      />
      <!-- 圖片可以直接拖進對話區（貼上則綁在輸入框），不必繞 ＋ →「圖片」→ 選檔案 -->
      <div
        ref="messagesEl"
        class="conv-messages"
        :class="{ 'is-drop-target': canOperate && isDraggingImage }"
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
        <template v-for="row in chatRows" :key="row.key">
          <div v-if="row.kind === 'event'" class="conv-timeline-event">
            <span class="conv-timeline-event__dot" aria-hidden="true" />
            <span class="conv-timeline-event__label">{{ row.label }}</span>
            <span class="conv-timeline-event__time">{{ formatTime(row.timestamp) }}</span>
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
                        <span class="conv-bubble-time">{{ formatTime(msg.timestamp) }}</span>
                      </span>
                      <span
                        v-if="msg.direction === 'outgoing' && msg.readByPeer"
                        class="conv-bubble-read"
                        title="客人後來有回訊息或點按鈕，代表他應該已看過這則之前的訊息；這是系統推估的，跟 LINE App 裡的「已讀」不一定完全一樣。"
                      >已讀</span>
                    </template>
                  </div>
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
        <div class="conv-picker-actions">
          <el-dropdown trigger="click" placement="top-start" @command="onQuickSendCommand">
            <button
              type="button"
              class="conv-picker-trigger"
              :disabled="sending || msgLoading || !selectedUserId"
              title="傳送媒體"
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
                :title="picker.title"
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
            @show="onQuickReplyPickerShow"
            @hide="pendingQuickReplyId = ''"
          >
            <template #reference>
              <button
                type="button"
                class="conv-picker-trigger"
                :disabled="sending || msgLoading"
                title="客服預存 / 自動回覆"
              >
                <span class="conv-picker-trigger__emoji">📦</span>
              </button>
            </template>
            <div class="conv-picker-panel">
              <div class="conv-picker-title">挑一則回覆</div>
              <div class="conv-picker-tabs">
                <button
                  v-for="tab in quickReplyTabs"
                  :key="tab.key"
                  type="button"
                  class="conv-picker-tab"
                  :class="{ active: quickReplyTab === tab.key }"
                  @click="setQuickReplyTab(tab.key)"
                >
                  <span>{{ tab.label }}</span>
                </button>
              </div>
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
                  <template v-else-if="quickReplyTab === 'preset'">
                    還沒有啟用的客服預存。建立常用回覆後，就能在這裡直接取用。
                    <a class="conv-picker-empty__link" @click="openQuickReplySource('preset')">去建立客服預存</a>
                  </template>
                  <template v-else>
                    還沒有啟用的自動回覆規則。
                    <a class="conv-picker-empty__link" @click="openQuickReplySource('rule')">去看自動回覆</a>
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
        <span class="text-muted conv-input-hint">點上面的按鈕，可以挑圖片、貼圖、表情，或挑一則客服預存／自動回覆（文字可先填進回覆框改）</span>
      </div>

      <div v-if="canOperate" class="conv-input-row">
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
import { STATUS_LABELS, type ConversationStatus } from '~~/shared/types/conversation-stats'
import { FOLLOW_UP_LIST_LIMIT } from '~~/shared/conversation-flags'
import { MESSAGE_SENDER_LABELS, MESSAGE_SENDER_HINTS, type MessageSender } from '~~/shared/message-sender'
import type { AutoReplyActionType } from '~~/shared/auto-reply-rule'
import type { AdminContextMenuItem } from '~/components/admin/ContextMenu.vue'

/** 與 `useWorkspace().apiFetch` 相同簽章，由路由頁注入（含 workspaceId）。 */
const props = defineProps<{
  apiFetch: <T>(url: string, options?: Parameters<typeof $fetch>[1]) => Promise<T>
}>()

const { apiFetch } = props
const { assertCanOperate } = useAdminOperateGuard()

const route = useRoute()
const workspaceId = computed(() => String(route.params.workspaceId || ''))

/** 各使用者上次在後台「開啟對話」的時間（ms），存 localStorage，僅影響「全部」列表未讀提示 */
const convLastReadMs = ref<Record<string, number>>({})
const pageHasFocus = ref(true)
const savedDocumentTitle = ref('')
let listPollTimer: ReturnType<typeof setInterval> | null = null

function convReadStorageKey(): string {
  const wid = workspaceId.value
  return wid ? `admin-conv-lastRead:${wid}` : ''
}

function hydrateConvLastRead() {
  if (typeof localStorage === 'undefined')
    return
  const key = convReadStorageKey()
  if (!key) {
    convLastReadMs.value = {}
    return
  }
  try {
    const raw = localStorage.getItem(key)
    convLastReadMs.value = raw ? JSON.parse(raw) as Record<string, number> : {}
  }
  catch {
    convLastReadMs.value = {}
  }
}

function persistConvLastRead() {
  if (typeof localStorage === 'undefined')
    return
  const key = convReadStorageKey()
  if (!key)
    return
  try {
    localStorage.setItem(key, JSON.stringify(convLastReadMs.value))
  }
  catch {
    /* quota or private mode */
  }
}

function markConversationRead(userId: string) {
  if (!userId)
    return
  convLastReadMs.value = { ...convLastReadMs.value, [userId]: Date.now() }
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

/** 最後一則訊息（含使用者進線、真人、機器人／系統回覆）晚於上次在後台開啟此對話即視為未讀 */
function isConvItemUnread(c: ConvItem): boolean {
  const lastMs = messageTimestampToMs(c.lastMessageAt)
  if (lastMs <= 0)
    return false
  const readMs = convLastReadMs.value[c.userId] ?? 0
  return lastMs > readMs
}

function applyUnreadDocumentTitle() {
  if (typeof document === 'undefined' || !savedDocumentTitle.value)
    return
  const n = conversations.value.filter(c => isConvItemUnread(c)).length
  const backgrounded = document.visibilityState === 'hidden' || !pageHasFocus.value
  if (n > 0 && backgrounded)
    document.title = `（${n}）${savedDocumentTitle.value}`
  else
    document.title = savedDocumentTitle.value
}

function onWindowFocus() {
  pageHasFocus.value = true
  applyUnreadDocumentTitle()
}

function onWindowBlur() {
  pageHasFocus.value = false
  applyUnreadDocumentTitle()
}

function onVisibilityChange() {
  applyUnreadDocumentTitle()
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
  lastActivityAt: any
  /** 對話層級的人工標記（見 ConvItem），會話列表只顯示、不改變排序 */
  pinned?: boolean
  followUp?: boolean
}

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
  /** 客人已封鎖官方帳號：推播會被 LINE 退件，回覆區要先擋一句話 */
  isBlocked?: boolean
  /**
   * 右鍵下的兩個人工標記（全 workspace 共用）。與會話狀態、統計完全無關——
   * 為什麼是「待跟進」不是「待處理」見 ~~/shared/conversation-flags.ts。
   */
  pinned?: boolean
  followUp?: boolean
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

interface SessionTimelineItem {
  id: string
  /** broadcast = 群發標記，後端讀取時才拼進來（不是真的訊息文件），與 event 同樣渲染 */
  type: 'event' | 'message' | 'broadcast'
  timestamp: any
  label?: string
  direction?: 'incoming' | 'outgoing'
  readByPeer?: boolean
  text?: string
  messageType?: string
  payload?: unknown
  mediaDescription?: string
  sender?: MessageSender | null
  senderName?: string
  broadcastId?: string
}

interface SessionPanelMeta {
  sessionId: string
  status: ConvSessionStatus
  statusLabel: string
}

type ChatRowEvent = { kind: 'event'; key: string; label: string; timestamp: any }
type ChatRowMsg = { kind: 'msg'; key: string; msg: MsgItem }
type ChatRow = ChatRowEvent | ChatRowMsg

type PickerKind = 'emoji' | 'sticker'
type QuickSendType = 'image' | 'video' | 'audio'
/** 「挑一則送出」的來源：客服預存 / 自動回覆規則 */
type QuickReplySource = 'preset' | 'rule'
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
const listHasMore = ref(false)
const listPage = ref(1)
const sidebarListEl = ref<HTMLElement | null>(null)
const msgLoading = ref(false)
const sending = ref(false)
const conversations = ref<ConvItem[]>([])
const sessions = ref<SessionItem[]>([])
const messages = ref<MsgItem[]>([])
/** 依 session 的 timeline API（含事件列 + 該場訊息） */
const sessionTimelineItems = ref<SessionTimelineItem[]>([])
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
const activeTab = ref<TabValue>('all')
const inputText = ref('')
const searchText = ref('')
/** 「只看待跟進」：只在「全部」分頁有意義（其他分頁看的是會話狀態，不是人工標記） */
const followUpFilterOn = ref(false)
/** 待跟進數超過顯示上限時要在列表上明講，不要讓人以為看到的就是全部 */
const followUpListTruncated = ref(false)
const followUpCount = ref(0)
const contextMenuVisible = ref(false)
const contextMenuPos = ref({ x: 0, y: 0 })
const contextMenuTarget = ref<ConvItem | SessionItem | null>(null)
const aiContextRefreshKey = ref(0)
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

const messagesEl = ref<HTMLElement | null>(null)
const supportPresetsRaw = ref<any[]>([])
/** 自動回覆規則清單：規則可能很多，等 picker 第一次打開才載入 */
const autoReplyRulesRaw = ref<any[]>([])
const autoReplyRulesLoaded = ref(false)
const autoReplyRulesLoading = ref(false)
const quickReplyTab = ref<QuickReplySource>('preset')
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
 * 「挑一則送出」的兩個來源：客服預存（專門為客服建的）與自動回覆規則（借用那條規則的內容）。
 * 兩者的 action 是同一個 shape，後端也走同一條發送路徑，所以放在同一顆按鈕的兩個分頁裡，
 * 不再多一顆意義相近的按鈕。
 */
const quickReplyTabs: ReadonlyArray<{ key: QuickReplySource, label: string }> = [
  { key: 'preset', label: '客服預存' },
  { key: 'rule', label: '自動回覆' },
]
/** 超過這個數量才顯示搜尋框：只有 3 則時多一個輸入框是噪音 */
const QUICK_REPLY_SEARCH_THRESHOLD = 8

const activeAutoReplyRules = computed(() =>
  autoReplyRulesRaw.value.filter((r: any) => r.isActive !== false),
)
const quickReplyLoading = computed(() =>
  quickReplyTab.value === 'rule' && autoReplyRulesLoading.value,
)
const quickReplySourceItems = computed<QuickReplyItem[]>(() => {
  if (quickReplyTab.value === 'rule') {
    return activeAutoReplyRules.value.map((r: any) => ({
      id: String(r.id),
      name: String(r.name || ''),
      // 關鍵字一起顯示：規則名稱常常很像，光看名字認不出是哪一條
      meta: [r.keyword ? `關鍵字：${r.keyword}` : '', getActionSummary(r)].filter(Boolean).join('｜'),
      actionType: getActionType(r),
      taggingEnabled: r?.tagging?.enabled === true,
    }))
  }
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
  triggerIcon: string
  categories: PickerCategory[]
}> = [
  {
    key: 'emoji',
    title: 'Emoji',
    triggerIcon: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f600.png',
    categories: emojiCategories,
  },
  {
    key: 'sticker',
    title: 'LINE 貼圖',
    triggerIcon: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f9e9.png',
    categories: stickerCategories,
  },
]

const sessionSidebarItems = computed<SessionItem[]>(() => {
  const kw = searchText.value.toLowerCase().trim()
  if (!kw || activeTab.value === 'all') return sessions.value
  return sessions.value.filter(s => s.displayName.toLowerCase().includes(kw))
})

/**
 * 釘選置頂。
 *
 * 後端第一頁已經排好，這裡再排一次是為了「按下右鍵到下次載入之間」畫面就先動——
 * 不然按了釘選什麼都沒發生，會以為沒生效。filter 保序，所以兩邊順序一致。
 */
const convSidebarItems = computed<ConvItem[]>(() => {
  const rows = conversations.value
  if (!rows.some(c => c.pinned)) return rows
  return [...rows.filter(c => c.pinned), ...rows.filter(c => !c.pinned)]
})

/** 釘選區的最後一筆：底下畫一條線，讀者才知道「時間序從這裡開始」 */
const lastPinnedIndex = computed(() => {
  const rows = convSidebarItems.value
  let last = -1
  for (let i = 0; i < rows.length; i++) if (rows[i]?.pinned) last = i
  // 整份清單都是釘選時不用畫線（下面沒有東西了）
  return last >= 0 && last < rows.length - 1 ? last : -1
})

const sidebarEmpty = computed<{ title: string, hint: string }>(() => {
  if (followUpFilterOn.value) {
    return searchText.value
      ? { title: '待跟進裡沒有符合的對話', hint: '' }
      // 空清單不能只說「沒有」就結束：順便講怎麼標，不然這個篩選看起來像壞掉
      : { title: '目前沒有待跟進的對話', hint: '在左側對話上按右鍵（或滑過按 ⋯）→「標記待跟進」，之後就能從這裡找回來' }
  }
  return { title: searchText.value ? '無符合結果' : '尚無對話紀錄', hint: '' }
})

const unreadConvCount = computed(() =>
  conversations.value.filter(c => isConvItemUnread(c)).length,
)

watch(unreadConvCount, () => {
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

const serverChatRows = computed<ChatRow[]>(() => {
  if (selectedSessionId.value) {
    return sessionTimelineItems.value.map((item) => {
      // broadcast 是後端讀取時才拼進來的群發標記（不是真的訊息文件），與事件同樣渲染成一行泡泡
      if (item.type === 'event' || item.type === 'broadcast') {
        return {
          kind: 'event' as const,
          key: `e-${item.id}`,
          label: item.label || '',
          timestamp: item.timestamp,
        }
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
      }
      return { kind: 'msg' as const, key: item.id, msg }
    })
  }
  return messages.value.map(msg => ({ kind: 'msg' as const, key: msg.id, msg }))
})

const chatRows = computed<ChatRow[]>(() => [...serverChatRows.value, ...pendingRows.value])

function sessionChipTone(status: ConvSessionStatus): 'neutral' | 'warning' | 'success' | 'error' {
  if (status === 'pending_human') return 'warning'
  if (status === 'human_handling') return 'success'
  if (status === 'closed') return 'neutral'
  return 'neutral'
}

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
  if (!isPin) followUpCount.value = Math.max(0, followUpCount.value + (next ? 1 : -1))

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
      if (!next && followUpFilterOn.value) await loadList(true)
    }
  }
  catch (e: any) {
    applyLocalFlags(userId, isPin ? { pinned: !next } : { followUp: !next })
    if (!isPin) followUpCount.value = Math.max(0, followUpCount.value + (next ? -1 : 1))
    showToast(e?.data?.statusMessage || '標記失敗，請稍後再試', 'error')
  }
}

async function toggleFollowUpFilter() {
  followUpFilterOn.value = !followUpFilterOn.value
  await loadList(true)
}

async function switchTab(tab: TabValue) {
  activeTab.value = tab
  // 「只看待跟進」是「全部」分頁專用的視角，切走就關掉，免得切回來還套著看不見的篩選
  if (tab !== 'all') followUpFilterOn.value = false
  selectedSessionId.value = null
  allTabActiveSession.value = null
  sessionTimelineItems.value = []
  sessionMeta.value = null
  await loadList(true)
  if (tab === 'all' && selectedUserId.value && selectedUser.value) {
    await selectUser(selectedUser.value)
  }
}

async function selectSession(s: SessionItem) {
  selectedSessionId.value = s.sessionId
  allTabActiveSession.value = null
  aiContextSeenAtMs = 0
  selectedUserId.value = s.userId
  messages.value = []
  const convItem: ConvItem = {
    userId: s.userId,
    displayName: s.displayName,
    pictureUrl: s.pictureUrl,
    lastMessage: SESSION_STATUS_LABELS[s.status] ?? '',
    lastDirection: 'incoming',
    lastMessageAt: s.lastActivityAt,
    pinned: s.pinned === true,
    followUp: s.followUp === true,
  }
  selectedUser.value = convItem
  sessionMeta.value = {
    sessionId: s.sessionId,
    status: s.status,
    statusLabel: SESSION_STATUS_LABELS[s.status] ?? String(s.status),
  }
  msgLoading.value = true
  try {
    const res = await apiFetch<{
      sessionId: string
      status: ConvSessionStatus
      statusLabel: string
      items: SessionTimelineItem[]
    }>(`/api/conversations/sessions/${s.sessionId}/timeline`)
    sessionMeta.value = {
      sessionId: res.sessionId,
      status: res.status,
      statusLabel: res.statusLabel,
    }
    sessionTimelineItems.value = res.items ?? []
    await nextTick()
    scrollToBottom()
    markConversationRead(s.userId)
  }
  catch {
    sessionTimelineItems.value = []
    showToast('載入會話時間軸失敗', 'error')
  }
  finally {
    msgLoading.value = false
  }
}

const canSend = computed(() => !!inputText.value.trim())

async function loadList(reset = true) {
  if (reset) {
    if (listLoading.value) return
    listLoading.value = true
    listPage.value = 1
    listHasMore.value = false
    conversations.value = []
    sessions.value = []
  }
  else {
    if (listLoadingMore.value || listLoading.value || !listHasMore.value) return
    listLoadingMore.value = true
  }

  const page = listPage.value

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
        },
      })
      const chunk = res.conversations ?? []
      conversations.value = reset ? chunk : [...conversations.value, ...chunk]
      listHasMore.value = Boolean(res.hasMore)
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
        },
      })
      const chunk = res.sessions ?? []
      sessions.value = reset ? chunk : [...sessions.value, ...chunk]
      listHasMore.value = Boolean(res.hasMore)
    }
  }
  catch {
    if (reset) {
      conversations.value = []
      sessions.value = []
    }
    showToast('載入對話列表失敗', 'error')
  }
  finally {
    listLoading.value = false
    listLoadingMore.value = false
  }
  await loadSessionCounts()
  maybeRefreshAiContext()
  if (reset) void autoFillSidebarList()
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
  await loadList(false)
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

async function refreshListQuiet() {
  if (sidebarListEl.value && sidebarListEl.value.scrollTop > 80) {
    await loadSessionCounts()
    return
  }
  await loadList(true)
}

let searchListTimer: ReturnType<typeof setTimeout> | null = null
watch(searchText, () => {
  if (searchListTimer) clearTimeout(searchListTimer)
  searchListTimer = setTimeout(() => void loadList(true), 300)
})

async function loadSessionCounts() {
  try {
    const res = await apiFetch<{ counts: Record<ConvSessionStatus, number>, followUp?: number }>(
      '/api/conversations/sessions-counts',
    )
    for (const k of Object.keys(sessionStatusCounts.value) as ConvSessionStatus[]) {
      sessionStatusCounts.value[k] = Number(res.counts?.[k] ?? 0)
    }
    followUpCount.value = Number(res.followUp ?? 0)
  }
  catch {
    // 分頁仍可用；數字維持上次成功值
  }
}

async function loadSupportPresets() {
  supportPresetsRaw.value = await apiFetch<any[]>('/api/support-preset/list').catch(() => [])
}

/** 自動回覆規則可能上百條，不在進頁時載入；picker 打開才抓一次 */
async function loadAutoReplyRules() {
  if (autoReplyRulesLoaded.value || autoReplyRulesLoading.value) return
  autoReplyRulesLoading.value = true
  try {
    autoReplyRulesRaw.value = await apiFetch<any[]>('/api/auto-reply/list').catch(() => [])
    autoReplyRulesLoaded.value = true
  }
  finally {
    autoReplyRulesLoading.value = false
  }
}

function onQuickReplyPickerShow() {
  if (quickReplyTab.value === 'rule') loadAutoReplyRules()
}

function setQuickReplyTab(tab: QuickReplySource) {
  if (quickReplyTab.value === tab) return
  quickReplyTab.value = tab
  // 換分頁就清掉選取與搜尋：留著會變成「畫面上沒有選中的項目，送出鍵卻是亮的」
  pendingQuickReplyId.value = ''
  quickReplySearch.value = ''
  if (tab === 'rule') loadAutoReplyRules()
}

function openQuickReplySource(tab: QuickReplySource) {
  const page = tab === 'rule' ? 'auto-reply' : 'support-presets'
  window.open(`/admin/${workspaceId.value}/${page}`, '_blank')
}

async function sendQuickReply() {
  if (!assertCanOperate()) return
  const id = pendingQuickReplyId.value
  if (!id || !selectedUserId.value || !selectedUser.value) return
  const isRule = quickReplyTab.value === 'rule'
  sending.value = true
  try {
    await apiFetch(
      `/api/conversations/${selectedUserId.value}/${isRule ? 'send-auto-reply' : 'send-preset'}`,
      {
        method: 'POST',
        body: isRule ? { ruleId: id } : { presetId: id },
      },
    )
    showToast(isRule ? '已送出自動回覆的內容' : '已送出客服預存', 'success')
    // 送完就收起來：這顆按鈕的事已經做完，留著擋住剛送出的訊息
    quickReplyPickerVisible.value = false
    await reloadAfterOutgoing()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || (isRule ? '送出自動回覆失敗' : '送出預存失敗'), 'error')
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
  const isRule = quickReplyTab.value === 'rule'
  quickReplyFilling.value = true
  try {
    const res = await apiFetch<{ text: string | null }>(
      `/api/conversations/${selectedUserId.value}/quick-reply-text`,
      { params: isRule ? { ruleId: item.id } : { presetId: item.id } },
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

/** 依 userId 選中對話；不在已載入的第一頁時，用列表搜尋端點撈那一筆（search 也比對 userId） */
async function selectUserById(userId: string) {
  let target = conversations.value.find(c => c.userId === userId) ?? null
  if (!target) {
    const res = await apiFetch<{ conversations: ConvItem[] }>('/api/conversations/list', {
      params: { page: 1, limit: 1, search: userId },
    }).catch(() => null)
    target = res?.conversations?.[0] ?? null
  }
  if (target) {
    await selectUser(target)
    return
  }
  // 找不到就要說:靜默不動的話,從監控頁按「開對話」會像連結壞掉
  // （對話很舊時會落在列表搜尋的掃描範圍之外）
  showToast('找不到這位客人的對話，請用左側搜尋看看', 'warning')
}

async function selectUser(c: ConvItem) {
  // 換人前先把打到一半的字收進這位客人的抽屜，再拿出下一位的
  if (selectedUserId.value !== c.userId) {
    stashDraft()
    inputText.value = drafts.get(c.userId) ?? ''
  }
  selectedSessionId.value = null
  sessionTimelineItems.value = []
  sessionMeta.value = null
  allTabActiveSession.value = null
  // 換人就重設基準時間，否則會拿上一位客人的時間戳去比、一進來就誤判成「有新訊息」
  aiContextSeenAtMs = 0
  selectedUserId.value = c.userId
  selectedUser.value = c
  pendingQuickReplyId.value = ''
  await loadMessages(c.userId)
}

/**
 * 讀這位客人的訊息。
 *
 * quiet = 自己剛送出後的刷新：不清空、不轉圈。原本這條走 selectUser()，
 * 每回一句就把整個對話清成一顆 spinner 再長回來——連回三句就閃三次。
 */
async function loadMessages(userId: string, options?: { quiet?: boolean }) {
  const quiet = options?.quiet === true
  if (!quiet) {
    messages.value = []
    msgLoading.value = true
  }
  try {
    const res = await apiFetch<{
      messages: MsgItem[]
      activeSession: SessionPanelMeta | null
    }>(`/api/conversations/${userId}/messages`)
    messages.value = res.messages
    allTabActiveSession.value = res.activeSession ?? null
    await nextTick()
    scrollToBottom()
    markConversationRead(userId)
  }
  catch {
    showToast('載入訊息失敗', 'error')
  }
  finally {
    if (!quiet) msgLoading.value = false
  }
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

async function reloadSessionTimeline(options?: { quiet?: boolean }) {
  const sid = selectedSessionId.value
  if (!sid)
    return
  const quiet = options?.quiet === true
  if (!quiet) msgLoading.value = true
  try {
    const res = await apiFetch<{
      sessionId: string
      status: ConvSessionStatus
      statusLabel: string
      items: SessionTimelineItem[]
    }>(`/api/conversations/sessions/${sid}/timeline`)
    sessionMeta.value = {
      sessionId: res.sessionId,
      status: res.status,
      statusLabel: res.statusLabel,
    }
    sessionTimelineItems.value = res.items ?? []
    await nextTick()
    scrollToBottom()
  }
  catch {
    showToast('重新載入會話失敗', 'error')
  }
  finally {
    if (!quiet) msgLoading.value = false
  }
}

/** 自己剛送出東西後的刷新：一律安靜（不清空、不轉圈），只有內容悄悄多一則 */
async function reloadAfterOutgoing() {
  if (selectedSessionId.value) {
    await reloadSessionTimeline({ quiet: true })
    await refreshListQuiet()
  }
  else if (selectedUserId.value) {
    await loadMessages(selectedUserId.value, { quiet: true })
    await loadSessionCounts()
  }
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
    if (selectedSessionId.value)
      await reloadSessionTimeline()
    else if (selectedUser.value)
      await selectUser(selectedUser.value)
    await refreshListQuiet()
    await loadSessionCounts()
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
    if (selectedSessionId.value)
      await reloadSessionTimeline()
    else if (selectedUser.value)
      await selectUser(selectedUser.value)
    await refreshListQuiet()
    // 狀態變了，側欄分頁的數字也要跟著動（先前漏了，交還後徽章會停在舊值）
    await loadSessionCounts()
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
    if (selectedSessionId.value)
      await reloadSessionTimeline()
    else if (selectedUser.value)
      await selectUser(selectedUser.value)
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

function scrollToBottom() {
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
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

function getQuickReplyItems(msg: MsgItem): string[] {
  const items = msg?.payload?.quickReply?.items
  if (!Array.isArray(items)) return []
  return items
    .map((item: any) => String(item?.action?.label || item?.action?.text || '').trim())
    .filter(Boolean)
    .slice(0, 8)
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
  void loadList(true).then(() => {
    if (qUserId && activeTab.value === 'all')
      void selectUserById(qUserId)
  })
  loadSupportPresets()
  listPollTimer = setInterval(() => {
    if (!listLoading.value && !listLoadingMore.value)
      void refreshListQuiet()
  }, 30_000)
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('blur', onWindowBlur)
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
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onWindowFocus)
    window.removeEventListener('blur', onWindowBlur)
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (savedDocumentTitle.value)
      document.title = savedDocumentTitle.value
  }
})
</script>
