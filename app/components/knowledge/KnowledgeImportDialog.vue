<template>
  <el-dialog
    :model-value="modelValue"
    title="加入知識"
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
        <!-- 有母本連結=開 Google 試算表副本(填完貼連結回來);沒設定=下載 Excel 檔(要用「選擇檔案」傳回來)。
             指示要照實際走的那條路講——寫死「貼回來」的話,下載 Excel 的人照字面做會卡住 -->
        <span class="text-xs text-muted">兩欄(問題／答案)填完，{{ faqTemplateCopyUrl ? '把試算表連結貼回來' : '用「選擇檔案」把檔案傳回來' }}就好，其他問法 AI 會自動補</span>
      </p>


      <!--
        等「偵測到內容」才出現:什麼都還沒貼就先問一個要讀四行字的問題,是空白狀態最重的負擔
        (佔近半個視窗)。答不出來也沒關係:整理完看到條數多,預覽那一步會再主動問一次(見
        suggestOverview)。標籤用敘述句不用問句——勾選框配問句,勾下去像在回答「有」,讀起來卡。
        「官網首頁不適合」那句只跟貼網址有關,貼文字/傳檔的人看到只是干擾。
      -->
      <div v-if="detected && mode !== 'gsheet'" class="kb-overview-toggle" data-tour="kb-overview">
        <el-checkbox v-model="generateOverview">
          這是一份<strong>多樣商品</strong>的清單（AI 會多做一張「我們有賣什麼」的總表）
        </el-checkbox>
        <p class="kb-section-hint">
          商品型錄、商品列表頁記得勾——客人問「你們有賣哪些東西」時可以一次答完，不會被反問。<template v-if="mode === 'url'"><strong>官網首頁不適合</strong>（商品區塊多半是滑動時才載入、抓不到，總表會做錯），請改貼商品列表頁。</template>
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
        <!-- 空白時按鈕是禁用的淺色,看起來像壞掉——講一句為什麼按不了。
             按鈕本身不藏:導覽有一步指著它(data-tour="kb-preview") -->
        <span v-if="!detected" class="text-xs text-muted">先貼上內容或選個檔案，這顆按鈕就會亮起來</span>
      </div>

      <!-- 等待要有契約:長文件可能要好幾分鐘。原本只有一行灰字,沒有取消、
           也沒說能不能關視窗——最容易讓人以為系統壞了的一段。 -->
      <div v-if="previewing" class="kb-waiting">
        <p class="kb-waiting__text">{{ previewProgressText }}</p>
        <!--
          這段話要跟實際行為對得上。以前寫「關掉視窗回來就看得到結果」,但工作編號只活在
          記憶體裡:換頁或重整就撿不回來,伺服器那份還在也拿不到 → 只能重傳、重跑、重收費。
          現在編號會落地(見 saveJobMarker),回到這一頁自動接續;但整理**只在有人看著時前進**,
          所以只能承諾「接著跑、不會從頭來」,不能承諾「回來就好了」。
        -->
        <p class="kb-waiting__note">
          內容長的話可能要幾分鐘。<strong>可以先關掉這個視窗、甚至切去別的頁面做別的事</strong>——
          回到知識庫這一頁會自動接著整理，<strong>不會從頭重來</strong>（離開的期間會暫停在原地）。
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
          <template v-if="!siteSummary.failed && !siteSummary.warned">這些知識沒有經過逐條預覽，建議到知識庫抽幾條看看內容是否合用。</template>
        </div>
      </el-alert>

      <!--
        這批 AI 標了哪些產品名。整站匯入不逐頁預覽,產品名全由 AI 自己填了就進庫——
        同一台在不同頁被標成兩種寫法,客人指名問時就會被反問「您指的是哪一台」,
        而且要等到有人發現才修得掉。至少讓人在這裡看一眼、知道去哪改。
      -->
      <div v-if="siteFinished && siteProductNames.length" class="kb-site-products">
        <p class="kb-site-products__head">
          AI 幫這批標了 {{ siteProductNames.length }} 個產品名
          <span class="text-xs text-muted">（標錯的話，到左邊那份資料的「所屬產品」改）</span>
        </p>
        <div class="kb-site-products__list">
          <span v-for="p in siteProductNames" :key="p.name" class="kb-site-product">
            {{ p.name }}
            <span class="kb-site-product__count">{{ p.pages }} 頁</span>
            <span v-if="p.isNew" class="kb-site-product__new">新</span>
          </span>
        </div>
        <p v-if="siteProductNames.some(p => p.isNew)" class="kb-site-products__note">
          標「新」的是這個帳號第一次出現的名字。<strong>如果其中有跟現有產品是同一台、只是寫法不同</strong>，
          AI 會把它們當成兩台——請到「⋯ → 產品名稱整理」把它們併起來。
        </p>
        <p v-if="siteProductsUnnamed" class="kb-site-products__note">
          另有 {{ siteProductsUnnamed }} 頁沒認出產品（多產品或非產品頁面就是正常的）。
        </p>
      </div>

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
      <!-- 條數只在下面的摘要區講一次(原本這裡「N 條知識」、下面「N 條問答」同一個數字兩種單位);
           也不能在這裡教人「勾選要匯入的」——清單預設收起,畫面上根本沒有勾選框。只留截斷警告。 -->
      <p v-if="truncated" class="kb-section-hint">
        <span class="kb-warning">原文超過 10 萬字已截斷，可能漏掉後半部。</span>
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

      <!-- 產品名（P1-1）：AI 自動偵測預填、使用者可改。空 = 非單一產品資料（FAQ、公告等）。
           欄位改成「可挑現成的」：手打是同一台被當成兩台的源頭（見 ProductNameField）。 -->
      <div v-if="sourceMeta.type !== 'gsheet'" class="kb-source-name-row">
        <span class="kb-source-name-label">所屬產品</span>
        <KnowledgeProductNameField
          v-model="sourceMeta.productName"
          size="small"
          placeholder="這份內容都在講同一個產品時才填（含品牌與型號）"
          :show-hint="false"
          class="kb-source-name-input"
        />
      </div>
      <p v-if="sourceMeta.type !== 'gsheet'" class="kb-section-hint">
        {{ sourceMeta.productName ? 'AI 判斷這份內容屬於這個產品，知識會自動標上產品名，客人指名問時才不會答錯台。不對可以直接改——同一台請從下拉挑現成的名字，自己重打一次容易被當成兩台。' : '點一下可以挑已經在用的產品；內容涵蓋多個產品或非產品內容（FAQ、公告）時留空即可。' }}
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
        <div class="text-xs">辨識可能有錯漏（尤其數字、價格、電話），請逐條確認內容正確再匯入。</div>
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

      <!-- 有勾「多樣商品」卻沒做出總表時要講一句:不講的話,勾了的人在這頁找不到總表,
           只會以為勾了沒用、或系統壞了 -->
      <p v-else-if="generateOverview" class="kb-section-hint">
        有勾「多樣商品」，但 AI 沒能從這份內容做出「我們有賣什麼」的總表（看起來不是商品清單）；下面這些一般問答不受影響。
      </p>

      <!-- 摘要 + 主動作先行:預設就是全選,所以「直接匯入」才是主路徑。
           原本一律攤開 N 條、主按鈕在最底部,50 張要捲上萬像素才按得到,
           結果沒人真的逐張審、只是捲——審核變成儀式。 -->
      <div class="kb-preview-summary">
        <p class="kb-preview-summary__head">
          AI 整理出 <strong>{{ chunks.length }}</strong> 條問答<template v-if="includedCount !== chunks.length">，目前選了 {{ includedCount }} 條</template>
        </p>
        <!--
          「建議展開確認」原本只是一句話:按下去攤開的是全部幾十條,要自己一條條找哪幾條有數字。
          該看的就是這幾條——直接讓這句話帶你到它們面前。
        -->
        <button
          v-if="numericChunkCount"
          type="button"
          class="kb-preview-summary__warn kb-preview-summary__warn--action"
          @click="showNumericOnly"
        >
          其中 <strong>{{ numericChunkCount }}</strong> 條含金額或數字（價格、期限最容易看錯）——
          <span class="kb-preview-summary__warn-cta">只看這幾條 →</span>
        </button>
        <div class="kb-preview-summary__actions">
          <!-- 重做清單跑到一半時擋住匯入:按下去會把「即將被取代的那一份」寫進知識庫 -->
          <el-button
            type="primary"
            :loading="importing"
            :disabled="includedCount === 0 || previewing"
            @click="runImport"
          >
            {{ importing ? '匯入並學習中⋯' : `直接匯入 ${includedCount} 條` }}
          </el-button>
          <el-button text @click="chunkListOpen = !chunkListOpen">
            {{ chunkListOpen ? '收起逐條檢查' : '先逐條檢查' }}
          </el-button>
          <el-button text @click="backToInput">← 換一份重新整理</el-button>
        </div>
      </div>

      <!--
        第一步那個勾選是在「還沒看到任何東西」時問的,答不出來很正常。
        整理完條數這麼多,這裡才有依據主動問一次——而且要老實講這會再花一次 AI 用量。
      -->
      <div v-if="suggestOverview || redoingOverview" class="kb-overview-suggest">
        <!-- 重做中:等待畫面在第一步,這裡看不到,所以進度要自己講(不然按下去像沒反應) -->
        <template v-if="redoingOverview">
          <p class="kb-overview-suggest__text">{{ previewProgressText }}</p>
          <div class="kb-overview-suggest__actions">
            <el-button size="small" text @click="cancelPreview">取消，保留原本的整理結果</el-button>
          </div>
        </template>
        <template v-else>
          <p class="kb-overview-suggest__text">
            這份整理出 <strong>{{ chunks.length }}</strong> 條，看起來列了很多樣商品。
            要不要再做一張「我們有賣什麼」的清單？客人問「你們有賣哪些東西」時才能一次答完，不會被反問。
          </p>
          <div class="kb-overview-suggest__actions">
            <el-button size="small" type="primary" plain @click="redoWithOverview">
              重新整理並加上清單
            </el-button>
            <el-button size="small" text @click="overviewSuggestDismissed = true">不用，直接匯入</el-button>
            <span class="text-xs text-muted">會請 AI 再讀一次這份資料（算一次用量），目前這些整理結果會重做。</span>
          </div>
        </template>
      </div>

      <div v-show="chunkListOpen" class="kb-bulk-actions">
        <!-- 篩選中時按鈕只作用在看得到的那幾條,標籤要講明白(見 visibleForBulk) -->
        <el-button size="small" plain @click="selectAll">
          {{ previewFilter === 'numeric' ? '全選這幾條' : '全選' }}
        </el-button>
        <el-button size="small" plain @click="selectNone">
          {{ previewFilter === 'numeric' ? '全不選這幾條' : '全不選' }}
        </el-button>
        <span class="text-muted text-xs">已選 {{ includedCount }} / {{ chunks.length }}</span>
        <!-- 篩選中一定要講清楚「現在沒看到全部」,否則會以為 AI 只整理出這幾條 -->
        <template v-if="previewFilter === 'numeric'">
          <span class="kb-filter-note">目前只顯示含金額或數字的 {{ numericVisibleCount }} 條</span>
          <el-button size="small" text type="primary" @click="previewFilter = 'all'">看全部 {{ chunks.length }} 條</el-button>
        </template>
      </div>

      <div v-show="chunkListOpen" class="kb-chunk-list">
        <!-- 用 v-show 而不是先過濾陣列:標籤/問法的編輯狀態是綁 idx 的,
             換成過濾後的索引會編到別條去 -->
        <div
          v-for="(chunk, idx) in chunks"
          v-show="previewFilter === 'all' || hasNumber(chunk.content)"
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
import { PREVIEW_JOB_DEADLINE } from '~/composables/usePreviewJobPoll'

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
  /**
   * 這份匯入工作現在的狀態,讓父層在視窗關著時也能顯示「還在整理／整理好了」。
   * 沒有這個訊號的話,關掉視窗去做別的事的人回來只會看到一片乾淨畫面(見 resumeStoredJob 的說明)。
   */
  'job-state': [state: 'running' | 'ready' | 'none']
}>()


const { apiFetch, workspaceId } = useWorkspace()
const { showToast } = useAdminToast()
// 產品名候選(與「所屬產品」欄位共用同一份快取):整站匯入結束要分辨哪些名字是這批新增的
const {
  known: knownProductNamesPool,
  ready: productNamesReady,
  load: loadProductNames,
  invalidate: invalidateProductNames,
} = useProductNames()

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
  /** AI 幫這一頁標的產品名(整站匯入不逐頁預覽,結束後要列出來讓人看過) */
  productName: string
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
 * 這批 AI 各自標了哪些產品名。
 *
 * 整站匯入是一次幾十頁、**不經逐頁預覽直接建庫**——也就是變體產品名最大的入口:
 * 同一台被 AI 在不同頁標成兩種寫法,之後客人指名問就會被反問「您指的是哪一台」。
 * 單頁匯入的欄位改成可挑現成的擋不到這條路,所以結束後至少要把結果攤開來讓人看過。
 * 「新」= 這次之前這個帳號沒有用過的名字(要多看一眼的就是這些)。
 */
const knownProductNames = ref<Set<string>>(new Set())
/**
 * 開始匯入前「現有產品清單」有沒有真的讀到。
 * 讀不到卻照樣標「新」的話，畫面會把每一個產品都說成第一次出現、還請人去合併——
 * 「查不到就等於沒有」是本專案踩過的假綠燈。
 */
const knownProductNamesReady = ref(false)
const siteProductNames = computed(() => {
  const m = new Map<string, number>()
  for (const p of sitePages.value) {
    if (p.status !== 'done' || !p.productName) continue
    m.set(p.productName, (m.get(p.productName) ?? 0) + 1)
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, pages]) => ({
      name,
      pages,
      isNew: knownProductNamesReady.value && !knownProductNames.value.has(name),
    }))
})
/** 有頁面成功、卻一個產品名都沒認出來時不顯示這一區(FAQ、公告類的網站本來就沒有) */
const siteProductsUnnamed = computed(() =>
  sitePages.value.filter(p => p.status === 'done' && !p.productName).length)
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
    productName: '',
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
  // 取消旗標是整支輪詢共用的:上一次按過「取消整理」的話它還立著,
  // 不先清掉,這批每一頁都會在第一次輪詢就被當成已取消而全部標失敗
  resetJobPoll()

  // 記下「這次之前已經有哪些產品名」,結束才分得出哪些是這批新冒出來的。
  // ⚠️ 兩件事:
  //  · 要在 siteImporting 立起來之後才 await——這中間關窗的話,收尾那條路(onDialogClose)
  //    會以為沒有批次在跑而不做收拾,已經建好的資料就不會出現在列表上。
  //  · 同一次開窗跑第二批時**不重抓**:重抓的話第一批剛加進去的名字會變成「本來就有」,
  //    第二批的面板就不會標它們是新的——同一段說明在兩批之間自相矛盾。
  if (!knownProductNamesReady.value) {
    await loadProductNames()
    // 用 known（含已經合併掉的舊叫法）而不是下拉那份收斂清單:
    // 拿收斂清單比對的話,AI 標出一個「已經確認過是同一台」的舊叫法會被說成新的,
    // 又叫使用者去合併一次他早就處理過的東西
    knownProductNames.value = new Set(knownProductNamesPool.value)
    knownProductNamesReady.value = productNamesReady.value
  }

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
        page.productName = res.suggestedProductName ?? ''
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
  invalidateProductNames() // 這批標的產品名已經進了後端清單,下次開欄位要挑得到
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
function hasNumber(content: string) {
  return /\d/.test(content)
}
/** 「其中 N 條含金額」講的是**這次會匯入的**——沒勾的不會進庫,不需要檢查 */
const numericChunkCount = computed(() =>
  chunks.value.filter(c => c.included && hasNumber(c.content)).length,
)
/**
 * 篩選後畫面上實際看得到的條數。與上面那個數字刻意不同：
 * 篩選是照「含不含數字」濾,沒勾的也留在畫面上(不然在這裡取消勾選,那一列會當場消失)。
 * 兩個數字混用的話會出現「說 7 條卻列出 10 列」。
 */
const numericVisibleCount = computed(() => chunks.value.filter(c => hasNumber(c.content)).length)

/**
 * 逐條檢查時的顯示範圍。'numeric' = 只看含金額或數字的那幾條。
 * 「建議展開確認數字」原本要人自己在幾十條裡找出哪幾條有數字——該看的既然算得出來,
 * 就直接把人帶到它們面前(這與 OCR 提醒「請逐張確認數字、價格」是同一件事)。
 */
const previewFilter = ref<'all' | 'numeric'>('all')
function showNumericOnly() {
  previewFilter.value = 'numeric'
  chunkListOpen.value = true
}

/**
 * 「要不要順便做一張『我們有賣什麼』的清單」——整理完才問得出來的那一次。
 *
 * 第一步的勾選是在還沒看到任何內容時問的（「這份資料裡有很多樣商品嗎」），
 * 第一次用的人根本答不出來，勾錯的代價是客人問「你們賣什麼」時 AI 只能反問。
 * 條數多＝列了很多樣東西，這是我們手上唯一真的訊號，就在這時候問。
 *
 * 條件要嚴：接受重做等於再花一次 AI 用量，寧可少問也不要亂問。
 * 只在「原本的輸入還在」時出現——接回上一份工作時輸入框是空的，重做會直接失敗。
 */
const OVERVIEW_SUGGEST_MIN_CHUNKS = 8
const overviewSuggestDismissed = ref(false)
const suggestOverview = computed(() =>
  !overviewSuggestDismissed.value
  && !overviewCard.value
  && !generateOverview.value
  && chunks.value.length >= OVERVIEW_SUGGEST_MIN_CHUNKS
  && (sourceMeta.value.type === 'url' || sourceMeta.value.type === 'file')
  && canPreview.value)

/**
 * 重做一次（這次加上清單）。
 *
 * ⚠️ 刻意**不切回第一步**：切回去的話，失敗時會停在空白的輸入畫面，
 * 而剛才那份已經整理好、也已經計過用量的結果就再也回不去了——等於要人付第三次錢。
 * 留在預覽頁重跑：成功才會被新結果取代，失敗的話原本那份還在，可以直接匯入。
 */
const redoingOverview = ref(false)
/** applyPreviewResult 每跑一次就加一。用「有沒有換成新的一份」判斷成敗，比逐一列舉失敗原因可靠 */
const previewRevision = ref(0)

async function redoWithOverview() {
  const before = previewRevision.value
  redoingOverview.value = true
  generateOverview.value = true
  try {
    await runPreview()
  }
  finally {
    redoingOverview.value = false
  }
  // 沒有換成新的一份（取消／失敗／這次 AI 一條都沒切出來）→ 原本那份完好無缺，
  // 把狀態退回去讓人可以直接匯入或再試一次。
  // 用版本號而不是逐一判斷失敗原因：runPreview 的提早結束出口不只一個，
  // 漏掉哪一個就會把失敗當成成功、還把「要不要做清單」的設定留在開啟狀態。
  if (previewRevision.value === before) {
    generateOverview.value = false
    if (previewError.value) {
      showToast(`${previewError.value}（原本整理好的內容還在，可以直接匯入）`, 'error')
      previewError.value = ''
    }
    return
  }
  overviewSuggestDismissed.value = true // 問過了就不再問(即使這次 AI 沒做出清單)
}

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

/**
 * 「先關掉視窗去做別的事」的續接記號。
 *
 * 等待畫面一直寫著「可以先關掉這個視窗、回來就看得到結果」,但 jobId 原本只活在記憶體裡:
 * 同一頁關掉視窗再打開沒問題(元件沒被卸載),**一換頁或重整就整個消失**——而「去做別的事」
 * 最自然的動作就是切去對話頁回客人。使用者回來看到一片乾淨畫面,只能重傳一次,
 * 大檔的 OCR + 切卡 + embedding 整套重跑重收費(伺服器那份工作其實還活著,只是沒人來認領)。
 *
 * 所以把 jobId 落地。後端 job 存活 1 小時且完成後仍可重取結果(見 preview-jobs/[jobId].get.ts),
 * 這裡留餘裕抓 55 分鐘;過期或撿不到就靜靜清掉,不打擾使用者。
 *
 * ⚠️ 伺服器端的工作**只有在有人輪詢時才會前進**(輪詢兼推進)。所以離開期間不會有進度,
 * 回來才接著跑——文案要照這個事實寫,不能承諾「回來就好了」。
 */
const JOB_MARKER_TTL_MS = 55 * 60 * 1000
interface JobMarker { jobId: string, startedAtMs: number, mode: ImportMode }

function jobMarkerKey(): string {
  return `kb-import-job:${workspaceId.value ?? ''}`
}

function saveJobMarker(jobId: string, m: ImportMode) {
  try {
    localStorage.setItem(jobMarkerKey(), JSON.stringify({ jobId, startedAtMs: Date.now(), mode: m } satisfies JobMarker))
  }
  catch { /* 無痕模式等寫不進去:接不回來而已,不影響這一輪匯入 */ }
}

function clearJobMarker() {
  try {
    localStorage.removeItem(jobMarkerKey())
  }
  catch { /* 同上 */ }
}

function readJobMarker(): JobMarker | null {
  try {
    const raw = localStorage.getItem(jobMarkerKey())
    if (!raw) return null
    const m = JSON.parse(raw) as JobMarker
    if (!m?.jobId || typeof m.startedAtMs !== 'number') return null
    if (Date.now() - m.startedAtMs > JOB_MARKER_TTL_MS) {
      clearJobMarker()
      return null
    }
    return m
  }
  catch {
    return null
  }
}

/**
 * 父層(資料頁)靠這個訊號在視窗關著時顯示「還在整理／整理好了」。
 * 沒有它的話,關掉視窗的人得自己記得回來點「加入知識」才看得到——正是原本會被誤認為
 * 「系統把我的東西弄丟了」的那一段。
 */
const jobState = computed<'running' | 'ready' | 'none'>(() => {
  if (previewing.value) return 'running'
  if (step.value === 'preview' && chunks.value.length > 0) return 'ready'
  return 'none'
})
watch(jobState, v => emit('job-state', v), { immediate: true })

/** 回到第一步(換一份重新整理)＝放棄目前這份工作,記號要跟著清掉 */
function backToInput() {
  clearJobMarker()
  step.value = 'input'
}

/** 進頁面時撿回上一次沒看完的整理工作;撿不到就當沒這回事(不跳任何錯誤) */
async function resumeStoredJob() {
  const marker = readJobMarker()
  if (!marker) return
  previewing.value = true
  previewError.value = ''
  previewCancelled = false
  resetJobPoll()
  try {
    const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(marker.jobId)
    // 這段可能跑好幾分鐘,期間使用者早就去做別的事了(挑整站頁面、跑批次匯入、開始另一份整理)。
    // 這時把畫面切到預覽等於半路搶走他正在做的事——記號留著,下次進來再接。
    if (siteImporting.value || step.value !== 'input') return
    if (!res.chunks.length) {
      clearJobMarker()
      return
    }
    applyPreviewResult(res, marker.mode)
    step.value = 'preview'
  }
  catch (err: any) {
    if (previewCancelled) return // 使用者自己按了取消
    // 等太久:伺服器那份工作還活著,記號留著下次進來再接。這次不出聲——
    // 使用者只是打開了知識庫,沒有要求任何事,不該迎面丟一個錯誤給他
    if (err?.code === PREVIEW_JOB_DEADLINE) return
    const code = Number(err?.statusCode ?? err?.data?.statusCode ?? 0)
    // 過期 / 被清掉 / 不是這個租戶的 → 記號沒用了,靜靜丟掉
    if (code === 404 || code === 403) {
      clearJobMarker()
      return
    }
    // 其他錯誤留在畫面上:等了很久的人至少知道發生什麼事、可以再試一次
    previewError.value = String(
      err?.data?.statusMessage || err?.statusMessage || err?.message || '接續整理失敗',
    ).slice(0, 300)
    clearJobMarker()
  }
  finally {
    previewing.value = false
    resetJobPoll()
  }
}

onMounted(() => { void resumeStoredJob() })

/** 逾時/失敗的訊息（留在畫面上，不用會自己消失的 toast） */
const previewError = ref('')
/** 使用者主動取消：用來區分「取消」與「真的失敗」，取消不該顯示錯誤 */
let previewCancelled = false

/**
 * 把整理結果攤進預覽畫面。第一次整理與「接回上次那份」共用同一份,
 * 兩邊各寫一次的話,之後補欄位只改到一邊,接回來的那份就會少東西。
 *
 * srcMode 要另外傳:接回來的時候輸入框是空的,mode(由輸入內容衍生)已經不是當初那個,
 * 拿它當來源類型會把網頁存成「一段文字」。
 */
function applyPreviewResult(res: PreviewResult, srcMode: ImportMode) {
  previewRevision.value++ // 呼叫端據此判斷「這一輪真的換成新的一份了嗎」
  previewFilter.value = 'all' // 新的一份從完整清單開始看
  overviewSuggestDismissed.value = false
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
    type: srcMode,
    name: res.sourceName,
    url: res.sourceUrl,
    productName: res.suggestedProductName ?? '',
    contentHash: res.contentHash ?? '',
  }
}

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
      // 上傳可能跑好幾秒:期間按了取消就到此為止,不要再去建一份沒人要的整理工作。
      // （下面的 reset 只是把「上傳檔案」的進度數字清掉，之後才進輪詢階段）
      if (previewCancelled) return
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
    // 上傳大檔那段可能跑好幾秒,期間按了取消就別再往下建工作(否則會留下一份沒人要的記號)
    if (previewCancelled) return
    // 記號要在開始等之前就落地:最需要接回來的正是「等很久所以跑去做別的事」那一種
    saveJobMarker(created.jobId, mode.value)
    const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(created.jobId)

    // 輪詢回來之後也要再確認一次:取消旗標是在 await 期間被設起來的
    if (previewCancelled) return

    if (!res.chunks.length) {
      clearJobMarker()
      showToast('AI 沒有切出任何有意義的知識；請改貼文字或檢查資料內容', 'error')
      return
    }

    applyPreviewResult(res, mode.value)
    step.value = 'preview'
  }
  catch (err: any) {
    if (previewCancelled) return // 使用者自己按取消,不是錯誤(記號已在 cancelPreview 清掉)
    // 等太久 ≠ 失敗:逾時的時候伺服器那份工作還活著,記號留著讓人下次進來接著跑;
    // 真的失敗(伺服器已標 error)才清掉——留著只會在下次進頁面時再報一次同一個錯。
    if (err?.code !== PREVIEW_JOB_DEADLINE) clearJobMarker()
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
  // ⚠️ 這裡**不可以**接著 resetJobPoll():reset 會把剛設好的取消旗標清成 false,
  //    正在跑的輪詢就照樣跑到底、照樣把結果蓋上畫面——按了取消卻什麼也沒取消。
  //    旗標留著,下一次 runPreview 開頭本來就會 reset。進度條只清畫面上的數字。
  jobProgress.value = null
  clearJobMarker() // 自己按取消 = 不要這份了,別在下次進頁面時又冒出來
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
// 只作用在**畫面上看得到的**那幾條:篩選「只看含數字的 8 條」時按全不選,
// 卻把沒顯示的 52 條一起取消,是使用者完全預期不到的破壞。
function visibleForBulk() {
  return previewFilter.value === 'numeric'
    ? chunks.value.filter(c => hasNumber(c.content))
    : chunks.value
}
function selectAll() {
  for (const c of visibleForBulk()) c.included = true
}
function selectNone() {
  for (const c of visibleForBulk()) c.included = false
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
  if (selected.length > 150) return showToast('單次最多匯入 150 條，請先取消勾選一些', 'error')

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
    clearJobMarker() // 卡已經進庫了,這份整理工作到此為止
    invalidateProductNames() // 這份資料的產品名已經進後端清單,下次填欄位要挑得到
    // 全部成功直接關窗(關窗 handler 會通知父層刷新並選中新資料);
    // 有失敗才停在結果頁,讓使用者看到哪幾張失敗、原因是什麼
    if (res && res.failed === 0) {
      showToast(`成功匯入 ${res.indexed} 條`, 'success')
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
  clearJobMarker()
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
  chunkListOpen.value = false
  previewFilter.value = 'all'
  overviewSuggestDismissed.value = false
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
  // 下一次開窗要重新抓一次「原本有哪些產品名」當基準
  knownProductNames.value = new Set()
  knownProductNamesReady.value = false
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

</script>
