<template>
  <!-- 頁面上的「用一句話建立」（`D-112` 第 2 件，示意頁 v2 的 ②）：放在「新增」旁邊——
       「什麼時候該叫小幫手」的答案就是「要建東西的這一刻」，按鈕自己講出來。
       按了只打開小幫手的對話、游標放進輸入框，⛔ 不替他送任何一句話（內容要他自己講）。
       這一頁小幫手一件都做不了的人（權限不夠）整顆不出現。 -->
  <div v-if="visible && row" class="agent-ask-row">
    <el-button size="small" class="agent-ask-btn" :icon="ChatDotRound" @click="open">{{ label }}</el-button>
  </div>
  <el-button v-else-if="visible" size="small" class="agent-ask-btn" :icon="ChatDotRound" @click="open">{{ label }}</el-button>
</template>

<script setup lang="ts">
import { ChatDotRound } from '@element-plus/icons-vue'
import { agentPromptsFor, type AgentPromptPage } from '~~/shared/agent-entry'

const props = withDefaults(defineProps<{
  /** 這顆在哪一頁（決定小幫手開起來列哪些建議；也拿來判斷這個人在這頁能不能叫它做事） */
  page: AgentPromptPage
  label?: string
  /** 側欄用：自己佔一排（240px 的側欄標頭塞不下第三顆，硬塞會折成兩行） */
  row?: boolean
}>(), { label: '用一句話建立', row: false })

const { can } = useWorkspace()
const { askAgent } = useTutorial()

const visible = computed(() => can('assistant.use') && agentPromptsFor(props.page, can).dos.length > 0)

function open() {
  askAgent({ send: false, source: 'page-button' })
}
</script>

<!-- 樣式在 app/assets/scss/components/_agent-chat.scss -->
