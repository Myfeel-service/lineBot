<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="操作紀錄"
        caption="誰把什麼改成什麼，包含小幫手代你做的每一筆。出事時先來這裡看最近動過什麼。"
        :help-topics="['activity']"
      />
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card ar-section-card" data-tour="act-list">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">最近的操作</span>
            </div>
            <el-radio-group v-model="actorFilter" size="small" data-tour="act-filter" @change="reload">
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button value="human">成員操作</el-radio-button>
              <el-radio-button value="agent">小幫手代辦</el-radio-button>
            </el-radio-group>
          </div>

          <div class="card-section-stack">
            <!-- 只記「設定類」的改動：講清楚範圍，免得有人以為這裡查得到所有操作 -->
            <p class="text-xs text-muted">
              這裡記的是會改變系統行為的設定類操作（AI 設定、流程開關、圖文選單、一鍵修…）。
              日常的回訊息、貼標籤不會記在這裡。
            </p>

            <!-- 小幫手提得準不準：提了幾次、你按了幾次確定。
                 ⚠️「沒有按確定」包含取消與看一看就走掉——資料上分不出來，所以不寫成「被拒絕」 -->
            <p v-if="stats && stats.proposed > 0" class="text-xs text-muted">
              這個月小幫手提議了 {{ stats.proposed }} 次，你按確定的有 {{ stats.executed }} 次<template v-if="stats.notConfirmed"> （{{ stats.notConfirmed }} 次沒有按確定）</template>。
            </p>

            <p v-if="error" class="text-xs" role="alert">⚠️ {{ error }}</p>

            <div v-if="loading && !rows.length" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>

            <el-table
              v-else
              :data="rows"
              size="small"
              :empty-text="emptyText"
            >
              <el-table-column label="時間" width="150">
                <template #default="{ row }">
                  <span v-if="row.createdAt">{{ formatTime(row.createdAt) }}</span>
                  <!-- 時間戳還沒被伺服器蓋上的極短空窗：如實說「剛剛」，不要自己填一個現在時間 -->
                  <span v-else class="text-muted">剛剛</span>
                </template>
              </el-table-column>
              <el-table-column label="誰" width="200">
                <template #default="{ row }">
                  <el-tag :type="row.actor === 'agent' ? 'warning' : 'info'" size="small" effect="light">
                    {{ actorLabel(row) }}
                  </el-tag>
                  <div class="text-xs text-muted">{{ who(row) }}</div>
                </template>
              </el-table-column>
              <el-table-column label="做了什麼">
                <template #default="{ row }">
                  <div>{{ auditActionLabel(row.action) }}</div>
                  <div v-if="row.note" class="text-xs text-muted">{{ row.note }}</div>
                </template>
              </el-table-column>
              <el-table-column label="改動內容">
                <template #default="{ row }">
                  <div v-if="changes(row).length">
                    <div v-for="c in changes(row)" :key="c.key" class="text-xs">
                      {{ c.label }}：{{ c.before }} → <b>{{ c.after }}</b>
                    </div>
                  </div>
                  <span v-else class="text-xs text-muted">—</span>
                </template>
              </el-table-column>
              <!-- 還原：改錯的第一時間需求是收回去，不是自己想起來原本是什麼。
                   ⛔ 還原不了的那些要講出原因，不要只是把按鈕藏起來（藏起來等於沒有回答） -->
              <el-table-column label="" width="92">
                <template #default="{ row }">
                  <el-button v-if="row.revertible" size="small" :loading="reverting === row.id" @click="revert(row)">
                    還原
                  </el-button>
                  <el-tooltip v-else-if="row.revertReason" :content="row.revertReason" placement="left">
                    <span class="text-xs text-muted">不能還原</span>
                  </el-tooltip>
                </template>
              </el-table-column>
            </el-table>

            <div v-if="nextCursor" class="flex justify-center">
              <el-button size="small" :loading="loading" @click="loadMore">載入更多</el-button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
/**
 * 操作紀錄（`C-31` Phase 2 地基）。
 *
 * 為什麼要有這一頁：`auditLogs` 從 2026-08-14 就在寫，但一直沒有任何地方讀得到——
 * 出事時「是誰改的、改前是什麼」查不到。小幫手要開始代人動手之前，這個洞得先補上。
 * ⛔ 這頁**只讀不寫**：稽核紀錄不提供編輯或刪除（能改的紀錄不叫紀錄）。
 */
import { ElMessageBox } from 'element-plus'
import {
  AUDIT_ACTOR_LABELS,
  auditActionLabel,
  auditFieldLabel,
  auditValueText,
  type AuditLogRow,
} from '~~/shared/types/audit'

definePageMeta({ middleware: ['auth', 'workspace-settings'], layout: 'default' })
useHead({ title: useAdminTitle('操作紀錄') })

const { apiFetch } = useWorkspace()

interface AgentStats { proposed: number, executed: number, notConfirmed: number }
interface ListRes {
  items: AuditLogRow[]
  uidEmails: Record<string, string>
  nextCursor: string | null
  agentStats?: AgentStats
}

const rows = ref<AuditLogRow[]>([])
const uidEmails = ref<Record<string, string>>({})
const nextCursor = ref<string | null>(null)
const actorFilter = ref<'all' | 'human' | 'agent'>('all')
const loading = ref(false)
const error = ref('')
const stats = ref<AgentStats | null>(null)
const reverting = ref('')
const { showToast } = useAdminToast()

const emptyText = computed(() =>
  actorFilter.value === 'agent'
    ? '小幫手還沒代你做過任何事'
    : '還沒有任何設定類操作被記錄下來',
)

// el-table 的 slot scope 是 any，這裡收窄一次，讓對照表的 key 型別擋得住打錯字
function actorLabel(row: AuditLogRow): string {
  return AUDIT_ACTOR_LABELS[row.actor] ?? AUDIT_ACTOR_LABELS.human
}

function who(row: AuditLogRow): string {
  // 換不到 Email 就顯示 uid：查不到「是誰」也要看得出「是同一個人」
  return uidEmails.value[row.uid] || row.uid || '（查不到操作者）'
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })
}

/** 前後對照：只列這次真的有變的欄位（後端寫入時就只存有變的） */
function changes(row: AuditLogRow): { key: string, label: string, before: string, after: string }[] {
  const keys = [...new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})])]
  return keys.map(k => ({
    key: k,
    label: auditFieldLabel(k),
    before: auditValueText(row.before?.[k]),
    after: auditValueText(row.after?.[k]),
  }))
}

async function load(cursor: string | null) {
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch<ListRes>('/api/admin/audit-logs', {
      query: {
        ...(actorFilter.value === 'all' ? {} : { actor: actorFilter.value }),
        ...(cursor ? { cursor } : {}),
      },
    })
    rows.value = cursor ? [...rows.value, ...res.items] : res.items
    if (res.agentStats) stats.value = res.agentStats
    uidEmails.value = { ...uidEmails.value, ...res.uidEmails }
    nextCursor.value = res.nextCursor
  }
  catch (e: any) {
    // ⛔ 讀不到就講讀不到：留著上一批資料卻不說話，看的人會以為「最近沒人動過」
    error.value = e?.statusMessage || e?.data?.statusMessage || '這次讀不到操作紀錄，稍後再試一次。'
    if (!cursor) { rows.value = []; nextCursor.value = null }
  }
  finally {
    loading.value = false
  }
}

/**
 * 還原一筆。先講清楚要把什麼改回什麼再按——還原本身也是一次會影響客人的改動。
 * ⛔ 後端會再驗一次「這段期間有沒有被改過」，前端這裡只是把話講清楚。
 */
async function revert(row: AuditLogRow) {
  const lines = changes(row).map(c => `${c.label}：${c.after} → ${c.before}`).join('\n')
  const go = await ElMessageBox.confirm(
    `要把這筆改回去嗎？\n\n${lines || auditActionLabel(row.action)}`,
    '還原這一筆',
    { confirmButtonText: '確定還原', cancelButtonText: '取消', type: 'warning' },
  ).then(() => true).catch(() => false)
  if (!go) return

  reverting.value = row.id
  try {
    const res = await apiFetch<{ message: string }>('/api/admin/audit-logs/revert', { method: 'POST', body: { id: row.id } })
    showToast(res.message, 'success')
    await load(null)
  }
  catch (e: any) {
    // 被擋下來的理由（這段期間又被改過、權限不夠）要原樣講，⛔不要收斂成「失敗」
    showToast(e?.statusMessage || e?.data?.statusMessage || '還原失敗，請到對應頁面確認現在的設定。', 'error')
  }
  finally {
    reverting.value = ''
  }
}

function reload() { load(null) }
function loadMore() { if (nextCursor.value) load(nextCursor.value) }

onMounted(reload)
</script>
