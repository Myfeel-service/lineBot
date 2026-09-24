<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="平台"
        title="全站操作紀錄"
        caption="全部官方帳號、加上平台自己做的事，照時間排在同一條線上。出事時先來這裡看最近誰動過什麼。"
      />
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">最近的操作</span>
            </div>
            <el-radio-group v-model="scopeFilter" size="small">
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button value="platform">只看平台做的</el-radio-button>
            </el-radio-group>
          </div>

          <div class="card-section-stack">
            <!-- 講清楚範圍：這一頁看得到的東西跟租戶那一頁不一樣，不講的話會以為漏了 -->
            <p class="text-xs text-muted">
              <!-- ⛔ 這裡不要寫 Markdown 的 `**粗體**`：它在畫面上會原樣印出兩個星號 -->
              這裡看得到所有官方帳號的設定類操作，以及平台自己做的事（調額度、作廢發票、停用組織、升降超管）。
              平台那幾筆不會出現在客戶自己的「操作紀錄」頁。
            </p>

            <p v-if="error" class="text-xs" role="alert">⚠️ {{ error }}</p>

            <div v-if="loading && !rows.length" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>

            <el-table
              v-else
              :data="visibleRows"
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
              <el-table-column label="哪一家" width="180">
                <template #default="{ row }">
                  <!--
                    ⚠️ 兩種都算平台做的：`scope='platform'`（不屬於任何帳號）
                    與掛在客戶帳號上的 `super.*`（調額度、改方案）。只認 scope 的話，
                    後者會看起來像客戶自己做的。
                  -->
                  <el-tag v-if="row.scope === 'platform'" type="danger" size="small" effect="light">平台</el-tag>
                  <template v-else>
                    <el-tag v-if="isPlatformAction(row.action)" type="danger" size="small" effect="light">平台</el-tag>
                    <div class="text-xs">{{ whichAccount(row) }}</div>
                  </template>
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
                  <div v-if="changes(row).lines.length">
                    <div v-for="c in changes(row).lines" :key="c.key" class="text-xs">
                      <!-- 同租戶那一頁：新增類不印「（空白） →」、刪除類不印「→ （空白）」 -->
                      <template v-if="auditIsCreate(row.before)">{{ c.label }}：<b>{{ c.after }}</b></template>
                      <template v-else-if="auditIsDelete(row.after)">{{ c.label }}：<b>{{ c.before }}</b></template>
                      <template v-else>{{ c.label }}：{{ c.before }} → <b>{{ c.after }}</b></template>
                    </div>
                    <!-- ⛔ 沒印完要講出來：少印幾行而不說，會被讀成「這次就只改了這些」 -->
                    <div v-if="changes(row).omitted" class="text-xs text-muted">
                      還有 {{ changes(row).omitted }} 項也一起改了，這裡沒列出來。
                    </div>
                  </div>
                  <span v-else class="text-xs text-muted">—</span>
                </template>
              </el-table-column>
            </el-table>

            <!--
              ⚠️ 篩選是在**這一頁已經載進來的資料**上做的，不是回伺服器重查。
              所以「只看平台做的」會愈翻愈多，而不是一次就給滿——這件事要講出來，
              不講的話人會以為平台總共只做過這幾件事。
            -->
            <p v-if="scopeFilter === 'platform' && rows.length" class="text-xs text-muted">
              目前只從已經載入的 {{ rows.length }} 筆裡篩出 {{ visibleRows.length }} 筆。要看更早的請繼續往下載入。
            </p>

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
 * 全站操作紀錄（`C-254`，2026-09-24）。
 *
 * **為什麼要有這一頁**：這一輪把超管的動作（調額度、作廢發票、停用組織、升降超管）
 * 補上了稽核，但那些紀錄沒有 `workspaceId`，客戶自己的「操作紀錄」頁查不到它們。
 * ⛔ 少了這一頁，那批紀錄就跟 2026-08-14 到 09-24 之間的 `auditLogs` 一樣是**只進不出**——
 * 那正是這一號要修掉的病，不能在平台層再犯一次。
 *
 * ⛔ 這頁**只讀不寫**，而且**不提供還原**（還原的前置檢查綁在租戶情境上，
 *    在這裡給一顆按下去行為不明的按鈕比沒有按鈕更糟）。
 */
import {
  AUDIT_ACTOR_LABELS,
  auditActionLabel,
  auditChangeLines,
  auditIsCreate,
  auditIsDelete,
  isPlatformAction,
  type AuditChangeSummary,
  type AuditLogRow,
} from '~~/shared/types/audit'

definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '全站操作紀錄 — 超級管理員' })

const { apiFetch } = useSuperAdmin()

type PlatformAuditRow = AuditLogRow & { workspaceId: string, orgId: string, scope: string }
interface ListRes {
  items: PlatformAuditRow[]
  uidEmails: Record<string, string>
  workspaceNames: Record<string, string>
  nextCursor: string | null
}

const rows = ref<PlatformAuditRow[]>([])
const uidEmails = ref<Record<string, string>>({})
const workspaceNames = ref<Record<string, string>>({})
const nextCursor = ref<string | null>(null)
const scopeFilter = ref<'all' | 'platform'>('all')
const loading = ref(false)
const error = ref('')

/**
 * 「只看平台做的」要涵蓋兩種：
 * ①`scope='platform'`（不屬於任何帳號，例如升降超管、作廢發票）
 * ②掛在客戶帳號上的 `super.*`（調額度、改方案——那是平台做的，只是記在客戶那邊）
 * ⛔ 只認 scope 的話，②會從這個篩選裡消失，而那幾筆正是最常被問「誰改了客戶的額度」的。
 */
const visibleRows = computed(() =>
  scopeFilter.value === 'platform'
    ? rows.value.filter(r => r.scope === 'platform' || isPlatformAction(r.action))
    : rows.value,
)

const emptyText = computed(() =>
  scopeFilter.value === 'platform'
    ? '已經載入的這幾筆裡沒有平台自己做的事（往下載入更多再看看）'
    : '還沒有任何設定類操作被記錄下來',
)

function actorLabel(row: PlatformAuditRow): string {
  return AUDIT_ACTOR_LABELS[row.actor] ?? AUDIT_ACTOR_LABELS.human
}

function who(row: PlatformAuditRow): string {
  // 換不到 Email 就顯示 uid：查不到「是誰」也要看得出「是同一個人」
  return uidEmails.value[row.uid] || row.uid || '（查不到操作者）'
}

/** 哪一家。查不到名字就顯示 id 前段，⛔ 不要留空白（空白會被讀成「沒有歸屬」） */
function whichAccount(row: PlatformAuditRow): string {
  if (!row.workspaceId) return row.orgId ? `組織 ${row.orgId.slice(0, 8)}…` : '—'
  return workspaceNames.value[row.workspaceId] || `${row.workspaceId.slice(0, 8)}…`
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })
}

// 算過就存起來：⛔ 不要每次重繪都重算（同租戶那一頁的做法）
const changeCache = new Map<string, AuditChangeSummary>()
function changes(row: PlatformAuditRow): AuditChangeSummary {
  const hit = changeCache.get(row.id)
  if (hit) return hit
  const summary = auditChangeLines(row.before, row.after)
  changeCache.set(row.id, summary)
  return summary
}

async function load(cursor: string | null) {
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch<ListRes>('/api/admin/super/audit-logs', {
      query: { ...(cursor ? { cursor } : {}) },
    })
    rows.value = cursor ? [...rows.value, ...res.items] : res.items
    uidEmails.value = { ...uidEmails.value, ...res.uidEmails }
    workspaceNames.value = { ...workspaceNames.value, ...res.workspaceNames }
    nextCursor.value = res.nextCursor
  }
  catch (e: any) {
    // ⛔ 讀不到就講讀不到：留著上一批卻不說話，看的人會以為「最近沒人動過」
    error.value = e?.statusMessage || e?.data?.statusMessage || '這次讀不到操作紀錄，稍後再試一次。'
    if (!cursor) { rows.value = []; nextCursor.value = null }
  }
  finally {
    loading.value = false
  }
}

function loadMore() { if (nextCursor.value) load(nextCursor.value) }

onMounted(() => load(null))
</script>
