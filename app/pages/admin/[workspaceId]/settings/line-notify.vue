<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="LINE 通知"
        caption="客人要找真人、每天早上的摘要，會用 LINE 傳到下面這些人的手機。"
        :help-topics="['line-notify']"
      />
    </template>

    <template #editor-body>
      <div v-if="loadError" class="solo-editor-body ai-load-error">
        <p>讀不到這一頁的資料，下面顯示的不是實際狀況。</p>
        <el-button type="primary" plain @click="load">重試</el-button>
      </div>
      <div v-else-if="!data" class="solo-editor-body tags-loading">
        <div class="spinner" />
        <span>載入中…</span>
      </div>

      <!-- `ln-page`：寬螢幕封頂 1100px 置中（`D-107`，跟首頁「對話統計」一樣）——2000px 螢幕上名字跟開關、
           表單跟手機預覽隔了大半個畫面 -->
      <div v-else class="solo-editor-body admin-panel-stack ln-page">
        <!-- ── 誰會收到 ───────────────────────── -->
        <div class="message-card ln-card" data-tour="ln-who">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">誰會收到</span>
            </div>
            <span v-if="receivingCount" class="ln-card__meta">{{ receivingCount }} 位會收到</span>
          </div>
          <div class="card-section-stack">
            <!-- `D-106`：第一次進來只看到一排字跟開關、不知道從哪開始 → 一句話講怎麼用。
                 「同事登入會被問」只在真的有同事還沒加時才講（⛔ 不在每一列再講一次） -->
            <p class="ln-howto">
              每個人用<strong>自己的手機</strong>加進來，綁好就會收到。<template v-if="hasUnboundOthers">還沒加進來的同事，下次登入後台會被問一次<template v-if="data.canManage">；想快一點，按他那一列的「<strong>傳連結給他</strong>」</template>。</template>
            </p>
            <!-- 登入的帳號不是這個官方帳號的成員（組織管理員、超管）：名單上沒有自己，⛔ 不可以讓他自己猜為什麼 -->
            <p v-if="!data.selfIsMember" class="ln-banner is-info">
              <strong>名單上沒有你</strong>：你現在登入的帳號不是這個官方帳號的成員，沒辦法把手機加進來。要收通知，請擁有者到「設定 → 成員管理」邀請你的 Email，登入後再回來這裡加。
            </p>
            <p v-if="!data.lineConnected" class="ln-banner">
              還沒接上 LINE，通知傳不出去。先到「設定 → 組織與 LINE」接好，再回來把手機加進來。
            </p>
            <p v-else-if="!receivingCount && !adding" class="ln-banner">
              現在沒有人會收到。客人要找真人時，不會有人知道。
            </p>
            <p v-else-if="undeliverableCount" class="ln-banner">
              有 {{ undeliverableCount }} 位收不到通知，原因和怎麼辦寫在他那一列的「狀態」。
            </p>

            <!-- 跟「成員管理」同一種表格（老闆對一致性很敏感）：寬螢幕上名字跟開關不再隔半個畫面沒有欄可以對 -->
            <el-table :data="tableRows" size="small" row-key="key" :row-class-name="rowClass" class="ln-table">
              <el-table-column label="成員" min-width="220">
                <template #default="{ row }">
                  <template v-if="row.kind === 'member'">
                    <span class="ln-table__email">{{ row.m.isSelf ? `你（${row.m.email || '我'}）` : (row.m.email || '（沒有 Email）') }}</span>
                    <el-tag :type="roleTagType(row.m.role)" :effect="roleTagEffect(row.m.role)" size="small" class="ln-table__role">
                      {{ roleLabel(row.m.role) }}
                    </el-tag>
                  </template>
                  <span v-else class="ln-table__muted">（不是成員）</span>
                </template>
              </el-table-column>
              <el-table-column label="LINE" min-width="150">
                <template #default="{ row }">
                  <span v-if="row.line" class="ln-line">
                    <img v-if="row.line.pictureUrl" :src="row.line.pictureUrl" class="ln-avatar" alt="">
                    <span v-else class="ln-avatar ln-avatar--initial">{{ initialOf(row.line.displayName) }}</span>
                    <span class="ln-line__name">{{ row.line.displayName }}</span>
                  </span>
                  <span v-else class="ln-table__muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="狀態" min-width="260">
                <template #default="{ row }">
                  <div class="ln-status" :class="row.status.cls">
                    {{ row.status.text }}
                    <span v-if="row.status.sub" class="ln-status__sub">{{ row.status.sub }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="收通知" width="160" align="right">
                <template #default="{ row }">
                  <template v-if="row.kind === 'member'">
                    <!-- 綁好的：開關（自己那一列、或管理員）。觀察者不收通知（`C-271`⑬）：舊資料裡已經在收的只給關、不給開 -->
                    <el-switch
                      v-if="row.m.line && (row.m.isSelf || data.canManage) && (row.m.role !== 'viewer' || row.m.receiving)"
                      :model-value="row.m.receiving"
                      :loading="savingUid === row.m.uid"
                      @change="setReceiving(row.m, $event === true)"
                    />
                    <el-button
                      v-else-if="!row.m.line && row.m.isSelf && !adding"
                      type="primary"
                      size="small"
                      data-tour="ln-add"
                      :disabled="!data.lineConnected"
                      @click="startAdd"
                    >
                      把我的手機加進來
                    </el-button>
                    <el-button
                      v-else-if="!row.m.line && !row.m.isSelf && data.canManage"
                      size="small"
                      plain
                      :disabled="!data.lineConnected"
                      :loading="linkLoadingUid === row.m.uid"
                      data-tour="ln-send-link"
                      @click="sendLink(row.m)"
                    >
                      傳連結給他
                    </el-button>
                  </template>
                  <!-- 舊資料：名單上、卻不是任何一位成員的 LINE 帳號（名單現在只收綁好的成員，只能拿掉） -->
                  <el-button v-else-if="data.canManage" size="small" plain @click="removeOther(row.o.lineUserId)">拿掉</el-button>
                </template>
              </el-table-column>
              <!-- 不常用、會讓人緊張的動作（解除綁定）收進「⋯」：原本紅字擠在開關旁邊，分不清哪個才是「不收」 -->
              <el-table-column width="52" align="center">
                <template #default="{ row }">
                  <el-dropdown v-if="menuOf(row).length" trigger="click" placement="bottom-end" @command="onMenu(row, $event)">
                    <el-button text size="small" :icon="MoreFilled" aria-label="更多" class="ln-table__more" />
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item
                          v-for="it in menuOf(row)"
                          :key="it.cmd"
                          :command="it.cmd"
                          :class="{ 'ln-menu-danger': it.danger }"
                        >
                          {{ it.label }}
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </template>
              </el-table-column>
            </el-table>

            <AdminLineNotifySelfAdd v-if="adding" @done="onAdded" @cancel="adding = false" />

            <div v-if="justAdded" class="ln-done" :class="{ 'is-warn': !justAdded.receiving }">
              <div>
                <h4 class="ln-done__title">
                  {{ justAdded.receiving ? `好了，你的 LINE「${justAdded.name}」加進來了` : `綁好了，但這支手機還沒收通知` }}
                </h4>
                <!-- ⛔ 沒進名單的原因要照實講（`C-271`⑨）：原本一律說「名單滿了」，寫入失敗時把人帶去做沒用的事 -->
                <p class="ln-done__text">
                  <template v-if="justAdded.receiving">
                    你的手機剛收到一則確認，寫著之後會收到什麼。{{ firstDigestPhrase }} 會收到第一則摘要。
                  </template>
                  <template v-else-if="justAdded.full">
                    名單滿了（最多 10 位）。請管理員關掉一位，再把你那一列的「收通知」打開。
                  </template>
                  <template v-else>
                    剛剛沒存進通知名單。把你那一列的「收通知」打開就好。
                  </template>
                </p>
              </div>
              <el-button size="small" plain @click="justAdded = null">知道了</el-button>
            </div>

            <p v-if="!data.deliveryKnown" class="ln-card__note">
              送到了沒的紀錄這次讀不到，「狀態」只講在不在名單上（不代表都送到了）。
            </p>
          </div>
        </div>

        <!-- ── 什麼時候通知（管理員；客服看不到這一塊，無權限一律隱藏） ── -->
        <div v-if="data.canManage" class="message-card ln-card" data-tour="ln-when">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">什麼時候通知</span>
            </div>
            <span class="ln-card__meta">上面每個人收到的都一樣</span>
          </div>
          <div class="card-section-stack">
            <div class="ln-when">
              <!-- `D-107`：三段各一塊，跟右邊手機的三個分頁一一對應；點哪一段、改哪一段，手機就換到那一則
                   （原本改了摘要的設定，手機還停在「客人找真人」，要自己去點分頁） -->
              <div class="ln-when__form">
                <section
                  class="admin-field-group ln-grp"
                  :class="{ 'is-on': groupOn('handoff') }"
                  data-grp="handoff"
                  @click="followGroup('handoff')"
                  @focusin="followGroup('handoff')"
                >
                  <div class="ln-grp__head">
                    <AdminFieldLabel text="客人要找真人時" tag="span" tight />
                    <span v-if="groupOn('handoff')" class="ln-grp__peek">右邊就是這一則</span>
                  </div>
                  <!-- `D-106`：沒選的那個選項不秀數字框（原本兩格都在、一格反灰，看起來像兩個都要填）
                       `D-107`：每個選項下面一行講「適合誰」，沒選的那個也看得到，才比得出來 -->
                  <el-radio-group v-model="timing.mode" class="ln-when__modes" @change="onModeChange">
                    <div class="ln-when__mode">
                      <el-radio value="always">{{ timing.mode === 'always' ? '馬上通知，' : '馬上通知' }}</el-radio>
                      <template v-if="timing.mode === 'always'">
                        <!-- ⚠️ 上限要跟後端 normalize 一樣是 1440（`C-271`③）：寫小了，Element 一載入就把
                             超過的舊設定夾小並寫回，存任何一格時一起存進去＝提醒時間被默默改短 -->
                        <el-input-number
                          v-model="slaAlways"
                          :min="0"
                          :max="SLA_MAX"
                          :step="5"
                          size="small"
                          controls-position="right"
                          class="ln-when__num"
                          @change="saveTiming"
                        />
                        <span class="ln-when__tail">分鐘還沒人回再提醒一次</span>
                      </template>
                    </div>
                    <!-- 「填 0」只跟有數字框的那一行有關：選了「馬上通知」才講 -->
                    <p class="ln-when__hint">
                      不常開後台的人用這個：客人一說要找真人，手機就響。{{ timing.mode === 'always' ? '填 0 就不再提醒。' : '' }}
                    </p>
                    <div class="ln-when__mode">
                      <el-radio value="missed_only">{{ timing.mode === 'missed_only' ? '先不吵，等' : '先不吵，等沒人接手才通知' }}</el-radio>
                      <template v-if="timing.mode === 'missed_only'">
                        <el-input-number
                          v-model="slaMissed"
                          :min="5"
                          :max="SLA_MAX"
                          :step="5"
                          size="small"
                          controls-position="right"
                          class="ln-when__num"
                          @change="saveTiming"
                        />
                        <span class="ln-when__tail">分鐘沒人接手才通知</span>
                      </template>
                    </div>
                    <p class="ln-when__hint">客服整天開著後台的團隊用這個，省官方帳號的訊息額度。</p>
                  </el-radio-group>
                </section>

                <section
                  class="admin-field-group ln-grp"
                  :class="{ 'is-on': groupOn('digest') }"
                  data-grp="digest"
                  @click="followGroup('digest')"
                  @focusin="followGroup('digest')"
                >
                  <div class="ln-grp__head">
                    <AdminFieldLabel text="每天早上的摘要" tag="span" tight />
                    <span v-if="groupOn('digest')" class="ln-grp__peek">右邊就是這一則</span>
                  </div>
                  <div class="ln-when__inline">
                    <span class="ln-when__tail">每天</span>
                    <el-select v-model="timing.digestHour" size="small" class="ai-hour-select" aria-label="摘要時間" @change="saveTiming">
                      <el-option v-for="h in 24" :key="h - 1" :value="h - 1" :label="`${String(h - 1).padStart(2, '0')}:00`" />
                    </el-select>
                    <span class="ln-when__tail">傳：昨天的成績、今天要處理的事</span>
                  </div>
                  <p v-if="data.serviceHours.enabled && data.serviceHours.weekendOff" class="ai-section-hint">
                    週末不傳（「服務時間」設了週六日休息）
                  </p>
                  <!-- `D-107`：兩個勾選是附在摘要裡的一段，⛔ 不是另外傳一則（08-06 拍板「一則錢講完全部」），
                       原本看起來像兩個獨立的通知。說明照送出端實際內容寫：festivalReminderText 三個里程碑、
                       formatWeeklyInsightLines 全零就整段不出現 -->
                  <p class="ln-grp__sub">摘要裡順便附（不另外傳一則）</p>
                  <el-checkbox v-model="timing.festivalTips" @change="saveTiming">節日前的行銷提醒</el-checkbox>
                  <p class="ln-when__hint">節日前 7／3／1 天各講一次：先備素材、再排推播、最後確認出貨與客服。</p>
                  <el-checkbox v-model="timing.weeklyInsights" @change="saveTiming">週一的「本週顧客觀察」</el-checkbox>
                  <p class="ln-when__hint">這週被貼最多的標籤、兩週沒再出現的客人有幾位；那週沒東西講就不附。</p>
                </section>

                <section
                  class="admin-field-group ln-grp"
                  :class="{ 'is-on': groupOn('crit') }"
                  data-grp="crit"
                  @click="followGroup('crit')"
                  @focusin="followGroup('crit')"
                >
                  <div class="ln-grp__head">
                    <AdminFieldLabel text="出大事時" tag="span" tight />
                    <span v-if="groupOn('crit')" class="ln-grp__peek">右邊就是這一則</span>
                  </div>
                  <el-checkbox v-model="timing.criticalAlertPush" @change="saveTiming">不等摘要，馬上通知</el-checkbox>
                  <p class="ln-when__hint">機器人收不到客人訊息、回覆額度用完這類正在影響客人的事。只在 9:00–21:00 傳。</p>
                </section>
              </div>

              <div class="ln-phone" data-tour="ln-preview" aria-label="手機會收到的樣子">
                <div class="ln-phone__top"><span class="ln-phone__oa">LINE</span>手機會收到這樣的訊息</div>
                <el-radio-group v-model="previewTab" size="small" class="ln-phone__tabs">
                  <el-radio-button value="handoff">客人找真人</el-radio-button>
                  <el-radio-button value="digest">早上的摘要</el-radio-button>
                  <el-radio-button value="crit">出大事</el-radio-button>
                </el-radio-group>
                <div class="ln-phone__screen">
                  <template v-for="(b, i) in previewBubbles" :key="i">
                    <span v-if="b.when" class="ln-phone__when">{{ b.when }}</span>
                    <div class="ln-phone__bubble" :class="{ 'is-me': b.me }">{{ b.text }}</div>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 「傳連結給他」（`D-106`）：原本按了只默默複製到剪貼簿，按的人不知道發生什麼事、下一步是什麼 -->
      <el-dialog v-model="linkDialog.open" :title="`把連結傳給 ${linkDialog.email || '對方'}`" width="min(460px, 92vw)" append-to-body>
        <ol class="ln-link__steps">
          <template v-if="linkDialog.url">
            <li>複製下面的連結，用 LINE（或任何方式）傳給他。</li>
            <li>他用手機點開，訊息已經打好，按送出。</li>
          </template>
          <!-- 拿不到官方帳號 ID 就做不出「訊息已打好」的連結：退回傳那一句 -->
          <template v-else>
            <li>複製下面這一句，用 LINE 傳給他。</li>
            <li>他在 LINE 打開官方帳號的聊天室，把這一句傳出去。</li>
          </template>
          <li v-if="data?.full">名單已經滿了（最多 10 位）：他綁好之後，要先關掉一位才收得到。</li>
          <li v-else>他送出之後，這一列會自己變成「會收到」。</li>
        </ol>
        <div class="ln-link__box">
          <code class="ln-link__text">{{ linkDialog.url || linkDialog.message }}</code>
          <el-button type="primary" size="small" @click="copyLink">{{ linkDialog.copied ? '已複製' : '複製' }}</el-button>
        </div>
        <p class="ln-link__note">{{ hhmm(linkDialog.expiresAt) }} 前有效；過期了再按一次「傳連結給他」就好。</p>
        <template #footer>
          <el-button @click="linkDialog.open = false">關閉</el-button>
        </template>
      </el-dialog>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
/**
 * 「設定 → LINE 通知」（`D-103`／`C-270`，2026-09-27 老闆拍板，照示意頁 artifact `DCNtvHLkws7NRiMmDXXqeZ` 做）。
 *
 * 一頁回答三件事：誰會收到（每位成員一列：綁了沒、收不收、送到了沒）、什麼時候收、手機上長什麼樣。
 * - 綁好＝加進名單；掃 QR 就加進來、當場知道成功（⛔ 不再有「我完成了」、不用再去別頁勾）
 * - 送不到的那一列變黃、寫原因（封鎖／被 LINE 退回）
 * - 名單只收綁好 LINE 的成員（第 2 題）；客服可以加／退自己（第 3 題）
 * - 右邊手機的內容跟真正送出的是**同一支函式**（`shared/line-notify-messages.ts`、`shared/daily-digest-message.ts`）
 */
import { ElMessageBox } from 'element-plus'
import { MoreFilled } from '@element-plus/icons-vue'
import {
  buildCriticalAlertText,
  buildHandoffNotifyText,
  buildNotifyConfirmText,
  nextDigestPhrase,
} from '~~/shared/line-notify-messages'
import { buildDigestLines, taipeiDateLabel } from '~~/shared/daily-digest-message'
import { taipeiDateKey } from '~~/shared/taipei-day'
import { addDays, daysBetween } from '~~/shared/time'
import { TAIWAN_FESTIVALS, festivalReminderText, type TaiwanFestival } from '~~/shared/taiwan-festivals'
import { formatWeeklyInsightLines } from '~~/shared/weekly-insight-lines'

definePageMeta({ middleware: ['auth', 'workspace-notify'], layout: 'default' })
useHead({ title: useAdminTitle('LINE 通知') })

type RecipientState =
  | { state: 'blocked', since: number, via: 'unfollow' | 'push' }
  | { state: 'failing', at: number, reason: string }
  /** 一時的失敗（LINE 5xx、送太快、斷線）：講一句「下一則會再試」，⛔ 不當成收不到（`C-271`⑦） */
  | { state: 'glitch', at: number, reason: string }
  | { state: 'ok', at: number, kind: 'notify' | 'confirm' }
  | { state: 'never' }

interface Row {
  uid: string
  email: string
  role: string
  isSelf: boolean
  line: { userId: string, displayName: string, pictureUrl: string } | null
  receiving: boolean
  pendingCodeExpiresAt: number | null
  /** 對方在首頁按過「先不用」：不會再被問 */
  inviteDismissed: boolean
  delivery: RecipientState | null
}
interface Other { lineUserId: string, displayName: string, delivery: RecipientState }
interface Status { text: string, sub?: string, cls: string }
/** 表格的一列：成員，或名單上對不上任何成員的舊資料 */
type TableRow =
  | { key: string, kind: 'member', m: Row, line: Row['line'], status: Status }
  | { key: string, kind: 'other', o: Other, line: { displayName: string, pictureUrl: string }, status: Status }
interface Timing {
  mode: 'always' | 'missed_only'
  slaRemindMinutes: number
  digestHour: number
  festivalTips: boolean
  weeklyInsights: boolean
  criticalAlertPush: boolean
}
interface PageData {
  canManage: boolean
  selfUid: string
  selfIsMember: boolean
  lineConnected: boolean
  full: boolean
  rows: Row[]
  others: Other[]
  deliveryKnown: boolean
  timing: Timing
  serviceHours: { enabled: boolean, start: string, end: string, weekendOff: boolean }
  /** 通知裡有沒有放連結（開關關著時預覽也不畫連結） */
  linksEnabled: boolean
}

const { apiFetch, workspaceId } = useWorkspace()
const { showToast } = useAdminToast()
const route = useRoute()
const router = useRouter()

const data = ref<PageData | null>(null)
const loadError = ref(false)
const adding = ref(false)
const justAdded = ref<{ name: string, receiving: boolean, full: boolean } | null>(null)
const flashUid = ref('')
const savingUid = ref('')
const linkLoadingUid = ref('')
const linkDialog = reactive({ open: false, email: '', url: '', message: '', expiresAt: 0, copied: false })
const previewTab = ref<PreviewTab>('handoff')

/** 分鐘數上限：跟後端 normalizeAiSettings 的夾值同一個數字（24 小時） */
const SLA_MAX = 1440
const timing = ref<Timing>({ mode: 'always', slaRemindMinutes: 30, digestHour: 9, festivalTips: true, weeklyInsights: true, criticalAlertPush: true })
/** 兩個模式各記一個分鐘數：切模式時不會把另一邊的數字帶過去（missed_only 最少 5 分鐘） */
const slaAlways = ref(30)
const slaMissed = ref(30)

const receivingCount = computed(() =>
  (data.value?.rows.filter(r => r.receiving).length ?? 0) + (data.value?.others.length ?? 0))

const ROLE_LABELS: Record<string, string> = { owner: '擁有者', admin: '管理員', agent: '客服', viewer: '觀察者' }
function roleLabel(role: string) { return ROLE_LABELS[role] ?? role }
// 角色標籤顏色跟「成員管理」「組織設定」同一套：擁有者實心、管理員黃、客服綠、觀察者灰
function roleTagType(role: string) {
  if (role === 'owner') return 'primary'
  if (role === 'admin') return 'warning'
  if (role === 'agent') return 'success'
  return 'info'
}
function roleTagEffect(role: string) { return role === 'owner' ? 'dark' : 'light' }
function initialOf(name: string) {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

function hhmm(ms: number) {
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
}
/** 「剛剛」「14:32」「9/25 10:02」 */
function when(ms: number) {
  const diff = Date.now() - ms
  if (diff < 2 * 60_000) return '剛剛'
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? hhmm(ms) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ms)}`
}

function monthDay(ms: number) {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 「狀態」那一格（`D-106`）：第一行只講結論——會收到／送不到／通知關著／還沒加進來；細節放第二行。
 * ⛔ 沒有送達紀錄 ≠ 沒傳過：紀錄從 `C-270` 才開始記，已經收了好幾週的人原本被寫成「還沒傳過通知」，
 *    看起來像壞了。沒有紀錄就只講「會收到」（他確實在名單上）。
 */
function statusOf(row: Row): Status {
  if (row.line && row.receiving) {
    const d = row.delivery
    if (!data.value?.deliveryKnown || !d) return { text: '會收到', cls: 'is-ok' }
    if (d.state === 'blocked') {
      const who = row.isSelf ? '這支手機' : '對方'
      // 推播被退回那一種，LINE 對「封鎖」與「還沒加好友」回同一句，分不出來就兩個都講（⛔ 不講死是封鎖）
      return d.via === 'unfollow'
        ? {
            text: '送不到',
            sub: `${who}封鎖了官方帳號（${monthDay(d.since)} 起）。請${row.isSelf ? '在 LINE 上' : '對方在 LINE '}解除封鎖，下一則就會送到。`,
            cls: 'is-warn',
          }
        : {
            text: '送不到',
            sub: `${who}封鎖了官方帳號，或還沒加好友（${monthDay(d.since)} 起）。請${row.isSelf ? '' : '對方'}加官方帳號好友（或解除封鎖），下一則就會送到。`,
            cls: 'is-warn',
          }
    }
    if (d.state === 'failing') return { text: '送不到', sub: `上次沒送到（${when(d.at)}）：${d.reason}`, cls: 'is-warn' }
    // 一時的：照講發生了什麼，但不變黃（下一則會再試，通常就過了）
    if (d.state === 'glitch') return { text: '會收到', sub: `上次沒送到（${when(d.at)}，${d.reason}），下一則會再試`, cls: 'is-ok' }
    if (d.state === 'ok') {
      const t = when(d.at)
      const sub = d.kind === 'confirm'
        ? (t === '剛剛' ? '剛剛送達確認訊息' : `${t} 送達確認訊息`)
        : `上次送達 ${t}`
      return { text: '會收到', sub, cls: 'is-ok' }
    }
    return { text: '會收到', cls: 'is-ok' }
  }
  if (row.line) return { text: '通知關著', cls: 'is-off' }
  if (row.pendingCodeExpiresAt) return { text: '還沒加進來', sub: `等對方點連結（${hhmm(row.pendingCodeExpiresAt)} 前有效）`, cls: 'is-off' }
  // 「下次登入會被問」寫在表格上面那一句；按過「先不用」的就不會再被問，⛔ 那一句對他不成立要另外講
  if (!row.isSelf && row.inviteDismissed) return { text: '還沒加進來', sub: '對方在首頁按了「先不用」，不會再被問', cls: 'is-off' }
  return { text: '還沒加進來', cls: 'is-off' }
}

function isUndeliverable(d: RecipientState | null) {
  return d?.state === 'blocked' || d?.state === 'failing'
}

const tableRows = computed<TableRow[]>(() => {
  if (!data.value) return []
  const members: TableRow[] = data.value.rows.map(m => ({ key: m.uid, kind: 'member', m, line: m.line, status: statusOf(m) }))
  const others: TableRow[] = data.value.others.map(o => ({
    key: `other:${o.lineUserId}`,
    kind: 'other',
    o,
    line: { displayName: o.displayName || `LINE 帳號 …${o.lineUserId.slice(-6)}`, pictureUrl: '' },
    status: {
      text: '不是成員的 LINE 帳號',
      sub: '名單只收綁好 LINE 的成員。這個帳號會一直收到客人的名字與訊息，確定是誰之前建議拿掉。',
      cls: 'is-warn',
    },
  }))
  return [...members, ...others]
})
function rowClass({ row }: { row: TableRow }) {
  return row.key === flashUid.value ? 'is-flash' : ''
}
/** 表格上面那一句的後半（同事登入會被問）只在真的有同事還沒加時講 */
const hasUnboundOthers = computed(() => Boolean(data.value?.rows.some(r => !r.isSelf && !r.line)))
/** 在名單上卻一直送不到的人數（一時的失敗不算） */
const undeliverableCount = computed(() => {
  if (!data.value?.deliveryKnown) return 0
  return data.value.rows.filter(r => r.receiving && isUndeliverable(r.delivery)).length
    + data.value.others.filter(o => isUndeliverable(o.delivery)).length
})

/** 「⋯」選單：不常用、或會讓人緊張的動作 */
function menuOf(row: TableRow): { cmd: 'rebind' | 'unbind', label: string, danger?: boolean }[] {
  if (row.kind !== 'member' || !row.m.line) return []
  if (row.m.isSelf) return adding.value ? [] : [{ cmd: 'rebind', label: '換一支手機' }]
  return data.value?.canManage ? [{ cmd: 'unbind', label: '解除綁定', danger: true }] : []
}
function onMenu(row: TableRow, cmd: string) {
  if (row.kind !== 'member') return
  if (cmd === 'rebind') startAdd()
  else if (cmd === 'unbind') void unbind(row.m)
}

// ── 載入 ──
let pollTimer: ReturnType<typeof setInterval> | null = null
async function load() {
  try {
    const res = await apiFetch<PageData>(`/api/admin/workspaces/${workspaceId.value}/line-notify`)
    data.value = res
    applyTiming(res.timing)
    loadError.value = false
  }
  catch (e: any) {
    loadError.value = true
    showToast(e?.data?.statusMessage || '載入失敗', 'error')
  }
}
function applyTiming(t: Timing) {
  timing.value = { ...t }
  if (t.mode === 'missed_only') slaMissed.value = t.slaRemindMinutes
  else slaAlways.value = t.slaRemindMinutes
}

/** 有人在等對方點「傳連結給他」的連結時，每 15 秒重抓一次（那一列會自己轉綠） */
function syncPoll() {
  const waiting = data.value?.rows.some(r => r.pendingCodeExpiresAt && r.pendingCodeExpiresAt > Date.now())
  if (waiting && !pollTimer) pollTimer = setInterval(load, 15_000)
  if (!waiting && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
watch(data, syncPoll)

// ── 自己加進來 ──
function startAdd() {
  justAdded.value = null
  adding.value = true
}
async function onAdded(s: { lineDisplayName: string, message: string }) {
  adding.value = false
  await load()
  const self = data.value?.rows.find(r => r.isSelf)
  justAdded.value = {
    name: s.lineDisplayName || self?.line?.displayName || '你',
    receiving: Boolean(self?.receiving),
    full: Boolean(data.value?.full),
  }
  // 手機預覽先秀他剛收到的那一來一回；點任何一個分頁就換回範例
  if (justAdded.value.receiving) confirmSent.value = s.message
  if (self) flash(self.uid)
}
/** 剛加好時他從手機送出的那一行；有值＝手機預覽秀「確認」那一來一回 */
const confirmSent = ref('')
watch(previewTab, () => { confirmSent.value = '' })
watch(justAdded, (v) => { if (!v) confirmSent.value = '' })

type PreviewTab = 'handoff' | 'digest' | 'crit'
/** 「什麼時候通知」那一段是不是右邊手機正在畫的那一則（剛加好、手機在秀確認時哪一段都不是） */
function groupOn(tab: PreviewTab) {
  return !confirmSent.value && previewTab.value === tab
}
/**
 * 點哪一段、改哪一段，手機就換到那一則（`D-107`）。
 * ⛔ 只換預覽、不收掉上面「好了，加進來了」那塊——那是另一件事（`justAdded` 另外管）。
 */
function followGroup(tab: PreviewTab) {
  confirmSent.value = ''
  previewTab.value = tab
}
function flash(uid: string) {
  flashUid.value = uid
  setTimeout(() => { if (flashUid.value === uid) flashUid.value = '' }, 1600)
}

// ── 那一列的動作 ──
async function setReceiving(row: Row, on: boolean) {
  savingUid.value = row.uid
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/line-notify/receiving`, { method: 'PUT', body: { uid: row.uid, on } })
    await load()
    showToast(on ? '打開了，之後會收到通知' : '關掉了，這支手機不會再收到通知', 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '存不進去', 'error')
  }
  finally {
    savingUid.value = ''
  }
}

async function sendLink(row: Row) {
  linkLoadingUid.value = row.uid
  try {
    const res = await apiFetch<{ message: string, bindUrl: string, expiresAt: number }>(
      `/api/admin/workspaces/${workspaceId.value}/members/${row.uid}/line-bind-code`,
      { method: 'POST' },
    )
    Object.assign(linkDialog, { open: true, email: row.email, url: res.bindUrl, message: res.message, expiresAt: res.expiresAt, copied: false })
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '產生連結失敗', 'error')
  }
  finally {
    linkLoadingUid.value = ''
  }
}
async function copyLink() {
  try {
    await navigator.clipboard.writeText(linkDialog.url || linkDialog.message)
    linkDialog.copied = true
  }
  catch {
    // 剪貼簿被瀏覽器擋掉（沒有 https、權限）：字就在框裡，⛔ 不要假裝複製成功
    showToast('複製不了，請選取上面框裡的字自己複製', 'warning')
  }
}

async function unbind(row: Row) {
  try {
    await ElMessageBox.confirm(
      '解除之後，這位成員的手機不會再收到任何 LINE 通知；要再收，得重新把手機加進來。',
      '解除 LINE 綁定',
      { confirmButtonText: '解除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger', type: 'warning' },
    )
  }
  catch { return }
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/members/${row.uid}/line-binding`, { method: 'DELETE' })
    showToast('已解除綁定', 'success')
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '解除失敗', 'error')
  }
}

async function removeOther(lineUserId: string) {
  try {
    await apiFetch(`/api/admin/workspaces/${workspaceId.value}/line-notify/receiving`, { method: 'PUT', body: { lineUserId, on: false } })
    showToast('拿掉了', 'success')
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '拿不掉', 'error')
  }
}

// ── 什麼時候通知（改了就存，跟每一列的開關一樣） ──
function onModeChange() {
  // 「只通知沒人接手的」下分鐘數是唯一的通知路徑，最少 5 分鐘（跟後端 normalize 同一條）
  if (timing.value.mode === 'missed_only' && slaMissed.value < 5) slaMissed.value = 30
  void saveTiming()
}
async function saveTiming() {
  const body = {
    ...timing.value,
    slaRemindMinutes: timing.value.mode === 'missed_only' ? slaMissed.value : slaAlways.value,
  }
  try {
    const res = await apiFetch<{ timing: Timing }>(`/api/admin/workspaces/${workspaceId.value}/line-notify/settings`, { method: 'PUT', body })
    applyTiming(res.timing)
    if (data.value) data.value.timing = res.timing
    showToast('已儲存', 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
    if (data.value) applyTiming(data.value.timing)
  }
}

// ── 手機預覽：跟送出端同一支函式，餵範例資料 ──
const currentTiming = computed(() => ({
  ...timing.value,
  slaRemindMinutes: timing.value.mode === 'missed_only' ? slaMissed.value : slaAlways.value,
}))
const firstDigestPhrase = computed(() =>
  nextDigestPhrase(Date.now(), currentTiming.value.digestHour, data.value?.serviceHours))
/** 開關關著（預設）就不放：預覽跟真正送出的一樣，退回「請至後台…」那一句 */
const sampleLink = computed(() => data.value?.linksEnabled ? `https://${useRequestURL().host}/c/7Kq2abX` : undefined)

/** 台北日期字串 → 「11/4」 */
function md(day: string) {
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`
}
/**
 * 摘要預覽的範例日：下一個「節日前 7 天、又是平日」的那一天——節日那一段才對得上真的句子。
 * 節日表用完了就用明天、不放節日那一段。`lastWeekText`＝那一週的週一往前一週（週報的統計區間）。
 */
function digestSample(nowMs: number): { day: string, festival: TaiwanFestival | null, lastWeekText: string } {
  const tomorrow = taipeiDateKey(new Date(nowMs + 86_400_000))
  const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay()
  let day = tomorrow
  let festival: TaiwanFestival | null = null
  for (const f of TAIWAN_FESTIVALS) {
    const d = addDays(f.date, -7)
    if (daysBetween(tomorrow, d) < 0 || weekday(d) === 0 || weekday(d) === 6) continue
    day = d
    festival = f
    break
  }
  const monday = addDays(day, -((weekday(day) + 6) % 7))
  return { day, festival, lastWeekText: `${md(addDays(monday, -7))}–${md(addDays(monday, -1))}` }
}

const previewBubbles = computed<{ when: string, text: string, me?: boolean }[]>(() => {
  const t = currentTiming.value
  const link = sampleLink.value
  // 剛加好：他剛收到的那一則確認（跟後端回覆同一支函式、同一份設定）
  if (confirmSent.value && data.value) {
    return [
      { when: '剛剛', text: confirmSent.value, me: true },
      { when: '', text: buildNotifyConfirmText({ result: 'added', cfg: t, serviceHours: data.value.serviceHours, nowMs: Date.now() }) },
    ]
  }
  if (previewTab.value === 'handoff') {
    const sample = {
      customerName: '阿明',
      customerMessage: '我訂的禮盒可以改寄公司嗎',
      reasonLabel: '客人要求真人',
      summary: '想把禮盒改寄到公司，問還來不來得及',
      link,
    }
    if (t.mode === 'missed_only') {
      return [{ when: `範例 · 轉真人後 ${t.slaRemindMinutes} 分鐘`, text: buildHandoffNotifyText({ ...sample, slaReminderMinutes: t.slaRemindMinutes }) }]
    }
    const out = [{ when: '範例 · 轉真人當下', text: buildHandoffNotifyText(sample) }]
    if (t.slaRemindMinutes > 0) {
      out.push({
        when: `${t.slaRemindMinutes} 分鐘後還沒人回`,
        text: buildHandoffNotifyText({ customerName: '阿明', customerMessage: '', reasonLabel: '', slaReminderMinutes: t.slaRemindMinutes, link }),
      })
    }
    return out
  }
  if (previewTab.value === 'digest') {
    const sample = digestSample(Date.now())
    const lines = buildDigestLines({
      dateLabel: taipeiDateLabel(sample.day),
      yesterday: { total: 18, selfServed: 14, humanServed: 3, unhandled: 1, unhandledNames: ['小美'], newFriends: 2 },
      waiting: { count: 2, offHoursCount: 0, samples: [{ name: '阿明', waitedMinutes: 25 }, { name: 'Lulu', waitedMinutes: 120 }], truncated: false, staleHumanCount: 0 },
      todo: { outdatedSources: 0, failedSources: 0, expiredCards: 0, suggestions: 3, tagSuggestUsers: 0, warnings: 0, topWarningLabel: '' },
      // `D-107`：用送出端同一支句型（原本手寫一句「再過 7 天就是中秋節…升溫。」，跟真的送出去的不一樣）
      festivalText: t.festivalTips && sample.festival
        ? festivalReminderText({ festival: sample.festival, milestone: 7, daysUntil: 7 })
        : '',
      weeklyLines: [],
      unknownNotes: [],
      link,
    }) ?? []
    const out = [{ when: `範例 · 每天 ${String(t.digestHour).padStart(2, '0')}:00`, text: lines.join('\n') }]
    // 週報只在週一、而且接在同一則的最後；範例日不一定是週一，所以另畫一顆講清楚（原本傳空陣列＝勾了也看不到）
    if (t.weeklyInsights) {
      const weekly = formatWeeklyInsightLines({
        rangeText: sample.lastWeekText,
        topTags: [{ name: '禮盒', count: 12 }, { name: '送禮', count: 8 }],
        inactiveAdds: { count: 0, name: '' },
        quietDown: 5,
        truncated: false,
      })
      if (weekly) out.push({ when: '週一的摘要，最後會多這一段', text: weekly.join('\n') })
    }
    return out
  }
  if (!t.criticalAlertPush)
    return [{ when: '這一類關著', text: '出大事時不會另外傳，隔天的摘要裡會寫。' }]
  return [{
    when: '範例 · 週四 14:20',
    text: buildCriticalAlertText({ count: 1, lines: ['・機器人收不到客人訊息'], more: 0, link }),
  }]
})

onMounted(async () => {
  await load()
  // 小幫手「現在沒有人會收到」帶路時帶 ?add=me：直接打開掃 QR 那一塊（參數用完即丟）
  if (route.query.add === 'me') {
    router.replace({ query: { ...route.query, add: undefined } })
    const self = data.value?.rows.find(r => r.isSelf)
    if (self && !self.line && data.value?.lineConnected) startAdd()
  }
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
