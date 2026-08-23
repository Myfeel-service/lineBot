<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="成員管理"
        caption="以 Email 邀請成員（對方無需先註冊）。若已綁定組織，列表也會顯示組織擁有者／管理員（僅供檢視）。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button v-if="canManageSettings" type="primary" data-tour="mem-invite" @click="openInvite">邀請成員</el-button>
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
            <p class="member-line-note">
              「LINE 通知」綁定成員本人的 LINE 帳號後,
              「AI 設定 → 轉真人通知」的名單就能直接勾選這位成員,不必到好友清單裡用暱稱找人。
            </p>
            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <el-table v-else :data="members" size="small" empty-text="尚無成員，點右上「邀請成員」新增">
              <el-table-column label="Email / UID">
                <template #default="{ row }">
                  <div>{{ row.invitedEmail || row.uid || '—' }}</div>
                  <div v-if="row.pendingInvite" class="text-xs text-muted">待加入（尚未註冊 Firebase）</div>
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
              <el-table-column label="LINE 通知" width="210">
                <template #default="{ row }">
                  <span v-if="row.readOnly || row.pendingInvite" class="text-xs text-muted">—</span>
                  <div v-else-if="row.lineUserId" class="member-line-cell">
                    <el-tag type="success" size="small" effect="light">
                      {{ row.lineDisplayName || '已綁定' }}
                    </el-tag>
                    <el-button v-if="canManageSettings" size="small" link type="danger" @click="unbindLine(row)">
                      解除
                    </el-button>
                  </div>
                  <div v-else class="member-line-cell">
                    <span class="text-xs text-muted">
                      {{ row.hasPendingBindCode ? '等待對方傳送綁定碼' : '未綁定' }}
                    </span>
                    <el-button v-if="canManageSettings" size="small" link type="primary" @click="openBind(row)">
                      {{ row.hasPendingBindCode ? '重新產生' : '綁定' }}
                    </el-button>
                  </div>
                </template>
              </el-table-column>
              <el-table-column v-if="canManageSettings" label="操作" width="160" align="right">
                <template #default="{ row }">
                  <template v-if="!row.readOnly && row.role !== 'owner'">
                    <el-select
                      :model-value="row.role"
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
        <AdminFieldLabel text="角色" tight />
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

  <!-- LINE 綁定 dialog -->
  <el-dialog v-model="showBind" title="綁定 LINE" width="min(460px, 92vw)">
    <div class="admin-panel-stack">
      <p class="member-bind-target">
        對象:<strong>{{ bindTargetLabel }}</strong>
      </p>
      <template v-if="bindUrl">
        <ol class="member-bind-steps">
          <li>請這位成員用<strong>他自己的 LINE</strong>加這個官方帳號為好友。</li>
          <li>把下面這條連結傳給他(用什麼方式傳都行)。</li>
          <li>他在手機上點開,訊息已經幫他打好了,<strong>按送出</strong>就完成。</li>
        </ol>
        <div class="member-bind-code member-bind-code--url">
          <code>{{ bindUrl }}</code>
          <el-button size="small" :type="bindCopied ? 'success' : 'primary'" plain @click="copyBindUrl">
            {{ bindCopied ? '已複製' : '複製連結' }}
          </el-button>
        </div>
        <p class="member-bind-expire">
          綁定碼 10 分鐘內有效({{ bindExpireText }}前),過期可再產生一組。
          他會收到「綁定成功」的回覆——收得到就代表確實已加好友,之後轉真人通知才推得出去。
        </p>
        <el-collapse class="member-bind-fallback">
          <el-collapse-item title="連結點不開?改用手動輸入">
            <p class="member-bind-expire">請他在跟官方帳號的聊天室裡,直接傳這行字:</p>
            <div class="member-bind-code">
              <code>{{ bindMessage }}</code>
              <el-button size="small" plain @click="copyBindMessage">複製</el-button>
            </div>
          </el-collapse-item>
        </el-collapse>
      </template>

      <template v-else>
        <ol class="member-bind-steps">
          <li>請這位成員用<strong>他自己的 LINE</strong>加這個官方帳號為好友。</li>
          <li>請他把下面這行字傳給官方帳號:</li>
        </ol>
        <div class="member-bind-code">
          <code>{{ bindMessage }}</code>
          <el-button size="small" :type="bindCopied ? 'success' : 'primary'" plain @click="copyBindMessage">
            {{ bindCopied ? '已複製' : '複製' }}
          </el-button>
        </div>
        <ol class="member-bind-steps" start="3">
          <li>他會收到「綁定成功」的回覆,這邊按「我完成了」重新整理即可。</li>
        </ol>
        <p class="member-bind-expire">
          綁定碼 10 分鐘內有效({{ bindExpireText }}前),過期可再產生一組。
          收得到回覆就代表他確實已加好友——之後轉真人通知才推得出去。
        </p>
      </template>
    </div>
    <template #footer>
      <el-button @click="showBind = false">關閉</el-button>
      <el-button type="primary" :loading="loading" @click="finishBind">我完成了</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
definePageMeta({ middleware: ['auth', 'workspace-settings'], layout: 'default' })
useHead({ title: useAdminTitle('成員管理') })

const { showToast } = useAdminToast()
const { workspaceId, apiFetch, canManageSettings } = useWorkspace()

const loading = ref(false)
const members = ref<any[]>([])
const showInvite = ref(false)
const inviteEmail = ref('')
const inviteRole = ref('agent')
const inviting = ref(false)

// ── LINE 綁定 ──
const showBind = ref(false)
const bindTargetLabel = ref('')
const bindMessage = ref('')
const bindUrl = ref('')
const bindExpiresAt = ref(0)
const bindCopied = ref(false)

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

const bindExpireText = computed(() => {
  if (!bindExpiresAt.value) return ''
  return new Date(bindExpiresAt.value).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
})

async function openBind(row: any) {
  bindTargetLabel.value = row.invitedEmail || row.uid || '此成員'
  bindCopied.value = false
  try {
    const res = await apiFetch<{ code: string; expiresAt: number; message: string; bindUrl: string }>(
      `/api/admin/workspaces/${workspaceId.value}/members/${row.uid}/line-bind-code`,
      { method: 'POST' },
    )
    bindMessage.value = res.message
    bindUrl.value = res.bindUrl || ''
    bindExpiresAt.value = res.expiresAt
    showBind.value = true
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '產生綁定碼失敗', 'error')
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    bindCopied.value = true
    setTimeout(() => { bindCopied.value = false }, 2000)
  }
  catch {
    showToast('複製失敗，請手動選取', 'error')
  }
}

const copyBindUrl = () => copyToClipboard(bindUrl.value)
const copyBindMessage = () => copyToClipboard(bindMessage.value)

// 綁定是對方在 LINE 上完成的,後台收不到即時訊號 → 用「我完成了」重抓一次列表確認狀態
async function finishBind() {
  await load()
  const bound = members.value.some(m => m.lineUserId && (m.invitedEmail || m.uid) === bindTargetLabel.value)
  if (bound) {
    showToast('已綁定', 'success')
    showBind.value = false
  }
  else {
    showToast('還沒收到綁定訊息,請確認對方已加好友並傳出那行字', 'warning')
  }
}

async function unbindLine(row: any) {
  try {
    await ElMessageBox.confirm(
      '解除後,這位成員會從「轉真人通知」名單中移除,不再收到通知。',
      '解除 LINE 綁定',
      { confirmButtonText: '解除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger', type: 'warning' },
    )
  }
  catch { return }
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/members/${row.uid}/line-binding`, {
      method: 'DELETE',
    })
    showToast('已解除綁定', 'success')
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '解除失敗', 'error')
  }
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

async function changeRole(row: any, role: string) {
  const ROLE_LABEL: Record<string, string> = { admin: '管理員', agent: '客服', viewer: '觀察者' }
  try {
    await ElMessageBox.confirm(
      `確定將此成員的角色改為「${ROLE_LABEL[role] ?? role}」？`,
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

onMounted(load)
</script>
