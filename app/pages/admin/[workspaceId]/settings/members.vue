<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="成員管理"
        caption="以 Email 邀請成員（對方無需先註冊）。若已綁定組織，列表也會顯示組織擁有者／管理員（僅供檢視）。"
        :help-topics="['members']"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button v-if="can('members.manage')" type="primary" data-tour="mem-invite" @click="openInvite">邀請成員</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card ar-section-card" data-tour="mem-list">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">成員列表</span>
            </div>
          </div>
          <div class="card-section-stack">
            <!-- 2026-09-27 `C-270`：綁 LINE／收不收通知搬到「設定 → LINE 通知」（一個地方做完，不再兩頁各做一次） -->
            <p class="member-line-note" data-tour="mem-line">
              要讓成員的手機收到客人找真人、每天早上的摘要，到
              <NuxtLink :to="`/admin/${workspaceId}/settings/line-notify`">「設定 → LINE 通知」</NuxtLink>。
              新成員第一次登入後台時也會被問一次。
            </p>
            <!-- 等對方動作的事彙總（D-43④）：邀請沒接受、綁定碼沒傳,原本只有表格裡一行小灰字,
                 等太久也沒人會發現。這裡收成一行,細節與動作（取消重邀/重新產生）都在下面該列。 -->
            <p v-if="pendingActionSummary" class="member-pending-note">
              ⏳ {{ pendingActionSummary }}——都在等對方動作；太久沒動靜，可以在下面那一列重新處理。
            </p>
            <!-- 邀請 30 天沒人接受就過期（`G-107`⑥）：過期的不刪，對方已經進不來，要不要重發由管理員決定 -->
            <p v-if="expiredInviteCount" class="member-pending-note">
              {{ expiredInviteCount }} 份邀請已過期，對方已經進不來；要的話在下面那一列按「重新邀請」。
            </p>
            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <el-table v-else :data="members" size="small" empty-text="尚無成員，點右上「邀請成員」新增">
              <el-table-column label="Email / UID">
                <template #default="{ row }">
                  <div>{{ row.invitedEmail || row.uid || '—' }}</div>
                  <div v-if="row.pendingInvite && row.expired" class="text-xs text-muted">邀請已過期（30 天沒接受）</div>
                  <div v-else-if="row.pendingInvite" class="text-xs text-muted">待加入（尚未註冊 Firebase）</div>
                  <div v-else-if="row.readOnly && row.linkedSource === 'org_member'" class="text-xs text-muted">組織管理員（組織內全部官方帳號）</div>
                  <div v-else-if="row.readOnly && row.linkedSource === 'org_owner'" class="text-xs text-muted">組織擁有者（登記 Email）</div>
                  <div v-else-if="row.uid" class="text-xs text-muted">{{ row.uid }}</div>
                </template>
              </el-table-column>
              <el-table-column label="角色" width="120">
                <template #default="{ row }">
                  <el-tag :type="roleTagType(row.role)" :effect="roleTagEffect(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column v-if="can('members.manage')" label="操作" width="160" align="right">
                <template #default="{ row }">
                  <!-- 自己那一列不給改、不給移除（`G-101`②）：手滑把自己改成觀察者會立刻被踢出這頁。
                       擁有者只有組織管理員／超管動得了（`G-96`），帳號管理員看不到這兩個鈕 -->
                  <template v-if="!row.readOnly && !row.isSelf && (row.role !== 'owner' || canManageOwner)">
                    <!-- 過期的邀請改角色沒有意義，換成「重新邀請」（同一個 Email、同一個角色再發一次） -->
                    <el-button v-if="row.pendingInvite && row.expired" size="small" @click="reinvite(row)">重新邀請</el-button>
                    <el-select
                      v-else
                      :model-value="row.role === 'owner' ? '' : row.role"
                      :placeholder="row.role === 'owner' ? '改成…' : undefined"
                      size="small"
                      style="width: 90px; margin-right: 4px"
                      @change="(val: string) => changeRole(row, val)"
                    >
                      <el-option label="管理員" value="admin" />
                      <el-option label="客服" value="agent" />
                      <el-option label="觀察者" value="viewer" />
                    </el-select>
                    <el-button size="small" type="danger" plain @click="removeMember(row)">移除</el-button>
                  </template>
                  <span v-else-if="row.readOnly" class="text-xs text-muted">—</span>
                  <span v-else-if="row.isSelf" class="text-xs text-muted">你自己</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <!-- Invite dialog -->
  <el-dialog v-model="showInvite" title="邀請成員" width="min(400px, 92vw)">
    <div class="admin-panel-stack">
      <div class="admin-field-group">
        <AdminFieldLabel text="Email" tight />
        <el-input v-model="inviteEmail" placeholder="對方 Email（可不已有 Firebase 帳號）" />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel tight>
          角色
          <!-- 選錯＝把帳單與 LINE 金鑰交給錯的人，這件事算資安不算 UX（D-33 P1） -->
          <AdminFieldHelp id="memberRole" />
        </AdminFieldLabel>
        <el-select v-model="inviteRole" style="width: 100%">
          <el-option label="管理員" value="admin" />
          <el-option label="客服" value="agent" />
          <el-option label="觀察者" value="viewer" />
        </el-select>
      </div>
    </div>
    <template #footer>
      <el-button @click="showInvite = false">取消</el-button>
      <el-button type="primary" :loading="inviting" @click="invite">邀請</el-button>
    </template>
  </el-dialog>

</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
definePageMeta({ middleware: ['auth', 'workspace-settings'], layout: 'default' })
useHead({ title: useAdminTitle('成員管理') })

const { showToast } = useAdminToast()
const { workspaceId, apiFetch, can, workspaceList, orgAdminOf } = useWorkspace()
const { isSuperAdmin, checkIsSuperAdmin } = useSuperAdmin()

const loading = ref(false)
const members = ref<any[]>([])

/**
 * 擁有者那一列的角色選單與移除鈕，只給組織管理員與超管（`G-96` 2026-09-29 拍板；伺服器也擋）。
 * 帳號管理員動不了擁有者——跟原本一樣，只是原本連組織管理員也動不了，離職的擁有者只能到主控台手動刪。
 */
const canManageOwner = computed(() => {
  if (isSuperAdmin.value) return true
  const orgId = workspaceList.value.find(w => w.workspaceId === workspaceId.value)?.organizationId
  return Boolean(orgId && orgAdminOf.value.some(o => o.id === orgId))
})

// 等對方動作的事（D-43④）：這頁不分頁、members 就是全量,直接從已載入的資料算。
// （「綁定碼還沒傳送」2026-09-27 隨綁 LINE 一起搬到「設定 → LINE 通知」，那一列自己會講「等對方點連結」）
// 過期的邀請不算「等對方」（`G-107`⑥）：對方已經進不來，下一步在管理員手上，另起一行講
const pendingActionSummary = computed(() => {
  const invites = members.value.filter(m => m.pendingInvite && !m.expired).length
  return invites ? `${invites} 份邀請還沒被接受` : ''
})
const expiredInviteCount = computed(() => members.value.filter(m => m.pendingInvite && m.expired).length)

const showInvite = ref(false)
const inviteEmail = ref('')
const inviteRole = ref('agent')
const inviting = ref(false)

const ROLE_LABELS: Record<string, string> = {
  owner: '擁有者',
  admin: '管理員',
  agent: '客服',
  viewer: '觀察者',
  org_admin: '組織管理員',
  org_owner: '組織擁有者（登記）',
}

function roleLabel(role: string) { return ROLE_LABELS[role] ?? role }
function roleTagType(role: string) {
  if (role === 'owner' || role === 'org_owner') return 'primary'
  if (role === 'admin' || role === 'org_admin') return 'warning'
  if (role === 'agent') return 'success'
  return 'info'
}

// 擁有者用實心品牌色標籤，與其他淺色標籤區隔（與組織設定頁一致）
function roleTagEffect(role: string) {
  return role === 'owner' || role === 'org_owner' ? 'dark' : 'light'
}

function openInvite() {
  inviteEmail.value = ''
  inviteRole.value = 'agent'
  showInvite.value = true
}

async function load() {
  loading.value = true
  try {
    members.value = await apiFetch<any[]>(
      `/api/admin/workspaces/${workspaceId.value}/members`,
    )
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '載入失敗', 'error')
  } finally {
    loading.value = false
  }
}

async function invite() {
  if (!inviteEmail.value.trim()) return showToast('請輸入 Email', 'error')
  inviting.value = true
  try {
    const res = await apiFetch<{ pending?: boolean }>(
      `/api/admin/workspaces/${workspaceId.value}/members`,
      {
        method: 'POST',
        body: { email: inviteEmail.value.trim(), role: inviteRole.value },
      },
    )
    showToast(
      res.pending
        ? '已送出邀請（對方註冊 Firebase 後首次登入即可加入）'
        : '已邀請成員',
      'success',
    )
    showInvite.value = false
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '邀請失敗', 'error')
  } finally {
    inviting.value = false
  }
}

/** 過期的邀請再發一次：同一個 Email、同一個角色（伺服器收掉過期那張、發一張新的 30 天） */
async function reinvite(row: any) {
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/members`, {
      method: 'POST',
      body: { email: row.invitedEmail, role: row.role },
    })
    showToast('已重新發出邀請', 'success')
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '重新邀請失敗', 'error')
  }
}

async function changeRole(row: any, role: string) {
  const ROLE_LABEL: Record<string, string> = { admin: '管理員', agent: '客服', viewer: '觀察者' }
  try {
    await ElMessageBox.confirm(
      row.role === 'owner'
        ? `確定把擁有者改為「${ROLE_LABEL[role] ?? role}」？他之後就不是這個帳號的擁有者了。`
        : `確定將此成員的角色改為「${ROLE_LABEL[role] ?? role}」？`,
      '變更角色',
      { confirmButtonText: '變更', cancelButtonText: '取消', type: 'warning' },
    )
  }
  catch { return }
  try {
    if (row.pendingInvite && row.inviteId) {
      await apiFetch(`/api/admin/workspaces/${workspaceId.value}/member-invites/${row.inviteId}`, {
        method: 'PUT',
        body: { role },
      })
    }
    else {
      await apiFetch(`/api/admin/workspaces/${workspaceId.value}/members/${row.uid}`, {
        method: 'PUT',
        body: { role },
      })
    }
    showToast('角色已更新', 'success')
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '更新失敗', 'error')
  }
}

async function removeMember(row: any) {
  const label = row.pendingInvite ? '此邀請' : '此成員'
  try {
    await ElMessageBox.confirm(`確定移除${label}？`, '移除確認', {
      confirmButtonText: '移除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    if (row.pendingInvite && row.inviteId) {
      await apiFetch(`/api/admin/workspaces/${workspaceId.value}/member-invites/${row.inviteId}`, {
        method: 'DELETE',
      })
    }
    else {
      await apiFetch(`/api/admin/workspaces/${workspaceId.value}/members/${row.uid}`, {
        method: 'DELETE',
      })
    }
    showToast(row.pendingInvite ? '已取消邀請' : '已移除成員', 'success')
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '移除失敗', 'error')
  }
}

onMounted(() => {
  void load()
  void checkIsSuperAdmin()
})
</script>
