<template>
  <div class="admin-flex-1">
    <AdminFieldLabel :text="props.fieldLabel" tight />
    <div class="admin-title-row">
      <span v-if="props.isCreating" class="split-editor-title">{{ props.createPrefix }}</span>
      <el-input
        :model-value="props.modelValue"
        size="large"
        class="admin-title-input"
        :placeholder="props.placeholder"
        @update:model-value="onInput"
        @keydown.enter.prevent="emit('enter')"
      />
    </div>
    <!--
      `C-227` 第二輪：caption 後面可以再掛一小段東西（例如機器人模組的「客人會從哪裡走到這裡」）。
      ⛔ 那種資訊**不可以自己開一塊面板放在工具列裡**——它會跟「儲存變更」搶版面、
         展開還把整條工具列推高（老闆兩次回報「還是很醜」都是這個形狀）。
         它就是一句補充說明，該待的地方就是這行灰字旁邊。
    -->
    <p class="text-sm text-muted admin-subtext">
      {{ props.caption }}<slot name="caption-extra" />
    </p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string
  fieldLabel: string
  placeholder: string
  caption: string
  createPrefix: string
  isCreating: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'enter'): void
}>()

function onInput(value: string | number) {
  emit('update:modelValue', String(value ?? ''))
}
</script>
