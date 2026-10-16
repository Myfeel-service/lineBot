<template>
  <!--
    三欄（`C-315`，老闆 10-15 拍板 `D-126` 第 2 題）：你的資料｜中間（工作台或那一份）｜右邊「問 AI」。
    右邊那一欄包在這一頁自己的外層（⛔ 不改共用的 AdminSplitLayout：二十幾頁在用，只有這一頁要第三欄）。
    放不下 340px 時（內容寬 < 1200）收成右上一顆「問 AI」、打開是抽屜；手機不放（手機工作台另排 `E-13`）。
    寬度看的是這一塊自己（ResizeObserver），不是整個視窗：左邊那條主選單收起來／展開，能放的寬度就不一樣。
  -->
  <div ref="colsRef" class="src-cols" :class="`src-cols--${askMode}`">
  <!-- 手機一次只看一邊（`D-124` 拍板做 `E-13` 的一小塊：手機拍照加入、看結果）：清單↔一份資料的內容 -->
  <AdminSplitLayout :is-empty="!selectedSource" mobile-stack mobile-back-label="你的資料" @mobile-back="backToWorkbench">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="kb-sources">你的資料<AdminPageHelpButton :topics="['knowledge', 'knowledge-manage']" :guides="['knowledge-first']" /></span>
      <!-- 工具列只留「加入知識」一顆主動作。原本 5 顆平鋪（含只有工程場景才按的「重新學習全部」）
           讓第一屏就要做五選一;次要與維護動作收進「⋯」 -->
      <div class="flex gap-1">
        <el-tooltip v-if="canEditKb" content="上傳檔案、貼網址或貼一段文字，AI 會自動整理" placement="bottom" :show-after="300">
          <el-button :icon="Upload" size="small" type="primary" plain data-tour="kb-import" @click="goImport">加入知識</el-button>
        </el-tooltip>
        <el-dropdown v-if="canEditKb || canEditFolders || canReindexAll" trigger="click">
          <!-- `kb-more`（`D-109`）：「新增資料夾」住在這個選單裡，導覽指這顆（指選單裡那一項的話，
               選單沒打開時聚光燈會框在一塊看不見的地方——Element Plus 的選單項目收著也在 DOM 裡） -->
          <el-button size="small" plain data-tour="kb-more">⋯</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <!-- 選單/按鈕用正式的功能動詞;白話留給說明文字(老闆 8/05:按鈕寫成口語句太過頭) -->
              <!--
                `C-323`（老闆 2026-10-15「這邊的 UIUX 是否都整理過」→ 照建議做）拿掉兩項：
                「手動新增知識」跟正下方「用一句話寫一條知識」打開同一個視窗＝重複的入口；
                「產品名稱整理」照 `D-126` 第 4 步改成分組裡的「客人還會怎麼叫它」（編輯分組），系統抓到的「可能是同一台」照舊進「要處理的事」
              -->
              <!-- `C-320`：這一頁的「資料夾」改叫「分組」（`D-126` 第 1 題：之後分組＝商品） -->
              <el-dropdown-item v-if="canEditFolders" data-tour="kb-folder-new" @click="createFolderPrompt">
                新增分組
              </el-dropdown-item>
              <el-dropdown-item v-if="canEditKb" @click="openRecycleBin">
                回收桶
              </el-dropdown-item>
              <!-- 全庫重新學習是工程維護動作（升級檢索方式後才需要），不該長在主工具列；`C-323` 起只有平台超管看得到（端點也擋） -->
              <el-dropdown-item v-if="canReindexAll" divided :disabled="reindexingAll" @click="reindexAll">
                {{ reindexingAll ? '重新學習中⋯' : '重新學習全部知識（維護用）' }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <!-- `D-112`：「用一句話建立」接在「加入知識」正下方（標頭 240px 塞不下第三顆）。
           建的卡放進「等你看過」，要他按採用才上線 -->
      <!-- 2026-10-12（`D-124`）：字改成講做出什麼——「一條」知識，跟上面「加入知識」（一整份資料）分得開。
           ⛔ 不收進加入視窗、不拿掉：推播、標籤、AI 腳本、知識庫四頁都在這個位置（`D-112`／`D-113`），
           只動這頁會不一致。換字是推播頁本來就有的做法（「用一句話擬草稿」） -->
      <!--
        `C-317`（`D-126` 第 3 題）：這一頁按了打開「補一條」小視窗（一兩句答案 → AI 整理 → 直接上線），不再叫小幫手。
        ⛔ 位置、大小、字、外觀照舊（同 AgentAskButton 那兩個 class）：推播、標籤、AI 腳本、知識庫四頁都在這個位置，
        只換這一頁按下去的事，不換它長什麼樣。建不了的人（沒有 knowledge.write）整顆不出現
      -->
      <div v-if="canEditKb" class="agent-ask-row">
        <el-button size="small" class="agent-ask-btn" :icon="ChatDotRound" @click="openAddOne()">用一句話寫一條知識</el-button>
      </div>
      <!-- 回工作台的那一行（老闆 8/05 要求有事時要看得到）：點了回工作台；兩邊都是空的才不顯示——沒事可提醒。
           `C-314`（老闆 10-14「只呈現需要的東西」）：只在選著一份資料時出現。沒選資料時右邊就是工作台、
           「要處理的事」整份攤在那裡，這一行再講一次「N 件要處理」是重複，點了也不會去任何地方 -->
      <button
        v-if="workbenchBadge && selectedSource"
        type="button"
        class="src-workbench-link"
        @click="backToWorkbench"
      >
        <el-icon class="src-workbench-link__icon"><FirstAidKit /></el-icon>
        <span class="src-workbench-link__text">{{ workbenchBadge }}</span>
        <span class="src-workbench-link__arrow">→</span>
      </button>

      <!--
        還在整理／整理好了的匯入工作(視窗關著時才顯示)。
        匯入的等待畫面告訴使用者「可以先關掉視窗去做別的事」,那就得有地方讓他知道
        事情做完了沒有——否則他回來只會看到一片乾淨畫面,以為系統把他的東西弄丟了。
      -->
      <button
        v-if="!importOpen && importJobState !== 'none'"
        type="button"
        class="src-workbench-link src-import-link"
        :class="{ 'src-import-link--ready': importJobDone }"
        @click="importOpen = true"
      >
        <el-icon
          class="src-workbench-link__icon"
          :class="{ 'is-loading': !importJobDone }"
        ><Loading v-if="!importJobDone" /><Check v-else /></el-icon>
        <!-- ready＝停在預覽等他看（`D-123`② 一份本來直接加入，停下來就是有要他核對的）；added＝關著視窗自己加好了 -->
        <span class="src-workbench-link__text">
          {{ importJobState === 'ready' ? '整理好了，等你看一下' : importJobState === 'added' ? '加好了，看結果' : importJobState === 'batch' ? '加入中，還沒跑完…' : '一份資料整理中…' }}
        </span>
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
              @click="openAddOne(searchKeyword.trim(), { resolveHandoffs: true })"
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
              <!-- 還在「等你看過」（`C-308`⑦）：搜得到、AI 卻還不會用——不標的話他以為這題已經有答案了 -->
              <span v-else-if="r.status === 'draft'" class="badge badge-yellow">等你看過</span>
            </span>
            <span class="src-search-row__snippet">{{ r.snippet }}</span>
          </button>
          <p v-if="searchCountTruncated" class="src-search-foot">符合的知識較多，只列出前 {{ searchResults.length }} 條。</p>
          <p v-if="searchTruncated" class="src-search-foot">知識較多，只搜尋了前面一部分。</p>
        </div>
      </div>

      <!--
        清單可能不完整（`C-137`）。⛔ 這一條不可以拿掉也不可以做成 toast：
        2026-09-04 的災情就是「少了東西、畫面卻長得完全正常」——老闆因此傳了三次
        同一份說明書。少講這一句，下一次還是會有人以為自己沒上傳成功。
      -->
      <div v-if="sourcesDegraded" class="src-degraded">
        <strong>這份清單可能不完整</strong>
        <span>資料庫索引缺失，有些資料讀不出來（東西還在，只是這裡列不出來）。搜尋仍然找得到，請把這句話回報給我們。</span>
      </div>

      <!-- 份數撞到上限（`C-138`）：搜尋／回收桶／體檢撞到都會講，這裡以前不會 -->
      <div v-if="sourcesTruncated && !sourcesDegraded" class="src-degraded">
        <strong>資料太多，這裡只列出前 {{ sources.length }} 份</strong>
        <span>其餘的沒有不見，用上面的搜尋找得到。</span>
      </div>

      <div v-if="loading && !sources.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!sources.length && !orphanCount" class="split-sidebar-empty">
        <span>還沒有任何資料</span>
        <!-- ⛔ 這裡原本還有一顆「加入知識」：同一個畫面上方一顆、這裡一顆、右邊「加入第一份資料」一顆，
             新手看到三顆一樣的不知道差在哪（2026-10-12 `D-124` 新手走查）。上方那顆是常駐入口、右邊那顆是空白時的主按鈕 -->
        <p class="text-xs text-muted">放一份進來（檔案、網址、Google 試算表或一段文字），AI 就會從裡面找答案回覆客人。</p>
      </div>
      <div v-else class="split-list">
        <!-- 未分類資料（直接平鋪在最上方，沒有 header） -->
        <!-- data-agent-target：補了一條、放進左邊這一份時亮一下（`C-317`，見 onAddOneCreated） -->
        <div
          v-for="src in uncategorizedSources"
          :key="src.id"
          class="flow-sidebar-row"
          :class="{ 'flow-sidebar-row--dragging': draggedSourceId === src.id }"
          :data-agent-target="`kb-source:${src.id}`"
        >
          <!-- `G-102`：拖進資料夾＝`sources/[id]` PUT（sources.write），觀察者不給把手（同機器人模組頁） -->
          <span
            v-if="canEditSources"
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

        <!-- 「移出分組」drop zone：只在拖曳「分組內」的資料時才出現 -->
        <div
          v-if="isDraggingFromFolder"
          class="src-unfolder-zone"
          :class="{ 'src-unfolder-zone--drop': dragOverFolderId === '__none__' }"
          @dragover.prevent="onFolderDragOver('__none__', $event)"
          @dragleave="onFolderDragLeave('__none__')"
          @drop.prevent="onFolderDrop(null)"
        >
          拖到這裡 = 移出分組
        </div>

        <!--
          每個分組（`C-320`）。「通用」那幾組（FAQ、公告、價目表這種不是講單一商品的）排最上面、名字旁邊標「通用」；
          其餘照原本的順序。拖曳照舊：資料拖進哪一組就放哪一組，組的標頭可以拖來排順序（通用跟商品不混排，見 reorderFoldersTo）
        -->
        <template v-for="folder in orderedFolders" :key="folder.id">
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
            <!-- `G-102`：分組排序＝`folders/reorder`（folders.write） -->
            <span
              v-if="canEditFolders"
              class="drag-handle flow-sidebar-drag-handle src-folder-drag-handle"
              draggable="true"
              aria-label="拖曳排序分組"
              @click.stop
              @dragstart.stop="onFolderHeaderDragStart($event, folder.id)"
              @dragend.stop="onFolderHeaderDragEnd"
            >⠿</span>
            <span class="src-folder-label">
              <span class="src-folder-arrow">{{ isExpanded(folder.id) ? '▾' : '▸' }}</span>
              <el-icon><Folder /></el-icon>
              <!-- 名字自己一個 span：太長時只截名字（…），後面的「通用」和條數不被擠掉（240px 側欄，守門員截圖看到「（0」被切） -->
              <span class="src-folder-name">{{ folder.name }}</span>
              <!-- 名字本來就叫「通用」的不再標一次 -->
              <span v-if="folder.general && folder.name.trim() !== '通用'" class="src-folder-general">通用</span>
              <span class="src-folder-count">（{{ countByFolder[folder.id] ?? 0 }}）</span>
            </span>
            <span v-if="canEditFolders" class="src-folder-actions">
              <el-tooltip content="編輯分組" placement="top" :show-after="300">
                <button class="src-folder-icon-btn" aria-label="編輯分組" @click.stop="openFolderEdit(folder)"><el-icon><EditPen /></el-icon></button>
              </el-tooltip>
            </span>
          </div>
          <template v-if="isExpanded(folder.id)">
            <div
              v-for="src in sourcesByFolder[folder.id] ?? []"
              :key="src.id"
              class="flow-sidebar-row src-row--in-folder"
              :class="{ 'flow-sidebar-row--dragging': draggedSourceId === src.id }"
              :data-agent-target="`kb-source:${src.id}`"
            >
              <span
                v-if="canEditSources"
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
              （這一組是空的{{ canEditSources ? '；可從外面拖一份過來' : '' }}）
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
      <!-- 「問 AI」收成一顆的時候（內容寬 721～1199，`C-315`）：工作台沒有標頭，這一行就是它的標頭，跟選著一份時右上那顆同一個位置 -->
      <div v-if="askMode === 'drawer'" class="src-ask-bar">
        <el-button :icon="ChatDotRound" data-tour="kb-ask-open" @click="askDrawerOpen = true">問 AI</el-button>
      </div>
      <div class="src-workbench">
        <!-- 開帳讀網站整理出來、等你看過的卡（`C-250`③）：新帳號進知識庫第一件該做的事，排最上面 -->
        <KnowledgeSiteDrafts :can-edit="canEditKb" @changed="loadSources(true)" />
        <!--
          `C-314`（老闆 10-14「只呈現需要的東西、不要過度呈現資訊」）：這一段介紹只給還沒有任何資料的人看。
          已經放了資料的人每天打開這頁要看的是「要處理的事」，上面不再先擺三行說明
          （「左邊點一份資料…」那一句連空的時候都不擺：左邊沒有東西可點）。
          `!loading`：第一次載入時清單還是空的，不擋的話介紹會先閃一下再消失。
        -->
        <div v-if="!loading && !sources.length" class="src-workbench__intro">
          <h3>這裡是 AI 回答客人的依據</h3>
          <p>
            你放進來的每一份資料（檔案、網址、Google 試算表、一段文字）都會由 AI 整理成一條條問答，
            客人問到相關問題時就用這些內容回答。<strong>沒放進來的事，AI 不會自己編。</strong>
          </p>
          <!-- 「資料進來會發生什麼事」的心智圖（D-40） -->
          <KnowledgeConceptDiagram />
          <!--
            空清單＝最不打擾的教學位（D-33 P2）。圖文選單／推播／活動的空狀態早就有這顆帶字鈕，
            知識庫（全站空狀態文案最好的一頁）反而漏了——第一次來的人只找得到右上角那顆灰問號。
            ⛔只掛「建立與匯入」那一支：還沒有任何資料的人不需要先挑一份教學，
            「整理與更新」等有東西之後從頁首問號進得去。
          -->
          <div v-if="canEditKb" class="src-workbench__cta">
            <el-button :icon="Upload" type="primary" @click="goImport">加入第一份資料</el-button>
            <AdminPageHelpButton :topics="['knowledge']" label="第一次用？看一遍怎麼做" />
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
          `C-314`：只列要動手的事。以前最後還有幾行灰字（「另有 N 條知識內容較短（照樣找得到，想看再看）」
          「已過期自動停用（正常，不用處理）」）——自己都說不用處理，就不擺；沒有要處理的事整塊不出現。
        -->
        <div v-if="todoItems.length" class="src-todo" data-tour="kb-health">
          <button type="button" class="src-todo__head" @click="todoOpen = !todoOpen">
            <el-icon class="src-todo__icon"><FirstAidKit /></el-icon>
            <span class="src-todo__title">要處理的事（{{ todoItems.length }}）</span>
            <span class="src-todo__toggle">{{ todoOpen ? '▴' : '▾' }}</span>
          </button>

          <div v-show="todoOpen" class="src-todo__body">
            <div v-for="item in todoItems" :key="item.id" class="src-todo__item" :class="`is-${item.tone}`">
              <div class="src-todo__item-main">
                <span class="src-todo__item-title">{{ item.title }}</span>
                <span class="src-todo__item-why">{{ item.why }}</span>
              </div>
              <el-button v-if="item.action" size="small" plain :loading="item.loading" @click="item.action?.()">
                {{ item.cta }}
              </el-button>
            </div>

            <!-- 數字可能少算（掃描撞上限）：這句講的是上面那幾個數字靠不靠得住，⛔ 不算「知道就好」的灰字，留著 -->
            <p v-if="health.chunkScanTruncated" class="src-todo__foot">
              內容較多，這份檢查只掃了其中一部分，實際數量可能更多。
            </p>
          </div>
        </div>

        <!-- 建議收件匣（草稿要看內容，維持獨立區塊）;count 讓側欄的工作台入口有數字可顯示 -->
        <KnowledgeSuggestions @accepted="loadSources(true)" @count="onSuggestCount" />
      </div>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <!-- src-header-main（`C-308`⑫）：手機上試算表網址太長會把這一塊撐寬，整頁可以左右滑、名稱框被切掉——不准它撐（樣式見 partial） -->
      <div class="admin-flex-1 src-header-main">
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
        <!-- 網址／原檔那一行：沒有網址也沒有原檔（一段文字、2026-10-10 以前的檔案）就不畫 -->
        <p v-if="selectedSource?.url || selectedSource?.originalFile" class="text-sm text-muted admin-subtext src-header-caption">
          <a v-if="selectedSource?.url" :href="selectedSource.url" target="_blank" rel="noopener">{{ selectedSource.url }}</a>
          <!-- 原檔留著（`C-296`③）：檔案來源以前讀完就刪，這裡什麼都點不開 -->
          <template v-if="selectedSource?.originalFile">
            {{ selectedSource.originalFile.name }}（{{ formatFileSize(selectedSource.originalFile.size, { zero: '大小未知' }) }}）
            <el-button link type="primary" size="small" :loading="downloadingOriginal" @click="downloadOriginal">下載原檔</el-button>
          </template>
        </p>
        <!--
          一行講完這一份是什麼（`C-314`）：以前是一整張「基本資訊」卡、四格（類型／狀態／條數／最後同步），
          狀態九成九是「可用」——正常的事不用講。現在一行「Google 試算表・20 條・35 分鐘前更新」，
          狀態只有不正常時才接在後面、上色（見 headerStatus）。
        -->
        <p v-if="selectedSource" class="text-sm text-muted admin-subtext src-header-meta">
          {{ headerMeta }}<span v-if="headerStatus" class="src-header-meta__status" :class="`is-${headerStatus.tone}`">・{{ headerStatus.text }}</span>
        </p>
      </div>
      <div v-if="canEditSources || askMode === 'drawer'" class="flex gap-1 admin-header-actions">
        <!--
          更新類按鈕一種講法（`C-319`，`D-126` 第 5 題）：試算表、網址「立即更新」（網址照舊先給你看哪裡不一樣），
          檔案「上傳新版」（要選檔，字要講出「上傳」）。以前三種講法：重新同步／立即同步／換新版
        -->
        <el-button
          v-if="canEditSources && selectedSource?.type === 'url'"
          type="primary"
          plain
          data-tour="kb-resync"
          :loading="resyncing"
          @click="startResync()"
        >
          {{ resyncButtonLabel }}
        </el-button>
        <el-button v-if="canEditSources && resyncing" text @click="cancelResync">
          取消
        </el-button>
        <el-button
          v-if="canEditSources && selectedSource?.type === 'gsheet'"
          type="primary"
          plain
          data-tour="kb-resync"
          :loading="gsheetSyncing"
          @click="syncGsheetNow"
        >
          立即更新
        </el-button>
        <!-- 檔案沒有自動更新：改版就在這裡換（`D-124`），跟網址、試算表的「立即更新」同一個位置 -->
        <el-tooltip v-if="canEditSources && selectedSource?.type === 'file' && canEditKb" content="選新的檔案，整理好直接換掉這一份" placement="bottom" :show-after="300">
          <!-- ⛔ 不掛 data-tour="kb-resync"：那一步導覽講的是「會自動跟上」，檔案不會 -->
          <el-button type="primary" plain @click="pickNewVersion">上傳新版</el-button>
        </el-tooltip>
        <!-- 「問 AI」收成一顆時（`C-315`，內容寬 721～1199）：跟工作台那一行同一個位置（右上） -->
        <el-button v-if="askMode === 'drawer'" :icon="ChatDotRound" data-tour="kb-ask-open" @click="askDrawerOpen = true">問 AI</el-button>
        <!--
          刪除收在「⋯」（全站同一顆）。知識來源不給複製：同一份內容學兩次，AI 會被重複的卡片搞混。
          `D-127` 分組就是商品：以前這裡是「AI 認的商品名」（每份自己一個名字）——拿掉了，要改成別台就換分組。
          「移到哪一組」：拖曳之外的第二條路（手機上拖不動；「要處理的事」的「放進分組」也開這一個）。
          「重新學習這一份」：換組、改組名之後重新學習沒成（網路、AI 服務忙）時的補救——以前沒有整份重學的按鈕
        -->
        <AdminMoreMenu
          v-if="canEditSources"
          :items="[
            { command: 'move', label: '移到哪一組' },
            { command: 'relearn', label: relearningSource ? '重新學習中⋯' : '重新學習這一份', disabled: relearningSource },
            { command: 'delete', label: '刪除', icon: Delete, danger: true, disabled: deleting },
          ]"
          @command="onSourceMoreCommand"
        />
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <div v-if="selectedSource" class="solo-editor-body admin-panel-stack">
        <!--
          「這份在講什麼」（`C-316`，`D-126` 第四節：NotebookLM 點開一份是先看到摘要）：最多三行。
          伺服器還沒寫過的，打開時請它寫一次（每份每次打開頁面最多一次，見 maybeGenerateSummary），寫的時候一小塊骨架；
          寫不出來就整塊不出現（⛔ 不講「摘要失敗」：這一塊是看了比較快懂，不是要他處理的事）。
          只有一條的那種（一段文字）不擺：摘要就是那一條再講一次
        -->
        <div v-if="summaryLines.length || summaryLoadingId === selectedSource.id" class="message-card src-section-card src-summary">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">這份在講什麼</span>
            </div>
          </div>
          <div class="card-section-stack">
            <el-skeleton v-if="!summaryLines.length" :rows="1" animated class="src-summary__skeleton" />
            <ul v-else class="src-summary__list">
              <li v-for="(line, i) in summaryLines" :key="i">{{ line }}</li>
            </ul>
          </div>
        </div>

        <!-- 「立即更新」後確認「網頁沒變」:這是使用者按下按鈕後唯一的答覆,用面板不用 toast -->
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
            剛剛重新抓了一次這個網址，內容逐字比對完全相同，所以沒有需要你決定的事，知識也不用動。
            <el-button text size="small" :loading="resyncing" @click="startResync(true)">
              還是要讓 AI 重新整理一次
            </el-button>
          </div>
        </el-alert>

        <!-- 偵測到變動的提示。⚠️ 只給網址（`C-308`⑤）：試算表一次少太多列被擋下時也會標「有變動」，
             這段講的「網頁內容變動、按立即更新」對試算表是錯的——那種情況下面的修理框會講 -->
        <el-alert
          v-if="selectedSource.outdatedAtMs > 0 && selectedSource.type === 'url'"
          type="warning"
          show-icon
          :closable="false"
          class="src-outdated-alert"
        >
          <template #title>
            偵測到網頁內容變動 — {{ relativeTime(selectedSource.outdatedAtMs) }}
          </template>
          <div>
            最後一次自動偵測發現原始網址內容已改變，建議點上方「立即更新」檢視差異後決定要不要套用。
          </div>
        </el-alert>

        <!-- gsheet 手編鎖分歧（C-44）:改了表格卻永遠不生效的唯一原因,必須常駐講出來,
             不能只有卡片上一顆沒解釋的小鎖 icon -->
        <el-alert
          v-if="selectedSource.type === 'gsheet' && selectedSource.manualKeptCount > 0"
          type="warning"
          show-icon
          :closable="false"
          class="src-outdated-alert"
        >
          <template #title>
            有 {{ selectedSource.manualKeptCount }} 條知識不會跟著表格更新
          </template>
          <div>
            這幾條知識在後台被手動編輯過，同步時會保留人工版本、不吃表格的修改。
            <template v-if="canEditKb">想改回跟著表格，點下面那幾條旁邊的鎖頭。</template>
          </div>
        </el-alert>

        <!-- gsheet 空間滿了沒收的列（`C-296`）：表格加了一列、AI 卻答不出來，原因只在這裡——
             ⛔ 不講就是「沉默地少收」；同步只是暫停新增，空間空出來會自己補，所以要講「不用重匯」。
             「什麼時候補」照這一份實際的同步頻率講（`C-308`④）：以前寫死「每小時」，設成不自動同步的永遠補不上 -->
        <el-alert
          v-if="selectedSource.type === 'gsheet' && (selectedSource.quotaSkippedCount ?? 0) > 0"
          type="warning"
          show-icon
          :closable="false"
          class="src-outdated-alert"
        >
          <template #title>
            表格上有 {{ selectedSource.quotaSkippedCount }} 列還沒收進知識庫
          </template>
          <div>
            知識空間已經用滿，這幾列先沒有新增。刪掉用不到的知識或升級方案之後，{{ gsheetRefillWhen }}，不用重新匯入。
          </div>
        </el-alert>

        <!-- 失敗要能就地修:原本只印一行後端原文,商家看不懂也修不了
             (最常見的兩種原因,修的地方一個在 Google、一個是換網址)。
             試算表一次少太多列被擋下（`C-308`⑤）不是「抓不到」：表讀得到，是系統怕誤刪先停下來——標題、做法都不一樣。
             `C-314`：「基本資訊」卡拿掉了（類型／條數／更新時間併成名稱下面那一行），這一塊自己獨立一格、有事才出現 -->
        <div v-if="selectedSource.failureReason" class="src-fix" :class="{ 'src-fix--held': failureAdvice.kind === 'massDelete' }">
          <p class="src-fix__title">{{ failureAdvice.kind === 'massDelete' ? `⚠ 表格一次少了 ${failureAdvice.rows} 列，自動同步先停下來` : '⚠ 這份資料目前抓不到內容' }}</p>
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

          <!-- 擋下來那種的原文就是上面那兩句再講一次（還寫「張卡」），不重複 -->
          <p v-if="failureAdvice.kind !== 'massDelete'" class="src-fix__raw">系統訊息：{{ selectedSource.failureReason }}</p>
        </div>

        <!--
          「所屬產品」那張卡拿掉了（`C-320`）；`D-127` 起商品名跟著分組走，要換就「⋯ → 移到哪一組」（見 moveDialogOpen）。
          九成的資料不用動它，常駐一整張表單是讓每個人每次都看一遍
        -->

        <!--
          自動更新（網址、Google 試算表）。`C-314`：以前兩張卡各一段說明＋一格選單＋「儲存設定」，
          現在一行「自動更新：[每小時 ▾]」，選了就存（toast 講改成什麼）。
          說明段拿掉：「你改過的不會被蓋掉」鎖頭那裡會講、「大改會先給你看」到時候畫面自己會停下來問。
          網址另外兩格（偵測到變動時、小幅文字變動）幾乎沒人要動，收進預設關著的「更多設定」，照舊按「儲存設定」才存。
          `G-107`：存不了的人（沒有 sources.write）只給看——選項文字只寫一份（URL_INTERVAL_OPTIONS 等），給看的那一版照同一份查。
        -->
        <div v-if="isSyncingType(selectedSource.type)" class="message-card src-section-card">
          <div class="card-section-stack">
            <div class="src-sync-row" data-tour="kb-sync-settings">
              <span class="src-sync-row__label">自動更新：</span>
              <el-select
                v-if="canEditSources"
                v-model="settingsForm.refreshIntervalMinutes"
                size="small"
                class="src-sync-row__select"
                aria-label="自動更新"
                :loading="savingInterval"
                :disabled="savingInterval"
                @change="saveInterval"
              >
                <el-option v-for="o in intervalOptions" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
              <span v-else class="src-sync-row__value">{{ optionLabel(intervalOptions, settingsForm.refreshIntervalMinutes) }}</span>
              <!-- 一組一顆求救鈕（D-33 P2 列了沒做，D-40 補上）：網址那三格是連動的，
                   而使用者真正想問的是「它會不會自己改掉我編過的東西」。⛔別改成一格一顆。 -->
              <AdminFieldHelp v-if="selectedSource.type === 'url'" id="knowledgeAutoUpdate" />
            </div>

            <!--
              在後台刪掉的列（`D-125`② 拍板 A）：刪掉＝「這一列不要了」，之後同步不再收。
              ⛔ 一定要講出來：不講的話他在表格上看得到那一列、AI 卻永遠答不出來，原因只在這裡。給一顆收回來的路。
            -->
            <p v-if="excludedTitles.length" class="src-excluded">
              <span class="src-excluded__text">表格上有 {{ excludedTitles.length }} 列你在後台刪掉了，不會再收：{{ excludedPreview }}</span>
              <el-button
                v-if="canEditSources"
                link
                type="primary"
                size="small"
                :loading="clearingExcluded"
                @click="clearExcludedRows"
              >
                重新收這幾列
              </el-button>
            </p>

            <!--
              偵測狀況三態（只有網址）：正常不出聲，另外兩種一定要講出來。
              以前這兩種情況畫面上什麼都不顯示,店家看到「最後同步 N 小時前」會以為系統在顧,
              實際上官網改版了也不會有人知道——最糟的那種假綠燈。
            -->
            <div v-if="selectedSource.type === 'url' && selectedSource.detectStalledAtMs > 0" class="src-detect-note src-detect-note--warn">
              <p class="src-detect-note__title">⚠ 這個網址自動偵測幫不上忙</p>
              <p>
                每次抓到的內容都不一樣（常見於有隨機推薦、輪播區塊的首頁），系統分不出哪一次才算真的改版，
                所以<strong>不會</strong>主動提醒你。要更新知識請按上方「立即更新」自己看差異，
                或改用內容固定的頁面（單一商品頁、說明頁）當資料來源。
              </p>
              <p class="src-detect-note__meta">從 {{ relativeTime(selectedSource.detectStalledAtMs) }}開始</p>
            </div>
            <div v-else-if="selectedSource.type === 'url' && selectedSource.numbersVolatile" class="src-detect-note">
              <p class="src-detect-note__title">這個網址上的數字每次抓都在變</p>
              <p>
                像是集資金額、支持人數、倒數天數。系統已經學會忽略這些數字，
                <strong>只在文字內容改變時才提醒你</strong>——所以單純改數字（例如只調價格）不會通知，
                那種情況要自己按上方「立即更新」。
              </p>
            </div>

            <!-- 網址另外兩格：預設收著（`C-314`），照舊按「儲存設定」才存 -->
            <template v-if="selectedSource.type === 'url'">
              <button type="button" class="chunk-advanced-toggle src-sync-more" :aria-expanded="syncMoreOpen" @click="syncMoreOpen = !syncMoreOpen">
                {{ syncMoreOpen ? '▾' : '▸' }} 更多設定
              </button>
              <template v-if="syncMoreOpen">
                <div class="admin-field-group">
                  <AdminFieldLabel text="偵測到變動時" tight />
                  <el-radio-group v-if="canEditSources" v-model="settingsForm.onChangeBehavior">
                    <el-radio v-for="o in ON_CHANGE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
                  </el-radio-group>
                  <p v-else class="src-readonly-value">{{ optionLabel(ON_CHANGE_OPTIONS, settingsForm.onChangeBehavior) }}</p>
                </div>
                <div class="admin-field-group">
                  <AdminFieldLabel text="小幅文字變動" tight />
                  <el-radio-group v-if="canEditSources" v-model="settingsForm.urlAutoApply" :disabled="settingsForm.onChangeBehavior === 'log_only'">
                    <el-radio v-for="o in AUTO_APPLY_OPTIONS" :key="String(o.value)" :value="o.value">{{ o.label }}</el-radio>
                  </el-radio-group>
                  <p v-else class="src-readonly-value">{{ optionLabel(AUTO_APPLY_OPTIONS, settingsForm.urlAutoApply) }}</p>
                </div>
                <div v-if="canEditSources" class="src-settings-actions">
                  <el-button
                    type="primary"
                    size="small"
                    :loading="savingSettings"
                    :disabled="!moreSettingsDirty"
                    @click="saveSettings"
                  >
                    儲存設定
                  </el-button>
                </div>
              </template>
            </template>
          </div>
        </div>

        <!-- 旗下 chunks -->
        <div class="message-card src-section-card" data-tour="kb-chunks">
          <div class="message-card-header src-chunks-head">
            <div class="card-header-main">
              <span class="section-title">知識（{{ chunks.length }}）</span>
            </div>
            <!--
              在這份裡找（`C-316`）：標題、內容、客人可能怎麼問一起找，在瀏覽器裡篩（這一份的條目已經都在畫面上，不用再問伺服器）。
              幾條而已一眼看得完的，不擺這一格
            -->
            <el-input
              v-if="chunks.length > CHUNK_SEARCH_MIN"
              v-model="chunkQuery"
              size="small"
              clearable
              placeholder="在這份裡找…"
              aria-label="在這份裡找"
              :prefix-icon="Search"
              class="src-chunk-search"
            />
          </div>
          <div class="card-section-stack">
            <div v-if="detailLoading" class="src-chunk-loading"><div class="spinner" /></div>
            <p v-else-if="!chunks.length" class="text-muted">這份資料底下沒有知識。</p>
            <template v-else>
              <!--
                要修的那幾條在哪裡:一份資料切出上百條時,「哪幾條停用了 / 沒學成功」
                只能靠滑鼠滾——不然就得繞回工作台的體檢清單再點回這裡。
                只在真的有東西可篩時才出現(全部正常就不該多一排按鈕)。
                `C-314`：拿掉「內容較短」那一格——短的照樣找得到、照樣拿去回答，不是要修的東西
              -->
              <div v-if="chunkFilterTabs.length > 1" class="src-chunk-filters">
                <button
                  v-for="t in chunkFilterTabs"
                  :key="t.key"
                  type="button"
                  class="src-chunk-filter"
                  :class="{ 'is-active': chunkFilter === t.key }"
                  @click="chunkFilter = t.key"
                >
                  {{ t.label }}（{{ t.count }}）
                </button>
              </div>
              <p v-if="!visibleChunks.length && activeChunkQuery" class="text-muted text-sm src-chunk-none">沒有符合「{{ activeChunkQuery }}」的。</p>
              <div class="src-chunk-list">
                <!-- data-agent-target：問 AI 點了「用了這幾條」打開的那一條要捲過來亮一下（`C-315`，見 revealChunk） -->
                <div
                  v-for="c in visibleChunks"
                  :key="c.id"
                  :class="['src-chunk-row', c.status === 'disabled' && 'src-chunk-row--off']"
                  :data-agent-target="`kb-chunk:${c.id}`"
                >
                  <div class="src-chunk-body">
                    <div class="src-chunk-main">
                      <span class="src-chunk-title">{{ c.title }}</span>
                      <!--
                        鎖頭（`C-44`）＝「這一條用你改過的版本」。
                        · 一段文字（manual）不會同步，鎖頭沒有意義、不畫（`C-308`②）；
                        · 說明以前只在滑鼠停留時出現（`C-309`），手機看不到——改成點一下就跳出來；
                          改得動的人在裡面按「改回跟著表格／網頁」。
                        · `C-314`：點開只剩一句＋一顆按鈕（以前三句：改過的時間、現在用哪一版、改回去之後什麼時候換）。
                          改回去之後什麼時候換，按了之後的提示會講（unlockToast），不用先講一遍。
                        `G-102`：解鎖打的是 `knowledge/[id]/settings`（客服級）。觀察者點了只看那一句、沒有按鈕
                        （⛔ 鎖頭不拿掉：它同時是「這條不吃表格更新」的標記，拿掉等於少講一件事）。
                      -->
                      <el-popover
                        v-if="c.manuallyEditedAtMs > 0 && lockApplies(selectedSource.type)"
                        trigger="click"
                        placement="bottom-start"
                        :width="260"
                        popper-class="src-lock-pop"
                      >
                        <template #reference>
                          <button
                            type="button"
                            class="src-chunk-lock"
                            :aria-label="`你改過這一條（${relativeTime(c.manuallyEditedAtMs)}），點一下看說明`"
                            @click.stop
                          ><el-icon><Lock /></el-icon></button>
                        </template>
                        <p class="src-lock-pop__what">{{ lockMeaning(selectedSource.type) }}</p>
                        <el-button v-if="canEditKb" size="small" type="primary" plain :loading="unlockingId === c.id" @click="unlockChunk(c, true)">
                          {{ unlockLabel(selectedSource.type) }}
                        </el-button>
                      </el-popover>
                    </div>
                    <p class="src-chunk-preview">{{ chunkPreview(c) }}</p>
                    <!--
                      `C-314`：只講例外（停用、處理中、沒學起來、等你看過、有效至…）。
                      以前每一條都寫「62 字 · 可用 · 10/1」——字數不用管、「可用」是正常、日期沒人要用，三樣都不擺
                    -->
                    <span v-if="chunkMeta(c)" class="src-chunk-meta" :class="{ 'is-failed': c.status === 'failed' }">{{ chunkMeta(c) }}</span>
                  </div>
                  <el-button v-if="canEditKb" :icon="EditPen" size="small" plain @click="openEditChunk(c)">編輯</el-button>
                  <!-- `G-102`：同一個視窗，沒有 knowledge.write 時開的是唯讀版（見 chunkReadonly）——
                       不給這顆的話，觀察者在清單上只看得到第一行，整條內容要繞去搜尋才看得到 -->
                  <el-button v-else size="small" plain @click="openEditChunk(c)">查看</el-button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <!-- 右邊「問 AI」（`C-315`）：內容寬夠（≥ 1200）才常駐；問的人要有測試對話的權限（`playground.use`，觀察者沒有）。
       ⚠️ 欄跟抽屜只會有一個在畫面上：寬度跨過門檻時換位置，那一份對話會重來（不會兩份同時在問） -->
  <aside v-if="askMode === 'column'" class="src-ask-col">
    <KnowledgeAskPanel :source-names="askSourceNames" :current-source-id="selectedId" @open-chunk="onAskOpenChunk" @add-one="onAskAddOne" />
  </aside>
  </div>

  <!-- 內容寬 721～1199：右上那顆「問 AI」打開的抽屜（同一個面板） -->
  <!-- 抽屜不寫標題：面板第一行就是「問 AI 一題」，再寫一次是重複（右上的 ✕ 照留，樣式見 .src-ask-drawer） -->
  <el-drawer
    v-if="askMode === 'drawer'"
    v-model="askDrawerOpen"
    aria-label="問 AI"
    direction="rtl"
    size="380px"
    append-to-body
    class="src-ask-drawer"
  >
    <KnowledgeAskPanel :source-names="askSourceNames" :current-source-id="selectedId" @open-chunk="onAskOpenChunk" @add-one="onAskAddOne" />
  </el-drawer>

  <!--
    補一條（`C-317`）：這一頁所有「新增一條」的入口都開這一個——側欄「用一句話寫一條知識」（`C-323` 拿掉了重複的「⋯ → 手動新增知識」）、
    問 AI 的「寫一句正確答案」、搜尋不到時的「補進知識庫」、加入視窗的「手寫一條」、從 AI 表現頁／對話帶 ?q= 進來。
    以前是五格的編輯框（標題、內容、問法、產品、進階），補一句答案要面對五個欄位
  -->
  <KnowledgeAddOneDialog
    v-model:open="addOneOpen"
    :initial-question="addOneQuestion"
    @created="onAddOneCreated"
  />
  <!-- ⛔ 不帶 product-name：以前的五格框預設沿用「正開著的那一份」的產品名、而且看得到改得掉；
       小視窗沒有那一格，帶了就是偷偷把「營業時間」標成某一台的（客人問別台時這條就被擋掉、或被拿去答錯台） -->

  <!--
    移到哪一組（`D-127` 分組就是商品）：從右上「⋯」或「要處理的事」的「放進分組」打開。
    跟拖進分組同一支（moveSourceToFolder）：換組＝換商品名，伺服器當場重新學這一份（最久約 9 秒）。
    底下那一行講「放過去之後 AI 把它當成哪一台」——這是換組真正的後果，選之前就看得到
  -->
  <el-dialog
    v-model="moveDialogOpen"
    title="移到哪一組"
    width="min(440px, 92vw)"
    :close-on-click-modal="!movingToFolder"
    destroy-on-close
  >
    <el-select v-model="moveTarget" filterable class="src-move-select" placeholder="選一組">
      <el-option-group v-if="generalFolders.length" label="通用（不是講單一商品）">
        <el-option v-for="f in generalFolders" :key="f.id" :label="f.name" :value="f.id" />
      </el-option-group>
      <el-option-group v-if="productFolders.length" label="商品">
        <el-option v-for="f in productFolders" :key="f.id" :label="f.name" :value="f.id" />
      </el-option-group>
      <el-option label="不放分組" :value="MOVE_NONE" />
    </el-select>
    <p class="text-muted text-xs src-move-hint">{{ moveHint }}</p>
    <template #footer>
      <el-button :disabled="movingToFolder" @click="moveDialogOpen = false">取消</el-button>
      <el-button type="primary" :loading="movingToFolder" :disabled="!moveTargetChanged" @click="confirmMove">
        移過去
      </el-button>
    </template>
  </el-dialog>

  <!--
    ── 可能是同一台：系統列候選、由人確認 ──
    `C-323`：以前叫「產品名稱整理」、住在「⋯」選單，還有「自己挑兩個合併」「已確認的對照」兩塊。
    那兩塊搬進「編輯分組 → 客人還會怎麼叫它」（D-126 第 4 步：別名跟著商品分組走）；這裡只剩系統抓到、等你判斷的那幾組，
    入口是「要處理的事」那一列和「疑似重複」的「去合併商品名」
  -->
  <el-dialog
    v-model="aliasOpen"
    title="這幾個商品名是同一台嗎？"
    width="min(680px, 94vw)"
  >
    <p class="text-muted text-sm src-health-list-hint">
      同一台有兩種寫法，AI 會當成兩台，反問客人二選一。
      <strong>是不是同一台由你判斷</strong>——同系列的不同型號（例如 ULTRA 版、12L 與 16L）看起來也很像，不能合併。
    </p>

    <div v-if="aliasLoading" class="src-chunk-loading"><div class="spinner" /></div>
    <template v-else>
      <p v-if="!aliasCandidates.length" class="text-muted text-sm">
        目前沒有需要確認的組合。
      </p>
      <div v-for="c in aliasCandidates" :key="c.key" class="src-alias-card">
        <div class="src-alias-pair">
          「{{ c.a }}」<span class="src-alias-eq">＝</span>「{{ c.b }}」？
          <!-- 型號風險優先於「證據明確」:兩者同時成立時只顯示綠標,等於在誘導使用者合併兩台不同機器 -->
          <span v-if="c.variantRisk" class="src-alias-tag is-risk">可能是不同型號</span>
          <span v-else-if="c.confidence === 'high'" class="src-alias-tag is-high">證據明確</span>
        </div>
        <p class="src-alias-reason">{{ c.reason }}</p>
        <!-- `G-102`：合併／不是／解除／手動合併都打 `product-aliases` POST（sources.write），觀察者只看候選 -->
        <div v-if="canEditSources" class="src-alias-actions">
          <el-button type="primary" size="small" :loading="aliasSaving === c.key" @click="decideAlias(c, 'confirm')">
            是同一台，合併
          </el-button>
          <el-button size="small" :loading="aliasSaving === c.key" @click="decideAlias(c, 'dismiss')">
            不是，兩台不同
          </el-button>
          <!-- `D-127`：兩個都是商品分組＝合成一組（資料搬過去、另一組刪掉），講清楚留哪一組 -->
          <span class="text-muted text-xs">{{ productGroupNamed(c.a) && productGroupNamed(c.b) ? `合成一組，留「${c.a}」這一組` : `合併後會以「${c.a}」為正式名稱` }}</span>
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
        @click="gotoHealthItem(item, { move: healthListCategory === 'noProductSources' })"
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
    title="立即更新：先看哪裡不一樣"
    width="min(900px, 92vw)"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div v-if="diffData" class="diff-body">
      <p class="text-muted text-sm">
        已重新抓一次網頁、重新整理成一條條知識，請逐條決定要換成新的、還是保留舊的。
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
          <strong>建議先按取消、不要套用</strong>；若網頁確實改版了，請把內容複製下來，在「加入知識」直接貼進框裡。
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
          一條舊知識都沒有對上（未變 0），同時出現 {{ diffData.diff.summary.added }} 條新增與
          {{ diffData.diff.summary.removed }} 條移除——網頁整頁重寫才會長這樣。
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

      <!--
        知識空間（`C-308`⑪）：勾了新增才講——跟加入視窗同一把尺，放不下的先不加、套用完講是幾條。
        以前空間不夠是整批套用失敗，差異畫面上也看不到還剩多少。
      -->
      <p v-if="diffRoom" class="kb-quota-line" :class="{ 'is-full': diffRoom.over > 0 }">
        <template v-if="diffRoom.over > 0">
          知識空間只剩 {{ diffRoom.room }} 條：勾了新增的 {{ diffRoom.adds }} 條裡，{{ diffRoom.over }} 條這次放不下、先不加。刪掉用不到的知識或升級方案就放得下。
        </template>
        <template v-else>知識空間還能放 {{ diffRoom.room }} 條。</template>
      </p>

      <!-- 把「該看哪幾條」講出來:修改裡只有數字變掉的那些會影響客人拿到的答案 -->
      <p v-if="diffNumbersChangedCount > 0 || diffRewordOnlyCount > 0" class="diff-unchanged-note text-muted text-xs">
        <template v-if="diffNumbersChangedCount > 0">
          「修改」裡有 <strong>{{ diffNumbersChangedCount }} 條的數字變了</strong>(價格、天數、規格這類)，
          下方標了「數字有變」的請優先看。
        </template>
        <template v-else>
          「修改」的 {{ diffRewordOnlyCount }} 條數字都沒有變(價格、天數、規格一樣)，只是換個說法。
        </template>
      </p>

      <p v-if="foldedNoteParts.length" class="diff-unchanged-note text-muted text-xs">
        {{ foldedNoteParts.join('、') }}已收合(不需要做決定)
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
            <span v-if="entry.cosmetic" class="diff-entry-hint">
              換句話說(意思沒變)
            </span>
            <span v-else-if="entry.stillOnPage" class="diff-entry-hint">
              內容其實還在網頁上(換了分法)
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
  <!-- 只剩「改既有的一條」（`C-317`）：新增一條全部走上面的「補一條」小視窗 -->
  <el-dialog
    v-model="chunkEditOpen"
    :title="chunkReadonly ? '知識內容' : '編輯知識'"
    width="min(700px, 92vw)"
    :close-on-click-modal="chunkReadonly"
    destroy-on-close
  >
    <!--
      `G-102`：沒有 knowledge.write 的人（觀察者）從搜尋結果、體檢、疑似重複的「看 A／B」點進來，
      以前開的是**完整的編輯視窗**——儲存、刪除、AI 整理、重新學習全都按得下去、全都 403。
      現在給一份只能看的：同樣的內容，不留任何輸入框與動作鈕。
      ⛔ 不要改成「同一份表單灰掉」：灰掉的輸入框看起來像壞掉，而且政策是沒權限就藏。
    -->
    <div v-if="chunkReadonly" class="chunk-form">
      <!-- 狀態章只在不正常時出現（`C-314`，理由見編輯版那一段） -->
      <div v-if="chunkStatusWorthShowing" class="chunk-status-row">
        <span :class="['badge', chunkStatusBadge(chunkEditStatus)]">{{ chunkStatusLabel(chunkEditStatus) }}</span>
        <span v-if="chunkEditFailureReason" class="chunk-status-failure">{{ chunkEditFailureReason }}</span>
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="標題" tight />
        <p class="src-readonly-value">{{ chunkForm.title }}</p>
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="內容" tight />
        <p class="src-readonly-value src-readonly-value--multiline">{{ chunkForm.content }}</p>
      </div>
      <div v-if="chunkForm.questions?.length" class="admin-field-group">
        <AdminFieldLabel text="客人可能怎麼問" tight />
        <ul class="src-readonly-list">
          <li v-for="(q, i) in chunkForm.questions" :key="i">{{ q }}</li>
        </ul>
      </div>
      <div v-if="chunkShowUsage" class="admin-field-group">
        <AdminFieldLabel text="AI 可以用這一條" tight />
        <p class="src-readonly-value">
          {{ chunkEnabled ? '可以' : '不行（已停用）' }}<template v-if="chunkActiveUntil">・有效至 {{ chunkActiveUntil }}</template>
        </p>
        <p v-if="chunkExpiredAtMs && !chunkEnabled" class="chunk-expired-note">
          這一條已於 {{ ymdLabel(chunkExpiredAtMs) }} 到期自動停用。
        </p>
      </div>
      <!-- 標籤不給看（`C-314`）：標籤是系統自己分類用的，店家不用管（同編輯版） -->
    </div>
    <div v-else class="chunk-form">
      <!--
        索引狀態(編輯既有卡才有)。`C-314`：只在不正常時出現（處理中、沒學起來、等你看過）——
        九成九打開的是「可用」那一條，最上面掛一個綠色「可用」只是多一樣東西要看；
        停用的不掛：下面「AI 可以用這一條」那顆開關關著就是在講這件事
      -->
      <div v-if="chunkStatusWorthShowing" class="chunk-status-row">
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
      <!--
        在這裡改了會怎樣（`C-309`：鎖頭說明搬進編輯框）：試算表／網頁來的那一條，存了就不再跟著來源更新——
        以前打開被鎖的那一條，編輯框完全沒講它被鎖；沒鎖的也沒講「存了就鎖」。一句話，被鎖的再給改回去的路。
      -->
      <p v-if="chunkSyncNote" class="chunk-sync-note">
        {{ chunkSyncNote }}
        <el-button
          v-if="chunkEditLockedAtMs > 0 && (selectedSource?.type === 'gsheet' || selectedSource?.type === 'url')"
          link
          type="primary"
          size="small"
          :loading="unlockingId === chunkEditingId"
          @click="unlockFromEditor"
        >
          {{ unlockLabel(selectedSource?.type) }}
        </el-button>
      </p>
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
        <!-- `C-314`：按鈕旁那一行說明收進滑鼠停留的提示（按了之後的 toast 也會講「記得儲存」） -->
        <div class="chunk-normalize-row">
          <el-tooltip content="自動整理成重點、清掉沒用的雜訊，讓 AI 更容易找到這條；整理後記得儲存" placement="top" :show-after="300">
            <el-button
              size="small"
              plain
              :loading="chunkNormalizing"
              :disabled="!chunkForm.content.trim()"
              @click="normalizeChunkFromModal"
            >
              AI 整理一下
            </el-button>
          </el-tooltip>
        </div>
      </div>
      <!-- 客人問法會一起進 embedding(拉高命中率)。一定要看得到、改得掉:
           從「補知識」進來時這裡預填的是客人原話,可能夾著電話或姓名。
           `C-314`：底下那句只留「別放個資」——這幾句是做什麼用的，標題括號（會幫 AI 更容易找到這一條）已經講了 -->
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
          別放電話、姓名這類個資
        </p>
      </div>
      <!-- 商品名不在這裡問：一條跟著它所在的那一份走、那一份跟著它所在的分組走（`D-127`），兩邊都能改會對不起來 -->

      <!-- 供 AI 使用開關(已完成索引的卡才有;pending/failed 本來就不會被引用)。
           `C-314`：標籤改成講結果的一句話，開關旁那一行說明拿掉（開關本身就是答案） -->
      <div v-if="chunkShowUsage" class="admin-field-group">
        <AdminFieldLabel text="AI 可以用這一條" tight />
        <div class="chunk-usage-row">
          <el-switch v-model="chunkEnabled" />
        </div>
      </div>

      <!--
        有效期限用得少,收進進階:補一題知識只需要標題+內容+問法。設了期限/到期停用過時預設展開——把生效中的設定藏起來會讓人找不到。
        `C-314`：標籤整格不給看、不給改——那是系統自己分類用的（AI 整理時產生），店家不用管。
        ⛔ 存檔不會洗掉標籤：改既有的那一條時沒動到就不送 tags（後端沒帶 tags＝不改那一格，見 saveChunk）。
        「進階」裡只剩有效期限，沒有有效期限可設的（新的一條、處理中、沒學起來）整個不畫
      -->
      <button v-if="chunkShowUsage" type="button" class="chunk-advanced-toggle" @click="chunkAdvancedOpen = !chunkAdvancedOpen">
        {{ chunkAdvancedOpen ? '▾' : '▸' }} 進階（有效期限）
      </button>
      <template v-if="chunkAdvancedOpen">
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
      <div v-if="chunkReadonly" class="chunk-footer chunk-footer--readonly">
        <el-button @click="chunkEditOpen = false">關閉</el-button>
      </div>
      <div v-else class="chunk-footer">
        <el-button
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
            儲存
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <!-- ── 匯入彈窗 ───────────────────────────────────── -->
  <KnowledgeImportDialog
    ref="importDialogRef"
    v-model="importOpen"
    :existing-sources="sources"
    :folders="folders"
    :prefill-paste="importPrefill"
    @imported="onImported"
    @job-state="importJobState = $event"
    @manual="onImportManual"
  />
  <!-- 「上傳新版」的選檔視窗（見 pickNewVersion）：收得了的種類跟加入視窗同一份 -->
  <input ref="newVersionInput" type="file" :accept="KNOWLEDGE_FILE_ACCEPT" class="kb-file-input" @change="onNewVersionChosen">

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
          <span v-else-if="r.status === 'draft'" class="badge badge-yellow">等你看過</span>
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

  <!-- ── Recycle Bin Modal ──────────────────────────── -->
  <el-dialog
    v-model="recycleOpen"
    title="回收桶"
    width="min(640px, 92vw)"
    :close-on-click-modal="false"
  >
    <!-- `C-314`：一句就好（以前兩句，另一句「還原後回到刪除前的狀態…」是邊角情況，還原之後清單上看得到） -->
    <p class="src-bin-hint">刪掉的知識會在這裡放 30 天，可以還原。</p>
    <!--
      找得到才救得回來（`C-312`）：以前只列最近 100 條、不能搜——一份 150 條的說明書換新版，
      昨天刪的那一條就被擠出畫面。搜尋＋挑資料＋「顯示更多」；回收桶整個是空的就不畫工具列。
    -->
    <div v-if="recycleTotal !== 0 || recycleFiltering" class="src-bin-tools">
      <div class="src-bin-tools__q">
        <el-input
          v-model="recycleQuery"
          clearable
          placeholder="找標題或內容"
          :prefix-icon="Search"
        />
      </div>
      <div class="src-bin-tools__src">
        <el-select v-model="recycleSource" filterable aria-label="哪一份資料">
          <el-option :value="RECYCLE_ALL" label="全部資料" />
          <el-option
            v-for="s in recycleSourceOptions"
            :key="s.key"
            :value="s.key"
            :label="recycleOptionLabel(s)"
          />
          <el-option v-if="recycleSourcesNote" value="__note__" :label="recycleSourcesNote" disabled />
        </el-select>
      </div>
    </div>
    <p v-if="recycleLoading" class="src-bin-empty">載入中⋯</p>
    <p v-else-if="recycleLoadError" class="src-bin-empty">{{ recycleLoadError }}</p>
    <p v-else-if="!recycleRows.length && !recycleCursor" class="src-bin-empty">
      {{ recycleFiltering ? '回收桶裡沒有符合的。' : '回收桶是空的。' }}
    </p>
    <template v-else>
      <p v-if="recycleCountText" class="src-bin-count">{{ recycleCountText }}</p>
      <div class="src-bin-list">
        <div v-for="r in recycleRows" :key="r.id" class="src-bin-row">
          <div class="src-bin-row__main">
            <span class="src-bin-row__title">{{ r.title }}</span>
            <span class="src-bin-row__meta">
              {{ r.sourceName && recycleSource === RECYCLE_ALL ? `${r.sourceName}｜` : '' }}{{ formatRecycleTime(r.deletedAtMs) }}刪除
              <template v-if="r.purgeAfterMs">・{{ recycleDaysLeft(r.purgeAfterMs) }} 天後清除</template>
            </span>
            <span class="src-bin-row__snippet">{{ r.snippet }}</span>
          </div>
          <el-button size="small" plain :loading="restoringId === r.id" @click="restoreChunk(r)">
            還原
          </el-button>
        </div>
        <!-- 翻到上限先停的（scanCapped）要講「更早的還沒找」——⛔ 不可以讓「還沒找」看起來像「找不到」 -->
        <div v-if="recycleCursor" class="src-bin-more">
          <span v-if="recycleScanCapped" class="src-bin-more__note">
            {{ recycleRows.length ? `最近刪除的 ${recycleScanned} 條找過了，更早的還沒找` : `最近刪除的 ${recycleScanned} 條裡沒有符合的，更早的還沒找` }}
          </span>
          <el-button size="small" :loading="recycleLoadingMore" @click="loadRecycle(true)">
            {{ recycleScanCapped ? '繼續往前找' : '顯示更多' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <!-- ── Duplicate Suggestions Modal（C-40(c)）────────── -->
  <el-dialog
    v-model="dupSuggestOpen"
    title="疑似重複的知識"
    width="min(680px, 92vw)"
    :close-on-click-modal="false"
  >
    <p class="src-bin-hint">
      系統用「內容相似度＋AI 判斷」找出可能重複的組合，並附上理由。
      <strong>不會自動合併或刪除</strong><template v-if="canEditSources">——同一台兩個名字的按「去合併商品名」，講同一件事的把多的那條刪掉（會進回收桶，可還原）。
      不是重複的按「忽略」，之後不會再報這一組</template>。
    </p>
    <!--
      ⛔ 被系統刻意排除的組數要講出來（`C-156`）：不講的話，「這兩張明明很像卻沒被建議合併」
         只能翻伺服器 log 才查得到——同 C-68／C-94 那種「按幾次都沒新的」的沉默死亡。
         用字要說清楚這是**刻意排除**、不是漏了。
    -->
    <p v-if="health.duplicates.blockedByModelCount" class="src-bin-empty">
      另有 <strong>{{ health.duplicates.blockedByModelCount }}</strong> 組因為
      <strong>標題型號不同</strong>（例如 6L 與 12L）被排除，不列在下面——同系列不同型號合併會答錯台。
    </p>
    <p v-if="!health.duplicates.items.length" class="src-bin-empty">目前沒有疑似重複的項目。</p>
    <div v-else class="src-bin-list">
      <div v-for="s in health.duplicates.items" :key="s.key" class="src-bin-row">
        <div class="src-bin-row__main">
          <span class="src-bin-row__title">
            {{ s.kind === 'product_split' ? '同一台商品、兩個名字？' : '兩條知識講同一件事？' }}
          </span>
          <span class="src-bin-row__meta">
            A「{{ s.a.title }}」{{ s.a.productName ? `（${s.a.productName}）` : '' }}
            ／ B「{{ s.b.title }}」{{ s.b.productName ? `（${s.b.productName}）` : '' }}
          </span>
          <span class="src-bin-row__snippet">{{ s.reason }}</span>
        </div>
        <!-- `G-102`：去合併／忽略＝sources.write；「看 A／看 B」觀察者也能按，開的是唯讀視窗 -->
        <div class="src-dupe-actions">
          <el-button v-if="s.kind === 'product_split' && canEditSources" size="small" type="primary" plain @click="dupGoMerge(s)">
            去合併商品名
          </el-button>
          <template v-else-if="s.kind !== 'product_split'">
            <el-button size="small" plain @click="dupOpenCard(s.a.id)">看 A</el-button>
            <el-button size="small" plain @click="dupOpenCard(s.b.id)">看 B</el-button>
          </template>
          <el-button v-if="canEditSources" size="small" text :loading="dupDismissing === s.key" @click="dupDismiss(s)">忽略</el-button>
        </div>
      </div>
    </div>
    <template #footer>
      <div class="src-dup-footer">
        <span class="text-xs text-muted">
          {{ health.duplicates.scannedAtMs ? `上次掃描：${relativeTime(health.duplicates.scannedAtMs)}` : '尚未掃描' }}
        </span>
        <el-button v-if="canEditSources" size="small" plain :loading="dupRescanning" @click="dupRescan">重新掃描</el-button>
      </div>
    </template>
  </el-dialog>

  <!-- ── Folder Edit Modal（`C-320`：這一頁叫「分組」）──────────────── -->
  <el-dialog
    v-model="folderEditOpen"
    title="編輯分組"
    width="min(480px, 92vw)"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div class="folder-form">
      <!--
        `D-127` 分組就是商品：商品分組的名字就是 AI 認的商品名（底下每份資料都掛這個名字），所以標籤直接叫「商品名」；
        通用那一組不講單一商品，照舊叫「名稱」。改商品名＝底下每份換名字、舊名字收成客人的叫法（伺服器 folders PUT）
      -->
      <div class="admin-field-group">
        <AdminFieldLabel :text="folderForm.general ? '名稱' : '商品名'" tight />
        <el-input
          v-model="folderForm.name"
          maxlength="50"
          show-word-limit
          :placeholder="folderForm.general ? '例：客服 FAQ' : '例：SHARP 自動調理零水鍋'"
        />
      </div>
      <!-- 「通用」那一組（`C-320`）：勾了排到最上面；底下的資料不當成任何一台（`D-127`） -->
      <el-checkbox v-model="folderForm.general" class="src-folder-general-check">
        通用（FAQ、公告這種不是講單一商品的）
      </el-checkbox>
      <!--
        客人還會怎麼叫它（`C-323`，`D-126` 第 4 步）：以前在「⋯ → 產品名稱整理」，跟分組是兩套。
        商品分組才有（通用那一組不講單一商品）。`D-127` 起一組只有一個商品名（上面那一格），這裡是它的其他叫法：
        全名、型號、舊名字、客人的暱稱。
        標籤＋可提示的輸入框（Element 元件、不手刻）：打字時下拉列出像的現有商品名，挑了＝當成同一台；打新的＝客人的叫法。
        ⛔ 不用 el-select 多選＋allow-create：沒按 Enter 就按儲存，打的字會被安靜丟掉（addGroupAlias 那段）
      -->
      <div v-if="!folderForm.general" class="admin-field-group src-group-alias">
        <AdminFieldLabel text="客人還會怎麼叫它" tight />
        <div v-if="groupAliasLoading" class="src-chunk-loading"><div class="spinner" /></div>
        <p v-else-if="groupAliasFailed" class="folder-form-hint">讀不到，關掉再打開一次試試。</p>
        <template v-else>
          <div v-for="row in groupAliasRows" :key="row.product" class="src-group-alias__row">
            <div v-if="row.current.length" class="src-group-alias__tags">
              <el-tag
                v-for="a in row.current"
                :key="a"
                :closable="canEditSources"
                disable-transitions
                @close="removeGroupAlias(row, a)"
              >
                {{ a }}
              </el-tag>
            </div>
            <el-autocomplete
              v-if="canEditSources"
              v-model="row.draft"
              :fetch-suggestions="groupAliasSuggestionsFor(row)"
              :trigger-on-focus="false"
              select-when-unmatched
              placeholder="打一個叫法，按 Enter"
              class="src-group-alias__input"
              @select="(item) => addGroupAlias(row, String(item.value ?? ''))"
            />
          </div>
          <p class="folder-form-hint">客人用這些叫法問，AI 就知道是這一台。別寫「除濕機」這種好幾台都通用的。</p>
        </template>
      </div>
      <p v-if="folderEditTarget" class="folder-form-hint">
        目前底下 {{ countByFolder[folderEditTarget.id] ?? 0 }} 份資料。
        刪掉這一組，底下的資料會移到「未分類」，<strong>不會</strong>被刪掉。
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
          刪除分組
        </el-button>
        <div class="folder-footer-right">
          <el-button @click="folderEditOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="folderSaving"
            :disabled="folderDeleting || !folderForm.name.trim() || !folderFormDirty"
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
import { ChatDotRound, Check, Delete, EditPen, FirstAidKit, Folder, Loading, Lock, Search, Upload } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { SHORT_CHUNK_CONTENT_CHARS } from '~~/shared/types/ai-knowledge'
import { PREVIEW_JOB_CANCELLED, PREVIEW_JOB_DEADLINE } from '~/composables/usePreviewJobPoll'
import { formatFileSize } from '~/utils/knowledge-upload'
import { apiErrorText, isRetryableError } from '~/utils/api-error-text'
import { KNOWLEDGE_FILE_ACCEPT } from '~~/shared/knowledge-file-types'
import type { AddOneCreated } from '~/utils/kb-add-one'
import { ALIAS_TOO_SHORT_TEXT, isUsableAlias, normalizeProductName } from '~~/shared/product-name-similarity'
import { groupSyncNoteText, parseGroupSync } from '~~/shared/knowledge-import-group'
import { sameProductGroupName } from '~~/shared/knowledge-product-group'

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
  /** 型錄／列表資料（旗下本來就有很多不同產品）→ 不該催它設「所屬產品」 */
  generateOverview: boolean
  /** type='url'：小幅文字變動是否自動套用 */
  urlAutoApply: boolean
  lastFetchedAtMs: number
  outdatedAtMs: number
  updatedAtMs: number
  /** type='url'：這個網址的數字每次抓都在變，系統已學會忽略，只在文字內容改變時提醒 */
  numbersVolatile: boolean
  /** type='url'：連續多輪抓到的內容都不同、自動偵測判斷不出來（0 = 正常） */
  detectStalledAtMs: number
  /** type='gsheet'：手動編輯鎖住、與表格內容分歧的張數（>0 要常駐提示） */
  manualKeptCount: number
  /** type='gsheet'：知識空間滿了、同步時沒新增的列數（>0 要常駐提示，`C-296`） */
  quotaSkippedCount?: number
  /** type='gsheet'：在後台刪掉、之後同步不再收的那幾列的標題（`D-125`②）；舊伺服器沒有這一格 */
  gsheetExcludedTitles?: string[]
  /** type='gsheet'：表格一次少太多列、排程停下來等他確認的列數（`C-308`⑤）；0＝沒擋下 */
  blockedPendingDeletes?: number
  /** type='file'：留著的原檔（`C-296`③）；null＝沒有（2026-10-10 以前匯入的檔案當時讀完就刪了） */
  originalFile?: { name: string, size: number } | null
  /** 「這份在講什麼」最多三行（`C-316`）；空的＝伺服器還沒寫過（打開時請它寫一次，見 maybeGenerateSummary）。⚠️ 舊伺服器沒有這一格，讀的時候一律 `?? []` */
  summary: string[]
  /** 摘要是什麼時候寫的（ms）；0＝還沒寫過 */
  summaryAt: number
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
  /** 意思判官認定「只是換句話說」（`C-144`）：收合、預設保留原卡 */
  cosmetic?: boolean
  /** 這筆「移除」的內容其實還在網頁上（`C-154`）＝重切換了分法，不是網頁刪了 */
  stillOnPage?: boolean
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
  /**
   * 這份 diff 的套用冪等鍵（C-43）:150 張卡的套用會超過閘道 30 秒,後端做完了
   * 前端卻收到逾時;再按一次時帶同一個 applyId,新增的卡用決定性 id 覆寫同一批,
   * 不會多出一整批重複卡。同一份 diff 存活期間永遠用同一個值。
   */
  applyId: string
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
// `C-323`：只有平台超管（店家用不到、按了要等幾分鐘又花錢）；端點另外擋。claim 在 onMounted 讀一次
const { isSuperAdmin, checkIsSuperAdmin } = useSuperAdmin()
const canReindexAll = computed(() => isSuperAdmin.value && can('knowledge.reindexAll'))
// 待辦「AI 客服還沒開啟」要不要給「前往開啟」：AI 設定頁只有管理員存得了（`G-102`）
const canEditAiSettings = computed(() => can('ai.settings.write'))
/** 右邊「問 AI」（`C-315`）：問的是測試對話那一支（`playground.use`＝客服級），觀察者整欄不出現 */
const canAsk = computed(() => can('playground.use'))
/** 知識視窗只給看（`G-102`）：建卡入口本來就只給 canEditKb，所以唯讀一定是「看一張既有的」 */
const chunkReadonly = computed(() => !canEditKb.value)
const { showToast } = useAdminToast()

const sources = ref<SourceSummary[]>([])

/**
 * AI 總開關與知識總條數（P1-4）：用來判斷「這一頁的內容目前有沒有在發揮作用」。
 * null = 還沒讀到（讀失敗時不顯示提醒，寧可少講一句也不要誤報「AI 沒開」）。
 */
const aiEnabled = ref<boolean | null>(null)
/**
 * 「AI 用得到幾條知識」（`D-41` P1④）。
 *
 * ⛔ 不可以用資料清單的 `chunkCount` 加總：那是存在來源上的快取值（含停用／失敗），
 *    而且孤兒卡不掛在任何來源底下。2026-09-03 第一版改成「加總 ＋ 孤兒數」，當天
 *    code review 抓到那樣會把**回收桶裡的孤兒卡**也算進去（`/api/ai/sources/list` 的
 *    孤兒計數沒有濾軟刪除）——低報修成了高報，而「至少」這個詞反而變成謊話。
 * 現在改用體檢端點回的 `liveChunkCount`：那是唯一逐條看過狀態與回收桶的地方。
 * ⚠️ 它有掃描上限，超過時 `chunkScanTruncated` 為 true → 文案要改口說「至少」。
 */
const liveChunkCount = computed(() => health.value.liveChunkCount ?? 0)
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
/**
 * 後端回報「這份清單可能不完整」（`C-137`）。
 * 主查詢需要的複合索引沒部署時，清單會少掉一整批來源而畫面完全看不出來——
 * 2026-09-04 老闆就是因此以為說明書沒上傳成功，連傳三次。
 */
const sourcesDegraded = ref(false)
/** 份數撞到後端上限、後面的沒回（`C-138`）：撞到就要講，不能默默少列 */
const sourcesTruncated = ref(false)
const migrating = ref(false)

// ── 分組（資料庫裡叫 folder；這一頁的字叫「分組」，`C-320`）──────────────
interface FolderRow {
  id: string
  name: string
  order: number
  createdAtMs: number
  /** 「通用」那一組（FAQ、公告、價目表這種不是講單一商品的，`C-320`）：排最上面、名字旁標「通用」。⚠️ 舊伺服器沒有這一格，一律用 `=== true` 判斷 */
  general: boolean
}
const folders = ref<FolderRow[]>([])
/**
 * 畫面上的順序：「通用」的排最上面，其餘照伺服器的順序（`C-320`）。
 * ⚠️ 拖曳排序也照這個順序算（見 reorderFoldersTo）——拿原本的 folders 算位置的話，畫面上拖到第二個、存進去的是另一個位置
 */
const orderedFolders = computed(() => [
  ...folders.value.filter(f => f.general === true),
  ...folders.value.filter(f => f.general !== true),
])

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
  // 照畫面上的順序（通用在前）算位置；通用跟商品不混排——拖過界的話放下去也會被排回原處，乾脆不動
  const next = [...orderedFolders.value]
  const fromIndex = next.findIndex(f => f.id === fromId)
  const toIndex = next.findIndex(f => f.id === targetFolderId)
  if (fromIndex < 0 || toIndex < 0) return
  if ((next[fromIndex]!.general === true) !== (next[toIndex]!.general === true)) return
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
    showToast(apiErrorText(err, '分組的順序沒有存成，請再試一次'), 'error')
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
  await moveSourceToFolder(srcId, folderId)
}

/** 正在搬（伺服器換商品名＋重新學）、或改組名之後正在重新學的那幾份（左邊那一列標「搬移中」） */
const movingSourceIds = ref<Set<string>>(new Set())

/**
 * 把一份資料搬到另一組（拖進分組、「⋯ → 移到哪一組」都走這裡）。回 true＝搬成了。
 * `D-127` 分組就是商品：換組＝換商品名，伺服器當場重新學這一份（最久約 9 秒）——那一列標「搬移中」。
 * AI 現在把它當成哪一台照伺服器回的 groupSync 講一句（商品名沒變就不講；announce＝沒變也講搬到哪）。
 */
async function moveSourceToFolder(srcId: string, folderId: string | null, opts: { announce?: boolean } = {}): Promise<boolean> {
  const src = sources.value.find(s => s.id === srcId)
  if (!src || (src.folderId ?? null) === folderId) return false
  // 樂觀更新
  src.folderId = folderId
  // ⚠️ 等 0.6 秒才標：商品名沒變的搬移一下就好，馬上標會閃一下
  const busyTimer = setTimeout(() => { movingSourceIds.value = new Set([...movingSourceIds.value, srcId]) }, 600)
  try {
    const res = await apiFetch<{ groupSync?: unknown }>(`/api/ai/sources/${srcId}`, { method: 'PUT', body: { folderId } })
    const sync = parseGroupSync(res)
    if (sync?.kind === 'synced') {
      // 商品名換了＝那一份重新學過：清單（「還沒放進商品分組」跟著變）、開著的那一份都要重讀
      await loadSources(true)
      if (selectedId.value === srcId) await loadSourceDetail(srcId)
      void loadHealth(true)
    }
    const note = groupSyncNoteText(sync)
    const warn = sync?.kind === 'failed' || (sync?.kind === 'synced' && sync.failed > 0)
    if (note) showToast(note, warn ? 'warning' : 'success')
    else if (opts.announce) showToast(`已移到「${folders.value.find(f => f.id === folderId)?.name ?? '未分類'}」`, 'success')
    return true
  }
  catch (err: any) {
    showToast(apiErrorText(err, '移動失敗'), 'error')
    await loadSources()
    return false
  }
  finally {
    clearTimeout(busyTimer)
    if (movingSourceIds.value.has(srcId)) {
      const next = new Set(movingSourceIds.value)
      next.delete(srcId)
      movingSourceIds.value = next
    }
  }
}

const chunks = ref<ChunkRow[]>([])
const detailLoading = ref(false)

/**
 * 知識清單的狀態篩選。
 *
 * 一份說明書可以切出上百條,要找「哪幾條停用了 / 沒學成功」原本只能滾——
 * 或是繞回工作台的體檢清單再點回這一份資料。分類與體檢用同一組判斷,
 * 兩邊看到的條數才會一樣。
 *
 * `C-314`：拿掉「內容較短」那一類（連同每一條上的「內容較短」小標和底下那段長說明）。
 * 短的照樣被找到、照樣拿去回答（檢索沒有字數條件），不是要修的東西——列成一類、每條掛標，
 * 只會讓人以為那幾條壞了。⛔ 篩選只留「要動手」的：沒學起來、已停用。
 */
type ChunkFilterKey = 'all' | 'failed' | 'disabled'
const chunkFilter = ref<ChunkFilterKey>('all')

function matchChunkFilter(c: ChunkRow, key: ChunkFilterKey): boolean {
  if (key === 'failed') return c.status === 'failed'
  if (key === 'disabled') return c.status === 'disabled'
  return true
}

/** 只列出真的有東西的分類——全部正常時整排按鈕不出現(沒有東西可篩就別佔版面) */
const chunkFilterTabs = computed(() => {
  const defs: Array<{ key: ChunkFilterKey, label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'failed', label: 'AI 沒學起來' },
    { key: 'disabled', label: '已停用' },
  ]
  return defs
    .map(d => ({ ...d, count: chunks.value.filter(c => matchChunkFilter(c, d.key)).length }))
    .filter(d => d.key === 'all' || d.count > 0)
})

/**
 * 「在這份裡找…」（`C-316`）：標題、內容、客人可能怎麼問一起找，不分大小寫。
 * 篩選鈕（沒學起來、已停用）照舊疊在上面。條數不多（≤ CHUNK_SEARCH_MIN）時不擺這一格——一眼看得完
 */
const CHUNK_SEARCH_MIN = 5
const chunkQuery = ref('')
function matchChunkQuery(c: Pick<ChunkRow, 'title' | 'content' | 'questions'>, q: string): boolean {
  if (!q) return true
  const kw = q.toLowerCase()
  return c.title.toLowerCase().includes(kw)
    || c.content.toLowerCase().includes(kw)
    || (c.questions ?? []).some(x => x.toLowerCase().includes(kw))
}
/** 搜尋框沒擺出來時（條數少）不篩：⛔ 不然刪到剩幾條、框不見了，殘留的字還在偷偷篩、清單少一截卻沒地方清 */
const activeChunkQuery = computed(() => (chunks.value.length > CHUNK_SEARCH_MIN ? chunkQuery.value.trim() : ''))
const visibleChunks = computed(() => {
  const q = activeChunkQuery.value
  return chunks.value.filter(c => matchChunkFilter(c, chunkFilter.value) && matchChunkQuery(c, q))
})

/**
 * 篩選中的那一類被清空時要自己退回「全部」。
 * 例:只剩一條「AI 沒學起來」,重新學習成功之後那個分類歸零 → 按鈕列不再顯示它,
 * 但篩選還停在 short → 清單空白、也沒有任何按鈕可以點回去(看起來像知識全消失了)。
 */
watch([chunks, chunkFilter], () => {
  if (chunkFilter.value === 'all') return
  if (!chunks.value.some(c => matchChunkFilter(c, chunkFilter.value))) chunkFilter.value = 'all'
})

function chunkPreview(c: Pick<ChunkRow, 'content'>): string {
  const firstLine = c.content.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}

/**
 * 每一條底下那一行（`C-314`）：只講例外，正常的一條什麼都不寫（回空字串＝那一行不畫）。
 * 以前每一條都是「62 字 · 可用 · 10/1」——字數不用管、「可用」是正常狀態、日期沒有人要拿來做什麼。
 */
function chunkMeta(c: Pick<ChunkRow, 'status' | 'activeUntilMs' | 'expiredAtMs'>): string {
  if (c.status === 'indexed') return c.activeUntilMs ? `有效至 ${ymdLabel(c.activeUntilMs)}` : ''
  if (c.status === 'disabled') return c.expiredAtMs ? `已停用（${ymdLabel(c.expiredAtMs)} 到期）` : '已停用'
  return chunkStatusLabel(c.status)
}

/**
 * 同步設定的選項文字。⛔ 只寫這一份：下拉／單選用它、給觀察者看的那一行也用它查（`G-107`），
 * 兩邊各寫一份的話改了一邊，觀察者看到的就是舊說法。
 */
// `C-314`：前面接「自動更新：」，關掉那一項就叫「不自動更新」（以前「不自動偵測（要更新時我自己按）」／「不自動同步（只手動）」，
// 接在「自動更新：」後面讀起來不通；關掉之後怎麼更新，改了的那一下 toast 會講）
const URL_INTERVAL_OPTIONS = [
  { label: '不自動更新', value: 0 },
  { label: '每小時', value: 60 },
  { label: '每天', value: 1440 },
  { label: '每週', value: 10080 },
  { label: '每月', value: 43200 },
]
const GSHEET_INTERVAL_OPTIONS = [
  { label: '不自動更新', value: 0 },
  { label: '每 30 分鐘', value: 30 },
  { label: '每小時', value: 60 },
  { label: '每天', value: 1440 },
  { label: '每週', value: 10080 },
  { label: '每月', value: 43200 },
]
const ON_CHANGE_OPTIONS = [
  { label: '通知我（在資料頁掛 提示）', value: 'notify' as const },
  { label: '只記錄不通知', value: 'log_only' as const },
]
const AUTO_APPLY_OPTIONS = [
  { label: '自動更新（建議）', value: true },
  { label: '一律等我確認', value: false },
]
/** 對不上任何選項（舊資料的自訂間隔）時照實講數字，⛔ 不要冒充成最接近的那一個 */
function optionLabel<T>(options: { label: string, value: T }[], value: T): string {
  const hit = options.find(o => o.value === value)
  if (hit) return hit.label
  return typeof value === 'number' ? `每 ${value} 分鐘` : String(value)
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
/** 「更多設定」那兩格（網址）有沒有改了還沒存：「儲存設定」只管這兩格，頻率選了就存（`C-314`） */
const moreSettingsDirty = computed(() =>
  settingsForm.value.onChangeBehavior !== settingsBaseline.value.onChangeBehavior
  || settingsForm.value.urlAutoApply !== settingsBaseline.value.urlAutoApply,
)
const savingSettings = ref(false)
/** 網址的「更多設定」預設收著（`C-314`）；換一份資料不重設——收著是預設，打開是他自己要看 */
const syncMoreOpen = ref(false)
/** 「自動更新：」選了就存，存的那一下（`C-314`） */
const savingInterval = ref(false)
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
/**
 * 措辭差異（`C-144`）跟「未變」一樣收合：意思判官認定只是換句話說的 modified，
 * 預設保留原卡、不用人決定。⛔ 摺疊不是隱藏——數字講出來、可展開，
 * 判官萬一看走眼，人展開還看得到。
 */
const visibleDiffEntries = computed(() => {
  const entries = diffData.value?.diff.entries ?? []
  return showUnchangedDiff.value
    ? entries
    : entries.filter(e => e.kind !== 'unchanged' && !e.cosmetic && !e.stillOnPage)
})
const hiddenUnchangedCount = computed(() =>
  (diffData.value?.diff.entries ?? []).filter(e => e.kind === 'unchanged').length,
)
const cosmeticCount = computed(() =>
  (diffData.value?.diff.entries ?? []).filter(e => e.cosmetic).length,
)
/**
 * 收合說明的各段。⛔ 用陣列 join 不用一串 v-if：這裡已經是第三種收合類別，
 * 每加一種就要多寫一組「前面有沒有東西」的分隔符條件，遲早會多一個或少一個「、」。
 */
/** 「移除」其實還在網頁上的筆數（`C-154`）：重切換分法造成的假移除 */
const stillOnPageCount = computed(() =>
  (diffData.value?.diff.entries ?? []).filter(e => e.stillOnPage).length,
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
/**
 * 「數字沒變、只是換個說法」還**需要人看**的筆數。
 * ⛔ 要扣掉已自動摺疊的（`C-146`）：不扣的話同一批會被講兩次——上面說「8 筆只是換個說法、
 *    下方請優先看」，下面又說「8 條已收合、不需要做決定」，而下方根本一列都沒有。
 */
const diffRewordOnlyCount = computed(() =>
  (diffData.value?.diff.entries ?? [])
    .filter(e => e.kind === 'modified' && e.numbersChanged === false && !e.cosmetic).length,
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

// ── Recycle bin（回收桶）─────────────────────────────
// 刪除一律先軟刪除（後端 C-42），這裡是唯一的還原入口。三態（載入中/失敗/就緒）
// 分開呈現——「讀取失敗」與「回收桶是空的」是兩回事，混在一起就是假綠燈。
//
// `C-312`：可以搜尋、挑「哪一份資料」、「顯示更多」往前翻。以前只列最近 100 條——一份 150 條的說明書換新版，
// 昨天刪的那一條就被擠出畫面，畫面說「30 天內可以還原」卻找不到、救不回來。
interface RecycleRow {
  id: string
  title: string
  snippet: string
  sourceId: string | null
  sourceName: string | null
  deletedAtMs: number
  purgeAfterMs: number
}
interface RecycleSourceOption { key: string; name: string | null; count: number }
interface RecycleBinRes {
  items: RecycleRow[]
  truncated: boolean
  nextCursor?: string | null
  scanned?: number
  scanCapped?: boolean
  total?: number | null
  sources?: RecycleSourceOption[]
  sourcesTruncated?: boolean
  sourcesFailed?: boolean
}
/** 「全部資料」的代號：Element Plus 的 el-select 把 '' 當成沒選，會顯示 placeholder 而不是「全部資料」 */
const RECYCLE_ALL = '__all__'
/** 資料已經不在的那一組（同 server/api/ai/knowledge/recycle-bin.get.ts 的 RECYCLE_GONE_SOURCE） */
const RECYCLE_GONE = '__gone__'

const recycleOpen = ref(false)
const recycleLoading = ref(false)
/** 讀失敗的那一句（伺服器給的原因優先）；空字串＝沒失敗 */
const recycleLoadError = ref('')
const recycleRows = ref<RecycleRow[]>([])
const recycleQuery = ref('')
const recycleSource = ref(RECYCLE_ALL)
const recycleSources = ref<RecycleSourceOption[]>([])
/** 選單的數字只算到一部分（或讀不到）時，選單最後那一行講出來；空字串＝完整 */
const recycleSourcesNote = ref('')
/** 回收桶一共幾條；null＝伺服器沒算出來 */
const recycleTotal = ref<number | null>(null)
/** 「顯示更多」要帶回去的位置；null＝已經到最早刪除的那一條 */
const recycleCursor = ref<string | null>(null)
/** 伺服器翻到上限、一頁還沒湊滿就先停了：更早的還沒找（不是找不到） */
const recycleScanCapped = ref(false)
/** 這一次搜尋一共往前翻了幾條（按「繼續往前找」會累加） */
const recycleScanned = ref(0)
const recycleLoadingMore = ref(false)
const restoringId = ref('')
/** 每發一次 +1：回來時已經不是最新那一發（又打了字、換了資料）就丟掉，不蓋掉畫面 */
let recycleSeq = 0
let recycleTimer: ReturnType<typeof setTimeout> | null = null
/** 畫面上這一份是用什麼條件查的：條件沒變就不重查（打開時重設條件也會觸發 watch） */
let recycleLoadedKey = ''

const recycleFiltering = computed(() => !!recycleQuery.value.trim() || recycleSource.value !== RECYCLE_ALL)
/** 選單只列還有東西的（還原到 0 條的拿掉，除非正選著它） */
const recycleSourceOptions = computed(() =>
  recycleSources.value.filter(s => s.count > 0 || s.key === recycleSource.value),
)
/**
 * 數字那一行。只挑了資料、沒打字時用選單數好的數字（還沒翻完也知道那一份有幾條）；
 * 有打字又還沒翻完時只能講「目前找到」——後面還有沒翻的，不能講成總共幾條。
 */
const recycleCountText = computed(() => {
  const n = recycleRows.value.length
  if (!recycleFiltering.value) {
    const total = recycleTotal.value ?? (recycleCursor.value ? null : n)
    return total ? `回收桶裡有 ${total} 條` : ''
  }
  if (!recycleQuery.value.trim() && !recycleSourcesNote.value) {
    const opt = recycleSources.value.find(s => s.key === recycleSource.value)
    if (opt) return `找到 ${opt.count} 條`
  }
  if (!n) return ''
  return recycleCursor.value ? `目前找到 ${n} 條` : `找到 ${n} 條`
})

function recycleOptionLabel(s: RecycleSourceOption): string {
  const name = s.key === RECYCLE_GONE ? '已經刪掉的資料' : (s.name || '（沒有名稱的資料）')
  return `${name}（${s.count}）`
}

function recycleKey(): string {
  return `${recycleQuery.value.trim()}\n${recycleSource.value}`
}

/**
 * 讀回收桶。more＝「顯示更多／繼續往前找」（接在後面）；withSources＝順便拿選單（打開那一下才帶：
 * 伺服器要把整個回收桶數一遍，搜尋時不重算）。
 */
async function loadRecycle(more = false, withSources = false) {
  if (recycleTimer) {
    clearTimeout(recycleTimer)
    recycleTimer = null
  }
  if (more && !recycleCursor.value) return
  const q = recycleQuery.value.trim()
  const source = recycleSource.value
  const seq = ++recycleSeq
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (source !== RECYCLE_ALL) params.set('source', source)
  if (more && recycleCursor.value) params.set('cursor', recycleCursor.value)
  if (withSources) params.set('withSources', '1')
  if (more) {
    recycleLoadingMore.value = true
  }
  else {
    recycleLoadedKey = recycleKey()
    recycleLoading.value = true
    recycleLoadError.value = ''
  }
  try {
    const qs = params.toString()
    const res = await apiFetch<RecycleBinRes>(`/api/ai/knowledge/recycle-bin${qs ? `?${qs}` : ''}`)
    if (seq !== recycleSeq) return
    if (more) {
      const seen = new Set(recycleRows.value.map(r => r.id))
      recycleRows.value = [...recycleRows.value, ...res.items.filter(r => !seen.has(r.id))]
    }
    else {
      recycleRows.value = res.items
    }
    recycleCursor.value = res.nextCursor ?? null
    recycleScanCapped.value = !!res.scanCapped
    recycleScanned.value = (more ? recycleScanned.value : 0) + (res.scanned ?? res.items.length)
    if (!more && typeof res.total === 'number') recycleTotal.value = res.total
    if (withSources) {
      recycleSources.value = res.sources ?? []
      recycleSourcesNote.value = res.sourcesFailed
        ? '資料清單讀不到，先看全部'
        : res.sourcesTruncated ? '更早刪除的沒算進數字' : ''
    }
  }
  catch (err) {
    if (seq !== recycleSeq) return
    if (more) {
      showToast(apiErrorText(err, '讀取失敗，請再按一次'), 'error')
    }
    else {
      recycleLoadError.value = apiErrorText(err, '回收桶讀取失敗，請重新開啟一次。')
      recycleRows.value = []
      recycleCursor.value = null
    }
  }
  finally {
    if (seq === recycleSeq) {
      recycleLoading.value = false
      recycleLoadingMore.value = false
    }
  }
}

/** 每次打開都從頭來：回收桶可能已經變了（剛刪、剛還原） */
async function openRecycleBin() {
  recycleQuery.value = ''
  recycleSource.value = RECYCLE_ALL
  recycleRows.value = []
  recycleSources.value = []
  recycleSourcesNote.value = ''
  recycleTotal.value = null
  recycleCursor.value = null
  recycleScanCapped.value = false
  recycleOpen.value = true
  await loadRecycle(false, true)
}

/**
 * 打字停 500ms 才查（同全庫搜尋）：伺服器每一發最多往前翻 1000 條，照讀取計費。
 * 換資料是點一下的動作，直接查。
 */
watch(recycleQuery, () => {
  if (!recycleOpen.value) return
  if (recycleTimer) clearTimeout(recycleTimer)
  recycleTimer = setTimeout(() => {
    recycleTimer = null
    if (recycleOpen.value && recycleKey() !== recycleLoadedKey) loadRecycle()
  }, 500)
})
watch(recycleSource, () => {
  if (recycleOpen.value && recycleKey() !== recycleLoadedKey) loadRecycle()
})

function formatRecycleTime(ms: number): string {
  return ms ? relativeTime(ms) : ''
}

function recycleDaysLeft(ms: number): number {
  return Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000))
}

async function restoreChunk(r: RecycleRow) {
  restoringId.value = r.id
  try {
    await apiFetch(`/api/ai/knowledge/${r.id}/restore`, { method: 'POST' })
    recycleRows.value = recycleRows.value.filter(x => x.id !== r.id)
    // 數字跟著少一條（`C-312`）：總數、那一份在選單上的數字（資料已經不在的算在「已經刪掉的資料」）
    if (recycleTotal.value) recycleTotal.value--
    const optKey = r.sourceId && recycleSources.value.some(s => s.key === r.sourceId) ? r.sourceId : RECYCLE_GONE
    const opt = recycleSources.value.find(s => s.key === optKey)
    if (opt) opt.count = Math.max(0, opt.count - 1)
    showToast(`已還原「${r.title}」`, 'success')
    // 還原會動到來源的卡數/列表（連坐的 manual 來源也會回來）→ 重載
    await loadSources(true)
    if (r.sourceId && selectedId.value === r.sourceId) await loadSourceDetail(r.sourceId)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '還原失敗'), 'error')
  }
  finally {
    restoringId.value = ''
  }
}

// ── 鎖頭（手動編輯鎖，C-44）＝「這一條用你改過的版本」─────────────
// 說明與「改回去會怎樣」照來源種類講（`C-308`②／`C-309`）：以前一律寫「下一次同步會改用表格／網頁的版本」，
// 檔案根本不同步、試算表設成不自動同步的也永遠等不到「下一次同步」。三句話只寫在這裡，鎖頭、編輯框、確認框共用。

/** 會自己同步的來源（網址、試算表）：「最後同步」「同步：」只對這兩種講 */
function isSyncingType(t: string | undefined): boolean {
  return t === 'url' || t === 'gsheet'
}
/** 鎖頭有沒有意義：一段文字（manual）不會同步、也沒有上傳新版，鎖了跟沒鎖一樣——不畫 */
function lockApplies(t: string | undefined): boolean {
  return t === 'url' || t === 'gsheet' || t === 'file'
}
/** 試算表有沒有在自動更新（設成「不自動更新」的，只有按「立即更新」才會動） */
const gsheetAutoSync = computed(() => (selectedSource.value?.refreshIntervalMinutes ?? 0) > 0)

/*
 * 下面這幾句提到的按鈕名字跟右上那顆一致（`C-319`）：試算表、網址「立即更新」，檔案「上傳新版」；
 * 自動的那一次叫「自動更新」（跟「自動更新：每小時」那一格同一個詞）。⛔ 不再寫「同步」「換新版」
 */

/**
 * 鎖頭點開那一句（`C-314`：一句＋一顆按鈕就好）。以前三句：改過的時間、現在用哪一版、改回去之後什麼時候換——
 * 時間在鎖頭的 aria-label 裡、什麼時候換按了之後的提示（unlockToast）會講。
 */
function lockMeaning(t: string | undefined): string {
  if (t === 'gsheet') return '你改過這一條，表格更新時不會蓋掉。'
  if (t === 'url') return '你改過這一條，網頁更新時不會蓋掉。'
  return '你改過這一條，上傳新版時會先問要不要帶過去。'
}
function unlockEffect(t: string | undefined): string {
  if (t === 'gsheet') {
    return gsheetAutoSync.value
      ? '改回之後，下一次自動更新會換成表格上的內容；想馬上換就按「立即更新」。'
      : '改回之後，按「立即更新」就會換成表格上的內容。'
  }
  if (t === 'url') return '改回之後，網頁下次有變動時會換成網頁上的內容。'
  return '改回之後，下次「上傳新版」不會再問，直接用新版的內容。'
}
/**
 * 改回去那顆按鈕的字。
 * 檔案（`C-314`）：檔案不會自己更新，「改回跟著新版」講的是一個還不存在的新版、讀不懂。
 * 這顆按下去的實際效果是「下次上傳新版不問了、直接用新版的內容」（同一支解鎖，unlockToast 的 next_replace 那句）——
 * 按鈕就直接講這件事。⛔ 不拿掉這顆：鎖頭要消失只有這條路（編輯框裡那顆只給試算表／網頁）；
 * 不想按也沒關係，上傳新版那一下畫面本來就會一條條問帶不帶（`D-125`①）
 */
function unlockLabel(t: string | undefined): string {
  return t === 'gsheet' ? '改回跟著表格' : t === 'url' ? '改回跟著網頁' : '上傳新版時直接用新版'
}
/**
 * 改回去之後什麼時候生效：照伺服器回的 appliesOn 講（`C-308`②：伺服器知道這一份的同步設定）；
 * 舊伺服器沒回這一格就照來源種類推。⛔ 以前一律說「下一次同步」，表格沒變的話同步直接跳過、根本沒換
 */
function unlockToast(appliesOn: string | undefined, t: string | undefined): string {
  const on = appliesOn ?? (t === 'gsheet' ? 'next_sync' : t === 'url' ? 'next_change' : t === 'file' ? 'next_replace' : 'never')
  if (on === 'next_sync') {
    return gsheetAutoSync.value
      ? '已改回跟著表格：下一次自動更新就會換成表格上的內容'
      : '已改回跟著表格：按「立即更新」就會換成表格上的內容'
  }
  if (on === 'next_change') return '已改回跟著網頁：網頁下次有變動時會換成網頁上的內容'
  if (on === 'next_replace') return '好了：下次上傳新版會直接用新版的內容'
  return '好了：這份資料不會自動更新，這一條維持現在的內容'
}

const unlockingId = ref('')
/**
 * 解除手動編輯鎖。從鎖頭跳出來的那一塊按的（confirmed）：那一塊已經講了改回去會怎樣、按鈕就是確認，不再多問一次；
 * 從編輯框按的要先確認（那裡只講了「現在用你改的版本」）。回傳有沒有改成。
 */
async function unlockChunk(c: { id: string; title: string }, confirmed = false): Promise<boolean> {
  const type = selectedSource.value?.type
  if (!confirmed) {
    try {
      await ElMessageBox.confirm(
        `「${c.title}」${unlockEffect(type)}`,
        `${unlockLabel(type)}？`,
        { confirmButtonText: unlockLabel(type), cancelButtonText: '留著我改的', type: 'warning' },
      )
    }
    catch {
      return false
    }
  }
  unlockingId.value = c.id
  try {
    const res = await apiFetch<{ appliesOn?: string }>(`/api/ai/knowledge/${c.id}/settings`, { method: 'POST', body: { clearManualLock: true } })
    showToast(unlockToast(res?.appliesOn, type), 'success')
    if (selectedId.value) await loadSourceDetail(selectedId.value)
    return true
  }
  catch (err: any) {
    showToast(apiErrorText(err, '解除失敗'), 'error')
    return false
  }
  finally {
    unlockingId.value = ''
  }
}

/** 編輯框裡那顆「改回跟著表格／網頁」 */
async function unlockFromEditor() {
  const id = chunkEditingId.value
  if (!id) return
  if (await unlockChunk({ id, title: chunkForm.value.title || '這一條' })) chunkEditLockedAtMs.value = 0
}

// ── Duplicate suggestions（疑似重複，C-40(c)）───────────
const dupSuggestOpen = ref(false)
const dupDismissing = ref('')
const dupRescanning = ref(false)

/**
 * 產品名分裂 → 打開「是同一台嗎？」視窗，這一組排第一個（`C-323`）。
 * 以前打開的視窗有「自己挑兩個合併」，這一組系統沒列成候選也合得了；那一塊搬進編輯分組之後，
 * 不把這一組帶進去的話，他按了「去合併」只會看到「目前沒有需要確認的組合」
 */
function dupGoMerge(s: DupSuggestionRow) {
  dupSuggestOpen.value = false
  const a = String(s.a.productName ?? '').trim()
  const b = String(s.b.productName ?? '').trim()
  const pair = a && b && normalizeProductName(a) !== normalizeProductName(b)
    ? { a: a.length >= b.length ? a : b, b: a.length >= b.length ? b : a }
    : null
  void openAliasDialog(pair
    ? { key: `dup:${s.key}`, ...pair, reason: s.reason, confidence: 'medium', variantRisk: false }
    : undefined)
}

/** 重複卡 → 打開那張卡（看完自行決定刪哪張；刪了會進回收桶可還原） */
function dupOpenCard(id: string) {
  dupSuggestOpen.value = false
  void gotoHealthItem({ id, kind: 'chunk' })
}

async function dupDismiss(s: DupSuggestionRow) {
  dupDismissing.value = s.key
  try {
    await apiFetch('/api/ai/knowledge/dup-scan/dismiss', { method: 'POST', body: { key: s.key } })
    health.value.duplicates.items = health.value.duplicates.items.filter(x => x.key !== s.key)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '忽略失敗'), 'error')
  }
  finally {
    dupDismissing.value = ''
  }
}

async function dupRescan() {
  dupRescanning.value = true
  try {
    const r = await apiFetch<{ outcome: string; suggestions: number }>('/api/ai/knowledge/dup-scan', { method: 'POST', body: {} })
    await loadHealth(true)
    showToast(r.outcome === 'skipped_unchanged'
      ? '知識沒有變動，維持上次的掃描結果'
      : `掃描完成：${r.suggestions} 組疑似重複`, 'success')
  }
  catch (err: any) {
    showToast(apiErrorText(err, '掃描失敗'), 'error')
  }
  finally {
    dupRescanning.value = false
  }
}

// ── Chunk edit modal（只剩改既有的一條，`C-317`：新增一律走「補一條」小視窗）───────────────
const chunkEditOpen = ref(false)
const chunkEditingId = ref<string | null>(null)
// questions 是 AI 整理產生的常見問法,使用者不直接編;沒值就不送、後端保留既有
const chunkForm = ref({ title: '', content: '', tags: [] as string[], questions: undefined as string[] | undefined })
/** 打開的那一條有沒有被鎖（＞0＝用他改過的版本，見鎖頭那段）；編輯框講「它跟不跟著來源」用 */
const chunkEditLockedAtMs = ref(0)
/**
 * 編輯框裡那一句（`C-309`）：在這裡存了會不會蓋掉「跟著來源更新」。只有會同步／會上傳新版的來源才講，
 * ⛔ 一句就好——要一直有效該去哪裡改、或改回去的那顆按鈕，都接在同一行
 */
const chunkSyncNote = computed(() => {
  const t = selectedSource.value?.type
  const locked = chunkEditLockedAtMs.value > 0
  if (t === 'gsheet') return locked ? '這一條用你改過的版本，不跟著表格。' : '在這裡改了，這一條就不再跟著表格更新；要一直有效，直接改試算表。'
  if (t === 'url') return locked ? '這一條用你改過的版本，不跟著網頁。' : '在這裡改了，這一條就不再跟著網頁更新。'
  if (t === 'file') return locked ? '你改過這一條：「上傳新版」時會先問你要不要帶到新版。' : '在這裡改過的，「上傳新版」時會先問你要不要帶到新版。'
  return ''
})

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

/**
 * 從監控頁（AI 表現）、對話頁 ?q= 進來補卡、或搜尋不到按「補進知識庫」：補好之後把同問題的轉真人案例自動標已處理。
 * 改既有那一條（查重那一步選「改這一條」）也算把這題處理掉了（見 saveChunk）
 */
const pendingResolveQuery = ref('')

// ── 補一條（`C-317`，`D-126` 第 3 題）────────────────────────────────
// 這一頁所有「新增一條」都開 KnowledgeAddOneDialog（一兩句答案 → AI 整理 → 直接上線）。
// 以前是五格的編輯框（標題、內容、問法、產品、進階），而「用一句話寫一條知識」叫的是小幫手、建好還要去「等你看過」按採用——
// 同一件事兩種結果。
const addOneOpen = ref(false)
const addOneQuestion = ref('')
/**
 * 打開補一條。q＝客人原話（預填「客人問」那一格）；resolveHandoffs＝補好之後順手銷掉同問題的轉真人案例（?q= 那條路）。
 * ⛔ 每次打開都重設「待銷案的問句」：從 ?q= 進來卻放棄、之後自己補另一條時，殘留的舊問句會讓不相干的那一條把監控頁案例誤標成已處理
 */
function openAddOne(q = '', opts: { resolveHandoffs?: boolean } = {}) {
  if (!canEditKb.value) return
  addOneQuestion.value = q.slice(0, 200)
  pendingResolveQuery.value = opts.resolveHandoffs && q ? q : ''
  addOneOpen.value = true
}

/**
 * 補好了（`C-317`）：重讀清單（左邊那一份的條數、體檢）；那一條在正開著的那一份 → 重讀明細、捲過去亮一下；
 * 不在（多半是新開的一段文字）→ 左邊那一份亮一下，讓他知道放到哪了。⛔ 不硬切走他正在看的那一份
 */
async function onAddOneCreated(evt: AddOneCreated) {
  const resolvedQ = pendingResolveQuery.value
  pendingResolveQuery.value = ''
  if (resolvedQ) void resolveHandoffsByQuery(resolvedQ)
  await loadSources(true)
  const openId = selectedId.value
  if (openId && evt.sourceId === openId) {
    await loadSourceDetail(openId)
    if (evt.chunkId) {
      clearChunkNarrowing()
      await nextTick()
      void flashAgentTarget(`kb-chunk:${evt.chunkId}`, 3000)
    }
    return
  }
  if (evt.sourceId) void flashAgentTarget(`kb-source:${evt.sourceId}`, 3000)
}

/** 補完卡順手銷案：把監控頁同問題的轉真人案例標成已處理（加值動作，失敗不影響補好的那一條） */
async function resolveHandoffsByQuery(q: string) {
  try {
    const r = await apiFetch<{ resolved: number }>('/api/ai/usage/handoffs/resolve-by-query', { method: 'POST', body: { query: q } })
    if (r.resolved > 0) showToast(`已把監控頁 ${r.resolved} 筆同問題案例標為已處理`, 'success')
  }
  catch { /* 銷案是順手的加值動作 */ }
}

/** 問 AI 的「答得不對？寫一句正確答案」（`C-315`）：同一個小視窗，帶著剛剛問的那一句 */
function onAskAddOne(evt: { question?: string }) {
  openAddOne(String(evt?.question ?? ''))
}

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
  else openAddOne(q, { resolveHandoffs: true })
}

async function dupEdit(row: SearchRow) {
  dupOpen.value = false
  pendingResolveQuery.value = ''
  // 改既有那一條也算把這題處理掉了 → 沿用同一套自動銷案（存了、真的有改才銷，見 saveChunk）
  await openChunkById(row.id, { resolveQuery: dupQuery.value })
}

function dupCreateAnyway() {
  dupOpen.value = false
  openAddOne(dupQuery.value, { resolveHandoffs: true })
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
const chunkShowUsage = computed(() => chunkEditStatus.value === 'indexed' || chunkEditStatus.value === 'disabled')
/**
 * 編輯框最上面那個狀態章要不要掛（`C-314`）：只有不正常時（處理中、沒學起來、等你看過，或有失敗原因）。
 * 「可用」是正常不講；「已停用」不講——下面「AI 可以用這一條」那顆開關關著就是在講這件事
 */
const chunkStatusWorthShowing = computed(() =>
  (chunkEditStatus.value !== 'indexed' && chunkEditStatus.value !== 'disabled') || !!chunkEditFailureReason.value)
/** 有效期限收進「進階」摺疊;開窗時依「有沒有值」決定預設開合 */
const chunkAdvancedOpen = ref(false)
/**
 * 打開時那一條的標籤（排好、接成一串）：存檔時比對用（`C-314`）。
 * 標籤欄位不給看了，只有「AI 整理一下」會換掉標籤——換了才送，沒換就不送 tags，後端就不動那一格（不會被洗成空的）
 */
let chunkTagsOriginal = ''
// 開窗時的原值,儲存時只送有變的部分
let chunkSettingsOriginal = { enabled: true, activeUntil: '' }

/** ms → 台灣時區 YYYY-MM-DD(sv locale 格式剛好是 ISO 日期) */
function ymdLabel(ms: number): string {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Taipei' }).format(new Date(ms))
}

// ── Folder edit modal ───────────────────────────────
const folderEditOpen = ref(false)
const folderEditTarget = ref<FolderRow | null>(null)
const folderForm = ref({ name: '', general: false })
/** 名字、「通用」或客人的叫法（`C-323`）有改才能按儲存（只送改了的那幾格） */
const folderFormDirty = computed(() => {
  const t = folderEditTarget.value
  if (!t) return false
  return folderForm.value.name.trim() !== t.name || folderForm.value.general !== (t.general === true)
    || groupAliasChanges.value.length > 0
    // 框裡打了字還沒按 Enter 也算：儲存會把它一起加進去（不然按鈕是灰的，他會以為打的字存不了）
    || (!folderForm.value.general && groupAliasRows.value.some(r => r.draft.trim()))
})
const folderSaving = ref(false)
const folderDeleting = ref(false)

/**
 * forceHealth:剛動過知識庫(匯入 / 刪資料 / 改卡 / 套用同步)時要跳過體檢節流,
 * 否則店家照著體檢清單修完、回來數字卻不動(以為沒生效)。純瀏覽的重載用節流版即可。
 */
async function loadSources(forceHealth = false) {
  loading.value = true
  void loadHealth(forceHealth) // 體檢與列表平行載入;失敗不擋頁面
  try {
    const [sourcesRes, foldersRes] = await Promise.all([
      apiFetch<{ items: SourceSummary[]; orphanCount?: number; degraded?: boolean; truncated?: boolean }>('/api/ai/sources/list'),
      apiFetch<{ items: FolderRow[] }>('/api/ai/folders').catch(() => ({ items: [] as FolderRow[] })),
    ])
    // 清單那一支沒帶摘要（舊伺服器、或清單不回這一格）時，留著剛剛明細／寫摘要拿到的那一份（`C-316`）：
    // 不留的話，拖一份進分組（重讀清單）那一下「這份在講什麼」就不見了
    const prevSummary = new Map(sources.value.map(s => [s.id, s.summary]))
    sources.value = sourcesRes.items.map((s) => {
      const kept = s.summary === undefined ? prevSummary.get(s.id) : undefined
      return kept ? { ...s, summary: kept } : s
    })
    orphanCount.value = Number(sourcesRes.orphanCount ?? 0)
    sourcesDegraded.value = sourcesRes.degraded === true
    sourcesTruncated.value = sourcesRes.truncated === true
    folders.value = foldersRes.items ?? []
    // 第一次載入：把所有資料夾預設展開（之後 toggle 會覆寫 localStorage 狀態）
    if (expandedFolders.value.size === 1 && expandedFolders.value.has('__none__')) {
      const init = new Set<string>(['__none__'])
      for (const f of folders.value) init.add(f.id)
      expandedFolders.value = init
    }
  }
  catch (err: any) {
    showToast(apiErrorText(err, '載入資料失敗'), 'error')
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
  /** 每輪抓到的內容都不一樣＝變動偵測形同關閉（抓得到內容，所以不算同步失敗） */
  stalledSources: Array<{ id: string; name: string }>
  noProductSources: Array<{ id: string; name: string; chunkCount: number }>
  /** 商品名換了、AI 還沒重新學（`D-127`：改組名／合成一組之後畫面中途關掉）。舊伺服器沒這格 */
  relearnPendingSources?: Array<{ id: string; name: string }>
  shortChunks: HealthChunkGroup
  failedChunks: HealthChunkGroup
  expiredChunks: HealthChunkGroup
  /**
   * 客服在對話頁按過「AI 答錯了」、而那張卡至今沒被改過。
   * 按卡聚合（同一張被標多次只會是一列，markCount 是次數）。
   */
  wrongAnswerChunks: {
    count: number
    items: Array<{ id: string; title: string; sourceId: string | null; markCount: number; lastMarkedAtMs: number }>
    /** 回饋事件撈到上限＝這裡的數字是低估值（要在清單上講明，不能讓人以為就這幾條） */
    scanTruncated: boolean
  }
  chunkScanTruncated: boolean
  /**
   * AI 真的用得到的條數（已濾回收桶與非 indexed 狀態）。受掃描上限影響，
   * `chunkScanTruncated` 為 true 時只是下界——畫面要據此改口說「至少」。
   */
  liveChunkCount: number
  aliasCandidateCount: number
  /** 建議收件匣待處理數（null＝這次查不到，⛔不等於 0；D-43 缺口②） */
  pendingSuggestions: number | null
  /** 疑似重複（C-40(c)）：排程「向量篩候選 → AI 判官」的建議；合併/刪除留人拍板 */
  duplicates: { items: DupSuggestionRow[]; scannedAtMs: number; blockedByModelCount?: number }
}
interface DupSuggestionRow {
  key: string
  kind: 'product_split' | 'duplicate_cards'
  a: { id: string; title: string; productName: string; sourceId: string | null }
  b: { id: string; title: string; productName: string; sourceId: string | null }
  similarity: number
  reason: string
}
const emptyHealth = (): HealthResponse => ({
  failedSources: [],
  outdatedSources: [],
  stalledSources: [],
  noProductSources: [],
  shortChunks: { count: 0, items: [] },
  failedChunks: { count: 0, items: [] },
  expiredChunks: { count: 0, items: [] },
  wrongAnswerChunks: { count: 0, items: [], scanTruncated: false },
  chunkScanTruncated: false,
  // ⛔ 預設 0 是安全的：0 條就不會出現「AI 還沒開」那條待辦（讀不到時寧可少講一句）
  liveChunkCount: 0,
  aliasCandidateCount: 0,
  pendingSuggestions: null,
  duplicates: { items: [], scannedAtMs: 0, blockedByModelCount: 0 },
})
const health = ref<HealthResponse>(emptyHealth())
// 資料與知識分開計:「1 份資料同步失敗」= 整批知識凍結,「1 條過短」= 小瑕疵,
// 加成同一個數字會把嚴重度抹平,店家看不出該先處理哪個。
const healthSourceCount = computed(() =>
  health.value.failedSources.length
  + health.value.outdatedSources.length
  + health.value.stalledSources.length
  + health.value.noProductSources.length)
const healthChunkCount = computed(() =>
  health.value.failedChunks.count + health.value.wrongAnswerChunks.count)

/*
 * 「知道就好」的體檢結果（已過期停用、內容較短）不進「要處理的事」。
 *
 * 判準＝**這件事有沒有讓客人得到錯的回答**。沒有的話就不該進「要處理的事」，
 * 否則數字永遠清不完，久了連真的紅字（同步失敗、AI 答錯）也一起被跳過。
 *
 * - 已過期停用：有效期限功能正確運作的結果。
 * - 內容較短：短卡**照樣被檢索到、照樣拿去回答**（檢索只篩 workspaceId + status，沒有字數條件），
 *   所以它不是故障。但「免運門檻：單筆滿 1000 元」這種最好答的知識也才 13 字——
 *   列成待辦會催人去停用或刪掉一條完全正常的知識。
 *
 * `C-314`（老闆 10-14「只呈現需要的東西」）：這兩類以前在「要處理的事」最後各掛一行灰字
 * （「另有 N 條知識已過期自動停用（正常，不用處理）」「另有 N 條知識內容較短（照樣找得到，想看再看）」）——
 * 自己都說不用處理的，就不擺在工作台上。體檢端點照樣回這兩類，`?health=shortChunks／expiredChunks`
 * 那份清單也還打得開（HEALTH_META 留著），只是工作台不再主動列。
 */
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
  /**
   * 沒有 action＝這個人只能知道、不能處理（`G-102`）：那一列只留標題與 why，不畫按鈕。
   * ⛔ 不要留一顆按了沒反應的鈕（「一鍵整理」以前對觀察者就是這樣靜靜吞掉）。
   */
  cta?: string
  loading?: boolean
  action?: () => void
}

/**
 * 只有一筆時直接跳到那筆資料/知識——最常見的情境(一份資料壞掉)原本也要
 * 過一層清單彈窗,而彈窗的 hint 只是把待辦已講過的 why 再講一遍。多筆才開清單。
 */
function singleOrList(single: Array<{ id: string }>, kind: 'source' | 'chunk', cat: HealthCategory): () => void {
  if (single.length === 1) {
    const id = single[0]!.id
    return () => { void gotoHealthItem({ id, kind }, { move: cat === 'noProductSources' }) }
  }
  return () => openHealthList(cat)
}

/**
 * 因為空間滿了、表格上還有列沒收的試算表（`C-308`⑦／報告第 2 組最後一條）。
 * 以前只有點進那一份才看得到——他在表格加了新品，以為 AI 會跟上。清單上每一份本來就帶著這個數，不用多打一支
 */
const quotaSkippedSheets = computed(() => sources.value
  .filter(s => s.type === 'gsheet' && (s.quotaSkippedCount ?? 0) > 0)
  .sort((a, b) => (b.quotaSkippedCount ?? 0) - (a.quotaSkippedCount ?? 0)))

const todoItems = computed<TodoItem[]>(() => {
  const items: TodoItem[] = []
  const h = health.value

  /**
   * AI 沒開 = 這一整頁的努力目前對客人零影響（P1-4）。
   * 排第一個、紅色：知識庫建得再完整，總開關關著客人也感覺不到——
   * 這是最容易「做完一整天卻沒有任何效果」的坑，而且畫面原本完全不提。
   */
  if (aiEnabled.value === false && liveChunkCount.value > 0) {
    items.push({
      id: 'aiOff',
      tone: 'danger',
      title: 'AI 客服還沒開啟',
      why: `${health.value.chunkScanTruncated ? '已經有至少' : '已經有'} ${liveChunkCount.value} 條知識，但 AI 目前不會回覆客人——這些內容還沒開始發揮作用。`
        + (canEditAiSettings.value ? '' : '開關要請管理員到「AI 設定」打開。'),
      // `G-102`：AI 設定頁客服、觀察者進得去卻存不了——給他「前往開啟」是一條走到底才發現開不了的路
      ...(canEditAiSettings.value
        ? { cta: '前往開啟', action: () => { void navigateTo(`/admin/${workspaceId.value}/ai-settings`) } }
        : {}),
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
  /**
   * 客服在對話上按過「AI 答錯了」的卡。排在同事回報的訊號裡最前面（僅次於整批壞掉的資料）：
   * 這是唯一「有人親眼看到 AI 答錯客人」的訊號，比任何自動偵測都確定。
   *
   * 不必等建議收件匣——那條路要同主題累積、還要等排程（最長 7 天）。這裡是不用等的那條。
   */
  if (h.wrongAnswerChunks.count) {
    const first = h.wrongAnswerChunks.items[0]
    const repeated = h.wrongAnswerChunks.items.filter(i => i.markCount > 1).length
    items.push({
      id: 'wrongAnswerChunks',
      tone: 'danger',
      title: h.wrongAnswerChunks.count === 1
        ? `有 1 條內容被同事標記「AI 答錯了」`
        : `有 ${h.wrongAnswerChunks.count} 條內容被同事標記「AI 答錯了」`,
      why: repeated
        ? `其中 ${repeated} 條被標記不只一次，代表它正在持續答錯客人。改好那幾條就會從這裡消失。`
        : '同事在對話上看到 AI 用這些內容答錯了，而它們到現在都還沒被修改過。',
      cta: '前往修正',
      action: h.wrongAnswerChunks.count === 1 && first
        ? () => { void gotoHealthItem({ id: first.id, kind: 'chunk' }) }
        : () => openHealthList('wrongAnswerChunks'),
    })
  }
  // 排在建議類最前面：其他幾件是「可能答錯」，這件是「確定答不出來」（表格上有、知識庫沒有）
  if (quotaSkippedSheets.value.length) {
    const rows = quotaSkippedSheets.value.reduce((n, s) => n + (s.quotaSkippedCount ?? 0), 0)
    items.push({
      id: 'quotaSkippedSheets',
      tone: 'warning',
      title: `${quotaSkippedSheets.value.length} 份試算表有 ${rows} 列因為空間滿了還沒收`,
      why: '表格上新加的那幾列 AI 還答不出來。刪掉用不到的知識或升級方案之後，同步時就會補上。',
      cta: '查看',
      action: singleOrList(quotaSkippedSheets.value, 'source', 'quotaSkippedSheets'),
    })
  }
  if (h.outdatedSources.length) {
    items.push({
      id: 'outdatedSources',
      tone: 'warning',
      title: `有 ${h.outdatedSources.length} 份資料的原始內容改過了`,
      // ⛔ 不再寫「原始網頁或試算表被改過，但 AI 還在用舊版本回答」（`C-309`）：頁頂提醒帶一字不差講過一次了，這裡只講下一步
      why: '點進去看哪裡變了，再決定要不要換成新的。',
      cta: '前往比對',
      action: singleOrList(h.outdatedSources, 'source', 'outdatedSources'),
    })
  }
  /**
   * 疑似重複（C-40(c)）：同一台商品的知識散在不同來源、或同一台被叫成兩個名字。
   * 放著不管的下場已經發生過——同機不同名答矛盾、客人講到型號被判成「別台」轉真人。
   * AI 只出建議（附理由），合併/刪除都由人按。
   */
  if (h.duplicates.items.length) {
    items.push({
      id: 'duplicates',
      tone: 'warning',
      title: `有 ${h.duplicates.items.length} 組知識疑似重複`,
      why: '同一件事存了兩份（或同一台商品有兩個名字），AI 可能反問一樣的選項、甚至前後矛盾。',
      cta: '查看',
      action: () => { dupSuggestOpen.value = true },
    })
  }
  /**
   * 排在「內容改過了」後面：那個是已經知道要做什麼的事，這個是「系統其實沒在幫你看」——
   * 不緊急但更容易被忽略，因為畫面上完全看不出異狀（最後同步時間照樣在更新）。
   */
  if (h.stalledSources.length) {
    items.push({
      id: 'stalledSources',
      tone: 'warning',
      title: `有 ${h.stalledSources.length} 份資料的自動偵測失效`,
      why: '這幾個網址每次抓到的內容都不一樣，系統分不出哪次才算真的改版，所以官網改了也不會通知你。',
      cta: '前往查看',
      action: singleOrList(h.stalledSources, 'source', 'stalledSources'),
    })
  }
  if (h.noProductSources.length) {
    items.push({
      id: 'noProductSources',
      tone: 'warning',
      // `D-127` 分組就是商品：說明書沒說是哪個商品＝沒放進商品分組（判斷同一支 needsProductName）
      title: `有 ${h.noProductSources.length} 份檔案還沒放進商品分組`,
      why: '客人指名問某一台時，AI 可能拿別台產品的內容回答。',
      // 這顆直接打開那一份的「移到哪一組」（一份時）；搬不了的人（`G-102`）只留這一列當作知道
      ...(canEditSources.value
        ? { cta: '放進分組', action: singleOrList(h.noProductSources, 'source', 'noProductSources') }
        : {}),
    })
  }
  /**
   * 商品名換了、AI 還沒重新學（`D-127` /code-review 第 4 條）：改組名、合成一組之後，重新學習是畫面一份份打的，
   * 中途關掉頁面就停在一半——那幾份卡片上還是舊名字。以前沒有任何地方找得到它們。
   * 正在學的那幾份（左邊標「搬移中」）不算：學完會自己消失
   */
  const pendingRelearn = (h.relearnPendingSources ?? []).filter(s => !movingSourceIds.value.has(s.id))
  if (pendingRelearn.length) {
    items.push({
      id: 'relearnPending',
      tone: 'warning',
      title: `有 ${pendingRelearn.length} 份資料換了商品名，AI 還沒重新學`,
      why: '學好之前，AI 還是用舊的商品名找這幾份的內容。',
      ...(canEditSources.value
        ? {
            cta: '重新學習',
            loading: relearningPending.value,
            action: () => {
              if (relearningPending.value) return
              relearningPending.value = true
              void relearnSourcesAfterGroupChange(pendingRelearn.map(s => s.id))
                .finally(() => { relearningPending.value = false })
            },
          }
        : {}),
    })
  }
  // ⛔「內容較短」刻意不在這裡：它不是待辦，判準見 healthIssueCount 上面那段。
  // 別名候選原本只藏在「⋯」選單展開後的項目文字裡,⋯ 按鈕本身沒有徽章——
  // 等於一個看不見的異常。它會讓 AI 把同一台機器當成兩台,該進待辦。
  // `C-323` 起選單那一項拿掉了，這一列（和「疑似重複」的「去合併商品名」）是唯一的入口
  if (h.aliasCandidateCount > 0) {
    items.push({
      id: 'alias',
      tone: 'warning',
      title: `有 ${h.aliasCandidateCount} 組商品名可能是同一台`,
      why: '同一台機器兩種叫法會被 AI 當成兩台——反問客人二選一、出貨時間並列成兩台。',
      // `G-102`：進去唯一能做的是合併／不是（sources.write），觀察者只留這一列當作知道
      ...(canEditSources.value ? { cta: '前往確認', action: () => { void openAliasDialog() } } : {}),
    })
  }
  if (orphanCount.value > 0) {
    items.push({
      id: 'orphan',
      tone: 'warning',
      title: `有 ${orphanCount.value} 條舊版內容還沒歸檔`,
      why: '這些是舊版本留下的、沒有歸在任何一份資料底下。整理一下就會出現在下面的清單裡。',
      // `G-102`：以前觀察者看得到這顆、按了靜靜不做事（裡面有 if 擋掉）＝最糟的那種；改成不給
      ...(canEditSources.value
        ? { cta: '一鍵整理', loading: migrating.value, action: () => { void migrateOrphans() } }
        : {}),
    })
  }
  return items
})

// ── 工作台入口(選著資料時) ──────────────────────────
// 工作台(要處理的事+AI建議)只在未選取資料時顯示;選著資料時側欄留一行入口。
// 建議數有兩個來源(D-43 缺口②)：元件掛載後以它回報的為準(採用/忽略即時反映)；
// 元件沒掛載時(選著資料、或深連結直接落在某張卡)退回 health 端點的計數——
// 原本只吃元件回報，深連結進頁時「M 個 AI 建議」整段消失。
const suggestCount = ref(0)
const suggestCountReported = ref(false)
function onSuggestCount(n: number) {
  suggestCount.value = n
  suggestCountReported.value = true
}
const effectiveSuggestCount = computed(() =>
  suggestCountReported.value ? suggestCount.value : (health.value.pendingSuggestions ?? 0))
const workbenchBadge = computed(() => {
  const parts: string[] = []
  if (todoItems.value.length) parts.push(`${todoItems.value.length} 件要處理`)
  if (effectiveSuggestCount.value) parts.push(`${effectiveSuggestCount.value} 個 AI 建議`)
  return parts.join('、')
})
function backToWorkbench() {
  selectedId.value = null
  chunks.value = []
}

// ── 小幫手補了一張卡（`D-112` 第 4 件）────────────────────────────
// 卡放在「等你看過」，那一區只在**沒選任何資料**時出現（它自己會重讀並亮那張，見 KnowledgeSiteDrafts）。
// 這裡只管「他正開著某份資料」：剛補好時不硬切走（他可能正在看那份），回 missing 讓聊天給「前往查看」；
// 按了才回工作台。
useAgentOpRefresh('knowledge', async (evt, { mode }) => {
  if (mode !== 'reveal' || !selectedId.value) return 'missing'
  backToWorkbench()
  return (await flashAgentTarget(evt.targetId, 8000)) ? 'shown' : 'missing'
})

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
    // 併回預設值:後端還沒部署新欄位(duplicates)時,舊回應缺欄位不能讓畫面炸掉
    health.value = { ...emptyHealth(), ...(await apiFetch<HealthResponse>('/api/ai/knowledge/health')) }
  }
  catch {
    /* 體檢失敗不擋頁面,banner 不顯示而已 */
    healthFetchedAt = 0 // 失敗不佔用節流窗,下次進來可重試
  }
}

type HealthCategory = 'failedSources' | 'outdatedSources' | 'stalledSources' | 'noProductSources' | 'quotaSkippedSheets' | 'failedChunks' | 'shortChunks' | 'expiredChunks' | 'wrongAnswerChunks'
const HEALTH_META: Record<HealthCategory, { title: string; hint: string }> = {
  failedSources: { title: '資料同步失敗', hint: '這些資料自動同步一直失敗,知識停留在最後一次成功的內容。點進資料看失敗原因(常見:試算表沒分享給服務帳號、網頁被移走)。' },
  outdatedSources: { title: '資料偵測到變動', hint: '網頁內容跟上次不一樣了。點進資料按「立即更新」看差異,決定要不要更新知識。' },
  stalledSources: { title: '自動偵測失效', hint: '這幾個網址每次抓到的內容都不一樣(常見於有隨機推薦、輪播區塊的首頁),系統分不出哪次才算真的改版,所以官網改了也不會通知你。要更新知識請點進資料按「立即更新」,或改用內容固定的頁面當資料來源。' },
  // `D-127`：點一份直接打開「移到哪一組」那個小視窗（gotoHealthItem），所以只講「點一份放進去」
  noProductSources: { title: '檔案還沒放進商品分組', hint: '單一商品的說明書要放進那一台的分組，AI 才知道在講哪一台。點一份放進去。' },
  quotaSkippedSheets: { title: '試算表還有列沒收', hint: '知識空間滿了，這幾份試算表上新加的列先沒收進知識庫。點進那一份看還差幾列。' },
  failedChunks: { title: '知識學習失敗', hint: '這幾條 AI 沒有學成功,客人問到相關問題時找不到它們。點開知識按「重新學習」可以重試。' },
  // ⛔ 字數不要寫死：門檻是 SHORT_CHUNK_CONTENT_CHARS，前後端共用同一把尺。
  //    寫死的話調了門檻，逐條提示與統計都會跟著變，只有這個對話框還在說「不到 30 字」——
  //    而這裡正是解釋門檻的地方，兩邊講不一樣最糟。
  shortChunks: { title: '知識內容較短', hint: `這幾條不到 ${SHORT_CHUNK_CONTENT_CHARS} 字(空白不算)。⚠️ 它們沒有壞掉——AI 一樣找得到、也照樣拿去回答,「客服電話」「免運門檻」這種本來就這麼短。列出來只是因為切壞或抓壞的殘片多半也很短:看一眼,是殘片就刪掉,是正常知識就放著不用管。` },
  expiredChunks: { title: '知識已過期停用', hint: '這幾條因有效期限到期被自動停用。活動若延長,把期限改到未來就會自動重新上架;確定結束可放著或刪除。' },
  wrongAnswerChunks: { title: '被標記「AI 答錯了」', hint: '同事在對話上看到 AI 用這幾條答錯客人。點開改掉內容就會從這裡消失——系統看的是「標記之後這條有沒有被改過」,不需要另外按已處理。次數是近 30 天內被標記的次數。' },
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
  if (cat === 'stalledSources') {
    return h.stalledSources.map(s => ({ id: s.id, title: s.name, meta: '', kind: 'source' as const }))
  }
  if (cat === 'noProductSources') {
    return h.noProductSources.map(s => ({ id: s.id, title: s.name, meta: `${s.chunkCount} 條`, kind: 'source' as const }))
  }
  if (cat === 'quotaSkippedSheets') {
    return quotaSkippedSheets.value.map(s => ({ id: s.id, title: s.name, meta: `${s.quotaSkippedCount ?? 0} 列沒收`, kind: 'source' as const }))
  }
  if (cat === 'wrongAnswerChunks') {
    // 次數是這一類唯一的排序依據,不放進 meta 等於把最重要的資訊藏起來
    return h.wrongAnswerChunks.items.map(c => ({
      id: c.id,
      title: c.title,
      meta: [c.markCount > 1 ? `被標記 ${c.markCount} 次` : '被標記 1 次', sourceName(c.sourceId)]
        .filter(Boolean).join(' · '),
      kind: 'chunk' as const,
    }))
  }
  return h[cat].items.map(c => ({ id: c.id, title: c.title, meta: sourceName(c.sourceId), kind: 'chunk' as const }))
})
const healthListTruncatedNote = computed(() => {
  const cat = healthListCategory.value
  // 一列是一份資料的那幾類沒有「先列前幾條」這回事（⚠️ 一個個比：TS 才收得窄，下面那行才查得到 health[cat]）
  if (cat === 'failedSources' || cat === 'outdatedSources' || cat === 'stalledSources' || cat === 'noProductSources' || cat === 'quotaSkippedSheets') return ''
  const group = health.value[cat]
  const notes: string[] = []
  if (group.count > group.items.length) {
    // 「知道就好」的兩類不講「處理完」——那是催促語氣,跟灰字那行「不用處理」互相打架
    notes.push(cat === 'shortChunks' || cat === 'expiredChunks'
      ? `共 ${group.count} 條,先列前 ${group.items.length} 條。`
      : `共 ${group.count} 條,先列前 ${group.items.length} 條;處理完重新整理會再列出其餘的。`)
  }
  // 掃描達上限時計數本身就是低估的,不講清楚店家會以為「清完就沒事了」
  if (health.value.chunkScanTruncated) {
    notes.push('知識數量較多,體檢只掃描了其中一部分,實際條數可能更多。')
  }
  if (cat === 'wrongAnswerChunks' && health.value.wrongAnswerChunks.scanTruncated) {
    notes.push('近期的標記筆數較多,只統計了最近的一批,實際被標記的內容可能更多。')
  }
  return notes.join(' ')
})

function openHealthList(cat: HealthCategory) {
  healthListCategory.value = cat
  healthListOpen.value = true
}

async function gotoHealthItem(item: { id: string; kind: 'source' | 'chunk' }, opts: { move?: boolean } = {}) {
  healthListOpen.value = false
  if (item.kind === 'source') {
    const src = sources.value.find(s => s.id === item.id)
    if (src) {
      await selectSource(src)
      // 「還沒放進商品分組」（`D-127`）：「移到哪一組」收在右上「⋯」裡，帶到那一份還要他自己找——直接打開那個小視窗
      if (opts.move && selectedId.value === src.id) openMoveDialog()
    }
    else showToast('找不到這份資料(可能剛被刪除),請重新整理', 'error')
  }
  else {
    await openChunkById(item.id)
  }
}

// ── 可能是同一台（別名候選）＋編輯分組的「客人還會怎麼叫它」───────────────
// 同一台機器兩種叫法會被 AI 當成兩台(反問二選一、出貨時間並列)。系統偵測候選、由人確認——
// 不自動合併:「W1 REGEN」與「W1 REGEN ULTRA」字面上也像別名,但那是兩台不同機器。
// `C-323`：候選視窗只剩「是不是同一台」那幾組；自己加叫法、拿掉別名搬進編輯分組（下方 groupAlias*）。
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
/** 已確認的對照（別名 → 最終正式名）。編輯分組照這份列出「客人還會怎麼叫它」 */
const aliasPairs = ref<AliasPair[]>([])
/** 這個帳號目前所有產品名（編輯分組加叫法時可以直接挑一個現有的＝當成同一台） */
const aliasProductNames = ref<string[]>([])
/** 正規化的別名 → 最終正式名 */
const aliasFinalOf = computed(() => new Map(aliasPairs.value.map(p => [p.aliasKey, p.canonical] as const)))

/** 讀別名對照＋候選。讀不到回 false（編輯分組要分得出「讀不到」跟「真的沒有」） */
async function loadAliases(): Promise<boolean> {
  aliasLoading.value = true
  try {
    const res = await apiFetch<{ candidates: AliasCandidate[]; pairs: AliasPair[]; productNames?: string[] }>(
      '/api/ai/knowledge/product-aliases',
    )
    aliasCandidates.value = (res.candidates ?? []).map(groupNameFirst)
    aliasPairs.value = res.pairs ?? []
    aliasProductNames.value = (res.productNames ?? []).slice().sort((a: string, b: string) => a.localeCompare(b, 'zh-TW'))
    return true
  }
  catch (err: any) {
    showToast(apiErrorText(err, '讀取商品名失敗'), 'error')
    return false
  }
  finally {
    aliasLoading.value = false
  }
}

/** 同一組名字（不分先後、不分寫法） */
function sameAliasPair(x: { a: string; b: string }, y: { a: string; b: string }): boolean {
  const k = (p: { a: string; b: string }) => [normalizeProductName(p.a), normalizeProductName(p.b)].sort().join('|')
  return k(x) === k(y)
}

/** extra：「疑似重複」帶過來的那一組（系統沒列成候選也要讓他判斷），排第一個 */
async function openAliasDialog(extra?: AliasCandidate) {
  aliasOpen.value = true
  await loadAliases()
  if (extra) aliasCandidates.value = [groupNameFirst(extra), ...aliasCandidates.value.filter(c => !sameAliasPair(c, extra))]
}

/** 名字就是這個的商品分組（`D-127`：組名＝商品名） */
function productGroupNamed(name: string): FolderRow | null {
  return folders.value.find(f => !f.general && sameProductGroupName(f.name, name)) ?? null
}

/**
 * 兩個名字只有一個是商品分組的組名 → 組名排前面＝合併後的正式名（`D-127` 組名就是商品名；/code-review 第 6 條）。
 * 以前一律拿比較長的當正式名，較長的常是沒有分組的舊全名：按「是同一台」反而把組名收成舊名字的別名，
 * 那一組的卡片全被收斂回舊名字、編輯分組裡的叫法也全看不到
 */
function groupNameFirst<T extends { a: string; b: string }>(c: T): T {
  return !productGroupNamed(c.a) && productGroupNamed(c.b) ? { ...c, a: c.b, b: c.a } : c
}

/**
 * 兩組其實是同一台 → 合成一組（`D-127` 分組就是商品：同一台只能有一組）。
 * 一個請求做完搬家（PUT {mergeInto}，/code-review 第 9、10 條）：伺服器照分組查**全部**資料搬進 keep——
 * 以前畫面照自己的清單一份份搬，清單被截斷時看不到的那幾份會被接著的「刪分組」丟到未分類；
 * 別名失敗被吞掉也看不出來。搬完只改了名字，回 relearnSourceIds 再一份份重新學（同改組名）
 */
async function mergeProductGroups(keep: FolderRow, from: FolderRow): Promise<void> {
  const res = await apiFetch<{ moved: number; relearnSourceIds?: string[]; aliasFrom?: string }>(
    `/api/ai/folders/${from.id}`,
    { method: 'PUT', body: { mergeInto: keep.id } },
  )
  folders.value = folders.value.filter(f => f.id !== from.id)
  showToast(`已合成一組「${keep.name}」${res.moved ? `（搬了 ${res.moved} 份）` : ''}，AI 把它們當成同一台`
    + (res.aliasFrom ? `；「${res.aliasFrom}」留成客人的叫法` : ''), 'success')
  await loadSources(true)
  void relearnSourcesAfterGroupChange(res.relearnSourceIds ?? [])
}

async function decideAlias(c: AliasCandidate, action: 'confirm' | 'dismiss') {
  aliasSaving.value = c.key
  try {
    // 兩個名字都是商品分組（`D-127`）：是同一台＝合成一組，不只是記一條別名（不然左邊照樣是兩組、資料分兩處）
    const keepGroup = action === 'confirm' ? productGroupNamed(c.a) : null
    const fromGroup = action === 'confirm' ? productGroupNamed(c.b) : null
    if (keepGroup && fromGroup && keepGroup.id !== fromGroup.id) {
      await mergeProductGroups(keepGroup, fromGroup)
      await loadAliases()
      void loadHealth(true)
      return
    }
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
          // 以前這個視窗下面就有「已確認的對照」可以解除；搬走之後要講一次去哪裡拿掉
          : '已合併，AI 之後會把它們當同一台（要拿掉：那一組的「編輯分組」）',
      'success',
    )
    await loadAliases()
    void loadHealth(true)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '儲存失敗'), 'error')
  }
  finally {
    aliasSaving.value = ''
  }
}

// ── 編輯分組：客人還會怎麼叫它（`C-323`，`D-126` 第 4 步「別名取代產品名稱整理」）──
// `D-127` 起一組一列（商品名＝組名），列出現有的別名；可以打新的叫法，也可以挑一個現有的商品名（＝當成同一台）。
// 舊的「自己挑兩個合併」「已確認的對照→解除」就是這兩件事。⛔ 按「儲存」才寫（跟名字、通用同一顆）：取消要真的取消。
interface GroupAliasRow {
  /** 最終正式名（別名指向它） */
  product: string
  /** 打開時就有的別名（原樣寫法） */
  original: string[]
  /** 現在的（標籤） */
  current: string[]
  /** 輸入框裡還沒加進去的字（按儲存時一起收，見 saveFolderName） */
  draft: string
}
const groupAliasRows = ref<GroupAliasRow[]>([])
const groupAliasLoading = ref(false)
const groupAliasFailed = ref(false)

/**
 * `D-127` 分組就是商品：一組一列，商品名＝組名（伺服器照組名掛在底下每一份上），列出指向它的別名。
 * （`C-323` 那時是「這一組裡每個商品名各一列」——一組裡可能有好幾種寫法；現在只有組名一種）
 */
function buildGroupAliasRows(folder: FolderRow): GroupAliasRow[] {
  const key = normalizeProductName(folder.name)
  if (!key) return []
  const aliases = aliasPairs.value.filter(p => normalizeProductName(p.canonical) === key).map(p => p.alias)
  return [{ product: folder.name, original: aliases, current: [...aliases], draft: '' }]
}

async function loadGroupAliases(folderId: string) {
  groupAliasRows.value = []
  groupAliasFailed.value = false
  groupAliasLoading.value = true
  const ok = await loadAliases()
  // 讀的這一兩秒他可能已經關掉、換開另一組
  if (!folderEditOpen.value || folderEditTarget.value?.id !== folderId) return
  groupAliasLoading.value = false
  if (!ok) {
    groupAliasFailed.value = true
    return
  }
  groupAliasRows.value = buildGroupAliasRows(folderEditTarget.value)
}

/** 下拉可以挑的：其他現有商品名（挑了＝當成這一台）；已經是這一台的、已經在框裡的不列 */
function groupAliasOptions(row: GroupAliasRow): string[] {
  const rowKey = normalizeProductName(row.product)
  const taken = new Set(row.current.map(normalizeProductName))
  return aliasProductNames.value.filter((n) => {
    const k = normalizeProductName(n)
    return k !== rowKey && !taken.has(k) && normalizeProductName(aliasFinalOf.value.get(k) ?? n) !== rowKey
  })
}

/** 輸入框打字時的下拉：只在打字後出現（一點進去就列一排別的商品，會以為要從裡面挑） */
function groupAliasSuggestionsFor(row: GroupAliasRow) {
  return (query: string, cb: (items: Array<{ value: string }>) => void) => {
    const q = normalizeProductName(query)
    cb(q ? groupAliasOptions(row).filter(n => normalizeProductName(n).includes(q)).map(value => ({ value })) : [])
  }
}

/**
 * 把一個叫法加成標籤（Enter、挑下拉、按儲存時框裡還有字）。回 false＝不收、原因已經講了。
 * ⛔ 不用 el-select 的「多選＋可自己打」：那個要按 Enter 才算數，打了字直接按儲存會被安靜丟掉（以前「所屬產品」欄位踩過同一個坑）
 */
function addGroupAlias(row: GroupAliasRow, value = row.draft): boolean {
  const s = String(value ?? '').trim()
  if (!s) return true
  const k = normalizeProductName(s)
  // 只檢查新的：舊資料裡可能有過短的別名，拿掉又加回來不該被擋
  if (!row.original.some(a => normalizeProductName(a) === k)) {
    if (!isUsableAlias(s)) { showToast(ALIAS_TOO_SHORT_TEXT, 'warning'); return false }
    if (s.length > 50) { showToast('叫法最多 50 個字', 'warning'); return false }
  }
  if (k === normalizeProductName(row.product)) showToast('這就是它的商品名，不用另外加', 'info')
  else if (!row.current.some(a => normalizeProductName(a) === k)) row.current = [...row.current, s]
  row.draft = ''
  return true
}

function removeGroupAlias(row: GroupAliasRow, alias: string) {
  row.current = row.current.filter(a => a !== alias)
}

function groupAliasDiff(row: GroupAliasRow) {
  const before = new Set(row.original.map(normalizeProductName))
  const after = new Set(row.current.map(normalizeProductName))
  return {
    added: row.current.filter(a => !before.has(normalizeProductName(a))),
    removed: row.original.filter(a => !after.has(normalizeProductName(a))),
  }
}

/** 通用那一組不講單一商品：勾著通用時這一塊收起來、也不存 */
const groupAliasChanges = computed(() => folderForm.value.general
  ? []
  : groupAliasRows.value
      .map(row => ({ row, ...groupAliasDiff(row) }))
      .filter(x => x.added.length || x.removed.length))

// ── 分組 CRUD（`C-320`：資料庫裡叫 folder，畫面上叫「分組」）─────────────────
async function createFolderPrompt() {
  let name = ''
  try {
    // `D-127` 分組就是商品：名字就是 AI 認的商品名（不是講單一商品的，建好之後在編輯分組勾「通用」）
    const { value } = await ElMessageBox.prompt('商品名就是分組的名字（不是講單一商品的，建好之後勾「通用」）', '新增分組', {
      confirmButtonText: '建立',
      cancelButtonText: '取消',
      inputPlaceholder: '例：SHARP 自動調理零水鍋',
      inputPattern: /^.{1,50}$/,
      inputErrorMessage: '名稱長度需 1–50 字',
    })
    name = String(value ?? '').trim()
  }
  catch { return /* 使用者取消 */ }
  if (!name) return
  // ⛔ 建不成要講（以前跟「按取消」接在同一個 catch 裡，伺服器拒絕時畫面什麼都沒發生）
  try {
    const folder = await apiFetch<FolderRow & { existed?: boolean }>('/api/ai/folders', { method: 'POST', body: { name } })
    // 已經有同一台的那一組（名字只差空白、符號、大小寫）：伺服器不另建、回那一組——打開它、講一句，⛔ 不在清單上多一列
    if (folder.existed) {
      expandedFolders.value = new Set([...expandedFolders.value, folder.id])
      saveExpandedState()
      showToast(`已經有「${folder.name}」這一組了`, 'info')
      return
    }
    folders.value = [...folders.value, folder]
    expandedFolders.value = new Set([...expandedFolders.value, folder.id])
    saveExpandedState()
    showToast('已建立分組', 'success')
  }
  catch (err: any) {
    showToast(apiErrorText(err, '分組沒有建成，請再試一次'), 'error')
  }
}

// 編輯分組 modal — 改名 + 刪除都在這裡做
function openFolderEdit(folder: FolderRow) {
  folderEditTarget.value = folder
  folderForm.value = { name: folder.name, general: folder.general === true }
  folderEditOpen.value = true
  // 通用那一組也讀：他可能當場取消勾「通用」、接著要加叫法
  void loadGroupAliases(folder.id)
}

async function saveFolderName() {
  if (!folderEditTarget.value) return
  const target = folderEditTarget.value
  const newName = folderForm.value.name.trim()
  if (!newName || !folderFormDirty.value) return
  const body: { name?: string, general?: boolean } = {}
  if (newName !== target.name) body.name = newName
  if (folderForm.value.general !== (target.general === true)) body.general = folderForm.value.general
  // 框裡還有字＝他要加的，先收成標籤；收不了（太短）就停在這裡，原因 addGroupAlias 講過了
  if (!folderForm.value.general) {
    for (const row of groupAliasRows.value) if (!addGroupAlias(row)) return
  }
  const aliasChanges = groupAliasChanges.value
  /*
   * 挑的是另一個現有商品分組的名字＝那一組其實就是這一台 → 合成一組（`D-127` /code-review 第 10 條）：
   * 以前只記一條別名，左邊照樣兩組、那一組的資料商品名還是自己的組名，下次改名又分家。
   */
  const mergeGroups = aliasChanges.flatMap(x => x.added)
    .map(a => productGroupNamed(a))
    .filter((g): g is FolderRow => !!g && g.id !== target.id)
    .filter((g, i, all) => all.findIndex(o => o.id === g.id) === i)
  const mergeIds = new Set(mergeGroups.map(g => g.id))
  // 挑的是另一個現有商品名＝兩台當成同一台。沒有系統證據背書，最常見的誤用是把同系列不同型號併掉——存之前講清楚
  const existing = new Set(aliasProductNames.value.map(normalizeProductName))
  const merges = aliasChanges.flatMap(x =>
    x.added.filter(a => existing.has(normalizeProductName(a)) && !productGroupNamed(a)).map(a => `「${a}」`))
  if (merges.length || mergeGroups.length) {
    try {
      await ElMessageBox.confirm(
        [
          mergeGroups.length ? `${mergeGroups.map(g => `「${g.name}」`).join('、')}那一組的資料會搬進這一組，合成一組。` : '',
          merges.length ? `${merges.join('、')}現在是別的商品名，存了之後 AI 會把它當成這一台。` : '',
          '同系列的不同型號（例如 ULTRA 版、12L 與 16L）是兩台不同機器，不要這樣加。',
        ].join(''),
        '確認是同一台？',
        { confirmButtonText: '是同一台，儲存', cancelButtonText: '再想想', type: 'warning' },
      )
    }
    catch {
      return // 使用者取消
    }
  }
  folderSaving.value = true
  let relearnIds: string[] = []
  let aliasFrom = ''
  let syncFailed = false
  try {
    if (body.name !== undefined || body.general !== undefined) {
      // `D-127`：改組名、改成／取消通用＝底下每份換商品名；回要重新學的那幾份、舊組名收成了哪個別名。同名的商品分組＝400（講原因）
      const res = await apiFetch<FolderRow & { relearnSourceIds?: string[], aliasFrom?: string, syncFailed?: boolean }>(`/api/ai/folders/${target.id}`, { method: 'PUT', body })
      const idx = folders.value.findIndex(f => f.id === target.id)
      // 舊伺服器回的沒有 general：照這次送的補上，畫面上的排序才對得上
      if (idx >= 0) folders.value[idx] = { id: res.id, name: res.name, order: res.order, createdAtMs: res.createdAtMs, general: res.general ?? (body.general ?? target.general === true) }
      relearnIds = res.relearnSourceIds ?? []
      aliasFrom = res.aliasFrom ?? ''
      syncFailed = res.syncFailed === true
    }
    // 叫法一個一個存（各自有操作紀錄）。中途失敗就停、前面存好的不回滾，catch 裡重讀一次讓畫面等於真的存進去的。
    // 指向的是**改完之後**的組名（同一個視窗裡又改名又加叫法時，加的要跟著新名字）
    for (const x of aliasChanges) {
      for (const alias of x.removed) {
        await apiFetch('/api/ai/knowledge/product-aliases', { method: 'POST', body: { action: 'remove', alias } })
      }
      for (const alias of x.added) {
        // 是另一個商品分組的名字：下面合成一組時伺服器會收成別名，這裡不另外記
        if (mergeIds.has(productGroupNamed(alias)?.id ?? '')) continue
        await apiFetch('/api/ai/knowledge/product-aliases', { method: 'POST', body: { action: 'confirm', canonical: newName, alias } })
      }
    }
    const keep = folders.value.find(f => f.id === target.id)
    if (keep) {
      for (const from of mergeGroups) await mergeProductGroups(keep, from)
    }
    // 「可能是同一台」那一列的數字可能跟著變
    if (aliasChanges.length || relearnIds.length || aliasFrom || syncFailed) void loadHealth(true)
    if (syncFailed) {
      // 組名存好了、底下資料的商品名沒跟上：體檢會列進「還沒重新學」，按一次就對齊（folders PUT 那段）
      showToast('組名改好了，但底下資料的商品名沒跟上——到「要處理的事」按「重新學習」補上', 'warning')
    }
    else if (!mergeGroups.length) {
      showToast(aliasFrom ? `已儲存；舊名字「${aliasFrom}」留成客人的叫法` : '已儲存', 'success')
    }
    folderEditOpen.value = false
    // 底下每份換了商品名：一份份重新學（不等；左邊那幾列標「搬移中」，學完講一句）
    void relearnSourcesAfterGroupChange(relearnIds)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '儲存失敗'), 'error')
    if (aliasChanges.length) void loadGroupAliases(target.id)
    // 組名改成了、後面叫法那一步才失敗：底下每份的商品名已經換了，照樣要重新學
    void relearnSourcesAfterGroupChange(relearnIds)
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
    ? `要刪除「${target.name}」這一組嗎？\n底下的 ${count} 份資料會移到「未分類」，不會被刪除。`
    : `要刪除「${target.name}」這一組嗎？（底下沒有資料）`
  try {
    await ElMessageBox.confirm(msg, '刪除分組', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  folderDeleting.value = true
  try {
    const res = await apiFetch<{ relearnSourceIds?: string[] }>(`/api/ai/folders/${target.id}`, { method: 'DELETE' })
    folders.value = folders.value.filter(f => f.id !== target.id)
    // 把底下的 source 顯示在「未分類」
    for (const s of sources.value) {
      if (s.folderId === target.id) s.folderId = null
    }
    showToast(count ? `已刪除分組，${count} 份資料移到了未分類` : '已刪除分組', 'success')
    folderEditOpen.value = false
    // `D-127`：未分類＝不是講單一商品，伺服器把它們的商品名清掉了——一份份重新學，AI 才不會繼續當成那一台
    void relearnSourcesAfterGroupChange(res?.relearnSourceIds ?? [])
  }
  catch (err: any) {
    showToast(apiErrorText(err, '刪除失敗'), 'error')
  }
  finally {
    folderDeleting.value = false
  }
}

/**
 * 同步設定那幾格的值。⛔ 選資料的那一刻就要填（`C-309`）：以前等明細回來才填，這一兩秒裡試算表的
 * 同步頻率先顯示「不自動同步（只手動）」（上一份的值或預設的 0）、再跳成「每小時」——看起來像設定被改掉了。
 * 清單上那一份的摘要就有這三格（跟明細同一支 docToSourceSummary），先用它，明細回來再蓋一次。
 * ⚠️ 他已經改了還沒存（dirty）就不蓋：輪詢重讀明細時會把正在改的值洗掉
 */
function seedSettingsForm(src: Pick<SourceSummary, 'refreshIntervalMinutes' | 'onChangeBehavior' | 'urlAutoApply'>, force = false) {
  if (!force && settingsDirty.value) return
  settingsForm.value = {
    refreshIntervalMinutes: src.refreshIntervalMinutes,
    onChangeBehavior: src.onChangeBehavior,
    urlAutoApply: src.urlAutoApply !== false,
  }
  settingsBaseline.value = { ...settingsForm.value }
}

async function selectSource(src: SourceSummary) {
  selectedId.value = src.id
  seedSettingsForm(src, true) // 換一份＝上一份沒存的改動不帶過來
  indexPollStartedAt = 0 // 換資料重新起算輪詢時限
  // 先清空再載入:否則標頭已換、知識列表還是上一份資料的(快速切換會張冠李戴)
  chunks.value = []
  // 篩選不跟著換資料的話:上一份選「AI 沒學起來」,換到一份全部正常的,
  // 那個分類不存在 → 按鈕消失、清單空白,看起來像這份資料沒有知識。「在這份裡找」打的字同理（`C-316`）
  clearChunkNarrowing()
  detailLoading.value = true
  try {
    await loadSourceDetail(src.id)
  }
  finally {
    // 只有「仍然選著這份資料」才收 spinner:A 的 finally 不該關掉 B 正在跑的 loading
    if (selectedId.value === src.id) detailLoading.value = false
  }
  if (selectedId.value === src.id) {
    // 內容在沒開著的時候換過（見 refreshSummaryAfterContentChange）：這一次打開要重寫
    const stale = summaryStale.delete(src.id)
    void maybeGenerateSummary(src.id, stale)
  }
}

/** 篩選鈕回「全部」、「在這份裡找」清空：換一份、或要捲到某一條時（那一條可能正被篩掉） */
function clearChunkNarrowing() {
  chunkFilter.value = 'all'
  chunkQuery.value = ''
}

// ── 這份在講什麼（`C-316`）───────────────────────────────────────
/** 最多三行；空的＝還沒有（或正在寫） */
const summaryLines = computed(() =>
  (selectedSource.value?.summary ?? []).map(s => String(s ?? '').trim()).filter(Boolean).slice(0, 3))
/** 正在請伺服器寫摘要的那一份（骨架只畫在那一份上） */
const summaryLoadingId = ref('')
/** 這次打開頁面已經請伺服器寫過的：每份最多一次（⛔ 寫不出來的不要每點一次就再付一次 AI 的錢） */
const summaryTried = new Set<string>()

/**
 * 還沒有摘要的那一份，打開時請伺服器寫一次（PUT generateSummary）。
 * 不請的：存不了的人（同一支 PUT 是 sources.write，觀察者會 403）、還在整理／壞掉的、
 * 一段文字（manual）與只有一條的（摘要就是那一條再講一次）。
 * force＝內容剛換過（上傳新版、立即更新）：伺服器不會自己重寫，存著的是舊內容的摘要——要明講重寫。
 * 寫不出來（summaryFailed、或出錯）＝整塊不出現，不講失敗：這一塊是幫他看得快，不是他要處理的事
 */
async function maybeGenerateSummary(sourceId: string, force = false) {
  const src = sources.value.find(s => s.id === sourceId)
  if (!src || !canEditSources.value || summaryTried.has(sourceId)) return
  if (src.type === 'manual' || src.status !== 'ready' || src.chunkCount < 2) return
  if (!force && (src.summary ?? []).some(s => String(s ?? '').trim())) return
  summaryTried.add(sourceId)
  summaryLoadingId.value = sourceId
  // 重寫的那一下先把舊的收掉（骨架代替）：舊內容的摘要多掛一秒都是在講錯的東西
  if (force) src.summary = []
  try {
    const res = await apiFetch<{ summary?: string[], summaryAt?: number, summaryFailed?: boolean }>(`/api/ai/sources/${sourceId}`, {
      method: 'PUT',
      body: force ? { generateSummary: true, force: true } : { generateSummary: true },
    })
    const lines = Array.isArray(res?.summary) ? res.summary : []
    const row = sources.value.find(s => s.id === sourceId)
    if (res?.summaryFailed) summaryFailedOnce(sourceId, force)
    else if (row) {
      row.summary = lines
      row.summaryAt = Number(res?.summaryAt ?? 0)
    }
  }
  catch { summaryFailedOnce(sourceId, force) /* 寫不出來就不擺（見上） */ }
  finally {
    if (summaryLoadingId.value === sourceId) summaryLoadingId.value = ''
  }
}
/**
 * 寫不出來：這一次就不擺（⛔ 重寫失敗也不退回舊內容的那份——那是在講換掉之前的東西）；
 * 從「已試過」拿掉，下次打開這一份再試一次（重寫失敗的那種，下次照樣帶 force）
 */
function summaryFailedOnce(sourceId: string, force: boolean) {
  summaryTried.delete(sourceId)
  if (force) summaryStale.add(sourceId)
}

/**
 * 內容換過了（上傳新版、立即更新套用、試算表更新到東西）：伺服器不會自己重寫摘要（存著的是舊內容的），
 * 開著的是這一份就馬上請它重寫（force）；不是開著的這一份，下次打開時再寫（從「已試過」名單拿掉、標成要重寫）
 */
const summaryStale = new Set<string>()
function refreshSummaryAfterContentChange(sourceId: string) {
  summaryTried.delete(sourceId)
  if (selectedId.value === sourceId) {
    summaryStale.delete(sourceId)
    void maybeGenerateSummary(sourceId, true)
  }
  else summaryStale.add(sourceId)
}

async function loadSourceDetail(sourceId: string) {
  try {
    const res = await apiFetch<{ source: SourceSummary; chunks: ChunkRow[] }>(`/api/ai/sources/${sourceId}`)
    // 過期回應防護:等待期間使用者已切到別的資料 → 這份回應作廢。
    // 沒有這行的話,慢的舊請求晚到會把 A 的知識/同步設定蓋進 B 的畫面(張冠李戴),
    // 此時按「儲存設定」還會把 A 的同步間隔寫進 B。
    if (selectedId.value !== sourceId) return
    // 用最新的 source 覆寫 list 裡的同一筆，保證 detail 不過時（沒帶摘要那一格的話留著手上那一份，同 loadSources）
    const idx = sources.value.findIndex(s => s.id === sourceId)
    if (idx >= 0) {
      const prevSummary = sources.value[idx]!.summary
      sources.value[idx] = res.source.summary === undefined && prevSummary ? { ...res.source, summary: prevSummary } : res.source
    }
    chunks.value = res.chunks
    // 編輯視窗開著時同步該卡最新索引狀態（輪詢刷新列表,視窗裡的「處理中」也要跟著變）
    if (chunkEditOpen.value && chunkEditingId.value) {
      const row = res.chunks.find(c => c.id === chunkEditingId.value)
      if (row) {
        chunkEditStatus.value = row.status
        chunkEditFailureReason.value = row.failureReason ?? ''
        chunkEditLockedAtMs.value = row.manuallyEditedAtMs || 0
      }
    }
    seedSettingsForm(res.source)
    urlForm.value = res.source.url ?? ''
    // 抓取失敗的 Sheet:把要分享的帳號先撈好，商家一眼就看到要加誰（不必再去開匯入視窗找）
    if (res.source.failureReason && res.source.type === 'gsheet') void loadServiceAccountEmail()
  }
  catch (err: any) {
    showToast(apiErrorText(err, '載入細節失敗'), 'error')
  }
}

// ── 移到哪一組（`D-127` 分組就是商品；取代 `C-320` 的「⋯ → AI 認的商品名」）─────────────────
/** 「不放分組」那個選項的值（el-select 收不了 null） */
const MOVE_NONE = '__none__'
const moveDialogOpen = ref(false)
const moveTarget = ref('')
const moveFrom = ref('')
const movingToFolder = ref(false)
const generalFolders = computed(() => folders.value.filter(f => f.general))
const productFolders = computed(() => folders.value.filter(f => !f.general))
const moveTargetChanged = computed(() => !!moveTarget.value && moveTarget.value !== moveFrom.value)
/** 選了之後 AI 會怎麼看這一份——換組真正的後果，選之前就講（規則同 shared productNameForGroup） */
const moveHint = computed(() => {
  const s = selectedSource.value
  if (!s || !moveTarget.value) return ''
  const f = folders.value.find(x => x.id === moveTarget.value)
  if (!f || f.general) return 'AI 不會把這份當成任何一台的資料。'
  if (s.type === 'gsheet' || s.generateOverview === true) return '試算表、型錄一份常講好幾台，放在哪一組都不會整份當成那一台。'
  return `AI 會把這份當成「${f.name}」的資料。`
})

/** 右上「⋯」 */
function onSourceMoreCommand(cmd: string) {
  if (cmd === 'delete') void deleteSource()
  else if (cmd === 'move') openMoveDialog()
  else if (cmd === 'relearn') void relearnSelectedSource()
}
/** 每次打開都從這一份現在放的那一組開始 */
function openMoveDialog() {
  const s = selectedSource.value
  if (!s || !canEditSources.value) return
  moveFrom.value = s.folderId ?? MOVE_NONE
  moveTarget.value = moveFrom.value
  moveDialogOpen.value = true
}
async function confirmMove() {
  const s = selectedSource.value
  if (!s || !moveTargetChanged.value) return
  movingToFolder.value = true
  try {
    if (await moveSourceToFolder(s.id, moveTarget.value === MOVE_NONE ? null : moveTarget.value, { announce: true })) {
      moveDialogOpen.value = false
    }
  }
  finally {
    movingToFolder.value = false
  }
}

/**
 * 重新學習這一份（右上「⋯」）：換組、改組名之後重新學習沒成時的補救（網路斷、AI 服務忙）。
 * 冪等，可以一直按；停用的不偷偷打開（伺服器那支跳過停用的）
 */
const relearningSource = ref(false)
async function relearnSelectedSource() {
  const id = selectedId.value
  if (!id || relearningSource.value) return
  relearningSource.value = true
  try {
    const res = await apiFetch<{ indexed: number; failed: number }>(`/api/ai/sources/${id}/reindex`, { method: 'POST' })
    showToast(res.failed > 0
      ? `學會 ${res.indexed} 條、${res.failed} 條還沒學會，可以再按一次`
      : `AI 重新學會了這一份的 ${res.indexed} 條`, res.failed > 0 ? 'warning' : 'success')
    if (selectedId.value === id) await loadSourceDetail(id)
    void loadHealth(true)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '重新學習沒有完成') + (isRetryableError(err) ? '，可以再試一次' : ''), 'error')
  }
  finally {
    relearningSource.value = false
  }
}

/**
 * 改組名、改成／取消通用、刪分組之後（`D-127`）：底下商品名換掉的那幾份，一份份重新學（一個請求學不完一整組）。
 * 不等它：視窗先關，左邊那幾列標「搬移中」、學完講一句。中途離開頁面的話沒學到的那幾份 AI 暫時還用舊名字——
 * 改組名時舊名字收成了別名，照樣認得是這一台；資料上留了「還沒重新學」的記號，「要處理的事」會列出來一鍵補學（relearnPending）
 */
const relearningPending = ref(false)
async function relearnSourcesAfterGroupChange(ids: string[]) {
  if (!ids.length) return
  movingSourceIds.value = new Set([...movingSourceIds.value, ...ids])
  let failed = 0
  for (const id of ids) {
    try {
      const r = await apiFetch<{ failed: number }>(`/api/ai/sources/${id}/reindex`, { method: 'POST' })
      if (r.failed > 0) failed++
    }
    catch {
      failed++
    }
    const next = new Set(movingSourceIds.value)
    next.delete(id)
    movingSourceIds.value = next
  }
  showToast(failed
    ? `AI 重新學好了 ${ids.length - failed} 份，${failed} 份沒學成，可以從「要處理的事」再按一次`
    : `AI 重新學好了 ${ids.length} 份資料`, failed ? 'warning' : 'success')
  await loadSources(true)
  if (selectedId.value && ids.includes(selectedId.value)) await loadSourceDetail(selectedId.value)
  void loadHealth(true)
}

// ── 抓取失敗:就地修 ──────────────────────────────────
// 兩種最常見原因,修的地方各自不同(一個在 Google 那邊、一個是網址換了),
// 所以要把「該做什麼」和「做的工具」放在失敗訊息旁邊,而不是只印後端原文。
/**
 * 試算表一次少太多列、排程怕誤刪先停下來（`C-308`⑤）：幾列。0＝不是這種情況。
 * 新伺服器直接給數字；舊的只有那句原因（cron-maintenance 寫的「表格一次少了 N 列…」），從那句讀
 */
function massDeleteRows(s: SourceSummary | null): number {
  if (!s || s.type !== 'gsheet') return 0
  if ((s.blockedPendingDeletes ?? 0) > 0) return s.blockedPendingDeletes!
  const m = String(s.failureReason ?? '').match(/^表格一次少了\s*(\d+)\s*列/)
  return m ? Number(m[1]) : 0
}

const failureAdvice = computed(() => {
  const s = selectedSource.value
  if (!s?.failureReason) return { kind: 'other' as const, what: '', rows: 0 }
  const rows = massDeleteRows(s)
  if (rows > 0) {
    // ⛔ 不叫人去分享（以前照「類型是試算表」一律教分享）：表讀得到，是系統等他確認——去 Google 改分享沒有用
    return {
      kind: 'massDelete' as const,
      what: '為了避免誤刪，系統先不動對應的知識。是你刪的就按上方「立即更新」確認；不是的話，到試算表把那幾列補回去。',
      rows,
    }
  }
  if (s.type === 'gsheet') {
    return {
      kind: 'gsheet' as const,
      what: '最常見的原因是這份 Google 試算表沒有分享給下面這個帳號。到試算表按「共用」，把這個帳號加為「檢視者」，再回來按上方「立即更新」。',
      rows: 0,
    }
  }
  if (s.type === 'url') {
    return {
      kind: 'url' as const,
      what: '原本的網頁可能被移走或改網址了。確認新網址後貼在下面換掉，換好會自動重新抓一次；網頁只是暫時掛掉的話，按上方「立即更新」再試即可。',
      rows: 0,
    }
  }
  // ⛔ 不教「重新匯入一次」（`C-309`）：同一個位置就有「上傳新版」，重新匯入會多一份
  return {
    kind: 'other' as const,
    what: s.type === 'file' ? '檔案不會自動更新。內容有問題的話，按上方「上傳新版」放一份新的。' : '這一段文字不會自動更新。內容有問題的話，點下面那一條直接改。',
    rows: 0,
  }
})

// ── 試算表：什麼時候補、在後台刪掉的列（`C-308`④、`D-125`②）──────────
/** 「空出空間後什麼時候補上」那半句：照這一份實際的同步頻率講，⛔ 不寫死「每小時」 */
const gsheetRefillWhen = computed(() => (gsheetAutoSync.value
  ? `下一次自動更新（${optionLabel(GSHEET_INTERVAL_OPTIONS, selectedSource.value?.refreshIntervalMinutes ?? 0)}一次，或按「立即更新」）會補上`
  : '按「立即更新」就會補上（這一份設成不自動更新）'))

const excludedTitles = computed(() => (selectedSource.value?.type === 'gsheet' ? selectedSource.value.gsheetExcludedTitles ?? [] : []))
/** 列出來的那幾列：太多就列前 3 個、其餘講「等 N 列」——那一行只是讓他認得是哪幾列，不是清單 */
const excludedPreview = computed(() => {
  const list = excludedTitles.value
  const shown = list.slice(0, 3).map(t => `「${t.length > 20 ? `${t.slice(0, 20)}…` : t}」`).join('、')
  return list.length > 3 ? `${shown} 等 ${list.length} 列` : shown
})
const clearingExcluded = ref(false)
/** 「重新收這幾列」：清掉名單，之後同步把那幾列收回來（伺服器順手清掉內容指紋，表格沒變也會整份重比） */
async function clearExcludedRows() {
  const id = selectedId.value
  if (!id) return
  clearingExcluded.value = true
  try {
    await apiFetch(`/api/ai/sources/${id}`, { method: 'PUT', body: { clearExcludedRows: true } })
    showToast(gsheetAutoSync.value ? '好了：下一次自動更新會把這幾列收回來（想馬上收就按「立即更新」）' : '好了：按「立即更新」就會把這幾列收回來', 'success')
    await loadSourceDetail(id)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '沒有改成，請再試一次'), 'error')
  }
  finally {
    clearingExcluded.value = false
  }
}

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
    showToast(apiErrorText(err, '更新網址失敗'), 'error')
  }
  finally {
    savingUrl.value = false
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

/** 「自動更新：」那一格的選項：網址、試算表各一份（試算表多一個「每 30 分鐘」） */
const intervalOptions = computed(() => (selectedSource.value?.type === 'gsheet' ? GSHEET_INTERVAL_OPTIONS : URL_INTERVAL_OPTIONS))

/** 改了頻率之後那一句：改成什麼；關掉的話講要更新時按哪一顆（跟右上那顆同名，`C-319` 兩種都叫「立即更新」） */
function intervalSavedToast(minutes: number, t: string | undefined): string {
  if (minutes > 0) return `已改成${optionLabel(t === 'gsheet' ? GSHEET_INTERVAL_OPTIONS : URL_INTERVAL_OPTIONS, minutes)}自動更新`
  return '已關掉自動更新：要更新時按右上「立即更新」'
}

/**
 * 「自動更新：」選了就存（`C-314`：以前選完還要找下面那顆「儲存設定」，沒按就等於沒改）。
 * 只送這一格（後端那支每一格都可以單獨送）；存不了就退回原本的值、講伺服器給的原因。
 * ⚠️ 存的途中他換到別份資料：那一份的設定已經由 selectSource 重填，⛔ 不可以把舊值退回到新的那一份上
 */
async function saveInterval() {
  const id = selectedId.value
  if (!id) return
  const next = settingsForm.value.refreshIntervalMinutes
  const prev = settingsBaseline.value.refreshIntervalMinutes
  if (next === prev) return
  const type = selectedSource.value?.type
  savingInterval.value = true
  try {
    await apiFetch(`/api/ai/sources/${id}`, { method: 'PUT', body: { refreshIntervalMinutes: next } })
    if (selectedId.value === id) settingsBaseline.value = { ...settingsBaseline.value, refreshIntervalMinutes: next }
    showToast(intervalSavedToast(next, type), 'success')
    if (selectedId.value === id) await loadSourceDetail(id)
  }
  catch (err: any) {
    if (selectedId.value === id) settingsForm.value.refreshIntervalMinutes = prev
    showToast(apiErrorText(err, '沒有改成，請再試一次'), 'error')
  }
  finally {
    savingInterval.value = false
  }
}

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
    showToast(apiErrorText(err, '儲存失敗'), 'error')
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
    showToast(apiErrorText(err, '刪除失敗'), 'error')
  }
  finally {
    deleting.value = false
  }
}

// ── 重新同步(背景作業版)────────────────────────────
// 舊版一個請求做完「重抓+LLM 重切+比對」,大頁面 30 秒必撞閘道逾時,使用者只看到
// 「取得差異失敗」。改走匯入同一套背景狀態機:建 job → 輪詢進度 → 永不逾時,可取消。
const { progress: resyncProgress, poll: pollResyncJob, cancel: cancelResync, reset: resetResyncPoll } = usePreviewJobPoll()
/** 這次重新同步的工作編號：逾時／取消時要通知伺服器停掉它（見 startResync 的 catch） */
const resyncJobId = ref('')

const resyncButtonLabel = computed(() => {
  if (!resyncing.value) return '立即更新'
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

const foldedNoteParts = computed(() => {
  const parts: string[] = []
  if (hiddenUnchangedCount.value) parts.push(`${hiddenUnchangedCount.value} 條未變`)
  if (stillOnPageCount.value) parts.push(`${stillOnPageCount.value} 條「移除」其實還在網頁上(這次 AI 換了分法，已自動保留)`)
  if (cosmeticCount.value) parts.push(`${cosmeticCount.value} 條只是換句話說(意思沒變，已自動保留原本的)`)
  return parts
})

/**
 * 套用前的知識空間（`C-308`⑪）：差異打開時讀一次；null＝不限或讀不到——那就不講（不猜）。
 * 伺服器套用時放不下的新增會先不加、回 quotaSkipped（跟加入視窗「先收前 N 條」同一把尺），這裡讓他按之前就知道。
 */
const diffQuota = ref<{ used: number, limit: number | null } | null>(null)
async function loadDiffQuota() {
  diffQuota.value = null
  try {
    diffQuota.value = (await apiFetch<{ quota: { used: number, limit: number | null } | null }>('/api/ai/knowledge/quota')).quota
  }
  catch {
    diffQuota.value = null
  }
}
/**
 * 這次勾了幾條新增、空間放不放得下。刪掉的會進回收桶、空出位置（跟伺服器同一把尺）——
 * ⛔ 「等你看過」的不算：草稿本來就沒佔空間，刪了也空不出來。明細只在差異屬於正開著的那一份時看得到狀態
 */
const diffRoom = computed(() => {
  const q = diffQuota.value
  const d = diffData.value
  if (!q || q.limit == null || !d) return null
  const statusOf = selectedId.value === d.sourceId ? new Map(chunks.value.map(c => [c.id, c.status])) : new Map<string, string>()
  let adds = 0
  let freed = 0
  for (const e of d.diff.entries) {
    const action = decisions.value[e.id]
    if (action === 'add_new' && e.newChunk) adds++
    else if (action === 'delete_old' && e.oldChunk && statusOf.get(e.oldChunk.id) !== 'draft') freed++
  }
  if (!adds) return null
  const room = Math.max(0, q.limit - q.used + freed)
  return { adds, room, over: Math.max(0, adds - room) }
})

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
    resyncJobId.value = created.jobId
    const res = await pollResyncJob<ResyncDoneResponse>(created.jobId)
    if (!res.resync?.diff) throw new Error('比對結果不完整,請再試一次')
    const shrink = res.resync.shrink ?? null
    diffData.value = {
      sourceId: sid,
      sourceName: res.sourceName,
      sourceUrl: res.sourceUrl,
      contentHash: res.resync.contentHash,
      applyId: crypto.randomUUID(),
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
    void loadDiffQuota() // 背景讀；讀到之前那一行不出現
    diffOpen.value = true
  }
  catch (err: any) {
    // 錯誤三要素:發生什麼 / 資料有沒有被動到 / 下一步。比對是唯讀的,可以誠實保證沒動到。
    if (err?.message === PREVIEW_JOB_CANCELLED) {
      showToast('已取消更新；你的知識沒有被改動', 'success')
    }
    /**
     * ⚠️ 逾時要單獨講（2026-09-03 code review 抓到）：重新同步的產物（新舊比對）
     * **只活在這個前端流程裡**——排程即使把工作做完，也沒有任何人會收那份結果。
     * 所以這一端不能沿用單筆匯入那句「還在背景整理、好了會告訴你」（共用的 composable
     * 已改成只講「畫面不等了」，下一步由各呼叫端自己補）；而且要主動把工作停掉，
     * 否則排程會付完整的 AI 費用做完再丟掉。
     */
    else if (err?.code === PREVIEW_JOB_DEADLINE) {
      if (resyncJobId.value) {
        apiFetch(`/api/ai/knowledge/preview-jobs/${resyncJobId.value}`, { method: 'DELETE' }).catch(() => {})
      }
      // 「貼上文字」不是畫面上任何東西的名字（加入視窗只有一個框，2026-10-12 文字審視）
      showToast('這個網頁整理太久，這次先停了；你的知識沒有被改動。可以再按一次「立即更新」，或把內容複製下來，在「加入知識」直接貼進框裡。', 'warning')
    }
    else {
      const reason = apiErrorText(err, '重新整理沒有完成')
      // 伺服器看過、拒絕了的（4xx：沒有權限、那一份不在了）再按一次也一樣，⛔ 不叫人「再試一次」（`C-308`⑩）
      showToast(isRetryableError(err)
        ? `${reason}。你的知識沒有被改動，可以再試一次；一直失敗的話，請把網頁內容複製下來，在「加入知識」直接貼進框裡，或聯絡我們。`
        : `${reason}。你的知識沒有被改動。`, 'error')
    }
  }
  finally {
    resyncing.value = false
  }
}

interface GsheetSyncRes {
  /** source_deleted：同步途中這份資料被刪掉了（`C-308`③，伺服器寫每一條前會先確認那份還在） */
  outcome: 'unchanged' | 'synced' | 'blocked_mass_deletion' | 'source_deleted'
  added: number
  updated: number
  deleted: number
  kept: number
  pendingDeletes?: number
  manualKept?: number
  /** 知識空間滿了沒新增的列數（`C-296`） */
  quotaSkipped?: number
}

async function syncGsheetNow() {
  if (!selectedId.value) return
  gsheetSyncing.value = true
  try {
    let res = await apiFetch<GsheetSyncRes>(
      `/api/ai/sources/${selectedId.value}/gsheet-sync`,
      { method: 'POST', body: {} },
    )
    // 大量刪除被後端擋下（什麼都還沒動）：把數字攤給使用者確認，同意才帶旗標放行。
    // 誤刪整批列 / 分頁讀取異常時，這一步就是最後一道門。
    if (res.outcome === 'blocked_mass_deletion') {
      try {
        await ElMessageBox.confirm(
          `表格比上次更新時少了 ${res.pendingDeletes ?? 0} 列，對應的知識會移到回收桶（30 天內可還原）。\n\n如果不是你刪的，請先到試算表確認分頁與內容是否正常，不要繼續。`,
          '一次要刪很多條，先確認一下',
          { confirmButtonText: '我確認要刪', cancelButtonText: '先不要', type: 'warning' },
        )
      }
      catch {
        showToast('已取消；這次沒有做任何變更', 'success')
        return
      }
      res = await apiFetch<GsheetSyncRes>(
        `/api/ai/sources/${selectedId.value}/gsheet-sync`,
        { method: 'POST', body: { allowMassDeletion: true } },
      )
    }
    // 更新途中這份資料被刪掉了（`C-308`③）：⛔ 不講「更新完成：新增…」——那些都沒留下來。講一句、清單重讀、回工作台
    if (res.outcome === 'source_deleted') {
      showToast('這份資料在更新途中被刪掉了，這次沒有留下任何東西', 'warning')
      backToWorkbench()
      await loadSources(true)
      return
    }
    const sid = selectedId.value!
    await loadSourceDetail(sid)
    // 同步成功也可能剛清掉失敗標記 → 一定要 force 重跑體檢。
    // 只重載明細的話,體檢有 60 秒快取,商家修好了畫面仍紅著,只能自己 F5。
    await loadSources(true)
    if (res.outcome === 'synced' && (res.added || res.updated || res.deleted)) refreshSummaryAfterContentChange(sid)
    // 空間滿了沒收的列一定要講（`C-296`）：不講的話，表格加了一列、按了更新卻什麼都沒發生。
    // 什麼時候補照自動更新的頻率講（`C-308`④）：設成不自動更新的不會「自動」補
    const quotaTail = res.quotaSkipped
      ? `；還有 ${res.quotaSkipped} 列因為知識空間用滿了沒收進來（空出空間後${gsheetAutoSync.value ? '，下一次自動更新會補上' : '再按一次「立即更新」就會補上'}）`
      : ''
    if (res.outcome === 'unchanged') {
      showToast(quotaTail ? `表格沒有變動${quotaTail}` : '已是最新，無變動', quotaTail ? 'warning' : 'success')
    }
    else if (res.manualKept || quotaTail) {
      // 被手動編輯鎖住的分歧要講出來——不講的話，商家改了表格卻永遠不生效、也不知道為什麼
      showToast(
        `更新完成：新增 ${res.added}、修改 ${res.updated}、刪除 ${res.deleted}`
        + (res.manualKept ? `；另有 ${res.manualKept} 條是你改過的，沒跟著表格更新（點那一條旁邊的鎖頭可以改回）` : '')
        + quotaTail,
        'warning',
      )
    }
    else {
      showToast(`更新完成：新增 ${res.added}、修改 ${res.updated}、刪除 ${res.deleted}`, 'success')
    }
  }
  catch (err: any) {
    // 中文原因在 data.statusMessage（err.statusMessage 是 HTTP 狀態那一行，HTTP/2 下是空的）
    showToast(apiErrorText(err, '更新沒有完成'), 'error')
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
  // C-44:「保留了與網頁不同的內容」要先講清楚——這些差異這次會被捨棄套用,
  // 但之後重新同步仍會再列出(後端因此不推進「已同步到哪一版」的指紋)。
  const divergentKeeps = diffData.value.diff.entries.filter((e) => {
    const a = decisions.value[e.id]
    // ⛔ 措辭差異保留原卡不算（`C-146`，與後端 countDivergentKeeps 同一把尺）：
    //    畫面剛跟人說「已自動保留原卡、不需要做決定」，套用時再跳一個
    //    「你保留了 N 項與網頁不同的內容」等於自打嘴巴——而他根本沒做過任何決定。
    if ((e.cosmetic || e.stillOnPage) && (a === 'keep_old' || a === 'skip' || a === undefined)) return false
    return (e.kind === 'modified' && (a === 'keep_old' || a === 'skip'))
      || (e.kind === 'removed' && a === 'keep_old')
      || (e.kind === 'new' && a === 'skip')
  }).length
  if (divergentKeeps > 0) {
    try {
      await ElMessageBox.confirm(
        `你保留了 ${divergentKeeps} 項與網頁不同的內容（那幾條維持舊版）。網頁的新內容這次不會套用；之後按「立即更新」時，這些差異仍會再列出來。`,
        '有保留與網頁不同的內容',
        { confirmButtonText: '照我的選擇套用', cancelButtonText: '回去再看看', type: 'warning' },
      )
    }
    catch {
      return
    }
  }
  applying.value = true
  try {
    const res = await apiFetch<{ added: number; updated: number; deleted: number; kept: number; errors: any[]; divergentKeeps?: number; fingerprintAdvanced?: boolean; quotaSkipped?: number }>(
      `/api/ai/sources/${targetId}/resync-apply`,
      {
        method: 'POST',
        body: {
          entries: diffData.value.diff.entries,
          decisions: decisions.value,
          contentHash: diffData.value.contentHash ?? '',
          applyId: diffData.value.applyId,
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
        `已套用:新增 ${res.added}、更新 ${res.updated}、刪除 ${res.deleted};但 ${res.errors.length} 條失敗:${names}${res.errors.length > 3 ? ' 等' : ''}。可以直接再按一次「套用」重試,不會重複建立`,
        'warning',
      )
      console.warn('[resync-apply] errors:', res.errors)
      // 部分失敗:diff 留在畫面上讓人直接重按(同一個 applyId,冪等)
      return
    }
    // 空間不夠、先沒加的新增（`C-308`⑪）：伺服器收到滿為止，沒收的那幾條一定要講——不講就是「沉默地少收」
    const skipped = Number(res.quotaSkipped ?? 0)
    if (skipped > 0) {
      showToast(`已套用：新增 ${res.added}、更新 ${res.updated}、刪除 ${res.deleted}；還有 ${skipped} 條新增因為知識空間滿了沒加（空出空間後再按一次「立即更新」就會補上）`, 'warning')
    }
    else {
      showToast(`已套用：新增 ${res.added}、更新 ${res.updated}、刪除 ${res.deleted}、保留 ${res.kept}`, 'success')
    }
    diffOpen.value = false
    diffData.value = null
    await loadSources(true)
    // 重載「被套用的那份資料」;使用者若已切到別的資料,那邊的畫面不受影響
    if (selectedId.value === targetId) await loadSourceDetail(targetId)
    if (res.added || res.updated || res.deleted) refreshSummaryAfterContentChange(targetId)
  }
  catch (err: any) {
    // 逾時/斷線:後端很可能已經做完(或做到一半)。diff 與 applyId 都還在,
    // 直接再按一次是安全的(新增用決定性 id 覆寫,不會重複建立)。
    // ⛔ 伺服器看過、拒絕了的（4xx：沒有權限、那一份不在了）不叫人再按（`C-308`⑩：以前每次都是同一個錯）
    showToast(isRetryableError(err)
      ? `${apiErrorText(err, '套用沒有完成')}；可以直接再按一次「套用」，不會重複建立`
      : apiErrorText(err, '套用失敗'), 'error')
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
    showToast(`重新學習完成:${indexed} 條成功${failed ? `、${failed} 條失敗(可在知識上個別重試)` : ''}`, failed ? 'warning' : 'success')
    if (selectedId.value) await loadSourceDetail(selectedId.value)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '重新學習沒有完成') + (isRetryableError(err) ? '，可以再試一次' : ''), 'error')
  }
  finally {
    reindexingAll.value = false
  }
}

// ── 匯入彈窗(原獨立頁面已整併) ──────────────────────
const importOpen = ref(false)
/**
 * 匯入視窗關著時,側欄要看得到「還在整理／整理好了」。
 * 匯入的等待畫面請使用者去做別的事,這裡就是他回來時的入口。
 */
const importJobState = ref<'running' | 'batch' | 'ready' | 'added' | 'none'>('none')
const importJobDone = computed(() => importJobState.value === 'ready' || importJobState.value === 'added')
/** `?import=1&url=…` 帶進來的網址：開通精靈的「把網站整理成知識卡」會這樣過來（`C-221`） */
const importPrefill = ref('')
function goImport() { importOpen.value = true }

/**
 * 「上傳新版」（`D-124` 新手走查；`C-319` 以前叫「換新版」）：檔案改版以前只能回「加入知識」重傳，而且名字要一樣才會問要不要換——
 * 改了檔名就默默多一份。現在在那一份上直接換：選檔視窗在這裡開（要在點擊當下開，瀏覽器才放行），
 * 選好交給加入視窗，整理好直接換掉這一份（流程同「重新整理，換掉那一份」）。
 */
const importDialogRef = ref<{ replaceWithFile: (file: File, target: { id: string, name: string, chunkCount: number }) => void } | null>(null)
const newVersionInput = ref<HTMLInputElement | null>(null)
function pickNewVersion() {
  newVersionInput.value?.click()
}
async function onNewVersionChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  const src = selectedSource.value
  input.value = '' // 同一個檔再選一次也要觸發
  if (!file || !src) return
  importOpen.value = true
  await nextTick()
  importDialogRef.value?.replaceWithFile(file, { id: src.id, name: src.name, chunkCount: src.chunkCount })
}
/** 加入視窗「還沒整理好」那格的「手寫一條」：關掉加入視窗、打開「補一條」（`C-317`：跟其他新增入口同一個小視窗） */
function onImportManual() {
  importOpen.value = false
  openAddOne()
}

async function onImported(sourceId: string | null) {
  await loadSources(true)
  if (sourceId) {
    const src = sources.value.find(s => s.id === sourceId)
    // 上傳新版換掉的常常就是這一份：內容換了，「這份在講什麼」要重寫（`C-316`；新加的一份本來就沒有，重寫＝第一次寫）
    summaryTried.delete(sourceId)
    summaryStale.add(sourceId)
    if (src) await selectSource(src)
    return
  }
  // 視窗關著、背景自己加好的（sourceId 是 null，不搶他正在看的那一份）：右邊開著的那一份也要重讀一次。
  // ⛔ 上傳新版換掉的常常就是他開著的這一份（2026-10-13 `/code-review`）：不重讀的話右邊一直是已經移到回收桶的舊條目，
  //    他在上面改、或以為沒換成又按一次上傳新版
  const openId = selectedId.value
  if (openId && sources.value.some(s => s.id === openId)) {
    const before = chunks.value.map(c => c.id).join('\n')
    await loadSourceDetail(openId)
    // 條目換了＝背景換掉的就是這一份 → 摘要重寫；⛔ 沒換（背景加好的是別份）不重寫，不白花 AI 的錢
    if (selectedId.value === openId && chunks.value.map(c => c.id).join('\n') !== before) refreshSummaryAfterContentChange(openId)
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
    showToast(`已整理 ${res.migrated} 條舊資料為手寫知識${tail}`, 'success')
    await loadSources(true)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '整理失敗'), 'error')
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
  catch (err: any) {
    nameDraft.value = current  // 失敗還原
    showToast(apiErrorText(err, '重新命名失敗'), 'error')
  }
  finally { savingName = false }
}

// ── 編輯既有 chunk（新增一條走「補一條」小視窗，見 openAddOne）──────────────
/**
 * 這一次打開編輯框要不要在存了之後銷案（查重那一步選「改這一條」才有，見 dupEdit）。
 * ⛔ 跟著這一次打開走、每次打開都重設：放在共用的 pendingResolveQuery 的話，他按了取消、之後改別條也會被拿去銷案
 */
let chunkEditResolveQuery = ''
function openEditChunk(chunk: ChunkRow, resolveQuery = '') {
  chunkEditResolveQuery = resolveQuery
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
  chunkEditLockedAtMs.value = chunk.manuallyEditedAtMs || 0
  chunkEnabled.value = chunk.status !== 'disabled'
  chunkActiveUntil.value = chunk.activeUntilMs ? ymdLabel(chunk.activeUntilMs) : ''
  chunkExpiredAtMs.value = chunk.expiredAtMs || 0
  chunkSettingsOriginal = { enabled: chunkEnabled.value, activeUntil: chunkActiveUntil.value }
  chunkTagsOriginal = tagsKey(chunkForm.value.tags)
  // 設過期限/到期停用過 → 進階預設展開,別把生效中的設定藏起來。
  // `C-314`：有標籤不再算——標籤欄位不給看了，進階裡只剩有效期限
  chunkAdvancedOpen.value = !!chunkActiveUntil.value || chunkExpiredAtMs.value > 0
  chunkEditOpen.value = true
}

/** 標籤比對用：排好接成一串（順序不同不算改了） */
function tagsKey(tags: string[]): string {
  return [...tags].sort().join('\n')
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
    showToast(apiErrorText(err, 'AI 整理失敗'), 'error')
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
    /**
     * ⛔ 要看回應內容，不可以「沒 throw 就報成功」（`D-41` P0①，2026-09-03 修）：
     *    `/reindex` 再次失敗時回的是 HTTP 200 ＋ `{ status: 'failed' }`（那支的 catch 是
     *    return 不是 throw）。原本一律跳「已重新學習」，於是 AI 服務忙碌時按下去，
     *    畫面說學會了、卡其實還是失敗——客人問到照樣答不出來。
     */
    const res = await apiFetch<{ status?: string; failureReason?: string }>(
      `/api/ai/knowledge/${chunkEditingId.value}/reindex`,
      { method: 'POST' },
    )
    // ⚠️ 判「失敗」看 status === 'failed',不是「不等於 indexed」（2026-09-03 code review 抓到）:
    //    停用中的卡重算成功時回的是 'disabled'（刻意的,停用卡不落 failed 才不會被重試佇列復活）,
    //    用不等式判會把那種成功報成「還是沒學起來」。
    const learned = res?.status !== 'failed'
    showToast(
      learned ? '已重新學習' : `還是沒學起來：${res?.failureReason || '原因不明'}`,
      learned ? 'success' : 'error',
    )
    if (selectedId.value) await loadSourceDetail(selectedId.value)
    const updated = chunks.value.find(c => c.id === chunkEditingId.value)
    if (updated) {
      chunkEditStatus.value = updated.status
      chunkEditFailureReason.value = updated.failureReason ?? ''
    }
    /**
     * 修好一條就把體檢一起刷新（`D-41` P1⑦，2026-09-03 修）。
     * 原本只重載這一份資料，所以「有 N 條內容 AI 沒學起來」會停在舊數字＝
     * 修好了畫面還紅，使用者只能猜是不是沒修成功。
     */
    if (learned) void loadHealth(true)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '重新學習失敗'), 'error')
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
    const body: Record<string, unknown> = { title: t, content: c }
    /*
     * 標籤（`C-314`：欄位不給看了，系統自己管）：只有「AI 整理一下」換了標籤才送——⛔ 沒換就不送：後端 PUT 沒帶 tags＝不改那一格，
     * 原本的標籤一個都不會被洗掉（照送也行，但舊資料若有超過上限的標籤，照送會被擋下 400、整條存不了）
     */
    if (tagsKey(chunkForm.value.tags) !== chunkTagsOriginal) body.tags = chunkForm.value.tags
    // 只要欄位有出現在畫面上就照送（含清成空陣列）——用 length 判斷的話，
    // 使用者把夾了個資的問法全部刪掉會送不出去，等於刪不掉。
    // undefined = 這次沒有這個欄位，後端保留既有值。
    if (chunkForm.value.questions !== undefined) body.questions = chunkForm.value.questions
    if (chunkEditingId.value) {
      const put = await apiFetch<{ changed?: boolean }>(`/api/ai/knowledge/${chunkEditingId.value}`, {
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
      chunkEditOpen.value = false
      /**
       * 什麼都沒改（`C-308`①：伺服器回 changed:false＝沒寫、也沒上鎖）：安安靜靜關掉就好。
       * ⛔ 不跳「已儲存」、不試問：跳了他會以為有東西被改了——以前「打開看看、按儲存關掉」就把那一條鎖住了
       */
      if (put?.changed === false && !Object.keys(settingsBody).length) return
      showToast('已儲存', 'success')
      if (put?.changed !== false) void verifyChunkAnswerable(t, chunkForm.value.questions?.[0])
      // 從 ?q= 的查重那一步選「改這一條」進來的：真的改了才算把這題處理掉（`C-317`：以前這條路設了問句卻從來沒銷案）
      if (chunkEditResolveQuery && put?.changed !== false) void resolveHandoffsByQuery(chunkEditResolveQuery)
      chunkEditResolveQuery = ''
      if (selectedId.value) await loadSourceDetail(selectedId.value)
      await loadSources(true) // 因為 manual source 名稱可能跟著變
    }
  }
  catch (err: any) {
    showToast(apiErrorText(err, '儲存失敗'), 'error')
  }
  finally {
    chunkSaving.value = false
  }
}

async function deleteChunkFromModal() {
  if (!chunkEditingId.value) return
  const title = chunkForm.value.title || '(未命名)'
  try {
    await ElMessageBox.confirm(
      // 量詞一律「條」（`D-41` 三，2026-09-03）：原本這句是錯字「這一條片」——
      // 08-04 拍板把「卡片」全面改叫「一條知識」時，這裡改了一半。
      // ⛔ 以前寫「無法復原」（`C-309`）：實際是進回收桶 30 天，嚇人又不對。
      // 試算表來的那一條（`D-125`② 拍板 A）：刪了＝表格那一列不再收，⛔ 一定要先講——不然他以為下次同步會長回來、或以為只是暫時拿掉
      selectedSource.value?.type === 'gsheet'
        ? `要刪除「${title}」嗎？表格上的這一列之後同步不會再收；刪掉的會先放進回收桶，30 天內可以還原。`
        : `要刪除「${title}」這 1 條知識嗎？會先放進回收桶，30 天內可以還原。`,
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
    showToast(apiErrorText(err, '刪除失敗'), 'error')
  }
  finally {
    chunkDeleting.value = false
  }
}

// ─── 原檔下載（`C-296`③）───────────────────────────────
const downloadingOriginal = ref(false)
/** 跟伺服器要一個 5 分鐘有效的下載網址再開；網址帶「存成附件」，瀏覽器會直接下載不會換頁 */
async function downloadOriginal() {
  const id = selectedSource.value?.id
  if (!id) return
  downloadingOriginal.value = true
  try {
    const { url } = await apiFetch<{ url: string }>(`/api/ai/sources/${encodeURIComponent(id)}/file-url`)
    const a = document.createElement('a')
    a.href = url
    a.rel = 'noopener'
    a.click()
  }
  catch (err: any) {
    showToast(apiErrorText(err, '下載失敗') + (isRetryableError(err) ? '，請再試一次' : ''), 'error')
  }
  finally {
    downloadingOriginal.value = false
  }
}
// ─── Display helpers ───────────────────────────────────
// 叫法跟「加入知識」視窗同一套（2026-10-12 文字審視：試算表不叫 Sheet、貼進來的文字不叫手打）
function typeLabel(t: string) {
  return t === 'url' ? '網址' : t === 'file' ? '檔案' : t === 'gsheet' ? 'Google 試算表' : '一段文字'
}
function statusLabel(s: string) {
  return s === 'ready' ? '可用' : s === 'fetching' ? '抓取中' : s === 'splitting' ? '整理中' : '失敗'
}
// ⚠️ `draft`（等你看過，`C-250`③）一定要有自己的字與顏色：落到最後那個「其他」會被畫成紅色「失敗」
function chunkStatusLabel(s: string) {
  return s === 'indexed' ? '可用' : s === 'pending' ? '處理中' : s === 'disabled' ? '已停用' : s === 'draft' ? '等你看過' : '失敗'
}
function chunkStatusBadge(s: string) {
  return s === 'indexed' ? 'badge-green' : s === 'pending' ? 'badge-yellow' : s === 'disabled' ? 'badge-gray' : s === 'draft' ? 'badge-yellow' : 'badge-red'
}
/**
 * 左邊每一份資料的小章（`C-314`）：**只有不正常時才有**。以前每一列都掛一個綠色「可用」——
 * 清單上幾十個一模一樣的綠章，真正有事的那一個反而不顯眼。回 null＝不畫。
 * 先後照嚴重度：壞了 > 處理中 > 內容有變動 > 試算表有列沒收。
 * 試算表一次少太多列被擋下（`C-308`⑤）狀態也是 failed，但不是壞了、是等他確認——講「等你確認」不講「失敗」。
 */
function sourceChip(src: SourceSummary): { text: string, tone: 'warning' | 'error' | 'neutral' } | null {
  // 搬進商品分組、伺服器正在補商品名＋重新學（`C-320`，最久約 9 秒）
  if (movingSourceIds.value.has(src.id)) return { text: '搬移中', tone: 'neutral' }
  if (src.status === 'failed') return massDeleteRows(src) > 0 ? { text: '等你確認', tone: 'warning' } : { text: '失敗', tone: 'error' }
  if (src.status === 'fetching' || src.status === 'splitting') return { text: statusLabel(src.status), tone: 'neutral' }
  if (src.outdatedAtMs > 0) return { text: '有變動', tone: 'warning' }
  if (src.type === 'gsheet' && (src.quotaSkippedCount ?? 0) > 0) return { text: '有列沒收', tone: 'warning' }
  return null
}
function statusChipText(src: SourceSummary) {
  return sourceChip(src)?.text ?? ''
}
function statusChipTone(src: SourceSummary): 'success' | 'warning' | 'error' | 'neutral' {
  return sourceChip(src)?.tone ?? 'neutral'
}
/**
 * 左邊每一份底下那一行：只剩「N 條」（`C-314`）。
 * 以前還接產品名、「同步：46 分鐘前」——240px 寬的側欄裡每一列都被截成「…」，看不完也用不到。
 * 「沒設產品」改由「要處理的事」那一條講（noProductSources，跟這裡以前用的是同一個判斷）；
 * 更新時間、AI 認的商品點進那一份就看得到（名稱下面那一行；`D-127` 起商品＝它所在的那一組）。
 */
function metaText(src: SourceSummary) {
  return `${src.chunkCount} 條`
}

/**
 * 資料頁名稱下面那一行（`C-314`）：「Google 試算表・20 條・35 分鐘前更新」／「檔案・79 條・9/4 更新」。
 * 取代原本整張「基本資訊」卡（類型／狀態／條數／最後同步四格）。
 * 檔案、文字不會自己更新（`C-309`）：時間取「最後一次換內容」那一刻，⛔ 不寫「同步」讓人以為它會自己更新。
 */
const headerMeta = computed(() => {
  const s = selectedSource.value
  if (!s) return ''
  const parts = [typeLabel(s.type), `${s.chunkCount} 條`]
  const when = isSyncingType(s.type) ? relativeTime(s.lastFetchedAtMs) : relativeTime(s.lastFetchedAtMs || s.updatedAtMs)
  // 「9/4」後面空一格再接「更新」；「35 分鐘前」「剛剛」直接接
  if (when) parts.push(/\d$/.test(when) ? `${when} 更新` : `${when}更新`)
  else if (isSyncingType(s.type)) parts.push('還沒同步過')
  /*
   * 這一份被 AI 當成哪個商品（`C-320` 只給改不了的人看；`D-127` 起「⋯ → AI 認的商品名」拿掉了，大家都在這一行看）。
   * 商品名＝它所在那一組的組名；要換就換分組（「⋯ → 移到哪一組」）
   */
  if (s.type !== 'gsheet' && String(s.productName ?? '').trim()) parts.push(`AI 認的商品：${s.productName.trim()}`)
  return parts.join('・')
})
/**
 * 那一行後面的狀態：只有不正常時才接（上色）。正常（可用）不講。
 * 壞了而且有原因的不接：底下那一塊紅框（src-fix）整段就在講這件事，這裡再寫「失敗」是同一件事講兩次。
 */
const headerStatus = computed<{ text: string, tone: 'busy' | 'failed' } | null>(() => {
  const s = selectedSource.value
  if (!s) return null
  if (s.status === 'fetching' || s.status === 'splitting') return { text: statusLabel(s.status), tone: 'busy' }
  if (s.status === 'failed' && !s.failureReason) return { text: statusLabel(s.status), tone: 'failed' }
  return null
})
function kindLabel(k: string) {
  return k === 'new' ? '新增' : k === 'modified' ? '修改' : k === 'removed' ? '移除' : '未變'
}
onMounted(async () => {
  loadExpandedState()
  void loadAiEnabled() // 不 await:只影響「要處理的事」多一列,不該卡住頁面載入
  void checkIsSuperAdmin().catch(() => {}) // 「⋯ → 重新學習全部知識」只給平台超管（`C-323`）
  const route = useRoute()
  const router = useRouter()
  // deep-link query 是一次性的指令:處理完就從網址清掉,否則 F5 會再彈一次視窗
  const clearQuery = () => { router.replace({ query: {} }).catch(() => {}) }
  await loadSources()

  // 監控頁「補知識」帶 ?q=(客人沒被答到的問題):直接開新增手寫視窗、預填標題
  const q = String(route.query.q ?? '').trim()
  if (q) {
    clearQuery()
    // `G-102`：這條路的終點是建卡視窗（`knowledge/create` 客服級）；沒有 knowledge.write 的人不開
    if (!canEditKb.value) return
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
    // 只有一份／一條就直接帶過去（`C-309`：「前往比對」打開一張只有一列的清單，還要再點一次）——同 singleOrList
    healthListCategory.value = healthParam as HealthCategory
    const only = healthListItems.value
    if (only.length === 1) await gotoHealthItem(only[0]!, { move: healthParam === 'noProductSources' })
    else openHealthList(healthParam as HealthCategory)
    return
  }

  // 小幫手「去看建議」帶 ?suggest=1:捲到建議收件匣（D-43 缺口①）。
  // 原本落地停在頁頂——收件匣在「要處理的事」下方,按過「去看建議」的人還得自己捲、
  // 自己找,等於帶路帶到巷口就放人。收件匣的資料是元件自己載的,元素要等它掛出來,
  // 所以用短輪詢等目標出現;等不到（權限不足之類）就安靜作罷,不能卡住頁面。
  if (String(route.query.suggest ?? '') === '1') {
    clearQuery()
    selectedId.value = null // 收件匣只在未選取資料時渲染
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 150))
      const el = document.querySelector('.kb-suggest')
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        break
      }
    }
    return
  }

  // 「去看那幾張卡」帶 ?drafts=1（試答頁、小幫手、`C-250`③）：捲到「等你看過」那一區。
  // 同上一段的理由與做法（元件自己載資料，等它掛出來；等不到就作罷）
  if (String(route.query.drafts ?? '') === '1') {
    clearQuery()
    selectedId.value = null
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 150))
      const el = document.querySelector('.kb-drafts')
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        break
      }
    }
    return
  }

  // 舊的 /knowledge/import 網址轉進來時帶 ?import=1:直接打開匯入彈窗
  if (String(route.query.import ?? '') === '1') {
    // `G-107`：匯入的每一支端點都是客服級——觀察者帶著舊網址進來，只清掉網址、不開視窗
    if (canEditKb.value) {
      // `&url=…`＝開通精靈把商家的官網帶過來（`C-221`）；填在貼上框裡讓既有偵測接手
      importPrefill.value = String(route.query.url ?? '').trim().slice(0, 500)
      importOpen.value = true
    }
    clearQuery()
  }
})

async function openChunkById(chunkId: string, opts: { resolveQuery?: string } = {}) {
  try {
    const info = await apiFetch<{ id: string; sourceId: string | null; deleted?: boolean }>(`/api/ai/knowledge/${chunkId}`)
    /**
     * 那一條已經在回收桶（換新版換掉、或被刪了，報告第 4 組）：以前舊對話裡「去修這條」點了什麼都沒發生。
     * 講一句，還在的那一份照樣打開——他多半是要去改那一份現在的內容
     */
    if (info.deleted) {
      showToast('這條已經換掉或刪掉了（在回收桶裡）', 'warning')
      const owner = info.sourceId ? sources.value.find(s => s.id === info.sourceId) : null
      if (owner) await selectSource(owner)
      return
    }
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
    if (chunk) openEditChunk(chunk, opts.resolveQuery)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '找不到這一條(可能已被刪除)'), 'error')
  }
}

// ── 右邊「問 AI」（`C-315`）──────────────────────────────────────
/**
 * 放不放得下第三欄：看這一頁自己的寬度（主選單收起來／展開都算進去），不是整個視窗。
 * column＝常駐右邊（≥ 1200）；drawer＝右上一顆「問 AI」開抽屜（721～1199）；none＝手機（≤ 720，手機工作台另排 `E-13`）或沒有權限。
 * ⚠️ 手機那一刀跟 mobileStack 同一條線（視窗 ≤ 720，見 _split-layout.scss），不然 721 寬時清單跟內容疊著、抽屜鈕卻不見
 */
const ASK_COLUMN_MIN = 1200
const PHONE_MAX = 720
const colsRef = ref<HTMLElement | null>(null)
const colsWidth = ref(0)
const viewportWidth = ref(0)
const askMode = computed<'column' | 'drawer' | 'none'>(() => {
  if (!canAsk.value || !colsWidth.value || viewportWidth.value <= PHONE_MAX) return 'none'
  return colsWidth.value >= ASK_COLUMN_MIN ? 'column' : 'drawer'
})
const askDrawerOpen = ref(false)
/** 「用了這 N 條 · 哪一份」的資料名：手上的清單就有，傳進去面板就不用再讀一次 /api/ai/sources/list */
const askSourceNames = computed<Record<string, string>>(() => Object.fromEntries(sources.value.map(s => [s.id, s.name])))
// 寬度變了、抽屜那一種不在了（拉寬成常駐、或縮成手機）：抽屜的開著狀態要收掉，下次回到中間寬度不會自己跳出來
watch(askMode, (m) => { if (m !== 'drawer') askDrawerOpen.value = false })

let colsObserver: ResizeObserver | null = null
function measureCols() {
  colsWidth.value = Math.round(colsRef.value?.getBoundingClientRect().width ?? 0)
  viewportWidth.value = window.innerWidth
}
onMounted(() => {
  measureCols()
  if (typeof ResizeObserver !== 'undefined' && colsRef.value) {
    colsObserver = new ResizeObserver(() => measureCols())
    colsObserver.observe(colsRef.value)
  }
  window.addEventListener('resize', measureCols)
})
onBeforeUnmount(() => {
  colsObserver?.disconnect()
  colsObserver = null
  window.removeEventListener('resize', measureCols)
})

/**
 * 答案底下「用了這幾條」點了（`C-315`）：中間打開那一份、捲到那一條、亮一下（不開編輯框：他是要看 AI 用了什麼，不一定要改）。
 * 那一條不在了（換掉、刪掉）、或還在「等你看過」，照實講一句（⛔ 不要點了什麼都沒發生）。
 */
async function onAskOpenChunk(evt: { chunkId?: string, sourceId?: string | null }) {
  const chunkId = String(evt?.chunkId ?? '')
  if (!chunkId) return
  askDrawerOpen.value = false // 抽屜蓋著中間：關掉才看得到那一條
  await revealChunk(chunkId, evt?.sourceId ? String(evt.sourceId) : null)
}

async function revealChunk(chunkId: string, sourceIdHint: string | null) {
  let sourceId = sourceIdHint
  let owner = sourceId ? sources.value.find(s => s.id === sourceId) : undefined
  if (sourceId && !owner) {
    await loadSources() // 剛加進來的那一份可能還不在清單上
    owner = sources.value.find(s => s.id === sourceId)
  }
  if (!owner) {
    // 沒給是哪一份、或清單上找不到：問伺服器那一條現在在哪
    try {
      const info = await apiFetch<{ id: string, sourceId: string | null, deleted?: boolean }>(`/api/ai/knowledge/${encodeURIComponent(chunkId)}`)
      if (info.deleted) {
        showToast('這一條已經換掉或刪掉了（在回收桶裡）', 'warning')
        return
      }
      sourceId = info.sourceId
      owner = sourceId ? sources.value.find(s => s.id === sourceId) : undefined
    }
    catch (err: any) {
      showToast(apiErrorText(err, '找不到這一條，可能剛被刪掉了'), 'warning')
      return
    }
  }
  if (!owner) {
    showToast('找不到這一條所在的資料，可能剛被刪掉了', 'warning')
    return
  }
  if (selectedId.value !== owner.id) await selectSource(owner)
  clearChunkNarrowing()
  const row = chunks.value.find(c => c.id === chunkId)
  if (!row) {
    // 那一份打開了、那一條卻不在：多半是剛被換掉（上傳新版、立即更新）——問一下是不是在回收桶，講對的那一句
    const gone = await apiFetch<{ deleted?: boolean }>(`/api/ai/knowledge/${encodeURIComponent(chunkId)}`).catch(() => null)
    showToast(gone?.deleted ? '這一條已經換掉或刪掉了（在回收桶裡）' : '這一條已經不在這份資料裡了', 'warning')
    return
  }
  if (row.status === 'draft') showToast('這一條還在「等你看過」，AI 還不會用它回答', 'warning')
  await nextTick()
  void flashAgentTarget(`kb-chunk:${chunkId}`, 3000)
}
</script>
