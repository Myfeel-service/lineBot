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

  <!-- 「怎麼拿?」展開教學 -->
  <details v-else-if="entry.msg.kind === 'help'" class="agm-card agm-help">
    <summary>{{ entry.msg.summary }}</summary>
    <ol>
      <li v-for="(s, i) in entry.msg.steps" :key="i">{{ s }}</li>
    </ol>
    <a
      v-if="entry.msg.href"
      class="agm-help__link"
      :href="entry.msg.href"
      target="_blank"
      rel="noopener"
    >{{ entry.msg.hrefLabel || '打開連結 ↗' }}</a>
  </details>

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

defineProps<{ entry: AgentChatEntry }>()

const copied = ref(false)

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
