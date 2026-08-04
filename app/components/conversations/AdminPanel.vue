<template>
  <AdminSplitLayout class="conversations-page" :is-empty="!selectedUserId">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title conv-sidebar-title-row" data-tour="conv-list">💬 對話</span>
      <el-button size="small" :loading="listLoading" @click="loadList(true)">重整</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <!-- Status Tabs -->
      <div class="conv-status-tabs" data-tour="conv-tabs">
        <button
          v-for="tab in STATUS_TABS"
          :key="tab.value"
          type="button"
          class="conv-status-tab"
          :class="{ active: activeTab === tab.value }"
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
      </div>
      <div v-if="listLoading && !sidebarItems.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!sidebarItems.length" class="split-sidebar-empty">
        <span>{{ searchText ? '無符合結果' : '尚無對話紀錄' }}</span>
      </div>
      <div
        v-else
        ref="sidebarListEl"
        class="split-list"
        @scroll.passive="onSidebarListScroll"
      >
        <!-- Session-based view (status tabs) -->
        <template v-if="activeTab !== 'all'">
          <AdminSplitListItem
            v-for="s in sessionSidebarItems"
            :key="s.sessionId"
            :title="s.displayName"
            :leading-avatar-url="s.pictureUrl"
            show-leading-avatar-fallback
            time-in-title-row
            :active="selectedSessionId === s.sessionId"
            :meta-text="SESSION_STATUS_LABELS[s.status] || s.status"
            :meta-truncate="true"
            :chip-text="formatTime(s.lastActivityAt)"
            :chip-tone="sessionChipTone(s.status)"
            @select="selectSession(s)"
          />
        </template>
        <!-- User-based view (all tab) -->
        <template v-else>
          <AdminSplitListItem
            v-for="c in convSidebarItems"
            :key="c.userId"
            :title="c.displayName"
            :leading-avatar-url="c.pictureUrl"
            show-leading-avatar-fallback
            time-in-title-row
            :show-unread-dot="isConvItemUnread(c)"
            :active="selectedUserId === c.userId && !selectedSessionId"
            :meta-text="(c.lastDirection === 'outgoing' ? '↑ ' : '') + c.lastMessage"
            :meta-truncate="true"
            :chip-text="formatTime(c.lastMessageAt)"
            chip-tone="neutral"
            @select="selectUser(c)"
          />
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
            v-if="sessionToolbarMeta.status === 'pending_human' || sessionToolbarMeta.status === 'human_handling'"
            size="small"
            type="primary"
            plain
            :loading="handingBackSession"
            @click="handBackSelectedSession"
          >
            交還機器人
          </el-button>
          <el-button
            v-if="sessionToolbarMeta.status !== 'closed'"
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
      <div ref="messagesEl" class="conv-messages">
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
              <div class="conv-video-frame">
                <img
                  v-if="getVideoPreviewImageUrl(msg)"
                  :src="getVideoPreviewImageUrl(msg)"
                  alt="video-preview"
                  class="conv-video-preview"
                />
                <div class="conv-video-play">▶</div>
              </div>
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
                  <span class="conv-attachment-card__title">音訊檔</span>
                  <span class="conv-attachment-card__desc">{{ getAudioDurationLabel(msg) }}</span>
                </span>
              </a>
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
                    <span class="conv-bubble-time">{{ formatTime(msg.timestamp) }}</span>
                    <span
                      v-if="msg.direction === 'outgoing' && msg.readByPeer"
                      class="conv-bubble-read"
                      title="客人後來有回訊息或點按鈕，代表他應該已看過這則之前的訊息；這是系統推估的，跟 LINE App 裡的「已讀」不一定完全一樣。"
                    >已讀</span>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </template>
      </div>

      <div class="conv-input-tools">
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
            trigger="click"
            placement="top-start"
            :width="340"
            popper-class="conv-picker-popover"
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
                    :class="`conv-picker-option--${picker.key}`"
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
            </div>
          </el-popover>
          <el-popover
            v-if="selectedUserId && activeSupportPresets.length"
            trigger="click"
            placement="top-start"
            :width="340"
            popper-class="conv-picker-popover"
          >
            <template #reference>
              <button
                type="button"
                class="conv-picker-trigger"
                :disabled="sending || msgLoading"
                title="客服預存"
              >
                <span class="conv-picker-trigger__emoji">📦</span>
              </button>
            </template>
            <div class="conv-picker-panel">
              <div class="conv-picker-title">客服預存</div>
              <div class="conv-picker-scrollbox">
                <div class="conv-support-preset-list">
                  <button
                    v-for="preset in activeSupportPresets"
                    :key="preset.id"
                    type="button"
                    class="conv-support-preset-option"
                    :class="{ active: pendingSupportPresetId === preset.id }"
                    :disabled="isSupportPresetBusy"
                    @click="pendingSupportPresetId = preset.id"
                  >
                    <span class="conv-support-preset-option__name">{{ preset.name || '(未命名)' }}</span>
                    <span class="conv-support-preset-option__meta">{{ getActionSummary(preset) }}</span>
                  </button>
                </div>
              </div>
              <div class="conv-picker-footer">
                <el-button
                  size="small"
                  type="primary"
                  :loading="sending"
                  :disabled="!pendingSupportPresetId || isSupportPresetBusy"
                  @click="sendSupportPreset"
                >
                  確認送出
                </el-button>
              </div>
            </div>
          </el-popover>
        </div>
        <span class="text-muted conv-input-hint">點上面的按鈕，可以直接挑圖片、貼圖、表情或客服預存來傳</span>
      </div>

      <div class="conv-input-row">
        <el-input
          v-model="inputText"
          placeholder="輸入訊息（可含 emoji），按 Enter 送出…"
          :disabled="sending"
          @keydown.enter.exact.prevent="send"
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
}

const STATUS_TABS: { value: TabValue; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending_human', label: '待真人' },
  { value: 'human_handling', label: '真人處理' },
  // 「待處理」＝還需不需要人處理（佇列語意）。不要改成「未首接」——那是統計看板
  // 的指標名稱（有沒有人回答過），兩者是不同的一群對話，同名會被誤讀成同一個數字。
  { value: 'open', label: '待處理' },
  { value: 'bot_handling', label: '機器人' },
  { value: 'closed', label: '結束' },
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
const selectedUserId = ref<string | null>(null)
const selectedSessionId = ref<string | null>(null)
const selectedUser = ref<ConvItem | null>(null)
const activeTab = ref<TabValue>('all')
const inputText = ref('')
const searchText = ref('')
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

function applyAiDraft(text: string) {
  inputText.value = String(text || '')
}

/** 開新分頁去補知識（帶客人原句預填），不離開現場對話——和 playground 同一做法 */
function goAddKnowledge(query: string) {
  const q = String(query || '').trim()
  const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
  window.open(`/admin/${workspaceId.value}/knowledge/sources${suffix}`, '_blank')
}

const messagesEl = ref<HTMLElement | null>(null)
const supportPresetsRaw = ref<any[]>([])
const pendingSupportPresetId = ref('')
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

const convSidebarItems = computed<ConvItem[]>(() => conversations.value)

const unreadConvCount = computed(() =>
  conversations.value.filter(c => isConvItemUnread(c)).length,
)

watch(unreadConvCount, () => {
  applyUnreadDocumentTitle()
})

watch(workspaceId, () => {
  hydrateConvLastRead()
  applyUnreadDocumentTitle()
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

const chatRows = computed<ChatRow[]>(() => {
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
      }
      return { kind: 'msg' as const, key: item.id, msg }
    })
  }
  return messages.value.map(msg => ({ kind: 'msg' as const, key: msg.id, msg }))
})

function sessionChipTone(status: ConvSessionStatus): 'neutral' | 'warning' | 'success' | 'error' {
  if (status === 'pending_human') return 'warning'
  if (status === 'human_handling') return 'success'
  if (status === 'closed') return 'neutral'
  return 'neutral'
}

async function switchTab(tab: TabValue) {
  activeTab.value = tab
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
      }>('/api/conversations/list', {
        params: {
          page,
          limit: CONV_LIST_PAGE_SIZE,
          search: searchText.value.trim() || undefined,
        },
      })
      const chunk = res.conversations ?? []
      conversations.value = reset ? chunk : [...conversations.value, ...chunk]
      listHasMore.value = Boolean(res.hasMore)
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
    const res = await apiFetch<{ counts: Record<ConvSessionStatus, number> }>(
      '/api/conversations/sessions-counts',
    )
    for (const k of Object.keys(sessionStatusCounts.value) as ConvSessionStatus[]) {
      sessionStatusCounts.value[k] = Number(res.counts?.[k] ?? 0)
    }
  }
  catch {
    // 分頁仍可用；數字維持上次成功值
  }
}

async function loadSupportPresets() {
  supportPresetsRaw.value = await apiFetch<any[]>('/api/support-preset/list').catch(() => [])
}

async function sendSupportPreset() {
  if (!assertCanOperate()) return
  const presetId = pendingSupportPresetId.value
  if (!presetId || !selectedUserId.value || !selectedUser.value) return
  sending.value = true
  try {
    await apiFetch(`/api/conversations/${selectedUserId.value}/send-preset`, {
      method: 'POST',
      body: { presetId },
    })
    showToast('已送出客服預存', 'success')
    await reloadAfterOutgoing()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '送出預存失敗', 'error')
  }
  finally {
    sending.value = false
    pendingSupportPresetId.value = ''
  }
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
  selectedSessionId.value = null
  sessionTimelineItems.value = []
  sessionMeta.value = null
  allTabActiveSession.value = null
  // 換人就重設基準時間，否則會拿上一位客人的時間戳去比、一進來就誤判成「有新訊息」
  aiContextSeenAtMs = 0
  selectedUserId.value = c.userId
  selectedUser.value = c
  pendingSupportPresetId.value = ''
  messages.value = []
  msgLoading.value = true
  try {
    const res = await apiFetch<{
      messages: MsgItem[]
      activeSession: SessionPanelMeta | null
    }>(`/api/conversations/${c.userId}/messages`)
    messages.value = res.messages
    allTabActiveSession.value = res.activeSession ?? null
    await nextTick()
    scrollToBottom()
    markConversationRead(c.userId)
  }
  catch {
    showToast('載入訊息失敗', 'error')
  }
  finally {
    msgLoading.value = false
  }
}

async function send() {
  if (!assertCanOperate()) return
  if (!selectedUserId.value) return
  sending.value = true
  try {
    const text = inputText.value.trim()
    if (!text) {
      showToast('請輸入訊息', 'error')
      return
    }
    await apiFetch(`/api/conversations/${selectedUserId.value}/send`, {
      method: 'POST',
      body: { type: 'text', text },
    })
    inputText.value = ''
    await reloadAfterOutgoing()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '發送失敗', 'error')
  }
  finally {
    sending.value = false
  }
}

async function reloadSessionTimeline() {
  const sid = selectedSessionId.value
  if (!sid)
    return
  msgLoading.value = true
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
    msgLoading.value = false
  }
}

async function reloadAfterOutgoing() {
  if (selectedSessionId.value) {
    await reloadSessionTimeline()
    await refreshListQuiet()
  }
  else if (selectedUser.value) {
    await selectUser(selectedUser.value)
    await loadSessionCounts()
  }
}

async function handBackSelectedSession() {
  const sid = selectedSessionId.value || allTabActiveSession.value?.sessionId
  const st = sessionToolbarMeta.value?.status
  if (!sid || (st !== 'pending_human' && st !== 'human_handling'))
    return
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
  if (kind === 'sticker' && item.kind === 'sticker') {
    sendSticker(item.packageId, item.stickerId)
  }
}

function appendEmoji(emoji: string) {
  inputText.value += emoji
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

function getMessageImageUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'image') return ''
  return String(msg?.payload?.previewImageUrl || msg?.payload?.originalContentUrl || '').trim()
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
  return String(msg?.payload?.previewImageUrl || msg?.payload?.originalContentUrl || '').trim()
}

function getStickerImageUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'sticker') return ''
  const sid = String(msg?.payload?.stickerId || '').trim()
  if (!sid) return ''
  return stickerPreviewUrl(sid)
}

function getAudioUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'audio') return ''
  return String(msg?.payload?.originalContentUrl || '').trim()
}

function getAudioDurationLabel(msg: MsgItem): string {
  if (getMessageType(msg) !== 'audio') return ''
  const durationMs = Number(msg?.payload?.duration || 0)
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '音訊'
  return `${Math.max(1, Math.round(durationMs / 1000))} 秒`
}

function getFileUrl(msg: MsgItem): string {
  if (getMessageType(msg) !== 'file') return ''
  return String(msg?.payload?.originalContentUrl || '').trim()
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
