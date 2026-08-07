<template>
  <div class="agd">
    <!-- 沒輪到使用者：顯示提示（或留白） -->
    <p v-if="ask.kind === 'idle'" class="agd__hint">{{ ask.hint || '' }}</p>

    <!-- 按鈕選項 -->
    <div v-else-if="ask.kind === 'choices'" class="agd__chips">
      <el-button
        v-for="opt in ask.options"
        :key="opt.value"
        :type="opt.primary ? 'primary' : 'default'"
        round
        :disabled="busy"
        @click="$emit('choice', opt.value)"
      >{{ opt.label }}</el-button>
    </div>

    <!-- 文字 / 密鑰輸入 -->
    <form v-else-if="ask.kind === 'input'" class="agd__form" @submit.prevent="submit">
      <el-input
        ref="inputEl"
        v-model="text"
        :type="ask.inputType === 'secret' ? 'password' : 'text'"
        :show-password="ask.inputType === 'secret'"
        :placeholder="ask.placeholder || ''"
        :maxlength="ask.maxLength"
        :disabled="busy"
        class="agd__input"
        @keyup.enter="submit"
      />
      <el-button v-if="ask.skippable" text class="agd__skip" :disabled="busy" @click="$emit('skip')">
        先跳過
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

// 換一題就清空上一題打到一半的字，並把游標放進輸入框
watch(() => props.ask, (ask) => {
  text.value = ''
  if (ask.kind === 'input')
    nextTick(() => inputEl.value?.focus())
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
