<template>
  <div class="admin-flex-1">
    <AdminFieldLabel :text="props.fieldLabel" tight />
    <div class="admin-title-row">
      <span class="split-editor-title">{{ props.title }}</span>
      <!-- 「這頁怎麼用」（D-33 P1-5）：掛在共用標題上，每一頁只要填 help-topics 就有，
           位置永遠一樣——⛔別在某一頁自己另擺一顆，一致性是這個後台的硬規則 -->
      <AdminPageHelpButton v-if="props.helpTopics?.length" :topics="props.helpTopics" />
    </div>
    <!-- caption 之後可再接一段（例：連到姊妹頁的連結）。純文字說明用 prop 就好，
         需要連結／標記時才用 slot——字串 prop 塞不進 <a>。 -->
    <p v-if="props.caption || $slots.caption" class="text-sm text-muted admin-subtext">
      {{ props.caption }}<slot name="caption" />
    </p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  fieldLabel: string
  title: string
  caption?: string
  /** 這一頁的逐步導覽主題 id（utils/tutorial-topics）；有填才會出現標題旁那顆問號 */
  helpTopics?: string[]
}>()
</script>
