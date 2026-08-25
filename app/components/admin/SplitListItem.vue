<template>
  <button
    type="button"
    class="split-list-item"
    :class="{ active: props.active, 'has-leading-avatar': showLeadingBlock }"
    @click="emit('select')"
    @contextmenu="onContextMenu"
  >
    <span
      v-if="showLeadingBlock"
      class="split-list-item__avatar-wrap"
      :class="{ 'is-unread': props.showUnreadDot }"
    >
      <img
        v-if="trimmedAvatarUrl"
        :src="trimmedAvatarUrl"
        class="split-list-item__avatar"
        alt=""
      />
      <span
        v-else
        class="split-list-item__avatar split-list-item__avatar--placeholder"
        aria-hidden="true"
      ><el-icon><User /></el-icon></span>
    </span>
    <div class="split-list-item__main">
      <template v-if="props.timeInTitleRow && !$slots.meta">
        <div class="split-list-item__title-row">
          <span
            v-if="trimmedTitleIcon"
            class="split-list-item__title-icon"
            aria-hidden="true"
          >{{ trimmedTitleIcon }}</span>
          <div class="split-list-name">{{ props.title }}</div>
          <!-- 一顆字的小圓章（例：對話列表的負責人員）。放時間左邊、名字右邊：
               名字被截短一點沒關係，「這條線已經有人在跟」要一眼看得到。 -->
          <span
            v-if="trimmedOwnerInitial"
            class="split-list-item__owner"
            :title="props.ownerTitle || props.ownerInitial"
          >{{ trimmedOwnerInitial }}</span>
          <span
            v-if="trimmedChipText && props.titleRowChip"
            class="split-list-chip split-list-chip--in-title-row"
            :class="`is-${props.chipTone}`"
          >{{ trimmedChipText }}</span>
          <span
            v-else-if="trimmedChipText"
            class="split-list-item__time"
          >{{ trimmedChipText }}</span>
        </div>
        <div
          v-if="trimmedMetaText || trimmedMetaTag || trimmedMetaPrefix"
          class="split-list-meta split-list-meta--stacked"
          :class="{ 'has-inline-lead': hasInlineLead, 'is-strong': props.metaStrong }"
        >
          <span
            v-if="trimmedMetaTag"
            class="split-list-chip split-list-chip--inline"
            :class="`is-${props.metaTagTone}`"
          >{{ trimmedMetaTag }}</span>
          <span
            v-if="trimmedMetaPrefix"
            class="split-list-meta-prefix"
          >{{ trimmedMetaPrefix }}</span>
          <span
            class="split-list-meta-text"
            :class="{ truncate: props.metaTruncate }"
          >{{ props.metaText }}</span>
        </div>
      </template>
      <template v-else>
        <div class="split-list-name">
          <span
            v-if="trimmedTitleIcon"
            class="split-list-item__title-icon"
            aria-hidden="true"
          >{{ trimmedTitleIcon }}</span>{{ props.title }}
        </div>
        <div
          v-if="$slots.meta || props.chipText || props.metaText || trimmedMetaPrefix"
          class="split-list-meta"
          :class="{ 'is-strong': props.metaStrong }"
        >
          <slot v-if="$slots.meta" name="meta" />
          <template v-else>
            <span
              v-if="props.chipText"
              class="split-list-chip"
              :class="`is-${props.chipTone}`"
            >
              {{ props.chipText }}
            </span>
            <span
              v-if="trimmedMetaPrefix"
              class="split-list-meta-prefix"
            >{{ trimmedMetaPrefix }}</span>
            <span
              v-if="props.metaText"
              class="split-list-meta-text"
              :class="{ truncate: props.metaTruncate }"
            >
              {{ props.metaText }}
            </span>
          </template>
        </div>
      </template>
    </div>
  </button>
</template>

<script setup lang="ts">
import { User } from '@element-plus/icons-vue'
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  active?: boolean
  chipText?: string
  chipTone?: 'success' | 'neutral' | 'warning' | 'error'
  metaText?: string
  metaTruncate?: boolean
  /** 左側頭貼 URL；與 showLeadingAvatarFallback 擇一或併用 */
  leadingAvatarUrl?: string
  /** 無頭貼 URL 時仍顯示佔位符（對話列表用） */
  showLeadingAvatarFallback?: boolean
  /** 使用者有新進線訊息等情境的視覺提示 */
  showUnreadDot?: boolean
  /**
   * 第一行：標題 + 右側時間（純文字）；第二行：摘要。
   * 用於對話列表等類聊天 App 的排版。
   */
  timeInTitleRow?: boolean
  /**
   * 搭配 timeInTitleRow：右側改為狀態膠囊（.split-list-chip），位置同對話列表時間。
   * 對話列表請維持 false（右側為時間純文字）。
   */
  titleRowChip?: boolean
  /** 名稱前的小圖示（emoji 即可），例如釘選的 📌 */
  titleIcon?: string
  /**
   * 搭配 timeInTitleRow：標題右側的一字圓章，例如對話列表的「負責人員」。
   * 只給**一個字**（呼叫端自己取，見 shared/conversation-assignee.ts 的 assigneeInitial）——
   * 這裡是 239px 寬的側欄，放全名會把客人的名字擠掉。
   */
  ownerInitial?: string
  /** 圓章的 tooltip：滑上去要看得到全名，否則一個字猜不出是誰 */
  ownerTitle?: string
  /** 搭配 timeInTitleRow：摘要那一行最前面的小膠囊，例如「待處理」 */
  metaTag?: string
  metaTagTone?: 'success' | 'neutral' | 'warning' | 'error'
  /**
   * 摘要前面的短前綴（不是膠囊），例如對話列表的「我們：」「客人：」。
   * 標示這段摘要是誰講的，膠囊留給標記，兩者可以同時出現。
   */
  metaPrefix?: string
  /**
   * 整行摘要（含前綴）用深字，預設淡字。給「這一列還等你處理」這種要被看見的內容用；
   * 後台單色，靠深淺分主次，不用顏色。膠囊有自己的配色，不受影響。
   */
  metaStrong?: boolean
  /**
   * 允許右鍵開啟自訂選單：開啟時會擋掉瀏覽器原生選單並 emit contextmenu。
   * 沒有要接選單就別開，不然使用者會失去原生右鍵卻換不到東西。
   */
  contextMenuEnabled?: boolean
}>(), {
  active: false,
  chipText: '',
  chipTone: 'neutral',
  metaText: '',
  metaTruncate: false,
  leadingAvatarUrl: '',
  showLeadingAvatarFallback: false,
  showUnreadDot: false,
  timeInTitleRow: false,
  titleRowChip: false,
  titleIcon: '',
  ownerInitial: '',
  ownerTitle: '',
  metaTag: '',
  metaTagTone: 'warning',
  metaPrefix: '',
  metaStrong: false,
  contextMenuEnabled: false,
})

const emit = defineEmits<{
  (e: 'select'): void
  (e: 'contextmenu', event: MouseEvent): void
}>()

const trimmedAvatarUrl = computed(() => String(props.leadingAvatarUrl || '').trim())
const trimmedChipText = computed(() => String(props.chipText || '').trim())
const trimmedMetaText = computed(() => String(props.metaText || '').trim())
const trimmedTitleIcon = computed(() => String(props.titleIcon || '').trim())
const trimmedOwnerInitial = computed(() => String(props.ownerInitial || '').trim().slice(0, 1))
const trimmedMetaTag = computed(() => String(props.metaTag || '').trim())
const trimmedMetaPrefix = computed(() => String(props.metaPrefix || '').trim())

/** 摘要前面掛了東西（膠囊或前綴）就要改走單行 flex，否則前綴會被擠到自己一行 */
const hasInlineLead = computed(() => Boolean(trimmedMetaTag.value || trimmedMetaPrefix.value))

function onContextMenu(event: MouseEvent) {
  if (!props.contextMenuEnabled) return
  event.preventDefault()
  emit('contextmenu', event)
}

const showLeadingBlock = computed(() =>
  Boolean(trimmedAvatarUrl.value) || props.showLeadingAvatarFallback,
)
</script>
