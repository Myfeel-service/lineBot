<!--
  測試對話頁：一條自動回應「客人會先收到什麼」（`D-173`）。
  伺服器照真的送出那條路組好（`previewScriptReply`），這裡只畫：
  - 送字＝LINE 訊息翻成預覽吃的形狀（`lineMessagesToPreviewMessages`，推播頁同一支）
  - 送模組＝交給 `AdminActionPreview`（自動回應頁、客服預存同一支：自己把模組抓回來畫，三態）
  - ⛔ 模組被關掉或刪掉要講「客人什麼都收不到」，不可以畫成空白
-->
<template>
  <div class="pg-rp">
    <p v-if="reply.moduleMissing" class="pg-rp__warn">
      這條要送的機器人模組已經關掉或刪掉了，<b>客人什麼都收不到</b>。到「機器人模組」看看。
    </p>
    <AdminActionPreview
      v-else-if="reply.moduleId"
      :action="{ type: 'module', moduleId: reply.moduleId }"
      :module-options="reply.moduleName ? [{ id: reply.moduleId, name: reply.moduleName }] : []"
      title=""
      bare
    />
    <template v-else-if="previewMessages.length">
      <FlowMessagePreview :messages="previewMessages" bare />
      <p v-if="variableNote" class="pg-rp__note">{{ variableNote }}</p>
    </template>
    <p v-else class="pg-rp__note">這一步沒有要送的字。</p>
    <!-- 快速回覆：LINE 上浮在輸入框上面那一排（預覽元件不畫它，這裡補） -->
    <div v-if="quickReplies.length" class="pg-rp__qr">
      <span class="pg-rp__qr-label">下面那一排可以按：</span>
      <span v-for="q in quickReplies" :key="q" class="pg-rp__qr-chip">{{ q }}</span>
    </div>
    <p v-if="reply.waits" class="pg-rp__note">接著等客人回答——客人回了才走下一步（這裡不模擬後面幾步，整條到「自動回應」頁看）。</p>
    <p v-else-if="reply.handoff" class="pg-rp__note">送完就轉給真人。</p>
  </div>
</template>

<script setup lang="ts">
import { lineMessagesToPreviewMessages } from '~~/shared/broadcast-content'
import { previewVariableNote, renderPreviewVariablesDeep } from '~~/shared/preview-variables'
import type { ScriptReplyPreview } from '~~/shared/types/playground-preview'

const props = defineProps<{ reply: ScriptReplyPreview }>()

/** `{{displayName}}` 這類變數換成範例值（標黃），旁邊那句講清楚——同 `AdminActionPreview`（`C-255`／`D-128`） */
const rendered = computed(() => renderPreviewVariablesDeep(lineMessagesToPreviewMessages(props.reply.lineMessages), { mark: true }))
const previewMessages = computed(() => rendered.value.value)
const variableNote = computed(() => previewVariableNote(rendered.value.keys))

/** 快速回覆的字（送字那條路：掛在那則文字上） */
const quickReplies = computed(() => props.reply.lineMessages.flatMap((m) => {
  const items = (m as { quickReply?: { items?: Array<{ action?: { label?: string } }> } }).quickReply?.items ?? []
  return items.map(i => String(i.action?.label ?? '')).filter(Boolean)
}))
</script>
