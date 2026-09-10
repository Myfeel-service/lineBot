<template>
  <AdminSplitLayout :is-empty="!selectedCampaign && !isCreating">
    <!-- ── Sidebar Header ── -->
    <template #sidebar-header>
      <span class="split-sidebar-title">活動貼標<AdminPageHelpButton :topics="['campaigns']" /></span>
      <el-button v-if="canOperate" :icon="Plus" type="primary" size="small" data-tour="cmp-new" @click="openCreate">新增</el-button>
    </template>

    <!-- ── Sidebar List ── -->
    <template #sidebar-list>
      <div v-if="loading && !campaigns.length" class="split-sidebar-loading">
        <div class="spinner" />
      </div>
      <div v-else-if="!campaigns.length" class="split-sidebar-empty">
        <span>尚無活動</span>
        <p class="text-xs text-muted">建立問券活動，讓加好友即自動貼標</p>
        <el-button v-if="canOperate" size="small" type="primary" plain @click="openCreate">立即新增</el-button>
      </div>
      <div v-else ref="listEl" class="split-list" data-tour="cmp-list" @scroll.passive="onSidebarListScroll">
        <AdminSplitListItem
          v-for="c in campaigns"
          :key="c.id"
          :title="c.name"
          :active="selectedId === c.id"
          time-in-title-row
          title-row-chip
          :chip-text="c.isActive ? '啟用' : '停用'"
          :chip-tone="c.isActive ? 'success' : 'neutral'"
          @select="selectCampaign(c)"
        />

        <div v-if="loadingMore" class="admin-sidebar-load-more">
          <div class="spinner" />
          <span>載入更多…</span>
        </div>
      </div>
    </template>

    <!-- ── Empty State ── -->
    <template #editor-empty>
      <el-icon class="empty-icon"><Tickets /></el-icon>
      <h3>選擇一個活動開始編輯</h3>
      <p>或點擊左側「新增」建立新的活動貼標設定</p>
      <div class="empty-actions">
        <el-button v-if="canOperate" type="primary" @click="openCreate">新增活動</el-button>
        <AdminPageHelpButton :topics="['campaigns']" label="第一次用？看一遍怎麼設" />
      </div>
    </template>

    <!-- ── Editor Header ── -->
    <template #editor-header>
      <AdminEditorHeaderTitle
        v-model="form.name"
        field-label="活動名稱"
        create-prefix="新增活動:"
        placeholder="例：2026 Q2 上線通知問券"
        caption="為此次活動命名，方便後續識別"
        :is-creating="isCreating"
        @enter="submitForm"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button v-if="canOperate && !isCreating && selectedCampaign" :icon="Delete" type="danger" @click="deleteCampaign">
          刪除
        </el-button>
        <el-button @click="cancelEdit">取消</el-button>
        <!--
          ⛔ 按下去會拿到假結果才擋（房規）：沒有 LIFF＝存了也產不出連結，這種要擋。
          原本是「填完一整張表 → 按儲存 → 閃過一行紅字 → 什麼都沒發生」；按鈕上看不出
          任何異狀，橫幅也還是琥珀色（＝提醒），顏色跟行為對不起來。
          ⚠️ 登記錯（mismatch／broken）**不擋**——那種情況連結是對的，人去 LINE 改完就通。
          span 是給 tooltip 掛的：按鈕 disabled 之後自己不會發出滑鼠事件。
        -->
        <el-tooltip
          v-if="canOperate"
          :disabled="!saveBlockedReason"
          :content="saveBlockedReason"
          placement="bottom-end"
        >
          <span>
            <el-button
              type="primary"
              :loading="saving"
              :disabled="Boolean(saveBlockedReason)"
              @click="submitForm"
            >
              {{ isCreating ? '建立活動' : '儲存變更' }}
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </template>

    <!-- ── Editor Body ── -->
    <template #editor-body>
      <div class="ar-editor-body admin-panel-stack">

        <!-- 狀態設定 -->
        <div class="message-card cmp-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">狀態設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!--
              ⛔ 原本這裡寫「停用的活動儲存後會隱藏活動進入網址」，兩件事都不是真的：
              網址照樣顯示，而且客人端根本沒讀過啟用狀態——停用後舊連結還是能綁定貼標。
              2026-09-10 拍板讓停用真的擋掉連結（server/utils/lead-campaign-active.ts）後，
              這句話才改成現在的說法。
            -->
            <p class="ar-section-hint">
              停用後，客人點這個活動的連結會看到「活動已結束」，後台也會把網址收起來。
              重新啟用並儲存，同一串網址會再生效（不會換一組新的）。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="啟用狀態" tight />
              <el-switch
                v-model="form.isActive"
                active-text="啟用中"
                inactive-text="已停用"
                class="ar-status-switch"
              />
            </div>
          </div>
        </div>

        <!-- 活動設定 -->
        <div class="message-card cmp-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">活動設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!--
              沒設活動頁（LIFF）要**提前**講（D-33 P1）。
              以前這件事只有按下「儲存」才擋（送出驗證那句「請先到組織與 LINE 設定預設 LIFF」），
              所以是「填完一整張表才發現做不出連結」。教學也早就寫好了（liffSetup），這頁一行都沒用到。
              ⚠️三態：讀不到 LIFF 設定時講「查不到」，⛔不可以講成「沒設定」（會叫人去改本來好的設定）。
            -->
            <AdminBlockStatus
              v-if="liffBanner"
              :tone="liffBanner.tone"
              :title="liffBanner.title"
              :detail="liffBanner.detail"
              action-label="去設定活動頁"
              @action="goSetLiff"
            >
              <!--
                就地把事情做完（`G-81`）：原本只有一顆「去設定活動頁」，跳過去之後
                沒有任何一條路回得來，填到一半的表單也在跳走時被丟掉。這裡直接給
                ①要貼到 LINE 的網址 ②貼回來的輸入框，人不用離開這一頁。
              -->
              <div v-if="liffBanner.setup !== 'none'" class="cmp-liff-fix">
                <template v-if="liffExpectedUrl">
                  <p class="cmp-liff-step">
                    <b>①</b> 複製這串網址，貼到 LINE Developers →
                    <b>LINE Login</b> 那張卡 → LIFF → 該 LIFF 的 <b>Endpoint URL</b>
                  </p>
                  <div class="cmp-url-row">
                    <el-input :model-value="liffExpectedUrl" readonly />
                    <el-button @click="copyLiffExpectedUrl">複製</el-button>
                  </div>
                </template>
                <p v-else class="cmp-url-hint">
                  系統這邊還沒設定正式網址，給不出要貼的活動頁網址——請到「組織與 LINE」設定處理。
                </p>

                <template v-if="liffBanner.setup === 'fill'">
                  <p class="cmp-liff-step">
                    <b>②</b> 建好之後把 <b>LIFF ID</b> 貼回這裡（長得像 2007123456-AbCdEfGh）
                  </p>
                  <div class="cmp-url-row">
                    <el-input v-model="inlineLiffId" placeholder="2007123456-AbCdEfGh" />
                    <el-button type="primary" :loading="savingInlineLiff" @click="saveInlineLiff">
                      存起來並檢查
                    </el-button>
                  </div>
                </template>
                <div v-else>
                  <el-button size="small" :loading="liffChecking" @click="loadLiffChecks({ force: true })">
                    改好了，重新檢查
                  </el-button>
                </div>

                <p class="ar-section-hint">
                  不知道去哪設、要填什麼？<AdminFieldHelp id="liffSetup" />
                </p>
              </div>
            </AdminBlockStatus>

            <!--
              客人打不開的時候，商家本來完全不會知道（`G-82`）：登記檢查只查得到
              「Endpoint URL 有沒有寫對」，連結被轉傳截斷、LIFF 被停用這些它都看不到。
              ⚠️ 講「次」不講「位客人」——回報端點沒辦法驗身分，這是提醒訊號不是報表。
            -->
            <AdminBlockStatus
              v-if="leadErrors && !leadErrors.ok"
              tone="unknown"
              title="這次查不到客人在活動頁的失敗紀錄"
              detail="重新整理可以再試一次。這不代表沒有客人失敗。"
            />
            <AdminBlockStatus
              v-else-if="leadErrorRows.length"
              :tone="leadErrorFaultTotal > 0 ? 'critical' : 'warning'"
              :title="`近 ${leadErrors?.days ?? 7} 天有 ${leadErrors?.total ?? 0} 次打不開活動頁`"
              detail="這些是客人那一端實際回報的，不是推算的。"
            >
              <ul class="cmp-lead-errors">
                <li v-for="row in leadErrorRows" :key="row.reason">
                  <span class="cmp-lead-errors__count">{{ row.count }} 次</span>
                  <span class="cmp-lead-errors__label">{{ row.label }}</span>
                  <span class="cmp-lead-errors__hint">{{ row.hint }}</span>
                </li>
              </ul>
              <p v-if="leadErrors?.truncated" class="cmp-url-hint">
                失敗筆數太多，這裡只算得到最近一段——實際次數比上面顯示的更多。
              </p>
            </AdminBlockStatus>
            <p v-else-if="leadErrors" class="ar-section-hint">
              近 {{ leadErrors.days }} 天沒有客人回報打不開活動頁。
            </p>

            <p class="ar-section-hint">
              這裡是客服／行政日常會看的重點。活動連結會在儲存後自動更新。
            </p>
            <div class="admin-field-group">
              <AdminFieldLabel text="活動說明（選填）" tight />
              <el-input
                v-model="form.description"
                type="textarea"
                :rows="2"
                placeholder="備註此活動的用途或來源"
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="完成後轉址網址（選填）" tight />
              <p class="text-xs text-muted">客人綁定完成後，自動幫他跳到這個網址（例：問卷的感謝頁）。留空的話就停在「綁定成功」畫面。</p>
              <el-input
                v-model="form.redirectUrl"
                placeholder="https://example.com/thank-you"
                clearable
              />
            </div>
            <div class="admin-field-group">
              <AdminFieldLabel text="活動檔期（選填）" tight />
              <p class="text-xs text-muted">僅供內部／行銷紀錄，不影響連結或貼標；清空後儲存可刪除。</p>
              <div class="flex flex-wrap gap-2 admin-w-full">
                <el-date-picker
                  v-model="form.startsAt"
                  type="datetime"
                  placeholder="開始時間"
                  value-format="YYYY-MM-DDTHH:mm:ss"
                  class="admin-w-full cmp-date-field"
                />
                <el-date-picker
                  v-model="form.endsAt"
                  type="datetime"
                  placeholder="結束時間"
                  value-format="YYYY-MM-DDTHH:mm:ss"
                  class="admin-w-full cmp-date-field"
                />
              </div>
            </div>

            <template v-if="!isCreating && selectedCampaign">
              <hr class="divider">
              <h4 class="admin-field-title">活動進入網址（貼標用）</h4>
              <p class="ar-section-hint">
                這個網址給客服／行政貼到問卷完成頁、簡訊、廣告按鈕即可。
                使用者點入後會先綁 LINE；之後加官方帳號為好友時，系統才會自動貼上本活動標籤。
              </p>
              <div class="admin-field-group">
                <AdminFieldLabel text="活動進入網址" tight />
                <!--
                  ⛔ 看「存起來的」啟用狀態不是表單開關：用表單的話，人一撥開關網址就
                  先消失，但那時連結其實還活著（要按儲存才生效），畫面會比事實早一步。
                -->
                <div v-if="!savedIsActive" class="ar-any-text-note">
                  活動已停用，這串連結現在點下去會被擋掉（客人看到「活動已結束」）。
                  重新啟用並儲存後，同一串網址會再生效。
                </div>
                <div v-else-if="ctaUrl" class="cmp-url-row">
                  <el-input :model-value="ctaUrl" readonly />
                  <el-button @click="copyCtaUrl">複製</el-button>
                </div>
                <div v-else class="ar-any-text-note">
                  {{ ctaMissingReason }}
                </div>
              </div>

              <hr class="divider">
              <div class="flex items-center justify-between gap-2">
                <h4 class="admin-field-title">行銷成效</h4>
                <el-button size="small" :loading="statsLoading" @click="loadStats">重新整理</el-button>
              </div>
              <p class="ar-section-hint">
                看法很簡單：先看「待加好友」有多少，再看「已加好友並貼標」有多少。
                「加好友→貼標完成率」越高，代表這波活動名單越順利轉成可用名單。
              </p>
              <div v-if="statsLoading" class="ar-modules-loading">
                <div class="spinner" />
              </div>
              <div v-else-if="stats" class="cmp-stats-row">
                <div class="cmp-stat-box">
                  <div class="cmp-stat-label">已加好友並貼標</div>
                  <div class="cmp-stat-value">{{ stats.applied }}</div>
                </div>
                <div class="cmp-stat-box">
                  <div class="cmp-stat-label">待加好友（只綁 LINE）</div>
                  <div class="cmp-stat-value">{{ stats.claimed }}</div>
                </div>
                <div class="cmp-stat-box">
                  <div class="cmp-stat-label">加好友→貼標完成率</div>
                  <div class="cmp-stat-value">{{ stats.tagCompletionRate }}%</div>
                  <div v-if="stats.claimed + stats.applied === 0" class="cmp-stat-sub text-xs text-muted">尚無已完成綁定的名單</div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 貼標與觸發設定 -->
        <div class="message-card cmp-section-card" data-tour="cmp-tagsection">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">貼標與觸發設定</span>
            </div>
          </div>
          <div class="card-section-stack">
            <p class="ar-section-hint">
              參考「觸發動作設定」的操作方式：先選要貼的標籤（此欄必填），再設定機器人模組／動作（選填）。
              實際執行時機都是「使用者加好友當下」。
            </p>
            <div v-if="tagsLoading" class="ar-modules-loading">
              <div class="spinner" />
            </div>
            <div v-else-if="!allTags.length" class="ar-no-modules">
              尚無標籤，請先前往「<NuxtLink :to="`/admin/${workspaceId}/tags`" class="ar-link">標籤管理</NuxtLink>」建立。
            </div>
            <div v-else class="admin-field-group">
              <AdminFieldLabel text="選擇標籤（至少一個）" tight />
              <el-select
                v-model="form.tagIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                placeholder="選擇要貼的標籤"
                class="admin-w-full"
              >
                <el-option
                  v-for="tag in allTags"
                  :key="tag.id"
                  :label="tag.name"
                  :value="tag.id"
                >
                  <AdminTagOptionRow :label="tag.name" :color="tag.color" />
                </el-option>
              </el-select>
            </div>
            <div v-if="modulesLoading" class="ar-modules-loading">
              <div class="spinner" />
            </div>
            <div v-else class="admin-field-group" data-tour="cmp-action">
              <FlowActionEditor
                :action="form.action"
                :type-options="campaignActionTypeOptions"
                :module-options="modules"
                :variable-options="[]"
                header-label=""
                flat
                :show-label-field="false"
                :show-variable-inset="false"
                :hide-fields-when-none="true"
                none-type-value="none"
                module-title="機器人模組"
                module-placeholder="請選擇要觸發的模組"
                text-title="回覆文字"
                text-placeholder="輸入要回覆給使用者的文字（可換行分段）"
                :text-multiline="true"
                uri-title="網址"
                uri-placeholder="https://..."
              />
              <p class="text-xs text-muted">可清空成「不觸發動作」；此時系統只會貼標，不會推送訊息或模組。</p>
            </div>
          </div>
        </div>

      </div>
    </template>
  </AdminSplitLayout>

</template>

<script setup lang="ts">
import { Delete, Plus, Tickets } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { LIFF_ID_RE } from '~~/shared/liff-lead-path'
import { LEAD_FAILURE_LABELS, LEAD_FAILURE_REASONS, type LeadFailureReason } from '~~/shared/lead-page-failure'
definePageMeta({ middleware: 'auth', layout: 'default' })

// canManageSettings：LIFF 登記狀態的檢查端點限管理員（客服查不到，見 liffVerdict）
const { workspaceId, apiFetch, canManageSettings } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()

const { tags: allTags, loading: tagsLoading, loadTags } = useAdminTagList()
const { showToast } = useAdminToast()

const modules = ref<any[]>([])
const {
  items: campaigns,
  loading,
  loadingMore,
  listEl,
  load: loadCampaigns,
  onScroll: onSidebarListScroll,
} = useWorkspaceSidebarList<any>('/api/campaigns/list')
const modulesLoading = ref(true)
const saving = ref(false)
const selectedId = ref<string | null>(null)
const isCreating = ref(false)
const ctaUrl = ref('')
const stats = ref<{
  applied: number
  claimed: number
  tagCompletionRate: number
} | null>(null)
const statsLoading = ref(false)
/** 產 CTA 時實際 fallback 的預設 LIFF（僅 Firestore） */
const effectiveDefaultLiffId = ref('')
/** LIFF 讀取是否失敗（區分「未設定」與「讀不到」，避免誤導成缺 LIFF） */
const liffLoadFailed = ref(false)
/**
 * 問過了沒。⛔ 沒有這個旗標的話，第一次繪製時 `effectiveDefaultLiffId` 還是空字串，
 * 畫面會先閃一下紅色的「還沒設定活動頁」——對設定好好的帳號說謊，只是說得很短。
 */
const liffConfigLoaded = ref(false)

// ── LINE 上的登記狀態（`G-81`）────────────────────────────────────────────
// ⛔ 這一頁原本只檢查「LIFF ID 這一格有沒有字」，等於**沒填就紅、填了就綠**。
// 但客人打不開的頭號原因不是沒填，是**填了、LINE 那邊的 Endpoint URL 卻指著舊網域**
// （2026-08-07 換網域災情的形狀）。那種情況下這頁一片正常，連結發出去才發現是死的。
// 設定頁早就有一支真的去 LINE 對答案的檢查，這裡改成用同一支——同一個訊號只有一份口徑。
type LiffCheckItem = {
  liffId: string
  source: 'default' | 'campaign'
  status: 'ok' | 'mismatch' | 'broken' | 'unknown'
  endpoint: string | null
  reason?: 'wrong_page' | 'unreachable' | 'deleted'
}
const liffChecks = ref<LiffCheckItem[]>([])
/** 該登記的網址（正式網址＋活動頁路徑）；後端沒設正式網址時為空字串 */
const liffExpectedUrl = ref('')
/** 預設 true：管理員一進頁就會去問 LINE，在答案回來前不可以先下任何結論 */
const liffChecking = ref(true)
/** 查詢本身失敗（≠「沒問題」）。⛔ 查不到一律現形，不可以靜靜當成綠燈 */
const liffCheckFailed = ref(false)
/** 就地補設定用的輸入框 */
const inlineLiffId = ref('')
const savingInlineLiff = ref(false)

// ── 客人在活動頁失敗了幾次（`G-82`）───────────────────────────────────────
// 後台的 LIFF 登記檢查只查得到「Endpoint URL 有沒有寫對」，其他壞法（連結被轉傳
// 截斷、LIFF 被停用、客人環境）它一概看不到——那些情況下客人一個都進不來而後台全綠。
const leadErrors = ref<{
  ok: boolean
  total: number
  byReason: Record<string, number> | null
  truncated: boolean
  days: number
} | null>(null)


function campaignTimestampToPicker(v: unknown): string {
  if (v == null || v === '') return ''
  if (typeof v === 'string')
    return v.length >= 19 ? v.slice(0, 19) : v
  if (typeof v === 'object' && v !== null) {
    const o = v as { seconds?: number; _seconds?: number }
    const sec = typeof o.seconds === 'number' ? o.seconds : o._seconds
    if (typeof sec === 'number')
      return new Date(sec * 1000).toISOString().slice(0, 19)
  }
  return ''
}

const defaultForm = () => ({
  name: '',
  campaignCode: '',
  liffId: '',
  tagIds: [] as string[],
  action: {
    type: 'none',
    moduleId: '',
    text: '',
    uri: '',
  },
  description: '',
  redirectUrl: '' as string,
  startsAt: '' as string,
  endsAt: '' as string,
  isActive: true,
})
const form = ref(defaultForm())
/**
 * 這個活動做不做得出可用連結（D-33 P1）——本活動自己指定的 LIFF，或帳號層的預設 LIFF，
 * 兩個有一個就行（跟產 CTA 的 fallback 同一個判斷，⛔別另立一套否則會出現
 * 「這裡說沒設、連結卻正常」）。
 */
const hasUsableLiff = computed(() =>
  Boolean(String(form.value.liffId || '').trim() || effectiveDefaultLiffId.value),
)

/** 這個活動實際會用到的那一顆 LIFF（活動自己指定的優先，否則吃帳號預設） */
const campaignLiffId = computed(() =>
  String(form.value.liffId || '').trim() || effectiveDefaultLiffId.value,
)

/**
 * 已經上線的活動＝客人現在點就打不開（紅）；還在建、或已停用的＝還沒有人受影響（琥珀）。
 * 嚴重度看的是「客人有沒有正在受影響」，不是看這件事重不重要。
 */
const liveNow = computed(() => !isCreating.value && form.value.isActive)

/**
 * 這一格到底怎麼了。**`ok` 只有真的查成功才准回**——「查不到就當沒問題」是這頁原本的病。
 *
 * - `missing`：連 LIFF ID 都沒有
 * - `unverified`：有 ID，但這個角色查不到 LINE 上的登記狀態（檢查端點限管理員）
 * - `checking` / `unreadable`：查詢中／查不到，兩者都不下結論
 * - `broken` / `mismatch` / `ok`：真的問過 LINE 才有的答案
 */
type LiffVerdict = 'missing' | 'unverified' | 'checking' | 'unreadable' | 'broken' | 'mismatch' | 'ok'

const campaignLiffCheck = computed<LiffCheckItem | null>(() =>
  liffChecks.value.find(c => c.liffId === campaignLiffId.value) ?? null,
)

const liffVerdict = computed<LiffVerdict>(() => {
  if (!liffConfigLoaded.value) return 'checking'
  if (liffLoadFailed.value) return 'unreadable'
  if (!hasUsableLiff.value) return 'missing'
  if (!canManageSettings.value) return 'unverified'
  if (liffChecking.value) return 'checking'
  if (liffCheckFailed.value) return 'unreadable'
  const hit = campaignLiffCheck.value
  // 查回來了卻沒有這一顆（例如剛存好還沒重查）→ 一樣不下結論
  if (!hit || hit.status === 'unknown') return 'unreadable'
  return hit.status
})

const LIFF_BROKEN_DETAIL: Record<NonNullable<LiffCheckItem['reason']>, string> = {
  deleted: '這個 LIFF 在 LINE 上已經不存在了（被刪掉、或 ID 貼錯）。',
  unreachable: 'LINE 上登記的網址已經連不上了（多半是舊網域停用了）。',
  wrong_page: 'LINE 上登記的網址不是這套系統的活動頁，客人會被帶去別的地方。',
}

/** 橫幅要不要出現、長什麼樣。回 null＝這一格沒事，不要製造雜訊 */
const liffBanner = computed<{
  tone: 'critical' | 'warning' | 'unknown'
  title: string
  detail: string
  /** 要不要展開就地設定（複製網址／貼 LIFF ID／重新檢查） */
  setup: 'fill' | 'recheck' | 'none'
} | null>(() => {
  switch (liffVerdict.value) {
    case 'ok':
    case 'unverified':
      // ⚠️ unverified 不出橫幅是刻意的：客服角色既查不到也改不了，掛一條灰色的
      //    「無法確認」在每一個活動上只是雜訊。真的壞掉時管理員那邊會紅。
      return null
    case 'checking':
      return null
    case 'missing':
      return {
        tone: liveNow.value ? 'critical' : 'warning',
        title: '還沒設定活動頁（LIFF），這個活動做不出可用的連結',
        detail: '客人點活動連結會打不開，綁定與貼標都不會發生。設定只要做一次，之後所有活動共用。',
        setup: canManageSettings.value ? 'fill' : 'none',
      }
    case 'broken':
      return {
        // 連結已經在外面流通，不管這個活動啟不啟用都有人會踩到 → 一律紅
        tone: 'critical',
        title: '客人點活動連結會打不開',
        detail: `${LIFF_BROKEN_DETAIL[campaignLiffCheck.value?.reason ?? 'wrong_page']}把下面那串網址貼回 LINE 的 Endpoint URL。`,
        setup: canManageSettings.value ? 'recheck' : 'none',
      }
    case 'mismatch':
      return {
        tone: liveNow.value ? 'critical' : 'warning',
        title: 'LINE 上登記的是別的網址',
        detail: `登記的是 ${campaignLiffCheck.value?.endpoint || '（查不到）'}。客人登入會多繞一圈，那個網址一停用，活動連結就整個打不開。`,
        setup: canManageSettings.value ? 'recheck' : 'none',
      }
    case 'unreadable':
      return {
        tone: 'unknown',
        title: '這次確認不了活動頁（LIFF）的狀態',
        detail: '重新整理可以再試一次。這不代表沒設定，也不代表沒問題。',
        setup: 'none',
      }
  }
  return null
})

/**
 * 存檔會不會白存。⛔ 判斷標準是「按下去會不會拿到假結果」，不是「有沒有警告」：
 * 沒有 LIFF＝活動存了也產不出連結（後端直接跳過），這種要擋；
 * 登記錯（mismatch／broken）＝連結產得出來、也是對的，人去 LINE 改完就會通，這種**不擋**——
 * 擋在可能誤報的警告上，會把正常編輯整個鎖死。
 */
const saveBlockedReason = computed(() => {
  if (!liffConfigLoaded.value) return '正在確認活動頁（LIFF）設定，稍等一下。'
  if (liffLoadFailed.value) return '這次讀不到活動頁（LIFF）設定，沒辦法確認活動連結做不做得出來。請重新整理再試。'
  if (!hasUsableLiff.value) return '還沒設定活動頁（LIFF）：現在存下去也產不出活動連結。請先在上面那一格設定。'
  return ''
})

/**
 * 近 7 天客人失敗的分項。只列真的有數字的，故障類排前面
 * （`campaign_inactive` 是預期內的擋下，不該把它算進「要修的事」）。
 */
const leadErrorRows = computed(() => {
  const by = leadErrors.value?.byReason
  if (!by) return []
  return LEAD_FAILURE_REASONS
    .map(r => ({ reason: r as LeadFailureReason, count: Number(by[r] || 0), ...LEAD_FAILURE_LABELS[r] }))
    .filter(r => r.count > 0)
    .sort((a, b) => Number(b.fault) - Number(a.fault) || b.count - a.count)
})

const leadErrorFaultTotal = computed(() =>
  leadErrorRows.value.filter(r => r.fault).reduce((s, r) => s + r.count, 0),
)

/**
 * 這個活動「存起來的」啟用狀態。
 * ⛔ 不可以看 `form.isActive`：那是畫面上還沒存的開關，用它會在按下儲存前就先改變說法。
 */
const savedIsActive = computed(() => selectedCampaign.value?.isActive !== false)

/**
 * 沒有網址的原因。⛔ 原本一律講「請確認活動為啟用，再按儲存」——
 * 缺 LIFF 的人照著做會被存檔擋下來，變成一條死路。三種「沒有」下一步不同就要分開講。
 */
const ctaMissingReason = computed(() => {
  if (!hasUsableLiff.value)
    return '還沒有網址，因為活動頁（LIFF）還沒設定——上面那一格處理完，儲存後就會自動產生。'
  return '尚未有網址：請按上方「儲存變更」重新產生一次。'
})

/** 去設定活動頁。帶 ?focus=liff：到了那頁直接捲到 LIFF 區塊，不要再自己找一遍 */
function goSetLiff() {
  void navigateTo(`/admin/${workspaceId.value}/settings/organization?focus=liff`)
}

const { markClean, confirmLeaveIfDirty } = useUnsavedChanges({
  getSnapshot: () => form.value,
})
const campaignActionTypeOptions = [
  { value: 'none', label: '不觸發動作' },
  { value: 'uri', label: '開啟網址' },
  { value: 'message', label: '傳送文字' },
  { value: 'module', label: '觸發機器人模組' },
]

const selectedCampaign = computed(() => campaigns.value.find(c => c.id === selectedId.value) ?? null)

// ── Load ─────────────────────────────────────────────────
async function loadModules() {
  modulesLoading.value = true
  // 只取選單要的欄位：整份模組清單是 133 KB（含每則訊息內容），這裡只用到名稱與編號
  modules.value = await apiFetch<any[]>('/api/flow/list?fields=picker').catch(() => [])
  modulesLoading.value = false
}

async function loadWorkspaceEffectiveLiff() {
  // 用免管理員權限的 /api/liff/config 讀預設 LIFF（與 CTA fallback 同一來源 getLineWorkspaceCredentials）。
  // 原本打 admin 專屬的 /api/admin/line-workspace，agent 會收 403 被吞成「缺 LIFF」。
  try {
    const data = await apiFetch<{ liffId?: string }>('/api/liff/config')
    effectiveDefaultLiffId.value = String(data?.liffId ?? '').trim()
    liffLoadFailed.value = false
  }
  catch {
    // 讀取失敗（非「未設定」）：標記起來，送出時給出真正原因而非假裝缺 LIFF
    effectiveDefaultLiffId.value = ''
    liffLoadFailed.value = true
  }
  finally {
    liffConfigLoaded.value = true
  }
}

/**
 * 問 LINE：這幾顆 LIFF 登記的 Endpoint URL 到底是什麼。與設定頁「LINE 上的登記狀態」
 * 同一支端點、同一份口徑（⛔ 別在這裡另立一套判斷，那就會出現「這頁說沒事、那頁說壞了」）。
 *
 * 端點限管理員：客服角色會收 403，這時走 `unverified`——**不是**當成沒問題。
 */
async function loadLiffChecks(opts?: { force?: boolean }) {
  if (!canManageSettings.value) {
    // 不會去問，就不要一直卡在「查詢中」（verdict 會走 unverified）
    liffChecking.value = false
    return
  }
  liffChecking.value = true
  try {
    const data = await apiFetch<{ expectedUrl?: string, checks?: LiffCheckItem[] }>(
      '/api/admin/liff-endpoint-check',
      { query: opts?.force ? { force: 1 } : {} },
    )
    liffChecks.value = Array.isArray(data?.checks) ? data.checks : []
    liffExpectedUrl.value = String(data?.expectedUrl || '').trim()
    liffCheckFailed.value = false
  }
  catch {
    // ⛔ 這裡不可以回空陣列就算了：空陣列會讓 liffVerdict 找不到那一顆而看起來像「沒查到問題」
    liffChecks.value = []
    liffCheckFailed.value = true
  }
  finally {
    liffChecking.value = false
  }
}

/** 客人在活動頁失敗了幾次（近 7 天） */
async function loadLeadErrors() {
  try {
    const data = await apiFetch<{
      ok: boolean
      total: number
      byReason: Record<string, number> | null
      truncated: boolean
      days: number
    }>('/api/campaigns/lead-errors')
    leadErrors.value = data
  }
  catch {
    // 查不到就說查不到（下方畫面會顯示 unknown），⛔ 不可以顯示成 0 次
    leadErrors.value = { ok: false, total: 0, byReason: null, truncated: false, days: 7 }
  }
}

/**
 * 就地把預設 LIFF 存起來，不用離開這一頁。
 *
 * 為什麼不只給一顆「去設定活動頁」：跳過去之後沒有任何一條路帶你回剛剛那個活動，
 * 而填到一半的表單在跳走時就被丟掉了——設定完還要自己找回來、重填一次。
 */
async function saveInlineLiff() {
  // 存 LINE 憑證是管理員的權限（端點也是 admin）。⛔ 不可以用 canOperate 當守衛：
  // 客服按下去只會收到 403，看起來像壞掉而不是「你沒有這個權限」。
  if (!canManageSettings.value) return showToast('這一格要管理員才能改，請找帳號管理員設定', 'warning')
  const id = inlineLiffId.value.trim()
  if (!LIFF_ID_RE.test(id)) {
    return showToast('這串看起來不像 LIFF ID。它長得像 2007123456-AbCdEfGh', 'error')
  }
  savingInlineLiff.value = true
  try {
    await apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { defaultLiffId: id } })
    inlineLiffId.value = ''
    await loadWorkspaceEffectiveLiff()
    // 剛在 LINE 那邊改完，一定要跳過 5 分鐘快取重查，否則會拿到修好前的答案
    await loadLiffChecks({ force: true })
    showToast('已存起來，正在確認 LINE 上的登記狀態', 'success')
  }
  catch {
    showToast('儲存失敗，請再試一次', 'error')
  }
  finally {
    savingInlineLiff.value = false
  }
}

async function copyLiffExpectedUrl() {
  try {
    await navigator.clipboard.writeText(liffExpectedUrl.value)
    showToast('已複製活動頁網址', 'success')
  }
  catch {
    showToast('複製失敗，請手動複製', 'error')
  }
}

onMounted(async () => {
  loadCampaigns(true)
  loadModules()
  loadTags({ status: 'active' })
  loadLeadErrors()
  // 先知道有沒有 LIFF ID，再去問 LINE 那顆登記對不對（後者要前者才知道要查誰）
  await loadWorkspaceEffectiveLiff()
  loadLiffChecks()
})

// ── Select / Create ───────────────────────────────────────
function selectCampaign(c: any, opts?: { skipDiscardConfirm?: boolean }) {
  if (!opts?.skipDiscardConfirm && !confirmLeaveIfDirty()) return
  isCreating.value = false
  selectedId.value = c.id
  ctaUrl.value = String(c.publishedCtaUrl || '')
  stats.value = null
  form.value = {
    name: c.name ?? '',
    campaignCode: c.campaignCode ?? '',
    liffId: c.liffId ?? '',
    tagIds: Array.isArray(c.tagIds) ? [...c.tagIds] : [],
    action: {
      type: c.action?.type || (c.moduleId ? 'module' : 'none'),
      moduleId: c.action?.moduleId || c.moduleId || '',
      text: c.action?.text || '',
      uri: c.action?.uri || '',
    },
    description: c.description ?? '',
    redirectUrl: c.redirectUrl ?? '',
    startsAt: campaignTimestampToPicker(c.startsAt),
    endsAt: campaignTimestampToPicker(c.endsAt),
    isActive: c.isActive !== false,
  }
  loadStats()
  markClean()
}

function openCreate() {
  if (!confirmLeaveIfDirty()) return
  isCreating.value = true
  selectedId.value = null
  ctaUrl.value = ''
  stats.value = null
  form.value = defaultForm()
  markClean()
}

function cancelEdit() {
  if (!confirmLeaveIfDirty()) return
  if (selectedCampaign.value) {
    selectCampaign(selectedCampaign.value, { skipDiscardConfirm: true })
    isCreating.value = false
  }
  else {
    isCreating.value = false
    selectedId.value = null
    form.value = defaultForm()
    markClean()
  }
}

// ── Save / Delete ─────────────────────────────────────────
async function submitForm() {
  if (!assertCanOperate()) return
  if (!form.value.name.trim()) return showToast('請輸入活動名稱', 'error')
  // ⛔ 與畫面上的橫幅共用同一個判斷（`saveBlockedReason`／`hasUsableLiff`）。
  //    原本橫幅看「活動自己的 LIFF 或帳號預設」、存檔只看「帳號預設」，於是舊資料裡
  //    自帶 LIFF 的活動會出現「畫面說沒問題、按儲存卻被擋」。
  if (saveBlockedReason.value) return showToast(saveBlockedReason.value, 'error')
  if (!form.value.tagIds.length) return showToast('請至少選擇一個標籤', 'error')
  if (form.value.action.type === 'module' && !String(form.value.action.moduleId || '').trim()) {
    return showToast('請選擇要觸發的模組，或改成「不觸發動作」', 'error')
  }
  if (form.value.action.type === 'message' && !String(form.value.action.text || '').trim()) {
    return showToast('請輸入回覆文字，或改成「不觸發動作」', 'error')
  }
  if (form.value.action.type === 'uri' && !String(form.value.action.uri || '').trim()) {
    return showToast('請輸入網址，或改成「不觸發動作」', 'error')
  }

  saving.value = true
  try {
    const payload = {
      name: form.value.name,
      // 這一頁沒有「這個活動用哪顆 LIFF」的欄位（一律吃帳號預設），所以新活動送空字串。
      // ⛔ 但不可以寫死空字串：後端是整欄覆蓋，舊資料裡自帶 LIFF 的活動一按儲存就被清掉。
      liffId: String(form.value.liffId || '').trim(),
      tagIds: form.value.tagIds,
      moduleId: form.value.action.type === 'module'
        ? (form.value.action.moduleId || null)
        : null,
      action: form.value.action.type === 'none'
        ? null
        : {
          type: form.value.action.type,
          moduleId: String(form.value.action.moduleId || '').trim(),
          text: String(form.value.action.text || '').trim(),
          uri: String(form.value.action.uri || '').trim(),
        },
      description: form.value.description,
      redirectUrl: String(form.value.redirectUrl || '').trim() || null,
      startsAt: form.value.startsAt || '',
      endsAt: form.value.endsAt || '',
      isActive: form.value.isActive,
    }
    if (isCreating.value) {
      const res = await apiFetch<any>('/api/campaigns/create', { method: 'POST', body: payload })
      showToast('活動已建立', 'success')
      await loadCampaigns(true)
      const created = campaigns.value.find(c => c.id === res.id) ?? campaigns.value[0]
      if (created) selectCampaign(created, { skipDiscardConfirm: true })
      isCreating.value = false
    }
    else {
      await apiFetch(`/api/campaigns/${selectedId.value}`, { method: 'PUT', body: payload })
      showToast('活動已更新', 'success')
      await loadCampaigns(true)
      const updated = campaigns.value.find(c => c.id === selectedId.value)
      if (updated) selectCampaign(updated, { skipDiscardConfirm: true })
      else await loadStats()
    }
  }
  catch {
    showToast('儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

async function deleteCampaign() {
  if (!assertCanOperate()) return
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(`確定刪除「${form.value.name}」？此操作無法復原。`, '刪除確認', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/campaigns/${selectedId.value}`, { method: 'DELETE' })
    showToast('已刪除', 'success')
    selectedId.value = null
    isCreating.value = false
    form.value = defaultForm()
    markClean()
    await loadCampaigns(true)
  }
  catch {
    showToast('刪除失敗', 'error')
  }
}

async function copyCtaUrl() {
  try {
    await navigator.clipboard.writeText(ctaUrl.value)
    showToast('已複製到剪貼簿', 'success')
  }
  catch {
    showToast('複製失敗，請手動複製', 'error')
  }
}

async function loadStats() {
  if (!selectedId.value) return
  statsLoading.value = true
  try {
    stats.value = await apiFetch(`/api/campaigns/${selectedId.value}/stats`)
  }
  catch {
    showToast('統計載入失敗', 'error')
  }
  finally {
    statsLoading.value = false
  }
}

</script>
