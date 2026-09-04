<template>
  <el-dialog
    :model-value="modelValue"
    width="min(760px, 92vw)"
    :close-on-click-modal="false"
    :before-close="onBeforeClose"
    class="kb-import-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @close="onDialogClose"
  >
    <!--
      標題旁的「這頁怎麼用」（2026-09-03）。刻意跟**頁首那顆問號長得一模一樣**
      （沿用 `.page-help` / `.page-help-btn`）——同一個後台裡「問號＝在真實畫面上帶我走一遍」
      只能有一種樣子（⛔不發明第七種教學機制，見 `D-39` 拍板）。
      差別只在它跑的是**視窗裡面**那幾步：視窗已經開著，所以用 startAdHocTour 而不是整支主題，
      並把 `clickBefore` 拿掉（那顆「加入知識」按鈕現在在遮罩後面）。
      ⚠️ `el-tour` 的 z-index 是 3000、對話框約 2001，所以聚光燈蓋得上來。
    -->
    <template #header="{ titleId, titleClass }">
      <span :id="titleId" :class="titleClass" class="kb-import-title">
        加入知識
        <span class="page-help">
          <el-tooltip content="在畫面上帶我走一遍" placement="bottom">
            <el-button
              class="page-help-btn"
              text
              size="small"
              :icon="QuestionFilled"
              aria-label="在畫面上帶我走一遍"
              @click="startDialogTour"
            />
          </el-tooltip>
        </span>
      </span>
    </template>
    <!-- ── Step 1:一個投放區,自動判別是什麼(P1-2) ─────────── -->
    <!--
      拖放handler掛在整個第一步而不是只掛投放框（2026-09-03 UI 打磨）：
      檔案拖歪一點（掉在說明文字或按鈕上）原本會被瀏覽器**整頁打開檔案**，
      這個視窗連同貼到一半的內容整個消失。掛在外層＝視窗內任何地方放開都算數。
      ⛔ 投放框自己不再掛 drop：drop 事件會冒泡，兩層都掛等於 onDrop 跑兩次
        （拒收的 toast 會連跳兩次）。
    -->
    <div
      v-if="step === 'input'"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>把資料交給 AI 整理</p>

      <!-- 拖放 + 貼上同一區:不用先決定「我該用哪一種」 -->
      <!-- 點框裡任何空白處＝把游標放進輸入框：整塊就是「一個輸入」的心智模型 -->
      <div
        class="kb-drop"
        :class="{ 'kb-drop--over': dragOver, 'kb-drop--filled': !!detected }"
        data-tour="kb-drop"
        @click="focusPaste"
      >
        <template v-if="selectedFile">
          <div class="kb-drop__file">
            <span class="kb-drop__filename">{{ fileName }}</span>
            <span class="text-xs text-muted">{{ fileSizeKb.toLocaleString('zh-TW') }} KB</span>
            <el-button v-if="!previewing" size="small" text @click="clearFile">換一個</el-button>
            <span v-else class="text-xs text-muted">正在整理這一份</span>
          </div>
        </template>
        <template v-else>
          <!-- 整理中要鎖住（`D-41` 死路⑪）：原本整理跑到一半還能換檔案／改內容，
               畫面顯示的是新檔名、實際在整理的卻是舊的那份（runPreview 早就把檔案抓走了）。 -->
          <el-input
            ref="pasteInputEl"
            v-model="pasteInput"
            type="textarea"
            :rows="4"
            :maxlength="100000"
            resize="none"
            :disabled="previewing"
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
            <el-button size="small" plain :disabled="previewing" @click="fileInputEl?.click()">選擇檔案</el-button>
            <span class="text-xs text-muted">{{ previewing ? '正在整理這一份，先不能換——要換請按上面的「取消」' : 'PDF / Excel，也可以直接拖進框裡（單檔 10MB 內）' }}</span>
          </div>
        </template>
      </div>

      <!-- 判別結果:先講「這是什麼」,再講唯一真正要知道的差異(會不會自動更新) -->
      <div v-if="detected" class="kb-detected" :class="`kb-detected--${detected.syncTone}`">
        <p class="kb-detected__head">
          <span class="kb-detected__label">{{ detected.label }}</span>
          <span class="kb-detected__sync">{{ detected.sync }}</span>
          <button type="button" class="kb-detected__more" @click="hintOpen = !hintOpen">
            {{ detected.hintLabel }}
          </button>
        </p>
        <p v-if="hintOpen" class="kb-detected__hint">{{ detected.hint }}</p>

        <!--
          Google 試算表要先分享才讀得到。⛔別只留說明文字：「分享好了沒」原本要按下
          「先看 AI 整理的結果」才知道，沒弄好的人先吃一次紅字、回 Google 重弄、再回來按一次
          ——第一次匯入最容易卡死的就是這一段（`D-50` 簡化 4）。現在貼上就去實際讀一次。
        -->
        <div v-if="mode === 'gsheet'" class="kb-gsheet-share">
          <p v-if="gsheetProbing" class="kb-gsheet-share__state">正在確認我讀不讀得到⋯</p>
          <p
            v-else-if="gsheetProbe"
            class="kb-gsheet-share__state"
            :class="gsheetProbe.status === 'ok' ? 'is-ok' : 'is-blocked'"
          >
            {{ gsheetProbe.status === 'ok' ? '✓' : '✗' }} {{ gsheetProbe.message }}
          </p>
          <!-- 綠勾之後就不必再看分享說明了(事情已經做完);其餘狀態一律附上帳號與重測鈕 -->
          <template v-if="gsheetProbe?.status !== 'ok'">
            <!-- ⚠️ 重測鈕不可以藏在「拿得到服務帳號」的條件裡（2026-09-03 code review 抓到）：
                 gsheet-account 那支在開窗時失敗（靜默）的話，畫面就只剩一句「請共用給下面這個帳號」
                 下面什麼都沒有、也沒有重測鈕＝死路。帳號改用探測回傳的那份當備援。 -->
            <div class="kb-gsheet-share__row">
              <code v-if="shareEmail" class="kb-gsheet-email">{{ shareEmail }}</code>
              <span v-else class="text-xs text-muted">（讀不到服務帳號，請重新整理頁面或聯絡我們）</span>
              <el-button v-if="shareEmail" size="small" text type="primary" @click="copyServiceEmail">複製</el-button>
              <el-button size="small" :loading="gsheetProbing" @click="probeGsheet(gsheetInput.trim(), true)">
                分享好了，再測一次
              </el-button>
            </div>
            <p v-if="gsheetProbe?.detail" class="kb-gsheet-share__detail">{{ gsheetProbe.detail }}</p>
          </template>
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

      <!--
        ── 「還沒有現成資料？」三條路（2026-09-03，老闆看到簡化後的第一步說「不知道怎麼做」）──

        為什麼要加回文字：簡化 1 拿掉「這是多樣商品清單嗎」那個**答不出來的問題**是對的，
        但同一輪把「我該做什麼」也一起拿掉了——剩下的畫面只回答「我們收哪些格式」，
        對「手邊什麼都還沒整理」的人是一片空白。⚠️這兩種文字不是同一件事：
        前者要人替 AI 做判斷（拿掉），後者是告訴人下一個動作（要留）。

        ⛔ 只在投放框還空的時候出現（`v-if="!detected"`）：貼上內容之後畫面必須回到
           「這是什麼＋一顆按鈕」那個乾淨狀態，不可以把簡化 1 的成果吃回去。
        ⛔ 每一條都要寫「準備時間」與「之後改了會不會自動更新」：那是三條路唯一真正的差別，
           不寫的話使用者只能憑感覺猜，而猜錯的代價是整份資料要重做一次。
      -->
      <!--
        ── 「還沒有現成資料？」三條路・二版（2026-09-03，老闆實測「光要讀完就快 fade out」）──

        一版把三條路的完整說明同時攤開（約 250 字）。說明本身沒錯，錯在**要人一次讀完
        三條才能挑一條**。二版把「讀」改成「點」：預設只有一行標題＋三顆選項，
        點了哪條才展開哪條，而且展開後每一步盡量是**可以按的動作**（下載範本、傳回檔案、
        複製帳號），不是要照著讀的文字。
        ⛔ 投放框永遠在最上面、不因為選了哪條而消失：熟手直接貼，這一塊只給
           「不知道從哪開始」的人，不是流程的一部分（「不用先選種類」的設計不變）。
        ⛔ 展開狀態刻意**不在關窗時重設**（resetAll 也不清）：走試算表那條的人會中途
           去 Google 分享，回來時面板要還開著、帳號還在眼前——收起來等於叫他重想一次
           剛剛做到哪。
      -->
      <div v-if="!detected" class="kb-start">
        <p class="kb-start__head">還沒有現成資料？挑一條開始：</p>
        <div class="kb-start__chips" data-tour="kb-start">
          <button
            type="button"
            class="kb-start__chip"
            :class="{ 'is-active': startOpen === 'web' }"
            :aria-expanded="startOpen === 'web'"
            @click="pickStart('web')"
          >
            貼官網現有的頁面<span class="kb-start__chip-tag">最快</span>
          </button>
          <button
            type="button"
            class="kb-start__chip"
            :class="{ 'is-active': startOpen === 'excel' }"
            :aria-expanded="startOpen === 'excel'"
            @click="pickStart('excel')"
          >
            用範本自己填<span class="kb-start__chip-tag">約 3 分鐘</span>
          </button>
          <button
            type="button"
            class="kb-start__chip"
            :class="{ 'is-active': startOpen === 'sheet' }"
            :aria-expanded="startOpen === 'sheet'"
            @click="pickStart('sheet')"
          >
            要「改了自動更新」<span class="kb-start__chip-tag">Google 試算表</span>
          </button>
        </div>

        <!--
          官網那條的「動作」就是貼網址：點選項時已順手把游標放進上面的框（見 pickStart）。
          ⚠️ 2026-09-03 老闆問「上傳網頁只適合用常見問題的頁面嗎」——不是，只要是**看得到文字**
             的頁面都吃（商品頁、運費退換貨、關於我們⋯）。原本標籤寫「官網有『常見問題』頁」
             把能力講窄了，等於誤教：沒有 FAQ 頁的店家會以為這條路不能用。
             真正的限制不是「哪一種頁面」，而是「抓不抓得到文字」，所以下面照實列兩種抓不到的。
        -->
        <div v-if="startOpen === 'web'" class="kb-start__panel">
          <!--
            ⚠️ 2026-09-03 三改。前一版是三段散文（約 130 字），而且「抓不到」那段**整句上琥珀色**
               ——整句著色等於整句在喊，讀者反而找不到重點（老闆：「這邊的文案能不能也調整過」）。
            改法：一行一件事，句子維持中性色，**顏色只留在最左邊那顆標籤上**
               （同 `.ls-status` 的房規：結論用色塊帶，內文不著色）。
            ⛔ 不要再把「一頁貼一次」這種操作常識寫進來：它不是決策資訊，
               而這一塊唯一的工作是回答「我的頁面能不能貼」。
          -->
          <p class="kb-start__ptxt kb-start__ptxt--lbl">
            <span class="kb-start__lbl kb-start__lbl--ok">可以貼</span>
            <span>商品或方案介紹、運費與退換貨、關於我們、公告——只要頁面上<strong>看得到文字</strong>就行，不限常見問題頁。</span>
          </p>
          <p class="kb-start__ptxt kb-start__ptxt--lbl">
            <span class="kb-start__lbl kb-start__lbl--no">抓不到</span>
            <span>要先登入、或要滑動、點按才長出內容的頁面（購物網站首頁的商品區多半是這種，改貼「商品列表頁」就好）。</span>
          </p>
          <p class="kb-start__ptxt kb-start__ptxt--dim">
            貼完會問你要不要把網站其他頁一起匯入；之後網頁改了也會通知你。
          </p>
        </div>
        <div v-else-if="startOpen === 'excel'" class="kb-start__panel">
          <!--
            ⚠️ 圖刻意放在清單**外面**（2026-09-03 老闆問「用範本自己填是否可以再更優化」）：
               第一版把它塞進第 1 步的 <li> 裡，圖把那一步撐成三倍高、第 2 步被推到很下面，
               於是「這條路只有兩個動作」這件事看不出來。現在先讓兩個動作一眼讀完，圖再補在後面。
          -->
          <ol class="kb-start__steps">
            <li>
              <el-button
                tag="a"
                href="/templates/faq-sheet-template.xlsx"
                target="_blank"
                rel="noopener"
                size="small"
                plain
              >
                下載 FAQ 範本
              </el-button>
              把答案填進去就好（欄位名稱已經填好，檔案裡還有一頁「<strong>使用說明</strong>」）
            </li>
            <li>
              <el-button size="small" plain :disabled="previewing" @click="fileInputEl?.click()">
                傳回填好的檔案
              </el-button>
              <span class="text-xs text-muted">（或直接拖進上面的框）</span>
            </li>
          </ol>
          <!-- --wide：這張很扁（880×132），吃滿面板寬字才讀得到（見 SCSS 的說明） -->
          <figure class="kb-shot kb-shot--wide">
            <img
              :src="SHOTS.gsheetTemplate"
              alt="範本的樣子：第一列是欄位名稱「客人會問的問題」與「答案」，下面每一列是一個問答"
              loading="lazy"
            >
            <figcaption>範本長這樣：<strong>第一列的欄位名稱已經填好</strong>，下面一列一題往下加就好</figcaption>
          </figure>
        </div>

        <div v-else-if="startOpen === 'sheet'" class="kb-start__panel">
          <!--
            2026-09-03 三版：**改用老闆拍的真截圖**（走既有截圖產線，見 `make-onboarding-shots.py`
            的 gsheet 區塊）。前一版是我憑記憶畫的示意圖，四處畫錯（欄位名、權限下拉位置、
            通知預設打勾、訊息框）——站外畫面就該用真截圖，這正是 08-28 拍板的分工。
            ⚠️ 圖上的①②③④跟這裡的文字是**同一套號碼**：改這裡的順序要一起改產線重跑，
               否則畫面上的③會指到別的動作，而且沒有任何測試會紅。
            ⛔ 每張圖緊貼它自己那一步（不要把三張圖堆在最後）：使用者是一步一步照做的。
          -->
          <ol class="kb-start__steps">
            <li v-if="faqTemplateCopyUrl">
              <el-button
                tag="a"
                :href="faqTemplateCopyUrl"
                target="_blank"
                rel="noopener"
                size="small"
                plain
              >
                用官方範本建立副本
              </el-button>
              <span class="text-xs text-muted">會在你的 Google 雲端硬碟建一份，欄位都填好了</span>
            </li>
            <li v-else>
              在 Google 試算表新開一份，第一列打<strong>「客人會問的問題」「答案」</strong>兩欄
            </li>
            <li>
              填完後按右上角<strong>「共用」</strong>，把這個帳號貼進去：
              <span v-if="shareEmail" class="kb-start__email">
                <code class="kb-gsheet-email">{{ shareEmail }}</code>
                <el-button size="small" text type="primary" @click="copyServiceEmail">複製</el-button>
              </span>
              <span v-else class="text-xs text-muted">（帳號讀取失敗，請重新整理頁面）</span>
              <figure class="kb-shot">
                <img
                  :src="SHOTS.gsheetShare1"
                  alt="Google 共用視窗最上面那一格，紅框標示要貼帳號的位置"
                  loading="lazy"
                >
                <figcaption><span class="kb-shot__n">1</span>貼在紅框那一格</figcaption>
              </figure>
            </li>
            <li>
              把權限從「編輯者」改成<strong>「檢視者」</strong>
              <figure class="kb-shot">
                <img
                  :src="SHOTS.gsheetShare2"
                  alt="貼上帳號後右邊出現權限下拉，預設是編輯者，紅框標示要改成檢視者"
                  loading="lazy"
                >
                <figcaption><span class="kb-shot__n">2</span>Google 預設給「編輯者」，改成「檢視者」就好</figcaption>
              </figure>
            </li>
            <li>
              按<strong>「傳送」</strong>（上面那個「通知共用對象」可以不勾）
              <figure class="kb-shot">
                <img
                  :src="SHOTS.gsheetShare3"
                  alt="共用視窗右下角，紅框標示傳送按鈕"
                  loading="lazy"
                >
                <figcaption><span class="kb-shot__n">3</span>按右下角的「傳送」</figcaption>
              </figure>
            </li>
            <li>把試算表的連結貼到上面的框——貼上時會<strong>當場告訴你讀不讀得到</strong></li>
          </ol>
        </div>
      </div>


      <!--
        ⛔ 這裡曾經有一個「這是一份多樣商品的清單嗎」的勾選框（配兩行說明），2026-09-03
           `D-50` 簡化 1 整塊移除。理由：那是在**還沒看到任何內容**時問的問題，第一次匯入的人
           根本答不出來（勾錯的代價是客人問「你們賣什麼」時 AI 只能反問），而它卻佔掉第一步
           近半個視窗。真正有依據回答的時機是「整理完、看到切出幾條」——那個機制本來就在
           （見 suggestOverview：條數多就主動問一次，並老實講會再花一次 AI 用量）。
           ⚠️ 所以 suggestOverview 的來源型別**不可以再縮**：勾選框沒了之後，它是總表唯一的入口。
      -->

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
          這段話要跟實際行為對得上,而行為已經換過兩輪:
          ① 最早寫「關掉視窗回來就看得到結果」——但工作編號只活在記憶體裡,換頁或重整就撿不回來。
          ② 編號落地之後改成「回來會接著跑」,並老實加註「離開的期間會暫停在原地」
             （因為整理只在有人輪詢時才前進）。
          ③ 2026-09-03（`D-50` 簡化 3）維護排程接手推進,那句附註才真的可以拿掉。
          ⛔ 別把「好了會通知你」寫成「馬上」:排程約十分鐘一輪,人真的走開時完成會慢一點。
        -->
        <p class="kb-waiting__note">
          內容長的話可能要幾分鐘。<strong>你可以直接去忙別的</strong>——關掉視窗、換頁都行，
          整理會<strong>在背景繼續</strong>，好了會在知識庫這一頁告訴你（不會從頭重來）。
        </p>
        <el-button size="small" text @click="cancelPreview">取消</el-button>
      </div>

      <!-- 逾時/失敗留在畫面上,不用 3.5 秒就消失的 toast:
           等了好幾分鐘的人只要沒盯著螢幕,回來會看到一片乾淨畫面、完全不知道發生什麼事 -->
      <el-alert
        v-if="previewError && !previewing"
        :type="previewStillRunning ? 'info' : 'error'"
        show-icon
        :closable="true"
        :title="previewError"
        style="margin-top: 12px"
        @close="previewError = ''"
      >
        <div v-if="previewStillRunning">
          可以關掉這個視窗去做別的事，整理完成後會出現在資料列表；這期間不用重傳，<strong>重傳會變成兩份同時在跑</strong>。
        </div>
        <div v-else>可以再試一次；內容很長的話，建議把文字分成幾段、分批貼進來。</div>
      </el-alert>

      <!--
        「這份已經匯過了」（`C-134`）。擋在整理**之前**＝沒有花 AI 的錢，也不會多一份重複。
        ⛔ 一定要給出路：擋住而沒有下一步，就是逼人改個名字再傳一次——那正是
        2026-09-04 同一本說明書在 MYFEEL 並存三份的成因。
      -->
      <el-alert
        v-if="duplicateHit && !previewing"
        type="warning"
        show-icon
        :closable="false"
        class="kb-dup-content"
      >
        <template #title>
          這份內容已經在知識庫裡了
        </template>
        <div class="kb-dedup-body">
          <p class="text-xs">
            跟「<strong>{{ duplicateHit.name }}</strong>」（{{ duplicateHit.chunkCount }} 條，{{ relativeTime(duplicateHit.updatedAtMs) || '未更新' }}）
            一字不差，所以先停在這裡——再整理一次會多出一份一模一樣的資料，AI 答題時會撈到兩份。
          </p>
          <div class="flex gap-1">
            <el-button size="small" type="primary" plain @click="openDuplicateSource">看那一份</el-button>
            <el-button size="small" text @click="retryIgnoringDuplicate">內容其實不一樣，重新整理一次</el-button>
          </div>
        </div>
      </el-alert>
    </div>

    <!-- ── Step 1.5:整站匯入 — 頁面清單勾選 ─────────────── -->
    <div v-if="step === 'sitePages'">
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>{{ siteFinished ? '整站匯入完成' : '選擇要匯入的頁面' }}</p>
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
          <!-- 已經建進庫、但 AI 還沒學起來的條數（`D-41` P1⑤）：不講的話這幾條就永遠沒人管，
               客人問到相關問題會找不到它們。到資料頁按「重新學習」就能修。 -->
          <template v-if="siteSummary.notLearned">
            其中 <strong>{{ siteSummary.notLearned }}</strong> 條 AI 還沒學起來（客人問到會找不到）——到左邊那份資料點開該條按「重新學習」即可。
          </template>
          <template v-if="siteSummary.failed">{{ siteSummary.failed }} 頁失敗（清單上有標原因，可重新勾選再試一次）。</template>
          <template v-if="siteSummary.warned">{{ siteSummary.warned }} 頁帶有提醒，建議進知識庫檢查這幾筆的內容。</template>
          <template v-if="!siteSummary.failed && !siteSummary.warned && !siteSummary.notLearned">這些知識沒有經過逐條預覽，建議到知識庫抽幾條看看內容是否合用。</template>
        </div>
      </el-alert>

      <!-- 整站匯入完成後也要講「客人聽不聽得到」（D-40，與結果頁交棒卡同一句話） -->
      <div v-if="siteFinished && siteSummary.ok && aiEnabled === false" class="kb-handoff is-off">
        <div class="kb-handoff__main">
          <p class="kb-handoff__title">知識進庫了，但客人現在還聽不到</p>
          <p class="kb-handoff__why"><strong>AI 客服還沒開啟</strong>，所以這些內容目前不會用在回覆客人上。開啟之後才會生效。</p>
        </div>
        <el-button size="small" type="primary" @click="goEnableAi">前往開啟</el-button>
      </div>

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
            <template v-else-if="p.status === 'done'">
              ✓ {{ p.cards }} 條<span v-if="p.notLearned" class="kb-site-status__warn">（{{ p.notLearned }} 條待學）</span>
            </template>
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
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>AI 整理的結果</p>
      <!--
        ── 結論先行（2026-09-03 `D-50` 簡化 2）────────────────────────────
        整理完的第一眼必須是「AI 整理出幾條」，不是兩個要填的欄位。
        名稱與所屬產品 **AI 都已經自動填好了**，所以收進這張卡的一行字、按「改」才展開；
        原本它們排在最上面、還各帶一行說明，第一次匯入的人看到的是「還有作業要交」。
        ⛔ 摘要卡從清單下方搬到這裡，順序就是它存在的理由——別再把任何欄位插到它前面。
      -->
      <div class="kb-preview-summary">
        <p class="kb-preview-summary__head">
          AI 整理出 <strong>{{ chunks.length }}</strong> 條知識<template v-if="includedCount !== chunks.length">，目前選了 {{ includedCount }} 條</template>
        </p>
        <p class="kb-preview-summary__meta">
          名稱：{{ sourceMeta.name || '未命名資料' }}<template v-if="sourceMeta.type !== 'gsheet'"> ・ 所屬產品：{{ sourceMeta.productName || '（無）' }}</template>
          <button type="button" class="kb-preview-summary__edit" @click="metaOpen = !metaOpen">
            {{ metaOpen ? '收起' : '改' }}
          </button>
        </p>
        <p v-if="truncated" class="kb-preview-summary__warn">
          原文超過 10 萬字已截斷，可能漏掉後半部。
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
          <!-- 重做清單跑到一半時擋住匯入:按下去會把「即將被取代的那一份」寫進知識庫。
               勾了總表時按鈕要把它算進去(見 importTotalLabel):按鈕說 20、結果頁說 21 是 `D-41` P0② -->
          <el-button
            type="primary"
            :loading="importing"
            :disabled="includedCount === 0 || previewing"
            @click="runImport"
          >
            {{ importing ? '匯入並學習中⋯' : importButtonLabel }}
          </el-button>
          <el-button text @click="chunkListOpen = !chunkListOpen">
            {{ chunkListOpen ? '收起逐條檢查' : '先逐條檢查' }}
          </el-button>
          <el-button text @click="backToInput">← 換一份重新整理</el-button>
        </div>
      </div>

      <!--
        名稱／所屬產品：預設收起（見上面那張卡的說明）。
        ⚠️ 有同名警告時**強制展開**——那句提醒叫人「改個名字」，收起來的話畫面上沒有東西可按。
      -->
      <div v-if="metaEditorOpen" class="kb-meta-editor">
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

        <!--
          放進哪個資料夾（`C-134`）。以前沒有這個欄位，所有匯進來的東西一律落在
          「未分類」，要靠人事後拖——實況是沒人記得拖，於是店家打開產品資料夾找說明書
          看到「沒有」，就再傳一次。這個欄位是那個災情的根治。
        -->
        <div v-if="folders?.length" class="kb-source-name-row">
          <span class="kb-source-name-label">放進資料夾</span>
          <el-select
            v-model="sourceMeta.folderId"
            size="small"
            clearable
            placeholder="未分類"
            class="kb-source-name-input"
            @change="folderAutoPicked = false"
          >
            <el-option v-for="f in folders" :key="f.id" :label="f.name" :value="f.id" />
          </el-select>
        </div>
        <p v-if="folders?.length" class="kb-section-hint">
          <!-- 猜的一定要講出來：不講的話「東西被放進某個資料夾」等於沒有人同意過 -->
          {{ folderAutoPicked
            ? '依名稱幫你選好了資料夾，不對可以直接改。'
            : '選了就直接歸到那個資料夾底下；留空會放在最上面的「未分類」，之後要自己拖進去。' }}
        </p>
      </div>

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
        <!--
          ⛔ 這裡原本唯一的建議是「改個名字」——照做的人就製造出第三份重複
          （2026-09-04 MYFEEL 同一本說明書並存三份、45 張重複卡，就是這樣長出來的）。
          人真正想做的事幾乎都是「我重傳了，用新的蓋掉舊的」，所以主要出口改成
          「更新這一份」；改名字降級成次要選項。
        -->
        <div class="kb-dedup-body">
          <p class="text-xs">你是要更新原本那一份，還是另外建一份？</p>
          <ul class="kb-dedup-list">
            <li v-for="m in dupMatches" :key="m.id" class="kb-dedup-row">
              <span>「{{ m.name }}」（{{ m.chunkCount }} 條，{{ relativeTime(m.updatedAtMs) || '未更新' }}）</span>
              <el-button
                v-if="canReplace(m)"
                size="small"
                type="primary"
                plain
                :disabled="replaceTarget?.id === m.id"
                @click="chooseReplaceTarget(m)"
              >
                {{ replaceTarget?.id === m.id ? '已選這份來更新' : '更新這一份' }}
              </el-button>
              <!-- 型別不同不給覆蓋（`C-139`）：講出「為什麼不能」，不要只是把按鈕藏起來 -->
              <span v-else class="text-xs text-muted">
                那份是{{ SOURCE_TYPE_LABEL[m.type ?? ''] ?? '別種' }}來源，不能用這份覆蓋
              </span>
            </li>
          </ul>
          <p class="text-xs">
            或者在上方「資料名稱」改個名字，另外建一份新的資料（這個提醒就會消失）。
          </p>
        </div>
      </el-alert>

      <!--
        已經選好要覆蓋哪一份：狀態要一直看得見，並且隨時退得回來。
        看不見的話，人按下匯入時不知道自己正在蓋掉東西——那是不可逆的誤會。
      -->
      <el-alert
        v-if="replaceTarget"
        type="info"
        show-icon
        :closable="false"
        class="kb-dedup-warning"
      >
        <template #title>
          會更新「{{ replaceTarget.name }}」，不會多一份
        </template>
        <div class="kb-dedup-body">
          <p class="text-xs">
            這份資料原本的 {{ replaceTarget.chunkCount }} 條知識會移到回收桶（30 天內都救得回來），
            換成這次整理好的內容。資料夾、同步設定都會留著。
          </p>
          <el-button size="small" text @click="replaceTarget = null">改成另外建一份新的</el-button>
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

      <!-- 要求重做總表、AI 卻做不出來時要講一句:不講的話,按了「重新整理並加上清單」的人
           在這頁找不到總表,只會以為按了沒用、或系統壞了 -->
      <p v-else-if="generateOverview" class="kb-section-hint">
        AI 沒能從這份內容做出「我們有賣什麼」的總表（看起來不是商品清單）；下面這些一般知識不受影響。
      </p>

      <!--
        「要不要順便做一張『我們有賣什麼』的清單」——整理完、看得到條數，才問得出來的那一次。
        第一步那個勾選框已經移除（見 suggestOverview），所以這裡是總表唯一的入口；
        而且要老實講這會再花一次 AI 用量。
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
          {{ importing ? '匯入並學習中⋯' : (replaceTarget ? importButtonLabel : `確認匯入 ${importTotalLabel}`) }}
        </el-button>
      </div>
    </div>

    <!--
      ── Step 3:結果＝交棒卡（D-40）──
      以前只有「部分失敗」才會停在這一頁,全成功是跳一句 toast 就關窗。
      但匯入成功正是使用者最想問「然後呢」的一刻,而那一刻的正確答案常常是
      「AI 總開關還關著,客人聽不到這些」——那句提醒過去只長在資料頁的待辦清單裡,
      匯完當下看不到。現在成功也停一下,把「進庫了幾條 / 客人聽不聽得到 / 要不要試問一題」
      講完再放人走。
    -->
    <div v-if="step === 'result' && result">
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>匯入結果</p>
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

      <!--
        蓋掉東西一定要講出來，而且要講「舊的去哪了」（`C-135`）。
        只報新的幾條、不提舊的幾條被換掉，等於讓人以為知識庫變多了。
      -->
      <p v-if="result.replacedChunks" class="kb-section-hint">
        這份資料原本的 <strong>{{ result.replacedChunks }}</strong> 條知識已換成上面這批；
        舊的移到<strong>回收桶</strong>，30 天內都救得回來。
      </p>

      <!--
        客人現在聽不聽得到這些內容。
        ⛔ aiEnabled 為 null（讀不到設定）時整塊不畫:寧可少講一句,也不要誤報「AI 沒開」
        害人跑去改一個本來就開著的開關（同 sources 頁 aiOff 待辦的判斷）。
      -->
      <div
        v-if="result.indexed > 0 && aiEnabled !== null"
        class="kb-handoff"
        :class="aiEnabled ? 'is-live' : 'is-off'"
      >
        <div class="kb-handoff__main">
          <p class="kb-handoff__title">
            <template v-if="aiEnabled">這 {{ result.indexed }} 條，客人問到就會用上</template>
            <template v-else>知識進庫了，但客人現在還聽不到</template>
          </p>
          <p class="kb-handoff__why">
            <template v-if="aiEnabled">AI 客服是開啟的。想確認 AI 真的學會了，可以在這裡直接試問一題。</template>
            <template v-else><strong>AI 客服還沒開啟</strong>，所以這些內容目前不會用在回覆客人上。開啟之後才會生效。</template>
          </p>
        </div>
        <el-button v-if="!aiEnabled" size="small" type="primary" @click="goEnableAi">前往開啟</el-button>
      </div>

      <!-- 試問一題:拿剛匯入的內容真的問一次(不進統計),答得出來才敢說「學會了」 -->
      <div v-if="result.indexed > 0 && verifyQuery" class="kb-handoff-verify">
        <el-button
          size="small"
          plain
          :loading="verifying"
          @click="runVerify"
        >
          {{ verifyOutcome ? '再試一次' : `試問一題：「${verifyQuery.slice(0, 16)}${verifyQuery.length > 16 ? '…' : ''}」` }}
        </el-button>
        <p v-if="verifyOutcome" class="kb-handoff-verify__out" :class="`is-${verifyOutcome.tone}`">
          {{ verifyOutcome.text }}
        </p>
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
import { QuestionFilled } from '@element-plus/icons-vue'
import { canReplaceSource, detectImportKind, GSHEET_PATTERN, HTTP_URL_PATTERN } from '~~/shared/knowledge-import-detect'
import { pickFolderForSource } from '~~/shared/knowledge-folder-match'
import { KB_IMPORT_DIALOG_STEPS } from '~/utils/tutorial-topics'
// 圖檔路徑的單一來源（同開通引導與修復劇本共用那份註冊表）
import { ONBOARDING_SHOTS as SHOTS } from '~/utils/onboarding-shots'
import { PREVIEW_JOB_DEADLINE } from '~/composables/usePreviewJobPoll'
// 型別要明寫（自動匯入只帶函式，不帶 type）
import type { KbVerifyOutcome } from '~/utils/kb-verify-outcome'

const props = defineProps<{
  modelValue: boolean
  /**
   * 父層的完整資料清單:同名警告要比對「全部」既有名稱——
   * 只比對 preview 回傳的(原始名稱的)同名清單,會漏掉「改名撞進另一個既有資料」的情況。
   */
  existingSources?: Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number; type?: string }>
  /**
   * 父層的資料夾清單：匯入時要能選「放進哪個資料夾」。
   * 沒有這個欄位的話，每一份匯進來的東西都掉在「未分類」，要靠人事後拖——
   * 而人不會記得（`C-134`：MYFEEL 的說明書因此躺在未分類，店家去產品資料夾找說「沒有」）。
   */
  folders?: Array<{ id: string; name: string }>
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
const { startAdHocTour } = useTutorial()

/**
 * 標題旁那顆問號：在**這個視窗裡**帶走一遍。
 * 步驟與「知識庫：建立與匯入」導覽共用 `KB_IMPORT_DIALOG_STEPS`（教材只一份）；
 * ⛔ 要把 `clickBefore` 拿掉——視窗已經開著，而那顆「加入知識」按鈕在遮罩後面，
 *    再點一次只會讓聚光燈去指一個蓋住的東西。
 */
function startDialogTour() {
  void startAdHocTour(KB_IMPORT_DIALOG_STEPS.map(step => ({ ...step, clickBefore: undefined })))
}
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
 * 「第幾步／共幾步」（D-40）。四種畫面卻沒有任何進度指示，而第一步可能要等好幾分鐘
 * ——等待畫面還明說「可以先關掉視窗去做別的事」，那就更該先講清楚全程有多長。
 * 判斷抽在 utils（有測試守著總數不會跳動）。
 */
const stepProgress = computed(() => kbImportStepProgress(step.value, { siteFinished: siteFinished.value }))
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

/**
 * 偵測結果：名稱 ＋ 那一句關鍵差異（會不會自動更新）＋ 收在展開裡的細節。
 *
 * 2026-09-03（`D-50` 簡化 1）：`sync` 砍成一句、細節移到 `hint`（預設收起、按 `hintLabel` 才展開）。
 * 原本貼完一個網址，畫面上一次冒出約 300 字——判別說明三行＋勾選題兩行＋整站詢問一行，
 * 而其中真正當下要做決定的只有「這是什麼、要不要順便匯整站」。
 * ⛔ 別把 `hint` 整段刪掉：那幾句是「抓不到內容」「數字要核對」唯一講清楚的地方，
 *    刪了就變成撞到才知道；要的是**分層**不是變少。
 */
const detected = computed(() => {
  if (selectedFile.value) {
    const excel = /\.(xlsx|xls)$/i.test(fileName.value)
    return {
      label: excel ? 'Excel 表格' : '檔案',
      sync: '上傳一次就固定，之後改了要重新上傳',
      syncTone: 'static' as const,
      hintLabel: '怎麼變成知識？',
      hint: excel
        ? '一列變成一條知識：第一欄當標題（例：商品名稱），其餘欄位當內容，第一列請放欄位名稱。想「改了自動更新」請改用 Google 試算表。'
        : '由 AI 判斷怎麼分段。用拍的、掃的檔案會由 AI 認字，請核對數字與價格有沒有看錯。想「改了自動更新」請改用 Google 試算表。',
    }
  }
  if (!pasteInput.value.trim()) return null
  if (mode.value === 'gsheet') {
    return {
      label: 'Google 試算表',
      sync: '你改試算表，AI 會定期自動跟著更新',
      syncTone: 'live' as const,
      hintLabel: '怎麼變成知識？',
      hint: '一列變成一條知識：第一欄當標題，其餘欄位當內容。第一欄請放看得懂的名字（例：商品名），不要放編號。你在後台手動改過的內容不會被蓋掉。',
    }
  }
  if (mode.value === 'url') {
    return {
      label: '網頁',
      sync: '抓當下內容；之後網頁改了會通知你',
      syncTone: 'semi' as const,
      hintLabel: '抓不到內容？',
      hint: '只抓網頁上的文字。需要先登入、或要按按鈕才顯示內容的頁面可能抓不到；商城首頁的商品區塊常是動態載入，請改貼商品列表頁。',
    }
  }
  // 字數留在永遠看得見的那一行（不收進展開）：貼上文字唯一會撞到的牆就是 10 萬字上限，
  // 而瀏覽器是**靜默**截斷的——這個數字是使用者唯一能提前發現的訊號
  return {
    label: '一段文字',
    sync: `貼進來就固定（目前 ${pasteInput.value.trim().length.toLocaleString('zh-TW')} 字，上限 100,000 字）`,
    syncTone: 'static' as const,
    hintLabel: '怎麼變成知識？',
    hint: 'AI 會讀完內容、自己判斷怎麼切成一條條知識。之後要改就直接編輯那一條。',
  }
})


// ── File ──────────────────────────────────────────────────
const fileInputEl = ref<HTMLInputElement | null>(null)
/** 投放框的 el-input（「官網有頁面」那顆選項要把游標放進來） */
const pasteInputEl = ref<{ focus: () => void } | null>(null)
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
/**
 * 判別結果的細節展開（預設收起，見 detected 的說明）。換一種來源就收回去。
 *
 * ⚠️ 這個 watch 必須放在 `selectedFile` 宣告**之後**（2026-09-03 實機炸掉才發現）：
 *    watch 的來源在註冊當下就會求值一次，而 `detected` 的 getter 會讀 `selectedFile`
 *    → 放前面就是 `Cannot access 'selectedFile' before initialization`，整個元件 setup 死掉、
 *    按下「加入知識」只會看到一片空白。跟下面那個 watch 是同一顆雷（註解就寫在那裡，我還是踩了）。
 *    ⛔ typecheck 抓不到這種：它只看得到直接引用，看不穿 getter 閉包。
 */
const hintOpen = ref(false)
watch(() => detected.value?.label, () => { hintOpen.value = false })

/**
 * 「還沒有現成資料」三顆選項的展開狀態（'' = 都收起）。
 * 一次只開一條：三條全開就回到一版「250 字同時攤開」的老問題（老闆：快 fade out）。
 * ⛔ 刻意不在 resetAll／關窗時清掉：走試算表那條的人會中途去 Google 分享，
 *    回來時面板要還開著、帳號還在眼前。
 */
const startOpen = ref<'' | 'web' | 'excel' | 'sheet'>('')

/** 點投放框的空白處＝聚焦輸入框；點到框裡的按鈕（選擇檔案）就讓按鈕自己來 */
function focusPaste(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest('button, a, input, textarea')) return
  pasteInputEl.value?.focus?.()
}

function pickStart(route: 'web' | 'excel' | 'sheet') {
  startOpen.value = startOpen.value === route ? '' : route
  // 官網那條的「動作」就是貼網址：把游標放進框裡，使用者回來直接 ⌘V 就能貼
  if (startOpen.value === 'web') nextTick(() => pasteInputEl.value?.focus?.())
}

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
  // 畫面上的欄位鎖住了,但拖放不經過那些欄位——這一層才是真的守門（`D-41` 死路⑪）
  if (previewing.value) {
    showToast('正在整理目前這一份，要換的話請先按「取消」', 'warning')
    return false
  }
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
  if (previewing.value) return // 同 acceptFile：整理中不接受換內容
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
    await navigator.clipboard.writeText(shareEmail.value)
    showToast('已複製服務帳號 email', 'success')
  }
  catch {
    showToast('複製失敗，請手動選取複製', 'error')
  }
}

/**
 * 「我現在讀不讀得到這份試算表」（`D-50` 簡化 4）：貼上連結就實際讀一次。
 *
 * 沿用整站探頁數（sitePeek）那套節流規矩：停止輸入 1 秒才打、同一個網址只自動測一次、
 * 過期結果丟掉。差別是**失敗不靜音**——「還讀不到」正是使用者此刻最需要知道的事
 * （整站探頁數失敗只是少一個順手功能，靜音無妨）。
 */
interface GsheetProbe { status: string, message: string, detail?: string, serviceAccountEmail?: string }
const gsheetProbe = ref<GsheetProbe | null>(null)
/**
 * 要分享給哪個帳號。開窗時那支 gsheet-account 失敗的話（catch 是靜默的）就退用探測回傳的那份
 * ——`gsheet-probe` 在「還讀不到」那條路刻意把它一起帶回來，正是為了這種情況。
 * ⚠️ 宣告排在 gsheetProbe 之後：computed 雖然是延遲求值不會 TDZ，但這個檔案同輪已經因為
 *    「衍生值排在來源前面」炸過兩次，一律排後面就不必每次判斷會不會炸。
 */
const shareEmail = computed(() => serviceAccountEmail.value || gsheetProbe.value?.serviceAccountEmail || '')
const gsheetProbing = ref(false)
let gsheetProbedUrl = ''
let gsheetProbeTimer: ReturnType<typeof setTimeout> | null = null

async function probeGsheet(url: string, force = false) {
  if (!url || !GSHEET_PATTERN.test(url)) return
  if (!force && url === gsheetProbedUrl) return
  gsheetProbing.value = true
  try {
    const res = await apiFetch<GsheetProbe>('/api/ai/knowledge/gsheet-probe', {
      method: 'POST',
      body: { url },
    })
    // 使用者在等待期間換了連結 → 過期結果丟掉（否則會拿舊表的綠勾蓋在新表上）
    if (gsheetInput.value.trim() !== url) return
    gsheetProbedUrl = url
    gsheetProbe.value = res
  }
  catch (err: any) {
    if (gsheetInput.value.trim() !== url) return
    gsheetProbedUrl = url
    // ⛔ 探測本身掛掉 ≠ 讀不到試算表：講「試不出來」而不是「還沒分享」，
    //    否則會叫人去按一個本來就分享好的分享鈕。
    gsheetProbe.value = {
      status: 'unknown',
      message: '試不出來（可能是暫時的網路問題），可以直接按下面的按鈕試試看。',
      detail: String(err?.data?.statusMessage || err?.statusMessage || err?.message || '').slice(0, 200) || undefined,
    }
  }
  finally {
    gsheetProbing.value = false
  }
}

watch([mode, pasteInput], () => {
  if (gsheetProbeTimer) clearTimeout(gsheetProbeTimer)
  const url = pasteInput.value.trim()
  if (mode.value !== 'gsheet' || !GSHEET_PATTERN.test(url)) {
    gsheetProbe.value = null
    return
  }
  if (url === gsheetProbedUrl) return // 已經測過這個連結（結果留在畫面上）
  gsheetProbe.value = null
  gsheetProbeTimer = setTimeout(() => { void probeGsheet(url) }, 1000)
})

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
/**
 * 最近一次預覽工作的 jobId（C-46）：兩個用途——
 * ① 取消時打 DELETE 讓伺服器真的停下（否則 job 佔著 Storage、再 poll 還會花錢推進）
 * ② 當 bulk-create 的冪等鍵：逾時後重按「匯入」覆寫同一批卡，不生殭屍來源與重複卡
 */
const lastPreviewJobId = ref('')
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
const existingMatches = ref<Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number; type?: string }>>([])
const sourceMeta = ref({
  type: '' as ImportMode | '',
  name: '',
  url: '',
  /** 所屬產品名：AI 偵測預填、使用者可改；'' = 非單一產品資料 */
  productName: '',
  /** 網址來源的內容指紋（存成 source.appliedContentHash＝重新同步的比對基準） */
  contentHash: '',
  /** 放進哪個資料夾；null = 未分類。依名稱自動預選（`C-134`），使用者可改 */
  folderId: null as string | null,
})

/**
 * 資料夾是「照名字猜的」還是使用者自己選的。
 * 猜的要在畫面上講出來——沒講的話，東西被放進某個資料夾這件事等於沒人同意過
 * （而放錯資料夾比留在未分類更難查）。使用者一動手就不再是猜的。
 */
const folderAutoPicked = ref(false)

/**
 * 「更新既有那一份」的目標（`C-135`）。
 * 有值時 `runImport` 走覆蓋：舊卡進回收桶、來源本身留著（資料夾／同步設定不會被洗掉）。
 * 這是同名警告的正解——原本唯一的建議是「改個名字」，照做就是製造出第三份重複。
 */
const replaceTarget = ref<{ id: string; name: string; chunkCount: number } | null>(null)

/** 後端回報「這份內容已經匯過了」（`C-134`）：內容指紋一模一樣的既有資料 */
interface DuplicateHit {
  id: string
  name: string
  type: string
  chunkCount: number
  updatedAtMs: number
}
const duplicateHit = ref<DuplicateHit | null>(null)
/**
 * 下一次整理要不要略過「已經匯過了」的守門。
 * 一次性：用掉就歸位——不然使用者按過一次之後，這個視窗接下來每一份都不再守門。
 */
const ignoreDuplicateOnce = ref(false)

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
  /** 這一頁**實際建立**幾條知識（含 AI 還沒學起來的：它們已經進庫了） */
  cards: number
  /**
   * 其中 AI 沒學起來的條數（`D-41` P1⑤）。
   * 原本結論只報「索引成功數」，於是索引失敗的卡**已經建進資料庫**卻不在數字裡、
   * 也沒有任何清單可以重試——而整站這條路刻意不逐頁預覽，等於沒有人會發現它們。
   */
  notLearned: number
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
    // 實際建立的總條數（含 AI 還沒學起來的）；notLearned 另外列，兩個數字加起來才對得上
    cards: done.reduce((s, p) => s + p.cards, 0),
    notLearned: done.reduce((s, p) => s + p.notLearned, 0),
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
    notLearned: 0,
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
        const created = await apiFetch<{ jobId?: string; duplicate?: DuplicateHit }>('/api/ai/knowledge/preview-jobs', {
          method: 'POST',
          // ⛔ 不帶 backgroundAdvance：這一頁的 bulk-create 只在下面這個 worker 裡呼叫，
          //    人一關窗就沒有人收結果，讓排程推完等於純燒錢（見 PreviewJobDoc 的說明）。
          body: { type: 'url', url: page.url, generateOverview: false },
        })
        /**
         * 這一頁的內容跟既有資料一字不差（`C-134`）——換了網址的同一頁、或同站兩個
         * 網址指向同一份內容。當成「這頁做完了」而不是失敗，但**一定要在清單上講出來**：
         * 靜靜跳過會變成「勾了 30 頁、只進了 22 頁」而沒有人知道少了哪幾頁、為什麼。
         */
        if (created.duplicate) {
          page.status = 'done'
          page.cards = 0
          page.notLearned = 0
          page.imported = true
          page.warningTexts = [`內容與既有資料「${created.duplicate.name}」完全相同，已跳過（沒有重複建立）`]
          continue
        }
        if (!created.jobId) throw new Error('建立整理工作失敗')
        lastPreviewJobId.value = created.jobId // 逾時要停掉它（見下面的 catch）
        const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(created.jobId)
        if (!res.chunks.length) throw new Error('沒有切出知識(頁面可能沒有實質內容)')
        const bulk = await apiFetch<{ total: number; indexed: number; failed: number }>('/api/ai/knowledge/bulk-create', {
          method: 'POST',
          body: {
            source: {
              type: 'url',
              name: page.title || res.sourceName || page.url,
              url: page.url,
              productName: res.suggestedProductName ?? '',
              contentHash: res.contentHash ?? '',
              // 整站匯入沒有逐頁預覽＝更沒有人會事後去拖資料夾（`C-134`）。
              // 猜不到就是 null（未分類），跟單筆匯入同一把尺。
              folderId: pickFolderForSource(props.folders ?? [], {
                sourceName: page.title || res.sourceName || page.url,
                productName: res.suggestedProductName ?? '',
              })?.folderId ?? null,
            },
            // 冪等鍵（C-46）:單頁逾時重試不會生第二個來源
            importId: created.jobId,
            chunks: res.chunks.map(c => ({
              title: c.title,
              content: c.content,
              tags: c.tags ?? [],
              questions: c.questions ?? [],
            })),
            overviewCard: null,
          },
        })
        // 實際建立的條數（不是「學會的條數」）：失敗的那幾條也已經在知識庫裡了
        page.cards = bulk.total ?? bulk.indexed
        page.notLearned = bulk.failed ?? 0
        page.productName = res.suggestedProductName ?? ''
        page.warningTexts = res.warnings ?? []
        page.status = 'done'
        page.checked = false
        page.imported = true
      }
      catch (err: any) {
        page.status = 'failed'
        /**
         * ⚠️ 逾時要單獨講（2026-09-03 code review 抓到）：整站這條路的 `bulk-create`
         * **只在這個 worker 裡呼叫**，所以這一頁的工作即使被排程做完，切好的知識也沒有人收
         * ——不能沿用單筆匯入那句「還在背景整理、好了會告訴你」，那是騙人的。
         * 而且要主動把工作停掉：不停的話排程會付完整的 OCR／AI 費用把它做完，結果丟掉。
         */
        if (err?.code === PREVIEW_JOB_DEADLINE) {
          page.error = '整理太久，這一頁跳過了（沒有匯入，可重新勾選再試）'
          if (lastPreviewJobId.value) {
            apiFetch(`/api/ai/knowledge/preview-jobs/${lastPreviewJobId.value}`, { method: 'DELETE' }).catch(() => {})
          }
        }
        else {
          page.error = String(err?.data?.statusMessage || err?.statusMessage || err?.message || '匯入失敗').slice(0, 80)
        }
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
  // 整站這條路不會走到結果頁（結論列就長在頁面清單上），但「客人聽不聽得到」
  // 這句話兩條路都要講——D-40 的交棒卡在這裡是結論列下面那一行
  if (ok.length) void loadAiEnabled()
  // 中途關窗:視窗已不在,改用父層刷新讓已建立的資料立刻出現在列表(否則要手動重整才看得到)
  if (siteAborted.value) {
    if (ok.length) emit('imported', null)
    // 視窗已經關了,結論列沒機會出現——但「做了什麼」一定要有人講（`D-41` P1⑤）。
    // ⛔ 不可以靜靜 resetAll 就結束:那正是「建了幾份沒人知道」的原形。
    showToast(
      ok.length
        ? `已停止整站匯入：完成的 ${ok.length} 頁（${ok.reduce((s, p) => s + p.cards, 0)} 條）已保留在知識庫`
        : '已停止整站匯入：這批還沒有任何一頁完成，知識庫沒有變動',
      ok.length ? 'success' : 'warning',
    )
    resetAll()
    return
  }
  const notLearned = ok.reduce((s, p) => s + p.notLearned, 0)
  showToast(
    bad.length
      ? `整站匯入完成:${ok.length} 頁成功、${bad.length} 頁失敗(清單有標原因)`
      : `整站匯入完成:${ok.length} 頁、共 ${ok.reduce((s, p) => s + p.cards, 0)} 條${notLearned ? `（其中 ${notLearned} 條待學）` : ''}`,

    bad.length ? 'error' : 'success',
  )
}

/**
 * 這次真的會送出幾條。
 * ⚠️ 過濾條件必須跟 `runImport` **一模一樣**（2026-09-03 code review 抓到）：
 * 原本只數 `included`，但 runImport 還會濾掉標題或內容被清空的那些——於是清空一條的標題
 * 卻留著勾選，按鈕說 20 條、實際只送 19 條，正是 `D-41` P0② 要修的「按鈕與結果對不上」；
 * 全部清空時按鈕還會是可按的，按下去只得到「請至少選擇一條」的死路。
 */
const willImportChunks = computed(() =>
  chunks.value.filter(c => c.included && c.title.trim() && c.content.trim()))
const includedCount = computed(() => willImportChunks.value.length)

/**
 * 這次真的會建幾條（`D-41` P0②）。
 *
 * 總表卡不在 `includedCount` 裡（它是 overviewCard 另外送出的），所以按鈕寫「直接匯入 20 條」、
 * 結果頁的「總計」卻是 21——兩個畫面對不上，使用者只能自己猜多出來的那一條是什麼。
 * 按鈕改成把它講出來；不寫成「21 條」是刻意的：那張總表跟其他條不同種，合成一個數字
 * 反而看不出多的是什麼。
 */
const overviewWillImport = computed(() => {
  const ov = overviewCard.value
  return !!(ov && ov.included && ov.title.trim() && ov.content.trim())
})
const importTotalLabel = computed(() =>
  overviewWillImport.value ? `${includedCount.value} 條＋1 張總表` : `${includedCount.value} 條`,
)

/**
 * 主按鈕的字。選了覆蓋目標時**按鈕本身就要改口**（`C-135`）——
 * 「匯入」跟「蓋掉既有那一份」是兩件事，按鈕說一樣的話等於沒有告知。
 */
const importButtonLabel = computed(() =>
  replaceTarget.value ? `更新既有資料（${importTotalLabel.value}）` : `直接匯入 ${importTotalLabel.value}`,
)

/** 選定要覆蓋的既有資料；名稱同步過去，免得更新完列表上出現兩個不同名字指同一份東西 */
function chooseReplaceTarget(m: { id: string; name: string; chunkCount: number }) {
  replaceTarget.value = { id: m.id, name: m.name, chunkCount: m.chunkCount }
  sourceMeta.value.name = m.name
}

/** 「這份已經匯過了」→ 關窗並跳去那一份（沿用 imported 訊號，父層會刷新列表並選中它） */
function openDuplicateSource() {
  const id = duplicateHit.value?.id ?? null
  duplicateHit.value = null
  emit('imported', id)
  emit('update:modelValue', false)
}

/** 「內容其實不一樣」→ 略過這一次守門重跑。旗標用完即歸位（見 ignoreDuplicateOnce） */
function retryIgnoringDuplicate() {
  duplicateHit.value = null
  ignoreDuplicateOnce.value = true
  void runPreview()
}

/** 名稱／所屬產品欄位的展開（`D-50` 簡化 2：預設收起，結論先行）。判斷見 metaEditorOpen */
const metaOpen = ref(false)

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
 * 第一步原本有個勾選框問同一件事，但那是在還沒看到任何內容時問的，第一次用的人根本
 * 答不出來（勾錯的代價是客人問「你們賣什麼」時 AI 只能反問）。2026-09-03（`D-50` 簡化 1）
 * 勾選框整塊移除，**這裡成為總表唯一的入口**。
 * 條數多＝列了很多樣東西，這是我們手上唯一真的訊號，就在這時候問。
 *
 * ⚠️ `text` 是勾選框移除的同一輪補進來的：以前貼上一大段商品清單的人只能靠勾選框，
 *    這裡若還只認 url/file，那條路就變成完全沒有出口（gsheet 例外——它本來就免勾）。
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
  && (sourceMeta.value.type === 'url' || sourceMeta.value.type === 'file' || sourceMeta.value.type === 'text')
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
  const pool = new Map<string, { id: string; name: string; chunkCount: number; updatedAtMs: number; type?: string }>()
  for (const s of props.existingSources ?? []) pool.set(s.id, s)
  for (const m of existingMatches.value) if (!pool.has(m.id)) pool.set(m.id, m)
  return [...pool.values()].filter(m => m.name.trim() === name)
})

/**
 * 這一份可不可以拿來「更新」（`C-139`）。
 * 型別不同的不給按——把一份 Google 試算表覆蓋成檔案，會讓它從此不再自動同步，
 * 而畫面上完全看不出來。⛔ 後端也擋（真正的守門在那裡），這裡只是別讓人按了才被拒絕。
 */
function canReplace(m: { type?: string }): boolean {
  const mode = sourceMeta.value.type
  if (!mode) return true
  return canReplaceSource(mode as ImportMode, String(m.type ?? ''))
}
const SOURCE_TYPE_LABEL: Record<string, string> = {
  file: '檔案',
  url: '網址',
  gsheet: 'Google 試算表',
  manual: '手打文字',
}

/**
 * 名稱／所屬產品欄位要不要展開。
 * ⚠️ 宣告在 dupMatches **之後**：這個檔案有過 TDZ 事故（watch 註冊當下就會讀一次 getter，
 *    整個元件 setup 直接炸掉、知識庫變全站錯誤頁），所以凡是讀別人 ref 的衍生值一律排在後面。
 * 有同名警告時強制展開——那句提醒叫人「改個名字」，收起來的話畫面上沒有東西可按。
 */
const metaEditorOpen = computed(() => metaOpen.value || dupMatches.value.length > 0)

/** 預覽 job 完成時的回應形狀（與舊 preview-chunks 相同） */
interface PreviewResult {
  chunks: Array<{ title: string; content: string; tags: string[]; questions?: string[] }>
  overviewCard?: { title: string; content: string; tags: string[]; questions: string[] } | null
  sourceName: string
  sourceUrl: string
  truncated: boolean
  ocrUsed?: boolean
  existingMatches?: Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number; type?: string }>
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
/**
 * 「畫面不等了，但它還在背景跑」（`D-50` 簡化 3）。
 * ⛔ 這種情況**不可以**畫成紅色錯誤：東西沒壞，工作還活著、排程正在推它；
 *    畫成錯誤的話使用者會去重傳一份，於是同一份資料兩個工作同時跑、OCR 錢付兩次。
 *
 * ⚠️ 宣告必須在 `jobState` **之前**（2026-09-03 實機炸掉才發現）：下面那個
 *    `watch(jobState, …, { immediate: true })` 在註冊當下就會求值 jobState，而 jobState 讀這個 ref
 *    → 放後面就是 `Cannot access … before initialization`，整個元件 setup 死掉。
 */
const previewStillRunning = ref(false)

const jobState = computed<'running' | 'ready' | 'none'>(() => {
  if (previewing.value) return 'running'
  // 畫面等太久先不等了、但排程還在推它（`D-50` 簡化 3）——這時側欄一定要照樣顯示
  // 「一份資料整理中」,否則使用者關掉視窗就只剩一片安靜,又變成「系統把我的東西弄丟了」
  if (previewStillRunning.value) return 'running'
  if (step.value === 'preview' && chunks.value.length > 0) return 'ready'
  return 'none'
})
watch(jobState, v => emit('job-state', v), { immediate: true })

/** 回到第一步(換一份重新整理)＝放棄目前這份工作,記號要跟著清掉 */
function backToInput() {
  clearJobMarker()
  // 回第一步＝要換一份了：覆蓋目標留著的話，下一份會被默默蓋到上一份的資料上
  replaceTarget.value = null
  duplicateHit.value = null
  step.value = 'input'
}

/** 進頁面時撿回上一次沒看完的整理工作;撿不到就當沒這回事(不跳任何錯誤) */
async function resumeStoredJob() {
  const marker = readJobMarker()
  if (!marker) return
  previewing.value = true
  previewError.value = ''
  previewStillRunning.value = false
  previewCancelled = false
  resetJobPoll()
  try {
    lastPreviewJobId.value = marker.jobId
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
    // 使用者只是打開了知識庫,沒有要求任何事,不該迎面丟一個錯誤給他。
    // ⚠️ 但**一定要立起「還在跑」的旗標**（2026-09-03 code review 抓到）:不立的話
    //    jobState 會變成 'none',側欄那顆「一份資料整理中」當場消失,而工作其實還活著
    //    ——記號在、畫面上卻一點痕跡都沒有,正是這輪要消滅的沉默死亡。
    if (err?.code === PREVIEW_JOB_DEADLINE) {
      previewStillRunning.value = true
      return
    }
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

/**
 * 「好了會告訴你」要真的做到（2026-09-03 code review 抓到的第一條）。
 *
 * 畫面等太久之後 previewStillRunning 立起來、側欄顯示「一份資料整理中」——但在這支之前
 * **沒有任何東西會再去看那份工作**：resumeStoredJob 只在 onMounted 跑，而這個元件沒有
 * v-if、永遠不會重新掛載，重開視窗也不會重新輪詢。結果排程幾分鐘後把它做完了，
 * 使用者卻要整頁重新載入才看得到——文案寫了一個程式沒做到的承諾。
 *
 * 做法：只在「還在跑」期間，每 45 秒打一次狀態（那支端點本身也會順手推進一步）。
 * ⛔ 間隔不能太短:每次呼叫都可能真的做一步 AI 工作,這裡是背景等待不是使用者在等。
 */
const RECHECK_MS = 45_000
let recheckTimer: ReturnType<typeof setInterval> | null = null

async function recheckStoredJob() {
  const marker = readJobMarker()
  if (!marker) {
    previewStillRunning.value = false
    return
  }
  // 使用者已經在做別的事（挑整站頁面、跑批次、開始另一份整理）→ 這輪不打擾，下次再看
  if (previewing.value || siteImporting.value || step.value !== 'input') return
  try {
    const res = await apiFetch<PreviewResult & { status: 'done' | 'processing' | 'error', error?: string }>(
      `/api/ai/knowledge/preview-jobs/${encodeURIComponent(marker.jobId)}`,
    )
    if (res.status === 'processing') return
    if (res.status === 'error') {
      previewStillRunning.value = false
      previewError.value = String(res.error || '整理失敗').slice(0, 300)
      clearJobMarker()
      return
    }
    // done：拿回結果直接攤到預覽頁（側欄的「整理好了，看結果」由 jobState 自己翻）
    previewStillRunning.value = false
    if (!res.chunks.length) {
      clearJobMarker()
      return
    }
    applyPreviewResult(res, marker.mode)
    step.value = 'preview'
  }
  catch (err: any) {
    const code = Number(err?.statusCode ?? err?.data?.statusCode ?? 0)
    // 過期／被清掉／不是這個租戶 → 記號沒用了，收掉旗標（否則側欄會永遠停在「整理中」）
    if (code === 404 || code === 403) {
      previewStillRunning.value = false
      clearJobMarker()
    }
    // 其他錯誤（網路抖動）不出聲，下一輪再看
  }
}

watch(previewStillRunning, (on) => {
  if (recheckTimer) {
    clearInterval(recheckTimer)
    recheckTimer = null
  }
  if (on) recheckTimer = setInterval(() => { void recheckStoredJob() }, RECHECK_MS)
})

// 使用者主動打開視窗＝他想看結果，不要讓他等下一次定時（45 秒在人站在畫面前時很長）
watch(() => props.modelValue, (open) => {
  if (open && previewStillRunning.value) void recheckStoredJob()
  // 開窗自動聚焦（2026-09-03 UI 打磨）：第一個動作幾乎都是貼上，游標先放進框，
  // 開窗直接 ⌘V 就能貼。⛔只在乾淨的第一步聚焦：接回預覽/結果頁時搶焦點會把人拉錯地方
  if (open) {
    nextTick(() => {
      if (step.value === 'input' && !detected.value && !previewing.value) pasteInputEl.value?.focus?.()
    })
  }
})

onBeforeUnmount(() => {
  if (recheckTimer) clearInterval(recheckTimer)
})

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
  replaceTarget.value = null // 新的一份＝回到「建立新資料」，別把上一輪選的覆蓋目標帶過來
  /**
   * 資料夾預選（`C-134`）：拿檔名＋AI 判出來的產品名去比現有資料夾。
   * ⛔ 比對必須帶產品名——實測「KIESLECT 小耳記 說明書.pdf」單靠檔名比不到
   * 「Kieselect 小耳記 AI NotePods 10S」這個資料夾（資料夾名字本身還打錯字）。
   * 猜不出來就是 null（未分類），不硬塞：放錯資料夾比留在未分類更難查。
   */
  const guessed = pickFolderForSource(props.folders ?? [], {
    sourceName: res.sourceName,
    productName: res.suggestedProductName ?? '',
  })
  folderAutoPicked.value = Boolean(guessed)
  sourceMeta.value = {
    type: srcMode,
    name: res.sourceName,
    url: res.sourceUrl,
    productName: res.suggestedProductName ?? '',
    contentHash: res.contentHash ?? '',
    folderId: guessed?.folderId ?? null,
  }
}

async function runPreview() {
  previewing.value = true
  previewError.value = ''
  previewStillRunning.value = false
  previewCancelled = false
  resetJobPoll()
  try {
    // backgroundAdvance：只有這條路（單筆匯入）的結果有人會回來收——記號落在 localStorage、
    // 回來自動接續，還有 recheck 定時器在看。整站每一頁刻意不帶（見 runSiteImport）。
    const body: Record<string, unknown> = {
      type: mode.value,
      generateOverview: generateOverview.value,
      backgroundAdvance: true,
    }
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

    // 已經匯過一模一樣的內容時要略過去重（使用者在下面那張卡按了「還是要再整理一次」）
    if (ignoreDuplicateOnce.value) body.ignoreDuplicate = true

    // 建 job(秒回)→ 輪詢推進(永不 504)。回應形狀與舊 preview-chunks 相同。
    const created = await apiFetch<{ jobId?: string; duplicate?: DuplicateHit }>(
      '/api/ai/knowledge/preview-jobs',
      { method: 'POST', body },
    )
    // 上傳大檔那段可能跑好幾秒,期間按了取消就別再往下建工作(否則會留下一份沒人要的記號)
    if (previewCancelled) return

    /**
     * 這份東西已經匯過了（`C-134`）：後端在**花錢整理之前**就擋下來，這裡只負責給兩條路。
     * ⛔ 不可以做成「擋住就結束」——那是死路。人會有兩種真實意圖：去看既有那份，
     *    或明知重複也要重新整理一次（換切法／上一次切壞了）。
     */
    if (created.duplicate) {
      duplicateHit.value = created.duplicate
      clearJobMarker()
      return
    }
    if (!created.jobId) {
      showToast('建立整理工作失敗，請再試一次', 'error')
      return
    }
    ignoreDuplicateOnce.value = false // 用掉了就歸位，下一份重新守門
    lastPreviewJobId.value = created.jobId // 取消端點與 bulk-create 冪等鍵（C-46）都要用
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
    // 等太久 ≠ 失敗:逾時的時候伺服器那份工作還活著(而且 2026-09-03 起維護排程會繼續推它),
    // 記號留著讓人下次進來接著看;真的失敗(伺服器已標 error)才清掉——留著只會在下次進頁面時
    // 再報一次同一個錯。
    const deadline = err?.code === PREVIEW_JOB_DEADLINE
    if (deadline) previewStillRunning.value = true
    else clearJobMarker()
    // 留在畫面上而不是 toast：等了幾分鐘的人常常沒盯著螢幕，3.5 秒的提示等於沒講。
    // 逾時那條路的「下一步」由這一端補（composable 只講發生什麼）——單筆匯入是三個呼叫端裡
    // **唯一**能承諾背景做完還接得回來的（記號落地＋下面的 recheck 定時器）。
    previewError.value = deadline
      ? '等太久了，畫面先不等——整理仍在背景進行，完成後這裡會自動顯示結果'
      : String(
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
  // 通知伺服器（C-46）:原本取消只是前端不再輪詢,job 停在 processing 佔著 Storage 一小時,
  // 再 poll 一下還會繼續花錢推進。fire-and-forget,失敗也不擋畫面(排程清理是保底)。
  if (lastPreviewJobId.value) {
    apiFetch(`/api/ai/knowledge/preview-jobs/${lastPreviewJobId.value}`, { method: 'DELETE' }).catch(() => {})
    lastPreviewJobId.value = ''
  }
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
  /** 「更新既有資料」時被移進回收桶的舊卡張數（`C-135`）；0 = 這次是新建一份 */
  replacedChunks?: number
} | null>(null)

const failedItems = computed(() =>
  (result.value?.items ?? []).filter(i => i.status === 'failed'),
)

// ── 交棒卡（D-40）：匯完之後「然後呢」 ──────────────────────
/**
 * AI 總開關現況。null＝讀不到（⛔這時整塊不畫，寧可少講一句也不要誤報「AI 沒開」
 * 害人跑去改一個本來就開著的開關）。只在真的匯進東西之後才查，沒匯成功不多打一支 API。
 */
const aiEnabled = ref<boolean | null>(null)
async function loadAiEnabled() {
  try {
    const s = await apiFetch<{ enabled?: boolean }>('/api/ai/settings')
    aiEnabled.value = s?.enabled === true
  }
  catch {
    aiEnabled.value = null
  }
}
function goEnableAi() {
  close()
  void navigateTo(`/admin/${workspaceId.value}/ai-settings`)
}

/** 試問用的句子（判斷抽在 utils，跟 sources 頁存檔後的就地試答同一套） */
const verifyQuery = computed(() => pickKbVerifyQuery(chunks.value))
const verifying = ref(false)
const verifyOutcome = ref<KbVerifyOutcome | null>(null)

/**
 * 拿剛匯入的內容真的問 AI 一次（isTest＝不計次數、不進統計、不消耗額度）。
 * ⛔答不出來要照實說：這一步的價值就是「別讓人帶著假的安心離開」，
 * 報喜不報憂的話還不如不做。判語全在 kbVerifyOutcome（有測試守著）。
 */
async function runVerify() {
  const query = verifyQuery.value
  if (!query) return
  verifying.value = true
  verifyOutcome.value = null
  try {
    const res = await apiFetch<{ timedOut: boolean; decision: string; confidence: number }>(
      '/api/ai/knowledge/verify',
      { method: 'POST', body: { query } },
    )
    verifyOutcome.value = kbVerifyOutcome({ query, timedOut: res.timedOut, decision: res.decision })
  }
  catch {
    verifyOutcome.value = kbVerifyOutcome({ query, errored: true })
  }
  finally {
    verifying.value = false
  }
}

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

/**
 * 重試一條。
 *
 * ⛔ **一定要看回應內容，不可以「沒 throw 就當成功」**（`D-41` P0①，2026-09-03 修）。
 *    `/reindex` 走 `runIndexOnChunk`，那支的 catch 是 **return 不是 throw**——再次失敗時
 *    回的是 HTTP 200 ＋ `{ status: 'failed' }`。原本這裡不看回應一律「可用 +1、失敗 −1」，
 *    於是 AI 服務忙碌時按重試，畫面說「3 條都學會了」而實際 3 條全還是失敗：
 *    客人問到照樣答不出來，而老闆以為修好了。資料頁的同功能本來就會重讀真狀態
 *    （`sources/index.vue` 的 retryChunk），兩邊誠實度不同才是這個 bug 的形狀。
 */
async function retryOne(item: { id: string; status: string; failureReason?: string }): Promise<boolean> {
  retryingIds.value = new Set([...retryingIds.value, item.id])
  try {
    const res = await apiFetch<{ status?: string; failureReason?: string }>(
      `/api/ai/knowledge/${item.id}/reindex`,
      { method: 'POST' },
    )
    const row = (result.value?.items ?? []).find(i => i.id === item.id)
    /**
     * ⚠️ 判「失敗」要看 `status === 'failed'`，不是「不等於 indexed」（2026-09-03 code review 抓到）：
     * `runIndexOnChunk` 對**停用中**的卡重算成功時回的是 `status: 'disabled'`（刻意的，
     * 停用卡不落 failed 才不會被重試佇列復活）。用不等式判的話，那種成功會被報成
     * 「還是沒學起來：原因不明」。
     */
    if (res?.status === 'failed') {
      if (row) row.failureReason = res?.failureReason || row.failureReason || '重試後仍然失敗'
      return false
    }
    // 就地改狀態：結果頁的統計與清單都跟著更新，不用重新匯入才看得到成果
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
  // 與畫面上的 includedCount 共用同一份判斷（見 willImportChunks 的說明）
  const selected = willImportChunks.value
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
          folderId: sourceMeta.value.folderId,
        },
        // 「更新既有那一份」（`C-135`）：舊卡進回收桶、來源留著，不再多生一份同名資料
        ...(replaceTarget.value ? { replaceSourceId: replaceTarget.value.id } : {}),
        chunks: selected,
        overviewCard: overviewPayload,
        // 冪等鍵（C-46）:逾時後重按「匯入」會覆寫同一批卡,不會多出殭屍來源＋重複卡
        importId: lastPreviewJobId.value || undefined,
      },
    })
    result.value = res
    clearJobMarker() // 卡已經進庫了,這份整理工作到此為止
    invalidateProductNames() // 這份資料的產品名已經進後端清單,下次填欄位要挑得到
    // 一律停在結果頁（D-40）。以前全成功是「跳 toast 就關窗」——那是使用者最想問
    // 「然後呢」的一刻，卻是整段流程唯一沉默的地方；而正確答案常常是「AI 還關著，
    // 客人聽不到」。⛔別把交棒卡改成 toast：toast 3.5 秒就消失，這張卡上有要按的按鈕。
    if (res) {
      step.value = 'result'
      verifyOutcome.value = null
      void loadAiEnabled() // 背景查，查不到就整塊不畫（不擋畫面）
      showToast(
        res.failed === 0 ? `成功匯入 ${res.indexed} 條` : `匯入完成：${res.indexed} 成功 / ${res.failed} 失敗`,
        res.failed === 0 ? 'success' : 'error',
      )
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
  previewStillRunning.value = false
  metaOpen.value = false
  // ⚠️ 探測狀態要一起清（2026-09-03 code review 抓到）：只清輸入不清這兩個的話，
  //    再貼同一個試算表連結時 watcher 會因為「這個網址測過了」直接 return，
  //    而結果早就被清成 null → 綠勾與「正在確認」都不會出現，畫面停在「還沒證明讀得到」。
  gsheetProbe.value = null
  gsheetProbedUrl = ''
  sourceMeta.value = { type: '', name: '', url: '', productName: '', contentHash: '', folderId: null }
  // 換一份就全部歸位：守門旗標若留著，接下來每一份都不再檢查重複（`C-134`）
  folderAutoPicked.value = false
  replaceTarget.value = null
  duplicateHit.value = null
  ignoreDuplicateOnce.value = false
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
/**
 * 關窗前的確認（`D-41` P1⑤，2026-09-03 加）。
 *
 * 整站匯入跑到一半按 ESC／✕ 原本**直接收工、一句話都不說**：做完的那幾頁已經進了知識庫，
 * 但結論列永遠不會出現，建了幾份、幾條全都沒交代。而那個畫面上還寫著「期間請保持這個
 * 視窗開著」——使用者關掉它時完全不知道自己中斷了什麼。
 * ⛔ 不可以擋著不讓關：他可能真的要走。要做的是「講清楚再放人」，並在收工時補一句交代。
 */
async function onBeforeClose(done: () => void) {
  if (siteImporting.value) {
    const built = sitePages.value.filter(p => p.status === 'done')
    const cards = built.reduce((sum, p) => sum + p.cards, 0)
    /**
     * ⚠️ 「正在跑的」與「還沒開始的」要分開講（2026-09-03 code review 抓到）：
     * worker 只在**開始下一頁之前**檢查中斷旗標，所以此刻正在整理的那幾頁會跑完、
     * 也會真的進知識庫。把它們算進「不會匯入」的數字裡，等於告訴使用者一件不會發生的事。
     */
    const running = sitePages.value.filter(p => p.status === 'processing').length
    const queued = Math.max(0, siteBatchTotal.value - siteDoneCount.value - running)
    try {
      await ElMessageBox.confirm(
        `已完成的 ${built.length} 頁（${cards} 條知識）會保留在知識庫。`
        + (running ? `正在整理的 ${running} 頁會跑完、也會匯入。` : '')
        + (queued ? `還沒開始的 ${queued} 頁不會匯入。` : ''),
        '要停止整站匯入嗎？',
        { confirmButtonText: '停止', cancelButtonText: '繼續整理', type: 'warning' },
      )
    }
    catch {
      return // 選了「繼續整理」＝不關窗
    }
  }
  done()
}

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
