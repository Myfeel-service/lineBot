<!--
  圖文選單「客人看到的樣子」（`C-233`）。

  **為什麼要有這個**：旁邊那張編輯畫布上，每一格都蓋著一層 60% 不透明的色塊（為了標出
  可點區域），而且**拿不掉**——所以店家在後台**從來沒看過那張圖乾淨的樣子**，
  判斷不出字夠不夠大、深色底會不會把文字吃掉、對齊有沒有歪。
  聊天室最下面那條 Chat Bar 文字（預設「選單」）也從來沒有被畫出來過。

  ⛔ **不是要取代編輯畫布**：那張是用來拖格子的，這張是用來看成品的，兩件事。
  ⛔ 這裡**一個色塊都不要疊**——只要疊了，它就又變成第二張編輯畫布，這個功能就沒了。
-->
<template>
  <div class="rmc">
    <div class="rmc-frame">
      <div class="rmc-head">
        <span class="rmc-avatar">{{ oaInitial }}</span>
        <div class="rmc-meta">
          <span class="rmc-name">{{ oaName || '官方帳號' }}</span>
          <span class="rmc-sub">預覽・實際以 LINE 為準</span>
        </div>
      </div>

      <!-- 聊天區：刻意留白。圖文選單本來就佔掉聊天室下半部，這片空白就是那個感覺 -->
      <div class="rmc-chat">
        <p class="rmc-chat-note">選單會蓋掉聊天室下半部，客人要按下面那一條才收得回去。</p>
      </div>

      <!-- 那張圖，乾乾淨淨，照真實比例 -->
      <div class="rmc-menu" :style="{ aspectRatio: `${width} / ${height}` }">
        <img v-if="imageUrl" :src="imageUrl" class="rmc-menu-img" alt="圖文選單背景圖">
        <div v-else class="rmc-menu-empty">還沒有背景圖</div>
      </div>

      <!-- Chat Bar：客人真的會看到這幾個字，而後台以前一處都沒畫過 -->
      <div class="rmc-bar">
        <span class="rmc-bar-caret" aria-hidden="true">▾</span>
        <span class="rmc-bar-text">{{ chatBarText || '選單' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  imageUrl?: string
  chatBarText?: string
  width?: number
  height?: number
  oaName?: string
}>()

const oaInitial = computed(() => (props.oaName || '官').trim().charAt(0).toUpperCase())
/** 比例壞掉時退回 LINE 的大版預設（2500×1686），⛔ 不要讓 aspect-ratio 變成 0 把整塊壓扁 */
const width = computed(() => Number(props.width) || 2500)
const height = computed(() => Number(props.height) || 1686)
</script>
