<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="操作紀錄"
        caption="誰把什麼改成什麼，包含小幫手代你做的每一筆。出事時先來這裡看最近動過什麼。"
      />
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">最近的操作</span>
            </div>
            <el-radio-group v-model="actorFilter" size="small" @change="reload">
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

interface ListRes { items: AuditLogRow[], uidEmails: Record<string, string>, nextCursor: string | null }

const rows = ref<AuditLogRow[]>([])
const uidEmails = ref<Record<string, string>>({})
const nextCursor = ref<string | null>(null)
const actorFilter = ref<'all' | 'human' | 'agent'>('all')
const loading = ref(false)
const error = ref('')

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

function reload() { load(null) }
function loadMore() { if (nextCursor.value) load(nextCursor.value) }

onMounted(reload)
</script>
