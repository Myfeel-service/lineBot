<template>
  <el-dialog
    :model-value="modelValue"
    title="上傳 / 匯入"
    width="min(760px, 92vw)"
    :close-on-click-modal="false"
    class="kb-import-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @close="onDialogClose"
  >
    <!-- ── Step 1:一個投放區,自動判別是什麼(P1-2) ─────────── -->
    <div v-if="step === 'input'">
      <p class="kb-step-label">把資料交給 AI 整理 — 檔案、網址、Google 試算表或一段文字都可以</p>

      <!-- 拖放 + 貼上同一區:不用先決定「我該用哪一種」 -->
      <div
        class="kb-drop"
        :class="{ 'kb-drop--over': dragOver, 'kb-drop--filled': !!detected }"
        data-tour="kb-drop"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <template v-if="selectedFile">
          <div class="kb-drop__file">
            <span class="kb-drop__filename">{{ fileName }}</span>
            <span class="text-xs text-muted">{{ fileSizeKb.toLocaleString('zh-TW') }} KB</span>
            <el-button size="small" text @click="clearFile">換一個</el-button>
          </div>
        </template>
        <template v-else>
          <el-input
            v-model="pasteInput"
            type="textarea"
            :rows="4"
            :maxlength="100000"
            resize="none"
            class="kb-drop__paste"
            placeholder="貼上網址、Google 試算表連結，或直接貼一大段文字（FAQ、政策原文都可以）"
          />
          <div class="kb-drop__or">
            <span>或</span>
            <input
              ref="fileInputEl"
              type="file"
              accept=".pdf,.xlsx,.xls,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              class="kb-file-input"
              @change="onFileChosen"
            >
            <el-button size="small" plain @click="fileInputEl?.click()">選擇檔案</el-button>
            <span class="text-xs text-muted">PDF / Excel，也可以直接把檔案拖進這個框，單檔 10MB 內</span>
          </div>
        </template>
      </div>

      <!-- 判別結果:先講「這是什麼」,再講唯一真正要知道的差異(會不會自動更新) -->
      <div v-if="detected" class="kb-detected" :class="`kb-detected--${detected.syncTone}`">
        <p class="kb-detected__head">
          <span class="kb-detected__label">{{ detected.label }}</span>
          <span class="kb-detected__sync">{{ detected.sync }}</span>
        </p>
        <p class="kb-detected__hint">{{ detected.hint }}</p>

        <!-- Google 試算表要先分享才讀得到:在偵測到的當下才講,不用先讀四段說明 -->
        <div v-if="mode === 'gsheet' && serviceAccountEmail" class="kb-gsheet-share">
          <span>還有一步:請把這份試算表「共用」給下面這個帳號(檢視權限就夠),否則系統讀不到。</span>
          <div class="kb-gsheet-share__row">
            <code class="kb-gsheet-email">{{ serviceAccountEmail }}</code>
            <el-button size="small" text type="primary" @click="copyServiceEmail">複製</el-button>
          </div>
        </div>

        <!-- 整站匯入主動浮出(P1-3):不用自己想到有這功能 -->
        <p v-if="mode === 'url' && sitePeeking" class="kb-site-peek kb-site-peek--loading">
          正在看看這個網站還有哪些頁面⋯
        </p>
        <div v-else-if="mode === 'url' && sitePeekCount > 0" class="kb-site-peek">
          <span>這個網站另外還有 <strong>{{ sitePeekCount }}</strong> 頁,要一起匯入嗎?</span>
          <el-button size="small" type="primary" plain @click="step = 'sitePages'">
            看清單挑選
          </el-button>
        </div>
      </div>

      <!-- 第一次用的人給一條捷徑,不佔版面 -->
      <p v-if="!detected" class="kb-first-time">
        第一次匯入?
        <el-button
          tag="a"
          :href="faqTemplateCopyUrl || '/templates/faq-sheet-template.xlsx'"
          target="_blank"
          rel="noopener"
          size="small"
          text
          type="primary"
        >
          用官方 FAQ 範本開始
        </el-button>
        <span class="text-xs text-muted">兩欄(問題／答案)填完貼回來就好,其他問法 AI 會自動補</span>
      </p>


      <div v-if="mode !== 'gsheet'" class="kb-overview-toggle" data-tour="kb-overview">
        <el-checkbox v-model="generateOverview">
          這是商品 / 列表頁（額外產生一張「總表」）
        </el-checkbox>
        <p class="kb-section-hint">
          適用商品「列表頁」、型錄這類「列出很多項目」的頁面（<strong>不建議用首頁</strong>——商品區塊常是動態載入抓不到，總表會做錯）。
          除了把每個項目切成知識，再額外合成一張帶分類的總表，讓客人問「你們有賣什麼 / 有哪些產品」時能一次回答，不會被反問。
        </p>
      </div>

      <div class="kb-import-actions">
        <el-button
          type="primary"
          data-tour="kb-preview"
          :loading="previewing"
          :disabled="!canPreview"
          @click="runPreview"
        >
          {{ previewing ? 'AI 正在整理⋯' : '先看 AI 整理的結果' }}
        </el-button>
        <!-- 整站匯入的備援入口:上方已自動報頁數時就不重複出現(探索失敗/還沒探完才需要) -->
        <el-button
          v-if="mode === 'url' && !sitePeekCount && !sitePeeking"
          :loading="discovering"
          :disabled="!canPreview || previewing"
          @click="runDiscover"
        >
          {{ discovering ? '尋找頁面中⋯' : '找出這個網站的其他頁面' }}
        </el-button>
      </div>

      <!-- 等待要有契約:長文件可能要好幾分鐘。原本只有一行灰字,沒有取消、
           也沒說能不能關視窗——最容易讓人以為系統壞了的一段。 -->
      <div v-if="previewing" class="kb-waiting">
        <p class="kb-waiting__text">{{ previewProgressText }}</p>
        <p class="kb-waiting__note">
          內容長的話可能要幾分鐘。<strong>可以先關掉這個視窗去做別的事</strong>，回來再點一次「加入知識」就看得到結果。
        </p>
        <el-button size="small" text @click="cancelPreview">取消</el-button>
      </div>

      <!-- 逾時/失敗留在畫面上,不用 3.5 秒就消失的 toast:
           等了好幾分鐘的人只要沒盯著螢幕,回來會看到一片乾淨畫面、完全不知道發生什麼事 -->
      <el-alert
        v-if="previewError && !previewing"
        type="error"
        show-icon
        :closable="true"
        :title="previewError"
        style="margin-top: 12px"
        @close="previewError = ''"
      >
        <div>可以再試一次；內容很長的話，建議把文字分成幾段、分批貼進來。</div>
      </el-alert>
    </div>

    <!-- ── Step 1.5:整站匯入 — 頁面清單勾選 ─────────────── -->
    <div v-if="step === 'sitePages'">
      <p class="kb-step-label">選擇要匯入的頁面</p>
      <p class="kb-section-hint">
        在 <strong>{{ siteHost }}</strong> 找到 <strong>{{ sitePages.length }}</strong> 頁
        （{{ siteFrom === 'sitemap' ? '來自網站自己提供的頁面清單（sitemap）' : '來自這一頁上的連結' }}<span v-if="siteTruncated">，已達 {{ sitePages.length }} 頁上限</span>）。
        勾選的每一頁會<strong>各自成為一份資料</strong>：AI 自動整理、自動辨識產品名，完成後可到資料列表逐一檢查。
      </p>

      <!-- 整站完成後的結論列:全卡直入沒有逐頁預覽,結束一定要給「做了什麼、還要看什麼」 -->
      <el-alert
        v-if="siteFinished"
        :type="siteSummary.failed || siteSummary.warned ? 'warning' : 'success'"
        show-icon
        :closable="false"
        class="kb-site-summary"
      >
        <template #title>
          已建立 {{ siteSummary.ok }} 份資料、共 {{ siteSummary.cards }} 條知識
        </template>
        <div class="text-xs">
          <template v-if="siteSummary.failed">{{ siteSummary.failed }} 頁失敗（清單上有標原因，可重新勾選再試一次）。</template>
          <template v-if="siteSummary.warned">{{ siteSummary.warned }} 頁帶有提醒，建議進知識庫檢查這幾筆的內容。</template>
          <template v-if="!siteSummary.failed && !siteSummary.warned">這些知識沒有經過逐張預覽，建議到知識庫抽幾張看看內容是否合用。</template>
        </div>
      </el-alert>

      <!-- 路徑分組導覽:一眼看懂網站組成,點分組縮小範圍(大站挑商品頁的主要動線) -->
      <div v-if="siteGroups.length >= 2" class="kb-site-groups">
        <button
          type="button"
          class="kb-site-group-chip"
          :class="{ 'is-active': siteGroup === '' }"
          :disabled="siteImporting"
          @click="siteGroup = ''"
        >
          全部 {{ sitePages.length }} 頁
        </button>
        <button
          v-for="[g, n] in siteGroups"
          :key="g"
          type="button"
          class="kb-site-group-chip"
          :class="{ 'is-active': siteGroup === g }"
          :disabled="siteImporting"
          @click="siteGroup = siteGroup === g ? '' : g"
        >
          {{ g }} {{ n }} 頁
        </button>
      </div>

      <div class="kb-site-toolbar">
        <el-checkbox
          :model-value="allSiteChecked"
          :indeterminate="someSiteChecked"
          :disabled="siteImporting || !selectableSitePages.length"
          @change="toggleAllSite"
        >
          全選{{ siteGroup || siteFilter.trim() ? '（目前顯示的）' : '' }}
        </el-checkbox>
        <span class="text-muted text-xs">已勾選 {{ checkedSiteCount }} 頁</span>
        <span v-if="importedSiteCount" class="text-muted text-xs">
          · {{ importedSiteCount }} 頁先前已匯入（不重複匯入，需更新請到資料頁「重新同步」）
        </span>
        <!-- 上百頁清單靠捲的找不到商品頁,給一個關鍵字篩選 -->
        <el-input
          v-model="siteFilter"
          size="small"
          clearable
          placeholder="篩選網址或標題，例：product"
          class="kb-site-filter"
        />
      </div>
      <p v-if="siteFilter.trim()" class="kb-section-hint kb-site-filter-hint">
        符合「{{ siteFilter.trim() }}」的有 {{ visibleSitePages.length }} 頁（勾選狀態不受篩選影響，清空篩選可看到全部）。
      </p>
      <div class="kb-site-list">
        <div v-for="p in visibleSitePages" :key="p.url" class="kb-site-row">
          <el-checkbox v-model="p.checked" :disabled="siteImporting || p.imported || p.status === 'done'" />
          <div class="kb-site-page">
            <div class="kb-site-title">{{ p.title || pagePathLabel(p.url) }}</div>
            <div class="kb-site-url">{{ p.url }}</div>
            <div v-if="p.status === 'failed'" class="kb-site-error">✕ {{ p.error }}</div>
            <div v-if="p.warningTexts.length" class="kb-site-warnings">
              <div v-for="(w, i) in p.warningTexts" :key="i">⚠︎ {{ w }}</div>
            </div>
          </div>
          <span class="kb-site-status" :class="`is-${p.status}`" :title="p.status === 'failed' ? p.error : ''">
            <template v-if="p.status === 'processing'">整理中⋯</template>
            <template v-else-if="p.status === 'done'">✓ {{ p.cards }} 條</template>
            <template v-else-if="p.status === 'failed'">✕ 失敗</template>
            <template v-else-if="p.imported">已匯入過</template>
          </span>
        </div>
      </div>
      <div class="kb-import-actions">
        <el-button :disabled="siteImporting" @click="step = 'input'">上一步</el-button>
        <el-button
          type="primary"
          :loading="siteImporting"
          :disabled="!checkedSiteCount || siteImporting"
          @click="runSiteImport"
        >
          {{ siteImporting ? `匯入中（${siteDoneCount}/${siteBatchTotal}）⋯` : `匯入勾選的 ${checkedSiteCount} 頁` }}
        </el-button>
        <el-button v-if="siteFinished && !siteImporting" type="primary" plain @click="close">
          完成，去看知識庫
        </el-button>
      </div>
    </div>

    <!-- ── Step 2:預覽 + 編輯 ─────────────────────────── -->
    <div v-if="step === 'preview'">
      <p class="kb-step-label">AI 整理的結果</p>
      <p class="kb-section-hint">
        AI 偵測到 <strong>{{ chunks.length }}</strong> 條知識。
        <span v-if="truncated" class="kb-warning"> 原文超過 10 萬字已截斷，可能漏掉後半部。</span>
        <span v-else>勾選要匯入的、可直接編輯內容；確認後一鍵建立。</span>
      </p>

      <div class="kb-source-name-row">
        <span class="kb-source-name-label">資料名稱</span>
        <el-input
          v-model="sourceMeta.name"
          :maxlength="200"
          size="small"
          placeholder="顯示在知識庫資料列表的名稱"
          class="kb-source-name-input"
        />
      </div>

      <!-- 產品名（P1-1）：AI 自動偵測預填、使用者可改。空 = 非單一產品資料（FAQ、公告等）。 -->
      <div v-if="sourceMeta.type !== 'gsheet'" class="kb-source-name-row">
        <span class="kb-source-name-label">所屬產品</span>
        <el-input
          v-model="sourceMeta.productName"
          :maxlength="60"
          size="small"
          placeholder="這份內容都在講同一個產品時才填（含品牌與型號）"
          class="kb-source-name-input"
        />
      </div>
      <p v-if="sourceMeta.type !== 'gsheet'" class="kb-section-hint">
        {{ sourceMeta.productName ? 'AI 判斷這份內容屬於這個產品，知識會自動標上產品名，客人指名問時才不會答錯台。不對可以直接改。' : '內容涵蓋多個產品或非產品內容（FAQ、公告）時留空即可。' }}
      </p>

      <el-alert
        v-if="ocrUsed"
        type="warning"
        show-icon
        :closable="false"
        class="kb-ocr-alert"
      >
        <template #title>
          這份 PDF 是掃描檔，文字由 AI 辨識
        </template>
        <div class="text-xs">辨識可能有錯漏（尤其數字、價格、電話），請逐張確認內容正確再匯入。</div>
      </el-alert>

      <!-- 表格健檢:示範列沒換、重複問題、空答案、合併儲存格等;提醒不擋匯入 -->
      <el-alert
        v-if="healthWarnings.length"
        type="warning"
        show-icon
        :closable="false"
        class="kb-health-warnings"
      >
        <template #title>
          建議先確認以下 {{ healthWarnings.length }} 點（不影響匯入）
        </template>
        <ul class="kb-health-list">
          <li v-for="(w, i) in healthWarnings" :key="i">{{ w }}</li>
        </ul>
      </el-alert>

      <el-alert
        v-if="dupMatches.length"
        type="warning"
        show-icon
        :closable="false"
        class="kb-dedup-warning"
      >
        <template #title>
          已存在 {{ dupMatches.length }} 個同名資料
        </template>
        <div class="kb-dedup-body">
          <p class="text-xs">繼續建立會在資料列表出現多筆同名項目，可能不是你想要的。在上方「資料名稱」改個名字，這個提醒就會消失。</p>
          <ul class="kb-dedup-list">
            <li v-for="m in dupMatches" :key="m.id">
              「{{ m.name }}」（{{ m.chunkCount }} 條，{{ relativeTime(m.updatedAtMs) || '未更新' }}）
            </li>
          </ul>
        </div>
      </el-alert>

      <!-- 總表（列表頁專屬）：列在最上面、可編輯、可取消 -->
      <div v-if="overviewCard" class="kb-overview-card">
        <div class="kb-chunk-checkbox">
          <el-checkbox v-model="overviewCard.included" />
        </div>
        <div class="kb-chunk-content">
          <div class="kb-overview-badge">總表（接「你們有賣什麼」這類問題）</div>
          <el-input v-model="overviewCard.title" placeholder="標題" size="small" class="kb-chunk-title" />
          <el-input
            v-model="overviewCard.content"
            type="textarea"
            :rows="4"
            placeholder="內容"
            class="kb-chunk-textarea"
          />
          <div class="kb-chunk-tags">
            <el-tag
              v-for="tag in overviewCard.tags"
              :key="tag"
              size="small"
              closable
              @close="removeTag(overviewCard, tag)"
            >
              {{ tag }}
            </el-tag>
          </div>
        </div>
      </div>

      <!-- 摘要 + 主動作先行:預設就是全選,所以「直接匯入」才是主路徑。
           原本一律攤開 N 條、主按鈕在最底部,50 張要捲上萬像素才按得到,
           結果沒人真的逐張審、只是捲——審核變成儀式。 -->
      <div class="kb-preview-summary">
        <p class="kb-preview-summary__head">
          AI 整理出 <strong>{{ chunks.length }}</strong> 條問答<template v-if="includedCount !== chunks.length">，目前選了 {{ includedCount }} 條</template>
        </p>
        <p v-if="numericChunkCount" class="kb-preview-summary__warn">
          其中 <strong>{{ numericChunkCount }}</strong> 條含金額或數字，建議展開確認一下再匯入。
        </p>
        <div class="kb-preview-summary__actions">
          <el-button
            type="primary"
            :loading="importing"
            :disabled="includedCount === 0"
            @click="runImport"
          >
            {{ importing ? '匯入並學習中⋯' : `直接匯入 ${includedCount} 條` }}
          </el-button>
          <el-button text @click="chunkListOpen = !chunkListOpen">
            {{ chunkListOpen ? '收起逐條檢查' : '先逐條檢查' }}
          </el-button>
          <el-button text @click="step = 'input'">← 換一份重新整理</el-button>
        </div>
      </div>

      <div v-show="chunkListOpen" class="kb-bulk-actions">
        <el-button size="small" plain @click="selectAll">全選</el-button>
        <el-button size="small" plain @click="selectNone">全不選</el-button>
        <span class="text-muted text-xs">已選 {{ includedCount }} / {{ chunks.length }}</span>
      </div>

      <div v-show="chunkListOpen" class="kb-chunk-list">
        <div
          v-for="(chunk, idx) in chunks"
          :key="idx"
          class="kb-chunk-row"
          :class="{ 'kb-chunk-row--excluded': !chunk.included }"
        >
          <div class="kb-chunk-checkbox">
            <el-checkbox v-model="chunk.included" />
          </div>
          <div class="kb-chunk-content">
            <el-input
              v-model="chunk.title"
              placeholder="標題"
              size="small"
              class="kb-chunk-title"
            />
            <el-input
              v-model="chunk.content"
              type="textarea"
              :rows="3"
              placeholder="內容"
              class="kb-chunk-textarea"
            />
            <!-- 客人問法:AI 自動補的檢索關鍵(參與比對),匯入前可逐題檢查/修改 -->
            <div class="kb-chunk-questions">
              <span class="kb-questions-label">客人問法</span>
              <el-tag
                v-for="(q, qi) in chunk.questions"
                :key="`${qi}-${q}`"
                size="small"
                type="info"
                closable
                @close="chunk.questions.splice(qi, 1)"
              >
                {{ q }}
              </el-tag>
              <el-input
                v-if="editingQuestionIdx === idx"
                ref="questionInputRef"
                v-model="questionInput"
                size="small"
                class="kb-question-input"
                placeholder="客人會怎麼問?"
                @keydown.enter.prevent="commitQuestion(chunk)"
                @blur="commitQuestion(chunk)"
              />
              <el-button
                v-else-if="chunk.questions.length < 3"
                size="small"
                plain
                @click="startAddQuestion(idx)"
              >
                ＋
              </el-button>
            </div>
            <!-- 原本這一排標籤沒有欄位名稱,而隔壁「客人問法」有——使用者看到一排小方塊
                 加一個「＋」不知道那是什麼,更可能誤以為它跟問法一樣會影響 AI 找不找得到。
                 兩者用途完全不同,要講清楚。 -->
            <div class="kb-chunk-tags">
              <span class="kb-questions-label">標籤<span class="kb-tags-note">（只是你自己分類用，不影響 AI 回答）</span></span>
              <el-tag
                v-for="tag in chunk.tags"
                :key="tag"
                size="small"
                closable
                @close="removeTag(chunk, tag)"
              >
                {{ tag }}
              </el-tag>
              <el-input
                v-if="editingTagIdx === idx"
                ref="tagInputRef"
                v-model="tagInput"
                size="small"
                class="kb-tag-input"
                @keydown.enter.prevent="commitTag(chunk)"
                @blur="commitTag(chunk)"
              />
              <el-button v-else size="small" plain @click="startAddTag(idx)">＋</el-button>
            </div>
          </div>
        </div>
      </div>

      <!-- 逐條檢查展開時,底部再放一次主動作(捲到最後不必再捲回去) -->
      <div v-show="chunkListOpen" class="kb-import-actions">
        <el-button @click="chunkListOpen = false">收起</el-button>
        <el-button
          type="primary"
          :loading="importing"
          :disabled="includedCount === 0"
          @click="runImport"
        >
          {{ importing ? '匯入並學習中⋯' : `確認匯入 ${includedCount} 條` }}
        </el-button>
      </div>
    </div>

    <!-- ── Step 3:結果(只有部分失敗才會看到;全成功直接關窗) ── -->
    <div v-if="step === 'result' && result">
      <p class="kb-step-label">匯入結果</p>
      <div class="kb-result-summary">
        <div class="kb-result-stat">
          <span class="kb-result-label">總計</span>
          <strong>{{ result.total }}</strong>
        </div>
        <div class="kb-result-stat kb-result-stat--success">
          <span class="kb-result-label">可用</span>
          <strong>{{ result.indexed }}</strong>
        </div>
        <div class="kb-result-stat" :class="result.failed ? 'kb-result-stat--danger' : ''">
          <span class="kb-result-label">失敗</span>
          <strong>{{ result.failed }}</strong>
        </div>
      </div>

      <div v-if="result.failed > 0" class="kb-result-failed-list">
        <div class="kb-failed-head">
          <p class="kb-section-hint">
            以下知識已經建立，但 AI 沒有學成功（客人問到相關問題時會找不到它們）。
            大多是暫時性問題，<strong>就在這裡按重試即可</strong>。
          </p>
          <el-button
            v-if="failedItems.some(i => plainFailure(i.failureReason).retryable)"
            size="small"
            type="primary"
            plain
            :loading="retryAllRunning"
            @click="retryAllFailed"
          >
            全部重試
          </el-button>
        </div>
        <ul class="kb-failed-list">
          <li v-for="item in failedItems" :key="item.id" class="kb-failed-row">
            <div class="kb-failed-row__main">
              <strong>{{ item.title }}</strong>
              <span class="text-muted text-xs">{{ plainFailure(item.failureReason).text }}</span>
            </div>
            <el-button
              v-if="plainFailure(item.failureReason).retryable"
              size="small"
              text
              type="primary"
              :loading="retryingIds.has(item.id)"
              @click="retryOne(item)"
            >
              重試
            </el-button>
            <span v-else class="text-xs text-muted">要改內容才行</span>
          </li>
        </ul>
      </div>

      <div class="kb-import-actions">
        <el-button @click="resetAll">繼續匯入</el-button>
        <el-button type="primary" @click="close">完成</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { detectImportKind, GSHEET_PATTERN, HTTP_URL_PATTERN } from '~~/shared/knowledge-import-detect'

const props = defineProps<{
  modelValue: boolean
  /**
   * 父層的完整資料清單:同名警告要比對「全部」既有名稱——
   * 只比對 preview 回傳的(原始名稱的)同名清單,會漏掉「改名撞進另一個既有資料」的情況。
   */
  existingSources?: Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number }>
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 有實際建立資料時觸發(全成功或部分成功),父層應刷新資料列表 */
  'imported': [sourceId: string | null]
}>()


const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()

type ImportMode = 'file' | 'url' | 'text' | 'gsheet'
type Step = 'input' | 'sitePages' | 'preview' | 'result'

const step = ref<Step>('input')
/**
 * 第一步收成「一個投放區」（P1-2）。
 *
 * 原本是四個分頁（檔案／網址／Google Sheet／貼上文字），使用者一進來就得先做一個
 * 「我該用哪個」的決定，而要判斷得切四次分頁讀四段小字；更糟的是**唯一真正重要的
 * 判準——「之後改了會不會自動更新」——從來沒有並排出現過**。
 * 現在：丟檔案或貼一段東西進來，由 pasteInput 自動判別是網址／試算表連結／純文字，
 * 判別結果連同那一句關鍵差異一起講。mode 因此改成 computed（衍生，不再由人選）。
 */
const pasteInput = ref('')

// 判別規則放 shared 並有測試涵蓋：判錯的後果不是顯示錯字，而是把一串試算表 ID
// 當成知識內容匯進資料庫。mode 與 canPreview 共用同一份，不再各寫一次。
const mode = computed<ImportMode>(() => detectImportKind(pasteInput.value, !!selectedFile.value))

/** 偵測結果：名稱 + 那一句關鍵差異（會不會自動更新），沒東西時為 null */
const detected = computed(() => {
  if (selectedFile.value) {
    const excel = /\.(xlsx|xls)$/i.test(fileName.value)
    return {
      label: excel ? 'Excel 表格' : '檔案',
      sync: '上傳一次就固定。之後改了要重新上傳；想「改了自動更新」請改用 Google 試算表',
      syncTone: 'static' as const,
      hint: excel
        ? '一列變成一條知識：第一欄當標題（例：商品名稱），其餘欄位當內容。第一列請放欄位名稱。'
        : '由 AI 判斷怎麼分段。用拍的、掃的檔案會由 AI 認字，請核對數字與價格有沒有看錯。',
    }
  }
  if (!pasteInput.value.trim()) return null
  if (mode.value === 'gsheet') {
    return {
      label: 'Google 試算表',
      sync: '你改試算表，AI 會定期自動跟著更新（你在後台手動改過的內容不會被蓋掉）',
      syncTone: 'live' as const,
      hint: '一列變成一條知識：第一欄當標題，其餘欄位當內容。第一欄請放看得懂的名字（例：商品名），不要放編號。',
    }
  }
  if (mode.value === 'url') {
    return {
      label: '網頁',
      sync: '抓取當下的內容。之後網頁改了，系統會通知你、由你決定要不要重新學',
      syncTone: 'semi' as const,
      hint: '只抓網頁上的文字。需要先登入、或要按按鈕才顯示內容的頁面可能抓不到；商城首頁的商品區塊常是動態載入，請改貼商品列表頁。',
    }
  }
  return {
    label: '一段文字',
    sync: '貼進來就固定。之後要改就直接編輯知識內容',
    syncTone: 'static' as const,
    hint: `AI 會幫你切成多條（目前 ${pasteInput.value.trim().length.toLocaleString('zh-TW')} 字，上限 100,000 字）。`,
  }
})

// ── File ──────────────────────────────────────────────────
const fileInputEl = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const fileSizeKb = ref(0)
// 留住 File 物件本身：預覽時才用 signed URL 直傳 Storage（不再前置轉 base64 塞 JSON，
// 否則 ~5MB 檔 base64 膨脹到 ~6.7MB 會超過 Lambda 6MB payload 上限 → 413）。
const selectedFile = ref<File | null>(null)
const fileContentType = ref('')

// 判別結果同步回原本三個欄位，下游（runPreview / runDiscover / bulk-create）完全不用改。
// ⚠️ 這個 watch 必須放在 selectedFile 宣告之後：watch 註冊當下就會讀一次 mode 當初始值，
// 而 mode 的 getter 讀 selectedFile——放前面會 TDZ(「Cannot access before initialization」)，
// 整個元件 setup 直接炸掉、知識庫頁面變全站錯誤頁。typecheck 抓不到這種執行時序問題。
watch([pasteInput, mode], () => {
  const v = pasteInput.value.trim()
  urlInput.value = mode.value === 'url' ? v : ''
  gsheetInput.value = mode.value === 'gsheet' ? v : ''
  textInput.value = mode.value === 'text' ? pasteInput.value : ''
})

const ACCEPTED_EXT_RE = /\.(pdf|xlsx|xls)$/i

/** 檔案共用入口:選檔與拖放都走這裡,上限與型別檢查只有一份 */
function acceptFile(file: File | undefined | null): boolean {
  if (!file) return false
  if (!ACCEPTED_EXT_RE.test(file.name)) {
    showToast('只支援 PDF 與 Excel（.xlsx / .xls）', 'error')
    return false
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('檔案超過 10MB 上限', 'error')
    return false
  }
  selectedFile.value = file
  fileName.value = file.name
  fileSizeKb.value = Math.round(file.size / 1024)
  fileContentType.value = file.type
  pasteInput.value = '' // 檔案優先:避免同時有檔案又有貼上內容而判別不出來
  return true
}

function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement
  if (!acceptFile(target.files?.[0])) target.value = ''
}

const dragOver = ref(false)
function onDrop(e: DragEvent) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) {
    acceptFile(file)
    return
  }
  // 拖的是一段文字/連結（從瀏覽器網址列或另一個頁面拖過來）也接受
  const text = e.dataTransfer?.getData('text')?.trim()
  if (text) pasteInput.value = text
}

function clearFile() {
  selectedFile.value = null
  fileName.value = ''
  fileSizeKb.value = 0
  fileContentType.value = ''
  if (fileInputEl.value) fileInputEl.value.value = ''
}

// ── URL / text ────────────────────────────────────────────
const urlInput = ref('')
const textInput = ref('')

// ── Google Sheet ──────────────────────────────────────────
const gsheetInput = ref('')
const serviceAccountEmail = ref('')

async function copyServiceEmail() {
  try {
    await navigator.clipboard.writeText(serviceAccountEmail.value)
    showToast('已複製服務帳號 email', 'success')
  }
  catch {
    showToast('複製失敗，請手動選取複製', 'error')
  }
}

// 官方 FAQ 範本:有設定母本網址就轉成 /copy 連結(一鍵建立副本);沒設定或網址無法轉則退回下載 xlsx
const faqTemplateCopyUrl = computed(() => {
  const u = String(useRuntimeConfig().public.faqTemplateSheetUrl || '').trim()
  if (!u) return ''
  if (/\/copy([?#]|$)/.test(u)) return u
  // 「發布到網路」的網址是 /spreadsheets/d/e/{發布ID}/...，那個 e 不是檔案 ID、也不支援 /copy；
  // 硬湊會變成 /d/e/copy（404）。這種情況不硬轉,回空字串 → 退回下載 xlsx。
  if (/\/spreadsheets\/d\/e\//.test(u)) return ''
  const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return m ? `https://docs.google.com/spreadsheets/d/${m[1]}/copy` : ''
})
// 載入要分享給哪個服務帳號 email（提示用；失敗不擋）
onMounted(async () => {
  try {
    const res = await apiFetch<{ serviceAccountEmail: string }>('/api/ai/knowledge/gsheet-account')
    serviceAccountEmail.value = res.serviceAccountEmail
  }
  catch { /* 提示性質，讀不到就不顯示 */ }
})

// ── Overview（列表頁總表）──────────────────────────────
const generateOverview = ref(false)
type OverviewCard = { included: boolean; title: string; content: string; tags: string[]; questions: string[] }
const overviewCard = ref<OverviewCard | null>(null)

// ── Preview ───────────────────────────────────────────────
const previewing = ref(false)
// 非同步 job 的即時進度（整理 3/5、辨識掃描檔 2/6…）；null = 尚無進度資訊
const previewProgressText = computed(() => {
  const p = jobProgress.value
  // 供應商名稱對商家沒有意義（也不該讓它出現在 UI，換供應商時文案就過期了）
  if (!p) return 'AI 正在讀你的資料⋯'
  return p.total > 1 ? `${p.label} ${p.done}/${p.total}⋯` : `${p.label}⋯`
})
const truncated = ref(false)
const ocrUsed = ref(false) // 掃描檔 PDF 由 AI 辨識文字 → 預覽時提醒逐張確認
const healthWarnings = ref<string[]>([]) // 表格資料的匯入前健檢警告（提醒不擋匯入）
const chunks = ref<Array<{ included: boolean; title: string; content: string; tags: string[]; questions: string[] }>>([])
const existingMatches = ref<Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number }>>([])
const sourceMeta = ref({
  type: '' as ImportMode | '',
  name: '',
  url: '',
  /** 所屬產品名：AI 偵測預填、使用者可改；'' = 非單一產品資料 */
  productName: '',
  /** 網址來源的內容指紋（存成 source.appliedContentHash＝重新同步的比對基準） */
  contentHash: '',
})

// mode 已經是「判別結果」，這裡只需確認對應的輸入真的有值（規則共用 shared/knowledge-import-detect）
const canPreview = computed(() => {
  if (mode.value === 'file') return Boolean(selectedFile.value)
  if (mode.value === 'url') return HTTP_URL_PATTERN.test(urlInput.value.trim())
  if (mode.value === 'gsheet') return GSHEET_PATTERN.test(gsheetInput.value.trim())
  return textInput.value.trim().length > 0
})

// ── 整站匯入(2.5):探頁面清單 → 勾選 → 逐頁走既有 preview-job + bulk-create ──
interface SitePageRow {
  url: string
  title: string
  checked: boolean
  status: 'idle' | 'processing' | 'done' | 'failed'
  cards: number
  /** 這一頁的匯入守門提醒原文(整站匯入沒有逐頁預覽,至少要看得到提醒內容) */
  warningTexts: string[]
  error: string
  /** 這個網址已經有對應的資料(再匯一次會產生重複) */
  imported: boolean
  /** 路徑第一段(分組用);探索時算一次,避免每次篩選/勾選都重新解析上千個網址 */
  group: string
}
const discovering = ref(false)
const sitePages = ref<SitePageRow[]>([])
const siteFrom = ref<'sitemap' | 'links'>('sitemap')
const siteTruncated = ref(false)
const siteImporting = ref(false)
const siteAborted = ref(false) // 使用者中途關窗 → worker 收工
const siteFinished = ref(false) // 至少跑完一輪批次匯入
const siteBatchTotal = ref(0)
const siteDoneCount = ref(0)

const siteHost = computed(() => {
  try {
    return new URL(sitePages.value[0]?.url || urlInput.value.trim()).host
  }
  catch {
    return ''
  }
})
const siteFilter = ref('')
/** 網址的第一段路徑當分組 key(例 /projects、/media);首頁歸「(首頁)」 */
function pageGroupKey(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[0] ?? ''
    return seg ? `/${seg}` : '(首頁)'
  }
  catch {
    return '(其他)'
  }
}

/** 目前選中的分組;'' = 全部 */
const siteGroup = ref('')
/**
 * 路徑分組導覽:大站(上千頁)的清單靠捲的找不到重點,先讓使用者看懂網站組成
 * (「/media 1511 頁、/projects 225 頁」),點分組直接縮小範圍。只顯示 ≥2 頁的組。
 */
const siteGroups = computed(() => {
  const m = new Map<string, number>()
  for (const p of sitePages.value) m.set(p.group, (m.get(p.group) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 2).slice(0, 8)
})

/** 篩選(分組+關鍵字)只影響顯示,不會把已勾的頁取消勾選 */
const visibleSitePages = computed(() => {
  const kw = siteFilter.value.trim().toLowerCase()
  return sitePages.value.filter(p =>
    (!siteGroup.value || p.group === siteGroup.value)
    && (!kw || p.url.toLowerCase().includes(kw) || p.title.toLowerCase().includes(kw)))
})
const checkedSiteCount = computed(() => sitePages.value.filter(p => p.checked).length)
/** 批次結束後的結論(成功頁數/卡數/失敗/帶提醒) */
const siteSummary = computed(() => {
  const done = sitePages.value.filter(p => p.status === 'done')
  return {
    ok: done.length,
    cards: done.reduce((s, p) => s + p.cards, 0),
    failed: sitePages.value.filter(p => p.status === 'failed').length,
    warned: done.filter(p => p.warningTexts.length).length,
  }
})
const importedSiteCount = computed(() => sitePages.value.filter(p => p.imported).length)
/**
 * 可勾的頁 = **目前顯示中**且未匯入過、本輪未完成的。全選作用在顯示中的頁——
 * 「點 /projects 分組再全選」正是大站挑商品頁的主要動線;已勾但被篩掉的頁不會被取消。
 */
const selectableSitePages = computed(() => visibleSitePages.value.filter(p => !p.imported && p.status !== 'done'))
const allSiteChecked = computed(() =>
  selectableSitePages.value.length > 0 && selectableSitePages.value.every(p => p.checked))
// 半勾狀態要跟「全選」同範圍(目前顯示的頁)。用全域已勾數的話:在 A 分組勾了 5 頁再切到
// B 分組,B 一頁都沒勾卻顯示半勾,點一下反而會把 B 的上千頁全勾起來。
const someSiteChecked = computed(() =>
  selectableSitePages.value.some(p => p.checked) && !allSiteChecked.value)

function toggleAllSite(checked: boolean | string | number) {
  const on = checked === true
  if (!on) {
    for (const p of selectableSitePages.value) p.checked = false
    return
  }
  // 勾到上限就停:分組動輒上千頁(/media 1511),讓他勾滿再用錯誤訊息擋下來,
  // 使用者會卡在「1511 個勾勾要自己取消」的死路。先勾前 N 頁並說清楚。
  const room = MAX_SITE_BATCH - sitePages.value.filter(p => p.checked).length
  let added = 0
  for (const p of selectableSitePages.value) {
    if (p.checked) continue
    if (added >= room) break
    p.checked = true
    added++
  }
  const remaining = selectableSitePages.value.filter(p => !p.checked).length
  if (remaining > 0) {
    showToast(`一次最多匯入 ${MAX_SITE_BATCH} 頁,已勾選 ${MAX_SITE_BATCH} 頁;剩下的 ${remaining} 頁可以等這批完成後再跑一次`, 'warning')
  }
}

function pagePathLabel(url: string): string {
  try {
    const u = new URL(url)
    return decodeURIComponent(u.pathname === '/' ? u.host : u.pathname)
  }
  catch {
    return url
  }
}

/** 抓同網域可匯入頁面清單並填進 sitePages。回傳頁數;不負責換頁。 */
async function loadSitePages(url: string): Promise<number> {
  const res = await apiFetch<{ pages: Array<{ url: string; title: string; imported?: boolean }>; from: 'sitemap' | 'links'; truncated: boolean }>(
    '/api/ai/knowledge/discover-pages',
    { method: 'POST', body: { url } },
  )
  // 預設不勾:整站可能上百頁,每頁都是一次 AI 整理(時間+token);讓使用者自己挑
  sitePages.value = res.pages.map(p => ({
    url: p.url,
    title: p.title,
    checked: false,
    status: 'idle',
    cards: 0,
    warningTexts: [],
    error: '',
    imported: p.imported === true,
    group: pageGroupKey(p.url),
  }))
  siteFrom.value = res.from
  siteTruncated.value = res.truncated
  siteFinished.value = false
  siteGroup.value = ''
  siteFilter.value = ''
  return sitePages.value.length
}

async function runDiscover() {
  discovering.value = true
  try {
    await loadSitePages(urlInput.value.trim())
    step.value = 'sitePages'
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || err?.statusMessage || err?.message || '探索失敗', 'error')
  }
  finally {
    discovering.value = false
  }
}

/**
 * 貼上網址後自動探一次「這個網站還有幾頁」(P1-3)。
 *
 * 原本整站匯入藏成第二顆次要按鈕(標籤還是「找出這個網站的其他頁面」),
 * 第一次用的人幾乎不會發現自己能一次匯入整站——那正是最花時間的手動替代方案。
 * 現在改成主動報數字:「這個網站還有 128 頁,要一起匯入嗎?」
 *
 * 成本控制:只對合法 http(s) 網址、停止輸入 1 秒後才探、同一個網址只探一次、
 * 失敗完全靜音(探不到就當沒這回事,原本的手動按鈕還在)。探到的清單直接留著,
 * 按「一起匯入」不用再抓一次。
 */
const sitePeekCount = ref(0)
const sitePeeking = ref(false)
let peekedUrl = ''
let peekTimer: ReturnType<typeof setTimeout> | null = null

watch([mode, pasteInput], () => {
  if (peekTimer) clearTimeout(peekTimer)
  const url = pasteInput.value.trim()
  if (mode.value !== 'url' || !HTTP_URL_PATTERN.test(url)) {
    sitePeekCount.value = 0
    return
  }
  if (url === peekedUrl) return // 已經探過這個網址
  sitePeekCount.value = 0
  peekTimer = setTimeout(async () => {
    sitePeeking.value = true
    try {
      const n = await loadSitePages(url)
      // 使用者可能在等待期間換了網址 → 過期結果丟掉
      if (pasteInput.value.trim() !== url) return
      peekedUrl = url
      // 清單一定包含使用者貼的那一頁,「另外還有」要扣掉它才不會多報一頁
      sitePeekCount.value = Math.max(0, n - 1)
    }
    catch {
      peekedUrl = url // 探失敗就不再重試同一個網址,避免每次改字都打一次
    }
    finally {
      sitePeeking.value = false
    }
  }, 1000)
})

/** 一次批次最多頁數:每頁一次 LLM 整理,再多就該分批跑(也避免瀏覽器分頁被綁住太久) */
const MAX_SITE_BATCH = 50

/** 批次匯入勾選頁:併發 2,每頁 = 建 preview-job → 輪詢 → bulk-create(全卡直入,不逐頁人工預覽)。 */
async function runSiteImport() {
  const targets = sitePages.value.filter(p => p.checked && p.status !== 'done')
  if (!targets.length) return
  if (targets.length > MAX_SITE_BATCH) {
    return showToast(`一次最多匯入 ${MAX_SITE_BATCH} 頁,請先取消勾選一些(可分批進行)`, 'error')
  }
  // 每頁都要跑一次 AI 整理並計入用量,量大時先講清楚再開始
  if (targets.length >= 10) {
    try {
      await ElMessageBox.confirm(
        `將匯入 ${targets.length} 頁,每頁都會由 AI 整理並計入本月用量,過程約需 ${Math.ceil(targets.length * 0.5)}–${targets.length} 分鐘。期間請保持這個視窗開著。`,
        '確認整站匯入',
        { confirmButtonText: '開始匯入', cancelButtonText: '再想想', type: 'warning' },
      )
    }
    catch {
      return // 使用者取消
    }
  }
  siteImporting.value = true
  siteAborted.value = false
  siteBatchTotal.value = targets.length
  siteDoneCount.value = 0

  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      if (siteAborted.value) return // 使用者關窗 → 收工,不再開新頁
      const page = targets[cursor++]!
      page.status = 'processing'
      page.error = ''
      try {
        const created = await apiFetch<{ jobId: string }>('/api/ai/knowledge/preview-jobs', {
          method: 'POST',
          body: { type: 'url', url: page.url, generateOverview: false },
        })
        const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(created.jobId)
        if (!res.chunks.length) throw new Error('沒有切出知識(頁面可能沒有實質內容)')
        const bulk = await apiFetch<{ indexed: number; failed: number }>('/api/ai/knowledge/bulk-create', {
          method: 'POST',
          body: {
            source: {
              type: 'url',
              name: page.title || res.sourceName || page.url,
              url: page.url,
              productName: res.suggestedProductName ?? '',
              contentHash: res.contentHash ?? '',
            },
            chunks: res.chunks.map(c => ({
              title: c.title,
              content: c.content,
              tags: c.tags ?? [],
              questions: c.questions ?? [],
            })),
            overviewCard: null,
          },
        })
        page.cards = bulk.indexed
        page.warningTexts = res.warnings ?? []
        page.status = 'done'
        page.checked = false
        page.imported = true
      }
      catch (err: any) {
        page.status = 'failed'
        page.error = String(err?.data?.statusMessage || err?.statusMessage || err?.message || '匯入失敗').slice(0, 80)
      }
      finally {
        siteDoneCount.value++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, worker))

  const ok = targets.filter(p => p.status === 'done')
  const bad = targets.filter(p => p.status === 'failed')
  // 讓關窗流程通知父層刷新資料列表(沿用既有 result 訊號)
  if (ok.length) {
    result.value = {
      sourceId: null,
      total: targets.length,
      indexed: ok.reduce((s, p) => s + p.cards, 0),
      failed: bad.length,
      items: [],
    }
  }
  siteFinished.value = true
  siteImporting.value = false
  // 中途關窗:視窗已不在,改用父層刷新讓已建立的資料立刻出現在列表(否則要手動重整才看得到)
  if (siteAborted.value) {
    if (ok.length) emit('imported', null)
    resetAll()
    return
  }
  showToast(
    bad.length
      ? `整站匯入完成:${ok.length} 頁成功、${bad.length} 頁失敗(清單有標原因)`
      : `整站匯入完成:${ok.length} 頁、共 ${ok.reduce((s, p) => s + p.cards, 0)} 條`,
    bad.length ? 'error' : 'success',
  )
}

const includedCount = computed(() => chunks.value.filter(c => c.included).length)

/**
 * 逐條檢查預設收起。整理結果預設全選,所以主路徑是「直接匯入」——
 * 原本一律攤開所有知識、主按鈕壓在最底,幾十條就要捲上萬像素才按得到。
 */
const chunkListOpen = ref(false)

/**
 * 含金額/數字的條數。OCR 提醒說「請逐張確認數字、價格」卻沒標出是哪幾張,
 * 那句話等於無法執行;這裡把該看的挑出來,讓「檢查」有對象。
 */
const numericChunkCount = computed(() =>
  chunks.value.filter(c => c.included && /\d/.test(c.content)).length,
)

// 同名警告要「活的」:使用者在預覽步驟改名,警告即時跟著變。
// 比對對象 = 父層完整資料清單 ∪ preview 回傳的同名清單(父層沒傳 prop 時的 fallback),
// 否則改名撞進「另一個」既有資料不會有任何警告——正是這個警示要防的事。
const dupMatches = computed(() => {
  const name = sourceMeta.value.name.trim()
  if (!name) return []
  const pool = new Map<string, { id: string; name: string; chunkCount: number; updatedAtMs: number }>()
  for (const s of props.existingSources ?? []) pool.set(s.id, s)
  for (const m of existingMatches.value) if (!pool.has(m.id)) pool.set(m.id, m)
  return [...pool.values()].filter(m => m.name.trim() === name)
})

/** 預覽 job 完成時的回應形狀（與舊 preview-chunks 相同） */
interface PreviewResult {
  chunks: Array<{ title: string; content: string; tags: string[]; questions?: string[] }>
  overviewCard?: { title: string; content: string; tags: string[]; questions: string[] } | null
  sourceName: string
  sourceUrl: string
  truncated: boolean
  ocrUsed?: boolean
  existingMatches?: Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number }>
  /** 表格資料的匯入前健檢警告（示範列沒換、重複問題等） */
  warnings?: string[]
  /** AI 自動偵測的產品名（多產品 / 平台頁為空）；預填給使用者確認可改 */
  suggestedProductName?: string
  /** 網址來源這次抓到的內容指紋；原樣帶給 bulk-create 當「重新同步」的比對基準 */
  contentHash?: string
}

// 輪詢協定與「重新同步」共用同一支 composable(重試碼 / 逾時 / 取消只留一份實作)
const { progress: jobProgress, poll: pollPreviewJob, reset: resetJobPoll, cancel: cancelJobPoll } = usePreviewJobPoll()

/** 逾時/失敗的訊息（留在畫面上，不用會自己消失的 toast） */
const previewError = ref('')
/** 使用者主動取消：用來區分「取消」與「真的失敗」，取消不該顯示錯誤 */
let previewCancelled = false

async function runPreview() {
  previewing.value = true
  previewError.value = ''
  previewCancelled = false
  resetJobPoll()
  try {
    const body: Record<string, unknown> = { type: mode.value, generateOverview: generateOverview.value }
    if (mode.value === 'file') {
      const file = selectedFile.value
      if (!file) return
      // 原檔直傳 Storage（signed PUT URL）：繞過 Lambda 6MB payload 上限、免 base64 33% 膨脹。
      // 檔案 bytes 不經過我們的 API/Lambda，只把 storagePath 送去建 job。
      jobProgress.value = { done: 0, total: 1, label: '上傳檔案' }
      const up = await apiFetch<{ storagePath: string; uploadUrl: string }>(
        '/api/ai/knowledge/upload-url',
        { method: 'POST', body: { fileName: file.name, contentType: file.type } },
      )
      // 直打 GCS signed URL（絕對網址）→ 用 $fetch，不要用會加 workspace/auth 標頭的 apiFetch。
      await $fetch(up.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      })
      resetJobPoll()
      body.fileName = file.name
      body.contentType = file.type
      body.storagePath = up.storagePath
    }
    else if (mode.value === 'url') {
      body.url = urlInput.value.trim()
    }
    else if (mode.value === 'gsheet') {
      body.url = gsheetInput.value.trim()
    }
    else {
      body.text = textInput.value.trim()
      // 帶日期避免每次都叫「手打輸入」→ 第二次必撞同名警告(且名稱可在預覽步驟再改)
      const now = new Date()
      body.name = `貼上文字 ${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`
    }

    // 建 job(秒回)→ 輪詢推進(永不 504)。回應形狀與舊 preview-chunks 相同。
    const created = await apiFetch<{ jobId: string }>(
      '/api/ai/knowledge/preview-jobs',
      { method: 'POST', body },
    )
    const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(created.jobId)

    if (!res.chunks.length) {
      showToast('AI 沒有切出任何有意義的知識；請改貼文字或檢查資料內容', 'error')
      return
    }

    truncated.value = res.truncated
    ocrUsed.value = res.ocrUsed === true
    healthWarnings.value = res.warnings ?? []
    chunks.value = res.chunks.map(c => ({
      included: true,
      title: c.title,
      content: c.content,
      tags: [...(c.tags ?? [])],
      questions: [...(c.questions ?? [])],
    }))
    overviewCard.value = res.overviewCard
      ? {
          included: true,
          title: res.overviewCard.title,
          content: res.overviewCard.content,
          tags: [...(res.overviewCard.tags ?? [])],
          questions: [...(res.overviewCard.questions ?? [])],
        }
      : null
    existingMatches.value = res.existingMatches ?? []
    sourceMeta.value = {
      type: mode.value,
      name: res.sourceName,
      url: res.sourceUrl,
      productName: res.suggestedProductName ?? '',
      contentHash: res.contentHash ?? '',
    }
    step.value = 'preview'
  }
  catch (err: any) {
    if (previewCancelled) return // 使用者自己按取消,不是錯誤
    // 留在畫面上而不是 toast：等了幾分鐘的人常常沒盯著螢幕，3.5 秒的提示等於沒講
    previewError.value = String(
      err?.data?.statusMessage || err?.statusMessage || err?.message || '整理失敗',
    ).slice(0, 300)
  }
  finally {
    previewing.value = false
    resetJobPoll()
  }
}

/** 取消整理:輪詢停掉、畫面回到可操作狀態（composable 早就有 cancel，只是這個視窗沒接） */
function cancelPreview() {
  previewCancelled = true
  cancelJobPoll()
  previewing.value = false
  resetJobPoll()
  showToast('已取消', 'success')
}

// ── Tag editor (per chunk) ────────────────────────────────
const editingTagIdx = ref<number | null>(null)
const tagInput = ref('')
const tagInputRef = ref<Array<{ focus: () => void }> | { focus: () => void } | null>(null)

function startAddTag(idx: number) {
  editingTagIdx.value = idx
  tagInput.value = ''
  nextTick(() => {
    const el = Array.isArray(tagInputRef.value) ? tagInputRef.value[0] : tagInputRef.value
    el?.focus?.()
  })
}

function commitTag(chunk: { tags: string[] }) {
  const t = tagInput.value.trim()
  if (t && !chunk.tags.includes(t)) chunk.tags.push(t)
  tagInput.value = ''
  editingTagIdx.value = null
}

function removeTag(chunk: { tags: string[] }, tag: string) {
  chunk.tags = chunk.tags.filter(x => x !== tag)
}

// ── Question editor (per chunk) ───────────────────────────
// 「客人問法」跟標題/內容一起進向量,是檢索命中的關鍵;AI 補的在這裡逐題把關。
// 上限 3 句與後端 bulk-create 的截斷一致。
const editingQuestionIdx = ref<number | null>(null)
const questionInput = ref('')
const questionInputRef = ref<Array<{ focus: () => void }> | { focus: () => void } | null>(null)

function startAddQuestion(idx: number) {
  editingQuestionIdx.value = idx
  questionInput.value = ''
  nextTick(() => {
    const el = Array.isArray(questionInputRef.value) ? questionInputRef.value[0] : questionInputRef.value
    el?.focus?.()
  })
}

function commitQuestion(chunk: { questions: string[] }) {
  const q = questionInput.value.trim()
  if (q && !chunk.questions.includes(q) && chunk.questions.length < 3) chunk.questions.push(q)
  questionInput.value = ''
  editingQuestionIdx.value = null
}

// ── Bulk selection ────────────────────────────────────────
function selectAll() {
  for (const c of chunks.value) c.included = true
}
function selectNone() {
  for (const c of chunks.value) c.included = false
}

// ── Import ────────────────────────────────────────────────
const importing = ref(false)
const result = ref<{
  sourceId: string | null
  total: number
  indexed: number
  failed: number
  items: Array<{ id: string; title: string; status: string; failureReason?: string }>
} | null>(null)

const failedItems = computed(() =>
  (result.value?.items ?? []).filter(i => i.status === 'failed'),
)

// ── 失敗就地重試（P1-6） ──────────────────────────────────
// 原本只寫「可到知識庫點開那一條按重新學習」：要記住 N 個標題、換頁、一條條點。
// 失敗原因也直接吐後端原文（多半是英文），使用者無從判斷是暫時性還是內容有問題。

/** 後端原文 → 白話一句＋能不能靠重試解決 */
function plainFailure(reason?: string): { text: string; retryable: boolean } {
  const r = String(reason ?? '').toLowerCase()
  if (!r) return { text: '原因不明', retryable: true }
  if (/timeout|timed out|etimedout|econnreset|socket/.test(r))
    return { text: '連線逾時（暫時性問題）', retryable: true }
  if (/429|rate limit|quota|resource.*exhausted/.test(r))
    return { text: 'AI 服務忙碌中（暫時性問題）', retryable: true }
  if (/5\d\d|internal|unavailable|bad gateway/.test(r))
    return { text: 'AI 服務暫時故障（暫時性問題）', retryable: true }
  if (/too long|exceed|payload|size/.test(r))
    return { text: '這一條內容太長，AI 讀不下', retryable: false }
  if (/empty|invalid|no content/.test(r))
    return { text: '這一條內容有問題（可能是空的或只有符號）', retryable: false }
  if (/api key|permission|denied|unauthorized|401|403/.test(r))
    return { text: 'AI 服務金鑰或權限有問題，重試無效，請聯絡我們', retryable: false }
  return { text: '學習失敗（暫時性問題居多）', retryable: true }
}

const retryingIds = ref<Set<string>>(new Set())
const retryAllRunning = ref(false)

async function retryOne(item: { id: string; status: string; failureReason?: string }): Promise<boolean> {
  retryingIds.value = new Set([...retryingIds.value, item.id])
  try {
    await apiFetch(`/api/ai/knowledge/${item.id}/reindex`, { method: 'POST' })
    // 就地改狀態：結果頁的統計與清單都跟著更新，不用重新匯入才看得到成果
    const row = (result.value?.items ?? []).find(i => i.id === item.id)
    if (row && result.value) {
      row.status = 'indexed'
      row.failureReason = undefined
      result.value.indexed += 1
      result.value.failed = Math.max(0, result.value.failed - 1)
    }
    return true
  }
  catch (err: any) {
    const row = (result.value?.items ?? []).find(i => i.id === item.id)
    if (row) row.failureReason = err?.data?.statusMessage || err?.statusMessage || row.failureReason
    return false
  }
  finally {
    const next = new Set(retryingIds.value)
    next.delete(item.id)
    retryingIds.value = next
  }
}

async function retryAllFailed() {
  // 只重試「可能靠重試解決」的：內容太長之類重試一百次也一樣，別讓人白等
  const targets = failedItems.value.filter(i => plainFailure(i.failureReason).retryable)
  if (!targets.length) return
  retryAllRunning.value = true
  try {
    let ok = 0
    for (const t of targets) {
      // 逐條而非併發：失敗多半是 AI 服務忙碌，同時打更多只會一起失敗
      if (await retryOne(t)) ok++
    }
    showToast(
      ok === targets.length ? `${ok} 條都學會了` : `${ok} / ${targets.length} 條成功，其餘可稍後再試`,
      ok === targets.length ? 'success' : 'error',
    )
  }
  finally {
    retryAllRunning.value = false
  }
}

async function runImport() {
  const selected = chunks.value
    .filter(c => c.included && c.title.trim() && c.content.trim())
    .map(c => ({ title: c.title.trim(), content: c.content.trim(), tags: c.tags, questions: c.questions ?? [] }))

  if (!selected.length) return showToast('請至少選擇一條', 'error')
  if (selected.length > 150) return showToast('單次最多匯入 150 張，請先取消勾選一些', 'error')

  importing.value = true
  try {
    const ov = overviewCard.value
    const overviewPayload = ov && ov.included && ov.title.trim() && ov.content.trim()
      ? { title: ov.title.trim(), content: ov.content.trim(), tags: ov.tags, questions: ov.questions ?? [] }
      : null

    const res = await apiFetch<typeof result.value>('/api/ai/knowledge/bulk-create', {
      method: 'POST',
      body: {
        source: {
          type: sourceMeta.value.type,
          name: sourceMeta.value.name.trim() || '未命名資料',
          url: sourceMeta.value.url,
          productName: sourceMeta.value.productName.trim(),
          contentHash: sourceMeta.value.contentHash,
        },
        chunks: selected,
        overviewCard: overviewPayload,
      },
    })
    result.value = res
    // 全部成功直接關窗(關窗 handler 會通知父層刷新並選中新資料);
    // 有失敗才停在結果頁,讓使用者看到哪幾張失敗、原因是什麼
    if (res && res.failed === 0) {
      showToast(`成功匯入 ${res.indexed} 張`, 'success')
      close()
    }
    else if (res) {
      step.value = 'result'
      showToast(`匯入完成：${res.indexed} 成功 / ${res.failed} 失敗`, 'error')
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.message || '匯入失敗', 'error')
  }
  finally {
    importing.value = false
  }
}

function resetAll() {
  step.value = 'input'
  pasteInput.value = '' // mode 由這個與 selectedFile 衍生，不再是可寫的狀態
  fileName.value = ''
  fileSizeKb.value = 0
  selectedFile.value = null
  fileContentType.value = ''
  urlInput.value = ''
  textInput.value = ''
  gsheetInput.value = ''
  chunks.value = []
  overviewCard.value = null
  generateOverview.value = false
  existingMatches.value = []
  truncated.value = false
  ocrUsed.value = false
  healthWarnings.value = []
  result.value = null
  sourceMeta.value = { type: '', name: '', url: '', productName: '', contentHash: '' }
  sitePages.value = []
  siteFilter.value = ''
  siteGroup.value = ''
  siteTruncated.value = false
  siteImporting.value = false
  siteAborted.value = false
  siteFinished.value = false
  siteBatchTotal.value = 0
  siteDoneCount.value = 0
  if (fileInputEl.value) fileInputEl.value.value = ''
}

function close() {
  emit('update:modelValue', false)
}

/**
 * 統一在「關窗」時結算:只要有實際建立過資料(result 存在,全成功或部分成功),
 * 就通知父層刷新資料列表並重置狀態;中途關窗(還沒匯入)則保留輸入,下次打開接續。
 */
function onDialogClose() {
  // 整站批次還在跑時關窗(ESC / X):通知 worker 收工,收尾由 runSiteImport 負責
  // (它會 emit imported 讓列表帶出已建立的資料,再 resetAll)——這裡不能先 reset,
  // 否則正在跑的那幾頁寫完後會把狀態寫回已清空的 ref。
  if (siteImporting.value) {
    siteAborted.value = true
    return
  }
  if (result.value) {
    emit('imported', result.value.sourceId)
    resetAll()
  }
}

function relativeTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}
</script>
