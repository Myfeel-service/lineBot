<!--
  行銷月曆卡（`D-85` / `C-224`）：未來 90 天有哪些檔期、每一檔該做什麼。

  掛在後台首頁（＝客服對話統計頁）。⛔ 不加側欄項目——它不是一個功能，
  是「這一季要做什麼」的提醒，跟首頁的其他數字住在一起才看得到。

  ⛔ 三件事不可以妥協：
    ① **「為什麼是你」每一條都要有出處**，湊不出來就整段不出現，
       並明講「這一檔還沒有你的數字」——⛔ 不可以編一句「這檔通常表現不錯」。
    ② **不承諾成效**：不出現「可以多賣三成」這種我們算不出來的話。
    ③ **還不認識這家店時要講**，不要讓通用建議看起來像為他算的。
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

      <div v-else-if="!entries.length" class="mkt-cal__muted">
        未來 90 天沒有重要節日，可以專心顧日常。
      </div>

      <template v-else>
        <!-- 還不認識這家店：整張卡只有通用建議，這件事要先講 -->
        <el-alert v-if="!ready" type="info" :closable="false" show-icon>
          <template #title>下面只有通用的建議</template>
          MiniMe 還不認識你的店，所以講不出「你的哪個商品該搭這個節日」。
          <el-link type="primary" :underline="false" @click="goProfile">花 3 分鐘讓它認識 →</el-link>
        </el-alert>

        <!--
          `C-235`：認識了、但**主打商品那一格是空的**。
          ⭐ 這一條是 2026-09-23 拿正式資料跑出來才發現要有的：`isStoreProfileReady` 只要求
             答滿三題，而「主打商品」正好是下游全部都靠的那一格——節慶客製講不出商品、
             受眾也配不出來，卻沒有任何地方會講。⛔ 不可以讓它安靜地不準。
        -->
        <el-alert v-else-if="!hasProducts" type="info" :closable="false" show-icon>
          <template #title>補上「主打商品」，這幾檔會準很多</template>
          你的輪廓裡還沒寫賣什麼，所以 MiniMe 不敢替你挑「這一檔該發給誰」，
          節慶提醒也只能講通用的一句。
          <el-link type="primary" :underline="false" @click="goProfile">去補主打商品 →</el-link>
        </el-alert>

        <!--
          `C-55`② / `C-240`：上一檔做得怎麼樣。
          ⭐ 放在「接下來」**上面**：先看完上一檔的結果，下一檔的建議才讀得進去。
          ⛔ 一檔都沒有就整段不出現（`outcomeHeadline` 回空字串）——不要留一個空殼。
        -->
        <section v-if="outcomeHeadline" class="mkt-cal__review">
          <p class="mkt-cal__label">{{ outcomeHeadline }}</p>
          <p v-for="o in outcomes" :key="o.festivalId" class="mkt-cal__review-line">{{ o.text }}</p>
          <!-- ⛔ 口徑要寫在畫面上：這是「幾次」不是「幾個人」 -->
          <p class="mkt-cal__nodata">
            「被點幾次」數的是<b>次數</b>不是人數——推播是同一則發給所有人，我們看得到連結被點了幾下，
            看不出是幾個人點的。
          </p>
          <p v-if="outcomeIntegrity.failed" class="mkt-cal__nodata">⚠️ 這次讀不到推播紀錄，上面的回顧不完整。</p>
          <p v-else-if="outcomeIntegrity.truncated" class="mkt-cal__nodata">⚠️ 推播太多，只算了掃到的那一段。</p>
        </section>

        <article v-for="e in visibleEntries" :key="e.festivalId" :class="['mkt-cal__item', { 'is-soon': e.soon }]">
          <header class="mkt-cal__head">
            <span class="mkt-cal__when">{{ shortDate(e.date) }}</span>
            <span class="mkt-cal__name">{{ e.name }}</span>
            <span :class="['mkt-cal__days', { 'is-soon': e.soon }]">{{ daysText(e.inDays) }}</span>
          </header>

          <!-- ① 為什麼——每一條都帶出處。湊不出來就整段不出現 -->
          <template v-if="e.reasons.length">
            <p class="mkt-cal__label">為什麼是你</p>
            <ul class="mkt-cal__reasons">
              <li v-for="(r, i) in e.reasons" :key="i">
                {{ r.text }}<span class="mkt-cal__source">（{{ r.source }}）</span>
              </li>
            </ul>
          </template>
          <p v-else class="mkt-cal__nodata">
            這一檔還沒有你的數字，先給你通用的切角：{{ e.generalAngle }}
          </p>

          <!-- ② 做什麼 -->
          <p class="mkt-cal__label">做什麼</p>
          <ol class="mkt-cal__actions">
            <li v-for="(a, i) in e.actions" :key="i">{{ a }}</li>
          </ol>

          <!-- ③ 一顆按鈕 -->
          <div class="mkt-cal__cta">
            <el-button
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
              `C-236`：這一檔跟我無關。
              ⛔ 這不是刪除：`festivalId` 含年份，明年那一檔會自己回來——按鈕的提示要講出來，
                 不然會被當成永久刪掉而不敢按。
            -->
            <el-button size="small" text :loading="skippingId === e.festivalId" @click="skipEntry(e)">
              這次不做
            </el-button>
          </div>
        </article>

        <!--
          收起來的那幾檔（`C-236` 鐵律①）。
          ⛔ **一定要看得見、可以還原**：靜靜消失的話，他會以為系統漏掉那個節日。
        -->
        <div v-if="skippedEntries.length" class="mkt-cal__skipped">
          <p class="mkt-cal__skipped-text">
            {{ visibleEntries.length ? skippedNoticeText(skippedEntries) : allSkippedText(skippedEntries) }}
          </p>
          <div class="mkt-cal__skipped-chips">
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
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CalendarEntry } from '~~/shared/marketing-calendar'
import type { FestivalOutcome } from '~~/shared/festival-outcome'
import {
  allSkippedText,
  skippedNoticeText,
  skippedToastText,
  splitBySkip,
  restoredText,
} from '~~/shared/marketing-skips'
import { BROADCAST_DRAFT_HANDOFF_KEY, type BroadcastDraftHandoff } from '~~/shared/broadcast-draft-handoff'

const props = defineProps<{ workspaceId: string }>()

const { apiFetch } = useWorkspaceApiFetch(() => props.workspaceId)

const entries = ref<CalendarEntry[]>([])
const headline = ref('')
const ready = ref(false)
/**
 * 輪廓有沒有寫「主打商品」（`C-235`）。
 * ⚠️ 跟 `ready` 是兩件事：`ready` 只要答滿三題就成立，但主打商品是下游全部都靠的那一格
 *   （節慶客製、受眾配對），空的話這張卡只講得出通用建議卻不會有人知道。
 * ⛔ 預設 `true`：讀不到時**不要**跳出「快去補商品」——那是在還不知道的情況下指責他。
 */
const hasProducts = ref(true)

/** 上一檔的結果（`C-55`②）。空陣列＝回看窗內沒有過去的節日，整段不出現。 */
const outcomes = ref<FestivalOutcome[]>([])
const outcomeHeadline = ref('')
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

async function reload() {
  loading.value = true
  loadError.value = ''
  try {
    const r = await apiFetch<{
      entries: CalendarEntry[]
      headline: string
      ready: boolean
      hasProducts: boolean
      outcomes: FestivalOutcome[]
      outcomeHeadline: string
      outcomeIntegrity: { truncated: boolean, failed: boolean }
      skippedFestivalIds: string[]
    }>('/api/marketing-calendar')
    entries.value = r.entries ?? []
    headline.value = r.headline ?? ''
    ready.value = r.ready === true
    hasProducts.value = r.hasProducts === true
    outcomes.value = r.outcomes ?? []
    outcomeHeadline.value = r.outcomeHeadline ?? ''
    outcomeIntegrity.value = r.outcomeIntegrity ?? { truncated: false, failed: false }
    skippedIds.value = Array.isArray(r.skippedFestivalIds) ? r.skippedFestivalIds : []
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

const draftingId = ref('')

/**
 * 「為這一檔擬推播」（`C-225`）。
 * ⛔ **這裡不建立任何東西**：端點只產文字，文案暫存在 sessionStorage，
 *    由推播頁開一張**還沒存檔**的草稿——對客人說話的東西，最後一顆按鈕永遠是人。
 */
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
