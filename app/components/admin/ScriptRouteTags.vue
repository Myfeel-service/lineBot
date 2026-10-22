<template>
  <!--
    路上貼的標籤（`D-150`②，示意第⑨張②）：按了那顆按鈕就貼。
    一列裡只放小膠囊（同示意的「退貨客人 ✕」），選標籤、建新標籤收進點開的小視窗——
    整顆選標籤欄位放進那一列會擠到下一行、✕ 跟著掉下去（10-23 實機截圖）。
  -->
  <span v-if="tagIds.length || canAdd" class="scripts-route-tags">
    <el-tag
      v-for="id in tagIds"
      :key="id"
      size="small"
      :closable="canEdit"
      disable-transitions
      @close="emit('update', tagIds.filter(x => x !== id))"
    >{{ nameOf(id) }}</el-tag>
    <el-popover v-if="canEdit && (canAdd || tagIds.length)" trigger="click" placement="bottom-start" :width="300">
      <template #reference>
        <button type="button" class="scripts-route-tags__add" :title="tagIds.length ? '再貼一個標籤' : '按了這顆就替客人貼標籤'">
          {{ tagIds.length ? '＋' : '＋ 貼標籤' }}
        </button>
      </template>
      <AdminTagPicker
        :model-value="tagIds"
        :options="options"
        placeholder="按了就貼哪些標籤"
        @update:model-value="emit('update', $event)"
      />
    </el-popover>
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  /** 這條路上現在貼的標籤 id */
  tagIds: string[]
  options: Array<{ id: string; name: string; color?: string }>
  canEdit: boolean
  /** 還沒貼的時候給不給「＋ 貼標籤」：按鈕那一列給；其他種的路只在已經貼了的時候出現（舊資料） */
  canAdd: boolean
}>()
const emit = defineEmits<{ update: [ids: string[]] }>()

/** 標籤清單還沒載到（或那顆被刪了）就先顯示 id，不要顯示空白 */
function nameOf(id: string): string {
  return props.options.find(t => t.id === id)?.name ?? id
}
</script>
