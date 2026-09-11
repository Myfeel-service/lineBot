<template>
  <!-- 只在真的要打字／選人時現身。選項鈕不歸這裡——它們長在對話流裡
       （AgentChoiceChips，跟著最新訊息），這裡再畫一份就會出現兩排一樣的按鈕 -->
  <div v-if="ask.kind === 'input' || ask.kind === 'picker'" class="agd">
    <!-- 文字 / 密鑰輸入 -->
    <form v-if="ask.kind === 'input'" class="agd__form" @submit.prevent="submit">
      <el-input
        ref="inputEl"
        v-model="text"
        :type="ask.inputType === 'secret' ? 'password' : 'text'"
        :show-password="ask.inputType === 'secret'"
        :placeholder="ask.placeholder || ''"
        :maxlength="ask.maxLength"
        :disabled="busy"
        class="agd__input"
        :class="{ 'is-turn': glow }"
        @keyup.enter="submit"
      />
      <el-button v-if="ask.skippable" text class="agd__skip" :disabled="busy" @click="$emit('skip')">
        {{ ask.skipLabel || '先跳過' }}
      </el-button>
      <el-button type="primary" round :disabled="busy || !text.trim()" @click="submit">送出</el-button>
    </form>

    <!-- 引導式選人：列出選項讓使用者主動選（不自動綁定） -->
    <div v-else-if="ask.kind === 'picker'" class="agd__picker">
      <button
        v-for="opt in ask.options"
        :key="opt.id"
        type="button"
        class="agd__person"
        :disabled="busy"
        @click="$emit('pick', opt)"
      >
        <img v-if="opt.pictureUrl" :src="opt.pictureUrl" class="agd__person-avatar" alt="">
        <span v-else class="agd__person-avatar agd__person-avatar--empty"><el-icon><User /></el-icon></span>
        <span class="agd__person-main">
          <span class="agd__person-name">{{ opt.label }}</span>
          <span v-if="opt.sub" class="agd__person-sub">{{ opt.sub }}</span>
        </span>
      </button>
      <el-button v-if="ask.skippable" text class="agd__skip" :disabled="busy" @click="$emit('skip')">
        先跳過
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * agent 對話的輸入區：依「目前輪到使用者做什麼」（AgentAsk）長成
 * 按鈕列 / 輸入框 / 選人清單。與 AgentMessageRenderer 成對使用。
 */
import { User } from '@element-plus/icons-vue'
import type { AgentAsk, AgentPickerOption } from '~~/shared/types/agent-messages'

const props = defineProps<{ ask: AgentAsk, busy?: boolean }>()

const emit = defineEmits<{
  choice: [value: string]
  submit: [text: string]
  pick: [option: AgentPickerOption]
  skip: []
}>()

const text = ref('')
const inputEl = ref<{ focus: () => void } | null>(null)
/** 輸入格現身時亮三下（見 `_agent-chat.scss` 的 `agd-turn-glow`） */
const glow = ref(false)

// 換一題就清空上一題打到一半的字，並把游標放進輸入框
watch(() => props.ask, (ask) => {
  text.value = ''
  // ⚠️ 先關再開：連著問兩格輸入時元素不會重建，不關掉的話 CSS 動畫不會重播
  glow.value = false
  if (ask.kind === 'input') {
    nextTick(() => {
      inputEl.value?.focus()
      glow.value = true
    })
  }
})

function submit() {
  const v = text.value.trim()
  if (!v || props.busy)
    return
  emit('submit', v)
  text.value = ''
}
</script>

<!-- 樣式在 app/assets/scss/components/_agent-chat.scss -->
