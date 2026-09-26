<template>
  <!-- 一般泡泡 -->
  <div
    v-if="entry.msg.kind === 'text'"
    class="agm-msg"
    :class="entry.role === 'user' ? 'agm-msg--user' : 'agm-msg--agent'"
  >
    <!-- html 僅限劇本文案＋已跳脫的使用者輸入（見 shared/types/agent-messages.ts 的警語） -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="agm-bubble">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-html="entry.msg.html" />
      <!-- 「為什麼／萬一沒做」預設收合：照著做需要的字留在外面，解釋收進來
           （⛔ 與圖解步驟卡的 aside 刻意不同：那個是「只有一部分人會遇到」的岔路，
             這個是所有人都適用、但不看也做得完的背景） -->
      <details v-if="entry.msg.aside" class="agm-bubble__aside">
        <summary>{{ entry.msg.aside.summary }}</summary>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-html="entry.msg.aside.html" />
        <!-- 圖檔還沒補進 public/onboarding/ 時整塊不顯示、文字照常 -->
        <el-image
          v-if="entry.msg.aside.image && shotReady(entry.msg.aside.image)"
          class="agm-help__shot"
          :src="entry.msg.aside.image"
          :alt="entry.msg.aside.alt || entry.msg.aside.summary"
          fit="contain"
          :preview-src-list="[entry.msg.aside.image]"
          :preview-teleported="true"
        />
      </details>
    </div>
  </div>

  <!-- 圖解步驟卡:一步一格,有圖就配圖(點圖放大)。預設展開——這是要照著做的東西,
       藏在一次點擊後面等於沒有 -->
  <details v-else-if="entry.msg.kind === 'help'" class="agm-card agm-help" open>
    <summary>{{ entry.msg.summary }}</summary>
    <ol>
      <li v-for="(s, i) in entry.msg.steps" :key="i" class="agm-help__step">
        <span>{{ s.text }}</span>
        <!-- 這一步自己的入口：例如「打開 LINE Developers」就在第一步直接點得到 -->
        <a
          v-if="s.href"
          class="agm-help__step-link"
          :href="s.href"
          target="_blank"
          rel="noopener"
        >{{ s.hrefLabel || '打開連結 ↗' }}</a>
        <!-- 圖檔還沒放進 public/onboarding/ 時 shotReady 永遠是 false:只少一張圖,不破版 -->
        <el-image
          v-if="s.image && shotReady(s.image)"
          class="agm-help__shot"
          :src="s.image"
          :alt="s.alt || s.text"
          fit="contain"
          :preview-src-list="[s.image]"
          :preview-teleported="true"
        />
        <details v-if="s.aside" class="agm-help__aside">
          <summary>{{ s.aside.summary }}</summary>
          <p>{{ s.aside.text }}</p>
          <el-image
            v-if="s.aside.image && shotReady(s.aside.image)"
            class="agm-help__shot"
            :src="s.aside.image"
            :alt="s.aside.alt || s.aside.text"
            fit="contain"
            :preview-src-list="[s.aside.image]"
            :preview-teleported="true"
          />
        </details>
      </li>
    </ol>
    <a
      v-if="entry.msg.href"
      class="agm-help__link"
      :href="entry.msg.href"
      target="_blank"
      rel="noopener"
    >{{ entry.msg.hrefLabel || '打開連結 ↗' }}</a>
  </details>

  <!-- 單張示意圖卡（節點式教學）：載不到檔整張不畫，不留空殼 -->
  <el-image
    v-else-if="entry.msg.kind === 'image' && shotReady(entry.msg.src)"
    class="agm-shot"
    :src="entry.msg.src"
    :alt="entry.msg.alt"
    fit="contain"
    :preview-src-list="[entry.msg.src]"
    :preview-teleported="true"
  />

  <!-- 步驟輪播卡：一步一張圖、圖在上步驟在下。全部圖都載不到就整張不畫（元件自己判斷） -->
  <AgentStepCarousel
    v-else-if="entry.msg.kind === 'carousel'"
    :steps="entry.msg.steps"
  />

  <!-- 站內連結卡：走 NuxtLink 同分頁導航（用 <a> 會整頁重載） -->
  <NuxtLink
    v-else-if="entry.msg.kind === 'link' && entry.msg.internal"
    class="agm-card agm-link"
    :to="entry.msg.href"
  >{{ entry.msg.label }} →</NuxtLink>

  <!-- 外部連結卡（另開分頁） -->
  <a
    v-else-if="entry.msg.kind === 'link'"
    class="agm-card agm-link"
    :href="entry.msg.href"
    target="_blank"
    rel="noopener"
  >{{ entry.msg.label }} ↗</a>

  <!-- 一鍵複製卡 -->
  <div v-else-if="entry.msg.kind === 'copy'" class="agm-card agm-copy">
    <div class="agm-card__label">{{ entry.msg.label }}</div>
    <div class="agm-copy__row">
      <code class="agm-copy__value">{{ entry.msg.value }}</code>
      <el-button size="small" :type="copied ? 'success' : 'primary'" plain @click="copy(entry.msg.value)">
        {{ copied ? '已複製 ✓' : '複製' }}
      </el-button>
    </div>
  </div>

  <!-- 狀態卡：進行中 / 成功 / 失敗 -->
  <div
    v-else-if="entry.msg.kind === 'status'"
    class="agm-card agm-status"
    :class="`agm-status--${entry.msg.state}`"
  >
    <el-icon v-if="entry.msg.state === 'pending'" class="is-loading"><Loading /></el-icon>
    <el-icon v-else-if="entry.msg.state === 'ok'"><CircleCheckFilled /></el-icon>
    <el-icon v-else-if="entry.msg.state === 'skipped'"><Remove /></el-icon>
    <el-icon v-else><WarningFilled /></el-icon>
    <span>{{ entry.msg.text }}</span>
  </div>

  <!-- 見證卡（`C-250`③，示意頁 v78→v80）：⭐ 一張卡只講一件事——**掃 QR 加好友**。
       加好友就算測通（「是你嗎？」是對話的下一句，⛔ 不在卡片裡先畫一格空框）。
       其他路（搜尋 ID／早就是好友／正在用手機看）收成兩行小字＋一個文字連結。
       ⚠️ 官方帳號用**他待會在手機上看到的名稱與頭像**講「加哪一個」；拿不到代號時只剩一句文字，不破版。 -->
  <div v-else-if="entry.msg.kind === 'witness'" class="agm-witness agm-witness--single">
    <div class="agm-witness__t">拿起手機，掃這個 QR 加你的官方帳號為好友</div>
    <div v-if="entry.msg.basicId" class="agm-witness__qrrow">
      <img
        v-if="entry.msg.qrDataUrl"
        class="agm-witness__qr"
        :src="entry.msg.qrDataUrl"
        :alt="`加入 ${entry.msg.basicId} 為好友的 QR Code`"
        width="104"
        height="104"
      >
      <div class="agm-witness__main">
        <span class="agm-who is-oa">
          <img v-if="entry.msg.oaPictureUrl" class="agm-who__av" :src="entry.msg.oaPictureUrl" alt="">
          <span v-else class="agm-who__av" />
          <b>{{ entry.msg.oaName || '你的官方帳號' }}</b>
          <span class="agm-who__id">{{ entry.msg.basicId }}</span>
        </span>
        <p class="agm-witness__how">
          掃不到？在 LINE 搜尋上面那組 ID<br>已經是好友了？傳一句話給它就好
        </p>
        <!-- ⛔ 不能寫「用手機打開這個連結」：它出現在**電腦畫面上**，等於叫他用手機點電腦上的連結 -->
        <a class="agm-witness__link" :href="entry.msg.addFriendUrl" target="_blank" rel="noopener">
          正在用手機看這一頁？直接加好友 ↗
        </a>
        <div class="agm-status agm-witness__wait" :class="`agm-witness__wait--${entry.msg.waitState}`">
          <el-icon v-if="entry.msg.waitState === 'pending'" class="is-loading"><Loading /></el-icon>
          <el-icon v-else-if="entry.msg.waitState === 'ok'"><CircleCheckFilled /></el-icon>
          <el-icon v-else><Remove /></el-icon>
          <span>{{ entry.msg.waitText }}</span>
        </div>
      </div>
    </div>
    <template v-else>
      <p class="agm-witness__how">在 LINE 裡搜尋你的官方帳號，加它為好友（已經是好友的話，傳一句話給它就好）。</p>
      <div class="agm-status agm-witness__wait" :class="`agm-witness__wait--${entry.msg.waitState}`">
        <el-icon v-if="entry.msg.waitState === 'pending'" class="is-loading"><Loading /></el-icon>
        <el-icon v-else-if="entry.msg.waitState === 'ok'"><CircleCheckFilled /></el-icon>
        <el-icon v-else><Remove /></el-icon>
        <span>{{ entry.msg.waitText }}</span>
      </div>
    </template>
  </div>

  <!-- 強調卡：回顯第一則訊息 -->
  <div v-else-if="entry.msg.kind === 'highlight'" class="agm-card agm-highlight">
    <div class="agm-card__label">{{ entry.msg.label }}</div>
    <div class="agm-highlight__title">{{ entry.msg.title }}</div>
    <div v-if="entry.msg.meta" class="agm-highlight__meta">{{ entry.msg.meta }}</div>
  </div>

  <!-- 完成摘要卡 -->
  <div v-else-if="entry.msg.kind === 'summary'" class="agm-card agm-summary">
    <div class="agm-card__label">{{ entry.msg.title || '開通結果' }}</div>
    <ul>
      <li v-for="(it, i) in entry.msg.items" :key="i" :class="{ 'is-skipped': !it.done }">
        <span class="agm-summary__mark">{{ it.done ? '✓' : '–' }}</span>
        <span>{{ it.label }}<template v-if="it.note">（{{ it.note }}）</template></span>
      </li>
    </ul>
  </div>

  <!-- 店家輪廓卡・分組版（`D-93`／`D-91`，`C-250` 落地）：你告訴我的／我猜的 N 項／還學不到的 N 項，
       每列就地可改。⛔ 分組之後每列的來源徽章拿掉——組名已經講了是誰說的。 -->
  <div v-else-if="entry.msg.kind === 'store-profile' && entry.msg.grouped" class="agm-card agm-profile is-grouped">
    <div class="agm-card__label">MiniMe 認識的你</div>
    <template v-for="g in profileGroups" :key="g.key">
      <div
        v-if="g.key !== 'later' && g.rows.length"
        :class="['agm-profile__group', { 'is-ai': g.key === 'ai' }]"
      >
        <div class="agm-profile__gh">
          <!-- ⛔ 數量只掛在**要他動作**的那一組（「我猜的 3 項」的 3 才是「要看幾格」） -->
          <!-- ⚠️ 空格要寫在插值裡：`<template>` 開頭的空白會被 Vue 的 whitespace condense 吃掉（實走量到「我猜的3 項」） -->
          <b>{{ g.key === 'ai' ? `${g.title} ${g.rows.length} 項` : g.title }}</b>
          <span v-if="g.note">{{ g.note }}</span>
        </div>
        <div class="agm-profile__grid">
          <template v-for="row in g.rows" :key="row.fieldId || row.label">
            <div class="k">{{ row.label }}</div>
            <div class="v">
              <div v-if="editingField === row.fieldId" class="agm-profile__rowedit">
                <el-input v-model="editValue" size="small" :maxlength="300" @keyup.enter="saveProfileEdit(row.fieldId)" />
                <el-button size="small" @click="editingField = null">取消</el-button>
                <el-button size="small" type="primary" @click="saveProfileEdit(row.fieldId)">存起來</el-button>
              </div>
              <template v-else>{{ row.value }}</template>
            </div>
            <!-- ⛔ 按鈕上的字要是正式的功能動詞（「改」→「修改」，2026-09-24 老闆指名） -->
            <el-button
              v-if="entry.msg.editable && row.fieldId && editingField !== row.fieldId"
              class="agm-profile__edit"
              link
              type="primary"
              size="small"
              @click="startProfileEdit(row.fieldId, row.value)"
            >修改</el-button>
            <span v-else class="agm-profile__edit" />
          </template>
        </div>
      </div>
    </template>
    <!-- 還學不到的：收成一行，⛔ 不佔三列——空格的語意是「之後會長出來」不是「現在缺」 -->
    <div v-if="laterRows.length" class="agm-profile__later">
      還學不到的 <b>{{ laterRows.length }}</b> 項：{{ laterRows.map(r => r.label).join('、') }}
      <!-- ⛔ 收合鈕跟列上的動作鈕**不可以同名**：兩顆都叫「填寫」的話，講「按填寫」會指到兩個地方 -->
      <el-button link type="primary" size="small" @click="laterOpen = !laterOpen">{{ laterOpen ? '收合' : '展開' }}</el-button>
      <div v-if="laterOpen" class="agm-profile__grid agm-profile__later-grid">
        <template v-for="row in laterRows" :key="row.fieldId || row.label">
          <div class="k">{{ row.label }}</div>
          <div class="v is-empty">
            <div v-if="editingField === row.fieldId" class="agm-profile__rowedit">
              <el-input v-model="editValue" size="small" :maxlength="300" @keyup.enter="saveProfileEdit(row.fieldId)" />
              <el-button size="small" @click="editingField = null">取消</el-button>
              <el-button size="small" type="primary" @click="saveProfileEdit(row.fieldId)">存起來</el-button>
            </div>
            <template v-else>{{ row.hint || '還沒有' }}</template>
          </div>
          <el-button
            v-if="entry.msg.editable && row.fieldId && editingField !== row.fieldId"
            class="agm-profile__edit"
            link
            type="primary"
            size="small"
            @click="startProfileEdit(row.fieldId, '')"
          >填寫</el-button>
          <span v-else class="agm-profile__edit" />
        </template>
      </div>
    </div>
  </div>

  <!-- 店家輪廓卡（`D-85`）：揭曉「我對你的店的認識」。猜的要看得出是猜的 -->
  <div v-else-if="entry.msg.kind === 'store-profile'" class="agm-card agm-profile">
    <div class="agm-card__label">MiniMe 認識的你</div>
    <dl class="agm-profile__rows">
      <template v-for="(row, i) in entry.msg.rows" :key="i">
        <dt>{{ row.label }}</dt>
        <dd>
          <span :class="['agm-profile__val', { 'is-empty': !row.value }]">{{ row.value || row.hint }}</span>
          <span :class="['agm-profile__src', `is-${row.source}`]">{{ row.sourceText }}</span>
        </dd>
      </template>
    </dl>
    <p v-if="entry.msg.siteNote" class="agm-profile__note">{{ entry.msg.siteNote }}</p>
  </div>

  <!-- 一樣草稿（`D-85`）：按採用才寫出去 -->
  <div v-else-if="entry.msg.kind === 'store-draft'" class="agm-card agm-draft">
    <div class="agm-draft__head">
      <span class="agm-draft__title">{{ entry.msg.title }}</span>
      <span class="agm-draft__where">→ {{ entry.msg.where }}</span>
    </div>
    <!-- ⭐ `D-94`：一開始就可以改（輸入框自己就是說明）。決定完（有 state）收回唯讀。 -->
    <el-input
      v-if="entry.msg.editable === 'text' && !entry.msg.state"
      v-model="draftBody"
      class="agm-draft__ta"
      type="textarea"
      :autosize="{ minRows: 3, maxRows: 12 }"
      :maxlength="4000"
      @input="emitDraft"
    />
    <!-- 標籤：名字欄＋勾選。⛔ 沒勾的**整列**變灰（只讓小方框變化，一眼看不出哪幾顆不會建） -->
    <div v-else-if="entry.msg.editable === 'tags' && !entry.msg.state" class="agm-draft__tags">
      <div
        v-for="(t, i) in draftTags"
        :key="i"
        :class="['agm-draft__tag', { 'is-off': !t.on }]"
      >
        <el-checkbox v-model="t.on" @change="emitDraft" />
        <el-input v-model="t.name" class="agm-draft__tag-name" size="small" :maxlength="20" :disabled="!t.on" @input="emitDraft" />
        <span class="agm-draft__tag-why">{{ t.why }}</span>
      </div>
    </div>
    <pre v-else class="agm-draft__body">{{ entry.msg.body }}</pre>
    <p v-if="entry.msg.note" class="agm-draft__note">{{ entry.msg.note }}</p>
    <p v-if="entry.msg.state" :class="['agm-draft__state', `is-${entry.msg.state}`]">{{ entry.msg.stateText }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * agent 結構化訊息的渲染層（一則訊息一個實例）。
 * 開通引導精靈與（未來的）後台查詢助理共用；型別合約在 shared/types/agent-messages.ts。
 */
import { CircleCheckFilled, Loading, Remove, WarningFilled } from '@element-plus/icons-vue'
import type { AgentChatEntry } from '~~/shared/types/agent-messages'

const props = defineProps<{ entry: AgentChatEntry }>()

/**
 * 互動卡片把「他改了什麼」往上交給頁面（`C-250`）。⚠️ 事件都是選配的——
 * 後台查詢助理那兩處也用這個元件，它們不掛監聽也不會壞（那裡的卡不會是 editable）。
 */
const emit = defineEmits<{
  /** 輪廓卡某一格存起來（值可以是空字串＝清空） */
  (e: 'profile-edit', p: { entryId: number, fieldId: string, value: string }): void
  /** 草稿框的內容變了（按「採用」時劇本用的是這一份） */
  (e: 'draft-input', p: { entryId: number, body?: string, tags?: { name: string, why: string, on: boolean }[] }): void
}>()

const copied = ref(false)

// ── 輪廓卡・分組（`D-93`）──────────────────────────────────────
type ProfileRow = Extract<AgentChatEntry['msg'], { kind: 'store-profile' }>['rows'][number]
const profileGroups = computed(() => {
  const m = props.entry.msg
  if (m.kind !== 'store-profile' || !m.grouped) return []
  const withValue = m.rows.filter(r => r.value)
  return [
    { key: 'owner', title: '你告訴我的', note: '', rows: withValue.filter(r => r.source === 'owner') },
    // ⭐ 出處跟主張長在一起：「從你的網站 5 頁猜的」掛在組名旁邊，⛔ 不掛在卡片最下面
    { key: 'ai', title: '我猜的', note: `${m.aiNote ? `${m.aiNote}，` : ''}幫我看一下對不對`, rows: withValue.filter(r => r.source === 'ai') },
    { key: 'conversation', title: '從你的對話學到的', note: '', rows: withValue.filter(r => r.source === 'conversation') },
  ] as { key: string, title: string, note: string, rows: ProfileRow[] }[]
})
const laterRows = computed<ProfileRow[]>(() => {
  const m = props.entry.msg
  return m.kind === 'store-profile' && m.grouped ? m.rows.filter(r => !r.value) : []
})
/** 還學不到的那幾項預設收著；按了才攤開 */
const laterOpen = ref(false)
const editingField = ref<string | null>(null)
const editValue = ref('')
function startProfileEdit(fieldId: string, value: string) {
  editingField.value = fieldId
  editValue.value = value
}
function saveProfileEdit(fieldId: string | undefined) {
  if (!fieldId) return
  emit('profile-edit', { entryId: props.entry.id, fieldId, value: editValue.value.trim() })
  editingField.value = null
}

// ── 草稿・一開始就可以改（`D-94`）────────────────────────────────
const draftBody = ref(props.entry.msg.kind === 'store-draft' ? props.entry.msg.body : '')
const draftTags = ref(props.entry.msg.kind === 'store-draft' && props.entry.msg.tags
  ? props.entry.msg.tags.map(t => ({ ...t }))
  : [])
function emitDraft() {
  if (props.entry.msg.kind !== 'store-draft') return
  emit('draft-input', props.entry.msg.editable === 'tags'
    ? { entryId: props.entry.id, tags: draftTags.value.map(t => ({ ...t })) }
    : { entryId: props.entry.id, body: draftBody.value })
}

// ── 示意圖：載得起來才畫 ──────────────────────────────────────
// 劇本會先把圖接上、截圖之後才補進 public/onboarding/。這段期間直接畫 <img> 會是一排破圖，
// 所以先在背景載一次，成功才顯示。結果記在 module 層：同一張圖在整個 session 只探一次
// （一段對話裡同一張圖可能出現在好幾張卡）。
const shotProbe = new Map<string, boolean>()
const readyShots = ref<string[]>([])

function probeShot(src: string) {
  const cached = shotProbe.get(src)
  if (cached != null) {
    if (cached)
      readyShots.value.push(src)
    return
  }
  const img = new Image()
  img.onload = () => {
    shotProbe.set(src, true)
    readyShots.value.push(src)
  }
  img.onerror = () => shotProbe.set(src, false)
  img.src = src
}

const shotReady = (src: string) => readyShots.value.includes(src)

onMounted(() => {
  const msg = props.entry.msg
  if (msg.kind === 'image') {
    probeShot(msg.src)
    return
  }
  if (msg.kind !== 'help')
    return
  for (const s of msg.steps) {
    if (s.image)
      probeShot(s.image)
    if (s.aside?.image)
      probeShot(s.aside.image)
  }
})

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
  }
  catch {
    // 舊瀏覽器 / 非安全來源 fallback
    const ta = document.createElement('textarea')
    ta.value = value
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1600)
}
</script>

<!-- 樣式在 app/assets/scss/components/_agent-chat.scss -->
