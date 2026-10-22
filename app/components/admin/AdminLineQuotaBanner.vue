<template>
  <!-- `D-146`②：LINE 訊息用完了＝每一頁最上面一條紅、關不掉（示意畫布 ③）。
       長相照抄「AI 已停止自動回覆」那條（.quota-banner--over）：同一個份量的事，同一個樣子 -->
  <div v-if="show" class="quota-banner quota-banner--over" role="alert" data-testid="line-quota-banner">
    <span class="quota-banner__icon"><el-icon><CircleCloseFilled /></el-icon></span>
    <div class="quota-banner__body">
      <p class="quota-banner__title">{{ ALERT_LABELS.lineQuotaExhausted }}</p>
      <p class="quota-banner__desc">{{ desc }}</p>
    </div>
    <div v-if="can('line.manage')" class="quota-banner__actions">
      <el-button tag="a" :href="LINE_OA_MANAGER_URL" target="_blank" rel="noopener" type="primary" size="small">
        前往 LINE 官方帳號後台
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { CircleCloseFilled } from '@element-plus/icons-vue'
import { ALERT_LABELS } from '~~/shared/types/alerts'
import { LINE_OA_MANAGER_URL, lineQuotaConsequence, lineQuotaResetLabel } from '~~/shared/line-quota'

/**
 * 顯示規則：
 *   · 只在**用完了**才出現；八成時不掛（那時講給管理員就好：登入後第一頁那一條變黃、小幫手黃、LINE 通知一則）。
 *   · **所有角色**都看得到：客服在後台回客人的訊息也會送不出去，他要先知道；按鈕只給管 LINE 的人。
 *   · 關不掉：那是服務中斷，不是提醒（同 AI 額度用完那條）。
 *   · 登入後第一頁（客服對話統計）不掛：那一頁最上面的「LINE 訊息」那一條已經是紅的、講同一句（同 AI 額度條在帳單頁不掛）。
 */
const route = useRoute()
const { workspaceId, can } = useWorkspace()
const { level, load } = useLineQuota()

const onStatsPage = computed(() => route.path.endsWith('/conversation-stats'))
const show = computed(() => level.value === 'over' && !onStatsPage.value)
const desc = computed(() => lineQuotaConsequence('over', lineQuotaResetLabel()))

// 掛在版型上、換頁換帳號都不重掛：兩個都要看。同一個帳號 5 分鐘內不重問（見 useLineQuota）
watch([workspaceId, () => route.path], () => { void load() }, { immediate: true })
</script>
