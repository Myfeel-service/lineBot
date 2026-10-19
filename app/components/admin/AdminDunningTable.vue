<template>
  <!--
    超管「自動扣款失敗」清單（`B-43`②）：金流總覽與異常總覽共用同一張表，兩頁講的才會一樣。
    資料由後端 readDunningRows 組（shared/billing/dunning.ts），這裡只負責畫。
  -->
  <el-table :data="rows" size="small" :empty-text="emptyText">
    <el-table-column label="官方帳號" min-width="150">
      <template #default="{ row }">
        <div class="text-sm font-bold">{{ row.workspaceName }}</div>
        <div class="text-xs text-muted">{{ row.planName }}方案<template v-if="row.cardLast4"> · 卡 •••• {{ row.cardLast4 }}</template></div>
      </template>
    </el-table-column>
    <el-table-column label="狀況" width="110">
      <template #default="{ row }">
        <el-tag v-if="row.state === 'past_due'" type="danger" size="small">扣款失敗中</el-tag>
        <el-tag v-else type="info" size="small">已降回免費</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="失敗原因（金流回的原文）" min-width="200">
      <template #default="{ row }">
        <span v-if="row.lastChargeError" class="text-sm">{{ row.lastChargeError }}</span>
        <span v-else class="text-xs text-muted">這期還沒扣過（排程還沒輪到，或在等銀行回覆）</span>
      </template>
    </el-table-column>
    <el-table-column label="試扣" width="110">
      <template #default="{ row }">
        <span class="sa-alerts-usage">第 {{ row.attempts }} 次</span>
        <div v-if="row.lastChargeDate" class="text-xs text-muted">最近 {{ md(row.lastChargeDate) }}</div>
      </template>
    </el-table-column>
    <el-table-column label="降回免費" min-width="150">
      <template #default="{ row }">
        <template v-if="row.state === 'past_due' && row.graceLastDay">
          <span class="text-sm">{{ monthDayText(row.graceLastDay) }}前沒扣到就降</span>
        </template>
        <span v-else-if="row.downgradeOn" class="text-sm">{{ monthDayText(row.downgradeOn) }}已降</span>
      </template>
    </el-table-column>
    <el-table-column label="通知客戶" width="110">
      <template #default="{ row }">
        <span v-if="row.email === 'sent'" class="text-xs text-muted">已寄信</span>
        <el-tooltip v-else-if="row.email === 'pending'" placement="top" content="寄信失敗的話系統每 3 小時再試一次；一直沒寄出去，先看異常總覽的「帳務信」那一區">
          <el-tag type="warning" size="small">信還沒寄出</el-tag>
        </el-tooltip>
        <el-tooltip v-else-if="row.email === 'no_recipient'" placement="top" content="這個帳號沒有發票信箱、組織也沒登記擁有者信箱，要自己聯絡客戶">
          <el-tag type="warning" size="small">沒有信箱可寄</el-tag>
        </el-tooltip>
        <span v-else class="sa-alerts-none">—</span>
      </template>
    </el-table-column>
    <el-table-column label="" width="100" align="right">
      <template #default="{ row }">
        <el-button size="small" plain @click="openBilling(row.workspaceId)">看帳單頁</el-button>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import { monthDayText, type DunningRow } from '~~/shared/billing/dunning'

withDefaults(defineProps<{ rows: DunningRow[], emptyText?: string }>(), {
  emptyText: '沒有扣款失敗的帳號。',
})

/** `2026-10-20` → `10/20`（表格裡要短） */
function md(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
}

function openBilling(workspaceId: string) {
  navigateTo(`/admin/${workspaceId}/settings/billing`)
}
</script>
