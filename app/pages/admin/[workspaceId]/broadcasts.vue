<template>
  <AdminSplitLayout :is-empty="!selectedItem && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title" data-tour="bc-title">推播<AdminPageHelpButton :topics="['broadcasts']" /></span>
      <el-button v-if="canOperate" :icon="Plus" type="primary" size="small" data-tour="bc-new" @click="openCreate">新增</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
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
        <el-button v-if="canOperate" size="small" type="primary" plain @click="openCreate">立即新增</el-button>
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
      <p>或點擊左側「新增」建立新推播</p>
      <div class="empty-actions">
        <el-button v-if="canOperate" type="primary" @click="openCreate">新增推播</el-button>
        <!-- 空清單＝最不打擾的教學位（D-33 P2）：這裡本來就沒東西可看 -->
        <AdminPageHelpButton :topics="['broadcasts']" label="第一次用？看一遍怎麼發" />
      </div>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <AdminEditorHeaderTitle
        v-model="form.name"
        field-label="推播名稱"
        create-prefix="新增推播:"
        placeholder="請輸入推播名稱…"
        caption="為這則推播命名，方便後續管理"
        :is-creating="isCreating"
      />
      <div class="flex gap-1 admin-header-actions">
        <!-- 已完成/取消 → 只看報表；失敗 → 多一個重發出口 -->
        <template v-if="isReadOnly">
          <el-button
            v-if="canOperate && selectedItem?.status === 'failed'"
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
            v-if="canOperate && !isCreating && selectedItem && ['draft','scheduled'].includes(selectedItem.status)"
            type="danger"
            plain
            @click="cancelBroadcast"
          >
            {{ selectedItem.status === 'scheduled' ? '取消排程' : '取消推播' }}
          </el-button>
          <el-button @click="cancelEdit">取消</el-button>
          <el-button v-if="canOperate" :loading="saving" @click="saveDraft">
            {{ selectedItem?.status === 'scheduled' ? '儲存變更' : '儲存草稿' }}
          </el-button>
          <el-button v-if="canOperate" type="primary" :loading="validating" data-tour="bc-send" @click="openValidateDialog">
            {{ headerSubmitLabel }}
          </el-button>
        </template>
      </div>
    </template>

    <!-- ── Editor Body（與其他編輯頁相同：可捲動 + padding + 區塊間距）── -->
    <template #editor-body>
      <div class="ar-editor-body admin-panel-stack">
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
              <el-radio-group v-model="form.audienceType" :disabled="isReadOnly">
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
                :disabled="isReadOnly"
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
                :disabled="isReadOnly"
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
            <AdminAreaActionEditor
              :model-value="form.contentAction"
              :module-options="flowOptions"
              :disabled="isReadOnly"
              @update:model-value="onContentActionUpdate"
            />
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
              <el-radio-group v-model="form.scheduleMode">
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
                :disabled="isReadOnly"
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
              />
              <p v-if="selectedItem?.status === 'scheduled'" class="tags-hint">
                已排程，時間到後系統會自動發送（開著這個推播列表頁最保險；若要完全自動、關頁也能發，需請工程人員設定好伺服器）。可以「儲存變更」或「取消排程」。
              </p>
              <p v-else class="tags-hint">
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
    </template>
  </AdminSplitLayout>

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
import { Plus, Promotion } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import type { UnifiedAction } from '~~/shared/action-schema'
import { normalizeUnifiedAction, validateUnifiedAction } from '~~/shared/action-schema'
import { parseLineMessagesToUnifiedAction, unifiedActionToLineMessages } from '~~/shared/broadcast-content'
import {
  BROADCAST_AUDIENCE_HANDOFF_KEY,
  handoffNoticeText,
  isFreshHandoff,
  parseHandoff,
} from '~~/shared/broadcast-audience-handoff'
import {
  localDateTimeInputToUtcIso,
  validateFutureScheduleLocalInput,
} from '~~/shared/broadcast-schedule-time'
import { parseFirestoreDate } from '~~/shared/firestore-date'
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

const { workspaceId, apiFetch } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()

// ── 狀態 ────────────────────────────────────────────────────────────
const flows = ref<{ id: string; name: string }[]>([])
const { tags: allTags, loadTags: loadTagOptions } = useAdminTagList()
// C-208：這一頁不給就地建標籤（受眾是拿標籤篩人），但別頁建了之後切回來要看得到
useAdminTagRefresh().onAdminTagListChanged(() => loadTagOptions({ status: 'active' }))
// 「只看草稿」篩選（D-43④）：list 端點本來就吃 ?status=，這裡只是把它接到畫面上
const draftFilterOn = ref(false)
const {
  items: broadcasts,
  loading,
  loadingMore,
  listEl,
  load: loadBroadcasts,
  onScroll: onSidebarListScroll,
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
})
const form = ref(defaultForm())
const { markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
})

const flowOptions = computed(() =>
  (flows.value ?? []).map((f) => ({ id: f.id, name: f.name || f.id })),
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

function loadFormFromItem(item: any) {
  const src = item.audienceSource ?? {}
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
    flows.value = (flowList ?? []).map((f: any) => ({ id: f.id, name: f.name || f.id }))
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
  if (!assertCanOperate()) return false
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
  if (!assertCanOperate()) return
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
  if (!assertCanOperate()) return
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
  if (!assertCanOperate()) return
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
  if (!assertCanOperate()) return
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
  if (!canOperate.value) return
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

onMounted(async () => {
  await loadData()
  applyAudienceHandoff()
  syncDuePollTimer()
})

onUnmounted(() => {
  if (duePollTimer) clearInterval(duePollTimer)
})
</script>
