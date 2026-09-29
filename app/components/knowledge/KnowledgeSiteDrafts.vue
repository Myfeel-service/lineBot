<template>
  <!-- 開帳讀網站整理出來、等你看過的卡（`C-250`③，示意頁 v80 的知識庫頁）。
       ⭐ 老闆 09-24：「我根本還是不知道知識卡內被建立了什麼」——文字解釋連敗兩輪，
          這一區直接放**他自己的卡**讓他一張一張看（範例本身就是定義）。
       ⛔ 什麼都沒有（沒給網址、或都看完了）就整塊不畫，不留一個空殼。 -->
  <section v-if="visible" class="kb-drafts" data-tour="kb-drafts">
    <div class="kb-drafts__head">
      <div class="kb-drafts__title">
        <template v-if="stillWorking && !total">正在整理你網站讀到的頁面…</template>
        <template v-else-if="siteTotal || stillWorking">開帳讀你網站那 {{ pagesCount }} 頁，整理成 {{ siteTotal }} 張卡了</template>
        <!-- 只有請小幫手補的卡（`D-109`）：⛔ 不可以講成「讀你網站那 1 頁」——那一張不是從網站來的 -->
        <template v-else>有 {{ total }} 張卡等你看過</template>
      </div>
      <p class="kb-drafts__sub">
        還沒進知識庫——你一張一張看過才算數。
        <template v-if="manualCount && (siteTotal || stillWorking)">另外 {{ manualCount }} 張是請小幫手補的，也在下面。</template>
        <!-- ⛔ 會花到額度的數字要寫在**按下去之前看得到的地方**（知識卡張數是計費維度） -->
        <template v-if="quota && quota.limit != null && total">
          <b>全收會用掉 {{ total }}／{{ quota.limit }} 張</b>（<template v-if="quota.planName">{{ quota.planName }}方案，</template>現在用了 {{ quota.used }} 張），不要的刪掉就不佔。
        </template>
      </p>
      <p v-if="stillWorking" class="kb-drafts__working">
        <span class="kb-drafts__spin" aria-hidden="true" />
        還在整理第 {{ Math.min((generating?.pagesDone ?? 0) + 1, generating?.pagesTotal ?? 1) }}／{{ generating?.pagesTotal }} 頁，整理好的會先出現在下面
      </p>
      <p v-if="generating?.error" class="kb-drafts__warn">{{ generating.error }}</p>
      <!-- ⛔ 過濾掉的東西要說得出丟了什麼：封頂沒放進來的、整理不出卡的頁 -->
      <p v-if="generating?.trimmed" class="kb-drafts__note">
        還有 {{ generating.trimmed }} 張沒整理進來（開帳一次最多整理 50 張）；那幾頁之後可以在上方「匯入資料」重新加。
      </p>
      <p v-if="generating?.pagesFailed?.length" class="kb-drafts__note">
        有 {{ generating.pagesFailed.length }} 頁整理不出卡：{{ generating.pagesFailed.map(p => pathOf(p.url)).join('、') }}
      </p>
      <!-- 重跑「讓我認識你的店」：同一頁上次已經整理過，這次沒有再建一份（⛔ 跳過的要說得出幾頁） -->
      <p v-if="generating?.skippedExisting" class="kb-drafts__note">
        有 {{ generating.skippedExisting }} 頁上次開帳已經整理過，這次沒有再整理一份。
      </p>
      <ul v-if="pages.length" class="kb-drafts__pages">
        <li v-for="p in pages" :key="p.sourceId">{{ p.name }} · {{ p.cards.length }} 張</li>
      </ul>
    </div>

    <div v-for="p in pages" :key="p.sourceId" class="kb-drafts__group">
      <div class="kb-drafts__group-head">
        <span v-if="p.url">來自「<b>{{ p.name }}</b>」那一頁 · <b>{{ p.cards.length }}</b> 張卡</span>
        <span v-else>請小幫手補的「<b>{{ p.name }}</b>」 · <b>{{ p.cards.length }}</b> 張卡</span>
        <!-- 只有一張的那一組不給「全部採用」：跟卡上那顆「採用」是同一件事，兩顆會被讀成兩件事 -->
        <el-button
          v-if="canEdit && p.cards.some(c => !decided[c.id]) && (p.url || p.cards.length > 1)"
          size="small"
          plain
          :loading="busyPage === p.sourceId"
          @click="adoptPage(p)"
        >{{ p.url ? '這一頁全部採用' : '全部採用' }}</el-button>
      </div>
      <div
        v-for="c in p.cards"
        :key="c.id"
        class="kb-drafts__card"
        :class="{ 'is-done': decided[c.id] }"
      >
        <div class="kb-drafts__k">客人問</div>
        <div v-if="editing !== c.id" class="kb-drafts__q">{{ c.questions[0] || c.title }}</div>
        <el-input v-else v-model="editQ" size="small" :maxlength="200" />
        <div class="kb-drafts__k">卡片寫</div>
        <div v-if="editing !== c.id" class="kb-drafts__a">{{ c.content }}</div>
        <el-input v-else v-model="editA" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" :maxlength="4000" />
        <p v-if="decided[c.id]" class="kb-drafts__state" :class="`is-${decided[c.id]!.tone}`">{{ decided[c.id]!.text }}</p>
        <div v-else-if="canEdit" class="kb-drafts__bar">
          <template v-if="editing === c.id">
            <el-button size="small" type="primary" :loading="busyCard === c.id" @click="saveEdit(c)">存起來</el-button>
            <el-button size="small" @click="editing = null">取消</el-button>
          </template>
          <template v-else>
            <el-button size="small" type="primary" :loading="busyCard === c.id" @click="adopt([c.id])">採用</el-button>
            <el-button size="small" @click="startEdit(c)">修改</el-button>
            <el-button size="small" text @click="dismiss(c)">刪掉</el-button>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 「等你看過」的知識卡（`C-250`③）。資料：`GET /api/ai/knowledge/drafts`。
 * 整理還沒做完就由這裡往前推（`POST …/drafts/advance`，一步最多 2 頁）——
 * 排程每 10 分鐘也會補推，但他人就在這一頁時不該讓他等 10 分鐘。
 */
const props = defineProps<{ canEdit: boolean }>()
const emit = defineEmits<{ changed: [] }>()

interface DraftCard { id: string, title: string, content: string, questions: string[], tags: string[] }
interface DraftPage { sourceId: string, name: string, url: string, cards: DraftCard[] }
interface Generating { status: string, pagesDone: number, pagesTotal: number, cards: number, trimmed: number, pagesFailed: { url: string, reason: string }[], skippedExisting?: number, error?: string }
interface Overview { total: number, pages: DraftPage[], generating: Generating | null, quota: { used: number, limit: number | null, planName?: string } | null }

const { apiFetch, workspaceId } = useWorkspace()
const { showToast } = useAdminToast()
/**
 * 開通步驟紀錄（`C-250`③）：這批卡是開帳讀網站生的，他怎麼處理它們＝`D-97`「一張張看」到底行不行得通。
 * ⭐ `left`＝這一下之後還剩幾張沒看；`whole`＝整頁一起收（跟一張張看分開算）。
 */
const { track: trackOnboarding } = useOnboardingEvents({ workspaceId: () => workspaceId.value, flow: () => 'other' })

const pages = ref<DraftPage[]>([])
const total = ref(0)
const generating = ref<Generating | null>(null)
const quota = ref<Overview['quota']>(null)
/** 這一場裡決定過的卡：留在畫面上講結果（⛔ 按完就消失的話，他不知道剛剛那一下有沒有成功） */
const decided = reactive<Record<string, { tone: 'ok' | 'muted' | 'warn', text: string }>>({})
const busyCard = ref<string | null>(null)
const busyPage = ref<string | null>(null)
const editing = ref<string | null>(null)
const editQ = ref('')
const editA = ref('')

const stillWorking = computed(() => generating.value?.status === 'queued' || generating.value?.status === 'running')
/**
 * 從網站來的 vs 請小幫手補的（`D-109`）：後者建在手寫資料底下、沒有網址。
 * ⛔ 標題「讀你網站那 N 頁、整理成 M 張」只能數前者——混在一起算，小幫手補的一張卡會被講成「讀你網站那 1 頁」。
 */
const manualCount = computed(() => pages.value
  .filter(p => !p.url)
  .reduce((n, p) => n + p.cards.filter(c => !decided[c.id]).length, 0))
const siteTotal = computed(() => Math.max(0, total.value - manualCount.value))
/**
 * 這張是不是開帳讀網站來的。⛔ 開通步驟紀錄只記這一種：那筆數字在量「一張張看」行不行得通（`D-97`），
 * 請小幫手補的卡混進去就不是在量開帳了。（一次按的卡都來自同一組，看第一張就夠。）
 */
const siteCardIds = computed(() => new Set(pages.value.filter(p => !!p.url).flatMap(p => p.cards.map(c => c.id))))
const isSiteCard = (id: string | undefined) => !!id && siteCardIds.value.has(id)
const pagesCount = computed(() => generating.value?.pagesTotal || pages.value.filter(p => !!p.url).length)
const visible = computed(() => total.value > 0 || stillWorking.value || Object.keys(decided).length > 0)

function pathOf(url: string) {
  try {
    const u = new URL(url)
    return decodeURIComponent(u.pathname) === '/' ? '首頁' : decodeURIComponent(u.pathname)
  }
  catch { return url }
}

async function load() {
  try {
    const r = await apiFetch<Overview>('/api/ai/knowledge/drafts')
    // ⚠️ 已經決定過的卡保留在畫面上（伺服器那邊它已經不是草稿了，重抓會少掉它）
    const keep = new Map(pages.value.map(p => [p.sourceId, p.cards.filter(c => decided[c.id])]))
    pages.value = r.pages.map(p => ({ ...p, cards: [...(keep.get(p.sourceId) ?? []), ...p.cards.filter(c => !decided[c.id])] }))
    for (const [sid, cards] of keep) {
      if (cards.length && !pages.value.some(p => p.sourceId === sid)) {
        const old = pagesSnapshot.get(sid)
        if (old) pages.value.push({ ...old, cards })
      }
    }
    pagesSnapshot = new Map(pages.value.map(p => [p.sourceId, p]))
    total.value = r.total
    generating.value = r.generating
    quota.value = r.quota
  }
  catch { /* 讀不到就不畫；知識庫其他部分照常 */ }
}
let pagesSnapshot = new Map<string, DraftPage>()

/** 整理還沒做完：一步一步推，推完一步就重抓（整理好的卡先出現） */
let pushing = false
let alive = true
async function pushUntilDone() {
  if (pushing || !props.canEdit) return
  pushing = true
  try {
    for (let i = 0; i < 12 && alive && stillWorking.value; i++) {
      const r = await apiFetch<{ cards: { status?: string } | null }>('/api/ai/knowledge/drafts/advance', { method: 'POST' }).catch(() => null)
      await load()
      if (generating.value?.error) break // 額度擋下：講出來、不再推
      // ⚠️ 別人正拿著租約（精靈或排程在推）時 advance 會馬上回 running：等久一點再問，⛔ 不要一圈接一圈讀整份清單
      await new Promise(res => setTimeout(res, r?.cards?.status === 'running' ? 6000 : 800))
    }
  }
  finally {
    pushing = false
  }
}

async function adopt(ids: string[], whole = false) {
  busyCard.value = ids.length === 1 ? ids[0]! : null
  try {
    const r = await apiFetch<{ adopted: string[], leftForQuota: string[], quota: Overview['quota'] }>('/api/ai/knowledge/drafts/adopt', {
      method: 'POST',
      body: { chunkIds: ids },
    })
    for (const id of r.adopted) decided[id] = { tone: 'ok', text: '已收進知識庫 ✓ 從現在起 AI 回客人會用這張' }
    // ⭐ 收到滿為止：沒收的那幾張照實講，⛔ 不可以靜靜只收一部分
    for (const id of r.leftForQuota) decided[id] = { tone: 'warn', text: '額度滿了，這張先留著——刪掉用不到的卡、或升級方案就收得下' }
    if (r.quota) quota.value = r.quota
    if (r.leftForQuota.length) showToast(`收了 ${r.adopted.length} 張，額度滿了，還有 ${r.leftForQuota.length} 張先留著`, 'warning')
    total.value = Math.max(0, total.value - r.adopted.length)
    if (isSiteCard(ids[0])) trackOnboarding('kb_draft_decision', {
      decision: 'adopt',
      whole,
      n: r.adopted.length,
      quotaBlocked: r.leftForQuota.length,
      left: total.value,
    })
    emit('changed')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || e?.statusMessage || '沒有成功，再試一次', 'error')
  }
  finally {
    busyCard.value = null
  }
}

async function adoptPage(p: DraftPage) {
  busyPage.value = p.sourceId
  try {
    await adopt(p.cards.filter(c => !decided[c.id]).map(c => c.id), true)
  }
  finally {
    busyPage.value = null
  }
}

async function dismiss(c: DraftCard) {
  busyCard.value = c.id
  try {
    await apiFetch('/api/ai/knowledge/drafts/dismiss', { method: 'POST', body: { chunkIds: [c.id] } })
    decided[c.id] = { tone: 'muted', text: '已刪掉，不會進知識庫' }
    total.value = Math.max(0, total.value - 1)
    if (isSiteCard(c.id)) trackOnboarding('kb_draft_decision', { decision: 'dismiss', n: 1, left: total.value })
    emit('changed')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '沒有刪成功，再試一次', 'error')
  }
  finally {
    busyCard.value = null
  }
}

function startEdit(c: DraftCard) {
  editing.value = c.id
  editQ.value = c.questions[0] || c.title
  editA.value = c.content
}

/** 改字＝仍是等你看過（⛔ 改完不自動採用：他按的是「存起來」不是「採用」） */
async function saveEdit(c: DraftCard) {
  const q = editQ.value.trim()
  const a = editA.value.trim()
  if (!q || !a) {
    showToast('問句跟答案都要有字', 'warning')
    return
  }
  busyCard.value = c.id
  try {
    // ⚠️ tags 一定要帶回去：這支沒帶 tags 會把標籤洗成空的
    await apiFetch(`/api/ai/knowledge/${c.id}`, {
      method: 'PUT',
      body: { title: c.title, content: a, tags: c.tags, questions: [q, ...c.questions.slice(1)] },
    })
    c.content = a
    c.questions = [q, ...c.questions.slice(1)]
    editing.value = null
    if (isSiteCard(c.id)) trackOnboarding('kb_draft_decision', { decision: 'edit', n: 1, left: total.value })
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '沒有存成功，再試一次', 'error')
  }
  finally {
    busyCard.value = null
  }
}

onMounted(async () => {
  await load()
  if (stillWorking.value) void pushUntilDone()
})
onBeforeUnmount(() => { alive = false })

defineExpose({ reload: load })
</script>

<!-- 樣式在 app/assets/scss/pages/_knowledge-sources.scss（.kb-drafts） -->
