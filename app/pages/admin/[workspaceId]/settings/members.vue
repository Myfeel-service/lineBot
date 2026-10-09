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
      <!-- `mem-page`：寬螢幕封頂 1100px，跟「設定 → LINE 通知」一樣（`D-117`：原本角色欄在 1650px 外，中間一大片空白） -->
      <div class="solo-editor-body admin-panel-stack mem-page">
        <div class="message-card ar-section-card" data-tour="mem-list">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">成員列表</span>
            </div>
            <!-- `D-117`：原本上方兩條「N 份邀請還沒被接受／已過期」彙總收成這一行，細節與下一步在那一列 -->
            <span v-if="!loading && headerMeta" class="mem-card__meta">{{ headerMeta }}</span>
          </div>
          <div class="card-section-stack">
            <!-- 2026-09-27 `C-270`：綁 LINE／收不收通知搬到「設定 → LINE 通知」（一個地方做完，不再兩頁各做一次） -->
            <p class="member-line-note" data-tour="mem-line">
              手機收通知在<NuxtLink :to="`/admin/${workspaceId}/settings/line-notify`">「設定 → LINE 通知」</NuxtLink>。
            </p>
            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <el-table v-else :data="sortedMembers" size="small" empty-text="尚無成員，點右上「邀請成員」新增">
              <!-- `D-117`：拿掉每列那串 UID 與「尚未註冊 Firebase」——店家看不懂，也用不到 -->
              <el-table-column label="成員" min-width="260">
                <template #default="{ row }">
                  <div class="mem-email">{{ row.isSelf ? `你（${emailOf(row)}）` : emailOf(row) }}</div>
                  <div v-if="row.pendingInvite && row.expired" class="text-xs text-muted">邀請已過期（30 天沒接受），他已經進不來</div>
                  <!-- 🔴 邀請不會寄任何信（`G-3` 等寄信服務）：原本寫「在等對方動作」，他其實不知道自己被邀請了 -->
                  <div v-else-if="row.pendingInvite" class="text-xs text-muted">邀請中：系統不會寄信，把登入連結傳給他</div>
                  <div v-else-if="row.readOnly && row.linkedSource === 'org_member'" class="text-xs text-muted">組織管理員（組織內全部官方帳號）</div>
                  <div v-else-if="row.readOnly && row.linkedSource === 'org_owner'" class="text-xs text-muted">組織擁有者（登記 Email）</div>
                </template>
              </el-table-column>
              <!-- 角色只講一次（`D-117`）：能改的看到選單（選單上就是現在的角色），不能改的看到色標。
                   原本可改的列左邊一個色標、右邊一個選單，同一個字出現兩次 -->
              <el-table-column label="角色" width="150">
                <template #default="{ row }">
                  <div class="mem-role">
                    <el-select
                      v-if="roleEditable(row)"
                      :model-value="row.role"
                      size="small"
                      style="width: 110px"
                      :aria-label="`${emailOf(row)} 的角色`"
                      @change="(val: string) => changeRole(row, val)"
                    >
                      <el-option label="管理員" value="admin" />
                      <el-option label="客服" value="agent" />
                      <el-option label="觀察者" value="viewer" />
                    </el-select>
                    <el-tag v-else :type="roleTagType(row.role)" :effect="roleTagEffect(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
                  </div>
                </template>
              </el-table-column>
              <!-- 自己那一列不給改、不給移除（`G-101`②）：手滑把自己改成觀察者會立刻被踢出這頁。
                   擁有者只有組織管理員／超管動得了（`G-96`），帳號管理員看不到。
                   「移除」收進「⋯」（`D-117` 拍板 2，跟 LINE 通知頁的「移除這支手機」一樣）：原本紅鈕每列攤開，擁有者那列也有 -->
              <el-table-column v-if="can('members.manage')" width="190" align="right">
                <template #default="{ row }">
                  <div class="mem-actions">
                    <!-- 過期的邀請改角色沒有意義，換成「重新邀請」（同一個 Email、同一個角色再發一次） -->
                    <el-button v-if="row.pendingInvite && row.expired && canTouch(row)" size="small" @click="reinvite(row)">重新邀請</el-button>
                    <!-- `D-117` 拍板 3：邀請信做好之前先頂著——不給這顆，對方根本不知道要去哪裡登入 -->
                    <el-button v-else-if="row.pendingInvite && canTouch(row)" size="small" @click="copyLoginLink(row)">複製登入連結</el-button>
                    <el-dropdown v-if="menuOf(row).length" trigger="click" placement="bottom-end" @command="onMenu(row, $event)">
                      <el-button text size="small" :icon="MoreFilled" aria-label="更多" class="mem-more" />
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item
                            v-for="it in menuOf(row)"
                            :key="it.cmd"
                            :command="it.cmd"
                            :divided="it.divided"
                            :class="{ 'mem-menu-danger': it.danger }"
                          >
                            {{ it.label }}
                          </el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </div>
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
        <!-- 後台只能用 Google 登入：講「Google 信箱」他才知道要填哪一個（原本寫「可不已有 Firebase 帳號」） -->
        <el-input v-model="inviteEmail" placeholder="對方的 Google 信箱（還沒登入過也可以）" />
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
import { MoreFilled } from '@element-plus/icons-vue'
import { compareMembersForList } from '~~/shared/member-order'
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

function emailOf(row: any): string {
  // 自助開帳的擁有者沒有 invitedEmail，API 另外查了登入信箱放在 email（`D-117`；原本這種列只印得出 uid）
  return String(row.invitedEmail || row.email || '').trim() || '（查不到 Email）'
}

/**
 * 名單順序（`D-117`）：成員（自己→擁有者→管理員→客服→觀察者，同角色照 Email，跟「LINE 通知」同一套）
 * → 邀請中 → 邀請已過期 → 組織層（只供檢視）。原本完全沒排，擁有者排第 4。
 */
function groupOf(row: any): number {
  if (row.readOnly) return 3
  if (row.pendingInvite) return row.expired ? 2 : 1
  return 0
}
const sortedMembers = computed(() => [...members.value].sort((a, b) =>
  groupOf(a) - groupOf(b)
  || compareMembersForList({ isSelf: a.isSelf, role: a.role, email: emailOf(a) }, { isSelf: b.isSelf, role: b.role, email: emailOf(b) })))

/**
 * 卡片右上那一行（`D-117`）：原本上方兩條「N 份邀請還沒被接受——都在等對方動作」「N 份邀請已過期」，
 * 細節與下一步本來就在那一列，這裡只留數字。（D-43④ 要的「等太久有人看得到」由這一行＋排在成員後面扛）
 */
const headerMeta = computed(() => {
  const rows = members.value.filter(m => !m.readOnly)
  const joined = rows.filter(m => !m.pendingInvite).length
  const inviting = rows.filter(m => m.pendingInvite && !m.expired).length
  const expired = rows.filter(m => m.pendingInvite && m.expired).length
  return [
    `${joined} 位成員`,
    inviting ? `${inviting} 位邀請中` : '',
    expired ? `${expired} 份邀請已過期` : '',
  ].filter(Boolean).join('・')
})

/** 這一列動得了嗎：不是唯讀列、不是自己、擁有者只有組織管理員／超管動得了 */
function canTouch(row: any): boolean {
  return !row.readOnly && !row.isSelf && (row.role !== 'owner' || canManageOwner.value)
}
/** 角色用選單顯示（能改）還是色標（不能改）。擁有者不在選單裡，改他走「⋯」 */
function roleEditable(row: any): boolean {
  return can('members.manage') && canTouch(row) && row.role !== 'owner' && !(row.pendingInvite && row.expired)
}

type MenuItem = { cmd: string, label: string, danger?: boolean, divided?: boolean }
/** 「⋯」：不常用、或會讓人緊張的動作（移除／收回邀請；擁有者的換角色） */
function menuOf(row: any): MenuItem[] {
  if (!can('members.manage') || !canTouch(row)) return []
  if (row.pendingInvite) return [{ cmd: 'remove', label: '收回邀請', danger: true }]
  if (row.role === 'owner') {
    return [
      { cmd: 'role:admin', label: '改成管理員' },
      { cmd: 'role:agent', label: '改成客服' },
      { cmd: 'role:viewer', label: '改成觀察者' },
      { cmd: 'remove', label: '移除這位成員', danger: true, divided: true },
    ]
  }
  return [{ cmd: 'remove', label: '移除這位成員', danger: true }]
}
function onMenu(row: any, cmd: string) {
  if (cmd === 'remove') void removeMember(row)
  else if (cmd.startsWith('role:')) void changeRole(row, cmd.slice(5))
}

/**
 * 複製登入連結（`D-117` 拍板 3）。系統不會寄邀請信（`G-3`，要先開通寄信服務），
 * 不給這顆的話，被邀請的人根本不知道要去哪裡登入。他用受邀的 Google 信箱登入那一刻就會加進來。
 */
async function copyLoginLink(row: any) {
  const url = `${window.location.origin}/login`
  const email = emailOf(row)
  try {
    await navigator.clipboard.writeText(url)
    showToast(`已複製登入連結。傳給他時記得說：用 ${email} 這個 Google 帳號登入`, 'success')
  }
  catch {
    // 瀏覽器不給寫剪貼簿：把網址講出來讓他自己抄，⛔ 不要只說「複製失敗」
    showToast(`沒辦法自動複製，請把這個網址傳給他：${url}（用 ${email} 這個 Google 帳號登入）`, 'warning')
  }
}

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
    // ⛔ 不講「已送出邀請」：系統不會寄任何信（`G-3`），講了他會以為對方收到通知了（`D-117`）
    showToast(
      res.pending
        ? '已加進名單。系統不會寄信，請在他那一列按「複製登入連結」傳給他'
        : '已加進成員名單。系統不會寄信，記得跟他說一聲',
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
    showToast('邀請又有 30 天可以用了。系統不會寄信，記得把登入連結傳給他', 'success')
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
  // 收進「⋯」之後按的人看不到旁邊是哪一列，確認框要講出是誰（`D-117`）
  const email = emailOf(row)
  try {
    await ElMessageBox.confirm(
      row.pendingInvite ? `確定收回給 ${email} 的邀請？` : `確定移除 ${email}？他之後就進不了這個後台。`,
      row.pendingInvite ? '收回邀請' : '移除成員',
      {
        confirmButtonText: row.pendingInvite ? '收回' : '移除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
        type: 'warning',
      },
    )
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
    showToast(row.pendingInvite ? '已收回邀請' : '已移除成員', 'success')
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
