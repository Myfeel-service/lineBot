<template>
  <div class="agp">
    <div class="agp__head">
      <button type="button" class="agp__back" @click="$emit('close')">← 返回</button>
      <span class="agp__title">{{ guide.title }}</span>
    </div>
    <div ref="listEl" class="agp__chat" aria-live="polite">
      <AgentMessageRenderer v-for="e in entries" :key="e.id" :entry="e" />
      <div v-if="typing" class="agm-msg agm-msg--agent">
        <div class="agm-bubble agm-typing"><i /><i /><i /></div>
      </div>
    </div>
    <AgentAskDock :ask="ask" :busy="busy" @choice="onChoice" @submit="onSubmit" @pick="onPick" @skip="onSkip" />
  </div>
</template>

<script setup lang="ts">
/**
 * 「帶你修好」引導劇本的宿主（C-31 Phase 1）：掛在小幫手面板裡，
 * 跑 AGENT_GUIDES 的宣告式步驟。引擎、訊息渲染、輸入區都與開通精靈共用同一份。
 * 卸載（關面板／切工作區）即 dispose——劇本鏈就地停下，不會在背景繼續問問題。
 */
import { AGENT_GUIDES } from '~/utils/agent-guides'
import type { AgentGuideId } from '~/utils/agent-guides'

const props = defineProps<{ guideId: AgentGuideId }>()
const emit = defineEmits<{ close: [], done: [] }>()

const { apiFetch, workspaceId } = useWorkspace()
const runner = useAgentScriptRunner()
const { entries, ask, typing, busy, onChoice, onSubmit, onPick, onSkip } = runner

const guide = AGENT_GUIDES[props.guideId]
const listEl = ref<HTMLElement | null>(null)

// 對話長出來就貼底（跟開通精靈同手法）
watch([() => entries.value.length, typing, ask], () => {
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight }))
})

onMounted(async () => {
  await runner.runSteps(guide.steps, {
    r: runner,
    apiFetch,
    workspaceId: workspaceId.value || '',
    state: {},
  })
  // 跑完（含提前收工）通知宿主強制重查訊號：異常有沒有真的熄掉，讓面板立刻反映
  if (!runner.isDisposed())
    emit('done')
})

onBeforeUnmount(() => runner.dispose())
</script>

<!-- 樣式在 app/assets/scss/components/_agent-chat.scss（.agp-） -->
