<template>
  <!--
    「⋯」更多動作（2026-10-09 `C-294`）：編輯頁右上角＝**次要動作（複製、刪除）一律收在這裡**，
    取消／儲存／發送／設為預設這種主要動作照舊露出。規則見 `docs/COPY-RULES-AND-INVENTORY-20261009.md`。
    表格每一列的「⋯」（成員、LINE 通知）也用這支，`variant="row"`（2026-10-10 審查：那兩頁原本各拼一份、紅字樣式有三份）。
    ⛔ 各頁不要再自己拼一份 el-dropdown：拼過的那幾份長相、順序、分隔線遲早各走各的。
  -->
  <el-dropdown
    v-if="shown.length"
    trigger="click"
    placement="bottom-end"
    @command="(cmd) => emit('command', String(cmd))"
  >
    <!-- 表格每一列（成員、LINE 通知）：小一號的純圖示按鈕，⛔ 不要外框（一欄十幾顆框會比內容還搶眼） -->
    <el-button v-if="variant === 'row'" text size="small" class="admin-more-btn--row" :icon="MoreFilled" aria-label="更多動作" />
    <el-button v-else class="admin-more-btn" :icon="MoreFilled" aria-label="更多動作" />
    <template #dropdown>
      <el-dropdown-menu>
        <!-- 刪除（danger）一律排最後、上面加一條分隔線 -->
        <el-dropdown-item
          v-for="(item, i) in shown"
          :key="item.command"
          :command="item.command"
          :icon="item.icon"
          :disabled="item.disabled"
          :divided="item.danger && i > 0"
          :class="{ 'admin-more-item--danger': item.danger }"
        >
          {{ item.label }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { MoreFilled } from '@element-plus/icons-vue'

export interface AdminMoreMenuItem {
  command: string
  label: string
  icon?: Component
  /** 危險動作（刪除）：紅字、排最後 */
  danger?: boolean
  disabled?: boolean
  /** false＝這一筆不顯示（例如系統模組不能刪）；一項都不顯示時整顆「⋯」不出現 */
  show?: boolean
}

const props = defineProps<{
  items: AdminMoreMenuItem[]
  /** header＝編輯頁右上角（預設）；row＝表格每一列最右邊 */
  variant?: 'header' | 'row'
}>()
const emit = defineEmits<{ command: [command: string] }>()

const shown = computed(() => {
  const visible = props.items.filter(it => it.show !== false)
  return [...visible.filter(it => !it.danger), ...visible.filter(it => it.danger)]
})
</script>
