<!--
  推播被方案鎖住時的那一行（`D-131` 推播頁、`C-352`① 帶發送對象進推播頁的每個入口）。

  🔒 ＋ 那一句 ＋「查看方案」（管理得了帳單的人）／「升級請找管理員。」（其他人）。
  ⛔ 句子不在這裡造：呼叫端傳 `broadcastLockText` 系列導出來的那一句（推播頁、驗證視窗、送出端被擋同一句）。
  ⛔ 不用紅也不用黃：沒有東西壞掉，是這個方案就長這樣——而且句尾指得出怎麼解。
-->
<template>
  <p class="bc-plan-lock" :class="{ 'bc-plan-lock--inline': inline, 'bc-plan-lock--bare': bare }" data-plan-lock>
    <el-icon class="bc-plan-lock__icon"><Lock /></el-icon>
    <span>{{ text }}</span>
    <el-button v-if="canManageBilling" link type="primary" @click="openPlans">查看方案</el-button>
    <span v-else class="bc-plan-lock__ask">升級請找管理員。</span>
  </p>
  <!-- append-to-body：這一行會出現在別的視窗裡（活動精靈、小幫手的確認卡），疊在裡面的視窗要掛到最外層才蓋得上去 -->
  <AdminPlanUpgradeDialog
    v-if="canManageBilling"
    v-model="dialogOpen"
    :current-plan-id="plan?.id ?? null"
    append-to-body
  />
</template>

<script setup lang="ts">
import { Lock } from '@element-plus/icons-vue'

withDefaults(defineProps<{
  /** 那一句（`broadcastLockText`／`broadcastEntryLockText` 導出來的，⛔ 不要自己寫） */
  text: string
  /** 接在一組選項／按鈕正下方：上面留一點距離 */
  inline?: boolean
  /** 不要外框（本來就在一張卡、一個框裡的時候） */
  bare?: boolean
}>(), { inline: false, bare: false })

// 「查看方案」打開的是付款彈窗（`billing.manage`）；方案摘要另看 `usage.read`——兩個都是管理員，各跟各的端點走（`G-109`）
const { can } = useWorkspace()
const canManageBilling = computed(() => can('billing.manage'))

const dialogOpen = ref(false)
const { plan, load: loadPlanSummary } = usePlanSummary()
function openPlans() {
  // 外殼的額度提醒條多半已經問過方案（同一份共享資料）；沒問過就補問一次，「目前」那一列才標得出來
  if (!plan.value) void loadPlanSummary()
  dialogOpen.value = true
}
</script>
