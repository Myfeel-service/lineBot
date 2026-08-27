<template>
  <AdminSplitLayout :is-empty="!selectedScript && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title">自動回應<AdminPageHelpButton :topics="['ai-scripts']" /></span>
      <el-button v-if="canEditScripts" :icon="Plus" type="primary" size="small" data-tour="scr-new" @click="openCreate">新增</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <div v-if="loading && !scripts.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!scripts.length" class="split-sidebar-empty">
        <span>尚無客服流程</span>
        <p class="text-xs text-muted">建一條情境流程，把多步驟客服變成自動流程</p>
        <el-button v-if="canEditScripts" size="small" type="primary" plain @click="openCreate">立即新增</el-button>
      </div>
      <div v-else ref="listEl" class="split-list" data-tour="scr-list" @scroll.passive="onSidebarListScroll">
        <AdminSplitListItem
          v-for="script in scripts"
          :key="script.id"
          :title="script.name || '(未命名流程)'"
          :active="selectedId === script.id"
          time-in-title-row
          title-row-chip
          :chip-text="script.enabled ? '啟用' : '停用'"
          :chip-tone="script.enabled ? 'success' : 'neutral'"
          :meta-text="triggerSummary(script)"
          :meta-truncate="true"
          @select="selectScript(script)"
        />
        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
        </div>
      </div>
    </template>

    <!-- ── Empty State ── -->
    <template #editor-empty>
      <el-icon class="empty-icon"><Operation /></el-icon>
      <h3>選擇一條客服流程開始{{ canEditScripts ? '編輯' : '檢視' }}</h3>
      <template v-if="canEditScripts">
        <div class="scripts-ai-generate" data-tour="scr-ai-gen">
          <span class="scripts-ai-generate-label">
            <el-icon><MagicStick /></el-icon> 用一句話描述，AI 幫你搭草稿
          </span>
          <el-input
            v-model="aiGenDesc"
            type="textarea"
            :rows="2"
            maxlength="500"
            placeholder="例：客人要退貨時，先問訂單編號和退貨原因，再請專員處理"
            @keydown.enter.exact.prevent="generateFromAi"
          />
          <div class="scripts-ai-generate-actions">
            <span class="text-xs text-muted">生成後會先進編輯器讓你檢查，按「建立客服流程」才會存檔</span>
            <el-button type="primary" :loading="aiGenerating" :disabled="!aiGenDesc.trim()" @click="generateFromAi">
              {{ aiGenerating ? 'AI 生成中…' : 'AI 生成草稿' }}
            </el-button>
          </div>
        </div>
        <p>從範本快速建立，或點「從空白開始」自己組</p>
        <div class="scripts-template-gallery" data-tour="scr-templates">
          <button
            v-for="tpl in scriptTemplates"
            :key="tpl.key"
            type="button"
            class="scripts-template-card"
            @click="createFromTemplate(tpl)"
          >
            <span class="scripts-template-card__title">{{ tpl.label }}</span>
            <span class="scripts-template-card__desc">{{ tpl.description }}</span>
          </button>
        </div>
        <el-button text @click="openCreate">從空白開始</el-button>
      </template>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <AdminEditorHeaderTitle
        v-model="form.name"
        field-label="流程名稱"
        create-prefix="新增客服流程："
        placeholder="例：訂單查詢、退換貨流程"
        caption="為這條情境流程取個名"
        :is-creating="isCreating"
        @enter="submitForm"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button v-if="canEditScripts && !isCreating && selectedScript" :icon="CopyDocument" @click="duplicateScript">複製一份</el-button>
        <el-button v-if="canEditScripts && !isCreating && selectedScript" :icon="Delete" type="danger" @click="deleteScript">刪除</el-button>
        <el-button @click="cancelEdit">{{ canEditScripts ? '取消' : '關閉' }}</el-button>
        <el-button v-if="canEditScripts" type="primary" :loading="saving" @click="submitForm">
          {{ isCreating ? '建立客服流程' : '儲存變更' }}
        </el-button>
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <div class="ai-scripts-body admin-panel-stack">
        <!--
          健康狀態 + 流程圖：吸頂常駐。刻意不放進 .message-card——那個共用卡為了裁切圓角
          設了 overflow:hidden，裡面的 sticky 會直接失效。
          這兩件事都是「編到第 5 個步驟時才真的需要」，捲走了等於在需要它的時候看不到。
        -->
        <div class="scripts-overview">
          <!--
            即時檢查：三件事疊在同一條線上才敢亮綠燈——
            ① 接線合法（擋存檔，沿用後端同一套 validateScriptDoc）
            ② 每一題走得完（findStuckCollects：問代碼類資料又沒退路＝客人被無限重問）
            ③ 這條腳本輪得到（findUnreachableScripts：撞到敏感情境詞或被別條腳本包住會無聲失效）
            只驗①的綠燈會保證它沒檢查過的事——正式站的「查詢訂單」接線全對，客人卻走不出去。
          -->
          <div v-if="flowIssue" class="scripts-flow-status is-error">
            <el-icon><CircleCloseFilled /></el-icon>
            <span>還差一步：{{ flowIssue }}</span>
          </div>
          <div v-for="w in flowWarnings" :key="w.key" class="scripts-flow-status is-warn">
            <el-icon><WarningFilled /></el-icon>
            <span>{{ w.text }}</span>
            <el-button v-if="w.nodeId" size="small" text type="primary" class="scripts-flow-status-action" @click="focusStep(w.nodeId)">去看這一題</el-button>
          </div>
          <div v-if="!flowIssue && !flowWarnings.length" class="scripts-flow-status is-ok">
            <el-icon><CircleCheckFilled /></el-icon>
            <span>{{ allClearText }}</span>
          </div>

          <!-- 流程圖：即時把整條流程畫出來，分支往內縮一層、一眼看懂走向。
               一步就結束的設定沒有「流向」可看，畫出來只是兩個框，不顯示。 -->
          <div v-if="flowRows.length && !isSimpleMode" class="scripts-flow-map">
            <div class="scripts-flow-map-head">
              <span class="scripts-flow-map-title">流程圖</span>
              <span class="text-xs text-muted">即時預覽・點步驟可跳到下面編輯</span>
            </div>
            <div class="scripts-flow-rows">
              <div
                v-for="row in flowRows"
                :key="row.key"
                class="scripts-flow-row"
                :class="[`scripts-flow-row--${row.kind}`, { 'is-indented': row.depth > 0 }]"
                :style="row.depth ? { marginInlineStart: `${row.depth * 22}px` } : undefined"
              >
                <span
                  v-if="row.kind === 'node'"
                  class="scripts-flow-box is-clickable"
                  :class="[nodeBadgeClass(row.type ?? 'reply'), { 'is-flagged': flaggedNodeIds.has(row.id ?? '') }]"
                  role="button"
                  tabindex="0"
                  @click="focusStep(row.id)"
                  @keydown.enter="focusStep(row.id)"
                >
                  <el-icon><component :is="nodeIcon(row.type ?? 'reply')" /></el-icon>
                  <b>{{ row.title }}</b>
                  <span v-if="row.sub" class="scripts-flow-sub">{{ row.sub }}</span>
                  <!-- 有問題的步驟標一顆黃點，跟上面那條狀態列同一套訊號（走不完、代號撞名…） -->
                  <span v-if="flaggedNodeIds.has(row.id ?? '')" class="scripts-flow-flag" title="這一步有要處理的問題，看上面的提醒">⚠</span>
                </span>
                <span v-else-if="row.kind === 'label'" class="scripts-flow-label">{{ row.title }}</span>
                <span v-else class="scripts-flow-note">{{ row.title }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 啟用 + 優先度 -->
        <div class="message-card scripts-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">基本設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- 成效：完成率是這頁最重要的數字，獨立成一列並在偏低時把「代表什麼」講出來 -->
            <div v-if="stats" class="scripts-stats" :class="{ 'is-warn': stats.rate < LOW_COMPLETION_RATE }">
              <div class="scripts-stats-figure">
                <span class="scripts-stats-value">{{ stats.rate }}%</span>
                <span class="scripts-stats-caption">的客人走完整條流程</span>
              </div>
              <p class="scripts-stats-detail">
                {{ stats.starts }} 個客人走進這條流程，{{ stats.completions }} 個走到最後一步。
                <template v-if="stats.dropped">
                  另外 {{ stats.dropped }} 個中途離開<template v-if="stats.rate < LOW_COMPLETION_RATE">——多半是卡在某一題答不出來，看看下面有沒有需要加退路的步驟</template>。
                </template>
              </p>
            </div>

            <div class="admin-field-group">
              <AdminFieldLabel text="啟用這條流程" tight />
              <el-switch
                v-model="form.enabled"
                active-text="啟用"
                inactive-text="停用"
              />
              <p class="scripts-section-hint">關掉後這條流程就不會啟動；就算關掉，AI 客服還是會照常回答客人。</p>
            </div>

            <!-- 優先度：說明本身就寫「通常不用動」，預設收起來不佔版面 -->
            <div class="scripts-advanced">
              <button type="button" class="scripts-inline-toggle" @click="showAdvanced = !showAdvanced">
                {{ showAdvanced ? '收起進階設定' : `進階設定（觸發優先度 ${form.priority}）` }}
              </button>
              <div v-if="showAdvanced" class="admin-field-group">
                <AdminFieldLabel :text="`觸發優先度（${form.priority}）`" tight />
                <el-slider v-model="form.priority" :min="1" :max="100" :step="1" />
                <p class="scripts-section-hint">如果同一句話同時命中好幾條流程，數字越大的會先跑。預設 50，通常不用動。</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 節點清單。
             一步就結束的設定（＝舊的「自動回覆」）走簡單模式：不出現流程圖、步驟徽章、
             接線提示與積木選單——那些是「多步驟」才需要的東西，擺在一句話的設定上只是噪音。
             加了第三步之後同一筆設定就地長成完整編輯器，不用換地方重做。 -->
        <div class="message-card scripts-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">{{ isSimpleMode ? '內容' : '流程步驟' }}</span>
              <span class="text-xs text-muted">{{ isSimpleMode ? '客人說什麼 → 你回什麼' : '流程：觸發 → 收集（可多個）→ 回覆' }}</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="scripts-node-list">
              <div v-for="node in form.nodes" :key="node.id" class="scripts-node-card" :class="{ 'is-focused': highlightStep === node.id, 'is-plain': isSimpleMode }" :data-node-id="node.id">
                <div v-if="isSimpleMode" class="scripts-simple-heading">{{ simpleSectionTitle(node) }}</div>
                <div v-else class="scripts-node-header">
                  <span class="scripts-node-badge" :class="nodeBadgeClass(node.type)">
                    <el-icon><component :is="nodeIcon(node.type)" /></el-icon> {{ nodeTypeLabel(node.type) }}
                  </span>
                  <span v-if="nodeHeaderHint(node)" class="text-xs text-muted">{{ nodeHeaderHint(node) }}</span>
                  <el-button
                    v-if="node.type !== 'trigger'"
                    size="small"
                    type="danger"
                    plain
                    class="scripts-node-delete"
                    @click="removeNode(node.id)"
                  >
                    移除
                  </el-button>
                </div>
                <p v-if="!isSimpleMode" class="scripts-node-purpose">{{ nodePurpose(node.type) }}</p>

                <!-- Trigger -->
                <template v-if="node.type === 'trigger'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="觸發方式" tight />
                    <el-radio-group
                      :model-value="triggerUiMode(node)"
                      size="small"
                      @change="setTriggerMode(node, $event)"
                    >
                      <el-radio-button value="keyword">關鍵字</el-radio-button>
                      <el-radio-button value="semantic">看意思</el-radio-button>
                      <el-radio-button value="follow">客人加好友時</el-radio-button>
                    </el-radio-group>
                  </div>

                  <template v-if="triggerUiMode(node) === 'follow'">
                    <p class="scripts-section-hint">
                      客人把這個官方帳號加為好友（含封鎖後再解除）的那一刻就會走這條流程，不用打任何字。一個帳號只能有一條這樣設定的流程。
                    </p>
                    <!-- 與 LINE 內建歡迎訊息打對台：兩邊都開＝客人一加好友連收兩份 -->
                    <el-alert
                      type="info"
                      :closable="false"
                      show-icon
                      title="LINE 內建的「加入好友的歡迎訊息」記得關掉"
                      description="LINE 官方帳號後台（LINE Official Account Manager）本身也有一則內建的歡迎訊息，兩邊都開的話，客人一加好友會連收兩份。請到那個後台把「加入好友的歡迎訊息」關閉，只留這一條。"
                    />
                  </template>

                  <template v-else-if="triggerUiMode(node) === 'keyword'">
                    <div class="admin-field-group">
                      <AdminFieldLabel text="怎麼比對" tight />
                      <el-select :model-value="node.keywordMatch ?? 'any'" class="control-full" @change="node.keywordMatch = $event">
                        <el-option v-for="m in KEYWORD_MATCH_OPTIONS" :key="m.value" :label="m.label" :value="m.value" />
                      </el-select>
                      <!-- 和自動回覆同一個陷阱：這種設定排在 AI 前面，開著等於把 AI 整個關掉 -->
                      <el-alert
                        v-if="node.keywordMatch === 'anyText'"
                        type="warning"
                        :closable="false"
                        show-icon
                        title="這條啟用後，會攔截「所有」文字訊息"
                        description="客人不管打什麼都會走進這條流程，AI 客服和其他客服流程都收不到訊息、完全失效，而且不會有任何錯誤提示。除非你是刻意要暫停 AI，否則建議改用「含任一關鍵字」。"
                      />
                    </div>
                    <div v-if="node.keywordMatch !== 'anyText'" class="admin-field-group">
                      <AdminFieldLabel text="關鍵字" tight />
                      <el-input
                        :model-value="node.keywords.join('，')"
                        :placeholder="keywordPlaceholder(node)"
                        @update:model-value="updateKeywords(node, $event)"
                      />
                      <!--
                        打字當下就講（D-33 P1）：太短或太常見的關鍵字會攔到一大堆不相關的訊息
                        （`C-25` 那場「觸發詞劫持」就是人手設的）。⛔只提醒不阻擋——
                        既有腳本可能刻意這樣設，回頭報錯會擋住本來好好在跑的東西。
                      -->
                      <el-alert
                        v-if="riskyKeywordsOf(node).length"
                        type="warning"
                        :closable="false"
                        show-icon
                        :title="`「${riskyKeywordsOf(node).join('、')}」太常見了，會攔到很多不相關的訊息`"
                        description="關鍵字是「訊息裡有這幾個字就攔走」，例如設「問題」，客人打「我的訂單有問題」也會被這條接走、AI 就答不到了。建議改成這條流程專屬的具體詞（兩個字以上）。"
                      />
                    </div>
                  </template>

                  <template v-else>
                    <div class="admin-field-group">
                      <AdminFieldLabel text="範例句（一行一句；比對的是「意思」，就算客人用字不一樣也算命中）" tight />
                      <el-input
                        :model-value="(node.examples ?? []).join('\n')"
                        type="textarea"
                        :rows="4"
                        placeholder="例：&#10;我要退貨&#10;不想要了想退&#10;能不能取消訂單"
                        @update:model-value="updateExamples(node, $event)"
                      />
                    </div>
                    <p class="scripts-section-hint">
                      不用列出所有講法——填 3～5 句不同說法即可，客人用相近意思的話也會觸發（最多 {{ MAX_TRIGGER_EXAMPLES }} 句）。
                    </p>
                  </template>

                  <!-- 防重複觸發（＝自動回覆的冷卻）。多數流程用不到，沒設時只留一顆鈕 -->
                  <div v-if="node.cooldownMs !== undefined" class="admin-field-group">
                    <AdminFieldLabel text="防重複觸發（選填）" tight />
                    <div class="scripts-branch-case scripts-branch-case--route">
                      <span class="text-xs text-muted">間隔</span>
                      <el-select :model-value="node.cooldownMs" class="scripts-branch-field" @change="node.cooldownMs = $event">
                        <el-option v-for="o in COOLDOWN_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
                      </el-select>
                      <span class="text-xs text-muted">內不再接</span>
                      <span />
                      <el-button type="danger" plain class="scripts-branch-remove" title="取消防重複觸發" @click="clearCooldown(node)">✕</el-button>
                    </div>
                    <p class="scripts-section-hint">
                      {{ triggerUiMode(node) === 'follow'
                        ? '同一位客人在這段時間內封鎖又解除、再次加好友，也不會再收到一次這條流程。'
                        : '同一位客人在這段時間內又打中觸發詞，也不會再走一次這條流程（會改由 AI 回答）。' }}
                    </p>
                  </div>
                  <button v-else type="button" class="scripts-skip-add" @click="enableCooldown(node)">
                    ＋ 設定防重複觸發（同一位客人隔多久才能再走一次）
                  </button>

                  <div v-if="triggerUiMode(node) !== 'follow'" class="admin-field-group scripts-trigger-test-group">
                    <AdminFieldLabel text="測試觸發（打一句話，看會不會啟動這條流程）" tight />
                    <el-input :model-value="triggerTest" placeholder="例：東西壞了想退" clearable @update:model-value="triggerTest = $event" />
                    <p v-if="triggerTestResult(node).state !== 'idle'" class="scripts-trigger-test" :class="`is-${triggerTestResult(node).state}`">
                      {{ triggerTestResult(node).state === 'hit' ? '✓ ' : triggerTestResult(node).state === 'maybe' ? '≈ ' : '✗ ' }}{{ triggerTestResult(node).text }}
                    </p>
                  </div>
                </template>

                <!-- Collect -->
                <template v-else-if="node.type === 'collect'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="問題（要問使用者的話）" tight />
                    <el-input v-model="node.question" placeholder="例：請輸入您的訂單編號" />
                  </div>
                  <!-- 這一題問的是什麼：選常用欄位就自動帶好問句、格式與代號，
                       不用開店的人自己想出 order_id 這種 snake_case 識別字 -->
                  <div class="admin-field-group">
                    <AdminFieldLabel text="這一題問的是" tight />
                    <el-select :model-value="presetKeyOf(node)" placeholder="選一個" class="control-full" @change="applyFieldPreset(node, $event)">
                      <el-option v-for="p in COMMON_COLLECT_FIELDS" :key="p.key" :label="p.label" :value="p.key" />
                      <el-option label="其他（自己命名）" value="__custom" />
                    </el-select>
                    <el-input
                      v-if="presetKeyOf(node) === '__custom'"
                      v-model="node.fieldName"
                      placeholder="給這個答案取個代號，例：order_id"
                      @focus="fieldRenameFrom = node.fieldName"
                      @change="renameCollectField(node, fieldRenameFrom)"
                    />
                    <p v-if="node.fieldName.trim()" class="scripts-section-hint">💡 之後在「回覆」步驟可以用 <b>{{ varLabel(node.fieldName) }}</b> 帶入客人的答案</p>
                  </div>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="答案格式（系統會自動從客人訊息抓出答案；格式不對會再問一次）" tight />
                    <el-select :model-value="node.format ?? 'any'" size="small" @change="node.format = $event">
                      <el-option label="不限制（整句存）" value="any" />
                      <el-option label="電話" value="phone" />
                      <el-option label="Email" value="email" />
                      <el-option label="純數字" value="number" />
                      <el-option label="英文＋數字（例：A123456）" value="alphanumeric" />
                      <el-option label="英文＋數字＋符號（例：OD-2024/001）" value="alphanumericSymbol" />
                      <el-option label="自訂（進階比對規則）" value="custom" />
                    </el-select>
                  </div>
                  <div v-if="node.format === 'custom'" class="admin-field-group">
                    <AdminFieldLabel text="自訂格式（進階比對規則，需懂正規表達式；不確定可先用上面的預設格式）" tight>
                      自訂格式（進階比對規則）
                      <!-- 標籤自己寫著「需懂正規表達式」＝已經承認是術語，那就得給出口（D-33 P1） -->
                      <AdminFieldHelp id="scriptCustomFormat" />
                    </AdminFieldLabel>
                    <el-input v-model="node.pattern" placeholder="例：[A-Za-z]\d{3,}（訂單編號 A123）" />
                  </div>
                  <div v-if="(node.format ?? 'any') !== 'any'" class="admin-field-group">
                    <AdminFieldLabel text="格式不符時的重問話術（可留空用預設）" tight />
                    <el-input v-model="node.reaskText" placeholder="例：訂單編號好像怪怪的，可以再確認一次嗎？" />
                  </div>
                  <!--
                    答不出來的退路：八成的收集步驟用不到，所以沒設定時只留一顆按鈕，不永遠佔一整塊。
                    問代碼類資料（訂單編號、序號…）又沒設時，按鈕改成帶語氣的建議——判斷用 findStuckCollects，
                    跟小幫手異常中心同一支函式，不會出現「這裡說沒事、那裡報警」的兩套標準。
                  -->
                  <div v-if="isSkipOpen(node)" class="admin-field-group">
                    <AdminFieldLabel text="答不出來的退路（選填）" tight />
                    <div class="scripts-branch-case scripts-branch-case--route">
                      <span class="text-xs text-muted">按鈕</span>
                      <el-input v-model="node.skipLabel" maxlength="20" placeholder="例：我沒有訂單編號" class="scripts-branch-field" />
                      <span class="text-xs text-muted scripts-branch-arrow">→</span>
                      <el-select :model-value="node.skipNext ?? ''" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, node.skipNext ?? '', (id) => node.skipNext = id)">
                        <el-option v-for="t in targetOptions(node.id)" :key="t.value" :label="t.label" :value="t.value" />
                        <el-option-group label="接下一步（會新增一個步驟）">
                          <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                        </el-option-group>
                      </el-select>
                      <el-button type="danger" plain class="scripts-branch-remove" title="移除這條退路" @click="clearCollectSkip(node)">✕</el-button>
                    </div>
                    <p class="scripts-section-hint">
                      問這一題時會多這顆按鈕，點了就改走你指定的那一步。
                      想給客人「好幾個」選擇？把「前往」指到一個<b>快速回覆</b>步驟，按鈕要幾顆都行。
                    </p>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="scripts-skip-add"
                    :class="{ 'is-suggested': isStuckCollect(node) }"
                    @click="openCollectSkip(node)"
                  >
                    <template v-if="isStuckCollect(node)">
                      ⚠ 這種編號客人手上可能根本沒有，沒退路會被一直重問　<b>＋ 加一條退路</b>
                    </template>
                    <template v-else>
                      ＋ 加一條退路（客人答不出來時）
                    </template>
                  </button>
                </template>

                <!-- Reply -->
                <template v-else-if="node.type === 'reply'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="回覆文字（可插入收集到的欄位）" tight />
                    <el-input
                      v-model="node.text"
                      type="textarea"
                      :rows="3"
                      placeholder="例：已收到您的訂單，將盡快為您處理 🙇"
                    />
                    <el-dropdown
                      v-if="collectFieldOptions.length"
                      size="small"
                      trigger="click"
                      class="scripts-var-insert"
                      @command="(f) => insertReplyVar(node, f)"
                    >
                      <el-button size="small" plain>＋ 插入欄位變數 ▾</el-button>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item v-for="f in collectFieldOptions" :key="f.value" :command="f.value">
                            {{ varLabel(f.value) }}
                          </el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </div>
                  <!-- 連結按鈕（＝自動回覆的「開啟網址」）。多數回覆用不到，沒設定時只留一顆鈕 -->
                  <div v-if="node.linkUrl !== undefined" class="admin-field-group">
                    <AdminFieldLabel text="附一顆連結按鈕（選填）" tight />
                    <div class="scripts-branch-case scripts-branch-case--map">
                      <span class="text-xs text-muted">網址</span>
                      <el-input v-model="node.linkUrl" placeholder="https://…（可用 {{ 欄位 }} 帶入答案）" class="scripts-branch-field" />
                      <span class="text-xs text-muted">按鈕字</span>
                      <el-input v-model="node.linkLabel" maxlength="20" :placeholder="DEFAULT_REPLY_LINK_LABEL" class="scripts-branch-field" />
                      <el-button type="danger" plain class="scripts-branch-remove" title="移除連結按鈕" @click="clearReplyLink(node)">✕</el-button>
                    </div>
                    <p class="scripts-section-hint">會在回覆文字下面多送一則帶按鈕的訊息。網址要以 https:// 開頭。</p>
                  </div>
                  <button v-else type="button" class="scripts-skip-add" @click="node.linkUrl = ''">
                    ＋ 附一顆連結按鈕
                  </button>

                  <div class="admin-field-group">
                    <AdminFieldLabel text="回覆後直接轉真人" tight />
                    <el-switch v-model="node.thenHandoff" active-text="開" inactive-text="關" />
                  </div>
                </template>

                <!-- Branch -->
                <template v-else-if="node.type === 'branch'">
                  <p class="scripts-section-hint">依照前面問到的答案決定接下來走哪條路。由上往下檢查，第一個符合的條件就走它。</p>
                  <div v-for="(c, ci) in node.cases" :key="ci" class="scripts-branch-case scripts-branch-case--cond">
                    <span class="text-xs text-muted">如果</span>
                    <el-select :model-value="c.field" filterable placeholder="選欄位" class="scripts-branch-field" @change="c.field = $event">
                      <el-option v-for="f in collectFieldOptions" :key="f.value" :label="f.label" :value="f.value" />
                    </el-select>
                    <el-select :model-value="c.op" class="scripts-branch-op" @change="setBranchOp(c, $event)">
                      <el-option label="有填寫" value="exists" />
                      <el-option label="等於" value="equals" />
                      <el-option label="包含" value="contains" />
                    </el-select>
                    <!-- 「有填寫」不需要比較值，但格子要留著：同一張卡裡幾條條件混用時，
                         欄數一變，後面的「→」和「前往」就會在各列之間左右錯開。 -->
                    <span class="scripts-branch-value">
                      <el-input v-if="c.op !== 'exists'" v-model="c.value" placeholder="比較值" />
                    </span>
                    <span class="text-xs text-muted scripts-branch-arrow">→</span>
                    <el-select :model-value="c.next" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, c.next, (id) => c.next = id)">
                      <el-option v-for="o in targetOptions(node.id)" :key="o.value" :label="o.label" :value="o.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                    <el-button type="danger" plain class="scripts-branch-remove" @click="removeBranchCase(node, ci)">✕</el-button>
                  </div>
                  <el-button size="small" plain @click="addBranchCase(node)">＋ 新增條件</el-button>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="其餘情況（都不符合時）→ 前往" tight />
                    <el-select :model-value="node.defaultNext" placeholder="前往…" @change="onTargetChange($event, node.defaultNext, (id) => node.defaultNext = id)">
                      <el-option v-for="o in targetOptions(node.id)" :key="o.value" :label="o.label" :value="o.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                  </div>
                </template>

                <!-- Quick reply -->
                <template v-else-if="node.type === 'quickReply'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="問句（出選項時一起送）" tight />
                    <el-input v-model="node.question" placeholder="例：請問需要哪項服務？" />
                  </div>
                  <p class="scripts-section-hint">客人點按鈕即走對應路線（按鈕文字就是送出的文字）。</p>
                  <div v-for="(o, oi) in node.options" :key="oi" class="scripts-branch-case scripts-branch-case--route">
                    <span class="text-xs text-muted">按鈕</span>
                    <el-input v-model="o.label" placeholder="按鈕文字（≤20 字）" class="scripts-branch-field" />
                    <span class="text-xs text-muted scripts-branch-arrow">→</span>
                    <el-select :model-value="o.next" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, o.next, (id) => o.next = id)">
                      <el-option v-for="t in targetOptions(node.id)" :key="t.value" :label="t.label" :value="t.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                    <el-button type="danger" plain class="scripts-branch-remove" @click="removeQuickReplyOption(node, oi)">✕</el-button>
                  </div>
                  <el-button size="small" plain @click="addQuickReplyOption(node)">＋ 新增選項</el-button>
                </template>

                <!-- Tag -->
                <template v-else-if="node.type === 'tag'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="替客人貼上標籤" tight />
                    <el-select
                      :model-value="node.addTagIds"
                      multiple
                      filterable
                      collapse-tags
                      placeholder="選擇標籤（可多選）"
                      class="scripts-tag-select"
                      @change="node.addTagIds = $event"
                    >
                      <el-option v-for="t in tagOptions" :key="t.value" :label="t.label" :value="t.value" />
                    </el-select>
                    <p class="scripts-section-hint">流程走到這裡就貼標，然後自動往下。</p>
                  </div>
                </template>

                <!-- Save lead -->
                <template v-else-if="node.type === 'saveLead'">
                  <p class="scripts-section-hint">把這次問到的答案長期存進這位客人的資料裡，之後在後台看得到，回覆文字也能帶入使用。</p>
                  <div v-for="(m, mi) in node.fieldMap" :key="mi" class="scripts-branch-case scripts-branch-case--map">
                    <span class="text-xs text-muted">收集欄位</span>
                    <el-select :model-value="m.fromField" filterable placeholder="選欄位" class="scripts-branch-field" @change="m.fromField = $event">
                      <el-option v-for="f in collectFieldOptions" :key="f.value" :label="f.label" :value="f.value" />
                    </el-select>
                    <span class="text-xs text-muted">存成</span>
                    <el-input v-model="m.attrKey" placeholder="如 訂單編號" class="scripts-branch-field" />
                    <el-button type="danger" plain class="scripts-branch-remove" @click="removeSaveLeadField(node, mi)">✕</el-button>
                  </div>
                  <el-button size="small" plain @click="addSaveLeadField(node)">＋ 新增欄位</el-button>
                </template>

                <!-- Module：送出某個機器人模組的訊息，然後結束 -->
                <template v-else-if="node.type === 'module'">
                  <p class="scripts-section-hint">送出你在「機器人模組」做好的那一組訊息，然後結束流程。若那是「真人客服」模組，會照常轉真人。</p>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="要送出哪個模組" tight />
                    <div v-if="modulesLoading" class="text-xs text-muted">載入中…</div>
                    <div v-else-if="!moduleOptions.length" class="scripts-section-hint">
                      還沒有機器人模組。請先到「<NuxtLink :to="`/admin/${workspaceId}/flow`" class="link">機器人模組</NuxtLink>」建立一個。
                    </div>
                    <el-select v-else :model-value="node.moduleId" filterable placeholder="選擇模組" class="control-full" @change="node.moduleId = $event">
                      <el-option v-for="m in moduleOptions" :key="m.value" :label="m.label" :value="m.value" />
                    </el-select>
                  </div>
                </template>

                <!-- 下一步摘要：把自動接線/結束這種看不見的去向講出來（一步的設定沒有「下一步」可講） -->
                <p v-if="!isSimpleMode && autoNextLabel(node)" class="scripts-next-hint" :class="{ 'is-unwired': isNodeUnwired(node) }">
                  ↳ 下一步：<strong>{{ autoNextLabel(node) }}</strong>
                </p>
              </div>
            </div>

            <!-- 簡單模式的成長入口：點了才出現積木選單，加完第一塊就自動變成完整編輯器 -->
            <button v-if="isSimpleMode && !showPalette" type="button" class="scripts-grow" @click="showPalette = true">
              ＋ 還要多做一步…
              <small>問客人資料、給按鈕選、依答案分路、轉真人</small>
            </button>

            <div v-if="!isSimpleMode || showPalette" class="scripts-add-palette">
              <div v-for="grp in nodePalette" :key="grp.group" class="scripts-add-group">
                <span class="scripts-add-group-title">{{ grp.group }}</span>
                <div class="scripts-add-cards">
                  <button
                    v-for="it in grp.items"
                    :key="it.type"
                    type="button"
                    class="scripts-add-card"
                    @click="addNode(it.type)"
                  >
                    <span class="scripts-add-card-icon" :class="nodeBadgeClass(it.type)">
                      <el-icon><component :is="nodeIcon(it.type)" /></el-icon>
                    </span>
                    <span class="scripts-add-card-text">
                      <b>＋ {{ it.name }}</b>
                      <small>{{ it.desc }}</small>
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <p v-if="!isSimpleMode" class="scripts-section-hint">
              一般步驟會由上到下自動接下去；只有「依答案分路」和「快速回覆」要自己用「前往…」下拉，指定每條路各接到哪一步。
            </p>
          </div>
        </div>

        <!-- 試跑：假裝自己是客人打字，即時模擬這條腳本（純預覽，無副作用）。
             擺在最後——新建腳本時第一眼不該是一個沒東西可跑的模擬器。 -->
        <div class="message-card scripts-section-card scripts-sim-card">
          <div class="message-card-header scripts-sim-head" role="button" tabindex="0" @click="showSim = !showSim" @keydown.enter="showSim = !showSim">
            <div class="card-header-main">
              <span class="section-title">試跑這條流程</span>
              <span class="text-xs text-muted">假裝客人打字，看機器人怎麼回（純預覽，不會真的發送）</span>
            </div>
            <el-icon class="scripts-sim-caret" :class="{ 'is-open': showSim }"><ArrowRight /></el-icon>
          </div>
          <div v-if="showSim" class="card-section-stack scripts-sim-panel">
            <div class="scripts-sim-chat">
              <p v-if="!simLog.length" class="scripts-sim-empty">
                {{ editingFollowScript ? '按「模擬客人加好友」開始' : '輸入客人會打的第一句話開始（假設已經觸發這條流程）' }}
              </p>
              <template v-for="(m, i) in simLog" :key="i">
                <div v-if="m.who === 'sys'" class="scripts-sim-sys">{{ m.text }}</div>
                <div v-else class="scripts-sim-line" :class="`is-${m.who}`">
                  <div class="scripts-sim-bubble">{{ m.text || '（空白訊息）' }}</div>
                  <div v-if="m.buttons?.length" class="scripts-sim-qr">
                    <button v-for="(b, bi) in m.buttons" :key="bi" type="button" @click="simSend(b)">{{ b || '（空白按鈕）' }}</button>
                  </div>
                </div>
              </template>
            </div>
            <div class="scripts-sim-input">
              <!-- 加好友腳本沒有「第一句話」——第一步由加好友事件觸發，之後才輪到打字 -->
              <el-button v-if="editingFollowScript && !simLog.length" type="primary" @click="simFollowStart">模擬客人加好友</el-button>
              <template v-else>
                <el-input v-model="simInput" placeholder="輸入客人會打的話…" @keyup.enter="simSend()" />
                <el-button type="primary" @click="simSend()">送出</el-button>
              </template>
              <el-button @click="simReset">重來</el-button>
            </div>
          </div>
        </div>

      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { ArrowRight, ChatDotRound, CircleCheckFilled, CircleCloseFilled, Collection, Connection, CopyDocument, Delete, MagicStick, Notebook, Operation, Plus, Pointer, Position, PriceTag, Share, WarningFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { v4 as uuidv4 } from 'uuid'
import type {
  BranchOp,
  CollectFormat,
  ScriptBranchNode,
  ScriptCollectNode,
  ScriptDoc,
  ScriptNode,
  ScriptQuickReplyNode,
  ScriptReplyNode,
  ScriptModuleNode,
  ScriptSaveLeadNode,
  ScriptTagNode,
  ScriptTriggerNode,
  TriggerKeywordMatch,
  TriggerMatchMode,
} from '~~/shared/types/ai-script'
import { DEFAULT_COLLECT_EXPIRE_MS, DEFAULT_REPLY_LINK_LABEL, DEFAULT_SCRIPT_PRIORITY, MAX_TRIGGER_EXAMPLES, SCRIPT_NODE_TYPE_LABELS, collectSkipLabel, extractCollectValue, findPlaceholderTexts, findStuckCollects, isHumanRequestText, renderScriptTemplate, resolveBranchNext, scriptTriggerEvent, validateScriptDoc } from '~~/shared/types/ai-script'
import type { ScriptForReachability } from '~~/shared/types/ai-script-reachability'
import { findUnreachableScripts } from '~~/shared/types/ai-script-reachability'
import { SCRIPT_TEMPLATES, type ScriptTemplate } from '~~/shared/types/ai-script-templates'
import { AUTO_REPLY_COOLDOWN_OPTIONS } from '~~/shared/auto-reply-rule'
import { riskyTriggerKeywords } from '~~/shared/script-trigger-keywords'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { workspaceId, apiFetch, can } = useWorkspace()
const canEditScripts = computed(() => can('scripts.write'))
const { showToast } = useAdminToast()


interface ScriptRow extends ScriptDoc { id: string }

const {
  items: scripts,
  loading,
  loadingMore,
  listEl,
  load: loadScripts,
  onScroll: onSidebarListScroll,
} = useWorkspaceSidebarList<ScriptRow>('/api/ai/scripts/list')

const saving = ref(false)
const selectedId = ref<string | null>(null)
const isCreating = ref(false)

const scriptTemplates = SCRIPT_TEMPLATES

// 貼標節點用的工作區標籤清單
const { tags: tagList, loadTags } = useAdminTagList()

// 機器人模組步驟用的模組清單（只在真的有 module 步驟時才需要，但清單很小、一次抓完最簡單）
const modulesLoading = ref(true)
const moduleOptions = ref<Array<{ value: string; label: string }>>([])
async function loadModuleOptions() {
  // 只取選單要的欄位：整份模組清單是 133 KB（含每則訊息內容），這裡只用到名稱與編號
  const list = await apiFetch<Array<Record<string, any>>>('/api/flow/list?fields=picker').catch(() => [])
  // moduleId 就是 flows 的文件 id（見 getFlowByModuleId），所以直接用 m.id
  moduleOptions.value = (Array.isArray(list) ? list : [])
    .map(m => ({ value: String(m.id ?? ''), label: String(m.name ?? m.id ?? '(未命名模組)') }))
    .filter(m => m.value)
  modulesLoading.value = false
}
const tagOptions = computed(() => (tagList.value ?? []).map((t: any) => ({ value: String(t.id), label: String(t.name ?? t.id) })))

function defaultTriggerNode(nextId: string): ScriptTriggerNode {
  return { id: uuidv4(), type: 'trigger', matchMode: 'keyword', keywords: [], examples: [], priority: DEFAULT_SCRIPT_PRIORITY, next: nextId }
}
function defaultReplyNode(): ScriptReplyNode {
  return { id: uuidv4(), type: 'reply', text: '', thenHandoff: false }
}
function defaultCollectNode(nextId: string): ScriptCollectNode {
  return { id: uuidv4(), type: 'collect', question: '', fieldName: '', expireMs: DEFAULT_COLLECT_EXPIRE_MS, format: 'any', next: nextId }
}
function defaultBranchNode(defaultNext: string): ScriptBranchNode {
  return { id: uuidv4(), type: 'branch', cases: [], defaultNext }
}
function defaultQuickReplyNode(nextId: string): ScriptQuickReplyNode {
  return { id: uuidv4(), type: 'quickReply', question: '', expireMs: DEFAULT_COLLECT_EXPIRE_MS, options: [{ label: '', next: nextId }] }
}
function defaultTagNode(nextId: string): ScriptTagNode {
  return { id: uuidv4(), type: 'tag', addTagIds: [], next: nextId }
}
function defaultModuleNode(): ScriptModuleNode {
  // 與 reply 一樣是終點，沒有 next
  return { id: uuidv4(), type: 'module', moduleId: '' }
}
function defaultSaveLeadNode(nextId: string): ScriptSaveLeadNode {
  return { id: uuidv4(), type: 'saveLead', fieldMap: [{ fromField: '', attrKey: '' }], next: nextId }
}

function blankForm() {
  const trigger = defaultTriggerNode('')
  const reply = defaultReplyNode()
  trigger.next = reply.id
  return {
    name: '',
    enabled: true,
    priority: DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: trigger.id,
    nodes: [trigger, reply] as ScriptNode[],
  }
}

const form = ref(blankForm())
const { markClean, markDirty, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
  // 腳本節點流程可能編很久；F5 / 關分頁也要攔，避免整段遺失
  enableBeforeUnload: true,
})

const selectedScript = computed(() => scripts.value.find(s => s.id === selectedId.value) ?? null)

/**
 * 一步就結束的設定（觸發 → 回覆，等同舊的「自動回覆」）走簡單模式。
 *
 * 為什麼用「節點數」而不是讓使用者先選種類：**複雜度是答案的屬性，不是使用者要先做的分類**。
 * 他心裡想的是「客人問運費就回一句」或「要先問訂單編號」，不是「我需要一個狀態機」。
 * 新增時 blankForm() 本來就是觸發＋回覆兩顆，所以預設就落在簡單模式；
 * 一旦加了第三步，同一筆設定就地長成完整編輯器，不用換地方重做。
 */
const isSimpleMode = computed(() => {
  const nodes = form.value.nodes
  return nodes.length === 2
    && nodes.some(n => n.type === 'trigger')
    && nodes.some(n => n.type === 'reply')
})

/** 簡單模式下按了「還要多做一步…」才展開積木選單 */
const showPalette = ref(false)

/** 簡單模式的區塊標題：用「這一格在問什麼」講，不用步驟類型的名字 */
function simpleSectionTitle(node: ScriptNode): string {
  if (node.type !== 'trigger') return '你回什麼'
  return node.triggerEvent === 'follow' ? '客人加好友時' : '客人說什麼'
}

/** 關鍵字比對方式；文案與自動回覆的「比對方式」對齊，兩邊講的是同一件事 */
const KEYWORD_MATCH_OPTIONS: Array<{ value: TriggerKeywordMatch; label: string }> = [
  { value: 'any', label: '含任一關鍵字' },
  { value: 'all', label: '含全部關鍵字' },
  { value: 'exact', label: '內容完全一致' },
  { value: 'anyText', label: '客人輸入任何內容' },
]

/** 防重複觸發的間隔選項；與自動回覆共用同一份，兩邊講的是同一件事 */
const COOLDOWN_OPTIONS = AUTO_REPLY_COOLDOWN_OPTIONS
const DEFAULT_COOLDOWN_MS = COOLDOWN_OPTIONS[0]?.value ?? 60_000

function enableCooldown(node: ScriptTriggerNode) {
  node.cooldownMs = DEFAULT_COOLDOWN_MS
}
function clearCooldown(node: ScriptTriggerNode) {
  delete node.cooldownMs
}

/**
 * 這個觸發填了哪幾個會惹禍的關鍵字（D-33 P1）。
 *
 * 名單與判斷來自 `shared/script-trigger-keywords`——跟 AI 生成端剔除用的是**同一份**，
 * ⛔別在這裡自己另寫一組詞，否則會出現「生成端剔掉、編輯器說沒事」的兩套標準。
 * 這裡只提醒不阻擋（既有腳本可能刻意這樣設）。
 */
function riskyKeywordsOf(node: ScriptTriggerNode): string[] {
  if ((node.keywordMatch ?? 'any') === 'anyText')
    return []
  // 「完全符合」是一字不差地比對整句，不會誤攔別的訊息，所以不用提醒
  if (node.keywordMatch === 'exact')
    return []
  return riskyTriggerKeywords(node.keywords ?? [])
}

function keywordPlaceholder(node: ScriptTriggerNode): string {
  const mode = node.keywordMatch ?? 'any'
  if (mode === 'all') return '例：訂單 取消（要全部出現才算命中）'
  if (mode === 'exact') return '例：查訂單（客人要一字不差地打這句）'
  return '例：退換貨，退費，要退（用逗號或空白分隔，任一命中即觸發）'
}

/** 低於這個完成率就把「代表什麼」講出來（多數客人沒走完＝流程某一題卡住） */
const LOW_COMPLETION_RATE = 60

const stats = computed(() => {
  if (isCreating.value) return null
  const s = selectedScript.value?.stats
  const starts = s?.starts ?? 0
  if (!starts) return null
  const completions = s?.completions ?? 0
  return {
    starts,
    completions,
    dropped: Math.max(0, starts - completions),
    rate: Math.round((completions / starts) * 100),
  }
})

/**
 * 即時流程檢查：沿用「後端存檔時同一套」validateScriptDoc，設定當下就知道還差什麼、
 * 不用按了儲存才被擋。名稱用佔位符帶入 → 這條專講「流程結構」問題，腳本名稱由標題欄位與送出時把關。
 * 這一支只驗「接線合不合法」——走得完、輪不輪得到是另外兩件事（見 flowWarnings）。
 */
const flowIssue = computed(() =>
  validateScriptDoc({ name: form.value.name.trim() || '未命名流程', nodes: form.value.nodes, rootNodeId: form.value.rootNodeId }),
)

/**
 * 敏感情境詞會排在腳本之前攔截，所以要拿來一起判「這條腳本輪不輪得到」。
 * （原本還會比對自動回覆規則，那個功能 2026-08-09 已下架，順位收成單一條之後不再有那種蓋台。）
 */
const sensitiveTopics = ref<string[]>([])
const reachabilityState = ref<'loading' | 'ready' | 'failed'>('loading')

async function loadReachabilityContext() {
  try {
    const settings = await apiFetch<{ sensitiveTopics?: string[] }>('/api/ai/settings')
    sensitiveTopics.value = settings?.sensitiveTopics ?? []
    reachabilityState.value = 'ready'
  }
  catch {
    // 查不到就明講沒查到，不要靜靜當作「沒問題」
    reachabilityState.value = 'failed'
  }
}

/** 編輯中這條腳本「輪不輪得到」：把草稿和其他啟用中的腳本一起餵進去，只取草稿自己的問題 */
const DRAFT_SCRIPT_ID = '__draft__'
const reachabilityIssues = computed(() => {
  if (!form.value.enabled) return [] // 停用是刻意的，不是異常
  const draftId = selectedId.value ?? DRAFT_SCRIPT_ID
  const draft: ScriptForReachability = {
    id: draftId,
    name: form.value.name.trim() || '這條流程',
    nodes: form.value.nodes,
    rootNodeId: form.value.rootNodeId,
    enabled: true,
    priority: form.value.priority,
  }
  const others: ScriptForReachability[] = scripts.value
    .filter(s => s.id !== draftId && s.enabled)
    .map(s => ({ id: s.id, name: s.name, nodes: s.nodes ?? [], rootNodeId: s.rootNodeId, enabled: true, priority: s.priority }))
  return findUnreachableScripts([draft, ...others], { sensitiveTopics: sensitiveTopics.value })
    // noTrigger 交給 validateScriptDoc 講（「請為觸發步驟設定至少一個關鍵字」），不要同一件事講兩遍
    .filter(i => i.scriptId === draftId && i.reason !== 'noTrigger')
})

interface FlowWarning { key: string; text: string; nodeId?: string }

/**
 * 不擋存檔、但客人會踩到的風險（黃燈）。只驗接線的綠燈會保證一件它沒檢查過的事——
 * 正式站那條「查詢訂單」接線全對、狀態列亮綠燈，客人卻永遠走不出去。
 */
/** 問代碼類資料又沒給退路的步驟；退路建議鈕與狀態列共用同一份，不會各算各的 */
const stuckCollectIds = computed(() => new Set(findStuckCollects(form.value.nodes).map(s => s.nodeId)))

/**
 * 兩個收集步驟用同一個代號 → 答案存在同一格，後面那題會蓋掉前面那題
 * （collected 是一張以代號為鍵的表）。驗證器只拿代號做「有沒有這個欄位」的比對，
 * 不會發現重複，所以這裡要講出來。刻意不擋存檔：既有腳本可能已經是這樣，擋了會存不回去。
 */
const duplicateFieldWarnings = computed<FlowWarning[]>(() => {
  const seen = new Map<string, string>()
  const out: FlowWarning[] = []
  for (const n of form.value.nodes) {
    if (n.type !== 'collect') continue
    const name = n.fieldName.trim()
    if (!name) continue
    if (seen.has(name)) {
      out.push({
        key: `dup:${n.id}`,
        text: `有兩個步驟都用「${name}」當代號，後面這題的答案會蓋掉前面那題，請改成不同的代號`,
        nodeId: n.id,
      })
    }
    else { seen.set(name, n.id) }
  }
  return out
})

const flowWarnings = computed<FlowWarning[]>(() => {
  const out: FlowWarning[] = []
  for (const s of findStuckCollects(form.value.nodes)) {
    const what = s.fieldName || s.question || '這一題'
    out.push({
      key: `stuck:${s.nodeId}`,
      text: `客人答不出「${what}」就出不去——這種編號他手上可能根本沒有，會被一直重問。建議加一條退路。`,
      nodeId: s.nodeId,
    })
  }
  // AI 生成草稿的「不編造事實」占位符：沒補完就存檔，客人會原封不動看到【請填入：…】
  for (const hit of findPlaceholderTexts(form.value.nodes)) {
    out.push({
      key: `placeholder:${hit.nodeId}`,
      text: `這一步的文案還留著「${hit.snippet}」——AI 不知道的資料不會亂編，請把真實內容填進去再存檔`,
      nodeId: hit.nodeId,
    })
  }
  out.push(...duplicateFieldWarnings.value)
  // 一個帳號只能有一條啟用中的「加好友時」腳本（後端存檔也會擋；這裡先講，別等按存檔才知道）
  if (editingFollowScript.value && form.value.enabled) {
    const draftId = selectedId.value
    const rival = scripts.value.find(s => s.id !== draftId && s.enabled && scriptTriggerEvent(s) === 'follow')
    if (rival) {
      out.push({
        key: 'follow:dup',
        text: `「${rival.name || '(未命名流程)'}」也是在客人加好友時啟動、而且開著——兩條都開的話客人會連收兩份，存檔會被擋下來。請先停用那一條，或直接改那一條`,
      })
    }
  }
  for (const issue of reachabilityIssues.value) {
    // 被「另一條腳本」蓋住時，講「自動回覆排在前面」會把人指去翻錯的地方
    const why = issue.reason === 'otherScript' ? '' : '（安全層排在客服流程前面）'
    out.push({ key: `reach:${issue.reason}`, text: `${issue.detail}${why}` })
  }
  if (reachabilityState.value === 'failed') {
    out.push({
      key: 'reach:unknown',
      text: '讀不到 AI 設定，這次沒辦法確認這條流程的觸發詞會不會撞到敏感情境詞。重新整理再看一次。',
    })
  }
  return out
})

/** 流程圖上要標黃點的步驟 */
const flaggedNodeIds = computed(() => new Set(flowWarnings.value.map(w => w.nodeId).filter(Boolean) as string[]))

/** 綠燈只能宣告「真的查過」的事：規則還沒到手時，不可以說「不會被自動回覆蓋掉」 */
const allClearText = computed(() => {
  const fullyChecked = reachabilityState.value === 'ready' && form.value.enabled
  return fullyChecked
    ? '流程完整、每一題客人都走得完，觸發也不會被別的設定蓋掉 ✓'
    : '流程完整、每一題客人都走得完 ✓'
})

// ── List helpers ───────────────────────────────────────────────────
function triggerSummary(script: ScriptRow): string {
  const trig = script.nodes?.find(n => n.type === 'trigger') as ScriptTriggerNode | undefined
  if (!trig) return '無觸發條件'
  if (trig.triggerEvent === 'follow') return '客人加好友時'
  if ((trig.matchMode ?? 'keyword') === 'semantic') {
    const ex = (trig.examples ?? []).filter(Boolean)
    if (!ex.length) return '無範例'
    return `${ex.slice(0, 3).join('、')}${ex.length > 3 ? '⋯' : ''}`
  }
  if (!trig.keywords?.length) return '無關鍵字'
  return `${trig.keywords.slice(0, 3).join('、')}${trig.keywords.length > 3 ? '⋯' : ''}`
}

function nodeIcon(type: string): Component {
  if (type === 'trigger') return Position
  if (type === 'collect') return Collection
  if (type === 'branch') return Share
  if (type === 'quickReply') return Pointer
  if (type === 'tag') return PriceTag
  if (type === 'saveLead') return Notebook
  if (type === 'module') return Connection
  return ChatDotRound
}

function nodeTypeLabel(type: string) {
  return SCRIPT_NODE_TYPE_LABELS[type as ScriptNode['type']] ?? '回覆'
}

function nodeBadgeClass(type: string) {
  if (type === 'trigger') return 'scripts-node-badge--trigger'
  if (type === 'collect') return 'scripts-node-badge--collect'
  if (type === 'branch') return 'scripts-node-badge--branch'
  if (type === 'quickReply') return 'scripts-node-badge--quickreply'
  if (type === 'tag' || type === 'saveLead' || type === 'module') return 'scripts-node-badge--action'
  return 'scripts-node-badge--reply'
}

/** 給「下一步」下拉用的節點選項標籤（trigger 不能當目標） */
function nodeOptionLabel(n: ScriptNode): string {
  if (n.type === 'collect') return `收集 ${n.fieldName || '(未命名)'}`
  if (n.type === 'quickReply') return `快速回覆${n.question ? `「${n.question.slice(0, 8)}」` : ''}`
  if (n.type === 'reply') return `回覆「${(n.text || '').slice(0, 8) || '空白'}」`
  if (n.type === 'module') return `機器人模組「${moduleLabel(n.moduleId)}」`
  return SCRIPT_NODE_TYPE_LABELS[n.type]
}

/** 模組 id → 顯示名稱（清單還沒載到就先顯示 id，不要顯示空白） */
function moduleLabel(moduleId: string): string {
  if (!moduleId) return '未選擇'
  return moduleOptions.value.find(m => m.value === moduleId)?.label ?? moduleId
}

/** 節點短名（給「下一步」摘要用） */
function shortNodeName(id: string): string {
  const n = form.value.nodes.find(x => x.id === id)
  return n ? nodeOptionLabel(n) : '（尚未接，存檔會擋）'
}
/**
 * 把「看不見的去向」講出來：
 * - 線性節點（觸發/收集/貼標/寫名單）自動接下一個，但畫面上看不到 → 顯示 ↳ 下一步：X
 * - 回覆節點是終點 → 顯示是否結束/轉真人
 * - 分支/快速回覆的出口已在各自的列上顯示，回 null 不重複
 */
function autoNextLabel(node: ScriptNode): string | null {
  if (node.type === 'trigger' || node.type === 'collect' || node.type === 'tag' || node.type === 'saveLead') {
    const main = node.next ? shortNodeName(node.next) : '（尚未接，存檔會擋）'
    // 收集節點有跳過出口 → 把兩條去向都講出來
    if (node.type === 'collect' && collectSkipLabel(node)) {
      return `${main}；按「${collectSkipLabel(node)}」→ ${shortNodeName(node.skipNext!)}`
    }
    return main
  }
  if (node.type === 'reply') {
    return node.thenHandoff ? '流程結束，並轉真人客服' : '流程結束'
  }
  if (node.type === 'module') return '送出模組訊息，流程結束'
  return null
}

/** 線性節點的出口是空的（存檔驗證會擋）→ 把該節點的「↳ 下一步」標紅，指出要修的地方 */
function isNodeUnwired(node: ScriptNode): boolean {
  return (node.type === 'trigger' || node.type === 'collect' || node.type === 'tag' || node.type === 'saveLead') && !node.next
}

// ── 流程圖（即時預覽）──────────────────────────────────────────────
// 從觸發節點走訪整條流程，攤平成「縮排的流程列」：線性步驟同層往下，分支/快速回覆
// 的每條路往內縮一層並標上條件。純唯讀，跟著下面卡片即時變動；用路徑 visited 斷循環。
interface FlowRow { key: string; kind: 'node' | 'label' | 'note'; type?: ScriptNode['type']; title: string; sub?: string; depth: number; id?: string }

function flowTruncate(s: string, n = 16): string {
  const t = String(s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
function flowNodeTitle(node: ScriptNode): string {
  if (node.type === 'collect') return `收集：${node.fieldName || '未命名'}`
  return nodeTypeLabel(node.type)
}
function flowNodeSub(node: ScriptNode): string {
  if (node.type === 'trigger') {
    if (node.triggerEvent === 'follow') return '客人加好友時'
    const list = ((node.matchMode ?? 'keyword') === 'semantic' ? (node.examples ?? []) : (node.keywords ?? [])).filter(Boolean)
    return list.length ? `${list.slice(0, 3).join('、')}${list.length > 3 ? '…' : ''}` : '未設條件'
  }
  if (node.type === 'collect' || node.type === 'quickReply') return node.question ? `問「${flowTruncate(node.question)}」` : ''
  if (node.type === 'reply') return node.thenHandoff ? '回覆後轉真人 → 結束' : '回覆 → 結束'
  if (node.type === 'tag') return `${node.addTagIds.length} 個標籤`
  if (node.type === 'saveLead') return `存 ${node.fieldMap.length} 個欄位`
  if (node.type === 'module') return `${moduleLabel(node.moduleId)} → 結束`
  return ''
}
function flowBranchLabel(c: ScriptBranchNode['cases'][number]): string {
  const f = c.field || '欄位'
  if (c.op === 'equals') return `若 ${f} =「${c.value || ''}」`
  if (c.op === 'contains') return `若 ${f} 含「${c.value || ''}」`
  return `若 ${f} 有填`
}

const flowRows = computed<FlowRow[]>(() => {
  const nodes = form.value.nodes
  const byId = new Map(nodes.map(n => [n.id, n]))
  const rows: FlowRow[] = []
  const rendered = new Set<string>()
  const MAX = 60
  let seq = 0

  const pushNode = (node: ScriptNode, depth: number) => {
    rendered.add(node.id)
    rows.push({ key: `n${seq++}`, kind: 'node', type: node.type, title: flowNodeTitle(node), sub: flowNodeSub(node), depth, id: node.id })
  }
  const pushLabel = (title: string, depth: number) => rows.push({ key: `l${seq++}`, kind: 'label', title, depth })
  const pushNote = (title: string, depth: number) => rows.push({ key: `x${seq++}`, kind: 'note', title, depth })

  function walk(id: string, depth: number, path: Set<string>) {
    if (rows.length >= MAX) return
    if (!id) return pushNote('（尚未接下一步）', depth)
    const node = byId.get(id)
    if (!node) return pushNote('（接到不存在的步驟）', depth)
    if (path.has(id)) return pushNote(`↩ 回到「${flowNodeTitle(node)}」`, depth)
    const seen = new Set(path)
    seen.add(id)

    pushNode(node, depth)
    if (node.type === 'branch') {
      for (const c of node.cases) { pushLabel(flowBranchLabel(c), depth + 1); walk(c.next, depth + 1, seen) }
      pushLabel('其餘情況', depth + 1)
      walk(node.defaultNext, depth + 1, seen)
    }
    else if (node.type === 'quickReply') {
      for (const o of node.options) { pushLabel(`按「${o.label || '未命名'}」`, depth + 1); walk(o.next, depth + 1, seen) }
    }
    else if (node.type === 'collect' && collectSkipLabel(node)) {
      // 有跳過出口的收集：像分支一樣畫兩條路，照常回答往下、按跳過鈕走另一條
      pushLabel('照常回答', depth + 1)
      walk(node.next, depth + 1, seen)
      pushLabel(`按「${collectSkipLabel(node)}」`, depth + 1)
      walk(node.skipNext!, depth + 1, seen)
    }
    // reply / module 是終點，沒有下一步可走
    else if (node.type !== 'reply' && node.type !== 'module') {
      walk(node.next, depth, seen)
    }
  }

  const root = nodes.find(n => n.id === form.value.rootNodeId)
  if (root) walk(root.id, 0, new Set())
  // 沒被走訪到的孤兒節點（觸發除外）：提醒還沒接進流程
  for (const n of nodes) {
    if (n.type !== 'trigger' && !rendered.has(n.id)) pushNote(`⚠「${flowNodeTitle(n)}」還沒接進流程`, 0)
  }
  return rows
})

// 點流程圖上的步驟 → 捲到下面對應的卡片並短暫高亮，讓「圖」和「編輯卡片」連成一個可導覽的流程
const highlightStep = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null
function focusStep(id?: string) {
  if (!id) return
  highlightStep.value = id
  // nextTick：剛新增的步驟卡片要等 DOM 更新後才捲得到
  nextTick(() => {
    document.querySelector(`[data-node-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightStep.value = null }, 1600)
}

// ── 「前往…」下拉裡直接「＋ 接下一步」：把「按鈕/分支可以接子流程」變成看得見的動作 ──
// 快速回覆排第一：「這一題想給客人好幾個選擇」最常見的解法就是把路指到一個快速回覆步驟
const newStepOptions = [
  { value: '__new:quickReply', label: '＋ 新增：快速回覆（給客人幾顆按鈕選）' },
  { value: '__new:collect', label: '＋ 新增：收集（問一個問題）' },
  { value: '__new:branch', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.branch}` },
  { value: '__new:tag', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.tag}` },
  { value: '__new:saveLead', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.saveLead}` },
  { value: '__new:reply', label: '＋ 新增：回覆（結束）' },
  { value: '__new:module', label: `＋ 新增：${SCRIPT_NODE_TYPE_LABELS.module}（送出訊息並結束）` },
]

function makeStep(type: 'collect' | 'quickReply' | 'branch' | 'tag' | 'saveLead' | 'reply' | 'module', nextId: string): ScriptNode {
  if (type === 'collect') return defaultCollectNode(nextId)
  if (type === 'quickReply') return defaultQuickReplyNode(nextId)
  if (type === 'branch') return defaultBranchNode(nextId)
  if (type === 'tag') return defaultTagNode(nextId)
  if (type === 'saveLead') return defaultSaveLeadNode(nextId)
  if (type === 'module') return defaultModuleNode()
  return defaultReplyNode()
}

/**
 * 「前往…」被改變時：
 * - 選了一般步驟 → 直接把這條路指過去。
 * - 選了「＋ 接下一步」→ 建一個新步驟「插進這條路」：新步驟的下一步自動接回原本的目標
 *   （不會把原本接的東西弄丟），再把這條路指到新步驟，然後捲過去讓你填內容。
 */
function onTargetChange(value: string, currentTarget: string, setNext: (id: string) => void) {
  if (typeof value === 'string' && value.startsWith('__new:')) {
    const type = value.slice(6) as 'collect' | 'quickReply' | 'branch' | 'tag' | 'saveLead' | 'reply' | 'module'
    const node = makeStep(type, currentTarget)
    form.value.nodes.push(node)
    setNext(node.id)
    focusStep(node.id)
  }
  else {
    setNext(value)
  }
}

// ── 加積木選單：分「常用 / 進階」＋一句說明，讓人一眼知道每種在做什麼 ──────
const nodePalette: Array<{ group: string; items: Array<{ type: 'collect' | 'quickReply' | 'reply' | 'branch' | 'tag' | 'saveLead' | 'module'; name: string; desc: string }> }> = [
  { group: '常用', items: [
    { type: 'collect', name: '收集', desc: '問客人一個問題、記住答案' },
    { type: 'quickReply', name: '快速回覆', desc: '給幾顆按鈕讓客人點選' },
    { type: 'reply', name: '回覆', desc: '機器人回一句話，可結束或轉真人' },
  ] },
  { group: '進階', items: [
    { type: 'branch', name: SCRIPT_NODE_TYPE_LABELS.branch, desc: '依前面的答案自動走不同路' },
    { type: 'tag', name: SCRIPT_NODE_TYPE_LABELS.tag, desc: '自動幫這位客人貼上標籤' },
    { type: 'saveLead', name: SCRIPT_NODE_TYPE_LABELS.saveLead, desc: '長期留存，後台看得到、之後回覆也能帶入' },
    { type: 'module', name: SCRIPT_NODE_TYPE_LABELS.module, desc: '送出做好的一組訊息並結束' },
  ] },
]

// ── 試跑對話：在後台假裝自己是客人，用「目前編輯中」的腳本即時模擬 ──────────
// 直接重用後端執行時同一套純函式（renderScriptTemplate / extractCollectValue /
// resolveBranchNext），行為與真的跑腳本一致；純預覽，不寫任何資料、無副作用。
interface SimMsg { who: 'bot' | 'me' | 'sys'; text: string; buttons?: string[] }
const showSim = ref(false)
const simLog = ref<SimMsg[]>([])
const simInput = ref('')
const simWaiting = ref<'collect' | 'quickReply' | null>(null)
const simNodeId = ref<string | null>(null)
const simCollected = ref<Record<string, string>>({})
const simDone = ref(false)

// 觸發測試框：打一句話，即時判斷會不會命中這條腳本
const triggerTest = ref('')

/** 「進階設定」（優先度）預設收起：它的說明本身就寫「通常不用動」 */
const showAdvanced = ref(false)

/**
 * 換一份腳本進編輯器時，把「展開了什麼」歸零並依內容重推欄位模式。
 * ⛔ 這件事不可以塞進 simReset()：那支也掛在試跑面板的「重來」按鈕上，
 * 重置一個預覽不該把使用者剛展開的退路欄位、進階設定收回去。
 */
function resetEditorDisclosure(nodes: ScriptNode[]) {
  openedSkips.value = new Set()
  showAdvanced.value = false
  showPalette.value = false
  syncFieldModes(nodes)
}

function simReset() {
  simLog.value = []
  simInput.value = ''
  simWaiting.value = null
  simNodeId.value = null
  simCollected.value = {}
  simDone.value = false
  triggerTest.value = ''
}
function simPush(m: SimMsg) { simLog.value.push(m) }

/** 從某節點往前推非互動步驟：遇到 collect/quickReply 停下等輸入、遇到 reply 結束 */
function simRun(startId: string) {
  let cursor = startId
  for (let i = 0; i < 50; i++) {
    if (!cursor) { simPush({ who: 'sys', text: '（這條路沒有接下一步，流程結束）' }); simDone.value = true; simWaiting.value = null; return }
    const node = form.value.nodes.find(n => n.id === cursor)
    if (!node) { simPush({ who: 'sys', text: '（接到不存在的步驟，流程結束）' }); simDone.value = true; simWaiting.value = null; return }
    if (node.type === 'trigger') { cursor = node.next; continue }
    if (node.type === 'branch') { cursor = resolveBranchNext(node, simCollected.value); continue }
    if (node.type === 'tag') { simPush({ who: 'sys', text: `（貼標：${node.addTagIds.length} 個標籤）` }); cursor = node.next; continue }
    if (node.type === 'saveLead') { simPush({ who: 'sys', text: '（已把答案存進客人資料）' }); cursor = node.next; continue }
    if (node.type === 'collect') {
      // 與引擎一致:有跳過出口 → 問句附跳過按鈕
      const skip = collectSkipLabel(node)
      simPush({ who: 'bot', text: renderScriptTemplate(node.question, { collected: simCollected.value }), ...(skip ? { buttons: [skip] } : {}) })
      simNodeId.value = node.id; simWaiting.value = 'collect'; return
    }
    if (node.type === 'quickReply') {
      simPush({ who: 'bot', text: renderScriptTemplate(node.question, { collected: simCollected.value }), buttons: node.options.map(o => o.label) })
      simNodeId.value = node.id; simWaiting.value = 'quickReply'; return
    }
    if (node.type === 'module') {
      simPush({ who: 'sys', text: `（送出機器人模組「${moduleLabel(node.moduleId)}」的訊息，流程結束）` })
      simDone.value = true; simWaiting.value = null; return
    }
    if (node.type === 'reply') {
      simPush({ who: 'bot', text: renderScriptTemplate(node.text, { collected: simCollected.value }) })
      // 與引擎一致：有連結按鈕就多送一則帶按鈕的訊息（試跑要跟客人看到的一樣）
      const linkUrl = renderScriptTemplate(String(node.linkUrl ?? '').trim(), { collected: simCollected.value })
      if (linkUrl) {
        simPush({ who: 'sys', text: `（另送一則連結按鈕：${String(node.linkLabel ?? '').trim() || DEFAULT_REPLY_LINK_LABEL} → ${linkUrl}）` })
      }
      if (node.thenHandoff) simPush({ who: 'sys', text: '↳ 轉真人客服' })
      simDone.value = true; simWaiting.value = null; return
    }
    return
  }
}

/** 編輯中的這條是不是「加好友時」腳本（試跑起點與重複警告共用） */
const editingFollowScript = computed(() => {
  const trig = form.value.nodes.find(n => n.type === 'trigger') as ScriptTriggerNode | undefined
  return trig?.triggerEvent === 'follow'
})

/** 加好友腳本的試跑起點：沒有「第一句話」，用一顆按鈕模擬 follow 事件 */
function simFollowStart() {
  if (simLog.value.length) return
  simPush({ who: 'sys', text: '（客人把你的官方帳號加為好友）' })
  const trig = form.value.nodes.find(n => n.type === 'trigger')
  if (!trig || trig.type !== 'trigger') {
    simPush({ who: 'sys', text: '（這條流程沒有觸發步驟）' })
    return
  }
  simRun(trig.next)
}

/** 送出一句「客人的話」；第一句視為觸發訊息，之後照 collect / quickReply 推進 */
function simSend(text?: string) {
  const msg = String(text ?? simInput.value).trim()
  if (!msg) return
  simInput.value = ''
  simPush({ who: 'me', text: msg })
  if (simDone.value) { simPush({ who: 'sys', text: '（流程已結束，按「重來」再試一次）' }); return }

  // 逃生門(與正式引擎同一份判斷詞):流程進行中喊「找真人」→ 放棄腳本、轉真人
  if (simWaiting.value && isHumanRequestText(msg)) {
    simPush({ who: 'sys', text: '↳ 逃生門：放棄流程，轉真人客服（會回覆客人並通知值班同仁）' })
    simDone.value = true
    simWaiting.value = null
    return
  }

  if (!simWaiting.value) {
    const trig = form.value.nodes.find(n => n.type === 'trigger')
    if (!trig || trig.type !== 'trigger') { simPush({ who: 'sys', text: '（這條流程沒有觸發步驟）' }); return }
    simRun(trig.next)
    return
  }
  const node = form.value.nodes.find(n => n.id === simNodeId.value)
  if (node?.type === 'collect') {
    // 與引擎一致:先看是不是點了跳過按鈕(先於格式驗證,否則「不限格式」會把跳過語存成髒值)
    const skip = collectSkipLabel(node)
    if (skip && msg.toLowerCase() === skip.toLowerCase()) {
      simRun(node.skipNext!)
      return
    }
    const res = extractCollectValue(node, msg)
    if (!res.ok) {
      // 與引擎一致:答錯格式=挫折點,重問時亮出退路——跳過按鈕(有設的話)+「找真人」逃生按鈕
      simPush({ who: 'bot', text: node.reaskText || '格式好像不太對，可以再輸入一次嗎？', buttons: [...(skip ? [skip] : []), '找真人'] })
      return
    }
    simCollected.value[node.fieldName] = res.value
    simRun(node.next)
  }
  else if (node?.type === 'quickReply') {
    const opt = node.options.find(o => o.label.trim() === msg)
    if (!opt) {
      // 與引擎一致:沒對到選項 → 重新出題,按鈕多一顆「找真人」(已有同義按鈕就不重複)
      const labels = node.options.map(o => o.label)
      if (!labels.some(l => isHumanRequestText(l.trim()))) labels.push('找真人')
      simPush({ who: 'bot', text: renderScriptTemplate(node.question, { collected: simCollected.value }), buttons: labels })
      return
    }
    simRun(opt.next)
  }
  else { simPush({ who: 'sys', text: '（狀態異常，請按重來）' }) }
}

/**
 * 觸發測試（大概版）：關鍵字用「即時子字串比對」（與後端 keyword 快速通道同邏輯，零成本）。
 * 「看意思」模式的最終判斷是 AI 在真實對話時做的，這裡只能提示、無法百分百確定。
 */
function triggerTestResult(node: ScriptTriggerNode): { state: 'idle' | 'hit' | 'maybe' | 'miss'; text: string } {
  const q = triggerTest.value.trim().toLowerCase()
  if (!q) return { state: 'idle', text: '' }
  const kws = (node.keywords ?? []).map(k => k.trim().toLowerCase()).filter(Boolean)
  if (kws.some(k => q.includes(k))) return { state: 'hit', text: '會觸發（命中關鍵字）' }
  if ((node.matchMode ?? 'keyword') === 'semantic') {
    return { state: 'maybe', text: '沒中關鍵字。「看意思」模式實際由 AI 依範例句判斷，這裡無法百分百確定；範例句越貼近客人講法越準' }
  }
  return { state: 'miss', text: '不會觸發（沒命中任何關鍵字）' }
}

/** 目前腳本裡所有 collect 節點的欄位名（給分支/寫名單/變數插入下拉選，避免手打 typo） */
const collectFieldOptions = computed(() =>
  form.value.nodes
    .filter((n): n is ScriptCollectNode => n.type === 'collect' && !!n.fieldName.trim())
    .map(n => ({ value: n.fieldName, label: n.fieldName })),
)
/** 節點標頭的用途提示（取代誤導的「節點 N」序號——分支圖裡順序≠流程） */
function nodeHeaderHint(node: ScriptNode): string {
  if (node.type === 'collect') return node.fieldName ? `欄位「${node.fieldName}」` : '（未命名欄位）'
  if (node.type === 'reply') return node.thenHandoff ? '結束 → 轉真人' : '結束'
  return ''
}

/** 每種步驟「在做什麼」的白話一句話，當步驟卡片副標，降低第一次使用的學習成本 */
function nodePurpose(type: string): string {
  if (type === 'trigger') return '決定客人說什麼，會啟動這條流程'
  if (type === 'collect') return '問客人一個問題，把答案記起來（例：訂單編號）'
  if (type === 'reply') return '機器人回一句話收尾，可選擇結束或轉真人'
  if (type === 'branch') return '依前面收到的答案，自動走不同路（不花 AI）'
  if (type === 'quickReply') return '給客人幾顆按鈕點選，依點哪顆走不同路'
  if (type === 'tag') return '自動幫這位客人貼上標籤，然後往下'
  if (type === 'saveLead') return '把收集到的答案，長期存進客人資料'
  if (type === 'module') return '送出做好的一組訊息，然後結束流程'
  return ''
}
/** 移除回覆的連結按鈕（兩格一起清，不留半套資料被存檔驗證擋下） */
function clearReplyLink(node: ScriptReplyNode) {
  delete node.linkUrl
  delete node.linkLabel
}

/** 在回覆文字尾端插入一個欄位變數 */
function insertReplyVar(node: ScriptReplyNode, field: string) {
  if (!field) return
  node.text = `${node.text || ''}{{${field}}}`
}
/** 變數插入選單的顯示文字（用函式回傳，避免在 template mustache 裡寫巢狀大括號被誤解析） */
function varLabel(field: string): string {
  return `{{ ${field} }}`
}

function addSaveLeadField(node: ScriptSaveLeadNode) {
  node.fieldMap.push({ fromField: '', attrKey: '' })
}
function removeSaveLeadField(node: ScriptSaveLeadNode, idx: number) {
  node.fieldMap.splice(idx, 1)
}
function targetOptions(selfId: string) {
  return form.value.nodes
    .filter(n => n.id !== selfId && n.type !== 'trigger')
    .map(n => ({ value: n.id, label: nodeOptionLabel(n) }))
}

function addBranchCase(node: ScriptBranchNode) {
  node.cases.push({ op: 'exists', field: '', value: '', next: '' })
}
function removeBranchCase(node: ScriptBranchNode, idx: number) {
  node.cases.splice(idx, 1)
}
function setBranchOp(c: ScriptBranchNode['cases'][number], op: string | number | boolean | undefined) {
  const next: BranchOp = (op === 'equals' || op === 'contains') ? op : 'exists'
  c.op = next
  // 切到 exists 不需要比較值，清掉殘留避免切回時冒出舊值
  if (next === 'exists') c.value = ''
}

// ── 收集步驟：常用欄位 ──────────────────────────────────────────────
// 「給答案取個代號（order_id）」是整頁最像工程師介面的一格。改成挑常用欄位，
// 問句、格式、代號一次帶好；真的不在清單裡才手打。
const COMMON_COLLECT_FIELDS: Array<{ key: string; label: string; question: string; format: CollectFormat }> = [
  { key: 'order_id', label: '訂單編號', question: '請提供您的訂單編號 🙂', format: 'alphanumericSymbol' },
  { key: 'name', label: '姓名', question: '請問怎麼稱呼您？', format: 'any' },
  { key: 'phone', label: '電話', question: '請留下方便聯絡的電話 📞', format: 'phone' },
  { key: 'email', label: 'Email', question: '請留下您的 Email', format: 'email' },
  { key: 'address', label: '地址', question: '請提供您的收件地址', format: 'any' },
]

const PRESET_FIELD_KEYS = new Set(COMMON_COLLECT_FIELDS.map(p => p.key))

/**
 * 每個收集步驟的「這一題問的是」選了什麼（步驟 id → 常用欄位 key 或 '__custom'）；沒有＝還沒選。
 *
 * ⛔ 不能從 fieldName 即時推導。手打代號打到剛好等於某個內建代號的那一刻（`nam` → `name`），
 * 推導出來的值會從 '__custom' 跳成 'name'，輸入框當場被 v-if 移除、@change 永遠不會觸發，
 * 於是「改名時順便修好所有引用」那段沒跑到，存檔被擋在「欄位沒有對應的收集步驟」，
 * 而且完全看不出是剛剛改名造成的。
 */
const fieldMode = ref<Record<string, string>>({})

/** 依目前的 fieldName 推一次初始模式（換腳本、載入草稿時呼叫；之後只跟著使用者的選擇走） */
function syncFieldModes(nodes: ScriptNode[]) {
  const next: Record<string, string> = {}
  for (const n of nodes) {
    if (n.type !== 'collect') continue
    const name = n.fieldName.trim()
    if (!name) continue
    next[n.id] = PRESET_FIELD_KEYS.has(name) ? name : '__custom'
  }
  fieldMode.value = next
}

/** 目前這一題選了哪個常用欄位；空字串＝還沒選（下拉顯示 placeholder） */
function presetKeyOf(node: ScriptCollectNode): string {
  return fieldMode.value[node.id] ?? ''
}

/**
 * 代號不能和別的收集步驟撞名——撞名的話兩題的答案會存進同一格、後面蓋掉前面。
 * 選常用欄位時自動讓開（姓名 → name、第二個 name_2），使用者會直接看到真正的代號。
 */
function uniqueFieldName(base: string, selfId: string): string {
  const taken = new Set(
    form.value.nodes
      .filter((n): n is ScriptCollectNode => n.type === 'collect' && n.id !== selfId)
      .map(n => n.fieldName.trim())
      .filter(Boolean),
  )
  if (!taken.has(base)) return base
  for (let i = 2; i <= 20; i++) {
    if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }
  return base
}

function applyFieldPreset(node: ScriptCollectNode, key: string | number | boolean | undefined) {
  const preset = COMMON_COLLECT_FIELDS.find(p => p.key === key)
  if (!preset) {
    // 切到「其他」：保留現有代號讓人直接改，不清空（清空會讓下面的分路條件瞬間失效）
    fieldMode.value = { ...fieldMode.value, [node.id]: '__custom' }
    return
  }
  const prev = node.fieldName
  const name = uniqueFieldName(preset.key, node.id)
  node.fieldName = name
  node.format = preset.format
  if (!node.question.trim()) node.question = preset.question
  // 撞名讓開後代號已經不是內建的那個，下拉要顯示「其他」才不會和輸入框裡的值互相矛盾
  fieldMode.value = { ...fieldMode.value, [node.id]: name === preset.key ? preset.key : '__custom' }
  if (name !== preset.key) {
    showToast(`已經有另一個步驟用「${preset.key}」了，這一題的代號改用「${name}」，避免兩題的答案互相蓋掉`, 'success')
  }
  renameCollectField(node, prev)
}

/** 手打代號時記住改之前叫什麼，change（失焦/Enter）才一次修好所有引用 */
const fieldRenameFrom = ref('')

/**
 * 改欄位代號時，把引用它的地方一起改掉。不修的話舊名字會變成「沒有對應的收集步驟」，
 * 存檔被擋、而且不容易看出是剛剛改名造成的。
 *
 * ⛔ 變數要四個地方一起換：引擎會對**回覆文字、收集問句、快速回覆問句、格式錯誤的重問話術**
 * 都跑 renderScriptTemplate（server/utils/ai-scripts.ts）。只換回覆文字的話，客人會實際收到
 * 一句「請確認 {{order_id}} 是否正確」——renderScriptTemplate 對認不得的變數是刻意原樣保留的。
 */
function renameCollectField(node: ScriptCollectNode, prev: string) {
  const next = node.fieldName.trim()
  if (!prev || !next || prev === next) return
  // 還有別的收集步驟叫這個舊名字 → 引用指的是誰無法判斷，不要亂改（同名本身會另外跳警告）
  const stillUsed = form.value.nodes.some(n => n.type === 'collect' && n.id !== node.id && n.fieldName.trim() === prev)
  if (stillUsed) return

  const varRe = new RegExp(`\\{\\{\\s*${prev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g')
  const swap = (text: string | undefined) => String(text ?? '').replace(varRe, `{{${next}}}`)

  for (const n of form.value.nodes) {
    if (n.type === 'branch') {
      for (const c of n.cases) if (c.field === prev) c.field = next
    }
    else if (n.type === 'saveLead') {
      for (const m of n.fieldMap) if (m.fromField === prev) m.fromField = next
    }
    else if (n.type === 'reply') {
      n.text = swap(n.text)
    }
    else if (n.type === 'quickReply') {
      n.question = swap(n.question)
    }
    else if (n.type === 'collect') {
      n.question = swap(n.question)
      if (n.reaskText) n.reaskText = swap(n.reaskText)
    }
  }
}

// ── 收集步驟：答不出來的退路 ─────────────────────────────────────────
// 八成的題目用不到，所以預設收起；已經設好的、或這一輪剛按開的才展開。
const openedSkips = ref<Set<string>>(new Set())

function isSkipOpen(node: ScriptCollectNode): boolean {
  // 單邊有值也要展開：那是還沒設完的狀態，收起來就沒人修得到（存檔會被擋）
  return !!node.skipLabel || !!node.skipNext || openedSkips.value.has(node.id)
}
function openCollectSkip(node: ScriptCollectNode) {
  openedSkips.value = new Set(openedSkips.value).add(node.id)
}

/** 這一題問的是「客人可能根本沒有」的代碼、又還沒給退路（和狀態列讀同一份，不會各算各的） */
function isStuckCollect(node: ScriptCollectNode): boolean {
  return stuckCollectIds.value.has(node.id)
}

/** 清掉收集節點的跳過出口（兩格一起清，避免留單邊被存檔驗證擋下） */
function clearCollectSkip(node: ScriptCollectNode) {
  node.skipLabel = ''
  node.skipNext = ''
  const next = new Set(openedSkips.value)
  next.delete(node.id)
  openedSkips.value = next
}

function addQuickReplyOption(node: ScriptQuickReplyNode) {
  node.options.push({ label: '', next: '' })
}
function removeQuickReplyOption(node: ScriptQuickReplyNode, idx: number) {
  node.options.splice(idx, 1)
}

// ── Edit ───────────────────────────────────────────────────────────
function selectScript(script: ScriptRow, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = script.id
  form.value = {
    name: script.name,
    enabled: script.enabled,
    priority: script.priority || DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: script.rootNodeId,
    nodes: deepCloneNodes(script.nodes),
  }
  markClean()
  simReset()
  resetEditorDisclosure(form.value.nodes)
}

function openCreate() {
  if (!confirmLeaveIfDirty()) return
  isCreating.value = true
  selectedId.value = null
  form.value = blankForm()
  markClean()
  simReset()
  resetEditorDisclosure(form.value.nodes)
}

/**
 * 複製一份：近似的腳本（「更改地址」「新增備註」常常只有最後一題不同）不用整條重刻。
 * 複本預設停用——兩條啟用中、觸發詞又一樣的腳本會互相蓋台，剛複製完就踩這個坑很冤。
 * 節點 id 沿用即可：只要在單一腳本內唯一，跨文件重複沒有影響。
 */
function duplicateScript() {
  const src = selectedScript.value
  if (!src || !confirmLeaveIfDirty()) return
  isCreating.value = true
  selectedId.value = null
  form.value = {
    name: `${src.name || '未命名流程'} 複本`,
    enabled: false,
    priority: src.priority || DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: src.rootNodeId,
    nodes: deepCloneNodes(src.nodes),
  }
  markDirty()
  simReset()
  resetEditorDisclosure(form.value.nodes)
  showToast('已複製成草稿，改完按「建立客服流程」才會存檔。複本先停用，避免和原本那條搶同一組觸發詞', 'success')
}

// ── AI 一句話生成草稿 ────────────────────────────────────────────────
const aiGenDesc = ref('')
const aiGenerating = ref(false)

/** 呼叫生成端點,把草稿載入編輯器(與範本同一條路:未存檔,人審後按「建立」才寫入) */
async function generateFromAi() {
  const description = aiGenDesc.value.trim()
  if (!description || aiGenerating.value) return
  if (!confirmLeaveIfDirty()) return
  aiGenerating.value = true
  try {
    const draft = await apiFetch<{ name: string; nodes: ScriptNode[]; rootNodeId: string }>(
      '/api/ai/scripts/generate',
      { method: 'POST', body: { description } },
    )
    isCreating.value = true
    selectedId.value = null
    form.value = {
      name: draft.name,
      enabled: true,
      priority: DEFAULT_SCRIPT_PRIORITY,
      rootNodeId: draft.rootNodeId,
      nodes: deepCloneNodes(draft.nodes),
    }
    markDirty()
    simReset()
    resetEditorDisclosure(form.value.nodes)
    aiGenDesc.value = ''
    showToast('草稿已生成——看看上面的流程圖、試跑一次，調整後按「建立客服流程」', 'success')
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.data?.statusMessage || err?.message || 'AI 生成失敗,換個說法再試一次', 'error')
  }
  finally {
    aiGenerating.value = false
  }
}

/** 從範本一鍵建立：載入到編輯器（尚未存檔，使用者微調後按建立才寫入） */
function createFromTemplate(tpl: ScriptTemplate) {
  if (!confirmLeaveIfDirty()) return
  isCreating.value = true
  selectedId.value = null
  form.value = {
    name: tpl.label,
    enabled: true,
    priority: DEFAULT_SCRIPT_PRIORITY,
    rootNodeId: tpl.rootNodeId,
    nodes: deepCloneNodes(tpl.nodes),
  }
  markDirty()
  simReset()
  resetEditorDisclosure(form.value.nodes)
}

function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedScript.value) {
    selectScript(selectedScript.value, { skipDiscardConfirm: true })
    isCreating.value = false
  }
  else {
    isCreating.value = false
    selectedId.value = null
    form.value = blankForm()
    markClean()
    resetEditorDisclosure(form.value.nodes)
  }
}

function deepCloneNodes(nodes: ScriptNode[] = []): ScriptNode[] {
  return JSON.parse(JSON.stringify(nodes || []))
}

// ── Node operations ─────────────────────────────────────────────────
function updateKeywords(node: ScriptTriggerNode, value: string) {
  node.keywords = String(value || '')
    .split(/[\n,，、\s]+/g)
    .map(k => k.trim())
    .filter(Boolean)
    .slice(0, 20)
}

/**
 * 觸發方式在畫面上是三選一（關鍵字／看意思／客人加好友時），但資料上是兩個欄位
 * （triggerEvent 事件型 vs matchMode 文字比對）——這裡是唯一一處換算，模板都吃這支。
 */
function triggerUiMode(node: ScriptTriggerNode): 'keyword' | 'semantic' | 'follow' {
  if (node.triggerEvent === 'follow') return 'follow'
  return (node.matchMode ?? 'keyword') === 'semantic' ? 'semantic' : 'keyword'
}

function setTriggerMode(node: ScriptTriggerNode, mode: string | number | boolean | undefined) {
  if (mode === 'follow') {
    node.triggerEvent = 'follow'
    return
  }
  // 切回文字比對：關鍵字／範例還留在欄位上，切回來就看得到（存檔時 follow 腳本才會被清空）
  delete node.triggerEvent
  const m: TriggerMatchMode = mode === 'semantic' ? 'semantic' : 'keyword'
  node.matchMode = m
  if (m === 'semantic' && !node.examples) node.examples = []
}

function updateExamples(node: ScriptTriggerNode, value: string) {
  // 一行一句（語意比對靠整句意思，不需逗號拆短詞）
  node.examples = String(value || '')
    .split(/\n+/g)
    .map(e => e.trim())
    .filter(Boolean)
    .slice(0, MAX_TRIGGER_EXAMPLES)
}

function addNode(type: 'collect' | 'reply' | 'branch' | 'quickReply' | 'tag' | 'saveLead' | 'module') {
  const nodes = form.value.nodes

  if (type === 'reply' || type === 'module') {
    // 終點步驟：通常只會有一個。若已有終點，這顆需手動接（當分支的某個出口）
    nodes.push(type === 'module' ? defaultModuleNode() : defaultReplyNode())
    return
  }

  // 其餘節點：插在最後一個 reply 之前，把「原本指到 reply 的節點」改指到新節點，
  // 新節點則接到那個 reply。沒 reply 時出口留空（驗證會擋）。
  const replyIdx = nodes.findIndex(n => n.type === 'reply')
  const reply = nodes[replyIdx] as ScriptReplyNode | undefined
  const nextId = reply?.id ?? ''
  const newNode: ScriptCollectNode | ScriptBranchNode | ScriptQuickReplyNode | ScriptTagNode | ScriptSaveLeadNode
    = type === 'collect' ? defaultCollectNode(nextId)
      : type === 'branch' ? defaultBranchNode(nextId)
        : type === 'quickReply' ? defaultQuickReplyNode(nextId)
          : type === 'tag' ? defaultTagNode(nextId)
            : defaultSaveLeadNode(nextId)

  if (!reply) {
    nodes.push(newNode)
    return
  }
  // 找「目前指到 reply 的那個節點」改指到新節點（涵蓋 trigger/collect 的 next、branch 的 defaultNext、
  // quickReply 的某個選項），讓新節點自動串進線性流程，避免變孤兒。
  const beforeReply = nodes.find(n =>
    ((n.type === 'trigger' || n.type === 'collect') && n.next === reply.id)
    || (n.type === 'branch' && n.defaultNext === reply.id)
    || (n.type === 'quickReply' && n.options.some(o => o.next === reply.id)),
  )
  if (beforeReply) {
    if (beforeReply.type === 'branch') beforeReply.defaultNext = newNode.id
    else if (beforeReply.type === 'quickReply') {
      const opt = beforeReply.options.find(o => o.next === reply.id)
      if (opt) opt.next = newNode.id
    }
    else if (beforeReply.type === 'trigger' || beforeReply.type === 'collect') beforeReply.next = newNode.id
  }
  nodes.splice(replyIdx, 0, newNode)
}

function removeNode(id: string) {
  const nodes = form.value.nodes
  const idx = nodes.findIndex(n => n.id === id)
  if (idx < 0) return
  const removed = nodes[idx]
  if (!removed || removed.type === 'trigger') return // trigger 不可移除

  // 接替出口：單一出口節點→其 next；branch→defaultNext；quickReply→首選項 next；reply→空
  const fallback = (removed.type === 'collect' || removed.type === 'tag' || removed.type === 'saveLead')
    ? removed.next
    : removed.type === 'branch'
      ? removed.defaultNext
      : removed.type === 'quickReply' ? (removed.options[0]?.next ?? '') : ''

  // 修補所有指向 removed.id 的出口（trigger/collect 的 next+skipNext、branch defaultNext+cases、quickReply options）
  for (const n of nodes) {
    if ((n.type === 'trigger' || n.type === 'collect') && n.next === id) n.next = fallback
    if (n.type === 'collect' && n.skipNext === id) n.skipNext = fallback
    if (n.type === 'branch') {
      if (n.defaultNext === id) n.defaultNext = fallback
      for (const c of n.cases) if (c.next === id) c.next = fallback
    }
    if (n.type === 'quickReply') {
      for (const o of n.options) if (o.next === id) o.next = fallback
    }
  }
  nodes.splice(idx, 1)
}

// ── Load / Save / Delete ────────────────────────────────────────────
onMounted(() => {
  loadScripts(true)
  loadTags({ status: 'active' }).catch(() => {})
  // 自己有 try/catch、失敗會轉成 reachabilityState='failed'（狀態列會據此改口），不會 reject
  loadReachabilityContext()
  loadModuleOptions()
})

async function submitForm() {
  const name = form.value.name.trim()
  if (!name) return showToast('請輸入流程名稱', 'error')
  // trigger 同步 priority
  const trig = form.value.nodes.find(n => n.type === 'trigger') as ScriptTriggerNode | undefined
  if (trig) trig.priority = form.value.priority

  saving.value = true
  try {
    const payload = {
      name,
      enabled: form.value.enabled,
      priority: form.value.priority,
      rootNodeId: form.value.rootNodeId,
      nodes: form.value.nodes,
    }
    if (isCreating.value) {
      const res = await apiFetch<{ id: string }>('/api/ai/scripts/create', { method: 'POST', body: payload })
      showToast('客服流程已建立', 'success')
      await loadScripts(true)
      const fresh = scripts.value.find(s => s.id === res.id)
      if (fresh) selectScript(fresh, { skipDiscardConfirm: true })
      isCreating.value = false
    }
    else if (selectedId.value) {
      await apiFetch(`/api/ai/scripts/${selectedId.value}`, { method: 'PUT', body: payload })
      showToast('已儲存', 'success')
      await loadScripts(true)
      markClean()
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.message || '儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

async function deleteScript() {
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(`確定刪除「${form.value.name}」這條客服流程？`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/ai/scripts/${selectedId.value}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    selectedId.value = null
    isCreating.value = false
    form.value = blankForm()
    markClean()
    await loadScripts(true)
  }
  catch {
    showToast('刪除失敗', 'error')
  }
}
</script>

<!-- 樣式見 app/assets/scss/pages/_ai-scripts.scss（與其他 admin 頁一致，不寫在 .vue） -->
