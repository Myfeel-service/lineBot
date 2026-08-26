<template>
  <AdminSplitLayout :is-empty="!selectedFlow && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="flow-title">機器人模組<AdminPageHelpButton :topics="['flow', 'msg-basic', 'msg-rich', 'msg-carousel', 'msg-quick', 'msg-userinput']" /></span>
      <AdminOperateGate>
        <div class="flex gap-1">
          <el-tooltip content="新增資料夾" placement="bottom" :show-after="300">
            <el-button :icon="FolderAdd" size="small" plain @click="createFlowFolderPrompt" />
          </el-tooltip>
          <el-tooltip content="新增模組" placement="bottom" :show-after="300">
            <el-button :icon="Plus" type="primary" size="small" data-tour="flow-new" @click="openCreate">新增</el-button>
          </el-tooltip>
        </div>
      </AdminOperateGate>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <div v-if="loading && !flows.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!flows.length" class="split-sidebar-empty">
        <span>尚無模組</span>
        <AdminOperateGate>
          <el-button size="small" type="primary" plain @click="openCreate">立即新增</el-button>
        </AdminOperateGate>
      </div>
      <div v-else ref="listEl" class="split-list" @scroll.passive="onSidebarListScroll">
        <!-- 系統模組永遠在最上方（不可分組） -->
        <AdminSplitListItem
          v-for="flow in systemFlows"
          :key="flow.id"
          :data-tour="`flow-sys-${flow.moduleType}`"
          :title="`${flow.name}`"
          :active="selectedId === flow.id"
          :meta-text="moduleTypeLabel(flow.moduleType)"
          chip-tone="neutral"
          @select="selectFlow(flow)"
        />

        <!-- 未分類的 regular flows（可拖曳重排序，沿用原本機制） -->
        <div
          v-for="flow in uncategorizedFlows"
          :key="flow.id"
          class="flow-sidebar-row"
          :class="{
            'flow-sidebar-row--dragging': flowListDragIndex === regularFlowIndex(flow.id),
            'flow-sidebar-row--drag-over': flowListDragOverIndex === regularFlowIndex(flow.id) && flowListDragIndex !== regularFlowIndex(flow.id),
          }"
          @dragover.prevent="onFlowListDragOver($event, regularFlowIndex(flow.id))"
          @dragenter.prevent
          @dragleave="onFlowListDragLeave"
          @drop="onFlowListDrop($event, regularFlowIndex(flow.id))"
        >
          <span
            v-if="canOperate"
            class="drag-handle flow-sidebar-drag-handle"
            draggable="true"
            aria-label="拖曳搬移 / 排序"
            @dragstart.stop="onFlowDragStart($event, flow.id, regularFlowIndex(flow.id))"
            @dragend.stop="onFlowDragEnd"
          >⠿</span>
          <AdminSplitListItem
            class="flow-sidebar-row__item"
            :title="flow.name"
            :active="selectedId === flow.id"
            :meta-text="moduleTypeLabel(flow.moduleType)"
            chip-tone="neutral"
            @select="selectFlow(flow)"
          />
        </div>

        <!-- 拖曳資料夾內模組時：出現「拖出資料夾」drop zone -->
        <div
          v-if="isDraggingFromFolder"
          class="src-unfolder-zone"
          :class="{ 'src-unfolder-zone--drop': dragOverFolderId === '__none__' }"
          @dragover.prevent="onFlowFolderDragOver('__none__', $event)"
          @dragleave="onFlowFolderDragLeave('__none__')"
          @drop.prevent="onFlowFolderDrop(null)"
        >
          拖到這裡 = 移出資料夾
        </div>

        <!-- 每個資料夾 -->
        <template v-for="folder in flowFolders" :key="folder.id">
          <div
            class="src-folder-header"
            :class="{
              'src-folder-header--drop': dragOverFolderId === folder.id,
              'src-folder-header--dragging': draggedFolderId === folder.id,
              'src-folder-header--reorder-over': folderReorderOverId === folder.id && draggedFolderId !== folder.id,
            }"
            @click="toggleFlowFolder(folder.id)"
            @dragover.prevent="onFlowFolderDragOver(folder.id, $event)"
            @dragleave="onFlowFolderDragLeave(folder.id)"
            @drop.prevent="onFlowFolderDrop(folder.id)"
          >
            <span
              v-if="canOperate"
              class="drag-handle flow-sidebar-drag-handle src-folder-drag-handle"
              draggable="true"
              aria-label="拖曳排序資料夾"
              @click.stop
              @dragstart.stop="onFolderHeaderDragStart($event, folder.id)"
              @dragend.stop="onFolderHeaderDragEnd"
            >⠿</span>
            <span class="src-folder-label">
              <span class="src-folder-arrow">{{ isFlowFolderExpanded(folder.id) ? '▾' : '▸' }}</span>
              <el-icon><Folder /></el-icon> {{ folder.name }}
              <span class="src-folder-count">（{{ flowCountByFolder[folder.id] ?? 0 }}）</span>
            </span>
            <AdminOperateGate>
              <span class="src-folder-actions">
                <el-tooltip content="編輯資料夾" placement="top" :show-after="300">
                  <button class="src-folder-icon-btn" @click.stop="openFlowFolderEdit(folder)"><el-icon><EditPen /></el-icon></button>
                </el-tooltip>
              </span>
            </AdminOperateGate>
          </div>
          <template v-if="isFlowFolderExpanded(folder.id)">
            <div
              v-for="flow in flowsByFolder[folder.id] ?? []"
              :key="flow.id"
              class="flow-sidebar-row src-row--in-folder"
              :class="{
                'flow-sidebar-row--dragging': draggedFlowId === flow.id,
                'flow-sidebar-row--drag-over': folderRowDragOverId === flow.id && draggedFlowId !== flow.id,
              }"
              @dragover.prevent="onFolderRowDragOver($event, folder.id, flow.id)"
              @dragenter.prevent
              @dragleave="onFolderRowDragLeave(flow.id)"
              @drop.prevent="onFolderRowDrop(folder.id, flow.id)"
            >
              <span
                v-if="canOperate"
                class="drag-handle flow-sidebar-drag-handle"
                draggable="true"
                aria-label="拖曳搬移"
                @dragstart.stop="onFlowDragStart($event, flow.id, null)"
                @dragend.stop="onFlowDragEnd"
              >⠿</span>
              <AdminSplitListItem
                class="flow-sidebar-row__item"
                :title="flow.name"
                :active="selectedId === flow.id"
                :meta-text="moduleTypeLabel(flow.moduleType)"
                chip-tone="neutral"
                @select="selectFlow(flow)"
              />
            </div>
            <div
              v-if="!(flowsByFolder[folder.id] ?? []).length"
              class="src-folder-empty"
            >
              （資料夾為空；可從外面拖一筆過來）
            </div>
          </template>
        </template>

        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
          <span>載入更多…</span>
        </div>
      </div>
    </template>

    <!-- ── Empty State ── -->
    <template #editor-empty>
      <el-icon class="empty-icon"><Connection /></el-icon>
      <h3>選擇一個模組開始編輯</h3>
      <p>或點擊左側「新增」建立一個全新的回覆模組</p>
      <AdminOperateGate>
        <el-button type="primary" @click="openCreate">新增模組</el-button>
      </AdminOperateGate>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <AdminEditorHeaderTitle
        v-model="form.name"
        field-label="模組名稱"
        create-prefix="新增模組:"
        placeholder="請輸入模組名稱..."
        :caption="`共 ${form.messages.length} 則回覆訊息；關鍵字觸發請到「自動回覆」設定`"
        :is-creating="isCreating"
      />
      <div v-if="selectedFlow || isCreating" class="flow-module-meta" data-tour="flow-type">
        <!-- System modules: type is locked, show label only -->
        <template v-if="isSystemFlow">
          <el-tag type="warning" size="small" disable-transitions>系統模組</el-tag>
          <el-tag size="small" disable-transitions>
            {{ MODULE_TYPE_LABELS[form.moduleType] ?? '機器人流程' }}
          </el-tag>
        </template>
        <!-- Regular modules (create or edit): labelled selector -->
        <template v-else>
          <span class="flow-module-meta__label">模組類型</span>
          <el-select v-model="form.moduleType" size="small" style="width: 130px">
            <el-option
              v-for="t in WORKSPACE_FLOW_MODULE_TYPES"
              :key="t"
              :label="MODULE_TYPE_LABELS[t]"
              :value="t"
            />
          </el-select>
        </template>
      </div>
      <div class="flex gap-1 admin-header-actions">
        <el-button @click="cancelEdit">取消</el-button>
        <AdminOperateGate>
          <el-button type="primary" :loading="saving" @click="submitForm">
            {{ isCreating ? '建立模組' : '儲存變更' }}
          </el-button>
        </AdminOperateGate>
        <AdminOperateGate>
          <el-dropdown
            v-if="!isCreating && selectedFlow"
            trigger="click"
            placement="bottom-end"
            @command="onHeaderCommand"
          >
            <el-button class="flow-more-btn" :icon="MoreFilled" aria-label="更多動作" />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="duplicate" :disabled="duplicating" :icon="CopyDocument">
                  複製
                </el-dropdown-item>
                <el-dropdown-item
                  v-if="!isSystemFlow"
                  command="delete"
                  divided
                  :icon="Delete"
                  class="flow-more-item--danger"
                >
                  刪除
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </AdminOperateGate>
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <div class="flow-editor-messages">
        <!-- Sticky header（整寬，橫跨卡片區與預覽之上） -->
        <div class="fem-header" data-tour="flow-messages">
          <AdminPanelTitle tag="span" text="回覆訊息" tight />
          <div class="msg-type-btns">
            <el-tooltip content="純文字回覆，可再加最多 4 顆按鈕" placement="bottom" :show-after="300">
              <el-button size="small" data-tour="fmt-text" @click="addMessage('text')">＋ 文字</el-button>
            </el-tooltip>
            <el-tooltip content="傳一張圖片給客人" placement="bottom" :show-after="300">
              <el-button size="small" data-tour="fmt-image" @click="addMessage('image')">＋ 圖片</el-button>
            </el-tooltip>
            <el-tooltip content="傳一段影片（檔案最大 5 MB）" placement="bottom" :show-after="300">
              <el-button size="small" data-tour="fmt-video" @click="addMessage('video')">＋ 影片</el-button>
            </el-tooltip>
            <el-tooltip content="一張大圖，圖上可切出多個可點區塊" placement="bottom" :show-after="300">
              <el-button size="small" data-tour="fmt-rich" @click="addMessage('richMessage')">＋ 圖文訊息</el-button>
            </el-tooltip>
            <el-tooltip content="多張卡片左右滑，每張可放圖片、標題、內文與按鈕" placement="bottom" :show-after="300">
              <el-button size="small" data-tour="fmt-carousel" @click="addMessage('flexImageCarousel')">＋ 輪播訊息</el-button>
            </el-tooltip>
            <el-tooltip v-if="showLegacyCarousel" content="舊版多卡左右滑，建議改用「輪播訊息」" placement="bottom" :show-after="300">
              <el-button size="small" @click="addMessage('carousel')">＋ 輪播（舊）</el-button>
            </el-tooltip>
            <el-tooltip v-if="showLegacyImageCarousel" content="整排純圖片左右滑，點圖可觸發動作" placement="bottom" :show-after="300">
              <el-button size="small" @click="addMessage('imageCarousel')">＋ 圖片輪播</el-button>
            </el-tooltip>
            <el-tooltip content="訊息下方一排可點的小按鈕，客人點一下就送出" placement="bottom" :show-after="300">
              <el-button size="small" data-tour="fmt-quick" @click="addMessage('quickReply')">＋ 快速回覆</el-button>
            </el-tooltip>
            <el-tooltip v-if="showUserInput" content="向客人提問並收集回覆（例：電話、Email）" placement="bottom" :show-after="300">
              <el-button size="small" data-tour="fmt-userinput" @click="addMessage('userInput')">＋ 用戶輸入</el-button>
            </el-tooltip>
            <el-button class="fem-preview-toggle" size="small" @click="previewOpen = !previewOpen">
              {{ previewOpen ? '隱藏預覽' : '顯示預覽' }}
            </el-button>
          </div>
        </div>

        <!-- 卡片區 | 即時預覽（兩欄，都在工具列下方） -->
        <div class="fem-body-row">
        <div class="fem-rail" data-tour="flow-rail">
          <div v-if="!form.messages.length" class="fem-empty">
            <span>尚無訊息</span>
            <p class="text-xs text-muted">點擊上方按鈕新增</p>
          </div>

          <!-- Message Cards + Carousel Blocks -->
          <template v-for="(msg, i) in form.messages" :key="getMessageRenderKey(msg, i)">

            <!-- ── Normal card: text / image / video ── -->
            <!-- Outer native div is the drop target; FlowMessageCardShell is drag source only -->
            <div
              v-if="msg.type === 'text' || msg.type === 'image' || msg.type === 'video' || msg.type === 'richMessageRef'"
              @dragover.prevent="onDragOver($event, i)"
              @dragenter.prevent
              @dragleave="onDragLeave"
              @drop="onDrop($event, i)"
            >
            <FlowMessageCardShell
              :badge-label="msgTypeLabel(msg.type)"
              :badge-class="msgBadgeClass(msg.type)"
              :class="{ dragging: dragIndex === i, 'drag-over': dragOverIndex === i && dragIndex !== i }"
              @dragstart="onDragStart($event, i)"
              @dragend="onDragEnd"
              @remove="removeMessage(i)"
            >
              <!-- Text -->
              <div v-if="msg.type === 'text'" class="message-bubble-wrap">
                <div class="admin-field-group">
                  <AdminFieldLabel tight>
                    回覆文字 <span class="text-muted">(最多 5000 字；若有按鈕最多 160 字)</span>
                  </AdminFieldLabel>
                  <div class="flow-textarea-wrapper flow-textarea-wrapper--var-inset">
                    <el-input v-model="msg.text" type="textarea" :rows="3" placeholder="輸入回覆文字..." :maxlength="msg.buttons && msg.buttons.length > 0 ? 160 : 5000" />
                    <FlowVariableInset
                      :options="variableTokenOptions"
                      @pick="(token) => insertVariableToken(msg, 'text', String(token))"
                    />
                  </div>
                </div>
                <div v-if="msg.buttons && msg.buttons.length" class="carousel-actions">
                  <div v-for="(btn, bIdx) in msg.buttons" :key="bIdx">
                    <FlowActionEditor
                      :action="btn"
                      :type-options="standardActionTypeOptions"
                      :module-options="modulePickerOptions"
                      :tag-options="allTags"
                      :enable-tagging="true"
                      :variable-options="variableTokenOptions"
                      :header-label="`按鈕 ${Number(bIdx) + 1}`"
                      label-placeholder="按鈕文字"
                      text-title="傳送文字"
                      text-placeholder="傳送文字"
                    >
                      <template #top-extra>
                        <el-button
                          link
                          type="danger"
                          size="small"
                          @click="removeButton(msg, Number(bIdx))"
                        >
                          ✕
                        </el-button>
                      </template>
                    </FlowActionEditor>
                  </div>
                </div>
                <el-button v-if="!msg.buttons || msg.buttons.length < 4" plain size="small" class="control-dashed-add" @click="addButton(msg)">
                  ⊕ 新增按鈕 (非必需)
                </el-button>
              </div>

              <!-- Image -->
              <div v-else-if="msg.type === 'image'" class="message-image-wrap">
                <div class="admin-field-group">
                  <AdminFieldLabel text="圖片" tight />
                  <FlowUploadZone v-model="msg.originalContentUrl" type="image" label="點擊上傳圖片" @update:model-value="(v) => { msg.previewImageUrl = v }" />
                </div>
              </div>

              <!-- Video -->
              <div v-else-if="msg.type === 'video'" class="message-video-wrap admin-field-stack">
                <div class="admin-field-group">
                  <AdminFieldLabel>
                    影片檔案 <span class="text-muted">(大小不可超過 5 MB)</span>
                  </AdminFieldLabel>
                  <FlowUploadZone
                    v-model="msg.originalContentUrl"
                    type="video"
                    label="點擊上傳影片"
                    hint="須符合 LINE 影片規範"
                    @video-sized="(size) => { applyVideoSize(msg, size); void ensureVideoDimensions(msg) }"
                    @update:model-value="(v) => { if (!v) { msg.videoWidth = undefined; msg.videoHeight = undefined } else { void ensureVideoDimensions(msg) } }"
                  />
                </div>
                <div v-if="String(msg.originalContentUrl || '').trim()" class="admin-field-group">
                  <AdminFieldLabel>
                    預覽圖片 <span class="text-muted">(長寬比例須與影片一致)</span>
                  </AdminFieldLabel>
                  <FlowUploadZone
                    :key="videoPreviewFrameKey(msg)"
                    v-model="msg.previewImageUrl"
                    type="image"
                    label="點擊上傳預覽圖"
                    hint="請先上傳影片；封面將依影片比例顯示"
                    :preview-frame="videoPreviewFrame(msg.videoWidth, msg.videoHeight, msg.originalContentUrl)"
                  />
                </div>
              </div>

              <!-- Rich Message Reference -->
              <div v-else-if="msg.type === 'richMessageRef'" class="message-bubble-wrap flow-rich-ref">
                <div class="admin-field-group">
                  <AdminFieldLabel text="引用圖文訊息" tight />
                  <el-select
                    v-model="msg.richMessageId"
                    size="small"
                    class="control-full"
                    filterable
                    placeholder="選擇已建立的圖文訊息"
                    @change="onRichMessageRefChange(msg)"
                  >
                    <el-option
                      v-for="item in richMessages"
                      :key="item.id"
                      :value="item.id"
                      :label="item.name"
                    />
                  </el-select>
                </div>
                <div class="text-xs text-muted">
                  圖文訊息需先在「圖文訊息管理」建立，這裡僅做引用。
                </div>
                <div v-if="richMessageRefPreview(msg)" class="carousel-action-row">
                  <div class="carousel-action-row-top">
                    <span class="carousel-action-index">預覽資訊</span>
                  </div>
                  <div class="text-sm">版型：{{ richMessageLayoutLabel(richMessageRefPreview(msg)?.layoutId || 'custom') }}</div>
                  <div class="text-xs text-muted">{{ richMessageRefPreview(msg)?.altText || '（未設定提醒文字）' }}</div>
                  <div class="text-xs text-muted">動作：{{ Array.isArray(richMessageRefPreview(msg)?.actions) ? richMessageRefPreview(msg)?.actions.length : 0 }} 個</div>
                </div>
              </div>
            </FlowMessageCardShell>
            </div>

            <!-- ── Rich Message (inline) block ── -->
            <div
              v-else-if="msg.type === 'richMessage'"
              class="carousel-block"
              :class="{ dragging: dragIndex === i, 'drag-over': dragOverIndex === i && dragIndex !== i }"
              @dragover.prevent="onDragOver($event, i)"
              @dragenter.prevent
              @dragleave="onDragLeave"
              @drop="onDrop($event, i)"
            >
              <!-- Config card -->
              <FlowMessageCardShell
                :badge-label="msgTypeLabel(msg.type)"
                :badge-class="msgBadgeClass(msg.type)"
                @dragstart="onDragStart($event, i)"
                @dragend="onDragEnd"
                @remove="removeMessage(i)"
              >
                <div class="card-section-stack">
                  <div class="admin-field-group">
                    <AdminFieldLabel tight>
                      提醒文字 <span class="text-muted">(最多 400 字)</span>
                    </AdminFieldLabel>
                    <el-input
                      v-model="msg.altText"
                      placeholder="提醒文字（最多 400 字）"
                      maxlength="400"
                    />
                  </div>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="保留 PNG 透明區域" tight />
                    <div class="flow-rich-toggle-row">
                      <el-switch v-model="msg.transparentBackground" />
                      <span class="text-sm text-muted">開啟後，圖片透明的地方會維持透明、不會補上白底</span>
                    </div>
                  </div>
                  <div class="admin-field-group" data-tour="rich-hero">
                    <AdminFieldLabel text="背景圖片" tight />
                    <FlowUploadZone
                      v-model="msg.heroImageUrl"
                      type="image"
                      appearance="simple"
                      hint="JPG / PNG · 最大 500KB · 依上傳圖片比例顯示"
                      @image-sized="(size) => applyRichMessageHeroSize(msg, size)"
                    />
                  </div>
                  <FlowRichMessageAreas
                    v-if="String(msg.heroImageUrl || '').trim()"
                    :msg="msg"
                    :module-options="modulePickerOptions"
                    :tag-options="allTags"
                    :enable-tagging="true"
                    :show-canvas="true"
                    :show-action-cards="false"
                    :show-header="false"
                    :flat="true"
                  />
                  <AdminLayoutPresetPicker
                    data-tour="rich-layout"
                    flat
                    title="圖文樣式"
                    :layouts="RICH_LAYOUT_PRESETS"
                    :selected-id="msg.layoutId"
                    @select="(layoutId) => selectInlineRichMessageLayout(msg, String(layoutId))"
                  />
                </div>
              </FlowMessageCardShell>
              <FlowRichMessageAreas
                v-if="String(msg.heroImageUrl || '').trim()"
                :msg="msg"
                :module-options="modulePickerOptions"
                :tag-options="allTags"
                :enable-tagging="true"
                :show-canvas="false"
                :show-action-cards="true"
                :flat="true"
              />
            </div>

            <!-- ── Quick Reply block (Carousel layout) ── -->
            <div
              v-else-if="msg.type === 'quickReply'"
              class="carousel-block"
              :class="{ dragging: dragIndex === i, 'drag-over': dragOverIndex === i && dragIndex !== i }"
              @dragover.prevent="onDragOver($event, i)"
              @dragenter.prevent
              @dragleave="onDragLeave"
              @drop="onDrop($event, i)"
            >
              <!-- Parent Config Card -->
              <FlowMessageCardShell
                badge-label="快速回覆"
                badge-class="badge-purple"
                @dragstart="onDragStart($event, i)"
                @dragend="onDragEnd"
                @remove="removeMessage(i)"
              >
                <!-- Text input for the bubble! -->
                <div class="carousel-alt-wrap card-section-stack">
                  <div class="admin-field-group" data-tour="quick-prompt">
                    <AdminFieldLabel tight>
                      搭配的文字內容 <span class="text-muted">(必需輸入，最多 5000 字)</span>
                    </AdminFieldLabel>
                    <div class="flow-textarea-wrapper flow-textarea-wrapper--var-inset">
                      <el-input
                        v-model="msg.text"
                        type="textarea"
                        :rows="2"
                        placeholder="請輸入主要回覆文字..."
                        maxlength="5000"
                      />
                      <FlowVariableInset
                        :options="variableTokenOptions"
                        @pick="(token) => insertVariableToken(msg, 'text', String(token))"
                      />
                    </div>
                  </div>
                </div>
              </FlowMessageCardShell>

              <!-- Sub-card horizontal rail ── -->
              <div class="carousel-cards-scroll cards-scroll-top-gap">
                <div
                  v-for="(qr, qi) in msg.quickReplies" :key="qi"
                  class="carousel-sub-card"
                  :class="{ 'col-dragging': qrDragMsgIndex === i && qrDragIndex === qi, 'col-drag-over': qrDragMsgIndex === i && qrDragOverIndex === qi && qrDragIndex !== qi }"
                  @dragover.prevent="onQrDragOver($event, i, Number(qi))"
                  @dragenter.prevent
                  @dragleave="onQrDragLeave"
                  @drop="onQrDrop($event, i, Number(qi))"
                >
                  <div class="carousel-card-top">
                    <div class="flex gap-1 items-center">
                      <span class="drag-handle" draggable="true" @dragstart.stop="onQrDragStart($event, i, Number(qi))" @dragend.stop="onQrDragEnd">⠿</span>
                      <span class="carousel-card-idx">{{ Number(qi) + 1 }}</span>
                    </div>
                    <el-button link type="danger" size="small" @click="removeQuickReply(msg, Number(qi))">✕</el-button>
                  </div>
                  <div class="carousel-sub-body carousel-sub-body-top-gap">
                    <!-- Action Config -->
                      <div class="carousel-actions" data-tour="quick-button">
                      <FlowActionEditor
                        :action="qr.action"
                        :type-options="quickReplyActionTypeOptions"
                        :module-options="modulePickerOptions"
                        :tag-options="allTags"
                        :enable-tagging="true"
                        :variable-options="variableTokenOptions"
                        header-label="按鈕動作"
                        label-title="按鈕顯示文字（最多 20 字）"
                      />
                    </div>
                  </div>
                </div>

                <!-- Add Button -->
                <button v-if="!msg.quickReplies || msg.quickReplies.length < 13" class="carousel-add-card" data-tour="quick-add" @click="addQuickReply(msg)">
                  <span class="add-card-plus">＋</span>
                </button>
              </div>
            </div>

            <!-- ── User Input block ── -->
            <!-- Outer native div is the drop target; FlowMessageCardShell is drag source only -->
            <div
              v-else-if="msg.type === 'userInput'"
              @dragover.prevent="onDragOver($event, i)"
              @dragenter.prevent
              @dragleave="onDragLeave"
              @drop="onDrop($event, i)"
            >
            <FlowMessageCardShell
              class="user-input-card"
              :badge-label="msgTypeLabel(msg.type)"
              :badge-class="msgBadgeClass(msg.type)"
              :class="{ dragging: dragIndex === i, 'drag-over': dragOverIndex === i && dragIndex !== i }"
              @dragstart="onDragStart($event, i)"
              @dragend="onDragEnd"
              @remove="removeMessage(i)"
            >
              <div class="message-bubble-wrap user-input-content">
                <div class="ui-field admin-field-group" data-tour="ui-question">
                  <AdminFieldLabel tight>
                    向用戶提問 <span class="text-muted">(必填，最多 500 字)</span>
                  </AdminFieldLabel>
                  <div class="flow-textarea-wrapper flow-textarea-wrapper--var-inset flow-textarea-wrapper--no-resize">
                    <el-input
                      v-model="msg.text"
                      type="textarea"
                      :rows="3"
                      placeholder="請輸入你的問題 (必需輸入)"
                      maxlength="500"
                      resize="none"
                    />
                    <FlowVariableInset
                      :options="variableTokenOptions"
                      @pick="(token) => insertVariableToken(msg, 'text', String(token))"
                    />
                  </div>
                </div>

                <div class="ui-settings">
                  <div v-if="showUserInputAttribute" class="ui-field admin-field-group" data-tour="ui-attribute">
                    <AdminFieldLabel tight>
                      儲存屬性名稱 <span class="text-muted">(選填)</span>
                    </AdminFieldLabel>
                    <el-select
                      v-model="msg.attribute"
                      size="small"
                      class="control-full"
                      filterable
                      allow-create
                      clearable
                      default-first-option
                      placeholder="選擇或輸入屬性名稱（例：phone, email）"
                    >
                      <el-option
                        v-for="opt in attributeOptions"
                        :key="opt.value"
                        :value="opt.value"
                        :label="opt.label"
                      />
                    </el-select>
                  </div>

                  <div class="ui-field admin-field-group" data-tour="ui-next-module">
                    <AdminFieldLabel tight>
                      收到回覆後，觸發下一個模組 <span class="text-muted">(必填)</span>
                    </AdminFieldLabel>
                    <el-select v-model="msg.moduleId" placeholder="選擇機器人模組" size="small" class="control-full">
                      <el-option v-for="f in modulePickerOptions" :key="f.id" :value="f.id" :label="f.name" />
                    </el-select>
                  </div>
                  <div class="ui-field admin-field-group">
                    <AdminFieldLabel text="收到回覆後是否貼標" tight />
                    <el-switch
                      v-model="msg.tagging.enabled"
                      active-text="啟用"
                      inactive-text="停用"
                      class="ar-status-switch"
                    />
                  </div>
                  <div v-if="msg.tagging.enabled" class="ui-field admin-field-group">
                    <AdminFieldLabel text="命中後加上標籤" tight />
                    <el-select
                      v-model="msg.tagging.addTagIds"
                      multiple
                      collapse-tags
                      collapse-tags-tooltip
                      placeholder="選擇要貼的標籤"
                      class="control-full"
                    >
                      <el-option
                        v-for="tag in allTags"
                        :key="tag.id"
                        :value="tag.id"
                        :label="tag.name"
                      >
                        <AdminTagOptionRow :label="tag.name" :color="tag.color" />
                      </el-option>
                    </el-select>
                  </div>
                </div>

                <div class="ui-warning-text">
                  用戶在聊天室看到這則提問後輸入回覆，系統會在 24 小時內把回覆存成你設定的屬性（若有填寫），並自動觸發你選擇的下一個模組。注意：超過 24 小時後，則不會觸發下一個行動，也不會將回覆存為自訂屬性。
                </div>
              </div>
            </FlowMessageCardShell>
            </div>

            <!-- ── Carousel block (flat stretch, but parent config is a standard card) ── -->
            <div
              v-else-if="msg.type === 'carousel' || msg.type === 'imageCarousel' || msg.type === 'flexImageCarousel'"
              class="carousel-block"
              :class="{ dragging: dragIndex === i, 'drag-over': dragOverIndex === i && dragIndex !== i }"
              @dragover.prevent="onDragOver($event, i)"
              @dragenter.prevent
              @dragleave="onDragLeave"
              @drop="onDrop($event, i)"
            >
              <!-- 1. The Parent Config Card (Exactly matches 380px standard card) -->
              <FlowMessageCardShell
                :badge-label="msgTypeLabel(msg.type)"
                :badge-class="msgBadgeClass(msg.type)"
                @dragstart="onDragStart($event, i)"
                @dragend="onDragEnd"
                @remove="removeMessage(i)"
              >
                <!-- Alt Text body (reusing standard padding) -->
                <div class="carousel-alt-wrap card-section-stack">
                  <div class="admin-field-group">
                    <AdminFieldLabel tight>
                      訊息提醒文字 <span class="text-muted">(最多 400 字)</span>
                    </AdminFieldLabel>
                    <div class="flow-input-inset-wrap control-full">
                      <el-input
                        v-model="msg.altText"
                        :placeholder="msg.type === 'carousel' ? '訊息提醒文字（客人裝置顯示不出卡片時，改顯示這行字，最多 400 字）' : '訊息提醒文字（最多 400 字）'"
                        maxlength="400"
                      />
                      <FlowVariableInset
                        :options="variableTokenOptions"
                        @pick="(token) => insertVariableToken(msg, 'altText', String(token))"
                      />
                    </div>
                  </div>
                  <div v-if="msg.type === 'carousel'" class="admin-field-group">
                    <AdminFieldLabel text="縮圖比例" tight />
                    <el-select v-model="msg.imageAspectRatio" size="small" class="control-full">
                      <el-option
                        v-for="opt in CAROUSEL_IMAGE_ASPECT_OPTIONS"
                        :key="opt.id"
                        :label="opt.label"
                        :value="opt.id"
                      />
                    </el-select>
                    <p class="text-xs text-muted">
                      LINE 輪播僅支援橫式 1.51:1 或正方形 1:1；上傳圖超出部分會置中裁切
                    </p>
                  </div>
                  <p v-if="msg.type === 'imageCarousel'" class="text-xs text-muted">
                    固定 1:1 正方形顯示，超出部分會置中裁切
                  </p>
                  <template v-if="msg.type === 'flexImageCarousel'">
                    <div class="admin-field-group" data-tour="flex-enable-image">
                      <AdminFieldLabel text="開啟圖片" tight />
                      <el-switch v-model="msg.enableImage" active-text="開啟" inactive-text="關閉" />
                    </div>
                    <div v-if="flexCarouselUsesImage(msg)" class="admin-field-group">
                      <AdminFieldLabel text="圖片比例" tight />
                      <el-select v-model="msg.imageAspectRatio" size="small" class="control-full">
                        <el-option
                          v-for="opt in FLEX_IMAGE_CAROUSEL_ASPECT_OPTIONS"
                          :key="opt.id"
                          :label="opt.label"
                          :value="opt.id"
                        />
                      </el-select>
                      <p class="text-xs text-muted">
                        標題、內文、底部按鈕為選填；上傳圖超出比例的部分會置中裁切
                      </p>
                    </div>
                    <p v-else class="text-xs text-muted">
                      未開啟圖片時，每張卡片標題為必填；可填內文與底部按鈕
                    </p>
                  </template>
                </div>
              </FlowMessageCardShell>

              <!-- 2. Horizontal sub-card rail ── -->
              <div class="carousel-cards-scroll cards-scroll-top-gap">

                <!-- Carousel sub-cards -->
                <template v-if="msg.type === 'carousel'">
                  <div
                    v-for="(col, ci) in msg.columns" :key="ci"
                    class="carousel-sub-card"
                    :class="{ 'col-dragging': colDragMsgIndex === i && colDragIndex === ci, 'col-drag-over': colDragMsgIndex === i && colDragOverIndex === ci && colDragIndex !== ci }"
                    @dragover.prevent="onColDragOver($event, i, Number(ci))"
                    @dragenter.prevent
                    @dragleave="onColDragLeave"
                    @drop="onColDrop($event, i, Number(ci))"
                  >
                    <div class="carousel-card-top">
                      <div class="flex gap-1 items-center">
                        <span class="drag-handle" draggable="true" @dragstart.stop="onColDragStart($event, i, Number(ci))" @dragend.stop="onColDragEnd">⠿</span>
                        <span class="carousel-card-idx">{{ Number(ci) + 1 }}</span>
                      </div>
                      <el-button v-if="msg.columns.length > 1" link type="danger" size="small" @click="removeColumn(msg, Number(ci))">✕</el-button>
                    </div>
                    <div class="carousel-sub-body admin-field-stack">
                      <FlowUploadZone
                        v-model="col.thumbnailImageUrl"
                        type="image"
                        label="上傳縮圖"
                        class="carousel-sub-media-upload"
                        :preview-frame="carouselPreviewFrame(msg)"
                      />
                      <div class="admin-field-group">
                        <AdminFieldLabel tight>
                          標題 <span class="text-muted">(必填，最多 80 字)</span>
                        </AdminFieldLabel>
                        <div class="flow-input-inset-wrap flow-input-inset-wrap--sm control-full">
                          <el-input v-model="col.title" placeholder="標題（必填，最多 80 字）" maxlength="80" />
                          <FlowVariableInset
                            size="sm"
                            :options="variableTokenOptions"
                            @pick="(token) => insertVariableToken(col, 'title', String(token))"
                          />
                        </div>
                      </div>
                      <div class="admin-field-group">
                        <AdminFieldLabel tight>
                          內容 <span class="text-muted">(最多 300 字)</span>
                        </AdminFieldLabel>
                        <div class="flow-textarea-wrapper flow-textarea-wrapper--var-inset">
                          <el-input v-model="col.text" type="textarea" :rows="2" placeholder="副標題或內容（最多 300 字）" maxlength="300" />
                          <FlowVariableInset
                            :options="variableTokenOptions"
                            @pick="(token) => insertVariableToken(col, 'text', String(token))"
                          />
                        </div>
                      </div>
                      <div v-if="col.actions?.length" class="carousel-actions">
                        <div v-for="(act, ai) in col.actions" :key="ai">
                          <FlowActionEditor
                            :action="act"
                            :type-options="standardActionTypeOptions"
                            :module-options="modulePickerOptions"
                            :tag-options="allTags"
                            :enable-tagging="true"
                            :variable-options="variableTokenOptions"
                            :header-label="`按鈕 ${Number(ai) + 1}`"
                            :field-size="'default'"
                            label-placeholder="按鈕文字"
                            text-title="傳送文字"
                            text-placeholder="傳送文字"
                          >
                            <template #top-extra>
                              <el-button
                                link
                                type="danger"
                                size="small"
                                :disabled="col.actions.length <= 1"
                                @click="removeCarouselAction(col, Number(ai))"
                              >
                                ✕
                              </el-button>
                            </template>
                          </FlowActionEditor>
                        </div>
                      </div>
                      <el-button v-if="!col.actions || col.actions.length < 3" plain size="small" class="control-dashed-add" @click="addCarouselAction(col)">⊕ 新增按鈕</el-button>
                    </div>
                  </div>
                </template>

                <!-- imageCarousel sub-cards -->
                <template v-else-if="msg.type === 'imageCarousel'">
                  <div
                    v-for="(col, ci) in msg.columns" :key="ci"
                    class="carousel-sub-card"
                    :class="{ 'col-dragging': colDragMsgIndex === i && colDragIndex === ci, 'col-drag-over': colDragMsgIndex === i && colDragOverIndex === ci && colDragIndex !== ci }"
                    @dragover.prevent="onColDragOver($event, i, Number(ci))"
                    @dragenter.prevent
                    @dragleave="onColDragLeave"
                    @drop="onColDrop($event, i, Number(ci))"
                  >
                    <div class="carousel-card-top">
                      <div class="flex gap-1 items-center">
                        <span class="drag-handle" draggable="true" @dragstart.stop="onColDragStart($event, i, Number(ci))" @dragend.stop="onColDragEnd">⠿</span>
                        <span class="carousel-card-idx">{{ Number(ci) + 1 }}</span>
                      </div>
                      <el-button v-if="msg.columns.length > 1" link type="danger" size="small" @click="removeColumn(msg, Number(ci))">✕</el-button>
                    </div>
                    <div class="carousel-sub-body">
                      <FlowUploadZone
                        v-model="col.imageUrl"
                        type="image"
                        label="上傳"
                        class="carousel-sub-media-upload"
                        :preview-frame="{ widthRatio: 1, heightRatio: 1, fit: 'cover' }"
                      />
                      <div v-if="flexCarouselUsesImage(msg)" class="carousel-actions carousel-actions-top-gap">
                        <FlowActionEditor
                          :action="col.action"
                          :type-options="imageCarouselActionTypeOptions"
                          :module-options="modulePickerOptions"
                          :tag-options="allTags"
                          :enable-tagging="true"
                          :variable-options="variableTokenOptions"
                          header-label="圖片動作"
                          :field-size="'default'"
                          :hide-fields-when-none="true"
                          label-placeholder="按鈕文字 (必填)"
                          text-title="傳送文字"
                          text-placeholder="點擊後傳送的文字"
                        />
                      </div>
                    </div>
                  </div>
                </template>

                <!-- flexImageCarousel sub-cards -->
                <template v-else-if="msg.type === 'flexImageCarousel'">
                  <div
                    v-for="(col, ci) in msg.columns" :key="ci"
                    class="carousel-sub-card"
                    :class="{ 'col-dragging': colDragMsgIndex === i && colDragIndex === ci, 'col-drag-over': colDragMsgIndex === i && colDragOverIndex === ci && colDragIndex !== ci }"
                    @dragover.prevent="onColDragOver($event, i, Number(ci))"
                    @dragenter.prevent
                    @dragleave="onColDragLeave"
                    @drop="onColDrop($event, i, Number(ci))"
                  >
                    <div class="carousel-card-top">
                      <div class="flex gap-1 items-center">
                        <span class="drag-handle" draggable="true" @dragstart.stop="onColDragStart($event, i, Number(ci))" @dragend.stop="onColDragEnd">⠿</span>
                        <span class="carousel-card-idx">{{ Number(ci) + 1 }}</span>
                      </div>
                      <el-button v-if="msg.columns.length > 1" link type="danger" size="small" @click="removeColumn(msg, Number(ci))">✕</el-button>
                    </div>
                    <div class="carousel-sub-body admin-field-stack">
                      <template v-if="flexCarouselUsesImage(msg)">
                        <FlowUploadZone
                          v-model="col.imageUrl"
                          type="image"
                          label="上傳圖片"
                          class="carousel-sub-media-upload"
                          :preview-frame="flexImageCarouselPreviewFrame(msg)"
                        />
                      </template>
                      <div class="admin-field-group" data-tour="flex-col-title">
                        <AdminFieldLabel tight>
                          標題 <span class="text-muted">({{ flexCarouselUsesImage(msg) ? '選填' : '必填' }}，最多 80 字)</span>
                        </AdminFieldLabel>
                        <div class="flow-input-inset-wrap flow-input-inset-wrap--sm control-full">
                          <el-input
                            v-model="col.title"
                            :placeholder="flexCarouselUsesImage(msg) ? '標題（選填，最多 80 字）' : '標題（必填，最多 80 字）'"
                            maxlength="80"
                          />
                          <FlowVariableInset
                            size="sm"
                            :options="variableTokenOptions"
                            @pick="(token) => insertVariableToken(col, 'title', String(token))"
                          />
                        </div>
                      </div>
                      <div class="admin-field-group">
                        <AdminFieldLabel tight>
                          內文 <span class="text-muted">(選填，最多 300 字)</span>
                        </AdminFieldLabel>
                        <div class="flow-textarea-wrapper flow-textarea-wrapper--var-inset">
                          <el-input v-model="col.text" type="textarea" :rows="2" placeholder="內文（選填，最多 300 字）" maxlength="300" />
                          <FlowVariableInset
                            :options="variableTokenOptions"
                            @pick="(token) => insertVariableToken(col, 'text', String(token))"
                          />
                        </div>
                      </div>
                      <div v-if="flexCarouselUsesImage(msg)" class="carousel-actions carousel-actions-top-gap">
                        <FlowActionEditor
                          :action="col.action"
                          :type-options="imageCarouselActionTypeOptions"
                          :module-options="modulePickerOptions"
                          :tag-options="allTags"
                          :enable-tagging="true"
                          :variable-options="variableTokenOptions"
                          header-label="圖片動作"
                          :field-size="'default'"
                          :hide-fields-when-none="true"
                          :show-label-field="false"
                          text-title="傳送文字"
                          text-placeholder="點擊後傳送的文字"
                        />
                      </div>
                      <div v-if="col.actions?.length" class="carousel-actions">
                        <div v-for="(act, ai) in col.actions" :key="ai">
                          <FlowActionEditor
                            :action="act"
                            :type-options="standardActionTypeOptions"
                            :module-options="modulePickerOptions"
                            :tag-options="allTags"
                            :enable-tagging="true"
                            :variable-options="variableTokenOptions"
                            :header-label="`按鈕 ${Number(ai) + 1}`"
                            :field-size="'default'"
                            label-placeholder="按鈕文字"
                            text-title="傳送文字"
                            text-placeholder="傳送文字"
                          >
                            <template #top-extra>
                              <el-button
                                link
                                type="danger"
                                size="small"
                                @click="removeFlexImageCarouselButton(col, Number(ai))"
                              >
                                ✕
                              </el-button>
                            </template>
                          </FlowActionEditor>
                        </div>
                      </div>
                      <el-button
                        v-if="!col.actions || col.actions.length < 3"
                        plain
                        size="small"
                        class="control-dashed-add"
                        @click="addFlexImageCarouselButton(col)"
                      >
                        ⊕ 新增按鈕（非必需）
                      </el-button>
                    </div>
                  </div>
                </template>

                <!-- Add sub-card button -->
                <button
                  v-if="msg.columns.length < 10"
                  class="carousel-add-card"
                  data-tour="flex-add-column"
                  @click="msg.type === 'carousel' ? addCarouselColumn(msg) : msg.type === 'flexImageCarousel' ? addFlexImageCarouselColumn(msg) : addImageCarouselColumn(msg)"
                >
                  <span class="add-card-plus">＋</span>
                </button>
              </div>
            </div>

          </template>
          <!-- End rail -->
          </div>
          <Transition name="fmp">
            <FlowMessagePreview v-if="previewOpen" :messages="form.messages" :rich-messages="richMessages" :oa-name="currentWorkspaceName" />
          </Transition>
        </div>
      </div>

    </template>
  </AdminSplitLayout>

  <!-- ── Flow Folder Edit Modal ──────────────────── -->
  <el-dialog
    v-model="flowFolderEditOpen"
    title="編輯資料夾"
    width="min(480px, 92vw)"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div class="folder-form">
      <div class="admin-field-group">
        <AdminFieldLabel text="名稱" tight />
        <el-input
          v-model="flowFolderForm.name"
          maxlength="50"
          show-word-limit
          placeholder="例：行銷活動 / 例假回覆"
        />
      </div>
      <p v-if="flowFolderEditTarget" class="folder-form-hint">
        目前底下 {{ flowCountByFolder[flowFolderEditTarget.id] ?? 0 }} 筆模組。
        若刪除，底下的模組會自動移到「未分類」，**不會**被刪掉。
      </p>
    </div>
    <template #footer>
      <div class="folder-footer">
        <el-button
          type="danger"
          plain
          :loading="flowFolderDeleting"
          :disabled="flowFolderSaving"
          @click="deleteFlowFolderFromModal"
        >
          刪除資料夾
        </el-button>
        <div class="folder-footer-right">
          <el-button @click="flowFolderEditOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="flowFolderSaving"
            :disabled="flowFolderDeleting || !flowFolderForm.name.trim() || flowFolderForm.name.trim() === flowFolderEditTarget?.name"
            @click="saveFlowFolderName"
          >
            儲存
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>

</template>


<script setup lang="ts">
import { Connection, CopyDocument, Delete, EditPen, Folder, FolderAdd, MoreFilled, Plus } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import {
  SLOT_LABELS as ACTION_SLOT_LABELS,
  validateUnifiedAction,
} from '~~/shared/action-schema'
import {
  RICH_LAYOUT_PRESETS,
  type RichLayoutId,
} from '~~/shared/rich-layout-presets'
import {
  CAROUSEL_IMAGE_ASPECT_OPTIONS,
  DEFAULT_CAROUSEL_IMAGE_ASPECT_RATIO,
  resolveCarouselImageAspectRatio,
  FLEX_IMAGE_CAROUSEL_ASPECT_OPTIONS,
  DEFAULT_FLEX_IMAGE_CAROUSEL_ASPECT_RATIO,
  resolveFlexImageCarouselAspectRatio,
} from '~~/shared/line-image-spec'
import { loadImageNaturalSize, loadVideoNaturalSize, simplifyAspectRatio } from '~~/shared/media-preview'
import {
  createRichMessageActions,
  normalizeRichMessageActions,
  richMessageEditorActionsOverlap,
  RICH_MESSAGE_MIN_BOUNDS,
} from '~~/shared/rich-message-editor-helpers'
import {
  MODULE_TYPE_LABELS,
  WORKSPACE_FLOW_MODULE_TYPES,
  type ModuleType,
} from '~~/shared/types/conversation-stats'

definePageMeta({ middleware: 'auth', layout: 'default' })

/** flow 物件多為動態型別（any），統一在此收斂 moduleType → 顯示標籤 */
function moduleTypeLabel(raw: unknown): string {
  return MODULE_TYPE_LABELS[raw as ModuleType] ?? '機器人流程'
}

const { apiFetch, workspaceId, currentWorkspaceName } = useWorkspace()
const previewOpen = ref(true)
const { canOperate, guardOperate } = useAdminOperateGuard()

// ── State ─────────────────────────────────────────────
const richMessages = ref<any[]>([])
const {
  allFlows,
  flows,
  modulePickerOptions,
  loading,
  loadingMore,
  listEl,
  load: loadFlows,
  onScroll: onSidebarListScroll,
  setRegularFlowsOrder,
} = useFlowWorkspaceList()
const saving = ref(false)
const duplicating = ref(false)
const seeding = ref(false)
const selectedId = ref<string | null>(null)
const isCreating = ref(false)
const FLOW_MESSAGE_LIMIT = 5
const { showToast } = useAdminToast()
const { tags: allTags, loadTags } = useAdminTagList()

// Drag and Drop State
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

// Carousel column Drag and Drop State
const colDragMsgIndex = ref<number | null>(null)
const colDragIndex = ref<number | null>(null)
const colDragOverIndex = ref<number | null>(null)

// Quick Reply Drag and Drop State
const qrDragMsgIndex = ref<number | null>(null)
const qrDragIndex = ref<number | null>(null)
const qrDragOverIndex = ref<number | null>(null)

// Sidebar flow list drag and drop（重排序 — 只對未分類有用）
const flowListDragIndex = ref<number | null>(null)
const flowListDragOverIndex = ref<number | null>(null)

// ── Flow Folder state ─────────────────────────────
interface FlowFolderRow {
  id: string
  name: string
  order: number
  createdAtMs: number
}
const flowFolders = ref<FlowFolderRow[]>([])
const flowExpandedFolders = ref<Set<string>>(new Set())
const FLOW_FOLDER_LS_KEY = computed(() => `flow-folders-expanded:${workspaceId.value}`)

function loadFlowFolderExpandedState() {
  try {
    const raw = localStorage.getItem(FLOW_FOLDER_LS_KEY.value)
    if (raw) flowExpandedFolders.value = new Set(JSON.parse(raw) as string[])
  }
  catch { /* 沒有就空集合，後續第一次載入時全展開 */ }
}
function saveFlowFolderExpandedState() {
  try { localStorage.setItem(FLOW_FOLDER_LS_KEY.value, JSON.stringify([...flowExpandedFolders.value])) }
  catch { /* */ }
}
function isFlowFolderExpanded(id: string) { return flowExpandedFolders.value.has(id) }
function toggleFlowFolder(id: string) {
  if (flowExpandedFolders.value.has(id)) flowExpandedFolders.value.delete(id)
  else flowExpandedFolders.value.add(id)
  flowExpandedFolders.value = new Set(flowExpandedFolders.value)
  saveFlowFolderExpandedState()
}

// 拖曳：把 flow 拖到 folder
const draggedFlowId = ref<string | null>(null)
const dragOverFolderId = ref<string | null>(null)

const isDraggingFromFolder = computed(() => {
  if (!draggedFlowId.value) return false
  const flow = flows.value.find(f => f.id === draggedFlowId.value)
  return !!(flow as any)?.folderId
})

// Folder edit modal
const flowFolderEditOpen = ref(false)
const flowFolderEditTarget = ref<FlowFolderRow | null>(null)
const flowFolderForm = ref({ name: '' })
const flowFolderSaving = ref(false)
const flowFolderDeleting = ref(false)

const messageRenderKeys = new WeakMap<object, string>()
let messageRenderKeySeq = 0

function getMessageRenderKey(msg: any, index: number) {
  if (msg && typeof msg === 'object') {
    const target = msg as object
    let key = messageRenderKeys.get(target)
    if (!key) {
      key = `msg-${messageRenderKeySeq++}`
      messageRenderKeys.set(target, key)
    }
    return key
  }
  return `msg-fallback-${index}`
}

function resolveDraggedIndex(e: DragEvent, fallback: number | null) {
  if (fallback !== null) return fallback
  const raw = e.dataTransfer?.getData('text/plain')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) ? parsed : null
}

const defaultForm = () => ({
  name: '',
  messages: [] as any[],
  moduleType: 'bot_flow' as ModuleType,
})
const form = ref(defaultForm())
const { markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
})

const selectedFlow = computed(() => flows.value.find(f => f.id === selectedId.value) ?? null)
const systemFlows = computed(() => flows.value.filter((f) => f.isSystem))
const regularFlows = computed(() => flows.value.filter((f) => !f.isSystem))

// ── 資料夾分組 ─────────────────────────────────────
const uncategorizedFlows = computed(() => regularFlows.value.filter(f => !(f as any).folderId))
const flowsByFolder = computed(() => {
  const map: Record<string, typeof regularFlows.value> = {}
  for (const f of regularFlows.value) {
    const fid = (f as any).folderId
    if (!fid) continue
    if (!map[fid]) map[fid] = [] as any
    map[fid]!.push(f)
  }
  return map
})
const flowCountByFolder = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const folder of flowFolders.value) m[folder.id] = (flowsByFolder.value[folder.id] ?? []).length
  return m
})
function regularFlowIndex(id: string): number {
  return regularFlows.value.findIndex(f => f.id === id)
}
const isSystemFlow = computed(() => selectedFlow.value?.isSystem === true)
const BUILTIN_VARIABLE_LABELS: Record<string, string> = {
  displayName: '聯絡人名稱（使用者名字）',
}
const attributeOptions = computed(() => {
  const values = new Set<string>()

  const collectAttributes = (messages: any[]) => {
    for (const msg of (messages ?? [])) {
      const rawAttr = msg?.type === 'userInput' ? msg?.attribute : ''
      const attr = typeof rawAttr === 'string' ? rawAttr.trim() : ''
      if (attr) values.add(attr)
    }
  }

  collectAttributes(form.value.messages)
  for (const flow of flows.value) {
    collectAttributes(flow?.messages ?? [])
  }

  return Array.from(values).map((value) => ({
    value,
    label: value,
  }))
})
const variableTokenOptions = computed(() => {
  const values = new Set<string>(['displayName'])

  const collectAttributes = (messages: any[]) => {
    for (const msg of (messages ?? [])) {
      const rawAttr = msg?.type === 'userInput' ? msg?.attribute : ''
      const attr = typeof rawAttr === 'string' ? rawAttr.trim() : ''
      if (attr) values.add(attr)
    }
  }

  collectAttributes(form.value.messages)
  for (const flow of flows.value) {
    collectAttributes(flow?.messages ?? [])
  }

  return Array.from(values).map((value) => ({
    value,
    label: BUILTIN_VARIABLE_LABELS[value] ?? value,
    token: `{{${value}}}`,
  }))
})

function insertVariableToken(target: Record<string, any>, key: string, token: string) {
  const current = typeof target[key] === 'string' ? target[key] : ''
  target[key] = `${current}${token}`
}

// 訊息類型可用性開關（共用於教學 agent，讓不可用功能的教學自動隱藏）
const { showLegacyImageCarousel, showLegacyCarousel, showUserInput, showUserInputAttribute } = useFlowFeatures()

// ── Badge helpers ─────────────────────────────────────
const MSG_META: Record<string, { label: string; badge: string }> = {
  text:          { label: '文字訊息',  badge: 'badge-blue'   },
  image:         { label: '圖片訊息', badge: 'badge-orange' },
  video:         { label: '影片訊息', badge: 'badge-gray'   },
  richMessage:   { label: '圖文訊息', badge: 'badge-green'  },
  richMessageRef:{ label: '圖文訊息(舊)', badge: 'badge-green'  },
  carousel:      { label: '輪播（舊）', badge: 'badge-green'  },
  imageCarousel:     { label: '圖片輪播',      badge: 'badge-gray'   },
  flexImageCarousel: { label: '輪播訊息', badge: 'badge-purple' },
  quickReply:    { label: '快速回覆', badge: 'badge-purple' },
  userInput:     { label: '用戶輸入卡片', badge: 'badge-red' },
}

const standardActionTypeOptions = [
  { value: 'uri', label: '開網址' },
  { value: 'message', label: '傳文字' },
  { value: 'module', label: '觸發模組' },
]

const quickReplyActionTypeOptions = [
  { value: 'message', label: '傳送文字' },
  { value: 'uri', label: '開啟網址' },
  { value: 'module', label: '觸發模組' },
]

const imageCarouselActionTypeOptions = [
  { value: 'none', label: '未有行動' },
  { value: 'uri', label: '開啟網址' },
  { value: 'message', label: '傳送文字' },
  { value: 'module', label: '觸發模組' },
]

function msgTypeLabel(type: string) {
  return MSG_META[type]?.label ?? type
}

function msgBadgeClass(type: string) {
  return MSG_META[type]?.badge ?? 'badge-gray'
}

function isCarouselType(type: string) {
  return type === 'carousel' || type === 'imageCarousel' || type === 'flexImageCarousel'
}

// ── Load ──────────────────────────────────────────────
async function loadRichMessages() {
  const list = await apiFetch<any[]>('/api/rich-message/list').catch(() => [])
  richMessages.value = (list ?? []).map((item) => normalizeRichMessageItem(item))
  form.value.messages = normalizeMessages(form.value.messages)
}

onMounted(async () => {
  loadFlowFolderExpandedState()
  await Promise.all([
    loadFlows(true),
    loadRichMessages(),
    loadTags({ status: 'active' }),
    loadFlowFolders(),
  ])
})

// ── Flow Folder CRUD ─────────────────────────────────
async function loadFlowFolders() {
  try {
    const res = await apiFetch<{ items: FlowFolderRow[] }>('/api/flow-folders')
    flowFolders.value = res.items ?? []
    // 第一次載入：所有資料夾預設展開（之後 toggle 會覆寫 localStorage）
    if (!flowExpandedFolders.value.size) {
      const init = new Set<string>()
      for (const f of flowFolders.value) init.add(f.id)
      flowExpandedFolders.value = init
    }
  }
  catch { flowFolders.value = [] }
}

async function createFlowFolderPrompt() {
  try {
    const { value } = await ElMessageBox.prompt('輸入資料夾名稱：', '新資料夾', {
      confirmButtonText: '建立',
      cancelButtonText: '取消',
      inputPlaceholder: '例：行銷活動',
      inputPattern: /^.{1,50}$/,
      inputErrorMessage: '名稱長度需 1–50 字',
    })
    const name = String(value ?? '').trim()
    if (!name) return
    const folder = await apiFetch<FlowFolderRow>('/api/flow-folders', { method: 'POST', body: { name } })
    flowFolders.value = [...flowFolders.value, folder]
    flowExpandedFolders.value = new Set([...flowExpandedFolders.value, folder.id])
    saveFlowFolderExpandedState()
    showToast('已建立資料夾', 'success')
  }
  catch { /* 使用者取消 */ }
}

function openFlowFolderEdit(folder: FlowFolderRow) {
  flowFolderEditTarget.value = folder
  flowFolderForm.value = { name: folder.name }
  flowFolderEditOpen.value = true
}

async function saveFlowFolderName() {
  if (!flowFolderEditTarget.value) return
  const target = flowFolderEditTarget.value
  const newName = flowFolderForm.value.name.trim()
  if (!newName || newName === target.name) return
  flowFolderSaving.value = true
  try {
    const res = await apiFetch<FlowFolderRow>(`/api/flow-folders/${target.id}`, {
      method: 'PUT',
      body: { name: newName },
    })
    const idx = flowFolders.value.findIndex(f => f.id === target.id)
    if (idx >= 0) flowFolders.value[idx] = res
    showToast('已重新命名', 'success')
    flowFolderEditOpen.value = false
  }
  catch (err: any) {
    showToast(err?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    flowFolderSaving.value = false
  }
}

async function deleteFlowFolderFromModal() {
  if (!flowFolderEditTarget.value) return
  const target = flowFolderEditTarget.value
  const count = flowCountByFolder.value[target.id] ?? 0
  const msg = count
    ? `要刪除「${target.name}」這個資料夾嗎？\n底下的 ${count} 個模組會自動移到「未分類」，不會被刪除。`
    : `要刪除「${target.name}」這個空資料夾嗎？`
  try {
    await ElMessageBox.confirm(msg, '刪除資料夾', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  flowFolderDeleting.value = true
  try {
    await apiFetch(`/api/flow-folders/${target.id}`, { method: 'DELETE' })
    flowFolders.value = flowFolders.value.filter(f => f.id !== target.id)
    for (const f of flows.value) {
      if ((f as any).folderId === target.id) (f as any).folderId = null
    }
    showToast(count ? `已刪除資料夾，${count} 個模組已移至未分類` : '已刪除空資料夾', 'success')
    flowFolderEditOpen.value = false
  }
  catch (err: any) {
    showToast(err?.statusMessage || '刪除失敗', 'error')
  }
  finally {
    flowFolderDeleting.value = false
  }
}

// ── Unified flow drag entry：兩種拖法共用一個 dragstart ─────
// `index` 有值 → 是「未分類」可重排序的 row（沿用 onFlowListDrag* 反應）
// `index` null → 是「資料夾內」的 row，僅支援移到別的資料夾 / 拖出
function onFlowDragStart(e: DragEvent, flowId: string, index: number | null) {
  if (index !== null) onFlowListDragStart(e, index)
  else if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
    e.dataTransfer.setData('text/plain', flowId)
  }
  // dragstart 的同一個 frame 不能動到 DOM（「拖出資料夾」zone 是 v-if，
  // 立刻插入會讓 Chrome 直接取消這次拖曳），所以延後一個 frame 再設
  requestAnimationFrame(() => {
    draggedFlowId.value = flowId
  })
}
function onFlowDragEnd() {
  draggedFlowId.value = null
  dragOverFolderId.value = null
  onFlowListDragEnd()
}

// ── Folder header 拖曳排序（資料夾之間互換順序）──────
const draggedFolderId = ref<string | null>(null)
const folderReorderOverId = ref<string | null>(null)

function onFolderHeaderDragStart(e: DragEvent, folderId: string) {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', folderId)
  }
  // 同 onFlowDragStart：state 延後一個 frame，避免 dragstart 當下重繪取消拖曳
  requestAnimationFrame(() => {
    draggedFolderId.value = folderId
  })
}
function onFolderHeaderDragEnd() {
  draggedFolderId.value = null
  folderReorderOverId.value = null
}
async function reorderFlowFoldersTo(targetFolderId: string) {
  const fromId = draggedFolderId.value
  draggedFolderId.value = null
  folderReorderOverId.value = null
  if (!fromId || fromId === targetFolderId) return
  const next = [...flowFolders.value]
  const fromIndex = next.findIndex(f => f.id === fromId)
  const toIndex = next.findIndex(f => f.id === targetFolderId)
  if (fromIndex < 0 || toIndex < 0) return
  const previous = flowFolders.value
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved!)
  flowFolders.value = next
  try {
    await apiFetch('/api/flow-folders/reorder', {
      method: 'POST',
      body: { orderedIds: next.map(f => f.id) },
    })
  }
  catch (err: any) {
    flowFolders.value = previous
    showToast(err?.statusMessage || '資料夾排序儲存失敗', 'error')
  }
}

// ── Folder drop target handlers ─────────────────────
function onFlowFolderDragOver(folderId: string, ev: DragEvent) {
  if (draggedFolderId.value) {
    // 拖的是資料夾 → 在別的資料夾標頭上顯示「插入位置」
    if (folderId !== '__none__' && folderId !== draggedFolderId.value) {
      folderReorderOverId.value = folderId
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    }
    return
  }
  if (!draggedFlowId.value) return
  dragOverFolderId.value = folderId
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
}
function onFlowFolderDragLeave(folderId: string) {
  if (dragOverFolderId.value === folderId) dragOverFolderId.value = null
  if (folderReorderOverId.value === folderId) folderReorderOverId.value = null
}
async function onFlowFolderDrop(folderId: string | null) {
  if (draggedFolderId.value) {
    if (folderId) await reorderFlowFoldersTo(folderId)
    return
  }
  const flowId = draggedFlowId.value
  dragOverFolderId.value = null
  draggedFlowId.value = null
  if (!flowId) return
  const flow = flows.value.find(f => f.id === flowId) as any
  if (!flow) return
  if ((flow.folderId ?? null) === folderId) return
  // 樂觀更新
  flow.folderId = folderId
  try {
    await apiFetch(`/api/flow/${flowId}`, {
      method: 'PUT',
      body: { folderId },
    })
  }
  catch (err: any) {
    showToast(err?.statusMessage || '搬移失敗', 'error')
    await loadFlows(true)
  }
}

// ── Sidebar flow list drag and drop ───────────────────
function onFlowListDragStart(e: DragEvent, index: number) {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
    e.dataTransfer.setData('text/plain', index.toString())
  }
  requestAnimationFrame(() => {
    flowListDragIndex.value = index
  })
}

function onFlowListDragEnd() {
  flowListDragIndex.value = null
  flowListDragOverIndex.value = null
}

function onFlowListDragOver(_e: DragEvent, index: number) {
  if (flowListDragIndex.value !== null) {
    flowListDragOverIndex.value = index
  }
}

function onFlowListDragLeave() {
  flowListDragOverIndex.value = null
}

async function onFlowListDrop(e: DragEvent, dropIndex: number) {
  e.preventDefault()
  if (!canOperate.value) return
  if (flowListDragIndex.value === null) return

  const fromIndex = resolveDraggedIndex(e, flowListDragIndex.value)
  flowListDragIndex.value = null
  flowListDragOverIndex.value = null
  if (fromIndex === null || fromIndex === dropIndex) return

  const movedId = regularFlows.value[fromIndex]?.id
  const targetId = regularFlows.value[dropIndex]?.id
  if (!movedId || !targetId) return

  await reorderRegularFlowById(movedId, targetId)
}

// 把 movedId 移到 targetId 的位置（全域 sortOrder；資料夾內排序也是走這套，
// 因為 folder 分組只是依 folderId 過濾、順序仍由 sortOrder 決定）
async function reorderRegularFlowById(movedId: string, targetId: string) {
  // 重排序要以完整清單為準：側邊欄是懶載入的，只動 visible 子集會讓
  // allFlows 被截斷、送出的 orderedIds 數量對不上後端而 400
  const previousFlows = [...allFlows.value]
  const allRegular = allFlows.value.filter((f) => !f.isSystem)
  const fullFromIndex = allRegular.findIndex((f) => f.id === movedId)
  const fullDropIndex = allRegular.findIndex((f) => f.id === targetId)
  if (fullFromIndex < 0 || fullDropIndex < 0) return

  const nextRegular = [...allRegular]
  const [moved] = nextRegular.splice(fullFromIndex, 1)
  nextRegular.splice(fullDropIndex, 0, moved)
  setRegularFlowsOrder(nextRegular)

  try {
    await apiFetch('/api/flow/reorder', {
      method: 'POST',
      body: { orderedIds: nextRegular.map((f) => f.id) },
    })
    await loadFlows(true)
  } catch {
    allFlows.value = previousFlows
    showToast('排序儲存失敗', 'error')
  }
}

// ── 資料夾內卡片排序：拖到同資料夾的另一張卡上 ──────
const folderRowDragOverId = ref<string | null>(null)

function draggedFlowFolderId(): string | null {
  if (!draggedFlowId.value) return null
  const flow = flows.value.find(f => f.id === draggedFlowId.value) as any
  return flow?.folderId ?? null
}

function onFolderRowDragOver(ev: DragEvent, folderId: string, flowId: string) {
  // 只接「同資料夾內排序」；跨資料夾搬移仍走資料夾標頭 / 拖出 zone
  if (!draggedFlowId.value || draggedFlowId.value === flowId) return
  if (draggedFlowFolderId() !== folderId) return
  folderRowDragOverId.value = flowId
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
}
function onFolderRowDragLeave(flowId: string) {
  if (folderRowDragOverId.value === flowId) folderRowDragOverId.value = null
}
async function onFolderRowDrop(folderId: string, targetFlowId: string) {
  const movedId = draggedFlowId.value
  folderRowDragOverId.value = null
  if (!canOperate.value) return
  if (!movedId || movedId === targetFlowId) return
  if (draggedFlowFolderId() !== folderId) return
  draggedFlowId.value = null
  await reorderRegularFlowById(movedId, targetFlowId)
}

// ── Select / Create ───────────────────────────────────
function normalizeWorkspaceModuleType(raw: ModuleType | undefined): ModuleType {
  return raw === 'system_notice' ? 'system_notice' : 'bot_flow'
}

function selectFlow(flow: any, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = flow.id
  const rawType = (flow.moduleType ?? 'bot_flow') as ModuleType
  form.value = {
    name: flow.name,
    messages: normalizeMessages(JSON.parse(JSON.stringify(flow.messages ?? []))),
    moduleType: flow.isSystem ? rawType : normalizeWorkspaceModuleType(rawType),
  }
  void hydrateMediaDimensionsInForm()
  markClean()
}

async function hydrateMediaDimensionsInForm() {
  for (const msg of form.value.messages) {
    if (msg?.type === 'richMessage') {
      await ensureRichMessageHeroDimensions(msg)
    }
    if (msg?.type === 'video') {
      await ensureVideoDimensions(msg)
    }
  }
}

async function seedSystemModules() {
  seeding.value = true
  try {
    const res = await apiFetch<{ results: { id: string; created: boolean }[] }>(
      '/api/admin/seed-system-modules',
      { method: 'POST' },
    )
    const created = res.results.filter(r => r.created).map(r => r.id)
    if (created.length) {
      showToast(`已建立系統模組：${created.join('、')}`, 'success')
    } else {
      showToast('系統模組已存在，無需重建', 'success')
    }
    await loadFlows(true)
  } catch {
    showToast('初始化失敗', 'error')
  } finally {
    seeding.value = false
  }
}

function openCreate() {
  guardOperate(() => {
    if (!confirmLeaveIfDirty()) return
    isCreating.value = true
    selectedId.value = null
    form.value = defaultForm()
    markClean()
  })
}

function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedFlow.value) {
    selectFlow(selectedFlow.value, { skipDiscardConfirm: true })
    isCreating.value = false
  } else {
    isCreating.value = false
    selectedId.value = null
    form.value = defaultForm()
    markClean()
  }
}

// ── Messages ──────────────────────────────────────────
function addMessage(type: string) {
  if (form.value.messages.length >= FLOW_MESSAGE_LIMIT) {
    showToast(`單一模組最多只能儲存 ${FLOW_MESSAGE_LIMIT} 則訊息`, 'error')
    return
  }
  if (type === 'userInput' && !showUserInput) return
  if (type === 'imageCarousel' && !showLegacyImageCarousel) return
  if (type === 'carousel' && !showLegacyCarousel) return

  if (type === 'text') {
    form.value.messages.push({ type: 'text', text: '', buttons: [] })
  } else if (type === 'image') {
    form.value.messages.push({ type: 'image', originalContentUrl: '', previewImageUrl: '' })
  } else if (type === 'video') {
    form.value.messages.push({
      type: 'video',
      originalContentUrl: '',
      previewImageUrl: '',
      videoWidth: undefined,
      videoHeight: undefined,
    })
  } else if (type === 'richMessage') {
    form.value.messages.push({
      type: 'richMessage',
      altText: '',
      transparentBackground: false,
      heroImageUrl: '',
      heroImageWidth: undefined,
      heroImageHeight: undefined,
      layoutId: 'single' as RichLayoutId,
      actions: createRichMessageActions('single'),
    })
  } else if (type === 'richMessageRef') {
    form.value.messages.push({
      type: 'richMessageRef',
      richMessageId: '',
      richMessageName: '',
    })
  } else if (type === 'carousel') {
    form.value.messages.push({
      type: 'carousel',
      altText: '',
      imageAspectRatio: DEFAULT_CAROUSEL_IMAGE_ASPECT_RATIO,
      columns: [newCarouselColumn()],
    })
  } else if (type === 'imageCarousel') {
    form.value.messages.push({
      type: 'imageCarousel',
      altText: '',
      columns: [newImageCarouselColumn()],
    })
  } else if (type === 'flexImageCarousel') {
    form.value.messages.push({
      type: 'flexImageCarousel',
      altText: '',
      enableImage: true,
      imageAspectRatio: DEFAULT_FLEX_IMAGE_CAROUSEL_ASPECT_RATIO,
      columns: [newFlexImageCarouselColumn()],
    })
  } else if (type === 'quickReply') {
    const existingIndex = form.value.messages.findIndex(m => m.type === 'quickReply' || m.type === 'userInput')
    if (existingIndex > -1) {
      showToast('每個流程只能有一張「快速回覆」或「用戶輸入卡片」', 'error')
      return
    }
    form.value.messages.push({
      type: 'quickReply',
      text: '',
      quickReplies: [newQuickReplyAction()]
    })
  } else if (type === 'userInput') {
    const existingIndex = form.value.messages.findIndex(m => m.type === 'quickReply' || m.type === 'userInput')
    if (existingIndex > -1) {
      showToast('每個流程只能有一張「快速回覆」或「用戶輸入卡片」', 'error')
      return
    }
    form.value.messages.push({
      type: 'userInput',
      text: '',
      attribute: '',
      moduleId: '',
      tagging: { enabled: false, addTagIds: [] },
    })
  }
}

// ── 教學示範橋接：tour 指定要示範哪種訊息，這裡在「只屬於示範的空白草稿」放一張那種卡 ──
// 安全原則：只在「沒有開任何模組」時自己開空白草稿示範；絕不動到既有/真實模組或使用者自己的草稿。
const { demoType: flowDemoType, demoNonce: flowDemoNonce } = useFlowDemo()
const flowDemoActive = ref(false)
function applyFlowDemo(type: string | null) {
  if (type == null) {
    // 結束示範：把示範草稿清空
    if (flowDemoActive.value && isCreating.value) {
      form.value.messages = []
      markClean()
    }
    flowDemoActive.value = false
    return
  }
  // 已在示範草稿中 → 直接換成新類型的卡
  if (flowDemoActive.value && isCreating.value) {
    form.value.messages = []
    addMessage(type)
    return
  }
  // 要進示範，但可能正在編輯別的模組／自己的草稿 → 先確認可離開（有未存變更會跳確認；不放棄就不開示範）
  if ((isCreating.value || selectedFlow.value) && !confirmLeaveIfDirty())
    return
  // 重設成空白示範草稿並放一張卡（含操作權限把關；沒權限則不動作）
  guardOperate(() => {
    isCreating.value = true
    selectedId.value = null
    form.value = defaultForm()
    markClean()
    flowDemoActive.value = true
    form.value.messages = []
    addMessage(type)
  })
}
// 監看 nonce（而非 demoType），確保「設成同一個類型」也會重放
watch(flowDemoNonce, () => applyFlowDemo(flowDemoType.value), { flush: 'post' })
// 進頁時若示範已被先觸發（startTopic 在導航後就 setDemo），補跑一次
onMounted(() => {
  if (flowDemoType.value)
    applyFlowDemo(flowDemoType.value)
})

function newCarouselColumn() {
  return {
    thumbnailImageUrl: '',
    title: '',
    text: '',
    actions: [newCarouselAction()],
  }
}

function newCarouselAction() {
  return { type: 'uri', label: '', uri: '', text: '', moduleId: '', tagging: { enabled: false, addTagIds: [] } }
}

function newImageCarouselColumn() {
  return {
    imageUrl: '',
    action: { type: 'none', uri: '', text: '', label: '', moduleId: '', tagging: { enabled: false, addTagIds: [] } },
  }
}

function newFlexImageCarouselColumn() {
  return {
    imageUrl: '',
    title: '',
    text: '',
    action: { type: 'none', uri: '', text: '', label: '', moduleId: '', tagging: { enabled: false, addTagIds: [] } },
    actions: [] as ReturnType<typeof newCarouselAction>[],
  }
}

function newQuickReplyAction() {
  return { imageUrl: '', action: { type: 'message', label: '', text: '', moduleId: '', tagging: { enabled: false, addTagIds: [] } } }
}

function normalizeRichMessageItem(item: any) {
  const layoutId = typeof item?.layoutId === 'string' ? item.layoutId : 'custom'
  const actions = Array.isArray(item?.actions)
    ? item.actions
    : Array.isArray(item?.buttons)
      ? item.buttons.map((btn: any, index: number) => ({
          slot: ACTION_SLOT_LABELS[index] || String.fromCharCode(65 + index),
          type: btn?.type === 'message' || btn?.type === 'module' ? btn.type : 'uri',
          uri: btn?.uri || '',
          text: btn?.text || '',
          moduleId: btn?.moduleId || '',
          tagging: {
            enabled: btn?.tagging?.enabled === true,
            addTagIds: Array.isArray(btn?.tagging?.addTagIds) ? btn.tagging.addTagIds : [],
          },
        }))
      : []
  return {
    id: item?.id || '',
    name: item?.name || '',
    layoutId,
    heroImageWidth: Number(item?.heroImageWidth) || undefined,
    heroImageHeight: Number(item?.heroImageHeight) || undefined,
    transparentBackground: Boolean(item?.transparentBackground),
    altText: item?.altText || '',
    heroImageUrl: item?.heroImageUrl || '',
    actions: actions.map((action: any, idx: number) => ({
      slot: action?.slot || ACTION_SLOT_LABELS[idx] || String.fromCharCode(65 + idx),
      type: action?.type === 'message' || action?.type === 'module' ? action.type : 'uri',
      uri: action?.uri || '',
      text: action?.text || '',
      moduleId: action?.moduleId || '',
    })),
  }
}

function richMessageLayoutLabel(layoutId: string) {
  const labels: Record<string, string> = {
    custom: '自訂',
    single: '滿版',
    splitV: '左右',
    splitH: '上下',
    grid4: '四宮格',
    tripleH: '三橫列',
    mix3: '上1下2',
    grid6: '六宮格',
  }
  return labels[layoutId] || '自訂'
}

function syncRichMessagePayload(msg: any) {
  const selected = richMessages.value.find(item => item.id === msg.richMessageId)
  if (!selected) {
    msg.richMessageName = ''
    return
  }
  msg.richMessageName = selected.name || ''
}

function onRichMessageRefChange(msg: any) {
  syncRichMessagePayload(msg)
}

function selectInlineRichMessageLayout(msg: any, layoutId: string) {
  const nextLayout = layoutId as RichLayoutId
  if (msg.layoutId === nextLayout) return
  msg.layoutId = nextLayout
  msg.actions = normalizeRichMessageActions(
    nextLayout,
    msg.actions || [],
    Number(msg.heroImageWidth) || undefined,
    Number(msg.heroImageHeight) || undefined,
  )
}

function applyRichMessageHeroSize(msg: any, size: { width: number; height: number }) {
  msg.heroImageWidth = size.width
  msg.heroImageHeight = size.height
  msg.actions = normalizeRichMessageActions(
    msg.layoutId || 'single',
    msg.actions || [],
    size.width,
    size.height,
  )
}

async function ensureRichMessageHeroDimensions(msg: any) {
  if (Number(msg?.heroImageWidth) > 0 && Number(msg?.heroImageHeight) > 0) return
  const url = String(msg?.heroImageUrl || '').trim()
  if (!url) return
  try {
    const size = await loadImageNaturalSize(url)
    applyRichMessageHeroSize(msg, size)
  }
  catch {
    /* ignore */
  }
}

function applyVideoSize(msg: any, size: { width: number; height: number }) {
  const rawW = Number(size?.width)
  const rawH = Number(size?.height)
  if (!(rawW > 0 && rawH > 0)) return
  const { width, height } = simplifyAspectRatio(rawW, rawH)
  msg.videoWidth = width
  msg.videoHeight = height
}

function videoPreviewFrameKey(msg: any) {
  const w = Number(msg?.videoWidth) || 0
  const h = Number(msg?.videoHeight) || 0
  return `${String(msg?.originalContentUrl || '')}:${w}x${h}`
}

function videoPreviewFrame(
  videoWidth: unknown,
  videoHeight: unknown,
  originalContentUrl: unknown,
) {
  if (!String(originalContentUrl || '').trim()) return 'natural' as const
  const rawW = Number(videoWidth)
  const rawH = Number(videoHeight)
  if (rawW > 0 && rawH > 0) {
    const { width, height } = simplifyAspectRatio(rawW, rawH)
    return { widthRatio: width, heightRatio: height, fit: 'cover' as const }
  }
  return { widthRatio: 16, heightRatio: 9, fit: 'cover' as const }
}

async function ensureVideoDimensions(msg: any) {
  if (Number(msg?.videoWidth) > 0 && Number(msg?.videoHeight) > 0) return
  const url = String(msg?.originalContentUrl || '').trim()
  if (!url) return
  try {
    const size = await loadVideoNaturalSize(url)
    applyVideoSize(msg, size)
  }
  catch {
    /* ignore */
  }
}

function carouselPreviewFrame(msg: any) {
  const { width, height } = resolveCarouselImageAspectRatio(msg?.imageAspectRatio)
  return { widthRatio: width, heightRatio: height, fit: 'cover' as const }
}

function richMessageRefPreview(msg: any) {
  const selected = richMessages.value.find(item => item.id === msg?.richMessageId)
  if (selected) return selected
  return msg?.payload ? normalizeRichMessageItem(msg.payload) : null
}

function addCarouselColumn(msg: any) {
  if (msg.columns.length < 10) msg.columns.push(newCarouselColumn())
}

function addImageCarouselColumn(msg: any) {
  if (msg.columns.length < 10) msg.columns.push(newImageCarouselColumn())
}

function addFlexImageCarouselColumn(msg: any) {
  if (msg.columns.length < 10) msg.columns.push(newFlexImageCarouselColumn())
}

function flexCarouselUsesImage(msg: any): boolean {
  return msg?.enableImage !== false
}

function flexImageCarouselPreviewFrame(msg: any) {
  const { widthRatio, heightRatio } = resolveFlexImageCarouselAspectRatio(msg?.imageAspectRatio)
  return { widthRatio, heightRatio, fit: 'cover' as const }
}

function addCarouselAction(col: any) {
  if (!col.actions) col.actions = []
  if (col.actions.length < 3) col.actions.push(newCarouselAction())
}

function removeCarouselAction(col: any, actionIndex: number) {
  if (!col.actions || col.actions.length <= 1) return
  col.actions.splice(actionIndex, 1)
}

function addFlexImageCarouselButton(col: any) {
  if (!col.actions) col.actions = []
  if (col.actions.length < 3) col.actions.push(newCarouselAction())
}

function removeFlexImageCarouselButton(col: any, actionIndex: number) {
  if (!col.actions) return
  col.actions.splice(actionIndex, 1)
}

async function removeMessage(i: number) {
  try {
    await ElMessageBox.confirm(`確定刪除第 ${i + 1} 則訊息？此動作無法復原。`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  form.value.messages.splice(i, 1)
}

async function removeColumn(msg: any, ci: number) {
  try {
    await ElMessageBox.confirm('確定刪除這一欄？此動作無法復原。', '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  msg.columns.splice(ci, 1)
}

// ── Buttons (text type) ───────────────────────────────
function addButton(msg: any) {
  if (!msg.buttons) msg.buttons = []
  if (msg.buttons.length >= 4) {
    showToast('最多只能新增 4 個按鈕', 'error')
    return
  }
  msg.buttons.push({ type: 'message', label: '', text: '', uri: '', moduleId: '', tagging: { enabled: false, addTagIds: [] } })
}

function removeButton(msg: any, bIdx: number) {
  if (msg.buttons) msg.buttons.splice(bIdx, 1)
}

// ── Quick Replies ─────────────────────────────────────
function addQuickReply(msg: any) {
  if (!msg.quickReplies) msg.quickReplies = []
  if (msg.quickReplies.length < 13) {
    msg.quickReplies.push(newQuickReplyAction())
  }
}

function removeQuickReply(msg: any, qi: number) {
  if (msg.quickReplies) msg.quickReplies.splice(qi, 1)
}

// ── Drag and Drop ─────────────────────────────────────
function onDragStart(e: DragEvent, i: number) {
  // dataTransfer must be set synchronously inside dragstart
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
    e.dataTransfer.setData('text/plain', i.toString())
  }
  // Delay the Vue reactive update that adds `dragging` class (with CSS transform).
  // Setting dragIndex.value synchronously triggers a Vue re-render which applies
  // transform: scale(0.98) to .carousel-block (align-self:stretch + overflow-x:auto).
  // Chrome detects this layout change mid-dragstart and cancels the drag operation.
  // Deferring to rAF ensures Chrome commits the drag before any DOM mutation occurs.
  requestAnimationFrame(() => {
    dragIndex.value = i
  })
}

function onDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

function onDragOver(_e: DragEvent, i: number) {
  if (dragIndex.value !== null) {
    dragOverIndex.value = i
  }
}


function onDragLeave() {
  dragOverIndex.value = null
}

function onDrop(e: DragEvent, dropIndex: number) {
  e.preventDefault()
  if (dragIndex.value === null) return
  const fromIndex = resolveDraggedIndex(e, dragIndex.value)
  if (fromIndex !== null && fromIndex !== dropIndex) {
    const item = form.value.messages.splice(fromIndex, 1)[0]
    form.value.messages.splice(dropIndex, 0, item)
  }
  dragIndex.value = null
  dragOverIndex.value = null
}

// ── Carousel Column Drag and Drop ──────────────────────────
function onColDragStart(e: DragEvent, msgIndex: number, colIndex: number) {
  colDragMsgIndex.value = msgIndex
  colDragIndex.value = colIndex
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
    e.dataTransfer.setData('text/plain', colIndex.toString())
  }
  setTimeout(() => {}, 0)
}

function onColDragOver(e: DragEvent, msgIndex: number, colIndex: number) {
  if (colDragMsgIndex.value === msgIndex) {
    colDragOverIndex.value = colIndex
  }
}

function onColDragLeave() {
  colDragOverIndex.value = null
}

function onColDragEnd() {
  colDragMsgIndex.value = null
  colDragIndex.value = null
  colDragOverIndex.value = null
}

function onColDrop(e: DragEvent, msgIndex: number, dropIndex: number) {
  e.preventDefault()
  if (colDragMsgIndex.value === null) return  // card-level drag: let event bubble to carousel-block
  e.stopPropagation()
  const fromIndex = resolveDraggedIndex(e, colDragIndex.value)
  if (colDragMsgIndex.value === msgIndex && fromIndex !== null && fromIndex !== dropIndex) {
    const columns = form.value.messages[msgIndex].columns
    const item = columns.splice(fromIndex, 1)[0]
    columns.splice(dropIndex, 0, item)
  }
  colDragMsgIndex.value = null
  colDragIndex.value = null
  colDragOverIndex.value = null
}

// ── Quick Reply Drag and Drop ──────────────────────────
function onQrDragStart(e: DragEvent, msgIndex: number, qrIndex: number) {
  qrDragMsgIndex.value = msgIndex
  qrDragIndex.value = qrIndex
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
    e.dataTransfer.setData('text/plain', qrIndex.toString())
  }
  setTimeout(() => {}, 0)
}

function onQrDragOver(e: DragEvent, msgIndex: number, qrIndex: number) {
  if (qrDragMsgIndex.value === msgIndex) {
    qrDragOverIndex.value = qrIndex
  }
}

function onQrDragLeave() {
  qrDragOverIndex.value = null
}

function onQrDragEnd() {
  qrDragMsgIndex.value = null
  qrDragIndex.value = null
  qrDragOverIndex.value = null
}

function onQrDrop(e: DragEvent, msgIndex: number, dropIndex: number) {
  e.preventDefault()
  if (qrDragMsgIndex.value === null) return  // card-level drag: let event bubble to outer block
  e.stopPropagation()
  const fromIndex = resolveDraggedIndex(e, qrDragIndex.value)
  if (qrDragMsgIndex.value === msgIndex && fromIndex !== null && fromIndex !== dropIndex) {
    const qrArray = form.value.messages[msgIndex].quickReplies
    const item = qrArray.splice(fromIndex, 1)[0]
    qrArray.splice(dropIndex, 0, item)
  }
  qrDragMsgIndex.value = null
  qrDragIndex.value = null
  qrDragOverIndex.value = null
}

// ── Save / Delete ─────────────────────────────────────
async function submitForm() {
  if (!canOperate.value) {
    showToast('觀察者無法執行此操作', 'warning')
    return
  }
  if (!form.value.name) return showToast('請輸入模組名稱', 'error')
  if (!form.value.messages.length) return showToast('請至少新增一則回覆訊息', 'error')
  if (form.value.messages.length > FLOW_MESSAGE_LIMIT) {
    return showToast(`單一模組最多只能儲存 ${FLOW_MESSAGE_LIMIT} 則訊息`, 'error')
  }

  form.value.messages = normalizeMessages(form.value.messages)
  const validationError = validateMessages(form.value.messages)
  if (validationError) return showToast(validationError, 'error')

  saving.value = true
  try {
    if (isCreating.value) {
      const res = await apiFetch<any>('/api/flow/create', {
        method: 'POST',
        body: {
          name: form.value.name,
          messages: form.value.messages,
          isActive: true,
          moduleType: form.value.moduleType,
        },
      })
      showToast('模組已建立', 'success')
      await loadFlows(true)
      const newFlow = flows.value.find(f => f.id === res.id) ?? flows.value[0]
      if (newFlow) selectFlow(newFlow, { skipDiscardConfirm: true })
      isCreating.value = false
    } else {
      await apiFetch(`/api/flow/${selectedId.value}`, {
        method: 'PUT',
        body: {
          name: form.value.name,
          messages: form.value.messages,
          isActive: true,
          // Only allow moduleType change for non-system flows
          ...(!isSystemFlow.value ? { moduleType: form.value.moduleType } : {}),
        },
      })
      showToast('模組已更新', 'success')
      await loadFlows(true)
      markClean()
    }
  } catch (error: any) {
    showToast(error?.data?.statusMessage || '儲存失敗', 'error')
  } finally {
    saving.value = false
  }
}

// 右上「⋯」選單：複製 / 刪除
function onHeaderCommand(cmd: string | number | object) {
  if (cmd === 'duplicate') void duplicateFlow()
  else if (cmd === 'delete') void deleteFlow()
}

async function deleteFlow() {
  if (!canOperate.value) return showToast('觀察者無法執行此操作', 'warning')
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(`確定刪除「${form.value.name}」？`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/flow/${selectedId.value}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    selectedId.value = null
    form.value = defaultForm()
    markClean()
    await loadFlows(true)
  } catch {
    showToast('刪除失敗', 'error')
  }
}

async function duplicateFlow() {
  if (!canOperate.value) return showToast('觀察者無法執行此操作', 'warning')
  const sourceName = form.value.name.trim()
  if (!sourceName) return showToast('請輸入模組名稱', 'error')

  const messages = normalizeMessages(form.value.messages)
  if (!messages.length) return showToast('請至少新增一則回覆訊息', 'error')
  if (messages.length > FLOW_MESSAGE_LIMIT) {
    return showToast(`單一模組最多只能儲存 ${FLOW_MESSAGE_LIMIT} 則訊息`, 'error')
  }

  const validationError = validateMessages(messages)
  if (validationError) return showToast(validationError, 'error')

  const moduleType = isSystemFlow.value
    ? 'bot_flow'
    : normalizeWorkspaceModuleType(form.value.moduleType)

  duplicating.value = true
  try {
    const res = await apiFetch<any>('/api/flow/create', {
      method: 'POST',
      body: {
        name: `${sourceName} (複製)`,
        messages,
        isActive: true,
        moduleType,
      },
    })
    showToast('模組已複製', 'success')
    await loadFlows(true)
    const newFlow = flows.value.find(f => f.id === res.id) ?? flows.value[0]
    if (newFlow) selectFlow(newFlow, { skipDiscardConfirm: true })
  } catch (error: any) {
    showToast(error?.data?.statusMessage || '複製失敗', 'error')
  } finally {
    duplicating.value = false
  }
}

function normalizeMessages(messages: any[]) {
  return (messages ?? []).map((msg) => {
    if (msg.type === 'quickReply') {
      return {
        ...msg,
        text: msg.text || '',
        quickReplies: Array.isArray(msg.quickReplies) && msg.quickReplies.length > 0 ? msg.quickReplies : [newQuickReplyAction()]
      }
    }

    if (msg.type === 'userInput') {
      return {
        ...msg,
        text: msg.text || '',
        attribute: msg.attribute || '',
        moduleId: msg.moduleId || '',
        tagging: {
          enabled: msg?.tagging?.enabled === true,
          addTagIds: Array.isArray(msg?.tagging?.addTagIds)
            ? msg.tagging.addTagIds.map((v: unknown) => String(v || '').trim()).filter(Boolean)
            : [],
        },
      }
    }

    if (msg.type === 'richMessage') {
      const rawLayout = (msg.layoutId as string) || 'single'
      const layoutId = RICH_LAYOUT_PRESETS.some((p) => p.id === rawLayout)
        ? (rawLayout as RichLayoutId)
        : 'single'
      return {
        ...msg,
        altText: msg.altText || '',
        transparentBackground: Boolean(msg.transparentBackground),
        heroImageWidth: Number(msg.heroImageWidth) || undefined,
        heroImageHeight: Number(msg.heroImageHeight) || undefined,
        heroImageUrl: msg.heroImageUrl || '',
        layoutId,
        actions: normalizeRichMessageActions(
          layoutId,
          Array.isArray(msg.actions) && msg.actions.length > 0
            ? msg.actions
            : createRichMessageActions(
                layoutId,
                Number(msg.heroImageWidth) || undefined,
                Number(msg.heroImageHeight) || undefined,
              ),
          Number(msg.heroImageWidth) || undefined,
          Number(msg.heroImageHeight) || undefined,
        ),
      }
    }

    if (msg.type === 'carousel') {
      return {
        ...msg,
        imageAspectRatio: msg.imageAspectRatio === 'square' ? 'square' : 'rectangle',
      }
    }

    if (msg.type === 'richMessageRef') {
      const selected = richMessages.value.find(item => item.id === msg.richMessageId)
      const { payload: _legacyPayload, ...rest } = msg || {}
      return {
        ...rest,
        richMessageId: msg.richMessageId || '',
        richMessageName: msg.richMessageName || selected?.name || '',
      }
    }

    if (msg.type === 'flexImageCarousel') {
      const columns = Array.isArray(msg.columns) ? msg.columns : []
      const aspectIds = FLEX_IMAGE_CAROUSEL_ASPECT_OPTIONS.map(o => o.id)
      return {
        ...msg,
        enableImage: msg.enableImage !== false,
        imageAspectRatio: aspectIds.includes(msg.imageAspectRatio)
          ? msg.imageAspectRatio
          : DEFAULT_FLEX_IMAGE_CAROUSEL_ASPECT_RATIO,
        columns: columns.map((col: any) => ({
          ...col,
          title: col?.title ?? '',
          text: col?.text ?? '',
          action: col?.action ?? {
            type: 'none',
            uri: '',
            text: '',
            label: '',
            moduleId: '',
            tagging: { enabled: false, addTagIds: [] },
          },
          actions: Array.isArray(col?.actions) ? col.actions : [],
        })),
      }
    }

    if (msg.type === 'carousel') {
      const columns = Array.isArray(msg.columns) ? msg.columns : []
      return {
        ...msg,
        columns: columns.map((col: any) => ({
          ...col,
          actions: Array.isArray(col?.actions) && col.actions.length > 0
            ? col.actions
            : [newCarouselAction()],
        })),
      }
    }

    return msg
  })
}

function validateMessages(messages: any[]): string | null {
  if (messages.length > FLOW_MESSAGE_LIMIT) return `單一模組最多只能儲存 ${FLOW_MESSAGE_LIMIT} 則訊息`

  const qrCount = messages.filter((m: any) => m.type === 'quickReply').length
  const uiCount = messages.filter((m: any) => m.type === 'userInput').length

  if (qrCount > 1) return '快速回覆模組：每個流程只能有一個'
  if (uiCount > 1) return '用戶輸入卡片：每個流程只能有一張'
  if (qrCount > 0 && uiCount > 0) return '不能同時設定「快速回覆」與「用戶輸入卡片」'

  const lastMsg = messages[messages.length - 1]
  if (uiCount > 0 && lastMsg?.type !== 'userInput') return '用戶輸入卡片必須放在所有訊息的最結尾'

  for (const [msgIdx, msg] of (messages ?? []).entries()) {
    // 每則訊息的驗證包成 IIFE，回傳的錯誤自動帶上「第 N 則」位置，方便定位
    const perMessageError = ((): string | null => {
    // text message optional buttons, but if a button exists it must be complete
    if (msg?.type === 'text' && Array.isArray(msg.buttons)) {
      for (const btn of msg.buttons) {
        if (!btn.label) return '文字模組：請輸入按鈕標題'
        if (btn.type === 'message' && !btn.text) return '文字模組：請輸入按鈕傳送文字'
        if (btn.type === 'uri' && !btn.uri) return '文字模組：請輸入按鈕網址'
        if (btn.type === 'module' && !btn.moduleId) return '文字模組：請選擇要觸發的機器人模組'
        if (btn?.tagging?.enabled === true && (!Array.isArray(btn?.tagging?.addTagIds) || btn.tagging.addTagIds.length === 0)) {
          return '文字模組：已啟用貼標，請至少選擇一個標籤'
        }
      }
    }

    // Validate quick replies
    if (msg?.type === 'quickReply') {
      if (!msg.text?.trim()) return '快速回覆模組：搭配的文字內容為必填'
      if (!Array.isArray(msg.quickReplies) || msg.quickReplies.length < 1) {
        return '快速回覆模組：至少要有 1 個快速回覆選項'
      }
      if (msg.quickReplies.length > 13) return '快速回覆模組：最多 13 個快速回覆選項'

      if (Array.isArray(msg.quickReplies)) {
        for (const qr of msg.quickReplies) {
          if (!qr.action?.label?.trim()) return '快速回覆：請輸入按鈕名稱'
          if (qr.action.type === 'message' && !qr.action?.text?.trim()) return '快速回覆：回覆文字不可為空'
          if (qr.action.type === 'uri' && !qr.action?.uri?.trim()) return '快速回覆：網址不可為空'
          if (qr.action.type === 'module' && !qr.action?.moduleId) return '快速回覆：請選擇要觸發的機器人模組'
          if (qr.action?.tagging?.enabled === true && (!Array.isArray(qr.action?.tagging?.addTagIds) || qr.action.tagging.addTagIds.length === 0)) {
            return '快速回覆：已啟用貼標，請至少選擇一個標籤'
          }
        }
      }
    }

    if (msg?.type === 'userInput') {
      if (!msg.text?.trim()) return '用戶輸入卡片：請輸入你的問題'
      if (msg.attribute?.trim() && !/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(msg.attribute.trim())) {
        return '用戶輸入卡片：儲存屬性名稱格式錯誤，請使用英文字母開頭，且只能包含英數與底線'
      }
      if (!msg.moduleId) return '用戶輸入卡片：請選擇等待回覆後要觸發的下一個模組'
      if (msg?.tagging?.enabled === true && (!Array.isArray(msg?.tagging?.addTagIds) || msg.tagging.addTagIds.length === 0)) {
        return '用戶輸入卡片：已啟用貼標，請至少選擇一個標籤'
      }
    }

    if (msg?.type === 'richMessage') {
      if (!msg.altText?.trim()) return '圖文訊息：請輸入提醒文字（Alt Text）'
      if (!msg.heroImageUrl) return '圖文訊息：請上傳背景圖片'
      if (!Array.isArray(msg.actions) || msg.actions.length < 1) return '圖文訊息：尚未設定任何動作區塊'
      if (msg.layoutId === 'custom') {
        if (richMessageEditorActionsOverlap(msg.actions)) {
          return '圖文訊息：自訂區域有重疊，請調整後再儲存'
        }
        for (const action of msg.actions) {
          const bounds = action.bounds
          if (!bounds) return `圖文訊息：區塊 ${action.slot} 缺少自訂區域範圍`
          if (bounds.width < RICH_MESSAGE_MIN_BOUNDS || bounds.height < RICH_MESSAGE_MIN_BOUNDS) {
            return `圖文訊息：區塊 ${action.slot} 區域尺寸過小`
          }
        }
      }
      for (const action of msg.actions) {
        const error = validateUnifiedAction({
          slot: action.slot || '',
          type: action.type === 'message' || action.type === 'module' ? action.type : 'uri',
          uri: action.uri || '',
          text: action.text || '',
          moduleId: action.moduleId || '',
          tagging: {
            enabled: action?.tagging?.enabled === true,
            addTagIds: Array.isArray(action?.tagging?.addTagIds) ? action.tagging.addTagIds : [],
          },
        })
        if (error) return `圖文訊息：區塊 ${action.slot} ${error}`
      }
    }

    if (msg?.type === 'richMessageRef') {
      if (!msg.richMessageId) return '圖文訊息：請選擇已建立的圖文訊息'
      const selected = richMessages.value.find((item) => item.id === msg.richMessageId)
      if (!selected) return '圖文訊息：找不到引用內容，請重新選擇'
      if (!selected.altText) {
        return '圖文訊息：引用內容不完整，請到圖文訊息管理補齊'
      }
      if (!selected.transparentBackground && !selected.heroImageUrl) return '圖文訊息：缺少背景圖片'
      if (!Array.isArray(selected.actions) || selected.actions.length < 1) return '圖文訊息：尚未定義任何動作'
      for (const action of selected.actions) {
        const error = validateUnifiedAction({
          slot: action.slot || '',
          type: action.type === 'message' || action.type === 'module' ? action.type : 'uri',
          uri: action.uri || '',
          text: action.text || '',
          moduleId: action.moduleId || '',
          tagging: {
            enabled: action?.tagging?.enabled === true,
            addTagIds: Array.isArray(action?.tagging?.addTagIds) ? action.tagging.addTagIds : [],
          },
        })
        if (error) return `圖文訊息：區塊 ${action.slot} ${error}`
      }
    }

    // carousel buttons are required by design and must be complete
    if (msg?.type === 'carousel' && Array.isArray(msg.columns)) {
      if (msg.columns.length < 1) return '輪播訊息：至少要有 1 個欄位'
      if (msg.columns.length > 10) return '輪播訊息：最多 10 個欄位'
      for (const col of msg.columns) {
        if (!col?.thumbnailImageUrl?.trim()) return '輪播訊息：每個欄位都需要縮圖'
        if (!col?.title?.trim()) return '輪播訊息：標題為必填'
        if (!Array.isArray(col?.actions) || col.actions.length < 1) {
          return '輪播訊息：每個欄位至少要有 1 個按鈕'
        }
        if (col.actions.length > 3) return '輪播訊息：每個欄位按鈕最多 3 個'
        for (const action of (col?.actions ?? [])) {
          if (!action?.label?.trim()) return '輪播按鈕文字為必填'
          if (action.type === 'uri' && !action?.uri?.trim()) return '輪播按鈕網址為必填'
          if (action.type === 'message' && !action?.text?.trim()) return '輪播按鈕傳送文字為必填'
          if (action.type === 'module' && !action?.moduleId) return '輪播：請選擇要觸發的機器人模組'
          if (action?.tagging?.enabled === true && (!Array.isArray(action?.tagging?.addTagIds) || action.tagging.addTagIds.length === 0)) {
            return '輪播：已啟用貼標，請至少選擇一個標籤'
          }
        }
      }
    }

    // image carousel action payload must be complete when action is enabled
    if (msg?.type === 'imageCarousel' && Array.isArray(msg.columns)) {
      if (msg.columns.length < 1) return '圖片輪播：至少要有 1 個欄位'
      if (msg.columns.length > 10) return '圖片輪播：最多 10 個欄位'
      for (const col of msg.columns) {
        if (!col?.imageUrl?.trim()) return '圖片輪播：每個欄位都需要圖片'
        const action = col?.action
        if (action?.type === 'uri') {
          if (!action?.label?.trim()) return '圖片輪播按鈕文字為必填'
          if (!action?.uri?.trim()) return '圖片輪播網址為必填'
        }
        if (action?.type === 'message') {
          if (!action?.label?.trim()) return '圖片輪播按鈕文字為必填'
          if (!action?.text?.trim()) return '圖片輪播傳送文字為必填'
        }
        if (action?.type === 'module') {
          if (!action?.label?.trim()) return '圖片輪播按鈕文字為必填'
          if (!action?.moduleId) return '圖片輪播：請選擇要觸發的機器人模組'
        }
        if (action?.tagging?.enabled === true && (!Array.isArray(action?.tagging?.addTagIds) || action.tagging.addTagIds.length === 0)) {
          return '圖片輪播：已啟用貼標，請至少選擇一個標籤'
        }
      }
    }

    if (msg?.type === 'flexImageCarousel' && Array.isArray(msg.columns)) {
      if (msg.columns.length < 1) return '輪播訊息：至少要有 1 個欄位'
      if (msg.columns.length > 10) return '輪播訊息：最多 10 個欄位'
      const enableImage = msg.enableImage !== false
      for (const col of msg.columns) {
        if (enableImage) {
          if (!col?.imageUrl?.trim()) return '輪播訊息：已開啟圖片，每個欄位都需要上傳圖片'
        }
        else if (!col?.title?.trim()) {
          return '輪播訊息：未開啟圖片時，每個欄位標題為必填'
        }
        const action = col?.action
        if (enableImage) {
          if (action?.type === 'uri' && !action?.uri?.trim()) return '輪播訊息：圖片動作網址為必填'
          if (action?.type === 'message' && !action?.text?.trim()) return '輪播訊息：圖片動作傳送文字為必填'
          if (action?.type === 'module' && !action?.moduleId) return '輪播訊息：請選擇圖片動作要觸發的機器人模組'
          if (action?.tagging?.enabled === true && (!Array.isArray(action?.tagging?.addTagIds) || action.tagging.addTagIds.length === 0)) {
            return '輪播訊息：已啟用貼標，請至少選擇一個標籤'
          }
        }
        if (Array.isArray(col?.actions)) {
          if (col.actions.length > 3) return '輪播訊息：每個欄位按鈕最多 3 個'
          for (const btn of col.actions) {
            if (!btn?.label?.trim()) return '輪播訊息：按鈕文字為必填'
            if (btn.type === 'uri' && !btn?.uri?.trim()) return '輪播訊息：按鈕網址為必填'
            if (btn.type === 'message' && !btn?.text?.trim()) return '輪播訊息：按鈕傳送文字為必填'
            if (btn.type === 'module' && !btn?.moduleId) return '輪播訊息：請選擇按鈕要觸發的機器人模組'
            if (btn?.tagging?.enabled === true && (!Array.isArray(btn?.tagging?.addTagIds) || btn.tagging.addTagIds.length === 0)) {
              return '輪播訊息：已啟用貼標，請至少選擇一個標籤'
            }
          }
        }
      }
    }
      return null
    })()
    if (perMessageError) return `第 ${msgIdx + 1} 則・${perMessageError}`
  }
  return null
}
</script>
