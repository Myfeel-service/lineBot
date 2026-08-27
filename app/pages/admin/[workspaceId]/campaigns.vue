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
        <el-button v-if="canOperate" type="primary" :loading="saving" @click="submitForm">
          {{ isCreating ? '建立活動' : '儲存變更' }}
        </el-button>
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
            <p class="ar-section-hint">停用的活動儲存後會隱藏活動進入網址。</p>
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
              v-if="liffLoadFailed"
              tone="unknown"
              title="這次讀不到活動頁（LIFF）設定，沒辦法確認活動連結做不做得出來"
              detail="重新整理可以再試一次。這不代表沒設定。"
            />
            <AdminBlockStatus
              v-else-if="!hasUsableLiff"
              :tone="liffMissingTone"
              title="還沒設定活動頁（LIFF），這個活動做不出可用的連結"
              detail="客人點活動連結會打不開，綁定與貼標都不會發生。設定只要做一次，之後所有活動共用。"
              action-label="去設定活動頁"
              @action="goSetLiff"
            >
              <p class="ar-section-hint">
                不知道去哪設、要填什麼？<AdminFieldHelp id="liffSetup" />
              </p>
            </AdminBlockStatus>
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
                <div v-if="ctaUrl" class="cmp-url-row">
                  <el-input :model-value="ctaUrl" readonly />
                  <el-button @click="copyCtaUrl">複製</el-button>
                </div>
                <div v-else class="ar-any-text-note">
                  尚未有網址：請確認活動為「啟用」，再按上方「儲存變更」。
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
definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
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

/**
 * 已經上線的活動＝客人現在點就打不開（紅）；還在建、或已停用的＝還沒有人受影響（琥珀）。
 * 嚴重度看的是「客人有沒有正在受影響」，不是看這件事重不重要。
 */
const liffMissingTone = computed<'critical' | 'warning'>(() =>
  !isCreating.value && form.value.isActive ? 'critical' : 'warning',
)

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
  modules.value = await apiFetch<any[]>('/api/flow/list').catch(() => [])
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
}

onMounted(() => {
  loadCampaigns(true)
  loadModules()
  loadTags({ status: 'active' })
  loadWorkspaceEffectiveLiff()
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
  if (!effectiveDefaultLiffId.value.trim()) {
    return showToast(
      liffLoadFailed.value
        ? '無法讀取 LIFF 設定，請重新整理後再試'
        : '請先到「組織與 LINE」設定預設 LIFF',
      'error',
    )
  }
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
      liffId: '',
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
