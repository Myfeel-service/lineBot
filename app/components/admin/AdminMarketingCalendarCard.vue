<!--
  行銷月曆卡（`D-85` / `C-224`）：未來 90 天有哪些檔期、每一檔該做什麼。
  2026-10-11 `D-121` 改版（示意頁 artifact `6boYgvH3V2h26Gy1Tzcx5e` v1）：
  快到的那一檔攤開、其他一行一檔；「還不認識你的店」只講一次；回顧收成最下面一行、改看 LINE 的人數。
  2026-10-19 `D-122`②（示意頁 v2 最下面那張）：店家可以「＋ 加自己的檔期」（週年慶、新品開賣），
  跟節日一樣攤開、擬推播、提醒、回顧；列上標「自己的」，攤開給「修改／刪除」。

  掛在後台首頁（＝客服對話統計頁）。⛔ 不加側欄項目——它不是一個功能，
  是「這一季要做什麼」的提醒，跟首頁的其他數字住在一起才看得到。

  ⛔ 三件事不可以妥協：
    ① **「為什麼是你」每一條都要有出處**，湊不出來就整段不出現——⛔ 不可以編一句「這檔通常表現不錯」。
    ② **不承諾成效**：不出現「可以多賣三成」這種我們算不出來的話。
    ③ **還不認識這家店時要講**，不要讓通用建議看起來像為他算的。
  ⛔ 同一句話只講一次（`D-121` 量過：改版前「通用」出現 7 次、同一段警語 3 次）。
-->
<template>
  <div class="message-card ar-section-card mkt-cal" data-tour="home-marketing-calendar">
    <div class="message-card-header">
      <div class="card-header-main">
        <span class="section-title">接下來的檔期</span>
        <span class="text-xs text-muted">{{ headline }}</span>
      </div>
      <el-button size="small" :loading="loading" @click="reload">重新載入</el-button>
    </div>

    <div class="card-section-stack">
      <!-- 查不到 ≠ 沒有檔期：載入失敗要講出來 -->
      <el-alert v-if="loadError" type="warning" :closable="false" show-icon>
        <template #title>這次讀不到你的檔期</template>
        {{ loadError }}
      </el-alert>

      <div v-else-if="loading && !loaded" class="mkt-cal__muted">正在整理接下來的檔期…</div>

      <template v-else>
        <div v-if="!entries.length" class="mkt-cal__muted">
          未來 90 天沒有重要節日，可以專心顧日常。
        </div>
        <!-- `D-122`②：自己的檔期讀不到。⛔ 不可以當成一檔都沒加（他會以為加了沒存到） -->
        <p v-if="ownEventsFailed" class="mkt-cal__muted">⚠️ 這次讀不到你加的檔期，按「重新載入」再試一次。</p>

        <template v-else>
          <!-- 還不認識這家店：整張卡只有通用建議，這件事只在這裡講一次 -->
          <el-alert v-if="!ready" type="info" :closable="false" show-icon class="mkt-cal__strip">
            <template #title>
              MiniMe 還不認識你的店，下面是通用建議。
              <!-- `G-102`：開帳頁只有管理員進得去，不給一條走進去才被擋的路，直接講要找誰 -->
              <el-link v-if="canEditProfile" type="primary" :underline="false" @click="goProfile">花 3 分鐘讓它認識 →</el-link>
              <template v-else>請管理員花 3 分鐘讓它認識。</template>
            </template>
          </el-alert>

          <!--
            `C-235`：認識了、但**主打商品那一格是空的**——節慶客製講不出商品、受眾也配不出來，
            ⛔ 不可以讓它安靜地不準。
          -->
          <el-alert v-else-if="!hasProducts" type="info" :closable="false" show-icon class="mkt-cal__strip">
            <template #title>
              補上「主打商品」，這幾檔會準很多。
              <el-link v-if="canEditProfile" type="primary" :underline="false" @click="goProfile">去補主打商品 →</el-link>
              <template v-else>請管理員補上。</template>
            </template>
          </el-alert>

          <div v-if="visibleEntries.length" class="mkt-cal__list">
            <article
              v-for="e in visibleEntries"
              :key="e.festivalId"
              :class="['mkt-cal__row', { 'is-open': openId === e.festivalId }]"
            >
              <button
                type="button"
                class="mkt-cal__row-head"
                :aria-expanded="openId === e.festivalId"
                @click="toggle(e.festivalId)"
              >
                <span class="mkt-cal__when">{{ shortDate(e.date) }}</span>
                <span class="mkt-cal__name">{{ e.name }}</span>
                <span class="mkt-cal__angle">
                  <!-- `D-122`②：店家自己加的那幾檔，攤開時也看得出是自己的 -->
                  <span v-if="e.own" class="mkt-cal__own">自己的</span>
                  <template v-if="openId !== e.festivalId">
                    <template v-if="plannedOf(e)">
                      <span :class="['mkt-cal__chip', chipTone(e)]">{{ chipText(e) }}</span>「{{ plannedOf(e)?.name }}」
                    </template>
                    <!-- 自己的檔期沒有通用切角：講它現在的狀態 -->
                    <template v-else-if="e.own">還沒有推播</template>
                    <template v-else>{{ e.generalAngle }}</template>
                  </template>
                </span>
                <span :class="['mkt-cal__days', { 'is-soon': e.soon }]">{{ daysText(e.inDays) }}</span>
                <span class="mkt-cal__chev" aria-hidden="true">{{ openId === e.festivalId ? '︿' : '﹀' }}</span>
              </button>

              <div v-if="openId === e.festivalId" class="mkt-cal__body">
                <p v-if="e.generalAngle" class="mkt-cal__angle-full">{{ e.generalAngle }}</p>

                <!-- ① 為什麼——每一條都帶出處。湊不出來就整段不出現 -->
                <template v-if="e.reasons.length">
                  <p class="mkt-cal__label">為什麼是你</p>
                  <ul class="mkt-cal__list-items mkt-cal__reasons">
                    <li v-for="(r, i) in e.reasons" :key="i">
                      {{ r.text }}<span class="mkt-cal__source">（{{ r.source }}）</span>
                    </li>
                  </ul>
                </template>

                <!-- ② 做什麼：只留跟時間有關的（`D-121`③），常常沒有 -->
                <template v-if="e.actions.length">
                  <p class="mkt-cal__label">做什麼</p>
                  <ul class="mkt-cal__list-items mkt-cal__actions">
                    <li v-for="(a, i) in e.actions" :key="i">{{ a }}</li>
                  </ul>
                </template>

                <!-- 已經為這一檔建好推播：直接講排在哪天，⛔ 不再給「為這一檔擬推播」（會擬出第二份） -->
                <p v-if="plannedOf(e)" class="mkt-cal__planned">
                  <span :class="['mkt-cal__chip', chipTone(e)]">{{ chipText(e) }}</span>「{{ plannedOf(e)?.name }}」<template v-if="e.planned.length > 1">（這一檔共 {{ e.planned.length }} 則）</template>
                </p>

                <!--
                  ③ 按鈕。`G-102`／`G-109`：兩顆各照自己的端點擋（`draft`＝`broadcast.write`、`skip`＝`marketing.write`）。
                  `C-236`「這次不做」⛔ 不是刪除：`festivalId` 含年份，明年那一檔會自己回來。
                -->
                <div v-if="plannedOf(e) || can('broadcast.write') || can('marketing.write')" class="mkt-cal__cta">
                  <el-button v-if="plannedOf(e)" size="small" type="primary" plain @click="goViewBroadcast(plannedOf(e)?.id ?? '')">查看推播</el-button>
                  <el-button
                    v-else-if="can('broadcast.write')"
                    size="small"
                    type="primary"
                    plain
                    :loading="draftingId === e.festivalId"
                    :disabled="draftingId !== '' && draftingId !== e.festivalId"
                    @click="goBroadcast(e)"
                  >
                    {{ draftingId === e.festivalId ? '正在擬文案…' : '為這一檔擬推播' }}
                  </el-button>
                  <!--
                    `D-122`②：自己的檔期是他親手加的，給「修改／刪除」，⛔ 不給「這次不做」（那是給節日表用的，明年會回來）。
                    排好推播之後一樣改得了：延期是常有的事。
                  -->
                  <template v-if="e.own && can('marketing.write')">
                    <el-button size="small" text @click="openEditEvent(e)">修改</el-button>
                    <el-button size="small" text :loading="deletingId === e.festivalId" @click="deleteEvent(e)">刪除</el-button>
                  </template>
                  <el-button
                    v-else-if="!plannedOf(e) && !e.own && can('marketing.write')"
                    size="small"
                    text
                    :loading="skippingId === e.festivalId"
                    @click="skipEntry(e)"
                  >
                    這次不做
                  </el-button>
                </div>
              </div>
            </article>
          </div>

          <!--
            收起來的那幾檔（`C-236` 鐵律①）。
            ⛔ **一定要看得見、可以還原**：靜靜消失的話，他會以為系統漏掉那個節日。
          -->
          <div v-if="skippedEntries.length" class="mkt-cal__skipped">
            <!-- `G-102`：觀察者沒有「還原」可按，全收起來時不用那句「按下面的還原」 -->
            <p class="mkt-cal__skipped-text">
              {{ visibleEntries.length || !can('marketing.write') ? skippedNoticeText(skippedEntries) : allSkippedText(skippedEntries) }}
            </p>
            <div v-if="can('marketing.write')" class="mkt-cal__skipped-chips">
              <el-button
                v-for="s in skippedEntries"
                :key="s.festivalId"
                size="small"
                text
                type="primary"
                :loading="skippingId === s.festivalId"
                @click="restoreEntry(s)"
              >
                還原「{{ s.name }}」
              </el-button>
            </div>
          </div>
        </template>

        <!--
          `D-122`②：店家自己的檔期（週年慶、新品開賣）。加進來跟節日一樣：快到時攤開、可以擬推播、
          早上的 LINE 提醒、發完在下面那一行看得到成效。⛔ 不從推播名稱猜，只收他親手加的。
        -->
        <div v-if="can('marketing.write')" class="mkt-cal__add-own">
          <el-link type="primary" :underline="false" @click="openAddEvent">＋ 加自己的檔期</el-link>
        </div>

        <!--
          `C-55`② / `C-240` / `D-121`：上一檔做得怎麼樣，收在最下面一行。
          只算為節日發的推播、成效是 LINE 的人數（規則在 `shared/festival-outcome.ts`）。
          ⛔ 回看窗內一檔都沒有就整段不出現——不要留一個空殼。
        -->
        <div v-if="outcomeLines.length" class="mkt-cal__past">
          <span class="mkt-cal__past-label">{{ outcomeLabel }}</span>
          <div class="mkt-cal__past-lines">
            <p v-for="(l, i) in outcomeLines" :key="i">
              {{ l.before }}<template v-if="l.broadcast">「<button type="button" class="mkt-cal__link" @click="goViewBroadcast(l.broadcast.id)">{{ l.broadcast.name }}</button>」</template>{{ l.after }}
            </p>
            <p v-if="outcomeIntegrity.failed" class="mkt-cal__muted">⚠️ 這次讀不到推播紀錄，上面的回顧不完整。</p>
            <p v-else-if="outcomeIntegrity.truncated" class="mkt-cal__muted">⚠️ 推播太多，只算了掃到的那一段。</p>
          </div>
        </div>
      </template>
    </div>

    <AdminMarketingEventDialog
      v-model:visible="eventDialog.visible"
      :workspace-id="workspaceId"
      :mode="eventDialog.mode"
      :initial="eventDialog.initial"
      @saved="onEventSaved"
    />
  </div>
</template>

<script setup lang="ts">
import type { CalendarEntry, PlannedBroadcast } from '~~/shared/marketing-calendar'
import { pickPlanned, plannedStatusText } from '~~/shared/marketing-calendar'
import type { OutcomeLine } from '~~/shared/festival-outcome'
import {
  allSkippedText,
  skippedNoticeText,
  skippedToastText,
  splitBySkip,
  restoredText,
} from '~~/shared/marketing-skips'
import { BROADCAST_DRAFT_HANDOFF_KEY, type BroadcastDraftHandoff } from '~~/shared/broadcast-draft-handoff'
import { STORE_PROFILE_EDIT_CAPABILITIES } from '~~/shared/permissions'
import { eventDeleteConfirmText, eventSavedText, type MarketingEvent } from '~~/shared/marketing-events'
import { ElMessageBox } from 'element-plus'

const props = defineProps<{ workspaceId: string }>()

const { apiFetch } = useWorkspaceApiFetch(() => props.workspaceId)
// `G-102`／`G-109`：擬推播＝`marketing-calendar/draft` 的 `broadcast.write`；收起來／還原＝`skip` 的 `marketing.write`。
// 補輪廓要進得了開帳頁、也存得了輪廓：兩道門都在 `STORE_PROFILE_EDIT_CAPABILITIES`，跟就緒度那一項問同一份
const { can } = useWorkspace()
const canEditProfile = computed(() => STORE_PROFILE_EDIT_CAPABILITIES.every(c => can(c)))

const entries = ref<CalendarEntry[]>([])
const headline = ref('')
const ready = ref(false)
/**
 * 輪廓有沒有寫「主打商品」（`C-235`）。
 * ⚠️ 跟 `ready` 是兩件事：`ready` 只要答滿三題就成立，但主打商品是下游全部都靠的那一格。
 * ⛔ 預設 `true`：讀不到時**不要**跳出「快去補商品」——那是在還不知道的情況下指責他。
 */
const hasProducts = ref(true)

/** 上一檔的結果（`C-55`② / `D-121`）。空陣列＝回看窗內沒有過去的節日，整段不出現。 */
const outcomeLabel = ref('')
const outcomeLines = ref<OutcomeLine[]>([])
const outcomeIntegrity = ref<{ truncated: boolean, failed: boolean }>({ truncated: false, failed: false })

/**
 * `C-236`：他自己收起來的那幾檔。
 * ⛔ **在前端分堆、不在後端濾掉**：後端濾掉的話收起來的就還原不回來，那就變成靜靜消失了。
 */
const skippedIds = ref<string[]>([])
const skippingId = ref('')
const skipMap = computed<Record<string, number>>(() =>
  Object.fromEntries(skippedIds.value.map(id => [id, 1])))
const visibleEntries = computed(() => splitBySkip(entries.value, skipMap.value).visible)
const skippedEntries = computed(() => splitBySkip(entries.value, skipMap.value).skipped)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
/** `D-122`②：自己的檔期讀不到（⛔ 不是「一檔都沒加」） */
const ownEventsFailed = ref(false)

/**
 * 哪一檔攤開（`D-121`）。他還沒動過＝最近的那一檔；按過就照他的（可以全部收起來）。
 * ⚠️ 用 `undefined` 當「還沒動過」，⛔ 不要用 null——null 是「他把它收起來了」。
 */
const openChoice = ref<string | null | undefined>(undefined)
const openId = computed(() => openChoice.value === undefined
  ? (visibleEntries.value[0]?.festivalId ?? null)
  : openChoice.value)
function toggle(id: string) {
  openChoice.value = openId.value === id ? null : id
}

function plannedOf(e: CalendarEntry): PlannedBroadcast | null {
  return pickPlanned(e.planned ?? [])
}
function chipText(e: CalendarEntry) {
  const p = plannedOf(e)
  if (!p) return ''
  const t = plannedStatusText(p)
  return p.status === 'scheduled' || p.status === 'completed' ? `✓ ${t}` : t
}
function chipTone(e: CalendarEntry) {
  const status = plannedOf(e)?.status
  if (status === 'failed') return 'is-bad'
  if (status === 'draft') return 'is-draft'
  return 'is-ok'
}

async function reload() {
  loading.value = true
  loadError.value = ''
  try {
    const r = await apiFetch<{
      entries: CalendarEntry[]
      headline: string
      ready: boolean
      hasProducts: boolean
      outcomeLabel: string
      outcomeLines: OutcomeLine[]
      outcomeIntegrity: { truncated: boolean, failed: boolean }
      skippedFestivalIds: string[]
      ownEventsFailed?: boolean
    }>('/api/marketing-calendar')
    entries.value = (r.entries ?? []).map(e => ({ ...e, planned: Array.isArray(e.planned) ? e.planned : [] }))
    headline.value = r.headline ?? ''
    ready.value = r.ready === true
    hasProducts.value = r.hasProducts === true
    outcomeLabel.value = r.outcomeLabel ?? ''
    outcomeLines.value = Array.isArray(r.outcomeLines) ? r.outcomeLines : []
    outcomeIntegrity.value = r.outcomeIntegrity ?? { truncated: false, failed: false }
    skippedIds.value = Array.isArray(r.skippedFestivalIds) ? r.skippedFestivalIds : []
    ownEventsFailed.value = r.ownEventsFailed === true
    loaded.value = true
  }
  catch (e: unknown) {
    // ⛔ 查不到不可以畫成「沒有檔期」：那會讓人以為這一季沒事做
    loadError.value = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || '請稍後再試一次'
  }
  finally {
    loading.value = false
  }
}

function shortDate(d: string) {
  return d.slice(5).replace('-', '/')
}

function daysText(n: number) {
  if (n === 0) return '就是今天'
  if (n === 1) return '明天'
  return `${n} 天後`
}

function goProfile() {
  // ⛔ 一定要帶 focus=profile：不帶會落進續走模式，那條路只跑接線四步
  void navigateTo(`/admin/onboarding?workspaceId=${props.workspaceId}&focus=profile`)
}

function goViewBroadcast(id: string) {
  if (!id) return
  // 推播頁吃 `?id=` 直接打開那一則（`C-237`）
  void navigateTo(`/admin/${props.workspaceId}/broadcasts?id=${encodeURIComponent(id)}`)
}

const draftingId = ref('')

/**
 * `C-236`：收起來 / 放回來。
 *
 * ⛔ **失敗要講出來、而且畫面要退回去**：樂觀更新之後靜靜失敗的話，
 *   他重新整理會發現那一檔又跑回來，而完全不知道發生過什麼。
 */
async function setSkip(e: { festivalId: string, name: string }, skip: boolean) {
  if (skippingId.value) return
  skippingId.value = e.festivalId
  const before = [...skippedIds.value]
  try {
    const r = await apiFetch<{ skips: Record<string, number> }>('/api/marketing-calendar/skip', {
      method: 'POST',
      body: { festivalId: e.festivalId, skip },
    })
    skippedIds.value = Object.keys(r.skips ?? {})
    ElMessage.success(skip ? skippedToastText(e.name) : restoredText(e.name))
  }
  catch (err: unknown) {
    skippedIds.value = before
    ElMessage.error((err as { data?: { statusMessage?: string } })?.data?.statusMessage || '這次沒改成功，請再試一次')
  }
  finally {
    skippingId.value = ''
  }
}

const skipEntry = (e: { festivalId: string, name: string }) => setSkip(e, true)
const restoreEntry = (e: { festivalId: string, name: string }) => setSkip(e, false)

/**
 * `D-122`②：店家自己的檔期——加、改、刪。存好就整張卡重載（攤開哪一檔、排了沒、回顧都由後端算）。
 */
const eventDialog = reactive<{
  visible: boolean
  mode: 'create' | 'edit'
  initial: { id?: string, name?: string, date?: string }
}>({ visible: false, mode: 'create', initial: {} })
const deletingId = ref('')

function openAddEvent() {
  Object.assign(eventDialog, { visible: true, mode: 'create', initial: {} })
}
function openEditEvent(e: CalendarEntry) {
  Object.assign(eventDialog, { visible: true, mode: 'edit', initial: { id: e.festivalId, name: e.name, date: e.date } })
}
async function onEventSaved(saved: MarketingEvent, isNew: boolean) {
  ElMessage.success(eventSavedText(saved.name, isNew))
  // 加的那一檔攤開給他看（他剛加的就是他現在要看的）
  if (isNew) openChoice.value = saved.id
  await reload()
}
async function deleteEvent(e: CalendarEntry) {
  if (deletingId.value) return
  try {
    await ElMessageBox.confirm(eventDeleteConfirmText(e.name), '刪除檔期', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  deletingId.value = e.festivalId
  try {
    await apiFetch('/api/marketing-calendar', { method: 'POST', body: { op: 'delete', id: e.festivalId } })
    ElMessage.success(`「${e.name}」刪掉了。`)
    // 攤開的就是刪掉的那一檔 → 回到「最近那一檔攤開」（⛔ 不要留一個對不到任何一列的選擇）
    if (openChoice.value === e.festivalId) openChoice.value = undefined
    await reload()
  }
  catch (err: unknown) {
    ElMessage.error((err as { data?: { statusMessage?: string } })?.data?.statusMessage || '這次沒刪成功，請再試一次')
  }
  finally {
    deletingId.value = ''
  }
}

/**
 * 「為這一檔擬推播」（`C-225`）。
 * ⛔ **這裡不建立任何東西**：端點只產文字，文案暫存在 sessionStorage，
 *    由推播頁開一張**還沒存檔**的草稿——對客人說話的東西，最後一顆按鈕永遠是人。
 */
async function goBroadcast(e: CalendarEntry) {
  if (draftingId.value) return // ⛔ 防連點：一次按兩下會打兩次 LLM
  draftingId.value = e.festivalId
  try {
    const r = await apiFetch<BroadcastDraftHandoff>('/api/marketing-calendar/draft', {
      method: 'POST',
      body: { festivalId: e.festivalId },
    })
    try {
      sessionStorage.setItem(BROADCAST_DRAFT_HANDOFF_KEY, JSON.stringify(r))
    }
    catch {
      // ⛔ 存不進去就不要跳頁：跳過去會是一張空白推播，他會以為文案弄丟了
      ElMessage.error('這個瀏覽器擋了暫存，文案帶不過去。請改用一般視窗再試一次。')
      return
    }
    await navigateTo(`/admin/${props.workspaceId}/broadcasts?from=calendar`)
  }
  catch (err: unknown) {
    const msg = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
    ElMessage.error(msg || '這次擬不出來，再按一次試試。')
  }
  finally {
    draftingId.value = ''
  }
}

onMounted(reload)
</script>
