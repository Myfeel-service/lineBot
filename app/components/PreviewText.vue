<template><template v-for="(seg, i) in segs" :key="i"><mark v-if="seg.mark" class="preview-sample">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></template>

<script setup lang="ts">
/**
 * 預覽裡的一段文字：範例值（`renderPreviewVariables… { mark: true }` 夾了記號的那段，例如「王小明」）標黃色（`D-128`）。
 * 沒有記號＝原字照印，所以每個預覽的文字都可以直接換成這個元件。
 * ⚠️ 模板寫成一行：多出來的空白會變成畫面上的字
 */
import { computed } from 'vue'
import { splitPreviewMarks } from '~~/shared/preview-variables'

const props = defineProps<{ text: string | undefined | null }>()
const segs = computed(() => splitPreviewMarks(String(props.text ?? '')))
</script>
