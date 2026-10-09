<template>
  <AdminSplitLayout :is-empty="!selectedItem && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="bc-title">推播<AdminPageHelpButton :topics="['broadcasts']" /></span>
      <el-button v-if="can('broadcast.write')" :icon="Plus" type="primary" size="small" data-tour="bc-new" @click="openCreate">新增</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <!-- `D-112`：「用一句話擬草稿」接在「新增」正下方（標頭 240px 塞不下第三顆）。
           ⛔ 只建草稿，發送照舊要他自己按（紅線） -->
      <AgentAskButton page="broadcasts" label="用一句話擬草稿" row />
      <!-- 節慶行銷提醒（2026-08-28 拍板）：人真的要動手排推播時就在這一頁——
           「中秋節快到了」最該出現的地方。文案跟 LINE 每日摘要那段同一支函式產
           （utils/festival-hint.ts），窗外整條不渲染。⛔不用警示色：這不是異常。 -->
      <p v-if="festival" class="bc-festival-hint">🎉 {{ festival.text }}</p>
      <!-- 草稿彙總（D-43④）：建了沒發的推播原本全站沒有一處會講，只有清單裡散落的灰章。
           數字問後端拿全量 total，⛔不數已載入的清單頁（分頁會漏算）。
           點了切成只看草稿——一行提醒不能是死路。篩選開著時就算歸零也要留著出口。 -->
      <button
        v-if="draftFilterOn || (draftTotal ?? 0) > 0"
        type="button"
        class="bc-draft-hint"
        :class="{ active: draftFilterOn }"
        :aria-pressed="draftFilterOn"
        @click="toggleDraftFilter"
      >
        <span v-if="(draftTotal ?? 0) > 0">📝 有 {{ draftTotal }} 則草稿還沒發</span>
        <span v-else>📝 草稿都處理完了</span>
        <span class="bc-draft-hint__act">{{ draftFilterOn ? '顯示全部' : '只看草稿' }}</span>
      </button>
      <div v-if="loading && !broadcasts.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!broadcasts.length" class="split-sidebar-empty">
        <span>尚無推播</span>
        <el-button v-if="can('broadcast.write')" size="small" type="primary" plain @click="openCreate">立即新增</el-button>
      </div>
      <div v-else ref="listEl" class="split-list" data-tour="bc-list" @scroll.passive="onSidebarListScroll">
        <AdminSplitListItem
          v-for="bc in broadcasts"
          :key="bc.id"
          :title="bc.name"
          :active="selectedId === bc.id"
          time-in-title-row
          title-row-chip
          :chip-text="statusLabel(bc.status)"
          :chip-tone="broadcastTone(bc.status)"
          :meta-text="bcMetaText(bc)"
          meta-truncate
          :data-agent-target="bc.id"
          @select="selectItem(bc)"
        />

        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
          <span>載入更多…</span>
        </div>
      </div>
    </template>

    <!-- ── Empty State ── -->
    <template #editor-empty>
      <el-icon class="empty-icon"><Promotion /></el-icon>
      <h3>選擇一則推播來查看或編輯</h3>
      <p v-if="can('broadcast.write')">或點擊左側「新增」建立新推播</p>
      <div class="empty-actions">
        <el-button v-if="can('broadcast.write')" type="primary" @click="openCreate">新增推播</el-button>
        <!-- 空清單＝最不打擾的教學位（D-33 P2）：這裡本來就沒東西可看 -->
        <AdminPageHelpButton :topics="['broadcasts']" label="第一次用？看一遍怎麼發" />
      </div>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <AdminEditorHeaderTitle
        v-if="can('broadcast.write')"
        v-model="form.name"
        field-label="推播名稱"
        create-prefix="新增推播:"
        placeholder="請輸入推播名稱…"
        caption="為這則推播命名，方便後續管理"
        :is-creating="isCreating"
      />
      <!-- `G-107`：觀察者存不了，名稱只給看（同知識庫頁資料名稱的做法） -->
      <div v-else class="admin-flex-1">
        <AdminFieldLabel text="推播名稱" tight />
        <div class="admin-title-row">
          <span class="split-editor-title">{{ form.name || '(未命名)' }}</span>
        </div>
      </div>
      <div class="flex gap-1 admin-header-actions">
        <!-- `C-229`：跟機器人模組頁同一顆、同樣的措辭；⛔ 唯讀（已發送）時也留著，
             那時人正在回頭查「我那天到底發了什麼」，正是最需要看預覽的時候。 -->
        <el-button size="small" @click="previewOpen = !previewOpen">
          {{ previewOpen ? '隱藏預覽' : '顯示預覽' }}
        </el-button>
        <!-- 已完成/取消 → 只看報表；失敗 → 多一個重發出口。
             `G-107`：觀察者看草稿／排程中的也走這一排（只有「關閉」），不給一顆什麼都不做的「取消」 -->
        <template v-if="isLocked">
          <el-button
            v-if="can('broadcast.send') && selectedItem?.status === 'failed'"
            type="warning"
            plain
            :loading="retrying"
            @click="retryBroadcast"
          >
            重設為草稿再發一次
          </el-button>
          <el-button @click="cancelEdit">關閉</el-button>
        </template>
        <!-- 可編輯 -->
        <template v-else>
          <el-button
            v-if="can('broadcast.send') && !isCreating && selectedItem && ['draft','scheduled'].includes(selectedItem.status)"
            type="danger"
            plain
            @click="cancelBroadcast"
          >
            {{ selectedItem.status === 'scheduled' ? '取消排程' : '取消推播' }}
          </el-button>
          <el-button @click="cancelEdit">取消</el-button>
          <el-button v-if="can('broadcast.write')" :loading="saving" @click="saveDraft">
            {{ selectedItem?.status === 'scheduled' ? '儲存變更' : '儲存草稿' }}
          </el-button>
          <!-- `G-109`：驗證本身是讀取，這顆按到底是 `send`／`schedule`，所以照 `broadcast.send` 擋 -->
          <el-button v-if="can('broadcast.send')" type="primary" :loading="validating" data-tour="bc-send" @click="openValidateDialog">
            {{ headerSubmitLabel }}
          </el-button>
        </template>
        <!-- 複製成一則新草稿（全站同一顆「⋯」）。
             ⛔ 已發送的也要給：最常見的用法正是「上次那則改一下再發一次」 -->
        <AdminMoreMenu
          v-if="can('broadcast.write') && !isCreating && selectedItem"
          :items="[{ command: 'duplicate', label: '複製', icon: CopyDocument, disabled: duplicating }]"
          @command="onHeaderCommand"
        />
      </div>
    </template>

    <!-- ── Editor Body（與其他編輯頁相同：可捲動 + padding + 區塊間距）── -->
    <template #editor-body>
      <!--
        `C-229`：表單 ｜ 即時預覽 兩欄。
        ⛔ 預覽**預設打開**（跟機器人模組那頁一樣）：推播是唯一「按下去就送給全部好友、
        收不回來」的功能，最需要看的人正是還沒想到要去按「顯示預覽」的那個人。
      -->
      <div class="bc-body-row">
      <div class="ar-editor-body admin-panel-stack bc-editor-col">
        <el-form label-position="top" class="admin-form-vertical bc-editor-form" @submit.prevent>

        <!-- ⓪  發送失敗原因（含看門狗收殮的卡死單「能否安全補發」判定） -->
        <div v-if="failedReason" class="message-card bc-section-card">
          <div class="card-section-stack">
            <p class="bc-failed-reason">{{ failedReason }}</p>
          </div>
        </div>

        <!-- ①  受眾設定 -->
        <div class="message-card bc-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">受眾設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- bc-audience：導覽也用這一格判斷「編輯器已經開著」（每則推播都有受眾設定），
                 開著就不要再幫他按一次「新增」把手上編到一半的推播切掉 -->
            <div class="admin-field-group" data-tour="bc-audience">
              <AdminFieldLabel text="發送對象" tight />
              <el-radio-group v-model="form.audienceType" :disabled="isLocked">
                <el-radio value="all">全部好友</el-radio>
                <el-radio value="tags">依標籤篩選</el-radio>
                <el-radio value="import">匯入名單</el-radio>
              </el-radio-group>
            </div>

            <!-- 依標籤 -->
            <div v-if="form.audienceType === 'tags'" class="admin-field-group">
              <AdminFieldLabel text="選擇標籤（符合任一即納入）" tight />
              <!-- 交集／聯集是分眾最常被誤解的一件事，而寄錯人收不回來（D-33 P1） -->
              <p class="text-xs text-muted">
                選兩顆以上是「或」：只要有其中一顆標籤的人都會收到，<b>不是</b>兩顆都要有。
                想寄給「兩個條件都符合」的人，目前要先到「好友」頁篩出那批人。
              </p>
              <!--
                C-208：共用選標籤欄位，但這一格 **allow-create = false**。
                ⛔ 別在這裡放「＋ 新標籤」：這格是「拿標籤篩人」不是「貼標籤」，
                當場建一顆全新的標籤身上沒有任何客人，等於挑到 0 個人、發給沒有人
                （送出前的驗證會擋下來，但那時他已經寫完整則推播了）。
                要多一群人可以發，正解是先去貼標，所以這裡只給出口與說明。
              -->
              <AdminTagPicker
                :model-value="form.tagIds"
                :options="allTags"
                :allow-create="false"
                :disabled="isLocked"
                placeholder="選擇標籤（可打字搜尋）"
                empty-text="還沒有任何標籤，所以沒有辦法用標籤挑人。標籤要先建好、而且要貼在客人身上，這裡才挑得到——貼標可以在機器人模組的按鈕、活動連結或客服預存上設定。"
                @update:model-value="(ids) => (form.tagIds = ids)"
              />
            </div>

            <!-- 匯入名單 -->
            <div v-if="form.audienceType === 'import'" class="admin-field-group">
              <AdminFieldLabel text="LINE User IDs（每行一筆）" tight />
              <!-- 這串東西從哪來，畫面上以前一個字都沒講（`D-39` 08-28 列出、`D-82` 補）：
                   沒人天生知道 U 開頭那 33 碼要去哪拿，而這一格又是三個選項裡最像「進階功能」的。
                   ⛔ 一併指出多數人其實不需要它——否則新手會以為要先湊出一份名單才能發推播。 -->
              <p class="text-xs text-muted">
                每位客人在 LINE 都有一串 <b>U 開頭</b>的專屬編號。要拿某位客人的編號，到「<b>好友</b>」頁點開他、
                按「<b>複製 ID</b>」。<b>多數情況用不到這一格</b>——想發給某一群人，用上面的「依標籤篩選」比較快；
                這裡是給「別人交給你一份名單」的情況用的。
              </p>
              <el-input
                v-model="form.importText"
                type="textarea"
                :rows="5"
                placeholder="Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                :disabled="isLocked"
              />
              <span class="tags-hint">共 {{ importUserIds.length }} 筆</span>
            </div>

            <!-- 受眾快照（已發送） -->
            <div v-if="isReadOnly && selectedItem?.audienceSnapshot?.estimatedCount" class="bc-snapshot-info">
              <span>發送時受眾：{{ selectedItem.audienceSnapshot.estimatedCount }} 位</span>
            </div>
          </div>
        </div>

        <!-- ②  訊息內容（與圖文訊息區塊相同：動作類型 + 欄位） -->
        <div class="message-card bc-section-card" data-tour="bc-content">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">訊息內容</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- `C-225`：從「接下來的檔期」擬過來的三版文案。
                 ⛔ 只在這一趟出現（重新整理就沒了）——它是草稿的起點，不是一個常駐功能。
                 ⛔ 一定要講「還沒有送出去」：對客人說話的東西，最後一顆按鈕永遠是人。 -->
            <div v-if="draftVariants.length > 1" class="bc-draft-picker">
              <p class="bc-draft-picker__lead">
                MiniMe 擬了 {{ draftVariants.length }} 版，挑一版再改。{{ draftBasis }}，<b>還沒有送出去</b>。
              </p>
              <el-radio-group
                :model-value="draftVariantIndex"
                :disabled="isLocked"
                @update:model-value="(v) => pickDraftVariant(Number(v))"
              >
                <el-radio v-for="(v, i) in draftVariants" :key="i" :value="i" class="bc-draft-picker__item">
                  <span class="bc-draft-picker__text">{{ v }}</span>
                </el-radio>
              </el-radio-group>
            </div>

            <!--
              `C-238`：`flow-picker-context="broadcast"` 讓選模組那一格多講一句
              「網址按鈕的貼標在推播裡不會生效」——⛔ 只有這一頁該講，別處那條路是有效的。
            -->
            <AdminAreaActionEditor
              :model-value="form.contentAction"
              :module-options="flowOptions"
              :enable-card-copy="true"
              :disabled="isLocked"
              flow-picker-context="broadcast"
              @update:model-value="onContentActionUpdate"
            />
            <!--
              這件事以前畫面上一個字都沒有，想發「圖＋文字＋按鈕」的人只會在這一頁一直找、找不到。
              ⛔ 不是警告色：這不是故障，是這個功能就長這樣，而且指得出正確的做法。

              ⚠️ `C-245`：**原本這句寫「一則推播只會送出一則訊息」，那是錯的**——選「觸發機器人
              模組」時，送出端會把模組裡的每一則都直接送出去（上限 5 則），正式庫 24 則模組型推播
              常態就是「圖文訊息＋一段文字」兩則。`F-9` 那條的結論（要多則就去建模組）沒有變。
            -->
            <p class="bc-click-hint text-muted">
              自己在這裡打的字<b>只會送出一則</b>。要一次送圖片、好幾段文字或多顆按鈕，
              請先到「<NuxtLink :to="`/admin/${workspaceId}/flow`" class="link">機器人模組</NuxtLink>」把那一組訊息做好，
              這裡再選「觸發機器人模組」——<b>模組裡的每一則都會直接送到客人手機上</b>（最多 5 則）。
            </p>
            <!--
              `C-248`：先發一則給自己看。
              ⛔ 放在「訊息內容」這張卡裡，不放在頁首那排按鈕旁邊——人要試的是**內容**，
              而頁首那排的旁邊就是「驗證並發送」，兩顆長得太近會按錯，而按錯的那一顆收不回來。
            -->
            <div v-if="!isReadOnly && can('broadcast.write')" class="bc-testsend" data-tour="bc-testsend">
              <el-button size="small" @click="openTestSend">試發一則給自己看</el-button>
              <span class="text-xs text-muted">
                真的會送到那支手機。<b>不會</b>算進成效報表、<b>不會</b>貼記號、<b>不會</b>改變這則推播的狀態。
              </span>
            </div>
            <!-- ⛔ 這段以前把四個環境變數名（PUBLIC_BASE_URL…）與 /api/r 攤在店家面前（`D-82`）：
                 店家看不懂、也不可能自己去設，讀完只會更怕。技術細節留在這裡給工程人員看就好，
                 畫面只講「哪些數字算得到、哪些算不到、算不到要找誰」。
                 （追蹤連結需要 PUBLIC_BASE_URL／舊名 LINE_IMAGEMAP_BASE_URL／CLICK_TRACKING_BASE_URL
                 其中之一設好，客人點的網址才會經過我們的轉址再開啟。） -->
            <p class="bc-click-hint text-muted">
              <b>開封數</b>＝有多少人看到這則推播，數字由 LINE 官方提供（不是即時的，通常會延遲）。
              <b>連結點擊</b>只算得到「訊息裡的網址」被點的次數，而且這項要工程人員先設定過才會有數字——
              還沒設定就只會看到開封數，不是壞掉。純文字、或按了之後回傳訊息的按鈕，都不會算進點擊。
            </p>
          </div>
        </div>

        <!-- ③  發送設定 -->
        <div v-if="!isReadOnly" class="message-card bc-section-card" data-tour="bc-schedule">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">發送設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="admin-field-group">
              <AdminFieldLabel text="發送時間" tight />
              <el-radio-group v-model="form.scheduleMode" :disabled="isLocked">
                <el-radio value="now">立即發送</el-radio>
                <el-radio value="schedule">排程發送</el-radio>
              </el-radio-group>
            </div>
            <!--
              `C-213`：發完幫收到的人貼記號。
              ⛔ 這一格的標籤是**貼上去**不是拿來篩人，所以給得起「＋ 新標籤」
              （跟上面「發送對象」那一格刻意相反）。
            -->
            <div class="admin-field-group">
              <AdminFieldLabel text="發完之後，幫收到的人貼一個記號（選填）" tight />
              <AdminTagPicker
                :model-value="form.completionTagIds"
                :options="allTags"
                :disabled="isLocked"
                placeholder="不貼記號（可打字搜尋）"
                @update:model-value="(ids) => (form.completionTagIds = ids)"
              />
              <p class="text-xs text-muted">
                之後就查得到「上次收過這則的是哪些人」，也能拿它再發一次或排除他們。
                ⛔ <strong>只會貼給真的收到的人</strong>——失敗的（多半是封鎖了官方帳號）不貼。
                要「已收到某某推播」這種粒度，就在這裡按「＋ 新標籤」現建一顆。
              </p>
            </div>
            <div v-if="form.scheduleMode === 'schedule'" class="admin-field-group">
              <AdminFieldLabel text="排程時間" tight />
              <el-date-picker
                v-model="form.scheduleAt"
                type="datetime"
                placeholder="選擇日期與時間"
                format="YYYY/MM/DD HH:mm"
                value-format="YYYY-MM-DDTHH:mm:ss"
                :disabled-date="disabledPastDate"
                :disabled="isLocked"
              />
              <p v-if="selectedItem?.status === 'scheduled'" class="tags-hint">
                已排程，時間到後系統會自動發送（開著這個推播列表頁最保險；若要完全自動、關頁也能發，需請工程人員設定好伺服器）。<template v-if="can('broadcast.write')">可以「儲存變更」或「取消排程」。</template>
              </p>
              <p v-else-if="can('broadcast.send')" class="tags-hint">
                按下確認後不會馬上發，要到排程時間才送出；發送對象也是到那個時間點才計算。
              </p>
            </div>
          </div>
        </div>

        <!-- ④  成效報表（已發送） -->
        <div v-if="report" class="message-card bc-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">成效報表</span>
            </div>
            <el-button size="small" @click="loadReport">重新整理</el-button>
          </div>
          <div class="card-section-stack">
            <p v-if="report.postSendError" class="bc-postsend-note">
              訊息已經送出去了，不必重發。只是送出後在整理紀錄時中斷，「每個人收到沒有」的逐筆明細可能不完整；下面的發送總數、成功、失敗數字仍然是準的。
            </p>
            <!--
              `C-213`：貼記號的結果。⛔ 失敗一定要講出來——不講的話，使用者會以為那群人
              身上有記號，之後照著它挑名單就會漏人，而且完全查不出為什麼少了幾個。
            -->
            <p v-if="completionTagNote" class="bc-postsend-note">{{ completionTagNote }}</p>
            <div class="bc-stats-row">
              <div class="bc-stat-box">
                <div class="bc-stat-label">發送總數</div>
                <div class="bc-stat-value">{{ report.totalCount }}</div>
              </div>
              <div class="bc-stat-box">
                <div class="bc-stat-label">成功</div>
                <div class="bc-stat-value">{{ report.sentCount }}</div>
              </div>
              <div class="bc-stat-box">
                <div class="bc-stat-label">失敗</div>
                <div class="bc-stat-value">{{ report.failedCount }}</div>
              </div>
              <div class="bc-stat-box">
                <div class="bc-stat-label">開封數（LINE）</div>
                <div class="bc-stat-value">{{ formatNullableStat(report.lineUniqueImpression) }}</div>
              </div>
              <div class="bc-stat-box">
                <div class="bc-stat-label">追蹤連結點擊</div>
                <div class="bc-stat-value">{{ report.linkClickCount ?? report.clickCount }}</div>
              </div>
            </div>
            <div v-if="report.failedRecipients?.length" class="admin-field-group">
              <AdminFieldLabel text="沒收到的人（多半是對方已封鎖官方帳號，可個別跟進）" tight />
              <ul class="bc-failed-list">
                <li v-for="u in report.failedRecipients" :key="u.lineUserId" class="bc-failed-item">
                  <span class="bc-failed-name">{{ u.displayName }}</span>
                  <span class="bc-failed-id">{{ u.lineUserId }}</span>
                </li>
              </ul>
              <p v-if="report.failedRecipientsTruncated" class="bc-insight-warn text-muted">
                共 {{ report.failedCount }} 位沒收到，這裡只列出前 {{ report.failedRecipients.length }} 位。
              </p>
            </div>
            <div class="admin-field-stack">
              <div class="admin-field-group">
                <AdminFieldLabel text="開封率（LINE 官方統計，非即時、通常會延遲）" tight />
                <span class="bc-ctr-value">{{ formatPercentRate(report.openRate) }}</span>
              </div>
              <div class="admin-field-group">
                <AdminFieldLabel text="追蹤連結點擊率" tight />
                <span class="bc-ctr-value">{{ (report.ctr * 100).toFixed(2) }}%</span>
              </div>
              <div v-if="report.lineUniqueClick != null" class="admin-field-group">
                <AdminFieldLabel text="LINE 官方統計：點過訊息內網址的人數" tight />
                <span class="bc-ctr-value">{{ report.lineUniqueClick }}</span>
              </div>
              <p v-if="report.lineInsightError === 'LINE_AGGREGATION_SKIPPED'" class="bc-insight-warn text-muted">
                這則推播在發送時沒有帶到 LINE 的統計標記（多半是 LINE 當下不接受，系統只好改用一般方式送出），所以這裡查不到開封數。可以再發一則新推播試試；這則的開封數請改到 LINE 官方帳號管理後台（LINE Official Account Manager）查看。
              </p>
              <p v-else-if="report.lineInsightError" class="bc-insight-warn text-muted">
                LINE 統計：{{ report.lineInsightError }}（剛發送完通常要等幾個小時才會有數字；請稍後再按「重新整理」）
              </p>
              <p
                v-else-if="report.lineUniqueImpression == null && report.lineInsightAggregationApplied !== false"
                class="bc-insight-warn text-muted"
              >
                開封數顯示「—」：LINE 官方統計通常不是即時的；而且如果實際看過的人太少，LINE 基於隱私會直接不給數字（跟聊天室看到的「已讀」不一定同步）。
              </p>
            </div>
          </div>
        </div>

        </el-form>
      </div>

      <!--
        即時預覽。⛔ 已發送／已取消的推播也要看得到：那時人正在回頭查「我那天到底發了什麼」。

        `C-245`（2026-09-24）**修掉一個畫了四個月、客人一次都沒收到的預覽**：
        選「觸發機器人模組」時，`unifiedActionToLineMessages()` 組出來的那張
        「點下面的按鈕看看＋開始」卡片，**送出端會在送出前整張換成模組自己的那幾則訊息**
        （`broadcast-send.ts`，2026-05-07 起）。所以這裡分三條路，判斷用的是**送出端同一支**
        `extractBroadcastTriggerModuleId()`：
          ① 已送出且有留存 → 畫**當時真的送出去的那一份**（`C-246` 的快照）
          ② 模組型 → 用共用的 `AdminActionPreview` 把那個模組**真的抓回來畫**（三態它自己講）
          ③ 純文字／開啟網址 → 原本就是對的，原封不動
        ⛔ 不要為了推播另寫第二套預覽元件（`H-27`：預覽在說謊比沒有預覽更糟）。
      -->
      <template v-if="previewOpen">
        <!-- ① 已送出，而且當時的內容有留存 -->
        <div v-if="sentContentMessages.length" class="bc-preview bc-preview--panel">
          <p class="aap__source">
            這是<b>當時真的送出去</b>的 {{ sentContentMessages.length }} 則{{ sentContentModuleName ? `（機器人模組「${sentContentModuleName}」）` : '' }}：
          </p>
          <p v-if="sentContentVarNote" class="aap__note aap__note--warn">{{ sentContentVarNote }}</p>
          <FlowMessagePreview :messages="sentContentPreview.value" :oa-name="currentWorkspaceName" />
        </div>

        <!-- ② 觸發機器人模組：去把那個模組真的抓回來畫 -->
        <AdminActionPreview
          v-else-if="previewModuleId"
          class="bc-preview bc-preview--panel"
          :action="{ type: 'module', moduleId: previewModuleId, text: '', uri: '' }"
          :module-options="flowOptions"
          title=""
          broadcast
        >
          <template #ready-note="{ count }">
            <!-- ⛔ 這句只有推播講得出來：別處是客人按了才收到，推播是直接送到手機上 -->
            <p v-if="isReadOnly" class="aap__note aap__note--warn">
              這則推播<b>沒有留存當時送出去的內容</b>（2026-09-24 之前送出的都沒有），
              上面畫的是那個模組<b>現在</b>的樣子，中間可能已經被改過。
            </p>
            <p v-else class="aap__note aap__note--quiet">
              客人會<b>直接收到這 {{ count }} 則</b>，不需要點任何按鈕。
            </p>
          </template>
        </AdminActionPreview>

        <!-- ③ 純文字／開啟網址：送出端不會動它，原樣畫 -->
        <!-- `D-118`：用了名字變數時要多講一句，改用跟①同一種面板（手機上面一句、下面手機）；
             ⛔ 句子直接接在手機旁邊會變成預覽區的第二欄，把手機擠到中間 -->
        <div v-else-if="textPreviewVarNote" class="bc-preview bc-preview--panel">
          <p class="aap__note aap__note--warn">{{ textPreviewVarNote }}</p>
          <FlowMessagePreview :messages="textPreview.value" :oa-name="currentWorkspaceName" />
        </div>
        <FlowMessagePreview
          v-else
          class="bc-preview"
          :messages="textPreview.value"
          :oa-name="currentWorkspaceName"
        />
      </template>
      </div>
    </template>
  </AdminSplitLayout>

  <!--
    `C-248`：試發一則給自己看。
    ⛔ 三件事一定要寫在這個框裡（都是人在按下去前會想知道、按下去後才知道就太遲的）：
    ①真的會送到 ②跟正式發送內容一樣 ③不會影響任何帳。
  -->
  <!--
    `D-119` ⑥（2026-10-09 老闆「照改」）：收件人改成一份固定名單打勾，⛔ 不再在九千多位好友裡搜名字
    （叫 Alice 的有 5 位，挑錯就是把還沒定稿的內容發給客人）。也 ⛔ 不只限自己：正式庫裡被拿來試打的
    推播，36 人次有 29 次是發給不在後台的看稿同事，4 則一次發 3–5 人。
  -->
  <el-dialog v-model="testSendVisible" class="bc-dialog-testsend" title="試發一則給自己看" width="min(480px, 92vw)">
    <div class="admin-field-stack">
      <div class="admin-field-group">
        <AdminFieldLabel text="要發給誰（可以勾好幾位）" tight />
        <div v-if="testListLoading" class="tags-loading">
          <div class="spinner" />
          <span>載入中…</span>
        </div>
        <p v-else-if="testListError" class="bc-dialog-footer__error">{{ testListError }}</p>
        <template v-else-if="testList">
          <!-- 自己還沒把手機加進來：就地加（加一次，之後直接勾自己） -->
          <div v-if="!testList.self && testList.selfIsMember" class="bc-testsend-bind">
            <template v-if="!testBinding">
              <p class="bc-testsend-bind__text">你的手機還沒加進來。加一次，之後試發直接勾自己就好。</p>
              <el-button size="small" type="primary" plain @click="testBinding = true">把我的手機加進來</el-button>
              <!-- ⚠️ 綁好＝也加進通知名單（`D-103` 的規則）：先講，不要讓他之後被通知嚇到 -->
              <p class="text-xs text-muted">加進來之後也會收到「客人要找真人」的通知，不想收可以到「設定 → LINE 通知」關掉。</p>
            </template>
            <AdminLineNotifySelfAdd v-else @done="onTestSelfBound" @cancel="testBinding = false" />
          </div>

          <el-checkbox-group v-model="testSendIds" class="bc-testsend-list">
            <div v-if="testList.self" class="bc-testsend-group">
              <p class="bc-testsend-group__title">你自己</p>
              <el-checkbox :value="testList.self.lineUserId" class="bc-testsend-row">
                <span class="bc-testsend-who">
                  <img v-if="testList.self.pictureUrl" :src="testList.self.pictureUrl" class="bc-testsend-avatar" alt="">
                  <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(testList.self.displayName) }}</span>
                  {{ testList.self.displayName || '你的手機' }}
                </span>
              </el-checkbox>
            </div>

            <div v-if="testList.members.length" class="bc-testsend-group">
              <p class="bc-testsend-group__title">同事</p>
              <el-checkbox v-for="m in testList.members" :key="m.lineUserId" :value="m.lineUserId" class="bc-testsend-row">
                <span class="bc-testsend-who">
                  <img v-if="m.pictureUrl" :src="m.pictureUrl" class="bc-testsend-avatar" alt="">
                  <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(m.displayName) }}</span>
                  {{ m.displayName || m.email }}
                  <span v-if="m.email && m.displayName" class="bc-testsend-sub">{{ m.email }}</span>
                </span>
              </el-checkbox>
            </div>

            <div class="bc-testsend-group">
              <p class="bc-testsend-group__title">常找來看稿的人</p>
              <div v-for="s in testList.saved" :key="s.lineUserId" class="bc-testsend-saved">
                <!-- 封鎖了／不是好友了：照樣列出來（⛔ 不安靜地拿掉），不給勾、講原因 -->
                <el-checkbox :value="s.lineUserId" :disabled="Boolean(s.unreachable)" class="bc-testsend-row">
                  <span class="bc-testsend-who">
                    <img v-if="s.pictureUrl" :src="s.pictureUrl" class="bc-testsend-avatar" alt="">
                    <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(s.displayName) }}</span>
                    {{ s.displayName || '（沒有名字）' }}
                    <span v-if="s.unreachable" class="bc-testsend-sub">{{ s.unreachable === 'blocked' ? '封鎖了官方帳號，收不到' : '已經不是好友，收不到' }}</span>
                  </span>
                </el-checkbox>
                <el-button v-if="can('broadcast.testList')" text size="small" class="bc-testsend-remove" @click="removeTestRecipient(s)">拿掉</el-button>
              </div>
              <p v-if="!testList.saved.length" class="text-xs text-muted">
                還沒有。主管、要看稿的同事不在後台的話，<template v-if="can('broadcast.testList')">從下面加一次就一直在。</template><template v-else>請管理員在這裡加一次。</template>
              </p>
            </div>
          </el-checkbox-group>

          <!-- 加人：管理員才看得到（`broadcast.testList`）。這是唯一還要在全部好友裡找名字的地方，所以秀頭像與加好友日期分同名 -->
          <el-select
            v-if="can('broadcast.testList')"
            v-model="testAddPick"
            filterable
            remote
            :remote-method="searchTestFriends"
            :loading="testFriendsLoading"
            :loading-text="'找好友中…'"
            :no-data-text="'打名字找好友'"
            placeholder="＋ 加一位常找來看稿的人（打名字找好友）"
            class="bc-testsend-add"
            @change="addTestRecipient"
          >
            <el-option v-for="u in testFriends" :key="u.lineUserId" :label="u.displayName || u.lineUserId" :value="u.lineUserId">
              <span class="bc-testsend-who">
                <img v-if="u.pictureUrl" :src="u.pictureUrl" class="bc-testsend-avatar" alt="">
                <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(u.displayName) }}</span>
                {{ u.displayName || u.lineUserId }}
                <span v-if="u.joined" class="bc-testsend-sub">{{ u.joined }} 加好友</span>
              </span>
            </el-option>
          </el-select>
        </template>
      </div>

      <p class="tags-hint">
        送出的內容跟正式發送<b>完全一樣</b>（選了機器人模組的話，送的就是模組裡那幾則）。
        ⛔ 但試發<b>不帶點擊追蹤</b>，所以他點了連結不會算進這則推播的成效。
      </p>
      <p v-if="hasUnsavedChanges || isCreating" class="tags-hint">
        有還沒儲存的變更——按下去會<b>先幫你存成草稿</b>，再用存好的那一份試發（才不會試到舊內容）。
      </p>

      <div v-if="testSendDone" class="bc-testsend-done">
        每人送了 {{ testSendDone.messageCount }} 則給
        <b>{{ testSendOkNames }}</b>{{ testSendDone.moduleName ? `（機器人模組「${testSendDone.moduleName}」的內容）` : '' }}。
        去手機上看一眼，沒問題再回來發。
        <!-- ⛔ 有人沒送到要講出是誰、為什麼（一位失敗不可以被「已送出」蓋過去） -->
        <p v-for="s in testSendFailed" :key="s.lineUserId" class="bc-testsend-failed">
          沒送到「{{ s.displayName || s.lineUserId }}」：{{ s.error }}
        </p>
      </div>
      <p v-if="testSendError" class="bc-dialog-footer__error">{{ testSendError }}</p>
    </div>
    <template #footer>
      <div class="bc-dialog-footer__actions">
        <el-button @click="testSendVisible = false">關閉</el-button>
        <el-button type="primary" :loading="testSending" @click="submitTestSend">送出試發</el-button>
      </div>
    </template>
  </el-dialog>

  <!-- 驗證 / 發送確認 Dialog -->
  <el-dialog v-model="validateDialogVisible" class="bc-dialog-validate" :title="validateDialogTitle" width="min(440px, 92vw)">
    <div v-if="validateLoading" class="bc-validate-loading">
      <div class="spinner" />
      <span>分析受眾中…</span>
    </div>
    <div v-else-if="validateResult" class="admin-field-stack">
      <div v-if="validateResult.errors?.length" class="admin-alert admin-alert--warn">
        <ul>
          <li v-for="e in validateResult.errors" :key="e">{{ e }}</li>
        </ul>
      </div>
      <div v-else class="bc-validate-ok">
        <!-- `D-118`：擋不擋由他決定（不擋），但按下去之前一定要知道名字那格會是空白 -->
        <div v-if="validateResult.warnings?.length" class="admin-alert admin-alert--warn">
          <ul>
            <li v-for="w in validateResult.warnings" :key="w">{{ w }}</li>
          </ul>
        </div>
        <p v-if="dialogIsSchedule && pendingScheduleAtLocal" class="tags-hint">
          將排程於 {{ formatScheduleLabel(pendingScheduleAtLocal) }} 自動發送（不會立即送出）。
        </p>
        <div class="bc-stats-row">
          <div class="bc-stat-box">
            <div class="bc-stat-label">預估發送人數</div>
            <div class="bc-stat-value">{{ validateResult.estimatedCount }}</div>
          </div>
        </div>
        <div v-if="validateResult.previewUserIds?.length" class="bc-preview-ids">
          <AdminFieldLabel text="名單預覽（前幾筆）" tight />
          <ul class="bc-preview-list">
            <li v-for="uid in validateResult.previewUserIds" :key="uid" class="td-code">{{ uid }}</li>
          </ul>
        </div>
      </div>
    </div>
    <template #footer>
      <div class="bc-dialog-footer">
        <p v-if="confirmDialogError" class="bc-dialog-footer__error">{{ confirmDialogError }}</p>
        <div class="bc-dialog-footer__actions">
          <el-button @click="closeValidateDialog">取消</el-button>
          <el-button
            v-if="validateResult && !validateResult.errors?.length"
            type="primary"
            :loading="sending"
            @click="onConfirmDialogSubmit"
          >
            {{ confirmSubmitLabel }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { CopyDocument, Plus, Promotion } from '@element-plus/icons-vue'
import { confirmSaveBeforeCopy } from '~/utils/confirm-save-before-copy'
import { ElMessageBox } from 'element-plus'
import type { UnifiedAction } from '~~/shared/action-schema'
import { normalizeUnifiedAction, validateUnifiedAction } from '~~/shared/action-schema'
import {
  extractBroadcastTriggerModuleId,
  lineMessagesToPreviewMessages,
  parseLineMessagesToUnifiedAction,
  unifiedActionToLineMessages,
} from '~~/shared/broadcast-content'
import {
  BROADCAST_AUDIENCE_HANDOFF_KEY,
  handoffNoticeText,
  isFreshHandoff,
  parseHandoff,
} from '~~/shared/broadcast-audience-handoff'
import {
  BROADCAST_DRAFT_HANDOFF_KEY,
  DRAFT_HANDOFF_MISSING_TEXT,
  draftHandoffNoticeText,
  isFreshDraftHandoff,
  parseDraftHandoff,
} from '~~/shared/broadcast-draft-handoff'
import {
  localDateTimeInputToUtcIso,
  validateFutureScheduleLocalInput,
} from '~~/shared/broadcast-schedule-time'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import { broadcastVariableNote, renderBroadcastVariablesDeep } from '~~/shared/preview-variables'
import { taipeiDate } from '~~/shared/time'
import { festivalHint } from '~/utils/festival-hint'

definePageMeta({ middleware: 'auth', layout: 'default' })

/** 節慶行銷提醒（窗外回 null＝整條不渲染）。判定與文案見 utils/festival-hint.ts */
const festival = festivalHint(taipeiDate())

/** 排程：不可選今天以前的日期 */
function disabledPastDate(d: Date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d < today
}

function formatDateForPicker(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatScheduleLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-TW')
}

function scheduleAtForApi(localValue?: string): string | null {
  const raw = String(localValue ?? form.value.scheduleAt ?? '').trim()
  return localDateTimeInputToUtcIso(raw)
}

function apiErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    const data = o.data as Record<string, unknown> | undefined
    if (typeof data?.statusMessage === 'string') return data.statusMessage
    if (typeof o.statusMessage === 'string') return o.statusMessage
    if (typeof o.message === 'string') return o.message
  }
  return fallback
}

function isNotFoundApiError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return o.statusCode === 404 || o.status === 404
}

const { workspaceId, apiFetch, currentWorkspaceName } = useWorkspace()
// `G-109`：草稿（新增／儲存／試發）＝`broadcast.write`；真的送出去（發送／排程／取消／重發／到期處理）＝`broadcast.send`
const { can, assertCan } = useAdminOperateGuard()

// ── 狀態 ────────────────────────────────────────────────────────────
const flows = ref<{
  id: string
  name: string
  isActive?: boolean
  messageCount?: number
  /** `C-238`：有幾顆「開了貼標的網址按鈕」——推播送出時那個貼標不會生效，要講出來 */
  taggedUriButtons?: number
}[]>([])
const { tags: allTags, loadTags: loadTagOptions } = useAdminTagList()
// C-208：這一頁不給就地建標籤（受眾是拿標籤篩人），但別頁建了之後切回來要看得到
useAdminTagRefresh().onAdminTagListChanged(() => loadTagOptions({ status: 'active' }))
const { openFromQueryId } = useAdminDeepLink()
/**
 * `D-86`：別處就地建了模組，這一頁的下拉要跟著看得到（否則人會以為沒建成功）。
 * ⛔ 只重抓模組那一份，不要叫 `loadData()`：那會連推播清單一起重抓，
 *    而使用者此刻多半正在編一則還沒存的推播。
 */
useAdminFlowRefresh().onAdminFlowListChanged(async () => {
  const list = await apiFetch<any[]>('/api/flow/list?fields=picker').catch(() => null)
  // ⛔ 抓失敗就維持原本那份：清空會讓已經選好的模組變成「（已刪除的模組）」，嚇到人
  if (!list) return
  flows.value = list.map((f: any) => ({
    id: f.id,
    name: f.name || f.id,
    isActive: f.isActive,
    messageCount: f.messageCount,
    taggedUriButtons: f.taggedUriButtons,
  }))
})
// 「只看草稿」篩選（D-43④）：list 端點本來就吃 ?status=，這裡只是把它接到畫面上
const draftFilterOn = ref(false)
const {
  items: broadcasts,
  loading,
  loadingMore,
  listEl,
  load: loadBroadcasts,
  onScroll: onSidebarListScroll,
  loadUntilFound: findBroadcastUntilFound,
} = useWorkspaceSidebarList<any>('/api/broadcast/list', () =>
  draftFilterOn.value ? { status: 'draft' } : {})

// 草稿總數：null＝還沒查到或查失敗（整行不顯示，⛔不拿 0 冒充「沒有草稿」）。
// 掛在 loading 的 true→false 邊緣刷新：清單每次重載（發送/刪除/新增後）數字跟著對。
const draftTotal = ref<number | null>(null)
async function loadDraftTotal() {
  try {
    const res = await apiFetch<{ total?: number }>('/api/broadcast/list', {
      params: { status: 'draft', page: 1, limit: 1 },
    })
    draftTotal.value = typeof res?.total === 'number' ? res.total : null
  }
  catch {
    draftTotal.value = null
  }
}
watch(loading, (now, was) => { if (was && !now) void loadDraftTotal() })
function toggleDraftFilter() {
  draftFilterOn.value = !draftFilterOn.value
  void loadBroadcasts()
}
const saving = ref(false)
const duplicating = ref(false)
const validating = ref(false)
const sending = ref(false)
const retrying = ref(false)
const selectedId = ref<string | null>(null)
const isCreating = ref(false)
const validateDialogVisible = ref(false)
const validateLoading = ref(false)
const validateResult = ref<any>(null)
/** 開啟驗證視窗當下鎖定的送出意圖（避免對話框開啟後切換 radio 誤觸立即發送） */
const pendingSubmitMode = ref<'now' | 'schedule'>('now')
/** 開啟驗證視窗時鎖定的排程時間（避免 saveDraft 重載表單後 scheduleAt 被清空） */
const pendingScheduleAtLocal = ref('')
const pendingBroadcastId = ref<string | null>(null)
const confirmDialogError = ref('')
const report = ref<any>(null)
const { showToast } = useAdminToast()

const defaultForm = () => ({
  name: '',
  audienceType: 'all' as 'all' | 'tags' | 'import',
  tagIds: [] as string[],
  importText: '',
  contentAction: normalizeUnifiedAction({ type: 'message', text: '' }, 'A') as UnifiedAction,
  scheduleMode: 'now' as 'now' | 'schedule',
  scheduleAt: '',
  /** `C-213`：發完幫收到的人貼的記號（選填） */
  completionTagIds: [] as string[],
  /**
   * `C-240`：這則是為了哪一檔節慶發的。只有從行銷月曆「為這一檔擬推播」進來才有值。
   * ⛔ 畫面上不給編輯：它是「這則推播的來歷」，不是使用者要填的東西。
   *   有了它，檔期回顧才敢講「這一檔的成績」而不是「那段期間你發過什麼」。
   */
  festivalId: '',
})
const form = ref(defaultForm())
const { markClean, confirmLeaveIfDirty, hasUnsavedChanges } = useUnsavedChanges({
  // `G-107`：觀察者存不了，就沒有「未儲存的變更」——以前他動過一格，離開就被問「確定要放棄嗎」
  getSnapshot: () => (can('broadcast.write') ? form.value : null),
})

// `D-86`：`isActive` / `messageCount` 要一路帶到下拉，它才標得出「還沒有內容／已停用」
const flowOptions = computed(() =>
  (flows.value ?? []).map((f) => ({
    id: f.id,
    name: f.name || f.id,
    isActive: f.isActive,
    messageCount: f.messageCount,
    taggedUriButtons: f.taggedUriButtons,
  })),
)

function onContentActionUpdate(next: Record<string, unknown>) {
  form.value.contentAction = normalizeUnifiedAction(next, 'A') as UnifiedAction
}

// ── 計算屬性 ─────────────────────────────────────────────────────────
const selectedItem = computed(() => broadcasts.value.find((b) => b.id === selectedId.value) ?? null)

const isReadOnly = computed(() => {
  if (isCreating.value) return false
  const s = selectedItem.value?.status
  return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'processing'
})

/**
 * 欄位要不要鎖（`G-107`）：已經發出去的（`isReadOnly`）**或是這個人存不了**（觀察者）。
 * ⛔ 跟 `isReadOnly` 分開：那一個講的是「這則推播的狀態」（決定要不要顯示報表、
 *    「沒有留存當時的內容」那句話），觀察者看一則草稿時那些話都不成立。
 */
const isLocked = computed(() => isReadOnly.value || !can('broadcast.write'))

const importUserIds = computed(() =>
  form.value.importText.split('\n').map((l) => l.trim()).filter(Boolean),
)

/**
 * 失敗原因只認列表那份資料（列表 API 就有 failureReason，而且背景刷新會一直更新）。
 * ⛔刻意不另外存一份詳情：詳情請求失敗時舊值會留著，變成 A 的「可以放心重發」
 * 掛在 B 的標題下，而按鈕動到的是 B（2026-08-13 code review 抓到）。
 */
const failedReason = computed(() =>
  selectedItem.value?.status === 'failed' ? String(selectedItem.value?.failureReason || '') : '',
)

const isScheduleSubmit = computed(() => form.value.scheduleMode === 'schedule')
const dialogIsSchedule = computed(() =>
  validateDialogVisible.value ? pendingSubmitMode.value === 'schedule' : isScheduleSubmit.value,
)
const validateDialogTitle = computed(() => (dialogIsSchedule.value ? '排程前確認' : '發送前確認'))
const confirmSubmitLabel = computed(() => (dialogIsSchedule.value ? '確認排程' : '確認發送'))
const headerSubmitLabel = computed(() => (isScheduleSubmit.value ? '驗證並排程' : '驗證並發送'))

// ── 工具函式 ─────────────────────────────────────────────────────────
function statusLabel(s: string) {
  const map: Record<string, string> = {
    draft: '草稿',
    scheduled: '已排程',
    processing: '發送中',
    completed: '已完成',
    failed: '失敗',
    cancelled: '已取消',
  }
  return map[s] ?? s
}

// 狀態膠囊色調：失敗要跳出來（error）、發送中提示（warning）、完成/排程正向（success）、其餘中性
function broadcastTone(s: string): 'success' | 'neutral' | 'warning' | 'error' {
  if (s === 'completed' || s === 'scheduled') return 'success'
  if (s === 'failed') return 'error'
  if (s === 'processing') return 'warning'
  return 'neutral'
}

function formatNullableStat(n: number | null | undefined): string {
  if (n == null) return '—'
  return String(n)
}

function formatPercentRate(rate: number | null | undefined): string {
  if (rate == null) return '—'
  return `${(rate * 100).toFixed(2)}%`
}

function bcMetaText(bc: any): string {
  const parts: string[] = []
  if (bc.audienceSnapshot?.estimatedCount) parts.push(`${bc.audienceSnapshot.estimatedCount} 人`)
  if (bc.scheduleAt) {
    const d = parseFirestoreDate(bc.scheduleAt)
    if (d) parts.push(d.toLocaleString('zh-TW'))
  }
  return parts.join(' · ')
}

function buildAudienceSource() {
  if (form.value.audienceType === 'all') return { type: 'all' }
  if (form.value.audienceType === 'tags') return { type: 'tags', tagIds: form.value.tagIds }
  return { type: 'import', importedUserIds: importUserIds.value }
}

function buildMessages(): Record<string, unknown>[] {
  return unifiedActionToLineMessages(form.value.contentAction)
}

/**
 * `C-229`：右側預覽吃的內容（**純文字／開啟網址**這兩條路）。
 * ⭐ 走的是 `buildMessages()`——這兩型送出端不會動它，所以畫出來的就是客人收到的。
 * ⛔ 不要改成照 `form.contentAction` 另外拼一份給預覽看：那樣系統套進去的預設文案
 * （「點下面的按鈕看看」那句）就不會出現在預覽裡，等於換個地方繼續騙人。
 */
const previewMessages = computed(() => lineMessagesToPreviewMessages(buildMessages()))

/**
 * `C-245`：這一則會不會在送出當下被整份換成某個模組的內容。
 * ⭐ **用送出端同一支函式判斷**（`extractBroadcastTriggerModuleId`），不是看
 * `form.contentAction.type`——後者是「店家選了什麼」，前者才是「送出去會發生什麼」。
 * 兩者現在一致，但只要送出端哪天多一個條件，照表單判斷的那邊就會再次默默對不上。
 */
const previewModuleId = computed(() => extractBroadcastTriggerModuleId(buildMessages()))

/**
 * `C-246`：已送出的推播回頭看時，畫的是**當時真的送出去的那一份**（送出端存下來的）。
 * ⚠️ 2026-09-24 之前送出的推播沒有這份資料，`sentContentMessages` 會是空陣列——
 * 那時走模組那條路畫「現在的內容」，⛔ 但畫面上一定要講「這不是當時的」。
 */
/**
 * ⚠️ 這一份**只從詳情 API 來，不從列表來**：留存的內容含圖文訊息的整份設定，
 * 一則就好幾 KB。跟著列表一起回，等於每次開頁、每次背景刷新都把幾十則的內容全部搬一次
 * （`docs/ADMIN-PERF-AUDIT-20260827.md` 已經為了同樣的事瘦過一次身）。
 */
const detailSentContent = ref<Record<string, any> | null>(null)
const sentContent = computed(() => detailSentContent.value)
const sentContentMessages = computed<any[]>(() => {
  const msgs = sentContent.value?.messages
  return Array.isArray(msgs) ? msgs : []
})
const sentContentModuleName = computed(() => String(sentContent.value?.moduleName ?? ''))

/**
 * `D-118`：推播是一次送給所有人，送出端拿不到客人資料，`{{displayName}}` 一律送成空白。
 * 三條預覽路都要畫成客人實際看到的樣子（空白）並講出來——⛔ 原本純文字／已送出那兩條原字印出
 * `{{displayName}}`、模組那條畫成「王小明」，三條都不是客人收到的樣子。
 */
const sentContentPreview = computed(() => renderBroadcastVariablesDeep(sentContentMessages.value))
const sentContentVarNote = computed(() => broadcastVariableNote(sentContentPreview.value.keys))
const textPreview = computed(() => renderBroadcastVariablesDeep(previewMessages.value))
const textPreviewVarNote = computed(() => broadcastVariableNote(textPreview.value.keys))

// ── `C-248`：試發一則給自己看（`D-119` ⑥：收件人改成固定名單打勾）──────────────────
interface TestRecipient { lineUserId: string; displayName: string; pictureUrl: string; email?: string; unreachable?: 'blocked' | 'gone' }
interface TestRecipientList { selfIsMember: boolean; self: TestRecipient | null; members: TestRecipient[]; saved: TestRecipient[] }
interface TestSendResult { lineUserId: string; displayName: string; ok: boolean; error?: string }

const testSendVisible = ref(false)
const testSending = ref(false)
const testSendError = ref('')
const testSendDone = ref<{ messageCount: number; moduleName: string; sent: TestSendResult[] } | null>(null)
const testSendOkNames = computed(() =>
  (testSendDone.value?.sent ?? []).filter(s => s.ok).map(s => s.displayName || s.lineUserId).join('、'))
const testSendFailed = computed(() => (testSendDone.value?.sent ?? []).filter(s => !s.ok))

const testList = ref<TestRecipientList | null>(null)
const testListLoading = ref(false)
const testListError = ref('')
/** 勾了誰 */
const testSendIds = ref<string[]>([])
/** 正在就地把自己的手機加進來（掃 QR） */
const testBinding = ref(false)
/** 「加一位常找來看稿的人」選單 */
const testAddPick = ref('')
const testFriends = ref<Array<{ lineUserId: string; displayName: string; pictureUrl: string; joined: string }>>([])
const testFriendsLoading = ref(false)

/**
 * 記住上次勾了誰（`D-119` 起是一組人，鍵換新的：舊鍵存的是單一 ID，⛔ 不沿用）。
 * ⚠️ 讀回來要先跟名單交集：上次勾的人可能被拿掉了，⛔ 不可以帶著名單外的人送出去（伺服器也會擋）。
 */
const TEST_SEND_LS_KEY = computed(() => `bc-test-send-to-v2:${workspaceId.value}`)

function initialOf(name: string) {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

/** 名單上勾得了的人（封鎖了、不是好友了的不算） */
function sendableIds(list: TestRecipientList): string[] {
  return [
    ...(list.self ? [list.self.lineUserId] : []),
    ...list.members.map(m => m.lineUserId),
    ...list.saved.filter(s => !s.unreachable).map(s => s.lineUserId),
  ]
}

async function loadTestList(opts: { keepPicked?: boolean } = {}) {
  testListLoading.value = !testList.value
  testListError.value = ''
  try {
    const list = await apiFetch<TestRecipientList>('/api/broadcast/test-recipients')
    testList.value = list
    const ok = new Set(sendableIds(list))
    if (opts.keepPicked) {
      testSendIds.value = testSendIds.value.filter(id => ok.has(id))
      return
    }
    let remembered: string[] = []
    try { remembered = JSON.parse(localStorage.getItem(TEST_SEND_LS_KEY.value) || '[]') }
    catch { /* 無痕視窗讀不到就算了，只是少一個方便 */ }
    const picked = (Array.isArray(remembered) ? remembered : []).map(String).filter(id => ok.has(id))
    // 沒記到就預設勾自己（按鈕寫的就是「給自己看」）
    testSendIds.value = picked.length ? picked : (list.self ? [list.self.lineUserId] : [])
  }
  catch (e: any) {
    testListError.value = e?.data?.statusMessage || '讀不到試發名單，請關掉再打開一次'
  }
  finally {
    testListLoading.value = false
  }
}

/** 就地把自己的手機加進來之後：重抓名單、把自己勾起來 */
async function onTestSelfBound() {
  testBinding.value = false
  await loadTestList({ keepPicked: true })
  const self = testList.value?.self
  if (self && !testSendIds.value.includes(self.lineUserId)) testSendIds.value = [self.lineUserId, ...testSendIds.value]
}

/** 加人用的找好友（只有管理員看得到那個選單）：打了字才找，⛔ 不先把全部好友列出來 */
async function searchTestFriends(keyword?: string) {
  const kw = String(keyword || '').trim()
  if (!kw) { testFriends.value = []; return }
  testFriendsLoading.value = true
  try {
    const params = new URLSearchParams({ limit: '20', search: kw })
    const res = await apiFetch<{ users?: Array<{ lineUserId?: string; displayName?: string; pictureUrl?: string; createdAt?: unknown }> }>(`/api/users/list?${params.toString()}`)
    const listed = new Set(testList.value ? [
      ...(testList.value.self ? [testList.value.self.lineUserId] : []),
      ...testList.value.members.map(m => m.lineUserId),
      ...testList.value.saved.map(s => s.lineUserId),
    ] : [])
    testFriends.value = (res?.users ?? [])
      .map((u) => {
        const d = parseFirestoreDate(u.createdAt)
        return {
          lineUserId: String(u.lineUserId || ''),
          displayName: String(u.displayName || ''),
          pictureUrl: String(u.pictureUrl || ''),
          // 同名的人靠「哪天加好友」分（叫 Alice 的有 5 位）
          joined: d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : '',
        }
      })
      .filter(u => u.lineUserId && !listed.has(u.lineUserId))
  }
  catch {
    testFriends.value = []
  }
  finally {
    testFriendsLoading.value = false
  }
}

async function addTestRecipient(lineUserId: string) {
  testAddPick.value = ''
  if (!lineUserId) return
  try {
    const res = await apiFetch<{ displayName: string }>('/api/broadcast/test-recipients', { method: 'POST', body: { lineUserId } })
    await loadTestList({ keepPicked: true })
    // 剛加的那位通常就是這次要發的人：直接勾起來
    if (!testSendIds.value.includes(lineUserId)) testSendIds.value = [...testSendIds.value, lineUserId]
    showToast(`已把「${res.displayName || '這位'}」加進常找來看稿的人`, 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '加不進去，請再試一次', 'error')
  }
}

async function removeTestRecipient(s: TestRecipient) {
  try {
    await apiFetch(`/api/broadcast/test-recipients/${encodeURIComponent(s.lineUserId)}`, { method: 'DELETE' })
    await loadTestList({ keepPicked: true })
    showToast(`已從常找來看稿的人拿掉「${s.displayName || '這位'}」`, 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '拿不掉，請再試一次', 'error')
  }
}

function openTestSend() {
  if (!assertCan('broadcast.write')) return
  testSendError.value = ''
  testSendDone.value = null
  testBinding.value = false
  testSendVisible.value = true
  void loadTestList()
}

async function submitTestSend() {
  const to = [...testSendIds.value]
  testSendError.value = ''
  testSendDone.value = null
  if (!to.length) {
    testSendError.value = testList.value?.self || testList.value?.members.length || testList.value?.saved.length
      ? '請至少勾一位'
      : '名單上還沒有人：先把你的手機加進來，或請管理員加常找來看稿的人'
    return
  }
  testSending.value = true
  try {
    /*
     * ⛔ **一定要先存**：試發端點送的是**存在資料庫裡的那一份**。
     * 不先存的話，改了內容卻試到舊的——那正是這一輪在修的那種謊。
     */
    if (isCreating.value || hasUnsavedChanges.value) {
      const saved = await saveDraft()
      if (!saved) {
        testSendError.value = '草稿沒有存成功，所以沒有試發（不然試到的會是舊內容）'
        return
      }
    }
    if (!selectedId.value) {
      testSendError.value = '找不到這則推播，請重新整理再試'
      return
    }
    const res = await apiFetch<{ messageCount: number; moduleName: string; sent: TestSendResult[] }>(
      `/api/broadcast/${selectedId.value}/test-send`,
      { method: 'POST', body: { lineUserIds: to } },
    )
    testSendDone.value = res
    try { localStorage.setItem(TEST_SEND_LS_KEY.value, JSON.stringify(to)) }
    catch { /* 存不進去只是下次要重勾 */ }
  }
  catch (e: any) {
    testSendError.value = e?.data?.statusMessage || '試發失敗，請稍後再試'
  }
  finally {
    testSending.value = false
  }
}

/**
 * 預覽預設打開（與機器人模組頁一致）。
 * ⛔ 不要預設收起來：推播是唯一「按下去就送給全部好友、收不回來」的功能，
 * 最需要看到它的人，正是還沒想到要去按「顯示預覽」的那個人。
 */
const previewOpen = ref(true)

function loadFormFromItem(item: any) {
  const src = item.audienceSource ?? {}
  /*
   * `C-246`：把「當時真的送出去的那一份」收下來（只有詳情 API 有）。
   * ⛔ 一定要**每次都覆寫**（沒有就設成 null）：不覆寫的話，看完一則有留存的推播、
   * 再點一則沒留存的，右邊會繼續畫上一則的內容——而人完全不會知道那是舊的。
   */
  detailSentContent.value = item.sentContent ?? null
  form.value = {
    name: item.name ?? '',
    audienceType: src.type ?? 'all',
    tagIds: src.tagIds ?? [],
    importText: (src.importedUserIds ?? []).join('\n'),
    contentAction: parseLineMessagesToUnifiedAction(item.messages ?? []) as UnifiedAction,
    scheduleMode: item.status === 'scheduled' || item.scheduleAt ? 'schedule' : 'now',
    scheduleAt: item.scheduleAt
      ? formatDateForPicker(parseFirestoreDate(item.scheduleAt) ?? new Date())
      : '',
    completionTagIds: Array.isArray(item.completionTagIds) ? item.completionTagIds : [],
    // 編輯既有推播時要保留來歷，⛔ 存一次檔就把它洗掉的話，回顧會突然對不起來
    festivalId: String((item as { festivalId?: string }).festivalId ?? ''),
  }
}

/** 列表 API 不含 messages，編輯／檢視必須另拉詳情 */
async function fetchBroadcastDetail(id: string): Promise<any | null> {
  try {
    return await apiFetch(`/api/broadcast/${id}`)
  }
  catch {
    return null
  }
}

async function loadFormFromId(id: string): Promise<boolean> {
  const full = await fetchBroadcastDetail(id)
  if (!full) return false
  loadFormFromItem(full)
  markClean()
  return true
}

function validateForm(options?: { requireScheduleTime?: boolean }): string | null {
  if (!form.value.name.trim()) return '請填寫推播名稱'
  if (form.value.audienceType === 'tags' && !form.value.tagIds.length) return '請至少選擇一個標籤'
  if (form.value.audienceType === 'import' && !importUserIds.value.length) return '請輸入至少一個 LINE User ID'
  const actionErr = validateUnifiedAction(form.value.contentAction)
  if (actionErr) return actionErr
  const msgs = buildMessages()
  if (!msgs.length) return '請設定訊息內容'
  const needScheduleTime = options?.requireScheduleTime ?? false
  if (needScheduleTime) {
    const scheduleErr = validateFutureScheduleLocalInput(form.value.scheduleAt)
    if (scheduleErr) return scheduleErr
  }
  return null
}

/**
 * `C-213`：發完貼記號的結果講成一句話。
 * ⛔ 全部成功時**不出現**（每則推播都掛一句「記號都貼好了」是純噪音）；
 * ⛔ 有失敗時一定要出現，而且要講清楚後果。
 */
const completionTagNote = computed(() => {
  const outcome = (selectedItem.value as any)?.completionTagOutcome
  if (!outcome) return ''
  const failed = Number(outcome.failedCount ?? 0)
  if (!failed) return ''
  const tagged = Number(outcome.taggedCount ?? 0)
  return `⚠️ 訊息都送出去了，但發完的記號有 ${failed} 位沒貼成功（成功 ${tagged} 位）。`
    + '之後如果用這個記號挑名單，那幾位不會被挑到——需要的話到「好友」頁手動補貼。'
})

function buildSaveBody(): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.value.name.trim(),
    audienceSource: buildAudienceSource(),
    messages: buildMessages(),
    completionTagIds: form.value.completionTagIds,
    // ⛔ 空的就不要送：後端只在有值時才寫這個欄位
    ...(form.value.festivalId ? { festivalId: form.value.festivalId } : {}),
  }
  const keepScheduled =
    !isCreating.value
    && selectedItem.value?.status === 'scheduled'
    && form.value.scheduleMode === 'schedule'
    && form.value.scheduleAt

  if (keepScheduled) {
    const iso = scheduleAtForApi()
    if (iso) body.scheduleAt = iso
  }
  else if (!isCreating.value) {
    body.scheduleAt = null
  }
  return body
}

// ── API 操作 ─────────────────────────────────────────────────────────
async function loadData() {
  try {
    const [_, tagOk, flowList] = await Promise.all([
      loadBroadcasts(true),
      loadTagOptions({ status: 'active' }),
      // 只取選單要的欄位：整份模組清單是 133 KB（含每則訊息內容），這裡只用到名稱與編號
      apiFetch<any[]>('/api/flow/list?fields=picker').catch(() => []),
    ])
    flows.value = (flowList ?? []).map((f: any) => ({
      id: f.id,
      name: f.name || f.id,
      isActive: f.isActive,
      messageCount: f.messageCount,
      taggedUriButtons: f.taggedUriButtons,
    }))
    if (!tagOk) showToast('載入標籤失敗', 'error')
    syncDuePollTimer()
  }
  catch {
    showToast('載入推播失敗', 'error')
  }
}

async function loadReport() {
  if (!selectedId.value) return
  try {
    report.value = await apiFetch(`/api/broadcast/${selectedId.value}/report`)
  }
  catch {
    report.value = null
  }
}

function openCreate() {
  if (!confirmLeaveIfDirty()) return
  isCreating.value = true
  selectedId.value = null
  report.value = null
  detailSentContent.value = null   // ⛔ 新建的當然沒有「當時送出去的內容」
  form.value = defaultForm()
  markClean()
}

async function selectItem(item: any, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = item.id
  report.value = null
  const ok = await loadFormFromId(item.id)
  if (!ok) {
    showToast('載入推播內容失敗', 'error')
    return
  }
  if (['completed', 'failed'].includes(item.status)) {
    loadReport()
  }
}

async function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedId.value) {
    await loadFormFromId(selectedId.value)
    isCreating.value = false
  }
  else {
    isCreating.value = false
    selectedId.value = null
    form.value = defaultForm()
    markClean()
  }
}

async function saveDraft(): Promise<boolean> {
  if (!assertCan('broadcast.write')) return false
  const err = validateForm({
    requireScheduleTime: form.value.scheduleMode === 'schedule',
  })
  if (err) {
    showToast(err, 'error')
    return false
  }
  saving.value = true
  try {
    const body = buildSaveBody()
    if (isCreating.value) {
      const created = await apiFetch<any>('/api/broadcast/create', { method: 'POST', body })
      showToast('草稿已建立', 'success')
      await loadData()
      selectedId.value = created.id
      isCreating.value = false
      if (!(await loadFormFromId(created.id))) showToast('已建立但載入內容失敗，請重新點選該推播', 'error')
    }
    else {
      await apiFetch(`/api/broadcast/${selectedId.value}`, { method: 'PUT', body })
      const savedScheduled = selectedItem.value?.status === 'scheduled' && body.scheduleAt
      showToast(savedScheduled ? '排程已更新' : '草稿已儲存', 'success')
      await loadData()
      if (selectedId.value && !(await loadFormFromId(selectedId.value))) {
        showToast('已儲存但載入內容失敗，請重新點選該推播', 'error')
      }
    }
    return true
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
    return false
  }
  finally {
    saving.value = false
  }
}

// 右上「⋯」選單：目前只有複製
function onHeaderCommand(cmd: string | number | object) {
  if (cmd === 'duplicate') void duplicateBroadcast()
}

/**
 * 把這一則複製成一則新草稿（帶什麼、不帶什麼見 `server/api/broadcast/[id]/duplicate.post.ts`）。
 *
 * ⛔ 跟機器人模組頁不同，**不拿編輯器裡的內容去建**：推播的編輯器只認得一則文字／一張按鈕卡，
 *    舊推播存了好幾則的話從畫面重組會默默只剩第一則。所以由後端照存好的那一份原樣複製，
 *    畫面上有沒存的修改就先問他要不要存——否則複製出來的會是他沒看到的舊版。
 */
async function duplicateBroadcast() {
  if (!assertCan('broadcast.write') || !selectedId.value) return
  if (hasUnsavedChanges.value) {
    if (!(await confirmSaveBeforeCopy())) return
    if (!(await saveDraft())) return
  }
  const sourceId = selectedId.value
  duplicating.value = true
  try {
    const created = await apiFetch<any>(`/api/broadcast/${sourceId}/duplicate`, { method: 'POST' })
    showToast('已複製成一則新草稿', 'success')
    await loadData()
    await selectItem(created, { skipDiscardConfirm: true })
    // 新的排在清單最上面；人可能正捲在下面看一則舊的，捲回去讓他看得到反白的那一列
    await nextTick()
    listEl.value?.querySelector(`[data-agent-target="${created.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '複製失敗', 'error')
  }
  finally {
    duplicating.value = false
  }
}

function closeValidateDialog() {
  validateDialogVisible.value = false
  confirmDialogError.value = ''
}

async function openValidateDialog() {
  // 在任何 async 動作之前先把當下表單狀態完整擷取，避免後續重載覆蓋
  const capturedMode = form.value.scheduleMode as 'now' | 'schedule'
  const capturedScheduleAt = String(form.value.scheduleAt || '').trim()
  const capturedName = form.value.name.trim()
  const capturedAudienceSource = buildAudienceSource()
  const capturedMessages = buildMessages()

  const err = validateForm({ requireScheduleTime: capturedMode === 'schedule' })
  if (err) return showToast(err, 'error')

  // 若是新建中，先建立草稿取得 ID（不帶 scheduleAt，之後由確認排程統一寫入）
  if (isCreating.value) {
    saving.value = true
    try {
      const created = await apiFetch<any>('/api/broadcast/create', {
        method: 'POST',
        body: { name: capturedName, audienceSource: capturedAudienceSource, messages: capturedMessages },
      })
      await loadData()
      selectedId.value = created.id
      isCreating.value = false
      markClean()
    }
    catch (e: any) {
      showToast(e?.data?.statusMessage || '建立推播失敗', 'error')
      return
    }
    finally {
      saving.value = false
    }
  }

  if (!selectedId.value) return

  confirmDialogError.value = ''
  pendingSubmitMode.value = capturedMode
  pendingScheduleAtLocal.value = capturedScheduleAt
  pendingBroadcastId.value = selectedId.value

  validateDialogVisible.value = true
  validateLoading.value = true
  validateResult.value = null
  try {
    validateResult.value = await apiFetch(`/api/broadcast/${selectedId.value}/validate`, { method: 'POST' })
    const serverErrors = validateResult.value?.errors
    if (Array.isArray(serverErrors) && serverErrors.length > 0) {
      showToast(serverErrors[0], 'error')
    }
  }
  catch {
    showToast('驗證失敗', 'error')
    closeValidateDialog()
  }
  finally {
    validateLoading.value = false
  }
}

async function onConfirmDialogSubmit() {
  confirmDialogError.value = ''
  if (pendingSubmitMode.value === 'schedule') {
    await confirmSchedule()
  }
  else {
    await confirmSendNow()
  }
}

async function confirmSchedule() {
  if (!assertCan('broadcast.send')) return
  const id = pendingBroadcastId.value
  const scheduleAtLocal = pendingScheduleAtLocal.value

  if (!id) {
    confirmDialogError.value = '推播 ID 遺失，請關閉視窗後重試'
    return
  }
  if (!scheduleAtLocal) {
    confirmDialogError.value = '排程時間遺失，請關閉視窗後重新選擇排程時間'
    return
  }

  const scheduleErr = validateFutureScheduleLocalInput(scheduleAtLocal)
  if (scheduleErr) {
    confirmDialogError.value = scheduleErr
    return
  }

  const scheduleAtIso = scheduleAtForApi(scheduleAtLocal)
  if (!scheduleAtIso) {
    confirmDialogError.value = '排程時間格式無效，請重新選擇'
    return
  }

  sending.value = true
  try {
    await apiFetch(`/api/broadcast/${id}/schedule`, {
      method: 'POST',
      body: {
        name: form.value.name.trim(),
        audienceSource: buildAudienceSource(),
        messages: buildMessages(),
        scheduleAt: scheduleAtIso,
      },
    })
    showToast(`已排程，將於 ${formatScheduleLabel(scheduleAtIso)} 自動發送`, 'success')
    closeValidateDialog()
    await loadData()
    selectedId.value = id
    const found = broadcasts.value.find((b) => b.id === id)
    if (found) await selectItem(found, { skipDiscardConfirm: true })
  }
  catch (e: unknown) {
    const msg = apiErrorMessage(e, '排程失敗')
    confirmDialogError.value = msg
    showToast(msg, 'error')
  }
  finally {
    sending.value = false
  }
}

async function confirmSendNow() {
  if (!assertCan('broadcast.send')) return
  const id = pendingBroadcastId.value || selectedId.value
  if (!id) {
    confirmDialogError.value = '推播 ID 遺失，請關閉視窗後重試'
    return
  }
  sending.value = true
  try {
    const res = await apiFetch<any>(`/api/broadcast/${id}/send`, { method: 'POST' })
    // postSendError＝訊息已送出、只是記錄沒整理完；不能報成發送失敗，否則會被重發一次
    showToast(
      res.postSendError
        ? `已送出 成功 ${res.sentCount} / 失敗 ${res.failedCount}（發送後的紀錄未整理完，詳見成效報表）`
        : `發送完成 成功 ${res.sentCount} / 失敗 ${res.failedCount}`,
      res.postSendError ? 'warning' : 'success',
    )
    closeValidateDialog()
    await loadData()
    selectedId.value = id
    const found = broadcasts.value.find((b) => b.id === id)
    if (found) await selectItem(found, { skipDiscardConfirm: true })
  }
  catch (e: unknown) {
    const msg = apiErrorMessage(e, '發送失敗')
    confirmDialogError.value = msg
    showToast(msg, 'error')
  }
  finally {
    sending.value = false
  }
}

async function cancelBroadcast() {
  if (!assertCan('broadcast.send')) return
  const isScheduled = selectedItem.value?.status === 'scheduled'
  const msg = isScheduled ? '確定要取消這則排程？' : '確定要取消這則推播？'
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(msg, isScheduled ? '取消排程' : '取消推播', {
      confirmButtonText: isScheduled ? '取消排程' : '取消推播',
      cancelButtonText: '返回',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/broadcast/${selectedId.value}/cancel`, { method: 'POST' })
    showToast(isScheduled ? '已取消排程' : '已取消推播', 'success')
    await loadData()
    if (selectedId.value) await loadFormFromId(selectedId.value)
  }
  catch {
    showToast('取消失敗', 'error')
  }
}

/** 失敗的推播重設回草稿：本身不發任何訊息，重設後要再走一次「驗證並發送」 */
async function retryBroadcast() {
  if (!assertCan('broadcast.send')) return
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(
      '會把這則推播重設回「草稿」：名稱、名單與訊息內容都保留，這一步不會發出任何訊息。重設後確認內容，再按「驗證並發送」才會真的送出。',
      '重設為草稿再發一次',
      {
        confirmButtonText: '重設為草稿',
        cancelButtonText: '返回',
        type: 'warning',
      },
    )
  }
  catch { return }
  retrying.value = true
  try {
    await apiFetch(`/api/broadcast/${selectedId.value}/retry`, { method: 'POST' })
    showToast('已重設為草稿，確認內容後可再次發送', 'success')
    report.value = null
    await loadData()
    if (selectedId.value && !(await loadFormFromId(selectedId.value))) {
      showToast('已重設但載入內容失敗，請重新點選該推播', 'error')
    }
  }
  catch (e: unknown) {
    showToast(apiErrorMessage(e, '重設失敗'), 'error')
  }
  finally {
    retrying.value = false
  }
}

/** 列表有「已排程」或「發送中」時每分鐘打一次到期處理（後台登入即可，無需另設 Cron） */
let duePollTimer: ReturnType<typeof setInterval> | null = null

/**
 * 這支端點做兩件事：發到期的排程、收殮卡死在「發送中」的單。
 * ⛔所以條件不能只看「已排程」：卡死的單狀態是 processing，只看 scheduled 的話，
 * 手邊沒有其他排程時輪詢根本不會啟動，收殮就只能靠外部排程——而外部排程掛掉
 * 正是推播卡住的原因之一，等於備援與主因同時失效（2026-08-13 code review 抓到）。
 */
function needsDuePolling() {
  return broadcasts.value.some((b) => b.status === 'scheduled' || b.status === 'processing')
}

async function processDueScheduledBroadcasts() {
  if (!can('broadcast.send')) return
  if (!needsDuePolling()) return
  try {
    const res = await apiFetch<{
      triggered: number
      reaped?: number
      results: Array<{ id: string; success: boolean; error?: string }>
    }>(
      '/api/broadcast/process-due',
      { method: 'POST' },
    )
    // reaped＝有卡死的單被標成失敗，畫面上那列還寫著「發送中」→ 一樣要重載，
    // 否則使用者盯著的還是舊狀態，也看不到失敗原因與重發按鈕
    if (res.triggered > 0 || (res.reaped ?? 0) > 0) {
      await loadData()
      if (selectedId.value) {
        const found = broadcasts.value.find((b) => b.id === selectedId.value)
        if (found) await selectItem(found, { skipDiscardConfirm: true })
      }
      const failed = res.results.filter((r) => !r.success)
      if (failed.length) {
        showToast(`有 ${failed.length} 則排程發送失敗，請查看狀態`, 'error')
      }
      if ((res.reaped ?? 0) > 0) {
        showToast(`有 ${res.reaped} 則推播卡住沒送出，已標記為失敗，點進去可看原因並重發`, 'error')
      }
    }
  }
  catch {
    /* 靜默；下次輪詢再試 */
  }
}

function syncDuePollTimer() {
  if (duePollTimer) {
    clearInterval(duePollTimer)
    duePollTimer = null
  }
  if (!needsDuePolling()) return
  void processDueScheduledBroadcasts()
  duePollTimer = setInterval(() => {
    void processDueScheduledBroadcasts()
  }, 60_000)
}

/**
 * C-210：從好友頁「推播給這 N 位」帶過來的名單。
 *
 * ⛔ **讀不到要講出來**：`sessionStorage` 在無痕視窗、擋了網站資料、或使用者自己
 * 另開分頁貼網址時都可能是空的。安靜地開一張空白推播，會讓人以為系統記住了他選的 300 個人。
 * ⛔ 讀完就清掉：不清的話重新整理會再套用一次，而那時他可能已經改成別的對象了。
 */
function applyAudienceHandoff() {
  if (String(useRoute().query.from ?? '') !== 'users') return

  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(BROADCAST_AUDIENCE_HANDOFF_KEY)
    sessionStorage.removeItem(BROADCAST_AUDIENCE_HANDOFF_KEY)
  }
  catch {
    raw = null
  }

  const payload = parseHandoff(raw)
  if (!isFreshHandoff(payload)) {
    showToast('名單沒有帶過來（可能已經過期或這個瀏覽器擋了暫存），請回好友頁重新勾選', 'error')
    return
  }

  openCreate()
  form.value.audienceType = 'import'
  form.value.importText = payload.userIds.join('\n')
  markClean() // 這是系統幫他填的，還沒動到手——不要一進來就說「有未儲存的變更」
  showToast(handoffNoticeText(payload), payload.dropped > 0 ? 'warning' : 'success')
}

/**
 * `C-225`：從後台首頁「接下來的檔期」→「為這一檔擬推播」帶過來的文案三版。
 *
 * ⛔ **只開草稿、不存檔**（`C-221` 同一條紅線：對客人說話的東西，最後一顆按鈕永遠是人）。
 * ⛔ **讀不到要講出來**：跟名單那份同一個理由——安靜地開一張空白推播，
 *    會讓人以為剛剛擬好的文案弄丟了。
 */
function applyDraftHandoff() {
  if (String(useRoute().query.from ?? '') !== 'calendar') return

  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(BROADCAST_DRAFT_HANDOFF_KEY)
    sessionStorage.removeItem(BROADCAST_DRAFT_HANDOFF_KEY)
  }
  catch {
    raw = null
  }

  const payload = parseDraftHandoff(raw)
  if (!isFreshDraftHandoff(payload)) {
    showToast(DRAFT_HANDOFF_MISSING_TEXT, 'warning')
    return
  }

  openCreate()
  form.value.name = payload.suggestedName
  // ⭐ `C-240`：記下這則是為了哪一檔發的。沒有它，之後的檔期回顧只能照日期猜，
  //    而照日期猜會把不相干的商品檔期算成這一檔的成績。
  form.value.festivalId = payload.festivalId
  // 預設帶第一版；其餘幾版擺在編輯器上面讓他換（換了只是改文字，還是草稿）
  form.value.contentAction = normalizeUnifiedAction({ type: 'message', text: payload.variants[0]! }, 'A')
  if (payload.suggestedTagIds.length) {
    form.value.audienceType = 'tags'
    form.value.tagIds = [...payload.suggestedTagIds]
  }
  draftVariants.value = payload.variants
  draftVariantIndex.value = 0
  draftBasis.value = payload.basis
  markClean() // 系統幫他填的，還沒動到手——不要一進來就說「有未儲存的變更」
  showToast(draftHandoffNoticeText(payload), 'success')
}

/**
 * `D-28`：從「好友統計」的興趣排行按「發推播給這群」帶過來的標籤。
 *
 * ⚠️ **這一支讀網址參數，不是 `sessionStorage`**——跟上面兩支不一樣是刻意的：
 *    那兩支要搬的是三百個 LINE 編號／三版文案（塞不進網址），這支只有一個標籤 id，
 *    用網址參數換來「重新整理還在、連結貼得出去」。
 * ⛔ **標籤對不上要講出來**：它可能在按下按鈕之後被停用或刪掉了，
 *    安靜地開一張空白推播會讓人以為受眾已經選好了。
 */
function applyTagHandoff() {
  const q = useRoute().query
  if (String(q.from ?? '') !== 'friend-stats') return
  const tagId = String(q.tagId ?? '').trim()
  if (!tagId) return

  openCreate()
  const hit = allTags.value.find(t => t.id === tagId)
  if (!hit) {
    showToast('那顆標籤現在選不到了（可能剛被停用或刪掉），請自己挑發送對象', 'warning')
    return
  }
  form.value.audienceType = 'tags'
  form.value.tagIds = [tagId]
  markClean() // 系統幫他填的，還沒動到手
  showToast(`發送對象已選好「${hit.name}」。這是草稿，還沒有送出去。`, 'success')
}

/** 這一次帶過來的三版文案（空陣列＝不是從月曆進來的） */
const draftVariants = ref<string[]>([])
const draftVariantIndex = ref(0)
const draftBasis = ref('')

function pickDraftVariant(i: number) {
  const v = draftVariants.value[i]
  if (!v) return
  draftVariantIndex.value = i
  form.value.contentAction = normalizeUnifiedAction({ type: 'message', text: v }, 'A')
}

// ── 小幫手擬好草稿（`D-112` 第 4 件）：清單與「有 N 則草稿」重讀、那一則亮一下 ─────────
// ⛔ 剛擬好時不打開它：他可能正在編另一則還沒存的推播（按了「前往查看」才打開）
useAgentOpRefresh('broadcasts', async (evt, { mode }) => {
  const id = evt.targetId
  if (!id) return 'missing'
  // 從別頁「前往查看」過來：`?id=` 深連結會自己翻頁打開它，這裡只等那一列出現
  if (mode === 'arrived') return (await flashAgentTarget(id, 8000)) ? 'shown' : 'missing'
  // 「有 N 則草稿」那一行掛在清單載完的那一刻自己重讀（見 loadDraftTotal 下面那個 watch）
  if (mode === 'fresh') await loadBroadcasts(true)
  if (!broadcasts.value.some(b => b.id === id))
    await findBroadcastUntilFound(b => b.id === id).catch(() => null)
  const row = broadcasts.value.find(b => b.id === id)
  if (!row) return 'missing'
  if (mode === 'reveal' && !isCreating.value && !hasUnsavedChanges.value)
    await selectItem(row, { skipDiscardConfirm: true })
  return (await flashAgentTarget(id)) ? 'shown' : 'missing'
})

onMounted(async () => {
  await loadData()
  applyAudienceHandoff()
  applyDraftHandoff()
  applyTagHandoff()
  syncDuePollTimer()
  // `C-237`：網址帶 ?id= 就直接開那一則（「這個東西誰在用」名單點得進來）
  await openFromQueryId({
    label: '推播',
    list: { loadUntilFound: findBroadcastUntilFound, listEl },
    select: item => void selectItem(item, { skipDiscardConfirm: true }),
    isBusy: () => hasUnsavedChanges.value,
  })
})

onUnmounted(() => {
  if (duePollTimer) clearInterval(duePollTimer)
})
</script>
