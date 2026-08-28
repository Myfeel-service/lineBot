<template>
  <!-- 一般泡泡 -->
  <div
    v-if="entry.msg.kind === 'text'"
    class="agm-msg"
    :class="entry.role === 'user' ? 'agm-msg--user' : 'agm-msg--agent'"
  >
    <!-- html 僅限劇本文案＋已跳脫的使用者輸入（見 shared/types/agent-messages.ts 的警語） -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="agm-bubble" v-html="entry.msg.html" />
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

  <!-- 加好友邀請卡：先講「要加的是哪個帳號」，再講怎麼加（QR 產不出來時只少一張圖，不破版） -->
  <div v-else-if="entry.msg.kind === 'oaInvite'" class="agm-card agm-invite">
    <img
      v-if="entry.msg.qrDataUrl"
      class="agm-invite__qr"
      :src="entry.msg.qrDataUrl"
      :alt="`加入 ${entry.msg.basicId} 為好友的 QR Code`"
      width="110"
      height="110"
    >
    <div class="agm-invite__main">
      <div class="agm-card__label">要加的是這個帳號</div>
      <div class="agm-invite__id">{{ entry.msg.basicId }}</div>
      <p class="agm-invite__how">
        用手機掃左邊的 QR，或在 LINE 的「加入好友 → 搜尋」輸入這組 ID。
      </p>
      <a class="agm-invite__link" :href="entry.msg.addFriendUrl" target="_blank" rel="noopener">
        用手機打開這個連結 ↗
      </a>
    </div>
  </div>

  <!-- 強調卡：回顯第一則訊息 -->
  <div v-else-if="entry.msg.kind === 'highlight'" class="agm-card agm-highlight">
    <div class="agm-card__label">{{ entry.msg.label }}</div>
    <div class="agm-highlight__title">{{ entry.msg.title }}</div>
    <div v-if="entry.msg.meta" class="agm-highlight__meta">{{ entry.msg.meta }}</div>
  </div>

  <!-- 完成摘要卡 -->
  <div v-else-if="entry.msg.kind === 'summary'" class="agm-card agm-summary">
    <div class="agm-card__label">開通結果</div>
    <ul>
      <li v-for="(it, i) in entry.msg.items" :key="i" :class="{ 'is-skipped': !it.done }">
        <span class="agm-summary__mark">{{ it.done ? '✓' : '–' }}</span>
        <span>{{ it.label }}<template v-if="it.note">（{{ it.note }}）</template></span>
      </li>
    </ul>
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

const copied = ref(false)

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
