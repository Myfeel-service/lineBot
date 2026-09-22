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

        <article v-for="e in entries" :key="e.festivalId" :class="['mkt-cal__item', { 'is-soon': e.soon }]">
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
          </div>
        </article>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CalendarEntry } from '~~/shared/marketing-calendar'
import { BROADCAST_DRAFT_HANDOFF_KEY, type BroadcastDraftHandoff } from '~~/shared/broadcast-draft-handoff'

const props = defineProps<{ workspaceId: string }>()

const { apiFetch } = useWorkspaceApiFetch(() => props.workspaceId)

const entries = ref<CalendarEntry[]>([])
const headline = ref('')
const ready = ref(false)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')

async function reload() {
  loading.value = true
  loadError.value = ''
  try {
    const r = await apiFetch<{ entries: CalendarEntry[], headline: string, ready: boolean }>('/api/marketing-calendar')
    entries.value = r.entries ?? []
    headline.value = r.headline ?? ''
    ready.value = r.ready === true
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
