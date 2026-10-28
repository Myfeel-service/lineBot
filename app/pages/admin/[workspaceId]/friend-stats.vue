<!--
  好友統計（`D-155` 改版，2026-10-28 老闆「好執行」）。

  舊版（`D-28`＋`D-63` Phase 1）回答「標籤系統健不健康」，店家看完不知道要做什麼；
  這一版回答：接下來該做什麼（行銷提案、也要留意）、客人最近在想什麼、推播發給誰有反應、新的人從哪裡來。
  報告＝`docs/FRIEND-STATS-REDESIGN-EVAL-20261028.md`，示意頁畫布 `9FNfkaT1yCCRQjB9KStPLd`。

  ⛔ 不可以妥協的幾件事：
    ① **這頁不會自己重算**。開頁只讀存檔，重算要按鈕、而且有 1 小時冷卻（一份約一萬次讀取＋問 LINE 約 31 次）。
    ② **數字一律程式算，AI 只擬推播文案**。提案的對象、理由、時機照 `shared/friend-report-advice.ts` 的規則；
       AI 只在按「幫我擬三版文案」時寫字，發不發由人在推播頁按。
    ③ **名冊不是興趣**：問卷／活動名冊只出現在「推播」「新進名單」兩區（當受眾與來源），
       「客人最近在想什麼」只列有開 AI 判斷的標籤——分界由版面守，不再靠一段段提醒。
    ④ **查不到不是 0**：每一格查不到都要講出來（三態）。
-->
<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading field-label="統計" title="好友統計" :help-topics="['friend-stats']">
        <template #caption>
          <template v-if="p">最近 30 天（{{ md(p.window.startDate) }}–{{ md(p.window.endDate) }}）。</template>
          想看客人來了多少、誰接住的？<NuxtLink :to="`/admin/${workspaceId}/conversation-stats`" class="admin-inline-link">看對話統計 →</NuxtLink>
        </template>
      </AdminSoloPageHeading>
      <!-- ⛔ 還沒有報告時這裡不放按鈕：中間的空狀態已經有一顆「產生報告」（`D-108`） -->
      <div v-if="report" class="admin-header-actions" data-tour="fs-regenerate">
        <span class="text-xs text-muted">{{ generatedText }}</span>
        <!-- 一小時冷卻的說明只放在這裡：要再按的時候才需要知道 -->
        <el-tooltip v-if="can('tags.write')" :content="cooldownTip" :disabled="!cooldownTip" placement="top">
          <span>
            <el-button
              size="small"
              type="primary"
              :icon="Refresh"
              :loading="generating"
              :disabled="!allowRegen"
              @click="generate"
            >
              重新產生
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

        <!-- 第一次產生、等待中：⛔ 不可以只有按鈕在轉（`D-108`）。⚠️ 刻意不寫秒數：沒在正式站量過 -->
        <div v-else-if="!report && generating" class="message-card ar-section-card friend-stats__empty-card">
          <div class="friend-stats__empty" role="status">
            <div class="spinner friend-stats__empty-spinner" />
            <p class="friend-stats__empty-title">正在整理你的好友資料⋯</p>
            <p class="friend-stats__empty-body">要等一下子。好了會直接出現在這裡，不用重新整理。</p>
          </div>
        </div>

        <!-- 還沒產生過：只留標題＋一顆按鈕（`D-108`） -->
        <div v-else-if="!report" class="message-card ar-section-card friend-stats__empty-card" data-tour="fs-empty">
          <div class="friend-stats__empty">
            <div class="friend-stats__empty-icon"><el-icon><PieChart /></el-icon></div>
            <p class="friend-stats__empty-title">還沒有產生過報告</p>
            <el-button v-if="can('tags.write')" type="primary" @click="generate">產生報告</el-button>
            <!-- 點名角色：「有操作權限的人」他在畫面上找不到是誰 -->
            <p v-else class="friend-stats__empty-body">要請客服或管理員來按「產生報告」，產生好之後你就看得到。</p>
          </div>
        </div>

        <!-- `D-155` 以前存的舊報告：⛔ 不可以畫成空的報告。按鈕在右上角，這裡不再放第二顆（`D-108` 同一條） -->
        <div v-else-if="!p" class="message-card ar-section-card friend-stats__empty-card" data-tour="fs-legacy">
          <div class="friend-stats__empty">
            <div class="friend-stats__empty-icon"><el-icon><PieChart /></el-icon></div>
            <p class="friend-stats__empty-title">這份是改版前的報告</p>
            <p class="friend-stats__empty-body">
              {{ can('tags.write') ? '按右上角「重新產生」就看得到新版。' : '要請客服或管理員按「重新產生」，好了之後你就看得到新版。' }}
            </p>
          </div>
        </div>

        <template v-else>
          <!-- ── 算不完整的話先講 ────────────────────────────────── -->
          <el-alert v-if="integrityLines.length" type="warning" :closable="false" show-icon>
            <template #title>這份報告有幾塊不完整</template>
            <ul class="friend-stats__warn-list">
              <li v-for="(l, i) in integrityLines" :key="i">{{ l }}</li>
            </ul>
          </el-alert>

          <!-- ── 三格總覽 ────────────────────────────────────────── -->
          <div class="friend-stats__tiles">
            <el-card v-for="t in tiles" :key="t.key" shadow="never" class="friend-stats__tile">
              <div class="friend-stats__tile-body">
                <el-tooltip :content="t.tip" placement="top">
                  <div class="stat-label friend-stats__tile-label">{{ t.label }} <span class="friend-stats__info">ⓘ</span></div>
                </el-tooltip>
                <div class="stat-value friend-stats__tile-value">
                  {{ t.value }}<span v-if="t.unit" class="friend-stats__tile-unit">{{ t.unit }}</span>
                </div>
                <div class="text-xs text-muted friend-stats__tile-foot">{{ t.foot }}</div>
              </div>
            </el-card>
          </div>

          <!-- ── 行銷提案 ────────────────────────────────────────── -->
          <div class="message-card ar-section-card" data-tour="fs-proposals">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">行銷提案</span>
              </div>
            </div>
            <p v-if="outcomeText" class="friend-stats__outcome">{{ outcomeText }}</p>
            <!-- `C-352`①：方案發不了「依標籤」就先講一次、按鈕全部鎖住 -->
            <AdminBroadcastPlanLock
              v-if="proposals.length && can('broadcast.write') && broadcastLock"
              class="friend-stats__lock"
              :text="broadcastLock"
            />
            <p v-if="!proposals.length" class="friend-stats__muted friend-stats__pad">{{ proposalsEmpty }}</p>
            <div
              v-for="(prop, i) in proposals"
              :key="prop.tagId"
              class="friend-stats__prop"
              :class="{ 'friend-stats__prop--sep': i > 0 }"
              :data-proposal="prop.tagId"
            >
              <div class="friend-stats__prop-top">
                <span class="friend-stats__pill friend-stats__pill--buy">提案 {{ i + 1 }}</span>
                <span class="friend-stats__prop-title">{{ prop.title }}</span>
                <!-- 第 1 則永遠展開；第 2 則收合，按了才看（⛔ 收合鈕不跟動作鈕同名） -->
                <el-button v-if="i > 0" link type="primary" class="friend-stats__toggle" @click="toggleProposal(prop.tagId)">
                  {{ isOpen(prop.tagId, i) ? '收合' : '展開' }}
                </el-button>
              </div>
              <div v-if="isOpen(prop.tagId, i)" class="friend-stats__prop-grid">
                <dl class="friend-stats__kv">
                  <dt>發給誰</dt><dd>{{ prop.who }}</dd>
                  <dt>為什麼</dt><dd>{{ prop.why }}</dd>
                  <dt>什麼時候</dt><dd>{{ prop.when }}</dd>
                </dl>
                <div class="friend-stats__draft">
                  <div class="friend-stats__draft-head">
                    <span>文案草稿</span>
                    <span v-if="canDraft && variantsOf(prop.tagId).length" class="friend-stats__draft-nav">
                      <el-button
                        size="small"
                        circle
                        :icon="ArrowLeft"
                        aria-label="上一版"
                        :disabled="draftOf(prop.tagId).index === 0"
                        @click="stepVariant(prop.tagId, -1)"
                      />
                      <span>第 {{ draftOf(prop.tagId).index + 1 }} 版／共 {{ variantsOf(prop.tagId).length }} 版</span>
                      <el-button
                        size="small"
                        circle
                        :icon="ArrowRight"
                        aria-label="下一版"
                        :disabled="draftOf(prop.tagId).index >= variantsOf(prop.tagId).length - 1"
                        @click="stepVariant(prop.tagId, 1)"
                      />
                    </span>
                  </div>
                  <template v-if="!canDraft">
                    <p class="friend-stats__muted">
                      {{ can('broadcast.write') ? '這個方案發不了依標籤的推播，升級之後才擬得了。' : '要有推播權限的人才能擬文案、開推播草稿。' }}
                    </p>
                  </template>
                  <template v-else-if="variantsOf(prop.tagId).length">
                    <p class="friend-stats__draft-text" data-draft-text>{{ variantsOf(prop.tagId)[draftOf(prop.tagId).index] }}</p>
                    <div class="friend-stats__draft-actions">
                      <el-button type="primary" @click="openDraft(prop)">用這版開推播草稿</el-button>
                      <el-button :loading="draftOf(prop.tagId).loading" @click="draftCopy(prop)">換一批</el-button>
                    </div>
                  </template>
                  <template v-else>
                    <div class="friend-stats__draft-actions">
                      <el-button type="primary" :loading="draftOf(prop.tagId).loading" @click="draftCopy(prop)">
                        {{ draftOf(prop.tagId).loading ? '正在擬⋯' : '幫我擬三版文案' }}
                      </el-button>
                    </div>
                  </template>
                  <p v-if="draftOf(prop.tagId).error" class="friend-stats__error">{{ draftOf(prop.tagId).error }}</p>
                </div>
              </div>
            </div>
            <p v-if="proposals.length" class="friend-stats__muted friend-stats__pad friend-stats__pad--foot">
              照提案發出去之後，下一份報告會回報它的成績、跟你其他推播比。
            </p>
          </div>

          <!-- ── 也要留意（沒有就整段不出現） ───────────────────── -->
          <div v-if="watchItems.length" class="message-card ar-section-card" data-tour="fs-watch">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">也要留意</span>
              </div>
            </div>
            <div
              v-for="(w, i) in watchItems"
              :key="w.kind"
              class="friend-stats__todo"
              :class="{ 'friend-stats__prop--sep': i > 0 }"
            >
              <span class="friend-stats__pill" :class="w.kind === 'push' ? 'friend-stats__pill--push' : 'friend-stats__pill--care'">
                {{ w.kind === 'push' ? '推播' : '留意' }}
              </span>
              <div class="friend-stats__todo-main">
                <div class="friend-stats__prop-title">{{ w.title }}</div>
                <div class="friend-stats__todo-why">{{ w.why }}</div>
              </div>
              <el-button @click="runWatchAction(w)">{{ w.action.label }}</el-button>
            </div>
          </div>

          <!-- ── 客人最近在想什麼 ────────────────────────────────── -->
          <div class="message-card ar-section-card" data-tour="fs-intents">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">客人最近在想什麼</span>
                <span class="text-xs text-muted">AI 從對話判出來的</span>
              </div>
            </div>
            <p v-if="!p.intents.length" class="friend-stats__muted friend-stats__pad">
              還沒有標籤開 AI 判斷。開了之後，客人在對話裡提到的東西會自動被貼上。
              <NuxtLink :to="`/admin/${workspaceId}/tags`" class="admin-inline-link">前往標籤管理 →</NuxtLink>
            </p>
            <div v-else class="friend-stats__tbox">
              <table class="friend-stats__table">
                <thead>
                  <tr>
                    <th>標籤</th>
                    <th class="is-num">目前共</th>
                    <th>最近 30 天新增</th>
                    <th class="is-num">前 30 天新增</th>
                    <th />
                  </tr>
                </thead>
                <tbody v-for="g in intentGroups" :key="g.key">
                  <tr class="friend-stats__group">
                    <td colspan="5">{{ g.label }}</td>
                  </tr>
                  <tr v-for="t in g.rows" :key="t.tagId">
                    <td>{{ t.name }}</td>
                    <td class="is-num">{{ fmt(t.members) }}</td>
                    <td>
                      <div class="friend-stats__barcell">
                        <span class="friend-stats__barnum">{{ fmt(t.recent) }}</span>
                        <div class="friend-stats__track">
                          <div class="friend-stats__bar" :class="{ 'friend-stats__bar--gray': g.key !== 'interest' }" :style="{ width: barWidth(t.recent, maxRecent) }" />
                        </div>
                      </div>
                    </td>
                    <td class="is-num text-muted">{{ fmt(t.prev) }}</td>
                    <td class="is-num">
                      <!-- 興趣那組可以直接發推播；其他（出貨、退換貨…）是要照顧的人，只給看名單 -->
                      <el-button
                        v-if="g.key === 'interest' && can('broadcast.write')"
                        link
                        type="primary"
                        :disabled="!!broadcastLock"
                        data-entry-broadcast
                        @click="broadcastTo(t.tagId)"
                      >
                        發推播
                      </el-button>
                      <el-button v-else link type="primary" @click="viewUsers(t.tagId)">看名單</el-button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- ── 推播發給誰最有反應 ────────────────────────────── -->
          <div id="fs-pushes" class="message-card ar-section-card" data-tour="fs-pushes">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">推播發給誰最有反應</span>
                <span v-if="p.pushes?.length" class="text-xs text-muted">最近 30 天 {{ p.pushes.length }} 則・數字是 LINE 官方統計</span>
              </div>
            </div>
            <p v-if="p.pushes === null" class="friend-stats__muted friend-stats__pad">這次讀不到推播，重新產生一次看看。</p>
            <p v-else-if="!p.pushes.length" class="friend-stats__muted friend-stats__pad">最近 30 天沒有發過推播。</p>
            <template v-else>
              <div class="friend-stats__tbox">
                <table class="friend-stats__table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>推播</th>
                      <th>發給</th>
                      <th class="is-num">送到</th>
                      <th class="is-num">打開</th>
                      <th>點連結的比例</th>
                      <th class="is-num">當天封鎖</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in pushTable" :key="r.id">
                      <td class="text-muted">{{ mdOfMs(r.completedMs) }}</td>
                      <td>
                        <NuxtLink :to="`/admin/${workspaceId}/broadcasts?id=${r.id}`" class="friend-stats__push-name">{{ r.name }}</NuxtLink>
                        <el-tag v-if="r.proposalTagId" size="small" type="success" class="friend-stats__push-tag">照提案發的</el-tag>
                      </td>
                      <td class="text-muted">{{ r.audienceText }}</td>
                      <td class="is-num">{{ fmt(r.sent) }}</td>
                      <td class="is-num">{{ r.opened === null ? '—' : fmt(r.opened) }}</td>
                      <td>
                        <div v-if="r.clicked !== null" class="friend-stats__barcell">
                          <span class="friend-stats__barnum">{{ r.clickPct }}</span>
                          <div class="friend-stats__track">
                            <div class="friend-stats__bar friend-stats__bar--blue" :style="{ width: r.clickBar }" />
                          </div>
                          <span class="text-muted">{{ fmt(r.clicked) }} 位</span>
                        </div>
                        <span v-else class="text-muted">這則沒有連結點擊資料</span>
                      </td>
                      <td class="is-num">
                        <span :class="{ 'friend-stats__warn': r.blockWarn, 'text-muted': r.blockText === '同一天' || r.blockText === '—' }">{{ r.blockText }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="friend-stats__muted friend-stats__pad">{{ pushNote }}</p>
            </template>
          </div>

          <!-- ── 新進名單從哪裡來 ────────────────────────────────── -->
          <div class="message-card ar-section-card" data-tour="fs-sources">
            <div class="message-card-header">
              <div class="card-header-main">
                <span class="section-title">新進名單從哪裡來</span>
                <span v-if="p.newMembers.total" class="text-xs text-muted">
                  這 30 天第一次進名單的 {{ fmt(p.newMembers.total) }} 位，照第一顆標籤分
                </span>
              </div>
            </div>
            <div class="card-section-stack">
              <p v-if="p.newMembers.total === null" class="friend-stats__muted">這次查不到新進名單，重新產生一次看看。</p>
              <p v-else-if="p.newMembers.total === 0" class="friend-stats__muted">這 30 天沒有新進名單。</p>
              <template v-else>
                <div class="friend-stats__src">
                  <template v-for="s in p.newMembers.rows" :key="`${s.kind}-${s.tagId ?? s.name}`">
                    <div class="friend-stats__src-name" :title="s.name">{{ s.name }}</div>
                    <div class="friend-stats__track friend-stats__track--thick">
                      <div class="friend-stats__bar" :class="{ 'friend-stats__bar--gray': s.kind !== 'tag' }" :style="{ width: barWidth(s.users, maxSource) }" />
                    </div>
                    <div class="friend-stats__src-num">{{ fmt(s.users) }}</div>
                  </template>
                </div>
                <!-- ⛔ 這個母數跟 LINE 的新加好友不同（`H-44`），兩格同頁出現就要講為什麼 -->
                <p class="friend-stats__muted">
                  「沒有來源標籤」多半是自己加好友、直接傳訊息來的人。以前就是好友、這次才第一次填問卷的也算在內，所以會比上面 LINE 的新加好友多。
                </p>
              </template>
            </div>
          </div>

          <!-- ── 標籤整理（收合在最底） ──────────────────────────── -->
          <details class="message-card ar-section-card friend-stats__housekeeping" data-tour="fs-housekeeping" @toggle="onHousekeepingToggle">
            <summary class="message-card-header friend-stats__housekeeping-summary">
              <div class="card-header-main">
                <span class="section-title">標籤整理</span>
                <span class="text-xs text-muted">{{ housekeepingSummary }}</span>
              </div>
              <span class="text-xs text-muted">{{ housekeepingOpen ? '收合' : '展開' }}</span>
            </summary>
            <div class="card-section-stack">
              <dl class="friend-stats__kv friend-stats__kv--wide">
                <template v-if="p.housekeeping.zeroMember.length">
                  <dt>建了沒人用</dt>
                  <dd class="friend-stats__chips">
                    <el-tag v-for="t in p.housekeeping.zeroMember" :key="t.tagId" size="small" type="info">{{ t.name }}</el-tag>
                    <NuxtLink :to="`/admin/${workspaceId}/tags`" class="admin-inline-link">前往標籤管理封存 →</NuxtLink>
                  </dd>
                </template>
                <template v-if="p.housekeeping.aiOnButNeverProduced.length">
                  <dt>開著 AI 判斷卻沒判出人</dt>
                  <dd class="friend-stats__chips">
                    <el-tag v-for="t in p.housekeeping.aiOnButNeverProduced" :key="t.tagId" size="small" type="warning">{{ t.name }}</el-tag>
                    <NuxtLink :to="`/admin/${workspaceId}/tags`" class="admin-inline-link">前往改判斷條件 →</NuxtLink>
                  </dd>
                </template>
                <dt>沒有任何標籤</dt>
                <dd>
                  <template v-if="p.housekeeping.untaggedUsers === null">這次算不出來（貼標紀錄掃到上限，或名單人數讀不到）</template>
                  <template v-else>{{ fmt(p.housekeeping.untaggedUsers) }} 位——按標籤發的推播不會發到他們</template>
                </dd>
                <dt>AI 判斷準不準</dt>
                <dd>{{ accuracyText }}</dd>
                <dt>等你決定的 AI 建議</dt>
                <dd>
                  <template v-if="p.housekeeping.pendingUsers === 0">沒有</template>
                  <template v-else>
                    {{ p.integrity.pendingTruncated ? `掃到的那些裡有 ${fmt(p.housekeeping.pendingUsers)} 位` : `${fmt(p.housekeeping.pendingUsers)} 位` }}
                    <!-- ⛔ 不要帶 `?tab=review`：標籤頁沒有那個分頁，審建議是每一列的「待審 N 位」按鈕 -->
                    <NuxtLink :to="`/admin/${workspaceId}/tags`" class="admin-inline-link">前往標籤管理審核 →</NuxtLink>
                  </template>
                </dd>
              </dl>
            </div>
          </details>
        </template>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { ArrowLeft, ArrowRight, PieChart, Refresh } from '@element-plus/icons-vue'
import { useAdminToast } from '~~/app/composables/useAdminToast'
import { broadcastEntryLockText } from '~~/shared/billing/plans'
import { BROADCAST_DRAFT_HANDOFF_KEY, type BroadcastDraftHandoff } from '~~/shared/broadcast-draft-handoff'
import {
  blockBaseline,
  fmt,
  lineDayOfMs,
  md,
  mdOfMs,
  type FriendReportPayload,
  type IntentTagStat,
} from '~~/shared/friend-report'
import {
  BLOCK_SPIKE_MIN,
  BLOCK_SPIKE_RATIO,
  buildProposals,
  buildWatchItems,
  proposalOutcomeText,
  proposalsEmptyText,
  type Proposal,
  type WatchItem,
} from '~~/shared/friend-report-advice'
import { cooldownText, type TagReportDoc } from '~~/shared/tag-report'

definePageMeta({ middleware: 'auth', layout: 'default' })
useHead({ title: useAdminTitle('好友統計') })

const { showToast } = useAdminToast()
// `G-109`：產生報告＝`POST /api/tag/report`（tags.write）；擬文案＝`POST /api/marketing-calendar/draft`（broadcast.write）
const { apiFetch, workspaceId, can } = useWorkspace()

/**
 * `C-352`①：提案與「發推播」帶過去的都是**一顆標籤**（依標籤篩選）——方案發不了就在這裡先講、按鈕鎖住。
 * 句子跟推播頁鎖住時同一句；讀不到方案＝不鎖（推播頁跟送出端照擋）。
 */
const { tier: broadcastTier, load: loadBroadcastTier } = useBroadcastTier()
const broadcastLock = computed(() => broadcastEntryLockText(broadcastTier.value, 'tags'))
const canDraft = computed(() => can('broadcast.write') && !broadcastLock.value)

const report = ref<TagReportDoc | null>(null)
const allowRegen = ref(false)
const remainingMs = ref(0)
const loading = ref(true)
const loadError = ref('')
const generating = ref(false)

/** 這一版的報告內容；舊版存檔（`legacy`）是 null，畫面請他重新產生 */
const p = computed<FriendReportPayload | null>(() => report.value?.payload ?? null)

const generatedText = computed(() => {
  const r = report.value
  if (!r) return ''
  const d = new Date(r.generatedAtMs)
  const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return r.generatedBy ? `${when} 由 ${r.generatedBy} 產生` : `${when} 產生`
})

const cooldownTip = computed(() => (allowRegen.value ? '' : cooldownText(remainingMs.value)))

/** 掃描撞上限一定要講出來——⛔ 不可以讓人把截斷後的數字當精確值（三態鐵律） */
const integrityLines = computed(() => {
  const i = p.value?.integrity
  if (!i) return []
  const out: string[] = []
  if (i.failed.length) out.push(`有幾塊資料這次查不到（${i.failed.join('、')}），相關的數字不完整。`)
  if (i.userTagsTruncated) out.push(`貼標紀錄掃到上限（已掃 ${fmt(i.scannedUserTags)} 筆），標籤人數與來源只算了這一段。`)
  if (i.newMembersTruncated) out.push('新進名單掃到上限，「新進名單從哪裡來」只算了掃到的那些。')
  if (i.pendingTruncated) out.push('待審建議掃到上限，「等你決定的 AI 建議」是掃到的那些裡的數字，不是全部。')
  if (i.suggestionLogsTruncated) out.push('AI 貼標底帳掃到上限，「AI 判斷準不準」只算了掃到的那一段。')
  return out
})

// ── 三格總覽 ──────────────────────────────────────────────────────
const tiles = computed(() => {
  const o = p.value?.overview
  if (!o) return []
  const line = o.line
  const lineDown = line.status === 'no_token' ? '還沒接上 LINE' : line.status === 'failed' ? '這次讀不到 LINE 的數字' : ''
  // LINE 隔天才算好前一天：最後一天還沒好時講算到哪一天
  const asOf = line.status === 'partial' && line.asOfDate ? `（算到 ${md(line.asOfDate)}）` : ''
  return [
    {
      key: 'followers',
      label: 'LINE 好友',
      tip: '跟 LINE 官方後台的「好友人數」同一個數字：加過好友的累計人次，封鎖了也不會減。',
      value: line.followers === null ? '—' : fmt(line.followers),
      unit: '',
      foot: lineDown || (line.followersDelta === null ? '' : `30 天新加 ${fmt(line.followersDelta)} 位${asOf}`),
    },
    {
      key: 'blocks',
      label: '封鎖',
      tip: '封鎖了官方帳號的人數（LINE 官方的數字）。推播發得越密，這個數字通常長得越快。',
      value: line.blocks === null ? '—' : fmt(line.blocks),
      unit: '',
      foot: lineDown || (line.blocksDelta === null ? '' : `30 天多了 ${fmt(line.blocksDelta)} 位${asOf}`),
    },
    {
      key: 'active',
      label: '30 天內有互動',
      tip: '最近 30 天傳過訊息、按過選單或按鈕的人。',
      value: o.activeUsers === null ? '—' : fmt(o.activeUsers),
      unit: o.activeUsers === null ? '' : '位',
      foot: o.activeUsers === null ? '這次查不到' : (o.listSize === null ? '' : `名單共 ${fmt(o.listSize)} 位`),
    },
  ]
})

// ── 行銷提案 ──────────────────────────────────────────────────────
const proposals = computed<Proposal[]>(() => (p.value ? buildProposals(p.value) : []))
const proposalsEmpty = computed(() => (p.value ? proposalsEmptyText(p.value) : ''))
const outcomeText = computed(() => (p.value ? proposalOutcomeText(p.value) : null))

/** 第 2 則以後收合，按了才展開（第 1 則永遠展開） */
const openedProposals = ref<string[]>([])
function isOpen(tagId: string, index: number): boolean {
  return index === 0 || openedProposals.value.includes(tagId)
}
function toggleProposal(tagId: string) {
  openedProposals.value = openedProposals.value.includes(tagId)
    ? openedProposals.value.filter(x => x !== tagId)
    : [...openedProposals.value, tagId]
}

interface DraftState {
  loading: boolean
  handoff: BroadcastDraftHandoff | null
  index: number
  error: string
}
/** 每則提案擬好的文案（按了才擬，⛔ 產生報告時不擬——大部分提案不會被採用，先擬是白花錢） */
const drafts = reactive<Record<string, DraftState>>({})
watch(proposals, (list) => {
  for (const prop of list) drafts[prop.tagId] ??= { loading: false, handoff: null, index: 0, error: '' }
}, { immediate: true })

/** 模板用：拿不到的時候給一份空的（⛔ 不在 render 裡寫入 reactive） */
const EMPTY_DRAFT: DraftState = { loading: false, handoff: null, index: 0, error: '' }
function draftOf(tagId: string): DraftState {
  return drafts[tagId] ?? EMPTY_DRAFT
}
function variantsOf(tagId: string): string[] {
  return drafts[tagId]?.handoff?.variants ?? []
}
function stepVariant(tagId: string, delta: number) {
  const s = drafts[tagId]
  if (!s?.handoff) return
  s.index = Math.min(Math.max(0, s.index + delta), s.handoff.variants.length - 1)
}

async function draftCopy(prop: Proposal) {
  const s = drafts[prop.tagId]
  if (!s || s.loading) return
  s.loading = true
  s.error = ''
  try {
    const r = await apiFetch<BroadcastDraftHandoff & { dropped?: unknown }>('/api/marketing-calendar/draft', {
      method: 'POST',
      body: { tagId: prop.tagId, festivalId: prop.festival?.id ?? '' },
    })
    const { dropped: _dropped, ...handoff } = r
    s.handoff = handoff
    s.index = 0
  }
  catch (e: unknown) {
    // ⛔ 擬不出來要講為什麼（沒有輪廓、三版都沒過檢查、方案鎖…），後端給的那句照講
    s.error = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || '這次擬不出來，再按一次試試。'
  }
  finally {
    s.loading = false
  }
}

/**
 * 帶著挑好的那一版去推播頁開一張**還沒存檔**的草稿（`C-225` 同一條路，`from=proposal`）。
 * ⛔ 不在這裡建任何東西：發不發、什麼時候發，由人在推播頁決定（`C-221` 紅線）。
 */
function openDraft(prop: Proposal) {
  const s = drafts[prop.tagId]
  if (!s?.handoff) return
  const picked = s.handoff.variants[s.index]
  if (!picked) return
  // 挑的那一版放第一個：推播頁預設帶第一版，其餘幾版擺在編輯器上面讓他換
  const variants = [picked, ...s.handoff.variants.filter((_, i) => i !== s.index)]
  try {
    sessionStorage.setItem(BROADCAST_DRAFT_HANDOFF_KEY, JSON.stringify({ ...s.handoff, variants, ts: Date.now() }))
  }
  catch {
    // ⛔ 擋了暫存就講出來：安靜跳過去會開一張空白推播
    showToast('這個瀏覽器擋了暫存，文案帶不過去。可以先把這一版複製起來，到推播頁貼上。', 'error')
    return
  }
  void navigateTo(`/admin/${workspaceId.value}/broadcasts?from=proposal`)
}

// ── 也要留意 ──────────────────────────────────────────────────────
const watchItems = computed<WatchItem[]>(() => (p.value ? buildWatchItems(p.value) : []))

function runWatchAction(w: WatchItem) {
  if (w.action.type === 'users') return viewUsers(w.action.tagId)
  document.getElementById('fs-pushes')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── 客人最近在想什麼 ──────────────────────────────────────────────
/** 照標籤的分類分兩組：興趣偏好（想買的訊號）一組、其他（出貨、退換貨…）一組。分類是店家自己設的 */
const intentGroups = computed(() => {
  const list = p.value?.intents ?? []
  const groups: Array<{ key: 'interest' | 'other', label: string, rows: IntentTagStat[] }> = [
    { key: 'interest', label: '興趣偏好', rows: list.filter(t => t.category === 'interest') },
    { key: 'other', label: '消費行為・好友狀態・其他', rows: list.filter(t => t.category !== 'interest') },
  ]
  return groups.filter(g => g.rows.length)
})
const maxRecent = computed(() => Math.max(1, ...(p.value?.intents ?? []).map(t => t.recent)))

function barWidth(n: number, max: number): string {
  if (!n || !max) return '0%'
  // 有數字的至少給一點寬度，不然 1 位跟 0 位看起來一樣
  return `${Math.max(2, Math.round((n / max) * 100))}%`
}

// ── 推播 ──────────────────────────────────────────────────────────
const baseline = computed(() => {
  const pushes = p.value?.pushes ?? []
  const line = p.value?.overview.line
  if (!line || line.status === 'no_token' || line.status === 'failed') return null
  return blockBaseline(line.blocksByDay, new Set(pushes.map(x => lineDayOfMs(x.completedMs))))
})

const pushTable = computed(() => {
  const pushes = p.value?.pushes ?? []
  const line = p.value?.overview.line
  const lineOk = !!line && line.status !== 'no_token' && line.status !== 'failed'
  const maxRate = Math.max(0, ...pushes.filter(r => r.clicked !== null && r.sent > 0).map(r => r.clicked! / r.sent))
  const seenDays = new Set<string>()
  return pushes.map((r) => {
    const day = lineDayOfMs(r.completedMs)
    const blocks = lineOk ? line!.blocksByDay[day] : undefined
    // 同一天發兩則：LINE 只給一天的合計，⛔ 不可以平分給兩則——第二列寫「同一天」
    const sameDay = seenDays.has(day)
    seenDays.add(day)
    const rate = r.clicked !== null && r.sent > 0 ? r.clicked / r.sent : null
    const b = baseline.value
    return {
      ...r,
      audienceText: r.audience.type === 'tags' ? r.audience.tagNames.join('、') : r.audience.type === 'all' ? '全部好友' : '指定名單',
      clickPct: rate === null ? '' : `${Math.round(rate * 100)}%`,
      clickBar: rate === null ? '0%' : barWidth(rate, maxRate),
      blockText: sameDay ? '同一天' : blocks === undefined ? '—' : fmt(blocks),
      blockWarn: !sameDay && blocks !== undefined && b !== null && b >= 1 && blocks >= b * BLOCK_SPIKE_RATIO && blocks >= BLOCK_SPIKE_MIN,
    }
  })
})

const pushNote = computed(() => {
  const line = p.value?.overview.line
  if (!line || line.status === 'no_token' || line.status === 'failed') return '這次讀不到 LINE 的封鎖數，「當天封鎖」先空著。'
  const head = baseline.value === null ? '' : `平常一天約 ${fmt(baseline.value)} 位封鎖。`
  return `${head}同一天發兩則的，LINE 只給得出那一天的合計。`
})

// ── 新進名單 ──────────────────────────────────────────────────────
const maxSource = computed(() => Math.max(1, ...(p.value?.newMembers.rows ?? []).map(s => s.users)))

// ── 標籤整理 ──────────────────────────────────────────────────────
const housekeepingOpen = ref(false)
function onHousekeepingToggle(e: Event) {
  housekeepingOpen.value = (e.target as HTMLDetailsElement).open
}

/** 摘要列只講要動手的件數；⛔ 沒有要處理的就直說，不要讓人點開才發現是空的 */
const housekeepingSummary = computed(() => {
  const h = p.value?.housekeeping
  if (!h) return ''
  const parts: string[] = []
  if (h.zeroMember.length) parts.push(`${h.zeroMember.length} 顆建了沒人用`)
  if (h.aiOnButNeverProduced.length) parts.push(`${h.aiOnButNeverProduced.length} 顆開著 AI 判斷卻沒判出人`)
  if (h.untaggedUsers) parts.push(`${fmt(h.untaggedUsers)} 位沒有任何標籤`)
  if (h.pendingUsers) parts.push(`${fmt(h.pendingUsers)} 位的建議等你決定`)
  return parts.length ? parts.join('・') : '沒有要處理的'
})

/**
 * ⛔ 只講「人看過的幾次裡同意幾次」，不並列「AI 提過幾次」：「提過」8/30 才開始記，
 *   早幾天提的建議很多是 8/30 之後才被決定，並列會變成「提過 77 次、人決定了 142 次」，讀起來像算錯。
 * ⛔ 沒有人決定過時講「還沒有」，不是 0%（0% 會被讀成 AI 全錯）。
 */
const accuracyText = computed(() => {
  const h = p.value?.housekeeping
  if (!h) return ''
  const s = h.suggestions
  const since = md(p.value!.integrity.suggestionLedgerSince)
  const auto = s.autoApplied ? `；另有 ${fmt(s.autoApplied)} 次是 AI 直接貼、沒經過人` : ''
  if (s.acceptanceRate === null) return `還沒有人決定過任何一筆建議${auto}`
  return `人看過的 ${fmt(s.decided)} 次裡同意 ${fmt(s.agreed)} 次（${Math.round(s.acceptanceRate)}%），${since} 起累積${auto}`
})

// ── 載入／產生 ────────────────────────────────────────────────────
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
 * 「發推播」——帶標籤過去、受眾自動選好（`D-28` 那條路，⛔ 只開一張還沒存檔的草稿）。
 * ⚠️ 刻意用網址參數不用 `sessionStorage`：只有一個標籤 id，換來「重新整理還在、連結貼得出去」。
 */
function broadcastTo(tagId: string) {
  if (broadcastLock.value) return showToast(broadcastLock.value, 'error')
  void navigateTo(`/admin/${workspaceId.value}/broadcasts?from=friend-stats&tagId=${encodeURIComponent(tagId)}`)
}

/** 看這群人＝好友頁照這顆標籤篩（好友頁吃 `?tagIds=`） */
function viewUsers(tagId: string) {
  void navigateTo(`/admin/${workspaceId.value}/users?tagIds=${encodeURIComponent(tagId)}`)
}

onMounted(() => {
  void load()
  // `C-352`①：只有按得到推播入口的人才需要知道方案能不能分眾（一次讀訂閱，不讀推播清單）
  if (can('broadcast.write')) void loadBroadcastTier()
})
</script>
