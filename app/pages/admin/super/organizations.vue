<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="超級管理員"
        title="組織管理"
        caption="管理系統中的所有組織、管理員與停用狀態。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button type="primary" @click="openCreate">+ 建立組織</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">所有組織</span>
            </div>
            <span class="text-xs text-muted">共 {{ orgs.length }} 筆</span>
          </div>
          <div class="card-section-stack">
            <el-table v-loading="loading" :data="orgs" size="small">
              <el-table-column label="組織名稱" min-width="160">
                <template #default="{ row }">
                  <span :class="{ 'text-muted': row.disabled }">{{ row.name }}</span>
                </template>
              </el-table-column>
              <el-table-column label="Owner Email" min-width="180">
                <template #default="{ row }">
                  <span class="text-sm">{{ row.ownerEmail }}</span>
                </template>
              </el-table-column>
              <el-table-column label="狀態" width="80">
                <template #default="{ row }">
                  <el-tag :type="row.disabled ? 'danger' : 'success'" size="small">
                    {{ row.disabled ? '停用' : '正常' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="220" align="right">
                <template #default="{ row }">
                  <el-button size="small" plain @click="openMembers(row)">管理員</el-button>
                  <el-button size="small" plain @click="openEdit(row)">編輯</el-button>
                  <el-button
                    size="small"
                    :type="row.disabled ? 'success' : 'warning'"
                    plain
                    @click="toggleDisable(row)"
                  >
                    {{ row.disabled ? '啟用' : '停用' }}
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <!-- Create dialog -->
  <el-dialog v-model="showCreate" title="建立組織" width="min(440px, 92vw)">
    <div class="admin-panel-stack">
      <div class="admin-field-group">
        <AdminFieldLabel text="組織名稱" tight />
        <el-input v-model="form.name" placeholder="例：MyFeel 股份有限公司" />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="Owner Email" tight />
        <el-input v-model="form.ownerEmail" placeholder="owner@example.com" />
      </div>
    </div>
    <template #footer>
      <el-button @click="showCreate = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="createOrg">建立</el-button>
    </template>
  </el-dialog>

  <!-- Edit dialog -->
  <el-dialog v-model="showEdit" title="編輯組織" width="min(480px, 92vw)">
    <div class="admin-panel-stack">
      <div class="admin-field-group">
        <AdminFieldLabel text="組織名稱" tight />
        <el-input v-model="editForm.name" />
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="擁有者 Email" tight />
        <el-input v-model="editForm.ownerEmail" placeholder="登記擁有者（小寫正規化儲存）" />
        <p class="text-xs text-muted">
          若對方尚無 Firebase，僅更新登記 Email；註冊後下次變更或系統寫入時可帶出 UID。新 Email 若尚非組織管理員，會自動加入 org 管理員。
        </p>
      </div>
      <div class="admin-field-group">
        <AdminFieldLabel text="官方帳號數量上限" tight />
        <el-input v-model="editForm.maxWorkspaces" :placeholder="`留空 = 預設 ${DEFAULT_MAX_WORKSPACES_PER_ORG} 個・填 0 = 不限`" />
        <p class="text-xs text-muted">
          濫用防護：每個新官方帳號都自帶 {{ BILLING_PLANS.free.answeredQuota }} 則免費額度，沒有上限的話一個人就能無限建帳號換免費額度。
          代理商 / 多品牌客戶在這裡調高，或填 0 表示不限。
        </p>
      </div>
    </div>
    <template #footer>
      <el-button @click="showEdit = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveEdit">儲存</el-button>
    </template>
  </el-dialog>

  <!-- Members dialog -->
  <el-dialog
    v-model="showMembers"
    :title="`組織管理員：${membersTarget?.name ?? ''}`"
    width="min(520px, 92vw)"
  >
    <div class="admin-panel-stack">
      <!-- 新增管理員 -->
      <div class="sa-members-add-row">
        <el-input
          v-model="newMemberEmail"
          placeholder="輸入 Email 新增組織管理員"
          style="flex: 1"
          @keyup.enter="addMember"
        />
        <el-button type="primary" :loading="memberSaving" @click="addMember">新增</el-button>
      </div>

      <!-- 管理員列表 -->
      <div v-if="membersLoading" class="ws-select-loading">
        <div class="spinner" />
        <span>載入中…</span>
      </div>
      <el-table v-else :data="members" size="small">
        <el-table-column label="Email / 名稱" min-width="200">
          <template #default="{ row }">
            <div class="text-sm font-bold">{{ row.email }}</div>
            <div v-if="row.displayName" class="text-xs text-muted">{{ row.displayName }}</div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="80">
          <template #default>
            <el-tag type="warning" size="small">管理員</el-tag>
          </template>
        </el-table-column>
        <el-table-column width="70" align="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" plain @click="removeMember(row.id)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <p v-if="!membersLoading && members.length === 0" class="text-sm text-muted">
        尚未指派任何組織管理員。
      </p>
    </div>
    <template #footer>
      <el-button @click="showMembers = false">關閉</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { DEFAULT_MAX_WORKSPACES_PER_ORG } from '~~/shared/types/organization'
// ⛔ 免費層額度不可寫死在文案裡（2026-09-07 從 200 改成 50 就會說謊，見 `D-69`）
import { BILLING_PLANS } from '~~/shared/billing/plans'

definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '組織管理 — 超級管理員' })

const { apiFetch } = useSuperAdmin()
const { showToast } = useAdminToast()

const loading = ref(false)
const saving = ref(false)
const orgs = ref<any[]>([])

const showCreate = ref(false)
const showEdit = ref(false)
const editTarget = ref<any>(null)

const showMembers = ref(false)
const membersTarget = ref<any>(null)
const members = ref<any[]>([])
const membersLoading = ref(false)
const memberSaving = ref(false)
const newMemberEmail = ref('')

const form = reactive({ name: '', ownerEmail: '' })
// maxWorkspaces 用字串存：要能區分「留空 = 用預設」與「0 = 不限」，數字型別做不到
const editForm = reactive({ name: '', ownerEmail: '', maxWorkspaces: '' })

async function load() {
  loading.value = true
  try {
    orgs.value = await apiFetch<any[]>('/api/admin/super/organizations')
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '載入失敗', 'error')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.name = ''
  form.ownerEmail = ''
  showCreate.value = true
}

function openEdit(row: any) {
  editTarget.value = row
  editForm.name = row.name
  editForm.ownerEmail = row.ownerEmail || ''
  // null = 特批不限 → 顯示 0；undefined = 沒設過 → 留空（用預設值）
  editForm.maxWorkspaces = row.maxWorkspaces === null ? '0' : (row.maxWorkspaces?.toString() ?? '')
  showEdit.value = true
}

async function openMembers(row: any) {
  membersTarget.value = row
  newMemberEmail.value = ''
  showMembers.value = true
  await loadMembers(row.id)
}

async function loadMembers(orgId: string) {
  membersLoading.value = true
  try {
    members.value = await apiFetch<any[]>(`/api/admin/super/organizations/${orgId}/members`)
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '載入失敗', 'error')
  } finally {
    membersLoading.value = false
  }
}

async function createOrg() {
  if (!form.name.trim()) return showToast('請輸入組織名稱', 'error')
  if (!form.ownerEmail.trim()) return showToast('請輸入 Owner Email', 'error')
  saving.value = true
  try {
    await apiFetch('/api/admin/super/organizations', {
      method: 'POST',
      body: { name: form.name, ownerEmail: form.ownerEmail },
    })
    showToast('組織已建立', 'success')
    showCreate.value = false
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '建立失敗', 'error')
  } finally {
    saving.value = false
  }
}

async function saveEdit() {
  if (!editForm.name.trim()) return showToast('組織名稱不能為空', 'error')
  if (!editForm.ownerEmail.trim()) return showToast('請填寫擁有者 Email', 'error')
  saving.value = true
  try {
    const max = editForm.maxWorkspaces.trim()
    await apiFetch(`/api/admin/super/organizations/${editTarget.value.id}`, {
      method: 'PATCH',
      body: {
        name: editForm.name,
        ownerEmail: editForm.ownerEmail.trim(),
        // 留空 → 不動（沿用預設）；0 → null = 特批不限；其他 → 該數字
        ...(max === '' ? {} : { maxWorkspaces: max === '0' ? null : Number(max) }),
      },
    })
    showToast('已更新', 'success')
    showEdit.value = false
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '更新失敗', 'error')
  } finally {
    saving.value = false
  }
}

async function toggleDisable(row: any) {
  const action = row.disabled ? '啟用' : '停用'
  try {
    await ElMessageBox.confirm(`確定要${action}「${row.name}」？`, `${action}組織`, {
      confirmButtonText: action,
      cancelButtonText: '取消',
      confirmButtonClass: row.disabled ? '' : 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/admin/super/organizations/${row.id}/disable`, {
      method: 'POST',
      body: { disabled: !row.disabled },
    })
    showToast(`已${action}`, 'success')
    await load()
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '操作失敗', 'error')
  }
}

async function addMember() {
  const email = newMemberEmail.value.trim()
  if (!email) {
    showToast('請輸入 Email', 'error')
    return
  }
  memberSaving.value = true
  try {
    await apiFetch(`/api/admin/super/organizations/${membersTarget.value.id}/members`, {
      method: 'POST',
      body: { email },
    })
    showToast('已新增組織管理員', 'success')
    newMemberEmail.value = ''
    await loadMembers(membersTarget.value.id)
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '新增失敗', 'error')
  } finally {
    memberSaving.value = false
  }
}

async function removeMember(docId: string) {
  try {
    await ElMessageBox.confirm('確定移除此管理員？', '移除確認', {
      confirmButtonText: '移除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  try {
    await apiFetch(`/api/admin/super/organizations/${membersTarget.value.id}/members/${docId}`, {
      method: 'DELETE',
    })
    showToast('已移除', 'success')
    await loadMembers(membersTarget.value.id)
  } catch (e: any) {
    showToast(e?.data?.statusMessage || '移除失敗', 'error')
  }
}

onMounted(load)
</script>
