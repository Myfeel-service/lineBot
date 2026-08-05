<template>
  <AdminSplitLayout :is-empty="!selectedSource">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="kb-sources">你的資料</span>
      <!-- 工具列只留「加入知識」一顆主動作。原本 5 顆平鋪（含只有工程場景才按的「重新學習全部」）
           讓第一屏就要做五選一;次要與維護動作收進「⋯」 -->
      <div class="flex gap-1">
        <el-tooltip v-if="canEditKb" content="上傳檔案、貼網址或貼一段文字，AI 會自動整理" placement="bottom" :show-after="300">
          <el-button :icon="Upload" size="small" type="primary" plain data-tour="kb-import" @click="goImport">加入知識</el-button>
        </el-tooltip>
        <el-dropdown v-if="canEditKb || canEditSources || canEditFolders" trigger="click">
          <el-button size="small" plain>⋯</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <!-- 選單/按鈕用正式的功能動詞;白話留給說明文字(老闆 8/05:按鈕寫成口語句太過頭) -->
              <el-dropdown-item v-if="canEditKb" @click="openCreateManual">
                手動新增知識
              </el-dropdown-item>
              <el-dropdown-item v-if="canEditFolders" data-tour="kb-folder-new" @click="createFolderPrompt">
                新增資料夾
              </el-dropdown-item>
              <el-dropdown-item v-if="canEditSources" divided @click="openAliasDialog">
                產品名稱整理{{ aliasCandidateCount ? `（${aliasCandidateCount}）` : '' }}
              </el-dropdown-item>
              <!-- 全庫重新學習是工程維護動作（升級檢索方式後才需要），不該長在主工具列 -->
              <el-dropdown-item v-if="canReindexAll" :disabled="reindexingAll" @click="reindexAll">
                {{ reindexingAll ? '重新學習中⋯' : '重新學習全部知識（維護用）' }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <!-- 常駐提醒(老闆 8/05 要求):有事要處理時側欄一直顯示這一行,不只在選著資料時。
           點了回工作台;兩邊都是空的才不顯示——沒事可提醒。 -->
      <button
        v-if="workbenchBadge"
        type="button"
        class="src-workbench-link"
        @click="backToWorkbench"
      >
        <el-icon class="src-workbench-link__icon"><FirstAidKit /></el-icon>
        <span class="src-workbench-link__text">{{ workbenchBadge }}</span>
        <span class="src-workbench-link__arrow">→</span>
      </button>

      <!-- 全庫搜尋:補卡前先確認「這題是不是已經有卡了」,不用一份資料一份資料翻 -->
      <div class="src-search">
        <el-input
          v-model="searchKeyword"
          size="small"
          clearable
          placeholder="搜尋知識（標題 / 內容 / 問法）"
          :prefix-icon="Search"
        />
        <div v-if="searchLoading" class="src-search-loading">搜尋中…</div>
        <div v-else-if="searchResults" class="src-search-results">
          <!-- 搜尋不到不能是死路:問題已經打好了、也確認過沒有重複,這是最乾淨的補知識時機 -->
          <div v-if="!searchResults.length" class="src-search-empty">
            <span>沒有符合的知識——如果客人常問這題，可能就是該補的知識。</span>
            <el-button
              v-if="canEditKb"
              size="small"
              type="primary"
              plain
              @click="openPrefilledCreate(searchKeyword.trim())"
            >
              補進知識庫
            </el-button>
          </div>
          <button v-for="r in searchResults" :key="r.id" type="button" class="src-search-row" @click="openChunkById(r.id)">
            <span class="src-search-row__title">
              {{ r.title }}
              <!-- 「找到卡」不等於「AI 用得到」:學習失敗/已停用的卡要標出來,
                   否則會誤判「已經有這一條了、不用補」 -->
              <span v-if="r.status === 'failed'" class="badge badge-red">AI 沒學起來</span>
              <span v-else-if="r.status === 'disabled'" class="badge badge-gray">已停用</span>
              <span v-else-if="r.status === 'pending'" class="badge badge-yellow">處理中</span>
            </span>
            <span class="src-search-row__snippet">{{ r.snippet }}</span>
          </button>
          <p v-if="searchCountTruncated" class="src-search-foot">符合的知識較多，只列出前 {{ searchResults.length }} 筆。</p>
          <p v-if="searchTruncated" class="src-search-foot">知識較多，只搜尋了前面一部分。</p>
        </div>
      </div>

      <div v-if="loading && !sources.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!sources.length && !orphanCount" class="split-sidebar-empty">
        <span>還沒有任何資料</span>
        <p class="text-xs text-muted">放一份進來（檔案、網址、Google 試算表或一段文字），AI 就會從裡面找答案回覆客人。</p>
        <div v-if="canEditKb" class="flex gap-1" style="margin-top:8px;">
          <el-button :icon="Upload" size="small" type="primary" plain @click="goImport">加入知識</el-button>
        </div>
      </div>
      <div v-else class="split-list">
        <!-- 未分類資料（直接平鋪在最上方，沒有 header） -->
        <div
          v-for="src in uncategorizedSources"
          :key="src.id"
          class="flow-sidebar-row"
          :class="{ 'flow-sidebar-row--dragging': draggedSourceId === src.id }"
        >
          <span
            class="drag-handle flow-sidebar-drag-handle"
            draggable="true"
            aria-label="拖曳搬移"
            @dragstart.stop="onSourceDragStart(src.id, $event)"
            @dragend.stop="onSourceDragEnd"
          >⠿</span>
          <!-- data-tour 標在每一列：教學要示範「知識」「同步設定」時得先有選中的資料，
               導覽會點到第一個符合的（＝清單第一列）-->
          <AdminSplitListItem
            class="flow-sidebar-row__item"
            data-tour="kb-source-row"
            :title="src.name || '(未命名)'"
            :active="selectedId === src.id"
            time-in-title-row
            title-row-chip
            :chip-text="statusChipText(src)"
            :chip-tone="statusChipTone(src)"
            :meta-text="metaText(src)"
            :meta-truncate="true"
            @select="selectSource(src)"
          />
        </div>

        <!-- 「移出資料夾」drop zone：只在拖曳「資料夾內」的知識時才出現 -->
        <div
          v-if="isDraggingFromFolder"
          class="src-unfolder-zone"
          :class="{ 'src-unfolder-zone--drop': dragOverFolderId === '__none__' }"
          @dragover.prevent="onFolderDragOver('__none__', $event)"
          @dragleave="onFolderDragLeave('__none__')"
          @drop.prevent="onFolderDrop(null)"
        >
          拖到這裡 = 移出資料夾
        </div>

        <!-- 每個資料夾 -->
        <template v-for="folder in folders" :key="folder.id">
          <div
            class="src-folder-header"
            :class="{
              'src-folder-header--drop': dragOverFolderId === folder.id,
              'src-folder-header--dragging': draggedFolderId === folder.id,
              'src-folder-header--reorder-over': folderReorderOverId === folder.id && draggedFolderId !== folder.id,
            }"
            @click="toggleFolder(folder.id)"
            @dragover.prevent="onFolderDragOver(folder.id, $event)"
            @dragleave="onFolderDragLeave(folder.id)"
            @drop.prevent="onFolderDrop(folder.id)"
          >
            <span
              class="drag-handle flow-sidebar-drag-handle src-folder-drag-handle"
              draggable="true"
              aria-label="拖曳排序資料夾"
              @click.stop
              @dragstart.stop="onFolderHeaderDragStart($event, folder.id)"
              @dragend.stop="onFolderHeaderDragEnd"
            >⠿</span>
            <span class="src-folder-label">
              <span class="src-folder-arrow">{{ isExpanded(folder.id) ? '▾' : '▸' }}</span>
              <el-icon><Folder /></el-icon> {{ folder.name }}
              <span class="src-folder-count">（{{ countByFolder[folder.id] ?? 0 }}）</span>
            </span>
            <span v-if="canEditFolders" class="src-folder-actions">
              <el-tooltip content="編輯資料夾" placement="top" :show-after="300">
                <button class="src-folder-icon-btn" @click.stop="openFolderEdit(folder)"><el-icon><EditPen /></el-icon></button>
              </el-tooltip>
            </span>
          </div>
          <template v-if="isExpanded(folder.id)">
            <div
              v-for="src in sourcesByFolder[folder.id] ?? []"
              :key="src.id"
              class="flow-sidebar-row src-row--in-folder"
              :class="{ 'flow-sidebar-row--dragging': draggedSourceId === src.id }"
            >
              <span
                class="drag-handle flow-sidebar-drag-handle"
                draggable="true"
                aria-label="拖曳搬移"
                @dragstart.stop="onSourceDragStart(src.id, $event)"
                @dragend.stop="onSourceDragEnd"
              >⠿</span>
              <AdminSplitListItem
                class="flow-sidebar-row__item"
                data-tour="kb-source-row"
                :title="src.name || '(未命名)'"
                :active="selectedId === src.id"
                time-in-title-row
                title-row-chip
                :chip-text="statusChipText(src)"
                :chip-tone="statusChipTone(src)"
                :meta-text="metaText(src)"
                :meta-truncate="true"
                @select="selectSource(src)"
              />
            </div>
            <div
              v-if="!(sourcesByFolder[folder.id] ?? []).length"
              class="src-folder-empty"
            >
              （資料夾為空；可從外面拖一筆過來）
            </div>
          </template>
        </template>
      </div>
    </template>

    <!-- ── 工作台(未選取資料時的右側大區) ── -->
    <!-- 「要處理的事」與「AI 建議」原本擠在 240px 側欄裡,每句說明都折成兩三行、
         資料清單被推到摺線以下;右邊這片大空間卻只放一段靜態說明。
         現在側欄回歸「搜尋+資料清單」,工作的事(異常+建議)放進來這裡——照使用者要做的事長。 -->
    <template #editor-empty>
      <div class="src-workbench">
        <div class="src-workbench__intro">
          <h3>這裡是 AI 回答客人的依據</h3>
          <p>
            你放進來的每一份資料（檔案、網址、Google 試算表、一段文字）都會由 AI 整理成一條條問答，
            客人問到相關問題時就用這些內容回答。<strong>沒放進來的事，AI 不會自己編。</strong>
          </p>
          <p class="text-muted src-workbench__tip">左邊點一份資料，可以看它整理出什麼、改內容、或設定自動更新。</p>
          <div v-if="canEditKb && !sources.length" class="src-workbench__cta">
            <el-button :icon="Upload" type="primary" @click="goImport">加入第一份資料</el-button>
          </div>
          <p v-if="!canEditKb" class="text-muted src-workbench__tip">（你的權限僅能檢視）</p>
        </div>

        <!--
          「要處理的事」單一收斂點。
          原本是三個各自為政的橫幅（AI 建議 / 舊版未分組知識 / 知識庫體檢六個 chip），
          視覺語言各不相同、使用者無從判斷哪個該先做。
          合成一份清單、照「會不會影響客人」排序：壞掉的先、建議次之、僅供參考最後。
          沿用右下角小幫手那套語言（結論先行 + 一句「不管它會怎樣」+ 一顆按鈕）。
          AI 建議的草稿要看內容，留在下方獨立區塊，不在這裡重複列一次。
        -->
        <div v-if="todoItems.length || healthExpiredCount" class="src-todo">
          <button type="button" class="src-todo__head" @click="todoOpen = !todoOpen">
            <el-icon class="src-todo__icon"><FirstAidKit /></el-icon>
            <span class="src-todo__title">
              <template v-if="todoItems.length">要處理的事（{{ todoItems.length }}）</template>
              <template v-else>目前沒有要處理的事</template>
            </span>
            <span class="src-todo__toggle">{{ todoOpen ? '▴' : '▾' }}</span>
          </button>

          <div v-show="todoOpen" class="src-todo__body">
            <div v-for="item in todoItems" :key="item.id" class="src-todo__item" :class="`is-${item.tone}`">
              <div class="src-todo__item-main">
                <span class="src-todo__item-title">{{ item.title }}</span>
                <span class="src-todo__item-why">{{ item.why }}</span>
              </div>
              <el-button size="small" plain :loading="item.loading" @click="item.action()">
                {{ item.cta }}
              </el-button>
            </div>

            <!-- 已過期停用＝功能正常運作的結果，不是待辦：灰階、排最後、不算進上方數字 -->
            <button
              v-if="healthExpiredCount"
              type="button"
              class="src-todo__muted"
              @click="openHealthList('expiredChunks')"
            >
              另有 {{ healthExpiredCount }} 張內容已過期自動停用（正常，不用處理）
            </button>
            <p v-if="health.chunkScanTruncated" class="src-todo__foot">
              內容較多，這份檢查只掃了其中一部分，實際數量可能更多。
            </p>
          </div>
        </div>

        <!-- 建議收件匣（草稿要看內容，維持獨立區塊）;count 讓側欄的工作台入口有數字可顯示 -->
        <KnowledgeSuggestions @accepted="loadSources(true)" @count="suggestCount = $event" />
      </div>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <div class="admin-flex-1">
        <AdminFieldLabel text="資料名稱" tight />
        <div class="admin-title-row">
          <el-input
            v-if="canEditSources"
            v-model="nameDraft"
            size="large"
            class="admin-title-input"
            placeholder="輸入資料名稱..."
            maxlength="200"
            @keydown.enter.prevent="commitName"
            @blur="commitName"
          />
          <span v-else class="split-editor-title">{{ selectedSource?.name || '(未命名資料)' }}</span>
        </div>
        <p class="text-sm text-muted admin-subtext src-header-caption">
          {{ typeEmoji(selectedSource?.type) }}<template v-if="selectedSource?.url"> · <a :href="selectedSource.url" target="_blank" rel="noopener">{{ selectedSource.url }}</a></template>
        </p>
      </div>
      <div v-if="canEditSources" class="flex gap-1 admin-header-actions">
        <el-button
          v-if="selectedSource?.type === 'url'"
          type="primary"
          plain
          data-tour="kb-resync"
          :loading="resyncing"
          @click="startResync()"
        >
          {{ resyncButtonLabel }}
        </el-button>
        <el-button v-if="resyncing" text @click="cancelResync">
          取消
        </el-button>
        <el-button
          v-if="selectedSource?.type === 'gsheet'"
          type="primary"
          plain
          data-tour="kb-resync"
          :loading="gsheetSyncing"
          @click="syncGsheetNow"
        >
          立即同步
        </el-button>
        <el-button :icon="Delete" type="danger" plain :loading="deleting" @click="deleteSource">
          刪除
        </el-button>
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <div v-if="selectedSource" class="solo-editor-body admin-panel-stack">
        <!-- 重新同步後確認「網頁沒變」:這是使用者按下按鈕後唯一的答覆,用面板不用 toast -->
        <el-alert
          v-if="resyncNoChange === selectedSource.id"
          type="success"
          show-icon
          :closable="true"
          class="src-outdated-alert"
          @close="resyncNoChange = null"
        >
          <template #title>
            網頁內容跟你上次整理的時候一模一樣
          </template>
          <div>
            剛剛重新抓了一次這個網址，內容逐字比對完全相同，所以沒有需要你決定的事，知識卡也不用動。
            <el-button text size="small" :loading="resyncing" @click="startResync(true)">
              還是要讓 AI 重新整理一次
            </el-button>
          </div>
        </el-alert>

        <!-- 偵測到變動的提示 -->
        <el-alert
          v-if="selectedSource.outdatedAtMs > 0"
          type="warning"
          show-icon
          :closable="false"
          class="src-outdated-alert"
        >
          <template #title>
            偵測到網頁內容變動 — {{ relativeTime(selectedSource.outdatedAtMs) }}
          </template>
          <div>
            最後一次自動偵測發現原始網址內容已改變，建議點上方「重新同步」檢視差異後決定要不要套用。
          </div>
        </el-alert>

        <!-- 基本資訊 -->
        <div class="message-card src-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">基本資訊</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="src-info-grid">
              <div><span class="src-label">類型</span><strong>{{ typeLabel(selectedSource.type) }}</strong></div>
              <div><span class="src-label">狀態</span><strong>{{ statusLabel(selectedSource.status) }}</strong></div>
              <div><span class="src-label">條數</span><strong>{{ selectedSource.chunkCount }}</strong></div>
              <div><span class="src-label">最後同步</span><strong>{{ selectedSource.lastFetchedAtMs ? relativeTime(selectedSource.lastFetchedAtMs) : '尚未同步' }}</strong></div>
            </div>
            <!-- 失敗要能就地修:原本只印一行後端原文,商家看不懂也修不了
                 (最常見的兩種原因,修的地方一個在 Google、一個是換網址) -->
            <div v-if="selectedSource.failureReason" class="src-fix">
              <p class="src-fix__title">⚠ 這份資料目前抓不到內容</p>
              <p class="src-fix__what">{{ failureAdvice.what }}</p>

              <!-- Google Sheet:最常見原因是沒分享給服務帳號 → email 直接放這裡可複製 -->
              <div v-if="failureAdvice.kind === 'gsheet'" class="src-fix__row">
                <code class="src-fix__email">{{ serviceAccountEmail || '讀取中⋯' }}</code>
                <el-button size="small" plain :disabled="!serviceAccountEmail" @click="copyServiceAccount">
                  複製帳號
                </el-button>
              </div>

              <!-- 網址:原網頁被搬走時可以直接改網址,不用刪掉重新匯入(會失去手動改過的內容) -->
              <div v-else-if="failureAdvice.kind === 'url' && canEditSources" class="src-fix__row">
                <el-input v-model="urlForm" size="small" placeholder="https://…" class="src-fix__input" />
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :loading="savingUrl"
                  :disabled="!urlForm.trim() || urlForm.trim() === selectedSource.url"
                  @click="saveSourceUrl"
                >
                  換成這個網址
                </el-button>
              </div>

              <p class="src-fix__raw">系統訊息：{{ selectedSource.failureReason }}</p>
            </div>
          </div>
        </div>

        <!-- 所屬產品（P1-1）：知識索引時自動繼承資料產品名；改動後自動重建該資料索引。
             gsheet 一列多產品不適用。 -->
        <div v-if="selectedSource.type !== 'gsheet'" class="message-card src-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">所屬產品</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="src-section-hint">
              這份資料的內容都在講<strong>同一個產品</strong>時才填（含品牌與型號）。知識會自動標上產品名——客人指名問哪一台、或 AI 反問「您指的是哪一個」時，靠它才不會答錯台。FAQ、公告這類多產品內容請留空。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="產品名" tight />
              <el-input
                v-model="productNameForm"
                :maxlength="60"
                placeholder="例：GPLUS 智慧除濕機 12L（留空 = 非單一產品）"
                class="control-full"
                :disabled="!canEditSources"
              />
            </div>
            <div v-if="canEditSources" class="src-settings-actions">
              <el-button
                type="primary"
                size="small"
                :loading="savingProductName"
                :disabled="productNameForm.trim() === productNameBaseline"
                @click="saveProductName"
              >
                儲存並重新學習
              </el-button>
              <span v-if="savingProductName" class="text-muted text-xs">正在讓 AI 重新學習這份資料的知識，約需幾十秒⋯</span>
            </div>
          </div>
        </div>

        <!-- 自動偵測設定（只給 URL） -->
        <div v-if="selectedSource.type === 'url'" class="message-card src-section-card" data-tour="kb-sync-settings">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">自動偵測變動</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="src-section-hint">
              排程會定期抓網頁內容、跟上次比對。<strong>小幅文字更新會自動套用並通知你</strong>（只更新原有知識的內容）；
              新增、刪除或大幅改版<strong>不會自動動</strong>，會在這裡標提示等你進來看差異再決定。
              你手動編輯過的卡永遠不會被自動覆蓋。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="偵測頻率" tight />
              <el-select v-model="settingsForm.refreshIntervalMinutes" class="control-full">
                <el-option label="不自動偵測（要更新時我自己按）" :value="0" />
                <el-option label="每小時" :value="60" />
                <el-option label="每天" :value="1440" />
                <el-option label="每週" :value="10080" />
                <el-option label="每月" :value="43200" />
              </el-select>
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="偵測到變動時" tight />
              <el-radio-group v-model="settingsForm.onChangeBehavior">
                <el-radio value="notify">通知我（在資料頁掛 提示）</el-radio>
                <el-radio value="log_only">只記錄不通知</el-radio>
              </el-radio-group>
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="小幅文字變動" tight />
              <el-radio-group v-model="settingsForm.urlAutoApply" :disabled="settingsForm.onChangeBehavior === 'log_only'">
                <el-radio :value="true">自動更新並通知我（建議）</el-radio>
                <el-radio :value="false">一律等我確認</el-radio>
              </el-radio-group>
              <p class="src-section-hint">
                只有「原有知識的文字被改動」才算小幅變動；新增、刪除知識或大幅改版一定會等你確認。
              </p>
            </div>
            <div v-if="canEditSources" class="src-settings-actions">
              <el-button
                type="primary"
                size="small"
                :loading="savingSettings"
                :disabled="!settingsDirty"
                @click="saveSettings"
              >
                儲存設定
              </el-button>
            </div>
          </div>
        </div>

        <!-- 自動同步設定（只給 Google Sheet）-->
        <div v-if="selectedSource.type === 'gsheet'" class="message-card src-section-card" data-tour="kb-sync-settings">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">自動同步</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="src-section-hint">
              排程會定期重讀這份 Sheet，<strong>一列一卡自動套用</strong>（新增/更新/刪除）。你在後台手動編輯過的卡會保留、不被覆蓋。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="同步頻率" tight />
              <el-select v-model="settingsForm.refreshIntervalMinutes" class="control-full">
                <el-option label="不自動同步（只手動）" :value="0" />
                <el-option label="每 30 分鐘" :value="30" />
                <el-option label="每小時" :value="60" />
                <el-option label="每天" :value="1440" />
                <el-option label="每週" :value="10080" />
                <el-option label="每月" :value="43200" />
              </el-select>
            </div>
            <div v-if="canEditSources" class="src-settings-actions">
              <el-button
                type="primary"
                size="small"
                :loading="savingSettings"
                :disabled="!settingsDirty"
                @click="saveSettings"
              >
                儲存設定
              </el-button>
            </div>
          </div>
        </div>

        <!-- 旗下 chunks -->
        <div class="message-card src-section-card" data-tour="kb-chunks">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">知識（{{ chunks.length }}）</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div v-if="detailLoading" class="src-chunk-loading"><div class="spinner" /></div>
            <p v-else-if="!chunks.length" class="text-muted">這份資料底下沒有知識。</p>
            <div v-else class="src-chunk-list">
              <div
                v-for="c in chunks"
                :key="c.id"
                :class="['src-chunk-row', c.status === 'disabled' && 'src-chunk-row--off']"
              >
                <div class="src-chunk-body">
                  <div class="src-chunk-main">
                    <span class="src-chunk-title">{{ c.title }}</span>
                    <span v-if="c.manuallyEditedAtMs > 0" class="src-chunk-lock" :title="`手動編輯過：${relativeTime(c.manuallyEditedAtMs)}`"><el-icon><Lock /></el-icon></span>
                    <span v-if="isShortChunk(c)" class="src-chunk-warn">內容過短</span>
                  </div>
                  <p class="src-chunk-preview">{{ chunkPreview(c) }}</p>
                  <span class="src-chunk-meta">
                    {{ c.content.length }} 字 · {{ chunkStatusLabel(c.status) }}<template v-if="c.status === 'disabled' && c.expiredAtMs">（{{ ymdLabel(c.expiredAtMs) }} 到期）</template><template v-if="c.status === 'indexed' && c.activeUntilMs"> · 有效至 {{ ymdLabel(c.activeUntilMs) }}</template> · {{ relativeTime(c.updatedAtMs) }}
                  </span>
                  <!-- 原本這句話只在滑鼠停留時出現:手機/平板完全看不到,而且沒說「多長才算夠」,
                       補了兩句話還是紅字也不知道差多少。改成看得見、並把門檻與差距講出來。 -->
                  <span v-if="isShortChunk(c)" class="src-chunk-warn-hint">
                    目前 {{ shortChunkChars(c) }} 字（空白不算），補到 {{ SHORT_CHUNK_CONTENT_CHARS }} 字以上 AI 才找得到；用不到的話可以直接刪掉。
                  </span>
                </div>
                <el-button v-if="canEditKb" :icon="EditPen" size="small" plain @click="openEditChunk(c)">編輯</el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <!-- ── 產品名稱整理:同一台的不同叫法,系統列候選、由人確認 ── -->
  <el-dialog
    v-model="aliasOpen"
    title="產品名稱整理"
    width="min(680px, 94vw)"
  >
    <p class="text-muted text-sm src-health-list-hint">
      同一台機器如果有兩種叫法（例：「上好ㄟ抽取式除濕機」和「NWT 威技 16L」），AI 會把它當成兩台，
      反問時要客人二選一、回答出貨時間還會並列成兩台。在這裡確認之後，AI 就知道它們是同一台。
      <strong>系統只負責找出可疑的組合，是不是同一台要由你判斷</strong>——同系列的不同型號（W1 REGEN 與 W1 REGEN ULTRA）看起來也很像，但不能合併。
    </p>

    <div v-if="aliasLoading" class="src-chunk-loading"><div class="spinner" /></div>
    <template v-else>
      <p v-if="!aliasCandidates.length" class="text-muted text-sm">
        目前沒有需要確認的組合。之後匯入新資料時若偵測到，這裡會再出現。
      </p>
      <div v-for="c in aliasCandidates" :key="c.key" class="src-alias-card">
        <div class="src-alias-pair">
          「{{ c.a }}」<span class="src-alias-eq">＝</span>「{{ c.b }}」？
          <!-- 型號風險優先於「證據明確」:兩者同時成立時只顯示綠標,等於在誘導使用者合併兩台不同機器 -->
          <span v-if="c.variantRisk" class="src-alias-tag is-risk">可能是不同型號</span>
          <span v-else-if="c.confidence === 'high'" class="src-alias-tag is-high">證據明確</span>
        </div>
        <p class="src-alias-reason">{{ c.reason }}</p>
        <div class="src-alias-actions">
          <el-button type="primary" size="small" :loading="aliasSaving === c.key" @click="decideAlias(c, 'confirm')">
            是同一台，合併
          </el-button>
          <el-button size="small" :loading="aliasSaving === c.key" @click="decideAlias(c, 'dismiss')">
            不是，兩台不同
          </el-button>
          <span class="text-muted text-xs">合併後會以「{{ c.a }}」為正式名稱</span>
        </div>
      </div>

      <div v-if="aliasPairs.length" class="src-alias-confirmed">
        <p class="section-title">已確認的對照（{{ aliasPairs.length }}）</p>
        <div v-for="p in aliasPairs" :key="p.aliasKey" class="src-alias-row">
          <span>「{{ p.alias }}」→ 「{{ p.canonical }}」</span>
          <el-button text size="small" :loading="aliasSaving === p.aliasKey" @click="undoAlias(p)">解除</el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <!-- ── 健康檢查清單 Modal:點分類 → 列出問題項目,點項目直達資料/知識 ── -->
  <el-dialog
    v-model="healthListOpen"
    :title="healthListTitle"
    width="min(560px, 92vw)"
  >
    <p class="text-muted text-sm src-health-list-hint">{{ healthListHint }}</p>
    <div class="src-health-list">
      <button
        v-for="item in healthListItems"
        :key="item.id"
        type="button"
        class="src-health-list-item"
        @click="gotoHealthItem(item)"
      >
        <span class="src-health-item-title">{{ item.title }}</span>
        <span v-if="item.meta" class="text-muted text-xs">{{ item.meta }}</span>
      </button>
    </div>
    <p v-if="healthListTruncatedNote" class="text-muted text-xs">{{ healthListTruncatedNote }}</p>
  </el-dialog>

  <!-- ── Diff Modal ──────────────────────────────────── -->
  <el-dialog
    v-model="diffOpen"
    title="重新同步：差異預覽"
    width="min(900px, 92vw)"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div v-if="diffData" class="diff-body">
      <p class="text-muted text-sm">
        已重新抓一次網頁、重新整理成一條條知識，請逐張決定要換成新的、還是保留舊的。
        你手動改過的內容預設保留你的版本。
      </p>

      <!-- 內容縮水警告(空內容當一等公民錯誤):抓到的量掉一半以上,「移除」多半是抓不到不是真下架 -->
      <el-alert
        v-if="diffData.shrink"
        type="error"
        show-icon
        :closable="false"
        class="diff-shrink-alert"
      >
        <template #title>
          這次只抓到約 {{ diffData.shrink.newChars.toLocaleString() }} 字（上次約 {{ diffData.shrink.oldChars.toLocaleString() }} 字）
        </template>
        <div class="text-xs">
          網頁可能改版成動態載入、或暫時故障——下方大量「移除」很可能是<strong>抓不到</strong>，不是內容真的下架。
          <strong>建議先按取消、不要套用</strong>；若網頁確實改版了，請把內容複製下來改用「貼上文字」重新匯入。
        </div>
      </el-alert>

      <!-- 擷取品質警示:與匯入流程共用同一套判斷,同一個網址在兩條路上要得到同樣的診斷 -->
      <el-alert
        v-if="diffData.warnings?.length"
        type="warning"
        show-icon
        :closable="false"
        class="diff-shrink-alert"
      >
        <template #title>
          這次抓到的內容有 {{ diffData.warnings.length }} 點要注意
        </template>
        <ul class="diff-warning-list">
          <li v-for="(w, i) in diffData.warnings" :key="i">{{ w }}</li>
        </ul>
      </el-alert>
      <!-- 切法漂了:一張都沒對上卻大量增減,幾乎都是 AI 換了切法,不是網頁整頁重寫。
           不講清楚的話,使用者會照著「移除 N」把好卡刪掉,或認定系統在亂報。 -->
      <el-alert
        v-if="diffLooksResplit"
        type="warning"
        show-icon
        :closable="false"
        class="diff-shrink-alert"
      >
        <template #title>
          這次的「新增 / 移除」多半不是網頁改了，而是 AI 換了一種分法
        </template>
        <div class="text-xs">
          一張舊知識都沒有對上（未變 0），同時出現 {{ diffData.diff.summary.added }} 筆新增與
          {{ diffData.diff.summary.removed }} 筆移除——網頁整頁重寫才會長這樣。
          <strong>先比對內容再決定</strong>；看起來只是同一件事換句話說的話，直接按取消就好，
          你現有的知識完全不會被動到。
        </div>
      </el-alert>

      <div class="diff-summary">
        <span class="diff-summary-chip diff-summary-chip--add">新增 {{ diffData.diff.summary.added }}</span>
        <span class="diff-summary-chip diff-summary-chip--mod">修改 {{ diffData.diff.summary.modified }}</span>
        <span class="diff-summary-chip diff-summary-chip--rem">移除 {{ diffData.diff.summary.removed }}</span>
        <span class="diff-summary-chip diff-summary-chip--same">未變 {{ diffData.diff.summary.unchanged }}</span>
      </div>

      <!-- 把「該看哪幾張」講出來:修改裡只有數字變掉的那些會影響客人拿到的答案 -->
      <p v-if="diffData.diff.summary.modified > 0" class="diff-unchanged-note text-muted text-xs">
        <template v-if="diffNumbersChangedCount > 0">
          「修改」裡有 <strong>{{ diffNumbersChangedCount }} 筆的數字變了</strong>(價格、天數、規格這類)，
          下方標了「數字有變」的請優先看。
        </template>
        <template v-else>
          「修改」的 {{ diffRewordOnlyCount }} 筆數字都沒有變(價格、天數、規格一樣)，只是換個說法。
        </template>
      </p>

      <p v-if="hiddenUnchangedCount > 0" class="diff-unchanged-note text-muted text-xs">
        {{ hiddenUnchangedCount }} 張未變的卡已收合(不需要做決定)
        <el-button text size="small" @click="showUnchangedDiff = !showUnchangedDiff">
          {{ showUnchangedDiff ? '收合' : '顯示' }}
        </el-button>
      </p>

      <div class="diff-entries">
        <div
          v-for="entry in visibleDiffEntries"
          :key="entry.id"
          class="diff-entry"
          :class="`diff-entry--${entry.kind}`"
        >
          <div class="diff-entry-head">
            <span class="diff-entry-kind">{{ kindLabel(entry.kind) }}</span>
            <span class="diff-entry-title">{{ entry.newChunk?.title || entry.oldChunk?.title }}</span>
            <span v-if="entry.oldChunk?.manuallyEdited" class="diff-entry-lock">手動編輯過</span>
            <!-- 數字有沒有變 = 這張修改到底會不會改變客人拿到的答案 -->
            <span v-if="entry.kind === 'modified' && entry.numbersChanged" class="diff-entry-hint diff-entry-hint--alert">
              數字有變{{ formatNumberChanges(entry.numberChanges) }}
            </span>
            <span v-else-if="entry.kind === 'modified' && entry.numbersChanged === false" class="diff-entry-hint">
              數字沒變
            </span>
          </div>

          <!-- 標題也變了:原本畫面只顯示一個標題,標題被 AI 改掉是看不見的 -->
          <p v-if="entry.kind === 'modified' && entry.titleChanged" class="diff-entry-titlechange text-xs">
            標題：<span class="diff-title-old">{{ entry.oldChunk?.title }}</span>
            → <span class="diff-title-new">{{ entry.newChunk?.title }}</span>
          </p>

          <!-- 內容對照 -->
          <div v-if="entry.kind === 'modified'" class="diff-entry-cols">
            <div class="diff-col diff-col--old">
              <div class="diff-col-head">舊版</div>
              <pre>{{ entry.oldChunk?.content }}</pre>
            </div>
            <div class="diff-col diff-col--new">
              <div class="diff-col-head">新版</div>
              <pre>{{ entry.newChunk?.content }}</pre>
            </div>
          </div>
          <div v-else-if="entry.kind === 'new'" class="diff-entry-single">
            <pre>{{ entry.newChunk?.content }}</pre>
          </div>
          <div v-else-if="entry.kind === 'removed'" class="diff-entry-single">
            <pre>{{ entry.oldChunk?.content }}</pre>
          </div>
          <!-- unchanged：不顯示內容，省版面 -->

          <!-- 動作選擇 -->
          <div class="diff-entry-actions">
            <el-radio-group v-model="decisions[entry.id]" size="small">
              <template v-if="entry.kind === 'new'">
                <el-radio-button value="add_new">新增</el-radio-button>
                <el-radio-button value="skip">略過</el-radio-button>
              </template>
              <template v-else-if="entry.kind === 'modified'">
                <el-radio-button value="use_new">用新版</el-radio-button>
                <el-radio-button value="keep_old">保留舊版</el-radio-button>
              </template>
              <template v-else-if="entry.kind === 'removed'">
                <el-radio-button value="delete_old">刪除</el-radio-button>
                <el-radio-button value="keep_old">保留</el-radio-button>
              </template>
              <template v-else>
                <el-radio-button value="keep_old">（無動作）</el-radio-button>
              </template>
            </el-radio-group>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <!-- 縮水時要求明確確認:此時所有「移除」已預設改為保留,使用者仍可逐張改成刪除,
           但必須先勾這一項才放行,避免習慣性直接按主按鈕就清空整份資料 -->
      <el-checkbox v-if="diffData?.shrink" v-model="shrinkAcknowledged" class="diff-shrink-ack">
        我確認網頁真的改版了，仍要套用
      </el-checkbox>
      <el-button @click="diffOpen = false">取消</el-button>
      <el-button
        type="primary"
        :loading="applying"
        :disabled="!diffData?.diff.entries.length || (!!diffData?.shrink && !shrinkAcknowledged)"
        @click="applyDiff"
      >
        套用選取的變更
      </el-button>
    </template>
  </el-dialog>

  <!-- ── Chunk Edit Modal ───────────────────────────── -->
  <el-dialog
    v-model="chunkEditOpen"
    :title="chunkEditMode === 'create' ? '新增知識(手寫一條知識)' : '編輯知識'"
    width="min(700px, 92vw)"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div class="chunk-form">
      <!-- 索引狀態(編輯既有卡才有) -->
      <div v-if="chunkEditMode === 'edit'" class="chunk-status-row">
        <span :class="['badge', chunkStatusBadge(chunkEditStatus)]">{{ chunkStatusLabel(chunkEditStatus) }}</span>
        <span v-if="chunkEditStatus === 'pending'" class="text-xs text-muted">處理中，約 5–30 秒後 AI 就能用這條回答</span>
        <span v-if="chunkEditFailureReason" class="chunk-status-failure">{{ chunkEditFailureReason }}</span>
        <el-button
          v-if="chunkEditStatus === 'failed'"
          size="small"
          plain
          :loading="chunkReindexing"
          @click="reindexChunkFromModal"
        >
          重新學習
        </el-button>
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="標題" tight />
        <el-input
          v-model="chunkForm.title"
          maxlength="100"
          show-word-limit
          placeholder="例：退換貨政策"
        />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="內容" tight />
        <el-input
          v-model="chunkForm.content"
          type="textarea"
          :rows="10"
          :maxlength="5000"
          show-word-limit
          placeholder="把這條的完整資訊寫進來，AI 會用整段當回答依據。"
        />
        <div class="chunk-normalize-row">
          <el-button
            size="small"
            plain
            :loading="chunkNormalizing"
            :disabled="!chunkForm.content.trim()"
            @click="normalizeChunkFromModal"
          >
            AI 整理一下
          </el-button>
          <span class="text-xs text-muted">自動整理成重點、清掉沒用的雜訊，讓 AI 更容易找到這條;整理後記得儲存</span>
        </div>
      </div>
      <!-- 客人問法會一起進 embedding(拉高命中率)。一定要看得到、改得掉:
           從「補知識」進來時這裡預填的是客人原話,可能夾著電話或姓名。 -->
      <div v-if="chunkForm.questions !== undefined" class="admin-field-group">
        <AdminFieldLabel text="客人可能怎麼問（會幫 AI 更容易找到這一條）" tight />
        <el-select
          v-model="chunkForm.questions"
          multiple
          filterable
          allow-create
          default-first-option
          :multiple-limit="3"
          placeholder="輸入後按 Enter，最多 3 條"
          style="width: 100%"
        />
        <p class="text-xs text-muted" style="margin: 4px 0 0;">
          這幾句會跟著知識一起被 AI 學習。若含個人資料（電話、姓名）請改寫成一般問法。
        </p>
      </div>
      <!-- 供 AI 使用開關(已完成索引的卡才有;pending/failed 本來就不會被引用) -->
      <div v-if="chunkShowUsage" class="admin-field-group">
        <AdminFieldLabel text="供 AI 使用" tight />
        <div class="chunk-usage-row">
          <el-switch v-model="chunkEnabled" />
          <span class="text-xs text-muted">{{ chunkEnabled ? 'AI 會引用這一條回答客人' : '停用後 AI 不再引用；隨時可重新開啟，不用重建' }}</span>
        </div>
      </div>

      <!-- 標籤/有效期限用得少,收進進階:補一題知識只需要標題+內容+問法。
           已有值(有標籤/設了期限/到期停用過)時預設展開——把生效中的設定藏起來會讓人找不到。 -->
      <button type="button" class="chunk-advanced-toggle" @click="chunkAdvancedOpen = !chunkAdvancedOpen">
        {{ chunkAdvancedOpen ? '▾' : '▸' }} 進階{{ chunkShowUsage ? '（標籤、有效期限）' : '（標籤）' }}
      </button>
      <template v-if="chunkAdvancedOpen">
        <div class="admin-field-group">
          <AdminFieldLabel text="標籤（非必填，後台分類用）" tight />
          <div class="chunk-tag-row">
            <el-tag
              v-for="t in chunkForm.tags"
              :key="t"
              closable
              class="chunk-tag"
              @close="removeChunkTag(t)"
            >{{ t }}</el-tag>
            <el-input
              v-if="chunkTagInputVisible"
              ref="chunkTagInputEl"
              v-model="chunkTagInput"
              size="small"
              style="width: 120px;"
              @keydown.enter.prevent="commitChunkTag"
              @blur="commitChunkTag"
            />
            <el-button v-else size="small" plain @click="showChunkTagInput">＋</el-button>
          </div>
        </div>
        <div v-if="chunkShowUsage" class="admin-field-group">
          <AdminFieldLabel text="有效期限（選填）" tight />
          <div class="chunk-usage-row">
            <el-date-picker
              v-model="chunkActiveUntil"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="永久有效"
              clearable
              style="width: 160px;"
            />
            <span class="text-xs text-muted">到期當天結束後自動停用——適合募資、折扣這類有檔期的內容</span>
          </div>
          <p v-if="chunkExpiredAtMs && !chunkEnabled" class="chunk-expired-note">
            這一條已於 {{ ymdLabel(chunkExpiredAtMs) }} 到期自動停用；打開開關或設定新期限即可重新上架。
          </p>
        </div>
      </template>
    </div>
    <template #footer>
      <div class="chunk-footer">
        <el-button
          v-if="chunkEditMode === 'edit'"
          type="danger"
          plain
          :loading="chunkDeleting"
          :disabled="chunkSaving"
          @click="deleteChunkFromModal"
        >
          刪除
        </el-button>
        <div class="chunk-footer-right">
          <el-button @click="chunkEditOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="chunkSaving"
            :disabled="chunkDeleting || !chunkForm.title.trim() || !chunkForm.content.trim()"
            @click="saveChunk"
          >
            {{ chunkEditMode === 'create' ? '建立' : '儲存' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <!-- ── 匯入彈窗 ───────────────────────────────────── -->
  <KnowledgeImportDialog v-model="importOpen" :existing-sources="sources" @imported="onImported" />

  <!-- ── 補知識前的查重(P1-1):改既有的比新建一條重複的好 ──────── -->
  <el-dialog
    v-model="dupOpen"
    title="這題可能已經有答案了"
    width="min(560px, 92vw)"
    :close-on-click-modal="false"
  >
    <p class="src-dup-query">客人問的是「{{ dupQuery }}」</p>
    <p class="src-dup-hint">
      知識庫裡已經有下面這些內容。<strong>改現有的那一條會比新增一條更好</strong>——
      內容相近的兩條會讓 AI 分不出該用哪一條，反而更容易反問或答錯。
    </p>
    <div class="src-dup-list">
      <button v-for="r in dupHits" :key="r.id" type="button" class="src-dup-row" @click="dupEdit(r)">
        <span class="src-dup-row__title">
          {{ r.title }}
          <span v-if="r.status === 'failed'" class="badge badge-red">AI 沒學起來</span>
          <span v-else-if="r.status === 'disabled'" class="badge badge-gray">已停用</span>
        </span>
        <span class="src-dup-row__snippet">{{ r.snippet }}</span>
        <span class="src-dup-row__go">改這一條 →</span>
      </button>
    </div>
    <template #footer>
      <div class="src-dup-footer">
        <span class="text-xs text-muted">都不是同一件事的話再新增</span>
        <div>
          <el-button @click="dupOpen = false">取消</el-button>
          <el-button type="primary" plain @click="dupCreateAnyway">還是新增一條</el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <!-- ── Folder Edit Modal ──────────────────────────── -->
  <el-dialog
    v-model="folderEditOpen"
    title="編輯資料夾"
    width="min(480px, 92vw)"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div class="folder-form">
      <div class="admin-field-group">
        <AdminFieldLabel text="名稱" tight />
        <el-input
          v-model="folderForm.name"
          maxlength="50"
          show-word-limit
          placeholder="例：客服 FAQ"
        />
      </div>
      <p v-if="folderEditTarget" class="folder-form-hint">
        目前底下 {{ countByFolder[folderEditTarget.id] ?? 0 }} 筆資料。
        若刪除，底下的資料會自動移到「未分類」，<strong>不會</strong>被刪掉。
      </p>
    </div>
    <template #footer>
      <div class="folder-footer">
        <el-button
          type="danger"
          plain
          :loading="folderDeleting"
          :disabled="folderSaving"
          @click="deleteFolderFromModal"
        >
          刪除資料夾
        </el-button>
        <div class="folder-footer-right">
          <el-button @click="folderEditOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="folderSaving"
            :disabled="folderDeleting || !folderForm.name.trim() || folderForm.name.trim() === folderEditTarget?.name"
            @click="saveFolderName"
          >
            儲存
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { Delete, EditPen, FirstAidKit, Folder, Lock, Search, Upload } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { isShortChunkContent, SHORT_CHUNK_CONTENT_CHARS } from '~~/shared/types/ai-knowledge'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

type SourceType = 'file' | 'url' | 'manual' | 'gsheet'
type SourceStatus = 'fetching' | 'splitting' | 'ready' | 'failed'

interface SourceSummary {
  id: string
  type: SourceType
  name: string
  url: string
  folderId: string | null
  status: SourceStatus
  failureReason?: string
  chunkCount: number
  refreshIntervalMinutes: number
  onChangeBehavior: 'notify' | 'log_only'
  /** 所屬產品名；'' = 非單一產品資料。改動後要重建該資料索引才生效。 */
  productName: string
  /** type='url'：小幅文字變動是否自動套用 */
  urlAutoApply: boolean
  lastFetchedAtMs: number
  outdatedAtMs: number
  updatedAtMs: number
}

interface ChunkRow {
  id: string
  title: string
  content: string
  tags: string[]
  /** 客人問法（會一起進 embedding）；編輯時要看得到、改得掉 */
  questions: string[]
  status: string
  failureReason?: string
  manuallyEditedAtMs: number
  updatedAtMs: number
  /** 有效期限（0 = 永久）；到期會被排程自動停用 */
  activeUntilMs: number
  /** 到期自動停用的時間（0 = 沒發生過） */
  expiredAtMs: number
}

interface DiffEntry {
  id: string
  kind: 'new' | 'modified' | 'removed' | 'unchanged'
  defaultAction: 'add_new' | 'use_new' | 'keep_old' | 'delete_old' | 'skip'
  oldChunk?: {
    id: string
    title: string
    content: string
    tags: string[]
    manuallyEdited: boolean
  }
  newChunk?: { title: string; content: string; tags: string[] }
  /** kind='modified'：內容裡的數字(價格/天數/規格)有沒有變。false = 只是換句話說 */
  numbersChanged?: boolean
  /** 變掉的數字,直接列給人看 */
  numberChanges?: { removed: string[]; added: string[] }
  /** kind='modified'：標題(忽略標點空白後)真的變了 */
  titleChanged?: boolean
}

interface DiffData {
  sourceId: string
  sourceName: string
  sourceUrl: string
  /** preview 當時內容的指紋;apply 時帶回,讓後端回寫「對應這份 diff」的 hash */
  contentHash?: string
  diff: {
    entries: DiffEntry[]
    summary: { added: number; modified: number; removed: number; unchanged: number }
  }
  /** 內容縮水偵測:重切後內容比舊卡總量掉一半以上且有卡消失 = 疑似動態頁/抓取故障,勸退套用 */
  shrink?: { oldChars: number; newChars: number } | null
  /** 擷取品質警示(太薄 / 只抓到選單頁尾),與匯入流程共用同一套判斷 */
  warnings?: string[]
}

const { apiFetch, workspaceId, can } = useWorkspace()
// 內容維護一律 agent+；資料/資料夾/知識目前同層級，分開判斷以便日後政策若拆分只改一處
const canEditKb = computed(() => can('knowledge.write'))
const canEditSources = computed(() => can('sources.write'))
const canEditFolders = computed(() => can('folders.write'))
const canReindexAll = computed(() => can('knowledge.reindexAll'))
const { showToast } = useAdminToast()

const sources = ref<SourceSummary[]>([])

/**
 * AI 總開關與知識總條數（P1-4）：用來判斷「這一頁的內容目前有沒有在發揮作用」。
 * null = 還沒讀到（讀失敗時不顯示提醒，寧可少講一句也不要誤報「AI 沒開」）。
 */
const aiEnabled = ref<boolean | null>(null)
const totalChunkCount = computed(() => sources.value.reduce((sum, s) => sum + (s.chunkCount ?? 0), 0))
async function loadAiEnabled() {
  try {
    const s = await apiFetch<{ enabled?: boolean }>('/api/ai/settings')
    aiEnabled.value = s?.enabled === true
  }
  catch {
    aiEnabled.value = null
  }
}
const loading = ref(false)
const selectedId = ref<string | null>(null)
const selectedSource = computed(() => sources.value.find(s => s.id === selectedId.value) ?? null)

// orphan chunks（sourceId === null）— 給「整理舊資料」橫幅用
const orphanCount = ref(0)
const migrating = ref(false)

// ── 資料夾分組 ───────────────────────────────────────
interface FolderRow {
  id: string
  name: string
  order: number
  createdAtMs: number
}
const folders = ref<FolderRow[]>([])

// 哪些資料夾是展開狀態（含特殊值 '__none__' 代表「未分類」）；localStorage 持久化
const expandedFolders = ref<Set<string>>(new Set(['__none__']))
const LS_EXPANDED_KEY = computed(() => `kb-folders-expanded:${workspaceId.value}`)
function loadExpandedState() {
  try {
    const raw = localStorage.getItem(LS_EXPANDED_KEY.value)
    if (raw) expandedFolders.value = new Set(JSON.parse(raw) as string[])
  }
  catch { /* 預設只展開「未分類」 */ }
}
function saveExpandedState() {
  try {
    localStorage.setItem(LS_EXPANDED_KEY.value, JSON.stringify([...expandedFolders.value]))
  }
  catch { /* 寫不進去就算了 */ }
}
function isExpanded(folderId: string) { return expandedFolders.value.has(folderId) }
function toggleFolder(folderId: string) {
  if (expandedFolders.value.has(folderId)) expandedFolders.value.delete(folderId)
  else expandedFolders.value.add(folderId)
  expandedFolders.value = new Set(expandedFolders.value) // trigger reactivity
  saveExpandedState()
}

const sourcesByFolder = computed(() => {
  const map: Record<string, SourceSummary[]> = {}
  for (const s of sources.value) {
    const key = s.folderId || ''
    if (!key) continue
    if (!map[key]) map[key] = []
    map[key].push(s)
  }
  return map
})
const uncategorizedSources = computed(() => sources.value.filter(s => !s.folderId))
const countByFolder = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const f of folders.value) m[f.id] = (sourcesByFolder.value[f.id] ?? []).length
  return m
})

// ── 拖曳：把 source 拖到 folder ─────────────────────
const draggedSourceId = ref<string | null>(null)
const dragOverFolderId = ref<string | null>(null)

// 拖曳中的這筆是不是「資料夾裡」的卡？是的話才顯示「拖出資料夾」drop zone
const isDraggingFromFolder = computed(() => {
  if (!draggedSourceId.value) return false
  const src = sources.value.find(s => s.id === draggedSourceId.value)
  return !!src?.folderId
})

function onSourceDragStart(srcId: string, ev: DragEvent) {
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', srcId)
  }
  // dragstart 的同一個 frame 不能動到 DOM（「拖出資料夾」zone 是 v-if，
  // 立刻插入會讓 Chrome 直接取消這次拖曳），所以延後一個 frame 再設
  requestAnimationFrame(() => {
    draggedSourceId.value = srcId
  })
}
function onSourceDragEnd() {
  draggedSourceId.value = null
  dragOverFolderId.value = null
}
// ── Folder header 拖曳排序（資料夾之間互換順序）──────
const draggedFolderId = ref<string | null>(null)
const folderReorderOverId = ref<string | null>(null)

function onFolderHeaderDragStart(e: DragEvent, folderId: string) {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', folderId)
  }
  // 同 onSourceDragStart：state 延後一個 frame，避免 dragstart 當下重繪取消拖曳
  requestAnimationFrame(() => {
    draggedFolderId.value = folderId
  })
}
function onFolderHeaderDragEnd() {
  draggedFolderId.value = null
  folderReorderOverId.value = null
}
async function reorderFoldersTo(targetFolderId: string) {
  const fromId = draggedFolderId.value
  draggedFolderId.value = null
  folderReorderOverId.value = null
  if (!fromId || fromId === targetFolderId) return
  const next = [...folders.value]
  const fromIndex = next.findIndex(f => f.id === fromId)
  const toIndex = next.findIndex(f => f.id === targetFolderId)
  if (fromIndex < 0 || toIndex < 0) return
  const previous = folders.value
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved!)
  folders.value = next
  try {
    await apiFetch('/api/ai/folders/reorder', {
      method: 'POST',
      body: { orderedIds: next.map(f => f.id) },
    })
  }
  catch (err: any) {
    folders.value = previous
    showToast(err?.statusMessage || '資料夾排序儲存失敗', 'error')
  }
}

function onFolderDragOver(folderId: string, ev: DragEvent) {
  if (draggedFolderId.value) {
    // 拖的是資料夾 → 在別的資料夾標頭上顯示「插入位置」
    if (folderId !== '__none__' && folderId !== draggedFolderId.value) {
      folderReorderOverId.value = folderId
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    }
    return
  }
  if (!draggedSourceId.value) return
  dragOverFolderId.value = folderId
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
}
function onFolderDragLeave(folderId: string) {
  if (dragOverFolderId.value === folderId) dragOverFolderId.value = null
  if (folderReorderOverId.value === folderId) folderReorderOverId.value = null
}
async function onFolderDrop(folderId: string | null) {
  if (draggedFolderId.value) {
    if (folderId) await reorderFoldersTo(folderId)
    return
  }
  const srcId = draggedSourceId.value
  dragOverFolderId.value = null
  draggedSourceId.value = null
  if (!srcId) return
  const src = sources.value.find(s => s.id === srcId)
  if (!src) return
  if ((src.folderId ?? null) === folderId) return // 沒換位置
  // 樂觀更新
  src.folderId = folderId
  try {
    await apiFetch(`/api/ai/sources/${srcId}`, {
      method: 'PUT',
      body: { folderId },
    })
  }
  catch (err: any) {
    showToast(err?.statusMessage || '移動失敗', 'error')
    await loadSources()
  }
}

const chunks = ref<ChunkRow[]>([])
const detailLoading = ref(false)

// ── 知識品質「被動提示」:只標示、絕不自動攔截/刪除(判斷權在人) ──
/** 標題＋內容去空白合計 <10 字:placeholder/測試列等級,embedding 是雜訊會污染檢索 */
/** 與知識庫體檢同一把尺（shared 常數）——兩邊門檻不同會出現「體檢說有、知識卻沒標」 */
function isShortChunk(c: Pick<ChunkRow, 'content'>): boolean {
  return isShortChunkContent(c.content)
}

/**
 * 判定用的字數（不算空白），與 isShortChunkContent 同一把尺。
 * 上面 meta 行顯示的是含空白的原始長度，兩個數字會不一樣——所以提示裡要標明「空白不算」，
 * 否則會出現「35 字」卻說「還差 5 字」這種自相矛盾。
 */
function shortChunkChars(c: Pick<ChunkRow, 'content'>): number {
  return String(c.content ?? '').replace(/\s+/g, '').length
}

function chunkPreview(c: Pick<ChunkRow, 'content'>): string {
  const firstLine = c.content.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}

const emptySettingsForm = () => ({
  refreshIntervalMinutes: 0,
  onChangeBehavior: 'notify' as 'notify' | 'log_only',
  urlAutoApply: true,
})
const settingsForm = ref(emptySettingsForm())
const settingsBaseline = ref(emptySettingsForm())
const settingsDirty = computed(() =>
  settingsForm.value.refreshIntervalMinutes !== settingsBaseline.value.refreshIntervalMinutes
  || settingsForm.value.onChangeBehavior !== settingsBaseline.value.onChangeBehavior
  || settingsForm.value.urlAutoApply !== settingsBaseline.value.urlAutoApply,
)
const savingSettings = ref(false)
const deleting = ref(false)

const resyncing = ref(false)
const gsheetSyncing = ref(false)
const applying = ref(false)
const diffOpen = ref(false)
const diffData = ref<DiffData | null>(null)
const decisions = ref<Record<string, string>>({})

// diff modal:「未變」的卡不需要人做決定,預設收合成一行摘要——大資料改一小處時,
// 使用者才不用在幾十條未變裡找那一條有變的
const showUnchangedDiff = ref(false)
const visibleDiffEntries = computed(() => {
  const entries = diffData.value?.diff.entries ?? []
  return showUnchangedDiff.value ? entries : entries.filter(e => e.kind !== 'unchanged')
})
const hiddenUnchangedCount = computed(() =>
  (diffData.value?.diff.entries ?? []).filter(e => e.kind === 'unchanged').length,
)

/**
 * 「網頁跟上次整理時一模一樣」的結果（後端短路,沒有 diff 可看）。
 * 用面板而不是 toast:這是使用者按下按鈕後唯一的答覆,3.5 秒消失的提示等於沒回答。
 */
const resyncNoChange = ref<string | null>(null)

/**
 * 「切法漂了」的提示條件:一張都沒對上(未變 0)卻同時大量新增+移除。
 * 這種形狀幾乎都是 AI 這次換了一種切法,不是網頁真的整頁重寫——要講出來,
 * 不然使用者會照著「移除 14」把好卡刪掉,或以為系統在亂報。
 */
const diffLooksResplit = computed(() => {
  const s = diffData.value?.diff.summary
  if (!s) return false
  const oldCards = s.modified + s.removed + s.unchanged
  return s.unchanged === 0 && oldCards >= 3 && s.added >= 3 && s.removed >= 3
})

/**
 * 「修改」裡數字（價格 / 天數 / 規格）真的變掉的張數 —— 要優先看的就是這幾張。
 * 反過來說：修改張數扣掉這個，就是純粹換句話說、客人拿到的事實沒變的那些。
 */
const diffNumbersChangedCount = computed(() =>
  (diffData.value?.diff.entries ?? []).filter(e => e.kind === 'modified' && e.numbersChanged).length,
)
const diffRewordOnlyCount = computed(() =>
  (diffData.value?.diff.entries ?? [])
    .filter(e => e.kind === 'modified' && e.numbersChanged === false).length,
)

/** 「數字有變」badge 後面接的內容:「(1000 → 1200)」;只有一邊有值就只顯示那一邊 */
function formatNumberChanges(c?: { removed: string[]; added: string[] }): string {
  if (!c) return ''
  const from = c.removed.join('、')
  const to = c.added.join('、')
  if (from && to) return `（${from} → ${to}）`
  if (to) return `（多了 ${to}）`
  if (from) return `（少了 ${from}）`
  return ''
}

// ── Chunk edit / create modal ───────────────────────
const chunkEditOpen = ref(false)
const chunkEditMode = ref<'create' | 'edit'>('create')
const chunkEditingId = ref<string | null>(null) // edit 模式才有值
// questions 是 AI 整理產生的常見問法,使用者不直接編;沒值就不送、後端保留既有
const chunkForm = ref({ title: '', content: '', tags: [] as string[], questions: undefined as string[] | undefined })

// ── 全庫搜尋（標題 / 內容 / 問法） ─────────────────────
interface SearchRow { id: string; sourceId: string | null; title: string; snippet: string; status: string }
const searchKeyword = ref('')
const searchResults = ref<SearchRow[] | null>(null)
const searchTruncated = ref(false)
const searchCountTruncated = ref(false)
const searchLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchAbort: AbortController | null = null
/**
 * 每次搜尋在後端要掃 1500 條,所以 debounce 訂 500ms 並取消上一發:
 * 300ms 的話打一句話會送出好幾發、每發都付一次全庫掃描的讀取費。
 */
watch(searchKeyword, (kw) => {
  if (searchTimer) clearTimeout(searchTimer)
  const q = kw.trim()
  if (q.length < 2) {
    // 單字元雜訊太多；清空輸入時同時收起結果面板
    searchAbort?.abort()
    searchAbort = null
    searchResults.value = null
    searchLoading.value = false
    return
  }
  searchLoading.value = true
  searchTimer = setTimeout(async () => {
    searchAbort?.abort()
    const ac = new AbortController()
    searchAbort = ac
    try {
      const res = await apiFetch<{ items: SearchRow[]; truncated: boolean; countTruncated: boolean }>(
        `/api/ai/knowledge/search?q=${encodeURIComponent(q)}`,
        { signal: ac.signal },
      )
      // 輸入已經變了就丟棄過期結果
      if (searchKeyword.value.trim() !== q) return
      searchResults.value = res.items
      searchTruncated.value = res.truncated
      searchCountTruncated.value = res.countTruncated
    }
    catch {
      if (ac.signal.aborted) return // 被新的一發取消,不要清掉畫面
      searchResults.value = []
      searchTruncated.value = false
      searchCountTruncated.value = false
    }
    finally {
      if (!ac.signal.aborted) searchLoading.value = false
    }
  }, 500)
})

/** 從監控頁 ?q= 進來補卡：建卡成功後把同問題的轉真人案例自動標已處理 */
const pendingResolveQuery = ref('')

// ── 補知識前先查重複（P1-1） ──────────────────────────
// 三個「補知識」入口原本都直接開空白視窗，同一題從不同入口進來就建出好幾條重複內容，
// 而內容相近正是會引發反問與答錯的老問題（全庫搜尋 API 就在同一頁，只是沒被用）。
const dupOpen = ref(false)
const dupQuery = ref('')
const dupHits = ref<SearchRow[]>([])
const dupChecking = ref(false)

/** 有現成的就先問要不要改那一條；沒有就直接開新增視窗（不多擋一步） */
async function startAddKnowledge(q: string) {
  dupQuery.value = q
  dupChecking.value = true
  try {
    const res = await apiFetch<{ items: SearchRow[] }>(
      `/api/ai/knowledge/search?q=${encodeURIComponent(q.slice(0, 60))}`,
    )
    // 只看前幾筆：這裡要回答的是「有沒有現成的」，不是給第二個搜尋結果頁
    dupHits.value = (res.items ?? []).slice(0, 5)
  }
  catch {
    dupHits.value = [] // 查不到就當沒有，不要卡住補知識這件事
  }
  finally {
    dupChecking.value = false
  }
  if (dupHits.value.length) dupOpen.value = true
  else openPrefilledCreate(q)
}

/** 客人原話預填成標題與問法（原話就是最好的問法，一併進 embedding） */
function openPrefilledCreate(q: string) {
  openCreateManual()
  chunkForm.value.title = q.slice(0, 100) // 對齊標題欄位 maxlength=100
  chunkForm.value.questions = [q.slice(0, 200)]
  pendingResolveQuery.value = q
}

async function dupEdit(row: SearchRow) {
  dupOpen.value = false
  // 改既有那一條也算把這題處理掉了 → 沿用同一套自動銷案
  pendingResolveQuery.value = dupQuery.value
  await openChunkById(row.id)
}

function dupCreateAnyway() {
  dupOpen.value = false
  openPrefilledCreate(dupQuery.value)
}
const chunkSaving = ref(false)
const chunkDeleting = ref(false)
const chunkEditStatus = ref('')
const chunkEditFailureReason = ref('')
const chunkNormalizing = ref(false)
const chunkReindexing = ref(false)
// 供 AI 使用開關 + 有效期限(與內容分開存:走 /settings 端點,不動 embedding)
const chunkEnabled = ref(true)
const chunkActiveUntil = ref('') // 'YYYY-MM-DD';空字串 = 永久
const chunkExpiredAtMs = ref(0)
/** 開關/期限只對已索引或已停用的卡有意義(pending/failed 本來就不會被引用) */
const chunkShowUsage = computed(() =>
  chunkEditMode.value === 'edit' && (chunkEditStatus.value === 'indexed' || chunkEditStatus.value === 'disabled'))
/** 標籤/有效期限收進「進階」摺疊;開窗時依「有沒有值」決定預設開合 */
const chunkAdvancedOpen = ref(false)
// 開窗時的原值,儲存時只送有變的部分
let chunkSettingsOriginal = { enabled: true, activeUntil: '' }

/** ms → 台灣時區 YYYY-MM-DD(sv locale 格式剛好是 ISO 日期) */
function ymdLabel(ms: number): string {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Taipei' }).format(new Date(ms))
}

// ── Folder edit modal ───────────────────────────────
const folderEditOpen = ref(false)
const folderEditTarget = ref<FolderRow | null>(null)
const folderForm = ref({ name: '' })
const folderSaving = ref(false)
const folderDeleting = ref(false)
const chunkTagInput = ref('')
const chunkTagInputVisible = ref(false)
const chunkTagInputEl = ref<{ focus: () => void } | null>(null)

/**
 * forceHealth:剛動過知識庫(匯入 / 刪資料 / 改卡 / 套用同步)時要跳過體檢節流,
 * 否則店家照著體檢清單修完、回來數字卻不動(以為沒生效)。純瀏覽的重載用節流版即可。
 */
async function loadSources(forceHealth = false) {
  loading.value = true
  void loadHealth(forceHealth) // 體檢與列表平行載入;失敗不擋頁面
  try {
    const [sourcesRes, foldersRes] = await Promise.all([
      apiFetch<{ items: SourceSummary[]; orphanCount?: number }>('/api/ai/sources/list'),
      apiFetch<{ items: FolderRow[] }>('/api/ai/folders').catch(() => ({ items: [] as FolderRow[] })),
    ])
    sources.value = sourcesRes.items
    orphanCount.value = Number(sourcesRes.orphanCount ?? 0)
    folders.value = foldersRes.items ?? []
    // 第一次載入：把所有資料夾預設展開（之後 toggle 會覆寫 localStorage 狀態）
    if (expandedFolders.value.size === 1 && expandedFolders.value.has('__none__')) {
      const init = new Set<string>(['__none__'])
      for (const f of folders.value) init.add(f.id)
      expandedFolders.value = init
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || '載入資料失敗', 'error')
  }
  finally {
    loading.value = false
  }
}

// ── 知識庫健康檢查列(P2-3)───────────────────────────
// 把 7/31 稽核靠工程師手動翻出來的問題(無主說明書/過短卡/同步失敗/過期停用)變成常駐體檢。
interface HealthChunkGroup { count: number; items: Array<{ id: string; title: string; sourceId: string | null }> }
interface HealthResponse {
  failedSources: Array<{ id: string; name: string; reason?: string }>
  outdatedSources: Array<{ id: string; name: string }>
  noProductSources: Array<{ id: string; name: string; chunkCount: number }>
  shortChunks: HealthChunkGroup
  failedChunks: HealthChunkGroup
  expiredChunks: HealthChunkGroup
  chunkScanTruncated: boolean
  aliasCandidateCount: number
}
const emptyHealth = (): HealthResponse => ({
  failedSources: [],
  outdatedSources: [],
  noProductSources: [],
  shortChunks: { count: 0, items: [] },
  failedChunks: { count: 0, items: [] },
  expiredChunks: { count: 0, items: [] },
  chunkScanTruncated: false,
  aliasCandidateCount: 0,
})
const health = ref<HealthResponse>(emptyHealth())
// 資料與知識分開計:「1 份資料同步失敗」= 整批知識凍結,「1 條過短」= 小瑕疵,
// 加成同一個數字會把嚴重度抹平,店家看不出該先處理哪個。
const healthSourceCount = computed(() =>
  health.value.failedSources.length
  + health.value.outdatedSources.length
  + health.value.noProductSources.length)
const healthChunkCount = computed(() =>
  health.value.shortChunks.count + health.value.failedChunks.count)
// 「已過期停用」是有效期限功能正確運作的結果,不是待辦——算進待處理會讓數字永遠清不完。
// 另列一行「僅供參考」,店家想看時看得到、但不催他處理。
const healthExpiredCount = computed(() => health.value.expiredChunks.count)
const healthIssueCount = computed(() => healthSourceCount.value + healthChunkCount.value)

// ── 「要處理的事」單一清單 ────────────────────────────
// 取代原本三個並排的橫幅。每一項照房規寫成:結論(標題) + 不管它會怎樣(why) + 一顆按鈕。
// tone 只有兩級:danger = 現在就在影響客人的回答;warning = 建議處理。
// 排序 = 影響客人的程度,不是資料類型——店家要的是「先做哪個」。
const todoOpen = ref(true)

interface TodoItem {
  id: string
  tone: 'danger' | 'warning'
  title: string
  why: string
  cta: string
  loading?: boolean
  action: () => void
}

/**
 * 只有一筆時直接跳到那筆資料/知識——最常見的情境(一份資料壞掉)原本也要
 * 過一層清單彈窗,而彈窗的 hint 只是把待辦已講過的 why 再講一遍。多筆才開清單。
 */
function singleOrList(single: Array<{ id: string }>, kind: 'source' | 'chunk', cat: HealthCategory): () => void {
  if (single.length === 1) {
    const id = single[0]!.id
    return () => { void gotoHealthItem({ id, kind }) }
  }
  return () => openHealthList(cat)
}

const todoItems = computed<TodoItem[]>(() => {
  const items: TodoItem[] = []
  const h = health.value

  /**
   * AI 沒開 = 這一整頁的努力目前對客人零影響（P1-4）。
   * 排第一個、紅色：知識庫建得再完整，總開關關著客人也感覺不到——
   * 這是最容易「做完一整天卻沒有任何效果」的坑，而且畫面原本完全不提。
   */
  if (aiEnabled.value === false && totalChunkCount.value > 0) {
    items.push({
      id: 'aiOff',
      tone: 'danger',
      title: 'AI 客服還沒開啟',
      why: `已經有 ${totalChunkCount.value} 條知識，但 AI 目前不會回覆客人——這些內容還沒開始發揮作用。`,
      cta: '前往開啟',
      action: () => navigateTo(`/admin/${workspaceId.value}/ai-settings`),
    })
  }

  if (h.failedSources.length) {
    items.push({
      id: 'failedSources',
      tone: 'danger',
      title: `有 ${h.failedSources.length} 份資料抓不到內容`,
      why: '這幾份的內容沒有更新進 AI，客人問到相關問題會拿到過時或空的答案。',
      cta: '前往修復',
      action: singleOrList(h.failedSources, 'source', 'failedSources'),
    })
  }
  if (h.failedChunks.count) {
    items.push({
      id: 'failedChunks',
      tone: 'danger',
      title: `有 ${h.failedChunks.count} 條內容 AI 沒學起來`,
      why: '存進去了但 AI 讀不到，等於白建——客人問到就會答不出來。',
      cta: '查看',
      action: singleOrList(h.failedChunks.count === 1 ? h.failedChunks.items : [], 'chunk', 'failedChunks'),
    })
  }
  if (h.outdatedSources.length) {
    items.push({
      id: 'outdatedSources',
      tone: 'warning',
      title: `有 ${h.outdatedSources.length} 份資料的原始內容改過了`,
      why: '原始網頁或試算表被改過，但 AI 還在用舊版本回答。',
      cta: '前往比對',
      action: singleOrList(h.outdatedSources, 'source', 'outdatedSources'),
    })
  }
  if (h.noProductSources.length) {
    items.push({
      id: 'noProductSources',
      tone: 'warning',
      title: `有 ${h.noProductSources.length} 份文件沒說是哪個產品`,
      why: '客人指名問某一台時，AI 可能拿別台產品的內容回答。',
      cta: '前往設定',
      action: singleOrList(h.noProductSources, 'source', 'noProductSources'),
    })
  }
  if (h.shortChunks.count) {
    items.push({
      id: 'shortChunks',
      tone: 'warning',
      title: `有 ${h.shortChunks.count} 條內容太短`,
      why: '太短的內容 AI 找到了也答不出東西，還可能擋住其他有用的內容。',
      cta: '查看',
      action: singleOrList(h.shortChunks.count === 1 ? h.shortChunks.items : [], 'chunk', 'shortChunks'),
    })
  }
  // 別名候選原本只藏在「⋯」選單展開後的項目文字裡,⋯ 按鈕本身沒有徽章——
  // 等於一個看不見的異常。它會讓 AI 把同一台機器當成兩台,該進待辦。
  if (h.aliasCandidateCount > 0) {
    items.push({
      id: 'alias',
      tone: 'warning',
      title: `有 ${h.aliasCandidateCount} 組產品名稱可能是同一台`,
      why: '同一台機器兩種叫法會被 AI 當成兩台——反問客人二選一、出貨時間並列成兩台。',
      cta: '前往確認',
      action: () => openAliasDialog(),
    })
  }
  if (orphanCount.value > 0) {
    items.push({
      id: 'orphan',
      tone: 'warning',
      title: `有 ${orphanCount.value} 條舊版內容還沒歸檔`,
      why: '這些是舊版本留下的、沒有歸在任何一份資料底下。整理一下就會出現在下面的清單裡。',
      cta: '一鍵整理',
      loading: migrating.value,
      action: () => { if (canEditSources.value) void migrateOrphans() },
    })
  }
  return items
})

// ── 工作台入口(選著資料時) ──────────────────────────
// 工作台(要處理的事+AI建議)只在未選取資料時顯示;選著資料時側欄留一行入口。
// suggestCount 由 KnowledgeSuggestions 元件回報——收件匣的資料只有它自己知道。
const suggestCount = ref(0)
const workbenchBadge = computed(() => {
  const parts: string[] = []
  if (todoItems.value.length) parts.push(`${todoItems.value.length} 件要處理`)
  if (suggestCount.value) parts.push(`${suggestCount.value} 個 AI 建議`)
  return parts.join('、')
})
function backToWorkbench() {
  selectedId.value = null
  chunks.value = []
}

/**
 * 體檢節流:loadSources 有十幾個呼叫點(建資料夾、改名、刪資料、搬卡…),每次都掃
 * 上千條的內容太貴,而體檢結果多半只在排程跑完或改過知識庫後才變。
 * 60 秒內重複呼叫直接跳過;真的需要立即更新(匯入完成、刪資料)用 force。
 */
const HEALTH_TTL_MS = 60_000
let healthFetchedAt = 0

async function loadHealth(force = false) {
  if (!force && healthFetchedAt && Date.now() - healthFetchedAt < HEALTH_TTL_MS) return
  healthFetchedAt = Date.now()
  try {
    health.value = await apiFetch<HealthResponse>('/api/ai/knowledge/health')
  }
  catch {
    /* 體檢失敗不擋頁面,banner 不顯示而已 */
    healthFetchedAt = 0 // 失敗不佔用節流窗,下次進來可重試
  }
}

type HealthCategory = 'failedSources' | 'outdatedSources' | 'noProductSources' | 'failedChunks' | 'shortChunks' | 'expiredChunks'
const HEALTH_META: Record<HealthCategory, { title: string; hint: string }> = {
  failedSources: { title: '資料同步失敗', hint: '這些資料自動同步一直失敗,知識停留在最後一次成功的內容。點進資料看失敗原因(常見:試算表沒分享給服務帳號、網頁被移走)。' },
  outdatedSources: { title: '資料偵測到變動', hint: '網頁內容跟上次不一樣了。點進資料按「重新同步」看差異,決定要不要更新知識。' },
  noProductSources: { title: '文件未設產品名', hint: '這些多卡的檔案資料沒設「所屬產品」——若是單一產品的說明書,客人指名問的時候可能拿別台產品的內容回答。點進資料補上產品名。' },
  failedChunks: { title: '知識學習失敗', hint: '這些卡 AI 沒有學成功,客人問到相關問題時找不到它們。點開知識按「重新學習」可以重試。' },
  shortChunks: { title: '知識內容過短', hint: '內容太少的卡多半是切壞或抓壞的殘片,檢索命中也答不出東西。點開知識補內容或停用。' },
  expiredChunks: { title: '知識已過期停用', hint: '這些卡因有效期限到期被自動停用。活動若延長,把期限改到未來就會自動重新上架;確定結束可放著或刪除。' },
}
const healthListOpen = ref(false)
const healthListCategory = ref<HealthCategory>('failedSources')
const healthListTitle = computed(() => HEALTH_META[healthListCategory.value].title)
const healthListHint = computed(() => HEALTH_META[healthListCategory.value].hint)
const healthListItems = computed<Array<{ id: string; title: string; meta: string; kind: 'source' | 'chunk' }>>(() => {
  const cat = healthListCategory.value
  const h = health.value
  const sourceName = (id: string | null) => sources.value.find(s => s.id === id)?.name ?? ''
  if (cat === 'failedSources') {
    // 直接把失敗原因列出來(最常見是試算表沒分享給服務帳號),不必逐一點進資料才知道
    return h.failedSources.map(s => ({ id: s.id, title: s.name, meta: s.reason ?? '', kind: 'source' as const }))
  }
  if (cat === 'outdatedSources') {
    return h.outdatedSources.map(s => ({ id: s.id, title: s.name, meta: '', kind: 'source' as const }))
  }
  if (cat === 'noProductSources') {
    return h.noProductSources.map(s => ({ id: s.id, title: s.name, meta: `${s.chunkCount} 條`, kind: 'source' as const }))
  }
  return h[cat].items.map(c => ({ id: c.id, title: c.title, meta: sourceName(c.sourceId), kind: 'chunk' as const }))
})
const healthListTruncatedNote = computed(() => {
  const cat = healthListCategory.value
  if (cat === 'failedSources' || cat === 'outdatedSources' || cat === 'noProductSources') return ''
  const group = health.value[cat]
  const notes: string[] = []
  if (group.count > group.items.length) {
    notes.push(`共 ${group.count} 張,先列前 ${group.items.length} 張;處理完重新整理會再列出其餘的。`)
  }
  // 掃描達上限時計數本身就是低估的,不講清楚店家會以為「清完就沒事了」
  if (health.value.chunkScanTruncated) {
    notes.push('知識數量較多,體檢只掃描了其中一部分,實際張數可能更多。')
  }
  return notes.join(' ')
})

function openHealthList(cat: HealthCategory) {
  healthListCategory.value = cat
  healthListOpen.value = true
}

async function gotoHealthItem(item: { id: string; kind: 'source' | 'chunk' }) {
  healthListOpen.value = false
  if (item.kind === 'source') {
    const src = sources.value.find(s => s.id === item.id)
    if (src) await selectSource(src)
    else showToast('找不到這份資料(可能剛被刪除),請重新整理', 'error')
  }
  else {
    await openChunkById(item.id)
  }
}

// ── 產品名稱整理(別名歸一)───────────────────────────
// 同一台機器兩種叫法會被 AI 當成兩台(反問二選一、出貨時間並列)。系統偵測候選、由人確認——
// 不自動合併:「W1 REGEN」與「W1 REGEN ULTRA」字面上也像別名,但那是兩台不同機器。
interface AliasCandidate {
  key: string
  a: string
  b: string
  reason: string
  confidence: 'high' | 'medium'
  variantRisk: boolean
}
interface AliasPair { aliasKey: string; alias: string; canonical: string }

const aliasOpen = ref(false)
const aliasLoading = ref(false)
const aliasSaving = ref('')
const aliasCandidates = ref<AliasCandidate[]>([])
const aliasPairs = ref<AliasPair[]>([])
/**
 * 工具列徽章的數字。**資料是體檢端點**(進頁面就載入),不是這個視窗自己的清單——
 * 只有開過視窗才有數字的話,使用者永遠沒有理由去點它,整個別名功能等於不存在。
 * 開過視窗後改用視窗內的即時清單(按完確認數字要馬上少一)。
 */
const aliasDialogLoaded = ref(false)
const aliasCandidateCount = computed(() =>
  aliasDialogLoaded.value ? aliasCandidates.value.length : health.value.aliasCandidateCount)

async function loadAliases() {
  aliasLoading.value = true
  try {
    const res = await apiFetch<{ candidates: AliasCandidate[]; pairs: AliasPair[] }>(
      '/api/ai/knowledge/product-aliases',
    )
    aliasCandidates.value = res.candidates ?? []
    aliasPairs.value = res.pairs ?? []
    aliasDialogLoaded.value = true
  }
  catch (err: any) {
    showToast(err?.statusMessage || '讀取產品名稱失敗', 'error')
  }
  finally {
    aliasLoading.value = false
  }
}

async function openAliasDialog() {
  aliasOpen.value = true
  await loadAliases()
}

async function decideAlias(c: AliasCandidate, action: 'confirm' | 'dismiss') {
  aliasSaving.value = c.key
  try {
    const res = await apiFetch<{ changed?: boolean }>('/api/ai/knowledge/product-aliases', {
      method: 'POST',
      body: action === 'confirm'
        ? { action: 'confirm', canonical: c.a, alias: c.b }
        : { action: 'dismiss', a: c.a, b: c.b },
    })
    showToast(
      action !== 'confirm'
        ? '好的，不再詢問這一組'
        // 沒異動時要講清楚,否則清單少一列但沒發生任何事,看起來像剛才那次沒生效
        : res?.changed === false
          ? '這兩個名字本來就已經對應到同一台了'
          : '已合併，AI 之後會把它們當同一台',
      'success',
    )
    await loadAliases()
    void loadHealth(true)
  }
  catch (err: any) {
    showToast(err?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    aliasSaving.value = ''
  }
}

async function undoAlias(p: AliasPair) {
  aliasSaving.value = p.aliasKey
  try {
    await apiFetch('/api/ai/knowledge/product-aliases', {
      method: 'POST',
      body: { action: 'remove', alias: p.alias },
    })
    showToast('已解除', 'success')
    await loadAliases()
  }
  catch (err: any) {
    showToast(err?.statusMessage || '解除失敗', 'error')
  }
  finally {
    aliasSaving.value = ''
  }
}

// ── 資料夾 CRUD ─────────────────────────────────────
async function createFolderPrompt() {
  try {
    const { value } = await ElMessageBox.prompt('輸入資料夾名稱：', '新資料夾', {
      confirmButtonText: '建立',
      cancelButtonText: '取消',
      inputPlaceholder: '例：客服 FAQ',
      inputPattern: /^.{1,50}$/,
      inputErrorMessage: '名稱長度需 1–50 字',
    })
    const name = String(value ?? '').trim()
    if (!name) return
    const folder = await apiFetch<FolderRow>('/api/ai/folders', { method: 'POST', body: { name } })
    folders.value = [...folders.value, folder]
    expandedFolders.value = new Set([...expandedFolders.value, folder.id])
    saveExpandedState()
    showToast('已建立資料夾', 'success')
  }
  catch { /* 使用者取消 */ }
}

// 編輯資料夾 modal — 改名 + 刪除都在這裡做
function openFolderEdit(folder: FolderRow) {
  folderEditTarget.value = folder
  folderForm.value = { name: folder.name }
  folderEditOpen.value = true
}

async function saveFolderName() {
  if (!folderEditTarget.value) return
  const target = folderEditTarget.value
  const newName = folderForm.value.name.trim()
  if (!newName || newName === target.name) return
  folderSaving.value = true
  try {
    const res = await apiFetch<FolderRow>(`/api/ai/folders/${target.id}`, {
      method: 'PUT',
      body: { name: newName },
    })
    const idx = folders.value.findIndex(f => f.id === target.id)
    if (idx >= 0) folders.value[idx] = res
    showToast('已重新命名', 'success')
    folderEditOpen.value = false
  }
  catch (err: any) {
    showToast(err?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    folderSaving.value = false
  }
}

async function deleteFolderFromModal() {
  if (!folderEditTarget.value) return
  const target = folderEditTarget.value
  const count = countByFolder.value[target.id] ?? 0
  const msg = count
    ? `要刪除「${target.name}」這個資料夾嗎？\n底下的 ${count} 筆資料會自動移到「未分類」，不會被刪除。`
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
  folderDeleting.value = true
  try {
    await apiFetch(`/api/ai/folders/${target.id}`, { method: 'DELETE' })
    folders.value = folders.value.filter(f => f.id !== target.id)
    // 把底下的 source 顯示在「未分類」
    for (const s of sources.value) {
      if (s.folderId === target.id) s.folderId = null
    }
    showToast(count ? `已刪除資料夾，${count} 筆資料已移至未分類` : '已刪除空資料夾', 'success')
    folderEditOpen.value = false
  }
  catch (err: any) {
    showToast(err?.statusMessage || '刪除失敗', 'error')
  }
  finally {
    folderDeleting.value = false
  }
}

async function selectSource(src: SourceSummary) {
  selectedId.value = src.id
  indexPollStartedAt = 0 // 換資料重新起算輪詢時限
  // 先清空再載入:否則標頭已換、知識列表還是上一份資料的(快速切換會張冠李戴)
  chunks.value = []
  detailLoading.value = true
  try {
    await loadSourceDetail(src.id)
  }
  finally {
    // 只有「仍然選著這份資料」才收 spinner:A 的 finally 不該關掉 B 正在跑的 loading
    if (selectedId.value === src.id) detailLoading.value = false
  }
}

async function loadSourceDetail(sourceId: string) {
  try {
    const res = await apiFetch<{ source: SourceSummary; chunks: ChunkRow[] }>(`/api/ai/sources/${sourceId}`)
    // 過期回應防護:等待期間使用者已切到別的資料 → 這份回應作廢。
    // 沒有這行的話,慢的舊請求晚到會把 A 的知識/同步設定蓋進 B 的畫面(張冠李戴),
    // 此時按「儲存設定」還會把 A 的同步間隔寫進 B。
    if (selectedId.value !== sourceId) return
    // 用最新的 source 覆寫 list 裡的同一筆，保證 detail 不過時
    const idx = sources.value.findIndex(s => s.id === sourceId)
    if (idx >= 0) sources.value[idx] = res.source
    chunks.value = res.chunks
    // 編輯視窗開著時同步該卡最新索引狀態（輪詢刷新列表,視窗裡的「處理中」也要跟著變）
    if (chunkEditOpen.value && chunkEditingId.value) {
      const row = res.chunks.find(c => c.id === chunkEditingId.value)
      if (row) {
        chunkEditStatus.value = row.status
        chunkEditFailureReason.value = row.failureReason ?? ''
      }
    }
    settingsForm.value = {
      refreshIntervalMinutes: res.source.refreshIntervalMinutes,
      onChangeBehavior: res.source.onChangeBehavior,
      urlAutoApply: res.source.urlAutoApply !== false,
    }
    settingsBaseline.value = { ...settingsForm.value }
    productNameForm.value = res.source.productName
    productNameBaseline.value = res.source.productName
    urlForm.value = res.source.url ?? ''
    // 抓取失敗的 Sheet:把要分享的帳號先撈好，商家一眼就看到要加誰（不必再去開匯入視窗找）
    if (res.source.failureReason && res.source.type === 'gsheet') void loadServiceAccountEmail()
  }
  catch (err: any) {
    showToast(err?.statusMessage || '載入細節失敗', 'error')
  }
}

// ── 所屬產品（P1-1）─────────────────────────────────
// 產品名進 embedding 前綴，舊向量還帶舊值 → 儲存後一律接著重建這份資料的索引才生效。
const productNameForm = ref('')
const productNameBaseline = ref('')
const savingProductName = ref(false)

// ── 抓取失敗:就地修 ──────────────────────────────────
// 兩種最常見原因,修的地方各自不同(一個在 Google 那邊、一個是網址換了),
// 所以要把「該做什麼」和「做的工具」放在失敗訊息旁邊,而不是只印後端原文。
const failureAdvice = computed(() => {
  const s = selectedSource.value
  if (!s?.failureReason) return { kind: 'other' as const, what: '' }
  if (s.type === 'gsheet') {
    return {
      kind: 'gsheet' as const,
      what: '最常見的原因是這份 Google 試算表沒有分享給下面這個帳號。到試算表按「共用」，把這個帳號加為「檢視者」，再回來按上方「立即同步」。',
    }
  }
  if (s.type === 'url') {
    return {
      kind: 'url' as const,
      what: '原本的網頁可能被移走或改網址了。確認新網址後貼在下面換掉，換好會自動重新抓一次；網頁只是暫時掛掉的話，按上方「重新同步」再試即可。',
    }
  }
  return {
    kind: 'other' as const,
    what: '檔案或文字資料不會自動更新。內容有問題請重新匯入一次這份資料。',
  }
})

const serviceAccountEmail = ref('')
async function loadServiceAccountEmail() {
  if (serviceAccountEmail.value) return
  const res = await apiFetch<{ serviceAccountEmail: string }>('/api/ai/knowledge/gsheet-account').catch(() => null)
  serviceAccountEmail.value = res?.serviceAccountEmail ?? ''
}
async function copyServiceAccount() {
  try {
    await navigator.clipboard.writeText(serviceAccountEmail.value)
    showToast('已複製帳號', 'success')
  }
  catch {
    showToast('複製失敗，請手動選取', 'error')
  }
}

const urlForm = ref('')
const savingUrl = ref(false)
async function saveSourceUrl() {
  if (!selectedId.value) return
  const next = urlForm.value.trim()
  savingUrl.value = true
  try {
    await apiFetch(`/api/ai/sources/${selectedId.value}`, { method: 'PUT', body: { url: next } })
    showToast('網址已更新，正在重新抓取⋯', 'success')
    // 換網址等於換一份內容:直接走既有的「重新同步」流程讓使用者確認差異
    await loadSources(true)
    await loadSourceDetail(selectedId.value)
    await startResync()
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || err?.statusMessage || '更新網址失敗', 'error')
  }
  finally {
    savingUrl.value = false
  }
}

async function saveProductName() {
  if (!selectedId.value) return
  const next = productNameForm.value.trim()
  savingProductName.value = true
  try {
    await apiFetch(`/api/ai/sources/${selectedId.value}`, {
      method: 'PUT',
      body: { productName: next },
    })
    const res = await apiFetch<{ indexed: number; failed: number }>(
      `/api/ai/sources/${selectedId.value}/reindex`,
      { method: 'POST' },
    )
    productNameBaseline.value = next
    if (res.failed > 0) {
      showToast(`已儲存；${res.indexed} 張學習成功 / ${res.failed} 張失敗，可再按一次重試`, 'error')
    }
    else {
      showToast(`已儲存，AI 已重新學會這份資料的 ${res.indexed} 條`, 'success')
    }
    await loadSourceDetail(selectedId.value)
    void loadHealth(true) // 「未設產品名」的計數要立刻反映
  }
  catch (err: any) {
    showToast(err?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    savingProductName.value = false
  }
}

// ── 索引狀態輪詢 ─────────────────────────────────────
// 知識存檔後是 pending（「處理中，約 5–30 秒」），但畫面不會自己更新——使用者要
// 手動點來點去才看得到變成「可用」，會以為壞掉。有 pending 卡就每 5 秒刷新一次
// 選中的資料，全部完成即停；上限 2 分鐘（真卡住的交給排程重試 + 手動重新整理）。
const INDEX_POLL_INTERVAL_MS = 5000
const INDEX_POLL_MAX_MS = 2 * 60 * 1000
let indexPollTimer: ReturnType<typeof setTimeout> | null = null
let indexPollStartedAt = 0

function stopIndexPolling() {
  if (indexPollTimer) {
    clearTimeout(indexPollTimer)
    indexPollTimer = null
  }
}

function maybeScheduleIndexPoll() {
  const hasPending = chunks.value.some(c => c.status === 'pending')
  if (!hasPending) {
    stopIndexPolling()
    indexPollStartedAt = 0
    return
  }
  if (indexPollTimer) return
  if (!indexPollStartedAt) indexPollStartedAt = Date.now()
  if (Date.now() - indexPollStartedAt > INDEX_POLL_MAX_MS) return
  indexPollTimer = setTimeout(async () => {
    indexPollTimer = null
    if (selectedId.value) await loadSourceDetail(selectedId.value)
    else maybeScheduleIndexPoll()
  }, INDEX_POLL_INTERVAL_MS)
}

// chunks 每次被 loadSourceDetail 整組替換都會觸發 → 完成即停、有 pending 就續排
watch(chunks, () => maybeScheduleIndexPoll())
onBeforeUnmount(stopIndexPolling)

async function saveSettings() {
  if (!selectedId.value) return
  savingSettings.value = true
  try {
    await apiFetch(`/api/ai/sources/${selectedId.value}`, {
      method: 'PUT',
      body: { ...settingsForm.value },
    })
    settingsBaseline.value = { ...settingsForm.value }
    showToast('已儲存設定', 'success')
    await loadSourceDetail(selectedId.value)
  }
  catch (err: any) {
    showToast(err?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    savingSettings.value = false
  }
}

async function deleteSource() {
  if (!selectedSource.value) return
  const src = selectedSource.value

  // 二次確認強度依風險分級:只有 1 條(多為手寫條目)用一般確認即可,
  // 多條的資料才要求打「刪除」二字——避免對小物件過度確認、對大物件確認不足
  try {
    if (src.chunkCount <= 1) {
      await ElMessageBox.confirm(
        `要刪除「${src.name}」嗎?底下 ${src.chunkCount} 條知識會一併刪除,無法復原。`,
        '刪除確認',
        {
          confirmButtonText: '刪除',
          cancelButtonText: '取消',
          confirmButtonClass: 'el-button--danger',
          type: 'warning',
        },
      )
    }
    else {
      await ElMessageBox.prompt(
        `要刪除「${src.name}」這份資料，會連同底下 ${src.chunkCount} 條知識全部刪除，無法復原。\n\n請在下方輸入「刪除」確認：`,
        '刪除確認',
        {
          confirmButtonText: '永久刪除',
          cancelButtonText: '取消',
          confirmButtonClass: 'el-button--danger',
          inputPattern: /^刪除$/,
          inputErrorMessage: '請輸入「刪除」兩個字',
          inputPlaceholder: '刪除',
          type: 'warning',
          roundButton: true,
        },
      )
    }
  }
  catch {
    return // 使用者取消或關閉
  }

  deleting.value = true
  try {
    await apiFetch(`/api/ai/sources/${selectedId.value}`, { method: 'DELETE' })
    showToast(`已刪除「${src.name}」`, 'success')
    selectedId.value = null
    chunks.value = []
    await loadSources(true)
  }
  catch (err: any) {
    showToast(err?.statusMessage || '刪除失敗', 'error')
  }
  finally {
    deleting.value = false
  }
}

// ── 重新同步(背景作業版)────────────────────────────
// 舊版一個請求做完「重抓+LLM 重切+比對」,大頁面 30 秒必撞閘道逾時,使用者只看到
// 「取得差異失敗」。改走匯入同一套背景狀態機:建 job → 輪詢進度 → 永不逾時,可取消。
const { progress: resyncProgress, poll: pollResyncJob, cancel: cancelResync, reset: resetResyncPoll } = usePreviewJobPoll()

const resyncButtonLabel = computed(() => {
  if (!resyncing.value) return '重新同步'
  const p = resyncProgress.value
  if (!p) return '重新抓取網頁⋯'
  return p.total > 1 ? `${p.label} ${p.done}/${p.total}⋯` : `${p.label}⋯`
})

interface ResyncDoneResponse {
  status: 'done'
  sourceName: string
  sourceUrl: string
  rawLength: number
  truncated: boolean
  warnings?: string[]
  resync?: {
    sourceId: string
    contentHash: string
    diff: DiffData['diff'] | null
    shrink: { oldChars: number; newChars: number } | null
    warnings?: string[]
  }
}

/** 縮水警示的二次確認(勾了才放行套用) */
const shrinkAcknowledged = ref(false)

/**
 * 重新同步。force=true 是「網頁其實沒變、但我還是要 AI 重新整理一次」的escape hatch
 * （例如想換一種切法、或有卡片索引失敗想重來）。
 */
async function startResync(force = false) {
  if (!selectedId.value) return
  const sid = selectedId.value
  resyncing.value = true
  resyncNoChange.value = null
  resetResyncPoll()
  try {
    const created = await apiFetch<{ jobId?: string; status?: string }>(`/api/ai/sources/${sid}/resync-jobs`, {
      method: 'POST',
      body: { force },
    })
    // 網頁與「上次整理的那一版」逐字元相同 → 後端不會建 job,也沒有東西要決定。
    // 誠實講「沒變」比丟一份假差異給人審好；真的想重整仍留一顆按鈕。
    if (created.status === 'unchanged' || !created.jobId) {
      resyncNoChange.value = sid
      await loadSources(true) // 後端已把「有變動」標記清掉,列表與體檢要跟上
      return
    }
    const res = await pollResyncJob<ResyncDoneResponse>(created.jobId)
    if (!res.resync?.diff) throw new Error('比對結果不完整,請再試一次')
    const shrink = res.resync.shrink ?? null
    diffData.value = {
      sourceId: sid,
      sourceName: res.sourceName,
      sourceUrl: res.sourceUrl,
      contentHash: res.resync.contentHash,
      diff: res.resync.diff,
      shrink,
      warnings: res.resync.warnings ?? [],
    }
    // 用後端 defaultAction 初始化使用者決定。
    // 內容縮水時「移除」多半是抓不到而不是真下架 → 一律預設保留,不能預設刪除
    // (預設值就是絕大多數人會直接送出的值,警告文字擋不住習慣性按主按鈕)。
    const init: Record<string, string> = {}
    for (const e of res.resync.diff.entries) {
      init[e.id] = shrink && e.kind === 'removed' ? 'keep_old' : e.defaultAction
    }
    decisions.value = init
    shrinkAcknowledged.value = false
    diffOpen.value = true
  }
  catch (err: any) {
    // 錯誤三要素:發生什麼 / 資料有沒有被動到 / 下一步。比對是唯讀的,可以誠實保證沒動到。
    if (err?.message === PREVIEW_JOB_CANCELLED) {
      showToast('已取消重新同步;你的知識沒有被改動', 'success')
    }
    else {
      const reason = err?.data?.statusMessage || err?.statusMessage || err?.message || '重新整理沒有完成'
      showToast(`${reason}。你的知識沒有被改動,可以再試一次;一直失敗的話,請把網頁內容複製下來用「貼上文字」重新匯入,或聯絡我們。`, 'error')
    }
  }
  finally {
    resyncing.value = false
  }
}

async function syncGsheetNow() {
  if (!selectedId.value) return
  gsheetSyncing.value = true
  try {
    const res = await apiFetch<{ outcome: 'unchanged' | 'synced'; added: number; updated: number; deleted: number; kept: number }>(
      `/api/ai/sources/${selectedId.value}/gsheet-sync`,
      { method: 'POST', body: {} },
    )
    await loadSourceDetail(selectedId.value)
    // 同步成功也可能剛清掉失敗標記 → 一定要 force 重跑體檢。
    // 只重載明細的話,體檢有 60 秒快取,商家修好了畫面仍紅著,只能自己 F5。
    await loadSources(true)
    if (res.outcome === 'unchanged') {
      showToast('已是最新，無變動', 'success')
    }
    else {
      showToast(`同步完成：新增 ${res.added}、更新 ${res.updated}、刪除 ${res.deleted}`, 'success')
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || '同步失敗', 'error')
  }
  finally {
    gsheetSyncing.value = false
  }
}

async function applyDiff() {
  if (!diffData.value) return
  // 一律套用回「算這份 diff 的那份資料」,不是「當下選中的資料」——重新同步改成背景作業後
  // 可能跑好幾分鐘,期間使用者能點別的資料;用 selectedId 會把 A 的知識建到 B 底下,
  // 還會用 A 的網頁指紋覆蓋 B 的變動偵測基準。
  const targetId = diffData.value.sourceId
  if (!targetId) return
  if (selectedId.value !== targetId) {
    const targetName = diffData.value.sourceName || '原資料'
    try {
      await ElMessageBox.confirm(
        `這份差異是「${targetName}」的比對結果,會套用回該資料(不是你目前選中的資料)。要繼續嗎?`,
        '確認套用對象',
        { confirmButtonText: '套用到原資料', cancelButtonText: '取消', type: 'warning' },
      )
    }
    catch {
      return
    }
  }
  applying.value = true
  try {
    const res = await apiFetch<{ added: number; updated: number; deleted: number; kept: number; errors: any[] }>(
      `/api/ai/sources/${targetId}/resync-apply`,
      {
        method: 'POST',
        body: {
          entries: diffData.value.diff.entries,
          decisions: decisions.value,
          contentHash: diffData.value.contentHash ?? '',
        },
      },
    )
    // 失敗清單要讓非技術使用者「看得到是哪幾張」,不能只說去看 console
    if (res.errors?.length) {
      const titleOf = (entryId: string) => {
        const e = diffData.value?.diff.entries.find(x => x.id === entryId)
        return e?.newChunk?.title || e?.oldChunk?.title || entryId
      }
      const names = res.errors.slice(0, 3).map((er: any) => `「${titleOf(String(er.entryId))}」`).join('、')
      showToast(
        `已套用:新增 ${res.added}、更新 ${res.updated}、刪除 ${res.deleted};但 ${res.errors.length} 張失敗:${names}${res.errors.length > 3 ? ' 等' : ''},請對這幾張重新同步或手動編輯`,
        'warning',
      )
      console.warn('[resync-apply] errors:', res.errors)
    }
    else {
      showToast(`已套用：新增 ${res.added}、更新 ${res.updated}、刪除 ${res.deleted}、保留 ${res.kept}`, 'success')
    }
    diffOpen.value = false
    diffData.value = null
    await loadSources(true)
    // 重載「被套用的那份資料」;使用者若已切到別的資料,那邊的畫面不受影響
    if (selectedId.value === targetId) await loadSourceDetail(targetId)
  }
  catch (err: any) {
    showToast(err?.statusMessage || '套用失敗', 'error')
  }
  finally {
    applying.value = false
  }
}

// ── 全部重新索引(admin;後端分批,帶 nextCursor 跑到底) ──────
const reindexingAll = ref(false)

async function reindexAll() {
  try {
    await ElMessageBox.confirm(
      '讓 AI 把這個工作區的所有知識重新學習一次(知識內容不會變)。通常只在系統升級後需要;知識多時要花幾分鐘,期間 AI 照常運作。',
      '全部重新學習',
      { confirmButtonText: '開始', cancelButtonText: '取消', type: 'warning' },
    )
  }
  catch { return }
  reindexingAll.value = true
  try {
    let cursor: string | null = null
    let indexed = 0
    let failed = 0
    do {
      // res 顯式標型:cursor ↔ res.nextCursor 互相參照會讓 TS 推導成循環(TS7022)
      const res: { batch: number; indexed: number; failed: number; nextCursor: string | null } = await apiFetch(
        '/api/ai/knowledge/reindex-all',
        { method: 'POST', body: cursor ? { cursor } : {} },
      )
      indexed += res.indexed
      failed += res.failed
      cursor = res.nextCursor
    } while (cursor)
    showToast(`重新學習完成:${indexed} 張成功${failed ? `、${failed} 張失敗(可在知識上個別重試)` : ''}`, failed ? 'warning' : 'success')
    if (selectedId.value) await loadSourceDetail(selectedId.value)
  }
  catch (err: any) {
    showToast(err?.statusMessage || '重新學習失敗,請再試一次', 'error')
  }
  finally {
    reindexingAll.value = false
  }
}

// ── 匯入彈窗(原獨立頁面已整併) ──────────────────────
const importOpen = ref(false)
function goImport() { importOpen.value = true }

async function onImported(sourceId: string | null) {
  await loadSources(true)
  if (sourceId) {
    const src = sources.value.find(s => s.id === sourceId)
    if (src) await selectSource(src)
  }
}

// ── 一鍵整理舊版未分組知識 ───────────────────────────
async function migrateOrphans() {
  migrating.value = true
  try {
    const res = await apiFetch<{ migrated: number; capped: boolean }>(
      '/api/ai/sources/migrate-orphans',
      { method: 'POST', body: {} },
    )
    const tail = res.capped ? '（達單次上限 200，剩下的請再點一次）' : ''
    showToast(`已整理 ${res.migrated} 張舊卡為手寫條目${tail}`, 'success')
    await loadSources(true)
  }
  catch (err: any) {
    showToast(err?.statusMessage || '整理失敗', 'error')
  }
  finally {
    migrating.value = false
  }
}

// ── 重新命名（用 ElMessageBox.prompt） ───────────────
// 名稱直接在表頭 inline 編輯（跟其他編輯頁一致）：Enter 或失焦即存。
// selectedSource 是唯讀 computed，故用 nameDraft 暫存，並隨選取的資料同步。
const nameDraft = ref('')
watch(() => selectedSource.value?.name, (n) => { nameDraft.value = n ?? '' }, { immediate: true })

let savingName = false
async function commitName() {
  const current = selectedSource.value?.name ?? ''
  const next = nameDraft.value.trim()
  if (savingName) return
  if (!next || next === current) { nameDraft.value = current; return }  // 空或沒變 → 還原、不打 API
  if (next.length > 200) { showToast('名稱長度需 1–200 字', 'warning'); nameDraft.value = current; return }
  savingName = true
  try {
    await apiFetch(`/api/ai/sources/${selectedId.value}`, { method: 'PUT', body: { name: next } })
    showToast('已重新命名', 'success')
    await loadSources()
    if (selectedId.value) await loadSourceDetail(selectedId.value)
  }
  catch {
    nameDraft.value = current  // 失敗還原
    showToast('重新命名失敗', 'error')
  }
  finally { savingName = false }
}

// ── 新增手寫知識 ─────────────────────────────────────
function openCreateManual() {
  // 每次重開都要清掉「待銷案的問句」:從 ?q= 進來卻放棄、之後自己手寫另一條時,
  // 殘留的舊問句會讓不相干的知識把監控頁案例誤標成已處理
  pendingResolveQuery.value = ''
  chunkEditMode.value = 'create'
  chunkEditingId.value = null
  chunkForm.value = { title: '', content: '', tags: [], questions: undefined }
  chunkEditStatus.value = ''
  chunkEditFailureReason.value = ''
  chunkEnabled.value = true
  chunkActiveUntil.value = ''
  chunkExpiredAtMs.value = 0
  chunkSettingsOriginal = { enabled: true, activeUntil: '' }
  chunkAdvancedOpen.value = false
  chunkEditOpen.value = true
}

// ── 編輯既有 chunk ───────────────────────────────────
function openEditChunk(chunk: ChunkRow) {
  chunkEditMode.value = 'edit'
  chunkEditingId.value = chunk.id
  chunkForm.value = {
    title: chunk.title,
    content: chunk.content,
    tags: [...(chunk.tags ?? [])],
    // 載入既有問法（以前傳 undefined＝欄位不顯示，結果從「補知識」存進去的客人原話
    // 改不掉；那句話會一直被 AI 學著，可能還夾著電話姓名）
    questions: [...(chunk.questions ?? [])],
  }
  chunkEditStatus.value = chunk.status
  chunkEditFailureReason.value = chunk.failureReason ?? ''
  chunkEnabled.value = chunk.status !== 'disabled'
  chunkActiveUntil.value = chunk.activeUntilMs ? ymdLabel(chunk.activeUntilMs) : ''
  chunkExpiredAtMs.value = chunk.expiredAtMs || 0
  chunkSettingsOriginal = { enabled: chunkEnabled.value, activeUntil: chunkActiveUntil.value }
  // 有標籤/設過期限/到期停用過 → 進階預設展開,別把生效中的設定藏起來
  chunkAdvancedOpen.value = chunkForm.value.tags.length > 0 || !!chunkActiveUntil.value || chunkExpiredAtMs.value > 0
  chunkEditOpen.value = true
}

// ── AI 整理(normalize):加重點摘要、去系統碼 ─────────
async function normalizeChunkFromModal() {
  const original = chunkForm.value.content.trim()
  if (!original) return
  chunkNormalizing.value = true
  try {
    const res = await apiFetch<{ title: string; content: string; tags: string[]; questions?: string[] }>(
      '/api/ai/knowledge/normalize',
      {
        method: 'POST',
        body: {
          title: chunkForm.value.title,
          content: chunkForm.value.content,
          tags: chunkForm.value.tags,
        },
      },
    )
    chunkForm.value.title = res.title || chunkForm.value.title
    chunkForm.value.content = res.content
    chunkForm.value.tags = res.tags
    if (res.questions?.length) chunkForm.value.questions = res.questions
    showToast('已整理 — 記得儲存', 'success')
  }
  catch (err: any) {
    showToast(err?.statusMessage || 'AI 整理失敗', 'error')
  }
  finally {
    chunkNormalizing.value = false
  }
}

// ── 重新索引(索引失敗的卡) ──────────────────────────
async function reindexChunkFromModal() {
  if (!chunkEditingId.value) return
  chunkReindexing.value = true
  try {
    await apiFetch(`/api/ai/knowledge/${chunkEditingId.value}/reindex`, { method: 'POST' })
    showToast('已重新學習', 'success')
    if (selectedId.value) await loadSourceDetail(selectedId.value)
    const updated = chunks.value.find(c => c.id === chunkEditingId.value)
    if (updated) {
      chunkEditStatus.value = updated.status
      chunkEditFailureReason.value = updated.failureReason ?? ''
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || '重新學習失敗', 'error')
  }
  finally {
    chunkReindexing.value = false
  }
}

/**
 * 存完知識就地試問一次,把「AI 現在答不答得出來」直接講給使用者聽。
 *
 * 為什麼要有:以前存好只知道「已建立」,要確認 AI 真的會用得換頁去「測試對話」重打一次;
 * 而系統建議那條路(採用並學習)早就會自動試答並回報——同一件事不該兩種待遇。
 * 用客人問法優先(那才是客人真的會打的句子),沒有就退回標題。
 * 背景跑、不擋畫面;失敗完全靜默(這是加值資訊,不是必要步驟)。
 */
async function verifyChunkAnswerable(title: string, question?: string) {
  const query = (question || title || '').trim()
  if (!query) return
  try {
    const res = await apiFetch<{ timedOut: boolean; decision: string; confidence: number }>(
      '/api/ai/knowledge/verify',
      { method: 'POST', body: { query } },
    )
    if (res.timedOut) return
    if (res.decision === 'answered') {
      showToast(`AI 已經學會了——用「${query.slice(0, 14)}」試問，答得出來`, 'success')
    }
    else if (res.decision === 'disambiguate') {
      showToast('已學會。這題和既有內容相近，AI 會先問客人是指哪一個再回答', 'success')
    }
    else {
      // 卡存好了但試答仍答不出＝還沒真的解決,用警示色而不是綠色
      showToast('知識已存好，但試問這題 AI 還是答不出來——建議把客人的問法補上，或到「測試對話」看細節', 'warning')
    }
  }
  catch {
    // 驗證失敗不影響存檔結果,不打擾
  }
}

async function saveChunk() {
  const t = chunkForm.value.title.trim()
  const c = chunkForm.value.content.trim()
  if (!t || !c) return
  chunkSaving.value = true
  try {
    const body: Record<string, unknown> = { title: t, content: c, tags: chunkForm.value.tags }
    // 只要欄位有出現在畫面上就照送（含清成空陣列）——用 length 判斷的話，
    // 使用者把夾了個資的問法全部刪掉會送不出去，等於刪不掉。
    // undefined = 這次沒有這個欄位，後端保留既有值。
    if (chunkForm.value.questions !== undefined) body.questions = chunkForm.value.questions
    if (chunkEditMode.value === 'create') {
      // 建立新手寫知識（後端會自動建一個 type='manual' 的 source 包它）
      const res = await apiFetch<{ id: string; sourceId: string }>('/api/ai/knowledge/create', {
        method: 'POST',
        body,
      })
      showToast('已建立', 'success')
      chunkEditOpen.value = false
      // 就地驗證:不用再換頁去「測試對話」重打一次(與系統建議那條路的行為對齊)
      void verifyChunkAnswerable(t, chunkForm.value.questions?.[0])
      // 從監控頁 ?q= 進來的:建完卡自動把同問題的轉真人案例標已處理,不用回去逐筆按
      if (pendingResolveQuery.value) {
        const resolvedQ = pendingResolveQuery.value
        pendingResolveQuery.value = ''
        apiFetch<{ resolved: number }>('/api/ai/usage/handoffs/resolve-by-query', {
          method: 'POST',
          body: { query: resolvedQ },
        })
          .then((r) => {
            if (r.resolved > 0) showToast(`已把監控頁 ${r.resolved} 筆同問題案例標為已處理`, 'success')
          })
          .catch(() => {}) // 銷案是順手的加值動作,失敗不影響建卡
      }
      await loadSources(true)
      if (res.sourceId) {
        selectedId.value = res.sourceId
        await loadSourceDetail(res.sourceId)
      }
    }
    else if (chunkEditingId.value) {
      await apiFetch(`/api/ai/knowledge/${chunkEditingId.value}`, {
        method: 'PUT',
        body,
      })
      // 開關 / 有效期限有變才另打 settings(與內容編輯分開:不動 embedding)
      const settingsBody: Record<string, unknown> = {}
      if (chunkEnabled.value !== chunkSettingsOriginal.enabled) settingsBody.enabled = chunkEnabled.value
      if (chunkActiveUntil.value !== chunkSettingsOriginal.activeUntil) settingsBody.activeUntil = chunkActiveUntil.value || null
      if (Object.keys(settingsBody).length) {
        await apiFetch(`/api/ai/knowledge/${chunkEditingId.value}/settings`, { method: 'POST', body: settingsBody })
      }
      showToast('已儲存', 'success')
      chunkEditOpen.value = false
      void verifyChunkAnswerable(t, chunkForm.value.questions?.[0])
      if (selectedId.value) await loadSourceDetail(selectedId.value)
      await loadSources(true) // 因為 manual source 名稱可能跟著變
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    chunkSaving.value = false
  }
}

async function deleteChunkFromModal() {
  if (chunkEditMode.value !== 'edit' || !chunkEditingId.value) return
  const title = chunkForm.value.title || '(未命名)'
  try {
    await ElMessageBox.confirm(
      `要刪除「${title}」這一條片嗎？無法復原。`,
      '刪除知識',
      {
        confirmButtonText: '刪除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
        type: 'warning',
      },
    )
  }
  catch { return }
  const targetId = chunkEditingId.value
  chunkDeleting.value = true
  try {
    await apiFetch(`/api/ai/knowledge/${targetId}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    chunkEditOpen.value = false
    // 若這張是 manual single-card source 的唯一卡，後端會連 source 一起刪 → 重載 source list
    await loadSources(true)
    if (selectedId.value) {
      const stillExists = sources.value.find(s => s.id === selectedId.value)
      if (stillExists) await loadSourceDetail(selectedId.value)
      else selectedId.value = null
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || '刪除失敗', 'error')
  }
  finally {
    chunkDeleting.value = false
  }
}

// ── Chunk tag input ─────────────────────────────────
function showChunkTagInput() {
  chunkTagInputVisible.value = true
  nextTick(() => chunkTagInputEl.value?.focus())
}
function commitChunkTag() {
  const t = chunkTagInput.value.trim()
  if (t && !chunkForm.value.tags.includes(t)) {
    chunkForm.value.tags = [...chunkForm.value.tags, t]
  }
  chunkTagInput.value = ''
  chunkTagInputVisible.value = false
}
function removeChunkTag(t: string) {
  chunkForm.value.tags = chunkForm.value.tags.filter(x => x !== t)
}

// ─── Display helpers ───────────────────────────────────
function typeEmoji(t: string | undefined) {
  return t === 'url' ? '網址' : t === 'file' ? '檔案' : t === 'gsheet' ? 'Sheet' : '文字'
}
function typeLabel(t: string) {
  return t === 'url' ? '網址' : t === 'file' ? '檔案' : t === 'gsheet' ? 'Google Sheet' : '手打'
}
function statusLabel(s: string) {
  return s === 'ready' ? '可用' : s === 'fetching' ? '抓取中' : s === 'splitting' ? '整理中' : '失敗'
}
function chunkStatusLabel(s: string) {
  return s === 'indexed' ? '可用' : s === 'pending' ? '處理中' : s === 'disabled' ? '已停用' : '失敗'
}
function chunkStatusBadge(s: string) {
  return s === 'indexed' ? 'badge-green' : s === 'pending' ? 'badge-yellow' : s === 'disabled' ? 'badge-gray' : 'badge-red'
}
function statusChipText(src: SourceSummary) {
  if (src.outdatedAtMs > 0) return '有變動'
  if (src.status === 'ready') return '可用'
  return statusLabel(src.status)
}
function statusChipTone(src: SourceSummary): 'success' | 'warning' | 'error' | 'neutral' {
  if (src.outdatedAtMs > 0) return 'warning'
  if (src.status === 'ready') return 'success'
  if (src.status === 'failed') return 'error'
  return 'neutral'
}
function metaText(src: SourceSummary) {
  const parts: string[] = []
  parts.push(`${src.chunkCount} 條`)
  if (src.lastFetchedAtMs) parts.push(`同步：${relativeTime(src.lastFetchedAtMs)}`)
  return parts.join(' · ')
}
function kindLabel(k: string) {
  return k === 'new' ? '新增' : k === 'modified' ? '修改' : k === 'removed' ? '移除' : '未變'
}
function relativeTime(ms: number) {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}

onMounted(async () => {
  loadExpandedState()
  void loadAiEnabled() // 不 await:只影響「要處理的事」多一列,不該卡住頁面載入
  const route = useRoute()
  const router = useRouter()
  // deep-link query 是一次性的指令:處理完就從網址清掉,否則 F5 會再彈一次視窗
  const clearQuery = () => { router.replace({ query: {} }).catch(() => {}) }
  await loadSources()

  // 監控頁「補知識」帶 ?q=(客人沒被答到的問題):直接開新增手寫視窗、預填標題
  const q = String(route.query.q ?? '').trim()
  if (q) {
    clearQuery()
    // 先查有沒有現成的（避免同一題從三個入口進來各建一條）；沒有才直接開新增視窗
    await startAddKnowledge(q)
    return
  }

  // 測試對話頁「編輯」帶 ?chunkId=:反查所屬資料,自動選取並開啟該卡的編輯視窗
  const chunkId = String(route.query.chunkId ?? '').trim()
  if (chunkId) {
    await openChunkById(chunkId)
    clearQuery()
    return
  }

  // 匯入完成帶 ?sourceId=:自動選中剛匯入的資料,讓使用者直接看到成果
  const sourceId = String(route.query.sourceId ?? '').trim()
  if (sourceId) {
    const src = sources.value.find(s => s.id === sourceId)
    if (src) await selectSource(src)
    clearQuery()
    return
  }

  // 右下角異常中心帶 ?health=分類:直接開對應的問題清單。
  // 使用者在異常中心已經按過一次「去修」,到頁面後不該再自己找一遍同一件事。
  const healthParam = String(route.query.health ?? '').trim()
  if (healthParam && healthParam in HEALTH_META) {
    clearQuery()
    await loadHealth(true)
    openHealthList(healthParam as HealthCategory)
    return
  }

  // 舊的 /knowledge/import 網址轉進來時帶 ?import=1:直接打開匯入彈窗
  if (String(route.query.import ?? '') === '1') {
    importOpen.value = true
    clearQuery()
  }
})

async function openChunkById(chunkId: string) {
  try {
    const info = await apiFetch<{ id: string; sourceId: string | null }>(`/api/ai/knowledge/${chunkId}`)
    if (!info.sourceId) {
      showToast('這一條尚未歸入任何資料,請先用「一鍵整理」歸檔', 'error')
      return
    }
    const src = sources.value.find(s => s.id === info.sourceId)
    if (!src) {
      showToast('找不到這一條所屬的資料(可能已被刪除)', 'error')
      return
    }
    await selectSource(src)
    const chunk = chunks.value.find(c => c.id === chunkId)
    if (chunk) openEditChunk(chunk)
  }
  catch {
    showToast('找不到這一條(可能已被刪除)', 'error')
  }
}
</script>
