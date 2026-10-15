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
        <!-- 這段導覽教的是「給資料 → 看整理結果」；一次好幾份的清單與結果頁上它要指的東西都不在，
             按下去只會指著空氣（2026-10-11 審查），這兩個畫面就不放問號 -->
        <span v-if="step !== 'fileBatch' && step !== 'result'" class="page-help">
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
      <!-- 步驟名稱是「這一步叫什麼」不是狀態句：1 把資料交給 AI → 2 AI 整理（整理中畫面還在這一頁，見 kb-import-step 的 processing）→ 3 加好了 -->
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>{{ previewing ? 'AI 整理' : '把資料交給 AI 整理' }}</p>
      <!-- 從資料頁「上傳新版」進來的（`D-124`；`C-319` 起叫「上傳新版」，以前叫「換新版」）：一進來就在整理，要講清楚會更新哪一份 -->
      <p v-if="replaceIntentName" class="kb-replace-intent">
        上傳新版：整理好會直接更新「<strong>{{ replaceIntentName }}</strong>」（舊的移到回收桶，30 天內救得回來）
      </p>

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
            <!-- 整理中不給換：不另外寫「正在整理這一份」——下面的等待框、按鈕的轉圈已經在講（同一件事一畫面講三次，2026-10-12 文字審視） -->
            <el-button v-if="!previewing" size="small" text @click="clearFile">換一個</el-button>
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
              :accept="KNOWLEDGE_FILE_ACCEPT"
              multiple
              class="kb-file-input"
              @change="onFileChosen"
            >
            <el-button size="small" plain :disabled="previewing" @click="fileInputEl?.click()">選擇檔案</el-button>
            <span class="text-xs text-muted">{{ previewing ? (autoImporting ? '' : '要換一份，請先按下面的「取消」') : `${KNOWLEDGE_FILE_LABEL}都可以，一次可以選好幾份、也可以直接拖進框裡（單檔 10MB 內）` }}</span>
          </div>
        </template>
      </div>

      <!-- 知識空間（`C-296`）：放之前就看得到剩幾條；滿了要在這裡就講，不是等整理完、按匯入才擋 -->
      <p v-if="quota && quota.limit != null" class="kb-quota-line" :class="{ 'is-full': roomLeft === 0 }">
        <template v-if="roomLeft === 0">
          知識空間滿了（{{ quota.used }}／{{ quota.limit }} 條）：新的資料整理完會放不進去，先刪掉用不到的知識<template v-if="billingLink">，或<NuxtLink :to="billingLink">升級方案</NuxtLink></template>。
        </template>
        <template v-else>
          知識空間：已用 {{ quota.used }}／{{ quota.limit }} 條，還能放 {{ roomLeft }} 條
          <!--
            「條」是什麼、一份會用掉幾條（`D-124` 新手走查：後台沒講，只有官網常見問題寫過）。
            數字是正式庫 2026-10-12 唯讀量的中位數附近：PDF 說明書 21 份中位數 35（25%～75%＝15～53）、
            網頁 24 份中位數 5（5～11）。⚠️ 帳號還少、樣本小；之後量級變了要重量再改這句，別讓它跟實際差太多
          -->
          <span class="kb-quota-line__unit">（一條＝一個問答；一本說明書通常 15～50 條、一個網頁約 5～10 條）</span>
        </template>
      </p>

      <!-- 判別結果:先講「這是什麼」,再講唯一真正要知道的差異(會不會自動更新) -->
      <div v-if="detected" class="kb-detected" :class="`kb-detected--${detected.syncTone}`">
        <p class="kb-detected__head">
          <span class="kb-detected__label">{{ detected.label }}</span>
          <span class="kb-detected__sync">{{ detected.sync }}</span>
          <button v-if="detected.hintLabel" type="button" class="kb-detected__more" @click="hintOpen = !hintOpen">
            {{ detected.hintLabel }}
          </button>
        </p>
        <p v-if="hintOpen && detected.hint" class="kb-detected__hint">{{ detected.hint }}</p>

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
            :class="gsheetReadable ? 'is-ok' : 'is-blocked'"
          >
            {{ gsheetReadable ? '✓' : '✗' }} {{ gsheetProbe.message }}
          </p>
          <!-- 綠勾之後就不必再看分享說明了(事情已經做完);其餘狀態一律附上帳號與重測鈕。
               「讀得到、只是還有分頁沒看」（partial）也算綠勾：⛔ 畫成紅叉＋分享說明，他會回頭去重新分享（2026-10-12 code review） -->
          <template v-if="!gsheetReadable">
            <!-- ⚠️ 重測鈕不可以藏在「拿得到服務帳號」的條件裡（2026-09-03 code review 抓到）：
                 gsheet-account 那支在開窗時失敗（靜默）的話，畫面就只剩一句「請共用給下面這個帳號」
                 下面什麼都沒有、也沒有重測鈕＝死路。帳號改用探測回傳的那份當備援。
                 ⛔ 帳號與「分享好了」只在**真的是沒分享**（no_access）時出現（2026-10-12 文字審視）：以前沒資料、
                    是上傳的 Excel 檔、試不出來也都叫人去分享——那幾種要做的是補資料、轉檔、再試一次。 -->
            <!--
              沒分享：三步教學**在這裡再出現一次**（2026-10-12 `D-124` 新手走查）。起步那一格只在框還空的時候看得到，
              先貼了連結的人一走到「讀不到」，三步和截圖全都不見了，只剩一串帳號——最需要教的那一刻反而沒有。
            -->
            <ol v-if="gsheetProbe?.status === 'no_access'" class="kb-start__steps kb-gsheet-share__steps">
              <li>打開這份試算表，按右上角<strong>「共用」</strong></li>
              <li>
                貼上這個帳號、權限選<strong>「檢視者」</strong>，按<strong>「傳送」</strong>
                <KnowledgeSheetShareHow :email="shareEmail" @copy="copyServiceEmail" />
              </li>
              <li>回來按下面的「分享好了，再測一次」</li>
            </ol>
            <div class="kb-gsheet-share__row">
              <el-button size="small" :loading="gsheetProbing" @click="probeGsheet(gsheetInput.trim(), true)">
                {{ gsheetProbe?.status === 'no_access' ? '分享好了，再測一次' : '再測一次' }}
              </el-button>
            </div>
            <!-- 伺服器原文只在「我們也猜不出原因」時給：沒分享那種的原文就是上面那句再講一次，還帶著 Google 的英文 -->
            <p v-if="gsheetProbe?.detail && gsheetProbe.status !== 'no_access'" class="kb-gsheet-share__detail">{{ gsheetProbe.detail }}</p>
          </template>
        </div>

        <!-- 整站匯入主動浮出(P1-3):不用自己想到有這功能 -->
        <p v-if="mode === 'url' && sitePeeking" class="kb-site-peek kb-site-peek--loading">
          正在看看這個網站還有哪些頁面⋯
        </p>
        <div v-else-if="mode === 'url' && sitePeekCount > 0" class="kb-site-peek">
          <span>這個網站另外還有 <strong>{{ sitePeekCount }}</strong> 頁，要一起加入嗎？</span>
          <el-button size="small" type="primary" plain @click="openSitePages">
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
      <!--
        ── 三版：換推薦順序（2026-09-13）──
        順序改成 **Google 試算表 → 貼官網 → 下載範本**，理由是查完三條路的實際行為：

        ① 精準度只有兩級，不是三級：試算表與下載範本用的是**同一份範本、同一種切法**
           （一列一卡、第一欄當標題，見下方 hintText 的「一列變成一條知識」），AI 不必猜分段；
           官網那條是整頁文字丟給 AI 自己判斷怎麼切。所以這兩條的勝負不在精準度，
           在**之後會不會自己爛掉**。
        ② 資料改了之後會怎樣（server/utils/cron-maintenance.ts 的 checkOneSource）：
             gsheet → 排程自己重讀、直接套用新增／修改／刪除
             url    → 排程發現頁面變了會**通知**，要人回來處理
             檔案   → **完全不在那支排程裡**（type 不是 url/gsheet 就直接 return unchanged）
           ⛔ 所以「下載範本」是三條裡唯一「做完就開始過期、而且系統看不見它過期」的路：
              方案從 399 改成 499，走這條的人不會收到任何提醒，AI 會一直講 399。
              它是**沒有 Google 帳號時的退路**，不是主推——排最後。
        ③ 官網排中間而不是最後：精準度雖然最差，卻是唯一**零工作量**的入口（貼個網址就有東西），
           而這一塊的受眾正是「手邊什麼都還沒有」的人，需要一條立刻看得到成果的路。

        ⛔ 小註（chip-tag）必須跟著換口徑：二版三顆寫的是**準備時間**（最快／約 3 分鐘／Google 試算表），
           而準備時間正好是試算表最吃虧的維度——順序調了、小註沒調，等於把看起來最麻煩的擺第一。
           現在小註一律回答「之後改了會怎樣」，準備時間降級到各自面板的第一行（仍然要寫，見二版規矩）。
        ⛔ 兩條都叫「範本」會被混在一起講（試算表那條的第一步也是「用官方範本建立副本」）：
           所以第三條改叫「下載範本自己填」、第一條明寫「Google 試算表」，光看選項就分得開。
      -->
      <!--
        ── 四版：從「挑一條」變成「把能怎麼做都列出來」（2026-09-13，老闆：「這是教學匯入方式，
           所以我覺得應該要把能怎麼做都列出教學」）──

        三版只列三條，是**照推薦排序**在挑；四版的定位改成**教材**：投放框收得了的每一種都要
        有一條，不能因為「我覺得那條不該推薦」就讓它整個不存在。補上兩條：
          · 直接打字貼上——⚠️ 它本來就收（`detectImportKind` 認得純文字），但三顆選項裡完全沒提，
            等於一個「打開就能用、還不用任何外部工具」的入口只寫在投放框那行小字裡。
          · 上傳現成檔案（PDF／Excel）——同理，PDF 連拍的掃的都吃，卻一個字都沒提。

        ⛔ 排序仍照三版那兩把尺（精準度、之後會不會自己爛掉），新來的兩條按同一把尺插進去：
           打字排第二（內容是自己寫的＝最準，但切法由 AI 決定、不會自動更新）；
           上傳現成檔案排第四（零工作量，但 AI 認字要核對、而且完全不會更新）。
        ⛔ 小註口徑不變、**五條一律回答「之後改了會怎樣」**——包括官網那條：它原本掛「最快」
           （速度），五條並排時只有它答的是別的問題，等於把唯一能橫向比較的那一欄弄花。
           速度改寫在它自己面板的第一行。
        ⛔ 手寫單卡與「AI 建議補的知識」**不做成第六、第七顆膠囊**：那兩個入口在這個視窗裡按不到
           （都在背後那一頁上），做成膠囊就是給一顆按了沒反應的按鈕。改用下面 `__more` 那行
           指路——教材要完整，但不能假裝這裡做得到。
      -->
      <!--
        ── 五版：從「還沒有現成資料？五種做法」改成「手上有什麼？」四格（2026-10-12，`D-123` 老闆拍板）──
        量出來（真登入、1440×900）：五顆收起時這一區 207 字；展開試算表 473 字＋3 張圖，主按鈕被推到 1,059px（要捲）。
        一般人慢在**要先學「之後改了會怎樣」這個概念才選得下去**——四版的小註五顆都回答那一題（而且兩顆一模一樣），
        但人腦中的問題是「我手上有什麼」。所以：
          · 照「手上有什麼」分四格：檔案／官網／Google 試算表／還沒整理好（同 NotebookLM 照「東西在哪」排的邏輯）；
          · 「之後改了會怎樣」只在**選了之後**講一次（判別結果那一行本來就有），不再當挑選的那一欄；
          · 「下載範本自己填」不再是獨立一條：`C-296` 起表格怎麼排都讀得懂，範本只是幫你寫——收進「還沒整理好」當連結；
          · 底下「還有兩種不在這個視窗」那段拿掉：那兩個入口在它們自己的位置本來就看得到（在目的地自然會知道的一律省略）。
        ⚠️ 跟四版「把能怎麼做都列出來教」的關係：四種**放得進框的東西**都各有一格，沒有少教一種輸入；範本仍在「還沒整理好」裡。
        「檔案」那格不展開面板，點了直接開選檔視窗——收不了的檔選到時當場講怎麼辦（acceptFile 的 toast），不必事先讀一段清單。
      -->
      <div v-if="!detected" class="kb-start">
        <p class="kb-start__head">手上有什麼？點一下就開始</p>
        <div class="kb-start__tiles" data-tour="kb-start">
          <button type="button" class="kb-start__tile" :disabled="previewing" @click="pickStart('file')">
            <span class="kb-start__tile-name"><el-icon><IconFile /></el-icon>檔案</span>
            <span class="kb-start__tile-sub">型錄、價目表、拍的照片</span>
          </button>
          <button
            type="button"
            class="kb-start__tile"
            :class="{ 'is-active': startOpen === 'web' }"
            :aria-expanded="startOpen === 'web'"
            @click="pickStart('web')"
          >
            <span class="kb-start__tile-name"><el-icon><IconWeb /></el-icon>官網</span>
            <span class="kb-start__tile-sub">貼網址就好</span>
          </button>
          <button
            type="button"
            class="kb-start__tile"
            :class="{ 'is-active': startOpen === 'sheet' }"
            :aria-expanded="startOpen === 'sheet'"
            @click="pickStart('sheet')"
          >
            <span class="kb-start__tile-name"><el-icon><IconSheet /></el-icon>Google 試算表</span>
            <span class="kb-start__tile-sub">改了表格，AI 跟著更新</span>
          </button>
          <button
            type="button"
            class="kb-start__tile"
            :class="{ 'is-active': startOpen === 'text' }"
            :aria-expanded="startOpen === 'text'"
            @click="pickStart('text')"
          >
            <span class="kb-start__tile-name"><el-icon><IconPen /></el-icon>還沒整理好</span>
            <span class="kb-start__tile-sub">直接打幾題常見問答</span>
          </button>
        </div>

        <!-- 官網：動作就是在上面的框貼網址（點這格時已把游標放進去，見 pickStart）；
             這裡只回答「我的頁面能不能貼」——可以貼的、抓不到的各一句（09-03 老闆的規矩：不限常見問題頁） -->
        <div v-if="startOpen === 'web'" class="kb-start__panel">
          <p class="kb-start__ptxt">
            把網址貼到上面的框。商品介紹、運費、退換貨、公告頁都可以；<strong>要登入、或要點開才看得到的內容抓不到</strong>。
          </p>
          <p class="kb-start__ptxt kb-start__ptxt--dim">貼完會問你要不要把網站其他頁一起匯入。</p>
        </div>

        <!--
          試算表：五步壓成三步（`D-123`）；三張真截圖一律攤開（2026-10-15 老闆：不要收起來，原本收在「看圖怎麼按」）。
          帳號、截圖、圖上編號的規矩都在 KnowledgeSheetShareHow（讀不到時那一塊共用同一份）。
        -->
        <div v-else-if="startOpen === 'sheet'" class="kb-start__panel">
          <p class="kb-start__ptxt kb-start__ptxt--lead">
            設定一次約 3 分鐘；之後改表格，AI <strong>每小時自己跟著更新</strong>。
          </p>
          <ol class="kb-start__steps">
            <li>
              <template v-if="faqTemplateCopyUrl">
                <el-button tag="a" :href="faqTemplateCopyUrl" target="_blank" rel="noopener" size="small" plain>用範本建一份</el-button>
                <span class="text-xs text-muted">或用你現有的試算表，欄位怎麼排都可以</span>
              </template>
              <template v-else>在 Google 試算表新開一份（欄位怎麼排都可以），或用你現有的</template>
            </li>
            <li>
              按右上角<strong>「共用」</strong>，貼上這個帳號、權限選<strong>「檢視者」</strong>，按<strong>「傳送」</strong>
              <KnowledgeSheetShareHow :email="shareEmail" @copy="copyServiceEmail" />
            </li>
            <li>把試算表的網址貼到上面的框，會<strong>馬上告訴你讀不讀得到</strong></li>
          </ol>
        </div>

        <!--
          還沒整理好：動作就是在上面的框打字（點這格時已把游標放進去）。範本收在這裡當連結（`D-123`）：
          表格怎麼排都讀得懂，範本只是幫你寫的格式，不再是獨立一條路。
          ⚠️ 刻意**不用 --lead**：那個 class 是給「下面接 <ol>」的面板補間距用的，這裡接的是 <p>，兩個間距會疊成 15px。
          ⚠️ 四版寫過「⛔『切法由 AI 決定』一定要寫」——那是為了叫人去看預覽。`D-123`② 之後一份也直接加入，
             要提醒「AI 是怎麼切的」改在結果頁講（存成哪一份、點開看這幾條），在這裡講只是多一行選之前讀不懂的字。
        -->
        <div v-else-if="startOpen === 'text'" class="kb-start__panel">
          <p class="kb-start__ptxt">
            把客人常問的問題<strong>連答案</strong>打進上面的框，一題一段、中間空一行就好。
          </p>
          <p class="kb-start__ptxt kb-start__ptxt--dim">
            想用表格填？<el-link type="primary" href="/templates/faq-sheet-template.xlsx" target="_blank" rel="noopener">下載問答範本（Excel）</el-link>，填好拖回上面的框。
          </p>
          <!-- 「手動新增知識」以前只在資料頁「⋯」選單裡（`D-124`）：同一件事（自己寫內容）的另一種深度，收在這一格一起講 -->
          <p class="kb-start__ptxt kb-start__ptxt--dim">
            只想加一條、自己指定客人會怎麼問？<button type="button" class="kb-start__fold" @click="emit('manual')">手寫一條</button>
          </p>
        </div>

      </div>


      <!--
        ⛔ 這裡曾經有一個「這是一份多樣商品的清單嗎」的勾選框（配兩行說明），2026-09-03
           `D-50` 簡化 1 整塊移除。理由：那是在**還沒看到任何內容**時問的問題，第一次匯入的人
           根本答不出來（勾錯的代價是客人問「你們賣什麼」時 AI 只能反問），而它卻佔掉第一步
           近半個視窗。真正有依據回答的時機是「整理完、看到切出幾條」——那個機制本來就在
           （見 overviewOffer：條數多就主動問一次，並老實講會再花一次 AI 用量）。
           ⚠️ 所以 overviewOffer 的來源型別**不可以再縮**：勾選框沒了之後，它是總表唯一的入口。
           2026-10-12（`D-123`②）一份也直接加入之後，那一問從預覽頁搬到結果頁。
      -->

      <!--
        「整理並加入」（`D-123`②，2026-10-12 老闆拍板）：以前一份要先看「AI 整理的結果」再按匯入，
        好幾份卻是直接匯入——同一件事兩種走法，本身就要解釋。現在一份也直接加入，
        只有要人核對的才停在預覽（見 previewStopReasons）。
      -->
      <div class="kb-import-actions">
        <el-button
          type="primary"
          data-tour="kb-preview"
          :loading="previewing || checkingUrlList"
          :disabled="!canPreview"
          @click="onPrimaryClick"
        >
          <!-- 整理中只轉圈、不換字：進度在下面的等待框講（以前按鈕、等待框、投放框同時三句「正在整理」） -->
          整理並加入
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
        <p class="kb-waiting__text">{{ autoImporting ? '加進知識庫，讓 AI 學起來⋯' : previewProgressText }}</p>
        <!--
          這段話要跟實際行為對得上,而行為已經換過三輪:
          ① 最早寫「關掉視窗回來就看得到結果」——但工作編號只活在記憶體裡,換頁或重整就撿不回來。
          ② 編號落地之後改成「回來會接著跑」,並老實加註「離開的期間會暫停在原地」
             （因為整理只在有人輪詢時才前進）。
          ③ 2026-09-03（`D-50` 簡化 3）維護排程接手推進,那句附註才真的可以拿掉。
          ④ 2026-10-12（`D-123`②）整理好直接加入。⚠️ 但「加進知識庫」那一下是這個視窗做的、不是排程：
             關掉視窗沒關係（元件還在），**離開知識庫這一頁**就要等回來才接著加——所以那半句要照實講。
          ⛔ 別把「好了會通知你」寫成「馬上」:排程約十分鐘一輪,人真的走開時完成會慢一點。
        -->
        <!-- `C-320` 減字：「不會從頭重來」拿掉（沒人問），「離開這一頁要回來才接著加」留著——那句會改變他走不走開 -->
        <p class="kb-waiting__note">
          內容長的話要幾分鐘。<strong>可以關掉視窗</strong>，整理好會自己加進知識庫（離開這一頁的話，回來才接著加）。
        </p>
        <!-- 加進去那一下停不了（卡片正在建），只有整理階段給取消 -->
        <el-button v-if="!autoImporting" size="small" text @click="cancelPreview">取消</el-button>
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
        <!-- 標題已經講「還在背景整理，好了會自己加進知識庫」：這裡只留會改變他下一步的那一句（別重傳） -->
        <div v-if="previewStillRunning">
          這期間不用重傳，<strong>重傳會變成兩份同時在跑</strong>。
        </div>
        <!-- 「分段貼」只對貼文字有用：以前每一種錯都附這句，檔案讀不到也叫人分段貼（2026-10-12 文字審視） -->
        <div v-else-if="mode === 'text'">內容很長的話，分成幾段分批貼進來。</div>
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
        <!--
          ⚠️ 第二顆以前叫「內容其實不一樣，重新整理一次」、整理完**另外建一份**——可是指紋一字不差時內容就是一樣的，
             那句不成立；而結果頁「原檔沒留成／空間不夠沒收齊」都是叫人再傳一次這份，會先被這張卡擋下來
             （2026-10-12 文字審視）。真正會再傳一次的人要的是**重做那一份**，所以直接換掉它，不多一份。
        -->
        <!-- `C-319`：同一件事只有一種說法——「更新原本那一份」（以前這顆叫「重新整理，換掉那一份」）。
             `C-320` 減字：「再整理一次會多一份」拿掉——畫面上已經沒有「另外再加一份」這條路，那句是在解釋一個不存在的選項 -->
        <div class="kb-dedup-body">
          <p class="text-xs">
            跟「<strong>{{ duplicateHit.name }}</strong>」（{{ duplicateHit.chunkCount }} 條，{{ relativeTime(duplicateHit.updatedAtMs) || '未更新' }}）一字不差。
          </p>
          <div class="flex gap-1">
            <el-button size="small" type="primary" plain @click="openDuplicateSource">看那一份</el-button>
            <el-button size="small" text @click="redoReplacingDuplicate">重新整理，更新原本那一份</el-button>
          </div>
        </div>
      </el-alert>
    </div>

    <!-- ── Step 1.5:整站匯入 — 頁面清單勾選 ─────────────── -->
    <div v-if="step === 'sitePages'">
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>{{ siteFinished ? '網站的頁面加好了' : '選擇要加入的頁面' }}</p>
      <!-- 「sitemap」是工程用語（`D-124` 新手走查）：講成「網站自己列的頁面清單」；一次貼好幾個網址的另講一句 -->
      <p class="kb-section-hint">
        <template v-if="siteFrom === 'pasted'">你貼了 <strong>{{ sitePages.length }}</strong> 個網址。</template>
        <template v-else>
          在 <strong>{{ siteHost }}</strong> 找到 <strong>{{ sitePages.length }}</strong> 頁
          （{{ siteFrom === 'sitemap' ? '網站自己列的頁面清單' : '這一頁上的連結' }}<span v-if="siteTruncated">，已達 {{ sitePages.length }} 頁上限</span>）<template v-if="checkedSiteCount && !siteImporting && !siteFinished">，先幫你勾了常被問的頁（運送、退換貨、常見問題、商品），要加減自己勾</template>。
        </template>
        <!-- `C-320` 減字：「AI 自動整理、自動辨識產品名、完成後可到資料列表檢查」拿掉——跑完的結論框與每一列自己會講 -->
        勾的每一頁<strong>各自成為一份資料</strong>。
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
          <!-- 跟一次好幾份的結論列同一句（`C-320` 減字：以前多講一次「沒有經過逐條預覽」） -->
          <template v-if="!siteSummary.failed && !siteSummary.warned && !siteSummary.notLearned">建議點開幾條看看內容對不對。</template>
        </div>
      </el-alert>

      <!-- 整站匯入完成後也要講「客人聽不聽得到」（D-40，與結果頁交棒卡同一句話） -->
      <div v-if="siteFinished && siteSummary.ok && aiEnabled === false" class="kb-handoff is-off">
        <div class="kb-handoff__main">
          <p class="kb-handoff__title">知識進庫了，但客人現在還聽不到</p>
          <!-- `C-320` 減字：「不會用在回覆客人上、開啟之後才會生效」是標題與「前往開啟」那顆按鈕已經在講的 -->
          <p class="kb-handoff__why"><strong>AI 客服還沒開啟</strong>。</p>
        </div>
        <el-button size="small" type="primary" @click="goEnableAi">前往開啟</el-button>
      </div>

      <!--
        這批放進了哪幾個商品分組（`D-127` 分組就是商品：放哪一組＝AI 當成哪一台）。整站匯入不逐頁預覽，
        同一台在不同頁被認成兩種寫法就會分成兩組、客人指名問時被反問「您指的是哪一台」，
        而且要等到有人發現才修得掉。至少讓人在這裡看一眼、知道去哪改。
      -->
      <div v-if="siteFinished && siteProductNames.length" class="kb-site-products">
        <p class="kb-site-products__head">
          這批放進了 {{ siteProductNames.length }} 個商品分組
          <span class="text-xs text-muted">（放錯的話，到左邊把那幾頁拖到對的那一組）</span>
        </p>
        <div class="kb-site-products__list">
          <span v-for="p in siteProductNames" :key="p.name" class="kb-site-product">
            {{ p.name }}
            <span class="kb-site-product__count">{{ p.pages }} 頁</span>
            <span v-if="p.isNew" class="kb-site-product__new">新</span>
          </span>
        </div>
        <p v-if="siteProductNames.some(p => p.isNew)" class="kb-site-products__note">
          標「新」的是這次新建的分組。<strong>其中有跟原本的是同一台</strong>的話，把那幾頁拖進原本那一組，再刪掉空的這一組。
        </p>
        <!-- `C-320` 減字：以前還有一行「另有 N 頁沒認出產品（…就是正常的）」——沒有要他做的事 -->
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
        <!-- 空間先講（`D-124`）：一頁大約 5 條，勾太多後面幾頁會因為空間不夠加不進去——整理的錢那時已經花了 -->
        <span v-if="siteRoomHint" class="text-xs" :class="siteRoomHint.tight ? 'kb-site-room is-tight' : 'text-muted'">· {{ siteRoomHint.text }}</span>
        <!-- `C-319`：資料頁那顆叫「立即更新」（以前叫「重新同步」） -->
        <span v-if="importedSiteCount" class="text-muted text-xs">
          · {{ importedSiteCount }} 頁以前加過了（不重複加入，要更新請到那一份按「立即更新」）
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
            <template v-else-if="p.imported">加過了</template>
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
          {{ siteImporting ? `加入中（${siteDoneCount}/${siteBatchTotal}）⋯` : `加入勾選的 ${checkedSiteCount} 頁` }}
        </el-button>
        <el-button v-if="siteFinished && !siteImporting" type="primary" plain @click="close">
          完成，去看知識庫
        </el-button>
      </div>
    </div>

    <!-- ── Step 1.5:一次好幾份檔案（`C-296`④）— 一份一列、各自跑、不逐條預覽 ── -->
    <KnowledgeFileBatch
      v-if="step === 'fileBatch'"
      ref="fileBatchRef"
      :files="batchFiles"
      :folders="allGroups"
      :group-registry="groupRegistry"
      :created-group-ids="createdGroupIds"
      :sources-in-groups="existingSources"
      :quota="quota"
      @back="leaveFileBatch"
      @close="close"
      @running="batchRunning = $event"
      @finished="onFileBatchFinished"
    />

    <!-- ── Step 2:預覽 + 編輯 ─────────────────────────── -->
    <div v-if="step === 'preview'">
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>{{ stoppedFor.length ? '加入之前先看一下' : 'AI 整理的結果' }}</p>
      <!--
        停在這裡的理由（`D-123`②）：一份本來會直接加入，停下來一定是因為下面有要他看的提醒。
        ⛔ 這一行不重講是哪幾件——每一件下面都有自己那句（截斷、空間、認字、同名），再列一次就是同一頁講兩遍。
      -->
      <p v-if="stoppedFor.length" class="kb-preview-stopped">還沒加進去，先看下面的提醒。</p>
      <!--
        ── 結論先行（2026-09-03 `D-50` 簡化 2）────────────────────────────
        整理完的第一眼必須是「AI 整理出幾條」，不是要填的欄位。
        ⛔ 摘要卡從清單下方搬到這裡，順序就是它存在的理由——別再把任何欄位插到它前面。
        `C-320`（2026-10-15 老闆拍板 `D-126`）：「所屬產品」「放進資料夾」兩格拿掉——上傳時不用選。
        AI 認的商品名照舊送出去（AI 答題看的是它）；分組照檔名＋商品名自動挑，這裡只剩一行「放在『X』・改」。
        什麼都比不到、AI 又認出一個商品時，那一行換成一題「這份在講哪個商品？」（見 KnowledgeImportGroupPick）。
      -->
      <div class="kb-preview-summary">
        <p class="kb-preview-summary__head">
          AI 整理出 <strong>{{ chunks.length }}</strong> 條知識<template v-if="includedCount !== chunks.length">，目前選了 {{ includedCount }} 條</template>
        </p>
        <p class="kb-preview-summary__meta">
          名稱：{{ sourceMeta.name || '未命名資料' }}
          <button type="button" class="kb-preview-summary__edit" @click="metaOpen = !metaOpen">
            {{ metaOpen ? '收起' : '改' }}
          </button>
        </p>
        <KnowledgeImportGroupPick
          class="kb-preview-summary__meta"
          :groups="allGroups"
          :model-value="groupShown"
          :new-name="groupNewName"
          :new-ids="createdGroupIds"
          :hints="groupHints"
          :ask="groupAsk"
          :busy="importing"
          @update:model-value="pickGroupBeforeImport"
        />
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
          其中 <strong>{{ numericChunkCount }}</strong> 條含金額或數字——
          <span class="kb-preview-summary__warn-cta">只看這幾條 →</span>
        </button>
        <!-- 放不下時收到滿為止（`C-296`）：按之前就講會收幾條、幾條不收，按鈕跟著改口 -->
        <p v-if="overQuotaBy > 0" class="kb-preview-summary__warn">
          <template v-if="fitChunkCount > 0">
            知識空間只剩 {{ roomLeft }} 條：這次會先收前 {{ fitChunkCount }} 條，其餘 {{ overQuotaBy }} 條先不收——刪掉用不到的知識<template v-if="billingLink">、或<NuxtLink :to="billingLink">升級方案</NuxtLink></template>就放得下。
          </template>
          <template v-else>
            知識空間滿了，這 {{ overQuotaBy }} 條放不進去——先刪掉用不到的知識<template v-if="billingLink">，或<NuxtLink :to="billingLink">升級方案</NuxtLink></template>。
          </template>
        </p>
        <div class="kb-preview-summary__actions">
          <!-- 重做清單跑到一半時擋住匯入:按下去會把「即將被取代的那一份」寫進知識庫。
               勾了總表時按鈕要把它算進去(見 importTotalLabel):按鈕說 20、結果頁說 21 是 `D-41` P0② -->
          <!-- keepLoading：還在讀原本那一份他改過哪幾條（`D-125`①），讀完才知道要不要帶 -->
          <el-button
            type="primary"
            :loading="importing"
            :disabled="includedCount === 0 || previewing || fitChunkCount === 0 || keepLoading"
            @click="runImport"
          >
            {{ importing ? '加入中⋯' : importButtonLabel }}
          </el-button>
          <el-button text @click="chunkListOpen = !chunkListOpen">
            {{ chunkListOpen ? '收起逐條檢查' : '先逐條檢查' }}
          </el-button>
          <el-button text @click="backToInput">← 換一份重新整理</el-button>
        </div>
      </div>

      <!--
        名稱：預設收起（見上面那張卡的說明）。
        ⚠️ 有同名警告時**強制展開**——那句提醒叫人「改個名字」，收起來的話畫面上沒有東西可按。
        `C-320`：「所屬產品」「放進資料夾」兩格搬走了（見上面摘要卡那段註解）；
        `C-134` 那個災情（東西都落在未分類、沒人記得拖）改由自動挑分組＋結果頁那一行「放在『X』・改」接住。
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
      </div>

      <el-alert
        v-if="ocrUsed"
        type="warning"
        show-icon
        :closable="false"
        class="kb-ocr-alert"
      >
        <template #title>
          {{ ocrFromPhoto ? '這張照片上的字由 AI 辨識' : '這份 PDF 是掃描檔，文字由 AI 辨識' }}
        </template>
        <div class="text-xs">辨識可能有錯漏（尤其數字、價格、電話），確認內容正確再加入。</div>
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
          整理時注意到 {{ healthWarnings.length }} 件事（不影響加入）
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
          {{ dupIsSameSheet ? '這份試算表已經接過了' : `已存在 ${dupMatches.length} 個同名資料` }}
        </template>
        <!--
          ⛔ 這裡原本唯一的建議是「改個名字」——照做的人就製造出第三份重複
          （2026-09-04 MYFEEL 同一本說明書並存三份、45 張重複卡，就是這樣長出來的）。
          人真正想做的事幾乎都是「我重傳了，用新的蓋掉舊的」，所以主要出口改成
          「更新原本那一份」；改名字降級成次要選項。
          `C-319`：這顆、按鈕、一次好幾份那一列都叫「更新原本那一份」（以前「更新這一份」「更新既有資料」「換掉舊的」三種講法）。
          `C-320` 減字：「你是要更新原本那一份，還是另外建一份？」拿掉——兩條路就是下面那顆按鈕和最後一行，再問一次是同一件事講兩遍。
        -->
        <div class="kb-dedup-body">
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
                {{ replaceTarget?.id === m.id ? '已選這一份' : '更新原本那一份' }}
              </el-button>
              <!-- 型別不同不給覆蓋（`C-139`）：講出「為什麼不能」，不要只是把按鈕藏起來 -->
              <span v-else class="text-xs text-muted">
                那份是{{ SOURCE_TYPE_LABEL[m.type ?? ''] ?? '別種' }}來源，不能用這份覆蓋
              </span>
            </li>
          </ul>
          <p class="text-xs">
            或在上面「資料名稱」改個名字，另外建一份。
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
          <!-- 帶過去的那幾條不進回收桶（`D-125`①）：數字要扣掉，⛔ 不另外再講一句（下面那一塊就在講它們）。
               `C-320` 減字：「換成這次整理好的內容。同步設定留著；資料夾沒改就留在原地」拿掉——標題已經說「會更新」，
               放哪一組上面那一行看得到 -->
          <p class="text-xs">
            這份資料原本的 {{ Math.max(0, replaceTarget.chunkCount - keptItems.length) }} 條知識會移到回收桶（30 天內都救得回來）。
          </p>
          <el-button size="small" text @click="cancelReplace">改成另外建一份新的</el-button>
        </div>
      </el-alert>

      <!--
        他在原本那一份改過的（`D-125`① 拍板 A）：換之前先問帶不帶到新版，預設全帶。
        每一條後面那半句講勾／不勾會變成什麼（新版有沒有同名的那一條）——⛔ 不另外寫一段說明，答案就在那半句。
      -->
      <div v-if="replaceTarget && (keepLoadFailed || keepCandidates.length)" class="kb-keep-edited">
        <template v-if="keepLoadFailed">
          <p class="kb-keep-edited__head">讀不到「{{ replaceTarget.name }}」裡你改過哪幾條</p>
          <p class="kb-keep-edited__note">
            直接換的話，你改過的也會一起移到回收桶（30 天內救得回來）。
            <button type="button" class="kb-start__fold" :disabled="keepLoading" @click="startKeepLoad(replaceTarget.id)">再讀一次</button>
          </p>
        </template>
        <template v-else>
          <p class="kb-keep-edited__head">你改過的 {{ keepCandidates.length }} 條，要帶到新版嗎？</p>
          <el-checkbox-group v-model="keepEditedIds" class="kb-keep-edited__list">
            <el-checkbox v-for="c in keepCandidates" :key="c.id" :value="c.id" class="kb-keep-edited__row">
              <span class="kb-keep-edited__title">{{ c.title }}</span>
              <span class="kb-keep-edited__suffix">{{ keepSuffix(c) }}</span>
            </el-checkbox>
          </el-checkbox-group>
        </template>
      </div>

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

      <!--
        「要不要再做一張『我們有賣什麼』」原本長在這裡（請 AI 把整份重讀一次）。`D-123`② 一份也直接加入之後，
        大部分人不會經過這一頁，所以搬到結果頁、改用已經進庫的那幾條合成（見 overviewOffer）——停在這裡的人加完也會看到。
      -->

      <div v-show="chunkListOpen" class="kb-bulk-actions">
        <!-- 篩選中時按鈕只作用在看得到的那幾條,標籤要講明白(見 visibleForBulk) -->
        <el-button size="small" plain @click="selectAll">
          {{ previewFilter === 'numeric' ? '全選這幾條' : '全選' }}
        </el-button>
        <el-button size="small" plain @click="selectNone">
          {{ previewFilter === 'numeric' ? '全不選這幾條' : '全不選' }}
        </el-button>
        <span class="text-muted text-xs">已選 {{ includedCount }} / {{ chunks.length }}</span>
        <!--
          試算表在這裡改的不會留下來（2026-10-12 文字審視，讀 gsheet-sync 確認、沒實跑）：加進去時內容指紋是空的、
          卡片也沒有「手動改過」記號，所以第一輪同步一定會比對——取消勾選的列被當成新增補回來、改過的內容被表格蓋回去。
          ⛔ 不講的話，他在這裡修好的錯字一小時後又回來了。
        -->
        <span v-if="sourceMeta.type === 'gsheet'" class="kb-filter-note">要改內容或拿掉哪幾條，請直接改試算表——這裡改的，下一次同步會照表格回復</span>
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

      <!-- 逐條檢查展開時,底部再放一次主動作(捲到最後不必再捲回去)。
           ⛔ 字與能不能按都要跟上面那顆一模一樣：以前這顆不看空間、也不看「重新整理中」——
              按鈕說 42 條、實際只收 12 條；重做清單跑到一半按下去，跑完還會把人從結果頁拉回預覽 -->
      <div v-show="chunkListOpen" class="kb-import-actions">
        <el-button @click="chunkListOpen = false">收起</el-button>
        <el-button
          type="primary"
          :loading="importing"
          :disabled="includedCount === 0 || previewing || fitChunkCount === 0 || keepLoading"
          @click="runImport"
        >
          {{ importing ? '加入中⋯' : importButtonLabel }}
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
      <p class="kb-step-label"><span class="kb-step-count">第 {{ stepProgress.index }} 步，共 {{ stepProgress.total }} 步</span>加好了</p>
      <!-- 「可用／失敗」是系統的話（`D-124` 新手走查）：失敗其實是「AI 還沒學起來、可以重試」，不是東西壞了 -->
      <div class="kb-result-summary">
        <div class="kb-result-stat">
          <span class="kb-result-label">整理出</span>
          <strong>{{ result.total }}</strong>
        </div>
        <div class="kb-result-stat kb-result-stat--success">
          <span class="kb-result-label">AI 學會了</span>
          <strong>{{ result.indexed }}</strong>
        </div>
        <div class="kb-result-stat" :class="result.failed ? 'kb-result-stat--danger' : ''">
          <span class="kb-result-label">還沒學起來</span>
          <strong>{{ result.failed }}</strong>
        </div>
      </div>

      <!--
        存成哪一份、放在哪一組（`D-123`②、`C-320`）：直接加入的話沒有人看過——「猜的一定要講出來」，而且要改得掉：
        一行「放在『X』・改」，按「改」就地換一組（已經加進去了，換＝搬過去，跟資料頁拖進分組同一支）。
        什麼都比不到、AI 又認出一個商品：這一行換成一題「這份在講哪個商品？」——預設的新分組已經替他建好放進去了，
        點別的就搬過去（⛔ 不為這一題停下來：關著視窗等它自己加完的那種，停下來＝知識一直沒加進去）。
        ⛔ 不再講「產品：○○」：分組就是商品，兩個名字並排只會讓人以為要對兩次。
        ⛔ 不加一顆「去看」：右下那顆就是打開這一份（關窗時父層會選中它）。
      -->
      <div v-if="result.sourceId" class="kb-result-saved">
        <span>存成「<strong>{{ sourceMeta.name.trim() || '未命名資料' }}</strong>」{{ savedGroup !== undefined && !groupAsk ? '，' : '' }}</span>
        <KnowledgeImportGroupPick
          v-if="savedGroup !== undefined"
          :groups="allGroups"
          :model-value="savedGroup"
          :new-name="groupNewName"
          :new-ids="createdGroupIds"
          :hints="groupHints"
          :ask="groupAsk"
          :moving="groupMoving"
          @update:model-value="moveSavedTo"
        />
      </div>
      <!--
        按「改」換了一組之後（`D-127` 分組就是商品）：AI 現在把它當成哪一台講一句；
        搬是搬過去了、重新學習那一步沒成（groupSync.error）：⛔ 不講成搬失敗
      -->
      <p v-if="groupSyncNote" class="kb-group-fill" :class="{ 'is-warn': groupSync?.kind === 'failed' }">{{ groupSyncNote }}</p>

      <!--
        AI 整理成哪幾條（`D-124` 新手走查）：以前這裡只有「3／3／0」三個數字，要再按「打開這一份」才看得到那 3 條是什麼——
        一份直接加入之後，這是他第一次、也常常是唯一一次看到 AI 做了什麼。Gemini Notebook 每份會附一段摘要，這是我們的版本。
        只列前 5 條標題：要看內容、要改，右下那顆就是打開這一份。
      -->
      <div v-if="resultTitles.length" class="kb-result-titles">
        <p class="kb-result-titles__head">AI 整理成這幾條：</p>
        <ul class="kb-result-titles__list">
          <li v-for="(t, i) in resultTitles.slice(0, 5)" :key="i">{{ t }}</li>
        </ul>
        <!-- `C-320` 減字：「按『打開這一份』看全部、逐條改」拿掉——那顆按鈕就在右下角 -->
        <p v-if="resultTitles.length > 5" class="kb-result-titles__more">還有 {{ resultTitles.length - 5 }} 條</p>
      </div>

      <!--
        蓋掉東西一定要講出來，而且要講「舊的去哪了」（`C-135`）。
        只報新的幾條、不提舊的幾條被換掉，等於讓人以為知識庫變多了。
      -->
      <p v-if="result.replacedChunks || result.keptEdited" class="kb-section-hint">
        <template v-if="result.replacedChunks">
          這份資料原本的 <strong>{{ result.replacedChunks }}</strong> 條知識已換成上面這批；
          舊的移到<strong>回收桶</strong>，30 天內都救得回來。
        </template>
        <!-- 帶過去的那幾條（`D-125`①）：伺服器說留了幾條就講幾條（⛔ 不照畫面上勾的數，伺服器會再驗一次） -->
        <template v-if="result.keptEdited">你改過的 <strong>{{ result.keptEdited }}</strong> 條帶到新版了。</template>
      </p>

      <!-- 原檔沒留成要講（`C-296`③）：不講的話，之後找「下載原檔」才發現沒有，還以為是系統壞了 -->
      <!-- ⛔ 不猜原因：沒留成的路不只一條（放太久暫存被清、存檔那一下失敗），講錯原因比不講還誤導 -->
      <!-- `C-319`：補原檔的路改講資料頁那顆「上傳新版」（以前叫人「再傳一次、選擇換掉原本那一份」，要先撞一次同名才問得到） -->
      <p v-if="result.originalKept === false" class="kb-quota-line is-full">
        這份的原檔這次沒有留下來；知識照常可以用。要能「下載原檔」，在那一份按「上傳新版」再傳一次。
      </p>

      <!-- 沒收進去的要說得出來（`C-296` 收到滿為止）：只報收了幾條，等於讓人以為整份都進去了 -->
      <!-- 補齊的路照來源講：試算表每小時自己同步，空間一空出來就會補上，不用他動手（叫他「再傳一次」是錯的） -->
      <p v-if="quotaSkipped > 0" class="kb-quota-line is-full">
        還有 <strong>{{ quotaSkipped }}</strong> 條因為知識空間不夠沒收進去。刪掉用不到的知識<template v-if="billingLink">、或<NuxtLink :to="billingLink">升級方案</NuxtLink></template>之後，{{ quotaRefillHint }}
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
          <!-- `C-320` 減字：開著的時候不再補一句「在下面問它一題試試」（那顆按鈕就在下面）；
               關著的時候只講原因，「不會用在回覆客人上、開了才生效」是標題與「前往開啟」已經在講的 -->
          <p v-if="!aiEnabled" class="kb-handoff__why"><strong>AI 客服還沒開啟</strong>。</p>
        </div>
        <el-button v-if="!aiEnabled" size="small" type="primary" @click="goEnableAi">前往開啟</el-button>
      </div>

      <!--
        試問一題:拿剛匯入的內容真的問一次(不進統計),答得出來才敢說「學會了」。
        ⚠️ 2026-10-12（`D-124` 新手走查）：以前是一顆寫「試問一題」的小灰鈕，沒講不算額度、不會傳給客人——新手不敢按。
           旁邊接「到測試對話多問幾題」：測試對話會列出 AI 用了哪幾條、各自多像，那是我們的「出處」，以前加完沒人帶他去。
      -->
      <div v-if="result.indexed > 0 && verifyQuery" class="kb-handoff-verify">
        <div class="kb-handoff-verify__row">
          <el-button
            size="small"
            plain
            :loading="verifying"
            @click="runVerify"
          >
            {{ verifyOutcome ? '再問一次' : `問 AI 一題試試：「${verifyQuery.slice(0, 16)}${verifyQuery.length > 16 ? '…' : ''}」` }}
          </el-button>
          <span class="text-xs text-muted">不算額度、不會傳給客人</span>
          <el-button size="small" link type="primary" @click="goPlayground">到測試對話多問幾題 →</el-button>
        </div>
        <p v-if="verifyOutcome" class="kb-handoff-verify__out" :class="`is-${verifyOutcome.tone}`">
          {{ verifyOutcome.text }}
        </p>
      </div>

      <!-- 整理時的提醒（示範列沒換、含時效內容⋯）：直接加入沒經過預覽，在這裡講；停過預覽的人已經看過，不重講 -->
      <el-alert
        v-if="autoImported && healthWarnings.length"
        type="warning"
        show-icon
        :closable="false"
        class="kb-health-warnings"
      >
        <template #title>
          整理時注意到 {{ healthWarnings.length }} 件事，打開這一份看一下
        </template>
        <ul class="kb-health-list">
          <li v-for="(w, i) in healthWarnings" :key="i">{{ w }}</li>
        </ul>
      </el-alert>

      <!--
        「要不要再做一張『我們有賣什麼』」——看得到條數才問得出來的那一次（搬自預覽頁，見 overviewOffer）。
        ⛔ 要老實講會再花一次 AI 用量、佔 1 條空間。
      -->
      <div v-if="overviewOffer" class="kb-overview-suggest">
        <template v-if="overviewState === 'ask' || overviewState === 'busy'">
          <!-- 不再講「這份有 N 條」：上面的數字格、交棒卡已經各講一次（同一頁三次，2026-10-12 截圖看到） -->
          <p class="kb-overview-suggest__text">
            這份看起來列了很多樣商品，要不要再做一張「我們有賣什麼」的清單？客人問「你們有賣哪些」時才能一次答完，不會被反問。
          </p>
          <div class="kb-overview-suggest__actions">
            <el-button size="small" type="primary" plain :loading="overviewState === 'busy'" @click="makeOverview">做一張</el-button>
            <el-button size="small" text :disabled="overviewState === 'busy'" @click="overviewState = 'dismissed'">不用</el-button>
            <span class="text-xs text-muted">AI 會照這份整理一次（算一次用量、佔 1 條空間）</span>
          </div>
        </template>
        <p v-else-if="overviewState === 'made'" class="kb-overview-suggest__text">做好了：客人問「你們有賣哪些」時，會先用這張清單回答。</p>
        <p v-else-if="overviewState === 'none'" class="kb-overview-suggest__text">AI 沒能從這份做出清單（看起來不是商品清單）；其他知識不受影響。</p>
      </div>

      <div v-if="result.failed > 0" class="kb-result-failed-list">
        <div class="kb-failed-head">
          <!-- `C-320` 減字：「大多是暫時性問題，就在這裡按重試即可」拿掉——每一列自己講原因、重試鈕就在旁邊 -->
          <p class="kb-section-hint">
            這幾條 AI 還沒學起來（客人問到會找不到）。
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
        <el-button @click="resetAll">再加一份</el-button>
        <!-- 關窗時父層會選中這一份（onDialogClose → imported）：按鈕直接講會發生什麼 -->
        <el-button type="primary" @click="close">{{ result.sourceId ? '打開這一份' : '完成' }}</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { Document as IconFile, EditPen as IconPen, Grid as IconSheet, Link as IconWeb, QuestionFilled } from '@element-plus/icons-vue'
import { canReplaceSource, detectImportKind, detectSheetAmongUrls, detectUrlList, GSHEET_PATTERN, HTTP_URL_PATTERN, sheetLinkOf } from '~~/shared/knowledge-import-detect'
import { GSHEET_PROBE_READABLE } from '~~/shared/gsheet-probe-status'
import {
  KNOWLEDGE_FILE_ACCEPT,
  KNOWLEDGE_FILE_KIND_LABEL,
  KNOWLEDGE_FILE_LABEL,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeFileKind,
  unsupportedFileHint,
} from '~~/shared/knowledge-file-types'
import {
  autoImportGroup,
  createImportGroupRegistry,
  type GroupSyncOutcome,
  groupSyncNoteText,
  type ImportGroup,
  type ImportGroupChoice,
  moveSurelyRejected,
  newGroupName,
  parseGroupSync,
  writeMayHaveLanded,
} from '~~/shared/knowledge-import-group'
import { KB_IMPORT_DIALOG_STEPS } from '~/utils/tutorial-topics'
import { PREVIEW_JOB_DEADLINE } from '~/composables/usePreviewJobPoll'
// 型別要明寫（自動匯入只帶函式，不帶 type）
import type { KbVerifyOutcome } from '~/utils/kb-verify-outcome'
import { batchRejectReasons, type FileBatchSnapshot, type FileBatchSummary } from '~/utils/kb-file-batch'
import { CARDS_PER_PAGE_ESTIMATE, recommendSitePages, sitePageGroup } from '~/utils/kb-site-pages'
import { EMPTY_FILE_HINT } from '~/utils/knowledge-upload'
import { apiErrorStatus, apiErrorText, isRetryableError } from '~/utils/api-error-text'
import { knowledgeTitleKey } from '~~/shared/knowledge-title-key'

const props = defineProps<{
  modelValue: boolean
  /**
   * 父層的完整資料清單:同名警告要比對「全部」既有名稱——
   * 只比對 preview 回傳的(原始名稱的)同名清單,會漏掉「改名撞進另一個既有資料」的情況。
   * folderId（`C-320`）：「更新原本那一份」時那一份現在放哪一組（畫面照實講）；改放別組時也拿來看那一組還有沒有別份。
   */
  existingSources?: Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number; type?: string; folderId?: string | null }>
  /**
   * 父層的分組清單（`C-320` 起畫面上叫「分組」，資料裡還是 folders；general＝「通用」那一組）：
   * 加入時照檔名＋AI 認的商品自動挑一組。沒有這個的話，每一份匯進來的東西都掉在「未分類」，要靠人事後拖——
   * 而人不會記得（`C-134`：MYFEEL 的說明書因此躺在未分類，店家去產品資料夾找說「沒有」）。
   */
  folders?: Array<{ id: string; name: string; general?: boolean }>
  /**
   * 開窗時要先填進去的東西（`D-85` / `C-221`）：開通精靈那顆「把網站整理成知識卡」
   * 會帶著商家的官網網址過來，⛔ 落在一個空白的貼上框等於叫他再打一次字。
   * 填進去之後由既有的偵測流程接手（貼上框自己認得出網址／試算表／純文字）。
   */
  prefillPaste?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 有實際建立資料時觸發(全成功或部分成功),父層應刷新資料列表 */
  'imported': [sourceId: string | null]
  /**
   * 這份匯入工作現在的狀態,讓父層在視窗關著時也能顯示「還在整理／整理好了」。
   * 沒有這個訊號的話,關掉視窗去做別的事的人回來只會看到一片乾淨畫面(見 resumeStoredJob 的說明)。
   */
  'job-state': [state: 'running' | 'batch' | 'ready' | 'added' | 'none']
  /** 「還沒整理好」那格的「手寫一條」：父層關掉這個視窗、打開手寫一條知識的編輯框 */
  'manual': []
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
  // 預覽頁上第一步的投放框已經不在了：沒寫 requiresPresent 的那幾步一律補「錨點在才走」，
  // 不然聚光燈打在空氣上（只改這次臨時跑的副本，⛔ 不動導覽主題本身——動它＝全員重跑一次）
  void startAdHocTour(KB_IMPORT_DIALOG_STEPS.map(s => ({ ...s, clickBefore: undefined, requiresPresent: s.requiresPresent ?? s.target })))
}
const { showToast } = useAdminToast()

type ImportMode = 'file' | 'url' | 'text' | 'gsheet'
type Step = 'input' | 'sitePages' | 'fileBatch' | 'preview' | 'result'

const step = ref<Step>('input')
/**
 * 「第幾步／共幾步」（D-40）。四種畫面卻沒有任何進度指示，而第一步可能要等好幾分鐘
 * ——等待畫面還明說「可以先關掉視窗去做別的事」，那就更該先講清楚全程有多長。
 * 判斷抽在 utils（有測試守著總數不會跳動）。
 */
const stepProgress = computed(() => kbImportStepProgress(step.value, { siteFinished: siteFinished.value, processing: previewing.value }))
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
  /**
   * 表格的讀法（Excel、CSV、Google 試算表**同一套**，見 server/utils/google-sheets.ts）——2026-10-12 文字審視統一成一句：
   * 以前試算表那句還叫人「第一欄不要放編號」（流水號早就自動換成下一欄）、沒講每頁都讀，Excel 那句卻有講，兩邊各說各的。
   * 「一列一條」仍然是規則（`D-77` 起表格不給 AI 切），括號裡是會讓條數比列數少的兩種例外：名稱一樣的併成一條、第一欄空白的接在上一條。
   */
  const TABLE_RULE = '每一列變成一條知識（名稱一樣的併成一條、第一欄空白的接在上一條）：欄位名稱在哪一列會自己找，第一欄當標題，其餘欄位當內容；每個分頁都會讀（使用說明頁除外）。'
  if (selectedFile.value) {
    const kind = knowledgeFileKind(fileName.value) ?? 'pdf'
    // 「想改了自動更新改用 Google 試算表」只對表格講：PDF、Word 換成試算表不是一個真的選項
    const autoSync = '想改了表格 AI 就跟著更新，改用 Google 試算表。'
    const hintByKind: Record<typeof kind, string> = {
      xlsx: `${TABLE_RULE}${autoSync}`,
      csv: `${TABLE_RULE}購物平台匯出的 Big5 編碼也讀得懂。${autoSync}`,
      pdf: '由 AI 判斷怎麼分段。用拍的、掃的檔案會由 AI 認字，加入之前會先停下來讓你核對數字與價格。',
      docx: '由 AI 判斷怎麼分段；文件裡的表格會照欄位讀，不會攤成一串字。',
      pptx: '每一張投影片上的文字都會讀；圖片上的字讀不到——重點寫在圖上的話，那幾張另外存成圖片傳上來。',
      // ⛔ 以前這裡寫「之後要改就直接編輯那一條」，旁邊那行卻說「改了要重新上傳」——同一個畫面兩種說法（2026-10-12 文字審視）
      text: 'AI 會讀完內容、自己判斷怎麼切成一條條知識。',
      image: '由 AI 認照片上的字（價目表、菜單、DM 都可以），加入之前會先停下來讓你核對數字與價格。一張照片會整理成一份資料。',
    }
    return {
      label: KNOWLEDGE_FILE_KIND_LABEL[kind],
      sync: '加進去就固定：檔案之後改了，要再傳一次',
      syncTone: 'static' as const,
      hintLabel: '怎麼變成知識？',
      hint: hintByKind[kind],
    }
  }
  if (!pasteInput.value.trim()) return null
  // 好幾個連結夾了試算表（2026-10-13 `/code-review`）：以前整串被當試算表，其他網址默默不見——講清楚、開始鈕也同一個判斷鎖住
  if (sheetAmongUrls.value) {
    return {
      label: '網址和 Google 試算表混在一起',
      sync: '試算表連結請單獨貼一次：它要先確認讀不讀得到，之後每小時跟著更新。網址可以先加，加完再貼試算表',
      syncTone: 'static' as const,
      hintLabel: '',
      hint: '',
    }
  }
  if (urlList.value) {
    return {
      label: `${urlList.value.length} 個網址`,
      sync: '每個網址各自成為一份資料；之後網頁小改自己跟著更新，大改先等你看過',
      syncTone: 'semi' as const,
      hintLabel: '抓不到內容？',
      hint: '只抓網頁上的文字。需要先登入、或要按按鈕才顯示內容的頁面可能抓不到；商城首頁的商品區塊常是動態載入，請改貼商品列表頁。',
    }
  }
  if (mode.value === 'gsheet') {
    return {
      label: 'Google 試算表',
      sync: '你改試算表，AI 每小時自己跟著更新',
      syncTone: 'live' as const,
      hintLabel: '怎麼變成知識？',
      // ⚠️ 「在後台改過的不會被蓋掉」講的是加進去之後在資料頁改的那幾條；預覽頁裡改的不算（見預覽頁那句）
      hint: `${TABLE_RULE}加進去之後，你在資料頁改過的那幾條，同步時不會被表格蓋掉。`,
    }
  }
  if (mode.value === 'url') {
    return {
      label: '網頁',
      // ⛔ 以前寫「之後網頁改了會通知你」：小改其實是自己套用、不通知（cron-maintenance 的 auto_applied），
      //    資料頁與「整理與更新」導覽講的才對——三處三種講法（2026-10-12 文字審視）
      sync: '會定期重抓：小改自己跟著更新，大改先等你看過',
      syncTone: 'semi' as const,
      hintLabel: '抓不到內容？',
      hint: '只抓網頁上的文字。需要先登入、或要按按鈕才顯示內容的頁面可能抓不到；商城首頁的商品區塊常是動態載入，請改貼商品列表頁。',
    }
  }
  // 字數留在永遠看得見的那一行（不收進展開）：貼上文字唯一會撞到的牆就是 10 萬字上限，
  // 而瀏覽器是**靜默**截斷的——這個數字是使用者唯一能提前發現的訊號
  return {
    label: '一段文字',
    sync: `加進去就固定，之後到資料頁逐條改（目前 ${pasteInput.value.trim().length.toLocaleString('zh-TW')} 字，上限 100,000 字）`,
    syncTone: 'static' as const,
    hintLabel: '怎麼變成知識？',
    hint: 'AI 會讀完內容、自己判斷怎麼切成一條條知識。',
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
/**
 * 一次貼了好幾個網址（`D-124`）：不是 null 就走整站加入那條路（見 runUrlList）。
 * ⚠️ 必須排在 selectedFile 之後、hintOpen 那個 watch 之前：detected 會讀它，而那個 watch 註冊當下就求值（同下面那顆 TDZ 雷）
 */
const urlList = computed(() => (selectedFile.value ? null : detectUrlList(pasteInput.value)))
/** 好幾個連結裡夾了 Google 試算表：哪一條路都不收，要他分開貼（見 detectSheetAmongUrls）。排在 urlList 旁邊，理由同上 */
const sheetAmongUrls = computed(() => !selectedFile.value && detectSheetAmongUrls(pasteInput.value))

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
 * 「還沒有現成資料」五顆選項的展開狀態（'' = 都收起）。
 * 一次只開一條：全開就回到一版「250 字同時攤開」的老問題（老闆：快 fade out）——
 * 四版把選項從三顆加到五顆之後，這條規矩比先前更重要，不可以改成多開。
 * ⛔ 刻意不在 resetAll／關窗時清掉：走試算表那條的人會中途去 Google 分享，
 *    回來時面板要還開著、帳號還在眼前。
 */
const startOpen = ref<'' | 'sheet' | 'text' | 'web'>('')

/** 點投放框的空白處＝聚焦輸入框；點到框裡的按鈕（選擇檔案）就讓按鈕自己來 */
function focusPaste(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest('button, a, input, textarea')) return
  pasteInputEl.value?.focus?.()
}

function pickStart(route: 'sheet' | 'text' | 'web' | 'file') {
  // 「檔案」那格不展開說明，直接開選檔視窗（收不了的選到時當場講，見 acceptFile）
  if (route === 'file') {
    fileInputEl.value?.click()
    return
  }
  startOpen.value = startOpen.value === route ? '' : route
  // 官網與「還沒整理好」的「動作」都是在上面那個框裡輸入：把游標放進去，使用者回來直接打字／⌘V 就能用。
  // ⛔ 試算表那格不要搶焦點：它的下一步是按面板裡的按鈕（用範本建一份／複製帳號），
  //    游標被拉走只會讓人以為自己點錯了。
  if (startOpen.value === 'web' || startOpen.value === 'text') nextTick(() => pasteInputEl.value?.focus?.())
}

watch([pasteInput, mode], () => {
  const v = pasteInput.value.trim()
  urlInput.value = mode.value === 'url' ? v : ''
  // 只拿連結本身（旁邊夾的字不帶進去，不然會被存成這份試算表的網址）
  gsheetInput.value = mode.value === 'gsheet' ? sheetLinkOf(v) : ''
  textInput.value = mode.value === 'text' ? pasteInput.value : ''
})

/** 檔案共用入口:選檔與拖放都走這裡,上限與型別檢查只有一份（收哪些看 shared/knowledge-file-types） */
function acceptFile(file: File | undefined | null): boolean {
  if (!file) return false
  // 畫面上的欄位鎖住了,但拖放不經過那些欄位——這一層才是真的守門（`D-41` 死路⑪）
  if (previewing.value) {
    showToast('正在整理目前這一份，要換的話請先按「取消」', 'warning')
    return false
  }
  if (!knowledgeFileKind(file.name)) {
    // 收不了要當場講怎麼辦（舊版 .doc → 另存 .docx），不是只說「不支援」
    showToast(unsupportedFileHint(file.name), 'error')
    return false
  }
  if (file.size > KNOWLEDGE_FILE_MAX_BYTES) {
    showToast('檔案超過 10MB 上限', 'error')
    return false
  }
  if (file.size === 0) {
    // 空檔當場講：以前照樣上傳、等伺服器回「內容為空」，白等一輪
    showToast(EMPTY_FILE_HINT, 'error')
    return false
  }
  selectedFile.value = file
  fileName.value = file.name
  fileSizeKb.value = Math.round(file.size / 1024)
  fileContentType.value = file.type
  pasteInput.value = '' // 檔案優先:避免同時有檔案又有貼上內容而判別不出來
  return true
}

/**
 * 一次好幾份（`C-296`④）：兩份以上就換到逐份清單那一步（KnowledgeFileBatch），
 * 只有一份照舊走有預覽的那條路。⛔ 以前多拖的只取第一份、其餘默默丟掉——
 * 收不了的現在也進清單、標原因，不會少一份沒人知道。
 */
const batchFiles = ref<File[]>([])
const batchRunning = ref(false)
const fileBatchRef = ref<{ abort: () => void, isRunning: () => boolean, snapshot: () => FileBatchSnapshot } | null>(null)
function acceptFiles(list: FileList | File[] | null | undefined): boolean {
  const files = Array.from(list ?? [])
  if (files.length >= 2) {
    if (previewing.value) {
      showToast('正在整理目前這一份，要換的話請先按「取消」', 'warning')
      return false
    }
    // 放了好幾份、但收得了的只有一份：那一份照常走單份路（有要核對的會停在預覽，見 previewStopReasons），
    // 收不了的那幾份在這裡講原因——⛔ 不可以默默少掉（2026-10-11 審查：以前這種會走沒有預覽的批次路）
    const reasons = batchRejectReasons(files)
    const usable = files.filter((_, i) => !reasons[i])
    if (usable.length === 1) {
      const others = files.map((f, i) => ({ name: f.name, reason: reasons[i] })).filter(o => o.reason)
      if (!acceptFile(usable[0])) return false
      showToast(`另外 ${others.length} 份收不了：${others.slice(0, 2).map(o => `「${o.name}」${o.reason}`).join('；')}${others.length > 2 ? '⋯' : ''}`, 'warning')
      return true
    }
    clearFile()
    pasteInput.value = ''
    batchFiles.value = files
    step.value = 'fileBatch'
    return true
  }
  return acceptFile(files[0])
}
function leaveFileBatch() {
  // 這一批有建出東西：清單現在就刷新、結果不留到下一份——留著的話，之後在第一步做的單份預覽
  // 一關窗就會被當成「匯入完成」整個清掉（2026-10-11 審查實測：付了錢的預覽與記號都沒了）
  if (result.value) {
    emit('imported', null)
    result.value = null
  }
  batchFiles.value = []
  step.value = 'input'
  if (fileInputEl.value) fileInputEl.value.value = ''
}
/**
 * 視窗是不是「看得到」。⚠️ 不能直接看 modelValue：el-dialog 先發 close、等關閉動畫跑完才發
 * update:modelValue(false)，中間約 0.3 秒 modelValue 還是 true——一批剛好在這時跑完，
 * 會被當成「視窗開著」而不講結論、也不刷新清單（2026-10-11 審查）
 */
const dialogShown = ref(props.modelValue)
watch(() => props.modelValue, (v) => { dialogShown.value = v })

/** 這一批跑完：有建出東西就讓關窗時刷新清單；視窗已經關了就當場刷新並講一句（同整站匯入） */
function onFileBatchFinished(summary: FileBatchSummary) {
  void loadQuota()
  // 視窗已經關了（中途按 ✕ 停下）：清單沒機會給人看，**做了什麼、沒做成什麼**都要在這一句講完
  // （還沒開始就停下的也要講：以前只說「已匯入 2 份」，另外 8 份去哪了沒人知道）
  if (!dialogShown.value) {
    const notDone = [
      summary.quotaShort ? `${summary.quotaShort} 條因為空間不夠沒收` : '',
      summary.failed ? `${summary.failed} 份沒有匯入` : '',
      summary.conflicts ? `${summary.conflicts} 份跟現有資料同名、沒有匯入` : '',
      summary.notStarted ? `${summary.notStarted} 份還沒開始就停下了` : '',
    ].filter(Boolean).join('、')
    if (summary.sources) emit('imported', null)
    showToast(
      summary.sources
        ? `已匯入 ${summary.sources} 份檔案（${summary.cards} 條）${notDone ? `；${notDone}` : ''}`
        : `這一批沒有匯入任何一份${notDone ? `（${notDone}）` : ''}`,
      summary.sources && !notDone ? 'success' : 'warning',
    )
    resetAll()
    return
  }
  if (!summary.sources) return
  result.value = { sourceId: null, total: summary.cards, indexed: summary.cards, failed: 0, items: [] }
}

function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement
  if (!acceptFiles(target.files)) target.value = ''
}

/**
 * 視窗開著時，檔案掉在「不收檔案的地方」不可以讓瀏覽器整頁打開它。
 * 第一步那個投放區自己收（它先 prevent、事件再冒泡上來，這裡看到 defaultPrevented 就不管）；
 * 其餘畫面——一次好幾份的清單、預覽、結果頁、視窗外的遮罩——以前全都沒擋：
 * 一批跑到一半再拖一份進清單，整頁就換成那個檔案，這一批跑到哪、匯了什麼全看不到（2026-10-11 審查實測）。
 */
function isFileDrag(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}
function guardStrayDragOver(e: DragEvent) {
  if (isFileDrag(e)) e.preventDefault()
}
function guardStrayDrop(e: DragEvent) {
  if (!isFileDrag(e) || e.defaultPrevented) return
  e.preventDefault()
  showToast(
    step.value === 'fileBatch'
      ? '這一批已經在清單上了；要再加檔案，請按「上一步」回去再放'
      : '要換一份資料，請先回到第一步再放進框裡',
    'warning',
  )
}
function setStrayDropGuard(on: boolean) {
  if (!import.meta.client) return // 伺服器端算畫面時沒有 window
  if (on) {
    window.addEventListener('dragover', guardStrayDragOver)
    window.addEventListener('drop', guardStrayDrop)
  }
  else {
    window.removeEventListener('dragover', guardStrayDragOver)
    window.removeEventListener('drop', guardStrayDrop)
  }
}
watch(() => props.modelValue, setStrayDropGuard, { immediate: true })
onBeforeUnmount(() => setStrayDropGuard(false))

const dragOver = ref(false)
function onDrop(e: DragEvent) {
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (files?.length) {
    acceptFiles(files)
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
/** 讀得到這份試算表（打勾、不出分享說明）：哪幾種算見 shared/gsheet-probe-status */
const gsheetReadable = computed(() => (GSHEET_PROBE_READABLE as readonly string[]).includes(gsheetProbe.value?.status ?? ''))
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
      detail: apiErrorText(err, '').slice(0, 200) || undefined,
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
// 預覽階段不再請 AI 做總表（`D-123`②：改成加完之後在結果頁問，見 overviewOffer）；
// 這裡留著是給「接回以前帶著總表的整理工作」用的
type OverviewCard = { included: boolean; title: string; content: string; tags: string[]; questions: string[] }
const overviewCard = ref<OverviewCard | null>(null)

// ── Preview ───────────────────────────────────────────────
/** 整理中（含整理好之後自動加入那一下）：第一步的輸入一律鎖住、等待框顯示 */
const previewing = ref(false)
/**
 * 整理好、正在自動加入（`D-123`②）。⚠️ 這段期間 previewing 刻意**還是 true**：輸入鎖、拖放守門、
 * 側欄「整理中」全都沿用同一個旗標，不必每個地方再多判斷一個；差別只在等待框的字與「取消」不給按
 * （卡片正在建，停不了——這時候按取消會把整理工作刪掉，伺服器卻已經在用它的暫存檔留原檔）。
 */
const autoImporting = ref(false)
/** 這一份是自動加進去的（沒經過預覽）：結果頁要補講預覽頁原本會講的事（存成哪一份、整理時的提醒） */
const autoImported = ref(false)
/**
 * 停在預覽的理由（`D-123`②）——停下來那一刻的快照：畫面上講「還沒加進去，先看下面的提醒」用。
 * 用快照不用即時算：他照提醒改了名字、同名提醒消失之後，標題不該跟著改口說「AI 整理的結果」。
 */
type PreviewStopReason = 'ocr' | 'truncated' | 'quota' | 'sameName' | 'edited'
const stoppedFor = ref<PreviewStopReason[]>([])
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
/** 後面沒讀到的其他幾種（見 PreviewResult.incomplete）：跟 truncated 一樣要停在預覽，但畫面上講的是 warnings 那一句 */
const incomplete = ref(false)
const ocrUsed = ref(false) // 掃描檔 PDF 由 AI 辨識文字 → 預覽時提醒逐張確認
const ocrFromPhoto = ref(false) // 認字的是照片（`C-296`）：同一句提醒，主詞換成「這張照片」
const healthWarnings = ref<string[]>([]) // 表格資料的匯入前健檢警告（提醒不擋匯入）
const chunks = ref<Array<{ included: boolean; title: string; content: string; tags: string[]; questions: string[] }>>([])
const existingMatches = ref<Array<{ id: string; name: string; chunkCount: number; quotaChunkCount?: number; updatedAtMs: number; type?: string; sameSheet?: boolean }>>([])
const sourceMeta = ref({
  type: '' as ImportMode | '',
  name: '',
  url: '',
  /**
   * AI 認的商品名；'' = 非單一產品資料。`C-320` 起畫面上不再給改（「所屬產品」那一格拿掉了），照原樣送出去——
   * ⛔ 不可以換成分組的名字：AI 答題看的是它，分組只是放在哪裡
   */
  productName: '',
  /** 網址來源的內容指紋（存成 source.appliedContentHash＝重新同步的比對基準） */
  contentHash: '',
})

// ── 放在哪一組（`C-320`，2026-10-15 老闆拍板 `D-126`：上傳時不用選）──────────────
/**
 * 這次開窗替他建的分組（「新分組『X』」）：頁面的分組清單要等關窗才重讀，在那之前第二份要比得到它、
 * 選單上要看得到它；他改放別組、又沒有別份在用時，替他刪掉（規則在 shared/knowledge-import-group 的 registry）。
 */
const localGroups = ref<ImportGroup[]>([])
const removedGroupIds = ref<string[]>([])
/** 這次標成「通用」的既有分組（手建的「通用」沒標，見 registry.ensure 的 general；`/code-review` ⑫） */
const markedGeneralIds = ref<string[]>([])
const groupRegistry = createImportGroupRegistry(
  {
    // general：選了「通用」、還沒有那一組（伺服器 `C-320` 起收這一格）
    create: (name, { general }) => apiFetch<ImportGroup>('/api/ai/folders', { method: 'POST', body: { name, ...(general ? { general: true } : {}) } }),
    remove: id => apiFetch(`/api/ai/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    markGeneral: id => apiFetch(`/api/ai/folders/${encodeURIComponent(id)}`, { method: 'PUT', body: { general: true } }),
  },
  {
    onCreated: (g) => { localGroups.value = [...localGroups.value, g] },
    onRemoved: (id) => {
      localGroups.value = localGroups.value.filter(g => g.id !== id)
      removedGroupIds.value = [...removedGroupIds.value, id]
    },
    onMarkedGeneral: (g) => { markedGeneralIds.value = [...markedGeneralIds.value, g.id] },
  },
)
/** 頁面的分組＋這次建的（同一組只算一次），扣掉這次刪掉的、補上這次標成通用的（頁面清單關窗才重讀） */
const allGroups = computed<ImportGroup[]>(() => {
  const removed = new Set(removedGroupIds.value)
  const marked = new Set(markedGeneralIds.value)
  const fromPage = (props.folders ?? []).filter(f => !removed.has(f.id)).map(f => (marked.has(f.id) ? { ...f, general: true } : f))
  const seen = new Set(fromPage.map(f => f.id))
  return [...fromPage, ...localGroups.value.filter(g => !seen.has(g.id))]
})
const createdGroupIds = computed(() => localGroups.value.map(g => g.id))
/** 系統自動挑的那一組（applyPreviewResult 算一次；「改成另外建一份」時退回這一組） */
const autoGroup = ref<{ choice: ImportGroupChoice, ask: boolean }>({ choice: { kind: 'none' }, ask: false })
/** 送出去要放哪一組 */
const groupChoice = ref<ImportGroupChoice>({ kind: 'none' })
/**
 * 要不要問「這份在講哪個商品？」：什麼都比不到、AI 又認出一個商品才問（停下來的那一頁問；直接加入的在結果頁問）。
 * 他選過一次就收成一行「放在『X』・改」。
 */
const groupAsk = ref(false)
/** 他自己選過（不是系統挑的）：「更新原本那一份」時，只有他動過才把分組帶過去（沒動＝那一份原本放哪就在哪） */
const groupTouched = ref(false)
/** 「新分組」那個選項用的名字＝AI 認的商品名 */
const groupNewName = computed(() => newGroupName(sourceMeta.value.productName))
const groupHints = computed(() => ({ sourceName: sourceMeta.value.name, productName: sourceMeta.value.productName }))
/**
 * 真的存進去的那一組（結果頁那一行講這個；按「改」搬過去之後跟著換）。
 * undefined＝還沒加；null＝「更新原本那一份」而他沒動分組、又不知道那一份現在放哪（那一行講「分組不變」）
 */
const savedGroup = ref<ImportGroupChoice | null | undefined>(undefined)
const groupMoving = ref(false)
/** 按「改」換組之後伺服器做了什麼（`PUT` 回的 groupSync，`D-127`）：AI 現在把它當成哪一台、或沒重新學成 */
const groupSync = ref<GroupSyncOutcome | null>(null)
const groupSyncNote = computed(() => groupSyncNoteText(groupSync.value).replace('點開那一份', '打開這一份'))

/**
 * 「更新既有那一份」的目標（`C-135`）。
 * 有值時 `runImport` 走覆蓋：舊卡進回收桶、來源本身留著（資料夾／同步設定不會被洗掉）。
 * 這是同名警告的正解——原本唯一的建議是「改個名字」，照做就是製造出第三份重複。
 */
/** quotaChunkCount：換掉它會空出多少空間（不含草稿，伺服器算好的）；chunkCount 是畫面上講「舊的幾條」用的 */
const replaceTarget = ref<{ id: string; name: string; chunkCount: number; quotaChunkCount?: number } | null>(null)

/**
 * 某一份資料現在放在哪一組（從頁面的資料清單看）：「更新原本那一份」而他沒動分組時，畫面照實講「放在『X』」。
 * 清單上找不到那一份＝不知道（null，畫面講「分組不變」）——⛔ 不猜。
 */
function currentGroupOf(sourceId: string): ImportGroupChoice | null {
  const s = (props.existingSources ?? []).find(x => x.id === sourceId)
  if (!s || s.folderId === undefined) return null
  if (!s.folderId) return { kind: 'none' }
  return allGroups.value.some(g => g.id === s.folderId) ? { kind: 'folder', id: s.folderId } : null
}
/**
 * 停下來那一頁「放在『X』」講哪一組：「更新原本那一份」而他沒動 → 那一份原本放哪（分組不帶過去，見 runImport）；
 * 其餘＝這次要送的那一組。
 */
const groupShown = computed<ImportGroupChoice | null>(() =>
  replaceTarget.value && !groupTouched.value ? currentGroupOf(replaceTarget.value.id) : groupChoice.value)

/** 加入之前改（停下來那一頁）：只改要送的值，還沒有東西要搬 */
function pickGroupBeforeImport(c: ImportGroupChoice) {
  groupChoice.value = c
  groupTouched.value = true
  groupAsk.value = false
}

/**
 * 決定要送哪一組（runImport 用）：新分組這時才建——同一個名字這次開窗只建一次（見 registry）。
 * 建不成（沒有建分組的權限、網路）：這一份照樣加進去、先不放分組，結果頁那一題還在，他可以再點一次。
 */
async function folderIdForImport(): Promise<{ folderId: string | null, createdNow: boolean }> {
  const c = groupChoice.value
  if (c.kind === 'folder') return { folderId: allGroups.value.some(g => g.id === c.id) ? c.id : null, createdNow: false }
  if (c.kind !== 'new') return { folderId: null, createdNow: false }
  try {
    const known = new Set(allGroups.value.map(g => g.id))
    const g = await groupRegistry.ensure(c.name, allGroups.value, { general: c.general })
    return { folderId: g.id, createdNow: !known.has(g.id) }
  }
  catch (err) {
    const why = apiErrorText(err, '')
    showToast(`沒建成分組「${c.name}」${why ? `：${why}` : ''}，這份先不放分組`, 'warning')
    return { folderId: null, createdNow: false }
  }
}

/**
 * 那一份現在真的放在哪一組（讀一次伺服器）：「更新原本那一份」改了分組、加入的回應又沒講時用（`/code-review` ⑨）。
 * 讀不到回 undefined＝不知道（畫面講「分組不變」，⛔ 不照送出去的值猜）
 */
async function readSourceFolderId(sourceId: string): Promise<string | null | undefined> {
  try {
    const r = await apiFetch<{ source?: { folderId?: string | null } }>(`/api/ai/sources/${encodeURIComponent(sourceId)}`)
    return r?.source && 'folderId' in r.source ? (r.source.folderId ?? null) : undefined
  }
  catch {
    return undefined
  }
}

/** 那一組裡除了這一份，清單上還看得到別份嗎（替他刪掉一個「這次建的」分組之前要先看） */
function groupUsedByOthers(folderId: string, exceptSourceId: string): boolean {
  return (props.existingSources ?? []).some(s => s.folderId === folderId && s.id !== exceptSourceId)
}

/**
 * 結果頁按「改」／點那一題的選項：已經加進去了，換＝搬過去（跟資料頁把一份拖進分組同一支 `PUT /api/ai/sources/:id`）。
 * 原本那一組要是這次替他建的、又空了，順手刪掉（見 registry.release）——⛔ 不留一個他沒要過的空分組。
 */
async function moveSavedTo(c: ImportGroupChoice) {
  const sourceId = result.value?.sourceId
  if (!sourceId || groupMoving.value) return
  const prev = savedGroup.value
  const prevId = prev && prev.kind === 'folder' ? prev.id : null
  // 換分組＝換商品名（`D-127`），伺服器當場重新學這一份（最久約 9 秒）：那一行一直顯示「搬過去中⋯」
  groupMoving.value = true
  let target: string | null = null
  let created = false
  try {
    if (c.kind === 'new') {
      const known = new Set(allGroups.value.map(g => g.id))
      const g = await groupRegistry.ensure(c.name, allGroups.value, { general: c.general })
      target = g.id
      created = !known.has(g.id) // 這一下才建的（先前就有、別份在用的不算）
    }
    else if (c.kind === 'folder') target = c.id
    if (target === prevId && prev) {
      groupAsk.value = false
      return
    }
    if (target) groupRegistry.hold(target)
    let res: { folderId?: string | null, groupSync?: unknown } | null
    try {
      res = await apiFetch<{ folderId?: string | null, groupSync?: unknown }>(
        `/api/ai/sources/${encodeURIComponent(sourceId)}`,
        { method: 'PUT', body: { folderId: target } },
      )
    }
    finally {
      if (target) groupRegistry.unhold(target)
    }
    // 那一行照伺服器回的那一份講（回的就是改好的資料）；舊伺服器沒回 folderId 才用送出去的
    const actual = res && 'folderId' in res ? (res.folderId ?? null) : target
    if (actual) groupRegistry.use(actual)
    if (created && target && actual !== target) void groupRegistry.discardIfUnused(target)
    if (prevId && prevId !== actual) void groupRegistry.release(prevId, groupUsedByOthers(prevId, sourceId))
    savedGroup.value = actual ? { kind: 'folder', id: actual } : { kind: 'none' }
    groupAsk.value = false
    groupSync.value = parseGroupSync(res)
  }
  catch (err) {
    // 剛替他建好、卻沒搬成：只有**確定沒搬進去**（伺服器 4xx 拒絕）才收掉那一組（`/code-review` ③）——
    // 5xx／逾時可能已經搬了、是後面補商品名才出錯，刪了那一組會把他這一份又移出分組
    if (created && target && moveSurelyRejected(apiErrorStatus(err))) void groupRegistry.discardIfUnused(target)
    showToast(apiErrorText(err, '沒有改成，請再試一次'), 'error')
  }
  finally {
    groupMoving.value = false
  }
}

/**
 * 換掉的那一份裡**他親手改過的**那幾條（`D-125`① 拍板 A）。
 *
 * 為什麼要有：以前換新版會把他改過的那幾條跟著舊的一起丟進回收桶、一句話都沒講——說明裡卻一再寫
 * 「你親手改過的一律保留」。現在只要選了要換哪一份（「上傳新版」、「重新整理，更新原本那一份」、「更新原本那一份」、
 * 接回這樣的一份整理），就去讀那一份、挑出改過的（不算總表），**一律停在預覽問他**（見 previewStopReasons 的 edited），
 * 預設全勾＝帶到新版；沒勾的照新版、舊的那條進回收桶。勾的送 `source.keepEditedChunkIds`。
 * ⚠️ 讀不到（網路、伺服器）也要停：不知道有沒有改過的，就不能替他決定把它們丟掉。那一份已經不在（404）＝沒東西可帶。
 */
interface KeepCandidate { id: string, title: string, key: string, countsQuota: boolean }
const keepCandidates = ref<KeepCandidate[]>([])
/** 勾了要帶到新版的（el-checkbox-group 的值） */
const keepEditedIds = ref<string[]>([])
/** 上面那份清單是哪一份讀來的（換了目標就作廢） */
const keepLoadedFor = ref('')
const keepLoading = ref(false)
const keepLoadFailed = ref(false)
/** 正在讀的那一趟：自動加入（settlePreview）要等它讀完才決定停不停 */
let keepLoad: Promise<void> = Promise.resolve()
let keepSeq = 0
function startKeepLoad(targetId: string) {
  const seq = ++keepSeq
  keepCandidates.value = []
  keepEditedIds.value = []
  keepLoadedFor.value = ''
  keepLoadFailed.value = false
  keepLoading.value = !!targetId
  if (!targetId) {
    keepLoad = Promise.resolve()
    return
  }
  keepLoad = (async () => {
    try {
      const res = await apiFetch<{ chunks?: Array<{ id: string, title: string, isOverview?: boolean, manuallyEditedAtMs?: number, status?: string }> }>(
        `/api/ai/sources/${encodeURIComponent(targetId)}`,
      )
      if (seq !== keepSeq) return
      const edited = (res.chunks ?? []).filter(c => (c.manuallyEditedAtMs ?? 0) > 0 && !c.isOverview)
      // 草稿（等你看過）本來就沒佔空間：留著也不會吃掉新版的位置（見 roomLeft）
      keepCandidates.value = edited.map(c => ({ id: c.id, title: c.title, key: knowledgeTitleKey(c.title), countsQuota: c.status !== 'draft' }))
      keepEditedIds.value = edited.map(c => c.id)
      keepLoadedFor.value = targetId
    }
    catch (err) {
      if (seq !== keepSeq) return
      if (apiErrorStatus(err) === 404) keepLoadedFor.value = targetId // 那一份已經不在了：加入那一下伺服器會講原因
      else keepLoadFailed.value = true
    }
    finally {
      if (seq === keepSeq) keepLoading.value = false
    }
  })()
}
// flush:'sync'：applyPreviewResult 選定目標之後馬上就是 settlePreview，要在那之前就開始讀、拿得到 keepLoad
watch(() => replaceTarget.value?.id ?? '', id => startKeepLoad(id), { flush: 'sync' })

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
  if (sheetAmongUrls.value) return false // 網址和試算表混在一起：要分開貼（畫面上那一行有講）
  if (urlList.value) return true // 好幾個網址（`D-124`）：走整站那條路，見 onPrimaryClick
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
  /**
   * 這一頁放進哪一組（`D-127` 分組就是商品：放哪一組＝AI 當成哪一台）。整站匯入不逐頁預覽，結束後要列出來讓人看過。
   * ''＝沒放分組；groupNew＝這一頁才建的；groupGeneral＝放進「通用」（不是講單一商品）
   */
  groupName: string
  groupNew: boolean
  groupGeneral: boolean
  /** 路徑第一段(分組用);探索時算一次,避免每次篩選/勾選都重新解析上千個網址 */
  group: string
}
const discovering = ref(false)
const sitePages = ref<SitePageRow[]>([])
/** 清單從哪來：網站的頁面清單／這一頁上的連結／他一次貼了好幾個網址（`D-124`） */
const siteFrom = ref<'sitemap' | 'links' | 'pasted'>('sitemap')
const siteTruncated = ref(false)
const siteImporting = ref(false)
const siteAborted = ref(false) // 使用者中途關窗 → worker 收工

/**
 * 一次好幾份／整站匯入跑到一半時離開頁面（重新整理、關分頁、站內換頁）先問一聲。
 * 關窗不擋（關窗只是不看，正在跑的會跑完）；但整頁離開＝還在路上的上傳與整理全斷，
 * 那幾份就沒匯進去、也沒人交代。
 * ⚠️ 排在 siteImporting 宣告之後：watch 註冊當下就會讀一次來源（這個檔案吃過三次同一顆雷）
 */
const { markDirty: markImportBusy, markClean: markImportIdle } = useUnsavedChanges({
  getSnapshot: () => null,
  message: '匯入還沒跑完：現在離開，正在整理和還沒開始的檔案都不會匯入（已經匯好的會保留）。確定要離開嗎？',
  enableBeforeUnload: true,
})
watch([batchRunning, siteImporting], ([a, b]) => { if (a || b) markImportBusy(); else markImportIdle() })
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
/**
 * 分組：網址第一段照意思歸成「商品／分類／文章／說明頁」（`D-124`：以前直接秀「/products」，新手看不懂）。
 * 規則在 utils/kb-site-pages（有測試）；認不出來的照舊用那一段。
 */
const pageGroupKey = (url: string) => sitePageGroup(url)

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
 * 這批放進了哪幾個商品分組（`D-127` 分組就是商品：放哪一組＝AI 當成哪一台）。
 *
 * 整站匯入是一次幾十頁、**不經逐頁預覽直接建庫**——也就是同一台被分成兩組最大的入口
 * （AI 在不同頁認成兩種寫法、又比不到現有的組）。結束後至少要把結果攤開來讓人看過。
 * 「新」＝這一批才建的分組（要多看一眼的就是這些）。通用那一組不列：不是講單一商品。
 */
const siteProductNames = computed(() => {
  const m = new Map<string, { pages: number, isNew: boolean }>()
  for (const p of sitePages.value) {
    if (p.status !== 'done' || !p.groupName || p.groupGeneral) continue
    const cur = m.get(p.groupName) ?? { pages: 0, isNew: false }
    m.set(p.groupName, { pages: cur.pages + 1, isNew: cur.isNew || p.groupNew })
  }
  return [...m.entries()]
    .sort((a, b) => b[1].pages - a[1].pages)
    .map(([name, v]) => ({ name, pages: v.pages, isNew: v.isNew }))
})
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
    showToast(`一次最多加入 ${MAX_SITE_BATCH} 頁，已勾選 ${MAX_SITE_BATCH} 頁；剩下的 ${remaining} 頁可以等這批完成後再跑一次`, 'warning')
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
  // 這裡先全部不勾；打開清單那一下才照空間先幫他勾常被問的頁（見 openSitePages）——
  // 探頁數是貼上網址就在背景跑的，那時候空間可能還沒讀到
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
    groupName: '',
    groupNew: false,
    groupGeneral: false,
    group: pageGroupKey(p.url),
  }))
  siteFrom.value = res.from
  siteTruncated.value = res.truncated
  siteFinished.value = false
  siteGroup.value = ''
  siteFilter.value = ''
  return sitePages.value.length
}

/**
 * 打開頁面清單（`D-124` 新手走查：以前上百頁一頁都沒勾，他不知道該勾哪些）。
 * 他還沒勾過任何一頁時，先照空間幫他勾常被問的頁（規則在 utils/kb-site-pages）；勾過就不動他的選擇。
 */
function openSitePages() {
  if (!sitePages.value.some(p => p.checked)) {
    const order = recommendSitePages(sitePages.value, { room: roomLeft.value, maxPages: MAX_SITE_BATCH })
    const rank = new Map(order.map((u, i) => [u, i]))
    for (const p of sitePages.value) p.checked = rank.has(p.url)
    // 勾好的排最上面、照推薦的順序（說明頁在前）：網站清單裡「運送」「常見問題」常在最後面，不排上來他得捲到底才看得到勾了什麼
    if (rank.size) {
      sitePages.value = [...sitePages.value].sort((a, b) => (rank.get(a.url) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.url) ?? Number.MAX_SAFE_INTEGER))
    }
  }
  step.value = 'sitePages'
}

/**
 * 一次貼了好幾個網址（`D-124`，Gemini Notebook 也這樣收）：每個網址各自成為一份資料，走整站加入同一條路
 * （每頁各自整理、直接加入、清單上講結果）。⛔ 以前這種輸入被當成一段文字——AI 整理的是網址字串本身。
 */
const checkingUrlList = ref(false)
async function runUrlList() {
  const urls = urlList.value
  if (!urls || checkingUrlList.value) return
  // 先問哪幾個已經加過了（2026-10-13 `/code-review`）：以前每一頁都當沒加過，網頁改了幾個字就多建一份。
  // 跟整站探頁同一支判斷；加過的那幾列不勾、標「加過了」，跟整站清單長得一樣。問不到就照舊全部加（內容一模一樣的伺服器還會擋）
  checkingUrlList.value = true
  let imported = new Set<string>()
  try {
    // 同一支整站探頁端點，帶 urls 就只回「哪幾個加過了」、不探站（見 discover-pages）
    const res = await apiFetch<{ imported: string[] }>('/api/ai/knowledge/discover-pages', { method: 'POST', body: { urls } })
    imported = new Set(res.imported ?? [])
  }
  catch { /* 見上 */ }
  finally {
    checkingUrlList.value = false
  }
  sitePages.value = urls.map(url => ({
    url,
    title: '',
    checked: !imported.has(url),
    status: 'idle' as const,
    cards: 0,
    notLearned: 0,
    warningTexts: [],
    error: '',
    imported: imported.has(url),
    groupName: '',
    groupNew: false,
    groupGeneral: false,
    group: pageGroupKey(url),
  }))
  siteFrom.value = 'pasted'
  siteTruncated.value = false
  siteFinished.value = false
  siteGroup.value = ''
  siteFilter.value = ''
  step.value = 'sitePages'
  if (sitePages.value.some(p => p.checked)) void runSiteImport()
  else showToast(`這 ${urls.length} 個網址都加過了（在你的資料裡），沒有再加一次`, 'info')
}

/** 主按鈕：好幾個網址走整站那條路，其餘照常整理並加入 */
function onPrimaryClick() {
  if (urlList.value) void runUrlList()
  else void runPreview()
}

async function runDiscover() {
  discovering.value = true
  try {
    await loadSitePages(urlInput.value.trim())
    openSitePages()
  }
  catch (err: any) {
    showToast(apiErrorText(err, '找不到這個網站的其他頁面'), 'error')
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
    return showToast(`一次最多加入 ${MAX_SITE_BATCH} 頁，請先取消勾選一些（可以分批）`, 'error')
  }
  // 每頁都要跑一次 AI 整理並計入用量,量大時先講清楚再開始
  if (targets.length >= 10) {
    try {
      await ElMessageBox.confirm(
        `要加入 ${targets.length} 頁，每頁都會由 AI 整理並算進本月用量，大約要 ${Math.ceil(targets.length * 0.5)}–${targets.length} 分鐘。期間請讓這個視窗開著。`,
        '一次加入整個網站？',
        { confirmButtonText: '開始加入', cancelButtonText: '再想想', type: 'warning' },
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

  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      if (siteAborted.value) return // 使用者關窗 → 收工,不再開新頁
      const page = targets[cursor++]!
      page.status = 'processing'
      page.error = ''
      // 這一頁自己的工作編號。⛔ 不可以借用 lastPreviewJobId：兩個 worker 同時跑，
      // 一頁逾時去停「最後一個」工作，停到的常常是另一個 worker 正在跑的那一頁（2026-10-11 審查）
      let jobId = ''
      /** 這一頁放進的分組、以及它是不是這一頁才建的（加入失敗時收掉這一頁建的空分組，同單份的 `/code-review` ⑥） */
      let heldPageGroupId: string | null = null
      let createdPageGroupId = ''
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
        jobId = created.jobId // 逾時要停掉它（見下面的 catch）
        const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(jobId)
        if (!res.chunks.length) throw new Error('沒有整理出知識（頁面可能沒有實質內容）')
        /*
         * 放哪一組（`D-127` 分組就是商品）：跟單份同一套規則（`C-320`，含沒認出商品的放「通用」）。
         * 認出一台現有分組裡沒有的商品＝**建那一組**（同一台的幾頁共用一組，registry 同名只建一次）。
         * 以前這條路⛔不開新分組、留在未分類，但商品名照 AI 猜的存著；現在商品名跟著分組走，不放分組＝AI 不知道這頁在講哪一台。
         * 建不成（沒有權限、網路）：這一頁照樣加、先不放分組——⛔ 不為了分組擋住知識
         */
        const choice = autoImportGroup(allGroups.value, {
          sourceName: page.title || res.sourceName || page.url,
          productName: res.suggestedProductName ?? '',
        }).choice
        let pageFolderId: string | null = choice.kind === 'folder' ? choice.id : null
        if (choice.kind === 'new') {
          try {
            const before = new Set(allGroups.value.map(g => g.id))
            const g = await groupRegistry.ensure(choice.name, allGroups.value, { general: choice.general })
            pageFolderId = g.id
            if (!before.has(g.id)) createdPageGroupId = g.id
          }
          catch { pageFolderId = null }
        }
        // 請求在路上的這段時間，別頁不可以把這一組當空的刪掉（見 registry.hold）
        if (pageFolderId) groupRegistry.hold(pageFolderId)
        heldPageGroupId = pageFolderId
        const bulk = await apiFetch<{ total: number; indexed: number; failed: number }>('/api/ai/knowledge/bulk-create', {
          method: 'POST',
          body: {
            source: {
              type: 'url',
              name: page.title || res.sourceName || page.url,
              url: page.url,
              contentHash: res.contentHash ?? '',
              folderId: pageFolderId,
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
        if (heldPageGroupId) {
          groupRegistry.unhold(heldPageGroupId)
          groupRegistry.use(heldPageGroupId)
          heldPageGroupId = null
        }
        const placed = pageFolderId ? allGroups.value.find(g => g.id === pageFolderId) : null
        page.groupName = placed?.name ?? ''
        page.groupGeneral = placed?.general === true
        page.groupNew = !!createdPageGroupId
        page.warningTexts = res.warnings ?? []
        page.status = 'done'
        page.checked = false
        page.imported = true
      }
      catch (err: any) {
        page.status = 'failed'
        // 這一頁沒加成：放的那一組不再「在路上」；是這一頁才建的、又沒有別頁在用 → 收掉（不留空分組）
        if (heldPageGroupId) groupRegistry.unhold(heldPageGroupId)
        if (createdPageGroupId) void groupRegistry.discardIfUnused(createdPageGroupId)
        /**
         * ⚠️ 逾時要單獨講（2026-09-03 code review 抓到）：整站這條路的 `bulk-create`
         * **只在這個 worker 裡呼叫**，所以這一頁的工作即使被排程做完，切好的知識也沒有人收
         * ——不能沿用單筆匯入那句「還在背景整理、好了會告訴你」，那是騙人的。
         * 而且要主動把工作停掉：不停的話排程會付完整的 OCR／AI 費用把它做完，結果丟掉。
         */
        if (err?.code === PREVIEW_JOB_DEADLINE) {
          page.error = '整理太久，這一頁跳過了（沒有匯入，可重新勾選再試）'
          if (jobId) {
            apiFetch(`/api/ai/knowledge/preview-jobs/${jobId}`, { method: 'DELETE' }).catch(() => {})
          }
        }
        else {
          // 截 120 字（同一次好幾份那份清單）：80 字會把「請共用給服務帳號：…」這種長句切在帳號中間
          page.error = apiErrorText(err, '加入失敗').slice(0, 120)
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
        ? `已停止加入網站頁面：完成的 ${ok.length} 頁（${ok.reduce((s, p) => s + p.cards, 0)} 條）已保留在知識庫`
        : '已停止加入網站頁面：這批還沒有任何一頁完成，知識庫沒有變動',
      ok.length ? 'success' : 'warning',
    )
    resetAll()
    return
  }
  // 視窗開著就不另跳提示：結論框就在畫面上，同一句話 toast 再講一次（2026-10-12 文字審視，同單份的結果頁）
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
 * 換新版時勾了要帶過去的那幾條（`D-125`①）：只算「這一份目標」讀來的清單（換了目標就不算）。
 * 帶過去的那幾條**留在原地、照樣佔空間**；新版裡跟它們同名的（同一把 knowledgeTitleKey）伺服器不收——
 * 這裡先扣掉，按鈕、空間、送出去的才是同一個數（伺服器那邊也照樣擋，兩邊同一套比對）。
 */
const keptItems = computed(() =>
  keepLoadedFor.value && keepLoadedFor.value === replaceTarget.value?.id
    ? keepCandidates.value.filter(c => keepEditedIds.value.includes(c.id))
    : [])
const keptKeys = computed(() => new Set(keptItems.value.map(c => c.key).filter(Boolean)))
/** 新版裡有哪些標題（每條後面「新版也有這一條／沒有這一條」用） */
const incomingKeys = computed(() => new Set(willImportChunks.value.map(c => knowledgeTitleKey(c.title))))
/** 這次真的會送出去建的：勾了的、扣掉跟帶過去那幾條同名的 */
const sendChunks = computed(() => willImportChunks.value.filter(c => !keptKeys.value.has(knowledgeTitleKey(c.title))))
const sendCount = computed(() => sendChunks.value.length)
/** 每一條改過的後面那半句：勾著＝帶過去（新版有同名的就用他改的）；沒勾＝照新版、他改的那條進回收桶 */
function keepSuffix(c: KeepCandidate): string {
  const inNew = incomingKeys.value.has(c.key)
  if (keepEditedIds.value.includes(c.id)) return inNew ? '新版也有這一條，會用你改過的' : '新版沒有這一條，會原樣留著'
  return inNew ? '用新版的' : '移到回收桶'
}

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
  overviewWillImport.value ? `${sendCount.value} 條＋1 張總表` : `${sendCount.value} 條`,
)

/**
 * 知識空間（`C-296`）：放之前就看得到剩幾條；放不下時**先收前 N 條**、講清楚其餘幾條沒收。
 * 以前是等完、看完、按下匯入才整批 403——42 條一條都拿不到，訊息還叫新帳號「刪掉不需要的」。
 * ⚠️ 伺服器照樣把關（assertKnowledgeChunkQuota），這裡只是讓人在按之前就知道；
 *    讀不到用量（訂閱讀取失敗）就整行不顯示，不猜。
 */
interface KbQuota { used: number, limit: number | null, planName?: string }
const quota = ref<KbQuota | null>(null)
async function loadQuota() {
  try {
    quota.value = (await apiFetch<{ quota: KbQuota | null }>('/api/ai/knowledge/quota')).quota
  }
  catch {
    quota.value = null
  }
}
/** 這次還放得下幾條；null＝不限或讀不到。「更新這一份」的舊卡會進回收桶，空間要算回來 */
const roomLeft = computed<number | null>(() => {
  const q = quota.value
  if (!q || q.limit == null) return null
  // ⚠️ 用不含草稿的那個數：草稿本來就沒算進「已用」，把它當成會空出來的空間，按鈕就會多承諾、按下去整批被擋
  // ⚠️ 帶到新版的那幾條（`D-125`①）留在原地、照樣佔空間：不扣的話一樣多承諾
  const keptQuota = keptItems.value.filter(c => c.countsQuota).length
  const freed = replaceTarget.value ? Math.max(0, (replaceTarget.value.quotaChunkCount ?? replaceTarget.value.chunkCount) - keptQuota) : 0
  return Math.max(0, q.limit - q.used + freed)
})
/**
 * 整站清單上的空間提醒（`D-124`）：一頁大約整理成 5 條（正式庫網頁中位數），勾的頁數乘上去超過剩下的空間就變色講。
 * ⛔ 整站這條路沒有「收到滿為止」：放不下的那幾頁是整理完（錢花了）才在加入那一下被擋，所以要在按之前講。
 */
const siteRoomHint = computed(() => {
  const room = roomLeft.value
  if (room == null || siteImporting.value || siteFinished.value) return null
  const need = checkedSiteCount.value * CARDS_PER_PAGE_ESTIMATE
  if (checkedSiteCount.value && need > room) {
    return { tight: true, text: `空間還能放 ${room} 條，一頁大約 ${CARDS_PER_PAGE_ESTIMATE} 條——勾這麼多，後面幾頁可能放不進去` }
  }
  return { tight: false, text: `空間還能放 ${room} 條（一頁大約 ${CARDS_PER_PAGE_ESTIMATE} 條）` }
})
/** 放得下幾條一般知識（總表排最後：先保住內容，空間還有剩才收總表）。跟帶過去那幾條同名的不用位置（sendCount 已扣） */
const fitChunkCount = computed(() =>
  roomLeft.value == null ? sendCount.value : Math.min(sendCount.value, roomLeft.value))
const overviewFits = computed(() =>
  overviewWillImport.value && (roomLeft.value == null || roomLeft.value > fitChunkCount.value))
/** 這次因為空間不夠、不會收進去的條數（含總表） */
const overQuotaBy = computed(() =>
  (sendCount.value - fitChunkCount.value) + (overviewWillImport.value && !overviewFits.value ? 1 : 0))
/** 匯入完要講「還有幾條沒收」用：按下去那一刻的數字（之後勾選再變也不影響結果頁） */
const quotaSkipped = ref(0)
/** 沒收的那幾條怎麼補：照這一份是什麼來源講（結果頁那一句的後半） */
const quotaRefillHint = computed(() => {
  switch (sourceMeta.value.type) {
    // `C-319`：內容一模一樣時出現的是「重新整理，更新原本那一份」，改過了出現的是同名的「更新原本那一份」——兩條同一句話。
    // 檔案改講資料頁那顆「上傳新版」：不用先撞一次同名才問得到
    // ⛔ 不寫「每小時」（`C-308`④）：換掉的是既有那一份的話，同步頻率照那一份原本的設定
    case 'gsheet': return '表格同步時會自動補上，不用重新加入。'
    case 'url': return '再貼一次這個網址、選「更新原本那一份」，就能補齊。'
    case 'text': return '再貼一次這段文字、選「更新原本那一份」，就能補齊。'
    default: return '在那一份按「上傳新版」再傳一次，就能補齊。'
  }
})
/** 只有看得到方案的人（管理員，`G-103`）才給「看方案」那條路 */
const billingLink = computed(() => (quota.value?.planName ? `/admin/${workspaceId.value}/settings/billing` : ''))

/**
 * 主按鈕的字。選了覆蓋目標時**按鈕本身就要改口**（`C-135`）——
 * 「匯入」跟「蓋掉既有那一份」是兩件事，按鈕說一樣的話等於沒有告知。
 * 放不下時也要改口（`C-296`）：按鈕說 42 條、實際只收 12 條，就是「按鈕與結果對不上」。
 */
const importButtonLabel = computed(() => {
  if (overQuotaBy.value > 0) {
    if (fitChunkCount.value === 0) return '空間已經滿了'
    // `C-319`：跟同名提醒那顆、一次好幾份那一列同一句「更新原本那一份」（以前叫「更新既有資料」）
    return replaceTarget.value ? `更新原本那一份（先收前 ${fitChunkCount.value} 條）` : `先收前 ${fitChunkCount.value} 條`
  }
  return replaceTarget.value ? `更新原本那一份（${importTotalLabel.value}）` : `加入 ${importTotalLabel.value}`
})

/**
 * 選定要覆蓋的既有資料；名稱同步過去，免得更新完列表上出現兩個不同名字指同一份東西。
 * 分組（`C-320`）：更新＝那一份原本放哪就在哪，不問「這份在講哪個商品」、不替他開新分組；他自己改了才帶過去
 */
function chooseReplaceTarget(m: { id: string; name: string; chunkCount: number; quotaChunkCount?: number }) {
  replaceTarget.value = { id: m.id, name: m.name, chunkCount: m.chunkCount, quotaChunkCount: m.quotaChunkCount }
  sourceMeta.value.name = m.name
  groupAsk.value = false
  groupTouched.value = false
}
/** 「改成另外建一份新的」：分組退回系統照這一份自動挑的那一組（連同要不要問那一題） */
function cancelReplace() {
  replaceTarget.value = null
  groupChoice.value = autoGroup.value.choice
  groupAsk.value = autoGroup.value.ask
  groupTouched.value = false
}

/** 「這份已經匯過了」→ 關窗並跳去那一份（沿用 imported 訊號，父層會刷新列表並選中它） */
function openDuplicateSource() {
  const id = duplicateHit.value?.id ?? null
  duplicateHit.value = null
  emit('imported', id)
  emit('update:modelValue', false)
}

/**
 * 「重新整理，換掉那一份」：略過這一次守門重跑，整理好直接選定「更新那一份」（不多一份）。
 * 會走到這裡的人幾乎都是結果頁叫他「再傳一次這份」的——原檔沒留成、空間不夠沒收齊。
 * 旗標用完即歸位（見 ignoreDuplicateOnce）；要換哪一份交給 runPreview 帶著走（見 pendingReplace）。
 */
const pendingReplace = ref<DuplicateHit | null>(null)
function redoReplacingDuplicate() {
  pendingReplace.value = duplicateHit.value
  duplicateHit.value = null
  ignoreDuplicateOnce.value = true
  void runPreview()
}

/** 名稱欄位的展開（`D-50` 簡化 2：預設收起，結論先行；`C-320` 起只剩名稱）。判斷見 metaEditorOpen */
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


// 同名警告要「活的」:使用者在預覽步驟改名,警告即時跟著變。
// 比對對象 = 父層完整資料清單 ∪ preview 回傳的同名清單(父層沒傳 prop 時的 fallback),
// 否則改名撞進「另一個」既有資料不會有任何警告——正是這個警示要防的事。
const dupMatches = computed(() => {
  const name = sourceMeta.value.name.trim()
  // 同一份 Google 試算表（伺服器比的是表的編號，名字改過也算，見 findExistingSources）：
  // ⛔ 不可以只靠名字——換頁回來接著做的那一下，資料清單常常還沒載入（2026-10-13 `/code-review`）
  const sameSheetIds = new Set(existingMatches.value.filter(m => m.sameSheet).map(m => m.id))
  if (!name && !sameSheetIds.size) return []
  const pool = new Map<string, { id: string; name: string; chunkCount: number; updatedAtMs: number; type?: string }>()
  for (const s of props.existingSources ?? []) pool.set(s.id, s)
  for (const m of existingMatches.value) if (!pool.has(m.id)) pool.set(m.id, m)
  return [...pool.values()].filter(m => (name && m.name.trim() === name) || sameSheetIds.has(m.id))
})
/** 撞到的是「同一份試算表」而不是名字一樣：標題要講對（名字可能根本不一樣） */
const dupIsSameSheet = computed(() => existingMatches.value.some(m => m.sameSheet && dupMatches.value.some(d => d.id === m.id)))

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
  // 貼一段文字進來的來源：跟判別結果那一行同一個叫法（2026-10-12 文字審視：以前同一種東西有六種叫法）
  manual: '一段文字',
}

/**
 * 名稱欄位要不要展開。
 * ⚠️ 宣告在 dupMatches **之後**：這個檔案有過 TDZ 事故（watch 註冊當下就會讀一次 getter，
 *    整個元件 setup 直接炸掉、知識庫變全站錯誤頁），所以凡是讀別人 ref 的衍生值一律排在後面。
 * 有同名警告時強制展開——那句提醒叫人「改個名字」，收起來的話畫面上沒有東西可按。
 */
const metaEditorOpen = computed(() => metaOpen.value || dupMatches.value.length > 0)

/**
 * 整理好之後**要不要停下來給人看**（`D-123`②，2026-10-12 老闆拍板「一份也直接加入，有要你核對的才停」）。
 *
 * 只有這五種停（第五種 edited 見最下面）：都是「AI 直接回客人，錯了要客人先發現」的那種錯，而且只有人看得出來——
 *  · ocr       照片／掃描檔上的字是 AI 認的：數字、價格、電話最容易看錯；
 *  · truncated 後面沒讀到：原文超過 10 萬字，或表格超過 150 列、整理到 150 條上限、網頁太大、檔案讀一半就停
 *              （後幾種是 incomplete，原因在整理時的提醒裡）——直接加入等於默默少一截；
 *  · quota     空間不夠、只收得下前幾條：要他決定收前幾條還是先去騰空間；
 *  · sameName  知識庫裡已經有同名的：要他決定「更新原本那一份」還是另外建一份（已經選好要換哪一份就不算）；
 *  · edited    要換掉的那一份裡有他親手改過的（`D-125`①）：要他決定帶不帶到新版（同一種「有要你看的才停」）。
 * ⛔ 表格健檢那類提醒（示範列沒換、含時效內容⋯）**不停**：以前就寫「提醒不擋匯入」，加完在結果頁照樣講。
 * ⚠️ 宣告排在 dupMatches／overQuotaBy 之後（這個檔案吃過三次「衍生值排在來源前面」的 TDZ）。
 */
const previewStopReasons = computed<PreviewStopReason[]>(() => {
  const r: PreviewStopReason[] = []
  if (ocrUsed.value) r.push('ocr')
  if (truncated.value || incomplete.value) r.push('truncated')
  if (overQuotaBy.value > 0) r.push('quota')
  if (dupMatches.value.length > 0 && !replaceTarget.value) r.push('sameName')
  // 換掉的那一份裡有他改過的（`D-125`①）、或讀不到有沒有：要他決定帶不帶過去——⛔ 不替他把親手改的丟掉
  if (replaceTarget.value && (keepLoadFailed.value || (keepLoadedFor.value === replaceTarget.value.id && keepCandidates.value.length > 0))) r.push('edited')
  return r
})

/** 預覽 job 完成時的回應形狀（與舊 preview-chunks 相同） */
interface PreviewResult {
  chunks: Array<{ title: string; content: string; tags: string[]; questions?: string[] }>
  overviewCard?: { title: string; content: string; tags: string[]; questions: string[] } | null
  sourceName: string
  sourceUrl: string
  truncated: boolean
  /** 後面沒讀到、但不是 10 萬字截斷（表格超過 150 列、整理到 150 條上限、網頁太大⋯）：原因在 warnings，這裡只負責停下來 */
  incomplete?: boolean
  ocrUsed?: boolean
  /** 抽取資訊；照片認字時帶 image: 1（提醒文字要說「照片」不是「掃描檔」） */
  meta?: Record<string, string | number>
  existingMatches?: Array<{ id: string; name: string; chunkCount: number; quotaChunkCount?: number; updatedAtMs: number; type?: string; sameSheet?: boolean }>
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
/**
 * fileName：接回來的時候「目前選的檔案」可能已經是另一份了（或根本沒選），
 * 下載原檔的檔名要跟著這份工作走，不是跟著畫面上的欄位（審查實測：存成「B.docx.pdf」）
 */
/**
 * autoImport：按的是「整理並加入」（`D-123`②）——接回來整理好了也要照樣直接加入，
 * 不然按了「加入」、換頁回來卻停在預覽等他再按一次，等於那顆按鈕說話不算話。
 * 沒有這一欄＝舊版留下的記號（按的是「先看整理結果」），照舊停在預覽。
 */
/**
 * replace／replaceIntentName：這一份整理好要**換掉哪一份**（資料頁「換新版」、「重新整理，換掉那一份」）。
 * ⛔ 一定要跟著記號落地（2026-10-13 `/code-review`）：以前只記在記憶體，換頁回來接著做、或等太久交給背景之後，
 *    整理好的結果被當成「新的一份」直接加進去——舊版沒換掉、多了一份，畫面寫的「整理好會直接換掉」沒有發生。
 */
interface JobMarker {
  jobId: string
  startedAtMs: number
  mode: ImportMode
  fileName?: string
  autoImport?: boolean
  replace?: DuplicateHit
  replaceIntentName?: string
}

function jobMarkerKey(): string {
  return `kb-import-job:${workspaceId.value ?? ''}`
}

function saveJobMarker(jobId: string, m: ImportMode, file = '', replace: DuplicateHit | null = null, intentName = '') {
  try {
    const marker: JobMarker = {
      jobId,
      startedAtMs: Date.now(),
      mode: m,
      fileName: file,
      autoImport: true,
      ...(replace ? { replace } : {}),
      ...(intentName ? { replaceIntentName: intentName } : {}),
    }
    localStorage.setItem(jobMarkerKey(), JSON.stringify(marker))
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

/**
 * 加完的結果（結果頁、整站與一次好幾份的「有建出東西」訊號共用）。
 * ⚠️ 排在 jobState 之前：jobState 會讀它，而 jobState 的 watch 註冊當下就求值（同上面那顆 TDZ 雷）。
 */
const result = ref<{
  sourceId: string | null
  total: number
  indexed: number
  failed: number
  items: Array<{ id: string; title: string; status: string; failureReason?: string }>
  /** 「更新既有資料」時被移進回收桶的舊卡張數（`C-135`）；0 = 這次是新建一份 */
  replacedChunks?: number
  /** 檔案來源：原檔有沒有留下來（`C-296`③）；false 要在結果頁講，null／沒有＝不是檔案 */
  originalKept?: boolean | null
  /** 換新版時帶過去、沿用他改過內容的條數（`D-125`①）；結果頁要講 */
  keptEdited?: number
  /** 新版裡跟帶過去那幾條同名、所以沒收的條數（畫面已先扣掉，這裡通常是 0） */
  skippedForKept?: number
} | null>(null)

const jobState = computed<'running' | 'batch' | 'ready' | 'added' | 'none'>(() => {
  // 一次好幾份／整站匯入跑到一半關窗：正在跑的那幾份還會跑完、匯入，結果要等它們跑完才講。
  // 這段時間側欄要看得到「還在匯入」，不然關窗的人只看到一片安靜，又回頭重放一次
  if (batchRunning.value || siteImporting.value) return 'batch'
  if (previewing.value) return 'running'
  // 畫面等太久先不等了、但排程還在推它（`D-50` 簡化 3）——這時側欄一定要照樣顯示
  // 「一份資料整理中」,否則使用者關掉視窗就只剩一片安靜,又變成「系統把我的東西弄丟了」
  if (previewStillRunning.value) return 'running'
  if (step.value === 'preview' && chunks.value.length > 0) return 'ready'
  // 關著視窗自動加好了（`D-123`②）：結果頁還有話要講（AI 開了沒、要不要做總表），側欄要留一個回去的入口
  if (step.value === 'result' && result.value) return 'added'
  return 'none'
})
watch(jobState, v => emit('job-state', v), { immediate: true })

/** 回到第一步(換一份重新整理)＝放棄目前這份工作,記號要跟著清掉 */
function backToInput() {
  clearJobMarker()
  // 回第一步＝要換一份了：覆蓋目標留著的話，下一份會被默默蓋到上一份的資料上
  replaceTarget.value = null
  duplicateHit.value = null
  stoppedFor.value = []
  step.value = 'input'
}

/** 進頁面時撿回上一次沒看完的整理工作;撿不到就當沒這回事(不跳任何錯誤) */
async function resumeStoredJob() {
  const marker = readJobMarker()
  if (!marker) return
  const run = ++previewRun
  const stale = () => run !== previewRun
  previewing.value = true
  previewError.value = ''
  previewStillRunning.value = false
  replaceIntentName.value = marker.replaceIntentName ?? '' // 「換新版」那一行跟著接回來的這一份
  resetJobPoll()
  try {
    lastPreviewJobId.value = marker.jobId
    const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(marker.jobId, { isStale: stale })
    if (stale()) return
    // 這段可能跑好幾分鐘,期間使用者早就去做別的事了(挑整站頁面、跑批次匯入、開始另一份整理)。
    // 這時把畫面切到預覽等於半路搶走他正在做的事——記號留著,下次進來再接。
    if (siteImporting.value || step.value !== 'input') return
    if (!res.chunks.length) {
      clearJobMarker()
      return
    }
    applyPreviewResult(res, marker.mode, marker.replace ?? null)
    fileName.value = marker.fileName ?? '' // 自動加入要用到（下載原檔的檔名），排在 settle 之前
    await settlePreview(marker.autoImport === true, stale)
  }
  catch (err: any) {
    if (stale()) return // 使用者自己按了取消，或已經開始另一輪
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
    previewError.value = apiErrorText(err, '接續整理失敗').slice(0, 300)
    clearJobMarker()
  }
  finally {
    if (!stale()) {
      previewing.value = false
      resetJobPoll()
      if (!previewStillRunning.value) replaceIntentName.value = ''
    }
  }
}

onMounted(() => {
  void resumeStoredJob()
  // 掛上來時就已經是開著的（`?import=1` 直接開窗）不會觸發下面那個 watch，空間要在這裡先讀
  if (props.modelValue) void loadQuota()
})


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
  // 使用者已經在做別的事（挑整站頁面、跑批次、開始另一份整理）→ 這輪不打擾，下次再看。
  // ⚠️ 已經選了另一份檔案、或貼了東西也算（審查實測：舊那份做完會把畫面換掉，新選的檔案默默不見）
  if (previewing.value || siteImporting.value || step.value !== 'input') return
  if (selectedFile.value || pasteInput.value.trim()) return
  try {
    const res = await apiFetch<PreviewResult & { status: 'done' | 'processing' | 'error', error?: string }>(
      `/api/ai/knowledge/preview-jobs/${encodeURIComponent(marker.jobId)}`,
    )
    if (res.status === 'processing') return
    if (res.status === 'error') {
      previewStillRunning.value = false
      replaceIntentName.value = ''
      previewError.value = String(res.error || '整理失敗').slice(0, 300)
      clearJobMarker()
      return
    }
    // 等回應的這段時間他可能已經開始做別的（選了檔案、貼了東西、開始另一份）：這輪不動，下次再看。
    // ⚠️ 2026-10-12 起這裡會**直接加進知識庫**（`D-123`②），搶在他正在做的事前面就不只是換畫面了
    if (previewing.value || siteImporting.value || step.value !== 'input' || selectedFile.value || pasteInput.value.trim()) return
    // done：沒有要他看的就直接加入，有的話攤到預覽頁（側欄的字由 jobState 自己翻）
    previewStillRunning.value = false
    previewError.value = '' // 「等太久了，還在背景整理」那句做完了就不成立
    if (!res.chunks.length) {
      clearJobMarker()
      return
    }
    const run = ++previewRun
    const stale = () => run !== previewRun
    previewing.value = true // 加入那一下也要鎖輸入、側欄顯示「整理中」（見 autoImporting）
    try {
      applyPreviewResult(res, marker.mode, marker.replace ?? null)
      fileName.value = marker.fileName ?? ''
      await settlePreview(marker.autoImport === true, stale)
    }
    finally {
      if (!stale()) {
        previewing.value = false
        replaceIntentName.value = ''
      }
    }
  }
  catch (err: any) {
    const code = Number(err?.statusCode ?? err?.data?.statusCode ?? 0)
    // 過期／被清掉／不是這個租戶 → 記號沒用了，收掉旗標（否則側欄會永遠停在「整理中」）
    if (code === 404 || code === 403) {
      previewStillRunning.value = false
      replaceIntentName.value = ''
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
  if (open) void loadQuota()
  // 帶著網址進來的（開通精靈的「把網站整理成知識卡」）先填好，省一次打字。
  // ⛔ 只在乾淨的第一步填：接回預覽／結果頁時蓋掉他正在看的東西比空白還糟。
  if (open && props.prefillPaste && step.value === 'input' && !pasteInput.value && !previewing.value) {
    pasteInput.value = props.prefillPaste
  }
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

/**
 * 這一輪整理的編號：按取消、或開始新的一輪都會往上加，舊那一輪之後回來的結果與錯誤一律丟掉
 * （取消不該顯示錯誤，被取代的那一輪也不該碰畫面）。
 * ⛔ 以前是一個「取消了沒」的旗標，下一輪開頭清成 false，舊那一輪就跟著復活
 * （2026-10-11 審查實測：上傳中按取消、換一份馬上再按——舊檔多建一份要付錢的整理工作，
 * 誰晚到誰蓋掉預覽；輪詢中取消後 1 秒內重按，舊那一輪拿到「已取消」反過來報紅字、清掉新那一份的記號）。
 */
let previewRun = 0

/**
 * 把整理結果攤進預覽畫面。第一次整理與「接回上次那份」共用同一份,
 * 兩邊各寫一次的話,之後補欄位只改到一邊,接回來的那份就會少東西。
 *
 * srcMode 要另外傳:接回來的時候輸入框是空的,mode(由輸入內容衍生)已經不是當初那個,
 * 拿它當來源類型會把網頁存成「一段文字」。
 */
function applyPreviewResult(res: PreviewResult, srcMode: ImportMode, replacing: DuplicateHit | null = null) {
  previewFilter.value = 'all' // 新的一份從完整清單開始看
  truncated.value = res.truncated
  incomplete.value = res.incomplete === true
  ocrUsed.value = res.ocrUsed === true
  ocrFromPhoto.value = res.ocrUsed === true && Number(res.meta?.image ?? 0) === 1
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
   * 分組自動挑（`C-134` 起、`C-320` 改成「上傳時不用選」）：拿檔名＋AI 判出來的產品名去比現有分組。
   * ⛔ 比對必須帶產品名——實測「KIESLECT 小耳記 說明書.pdf」單靠檔名比不到
   * 「Kieselect 小耳記 AI NotePods 10S」這個資料夾（資料夾名字本身還打錯字）。
   * 比不到、又認出商品＝預設新分組並問一題；沒認出商品＝放「通用」（規則在 shared/knowledge-import-group）。
   */
  autoGroup.value = autoImportGroup(allGroups.value, {
    sourceName: res.sourceName,
    productName: res.suggestedProductName ?? '',
  })
  groupChoice.value = autoGroup.value.choice
  groupAsk.value = autoGroup.value.ask
  groupTouched.value = false
  savedGroup.value = undefined
  groupSync.value = null
  sourceMeta.value = {
    type: srcMode,
    name: res.sourceName,
    url: res.sourceUrl,
    productName: res.suggestedProductName ?? '',
    contentHash: res.contentHash ?? '',
  }
  // 「重新整理，換掉那一份」：直接選定要更新的那一份（名稱跟著換成它的，見 chooseReplaceTarget）。
  // 不含草稿的張數只有同名清單裡有（伺服器算好的）；名字對不上時退用總張數——多算一點騰出的空間，最壞是伺服器擋下來
  if (replacing) {
    const m = existingMatches.value.find(x => x.id === replacing.id)
    chooseReplaceTarget({ id: replacing.id, name: replacing.name, chunkCount: m?.chunkCount ?? replacing.chunkCount, quotaChunkCount: m?.quotaChunkCount })
  }
}

/**
 * 整理好了：沒有要人核對的就直接加入（`D-123`②），有的話停在預覽（理由見 previewStopReasons）。
 * 三條路共用——剛按的（runPreview）、換頁回來接著跑的（resumeStoredJob）、背景跑完被定時撿回來的
 * （recheckStoredJob）——停不停的規則只有一份。auto=false 是舊版記號（按的是「先看整理結果」），照舊停在預覽。
 * ⚠️ 呼叫端要讓 previewing 在這段期間保持 true：輸入鎖、拖放守門、側欄「整理中」都看它。
 */
async function settlePreview(auto: boolean, stale: () => boolean) {
  stoppedFor.value = []
  autoImported.value = false
  if (!auto) {
    step.value = 'preview'
    return
  }
  // 等整理的這幾分鐘裡空間可能變了（別的分頁刪了、加了）：用新的數字判斷收不收得下。
  // 要換掉哪一份的話，「他改過哪幾條」也要讀完才知道停不停（`D-125`①；目標一選定就開始讀，見 startKeepLoad）
  await Promise.all([loadQuota(), keepLoad])
  if (stale()) return
  const reasons = previewStopReasons.value
  if (reasons.length) {
    stoppedFor.value = reasons
    step.value = 'preview'
    return
  }
  autoImporting.value = true
  autoImported.value = true
  try {
    await runImport()
  }
  finally {
    autoImporting.value = false
  }
  // 沒加成（網路、伺服器擋下，runImport 已經講了原因）：停在預覽，整理好的東西都還在，按一次加入就好——不重整理、不重付
  if (step.value !== 'result') {
    autoImported.value = false
    step.value = 'preview'
  }
}

async function runPreview() {
  const run = ++previewRun
  const stale = () => run !== previewRun
  // 「換掉那一份」只屬於這一輪：先拿走，這一輪失敗或被取代都不會留給下一份（見 redoReplacingDuplicate）
  const replacing = pendingReplace.value
  pendingReplace.value = null
  previewing.value = true
  previewError.value = ''
  previewStillRunning.value = false
  resetJobPoll()
  try {
    // backgroundAdvance：只有這條路（單筆匯入）的結果有人會回來收——記號落在 localStorage、
    // 回來自動接續，還有 recheck 定時器在看。整站每一頁刻意不帶（見 runSiteImport）。
    const body: Record<string, unknown> = {
      type: mode.value,
      // 總表改在加完之後問（`D-123`②，見 overviewOffer）：整理這一步不再請 AI 多做一張
      generateOverview: false,
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
      // 直打簽名網址；失敗時講人話，不把一長串網址丟到畫面上（見 utils/knowledge-upload）
      await putFileToSignedUrl(up.uploadUrl, file)
      // 上傳可能跑好幾秒:期間按了取消就到此為止,不要再去建一份沒人要的整理工作。
      // （下面的 reset 只是把「上傳檔案」的進度數字清掉，之後才進輪詢階段）
      if (stale()) return
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
      // ⚠️ 2026-10-12 起連時間一起帶（`D-123`②）：同名會讓這一份停在預覽，同一天貼第二段就被擋下來問「要不要更新上一段」——
      //    兩段不相干的文字，那一問本身就是錯的。名稱叫「一段文字」跟判別結果那一行同一個叫法
      const now = new Date()
      body.name = `一段文字 ${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    }

    // 已經匯過一模一樣的內容時要略過去重（使用者在下面那張卡按了「還是要再整理一次」）
    if (ignoreDuplicateOnce.value) body.ignoreDuplicate = true

    // 建 job(秒回)→ 輪詢推進(永不 504)。回應形狀與舊 preview-chunks 相同。
    const created = await apiFetch<{ jobId?: string; duplicate?: DuplicateHit }>(
      '/api/ai/knowledge/preview-jobs',
      { method: 'POST', body },
    )
    // 建工作那一下也可能跑好幾秒：期間按了取消，伺服器那份已經建好、而且帶著 backgroundAdvance
    // （排程會付錢把它做完）——取消那一刻還不知道它的編號、停不掉，這裡補停
    if (stale()) {
      if (created.jobId) apiFetch(`/api/ai/knowledge/preview-jobs/${created.jobId}`, { method: 'DELETE' }).catch(() => {})
      return
    }

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
    saveJobMarker(created.jobId, mode.value, mode.value === 'file' ? fileName.value : '', replacing, replaceIntentName.value)
    const res = await pollPreviewJob<PreviewResult & { status: 'done' }>(created.jobId, { isStale: stale })

    // 輪詢回來之後也要再確認一次:取消是在 await 期間按的
    if (stale()) return

    if (!res.chunks.length) {
      clearJobMarker()
      showToast('AI 沒有從這份整理出任何知識；檢查一下內容是不是空的、或改成直接貼文字', 'error')
      return
    }

    applyPreviewResult(res, mode.value, replacing)
    await settlePreview(true, stale)
  }
  catch (err: any) {
    if (stale()) return // 使用者自己按取消（記號已在 cancelPreview 清掉）、或已經開始另一輪：都不是錯誤
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
      ? '等太久了，畫面先不等——還在背景整理，好了會自己加進知識庫'
      : apiErrorText(err, '整理失敗').slice(0, 300)
  }
  finally {
    // 被取代的那一輪不碰畫面：previewing 已經由取消或新那一輪接手了
    if (!stale()) {
      previewing.value = false
      resetJobPoll()
      // 「換新版」那一行只陪這一輪（成功已經換到結果頁；失敗了再按一次就是一般加入）。
      // ⚠️ 等太久交給背景的不清：那一份好了照樣會換掉（記號裡有），這一行要陪到那時候
      if (!previewStillRunning.value) replaceIntentName.value = ''
    }
  }
}

/**
 * 資料頁「換新版」（`D-124` 新手走查：檔案改版以前只能回「加入知識」重傳、而且名字要一樣才會問要不要換）。
 * 父層在資料頁就開好選檔視窗（點擊當下才開得了），選好之後交到這裡：直接整理、整理好直接換掉那一份，
 * 跟「重新整理，換掉那一份」同一條路（pendingReplace → applyPreviewResult 選定覆蓋目標 → settlePreview）。
 * ⛔ 還有別的在跑就不接：半路換掉輸入，正在整理的那一份會不見。
 * ⚠️ 不略過「內容一模一樣」的守門：新版其實跟原本一字不差時，那張卡會講出來，不必白花一次 AI 的錢。
 */
const replaceIntentName = ref('')
function replaceWithFile(file: File, target: { id: string, name: string, chunkCount: number }) {
  // ⚠️ 守門要連「畫面不等了、背景還在跑」的那一份一起看（2026-10-13 `/code-review`）：
  //    以前只看 previewing，背景那份的記號會被新的這份蓋掉——整理完（錢已經花了）卻沒人把它加進去
  if (previewing.value || batchRunning.value || siteImporting.value || previewStillRunning.value) {
    showToast('「加入知識」裡還有一份正在整理（好了會自己加進去），等它好了再上傳新版', 'warning')
    return
  }
  // 整理好、停在「加入之前先看一下」等他核對的那一份（照片認字、沒讀完、空間不夠、同名）：
  // ⛔ 不可以直接清掉——那是付過錢、還沒人看過的結果，以前按了換新版就默默不見。視窗已經開著，他看得到是哪一份
  if (step.value === 'preview' && chunks.value.length > 0) {
    showToast('「加入知識」裡有一份整理好、還在等你看，先決定要不要加入，再上傳新版', 'warning')
    return
  }
  resetAll()
  if (!acceptFile(file)) return
  replaceIntentName.value = target.name
  pendingReplace.value = { id: target.id, name: target.name, type: 'file', chunkCount: target.chunkCount, updatedAtMs: 0 }
  void runPreview()
}
defineExpose({ replaceWithFile })

/** 取消整理:輪詢停掉、畫面回到可操作狀態（composable 早就有 cancel，只是這個視窗沒接） */
function cancelPreview() {
  previewRun++ // 正在跑的那一輪（整理或接回）從這一刻起作廢
  replaceIntentName.value = ''
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
/** 到測試對話多問幾題（`D-124`）：那頁會列出 AI 用了哪幾條、各自多像——加完最該去、卻沒人帶他去的地方 */
function goPlayground() {
  close()
  void navigateTo(`/admin/${workspaceId.value}/ai-playground`)
}

/**
 * 加好了那頁列的標題（`D-124`）：伺服器回來的那幾條（真的建進去的）；接回以前的工作時那份清單可能是空的，退用送出去的那幾條。
 */
const resultTitles = computed(() => {
  const fromServer = (result.value?.items ?? []).map(i => String(i.title ?? '').trim()).filter(Boolean)
  return fromServer.length ? fromServer : willImportChunks.value.map(c => c.title.trim()).filter(Boolean)
})

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

// 結果頁以前還講「產品：○○・資料夾：○○（是 AI 猜的）」——`C-320` 起只剩「放在『X』・改」（見結果頁那段註解）

// ── 「我們有賣什麼」總表：加完才問（`D-123`②） ─────────────────
/**
 * 搬自預覽頁（那裡是請 AI 把整份原文重讀一次）：一份也直接加入之後，大部分人不會經過預覽頁。
 * 改用已經進庫、學好的那幾條合成（`POST /api/ai/sources/:id/overview`，同步重生總表用的同一支）——不用原檔、不重做任何一條。
 *
 * 第一步原本有個勾選框問同一件事，2026-09-03（`D-50` 簡化 1）移除，**這裡是總表唯一的入口**。條件跟以前一樣嚴，
 * 接受等於再花一次 AI 用量，寧可少問也不要亂問：
 *  · 條數多（≥ 8）＝列了很多樣東西，這是手上唯一真的訊號；
 *  · 只問網址／檔案／貼文字——⚠️ `text` 不可以拿掉（勾選框移除後，貼一大段商品清單的人只剩這個入口）；
 *    Google 試算表維持以前不問；
 *  · 這次已經帶著總表加進去（接回以前的工作）不問；空間滿了不問（做了也放不下）。
 */
const OVERVIEW_SUGGEST_MIN_CHUNKS = 8
const overviewState = ref<'ask' | 'busy' | 'made' | 'none' | 'dismissed'>('ask')
const overviewOffer = computed(() => {
  const r = result.value
  if (step.value !== 'result' || !r?.sourceId || overviewState.value === 'dismissed') return false
  if (r.indexed < OVERVIEW_SUGGEST_MIN_CHUNKS || overviewCard.value) return false
  if (!['url', 'file', 'text'].includes(sourceMeta.value.type)) return false
  // 做好／做不出來的那一句要留著給他看；還沒按之前空間滿了就不問
  const q = quota.value
  if (overviewState.value === 'ask' && q && q.limit != null && q.used >= q.limit) return false
  return true
})
async function makeOverview() {
  const id = result.value?.sourceId
  if (!id) return
  overviewState.value = 'busy'
  try {
    const res = await apiFetch<{ made: boolean }>(`/api/ai/sources/${encodeURIComponent(id)}/overview`, { method: 'POST' })
    // ⛔ 沒做出來要照實講：按了「做一張」卻什麼都沒有，人只會以為按了沒用
    overviewState.value = res.made ? 'made' : 'none'
    if (res.made) void loadQuota()
  }
  catch (err: any) {
    overviewState.value = 'ask'
    showToast(apiErrorText(err, '沒做成') + (isRetryableError(err) ? '，請再試一次' : ''), 'error')
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
    if (row) row.failureReason = apiErrorText(err, row.failureReason ?? '')
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
  // 與畫面上的按鈕共用同一份判斷（見 willImportChunks、sendChunks 的說明）；
  // 放不下時只送前 fitChunkCount 條（`C-296`：收到滿為止，不再整批被擋）
  const selected = sendChunks.value
    .slice(0, fitChunkCount.value)
    .map(c => ({ title: c.title.trim(), content: c.content.trim(), tags: c.tags, questions: c.questions ?? [] }))

  if (!selected.length) {
    return showToast(
      overQuotaBy.value > 0
        ? '知識空間已經滿了：先刪掉用不到的知識，或升級方案'
        : includedCount.value > 0 ? '新版的每一條都跟你改過、要帶過去的同名——原本那一份不用更新' : '請至少選一條',
      'error',
    )
  }
  // 他改過的那幾條還在讀（`D-125`①）：讀完才知道要不要帶，⛔ 不先送（送了就照舊全進回收桶）
  if (replaceTarget.value && keepLoading.value) return showToast('還在讀原本那一份你改過哪幾條，等一下再按', 'warning')
  if (selected.length > 150) return showToast('一次最多加入 150 條，請先取消勾選一些', 'error')

  importing.value = true
  const skippedNow = overQuotaBy.value
  /** 這一下才替他建的新分組（加入失敗時要收掉，`/code-review` ⑥） */
  let createdGroupId: string | null = null
  let heldGroupId: string | null = null
  try {
    const ov = overviewCard.value
    const overviewPayload = ov && overviewFits.value
      ? { title: ov.title.trim(), content: ov.content.trim(), tags: ov.tags, questions: ov.questions ?? [] }
      : null
    // 「更新原本那一份」而他沒動分組：不帶，那一份原本放哪就留在哪。
    // ⛔ 帶了的話伺服器照收，舊資料會被默默搬到猜的那一組（2026-10-12 code review）
    const keepOldGroup = !!replaceTarget.value && !groupTouched.value
    // 新分組這時才建（`C-320`）：建不成就先不放分組，照樣加進去（見 folderIdForImport）
    const picked = keepOldGroup ? undefined : await folderIdForImport()
    const sentFolderId = picked?.folderId
    if (picked?.createdNow) createdGroupId = picked.folderId
    // 請求在路上的這段時間，別人（一次好幾份那幾列）不可以把這一組當空的刪掉（見 registry.hold）
    if (sentFolderId) {
      heldGroupId = sentFolderId
      groupRegistry.hold(sentFolderId)
    }

    const res = await apiFetch<typeof result.value>('/api/ai/knowledge/bulk-create', {
      method: 'POST',
      body: {
        source: {
          type: sourceMeta.value.type,
          name: sourceMeta.value.name.trim() || '未命名資料',
          url: sourceMeta.value.url,
          // 商品名不送（`D-127`）：伺服器照放進的那一組決定（換掉原本那一份又沒動分組＝照它原本那一組）
          contentHash: sourceMeta.value.contentHash,
          ...(sentFolderId === undefined ? {} : { folderId: sentFolderId }),
          // 原檔留著時「下載原檔」存成這個名字（`C-296`③）；接回背景整理時沒有檔名就退用資料名稱
          ...(sourceMeta.value.type === 'file' ? { fileName: fileName.value || sourceMeta.value.name } : {}),
          // 換新版時勾了要帶過去的那幾條（`D-125`①）：留在原地、不進回收桶
          ...(replaceTarget.value && keptItems.value.length ? { keepEditedChunkIds: keptItems.value.map(c => c.id) } : {}),
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
    quotaSkipped.value = skippedNow
    // 結果頁那一行「放在『X』」（`C-320`）：講**伺服器真的放的**那一組，不是送出去的（`/code-review` ⑨：
    // 「更新原本那一份」改選「不放分組」送 null，舊版伺服器會不理、那一份還在原本那組，畫面卻說不放分組）。
    // 回應有 folderId 就照它；沒有、又是更新原本那一份而他改了分組，就讀一次那一份（讀不到＝不知道，講「分組不變」）
    const replied = res && 'folderId' in res
    let actualFolderId: string | null | undefined = sentFolderId
    if (replied) actualFolderId = (res as { folderId?: string | null }).folderId ?? null
    else if (replaceTarget.value && !keepOldGroup && res?.sourceId) actualFolderId = await readSourceFolderId(res.sourceId)
    if (heldGroupId) groupRegistry.unhold(heldGroupId)
    heldGroupId = null
    if (actualFolderId) groupRegistry.use(actualFolderId)
    // 剛建的那一組結果確定沒用上（伺服器沒放進去）：空的，收掉；不知道放了沒（讀不到）就留著
    if (createdGroupId && actualFolderId !== undefined && actualFolderId !== createdGroupId) void groupRegistry.discardIfUnused(createdGroupId)
    savedGroup.value = keepOldGroup && !replied
      ? currentGroupOf(replaceTarget.value!.id)
      : actualFolderId === undefined ? null : (actualFolderId ? { kind: 'folder', id: actualFolderId } : { kind: 'none' })
    groupSync.value = null
    if (!autoImporting.value) groupAsk.value = false
    clearJobMarker() // 卡已經進庫了,這份整理工作到此為止
    void loadQuota() // 「繼續匯入」下一份時，剩幾條要是新的數字
    // 一律停在結果頁（D-40）。以前全成功是「跳 toast 就關窗」——那是使用者最想問
    // 「然後呢」的一刻，卻是整段流程唯一沉默的地方；而正確答案常常是「AI 還關著，
    // 客人聽不到」。⛔別把交棒卡改成 toast：toast 3.5 秒就消失，這張卡上有要按的按鈕。
    if (res) {
      step.value = 'result'
      verifyOutcome.value = null
      overviewState.value = 'ask'
      void loadAiEnabled() // 背景查，查不到就整塊不畫（不擋畫面）
      // 視窗開著：結果頁就是交代，不另跳提示（以前同一句話 toast 一次、結果頁又講一次，2026-10-12 文字審視）。
      // 視窗關著（關掉視窗等它自己加完，`D-123`②）：清單現在就刷新、講一句；結果頁留著，側欄點回去看得到。
      // ⛔ 這時候不選中那一份：他可能正在看別份，刷新清單就好（選中留到他自己回來關窗時）
      if (!dialogShown.value) {
        emit('imported', null)
        const name = sourceMeta.value.name.trim() || '未命名資料'
        showToast(
          res.failed === 0
            ? `「${name}」已加進知識庫（${res.indexed} 條）`
            : `「${name}」已加進知識庫：${res.indexed} 條可用、${res.failed} 條 AI 還沒學起來`,
          res.failed === 0 ? 'success' : 'warning',
        )
      }
    }
  }
  catch (err: any) {
    // 剛替他建的新分組、加入卻沒成（403 空間滿、500⋯）：空的，收掉（`/code-review` ⑥）。
    // ⛔ 斷線、逾時、閘道錯不收：伺服器可能其實放進去了，刪了那一組會把這一份又移出分組（見 writeMayHaveLanded）
    if (heldGroupId) groupRegistry.unhold(heldGroupId)
    heldGroupId = null
    if (createdGroupId && !writeMayHaveLanded(apiErrorStatus(err))) void groupRegistry.discardIfUnused(createdGroupId)
    // ⚠️ 中文的原因在 data.statusMessage：err.statusMessage 是 HTTP 狀態那一行（HTTP/2 下是空的），
    //    只看它的話空間不夠、舊的那份已經被刪掉這些 403／404 會變成一串「[POST] …: 403」（審查實測）
    // 自動加入失敗時畫面會停在預覽（見 settlePreview），要講「還沒加進去」——只丟伺服器的原因，人會以為加了一半。
    // 「可以再按一次」只在再按有用時講（`C-308`⑩）：空間滿了、那一份不在了這種 4xx，再按一百次都一樣
    const why = apiErrorText(err, '')
    const retry = isRetryableError(err) ? '可以再按一次加入' : ''
    showToast(autoImporting.value
      ? `還沒加進去${why ? `：${why}` : ''}（整理好的內容還在${retry ? `，${retry}` : ''}）`
      : (why || '加入失敗'), 'error')
  }
  finally {
    importing.value = false
  }
}

function resetAll() {
  // 背景還在整理的那一份（畫面等太久、交給排程推的單份）不是這一輪的東西：一次好幾份／整站跑完收工時
  // 一起清掉的話，它做完沒人接、側欄的「整理中」也跟著消失（2026-10-11 審查）。
  // 它的那句「好了會自己加進知識庫」也要留著；其餘的錯誤字跟著這一輪清掉
  if (!previewStillRunning.value) {
    clearJobMarker()
    previewError.value = ''
    replaceIntentName.value = '' // 背景那一份是「換新版」的話，那一行要陪到它換好（記號裡有要換哪一份）
  }
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
  overviewState.value = 'ask'
  overviewCard.value = null
  stoppedFor.value = []
  autoImported.value = false
  pendingReplace.value = null
  existingMatches.value = []
  truncated.value = false
  incomplete.value = false
  ocrUsed.value = false
  ocrFromPhoto.value = false
  healthWarnings.value = []
  result.value = null
  metaOpen.value = false
  // ⚠️ 探測狀態要一起清（2026-09-03 code review 抓到）：只清輸入不清這兩個的話，
  //    再貼同一個試算表連結時 watcher 會因為「這個網址測過了」直接 return，
  //    而結果早就被清成 null → 綠勾與「正在確認」都不會出現，畫面停在「還沒證明讀得到」。
  gsheetProbe.value = null
  gsheetProbedUrl = ''
  sourceMeta.value = { type: '', name: '', url: '', productName: '', contentHash: '' }
  // 換一份就全部歸位：守門旗標若留著，接下來每一份都不再檢查重複（`C-134`）
  // 分組（`C-320`）也歸位；這次開窗建過的分組（localGroups）留著——下一份同一個商品要比得到它
  autoGroup.value = { choice: { kind: 'none' }, ask: false }
  groupChoice.value = { kind: 'none' }
  groupAsk.value = false
  groupTouched.value = false
  savedGroup.value = undefined
  groupSync.value = null
  replaceTarget.value = null
  quotaSkipped.value = 0
  batchFiles.value = []
  batchRunning.value = false
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
  // 一次好幾份（`C-296`④）：同整站匯入，講清楚再放人，不擋。數字照實講——
  // 「正在跑的會跑完」與「還沒開始的不會匯入」是兩件事；同名、等他決定的那幾份關掉就不匯入了，也要講
  const batch = step.value === 'fileBatch' ? fileBatchRef.value?.snapshot() : undefined
  if (batch && (batchRunning.value || batch.conflicts)) {
    const conflictLine = batch.conflicts ? `跟現有資料同名、等你決定的 ${batch.conflicts} 份不會匯入（整理好的結果會丟掉）。` : ''
    try {
      await ElMessageBox.confirm(
        batchRunning.value
          ? `已經匯好的 ${batch.done} 份會保留在知識庫。`
            + (batch.processing ? `正在整理的 ${batch.processing} 份會跑完、也會匯入。` : '')
            + (batch.queued ? `還沒開始的 ${batch.queued} 份不會匯入。` : '')
            + conflictLine
          : conflictLine,
        batchRunning.value ? '要停止匯入嗎？' : '還有檔案在等你決定',
        batchRunning.value
          ? { confirmButtonText: '停止', cancelButtonText: '繼續整理', type: 'warning' }
          : { confirmButtonText: '關掉，不匯入', cancelButtonText: '回去決定', type: 'warning' },
      )
    }
    catch {
      return
    }
  }
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
  dialogShown.value = false // 見 dialogShown：關閉動畫跑完之前就要算「看不到了」
  // 整站批次還在跑時關窗(ESC / X):通知 worker 收工,收尾由 runSiteImport 負責
  // (它會 emit imported 讓列表帶出已建立的資料,再 resetAll)——這裡不能先 reset,
  // 否則正在跑的那幾頁寫完後會把狀態寫回已清空的 ref。
  if (siteImporting.value) {
    siteAborted.value = true
    return
  }
  // 一次好幾份還在跑：叫它收工，收尾（刷新清單、講一句）由 onFileBatchFinished 負責
  if (batchRunning.value) {
    fileBatchRef.value?.abort()
    return
  }
  // 一次好幾份已經跑過（不論成敗）：關窗＝這一批收工。⛔ 不留到下次——以前成功過的會清、
  // 一份都沒成的卻留著，下次打開還是那張跑完的舊清單（2026-10-11 審查：同樣關窗兩種結果）。
  // 沒按過「整理並匯入」的照「關窗保留輸入」的規矩留著
  if (step.value === 'fileBatch' && fileBatchRef.value?.snapshot().started) {
    if (result.value) emit('imported', null)
    resetAll()
    return
  }
  if (result.value) {
    emit('imported', result.value.sourceId)
    resetAll()
  }
}

</script>
