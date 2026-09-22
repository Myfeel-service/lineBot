<!--
  好友統計（貼標分析）——`D-28`＋`D-63` Phase 1。

  ⛔ 三件事不可以妥協：
    ① **這頁不會自己重算**。開頁只讀存檔，重算要按鈕、而且有 1 小時冷卻
       （一份約三四千次 Firestore 讀取，掛在開頁上就是 08-11 讀取費暴衝重演）。
    ② **事件紀錄與意圖要分開講**。97% 的貼標是問卷／活動名冊，說成「客人對 X 有興趣」
       就是騙人。排行那張卡的標題永遠要提醒這件事。
    ③ **覆蓋率的分母寫「有互動的客人」，不可以寫「好友」**——名單只收得到互動過的人，
       寫成好友這個百分比就是虛高的。
-->
<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="統計"
        title="好友統計"
        caption="這些標籤在告訴你什麼——客人在乎什麼、誰還沒被貼到、AI 判得準不準。"
      >
        <template #caption>
          想看客人來了多少、誰接住的？<NuxtLink :to="`/admin/${workspaceId}/conversation-stats`" class="admin-inline-link">看對話統計 →</NuxtLink>
        </template>
      </AdminSoloPageHeading>
      <div class="admin-header-actions">
        <span v-if="report" class="text-xs text-muted">{{ generatedText }}</span>
        <el-tooltip v-if="canOperate" :content="cooldownTip" :disabled="!cooldownTip" placement="top">
          <span>
            <el-button
              size="small"
              type="primary"
              :icon="Refresh"
              :loading="generating"
              :disabled="!allowRegen"
              @click="generate"
            >
              {{ report ? '重新產生' : '產生報告' }}
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack friend-stats">
        <div v-if="loading" class="tags-loading">
          <div class="spinner" />
          <span>載入中…</span>
        </div>

        <!-- ⛔ 讀不到 ≠ 沒有報告：載入失敗要講出來，不可以畫成「還沒產生過」 -->
        <el-alert v-else-if="loadError" type="warning" :closable="false" show-icon>
          <template #title>這次讀不到報告</template>
          {{ loadError }}
        </el-alert>

        <!-- 還沒產生過 -->
        <div v-else-if="!report" class="friend-stats__empty">
          <p class="friend-stats__empty-title">還沒有產生過報告</p>
          <p class="friend-stats__empty-body">
            這份報告會把你的標籤整理成六件事：還沒審的建議、客人自己表現出來的興趣、
            標籤在回答什麼、有多少人一顆標籤都沒有、哪些標籤該清掉、AI 判得準不準。
          </p>
          <p class="friend-stats__empty-body text-muted">
            算一次要掃過整個帳號的貼標紀錄，所以是按鈕觸發、一小時內只算一次。
          </p>
          <el-button v-if="canOperate" type="primary" :loading="generating" @click="generate">產生報告</el-button>
          <p v-else class="text-muted">這要請有操作權限的人來按。</p>
        </div>

        <template v-else>
          <!-- ── 算不完整的話先講 ────────────────────────────────── -->
          <el-alert v-if="integrityLines.length" type="warning" :closable="false" show-icon>
            <template #title>這份報告有幾塊不完整</template>
            <ul class="friend-stats__warn-list">
              <li v-for="(l, i) in integrityLines" :key="i">{{ l }}</li>
            </ul>
          </el-alert>

          <!-- ── 白話總結 ──────────────────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">一句話總結</span>
                <span class="text-xs text-muted">數字是程式算的，這段只是把它翻成白話</span>
              </div>
            </div>
            <div class="card-section-stack">
              <div v-if="report.summary" class="friend-stats__summary">
                <p v-for="(l, i) in summaryLines" :key="i">{{ l }}</p>
              </div>
              <!-- ⛔ 沒有總結一定要講為什麼（三種理由三句話），不可以讓它靜靜消失 -->
              <p v-else class="friend-stats__muted">{{ summarySkipText(report.summarySkip) }}</p>
            </div>
          </div>

          <!-- ── 卡 1：還沒審的建議 ────────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">還沒審的 AI 建議</span>
              </div>
            </div>
            <div class="card-section-stack">
              <p v-if="p.pendingReview.users === 0" class="friend-stats__muted">目前沒有等著決定的建議。</p>
              <template v-else>
                <p class="friend-stats__lead">
                  <b>{{ pendingUsersText }}</b> 的標籤建議還沒決定。
                  下面的分析沒有算到他們——審完這頁的數字才完整。
                </p>
                <div class="friend-stats__chips">
                  <el-tag v-for="t in p.pendingReview.byTag.slice(0, 8)" :key="t.tagId" size="small" type="info">
                    {{ t.name }}（{{ t.users }}）
                  </el-tag>
                </div>
                <!-- ⛔ 不要帶 `?tab=review`：標籤頁沒有那個分頁，審建議是每一列的「待審 N 位」按鈕 -->
                <NuxtLink :to="`/admin/${workspaceId}/tags`" class="admin-inline-link">去標籤管理審這些建議 →</NuxtLink>
              </template>
            </div>
          </div>

          <!-- ── 卡 2：客人自己表現出來的興趣 ───────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">客人自己表現出來的</span>
                <!-- ⭐ 這句是鐵律②的門面：不寫的話這張表會被讀成「客人的興趣排行」 -->
                <span class="text-xs text-muted">客人講出來、或系統從對話判出來的，不是我們自己圈的</span>
              </div>
            </div>
            <div class="card-section-stack">
              <p v-if="!p.customerExpressed.length" class="friend-stats__muted">
                還沒有這一類的標籤。手動貼的、匯入的刻意不算進來——不然自己批次貼一次就霸佔第一名。
              </p>
              <template v-else>
                <el-table :data="p.customerExpressed" size="small" class="friend-stats__table">
                  <el-table-column prop="name" label="標籤" min-width="180" />
                  <!-- ⭐ 這一欄不可以省：2026-09-23 實測，連 AI 看到「問卷_X：1691 位」都會
                       寫成「客戶對這個的興趣最高」。人看這張表一樣會這樣讀。 -->
                  <el-table-column label="這顆在講什麼" width="150">
                    <template #default="{ row }">
                      <el-tag size="small" :type="row.isIntent ? 'success' : 'info'">
                        {{ row.isIntent ? '想要什麼' : '做過什麼' }}
                      </el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column prop="users" label="幾位客人" width="100" align="right" />
                  <el-table-column label="" width="130" align="right">
                    <template #default="{ row }">
                      <el-button v-if="canOperate" link type="primary" size="small" @click="broadcastTo(row)">
                        發推播給這群
                      </el-button>
                    </template>
                  </el-table-column>
                </el-table>

                <div v-if="p.intersections.length" class="friend-stats__sub">
                  <p class="friend-stats__sub-title">同時有兩顆標籤的人</p>
                  <p v-for="(x, i) in p.intersections" :key="i" class="friend-stats__sub-line">
                    「{{ x.a.name }}」＋「{{ x.b.name }}」：<b>{{ x.users }}</b> 位
                  </p>
                  <p class="friend-stats__muted">少於 5 位的組合不列——兩三個人的交集是雜訊。</p>
                </div>
                <!-- 誠信紅線：標「做過什麼」的那幾列不是興趣排行 -->
                <p class="friend-stats__muted">
                  標「<b>做過什麼</b>」的是事件紀錄（填過那份問卷、報名過那檔活動），
                  <b>不代表他想買</b>；只有標「想要什麼」的才是 AI 從對話判出來的意圖。
                </p>
              </template>
            </div>
          </div>

          <!-- ── 卡 3：標籤在回答什麼 ──────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">這些標籤在回答什麼</span>
              </div>
            </div>
            <div class="card-section-stack">
              <div class="friend-stats__split">
                <div class="friend-stats__split-col">
                  <div class="stat-label">意圖（這個人想要什麼）</div>
                  <div class="stat-value">{{ p.eventVsIntent.intent.taggings }}</div>
                  <div class="text-xs text-muted">{{ p.eventVsIntent.intent.tags }} 顆標籤，有開 AI 判斷</div>
                </div>
                <div class="friend-stats__split-col">
                  <div class="stat-label">事件紀錄（這個人做過什麼）</div>
                  <div class="stat-value">{{ p.eventVsIntent.event.taggings }}</div>
                  <div class="text-xs text-muted">{{ p.eventVsIntent.event.tags }} 顆標籤，例如填了哪份問卷</div>
                </div>
              </div>
              <p class="friend-stats__muted">
                事件紀錄只代表「這個人做過這件事」，不等於他想買。
                想知道「誰在想買什麼」要靠意圖型標籤——那要在標籤裡開 AI 判斷。
              </p>
            </div>
          </div>

          <!-- ── 卡 4：覆蓋率 ──────────────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">有多少人被貼到</span>
              </div>
            </div>
            <div class="card-section-stack">
              <!-- ⛔ 掃描截斷時 pct 是 null：要講「算不出來」，不可以畫一個錯的百分比 -->
              <p v-if="p.coverage.pct === null" class="friend-stats__muted">
                這次算不出覆蓋率（貼標紀錄掃到上限，或名單人數讀不到）。重新產生一次看看。
              </p>
              <template v-else>
                <p class="friend-stats__lead">
                  有互動的客人共 <b>{{ p.coverage.totalUsers }}</b> 位，
                  其中 <b>{{ p.coverage.taggedUsers }}</b> 位身上至少有一顆標籤（{{ p.coverage.pct }}%）。
                </p>
                <p v-if="p.coverage.untaggedUsers">
                  另外 <b>{{ p.coverage.untaggedUsers }}</b> 位一顆都沒有——任何按標籤發的推播都會漏掉他們。
                </p>
                <!-- 誠信紅線：分母講清楚，否則這個百分比是虛高的 -->
                <p class="friend-stats__muted">
                  分母是「<b>有互動的客人</b>」，不是 LINE 的好友總數——從來沒講過話的好友不在我們的名單裡。
                </p>
              </template>
            </div>
          </div>

          <!-- ── 卡 5：健康檢查 ────────────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">該清一清的標籤</span>
              </div>
            </div>
            <div class="card-section-stack">
              <p v-if="!p.health.zeroMember.length && !p.health.aiOnButNeverProduced.length" class="friend-stats__muted">
                沒有發現需要處理的標籤。
              </p>
              <template v-else>
                <div v-if="p.health.zeroMember.length">
                  <p class="friend-stats__lead"><b>{{ p.health.zeroMember.length }}</b> 顆建了沒用到，建議封存：</p>
                  <div class="friend-stats__chips">
                    <el-tag v-for="t in p.health.zeroMember" :key="t.tagId" size="small" type="info">{{ t.name }}</el-tag>
                  </div>
                </div>
                <div v-if="p.health.aiOnButNeverProduced.length">
                  <p class="friend-stats__lead">
                    <b>{{ p.health.aiOnButNeverProduced.length }}</b> 顆開著 AI 判斷但從來沒判出過人——
                    判斷條件寫了等於沒寫：
                  </p>
                  <div class="friend-stats__chips">
                    <el-tag v-for="t in p.health.aiOnButNeverProduced" :key="t.tagId" size="small" type="warning">{{ t.name }}</el-tag>
                  </div>
                  <NuxtLink :to="`/admin/${workspaceId}/tags`" class="admin-inline-link">去改判斷條件 →</NuxtLink>
                </div>
                <!-- ⛔ 重複偵測不在這裡重做一套：D-62 已經有了，這裡只指路 -->
                <p class="friend-stats__muted">疑似重複的標籤在「標籤管理」頁的重複檢查裡，這裡不重做一份。</p>
              </template>
            </div>
          </div>

          <!-- ── 卡 6：AI 貼標的成績 ───────────────────────────── -->
          <div class="message-card ar-section-card">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">AI 判得準不準</span>
                <span class="text-xs text-muted">資料自 {{ p.integrity.suggestionLedgerSince }} 起累積</span>
              </div>
            </div>
            <div class="card-section-stack">
              <!-- ⛔ 沒有人做過決定時同意率是 null，不是 0%（0% 會被讀成「AI 全錯」） -->
              <p v-if="p.suggestions.acceptanceRate === null" class="friend-stats__muted">
                還沒有人決定過任何一筆建議，算不出同意率。
                AI 提過 {{ p.suggestions.suggested }} 次。
              </p>
              <template v-else>
                <p class="friend-stats__lead">
                  AI 提過 <b>{{ p.suggestions.suggested }}</b> 次建議，人決定了 <b>{{ p.suggestions.decided }}</b> 次，
                  其中 <b>{{ p.suggestions.agreed }}</b> 次同意 AI 的判斷＝<b>{{ p.suggestions.acceptanceRate }}%</b>。
                </p>
                <p v-if="p.suggestions.superseded" class="friend-stats__muted">
                  （含 {{ p.suggestions.superseded }} 次是「沒按採用、自己去貼了同一顆」——那也算同意。）
                </p>
              </template>
              <p v-if="p.suggestions.autoApplied" class="friend-stats__muted">
                另有 {{ p.suggestions.autoApplied }} 次是設成「AI 判到直接貼」、沒有經過人，
                <b>沒有算進上面的同意率</b>——那些沒有人投過票。
              </p>
              <!-- ⛔ 這本帳跟卡 1 的待審不可以相加對帳：兩本帳問的問題不同 -->
              <p class="friend-stats__muted">
                這本帳問的是「建議的結局是什麼」，卡一問的是「現在誰在等」——⛔ 兩邊的數字不要相加。
              </p>
            </div>
          </div>
        </template>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import { useAdminToast } from '~~/app/composables/useAdminToast'
import {
  cooldownText,
  summarySkipText,
  type TagInsightsPayload,
  type TagReportDoc,
} from '~~/shared/tag-report'

definePageMeta({ middleware: 'auth', layout: 'default' })
useHead({ title: useAdminTitle('好友統計') })

const { showToast } = useAdminToast()
const { apiFetch, workspaceId, canOperate } = useWorkspace()

const report = ref<TagReportDoc | null>(null)
const allowRegen = ref(false)
const remainingMs = ref(0)
const loading = ref(true)
const loadError = ref('')
const generating = ref(false)

/** 有報告才會用到；模板已用 v-else 擋過，這裡給個不會爆的形狀 */
const p = computed(() => report.value?.payload as TagInsightsPayload)

const generatedText = computed(() => {
  const r = report.value
  if (!r) return ''
  const d = new Date(r.generatedAtMs)
  const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return r.generatedBy ? `${when} 由 ${r.generatedBy} 產生` : `${when} 產生`
})

const cooldownTip = computed(() => (allowRegen.value ? '' : cooldownText(remainingMs.value)))

const summaryLines = computed(() =>
  String(report.value?.summary ?? '').split('\n').map(s => s.trim()).filter(Boolean))

/** 掃描撞上限一定要講出來——⛔ 不可以讓人把截斷後的數字當精確值（三態鐵律） */
const integrityLines = computed(() => {
  const i = report.value?.payload?.integrity
  if (!i) return []
  const out: string[] = []
  if (i.failed.length) out.push(`有 ${i.failed.length} 塊資料這次查不到（${i.failed.join('、')}），相關的數字不完整。`)
  if (i.userTagsTruncated) out.push(`貼標紀錄掃到上限（已掃 ${i.scannedUserTags} 筆），排行與覆蓋率只算了這一段。`)
  if (i.pendingTruncated) out.push('待審建議掃到上限，「還沒審的建議」是掃到的那些裡的數字，不是全部。')
  if (i.suggestionLogsTruncated) out.push('AI 貼標底帳掃到上限，同意率只算了掃到的那一段。')
  return out
})

/** 撞上限時「45 位」要變成「掃到的那些裡有 45 位」——⛔ 不可以當精確值 */
const pendingUsersText = computed(() => {
  const i = report.value?.payload?.integrity
  const n = report.value?.payload?.pendingReview.users ?? 0
  return i?.pendingTruncated ? `掃到的那些裡有 ${n} 位客人` : `${n} 位客人`
})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const r = await apiFetch<{ report: TagReportDoc | null, canRegenerate: boolean, cooldownRemainingMs: number }>('/api/tag/report')
    report.value = r.report
    allowRegen.value = r.canRegenerate
    remainingMs.value = r.cooldownRemainingMs
  }
  catch (e: unknown) {
    // ⛔ 讀不到不可以畫成「還沒產生過」：那會讓人以為之前那份不見了
    loadError.value = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || '請稍後再試一次'
  }
  finally {
    loading.value = false
  }
}

async function generate() {
  generating.value = true
  try {
    const r = await apiFetch<{ report: TagReportDoc, canRegenerate: boolean, cooldownRemainingMs: number }>('/api/tag/report', { method: 'POST' })
    report.value = r.report
    allowRegen.value = r.canRegenerate
    remainingMs.value = r.cooldownRemainingMs
    showToast('報告產生好了', 'success')
  }
  catch (e: unknown) {
    showToast((e as { data?: { statusMessage?: string } })?.data?.statusMessage || '產生失敗，請再試一次', 'error')
  }
  finally {
    generating.value = false
  }
}

/**
 * 「發推播給這群」——帶標籤過去、受眾自動選好。
 * ⛔ 只開一張**還沒存檔**的草稿，不建資料也不送出（`C-210`／`C-225` 同一條界線）。
 *
 * ⚠️ **這一支刻意用網址參數，不用 `sessionStorage`**——跟好友頁那條路不一樣：
 *    那邊要搬的是三百個客人的 LINE 編號（塞不進網址、也不該出現在網址列），
 *    這邊只有一個標籤 id。用網址參數換來的是「重新整理還在、連結貼得出去」。
 */
function broadcastTo(row: { tagId: string, name: string }) {
  void navigateTo(`/admin/${workspaceId.value}/broadcasts?from=friend-stats&tagId=${encodeURIComponent(row.tagId)}`)
}

onMounted(load)
</script>
