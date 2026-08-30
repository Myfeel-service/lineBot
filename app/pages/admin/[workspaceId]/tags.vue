<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="標籤管理"
        title="標籤列表"
        caption="建立與管理好友標籤，用於分眾推播"
        :help-topics="['tags']"
      />
      <div class="flex gap-1 admin-header-actions">
        <!-- 範本＝AI 判斷型標籤的起手式：名稱、判斷條件都寫好，一鍵建立改幾個字就能用（D-27③） -->
        <el-button v-if="canOperate" size="small" data-tour="tag-templates" @click="openTemplates">從範本建立</el-button>
        <el-button v-if="canOperate" :icon="Plus" type="primary" size="small" data-tour="tag-new" @click="openCreate">新增</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <!-- 掃描停擺的提醒改由版型層的「頁面級提醒條」統一顯示（AdminPageAlertStrip，
             D-33 二輪）——⛔別在這頁再自刻一條，每頁長得不一樣正是老闆抓的問題 -->
        <!-- ══ AI 發現的新標籤（老闆 08-25 拍板）═══════════════════
             掃描器每週讀一次最近的對話，找「很多客人在聊、但還沒有標籤」的主題。
             按「建立」才會真的新增（同時幫聊過的那批客人貼上）；按「不要」永不再提。
             沒有建議時整張卡不出現——不佔版面。 -->
        <div v-if="discoveryPending.length" class="message-card tags-discovery-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">AI 發現的新標籤</span>
              <span class="badge badge-orange">{{ discoveryPending.length }} 個建議</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- ⛔ 總開關關著卻有舊建議：按「建立」會生出一顆永遠不會自己運作的標籤，
                 要先把這件事講出來，不能讓人按完才發現沒動靜 -->
            <p v-if="!discoveryEnabled" class="tags-discovery-warn">
              ⚠️ 「AI 讀對話」目前是關的，這些是先前留下的建議。現在建立的標籤不會自動判斷，
              要到「AI 設定 → 顧客標籤」打開總開關才會開始運作。
            </p>
            <p class="tags-desc-hint text-muted">
              從最近兩週的對話歸納出來的主題。按「建立」才會真的新增標籤，
              並幫聊過的那批客人貼上（記為 AI 貼的，隨時可拿掉）；按「忽略」之後不會再建議同一個主題。
            </p>
            <div v-for="p in discoveryPending" :key="p.id" class="tags-discovery-row">
              <div class="tags-discovery-row__main">
                <div class="tags-discovery-row__title">
                  <span class="tags-discovery-row__name">{{ p.name }}</span>
                  <span class="badge badge-gray">{{ tagCategoryLabel(p.category) }}</span>
                  <!-- 這條建議是什麼時候提的：放著三週沒動的建議，「最近兩週」那句就不成立了 -->
                  <span v-if="p.proposedAtMs" class="tags-discovery-row__when">
                    {{ elapsedSince(p.proposedAtMs) }}提議
                  </span>
                </div>
                <!-- 「N 位客人聊過」是這條建議唯一的證據強度 → 附上前幾位的名字。
                     標籤還不存在，沒有名單頁可以連過去（好友頁靠 ?tagIds= 篩） -->
                <p class="tags-discovery-row__count">
                  <strong>{{ p.userCount }} 位客人</strong>聊過<template v-if="p.sampleNames?.length">，包括 {{ p.sampleNames.join('、') }}{{ p.userCount > p.sampleNames.length ? ' 等' : '' }}</template>
                </p>
                <p v-if="p.reason" class="tags-discovery-row__reason">{{ p.reason }}</p>
                <!-- 條件會被裁成兩行，但它正是要按下去的依據 → 滑上去看得到全文 -->
                <p class="tags-discovery-row__criteria" :title="p.criteria">AI 判斷條件：{{ p.criteria }}</p>
              </div>
              <div v-if="canOperate" class="tags-discovery-row__actions">
                <el-button
                  size="small"
                  type="primary"
                  :loading="discoveryActing === p.id"
                  :disabled="!!discoveryActing && discoveryActing !== p.id"
                  @click="actOnDiscovery(p, 'adopt')"
                >建立並幫 {{ p.userCount }} 位貼上</el-button>
                <el-button
                  size="small"
                  :disabled="!!discoveryActing"
                  @click="actOnDiscovery(p, 'dismiss')"
                >忽略</el-button>
              </div>
            </div>
          </div>
        </div>

        <!--
          ══ 沒有建議時的常駐細條（D-30②）════════════════════════
          ⛔ **不可以整個消失**：第一版是「沒建議只剩一行小灰字」，老闆的反應是
          「這個功能好像沒有介面」——一個功能不能只在有結果的時候才有臉。
          現在是一條看得見的細條：講清楚上次掃了沒、結果如何，並且給一顆
          「立即掃描一次」，不用等它一週一次的節奏。
          文案由 discoveryState() 純函式決定（可測），⛔ 不要在模板裡拼條件：
          第一版就是在這裡拼 v-if，結果「每輪都炸」被印成「第一次掃描還沒跑」。
        -->
        <div
          v-else-if="discoveryLoaded"
          class="tags-discovery-strip"
          :class="`is-${discoveryIdle.tone}`"
        >
          <span class="tags-discovery-strip__icon" aria-hidden="true">{{ discoveryIdle.tone === 'idle' ? '🔍' : '⚠️' }}</span>
          <span class="tags-discovery-strip__txt">
            <b>AI 發現新標籤</b>：{{ discoveryIdle.text }}
            <!--
              ⛔ 時間另起一行，不要接在上面那句後面：上面講的是**結論**
              （有沒有發現、是不是壞了），這行講的是**什麼時候**，混成一句沒人讀得完。
              老闆 08-26：「立即掃描是否可以知道上次掃描是什麼時候、自動掃描會落在什麼時候」
              ——先前這條細條一個時間都沒有，功能看起來像沒在動。
            -->
            <span v-if="discoveryTimingText" class="tags-discovery-strip__when">{{ discoveryTimingText }}</span>
          </span>
          <!-- ⛔ 開關關著時不給這顆按鈕：按了也不會掃，那是假的操作 -->
          <el-button
            v-if="canOperate && discoveryEnabled"
            size="small"
            :loading="rescanning"
            @click="requestRescan"
          >立即掃描一次</el-button>
        </div>

        <!--
          ══ 先前的建議與當時的決定（C-94）════════════════════════
          老闆 08-28：「按了幾次都沒有新的，是否把之前建議的紀錄保留，
          也保留之前決策是建立還是不要建立」。
          ⛔ **預設收合**：這是回頭查用的，不是每天要看的東西——展開就佔掉半個畫面，
             而上面那張「等你決定」的卡才是要被看見的主角。
          ⛔ **沒有紀錄時整塊不出現**：一個空的「先前紀錄（0）」只是告訴人這裡沒東西，
             那句話用不著一個區塊來講。
        -->
        <div v-if="discoveryLoaded && discoveryHistory.length" class="tags-history">
          <button
            type="button"
            class="tags-history__toggle"
            :class="{ 'is-open': showDiscoveryHistory }"
            @click="showDiscoveryHistory = !showDiscoveryHistory"
          >
            <span class="tags-history__chevron" aria-hidden="true" />
            {{ showDiscoveryHistory ? '收合' : '展開' }}先前的建議與決定（{{ discoveryHistory.length }} 筆）
          </button>

          <div v-if="showDiscoveryHistory" class="tags-history__body">
            <p class="tags-desc-hint text-muted">
              AI 提過的每一條，以及當時是誰、在什麼時候按了「建立」或「忽略」。
              按過「忽略」的主題之後不會再被提；如果是按錯的，可以在這裡取消。
            </p>
            <div v-for="h in discoveryHistory" :key="h.id" class="tags-history-row">
              <div class="tags-history-row__main">
                <div class="tags-history-row__title">
                  <!-- 決定本身是這一列的重點 → 放在名字前面，一眼掃得完整欄 -->
                  <span
                    class="badge"
                    :class="h.action === 'adopt' ? 'badge-green' : 'badge-gray'"
                  >{{ h.action === 'adopt' ? '已建立' : '已忽略' }}</span>
                  <span class="tags-history-row__name">{{ h.name }}</span>
                  <span class="badge badge-gray">{{ tagCategoryLabel(h.category) }}</span>
                  <!-- 撤回過的忽略要看得出來：否則畫面說「已忽略」，實際上它隨時會再回來 -->
                  <span v-if="h.undoneAtMs" class="badge badge-orange">已取消忽略</span>
                </div>
                <p class="tags-history-row__meta">
                  <!-- ⛔ 查不到是誰就整段不講：「由 同事決定」既沒資訊、中英夾雜的空格還會歪掉 -->
                  {{ elapsedSince(h.decidedAtMs) }}<template v-if="h.decidedByEmail">由 {{ h.decidedByEmail }} </template>決定．提議時有
                  <strong>{{ h.userCount }} 位客人</strong>聊過<template v-if="h.sampleNames?.length">（{{ h.sampleNames.join('、') }}{{ h.userCount > h.sampleNames.length ? ' 等' : '' }}）</template>
                  <!-- ⛔ 實際貼上人數可能少於提議人數（逐位貼、單人失敗不整批放棄）→ 據實顯示，不要拿 userCount 充數 -->
                  <template v-if="h.action === 'adopt' && h.taggedCount !== undefined">
                    ．實際幫 <strong>{{ h.taggedCount }} 位</strong>貼上
                  </template>
                </p>
                <p class="tags-history-row__criteria" :title="h.criteria">AI 判斷條件：{{ h.criteria }}</p>
              </div>
              <div class="tags-history-row__actions">
                <!-- 採用的那條連得到名單：標籤已經存在，好友頁靠 ?tagIds= 篩得出來 -->
                <el-button
                  v-if="h.action === 'adopt' && h.tagId"
                  size="small"
                  text
                  @click="goTaggedFriends(h.tagId)"
                >看這批客人</el-button>
                <!-- ⛔ 文案是「取消忽略」不是「還原建議」：建議本身回不來（沒存名單），
                     真正發生的是「這個主題重新有資格被提」 -->
                <el-button
                  v-if="canOperate && canUndoDismiss(h)"
                  size="small"
                  :loading="undoingDismiss === h.id"
                  :disabled="!!undoingDismiss"
                  @click="undoDismiss(h)"
                >取消忽略</el-button>
              </div>
            </div>
          </div>
        </div>

        <div class="message-card tags-page-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">篩選與表格</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- ══ AI 分段（D-30①）════════════════════════════════
                 老闆問「所有標籤混在一個列表好嗎」。列表維持一個（標籤只有一種身分），
                 但把最常用的切法從下拉搬到檯面上——數字本身就是資訊，不點也知道
                 「有幾顆在讓 AI 判」。細分（先建議／直接貼）由表格那欄的徽章負責。 -->
            <div class="tags-segments" role="group" aria-label="依 AI 判斷篩選">
              <button
                v-for="seg in TAG_AI_SEGMENTS"
                :key="seg.value || 'all'"
                type="button"
                class="tags-segment"
                :class="{ active: isSegmentActive(seg.value) }"
                :aria-pressed="isSegmentActive(seg.value)"
                @click="filterAiMode = seg.value"
              >{{ seg.label }} <span class="tags-segment__n">{{ segmentCount(seg.value) }}</span></button>
            </div>

            <!-- ══ 進了「AI 判斷中」才出現的細分（2026-08-26）══════════
                 ⛔ **不是把上面那排改成四顆**——那是刻意拍板不做的（會有一顆長期是 0、
                 點進去是死路）。這排只在已經選了「AI 判斷中」時才出現：那時你已經在
                 這一段裡面，看到「直接貼 0」是有意義的答案，不是一顆沒用的死膠囊。
                 為什麼要補：「AI 直接貼」是**風險最高**的一種（貼錯的下游是推播發錯人），
                 先前要盤點它只能自己翻完整份清單一列一列看徽章。 -->
            <div v-if="isAiSegmentActive" class="tags-subsegments" role="group" aria-label="再分先建議或直接貼">
              <span class="tags-subsegments__lead">這 {{ segmentCount('ai') }} 顆裡：</span>
              <button
                v-for="sub in TAG_AI_SUB_SEGMENTS"
                :key="sub.value"
                type="button"
                class="tags-subsegment"
                :class="{ active: filterAiMode === sub.value }"
                :title="sub.hint"
                :aria-pressed="filterAiMode === sub.value"
                @click="filterAiMode = filterAiMode === sub.value ? 'ai' : sub.value"
              >{{ sub.label }} <span class="tags-segment__n">{{ segmentCount(sub.value) }}</span></button>
            </div>

            <div class="tags-toolbar" data-tour="tag-filter">
              <div class="tags-toolbar__field tags-toolbar__field--search">
                <AdminFieldLabel text="搜尋（標籤名稱或英文代號）" tight />
                <el-input v-model="searchText" placeholder="輸入關鍵字…" clearable />
              </div>
              <div class="tags-toolbar__field tags-toolbar__field--category">
                <AdminFieldLabel text="分類" tight />
                <el-select v-model="filterCategory" placeholder="全部" clearable>
                  <el-option
                    v-for="c in TAG_CATEGORY_OPTIONS"
                    :key="c.value"
                    :label="c.label"
                    :value="c.value"
                  />
                </el-select>
              </div>
              <div class="tags-toolbar__field tags-toolbar__field--status">
                <AdminFieldLabel text="狀態" tight />
                <el-select v-model="filterStatus" placeholder="全部" clearable>
                  <el-option label="啟用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </div>
              <span class="tags-count text-muted">符合 {{ total.toLocaleString('zh-TW') }} 筆</span>
            </div>

            <!-- ⛔ 「待審」讀失敗要講出來：整欄安靜消失的話，畫面看起來就是「沒有人等你決定」
                 ——同一款沉默死亡這個專案已經吃過三次（C-68／守門員／C-94）。 -->
            <p v-if="pendingCountsFailed" class="tags-pending-note">
              ⚠️ 「待審」數字這次讀不到（其他資料正常）。重整這一頁再試一次。
            </p>

            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <div v-else-if="!tags.length" class="tags-empty">
              <span>{{ total ? '無符合的標籤' : '尚無任何標籤，請點擊右上角「新增標籤」開始' }}</span>
            </div>
            <div v-else class="table-wrap">
              <table class="tags-table">
                <thead>
                  <tr>
                    <th class="tags-table__th--swatch" />
                    <th>名稱</th>
                    <th>Code</th>
                    <th>AI 判斷</th>
                    <th>分類</th>
                    <th>狀態</th>
                    <th class="tags-table__th--count">好友數</th>
                    <th>建立時間</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="tag in tags"
                    :key="tag.id"
                    class="tags-table__row--clickable"
                    tabindex="0"
                    @click="openEdit(tag)"
                    @keydown.enter="openEdit(tag)"
                  >
                    <td>
                      <span class="tag-color-dot" :style="{ '--dot-bg': tag.color || '#6B7280' }" />
                    </td>
                    <td class="td-name">{{ tag.name }}</td>
                    <td class="td-code">{{ tag.code }}</td>
                    <!-- 一眼看出「這顆是誰在貼」：AI 有在動的才上色，off 給低調的「—」
                         （21 顆裡多數是 off，整欄都掛灰章只是噪音） -->
                    <td>
                      <span v-if="tag.aiMode === 'auto'" class="badge badge-green">AI 直接貼</span>
                      <span v-else-if="tag.aiMode === 'suggest'" class="badge badge-orange">AI 先建議</span>
                      <span v-else class="text-muted">—</span>
                      <!-- 「還有幾位等你決定」（D-42②）：只在真的有的時候出現。
                           ⛔ 0 位不顯示——每列都掛「待審 0 位」是純噪音；
                           ⛔ 讀不到時也不顯示（不能拿 0 冒充「沒事」），改由表格上方那行說明。 -->
                      <button
                        v-if="pendingCountsLoaded && pendingCountFor(tag.id) > 0"
                        type="button"
                        class="tags-pending-link"
                        :title="pendingCountsTruncated
                          ? '去看這些建議（待審總數已達統計上限，實際可能更多）'
                          : `去看還沒決定的 ${pendingCountFor(tag.id)} 位客人`"
                        @click.stop="goPendingFriends(tag.id)"
                      >待審 {{ pendingCountFor(tag.id) }} 位</button>
                    </td>
                    <td>
                      <span class="badge badge-gray">{{ tagCategoryLabel(tag.category) }}</span>
                    </td>
                    <td>
                      <span :class="tag.status === 'active' ? 'badge badge-green' : 'badge badge-gray'">
                        {{ tag.status === 'active' ? '啟用' : '停用' }}
                      </span>
                    </td>
                    <!-- 大數字要能點進明細：帶著標籤跳好友頁（?tagIds=）就是那份名單。
                         ⛔ 要 stop 掉冒泡——整列的 click 是開編輯對話框，不擋的話會同時觸發。
                         0 位時不給連結（點進去只會看到空清單，是死路不是捷徑）。 -->
                    <td class="td-count">
                      <button
                        v-if="(tag.memberCount ?? 0) > 0"
                        type="button"
                        class="tags-count-link"
                        :title="`看這 ${formatMemberCount(tag.memberCount)} 位好友`"
                        @click.stop="goTaggedFriends(tag.id)"
                      >{{ formatMemberCount(tag.memberCount) }}</button>
                      <span v-else>{{ formatMemberCount(tag.memberCount) }}</span>
                    </td>
                    <td class="td-time">{{ formatZhDateOnly(tag.createdAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="!loading && total > pageSize" class="admin-table-pager">
              <el-pagination
                :current-page="page"
                :page-size="pageSize"
                :total="total"
                layout="total, prev, pager, next"
                background
                @current-change="onPageChange"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <el-dialog
    v-model="dialogVisible"
    :title="isEditing ? '編輯標籤' : '新增標籤'"
    width="min(600px, 94vw)"
    class="tags-dialog"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" @submit.prevent>
      <div class="admin-field-stack">
        <div class="admin-field-group">
          <AdminFieldLabel text="啟用狀態" tight />
          <el-switch
            v-model="form.status"
            active-value="active"
            inactive-value="inactive"
            active-text="啟用中"
            inactive-text="已停用"
            class="tags-status-switch"
          />
          <span class="tags-hint">停用的標籤不會出現在貼標選單，但仍可在此編輯</span>
        </div>

        <div class="admin-field-group" data-tour="tag-code">
          <AdminFieldLabel text="英文代號（系統辨識用，建立後就不能改）" tight />
          <el-input
            v-model="form.code"
            :disabled="isEditing"
            placeholder="例如 interest_food、vip"
            maxlength="40"
          />
          <span class="tags-hint">給系統認的英文代號（不會給客人看到）：只能用英文小寫、數字、底線，開頭要是英文字母</span>
        </div>

        <div class="admin-field-group" data-tour="tag-name">
          <AdminFieldLabel text="顯示名稱（最多 30 字）" tight />
          <el-input v-model="form.name" placeholder="例如 美食愛好者" maxlength="30" />
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="分類" tight />
          <el-select v-model="form.category" class="tags-dialog-select">
            <el-option
              v-for="c in TAG_CATEGORY_OPTIONS"
              :key="c.value"
              :label="c.label"
              :value="c.value"
            />
          </el-select>
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="標籤顏色" tight />
          <div class="tags-color-row">
            <button
              v-for="c in TAG_PRESET_COLORS"
              :key="c"
              type="button"
              class="tags-color-swatch"
              :class="{ active: form.color === c }"
              :style="{ '--swatch-bg': c }"
              @click="form.color = c"
            />
          </div>
        </div>

        <!-- 說明與 AI 判斷條件是**兩欄**（D-27②）：既有標籤的說明是寫給人看的（檔期備註
             之類），拿去當 AI 條件會讓它亂猜。AI 只讀 aiCriteria，description 回歸內部備註。 -->
        <div class="admin-field-group">
          <AdminFieldLabel text="說明（給團隊看，選填）" tight />
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            placeholder="這顆標籤是做什麼的、誰負責、檔期備註——寫給人看的話"
            maxlength="200"
          />
        </div>

        <!-- 三段選擇（D-27①）：一個控制講完「讓不讓 AI 判＋判了怎麼處理」。
             ⛔ 不做成兩個開關——四種組合有一種（不讓判卻自動貼）沒有意義。
             預設 off＝問卷/客服/活動這類事件紀錄標籤完全不被 AI 碰。 -->
        <div class="admin-field-group">
          <AdminFieldLabel text="要不要讓 AI 判斷這顆標籤？" tight />
          <!-- ⛔ 用 el-radio-group 不要手刻 <input type="radio">：base/_reset.scss 有
               `input, textarea, select { width: 100% }`，原生 radio 會被拉成滿版把整列吃光，
               旁邊的文字被壓成 0 寬變直排（2026-08-24 實際破版過）。Element Plus 的真 input
               是隱藏的 .el-radio__original，不吃那條規則。 -->
          <el-radio-group v-model="form.aiMode" class="tags-ai-options">
            <el-radio
              v-for="opt in AI_MODE_OPTIONS"
              :key="opt.value"
              :value="opt.value"
              class="tags-ai-option"
            >
              <span class="tags-ai-option__title">{{ opt.title }}</span>
              <span class="tags-ai-option__desc">{{ opt.desc }}</span>
            </el-radio>
          </el-radio-group>
        </div>

        <!-- 判斷條件只在需要時出現（漸進揭露）：off 的 19 顆標籤不用面對用不到的欄位。
             切到 suggest/auto 時把 description 預填進來讓人改（不是靜默沿用，見 watch）。
             ⛔ maxlength 200 = ai-tag-suggest 的 CRITERIA_IN_PROMPT_MAX，動一邊要動另一邊
             （有測試釘住「滿 200 字要整段進 prompt」）。 -->
        <div v-if="form.aiMode !== 'off'" class="admin-field-group tags-criteria-group">
          <AdminFieldLabel text="AI 判斷條件（只有這欄 AI 會看）" tight />
          <el-input
            v-model="form.aiCriteria"
            type="textarea"
            :rows="3"
            placeholder="例：客人詢問、比較除濕機，或提到家裡潮濕、衣服晾不乾想找解法。只問舊機維修的不算。"
            maxlength="200"
            show-word-limit
          />
          <p class="tags-desc-hint text-muted">
            AI 會拿整段對話對照這裡寫的條件，<strong>只看客人說的話</strong>（客服自己提到不算）。
            寫法：<strong>什麼算</strong>、順便寫<strong>什麼不算</strong>，越像人話越準。
            要生效記得到「AI 設定 → 顧客標籤」開啟 AI 讀對話的總開關。
          </p>
        </div>
      </div>
    </el-form>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button v-if="canOperate" type="primary" :loading="saving" @click="submitForm">
        {{ isEditing ? '儲存變更' : '建立標籤' }}
      </el-button>
    </template>
  </el-dialog>

  <!-- ── 範本（D-27③）：AI 判斷型標籤的起手式 ──────────────
       難的不是點「新增」，是想不到該建哪些、條件怎麼寫。範本全部寫好，
       勾選建立後改幾個字就能用；建立時一律「AI 先建議」，跑準了再自行升級直接貼。 -->
  <el-dialog v-model="templateDialogVisible" title="從範本建立 AI 判斷型標籤" width="min(680px, 94vw)">
    <p class="tags-desc-hint text-muted" style="margin-top: 0">
      這些都是「對話裡看得出來」的意圖標籤——判斷條件已經寫好，建立後可到標籤上逐字修改。
      建立時一律是「<strong>AI 先建議</strong>」，你按採用才貼；覺得準了再把該顆改成「直接貼」。
    </p>
    <!-- 同三段選擇：原生 checkbox 也會被 reset 的 `input { width: 100% }` 拉滿版，一律走 el-checkbox -->
    <el-checkbox-group v-model="selectedTemplateCodes" class="tags-template-list">
      <el-checkbox
        v-for="t in TAG_TEMPLATES"
        :key="t.code"
        :value="t.code"
        :disabled="existingCodes.has(t.code)"
        class="tags-template-item"
        :class="{ 'is-exists': existingCodes.has(t.code) }"
      >
        <span class="tags-template-item__name">
          <span class="tag-color-dot" :style="{ '--dot-bg': t.color }" />
          {{ t.name }}
          <span v-if="existingCodes.has(t.code)" class="badge badge-gray">已建立</span>
        </span>
        <span class="tags-template-item__criteria">條件：{{ t.criteria }}</span>
        <span class="tags-template-item__usage">{{ t.usage }}</span>
      </el-checkbox>
    </el-checkbox-group>
    <template #footer>
      <el-button @click="templateDialogVisible = false">關閉</el-button>
      <el-button
        v-if="canOperate"
        type="primary"
        :loading="creatingTemplates"
        :disabled="!selectedTemplateCodes.length"
        @click="createFromTemplates"
      >
        建立所選（{{ selectedTemplateCodes.length }}）
      </el-button>
    </template>
  </el-dialog>

</template>

<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'
import { formatZhDateOnly } from '~~/shared/firestore-date'
import { TAG_CATEGORY_OPTIONS, TAG_PRESET_COLORS, tagCategoryLabel } from '~~/shared/tag-admin'
import { TAG_TEMPLATES } from '~~/shared/tag-templates'
import { discoveryState, discoveryTiming, type DiscoveryScanOutcome, type TagDiscoveryDecision } from '~~/shared/tag-discovery'
import { TAG_AI_SEGMENTS, TAG_AI_SUB_SEGMENTS, isTagAiFilterValue } from '~~/shared/tag-admin'
import type { TagAiMode } from '~~/shared/types/tag-broadcast'

/** 三段選擇的文案（D-27①）：信任程度由低到高，一次講完「讓不讓判＋判了怎麼處理」 */
const AI_MODE_OPTIONS: Array<{ value: TagAiMode; title: string; desc: string }> = [
  { value: 'off', title: '不用，我自己貼（預設）', desc: 'AI 完全不會碰這顆。問卷、客服、活動這類由系統或人貼的標籤選這個。' },
  { value: 'suggest', title: 'AI 判斷後先建議，我按了才貼', desc: '出現在「好友」頁那位客人的 AI 建議區，你按採用才生效。新標籤建議從這段開始。' },
  { value: 'auto', title: 'AI 判斷到就直接貼上', desc: '不用你按。會記「AI 貼的」、隨時可拿掉；手動拿掉過的客人 AI 不會再貼。' },
]

definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()
const { tags, loading, total, segments, page, pageSize, loadTags } = useAdminTagList()
const { showToast } = useAdminToast()

const saving = ref(false)
const dialogVisible = ref(false)
const isEditing = ref(false)
const searchText = ref('')
const filterCategory = ref('')
const filterStatus = ref('')
const filterAiMode = ref('')

const defaultForm = () => ({
  id: '',
  code: '',
  name: '',
  category: 'custom' as const,
  color: '#6B7280',
  description: '',
  aiMode: 'off' as TagAiMode,
  aiCriteria: '',
  status: 'active' as 'active' | 'inactive',
})
const form = ref(defaultForm())

/**
 * 切到「讓 AI 判」而條件還是空的 → 把說明**預填**進去當底稿讓人改。
 * ⛔ 是預填不是靜默沿用：欄位裡看得到、能整段改掉——「AI 偷偷拿說明當條件」正是
 * 這次要拆掉的行為（G-24 的教訓）。
 */
watch(() => form.value.aiMode, (mode, prev) => {
  if (prev === 'off' && mode !== 'off' && !form.value.aiCriteria.trim() && form.value.description.trim()) {
    form.value.aiCriteria = form.value.description.trim()
  }
})

// ── 範本（D-27③）──────────────────────────────────────
const templateDialogVisible = ref(false)
const selectedTemplateCodes = ref<string[]>([])
const creatingTemplates = ref(false)
/** 已存在的 code（含分頁外的：範本 code 撞號時後端也會 409 擋，這裡是第一道顯示） */
const existingCodes = computed(() => new Set(tags.value.map((t: any) => String(t.code ?? ''))))

function openTemplates() {
  selectedTemplateCodes.value = []
  templateDialogVisible.value = true
}

async function createFromTemplates() {
  if (!assertCanOperate()) return
  if (!selectedTemplateCodes.value.length) return
  creatingTemplates.value = true
  let created = 0
  let skipped = 0
  try {
    // 逐顆建（一次最多 8 顆）：單顆撞號（409）算跳過不算失敗，其餘照建
    for (const code of selectedTemplateCodes.value) {
      const t = TAG_TEMPLATES.find(x => x.code === code)
      if (!t) continue
      try {
        await apiFetch('/api/tag/create', {
          method: 'POST',
          body: {
            code: t.code,
            name: t.name,
            category: t.category,
            color: t.color,
            description: t.usage,
            aiMode: 'suggest', // 範本一律先建議（人工把關），跑準了再自行升級 auto
            aiCriteria: t.criteria,
            status: 'active',
          },
        })
        created++
      }
      catch (e: any) {
        if (e?.status === 409 || e?.statusCode === 409) skipped++
        else throw e
      }
    }
    showToast(skipped ? `建立 ${created} 顆（${skipped} 顆已存在，略過）` : `建立 ${created} 顆標籤`, 'success')
    templateDialogVisible.value = false
    await refreshTags()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '建立失敗', 'error')
  }
  finally {
    creatingTemplates.value = false
  }
}

/** 膠囊上的數字（D-30①）。⛔ 後端算的時候排除 aiMode 本身，所以點了某一段其他段不會歸零 */
function segmentCount(value: string): number {
  if (value === 'ai') return segments.value.ai
  if (value === 'off') return segments.value.manual
  if (value === 'suggest') return segments.value.suggest
  if (value === 'auto') return segments.value.auto
  return segments.value.all
}

/**
 * 細分那排要不要出現：**已經在「AI 判斷中」這一段裡面**才算。
 * 選了細分（先建議／直接貼）時仍然算在裡面——否則按下去那排會自己消失，
 * 等於把使用者踢出他剛進來的那一層。
 */
const isAiSegmentActive = computed(
  () => filterAiMode.value === 'ai' || filterAiMode.value === 'suggest' || filterAiMode.value === 'auto',
)

/**
 * 上面那排膠囊哪一顆是選中的。
 * ⛔ 選了細分時「🤖 AI 判斷中」**仍然要亮著**：你人就在那一段裡面，
 * 讓它看起來沒選中的話，畫面等於在說「你不在任何一段」卻又顯示著細分那排。
 */
function isSegmentActive(value: string): boolean {
  return value === 'ai' ? isAiSegmentActive.value : filterAiMode.value === value
}

/* ── 立即掃描一次（D-30②）───────────────────────────────── */
const rescanning = ref(false)

async function requestRescan() {
  if (!assertCanOperate()) return
  rescanning.value = true
  try {
    const res = await apiFetch<{ queued: boolean, reason?: string }>('/api/tag/discovery', {
      method: 'POST',
      body: { action: 'rescan' },
    })
    /**
     * 排上了就**當場把細條改成「排隊中」**，不要只丟一則會消失的 toast。
     * ⛔ 少了這行，按完之後畫面完全看不出有排隊，使用者會以為沒按到而再按一次
     *    ——而那顆按鈕每按一次就是一次 LLM。
     */
    if (res.queued) discoveryRescanRequestedMs.value = Date.now()
    // ⛔ queued:false 不是錯誤，是「剛掃過、不用再掃」——要講清楚而不是報失敗
    showToast(
      res.queued
        ? '已排入掃描，通常十分鐘內完成，完成後回來重整這一頁'
        : '剛剛才掃過，先等一下再試（每半小時最多一次）',
      res.queued ? 'success' : 'warning',
    )
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '排入掃描失敗', 'error')
  }
  finally {
    rescanning.value = false
  }
}

// ── AI 發現的新標籤（08-25）──────────────────────────────
interface DiscoveryRow {
  id: string
  name: string
  category: string
  criteria: string
  usage: string
  reason: string
  userCount: number
  sampleNames: string[]
  proposedAtMs: number
}

const discoveryPending = ref<DiscoveryRow[]>([])
/** 目前正在處理的提案 id（同一時間只准按一條，防連點與互相蓋寫） */
const discoveryActing = ref('')
/** 「AI 讀對話」總開關：關著的話卡片要先講清楚建了也不會自己運作 */
const discoveryEnabled = ref(false)
const discoveryLastScanMs = ref(0)
/**
 * 上次掃描的明細：讀了幾段對話、AI 提了幾個、被擋掉哪幾個。
 * ⛔ 沒有這個的話，「樣本太少」「AI 覺得沒主題」「AI 有提但撞名被擋」畫面上會印同一句話
 *   ——老闆 08-28「按了幾次都沒有新的」問的正是這三種的哪一種。
 */
const discoveryLastScan = ref<DiscoveryScanOutcome | null>(null)
/** 先前的建議與當時的決定（新的在前，後端已反轉） */
const discoveryHistory = ref<TagDiscoveryDecision[]>([])
/** 紀錄區塊預設收合：它是「回頭查」用的，不該每次開頁都佔掉半個畫面 */
const showDiscoveryHistory = ref(false)
/** 正在取消忽略的那筆紀錄 id（防連點） */
const undoingDismiss = ref('')
/** 有人按過「立即掃描一次」、排程還沒撿走（比 lastScanMs 新才算數） */
const discoveryRescanRequestedMs = ref(0)
/** 掃描器連續失敗中（後端用掃描器自己記的失敗判定，不是拿游標猜） */
const discoveryStalled = ref(false)
/** 這次進頁面之後有沒有自己處理掉建議——⛔ 沒有這個的話，按掉最後一條之後畫面會
 *  說「這次掃描沒有發現主題」，但它明明有發現，是你剛處理完（等於系統在說謊） */
const discoveryHandledThisVisit = ref(false)
/**
 * 查過了沒。⛔ 三態：沒有這個旗標的話，「還沒查完」和「查完沒建議」在畫面上
 * 長得一樣，那行說明會在載入中就先閃一下（也就是 08-09 拍板的「查不到≠沒問題」）。
 */
const discoveryLoaded = ref(false)

/** 那行小字的內容：全部交給純函式決定（可測），模板只負責印 */
/**
 * 細條第二行的事實：上次掃描什麼時候、下次自動掃描落在哪天、有沒有正在排隊。
 * ⛔ 和上面那句分開：上面是**結論**（有沒有發現、是不是壞了），這行是**時間**。
 *    混成一句話會變成一段沒人讀得完的長字串。
 * 回 null＝這個情境沒有誠實的時間可講（功能關著、或從沒成功掃過），整行不出現。
 */
const discoveryTimingText = computed(() => discoveryTiming({
  enabled: discoveryEnabled.value,
  lastScanMs: discoveryLastScanMs.value,
  rescanRequestedMs: discoveryRescanRequestedMs.value,
}))

const discoveryIdle = computed(() => discoveryState({
  enabled: discoveryEnabled.value,
  lastScanMs: discoveryLastScanMs.value,
  stalled: discoveryStalled.value,
  handledThisVisit: discoveryHandledThisVisit.value,
  lastScan: discoveryLastScan.value,
}))

/** 「還可以被 AI 再提一次」的只有沒撤回過的忽略；採用過的標籤已經存在，不會也不該再提 */
function canUndoDismiss(h: TagDiscoveryDecision) {
  return h.action === 'dismiss' && !h.undoneAtMs
}

/**
 * 載入失敗＝把 loaded 收回 false，那行說明就不出現。
 * ⛔ 只清空清單是不夠的：現在雖然只在 onMounted 呼叫一次、失敗剛好不會出事，
 *    但只要有人加一個「採用後重新載入」或輪詢，失敗的那次就會變成
 *    「上次掃描：X，這次沒有發現新主題」——網路錯誤被講成掃描結果（08-09 三態鐵律）。
 */
async function loadDiscovery() {
  try {
    const res = await apiFetch<{
      pending: DiscoveryRow[]
      enabled: boolean
      lastScanMs: number
      rescanRequestedMs?: number
      stalled: boolean
      lastScan?: DiscoveryScanOutcome | null
      history?: TagDiscoveryDecision[]
    }>('/api/tag/discovery')
    discoveryPending.value = res.pending ?? []
    discoveryEnabled.value = res.enabled === true
    discoveryLastScanMs.value = Number(res.lastScanMs ?? 0)
    discoveryRescanRequestedMs.value = Number(res.rescanRequestedMs ?? 0)
    discoveryStalled.value = res.stalled === true
    discoveryLastScan.value = res.lastScan ?? null
    discoveryHistory.value = res.history ?? []
    discoveryLoaded.value = true
  }
  catch {
    discoveryPending.value = []
    discoveryLastScan.value = null
    discoveryHistory.value = []
    discoveryLoaded.value = false
  }
}

/**
 * 取消忽略：把否決票撤回，讓這個主題**有機會**再被提。
 *
 * ⛔ 文案不可以講成「已還原這條建議」——建議沒有回來（決策紀錄刻意不存客人名單，
 * 見 shared 的欄位註解）。真正發生的是「下次掃描時它可以再被提」，
 * 而如果聊過的客人已經散掉、或超出兩週窗口，它就不會回來。講白比講好聽重要。
 */
async function undoDismiss(h: TagDiscoveryDecision) {
  if (!assertCanOperate()) return
  undoingDismiss.value = h.id
  try {
    await apiFetch('/api/tag/discovery', {
      method: 'POST',
      body: { action: 'undo-dismiss', proposalId: h.id },
    })
    showToast(`已取消忽略「${h.name}」，下次掃描如果還有客人在聊就會再提一次`, 'success')
    await loadDiscovery()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '取消忽略失敗', 'error')
  }
  finally {
    undoingDismiss.value = ''
  }
}

async function actOnDiscovery(p: DiscoveryRow, action: 'adopt' | 'dismiss') {
  if (!assertCanOperate()) return
  discoveryActing.value = p.id
  try {
    const res = await apiFetch<{ created?: { name: string }; tagged?: number; dismissed?: boolean }>(
      '/api/tag/discovery',
      { method: 'POST', body: { action, proposalId: p.id } },
    )
    if (action === 'adopt') {
      showToast(`已建立「${res.created?.name ?? p.name}」並幫 ${res.tagged ?? 0} 位客人貼上（AI 先建議模式）`, 'success')
      await refreshTags() // 新標籤要馬上出現在下面的表格裡
    }
    else {
      showToast('已忽略，之後不會再建議這個主題', 'success')
    }
    discoveryPending.value = discoveryPending.value.filter((row: DiscoveryRow) => row.id !== p.id)
    discoveryHandledThisVisit.value = true
    // 決策紀錄是後端寫的（含採用後補上的標籤連結與實際貼上人數）→ 重新載入才看得到這筆
    await loadDiscovery()
  }
  catch (e: any) {
    // 404＝同事剛處理掉了：把這條從畫面拿掉並講原因，不是報錯了事
    if (e?.status === 404 || e?.statusCode === 404) {
      discoveryPending.value = discoveryPending.value.filter((row: DiscoveryRow) => row.id !== p.id)
      showToast('這條建議剛被同事處理過了', 'warning')
    }
    else {
      showToast(e?.data?.statusMessage || '操作失敗', 'error')
    }
  }
  finally {
    discoveryActing.value = ''
  }
}

function formatMemberCount(count: number | undefined) {
  return (count ?? 0).toLocaleString('zh-TW')
}

/** 點「好友數」→ 好友頁並自動套上這顆標籤的篩選（那頁 onMounted 會讀 ?tagIds=） */
function goTaggedFriends(tagId: string) {
  navigateTo(`/admin/${workspaceId.value}/users?tagIds=${encodeURIComponent(tagId)}`)
}

/* ── 每顆標籤還有幾位客人等人決定（D-42②）──────────────────────
   為什麼要放在這一頁：「這顆 AI 判得準不準、要不要升級成直接貼」是在這頁做的判斷，
   但待審清單長在好友頁——這個數字就是把「那邊有事等你」搬到做決定的地方。
   ⛔ 三態不可省：載入失敗時**不可以顯示 0**（那等於謊稱沒事要處理），整欄不出現＋上方講一句。 */
const pendingCounts = ref<Record<string, number>>({})
const pendingCountsLoaded = ref(false)
const pendingCountsFailed = ref(false)
/** 掃描撞到上限＝數字會低報，一定要講出來（見端點的 SCAN_LIMIT 註解） */
const pendingCountsTruncated = ref(false)

function pendingCountFor(tagId: string): number {
  return pendingCounts.value[tagId] ?? 0
}

async function loadPendingCounts() {
  try {
    const res = await apiFetch<{ counts: Record<string, number>, truncated: boolean }>('/api/tag/pending-counts')
    pendingCounts.value = res.counts ?? {}
    pendingCountsTruncated.value = res.truncated === true
    pendingCountsFailed.value = false
  }
  catch {
    // 讀不到就整欄不出現：待審是輔助資訊，讀失敗不該讓標籤頁壞掉，但也不能假裝是 0
    pendingCounts.value = {}
    pendingCountsFailed.value = true
  }
  finally {
    pendingCountsLoaded.value = true
  }
}

/**
 * 點「待審 N 位」→ 好友頁的 AI 建議收件匣。
 *
 * ⚠️ **第一版只篩得到「有建議的客人」，不是「有這顆標籤建議的客人」**（D-42 拍板的簡單版）：
 * 建議存在「一位客人一份」的文件裡，要按標籤反查得先補鏡像欄位。所以帶著 `fromTag`
 * 過去，讓那頁講明白「你從哪顆標籤過來、為什麼看到的人比 N 多」——⛔ 不講的話
 * 就是一個對不上的數字（正是 D-41 整份報告在抓的那種病）。
 */
function goPendingFriends(tagId: string) {
  navigateTo(`/admin/${workspaceId.value}/users?suggested=1&fromTag=${encodeURIComponent(tagId)}`)
}

function tagListQuery(targetPage = page.value) {
  return {
    page: targetPage,
    limit: pageSize.value,
    includeMemberCount: true,
    status: filterStatus.value || undefined,
    category: filterCategory.value || undefined,
    aiMode: filterAiMode.value || undefined,
    search: searchText.value,
  }
}

async function reloadTags(resetPage = false) {
  const targetPage = resetPage ? 1 : page.value
  const ok = await loadTags(tagListQuery(targetPage))
  if (!ok) showToast('載入標籤失敗', 'error')
}

async function refreshTags() {
  await reloadTags()
}

async function onPageChange(nextPage: number) {
  await loadTags(tagListQuery(nextPage))
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch([filterStatus, filterCategory, filterAiMode], () => {
  void reloadTags(true)
})
watch(searchText, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void reloadTags(true), 300)
})

function openCreate() {
  isEditing.value = false
  form.value = defaultForm()
  dialogVisible.value = true
}

function openEdit(tag: any) {
  isEditing.value = true
  form.value = {
    id: tag.id,
    code: tag.code,
    name: tag.name,
    category: (tag.category ?? 'custom') as any,
    color: tag.color ?? '#6B7280',
    description: tag.description ?? '',
    // 舊標籤沒有這兩欄＝off（跟後端與掃描器同一個口徑）
    aiMode: (tag.aiMode === 'suggest' || tag.aiMode === 'auto' ? tag.aiMode : 'off') as TagAiMode,
    aiCriteria: tag.aiCriteria ?? '',
    status: tag.status === 'inactive' ? 'inactive' : 'active',
  }
  dialogVisible.value = true
}

function validateForm(): string | null {
  if (!form.value.code.trim()) return '請填寫 Code'
  if (!/^[a-z][a-z0-9_]*$/.test(form.value.code)) return 'Code 格式錯誤（英文小寫開頭，可含數字與底線）'
  if (!form.value.name.trim()) return '請填寫顯示名稱'
  if (!form.value.category) return '請選擇分類'
  return null
}

async function submitForm() {
  if (!assertCanOperate()) return
  const err = validateForm()
  if (err) return showToast(err, 'error')
  saving.value = true
  try {
    if (isEditing.value) {
      await apiFetch(`/api/tag/${form.value.id}`, {
        method: 'PUT',
        body: {
          name: form.value.name.trim(),
          category: form.value.category,
          color: form.value.color,
          description: form.value.description.trim(),
          aiMode: form.value.aiMode,
          aiCriteria: form.value.aiCriteria.trim(),
          status: form.value.status,
        },
      })
      showToast('標籤已更新', 'success')
    }
    else {
      await apiFetch('/api/tag/create', {
        method: 'POST',
        body: {
          code: form.value.code.trim(),
          name: form.value.name.trim(),
          category: form.value.category,
          color: form.value.color,
          description: form.value.description.trim(),
          aiMode: form.value.aiMode,
          aiCriteria: form.value.aiCriteria.trim(),
          status: form.value.status,
        },
      })
      showToast('標籤已建立', 'success')
    }
    dialogVisible.value = false
    await refreshTags()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

onMounted(() => {
  /**
   * `?aiMode=` 深連結（例：`…/tags?aiMode=auto` 直接落在「AI 直接貼」那幾顆）。
   *
   * ⛔ 這條**先前是假的**：`shared/tag-admin.ts` 的註解寫著「深連結不受影響」，
   * 但這一頁從頭到尾沒有讀過網址參數，帶了也是整份未篩選的清單。
   * 補上之後那句話才成立，小幫手／週報也才有路可以直接指到「風險最高的那幾顆」。
   * ⛔ 認不得的值當沒帶：否則打錯字會篩出一片空白，看起來像「一顆都沒有」。
   */
  const q = useRoute().query.aiMode
  if (isTagAiFilterValue(q)) filterAiMode.value = q

  void reloadTags(true)
  void loadDiscovery()
  // ⛔ 一次就好，不要跟著分頁／篩選重打：它是「全工作區的待審」，跟畫面上看哪幾顆無關
  void loadPendingCounts()
})
</script>
