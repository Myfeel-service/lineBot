<template>
  <AdminSplitLayout :is-empty="!selectedScript && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title">腳本</span>
      <el-button v-if="canEditScripts" :icon="Plus" type="primary" size="small" data-tour="scr-new" @click="openCreate">新增</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <div v-if="loading && !scripts.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!scripts.length" class="split-sidebar-empty">
        <span>尚無腳本</span>
        <p class="text-xs text-muted">建一條情境流程，把多步驟客服變成自動流程</p>
        <el-button v-if="canEditScripts" size="small" type="primary" plain @click="openCreate">立即新增</el-button>
      </div>
      <div v-else ref="listEl" class="split-list" @scroll.passive="onSidebarListScroll">
        <AdminSplitListItem
          v-for="script in scripts"
          :key="script.id"
          :title="script.name || '(未命名腳本)'"
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
      <h3>選擇一條腳本開始{{ canEditScripts ? '編輯' : '檢視' }}</h3>
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
            <span class="text-xs text-muted">生成後會先進編輯器讓你檢查，按「建立腳本」才會存檔</span>
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
        field-label="腳本名稱"
        create-prefix="新增腳本:"
        placeholder="例：訂單查詢、退換貨流程"
        caption="為這條情境流程取個名"
        :is-creating="isCreating"
        @enter="submitForm"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button v-if="canEditScripts && !isCreating && selectedScript" :icon="Delete" type="danger" @click="deleteScript">刪除</el-button>
        <el-button @click="cancelEdit">{{ canEditScripts ? '取消' : '關閉' }}</el-button>
        <el-button v-if="canEditScripts" type="primary" :loading="saving" @click="submitForm">
          {{ isCreating ? '建立腳本' : '儲存變更' }}
        </el-button>
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <div class="ai-scripts-body admin-panel-stack">
        <!-- 試跑：假裝自己是客人打字，即時模擬這條腳本（純預覽，無副作用） -->
        <div class="message-card scripts-section-card scripts-sim-card">
          <div class="message-card-header scripts-sim-head" role="button" tabindex="0" @click="showSim = !showSim" @keydown.enter="showSim = !showSim">
            <div class="card-header-main">
              <span class="section-title">試跑這條腳本</span>
              <span class="text-xs text-muted">假裝客人打字，看機器人怎麼回（純預覽，不會真的發送）</span>
            </div>
            <el-icon class="scripts-sim-caret" :class="{ 'is-open': showSim }"><ArrowRight /></el-icon>
          </div>
          <div v-if="showSim" class="card-section-stack scripts-sim-panel">
            <div class="scripts-sim-chat">
              <p v-if="!simLog.length" class="scripts-sim-empty">輸入客人會打的第一句話開始（假設已經觸發這條腳本）</p>
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
              <el-input v-model="simInput" placeholder="輸入客人會打的話…" @keyup.enter="simSend()" />
              <el-button type="primary" @click="simSend()">送出</el-button>
              <el-button @click="simReset">重來</el-button>
            </div>
          </div>
        </div>

        <!-- 啟用 + 優先度 -->
        <div class="message-card scripts-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">基本設定</span>
              <span v-if="statsText" class="text-xs text-muted">{{ statsText }}</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="admin-field-group">
              <AdminFieldLabel text="啟用此腳本" tight />
              <el-switch
                v-model="form.enabled"
                active-text="啟用"
                inactive-text="停用"
              />
              <p class="scripts-section-hint">關掉後這條流程就不會啟動；就算關掉，AI 客服還是會照常回答客人。</p>
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel :text="`觸發優先度（${form.priority}）`" tight />
              <el-slider v-model="form.priority" :min="1" :max="100" :step="1" />
              <p class="scripts-section-hint">如果同一句話同時命中好幾條流程，數字越大的會先跑。預設 50，通常不用動。</p>
            </div>
          </div>
        </div>

        <!-- 節點清單 -->
        <div class="message-card scripts-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">流程步驟</span>
              <span class="text-xs text-muted">流程：觸發 → 收集（可多個）→ 回覆</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- 即時流程檢查：設定當下就顯示「還差什麼 / 已 OK」，沿用存檔時同一套驗證 -->
            <div class="scripts-flow-status" :class="flowIssue ? 'is-warn' : 'is-ok'">
              <el-icon v-if="flowIssue"><WarningFilled /></el-icon>
              <el-icon v-else><CircleCheckFilled /></el-icon>
              <span>{{ flowIssue ? `還差一步：${flowIssue}` : '流程完整，隨時可以儲存 ✓' }}</span>
            </div>

            <!-- 流程圖：即時把整條流程畫出來，分支往內縮一層、一眼看懂走向 -->
            <div v-if="flowRows.length" class="scripts-flow-map">
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
                    :class="nodeBadgeClass(row.type ?? 'reply')"
                    role="button"
                    tabindex="0"
                    @click="focusStep(row.id)"
                    @keydown.enter="focusStep(row.id)"
                  >
                    <el-icon><component :is="nodeIcon(row.type ?? 'reply')" /></el-icon>
                    <b>{{ row.title }}</b>
                    <span v-if="row.sub" class="scripts-flow-sub">{{ row.sub }}</span>
                  </span>
                  <span v-else-if="row.kind === 'label'" class="scripts-flow-label">{{ row.title }}</span>
                  <span v-else class="scripts-flow-note">{{ row.title }}</span>
                </div>
              </div>
            </div>

            <div class="scripts-node-list">
              <div v-for="node in form.nodes" :key="node.id" class="scripts-node-card" :class="{ 'is-focused': highlightStep === node.id }" :data-node-id="node.id">
                <div class="scripts-node-header">
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
                <p class="scripts-node-purpose">{{ nodePurpose(node.type) }}</p>

                <!-- Trigger -->
                <template v-if="node.type === 'trigger'">
                  <div class="admin-field-group">
                    <AdminFieldLabel text="觸發方式" tight />
                    <el-radio-group
                      :model-value="node.matchMode ?? 'keyword'"
                      size="small"
                      @change="setTriggerMode(node, $event)"
                    >
                      <el-radio-button value="keyword">關鍵字</el-radio-button>
                      <el-radio-button value="semantic">看意思</el-radio-button>
                    </el-radio-group>
                  </div>

                  <div v-if="(node.matchMode ?? 'keyword') === 'keyword'" class="admin-field-group">
                    <AdminFieldLabel text="關鍵字（任一命中即觸發）" tight />
                    <el-input
                      :model-value="node.keywords.join('，')"
                      placeholder="例：退換貨，退費，要退（用逗號或空白分隔）"
                      @update:model-value="updateKeywords(node, $event)"
                    />
                  </div>

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

                  <div class="admin-field-group scripts-trigger-test-group">
                    <AdminFieldLabel text="測試觸發（打一句話，看會不會啟動這條腳本）" tight />
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
                  <div class="admin-field-group">
                    <AdminFieldLabel text="欄位名稱（給答案取個代號，後面判斷、存名單、回覆帶入時都靠它）" tight />
                    <el-input v-model="node.fieldName" placeholder="例：order_id" />
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
                    <AdminFieldLabel text="自訂格式（進階比對規則，需懂正規表達式；不確定可先用上面的預設格式）" tight />
                    <el-input v-model="node.pattern" placeholder="例：[A-Za-z]\d{3,}（訂單編號 A123）" />
                  </div>
                  <div v-if="(node.format ?? 'any') !== 'any'" class="admin-field-group">
                    <AdminFieldLabel text="格式不符時的重問話術（可留空用預設）" tight />
                    <el-input v-model="node.reaskText" placeholder="例：訂單編號好像怪怪的，可以再確認一次嗎？" />
                  </div>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="客人答不出來時（選填）：多給一顆跳過按鈕，點了改走別條路" tight />
                    <div class="scripts-branch-case">
                      <span class="text-xs text-muted">按鈕</span>
                      <el-input v-model="node.skipLabel" maxlength="20" placeholder="例：我沒有訂單編號" class="scripts-branch-field" />
                      <span class="text-xs text-muted">→</span>
                      <el-select :model-value="node.skipNext ?? ''" size="small" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, node.skipNext ?? '', (id) => node.skipNext = id)">
                        <el-option v-for="t in targetOptions(node.id)" :key="t.value" :label="t.label" :value="t.value" />
                        <el-option-group label="接下一步（會新增一個步驟）">
                          <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                        </el-option-group>
                      </el-select>
                      <el-button v-if="node.skipLabel || node.skipNext" size="small" type="danger" plain @click="clearCollectSkip(node)">✕</el-button>
                    </div>
                    <p class="scripts-section-hint">問這一題時會多這顆按鈕。例：問訂單編號附「我沒有訂單編號」，點了就跳去改問 Email。兩格都留空＝不提供跳過。</p>
                  </div>
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
                  <div class="admin-field-group">
                    <AdminFieldLabel text="回覆後直接轉真人" tight />
                    <el-switch v-model="node.thenHandoff" active-text="開" inactive-text="關" />
                  </div>
                </template>

                <!-- Branch -->
                <template v-else-if="node.type === 'branch'">
                  <p class="scripts-section-hint">依照前面問到的答案決定接下來走哪條路。由上往下檢查，第一個符合的條件就走它。</p>
                  <div v-for="(c, ci) in node.cases" :key="ci" class="scripts-branch-case">
                    <span class="text-xs text-muted">如果</span>
                    <el-select :model-value="c.field" filterable size="small" placeholder="選欄位" class="scripts-branch-field" @change="c.field = $event">
                      <el-option v-for="f in collectFieldOptions" :key="f.value" :label="f.label" :value="f.value" />
                    </el-select>
                    <el-select :model-value="c.op" size="small" class="scripts-branch-op" @change="setBranchOp(c, $event)">
                      <el-option label="有填寫" value="exists" />
                      <el-option label="等於" value="equals" />
                      <el-option label="包含" value="contains" />
                    </el-select>
                    <el-input v-if="c.op !== 'exists'" v-model="c.value" placeholder="比較值" class="scripts-branch-value" />
                    <span class="text-xs text-muted">→</span>
                    <el-select :model-value="c.next" size="small" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, c.next, (id) => c.next = id)">
                      <el-option v-for="o in targetOptions(node.id)" :key="o.value" :label="o.label" :value="o.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                    <el-button size="small" type="danger" plain @click="removeBranchCase(node, ci)">✕</el-button>
                  </div>
                  <el-button size="small" plain @click="addBranchCase(node)">＋ 新增條件</el-button>
                  <div class="admin-field-group">
                    <AdminFieldLabel text="其餘情況（都不符合時）→ 前往" tight />
                    <el-select :model-value="node.defaultNext" size="small" placeholder="前往…" @change="onTargetChange($event, node.defaultNext, (id) => node.defaultNext = id)">
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
                  <div v-for="(o, oi) in node.options" :key="oi" class="scripts-branch-case">
                    <span class="text-xs text-muted">按鈕</span>
                    <el-input v-model="o.label" placeholder="按鈕文字（≤20 字）" class="scripts-branch-field" />
                    <span class="text-xs text-muted">→</span>
                    <el-select :model-value="o.next" size="small" placeholder="前往…" class="scripts-branch-next" @change="onTargetChange($event, o.next, (id) => o.next = id)">
                      <el-option v-for="t in targetOptions(node.id)" :key="t.value" :label="t.label" :value="t.value" />
                      <el-option-group label="接下一步（會新增一個步驟）">
                        <el-option v-for="p in newStepOptions" :key="p.value" :label="p.label" :value="p.value" />
                      </el-option-group>
                    </el-select>
                    <el-button size="small" type="danger" plain @click="removeQuickReplyOption(node, oi)">✕</el-button>
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
                  <div v-for="(m, mi) in node.fieldMap" :key="mi" class="scripts-branch-case">
                    <span class="text-xs text-muted">收集欄位</span>
                    <el-select :model-value="m.fromField" filterable size="small" placeholder="選欄位" class="scripts-branch-field" @change="m.fromField = $event">
                      <el-option v-for="f in collectFieldOptions" :key="f.value" :label="f.label" :value="f.value" />
                    </el-select>
                    <span class="text-xs text-muted">→ 屬性名稱</span>
                    <el-input v-model="m.attrKey" placeholder="如 訂單編號" class="scripts-branch-field" />
                    <el-button size="small" type="danger" plain @click="removeSaveLeadField(node, mi)">✕</el-button>
                  </div>
                  <el-button size="small" plain @click="addSaveLeadField(node)">＋ 新增欄位</el-button>
                </template>

                <!-- 下一步摘要：把自動接線/結束這種看不見的去向講出來 -->
                <p v-if="autoNextLabel(node)" class="scripts-next-hint" :class="{ 'is-unwired': isNodeUnwired(node) }">
                  ↳ 下一步：<strong>{{ autoNextLabel(node) }}</strong>
                </p>
              </div>
            </div>

            <div class="scripts-add-palette">
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

            <p class="scripts-section-hint">
              一般步驟會由上到下自動接下去；只有「分支」和「快速回覆」要自己用「前往…」下拉，指定每條路各接到哪一步。
            </p>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { ArrowRight, ChatDotRound, CircleCheckFilled, Collection, Delete, MagicStick, Notebook, Operation, Plus, Pointer, Position, PriceTag, Share, WarningFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { v4 as uuidv4 } from 'uuid'
import type {
  BranchOp,
  ScriptBranchNode,
  ScriptCollectNode,
  ScriptDoc,
  ScriptNode,
  ScriptQuickReplyNode,
  ScriptReplyNode,
  ScriptSaveLeadNode,
  ScriptTagNode,
  ScriptTriggerNode,
  TriggerMatchMode,
} from '~~/shared/types/ai-script'
import { DEFAULT_COLLECT_EXPIRE_MS, DEFAULT_SCRIPT_PRIORITY, MAX_TRIGGER_EXAMPLES, collectSkipLabel, extractCollectValue, isHumanRequestText, renderScriptTemplate, resolveBranchNext, validateScriptDoc } from '~~/shared/types/ai-script'
import { SCRIPT_TEMPLATES, type ScriptTemplate } from '~~/shared/types/ai-script-templates'

definePageMeta({ middleware: ['auth', 'ai-feature'], layout: 'default' })

const { apiFetch, can } = useWorkspace()
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
const { markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
  // 腳本節點流程可能編很久；F5 / 關分頁也要攔，避免整段遺失
  enableBeforeUnload: true,
})

const selectedScript = computed(() => scripts.value.find(s => s.id === selectedId.value) ?? null)

const statsText = computed(() => {
  if (isCreating.value) return ''
  const stats = selectedScript.value?.stats
  const starts = stats?.starts ?? 0
  const completions = stats?.completions ?? 0
  if (!starts) return ''
  const rate = Math.round((completions / starts) * 100)
  return `啟動 ${starts} 次・完成 ${completions} 次（完成率 ${rate}%）`
})

/**
 * 即時流程檢查：沿用「後端存檔時同一套」validateScriptDoc，設定當下就知道還差什麼、
 * 不用按了儲存才被擋。名稱用佔位符帶入 → 這條專講「流程結構」問題，腳本名稱由標題欄位與送出時把關。
 */
const flowIssue = computed(() =>
  validateScriptDoc({ name: form.value.name.trim() || '未命名腳本', nodes: form.value.nodes, rootNodeId: form.value.rootNodeId }),
)

// ── List helpers ───────────────────────────────────────────────────
function triggerSummary(script: ScriptRow): string {
  const trig = script.nodes?.find(n => n.type === 'trigger') as ScriptTriggerNode | undefined
  if (!trig) return '無觸發條件'
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
  return ChatDotRound
}

function nodeTypeLabel(type: string) {
  if (type === 'trigger') return '觸發'
  if (type === 'collect') return '收集'
  if (type === 'branch') return '分支'
  if (type === 'quickReply') return '快速回覆'
  if (type === 'tag') return '貼標'
  if (type === 'saveLead') return '寫名單'
  return '回覆'
}

function nodeBadgeClass(type: string) {
  if (type === 'trigger') return 'scripts-node-badge--trigger'
  if (type === 'collect') return 'scripts-node-badge--collect'
  if (type === 'branch') return 'scripts-node-badge--branch'
  if (type === 'quickReply') return 'scripts-node-badge--quickreply'
  if (type === 'tag' || type === 'saveLead') return 'scripts-node-badge--action'
  return 'scripts-node-badge--reply'
}

/** 給「下一步」下拉用的節點選項標籤（trigger 不能當目標） */
function nodeOptionLabel(n: ScriptNode): string {
  if (n.type === 'collect') return `收集 ${n.fieldName || '(未命名)'}`
  if (n.type === 'branch') return '分支'
  if (n.type === 'quickReply') return `快速回覆${n.question ? `「${n.question.slice(0, 8)}」` : ''}`
  if (n.type === 'tag') return '貼標'
  if (n.type === 'saveLead') return '寫名單'
  if (n.type === 'reply') return `回覆「${(n.text || '').slice(0, 8) || '空白'}」`
  return '觸發'
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
    const list = ((node.matchMode ?? 'keyword') === 'semantic' ? (node.examples ?? []) : (node.keywords ?? [])).filter(Boolean)
    return list.length ? `${list.slice(0, 3).join('、')}${list.length > 3 ? '…' : ''}` : '未設條件'
  }
  if (node.type === 'collect' || node.type === 'quickReply') return node.question ? `問「${flowTruncate(node.question)}」` : ''
  if (node.type === 'reply') return node.thenHandoff ? '回覆後轉真人 → 結束' : '回覆 → 結束'
  if (node.type === 'tag') return `${node.addTagIds.length} 個標籤`
  if (node.type === 'saveLead') return `存 ${node.fieldMap.length} 個欄位`
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
    else if (node.type !== 'reply') {
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
const newStepOptions = [
  { value: '__new:collect', label: '＋ 新增：收集（問一個問題）' },
  { value: '__new:quickReply', label: '＋ 新增：快速回覆（給按鈕）' },
  { value: '__new:branch', label: '＋ 新增：分支（依答案分流）' },
  { value: '__new:tag', label: '＋ 新增：貼標' },
  { value: '__new:saveLead', label: '＋ 新增：寫名單' },
  { value: '__new:reply', label: '＋ 新增：回覆（結束）' },
]

function makeStep(type: 'collect' | 'quickReply' | 'branch' | 'tag' | 'saveLead' | 'reply', nextId: string): ScriptNode {
  if (type === 'collect') return defaultCollectNode(nextId)
  if (type === 'quickReply') return defaultQuickReplyNode(nextId)
  if (type === 'branch') return defaultBranchNode(nextId)
  if (type === 'tag') return defaultTagNode(nextId)
  if (type === 'saveLead') return defaultSaveLeadNode(nextId)
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
    const type = value.slice(6) as 'collect' | 'quickReply' | 'branch' | 'tag' | 'saveLead' | 'reply'
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
const nodePalette: Array<{ group: string; items: Array<{ type: 'collect' | 'quickReply' | 'reply' | 'branch' | 'tag' | 'saveLead'; name: string; desc: string }> }> = [
  { group: '常用', items: [
    { type: 'collect', name: '收集', desc: '問客人一個問題、記住答案' },
    { type: 'quickReply', name: '快速回覆', desc: '給幾顆按鈕讓客人點選' },
    { type: 'reply', name: '回覆', desc: '機器人回一句話，可結束或轉真人' },
  ] },
  { group: '進階', items: [
    { type: 'branch', name: '分支', desc: '依前面的答案自動走不同路' },
    { type: 'tag', name: '貼標', desc: '自動幫這位客人貼上標籤' },
    { type: 'saveLead', name: '寫名單', desc: '把答案長期存進客人資料' },
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
    if (node.type === 'saveLead') { simPush({ who: 'sys', text: '（寫名單：已把答案存進客人資料）' }); cursor = node.next; continue }
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
    if (node.type === 'reply') {
      simPush({ who: 'bot', text: renderScriptTemplate(node.text, { collected: simCollected.value }) })
      if (node.thenHandoff) simPush({ who: 'sys', text: '↳ 轉真人客服' })
      simDone.value = true; simWaiting.value = null; return
    }
    return
  }
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
    if (!trig || trig.type !== 'trigger') { simPush({ who: 'sys', text: '（這條腳本沒有觸發步驟）' }); return }
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
  return ''
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

/** 清掉收集節點的跳過出口（兩格一起清，避免留單邊被存檔驗證擋下） */
function clearCollectSkip(node: ScriptCollectNode) {
  node.skipLabel = ''
  node.skipNext = ''
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
}

function openCreate() {
  if (!confirmLeaveIfDirty()) return
  isCreating.value = true
  selectedId.value = null
  form.value = blankForm()
  markClean()
  simReset()
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
    markClean()
    simReset()
    aiGenDesc.value = ''
    showToast('草稿已生成——看看上面的流程圖、試跑一次,調整後按「建立腳本」', 'success')
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
  markClean()
  simReset()
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

function setTriggerMode(node: ScriptTriggerNode, mode: string | number | boolean | undefined) {
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

function addNode(type: 'collect' | 'reply' | 'branch' | 'quickReply' | 'tag' | 'saveLead') {
  const nodes = form.value.nodes

  if (type === 'reply') {
    // 新增 reply：通常只會有一個。若已有 reply，這顆需手動接（當分支的某個出口）
    nodes.push(defaultReplyNode())
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
})

async function submitForm() {
  const name = form.value.name.trim()
  if (!name) return showToast('請輸入腳本名稱', 'error')
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
      showToast('腳本已建立', 'success')
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
    await ElMessageBox.confirm(`確定刪除「${form.value.name}」這條腳本？`, '刪除確認', {
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
